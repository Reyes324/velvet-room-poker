const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { RoomManager } = require('./RoomManager');

function createServer() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: '*' },
  });

  const rooms = new RoomManager();

  app.use(express.static(path.join(__dirname, '../client/dist')));
  app.get('/health', (_, res) => res.json({ ok: true, rooms: rooms.rooms.size }));
  // Pass root+relative (not a raw absolute path) so express/send's dotfile
  // check only inspects "index.html", not every ancestor directory in the
  // checkout path — a raw absolute path 404s if the checkout lives under
  // any dot-prefixed directory (e.g. a `.claude/worktrees/...` worktree).
  app.get('/{*path}', (_, res) => res.sendFile('index.html', { root: path.join(__dirname, '../client/dist') }));

  // ─── helpers ───────────────────────────────────────────────────────────────

  function broadcastRoom(room) {
    for (const p of room.players) {
      if (!p.socketId) continue;
      const state = room.getStateForPlayer(p.id);
      if (state) io.to(p.socketId).emit('game:state', state);
    }
    io.to(room.code).emit('room:state', room.getLobbyState());
  }

  function handleActionResult(room, result) {
    if (result.error) return;
    broadcastRoom(room);

    if (result.showdown) {
      io.to(room.code).emit('game:showdown', {
        winners: result.winners,
        pot: result.pot,
        settle: result.settle,
      });

      const eligiblePlayerIds = new Set(room.players.filter(p => p.socketId).map(p => p.id));
      const readyPlayerIds = new Set();

      function advance() {
        clearTimeout(fallbackTimer);
        room._advanceRound = null;
        const nr = room.nextRound();
        if (nr.ended) io.to(room.code).emit('game:ended', nr);
        broadcastRoom(room);
      }

      const fallbackTimer = setTimeout(advance, 15000);
      room._advanceRound = { readyPlayerIds, eligiblePlayerIds, advance };
    }
  }

  // ─── socket events ─────────────────────────────────────────────────────────

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
      if (result.error) return socket.emit('game:error', result.error);
      result.room.updateSocket(playerId, socket.id);
      socket.join(code.toUpperCase());
      socket.emit('room:joined', { code: code.toUpperCase(), playerId });
      io.to(code.toUpperCase()).emit('room:state', result.room.getLobbyState());
    });

    socket.on('room:start', ({ playerId }) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room) return socket.emit('game:error', '未找到房间');
      if (room.hostId !== playerId) return socket.emit('game:error', '只有房主可以开始游戏');
      const result = room.startGame();
      if (result.error) return socket.emit('game:error', result.error);
      broadcastRoom(room);
    });

    socket.on('game:action', ({ playerId, action, amount }) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room) return socket.emit('game:error', '未找到房间');
      const result = room.playerAction(playerId, action, amount);
      if (result.error) return socket.emit('game:error', result.error);
      handleActionResult(room, result);
    });

    socket.on('player:rebuy', ({ playerId }) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room) return socket.emit('game:error', '未找到房间');
      const result = room.rebuy(playerId);
      if (result.error) return socket.emit('game:error', result.error);
      io.to(room.code).emit('room:state', room.getLobbyState());
    });

    socket.on('room:restart', ({ playerId }) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room) return socket.emit('game:error', '未找到房间');
      if (room.hostId !== playerId) return socket.emit('game:error', '只有房主可以重新开始');
      room.restart();
      io.to(room.code).emit('room:state', room.getLobbyState());
    });

    socket.on('room:sync', ({ playerId }) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room) return;
      socket.emit('room:state', room.getLobbyState());
      const state = room.getStateForPlayer(playerId);
      if (state) socket.emit('game:state', state);
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

    socket.on('game:ready-next', ({ playerId }) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room?._advanceRound) return;
      const { readyPlayerIds, eligiblePlayerIds, advance } = room._advanceRound;
      readyPlayerIds.add(playerId);
      if ([...eligiblePlayerIds].every((id) => readyPlayerIds.has(id))) {
        advance();
      }
    });

    socket.on('disconnect', () => {
      if (!myPlayerId) return;
      const room = rooms.getRoomByPlayer(myPlayerId);
      if (room?.game && !room._advanceRound) {
        const result = room.playerAction(myPlayerId, 'fold');
        handleActionResult(room, result);
      }
      rooms.leave(myPlayerId);
      if (room?._advanceRound) {
        room._advanceRound.eligiblePlayerIds.delete(myPlayerId);
        const { readyPlayerIds, eligiblePlayerIds, advance } = room._advanceRound;
        if ([...eligiblePlayerIds].every((id) => readyPlayerIds.has(id))) advance();
      }
      if (room && room.players.length > 0) {
        io.to(room.code).emit('room:state', room.getLobbyState());
      }
    });
  });

  return { app, server, io, rooms };
}

if (require.main === module) {
  const { server } = createServer();
  const PORT = process.env.PORT || 3001;
  server.listen(PORT, () => console.log(`🃏  翡翠厅 server → http://localhost:${PORT}`));
}

module.exports = { createServer };
