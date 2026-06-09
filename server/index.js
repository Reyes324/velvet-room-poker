const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { RoomManager } = require('./RoomManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: 'http://localhost:5173', credentials: true },
});

const rooms = new RoomManager();
const ACTION_TIMEOUT_MS = 30000;
const timeouts = new Map(); // socketId -> timeout handle

app.use(express.static(path.join(__dirname, '../client/dist')));
app.get('/{*path}', (_, res) => res.sendFile(path.join(__dirname, '../client/dist/index.html')));

// ─── helpers ─────────────────────────────────────────────────────────────────

function broadcastRoom(room) {
  for (const p of room.players) {
    if (!p.socketId) continue;
    const state = room.getStateForPlayer(p.id);
    if (state) io.to(p.socketId).emit('game:state', state);
  }
  io.to(room.code).emit('room:state', room.getLobbyState());
}

function scheduleTimeout(room) {
  const game = room.game;
  if (!game) return;
  const p = game.players[game.actionIndex];
  if (!p) return;

  // Clear existing
  if (timeouts.has(p.id)) {
    clearTimeout(timeouts.get(p.id));
    timeouts.delete(p.id);
  }

  const handle = setTimeout(() => {
    // Auto check or fold
    const result = game.currentBet > (p.bet ?? 0)
      ? room.playerAction(p.id, 'fold')
      : room.playerAction(p.id, 'check');

    handleActionResult(room, result);
  }, ACTION_TIMEOUT_MS);

  timeouts.set(p.id, handle);
}

function handleActionResult(room, result) {
  if (result.error) return;
  broadcastRoom(room);

  if (result.showdown) {
    // Broadcast winners, then start next round after delay
    io.to(room.code).emit('game:showdown', result.winners);
    setTimeout(() => {
      const nr = room.nextRound();
      if (nr.ended) {
        io.to(room.code).emit('game:ended', nr);
      } else {
        broadcastRoom(room);
        scheduleTimeout(room);
      }
    }, 4000);
  } else {
    scheduleTimeout(room);
  }
}

// ─── socket events ────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  let myPlayerId = null;

  socket.on('room:create', ({ playerId, playerName }) => {
    myPlayerId = playerId;
    const room = rooms.create(playerId, playerName);
    room.updateSocket(playerId, socket.id);
    socket.join(room.code);
    socket.emit('room:joined', { code: room.code, playerId });
    io.to(room.code).emit('room:state', room.getLobbyState());
  });

  socket.on('room:join', ({ code, playerId, playerName }) => {
    myPlayerId = playerId;
    const result = rooms.join(code, playerId, playerName, socket.id);
    if (result.error) return socket.emit('error', result.error);
    result.room.updateSocket(playerId, socket.id);
    socket.join(code.toUpperCase());
    socket.emit('room:joined', { code: code.toUpperCase(), playerId });
    io.to(code.toUpperCase()).emit('room:state', result.room.getLobbyState());
  });

  socket.on('room:start', ({ playerId }) => {
    const room = rooms.getRoomByPlayer(playerId);
    if (!room) return socket.emit('error', '未找到房间');
    if (room.hostId !== playerId) return socket.emit('error', '只有房主可以开始游戏');
    const result = room.startGame();
    if (result.error) return socket.emit('error', result.error);
    broadcastRoom(room);
    scheduleTimeout(room);
  });

  socket.on('game:action', ({ playerId, action, amount }) => {
    const room = rooms.getRoomByPlayer(playerId);
    if (!room) return socket.emit('error', '未找到房间');
    // Clear pending timeout for this player
    if (timeouts.has(playerId)) {
      clearTimeout(timeouts.get(playerId));
      timeouts.delete(playerId);
    }
    const result = room.playerAction(playerId, action, amount);
    if (result.error) return socket.emit('error', result.error);
    handleActionResult(room, result);
  });

  socket.on('room:kick', ({ hostId, targetId }) => {
    const room = rooms.getRoomByPlayer(hostId);
    if (!room || room.hostId !== hostId) return;
    const target = room.players.find(p => p.id === targetId);
    if (target?.socketId) {
      io.to(target.socketId).emit('room:kicked');
    }
    rooms.leave(targetId);
    io.to(room.code).emit('room:state', room.getLobbyState());
  });

  socket.on('disconnect', () => {
    if (!myPlayerId) return;
    const room = rooms.getRoomByPlayer(myPlayerId);
    if (room?.game) {
      // Auto-fold disconnected player
      const result = room.playerAction(myPlayerId, 'fold');
      handleActionResult(room, result);
    }
    rooms.leave(myPlayerId);
    if (room && room.players.length > 0) {
      io.to(room.code).emit('room:state', room.getLobbyState());
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🃏  翡翠厅 server → http://localhost:${PORT}`));
