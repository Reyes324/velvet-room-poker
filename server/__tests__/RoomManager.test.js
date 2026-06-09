import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { RoomManager } = require('../RoomManager');

let rooms;

beforeEach(() => {
  rooms = new RoomManager();
});

describe('RoomManager — 创建房间', () => {
  it('返回6位大写房间码', () => {
    const room = rooms.create('p1', 'Alice');
    expect(room.code).toMatch(/^[A-Z0-9]{6}$/);
  });

  it('房间码存入 rooms Map', () => {
    const room = rooms.create('p1', 'Alice');
    expect(rooms.rooms.has(room.code)).toBe(true);
  });

  it('创建者是房主且在玩家列表中', () => {
    const room = rooms.create('p1', 'Alice');
    expect(room.hostId).toBe('p1');
    expect(room.players.find(p => p.id === 'p1')).toBeDefined();
  });
});

describe('RoomManager — 加入房间', () => {
  it('成功加入存在的房间', () => {
    const room = rooms.create('p1', 'Alice');
    const result = rooms.join(room.code, 'p2', 'Bob', 'socket2');
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.room.players).toHaveLength(2);
  });

  it('加入不存在的房间 → 返回"房间不存在"', () => {
    const result = rooms.join('NOTEXIST', 'p2', 'Bob', 'socket2');
    expect(result.error).toBe('房间不存在');
  });

  it('同一玩家重复加入 → 返回"已在房间内"', () => {
    const room = rooms.create('p1', 'Alice');
    const result = rooms.join(room.code, 'p1', 'Alice', 'socket1');
    expect(result.error).toBe('已在房间内');
  });

  it('游戏已开始时加入 → 返回错误', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    room.startGame();
    const result = rooms.join(room.code, 'p3', 'Charlie', 'socket3');
    expect(result.error).toBeDefined();
  });

  it('房间码不区分大小写', () => {
    const room = rooms.create('p1', 'Alice');
    const lower = room.code.toLowerCase();
    const result = rooms.join(lower, 'p2', 'Bob', 'socket2');
    expect(result.error).toBeUndefined();
  });
});

describe('Room — 重新开始', () => {
  it('restart 后所有玩家筹码重置为初始值', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 's2');
    room.startGame();
    // 模拟输掉一些筹码
    room.players[0].chips = 500;
    room.players[1].chips = 1500;
    room.restart();
    expect(room.players[0].chips).toBe(10000);
    expect(room.players[1].chips).toBe(10000);
  });

  it('restart 后状态回到 waiting', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 's2');
    room.startGame();
    room.restart();
    expect(room.status).toBe('waiting');
  });

  it('restart 后 game 清空为 null', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 's2');
    room.startGame();
    room.restart();
    expect(room.game).toBeNull();
  });
});

describe('RoomManager — 离开房间', () => {
  it('离开后从玩家列表移除', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    rooms.leave('p2');
    expect(room.players.find(p => p.id === 'p2')).toBeUndefined();
  });

  it('最后一个玩家离开后房间被删除', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.leave('p1');
    expect(rooms.rooms.has(room.code)).toBe(false);
  });

  it('getRoomByPlayer 离开后返回 null', () => {
    rooms.create('p1', 'Alice');
    rooms.leave('p1');
    expect(rooms.getRoomByPlayer('p1')).toBeNull();
  });
});
