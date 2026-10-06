# Socket 多客户端监控工具 (Electron 版)

这是对原有 WinForm 版「WinForm Socket 多客户端监控」程序的 Electron 重写版。

## 功能特性

- **TCP 服务器**：监听指定端口，接受入站客户端连接
- **TCP 客户端**：添加多个连接目标（IP:Port），支持自动重连（失败或断开后 5 秒重试）
- **绑定双 IP**：通过「绑定两个 IP」将两台设备合并到一个监控窗口（上下两部分分别显示各自的日志与状态），两个 IP 同时建立独立连接
- **实时监控面板**：每个连接一个卡片，显示 Total / Pass / Fail / FPY 以及失败组件排行；绑定面板为上下两栏合并窗口
- **最新失败零件高亮**：本次更新涉及的组件在日志中以红色加粗显示，便于快速定位
- **消息解析**：识别 `pass`/`fail` 统计，检测 `continuetestfailed`（连续测试不良）和 `stationerror`（站别错误）
- **连接管理**：左侧列表显示所有连接，颜色区分状态（正常/连接中/断开）
- **右键菜单**：列表空白处右键添加连接 / 绑定两个 IP，选中项可断开连接
- **重置统计**：每个面板标题栏右上角「重置」按钮，一键清零该面板统计；绑定面板重置整组
- **拖放排序**：拖拽面板标题栏可调整面板顺序
- **Web 只读同步**：内置 Web 服务（端口 8090），浏览器打开即可实时只读查看监控界面；增删连接、重置等操作仅在软件上进行
- **消息协议**：4 字节大端长度头 + UTF-8 数据体（与原程序一致）

## 目录结构

```
electron/
├── package.json          # 项目配置与依赖（含打包配置）
├── main.js               # 主进程：窗口、TCP 服务器/客户端、IPC、Web 同步
├── preload.js            # 安全的 IPC 桥接
├── messageParser.js      # 消息统计解析模块
├── webserver.js          # Web 静态服务 + SSE 实时推送（8090，只读）
├── build/
│   ├── icon.ico          # Windows 应用图标
│   └── make_icon.js      # PNG -> ICO 转换脚本
├── renderer/
│   ├── index.html        # 界面结构
│   ├── style.css         # 深色主题样式
│   ├── renderer.js       # 前端逻辑（面板、列表、拖放、对话框、绑定面板）
│   └── webapi.js         # 浏览器端 socketAPI（SSE 同步，只读）
└── README.md
```

## 安装与运行

```bash
cd electron
npm install          # 安装 Electron 及依赖
npm start            # 启动应用
```

> 首次 `npm install` 会下载 Electron 二进制文件，可能需要一些时间。

## Web 浏览器查看

应用运行后，在浏览器打开 `http://localhost:8090` 即可实时只读查看监控界面（SSE 推送，与软件端同步）。

## 打包为可执行文件

```bash
cd electron
npm run dist         # 使用 electron-builder 打包，输出到 dist_new/
```

产物：

- `dist_new/SocketMonitor Setup 1.0.0.exe` — Windows 安装程序（含应用图标）
- `dist_new/win-unpacked/SocketMonitor.exe` — 免安装绿色版

更换图标：将 `build/icon.ico` 替换为新图标（可用 `node build/make_icon.js <png> <ico>` 转换），再重新打包。

## 使用方法

1. **启动服务器**：在顶部输入端口号（默认 8888），点击「启动服务器」
2. **添加连接**：在左侧列表空白处右键选择「添加连接」，输入 IP 和端口
3. **绑定两个 IP**：在左侧列表空白处右键选择「绑定两个 IP」，填写两台设备的 IP/端口（两者不能完全相同）；两个 IP 同时建立连接，合并为一个上下两栏的监控窗口
4. **查看监控**：每个连接右侧显示统计面板；面板标题栏可拖拽调整顺序；绑定面板上下两栏分别显示两台设备的日志与连接状态
5. **重置统计**：点击面板标题栏右上角「重置」按钮（绑定面板重置整组）
6. **断开连接**：在左侧列表右键选中项，选择「断开连接」（将删除并停止重连）
