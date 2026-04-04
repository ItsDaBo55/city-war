/**
 * City War - Authoritative Socket.IO Multiplayer Server
 */

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.get('/', (req, res) => res.send('City Wars Server Running'));

const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`\n🎮 City Wars Server running on port ${port}\n`));

// ─── Game Templates (must match client constants) ─────────
const BUILDING_TEMPLATES = [
  { type: 'house', cost: 30, income: 2, hp: 40, maxCount: 10 },
  { type: 'apartment', cost: 60, income: 5, hp: 70, maxCount: 8 },
  { type: 'hotel', cost: 100, income: 8, hp: 90, maxCount: 6 },
  { type: 'skyscraper', cost: 180, income: 14, hp: 120, maxCount: 5 },
  { type: 'factory', cost: 250, income: 20, hp: 150, maxCount: 3 },
];

const MISSILE_TEMPLATES = [
  { type: 'dart', cost: 15, upgradeCost: 50 },
  { type: 'rocket', cost: 30, upgradeCost: 80 },
  { type: 'cruise', cost: 60, upgradeCost: 120 },
  { type: 'ballistic', cost: 100, upgradeCost: 200 },
  { type: 'nuke', cost: 200, upgradeCost: 400 },
];

const DEFENSE_TEMPLATES = [
  { type: 'turret', cost: 40, maxCount: 3, upgradeCost: 60, armCost: 20 },
  { type: 'sam', cost: 80, maxCount: 2, upgradeCost: 100, armCost: 35 },
  { type: 'laser', cost: 150, maxCount: 2, upgradeCost: 180, armCost: 50 },
  { type: 'railgun', cost: 250, maxCount: 1, upgradeCost: 300, armCost: 75 },
  { type: 'aegis', cost: 400, maxCount: 1, upgradeCost: 500, armCost: 100 },
];

const DEFAULT_SETTINGS = {
  gracePeriod: 60,
  startMoney: 200,
  incomeMultiplier: 1,
  allowedMissiles: ['dart', 'rocket', 'cruise', 'ballistic', 'nuke'],
  allowedDefenses: ['turret', 'sam', 'laser', 'railgun', 'aegis'],
  map: 'city',
  powerUps: false,
  enabledEvents: ['supply-drop', 'meteor-shower', 'earthquake', 'airstrike', 'emp'],
  specialsEnabled: true,
};

// ─── State ────────────────────────────────────────────────
const rooms = new Map();
const playerRooms = new Map();
const gameStates = new Map();

const SHIELD_COST = 150;

function generateId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function createPlayerState(settings) {
  const allowedMissiles = settings.allowedMissiles || DEFAULT_SETTINGS.allowedMissiles;
  const allowedDefenses = settings.allowedDefenses || DEFAULT_SETTINGS.allowedDefenses;

  const missiles = {};
  MISSILE_TEMPLATES.forEach(t => {
    missiles[t.type] = {
      unlocked: false,
      allowed: allowedMissiles.includes(t.type),
      level: 1,
      upgradeCost: t.upgradeCost,
    };
  });
  const defaultUnlocked = allowedMissiles.slice(0, 2);
  defaultUnlocked.forEach(type => { if (missiles[type]) missiles[type].unlocked = true; });

  const defenses = {};
  DEFENSE_TEMPLATES.forEach(t => {
    defenses[t.type] = {
      unlocked: false,
      allowed: allowedDefenses.includes(t.type),
      level: 1,
      upgradeCost: t.upgradeCost,
    };
  });
  const defaultDefUnlocked = allowedDefenses.slice(0, 2);
  defaultDefUnlocked.forEach(type => { if (defenses[type]) defenses[type].unlocked = true; });

  return {
    money: settings.startMoney,
    buildingCounts: { house: 1 },
    defenseCounts: {},
    buildingLevels: {},
    shields: 0,
    specialsEnabled: settings.specialsEnabled !== false,
    missiles,
    defenses,
    queuedCost: 0,
    queuedMissiles: [],
  };
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

function cleanupGameState(roomId) {
  const gs = gameStates.get(roomId);
  if (gs) {
    if (gs.incomeInterval) clearInterval(gs.incomeInterval);
    if (gs.powerUpInterval) clearInterval(gs.powerUpInterval);
  }
  gameStates.delete(roomId);
}

// Cleanup stale rooms every 60s
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    const maxAge = room.status === 'finished' ? 5 * 60_000 : 30 * 60_000;
    if (now - room.createdAt > maxAge) {
      room.players.forEach(p => {
        const sock = io.sockets.sockets.get(p.id);
        if (sock) {
          sock.emit('room-closed', 'Room expired');
          sock.leave(id);
          playerRooms.delete(p.id);
        }
      });
      cleanupGameState(id);
      rooms.delete(id);
    }
  }
  broadcastRoomList();
}, 60_000);

