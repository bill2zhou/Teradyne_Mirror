const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { StatsTracker } = require('./messageParser');
const { startWebServer, broadcastToWeb } = require('./webserver');

// ============ 应用窗口 ============
function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 700,
    title: 'Socket 多客户端监控',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  loadStatsStore(); // 恢复本地保存的统计，重开后统计接续
  createWindow();

  // 启动 Web 服务，浏览器可通过 http://localhost:8090 只读查看页面（操作仅在软件上进行）
  startWebServer({
    getSnapshot: getWebSnapshot,
  });

  // 每天 8:00 / 20:00 自动重置所有窗口统计与日志
  scheduleAutoReset();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // 关闭时清理所有连接
  shutdownAll();
  writeStatsNow(); // 退出前把统计写入本地，保证重开后数据完整
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  writeStatsNow();
});

// ============ 连接管理 ============
// 所有配置的连接目标（无论是否连通）
const connectionConfigs = new Map(); // key: "ip:port" -> config
// 活跃的物理连接
const activeClients = new Set();      // TcpClient 对象集合
// 监听器
let server = null;
let isListening = false;

let mainWindow = null;

function getWindow() {
  return BrowserWindow.getAllWindows()[0] || null;
}

function sendToRenderer(channel, payload) {
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
  // 同时推送给浏览器 Web 端（SSE 客户端）
  broadcastToWeb(channel, payload);
}

