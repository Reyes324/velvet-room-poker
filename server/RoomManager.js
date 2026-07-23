const { GameEngine } = require('./GameEngine');

const STARTING_CHIPS = 1000;
const BIG_BLIND = 20;
const POKE_COOLDOWN_MS = 2000;

function randomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

class Room {
  constructor(hostId, hostName) {
    let code;
    do { code = randomCode(); } while (false); // uniqueness checked by RoomManager
    this.code = code;
    this.hostId = hostId;
    this.players = [{ id: hostId, name: hostName, chips: STARTING_CHIPS, socketId: null, debt: 0, connected: true, left: false }];
    this.game = null;       // GameEngine instance when in progress
    // Tracked by player id (not array index) so the button reliably lands on
    // "whoever sits after the previous dealer" even when the roster's size or
    // order changes between hands (mid-game joins, busted players dropping
    // out) — a raw index recomputed against a freshly-filtered array would
    // otherwise jump non-adjacently whenever the active set changes shape.
    this.dealerId = hostId;
    this.status = 'waiting'; // waiting | playing
    this.settlementWait = null; // { eligiblePlayerIds, readyPlayerIds } while waiting for post-showdown acks
    // True between a hand ending and every busted (chips===0, not left)
    // player having resolved their rebuy-or-leave decision — see
    // server/index.js's tryAdvanceIfClear. While true, nextRound() is
    // deliberately not called, so the room stays on the table instead of
    // snapping back to the lobby the instant someone busts.
    this.awaitingBustResolution = false;
    this.lastShowdown = null; // Last showdown data, stored for reconnection during settlement wait
    this.pokeCooldowns = new Map(); // `${fromId}→${targetId}` -> last-poke timestamp (ms)
  }

  addPlayer(id, name, socketId) {
    if (this.players.length >= 9) return { error: '房间已满，无法加入' };
    if (this.players.find(p => p.id === id)) return { error: '已在房间内' };
    this.players.push({ id, name, chips: STARTING_CHIPS, socketId, debt: 0, connected: true, left: false });
    return { ok: true };
  }

  // Only a busted (chips === 0) player can rebuy — independent of room
  // status, so someone who busts mid-game in a 3+ player table isn't stuck
  // waiting for the whole room to end before they can buy back in.
  rebuy(playerId) {
    const p = this.players.find(p => p.id === playerId);
    if (!p) return { error: '玩家不存在' };
    if (p.chips !== 0) return { error: '筹码充足，无需借入' };
    p.chips += STARTING_CHIPS;
    p.debt = (p.debt || 0) + STARTING_CHIPS;
    // nextRound() unconditionally re-syncs room.players' chips FROM
    // this.game.players every time it runs, including when a rebuy is
    // exactly what just cleared a bust-wait pause — without also writing
    // through to the (still-referenced, already-finished-hand) game
    // engine's own copy here, that resync would clobber the rebuy right
    // back down to 0 using the old pre-rebuy chip count.
    const gp = this.game?.players.find(gp => gp.id === playerId);
    if (gp) gp.chips = p.chips;
    return { ok: true };
  }

  // Was removePlayer(id) — deleted the row outright, which silently wiped
  // that player's chips/debt from the shared ledger the moment they left
  // (confirmed by user feedback: the ledger is meant to be the group's
  // real-money settlement record, not just a live scoreboard). Marking
  // `left` instead keeps their final numbers visible in 账本 forever, and
  // just excludes them from anything seating-related (dealt hands, the
  // lobby's open-seat count, host handoff).
  markLeft(id) {
    const p = this.players.find(p => p.id === id);
    if (!p) return;
    p.left = true;
    if (this.hostId === id) {
      const next = this.players.find(p => !p.left);
      if (next) this.hostId = next.id;
    }
    if (this.settlementWait) {
      this.settlementWait.eligiblePlayerIds.delete(id);
    }
  }

  // Purely social — no game-state effect. Cooldown is keyed by the ordered
  // pair so A repeatedly poking B doesn't also throttle A poking C, or B
  // poking A back.
  poke(fromId, targetId) {
    if (fromId === targetId) return { error: '不能拍自己' };
    const key = `${fromId}→${targetId}`;
    const last = this.pokeCooldowns.get(key);
    if (last && Date.now() - last < POKE_COOLDOWN_MS) return { error: '拍得太快了' };
    this.pokeCooldowns.set(key, Date.now());
    return { ok: true };
  }

  updateSocket(playerId, socketId) {
    const p = this.players.find(p => p.id === playerId);
    if (p) p.socketId = socketId;
  }

