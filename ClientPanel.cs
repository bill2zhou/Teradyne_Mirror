using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using System.Drawing;

namespace WinFormSocketClient
{
    public partial class ClientPanel : UserControl
    {
        private readonly string _connectionKey;
        private readonly Action<string, string> _sendCallback;

        // 统计数据
        private int _passCount = 0;
        private int _totalCount = 0;
        private string _msg = "";
        private DateTime _startTime;
        
        // 状态标志：是否已收到过数据
        private bool _hasReceivedData = false;
        
        // 组件失败统计: Key=ComponentName, Value=Count
        private readonly Dictionary<string, int> _componentFailStats;
        private readonly object _statsLock = new object();

        // 右键菜单
        private readonly ContextMenuStrip _contextMenu;

        // [新增] 拖动相关字段
        private bool _isDragging = false;
        private Point _dragStartPoint;
        private const int DragThreshold = 5; // 鼠标移动多少像素后开始拖动

        public ClientPanel(string key, Action<string, string> sendCallback)
        {
            InitializeComponent();
            
            _connectionKey = key;
            _sendCallback = sendCallback;
            
            // 【修复】初始化字典，防止 NullReferenceException
            _componentFailStats = new Dictionary<string, int>();

            // 初始化右键菜单
            _contextMenu = new ContextMenuStrip();
            ToolStripMenuItem resetItem = new ToolStripMenuItem("重置统计");
            resetItem.Click += ResetStats_Click;
            _contextMenu.Items.Add(resetItem);

            // 将右键菜单绑定到 rtbLog
            if (rtbLog != null)
            {
                rtbLog.ContextMenuStrip = _contextMenu;
                // 初始化为空白，不调用 UpdateDisplayText
                rtbLog.Text = string.Empty; 
            }

            // 初始化界面显示
            lblConnectionInfo.Text = $"监控连接: {key}";

            // [新增] 启用此控件作为拖放目标（用于接收其他面板的拖放排序）
            this.AllowDrop = true;

            // [新增] 仅为标题栏绑定拖动事件，这样点击日志区域仍然可以选中文本
            lblConnectionInfo.MouseDown += TitleBar_MouseDown;
            lblConnectionInfo.MouseMove += TitleBar_MouseMove;
            
            // 可选：改变鼠标样式，提示用户标题栏可拖动
            lblConnectionInfo.Cursor = Cursors.SizeAll;
        }

        #region 标题栏拖动逻辑

        /// <summary>
        /// 标题栏鼠标按下
        /// </summary>
        private void TitleBar_MouseDown(object sender, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left)
            {
                _dragStartPoint = e.Location;
                _isDragging = false;
            }
        }

