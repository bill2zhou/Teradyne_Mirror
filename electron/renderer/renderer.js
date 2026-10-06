// ============ 状态管理 ============
// 每个连接对应一个面板，保存统计信息
const panels = {}; // key -> { element, logEl, titleEl, stats: {logText} }

// 绑定组：groupId -> { element, titlebar, halves: [{key, logEl, statusEl}], orderKey }
// 绑定组内的两个 IP 合并到一个窗口、上下两部分显示
const bondedGroups = {};
// key -> groupId，用于把某个连接的 state/message 路由到对应绑定面板
const bondedKeys = {};

// 浏览器(Web)环境为只读，仅同步界面，不提供操作；Electron 中由 preload 注入真实 API
const IS_WEB = !!window.__IS_WEB__;

// 连接列表 key -> { isConnected }
const connections = {};

// 面板顺序（用于拖放排序）
let panelOrder = [];

// 拖放状态
let dragPanelKey = null;

// ============ 本地持久化 ============
// 只保存各窗口(面板)的数据(日志)，窗口重开自动加载；删除/关闭面板不删数据；重置时清空对应数据
// singles: 普通连接配置(重开自动重连)；logs: 各窗口日志内容。绑定关系与面板顺序不保存
const STORAGE_KEY = 'socketMonitorPersist';
let persistData = { singles: {}, logs: {} };
let persistTimer = null;

// key 形如 "ip:port"，解析出 ip / port
function parseKey(key) {
  const idx = key.lastIndexOf(':');
  return { ip: key.slice(0, idx), port: parseInt(key.slice(idx + 1), 10) };
}

// 防抖写入本地（高频消息合并为低频写盘）
function flushPersist() {
  if (IS_WEB) return;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persistData));
    } catch (e) { /* 存储失败不影响运行 */ }
  }, 200);
}

function loadPersist() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return {
      singles: data.singles || {},
      logs: data.logs || {},
    };
  } catch (e) {
    return null;
  }
}

// 退出前强制写盘，避免最后一条数据丢失
window.addEventListener('beforeunload', () => {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!IS_WEB) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persistData));
    } catch (e) { /* ignore */ }
  }
});

// ============ DOM 引用 ============
const panelContainerEl = document.getElementById('panelContainer');
const contextMenuEl = document.getElementById('contextMenu');
const addDialogEl = document.getElementById('addDialog');
const bindDialogEl = document.getElementById('bindDialog');
const sendDialogEl = document.getElementById('sendDialog');

// ============ 面板创建 ============
function createPanel(key, type) {
  if (panels[key]) return panels[key];

  const panel = document.createElement('div');
  panel.className = 'client-panel';
  panel.dataset.key = key;

  // 标题栏
  const titlebar = document.createElement('div');
  titlebar.className = 'panel-titlebar';
  titlebar.innerHTML = `<span class="panel-title">${key}</span>
    <span class="titlebar-right">
      <span class="conn-status"></span>
      <button class="btn-reset" title="重置统计" ${IS_WEB ? 'style="display:none"' : ''}>重置</button>
      <button class="btn-close" title="断开连接并关闭" ${IS_WEB ? 'style="display:none"' : ''}>关闭</button>
    </span>`;
  titlebar.title = '拖拽可调整面板顺序';

  // 日志区域
  const logEl = document.createElement('div');
  logEl.className = 'panel-log';
  logEl.textContent = '';

  panel.appendChild(titlebar);
  panel.appendChild(logEl);

  // 标题栏右上角"重置"按钮
  const resetBtn = titlebar.querySelector('.btn-reset');
  // 阻止 mousedown 冒泡，避免点按钮时触发标题栏拖拽排序
  resetBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  resetBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    resetPanelStats(key);
  });

  // 标题栏右上角"关闭"按钮：断开连接并关闭此面板
  const closeBtn = titlebar.querySelector('.btn-close');
  closeBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    disconnectConnection(key);
  });

  // 拖放排序 - 从标题栏启动
  titlebar.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;

    const moveHandler = (ev) => {
      if (!moved && (Math.abs(ev.clientX - startX) > 5 || Math.abs(ev.clientY - startY) > 5)) {
        moved = true;
        startDrag(key);
      }
      if (moved) moveDragPanel(ev.clientX, ev.clientY);
    };
    const upHandler = () => {
      document.removeEventListener('mousemove', moveHandler);
      document.removeEventListener('mouseup', upHandler);
      if (moved) endDrag();
    };
    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup', upHandler);
  });

  panelContainerEl.appendChild(panel);
  panels[key] = { element: panel, logEl, titlebar, logText: '' };
  panelOrder.push(key);
  // 恢复本地保存的该窗口日志（窗口重开 / 重新添加同一连接时自动加载）
  const saved = persistData.logs[key];
  if (saved) {
    panels[key].logEl.innerHTML = renderLogText(saved);
    panels[key].logText = saved;
    panels[key].logEl.classList.add('grown');
  }
  return panels[key];
}

