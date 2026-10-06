/**
 * Web 服务模块
 * 提供 HTTP 服务器，让浏览器通过 http://localhost:8090 查看监控页面（只读同步界面）。
 * - 静态资源：renderer/ 下的 html / js / css
 * - SSE 事件流：/events，把主进程的事件实时推送给浏览器
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const WEB_PORT = 8090;

// 当前已连接的浏览器 SSE 客户端（res 响应对象）
const sseClients = new Set();

// 把事件推送给所有浏览器客户端
function broadcastToWeb(channel, payload) {
  if (sseClients.size === 0) return;
  const data = `data: ${JSON.stringify({ channel, payload })}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(data);
    } catch (e) { /* 忽略单个客户端的写错误 */ }
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    // 禁用缓存：避免浏览器使用旧版 JS/CSS，导致界面功能不完整（如绑定面板不显示）
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
    });
    res.end(data);
  });
}

/**
 * 启动 Web 服务。
 * options.getSnapshot() -> [{ type, payload }, ...]   // 初次 SSE 连接的现状快照
 */
function startWebServer(options) {
  const rendererDir = path.join(__dirname, 'renderer');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // ---- SSE 事件流 ----
    if (pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write('retry: 1000\n\n');

      // 初次连接推送当前状态快照
      if (options.getSnapshot) {
        for (const { type, payload } of options.getSnapshot()) {
          res.write(`data: ${JSON.stringify({ channel: type, payload })}\n\n`);
        }
      }

      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // ---- 静态资源 ----
    let filePath;
    if (pathname === '/' || pathname === '/index.html') {
      filePath = path.join(rendererDir, 'index.html');
    } else {
      const rel = pathname.replace(/^\/+/, '');
      filePath = path.join(rendererDir, rel);
    }
    // 防止目录穿越
    if (!filePath.startsWith(rendererDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    return serveFile(res, filePath);
  });

  server.on('error', (err) => {
    console.log(`[Web] 服务器错误: ${err.message}`);
  });

  server.listen(WEB_PORT, () => {
    console.log(`[Web] 监控页面已启动: http://localhost:${WEB_PORT}`);
  });
  return server;
}

module.exports = { startWebServer, broadcastToWeb, WEB_PORT };
