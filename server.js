const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');

const app = express();
app.set('trust proxy', true);

const sslCertPath = process.env.SSL_CERT;
const sslKeyPath = process.env.SSL_KEY;
let isTls = false;
let server;

if (sslCertPath && sslKeyPath && fs.existsSync(sslCertPath) && fs.existsSync(sslKeyPath)) {
  server = https.createServer({
    cert: fs.readFileSync(sslCertPath),
    key: fs.readFileSync(sslKeyPath)
  }, app);
  isTls = true;
} else {
  server = http.createServer(app);
}

// Disable perMessageDeflate so binary audio frames bypass zlib compression latency and CPU overhead
const wss = new WebSocket.Server({
  server,
  path: '/ws',
  maxPayload: 64 * 1024,
  perMessageDeflate: false
});

function safeSendJson(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (e) {}
}

const PORT = process.env.PORT || 3000;
// Capped at 6 connected speakers (exact 5.1 surround array) to prevent Wi-Fi unicast airtime saturation
const MAX_RECEIVERS_PER_ROOM = 6;
// Tight per-socket backpressure cap (~24 KB) to prevent multi-second TCP bufferbloat queues on slow links
const MAX_RECEIVER_BUFFER_BYTES = 24 * 1024;

function sanitizeText(val, fallback, maxLen = 40) {
  const cleaned = String(val || '')
    .replace(/[\u0000-\u001F\u007F<>]/g, '')
    .trim()
    .slice(0, maxLen);
  return cleaned || fallback;
}

function makeSecret() {
  return crypto.randomBytes(16).toString('hex');
}

function secretsEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Per-room code generator
function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

function normalizeRoomCode(code) {
  return String(code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

// Multi-Tenant Room Store: roomKey -> Room Object
const rooms = new Map();

function createRoom(customName) {
  let code, key;
  let attempts = 0;
  do {
    code = makeRoomCode();
    key = normalizeRoomCode(code);
    attempts++;
  } while (rooms.has(key) && attempts < 100);

  const room = {
    code,
    key,
    name: sanitizeText(customName, 'Studio room', 48),
    hostSecret: makeSecret(),
    hostSocket: null,
    receivers: new Map(), // deviceId -> { ws, info, role, channelIndex, color, delayMs, rtt, offset }
    receiverPrefs: new Map(), // deviceId -> { role, channelIndex, color, delayMs }
    mode: 'PARTY',
    createdAt: Date.now(),
    lastActivity: Date.now(),
    lastListSent: 0
  };

  rooms.set(key, room);
  return room;
}

function getOrCreateRoom(requestedCode, hostSecret, customName) {
  if (requestedCode) {
    const key = normalizeRoomCode(requestedCode);
    const existing = rooms.get(key);
    if (existing && secretsEqual(hostSecret, existing.hostSecret)) {
      existing.lastActivity = Date.now();
      return existing;
    }
  }
  return createRoom(customName);
}

// Helper: Get local network IPv4 address prioritizing Wi-Fi
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();

  for (const name of Object.keys(interfaces)) {
    if (/wi-fi|wlan|wireless/i.test(name)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
  }

  for (const name of Object.keys(interfaces)) {
    if (/ethernet/i.test(name) && !/vethernet|hyper-v|wsl|virtual/i.test(name)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
  }

  for (const name of Object.keys(interfaces)) {
    if (!/vethernet|hyper-v|wsl|virtual|loopback|mcafee/i.test(name)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
  }

  return 'localhost';
}

function getAllLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const list = [];
  for (const name of Object.keys(interfaces)) {
    if (/vethernet|hyper-v|wsl|virtual|loopback|mcafee/i.test(name)) continue;
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        let type = 'LAN';
        if (/wi-fi|wlan|wireless/i.test(name)) type = 'Wi-Fi';
        else if (/local area connection/i.test(name) || iface.address.startsWith('192.168.137.')) type = 'Mobile Hotspot';
        else if (/ethernet/i.test(name)) type = 'Ethernet';
        list.push({ name, address: iface.address, type });
      }
    }
  }
  return list;
}

const localIp = getLocalIpAddress();

// Serve static assets from 'public'
app.use(express.static(path.join(__dirname, 'public')));

app.get('/favicon.ico', (req, res) => {
  res.type('image/svg+xml').sendFile(path.join(__dirname, 'public', 'favicon.svg'));
});

// Healthcheck endpoint for cloud load balancers & container orchestrators
app.get('/health', (req, res) => {
  res.json({ ok: true, rooms: rooms.size, maxReceiversPerRoom: MAX_RECEIVERS_PER_ROOM, uptime: Math.round(process.uptime()) });
});

// Specific routes
app.get(['/receiver', '/join', '/join/:code'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'receiver.html'));
});