// ============ 绑定面板（一个窗口、上下两部分） ============
function createBondedPanel(groupId, key1, key2) {
  if (bondedGroups[groupId]) return bondedGroups[groupId];

  const panel = document.createElement('div');
  panel.className = 'client-panel bonded-panel';
  panel.dataset.key = groupId;

  // 标题栏
  const titlebar = document.createElement('div');
  titlebar.className = 'panel-titlebar';
  titlebar.innerHTML = `<span class="panel-title">绑定: ${escapeHtml(key1)} / ${escapeHtml(key2)}</span>
    <span class="titlebar-right">
      <button class="btn-reset" title="重置统计" ${IS_WEB ? 'style="display:none"' : ''}>重置</button>
      <button class="btn-close" title="断开连接并关闭" ${IS_WEB ? 'style="display:none"' : ''}>关闭</button>
    </span>`;
  titlebar.title = '拖拽可调整面板顺序';

  // 标题栏置于最上方
  panel.appendChild(titlebar);

  // 上下两个日志区（isTop: 上半部分，高度占比更高）
  function makeHalf(key, isTop) {
    const half = document.createElement('div');
    half.className = isTop ? 'bonded-half bonded-half-top' : 'bonded-half';
    const head = document.createElement('div');
    head.className = 'bonded-half-title';
    const statusEl = document.createElement('span');
    statusEl.className = 'bonded-half-status';
    head.innerHTML = `<span class="bonded-half-key">${escapeHtml(key)}</span>`;
    head.appendChild(statusEl);
    const logEl = document.createElement('div');
    logEl.className = 'panel-log bonded-log';
    logEl.textContent = '';
    half.appendChild(head);
    half.appendChild(logEl);
    panel.appendChild(half);
    return { key, logEl, statusEl };
  }

  const half1 = makeHalf(key1, true);
  const half2 = makeHalf(key2, false);

  panelContainerEl.appendChild(panel);

  const group = { element: panel, titlebar, halves: [half1, half2] };
  bondedGroups[groupId] = group;
  bondedKeys[key1] = groupId;
  bondedKeys[key2] = groupId;
  // 恢复本地保存的上下两个日志区数据（重新绑定同一对 IP 时自动加载）
  for (const half of [half1, half2]) {
    const saved = persistData.logs[half.key];
    if (saved) {
      half.logEl.innerHTML = renderLogText(saved);
      half.logEl.classList.add('grown');
    }
  }

  // 重置按钮：重置整组统计并清空上下区域
  const resetBtn = titlebar.querySelector('.btn-reset');
  resetBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  resetBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    resetBondedPanel(groupId);
  });

  // 关闭按钮：断开组内两个连接并移除该绑定面板
  const closeBtn = titlebar.querySelector('.btn-close');
  closeBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeBondedPanel(groupId);
  });

  // 拖放排序 - 从标题栏启动（用 groupId 作为面板 key）
  titlebar.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;
    const moveHandler = (ev) => {
      if (!moved && (Math.abs(ev.clientX - startX) > 5 || Math.abs(ev.clientY - startY) > 5)) {
        moved = true;
        startDrag(groupId);
      }
      if (moved) moveDragPanel(ev.clientX, ev.clientY);
    };
    const upHandler = () => {
      document.removeEventListener('mousemove', moveHandler);
      document.removeEventListener('mouseup', upHandler);
      if (moved) endDrag();
    };
    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup', upHandler);
  });

  // 注册到 panels 与 panelOrder，便于拖拽排序复用
  panels[groupId] = { element: panel, titlebar, logText: '' };
  panelOrder.push(groupId);
  return group;
}

// ============ 拖放排序 ============
// 基于鼠标位置的自定义拖放排序（不依赖 HTML5 DnD）
function startDrag(key) {
  dragPanelKey = key;
  panels[key].element.classList.add('dragging');
  panels[key].element.style.opacity = '0.5';
  panelContainerEl.classList.add('drag-active');
}

function endDrag() {
  if (!dragPanelKey) return;
  panels[dragPanelKey].element.classList.remove('dragging');
  panels[dragPanelKey].element.style.opacity = '';
  panelContainerEl.classList.remove('drag-active');
  dragPanelKey = null;
}

