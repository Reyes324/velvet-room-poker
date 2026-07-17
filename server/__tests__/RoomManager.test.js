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
    expect(room.players[0].chips).toBe(1000);
    expect(room.players[1].chips).toBe(1000);
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

describe('Room — 借一底 (rebuy)', () => {
  it('等待阶段可借入初始筹码并累计欠款', () => {
    const room = rooms.create('p1', 'Alice');
    room.players[0].chips = 0;
    const result = room.rebuy('p1');
    expect(result.ok).toBe(true);
    expect(room.players[0].chips).toBe(1000);
    expect(room.players[0].debt).toBe(1000);
  });

  it('多次借入累计欠款', () => {
    const room = rooms.create('p1', 'Alice');
    room.players[0].chips = 0;
    room.rebuy('p1');
    room.rebuy('p1');
    expect(room.players[0].chips).toBe(2000);
    expect(room.players[0].debt).toBe(2000);
  });

  it('游戏进行中不能借入', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 's2');
    room.startGame();
    const result = room.rebuy('p1');
    expect(result.error).toBeDefined();
  });

  it('不存在的玩家借入 → 返回错误', () => {
    const room = rooms.create('p1', 'Alice');
    const result = room.rebuy('nobody');
    expect(result.error).toBeDefined();
  });
});

describe('Room — nextRound 筹码归零处理', () => {
  it('筹码归零的玩家不进入下一手，但仍留在房间里', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 's2');
    rooms.join(room.code, 'p3', 'Charlie', 's3');
    room.startGame();
    // 模拟 p2 本局输光
    room.game.players.find(p => p.id === 'p2').chips = 0;
    room.game.players.find(p => p.id === 'p1').chips = 1500;
    room.game.players.find(p => p.id === 'p3').chips = 1500;

    const result = room.nextRound();

    expect(result.ended).toBeUndefined();
    expect(room.status).toBe('playing');
    // p2 筹码同步为0，但仍在房间玩家列表中（可借一底）
    expect(room.players.find(p => p.id === 'p2').chips).toBe(0);
    expect(room.players.find(p => p.id === 'p2')).toBeDefined();
    // 新一手的游戏引擎里只有筹码>0的两人
    expect(room.game.players.map(p => p.id).sort()).toEqual(['p1', 'p3']);
  });

  it('少于2人有筹码时游戏结束，回到等待阶段', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 's2');
    room.startGame();
    room.game.players.find(p => p.id === 'p2').chips = 0;
    room.game.players.find(p => p.id === 'p1').chips = 2000;

    const result = room.nextRound();

    expect(result.ended).toBe(true);
    expect(room.status).toBe('waiting');
    expect(room.game).toBeNull();
    // 筹码同步依然发生，p2 显示为0，可借一底后重开
    expect(room.players.find(p => p.id === 'p2').chips).toBe(0);
  });

  it('借一底后归零玩家可重新加入下一手', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 's2');
    room.startGame();
    room.game.players.find(p => p.id === 'p2').chips = 0;
    room.game.players.find(p => p.id === 'p1').chips = 2000;
    room.nextRound(); // 游戏结束，回到 waiting

    room.rebuy('p2');
    expect(room.players.find(p => p.id === 'p2').chips).toBe(1000);

    const startResult = room.startGame();
    expect(startResult.error).toBeUndefined();
    expect(room.game.players).toHaveLength(2);
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

describe('Room — 结算等待期（settlementWait）', () => {
  function setupTwoConnectedPlayers() {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 's2');
    room.updateSocket('p1', 's1');
    room.updateSocket('p2', 's2');
    return room;
  }

  it('beginSettlementWait 后 isAwaitingSettlementAck 为 true，只包含有 socketId 的玩家', () => {
    const room = setupTwoConnectedPlayers();
    // p3 加入但从未连上 socket（socketId 仍是 join 时传入的值，这里模拟未连接）
    room.players.push({ id: 'p3', name: 'Charlie', chips: 1000, socketId: null, debt: 0 });

    expect(room.isAwaitingSettlementAck()).toBe(false);
    room.beginSettlementWait();
    expect(room.isAwaitingSettlementAck()).toBe(true);
    expect(room.settlementWait.eligiblePlayerIds).toEqual(new Set(['p1', 'p2']));
    expect(room.settlementWait.readyPlayerIds.size).toBe(0);
  });

  it('ackReady：只有全部符合条件的玩家都确认后才返回 true', () => {
    const room = setupTwoConnectedPlayers();
    room.beginSettlementWait();

    expect(room.ackReady('p1')).toBe(false); // p2 还没确认
    expect(room.ackReady('p2')).toBe(true);  // 两人都确认了
  });

  it('ackReady：没有进行中的结算等待时返回 false，不报错', () => {
    const room = setupTwoConnectedPlayers();
    expect(room.ackReady('p1')).toBe(false);
  });

  it('dropFromSettlementWait：移除一个待确认玩家后，剩余玩家确认即可推进', () => {
    const room = setupTwoConnectedPlayers();
    room.beginSettlementWait();

    // p2 断线离开等待名单，只剩 p1 需要确认
    expect(room.dropFromSettlementWait('p2')).toBe(false); // p1 还没确认
    expect(room.ackReady('p1')).toBe(true);
  });

  it('clearSettlementWait 后 isAwaitingSettlementAck 变回 false', () => {
    const room = setupTwoConnectedPlayers();
    room.beginSettlementWait();
    room.clearSettlementWait();
    expect(room.isAwaitingSettlementAck()).toBe(false);
    expect(room.settlementWait).toBeNull();
  });
});
