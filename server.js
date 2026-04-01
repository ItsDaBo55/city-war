/**
 * City Wars - Socket.IO Multiplayer Server
 * 
 * Run: node server.js
 * Or:  PORT=4000 node server.js
 * 
 * Requires: npm install socket.io
 */

const { Server } = require('socket.io');
const http = require('http');

const PORT = process.env.PORT || 3001;

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('City Wars Server Running');
});

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// ─── State ────────────────────────────────────────────────
const rooms = new Map();        // roomId -> Room
const playerRooms = new Map();  // socketId -> roomId

const DEFAULT_SETTINGS = {
  maxTime: 180,
  gracePeriod: 60,
  startMoney: 200,
  incomeMultiplier: 1,
  unlockedMissiles: ['dart', 'rocket'],
  unlockedDefenses: ['turret', 'sam'],
};

function generateId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getRoomList() {
  const list = [];
  for (const [id, room] of rooms) {
    if (room.status === 'finished') continue;
    list.push({
      id,
      name: room.name,
      playerCount: room.players.length,
      maxPlayers: 2,
      status: room.status,
      hostName: room.players.find(p => p.id === room.host)?.nickname || '?',
    });
  }
  return list;
}

function broadcastRoomList() {
  io.emit('rooms-list', getRoomList());
}

// Cleanup stale rooms every 60s
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    // Remove rooms older than 30 min or finished rooms older than 5 min
    const maxAge = room.status === 'finished' ? 5 * 60_000 : 30 * 60_000;
    if (now - room.createdAt > maxAge) {
      // Kick remaining players
      room.players.forEach(p => {
        const sock = io.sockets.sockets.get(p.id);
        if (sock) {
          sock.emit('room-closed', 'Room expired');
          sock.leave(id);
          playerRooms.delete(p.id);
        }
      });
      rooms.delete(id);
    }
  }
  broadcastRoomList();
}, 60_000);

// ─── Socket handlers ──────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} connected`);

  // List rooms
  socket.on('list-rooms', (cb) => {
    if (typeof cb === 'function') cb(getRoomList());
  });

  // Create room
  socket.on('create-room', ({ nickname, roomName, settings }, cb) => {
    if (!nickname || nickname.length > 20) {
      return cb({ ok: false, error: 'Invalid nickname' });
    }
    // Leave any existing room
    leaveCurrentRoom(socket);

    const roomId = generateId();
    const room = {
      id: roomId,
      name: roomName || `${nickname}'s Room`,
      host: socket.id,
      players: [{
        id: socket.id,
        nickname: nickname.substring(0, 20),
        ready: false,
        side: 'left',
      }],
      settings: { ...DEFAULT_SETTINGS, ...settings },
      status: 'waiting',
      createdAt: Date.now(),
    };
    rooms.set(roomId, room);
    playerRooms.set(socket.id, roomId);
    socket.join(roomId);

    cb({ ok: true, room });
    broadcastRoomList();
    console.log(`[Room] ${nickname} created room ${roomId}`);
  });

  // Join room
  socket.on('join-room', ({ nickname, roomId }, cb) => {
    if (!nickname || nickname.length > 20) {
      return cb({ ok: false, error: 'Invalid nickname' });
    }
    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'Room not found' });
    if (room.status !== 'waiting') return cb({ ok: false, error: 'Game already in progress' });
    if (room.players.length >= 2) return cb({ ok: false, error: 'Room is full' });

    // Leave any existing room
    leaveCurrentRoom(socket);

    const side = room.players[0]?.side === 'left' ? 'right' : 'left';
    room.players.push({
      id: socket.id,
      nickname: nickname.substring(0, 20),
      ready: false,
      side,
    });
    playerRooms.set(socket.id, roomId);
    socket.join(roomId);

    cb({ ok: true, room });
    io.to(roomId).emit('room-updated', room);
    broadcastRoomList();
    console.log(`[Room] ${nickname} joined room ${roomId}`);
  });

  // Leave room
  socket.on('leave-room', (cb) => {
    leaveCurrentRoom(socket);
    if (typeof cb === 'function') cb({ ok: true });
    broadcastRoomList();
  });

  // Toggle ready
  socket.on('toggle-ready', (cb) => {
    const roomId = playerRooms.get(socket.id);
    if (!roomId) return cb({ ok: false });
    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false });

    const player = room.players.find(p => p.id === socket.id);
    if (player) player.ready = !player.ready;

    cb({ ok: true });
    io.to(roomId).emit('room-updated', room);
  });

  // Update settings (host only)
  socket.on('update-settings', ({ settings }, cb) => {
    const roomId = playerRooms.get(socket.id);
    if (!roomId) return cb({ ok: false });
    const room = rooms.get(roomId);
    if (!room || room.host !== socket.id) return cb({ ok: false });
    if (room.status !== 'waiting') return cb({ ok: false });

    room.settings = { ...room.settings, ...settings };
    cb({ ok: true });
    io.to(roomId).emit('room-updated', room);
  });

  // Start game (host only, both players must be ready)
  socket.on('start-game', (cb) => {
    const roomId = playerRooms.get(socket.id);
    if (!roomId) return cb({ ok: false, error: 'Not in a room' });
    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'Room not found' });
    if (room.host !== socket.id) return cb({ ok: false, error: 'Only host can start' });
    if (room.players.length < 2) return cb({ ok: false, error: 'Need 2 players' });
    if (!room.players.every(p => p.ready)) return cb({ ok: false, error: 'All players must be ready' });

    room.status = 'playing';
    cb({ ok: true });

    room.players.forEach(p => {
      const sock = io.sockets.sockets.get(p.id);
      if (sock) {
        sock.emit('game-started', { room, yourSide: p.side });
      }
    });
    broadcastRoomList();
    console.log(`[Game] Room ${roomId} started`);
  });

  // Game action relay
  socket.on('game-action', (action) => {
    const roomId = playerRooms.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return;

    // Relay to opponent only
    socket.to(roomId).emit('opponent-action', action);
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id} disconnected`);
    const roomId = playerRooms.get(socket.id);
    if (roomId) {
      const room = rooms.get(roomId);
      if (room && room.status === 'playing') {
        // Notify opponent
        socket.to(roomId).emit('opponent-disconnected');
        room.status = 'finished';
      }
      leaveCurrentRoom(socket);
      broadcastRoomList();
    }
  });
});

function leaveCurrentRoom(socket) {
  const roomId = playerRooms.get(socket.id);
  if (!roomId) return;

  const room = rooms.get(roomId);
  playerRooms.delete(socket.id);
  socket.leave(roomId);

  if (!room) return;

  room.players = room.players.filter(p => p.id !== socket.id);

  if (room.players.length === 0) {
    rooms.delete(roomId);
    console.log(`[Room] ${roomId} deleted (empty)`);
  } else {
    // Transfer host
    if (room.host === socket.id) {
      room.host = room.players[0].id;
    }
    io.to(roomId).emit('room-updated', room);
    
    if (room.status === 'playing') {
      io.to(roomId).emit('opponent-disconnected');
      room.status = 'finished';
    }
  }
}

httpServer.listen(PORT, () => {
  console.log(`\n🎮 City Wars Server running on port ${PORT}\n`);
});