// 根据鼠标位置实时重排面板
function moveDragPanel(clientX, clientY) {
  if (!dragPanelKey) return;

  const panelsArr = panelOrder.map((k) => ({ key: k, el: panels[k].element }));
  // 计算目标插入位置
  let insertBefore = null;

  for (const p of panelsArr) {
    if (p.key === dragPanelKey) continue;
    const rect = p.el.getBoundingClientRect();
    // 面板按从左到右、从上到下排列
    if (
      clientX < rect.left + rect.width / 2 &&
      clientY < rect.top + rect.height
    ) {
      insertBefore = p.key;
      break;
    }
  }

  const fromIdx = panelOrder.indexOf(dragPanelKey);
  let toIdx = insertBefore ? panelOrder.indexOf(insertBefore) : panelOrder.length;

  // 插入位置修正
  if (insertBefore && fromIdx < toIdx) {
    toIdx--;
  }

  if (fromIdx !== toIdx && toIdx >= 0) {
    panelOrder.splice(fromIdx, 1);
    panelOrder.splice(toIdx, 0, dragPanelKey);
    reorderPanels();
  }
}

function reorderPanels() {
  for (const key of panelOrder) {
    if (panels[key]) panelContainerEl.appendChild(panels[key].element);
  }
}

// ============ 接收消息处理 ============
// 主进程已通过 StatsTracker 完成消息解析与统计，这里只负责展示
function handleMessage(key, message, flag) {
  // 绑定组内的 key：更新该组面板中对应的上下日志区
  const groupId = bondedKeys[key];
  if (groupId) {
    const group = bondedGroups[groupId];
    const half = group && group.halves.find((h) => h.key === key);
    if (half) {
      half.logEl.classList.toggle('warning', flag === 'continuous' || flag === 'station');
      half.logEl.innerHTML = renderLogText(message);
      half.logEl.classList.add('grown');
    }
    persistData.logs[key] = message;
    flushPersist();
    return;
  }

  let p = panels[key];
  if (!p) {
    // 若尚未有面板则创建（理论上主进程会先发 panel-added）
    p = createPanel(key, 'Inbound');
  }

  // flag: 'continuous' | 'station' | 'normal'
  if (flag === 'continuous' || flag === 'station') {
    p.logEl.classList.add('warning');
  } else {
    p.logEl.classList.remove('warning');
  }

  p.logEl.innerHTML = renderLogText(message);
  p.logText = message;
  p.logEl.classList.add('grown');
  persistData.logs[key] = message;
  flushPersist();
}

// 把显示文本渲染为 HTML，行首带 LATEST_MARKER(\u0001) 的"最新更新零件"行显示为红色
function renderLogText(message) {
  const LATEST = '\u0001';
  return String(message)
    .split('\n')
    .map((line) => {
      const html = escapeHtml(line);
      if (line.startsWith(LATEST)) {
        return `<span class="latest-fail">${escapeHtml(line.slice(1))}</span>`;
      }
      return html;
    })
    .join('\n');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============ 状态更新 ============
function updatePanelStatus(key, isConnected) {
  // 绑定组内的 key：更新该组面板中对应上下区域的连接状态
  const groupId = bondedKeys[key];
  if (groupId) {
    const group = bondedGroups[groupId];
    const half = group && group.halves.find((h) => h.key === key);
    if (half) {
      half.statusEl.textContent = isConnected ? '● 已连接' : '○ 断开';
      half.statusEl.classList.toggle('ok', !!isConnected);
    }
    return;
  }

  const p = panels[key];
  if (p) {
    const statusEl = p.titlebar.querySelector('.conn-status');
    if (isConnected) {
      statusEl.textContent = '● 已连接';
      statusEl.classList.add('ok');
    } else {
      statusEl.textContent = '○ 断开';
      statusEl.classList.remove('ok');
    }
  }
}

// ============ 右键菜单 ============
// 主面板区域右键：空白处添加连接/绑定 IP；右键面板可断开连接
let contextKey = null;

panelContainerEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (IS_WEB) return; // 浏览器只读，不提供操作菜单

  const panel = e.target.closest('.client-panel');
  contextKey = panel ? panel.dataset.key : null;

  document.getElementById('menuAdd').classList.remove('hidden');
  document.getElementById('menuBind').classList.remove('hidden');
  // 绑定组面板不支持单独断开（主进程按单连接 key 管理），隐藏"断开连接"
  const isBonded = contextKey ? !!bondedGroups[contextKey] : false;
  document.getElementById('menuDisconnect').classList.toggle('hidden', !contextKey || isBonded);

  showContextMenu(e.clientX, e.clientY);
});