// Endpoint for LAN/Cloud connection info and QR code
app.get('/api/info', async (req, res) => {
  const proto = (req.headers['x-forwarded-proto'] || (isTls ? 'https' : req.protocol) || 'http').split(',')[0].trim();
  const rawHost = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const hostNameOnly = rawHost.split(':')[0];

  const isLocalHost = !rawHost ||
    hostNameOnly === 'localhost' ||
    hostNameOnly === '127.0.0.1' ||
    hostNameOnly.endsWith('.local') ||
    hostNameOnly.startsWith('10.') ||
    hostNameOnly.startsWith('192.168.') ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostNameOnly);

  const allIps = getAllLocalIpAddresses();
  const requestedIp = req.query.ip;
  const activeLanIp = (requestedIp && allIps.some(item => item.address === requestedIp))
    ? requestedIp
    : getLocalIpAddress();

  const requestedRoom = req.query.room;
  const requestedSecret = req.query.hostSecret;
  const room = getOrCreateRoom(requestedRoom, requestedSecret, req.query.roomName);

  let hostUrl;
  let receiverUrl;
  let responseIps = allIps;
  const scheme = isTls ? 'https' : proto;
  const hostPortMatch = rawHost.match(/:(\d+)$/);
  const effectivePort = hostPortMatch ? hostPortMatch[1] : String(PORT);

  if (isLocalHost) {
    const portSuffix = ((scheme === 'http' && effectivePort === '80') || (scheme === 'https' && effectivePort === '443'))
      ? ''
      : `:${effectivePort}`;
    hostUrl = `${scheme}://${activeLanIp}${portSuffix}`;
    receiverUrl = `${scheme}://${activeLanIp}${portSuffix}/receiver?code=${encodeURIComponent(room.code)}`;
  } else {
    hostUrl = `${proto}://${rawHost}`;
    receiverUrl = `${proto}://${rawHost}/receiver?code=${encodeURIComponent(room.code)}`;
    responseIps = [
      { name: 'Public Cloud', address: rawHost, type: 'Cloud Domain' },
      ...allIps
    ];
  }

  try {
    const qrCodeDataUrl = await QRCode.toDataURL(receiverUrl, {
      margin: 2,
      width: 280,
      color: {
        dark: '#0f0f10',
        light: '#ffffff'
      }
    });

    res.json({
      localIp: isLocalHost ? activeLanIp : rawHost,
      allIps: responseIps,
      port: PORT,
      hostUrl,
      receiverUrl,
      roomCode: room.code,
      roomName: room.name,
      hostSecret: room.hostSecret,
      maxReceivers: MAX_RECEIVERS_PER_ROOM,
      qrCodeDataUrl,
      isCloud: !isLocalHost
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR Code' });
  }
});

// Endpoint to explicitly generate a new room
app.post('/api/room/new', (req, res) => {
  const room = createRoom();
  res.json({ roomCode: room.code, roomName: room.name, hostSecret: room.hostSecret, maxReceivers: MAX_RECEIVERS_PER_ROOM });
});

// Helper: High-precision master time in milliseconds
function getMasterTime() {
  return (performance.timeOrigin ? (performance.timeOrigin + performance.now()) : Date.now());
}

function broadcastHostStatus(room, online) {
  if (!room) return;
  const payload = JSON.stringify({ type: 'HOST_STATUS', online });
  for (const dev of room.receivers.values()) {
    if (dev.ws.readyState === WebSocket.OPEN) {
      try {
        dev.ws.send(payload);
      } catch (e) {}
    }
  }
}

function cleanupSocketMembership(ws) {
  if (!ws.roomKey) return;
  const oldRoom = rooms.get(ws.roomKey);
  if (oldRoom) {
    if (ws.clientType === 'HOST' && oldRoom.hostSocket === ws) {
      oldRoom.hostSocket = null;
      broadcastHostStatus(oldRoom, false);
    } else if (ws.clientType === 'RECEIVER' && ws.deviceId) {
      const dev = oldRoom.receivers.get(ws.deviceId);
      if (dev && dev.ws === ws) {
        oldRoom.receivers.delete(ws.deviceId);
        notifyHostDeviceList(oldRoom, true);
      }
    }
  }
  ws.roomKey = null;
  ws.clientType = null;
  ws.deviceId = null;
}

// Broadcast device list updates to the host of a specific room
function notifyHostDeviceList(room, force = false) {
  if (!room || !room.hostSocket || room.hostSocket.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  if (!force && now - room.lastListSent < 800) return;
  room.lastListSent = now;
  const list = [];
  for (const [id, dev] of room.receivers.entries()) {
    list.push({
      id,
      name: dev.info.name || `Device-${id.slice(0, 4)}`,
      ua: dev.info.ua || 'Mobile Device',
      role: dev.role || 'UNASSIGNED',
      channelIndex: dev.channelIndex !== undefined ? dev.channelIndex : -1,
      delayMs: dev.delayMs || 0,
      rtt: dev.rtt || 0,
      offset: dev.offset || 0,
      color: dev.color || '#2dd4bf'
    });
  }
  try {
    room.hostSocket.send(JSON.stringify({
      type: 'DEVICE_LIST',
      devices: list,
      maxDevices: MAX_RECEIVERS_PER_ROOM,
      mode: room.mode,
      roomName: room.name,
      roomCode: room.code
    }));
  } catch (e) {
    console.error('Failed to send device list:', e);
  }
}

wss.on('error', (err) => {
  console.error('WebSocket server error:', err);
});

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.roomKey = null;
  ws.clientType = null;
  ws.deviceId = null;

  if (ws._socket && typeof ws._socket.setNoDelay === 'function') {
    ws._socket.setNoDelay(true);
  }

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => { cleanupSocketMembership(ws); });

  ws.on('message', (message, isBinary) => {
    // Binary audio packets from Host
    if (isBinary) {
      if (!ws.roomKey) return;
      const room = rooms.get(ws.roomKey);
      if (!room || ws !== room.hostSocket) return;

      if (message.length < 16) return;
      const targetChannel = message.readUInt8(10);
      room.lastActivity = Date.now();

      for (const receiver of room.receivers.values()) {
        const rws = receiver.ws;
        if (rws.readyState === WebSocket.OPEN) {
          if (targetChannel === 255 || receiver.channelIndex === targetChannel) {
            if (rws.bufferedAmount < MAX_RECEIVER_BUFFER_BYTES) {
              rws.send(message, { binary: true, compress: false });
            }
          }
        }
      }
      return;
    }

    // JSON Control Messages
    try {
      const data = JSON.parse(message.toString());

      // High-precision NTP Clock Sync
      if (data.type === 'SYNC_PING') {
        const t1 = getMasterTime();
        safeSendJson(ws, {
          type: 'SYNC_PONG',
          clientSendTime: data.clientSendTime,
          serverReceiveTime: t1,
          serverSendTime: getMasterTime()
        });
        return;
      }

      // Client Registration
      if (data.type === 'REGISTER') {
        const role = data.role; // 'HOST' | 'RECEIVER'
        const rawCode = data.roomCode;
        const roomKey = normalizeRoomCode(rawCode);

        if (role === 'HOST') {
          if (!roomKey) {
            ws.send(JSON.stringify({
              type: 'HOST_REJECTED',
              reason: 'Missing room code.'
            }));
            return;
          }

          const room = rooms.get(roomKey);
          if (!room) {
            ws.send(JSON.stringify({
              type: 'HOST_REJECTED',
              reason: 'Room expired or not found.'
            }));
            return;
          }

          if (!secretsEqual(data.hostSecret, room.hostSecret)) {
            ws.send(JSON.stringify({
              type: 'HOST_REJECTED',
              reason: 'Host authorization failed for this room.'
            }));
            return;
          }

          if (ws.roomKey && ws.roomKey !== room.key) {
            cleanupSocketMembership(ws);
          }

          if (room.hostSocket && room.hostSocket !== ws && room.hostSocket.readyState === WebSocket.OPEN) {
            try {
              room.hostSocket.send(JSON.stringify({ type: 'HOST_REPLACED' }));
            } catch (e) {}
            room.hostSocket.close(4001, 'Host replaced by newer session');
          }
          room.hostSocket = ws;

          ws.roomKey = room.key;
          ws.clientType = 'HOST';
          room.lastActivity = Date.now();
          ws.send(JSON.stringify({
            type: 'HOST_REGISTERED',
            roomCode: room.code,
            roomName: room.name,
            mode: room.mode,
            maxDevices: MAX_RECEIVERS_PER_ROOM
          }));
          broadcastHostStatus(room, true);
          notifyHostDeviceList(room, true);
          return;
        }

        if (role === 'RECEIVER') {
          if (!roomKey) {
            ws.send(JSON.stringify({
              type: 'JOIN_REJECTED',
              reason: 'Enter the room code shown on the host.'
            }));
            return;
          }

          const room = rooms.get(roomKey);
          if (!room) {
            ws.send(JSON.stringify({
              type: 'JOIN_REJECTED',
              reason: 'Room not found. Check the code shown on the host.'
            }));
            return;
          }

          if (ws.roomKey && ws.roomKey !== roomKey) {
            cleanupSocketMembership(ws);
          }

          const deviceId = sanitizeText(data.deviceId, '', 32) || Math.random().toString(36).substring(2, 9);
          const existing = room.receivers.get(deviceId);
          if (existing && existing.ws !== ws && existing.ws.readyState === WebSocket.OPEN) {
            existing.ws.close(4002, 'Receiver reconnected');
          }

          if (!room.receivers.has(deviceId) && room.receivers.size >= MAX_RECEIVERS_PER_ROOM) {
            ws.send(JSON.stringify({
              type: 'ROOM_FULL',
              reason: `This room is full (${MAX_RECEIVERS_PER_ROOM} speakers max for low-latency audio).`
            }));
            return;
          }

          const rawInfo = data.info && typeof data.info === 'object' ? data.info : {};
          const safeInfo = {
            name: sanitizeText(rawInfo.name, `Device-${deviceId.slice(0, 4)}`, 40),
            ua: sanitizeText(rawInfo.ua, 'Mobile Device', 160)
          };

          const prefs = room.receiverPrefs.get(deviceId) || {};
          const restoredRole = prefs.role || 'UNASSIGNED';
          const restoredChannel = prefs.channelIndex !== undefined ? prefs.channelIndex : -1;
          const restoredColor = prefs.color || '#2dd4bf';
          const restoredDelayMs = Number.isFinite(prefs.delayMs) ? prefs.delayMs : 0;

          ws.roomKey = roomKey;
          ws.clientType = 'RECEIVER';
          ws.deviceId = deviceId;

          room.receivers.set(deviceId, {
            ws,
            info: safeInfo,
            role: restoredRole,
            channelIndex: restoredChannel,
            color: restoredColor,
            delayMs: restoredDelayMs,
            rtt: 0,
            offset: 0
          });
          room.lastActivity = Date.now();

          ws.send(JSON.stringify({
            type: 'REGISTERED',
            deviceId,
            mode: room.mode,
            roomName: room.name,
            roomCode: room.code,
            role: restoredRole,
            channelIndex: restoredChannel,
            delayMs: restoredDelayMs,
            hostOnline: !!(room.hostSocket && room.hostSocket.readyState === WebSocket.OPEN)
          }));
          notifyHostDeviceList(room, true);
          return;
        }
        return;
      }

      // Telemetry update from receiver
      if (data.type === 'TELEMETRY' && ws.roomKey && ws.deviceId) {
        const room = rooms.get(ws.roomKey);
        if (room) {
          const dev = room.receivers.get(ws.deviceId);
          if (dev) {
            dev.rtt = Number.isFinite(data.rtt) ? data.rtt : 0;
            dev.offset = Number.isFinite(data.offset) ? data.offset : 0;
            room.lastActivity = Date.now();
            notifyHostDeviceList(room); // throttled
          }
        }
        return;
      }

      // Host controls
      if (ws.roomKey && ws.clientType === 'HOST') {
        const room = rooms.get(ws.roomKey);
        if (!room || ws !== room.hostSocket) return;

        room.lastActivity = Date.now();

        if (data.type === 'SET_MODE') {
          if (data.mode !== 'PARTY' && data.mode !== 'DOLBY') return;
          room.mode = data.mode; // 'DOLBY' | 'PARTY'
          for (const dev of room.receivers.values()) {
            if (dev.ws.readyState === WebSocket.OPEN) {
              dev.ws.send(JSON.stringify({ type: 'MODE_UPDATED', mode: room.mode }));
            }
          }
          notifyHostDeviceList(room, true);
        } else if (data.type === 'SET_ROOM_NAME') {
          room.name = sanitizeText(data.roomName, 'Studio room', 48);
          for (const dev of room.receivers.values()) {
            if (dev.ws.readyState === WebSocket.OPEN) {
              dev.ws.send(JSON.stringify({ type: 'ROOM_UPDATED', roomName: room.name }));
            }
          }
          notifyHostDeviceList(room, true);
        } else if (data.type === 'ASSIGN_ROLE') {
          const dev = room.receivers.get(data.deviceId);
          if (dev) {
            dev.role = sanitizeText(data.role, 'UNASSIGNED', 32);
            dev.channelIndex = Number.isInteger(data.channelIndex) ? data.channelIndex : -1;
            dev.color = sanitizeText(data.color, '#2dd4bf', 24);
            const prevPrefs = room.receiverPrefs.get(data.deviceId) || {};
            room.receiverPrefs.set(data.deviceId, {
              ...prevPrefs,
              role: dev.role,
              channelIndex: dev.channelIndex,
              color: dev.color
            });
            if (dev.ws.readyState === WebSocket.OPEN) {
              dev.ws.send(JSON.stringify({
                type: 'ROLE_ASSIGNED',
                role: dev.role,
                channelIndex: dev.channelIndex,
                color: dev.color
              }));
            }
          }
        } else if (data.type === 'PING_DEVICE') {
          const dev = room.receivers.get(data.deviceId);
          if (dev) {
            safeSendJson(dev.ws, {
              type: 'TRIGGER_PING',
              role: dev.role,
              color: dev.color,
              silentAudio: Boolean(data.silentAudio)
            });
          }
        } else if (data.type === 'SET_SPEAKER_DELAY') {
          const delayMs = Math.max(0, Math.min(500, Number(data.delayMs) || 0));
          const prevPrefs = room.receiverPrefs.get(data.deviceId) || {};
          room.receiverPrefs.set(data.deviceId, { ...prevPrefs, delayMs });
          const dev = room.receivers.get(data.deviceId);
          if (dev) {
            dev.delayMs = delayMs;
            if (dev.ws.readyState === WebSocket.OPEN) {
              dev.ws.send(JSON.stringify({
                type: 'SET_SPEAKER_DELAY',
                delayMs
              }));
            }
          }
        }
      }
    } catch (e) {
      console.error('Failed to parse message:', e);
    }
  });

  ws.on('close', () => {
    cleanupSocketMembership(ws);
  });
});