  // Explicit connection-status flag, separate from `socketId` (which is
  // never cleared on disconnect and so doesn't reflect live status). Set
  // false on disconnect, true on room:create/room:join/room:sync — see
  // server/index.js.
  setConnected(playerId, connected) {
    const p = this.players.find(p => p.id === playerId);
    if (p) p.connected = connected;
  }

  startGame() {
    const seated = this.players.filter(p => !p.left);
    if (seated.length < 2) return { error: '至少需要2名玩家' };
    if (this.status !== 'waiting') return { error: '游戏已在进行中' };
    this.status = 'playing';
    const idx = seated.findIndex(p => p.id === this.dealerId);
    const dealerIndex = idx === -1 ? 0 : idx;
    this.dealerId = seated[dealerIndex].id;
    this.game = new GameEngine(seated, dealerIndex, BIG_BLIND);
    return { ok: true };
  }

  // Sync chips from the (just-finished) game engine back onto the room's
  // own player records — keeps busted players' rows around at chips===0
  // for rebuy instead of dropping them. Split out from nextRound() because
  // index.js's tryAdvanceIfClear needs this to have already happened
  // *before* it decides whether nextRound() should even be called — chips
  // dropping to 0 is exactly the condition it's checking for, and checking
  // stale (pre-sync) values silently never caught anyone busting (confirmed
  // the hard way: a live test only passed because the bust-pause it was
  // meant to exercise never actually engaged).
  syncChipsFromGame() {
    for (const rp of this.players) {
      const gp = this.game?.players.find(p => p.id === rp.id);
      if (gp) rp.chips = gp.chips;
    }
  }

  nextRound() {
    this.syncChipsFromGame();
    // Only active (chips > 0, currently connected, hasn't left) players
    // enter the next hand — this already naturally picks up anyone who
    // joined mid-game, just rebought, or just reconnected, since it's
    // filtered fresh from the full room roster every time, not carried
    // over from the previous hand's player list. Disconnected players are
    // skipped (not dealt in) rather than force-included, so the same
    // absent player doesn't stall every subsequent hand — they're picked
    // back up automatically the next time nextRound() runs after they
    // reconnect.
    const active = this.players.filter(p => p.chips > 0 && p.connected !== false && !p.left);
    if (active.length < 2) {
      this.status = 'waiting';
      this.game = null;
      return { ended: true, reason: '筹码不足，等待玩家买入后重新开始' };
    }
    // Move the button to the seat after the previous dealer, found by id in
    // the freshly-filtered array. If that player busted out (or otherwise
    // isn't active this hand), fall back to seat 0 rather than guessing.
    const prevIdx = active.findIndex(p => p.id === this.dealerId);
    const dealerIndex = prevIdx === -1 ? 0 : (prevIdx + 1) % active.length;
    this.dealerId = active[dealerIndex].id;
    this.game = new GameEngine(active, dealerIndex, BIG_BLIND);
    return { ok: true };
  }

  // The one place that actually clears the session's history — chips,
  // debt (accumulated rebuys), and anyone who'd left all reset, since a
  // restart is explicitly "start a fresh night", unlike a player leaving
  // mid-session (markLeft), which deliberately keeps their final numbers
  // on the ledger.
  restart() {
    for (const p of this.players) { p.chips = STARTING_CHIPS; p.debt = 0; p.left = false; }
    this.status = 'waiting';
    this.game = null;
    this.awaitingBustResolution = false;
    this.dealerId = this.players.find(p => !p.left)?.id ?? null;
  }

  // ─── post-showdown "wait for everyone to ack" state ───────────────────────
  // Owned here (like `game`/`status`/`dealerId`) rather than as an ad-hoc
  // property set from outside — index.js only decides *when* to advance
  // (the fallback timer) and broadcasts the result; the ready-tracking data
  // itself belongs to the room.

  beginSettlementWait() {
    this.settlementWait = {
      eligiblePlayerIds: new Set(this.players.filter(p => p.socketId).map(p => p.id)),
      readyPlayerIds: new Set(),
    };
  }

  isAwaitingSettlementAck() {
    return this.settlementWait !== null;
  }

  // Records that a player has acked. Returns true if everyone currently
  // eligible has now acked (caller should advance the round).
  ackReady(playerId) {
    if (!this.settlementWait) return false;
    this.settlementWait.readyPlayerIds.add(playerId);
    return this._allSettlementAcksIn();
  }

  // Removes a departing player from the eligible set (e.g. on disconnect)
  // so they can't block the room forever. Returns true if everyone
  // remaining has now acked.
  dropFromSettlementWait(playerId) {
    if (!this.settlementWait) return false;
    this.settlementWait.eligiblePlayerIds.delete(playerId);
    return this._allSettlementAcksIn();
  }