function showContextMenu(x, y) {
  contextMenuEl.style.left = x + 'px';
  contextMenuEl.style.top = y + 'px';
  contextMenuEl.classList.remove('hidden');
}

function hideContextMenu() {
  contextMenuEl.classList.add('hidden');
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.context-menu')) hideContextMenu();
});

// 菜单项点击
document.getElementById('menuAdd').addEventListener('click', () => {
  hideContextMenu();
  openAddDialog();
});

document.getElementById('menuBind').addEventListener('click', () => {
  hideContextMenu();
  openBindDialog();
});

document.getElementById('menuDisconnect').addEventListener('click', () => {
  hideContextMenu();
  if (contextKey) disconnectConnection(contextKey);
});

async function resetPanelStats(key) {
  // 统计状态在主进程维护，通过 IPC 重置
  await window.socketAPI.resetStats(key);
  const p = panels[key];
  if (p) {
    p.logText = '';
    p.logEl.textContent = '';
    p.logEl.classList.remove('grown');
  }
  // 重置时同时清空本地保存的该窗口数据
  delete persistData.logs[key];
  flushPersist();
}

async function resetBondedPanel(groupId) {
  // 重置整组统计（主进程按 groupId 重置组内所有连接）
  await window.socketAPI.resetStats(groupId);
  const group = bondedGroups[groupId];
  if (group) {
    for (const half of group.halves) {
      half.logEl.textContent = '';
      half.logEl.classList.remove('grown', 'warning');
      delete persistData.logs[half.key];
    }
  }
  flushPersist();
}

// ============ 断开连接 ============
async function disconnectConnection(key) {
  const confirmed = confirm(`确定要断开并删除连接 ${key} 吗？\n(删除后将不再自动重连)`);
  if (!confirmed) return;
  await window.socketAPI.disconnectConnection(key);
}

// 关闭绑定面板：断开组内两个连接并移除面板
async function closeBondedPanel(groupId) {
  const group = bondedGroups[groupId];
  if (!group) return;
  const names = group.halves.map((h) => h.key).join(' / ');
  const confirmed = confirm(`确定要断开并删除该绑定连接 ${names} 吗？\n(删除后将不再自动重连)`);
  if (!confirmed) return;
  for (const half of group.halves) {
    await window.socketAPI.disconnectConnection(half.key);
  }
  removeBondedPanel(groupId);
}

// 从界面移除绑定面板（组内连接已由主进程断开）
// 注意：仅移除界面，不删除本地保存的数据
function removeBondedPanel(groupId) {
  const group = bondedGroups[groupId];
  if (!group) return;
  group.element.remove();
  delete bondedGroups[groupId];
  for (const half of group.halves) {
    delete bondedKeys[half.key];
  }
  delete panels[groupId];
  panelOrder = panelOrder.filter((k) => k !== groupId);
}

// ============ 对话框 ============
function openAddDialog() {
  addDialogEl.classList.remove('hidden');
  document.getElementById('ipInput').focus();
}

function closeAddDialog() {
  addDialogEl.classList.add('hidden');
}

function openBindDialog() {
  if (IS_WEB) return; // 浏览器只读，不提供操作
  bindDialogEl.classList.remove('hidden');
  document.getElementById('bindIp1').focus();
}

function closeBindDialog() {
  bindDialogEl.classList.add('hidden');
}

function closeSendDialog() {
  sendDialogEl.classList.add('hidden');
}

// ============ 事件绑定 ============
document.getElementById('btnAddOk').addEventListener('click', async () => {
  const ip = document.getElementById('ipInput').value.trim();
  const port = parseInt(document.getElementById('portInput').value, 10);
  if (!ip || !(port > 0 && port <= 65535)) {
    alert('请输入有效的 IP 地址和端口号 (1-65535)。');
    return;
  }
  const result = await window.socketAPI.addConnection(ip, port);
  if (!result.ok) {
    alert(result.message || '添加失败');
  }
  closeAddDialog();
});
document.getElementById('btnAddCancel').addEventListener('click', closeAddDialog);

