// test_server.js —— 服务器模式：连接建立后主动推送数据
// 运行: node test_server.js server

const net = require('net');

function log(tag, msg) {
    const time = new Date().toTimeString().slice(0, 8);
    console.log(`[${time}] [${tag}] ${msg}`);
}

// 打包 [4字节小端长度][UTF-8正文]
function encodeMessage(str) {
    const data = Buffer.from(str, 'utf8');
    const lengthBuf = Buffer.alloc(4);
    lengthBuf.writeInt32LE(data.length, 0);
    return Buffer.concat([lengthBuf, data]);
}

// 流式解码
function decodeStream(buffer) {
    const messages = [];
    let offset = 0;
    while (true) {
        if (buffer.length - offset < 4) break;
        const len = buffer.readInt32LE(offset);
        if (len <= 0 || len > 10 * 1024 * 1024) { offset += 4; continue; }
        if (buffer.length - offset - 4 < len) break;
        messages.push(buffer.slice(offset + 4, offset + 4 + len).toString('utf8'));
        offset += 4 + len;
    }
    return { messages, leftover: buffer.slice(offset) };
}

// 生成混合 PASS/FAIL 测试消息
function genMixedMsg() {
    const comps = ['SensorX', 'SensorY', 'Motor', 'Board', 'Cable'];
    if (Math.random() < 0.5) {
        const n = 1 + Math.floor(Math.random() * 4);
        return `${Date.now()} PASS ${comps.slice(0, n).join(' ')}`;
    } else {
        return `${Date.now()} FAIL ${comps[Math.floor(Math.random() * comps.length)]} ${comps[Math.floor(Math.random() * comps.length)]}`;
    }
}

const server = net.createServer((socket) => {
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    log('SERVER', `客户端接入: ${remote}`);
    socket.setNoDelay(true);

    // ---- 核心：连接建立后，立即每 500ms 主动推一条数据 ----
    const timer = setInterval(() => {
        if (socket.destroyed) return;
        const msg = genMixedMsg();
        const packet = encodeMessage(msg);
        socket.write(packet);
        log('PUSH', `主动推送 -> [${msg.slice(0, 60)}] (${packet.length} 字节)`);
    }, 500);

    // 同时仍支持回显
    let buffer = Buffer.alloc(0);
    socket.on('data', (data) => {
        buffer = Buffer.concat([buffer, data]);
        const { messages, leftover } = decodeStream(buffer);
        buffer = leftover;
        messages.forEach((m) => log('RECV', `收到软件数据: ${m.slice(0, 100)}`));
    });

    socket.on('close', () => { clearInterval(timer); log('SERVER', `客户端断开: ${remote}`); });
    socket.on('error', (e) => { clearInterval(timer); log('SERVER', `错误: ${e.message}`); });
});

const port = parseInt(process.argv[2], 10) || 8888;
server.listen(port, () => {
    log('SERVER', `服务器已监听端口 ${port}，连接建立后每 500ms 自动推送 PASS/FAIL 数据`);
    log('SERVER', '请在软件中添加连接: 127.0.0.1:' + port);
});
