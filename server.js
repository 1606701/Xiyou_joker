'use strict';

/**
 * server.js — 进程入口：HTTP 静态服务 + Socket.IO + 局域网访问支持。
 */

const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const { initNet } = require('./net/net');

const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  // 局域网 WiFi 可能拦截 WebSocket 升级，允许自动降级为 HTTP long-polling
  transports: ['websocket', 'polling'],
});

// 房间注册表（内存态）：roomCode -> Room
const rooms = new Map();
initNet(io, rooms);

/** 打印所有局域网 IPv4 地址 */
function lanAddresses() {
  const list = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) list.push(net.address);
    }
  }
  return list;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('============================================');
  console.log('  西游斗牌 服务器已启动');
  console.log(`  本机访问:    http://localhost:${PORT}`);
  const addrs = lanAddresses();
  if (addrs.length > 0) {
    console.log('  手机局域网访问（同一 WiFi 下）:');
    for (const addr of addrs) {
      console.log(`    http://${addr}:${PORT}`);
    }
  } else {
    console.log('  (未检测到局域网 IP，请确认已连接网络)');
  }
  console.log('--------------------------------------------');
  console.log('  提示：');
  console.log('  1. 手机与电脑须在同一 WiFi / 同一网段');
  console.log('  2. 若路由器开启 AP 隔离或访客网络，手机将无法访问');
  console.log('  3. 若手机访问被防火墙拦截，请放行端口:');
  console.log('     netsh advfirewall firewall add rule name="XiyoujiPoker" dir=in action=allow protocol=TCP localport=' + PORT);
  console.log('============================================');
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，可用环境变量 PORT 指定其他端口，例如: PORT=8080 npm start`);
  } else {
    console.error('服务器启动失败:', e.message);
  }
  process.exit(1);
});
