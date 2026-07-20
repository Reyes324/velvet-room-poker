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
  // Grace-period timers for lobby (pre-game) disconnects, keyed by playerId.
  // A disconnect while just sitting in the lobby is very often transient —
  // backgrounding the tab to paste the invite link into a messaging app,
  // a brief network blip — not "this player is gone". Removing them (and
  // deleting the room, if they were its only player, which is exactly the
  // case right after a host creates a room and before anyone's joined)
  // immediately on disconnect turned "share the link" into a room-deleting
  // action a large fraction of the time on mobile. See GRACE_PERIOD_MS.
  const pendingRemovals = new Map();
  const GRACE_PERIOD_MS = 120000;

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

  // Advances a room past its post-showdown settlement wait: clears the
  // room's ready-tracking state and moves the game on. This is the single
  // place that does so — either trigger (all acks in, or a departing player
  // unblocking everyone still left) funnels through here. No fallback timer
  // — the room waits for every seated player to actually click "我知道了"
  // before the next hand deals, full stop.
  function advanceRoom(room) {
    room.clearSettlementWait();
    const nr = room.nextRound();
    if (nr.ended) io.to(room.code).emit('game:ended', nr);
    broadcastRoom(room);
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

      room.beginSettlementWait();
    }
  }

  // ─── socket events ─────────────────────────────────────────────────────────

  io.on('connection', (socket) => {
    let myPlayerId = null;

    // Read-only lookup for the "XXX invited you" banner on the join screen —
    // no side effects (doesn't touch players/sockets), safe to call before
    // the visitor has entered their name or committed to joining.
    socket.on('room:peek', ({ code }, callback) => {
      const room = rooms.getRoom(code);
      if (!room) return callback?.({ error: '房间不存在' });
      const host = room.players.find(p => p.id === room.hostId);
      callback?.({ hostName: host?.name ?? null, playerCount: room.players.length });
    });

    socket.on('room:create', ({ playerId, playerName }) => {
      myPlayerId = playerId;
      clearTimeout(pendingRemovals.get(playerId));
      pendingRemovals.delete(playerId);
      const room = rooms.create(playerId, playerName);
      room.updateSocket(playerId, socket.id);
      socket.join(room.code);
      socket.emit('room:joined', { code: room.code, playerId });
      io.to(room.code).emit('room:state', room.getLobbyState());
    });

    socket.on('room:join', ({ code, playerId, playerName }) => {
      myPlayerId = playerId;
      clearTimeout(pendingRemovals.get(playerId));
      pendingRemovals.delete(playerId);
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

    socket.on('player:poke', ({ fromId, targetId }) => {
      const room = rooms.getRoomByPlayer(fromId);
      if (!room) return socket.emit('game:error', '未找到房间');
      const result = room.poke(fromId, targetId);
      if (result.error) return socket.emit('game:error', result.error);
      io.to(room.code).emit('player:poked', { fromId, targetId });
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
      if (!room) {
        // Reconnected too late — the grace period already expired and the
        // room (or this player's spot in it) is gone. Say so explicitly
        // instead of leaving the client sitting on a stale lobby forever.
        socket.emit('room:gone');
        return;
      }
      // Re-associate this (possibly new, post-reconnect) socket with the
      // room: without this, a reconnected client never gets back into the
      // socket.io room (misses future broadcasts) and this connection's own
      // future 'disconnect' wouldn't know which player it was for.
      myPlayerId = playerId;
      room.updateSocket(playerId, socket.id);
      room.setConnected(playerId, true);
      socket.join(room.code);
      clearTimeout(pendingRemovals.get(playerId));
      pendingRemovals.delete(playerId);
      // Broadcast to the whole room (not just this socket) so everyone
      // else's "XXX 断线中" indicator clears too, and — once a game is in
      // progress — so maybeArmPauseTimer (Task 7) re-evaluates whether the
      // safety timeout should still be ticking.
      if (room.game) broadcastRoom(room);
      else io.to(room.code).emit('room:state', room.getLobbyState());
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
      if (!room?.isAwaitingSettlementAck()) return;
      if (room.ackReady(playerId)) advanceRoom(room);
      else io.to(room.code).emit('game:settlement-progress', room.getSettlementProgress());
    });

    socket.on('disconnect', () => {
      if (!myPlayerId) return;
      const room = rooms.getRoomByPlayer(myPlayerId);
      if (!room) return;

      room.setConnected(myPlayerId, false);

      if (room.isAwaitingSettlementAck()) {
        // Unchanged: settlement-ack disconnects still drop the player from
        // the "must ack" set immediately rather than pausing — this is a
        // lower-stakes confirmation click, not an in-hand decision, and is
        // explicitly out of scope for the pause-and-wait behavior below.
        if (room.dropFromSettlementWait(myPlayerId)) advanceRoom(room);
        else io.to(room.code).emit('game:settlement-progress', room.getSettlementProgress());
      } else if (room.game) {
        // Mid-hand disconnect: no auto-fold, no removal. broadcastRoom lets
        // everyone see the "connected:false" flag immediately, and (once
        // Task 7 lands) arms the safety-timeout if it's this player's turn.
        broadcastRoom(room);
      } else {
        io.to(room.code).emit('room:state', room.getLobbyState());
      }

      if (room.status === 'waiting') {
        // Lobby disconnect: give them a grace period to reconnect (e.g. they
        // just backgrounded the tab to paste the invite link somewhere)
        // instead of yanking them — and possibly deleting the whole room,
        // if they were its only player — immediately. Unchanged from before.
        const pid = myPlayerId;
        const deadSocketId = socket.id;
        const timer = setTimeout(() => {
          pendingRemovals.delete(pid);
          const stillRoom = rooms.getRoomByPlayer(pid);
          const player = stillRoom?.players.find(p => p.id === pid);
          if (stillRoom && player && player.socketId === deadSocketId) {
            rooms.leave(pid);
            if (stillRoom.players.length > 0) {
              io.to(stillRoom.code).emit('room:state', stillRoom.getLobbyState());
            }
          }
        }, GRACE_PERIOD_MS);
        pendingRemovals.set(pid, timer);
      }
      // Mid-game (room.status !== 'waiting'): deliberately no removal timer
      // at all. The only ways a mid-game player loses their seat are an
      // explicit host kick (room:kick, unchanged) or busting out of chips
      // (existing nextRound() elimination, unchanged) — see design.md.
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