document.getElementById('btnBindOk').addEventListener('click', async () => {
  const ip1 = document.getElementById('bindIp1').value.trim();
  const port1 = parseInt(document.getElementById('bindPort1').value, 10);
  const ip2 = document.getElementById('bindIp2').value.trim();
  const port2 = parseInt(document.getElementById('bindPort2').value, 10);
  const validPort = (p) => p > 0 && p <= 65535;
  if (!ip1 || !ip2 || !validPort(port1) || !validPort(port2)) {
    alert('请填写两个有效的 IP 地址和端口号 (1-65535)。');
    return;
  }
  if (ip1 === ip2 && port1 === port2) {
    alert('两个 IP/端口不能完全相同。');
    return;
  }
  const result = await window.socketAPI.addBondedConnection(ip1, port1, ip2, port2);
  if (!result.ok) {
    const msgs = (result.results || []).filter((r) => !r.ok).map((r) => r.message);
    if (msgs.length) alert('绑定失败：' + msgs.join('；'));
  }
  closeBindDialog();
});
document.getElementById('btnBindCancel').addEventListener('click', closeBindDialog);

document.getElementById('btnSendOk').addEventListener('click', async () => {
  const key = document.getElementById('sendTarget').value;
  const content = document.getElementById('sendContent').value;
  if (!key || !content) {
    alert('请选择目标连接并输入消息内容');
    return;
  }
  await window.socketAPI.sendMessage(key, content);
  closeSendDialog();
  document.getElementById('sendContent').value = '';
});
document.getElementById('btnSendCancel').addEventListener('click', closeSendDialog);

// 关闭对话框（点击遮罩）
[addDialogEl, bindDialogEl, sendDialogEl].forEach((el) => {
  el.addEventListener('click', (e) => {
    if (e.target === el) el.classList.add('hidden');
  });
});

// Enter/Esc 快捷键
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!addDialogEl.classList.contains('hidden')) closeAddDialog();
    if (!bindDialogEl.classList.contains('hidden')) closeBindDialog();
    if (!sendDialogEl.classList.contains('hidden')) closeSendDialog();
    hideContextMenu();
  }
});

// ============ 主进程事件 ============
window.socketAPI.onBondedAdded(({ groupId, key1, key2 }) => {
  createBondedPanel(groupId, key1, key2);
});

window.socketAPI.onConnectionAdded(({ key, isConnected }) => {
  connections[key] = { isConnected, connecting: true };
  createPanel(key, 'Outbound');
  // 保存单连接配置到本地（供窗口重开时恢复）
  persistData.singles[key] = parseKey(key);
  flushPersist();
});

window.socketAPI.onConnectionState(({ key, isConnected, connecting }) => {
  if (connections[key]) {
    connections[key].isConnected = isConnected;
    connections[key].connecting = connecting;
  }
  updatePanelStatus(key, isConnected);
});

window.socketAPI.onPanelAdded(({ key, type }) => {
  createPanel(key, type);
});

window.socketAPI.onConnectionRemoved(({ key }) => {
  delete connections[key];
  if (panels[key]) {
    panels[key].element.remove();
    delete panels[key];
  }
  panelOrder = panelOrder.filter((k) => k !== key);
  // 删除连接/关闭面板：不删除本地数据（面板数据仍保存在本地，重新添加时自动恢复）
});

window.socketAPI.onMessageReceived(({ key, message, flag }) => {
  handleMessage(key, message, flag);
});

// 每天 8:00 / 20:00 主进程触发的自动重置：清空所有窗口界面与本地保存的日志
window.socketAPI.onStatsResetAll(() => {
  // 普通面板
  for (const key of Object.keys(panels)) {
    const p = panels[key];
    if (p && p.logEl) {
      p.logEl.textContent = '';
      p.logEl.classList.remove('grown', 'warning');
      p.logText = '';
    }
  }
  // 绑定面板的上下日志区
  for (const group of Object.values(bondedGroups)) {
    if (!group) continue;
    for (const half of group.halves) {
      half.logEl.textContent = '';
      half.logEl.classList.remove('grown', 'warning');
    }
  }
  // 清空本地保存的日志数据
  persistData.logs = {};
  flushPersist();
});

// ============ 启动恢复：窗口重开自动加载本地数据 ============
// 只自动重连已保存的普通连接；日志在 createPanel / createBondedPanel 创建时自动恢复
function restoreFromStorage() {
  if (IS_WEB) return; // 浏览器端只读，不做本地持久化/恢复
  const data = loadPersist();
  if (!data) return;
  // 把本地数据载入内存，供面板创建时恢复日志
  persistData.singles = data.singles;
  persistData.logs = data.logs;
  // 自动重连所有已保存的单连接（触发 onConnectionAdded -> createPanel -> 恢复日志）
  for (const info of Object.values(data.singles)) {
    window.socketAPI.addConnection(info.ip, info.port);
  }
}

restoreFromStorage();
