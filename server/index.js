const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { RoomManager } = require('./RoomManager');
const { parseCard } = require('./GameEngine');

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
  // Same 5-minute safety net, for the "someone busted and won't decide"
  // pause (awaitingBustResolution) instead of a stuck mid-hand turn. Keyed
  // by room code, like pauseTimers — see maybeArmBustTimer below.
  const bustTimers = new Map();
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
    room.touch();
    maybeArmPauseTimer(room);
    maybeArmBustTimer(room);
    for (const p of room.players) {
      if (!p.socketId) continue;
      const state = room.getStateForPlayer(p.id);
      if (state) io.to(p.socketId).emit('game:state', state);
    }
    io.to(room.code).emit('room:state', room.getLobbyState());
  }

  // Mirrors maybeArmPauseTimer, for the "someone busted, hasn't rebought or
  // left yet" pause instead of a stuck mid-hand turn. Re-evaluated from the
  // same broadcastRoom funnel point after every event that could change who's
  // pending (a bust, a rebuy, a leave).
  function maybeArmBustTimer(room) {
    const existing = bustTimers.get(room.code);
    const pendingIds = room.players.filter(p => p.chips === 0 && !p.left).map(p => p.id).sort().join(',');
    const shouldBeArmed = room.awaitingBustResolution && pendingIds.length > 0;

    if (existing && existing.pendingIds === pendingIds) return; // already correct
    if (existing) {
      clearTimeout(existing.timer);
      bustTimers.delete(room.code);
    }
    if (!shouldBeArmed) return;

    const timer = setTimeout(() => {
      bustTimers.delete(room.code);
      // Re-validate at fire time — someone may have resolved (rebought or
      // left) between arming and firing.
      const stillPending = room.players.filter(p => p.chips === 0 && !p.left);
      for (const p of stillPending) room.markLeft(p.id);
      tryAdvanceIfClear(room);
    }, PAUSE_TIMEOUT_MS);
    bustTimers.set(room.code, { pendingIds, timer });
  }

  // The single place that decides whether the room can actually deal the
  // next hand: holds (and broadcasts the pause) if anyone's chips===0 and
  // hasn't resolved yet, otherwise proceeds to nextRound() as before. Called
  // both right after the settlement-ack wait clears, and again whenever a
  // pending player resolves (rebuy or leave) — either can be the thing that
  // finally clears the pause.
  function tryAdvanceIfClear(room) {
    // Deliberately does NOT call room.syncChipsFromGame() itself — that
    // must happen exactly once, right when a hand finishes (see
    // advanceRoom), not on every call here. This function is also called
    // after a rebuy/leave resolves the pause, and by then room.players
    // already holds the current truth (the rebuy already incremented
    // chips directly); re-syncing from the finished, untouched game engine
    // at that point would clobber the rebuy's chips right back down to 0
    // (confirmed the hard way — a live test kept looping instead of
    // clearing the pause).
    const busted = room.players.filter(p => p.chips === 0 && !p.left);
    if (busted.length > 0) {
      room.awaitingBustResolution = true;
      broadcastRoom(room);
      return;
    }
    room.awaitingBustResolution = false;
    const nr = room.nextRound();
    if (nr.ended) io.to(room.code).emit('game:ended', nr);
    broadcastRoom(room);
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
    room.syncChipsFromGame();
    tryAdvanceIfClear(room);
  }

  function handleActionResult(room, result) {
    if (result.error) return;
    broadcastRoom(room);

    if (result.showdown) {
      const showdownData = {
        winners: result.winners,
        pot: result.pot,
        settle: result.settle,
        foldWin: result.foldWin,
      };
      io.to(room.code).emit('game:showdown', showdownData);
      room.lastShowdown = showdownData;
      room.beginSettlementWait();

      room.handHistory.push({
        handNumber: room.handHistory.length + 1,
        timestamp: Date.now(),
        communityCards: result.state.communityCards,
        foldWin: result.foldWin,
        winners: result.winners.map(w => ({ id: w.id, name: w.name, won: w.won, handName: w.handName })),
        settle: result.settle,
        reveals: result.showdownReveal, // public — sent to everyone as-is
        _privateHoleCards: result.allHoleCards, // never broadcast directly — see room:get-hand-history
      });
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
      clearTimeout(pendingRemovals.get(playerId));
      pendingRemovals.delete(playerId);
      const result = rooms.join(code, playerId, playerName, socket.id);
      if (result.error) return socket.emit('game:error', result.error);
      // The actual identity for this socket — may differ from the
      // client-sent playerId if this join was reclaimed by name-fallback
      // (different browser/app, same name, old identity currently
      // offline; see RoomManager.addPlayer). The client always adopts
      // whatever playerId comes back in room:joined as authoritative.
      const actualId = result.playerId;
      myPlayerId = actualId;
      result.room.touch();
      result.room.updateSocket(actualId, socket.id);
      socket.join(code.toUpperCase());
      socket.emit('room:joined', { code: code.toUpperCase(), playerId: actualId });
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
      room.touch();
      // If the room was paused waiting on this player's bust decision,
      // rebuying is one of the two ways to resolve it — re-check whether
      // everyone's clear to deal the next hand now.
      if (room.awaitingBustResolution) tryAdvanceIfClear(room);
      else io.to(room.code).emit('room:state', room.getLobbyState());
    });

    // Self-triggered "I'm intentionally leaving" — used for the busted
    // player's "退出对局" choice, an impatient other player's "退出" while
    // waiting on someone else's bust decision, and the lobby's own "退出
    // 房间" button. Unlike a disconnect, this resolves immediately rather
    // than waiting out a grace period, and (via RoomManager.leave) marks
    // the player left instead of deleting their row, so their final
    // numbers stay on the ledger.
    socket.on('player:leave-room', ({ playerId }) => {
      const room = rooms.leave(playerId);
      if (!room) return;
      room.touch();
      if (room.awaitingBustResolution) tryAdvanceIfClear(room);
      else io.to(room.code).emit('room:state', room.getLobbyState());
    });

    // Host-only equivalent of "player:leave-room", for a busted player who
    // won't decide (mirrors game:fold-disconnected's manual override of
    // the mid-hand pause timer). Only usable while that specific player is
    // actually the thing the room is paused on — can't be used to force
    // out a player who simply hasn't rebought yet outside a bust pause.
    socket.on('room:leave-for', ({ hostId, targetId }) => {
      const room = rooms.getRoomByPlayer(hostId);
      if (!room || room.hostId !== hostId) return;
      const target = room.players.find(p => p.id === targetId);
      if (!target || target.chips !== 0 || target.left) return;
      const result = rooms.leave(targetId);
      if (!result) return;
      result.touch();
      if (result.awaitingBustResolution) tryAdvanceIfClear(result);
      else io.to(result.code).emit('room:state', result.getLobbyState());
    });

    socket.on('player:poke', ({ fromId, targetId }) => {
      const room = rooms.getRoomByPlayer(fromId);
      if (!room) return socket.emit('game:error', '未找到房间');
      const result = room.poke(fromId, targetId);
      if (result.error) return socket.emit('game:error', result.error);
      room.touch();
      io.to(room.code).emit('player:poked', { fromId, targetId });
    });

    socket.on('room:restart', ({ playerId }) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room) return socket.emit('game:error', '未找到房间');
      if (room.hostId !== playerId) return socket.emit('game:error', '只有房主可以重新开始');
      room.restart();
      room.touch();
      io.to(room.code).emit('room:state', room.getLobbyState());
    });

    // Host-only "call it a night" — unlike room:restart, chips/debt are
    // NOT reset (this is the final tally, not a fresh session), and unlike
    // the chips-run-out auto-pause, this is a deliberate action, so the
    // client marks it `hostEnded` to auto-open the ledger instead of just
    // toasting a reason.
    socket.on('room:end-game', ({ playerId }) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room) return socket.emit('game:error', '未找到房间');
      if (room.hostId !== playerId) return socket.emit('game:error', '只有房主可以结束游戏');
      room.syncChipsFromGame();
      room.game = null;
      room.status = 'waiting';
      room.awaitingBustResolution = false;
      room.touch();
      io.to(room.code).emit('room:state', room.getLobbyState());
      io.to(room.code).emit('game:ended', { ended: true, reason: '房主结束了本局对局', hostEnded: true });
    });

    // On-demand only (not folded into the high-frequency room:state
    // broadcast every action already triggers) — the history can grow to
    // dozens of hands across a night, no need to ship all of it on every
    // single check/call.
    socket.on('room:get-hand-history', ({ playerId }) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room) return socket.emit('game:error', '未找到房间');
      // Per-viewer response: everyone gets the same public `reveals`
      // (showdown contenders, or a fold-win winner who opted into 亮牌炫耀),
      // plus this one viewer's own hole cards for hands they were dealt
      // into — same rule the live table already applies (own cards always
      // visible, others' hidden unless publicly shown). Built fresh per
      // request; `_privateHoleCards` never leaves the server directly.
      const personalized = room.handHistory.map(h => {
        const { _privateHoleCards, ...pub } = h;
        const mine = _privateHoleCards?.find(c => c.id === playerId);
        const alreadyPublic = pub.reveals.some(r => r.id === playerId);
        const myName = h.settle.find(s => s.id === playerId)?.name;
        const reveals = mine && !alreadyPublic
          ? [...pub.reveals, { id: playerId, name: myName, holeCards: mine.holeCards }]
          : pub.reveals;
        return { ...pub, reveals };
      });
      socket.emit('room:hand-history', personalized);
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
      room.touch();
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
      room.touch();
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
      room.touch();
      if (room.ackReady(playerId)) advanceRoom(room);
      else io.to(room.code).emit('game:settlement-progress', room.getSettlementProgress());
    });

    socket.on('game:reveal-cards', ({ playerId }) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room?.isAwaitingSettlementAck() || !room.game) return;

      const player = room.game.players.find(p => p.id === playerId);
      // Must be a fold-win: this player didn't fold, and is the ONLY non-folded player
      const activePlayers = room.game.players.filter(p => p.status !== 'folded');
      if (!player || player.status === 'folded' || activePlayers.length !== 1) return;
      // No double-reveal
      if (!room.revealedPlayerIds) room.revealedPlayerIds = new Set();
      if (room.revealedPlayerIds.has(playerId)) return;
      room.revealedPlayerIds.add(playerId);
      room.touch();

      const revealedHoleCards = player.holeCards.map(parseCard);
      io.to(room.code).emit('game:cards-revealed', {
        playerId,
        playerName: player.name,
        holeCards: revealedHoleCards,
      });

      // Same settlement-wait invariant room.lastShowdown already relies on:
      // no new hand can start until this one's wait resolves, so the most
      // recent handHistory entry is still this hand — patch its reveals in
      // now that the winner opted in, instead of it staying permanently
      // empty for a fold-win hand they later chose to show off.
      const lastHand = room.handHistory[room.handHistory.length - 1];
      if (lastHand && lastHand.foldWin) {
        lastHand.reveals.push({ id: playerId, name: player.name, holeCards: revealedHoleCards });
      }
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

  // Idle-room reaper: mid-game disconnects have no per-player timeout (see
  // the comment above), so a room abandoned mid-hand would otherwise sit in
  // memory forever with nothing to ever clear it. Sweeps every 15 minutes;
  // .unref() so this interval alone never keeps the Node process (or a test
  // run) alive.
  const ROOM_IDLE_TTL_MS = 12 * 60 * 60 * 1000;
  const sweepInterval = setInterval(() => rooms.sweepIdleRooms(ROOM_IDLE_TTL_MS), 15 * 60 * 1000);
  sweepInterval.unref();

  return { app, server, io, rooms };
}

if (require.main === module) {
  const { server } = createServer();
  const PORT = process.env.PORT || 3001;
  server.listen(PORT, () => console.log(`🃏  翡翠厅 server → http://localhost:${PORT}`));
}

module.exports = { createServer };
