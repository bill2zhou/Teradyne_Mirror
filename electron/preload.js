const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('socketAPI', {
  // 连接
  addConnection: (ip, port) => ipcRenderer.invoke('connection:add', { ip, port }),
  addBondedConnection: (ip1, port1, ip2, port2) =>
    ipcRenderer.invoke('connection:addBonded', { ip1, port1, ip2, port2 }),
  disconnectConnection: (key) => ipcRenderer.invoke('connection:disconnect', key),

  // 发送
  sendMessage: (key, message) => ipcRenderer.invoke('message:send', { key, message }),

  // 统计
  resetStats: (key) => ipcRenderer.invoke('stats:reset', key),

  // 事件监听
  onConnectionAdded: (cb) => ipcRenderer.on('connection-added', (e, data) => cb(data)),
  onConnectionRemoved: (cb) => ipcRenderer.on('connection-removed', (e, data) => cb(data)),
  onConnectionState: (cb) => ipcRenderer.on('connection-state', (e, data) => cb(data)),
  onPanelAdded: (cb) => ipcRenderer.on('panel-added', (e, data) => cb(data)),
  onBondedAdded: (cb) => ipcRenderer.on('bonded-added', (e, data) => cb(data)),
  onMessageReceived: (cb) => ipcRenderer.on('message-received', (e, data) => cb(data)),
  onStatsResetAll: (cb) => ipcRenderer.on('stats-reset-all', (e, data) => cb(data)),
});