// Periodic heartbeat to clean broken connections
const interval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 15000);

// Inactive room cleanup: delete rooms idle for >30 minutes with no host or receivers
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, room] of rooms.entries()) {
    const isInactive = !room.hostSocket && room.receivers.size === 0;
    if (isInactive && now - room.lastActivity > 30 * 60 * 1000) {
      rooms.delete(key);
    }
  }
}, 5 * 60 * 1000);

wss.on('close', () => {
  clearInterval(interval);
  clearInterval(cleanupInterval);
});

function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}, shutting down cleanly...`);
  clearInterval(interval);
  clearInterval(cleanupInterval);
  wss.clients.forEach(client => {
    try { client.close(1001, 'Server shutting down'); } catch (e) {}
  });
  wss.close(() => {
    server.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

server.listen(PORT, '0.0.0.0', () => {
  const scheme = isTls ? 'https' : 'http';
  console.log('\n======================================================');
  console.log('           EQsono Multi-Device Audio System           ');
  console.log('======================================================');
  console.log(` > Server Listening on Port:  ${PORT} (${scheme.toUpperCase()})`);
  console.log(` > Local Host Dashboard:      ${scheme}://localhost:${PORT}`);
  console.log(` > Local LAN Wi-Fi Endpoint:  ${scheme}://${localIp}:${PORT}`);
  console.log(` > Max Speakers Per Room:     ${MAX_RECEIVERS_PER_ROOM} (5.1 Array Optimized)`);
  console.log(' > Multi-Tenant Rooms:       Enabled (Dynamic)');
  console.log('======================================================\n');
});
