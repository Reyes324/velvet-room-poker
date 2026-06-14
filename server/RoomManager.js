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
    this.players = [{ id: hostId, name: hostName, chips: STARTING_CHIPS, socketId: null }];
    this.game = null;       // GameEngine instance when in progress
    this.dealerIndex = 0;
    this.status = 'waiting'; // waiting | playing
  }

  addPlayer(id, name, socketId) {
    if (this.players.length >= 9) return { error: '房间已满，无法加入' };
    if (this.status !== 'waiting') return { error: '游戏已开始，无法加入' };
    if (this.players.find(p => p.id === id)) return { error: '已在房间内' };
    this.players.push({ id, name, chips: STARTING_CHIPS, socketId });
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
    this.game = new GameEngine(this.players, this.dealerIndex, BIG_BLIND);
    return { ok: true };
  }

  nextRound() {
    // Keep chips from last game state
    for (const rp of this.players) {
      const gp = this.game?.players.find(p => p.id === rp.id);
      if (gp) rp.chips = gp.chips;
    }
    // Remove busted players
    this.players = this.players.filter(p => p.chips > 0);
    if (this.players.length < 2) {
      this.status = 'waiting';
      this.game = null;
      return { ended: true, reason: '筹码不足，游戏结束' };
    }
    this.dealerIndex = (this.dealerIndex + 1) % this.players.length;
    this.game = new GameEngine(this.players, this.dealerIndex, BIG_BLIND);
    return { ok: true };
  }

  restart() {
    for (const p of this.players) p.chips = STARTING_CHIPS;
    this.status = 'waiting';
    this.game = null;
    this.dealerIndex = 0;
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
      players: this.players.map(p => ({ id: p.id, name: p.name, chips: p.chips })),
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
