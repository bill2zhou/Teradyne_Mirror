using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.ComponentModel; // 用于 CancelEventArgs

namespace WinFormSocketClient
{
    /// <summary>
    /// 连接配置项，用于管理单个IP:Port的生命周期（包括重连状态）
    /// </summary>
    public class ConnectionItem
    {
        public string Ip { get; set; }
        public int Port { get; set; }
        public TcpClient Client { get; set; }
        
        // 用于取消自动重连循环
        public CancellationTokenSource Cts { get; set; }

        public bool IsConnected => Client != null && Client.Connected;

        public ConnectionItem(string ip, int port)
        {
            Ip = ip;
            Port = port;
            Cts = new CancellationTokenSource();
        }
    }

    public partial class SocketServerForm : Form
    {
        // 管理所有配置的连接目标（无论是否连通）
        private List<ConnectionItem> _connectionConfigs = new List<ConnectionItem>();
        
        // 管理当前物理上已连接的客户端
        private List<TcpClient> _activeClients = new List<TcpClient>();
        private Dictionary<TcpClient, ClientPanel> _clientPanels = new Dictionary<TcpClient, ClientPanel>();
        
        private TcpListener _listener;
        private bool _isListening = false;

        public SocketServerForm()
        {
            InitializeComponent();
            
            // FlowLayoutPanel 初始化
            this.flowLayoutPanel1.AllowDrop = true;
            this.flowLayoutPanel1.DragEnter += FlowLayoutPanel1_DragEnter;
            this.flowLayoutPanel1.DragDrop += FlowLayoutPanel1_DragDrop;
            this.flowLayoutPanel1.WrapContents = true; 
            this.flowLayoutPanel1.AutoScroll = true;
            this.flowLayoutPanel1.FlowDirection = FlowDirection.LeftToRight; 

            // 【关键修改】设置 ListBox 为自绘模式，以实现根据状态显示不同颜色
            this.lstConnections.DrawMode = DrawMode.OwnerDrawFixed;
            this.lstConnections.DrawItem += LstConnections_DrawItem;
        }

        #region UI 自绘逻辑 (实现灰色字体)

        private void LstConnections_DrawItem(object sender, DrawItemEventArgs e)
        {
            if (e.Index < 0) return;

            // 获取绑定的 ConnectionItem 对象
            var item = this.lstConnections.Items[e.Index] as ConnectionItem;
            if (item == null) 
            {
                e.DrawBackground();
                e.DrawFocusRectangle();
                return;
            }

            e.DrawBackground();

            // 如果已连接，使用黑色；否则（重试中/未连接）使用灰色
            Brush textBrush = item.IsConnected ? Brushes.Black : Brushes.Gray;
            
            // 绘制文本
            // 这里直接显示 IP:Port，颜色区分状态
            string displayText = $"{item.Ip}:{item.Port}";
            e.Graphics.DrawString(displayText, e.Font, textBrush, e.Bounds, StringFormat.GenericDefault);

            e.DrawFocusRectangle();
        }

        #endregion

        #region 服务器逻辑

        public async void StartServerAsync(int port = 8888)
        {
             if (_isListening) return;
             try {
                 _listener = new TcpListener(IPAddress.Any, port);
                 _listener.Start();
                 _isListening = true;
                 UpdateStatus($"[服务器] 已启动，监听端口: {port}");
                 
                 while (_isListening) {
                     TcpClient client = await _listener.AcceptTcpClientAsync();
                     _activeClients.Add(client);
                     
                     // 服务器接受的连接不需要重连逻辑，直接使用原有逻辑添加 Panel
                     AddClientPanelForActiveClient(client, "Inbound");
                     _ = HandleClientCommunicationAsync(client, null); // config 为 null 表示无需重连
                 }
             } catch (ObjectDisposedException) { 
                 // 正常停止
             } catch (Exception ex) { 
                 UpdateStatus($"[服务器] 错误: {ex.Message}"); 
             }
        }

        #endregion

        #region 客户端逻辑 (含自动重连)