function log(message) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`;
  console.log(line);
  sendToRenderer('status-log', { text: line });
}

// ============ TCP 服务器 ============
function startServer(port) {
  return new Promise((resolve) => {
    if (isListening) {
      resolve({ ok: true, message: '服务器已在运行' });
      return;
    }
    server = new net.Server((socket) => {
      const config = null; // 入站连接无需重连
      registerActiveClient(socket, null);
      handleClientCommunication(socket, null);
    });
    server.on('error', (err) => {
      log(`[服务器] 错误: ${err.message}`);
      resolve({ ok: false, message: err.message });
    });
    server.listen(port, () => {
      isListening = true;
      log(`[服务器] 已启动，监听端口: ${port}`);
      sendToRenderer('server-state', { listening: true, port });
      resolve({ ok: true, message: `已监听 ${port}` });
    });
  });
}

function stopServer() {
  if (server) {
    try { server.close(); } catch (e) { /* ignore */ }
    server = null;
  }
  if (isListening) {
    isListening = false;
    log('[服务器] 已停止');
    sendToRenderer('server-state', { listening: false, port: null });
  }
}

// ============ 客户端（含自动重连） ============
class ConnectionConfig {
  constructor(ip, port, groupId = null) {
    this.ip = ip;
    this.port = port;
    this.groupId = groupId; // 绑定组标识；null 表示独立连接
    this.client = null;
    this.retryTimer = null;
    this.cancelled = false;
    this.isConnected = false;
    this.connecting = false;
    // 每个连接独立维护统计状态（对应原 ClientPanel 内部统计）
    this.stats = new StatsTracker(`${ip}:${port}`);
  }
  get key() {
    return `${this.ip}:${this.port}`;
  }
}

// ============ 统计状态本地持久化 ============
// 面板数据保存在本地：统计随连接配置一起持久化，重开应用后恢复，
// 保证收到新数据时统计在旧数据基础上累加，而不是被新数据清掉
const statsStore = new Map(); // key(ip:port) -> StatsTracker 序列化数据（连接删除后也保留）
let statsSaveTimer = null;

function statsFilePath() {
  return path.join(app.getPath('userData'), 'socket-stats.json');
}

// 防抖写盘（高频消息合并为低频写入）
function scheduleStatsSave() {
  if (statsSaveTimer) return;
  statsSaveTimer = setTimeout(() => {
    statsSaveTimer = null;
    writeStatsNow();
  }, 500);
}

function writeStatsNow() {
  try {
    const obj = {};
    for (const [key, data] of statsStore) obj[key] = data;
    fs.writeFileSync(statsFilePath(), JSON.stringify(obj));
  } catch (e) { /* 写入失败不影响运行 */ }
}

function loadStatsStore() {
  try {
    const raw = fs.readFileSync(statsFilePath(), 'utf8');
    const obj = JSON.parse(raw);
    for (const [key, data] of Object.entries(obj)) statsStore.set(key, data);
  } catch (e) { /* 无文件或读取失败 */ }
}

// 把某连接的统计同步进本地存储
function syncConfigStats(config) {
  if (!config || !config.stats) return;
  statsStore.set(config.key, config.stats.toJSON());
  scheduleStatsSave();
}

// 添加单个连接；emitAdded 控制是否向界面发送 connection-added（绑定组不单独发，由 bonded-added 统一建面板）
function addSingleConnection(ip, port, groupId = null, emitAdded = true) {
  const key = `${ip}:${port}`;
  if (connectionConfigs.has(key)) {
    return { ok: false, message: '该连接配置已存在' };
  }
  const config = new ConnectionConfig(ip, port, groupId);
  // 恢复本地保存的统计（重开应用后统计接续，不从头计数）
  if (statsStore.has(key)) {
    config.stats = StatsTracker.fromJSON(statsStore.get(key));
  }
  connectionConfigs.set(key, config);
  if (emitAdded) sendToRenderer('connection-added', { key, isConnected: false });
  connectWithRetry(config);
  return { ok: true, key };
}

function addConnection(ip, port) {
  return addSingleConnection(ip, port, null, true);
}

// 绑定两个 IP：同时建立两个独立连接（各自独立收发），界面上合成一个窗口、上下两部分显示
function addBondedConnection(ip1, port1, ip2, port2) {
  const groupId = `${ip1}:${port1} <=> ${ip2}:${port2}`;
  const r1 = addSingleConnection(ip1, port1, groupId, false);
  const r2 = addSingleConnection(ip2, port2, groupId, false);
  if (r1.ok && r2.ok) {
    sendToRenderer('bonded-added', { groupId, key1: r1.key, key2: r2.key });
  }
  return { ok: r1.ok || r2.ok, results: [r1, r2] };
}

function connectWithRetry(config) {
  if (config.cancelled) return;

  clearTimeout(config.retryTimer);
  config.connecting = true;
  refreshConfigState(config);

  const socket = new net.Socket();
  const timeout = setTimeout(() => {
    socket.destroy();
    handleConnectFailure(config, '连接超时');
  }, 5000);

  socket.once('connect', () => {
    clearTimeout(timeout);
    config.connecting = false;
    config.client = socket;
    config.isConnected = true;
    refreshConfigState(config);
    activeClients.add(socket);
    // 绑定组的面板由 bonded-added 统一创建，不再单独发送 panel-added
    if (!config.groupId) {
      sendToRenderer('panel-added', { key: config.key, type: 'Outbound' });
    }
    handleClientCommunication(socket, config);
  });

  socket.once('error', (err) => {
    clearTimeout(timeout);
    handleConnectFailure(config, err.message);
  });

  socket.connect(config.port, config.ip);
}

function handleConnectFailure(config, message) {
  if (config.cancelled) return;
  config.connecting = false;
  config.client = null;
  config.isConnected = false;
  log(`[客户端] 连接失败 ${config.key}: ${message}`);
  refreshConfigState(config);
  // 5 秒后重试
  config.retryTimer = setTimeout(() => connectWithRetry(config), 5000);
}

function refreshConfigState(config) {
  sendToRenderer('connection-state', { key: config.key, isConnected: config.isConnected, connecting: config.connecting });
}

// ============ 通信与数据处理 ============
function registerActiveClient(socket, config) {
  activeClients.add(socket);
}

function handleClientCommunication(socket, config) {
  // 协议模式：'length'（4 字节长度头）或 'text'（\n/\r\n 文本行）
  // 原 WinForm 程序接收使用长度头协议，发送使用文本行协议，
  // 因此这里做一次自适应判定，避免固定协议导致收发不对称而解析错乱。
  let protocolMode = null;

  let buffer = Buffer.alloc(0);

  // 每个连接一个独立统计器（入站连接用对端地址作为 key）
  const stats = config ? config.stats : new StatsTracker(getEndPoint(socket));

  // 发送一条消息到界面（由 StatsTracker 解析后发送显示文本）
  function emitMessage(message) {
    const key = config ? config.key : getEndPoint(socket);
    const result = stats.process(message);
    if (result) {
      sendToRenderer('message-received', { key, message: result.display, flag: result.flag });
      if (config) syncConfigStats(config); // 更新统计后同步到本地存储
    }
  }

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    // 尚未确定协议时先探测
    if (!protocolMode) {
      protocolMode = detectProtocol(buffer);
      // 探测需要至少 4 字节（长度头）才能判断，若不足则等待更多数据
      if (!protocolMode) return;
    }

    if (protocolMode === 'length') {
      parseLengthHeader();
    } else {
      parseTextLines();
    }
  });

  /**
   * 探测协议：
   * 1) 如果前 4 字节的大端整数是一个"合理长度"且完整消费后能解析出完整消息，
   *    则判定为长度头协议（与原程序一致）。
   * 2) 如果数据里出现换行符（\n），判定为文本行协议。
   * 3) 否则暂不确定，返回 null 等待更多数据。
   * 采用"长度头优先、换行符确认"策略，降低对纯文本消息（如 "pass"）的误判。
   */
  function detectProtocol(buf) {
    if (buf.length < 4) return null;

    const len = buf.readInt32LE(0);

    if (len > 0 && len <= 10 * 1024 * 1024) {
      // 若长度头声称的完整消息已收齐，且剩余无残留，视为长度头协议
      if (buf.length >= 4 + len) {
        return 'length';
      }
    }

    // 检查是否含换行符 -> 文本行协议
    if (buf.indexOf('\n') >= 0) {
      return 'text';
    }

    return null;
  }

  // 4 字节大端长度头 + 数据体（与原程序一致）
  function parseLengthHeader() {
    while (buffer.length >= 4) {
      const messageLength = buffer.readInt32LE(0);
      if (messageLength <= 0 || messageLength > 10 * 1024 * 1024) {
        // 非法长度：丢弃前 4 字节，继续尝试下一个
        buffer = buffer.subarray(4);
        continue;
      }
      if (buffer.length < 4 + messageLength) break; // 数据未收完整
      const payload = buffer.subarray(4, 4 + messageLength);
      buffer = buffer.subarray(4 + messageLength);
      emitMessage(payload.toString('utf8'));
    }
  }

  // 文本行协议：按 \n 分隔，兼容纯文本服务端
  function parseTextLines() {
    let text = buffer.toString('utf8');
    let newlineIdx;
    while ((newlineIdx = text.indexOf('\n')) >= 0) {
      let line = text.slice(0, newlineIdx);
      text = text.slice(newlineIdx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim().length > 0) emitMessage(line);
    }
    // 剩余未完成的半行留到下一包
    buffer = Buffer.from(text, 'utf8');
  }

  socket.on('error', () => { /* 错误在 close 中统一处理 */ });

  socket.on('close', () => {
    activeClients.delete(socket);
    if (config) {
      // 出站连接异常断开 -> 自动重连
      config.client = null;
      config.isConnected = false;
      refreshConfigState(config);
      log(`[连接断开] ${config.key}，将在5秒后尝试重连...`);
      config.retryTimer = setTimeout(() => connectWithRetry(config), 5000);
    } else {
      log(`[服务器] 客户端断开 ${getEndPoint(socket)}`);
    }
  });
}

function sendMessageTo(key, message) {
  const config = connectionConfigs.get(key);
  const target = config && config.client;
  if (target && !target.destroyed) {
    const data = Buffer.from(message + '\r\n', 'utf8');
    target.write(data, (err) => {
      if (err) log(`[发送错误] ${key}: ${err.message}`);
    });
  }
}

function getEndPoint(socket) {
  try {
    const addr = socket.remoteAddress;
    const port = socket.remotePort;
    return `${addr}:${port}`;
  } catch (e) {
    return 'Unknown';
  }
}

// ============ 手动断开 / 删除连接 ============
function disconnectConnection(key) {
  const config = connectionConfigs.get(key);
  if (!config) return;
  config.cancelled = true;
  clearTimeout(config.retryTimer);
  if (config.client && !config.client.destroyed) {
    config.client.destroy();
  }
  activeClients.delete(config.client);
  config.client = null;
  connectionConfigs.delete(key);
  sendToRenderer('connection-removed', { key });
  log(`[手动断开] 已移除配置 ${key}`);
}

// ============ Web 端状态快照 ============
// 浏览器首次建立 SSE 连接时，推送当前所有连接/面板/统计的现状
function getWebSnapshot() {
  const events = [];
  const bonded = {}; // groupId -> [keys]

  // 先收集绑定组，再收集单个连接的通用状态
  for (const [key, config] of connectionConfigs) {
    if (config.groupId) {
      if (!bonded[config.groupId]) bonded[config.groupId] = [];
      bonded[config.groupId].push(key);
    }
  }

  // 绑定组：先发送 bonded-added，确保合并面板优先创建
  for (const [groupId, keys] of Object.entries(bonded)) {
    events.push({ type: 'bonded-added', payload: { groupId, key1: keys[0], key2: keys[1] } });
  }

  for (const [key, config] of connectionConfigs) {
    if (!config.groupId) {
      events.push({ type: 'connection-added', payload: { key, isConnected: config.isConnected } });
    }
    events.push({
      type: 'connection-state',
      payload: { key, isConnected: config.isConnected, connecting: config.connecting },
    });
    if (config.stats && config.stats.hasReceivedData) {
      events.push({
        type: 'message-received',
        payload: { key, message: config.stats.buildDisplayText(), flag: 'normal' },
      });
    }
  }

  return events;
}

// ============ 每日定时自动重置 ============
// 每天 8:00 / 20:00 自动重置所有窗口的统计与日志（与手动"重置"等效）
function scheduleAutoReset() {
  const now = new Date();
  const currentSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  const targets = [8 * 3600, 20 * 3600]; // 8:00 与 20:00（秒）

  // 找今天剩余的下一个触发点；若都已过，则取明天 8:00
  let next = null;
  for (const t of targets) {
    if (t > currentSec) { next = t; break; }
  }
  if (next === null) next = targets[0] + 24 * 3600;

  const delay = (next - currentSec) * 1000;
  setTimeout(() => {
    performAutoReset();
    scheduleAutoReset(); // 重新调度下一次
  }, delay);
}

function performAutoReset() {
  for (const config of connectionConfigs.values()) {
    if (config.stats) config.stats.reset();
  }
  statsStore.clear();
  writeStatsNow();
  log('[自动重置] 已重置所有窗口统计与日志');
  sendToRenderer('stats-reset-all', {});
}

// ============ 关闭清理 ============
function shutdownAll() {
  stopServer();
  for (const [key, config] of connectionConfigs) {
    config.cancelled = true;
    clearTimeout(config.retryTimer);
    if (config.client && !config.client.destroyed) config.client.destroy();
  }
  connectionConfigs.clear();
  activeClients.clear();
}

// ============ IPC 处理 ============
ipcMain.handle('server:start', async (e, port) => await startServer(port));
ipcMain.handle('server:stop', () => { stopServer(); return { ok: true }; });
ipcMain.handle('connection:add', (e, { ip, port }) => addConnection(ip, port));
ipcMain.handle('connection:addBonded', (e, { ip1, port1, ip2, port2 }) => addBondedConnection(ip1, port1, ip2, port2));
ipcMain.handle('connection:disconnect', (e, key) => { disconnectConnection(key); return { ok: true }; });
ipcMain.handle('message:send', (e, { key, message }) => { sendMessageTo(key, message); return { ok: true }; });
ipcMain.handle('stats:reset', (e, key) => {
  // 若 key 是绑定组 groupId，则重置组内所有连接；否则重置单个连接
  if (connectionConfigs.has(key)) {
    connectionConfigs.get(key).stats.reset();
    statsStore.delete(key);
  } else {
    for (const config of connectionConfigs.values()) {
      if (config.groupId === key && config.stats) {
        config.stats.reset();
        statsStore.delete(config.key);
      }
    }
  }
  writeStatsNow(); // 重置后立即同步本地存储
  return { ok: true };
});