// ─── Action Validation ────────────────────────────────────
function validateAction(ps, action) {
  switch (action.type) {
    case 'build': {
      const tmpl = BUILDING_TEMPLATES.find(t => t.type === action.buildingType);
      if (!tmpl) return { ok: false, error: 'Invalid building' };
      const count = ps.buildingCounts[tmpl.type] || 0;
      if (count >= tmpl.maxCount) return { ok: false, error: 'Max count reached' };
      if (ps.money < tmpl.cost) return { ok: false, error: 'Not enough money' };
      ps.money -= tmpl.cost;
      ps.buildingCounts[tmpl.type] = count + 1;
      return { ok: true };
    }
    case 'upgrade-building': {
      const buildingId = action.buildingId;
      const currentLevel = ps.buildingLevels[buildingId] || 1;
      const cost = Math.floor(35 * Math.pow(1.45, currentLevel - 1));
      if (currentLevel >= 5) return { ok: false, error: 'Max level' };
      if (ps.money < cost) return { ok: false, error: 'Not enough money' };
      ps.money -= cost;
      ps.buildingLevels[buildingId] = currentLevel + 1;
      return { ok: true };
    }
    case 'place-defense': {
      const tmpl = DEFENSE_TEMPLATES.find(t => t.type === action.defenseType);
      if (!tmpl) return { ok: false, error: 'Invalid defense' };
      const ds = ps.defenses[tmpl.type];
      if (!ds || !ds.unlocked) return { ok: false, error: 'Not unlocked' };
      if (!ds.allowed) return { ok: false, error: 'Not allowed in this match' };
      const count = ps.defenseCounts[tmpl.type] || 0;
      if (count >= tmpl.maxCount) return { ok: false, error: 'Max count reached' };
      if (ps.money < tmpl.cost) return { ok: false, error: 'Not enough money' };
      ps.money -= tmpl.cost;
      ps.defenseCounts[tmpl.type] = count + 1;
      return { ok: true };
    }
    case 'place-shield': {
      if (ps.money < SHIELD_COST) return { ok: false, error: 'Not enough money' };
      ps.money -= SHIELD_COST;
      ps.shields += 1;
      return { ok: true };
    }
    case 'queue-missile': {
      const tmpl = MISSILE_TEMPLATES.find(t => t.type === action.missileType);
      if (!tmpl) return { ok: false, error: 'Invalid missile' };
      const ms = ps.missiles[tmpl.type];
      if (!ms || !ms.unlocked) return { ok: false, error: 'Not unlocked' };
      if (!ms.allowed) return { ok: false, error: 'Not allowed in this match' };
      if (ps.money < tmpl.cost) return { ok: false, error: 'Not enough money' };
      ps.money -= tmpl.cost;
      ps.queuedCost += tmpl.cost;
      ps.queuedMissiles.push({ missileType: action.missileType, targetX: action.targetX, targetY: action.targetY });
      return { ok: true, skipRelay: true };
    }
    case 'launch-queue': {
      const missiles = ps.queuedMissiles.splice(0);
      ps.queuedCost = 0;
      if (missiles.length === 0) return { ok: true, skipRelay: true };
      return { ok: true, relayAction: { type: 'launch-missiles', missiles } };
    }
    case 'clear-queue': {
      ps.money += ps.queuedCost;
      ps.queuedCost = 0;
      ps.queuedMissiles = [];
      return { ok: true, skipRelay: true };
    }
    case 'unlock-missile': {
      const tmpl = MISSILE_TEMPLATES.find(t => t.type === action.missileType);
      if (!tmpl) return { ok: false, error: 'Invalid missile' };
      const ms = ps.missiles[tmpl.type];
      if (!ms) return { ok: false, error: 'Invalid missile' };
      if (!ms.allowed) return { ok: false, error: 'Not allowed in this match' };
      if (ms.unlocked) return { ok: false, error: 'Already unlocked' };
      const cost = tmpl.cost * 3;
      if (ps.money < cost) return { ok: false, error: 'Not enough money' };
      ps.money -= cost;
      ms.unlocked = true;
      return { ok: true };
    }
    case 'upgrade-missile': {
      const tmpl = MISSILE_TEMPLATES.find(t => t.type === action.missileType);
      if (!tmpl) return { ok: false, error: 'Invalid missile' };
      const ms = ps.missiles[tmpl.type];
      if (!ms || !ms.unlocked) return { ok: false, error: 'Not unlocked' };
      if (ms.level >= 5) return { ok: false, error: 'Max level' };
      if (ps.money < ms.upgradeCost) return { ok: false, error: 'Not enough money' };
      ps.money -= ms.upgradeCost;
      ms.level += 1;
      ms.upgradeCost = Math.floor(ms.upgradeCost * 1.5);
      return { ok: true };
    }
    case 'unlock-defense': {
      const tmpl = DEFENSE_TEMPLATES.find(t => t.type === action.defenseType);
      if (!tmpl) return { ok: false, error: 'Invalid defense' };
      const ds = ps.defenses[tmpl.type];
      if (!ds) return { ok: false, error: 'Invalid defense' };
      if (!ds.allowed) return { ok: false, error: 'Not allowed in this match' };
      if (ds.unlocked) return { ok: false, error: 'Already unlocked' };
      const cost = tmpl.cost * 2;
      if (ps.money < cost) return { ok: false, error: 'Not enough money' };
      ps.money -= cost;
      ds.unlocked = true;
      return { ok: true };
    }
    case 'upgrade-defense': {
      const tmpl = DEFENSE_TEMPLATES.find(t => t.type === action.defenseType);
      if (!tmpl) return { ok: false, error: 'Invalid defense' };
      const ds = ps.defenses[tmpl.type];
      if (!ds || !ds.unlocked) return { ok: false, error: 'Not unlocked' };
      if (ds.level >= 5) return { ok: false, error: 'Max level' };
      if (ps.money < ds.upgradeCost) return { ok: false, error: 'Not enough money' };
      ps.money -= ds.upgradeCost;
      ds.level += 1;
      ds.upgradeCost = Math.floor(ds.upgradeCost * 1.5);
      return { ok: true };
    }
    case 'arm-defense': {
      const defType = action.defenseType;
      if (!defType) return { ok: false, error: 'Missing defense type' };
      const tmpl = DEFENSE_TEMPLATES.find(t => t.type === defType);
      if (!tmpl) return { ok: false, error: 'Invalid defense type' };
      if (ps.money < tmpl.armCost) return { ok: false, error: 'Not enough money' };
      ps.money -= tmpl.armCost;
      return { ok: true };
    }
    case 'use-special': {
      const costs = { 'air-raid': 120, spy: 70, sabotage: 90, uav: 60, jammer: 80 };
      const cost = costs[action.specialType] || 0;
      if (!ps.specialsEnabled) return { ok: false, error: 'Specials disabled' };
      if (ps.money < cost) return { ok: false, error: 'Not enough money' };
      ps.money -= cost;
      return { ok: true };
    }
    default:
      return { ok: false, error: 'Unknown action' };
  }
}

