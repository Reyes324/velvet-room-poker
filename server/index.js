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
  // Safety-timeout for a mid-hand pause: if the player whose turn it is
  // stays disconnected this long with nobody (them or the host) resolving
  // it, auto-fold on their behalf so the table isn't stuck forever if the
  // host is unreachable too. Keyed by room code — only one turn can be
  // "stuck" at a time per room. See maybeArmPauseTimer below.
  const pauseTimers = new Map();
  const PAUSE_TIMEOUT_MS = 5 * 60 * 1000;
  // Settlement safety-timeout: if an eligible player disconnects during
  // settlement wait and never returns, auto-drop them after 10 minutes so
  // the remaining connected players can advance instead of being stuck
  // forever. Analogous to maybeArmPauseTimer but for the settlement phase
  // — the action-phase timer fires fold, this one fires dropFromSettlementWait.
  const settlementTimers = new Map();
  const SETTLEMENT_TIMEOUT_MS = 10 * 60 * 1000;

  app.use(express.static(path.join(__dirname, '../client/dist')));
  app.get('/health', (_, res) => res.json({ ok: true, rooms: rooms.rooms.size }));
  // Pass root+relative (not a raw absolute path) so express/send's dotfile
  // check only inspects "index.html", not every ancestor directory in the
  // checkout path — a raw absolute path 404s if the checkout lives under
  // any dot-prefixed directory (e.g. a `.claude/worktrees/...` worktree).
  app.get('/{*path}', (_, res) => res.sendFile('index.html', { root: path.join(__dirname, '../client/dist') }));

  // ─── helpers ───────────────────────────────────────────────────────────────

  function broadcastRoom(room) {
    maybeArmPauseTimer(room);
    for (const p of room.players) {
      if (!p.socketId) continue;
      const state = room.getStateForPlayer(p.id);
      if (state) io.to(p.socketId).emit('game:state', state);
    }
    io.to(room.code).emit('room:state', room.getLobbyState());
  }

  // Arms, re-arms, or clears the pause-timeout for a room, based on
  // whether whoever's turn it currently is is disconnected. Called from
  // the single broadcastRoom() funnel point below, so it re-evaluates
  // after every event that could change whose turn it is or someone's
  // connection status (actions, disconnects, reconnects).
  function maybeArmPauseTimer(room) {
    const existing = pauseTimers.get(room.code);
    const actionPlayerId = room.getActionPlayerId();
    const player = actionPlayerId ? room.players.find(p => p.id === actionPlayerId) : null;
    const shouldBeArmed = !!player && player.connected === false;

    if (existing && existing.playerId === actionPlayerId && shouldBeArmed) return; // already correct
    if (existing) {
      clearTimeout(existing.timer);
      pauseTimers.delete(room.code);
    }
    if (!shouldBeArmed) return;

    const timer = setTimeout(() => {
      pauseTimers.delete(room.code);
      // Re-validate at fire time — the situation may have resolved itself
      // (reconnect, host fold, hand ended) between arming and firing.
      const result = room.resolveDisconnectedTurn(actionPlayerId);
      if (!result.error) handleActionResult(room, result);
    }, PAUSE_TIMEOUT_MS);
    pauseTimers.set(room.code, { playerId: actionPlayerId, timer });
  }

  // Arms a safety-timeout for the settlement-wait phase: if any eligible
  // (not-yet-acked) player is disconnected, starts a 10-minute timer. At
  // fire time, all disconnected eligible players are dropped so the room
  // can advance. Clears + rearms on each call (lives alongside the pause
  // timer for the action phase, which is a different concern).
  function armSettlementTimer(room) {
    clearSettlementTimer(room);
    if (!room.isAwaitingSettlementAck()) return;
    const eligible = room.settlementWait.eligiblePlayerIds;
    const anyDisconnected = room.players.some(p => eligible.has(p.id) && p.connected === false);
    if (!anyDisconnected) return;

    const timer = setTimeout(() => {
      settlementTimers.delete(room.code);
      if (!room.isAwaitingSettlementAck()) return;
      for (const p of room.players) {
        if (p.connected === false && eligible.has(p.id)) {
          if (room.dropFromSettlementWait(p.id)) {
            advanceRoom(room);
            return;
          }
        }
      }
      // Dropped all disconnected players but still didn't fire advanceRoom
      // (not all remaining eligible have acked yet). Broadcast the updated
      // progress so the stuck players know something changed.
      io.to(room.code).emit('game:settlement-progress', room.getSettlementProgress());
    }, SETTLEMENT_TIMEOUT_MS);
    settlementTimers.set(room.code, timer);
  }

  function clearSettlementTimer(room) {
    const existing = settlementTimers.get(room.code);
    if (existing) clearTimeout(existing);
    settlementTimers.delete(room.code);
  }

  // Advances a room past its post-showdown settlement wait: clears the
  // room's ready-tracking state and moves the game on. This is the single
  // place that does so — either trigger (all acks in, or a departing player
  // unblocking everyone still left) funnels through here. No fallback timer
  // — the room waits for every seated player to actually click "我知道了"
  // before the next hand deals, full stop.
  function advanceRoom(room) {
    room.lastShowdown = null;
    clearSettlementTimer(room);
    room.clearSettlementWait();
    const nr = room.nextRound();
    if (nr.ended) io.to(room.code).emit('game:ended', nr);
    broadcastRoom(room);
  }

  function handleActionResult(room, result) {
    if (result.error) return;
    broadcastRoom(room);

    if (result.showdown) {
      const showdownData = {
        winners: result.winners,
        pot: result.pot,
        settle: result.settle,
      };
      io.to(room.code).emit('game:showdown', showdownData);
      room.lastShowdown = showdownData;
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
      if (room.isAwaitingSettlementAck() && room.game) {
        // Reconnection during settlement wait: send room:state to everyone
        // (connected markers), then send game:state + showdown data +
        // settlement progress to the reconnecting socket only. We avoid
        // broadcastRoom here because it sends game:state to all players,
        // which the client handler uses to clear settlement modals.
        io.to(room.code).emit('room:state', room.getLobbyState());
        socket.emit('game:state', room.getStateForPlayer(playerId));
        if (room.lastShowdown) socket.emit('game:showdown', room.lastShowdown);
        socket.emit('game:settlement-progress', room.getSettlementProgress());
        // Clear the settlement timer since this player reconnected
        clearSettlementTimer(room);
      } else if (room.game) {
        broadcastRoom(room);
      } else {
        io.to(room.code).emit('room:state', room.getLobbyState());
      }
    });

    socket.on('room:kick', ({ hostId, targetId }) => {
      const room = rooms.getRoomByPlayer(hostId);
      if (!room || room.hostId !== hostId) return;
      const target = room.players.find(p => p.id === targetId);
      if (target?.socketId) {
        io.to(target.socketId).emit('room:kicked');
      }
      const wasAwaitingSettlement = room.isAwaitingSettlementAck();
      rooms.leave(targetId);
      io.to(room.code).emit('room:state', room.getLobbyState());
      // If settlement was blocked by the kicked player (who was removed
      // from eligiblePlayerIds by Room.removePlayer), check if all
      // remaining eligible players have now acked. dropFromSettlementWait
      // is idempotent on an already-removed ID: Set.delete returns false
      // (no-op) but still returns _allSettlementAcksIn().
      if (wasAwaitingSettlement && room.isAwaitingSettlementAck() &&
          room.dropFromSettlementWait(targetId)) {
        advanceRoom(room);
      }
    });

    socket.on('game:fold-disconnected', ({ hostId, targetId }) => {
      const room = rooms.getRoomByPlayer(hostId);
      if (!room) return socket.emit('game:error', '未找到房间');
      const result = room.foldForDisconnected(hostId, targetId);
      if (result.error) return socket.emit('game:error', result.error);
      handleActionResult(room, result);
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
        // Settlement-wait disconnect: unlike the old behavior, we do NOT
        // drop the player from settlement wait or auto-advance (which was
        // the root cause of Bug 3 — in heads-up, the brief disconnect
        // would trigger advanceRoom → nextRound → only 1 active player →
        // game ends). Instead, treat it like any other mid-game disconnect:
        // just mark connected:false and let the settlement safety timeout
        // handle the "never came back" case. We broadcast room:state and
        // settlement-progress (but NOT game:state, which would clear other
        // players' settlement modals via the client's game:state handler).
        io.to(room.code).emit('room:state', room.getLobbyState());
        io.to(room.code).emit('game:settlement-progress', room.getSettlementProgress());
        armSettlementTimer(room);
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
