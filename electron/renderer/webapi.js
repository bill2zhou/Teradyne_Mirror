/**
 * 浏览器端(Web 服务器)的 socketAPI 实现 —— 只读模式
 * 浏览器只负责同步显示界面，不提供任何操作能力（添加连接/断开/发送/重置等只在 Electron 软件上进行）。
 * 通过 SSE 接收主进程推送的事件来更新界面。
 * 若 Electron preload 已注入 window.socketAPI（IPC 版本），则本脚本自动跳过。
 */
(function () {
  if (window.socketAPI) return; // Electron 环境已由 preload 注入

  // 标记当前为浏览器(只读)环境，供 renderer.js 隐藏操作入口
  window.__IS_WEB__ = true;

  const BASE = '';

  // 操作类方法在浏览器端一律为无效操作（界面只读）
  const noop = async () => ({ ok: true });

  const listeners = {
    'connection-added': [],
    'connection-removed': [],
    'connection-state': [],
    'panel-added': [],
    'bonded-added': [],
    'message-received': [],
    'stats-reset-all': [],
  };
  const on = (channel) => (cb) => { listeners[channel].push(cb); };

  // 建立 SSE 连接接收主进程推送的事件
  const es = new EventSource(BASE + '/events');
  es.onmessage = (ev) => {
    try {
      const { channel, payload } = JSON.parse(ev.data);
      const cbs = listeners[channel];
      if (cbs) for (const cb of cbs) cb(payload);
    } catch (e) { /* 忽略无法解析的消息 */ }
  };

  window.socketAPI = {
    // 操作类方法（只读，浏览器端无效）
    addConnection: noop,
    addBondedConnection: noop,
    disconnectConnection: noop,
    sendMessage: noop,
    resetStats: noop,

    // 事件监听（用于界面同步）
    onConnectionAdded: on('connection-added'),
    onConnectionRemoved: on('connection-removed'),
    onConnectionState: on('connection-state'),
    onPanelAdded: on('panel-added'),
    onBondedAdded: on('bonded-added'),
    onMessageReceived: on('message-received'),
    onStatsResetAll: on('stats-reset-all'),
  };
})();
