const { GameEngine } = require('./GameEngine');

const STARTING_CHIPS = 1000;
const BIG_BLIND = 20;

function randomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

class Room {
  constructor(hostId, hostName) {
    let code;
    do { code = randomCode(); } while (false); // uniqueness checked by RoomManager
    this.code = code;
    this.hostId = hostId;
    this.players = [{ id: hostId, name: hostName, chips: STARTING_CHIPS, socketId: null, debt: 0 }];
    this.game = null;       // GameEngine instance when in progress
    // Tracked by player id (not array index) so the button reliably lands on
    // "whoever sits after the previous dealer" even when the roster's size or
    // order changes between hands (mid-game joins, busted players dropping
    // out) — a raw index recomputed against a freshly-filtered array would
    // otherwise jump non-adjacently whenever the active set changes shape.
    this.dealerId = hostId;
    this.status = 'waiting'; // waiting | playing
    this.settlementWait = null; // { eligiblePlayerIds, readyPlayerIds } while waiting for post-showdown acks
  }

  addPlayer(id, name, socketId) {
    if (this.players.length >= 9) return { error: '房间已满，无法加入' };
    if (this.players.find(p => p.id === id)) return { error: '已在房间内' };
    this.players.push({ id, name, chips: STARTING_CHIPS, socketId, debt: 0 });
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
    return { ok: true };
  }

  removePlayer(id) {
    this.players = this.players.filter(p => p.id !== id);
    if (this.hostId === id && this.players.length > 0) {
      this.hostId = this.players[0].id;
    }
  }

  updateSocket(playerId, socketId) {
    const p = this.players.find(p => p.id === playerId);
    if (p) p.socketId = socketId;
  }

  startGame() {
    if (this.players.length < 2) return { error: '至少需要2名玩家' };
    if (this.status !== 'waiting') return { error: '游戏已在进行中' };
    this.status = 'playing';
    const idx = this.players.findIndex(p => p.id === this.dealerId);
    const dealerIndex = idx === -1 ? 0 : idx;
    this.dealerId = this.players[dealerIndex].id;
    this.game = new GameEngine(this.players, dealerIndex, BIG_BLIND);
    return { ok: true };
  }

  nextRound() {
    // Sync chips from game engine back to room players; keep busted players for rebuy
    for (const rp of this.players) {
      const gp = this.game?.players.find(p => p.id === rp.id);
      if (gp) rp.chips = gp.chips;
    }
    // Only active (chips > 0) players enter the next hand — this already
    // naturally picks up anyone who joined mid-game or just rebought, since
    // it's filtered fresh from the full room roster every time, not carried
    // over from the previous hand's player list.
    const active = this.players.filter(p => p.chips > 0);
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

  restart() {
    for (const p of this.players) p.chips = STARTING_CHIPS;
    this.status = 'waiting';
    this.game = null;
    this.dealerId = this.players[0]?.id ?? null;
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
      players: this.players.map(p => ({ id: p.id, name: p.name, chips: p.chips, debt: p.debt || 0 })),
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
    room.removePlayer(playerId);
    this.playerRoom.delete(playerId);
    if (room.players.length === 0) this.rooms.delete(code);
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