  clearSettlementWait() {
    this.settlementWait = null;
    this.revealedPlayerIds = null;
  }

  // Real per-player ack progress for the settlement modal's "等待其他人确认
  // (X/Y)" — was previously faked client-side as "am I ready: 1 or 0", which
  // never reflected who else had actually acked.
  getSettlementProgress() {
    if (!this.settlementWait) return null;
    const { eligiblePlayerIds, readyPlayerIds } = this.settlementWait;
    return { readyCount: readyPlayerIds.size, totalCount: eligiblePlayerIds.size };
  }

  _allSettlementAcksIn() {
    const { eligiblePlayerIds, readyPlayerIds } = this.settlementWait;
    return [...eligiblePlayerIds].every((id) => readyPlayerIds.has(id));
  }

  // The id of whoever's turn it currently is, or null if no hand is in
  // progress. Cross-references GameEngine's own actionIndex — GameEngine
  // doesn't know about room-level connection status, so this is the seam
  // between "whose turn is it" (GameEngine) and "are they actually here"
  // (Room).
  getActionPlayerId() {
    if (!this.game) return null;
    return this.game.players[this.game.actionIndex]?.id ?? null;
  }

  // Shared by the host's manual "帮TA弃牌" button and the system safety
  // timeout (see server/index.js maybeArmPauseTimer) — the only difference
  // between those two callers is who's allowed to trigger it, not what
  // happens once triggered, so both funnel through here.
  resolveDisconnectedTurn(targetId) {
    if (!this.game) return { error: '游戏未开始' };
    const target = this.players.find(p => p.id === targetId);
    if (!target || target.connected !== false) return { error: '该玩家未处于断线状态' };
    if (this.getActionPlayerId() !== targetId) return { error: '还没轮到该玩家' };
    return this.game.fold(targetId);
  }

  foldForDisconnected(hostId, targetId) {
    if (this.hostId !== hostId) return { error: '只有房主可以这样做' };
    return this.resolveDisconnectedTurn(targetId);
  }

  playerAction(playerId, action, amount) {
    if (!this.game) return { error: '游戏未开始' };
    switch (action) {
      case 'fold':  return this.game.fold(playerId);
      case 'check': return this.game.check(playerId);
      case 'call':  return this.game.call(playerId);
      case 'raise': return this.game.raise(playerId, Number(amount));
      case 'allin': return this.game.allIn(playerId);
      default:      return { error: '未知操作' };
    }
  }

  getStateForPlayer(playerId) {
    if (!this.game) return null;
    return this.game.getStateForPlayer(playerId);
  }

  getLobbyState() {
    return {
      code: this.code,
      hostId: this.hostId,
      status: this.status,
      startingChips: STARTING_CHIPS,
      players: this.players.map(p => ({ id: p.id, name: p.name, chips: p.chips, debt: p.debt || 0, connected: p.connected !== false, left: p.left || false })),
      awaitingBustResolution: this.awaitingBustResolution,
    };
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map(); // code -> Room
    this.playerRoom = new Map(); // playerId -> roomCode
  }

  create(hostId, hostName) {
    let code;
    do { code = randomCode(); } while (this.rooms.has(code));
    const room = new Room(hostId, hostName);
    room.code = code;
    this.rooms.set(code, room);
    this.playerRoom.set(hostId, code);
    return room;
  }

  join(code, playerId, playerName, socketId) {
    const room = this.rooms.get(code.toUpperCase());
    if (!room) return { error: '房间不存在' };
    const result = room.addPlayer(playerId, playerName, socketId);
    if (result.error) return result;
    this.playerRoom.set(playerId, code.toUpperCase());
    return { ok: true, room };
  }

  leave(playerId) {
    const code = this.playerRoom.get(playerId);
    if (!code) return;
    const room = this.rooms.get(code);
    if (!room) return;
    room.markLeft(playerId);
    this.playerRoom.delete(playerId);
    // A room is only truly abandoned once everyone in it has left — the
    // player rows themselves stay (markLeft keeps them for the ledger), so
    // "empty" is no longer players.length === 0.
    if (room.players.every(p => p.left)) this.rooms.delete(code);
    return room;
  }

  getRoom(code) {
    return this.rooms.get(code?.toUpperCase());
  }

  getRoomByPlayer(playerId) {
    const code = this.playerRoom.get(playerId);
    return code ? this.rooms.get(code) : null;
  }

  updateSocket(playerId, socketId) {
    const room = this.getRoomByPlayer(playerId);
    if (room) room.updateSocket(playerId, socketId);
  }
}

module.exports = { RoomManager };