        /// <summary>
        /// 添加一个新的连接配置，并启动带重试的连接过程
        /// </summary>
        private void AddNewConnectionConfig(string ip, int port)
        {
            // 检查是否已存在相同的配置
            if (_connectionConfigs.Any(c => c.Ip == ip && c.Port == port))
            {
                MessageBox.Show("该连接配置已存在。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            var config = new ConnectionItem(ip, port);
            _connectionConfigs.Add(config);
            
            // 将配置对象添加到 ListBox，UI 会通过 DrawItem 显示它
            this.lstConnections.Items.Add(config);
            
            // 启动异步重连任务
            _ = ConnectWithRetryAsync(config);
        }

        /// <summary>
        /// 带有自动重连逻辑的连接方法
        /// </summary>
        private async Task ConnectWithRetryAsync(ConnectionItem config)
        {
            // 只要没有被取消，就一直尝试
            while (!config.Cts.Token.IsCancellationRequested)
            {
                try
                {
                    // 刷新 UI 状态（变为灰色或黑色取决于连接状态）
                    RefreshListBoxItem(config);

                    TcpClient client = new TcpClient();
                    
                    // 尝试连接，设置超时
                    var connectTask = client.ConnectAsync(config.Ip, config.Port);
                    
                    // 等待连接完成或超时 (5秒)
                    if (await Task.WhenAny(connectTask, Task.Delay(5000, config.Cts.Token)) == connectTask)
                    {
                        await connectTask; // 抛出可能的异常
                        
                        if (client.Connected)
                        {
                            // --- 连接成功 ---
                            config.Client = client;
                            _activeClients.Add(client);
                            
                            // 更新 UI 为黑色（已连接）
                            RefreshListBoxItem(config);
                            
                            // 添加对应的 UI Panel
                            AddClientPanelForActiveClient(client, "Outbound");
                            
                            // 启动通信监听
                            _ = HandleClientCommunicationAsync(client, config);
                            
                            // 成功则退出重试循环，直到连接断开再次进入循环或外部取消
                            // 注意：这里 break 是为了退出当前的 while 尝试连接块。
                            // 实际上，如果连接保持，HandleClientCommunicationAsync 会一直运行。
                            // 当连接断开时，RemoveClient 会被调用，我们需要在那里决定是重试还是停止。
                            // 为了简化模型：ConnectWithRetryAsync 负责“建立连接”。
                            // 一旦建立，它就完成任务退出了。
                            // 如果连接后来断开了，HandleClientCommunicationAsync 的 finally 块会处理重连触发。
                            return; 
                        }
                        else
                        {
                            throw new Exception("连接状态异常");
                        }
                    }
                    else
                    {
                        // 超时
                        client.Close();
                        throw new TimeoutException("连接超时");
                    }
                }
                catch (Exception ex)
                {
                    // 如果是被外部取消（手动删除），则直接退出
                    if (config.Cts.Token.IsCancellationRequested) break;

                    // 连接失败
                    UpdateStatus($"[客户端] 连接失败 {config.Ip}:{config.Port}: {ex.Message}");
                    
                    // 清理资源
                    try { config.Client?.Close(); } catch { }
                    config.Client = null;
                    
                    // 确保 UI 显示为灰色
                    RefreshListBoxItem(config);

                    // 等待 5 秒后重试
                    try
                    {
                        await Task.Delay(5000, config.Cts.Token);
                    }
                    catch (OperationCanceledException)
                    {
                        break; // 等待期间被取消
                    }
                    // 循环继续，再次尝试连接
                }
            }
        }

        /// <summary>
        /// 刷新 ListBox 中特定项的显示
        /// </summary>
        private void RefreshListBoxItem(ConnectionItem config)
        {
            if (this.InvokeRequired)
            {
                this.Invoke(new Action<ConnectionItem>(RefreshListBoxItem), config);
                return;
            }
            
            // 强制重绘整个 ListBox 以更新颜色状态
            // 性能优化：可以只重绘特定 Item，但 Refresh 最简单可靠
            this.lstConnections.Refresh();
        }

        #endregion

        #region UI 管理与通信

        /// <summary>
        /// 为已连接的客户端添加 UI Panel
        /// </summary>
        private void AddClientPanelForActiveClient(TcpClient client, string type)
        {
            if (this.InvokeRequired) { 
                this.Invoke(new Action<TcpClient, string>(AddClientPanelForActiveClient), client, type); 
                return; 
            }
            
            string endPoint = GetClientEndPoint(client);
            string key = $"{endPoint}";
            
            // 注意：ListBox 现在存的是 ConnectionItem 对象，所以这里不再向 lstConnections.Items.Add(key)
            // ListBox 的显示由 DrawItem 控制
            
            var panel = new ClientPanel(key, (connKey, msg) => { SendMessageToClient(client, msg); });
            panel.Size = new Size(300, 150);
            panel.MinimumSize = new Size(300, 150);
            panel.Margin = new Padding(5, 5, 5, 5);
            
            _clientPanels[client] = panel;
            this.flowLayoutPanel1.Controls.Add(panel);
            this.flowLayoutPanel1.ScrollControlIntoView(panel);
        }

        private void SendMessageToClient(TcpClient client, string message)
        {
            Task.Run(async () => {
                try {
                    if (client != null && client.Connected) {
                        byte[] data = Encoding.UTF8.GetBytes(message + "\r\n");
                        await client.GetStream().WriteAsync(data, 0, data.Length);
                    }
                } catch (Exception ex) { UpdateStatus($"[发送错误] {ex.Message}"); }
            });
        }

        /// <summary>
        /// 移除客户端连接
        /// </summary>
        /// <param name="client">要移除的物理连接</param>
        /// <param name="associatedConfig">关联的配置项。如果是服务器端连接或手动删除，可能为 null 或有特定处理</param>
        /// <param name="isManualDisconnect">是否为手动点击断开</param>
        private void RemoveClient(TcpClient client, ConnectionItem associatedConfig, bool isManualDisconnect = false)
        {
            _activeClients.Remove(client);
            
            if (this.InvokeRequired) { 
                this.Invoke(new Action<TcpClient, ConnectionItem, bool>(RemoveClient), client, associatedConfig, isManualDisconnect); 
                return; 
            }
            
            // 1. 清理 UI Panel
            if (_clientPanels.TryGetValue(client, out ClientPanel panel)) {
                this.flowLayoutPanel1.Controls.Remove(panel);
                panel.Dispose();
                _clientPanels.Remove(client);
            }
            
            // 2. 关闭物理连接
            try { client.Close(); } catch { }

            // 3. 处理配置和重连逻辑
            if (isManualDisconnect && associatedConfig != null)
            {
                // --- 手动断开：彻底删除配置，停止重连 ---
                associatedConfig.Cts.Cancel(); // 停止任何正在进行的等待或重试
                
                // 从配置列表移除
                _connectionConfigs.Remove(associatedConfig);
                
                // 从 ListBox 移除
                this.lstConnections.Items.Remove(associatedConfig);
                
                UpdateStatus($"[手动断开] 已移除配置 {associatedConfig.Ip}:{associatedConfig.Port}");
            }
            else if (associatedConfig != null)
            {
                // --- 异常断开：保留配置，触发重连 ---
                UpdateStatus($"[连接断开] {associatedConfig.Ip}:{associatedConfig.Port}，将在5秒后尝试重连...");
                
                // 重置配置中的 Client 引用，标记为未连接
                associatedConfig.Client = null;
                
                // 刷新 UI 变灰
                RefreshListBoxItem(associatedConfig);
                
                // 重新启动重连循环
                _ = ConnectWithRetryAsync(associatedConfig);
            }
            else
            {
                // --- 服务器端连接断开 (associatedConfig 为 null) ---
                // 服务器端连接通常不自动重连（因为是被动接受），只需清理
                string endPoint = GetClientEndPoint(client);
                UpdateStatus($"[服务器] 客户端断开 {endPoint}");
            }
        }

        private async Task HandleClientCommunicationAsync(TcpClient client, ConnectionItem config)
        {
            NetworkStream stream = client.GetStream();
            byte[] lengthBuffer = new byte[4];

            try
            {
                while (client.Connected)
                {
                    // --- 读取长度头 ---
                    int totalBytesRead = 0;
                    while (totalBytesRead < 4)
                    {
                        int bytesRead = await stream.ReadAsync(lengthBuffer, totalBytesRead, 4 - totalBytesRead);               
                        if (bytesRead == 0) return; // 连接关闭
                        totalBytesRead += bytesRead;
                    }
                    Console.WriteLine(totalBytesRead);
                    int messageLength = BitConverter.ToInt32(lengthBuffer, 0);


                    if (messageLength <= 0 || messageLength > 10 * 1024 * 1024) 
                    {
                        throw new InvalidOperationException($"无效的消息长度: {messageLength}");
                    }

                    // --- 读取数据体 ---
                    byte[] dataBuffer = new byte[messageLength];
                    totalBytesRead = 0;
                    while (totalBytesRead < messageLength)
                    {
                        int bytesRead = await stream.ReadAsync(dataBuffer, totalBytesRead, messageLength - totalBytesRead);
                        Console.WriteLine(bytesRead);
                        if (bytesRead == 0) return; // 连接关闭
                        totalBytesRead += bytesRead;
                    }

                    string message = Encoding.UTF8.GetString(dataBuffer);
                    Console.WriteLine(message);
                    if (_clientPanels.TryGetValue(client, out ClientPanel panel))
                    {
                        panel.AppendMessage(message);
                    }
                }
            }

            catch (Exception ex)
            {
                if (!(ex is ObjectDisposedException || ex is IOException || ex is InvalidOperationException))
                {
                    string id = config != null ? $"{config.Ip}:{config.Port}" : GetClientEndPoint(client);
                    UpdateStatus($"[通信错误] {id}: {ex.Message}");
                }
            }
            finally
            {
                // 连接断开，调用 RemoveClient
                // 如果 config 不为 null，说明是出站连接，需要判断是否重连
                // 这里的 finally 捕获的是非手动断开的情况，所以 isManualDisconnect = false
                RemoveClient(client, config, false);
            }
        }

        private string GetClientEndPoint(TcpClient client)
        {
            try { return client.Client.RemoteEndPoint?.ToString() ?? "Unknown"; } catch { return "Disconnected"; }
        }

        private void UpdateStatus(string message)
        {
            string log = $"[{DateTime.Now:HH:mm:ss}] {message}";
            Console.WriteLine(log);
            // 如果需要显示在界面上，可以追加到某个 TextBox
        }

        #endregion

        #region 拖放排序逻辑

        private void FlowLayoutPanel1_DragEnter(object sender, DragEventArgs e)
        {
            if (e.Data.GetDataPresent(typeof(ClientPanel)))
            {
                e.Effect = DragDropEffects.Move;
            }
            else
            {
                e.Effect = DragDropEffects.None;
            }
        }

        private void FlowLayoutPanel1_DragDrop(object sender, DragEventArgs e)
        {
            if (!(e.Data.GetData(typeof(ClientPanel)) is ClientPanel draggedPanel))
                return;

            Point clientPoint = this.flowLayoutPanel1.PointToClient(new Point(e.X, e.Y));
            Control targetControl = this.flowLayoutPanel1.GetChildAtPoint(clientPoint);

            int targetIndex = -1;

            if (targetControl != null && targetControl is ClientPanel)
            {
                targetIndex = this.flowLayoutPanel1.Controls.IndexOf(targetControl);
            }
            else
            {
                for (int i = 0; i < this.flowLayoutPanel1.Controls.Count; i++)
                {
                    Control c = this.flowLayoutPanel1.Controls[i];
                    if (c == draggedPanel) continue;

                    Point loc = c.Location;
                    Size size = c.Size;

                    if (this.flowLayoutPanel1.FlowDirection == FlowDirection.LeftToRight ||
                        this.flowLayoutPanel1.FlowDirection == FlowDirection.RightToLeft)
                    {
                        if (clientPoint.X < loc.X + size.Width / 2)
                        {
                            targetIndex = i;
                            break;
                        }
                    }
                    else 
                    {
                        if (clientPoint.Y < loc.Y + size.Height / 2)
                        {
                            targetIndex = i;
                            break;
                        }
                    }
                }

                if (targetIndex == -1)
                {
                    targetIndex = this.flowLayoutPanel1.Controls.Count;
                }
            }

            int draggedIndex = this.flowLayoutPanel1.Controls.IndexOf(draggedPanel);

            if (targetIndex != -1 && targetIndex != draggedIndex)
            {
                this.flowLayoutPanel1.Controls.SetChildIndex(draggedPanel, targetIndex);
            }
        }

        #endregion

        #region 事件处理

        private void lstConnections_MouseDown(object sender, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Right)
            {
                int index = this.lstConnections.IndexFromPoint(e.Location);
                
                if (index == ListBox.NoMatches)
                {
                    this.lstConnections.ClearSelected();
                }
                else
                {
                    this.lstConnections.SelectedIndex = index;
                }
            }
        }

        private void contextMenuStrip1_Opening(object sender, CancelEventArgs e)
        {
            bool hasSelection = this.lstConnections.SelectedIndex != -1;

            // “添加连接”只在空白处显示
            this.toolStripMenuItem1.Visible = !hasSelection;
            
            // “断开连接”只在有选中项时显示
            this.toolStripMenuItem2.Visible = hasSelection;

            if (!this.toolStripMenuItem1.Visible && !this.toolStripMenuItem2.Visible)
            {
                this.toolStripMenuItem1.Visible = true;
            }
        }

        private void contextMenuAddConnection_Click(object sender, EventArgs e)
        {
            using (var dialog = new InputDialog())
            {
                if (dialog.ShowDialog(this) == DialogResult.OK)
                {
                    string ip = dialog.IpAddress;
                    int port = dialog.Port;
                    if (!string.IsNullOrEmpty(ip) && port > 0 && port <= 65535)
                    {
                        // 使用新的添加配置方法
                        AddNewConnectionConfig(ip, port);
                    }
                    else
                    {
                        MessageBox.Show("请输入有效的 IP 地址和端口号 (1-65535)。", "输入错误", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    }
                }
            }
        }

        private void contextMenuDisconnect_Click(object sender, EventArgs e)
        {
            if (this.lstConnections.SelectedIndex == -1) return;

            // 获取选中的 ConnectionItem
            var selectedConfig = this.lstConnections.SelectedItem as ConnectionItem;
            if (selectedConfig == null) return;

            string displayText = $"{selectedConfig.Ip}:{selectedConfig.Port}";

            if (MessageBox.Show($"确定要断开并删除连接 {displayText} 吗？\n(删除后将不再自动重连)", "确认断开", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes)
            {
                // 如果当前有活跃连接，先关闭它，并标记为手动断开
                if (selectedConfig.Client != null && selectedConfig.Client.Connected)
                {
                    RemoveClient(selectedConfig.Client, selectedConfig, true);
                }
                else
                {
                    // 如果当前没连上（正在重试或从未连上），直接取消任务并移除
                    selectedConfig.Cts.Cancel();
                    _connectionConfigs.Remove(selectedConfig);
                    this.lstConnections.Items.Remove(selectedConfig);
                    UpdateStatus($"[已删除] 配置 {displayText}");
                }
            }
        }

        private void lstConnections_SelectedIndexChanged(object sender, EventArgs e)
        {
            // 联动逻辑可在此扩展
        }

        private void SocketServerForm_FormClosing(object sender, FormClosingEventArgs e)
        {
            _isListening = false;
            _listener?.Stop();
            
            // 取消所有重连任务
            foreach (var config in _connectionConfigs)
            {
                config.Cts.Cancel();
                try { config.Client?.Close(); } catch { }
            }
            
            // 关闭所有活跃客户端
            foreach (var client in new List<TcpClient>(_activeClients)) { try { client.Close(); } catch { } }
            
            _connectionConfigs.Clear();
            _activeClients.Clear();
            _clientPanels.Clear();
        }

        #endregion
    }

    /// <summary>
    /// 添加连接对话框，支持IP下拉选择和手动输入
    /// </summary>
    public class InputDialog : Form
    {
        private ComboBox cmbIpHistory;
        private TextBox txtPort;
        private Button btnOk;
        private Button btnCancel;
        private Label lblIp;
        private Label lblPort;

        public string IpAddress 
        { 
            get { return cmbIpHistory.Text.Trim(); } 
        }

        public int Port 
        { 
            get 
            { 
                if (int.TryParse(txtPort.Text.Trim(), out int port)) 
                    return port; 
                return 0; 
            } 
        }

        public InputDialog() 
        { 
            InitializeComponents(); 
        }

        private void InitializeComponents()
        {
            this.Text = "添加连接";
            this.Size = new Size(320, 150); 
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.StartPosition = FormStartPosition.CenterParent;
            this.MaximizeBox = false;
            this.MinimizeBox = false;

            lblIp = new Label { Text = "IP 地址:", Location = new Point(10, 15), AutoSize = true };
            
            cmbIpHistory = new ComboBox 
            { 
                Location = new Point(80, 12), 
                Width = 180, 
                DropDownStyle = ComboBoxStyle.DropDown, 
                Text = "" 
            };
            cmbIpHistory.Items.AddRange(new object[] { "192.188.2.34", "192.188.2.35", "192.188.2.64", "192.188.2.65", "192.188.2.74", "192.188.2.75", "127.0.0.1" });

            lblPort = new Label { Text = "端口:", Location = new Point(10, 45), AutoSize = true };
            txtPort = new TextBox { Location = new Point(80, 42), Width = 180, Text = "8888" };

            btnOk = new Button { Text = "确定", DialogResult = DialogResult.OK, Location = new Point(120, 80), Width = 75 };
            btnCancel = new Button { Text = "取消", DialogResult = DialogResult.Cancel, Location = new Point(210, 80), Width = 75 };

            this.Controls.AddRange(new Control[] { lblIp, cmbIpHistory, lblPort, txtPort, btnOk, btnCancel });
            
            this.AcceptButton = btnOk;
            this.CancelButton = btnCancel;
        }
    }
}