        /// <summary>
        /// 标题栏鼠标移动，判断是否启动拖动
        /// </summary>
        private void TitleBar_MouseMove(object sender, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left && !_isDragging)
            {
                // 计算鼠标移动距离
                int dx = Math.Abs(e.X - _dragStartPoint.X);
                int dy = Math.Abs(e.Y - _dragStartPoint.Y);

                // 如果移动距离超过阈值，启动拖放
                if (dx > DragThreshold || dy > DragThreshold)
                {
                    _isDragging = true;
                    // 启动拖放操作，数据源是当前 ClientPanel
                    // DragDropEffects.Move 表示移动操作
                    this.DoDragDrop(this, DragDropEffects.Move);
                }
            }
        }

        /// <summary>
        /// 当拖放操作结束时重置状态
        /// </summary>
        protected override void OnQueryContinueDrag(QueryContinueDragEventArgs e)
        {
            base.OnQueryContinueDrag(e);
            // 如果拖放结束（释放鼠标或取消），重置拖动状态
            if (e.Action == DragAction.Drop || e.Action == DragAction.Cancel)
            {
                _isDragging = false;
            }
        }

        #endregion

        /// <summary>
        /// 右键菜单：重置统计
        /// </summary>
        private void ResetStats_Click(object sender, EventArgs e)
        {
            lock (_statsLock)
            {
                _passCount = 0;
                _totalCount = 0;
                _msg="";
                _componentFailStats.Clear();
                _hasReceivedData = false; // 重置接收状态
                this.Size = new System.Drawing.Size(300, 150);
                // _startTime 可以在下次收到数据时重新赋值，或者保持不动视需求而定
            }

            // 更新 UI：直接清空文本，回到初始空白状态
            
            if (rtbLog.InvokeRequired)
            {             
                rtbLog.BeginInvoke(new Action(() => rtbLog.Text = string.Empty));
            }
            else
            {
                rtbLog.Text = string.Empty;
            }
        }

        /// <summary>
        /// 追加接收到的消息到日志窗口并更新统计
        /// </summary>
        public void AppendMessage(string message)
        {
            if (string.IsNullOrEmpty(message)) return;

            // 检查是否需要跨线程调用
            if (rtbLog.InvokeRequired)
            {
                rtbLog.BeginInvoke(new Action<string>(ProcessMessageAndUpdateUI), message);
                return;
            }

            ProcessMessageAndUpdateUI(message);
        }

        /// <summary>
        /// 处理消息逻辑并更新 UI (必须在 UI 线程执行)
        /// </summary>
        private void ProcessMessageAndUpdateUI(string message)
        {
            // 1. 更新统计数据 (逻辑层)
            string lowerMsg = message.Trim().ToLowerInvariant();

            if (lowerMsg.Contains( "continuetestfailed"))
            {
                
                _msg = _msg+ $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}]:***连续测试不良***\n";
                rtbLog.Text = _msg;
                return;
            }
            if (lowerMsg.Contains("stationerror"))
            {
                _msg = _msg + $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}]:***站别错误***\n";
                rtbLog.Text = _msg;
                return;
            }
            UpdateStatistics(message);

            // 2. 如果这是第一条数据，标记为已接收，并记录开始时间
            if (!_hasReceivedData)
            {
                _hasReceivedData = true;
                _startTime = DateTime.Now;
            }

            // 3. 只有当收到过数据后，才更新 UI 显示统计信息
            if (_hasReceivedData)
            {
                UpdateDisplayText();
            }
        }

        /// <summary>
        /// 更新内部统计数据
        /// </summary>
        /// <summary>
        /// 更新内部统计数据
        /// </summary>
        private void UpdateStatistics(string message)
        {
            // 标准化消息以便比较
            string lowerMsg = message.Trim().ToLowerInvariant();

            // 1. 统计 Pass/Fail 总数 (保持原有逻辑)
            int passCountInMsg = Regex.Matches(lowerMsg, @"\bpass\b").Count;
            int failCountInMsg = Regex.Matches(lowerMsg, @"\bfail\b").Count;

            if (passCountInMsg > 0)
            {
                _passCount += passCountInMsg;
                _totalCount += passCountInMsg;
            }

            if (failCountInMsg > 0 && passCountInMsg == 0)
            {
                _totalCount += failCountInMsg;
            }

            // 2. 统计组件失败详情
            // 【修复】先判断消息是否有效，避免处理纯 Pass/Fail 的短消息
            // 注意：这里保留你原有的 cleanedMsg 长度检查逻辑作为入口判断
            string cleanedMsgCheck = Regex.Replace(lowerMsg, @"\b(pass|fail)\b|\s", "");

            // 如果去除 pass/fail/空格后内容太少，可能不是组件列表，跳过
            if (cleanedMsgCheck.Length <= 4)
            {
                return;
            }

            // 【关键修复】分割字符串
            // 建议同时支持逗号、空格、换行作为分隔符，因为日志格式可能不统一
            string[] rawComponents = message.Split(new[] { ',', ' ', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries);

            lock (_statsLock)
            {
                foreach (var rawComp in rawComponents)
                {
                    // 【关键修复】清洗单个组件名称
                    // 1. 转小写保持一致性（可选，看你需求）
                    // 2. 移除 "pass" 和 "fail" 单词
                    // 3. 移除剩余空格
                    string cleanComp = Regex.Replace(rawComp.Trim(), @"\b(pass|fail)\b", "", RegexOptions.IgnoreCase).Trim();

                    // 再次检查清洗后是否为空或太短（比如原本是 "pass"，清洗后变空）
                    if (string.IsNullOrEmpty(cleanComp) || cleanComp.Length < 3)
                    {
                        continue;
                    }

                    // 可选：如果组件名还包含其他无关字符，可以在此继续清洗

                    // 存入统计字典
                    if (_componentFailStats.ContainsKey(cleanComp))
                    {
                        _componentFailStats[cleanComp]++;
                    }
                    else
                    {
                        _componentFailStats[cleanComp] = 1;
                    }
                }
            }
        }

        /// <summary>
        /// 刷新 UI 显示
        /// </summary>
        private void UpdateDisplayText()
        {
            this.Size = new System.Drawing.Size(300, 350);
            // 计算 FPY (First Pass Yield)
            double fpy = _totalCount == 0 ? 0 : (double)_passCount / _totalCount * 100;
            
            // 如果还没有开始时间（理论上不会进入这里，因为_hasReceivedData为true时已赋值），做个保护
            string startTimeStr = _hasReceivedData ? _startTime.ToString(@"yyyy-MM-dd HH:mm:ss") : "--";

            // 构建基础统计部分
            var sb = new StringBuilder();
            sb.AppendLine($"--- 连接: {_connectionKey} ---");
            sb.AppendLine($"开始时间: {startTimeStr}");
            sb.AppendLine($"Total : {_totalCount}");
            sb.AppendLine($"Pass  : {_passCount}");
            sb.AppendLine($"Fail  : {_totalCount - _passCount}");
            sb.AppendLine($"FPY   : {fpy:F2}%");
            sb.AppendLine("------------------------");
            sb.AppendLine("Top Failed Components:");

            // 构建组件统计部分
            lock (_statsLock)
            {
                // 获取失败次数最多的前 10 个组件
                var topFails = _componentFailStats.OrderByDescending(kvp => kvp.Value)
                                                  .ThenBy(kvp => kvp.Key)
                                                  ;

                if (!topFails.Any())
                {
                    sb.AppendLine("  (无失败记录)");
                }
                else
                {
                    foreach (var kvp in topFails)
                    {
                        // 格式对齐: 组件名左对齐24字符，次数右对齐
                        sb.AppendLine($"  {kvp.Key,-24} : {kvp.Value} 次");
                    }
                }
            }

            // 一次性设置 Text
            if (rtbLog != null)
            {
                rtbLog.Text = sb.ToString();
            }
        }
    }
}