// ─── Socket handlers ──────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} connected`);

  socket.on('list-rooms', (cb) => {
    if (typeof cb === 'function') cb(getRoomList());
  });

  socket.on('create-room', ({ nickname, roomName, settings }, cb) => {
    if (!nickname || nickname.length > 20) return cb({ ok: false, error: 'Invalid nickname' });
    leaveCurrentRoom(socket);

    const roomId = generateId();
    const room = {
      id: roomId,
      name: roomName || `${nickname}'s Room`,
      host: socket.id,
      players: [{ id: socket.id, nickname: nickname.substring(0, 20), ready: false, side: 'left' }],
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

  socket.on('join-room', ({ nickname, roomId }, cb) => {
    if (!nickname || nickname.length > 20) return cb({ ok: false, error: 'Invalid nickname' });
    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'Room not found' });
    if (room.status !== 'waiting') return cb({ ok: false, error: 'Game already in progress' });
    if (room.players.length >= 2) return cb({ ok: false, error: 'Room is full' });
    leaveCurrentRoom(socket);

    const side = room.players[0]?.side === 'left' ? 'right' : 'left';
    room.players.push({ id: socket.id, nickname: nickname.substring(0, 20), ready: false, side });
    playerRooms.set(socket.id, roomId);
    socket.join(roomId);
    cb({ ok: true, room });
    io.to(roomId).emit('room-updated', room);
    broadcastRoomList();
    console.log(`[Room] ${nickname} joined room ${roomId}`);
  });

  socket.on('leave-room', (cb) => {
    leaveCurrentRoom(socket);
    if (typeof cb === 'function') cb({ ok: true });
    broadcastRoomList();
  });

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

  socket.on('update-settings', ({ settings }, cb) => {
    const roomId = playerRooms.get(socket.id);
    if (!roomId) return cb({ ok: false });
    const room = rooms.get(roomId);
    if (!room || room.host !== socket.id || room.status !== 'waiting') return cb({ ok: false });
    room.settings = { ...room.settings, ...settings };
    cb({ ok: true });
    io.to(roomId).emit('room-updated', room);
  });

  socket.on('kick-player', ({ playerId }, cb) => {
    const roomId = playerRooms.get(socket.id);
    if (!roomId) return cb?.({ ok: false, error: 'Not in a room' });
    const room = rooms.get(roomId);
    if (!room) return cb?.({ ok: false, error: 'Room not found' });
    if (room.host !== socket.id) return cb?.({ ok: false, error: 'Only host can kick' });
    if (room.status !== 'waiting') return cb?.({ ok: false, error: 'Cannot kick during game' });
    if (playerId === socket.id) return cb?.({ ok: false, error: 'Cannot kick yourself' });

    const target = room.players.find(p => p.id === playerId);
    if (!target) return cb?.({ ok: false, error: 'Player not found' });

    room.players = room.players.filter(p => p.id !== playerId);
    playerRooms.delete(playerId);

    const targetSocket = io.sockets.sockets.get(playerId);
    if (targetSocket) {
      targetSocket.emit('kicked', 'You were kicked from the room');
      targetSocket.leave(roomId);
    }

    cb?.({ ok: true });
    io.to(roomId).emit('room-updated', room);
    broadcastRoomList();
    console.log(`[Room] ${target.nickname} was kicked from room ${roomId}`);
  });

  // ─── Chat ──────────────────────────────────────────────
  socket.on('chat-message', ({ text, isEmote }, cb) => {
    const roomId = playerRooms.get(socket.id);
    if (!roomId) return cb?.({ ok: false });
    const room = rooms.get(roomId);
    if (!room) return cb?.({ ok: false });
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return cb?.({ ok: false });

    // Rate limit: max 60 chars, sanitize
    const sanitized = String(text).substring(0, 60);
    const msg = {
      id: generateId(),
      sender: player.nickname,
      text: sanitized,
      isEmote: !!isEmote,
      timestamp: Date.now(),
    };
    io.to(roomId).emit('chat', msg);
    cb?.({ ok: true });
  });

  socket.on('start-game', (cb) => {
    const roomId = playerRooms.get(socket.id);
    if (!roomId) return cb({ ok: false, error: 'Not in a room' });
    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'Room not found' });
    if (room.host !== socket.id) return cb({ ok: false, error: 'Only host can start' });
    if (room.players.length < 2) return cb({ ok: false, error: 'Need 2 players' });
    if (!room.players.every(p => p.ready)) return cb({ ok: false, error: 'All players must be ready' });

    room.status = 'playing';

    const gs = {
      left: createPlayerState(room.settings),
      right: createPlayerState(room.settings),
      incomeInterval: null,
      powerUpInterval: null,
      gameStartTime: Date.now(),
    };

    // Start income ticker (every second)
    gs.incomeInterval = setInterval(() => {
      const currentRoom = rooms.get(roomId);
      if (!currentRoom || currentRoom.status !== 'playing') {
        clearInterval(gs.incomeInterval);
        return;
      }
      ['left', 'right'].forEach(side => {
        const ps = gs[side];
        let income = 0;
        for (const [type, count] of Object.entries(ps.buildingCounts)) {
          const tmpl = BUILDING_TEMPLATES.find(t => t.type === type);
          if (tmpl) income += tmpl.income * count;
        }
        income *= (currentRoom.settings.incomeMultiplier || 1);
        ps.money += income;
      });
      currentRoom.players.forEach(p => {
        const sock = io.sockets.sockets.get(p.id);
        const ps = gs[p.side];
        if (sock && ps) {
          sock.emit('money-sync', ps.money);
        }
      });
    }, 1000);

    // Power-up events (if enabled)
    if (room.settings.powerUps) {
      gs.powerUpInterval = setInterval(() => {
        const currentRoom = rooms.get(roomId);
        if (!currentRoom || currentRoom.status !== 'playing') {
          clearInterval(gs.powerUpInterval);
          return;
        }
        const elapsed = (Date.now() - gs.gameStartTime) / 1000;
        if (elapsed < (currentRoom.settings.gracePeriod || 60)) return;
        const enabledEvents = new Set(currentRoom.settings.enabledEvents || DEFAULT_SETTINGS.enabledEvents);

        // Supply drop ~every 30s
        if (enabledEvents.has('supply-drop') && Math.random() < 0.15) {
          const event = {
            type: 'supply-drop',
            x: 0.1 + Math.random() * 0.8,
            data: { amount: 50 + Math.floor(Math.random() * 100) },
          };
          io.to(roomId).emit('power-up', event);
        }
        // Meteor shower ~every 2 min
        if (enabledEvents.has('meteor-shower') && Math.random() < 0.03) {
          const event = {
            type: 'meteor-shower',
            x: 0.1 + Math.random() * 0.8,
            data: { count: 3 + Math.floor(Math.random() * 4), damage: 15 + Math.floor(Math.random() * 25) },
          };
          io.to(roomId).emit('power-up', event);
        }
        if (enabledEvents.has('earthquake') && Math.random() < 0.02) {
          io.to(roomId).emit('power-up', { type: 'earthquake', x: 0.5, data: { damage: 8 } });
        }
        if (enabledEvents.has('airstrike') && Math.random() < 0.02) {
          io.to(roomId).emit('power-up', { type: 'airstrike', x: 0.2 + Math.random() * 0.6, data: { count: 3, damage: 28 } });
        }
        if (enabledEvents.has('emp') && Math.random() < 0.015) {
          io.to(roomId).emit('power-up', { type: 'emp', x: 0.5, data: { duration: 7000 } });
        }
      }, 5000);
    }

    gameStates.set(roomId, gs);

    cb({ ok: true });
    room.players.forEach(p => {
      const sock = io.sockets.sockets.get(p.id);
      if (sock) sock.emit('game-started', { room, yourSide: p.side });
    });
    broadcastRoomList();
    console.log(`[Game] Room ${roomId} started with settings:`, JSON.stringify(room.settings));
  });

  // ─── Authoritative game action handler ──────────────────
  socket.on('game-action', (action, cb) => {
    const roomId = playerRooms.get(socket.id);
    if (!roomId) return cb?.({ ok: false, error: 'Not in room' });
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return cb?.({ ok: false, error: 'Not playing' });

    const gs = gameStates.get(roomId);
    if (!gs) return cb?.({ ok: false, error: 'No game state' });

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return cb?.({ ok: false, error: 'Not a player' });

    const ps = gs[player.side];
    const result = validateAction(ps, action);

    if (result.ok) {
      if (!result.skipRelay) {
        socket.to(roomId).emit('opponent-action', result.relayAction || action);
      }
      cb?.({ ok: true, money: ps.money });
    } else {
      cb?.({ ok: false, error: result.error, money: ps.money });
    }
  });

  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id} disconnected`);
    const roomId = playerRooms.get(socket.id);
    if (roomId) {
      const room = rooms.get(roomId);
      if (room && room.status === 'playing') {
        socket.to(roomId).emit('opponent-disconnected');
        room.status = 'finished';
        cleanupGameState(roomId);
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
    cleanupGameState(roomId);
    rooms.delete(roomId);
    console.log(`[Room] ${roomId} deleted (empty)`);
  } else {
    if (room.host === socket.id) room.host = room.players[0].id;
    io.to(roomId).emit('room-updated', room);
    if (room.status === 'playing') {
      io.to(roomId).emit('opponent-disconnected');
      room.status = 'finished';
      cleanupGameState(roomId);
    }
  }
}
