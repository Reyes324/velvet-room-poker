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

  it('同一玩家重复加入（仍在线）→ 返回"已在房间内"', () => {
    const room = rooms.create('p1', 'Alice');
    const result = rooms.join(room.code, 'p1', 'Alice', 'socket1');
    expect(result.error).toBe('已在房间内');
  });

  it('同一 playerId 掉线后（未主动离开）用同一昵称重新加入 → 恢复身份，不报"已在房间内"', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    room.setConnected('p2', false); // 掉线，但从未 leave，left 仍是 false
    const result = rooms.join(room.code, 'p2', 'Bob', 'socket3');
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.room.players).toHaveLength(2); // 恢复原有行，不是新增一行
    const p2 = result.room.players.find(p => p.id === 'p2');
    expect(p2.connected).toBe(true);
    expect(p2.left).toBe(false);
  });

  it('游戏已开始时加入 → 允许加入，1000筹码，但不进入当前这一手', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    room.startGame();
    const result = rooms.join(room.code, 'p3', 'Charlie', 'socket3');
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(room.players.find(p => p.id === 'p3')).toMatchObject({ chips: 1000, debt: 0 });
    // 不在当前正在进行的这一手里
    expect(room.game.players.find(p => p.id === 'p3')).toBeUndefined();
  });

  it('中途加入的玩家从下一手开始自动生效', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    room.startGame();
    rooms.join(room.code, 'p3', 'Charlie', 'socket3');
    room.game.players.forEach(p => { p.chips = 1000; });

    room.nextRound();

    expect(room.game.players.map(p => p.id).sort()).toEqual(['p1', 'p2', 'p3']);
  });

  it('房间码不区分大小写', () => {
    const room = rooms.create('p1', 'Alice');
    const lower = room.code.toLowerCase();
    const result = rooms.join(lower, 'p2', 'Bob', 'socket2');
    expect(result.error).toBeUndefined();
  });

  it('同一 playerId 退出后重新加入 → 恢复原有身份（不是被拒绝，也不是新增一行）', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    room.players.find(p => p.id === 'p2').chips = 730; // simulate mid-session chips
    room.players.find(p => p.id === 'p2').debt = 1000;
    rooms.leave('p2');
    expect(room.players.find(p => p.id === 'p2').left).toBe(true);

    const result = rooms.join(room.code, 'p2', 'Bob', 'socket2-new');
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(room.players).toHaveLength(2); // reactivated, not a new row
    const rejoined = room.players.find(p => p.id === 'p2');
    expect(rejoined.left).toBe(false);
    expect(rejoined.connected).toBe(true);
    expect(rejoined.socketId).toBe('socket2-new');
    expect(rejoined.chips).toBe(730); // chips/debt survive the reactivation
    expect(rejoined.debt).toBe(1000);
    expect(rooms.getRoomByPlayer('p2')).toBe(room); // playerRoom mapping restored
  });

  it('房间已满时，仍允许已离开的玩家用同一 playerId 复位（不占用新座位）', () => {
    const room = rooms.create('p1', 'Alice');
    for (let i = 2; i <= 9; i++) rooms.join(room.code, `p${i}`, `Player${i}`, `socket${i}`);
    expect(room.players).toHaveLength(9);
    rooms.leave('p9');

    const result = rooms.join(room.code, 'p9', 'Player9', 'socket9-new');
    expect(result.error).toBeUndefined();
    expect(room.players).toHaveLength(9);
  });

  it('真正的新玩家在房间已满时仍被拒绝加入', () => {
    const room = rooms.create('p1', 'Alice');
    for (let i = 2; i <= 9; i++) rooms.join(room.code, `p${i}`, `Player${i}`, `socket${i}`);
    const result = rooms.join(room.code, 'p10', 'Newcomer', 'socket10');
    expect(result.error).toBe('房间已满，无法加入');
  });

  it('不同 playerId + 同昵称，旧身份当前离线 → 按昵称复用旧身份（不是新增玩家）', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    room.players.find(p => p.id === 'p2').chips = 650;
    room.setConnected('p2', false); // e.g. WeChat browser closed/lost connection

    // A different browser/app — brand-new playerId, same typed name.
    const result = rooms.join(room.code, 'p2-new-device', 'Bob', 'socket2-fresh');

    expect(result.error).toBeUndefined();
    expect(result.playerId).toBe('p2'); // reclaimed the OLD identity, not p2-new-device
    expect(room.players).toHaveLength(2); // reactivated the row, didn't add a 3rd
    const reclaimed = room.players.find(p => p.id === 'p2');
    expect(reclaimed.connected).toBe(true);
    expect(reclaimed.chips).toBe(650); // chip history carried over
    expect(reclaimed.socketId).toBe('socket2-fresh');
    expect(rooms.getRoomByPlayer('p2-new-device')).toBeNull(); // the sent-in id never became a real identity
    expect(rooms.getRoomByPlayer('p2')).toBe(room);
  });

  it('不同 playerId + 同昵称，但旧身份当前仍在线 → 不复用，两个身份并存（后来者进不去）', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2'); // p2 stays connected (default true)

    const result = rooms.join(room.code, 'p2-second-device', 'Bob', 'socket2-second');

    expect(result.error).toBeUndefined();
    expect(result.playerId).toBe('p2-second-device'); // did NOT reclaim the online p2
    expect(room.players).toHaveLength(3); // p1, p2 (still online), p2-second-device (new)
    expect(room.players.find(p => p.id === 'p2').connected).toBe(true);
    expect(room.players.find(p => p.id === 'p2').socketId).toBe('socket2'); // untouched
  });

  it('两个不同的人先后用同一昵称加入，都不匹配任何离线记录 → 都是独立的新玩家', () => {
    const room = rooms.create('p1', 'Alice');
    const r1 = rooms.join(room.code, 'pA', 'Chris', 'socketA');
    const r2 = rooms.join(room.code, 'pB', 'Chris', 'socketB');

    expect(r1.playerId).toBe('pA');
    expect(r2.playerId).toBe('pB');
    expect(room.players).toHaveLength(3);
  });
});

describe('RoomManager — 闲置房间自动清理（sweepIdleRooms）', () => {
  it('全员断线/离开且超过 ttl 未活动 → 房间被清理', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    room.setConnected('p1', false);
    room.setConnected('p2', false);
    room.lastActivityAt = Date.now() - 1000; // "13 小时前"（相对 ttl=1000ms 而言足够旧）

    rooms.sweepIdleRooms(500);

    expect(rooms.rooms.has(room.code)).toBe(false);
    expect(rooms.getRoomByPlayer('p1')).toBeNull();
    expect(rooms.getRoomByPlayer('p2')).toBeNull();
  });

  it('全员断线但未超过 ttl → 不清理', () => {
    const room = rooms.create('p1', 'Alice');
    room.setConnected('p1', false);
    room.lastActivityAt = Date.now();

    rooms.sweepIdleRooms(60_000);

    expect(rooms.rooms.has(room.code)).toBe(true);
  });

  it('有玩家仍连接 → 不管多久没活动都不清理', () => {
    const room = rooms.create('p1', 'Alice');
    room.lastActivityAt = Date.now() - 1000;

    rooms.sweepIdleRooms(500);

    expect(rooms.rooms.has(room.code)).toBe(true);
  });

  it('touch() 会更新 lastActivityAt', () => {
    const room = rooms.create('p1', 'Alice');
    room.lastActivityAt = 0;
    room.touch();
    expect(room.lastActivityAt).toBeGreaterThan(0);
  });
});

describe('RoomManager — 连接状态', () => {
  it('新创建/新加入的玩家默认 connected 为 true', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    expect(room.players.find(p => p.id === 'p1').connected).toBe(true);
    expect(room.players.find(p => p.id === 'p2').connected).toBe(true);
  });

  it('setConnected(false) 标记玩家为断线，不影响其他字段', () => {
    const room = rooms.create('p1', 'Alice');
    room.setConnected('p1', false);
    const p = room.players.find(p => p.id === 'p1');
    expect(p.connected).toBe(false);
    expect(p.chips).toBe(1000);
  });

  it('setConnected(true) 能把断线状态改回来', () => {
    const room = rooms.create('p1', 'Alice');
    room.setConnected('p1', false);
    room.setConnected('p1', true);
    expect(room.players.find(p => p.id === 'p1').connected).toBe(true);
  });

  it('setConnected 对不存在的 playerId 静默忽略', () => {
    const room = rooms.create('p1', 'Alice');
    expect(() => room.setConnected('nope', false)).not.toThrow();
  });

  it('getLobbyState() 的 players 里带上 connected 字段', () => {
    const room = rooms.create('p1', 'Alice');
    room.setConnected('p1', false);
    const state = room.getLobbyState();
    expect(state.players.find(p => p.id === 'p1').connected).toBe(false);
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

describe('Room — 计时游戏（startGame durationMinutes）', () => {
  it('不传 durationMinutes（普通"开始游戏"）→ gameTimerEndsAt 为 null，不限时', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 's2');
    room.startGame();
    expect(room.gameTimerEndsAt).toBeNull();
  });

  it('传 durationMinutes → gameTimerEndsAt 设为当前时间 + 对应分钟数', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 's2');
    const before = Date.now();
    room.startGame(30);
    const after = Date.now();
    expect(room.gameTimerEndsAt).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(room.gameTimerEndsAt).toBeLessThanOrEqual(after + 30 * 60_000);
  });

  it('restart 清空计时相关字段', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 's2');
    room.startGame(15);
    room.awaitingTimerDecision = true;
    room.restart();
    expect(room.gameTimerEndsAt).toBeNull();
    expect(room.awaitingTimerDecision).toBe(false);
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

  it('多次归零、多次借入，欠款累计', () => {
    const room = rooms.create('p1', 'Alice');
    room.players[0].chips = 0;
    room.rebuy('p1');
    room.players[0].chips = 0; // 模拟借回来的这一底又输光了
    room.rebuy('p1');
    expect(room.players[0].chips).toBe(1000);
    expect(room.players[0].debt).toBe(2000);
  });

  it('筹码充足时不能借入（无论房间处于什么状态）', () => {
    const room = rooms.create('p1', 'Alice');
    const result = room.rebuy('p1');
    expect(result.error).toBeDefined();
    expect(room.players[0].chips).toBe(1000);
  });

  it('游戏进行中，本人筹码归零时可以借入，不影响其他人', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 's2');
    room.startGame();
    room.players.find(p => p.id === 'p1').chips = 0;

    const result = room.rebuy('p1');

    expect(result.ok).toBe(true);
    expect(room.players.find(p => p.id === 'p1').chips).toBe(1000);
    expect(room.players.find(p => p.id === 'p1').debt).toBe(1000);
    expect(room.status).toBe('playing'); // 其他人不受影响，房间没有掉回 waiting
  });

  it('不存在的玩家借入 → 返回错误', () => {
    const room = rooms.create('p1', 'Alice');
    const result = room.rebuy('nobody');
    expect(result.error).toBeDefined();
  });
});

describe('Room — 旁观留下 (spectate)', () => {
  it('归零后可以选择旁观留下，标记 bustResolved', () => {
    const room = rooms.create('p1', 'Alice');
    room.players[0].chips = 0;
    const result = room.spectate('p1');
    expect(result.ok).toBe(true);
    expect(room.players[0].bustResolved).toBe(true);
    expect(room.players[0].chips).toBe(0); // 不加筹码，跟借一底不同
    expect(room.players[0].left).toBe(false); // 不退出，跟离开不同
  });

  it('筹码充足时不能选择旁观留下', () => {
    const room = rooms.create('p1', 'Alice');
    const result = room.spectate('p1');
    expect(result.error).toBeDefined();
    expect(room.players[0].bustResolved).toBeFalsy();
  });

  it('不存在的玩家旁观留下 → 返回错误', () => {
    const room = rooms.create('p1', 'Alice');
    const result = room.spectate('nobody');
    expect(result.error).toBeDefined();
  });

  it('旁观留下的人不进入下一手，但不影响其他人继续（三人局）', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 's2');
    rooms.join(room.code, 'p3', 'Charlie', 's3');
    room.startGame();
    room.game.players.find(p => p.id === 'p2').chips = 0;
    room.game.players.find(p => p.id === 'p1').chips = 1500;
    room.game.players.find(p => p.id === 'p3').chips = 1500;
    room.syncChipsFromGame();

    room.spectate('p2');
    const result = room.nextRound();

    expect(result.ended).toBeUndefined();
    expect(room.status).toBe('playing');
    expect(room.game.players.map(p => p.id).sort()).toEqual(['p1', 'p3']);
    // p2 还在房间里，旁观，且没有被强制退出
    const p2 = room.players.find(p => p.id === 'p2');
    expect(p2.chips).toBe(0);
    expect(p2.left).toBe(false);
    expect(p2.bustResolved).toBe(true);
  });

  it('再次归零时，之前的旁观决定被重置——不会延续到下一次归零', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 's2');
    room.startGame();
    room.game.players.find(p => p.id === 'p2').chips = 0;
    room.game.players.find(p => p.id === 'p1').chips = 2000;
    room.syncChipsFromGame();
    room.spectate('p2');
    expect(room.players.find(p => p.id === 'p2').bustResolved).toBe(true);

    // 借一底回来，再打光一次
    room.rebuy('p2');
    room.game.players.find(p => p.id === 'p2').chips = 1000; // rebuy 已经写回引擎副本，这里对齐一下方便下一步归零
    room.game.players.find(p => p.id === 'p2').chips = 0;
    room.syncChipsFromGame();

    // 新的这次归零，不该沿用上一次"旁观留下"的决定
    expect(room.players.find(p => p.id === 'p2').bustResolved).toBe(false);
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

describe('Room — 庄位轮转（dealerId）', () => {
  it('庄家仍在场时，庄位顺延到下一个座位', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 's2');
    rooms.join(room.code, 'p3', 'Charlie', 's3');
    room.startGame(); // dealerId = p1 (players[0])
    room.game.players.forEach(p => { p.chips = 1000; });

    room.nextRound();

    expect(room.dealerId).toBe('p2');
    expect(room.game.players[room.game.dealerIndex].id).toBe('p2');
  });

  it('上一手庄家归零离场后，庄位退回座位0，而不是崩溃或跳到无关位置', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 's2');
    rooms.join(room.code, 'p3', 'Charlie', 's3');
    room.startGame(); // dealerId = p1
    room.game.players.find(p => p.id === 'p1').chips = 0; // 庄家本手输光
    room.game.players.find(p => p.id === 'p2').chips = 1500;
    room.game.players.find(p => p.id === 'p3').chips = 1500;

    room.nextRound();

    expect(room.game.players.map(p => p.id).sort()).toEqual(['p2', 'p3']);
    expect(room.dealerId).toBe(room.game.players[room.game.dealerIndex].id);
    expect(['p2', 'p3']).toContain(room.dealerId);
  });

  it('中途加入的玩家不会打乱已在场玩家的庄位顺延', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 's2');
    room.startGame(); // dealerId = p1
    rooms.join(room.code, 'p3', 'Charlie', 's3'); // 中途加入
    room.game.players.forEach(p => { p.chips = 1000; });

    room.nextRound();

    // 庄位仍然是"p1之后的下一个"，不受新加入的p3影响
    expect(room.dealerId).toBe('p2');
  });
});

describe('Room — getLobbyState', () => {
  it('返回 startingChips 常量供客户端账本视图使用', () => {
    const room = rooms.create('p1', 'Alice');
    expect(room.getLobbyState().startingChips).toBe(1000);
  });
});

describe('RoomManager — 离开房间', () => {
  it('离开后标记 left，但仍留在玩家列表里（账本要留存最终数字）', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    rooms.leave('p2');
    const p2 = room.players.find(p => p.id === 'p2');
    expect(p2).toBeDefined();
    expect(p2.left).toBe(true);
  });

  it('所有玩家都离开后房间被删除', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.leave('p1');
    expect(rooms.rooms.has(room.code)).toBe(false);
  });

  it('getRoomByPlayer 离开后返回 null', () => {
    rooms.create('p1', 'Alice');
    rooms.leave('p1');
    expect(rooms.getRoomByPlayer('p1')).toBeNull();
  });

  it('离开的玩家不计入 startGame 的人数门槛', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 's2');
    rooms.join(room.code, 'p3', 'Charlie', 's3');
    rooms.leave('p3');
    const result = room.startGame();
    expect(result.error).toBeUndefined();
    expect(room.game.players).toHaveLength(2);
  });

  it('房主离开后，房主身份转移给下一个仍在场（未离开）的玩家', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 's2');
    rooms.leave('p1');
    expect(room.hostId).toBe('p2');
  });
});

describe('Room — 结算等待期（settlementWait）', () => {
  function setupTwoConnectedPlayers() {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 's2');
    room.updateSocket('p1', 's1');
    room.updateSocket('p2', 's2');
    // beginSettlementWait 生产环境里永远是摊牌之后才调用，这时 this.game
    // 一定有值（eligiblePlayerIds 要跟这一手实际发牌的名单取交集，见其
    // 上方注释）——这里真实开一局，让测试环境跟生产的调用时机对齐，不是
    // 凭空造一个"没有进行中游戏"的场景。
    room.startGame();
    return room;
  }

  it('beginSettlementWait 后 isAwaitingSettlementAck 为 true，只包含有 socketId 且被发进这一手的玩家', () => {
    const room = setupTwoConnectedPlayers();
    // p3 加入但从未连上 socket、也没被发进这一手（模拟手牌进行中途才加入的旁观新玩家）
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

describe('RoomManager — 拍一拍', () => {
  it('成功拍一拍返回 ok', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    const result = room.poke('p1', 'p2');
    expect(result.ok).toBe(true);
  });

  it('不能拍自己', () => {
    const room = rooms.create('p1', 'Alice');
    const result = room.poke('p1', 'p1');
    expect(result.error).toBe('不能拍自己');
  });

  it('2 秒冷却内重复拍同一人 → 静默忽略（不报错，GitHub #19：去掉过于频繁的提示）', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    expect(room.poke('p1', 'p2').ok).toBe(true);
    const second = room.poke('p1', 'p2');
    expect(second.ignored).toBe(true);
    expect(second.error).toBeUndefined();
  });

  it('冷却只按 fromId→targetId 这一对生效，不影响拍别人', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    rooms.join(room.code, 'p3', 'Carol', 'socket3');
    expect(room.poke('p1', 'p2').ok).toBe(true);
    expect(room.poke('p1', 'p3').ok).toBe(true);
  });

  it('冷却过期后可以再次拍同一人', async () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    expect(room.poke('p1', 'p2').ok).toBe(true);
    room.pokeCooldowns.set('p1→p2', Date.now() - 3000); // simulate 3s elapsed
    expect(room.poke('p1', 'p2').ok).toBe(true);
  });
});

describe('RoomManager — 被扔鸡蛋计数（用户反馈，2026-08-14："底部能否加上谁被扔鸡蛋多少次，只需要显示最多次数的那个"）', () => {
  it('recordEggPoke 累加同一个目标的次数', () => {
    const room = rooms.create('p1', 'Alice');
    room.recordEggPoke('p2');
    room.recordEggPoke('p2');
    room.recordEggPoke('p3');
    expect(room.eggCounts.get('p2')).toBe(2);
    expect(room.eggCounts.get('p3')).toBe(1);
  });

  it('getLobbyState 里的 eggCounts 是一个可序列化的普通对象', () => {
    const room = rooms.create('p1', 'Alice');
    room.recordEggPoke('p2');
    expect(room.getLobbyState().eggCounts).toEqual({ p2: 1 });
  });

  it('restart 清空 eggCounts（跟 chips/debt/handHistory 一样，属于"开新的一晚"要清的东西）', () => {
    const room = rooms.create('p1', 'Alice');
    room.recordEggPoke('p2');
    room.restart();
    expect(room.eggCounts.size).toBe(0);
  });
});

describe('RoomManager — nextRound 不再因断线跳过玩家（Bug C 修复）', () => {
  it('断线的玩家筹码 > 0 时仍会被正常发进下一手（断线不等于淘汰）', () => {
    const rooms2 = new RoomManager();
    const room = rooms2.create('p1', 'Alice');
    rooms2.join(room.code, 'p2', 'Bob', 'socket2');
    rooms2.join(room.code, 'p3', 'Carol', 'socket3');
    room.startGame();
    room.setConnected('p2', false);
    const result = room.nextRound();
    expect(result.ok).toBe(true);
    const dealtIds = room.game.players.map(p => p.id);
    expect(dealtIds).toEqual(expect.arrayContaining(['p1', 'p2', 'p3']));
  });

  it('三人局中 2 人同时断线（都还有筹码）→ 游戏不会被误判"筹码不足"提前结束', () => {
    const rooms2 = new RoomManager();
    const room = rooms2.create('p1', 'Alice');
    rooms2.join(room.code, 'p2', 'Bob', 'socket2');
    rooms2.join(room.code, 'p3', 'Carol', 'socket3');
    room.startGame();
    // Simulates two phones' PWAs both flickering offline at the exact
    // moment a hand ends (screen lock / backgrounding) — the real-world
    // scenario reported as "每次弃牌就被弹回大厅，提示筹码不足".
    room.setConnected('p1', false);
    room.setConnected('p3', false);
    const result = room.nextRound();
    expect(result.ok).toBe(true);
    expect(result.ended).toBeUndefined();
    expect(room.status).toBe('playing');
    const dealtIds = room.game.players.map(p => p.id);
    expect(dealtIds).toEqual(expect.arrayContaining(['p1', 'p2', 'p3']));
  });

  it('筹码真的归零（不是断线）时，人数不足依然正确结束', () => {
    const rooms2 = new RoomManager();
    const room = rooms2.create('p1', 'Alice');
    rooms2.join(room.code, 'p2', 'Bob', 'socket2');
    room.startGame();
    // nextRound() syncs room.players' chips FROM room.game.players — mutate
    // the game engine's own copy, same pattern as the existing "筹码归零处理"
    // test block above.
    room.game.players.find(p => p.id === 'p2').chips = 0;
    const result = room.nextRound();
    expect(result.ended).toBe(true);
    expect(result.reason).toBe('筹码不足，等待玩家买入后重新开始');
    expect(room.status).toBe('waiting');
  });

  it('主动离开（left）的玩家依然被排除在外，即使筹码 > 0', () => {
    const rooms2 = new RoomManager();
    const room = rooms2.create('p1', 'Alice');
    rooms2.join(room.code, 'p2', 'Bob', 'socket2');
    rooms2.join(room.code, 'p3', 'Carol', 'socket3');
    room.startGame();
    room.markLeft('p3');
    const result = room.nextRound();
    expect(result.ok).toBe(true);
    const dealtIds = room.game.players.map(p => p.id);
    expect(dealtIds).not.toContain('p3');
    expect(dealtIds).toEqual(expect.arrayContaining(['p1', 'p2']));
  });
});

describe('RoomManager — 断线玩家的行动兜底', () => {
  function setupPlayingRoom() {
    const rooms2 = new RoomManager();
    const room = rooms2.create('p1', 'Alice');
    rooms2.join(room.code, 'p2', 'Bob', 'socket2');
    room.startGame();
    return room;
  }

  it('getActionPlayerId 返回当前该行动的玩家 id', () => {
    const room = setupPlayingRoom();
    const id = room.getActionPlayerId();
    expect(['p1', 'p2']).toContain(id);
  });

  it('getActionPlayerId 在没有牌局时返回 null', () => {
    const rooms2 = new RoomManager();
    const room = rooms2.create('p1', 'Alice');
    expect(room.getActionPlayerId()).toBeNull();
  });

});

describe('RoomManager — 暂停期间拒绝行动', () => {
  it('paused=true 时 playerAction 返回错误，不改变牌局状态', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    room.startGame();
    const actorId = room.getActionPlayerId();

    room.paused = true;
    const result = room.playerAction(actorId, 'fold');

    expect(result.error).toBe('已暂停');
    // 牌局没有真的翻掉——行动方还是原来那个人。
    expect(room.getActionPlayerId()).toBe(actorId);
  });

  it('paused=false（默认）时 playerAction 正常放行', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    room.startGame();
    expect(room.paused).toBe(false);

    const actorId = room.getActionPlayerId();
    const result = room.playerAction(actorId, 'fold');
    expect(result.error).toBeUndefined();
  });

  it('getLobbyState() 暴露 paused 字段', () => {
    const room = rooms.create('p1', 'Alice');
    expect(room.getLobbyState().paused).toBe(false);
    room.paused = true;
    expect(room.getLobbyState().paused).toBe(true);
  });
});

describe('RoomManager — 断线跨手自动离座', () => {
  it('本手中途才断线：这一手不受影响，仍正常参与', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    rooms.join(room.code, 'p3', 'Carol', 'socket3');
    room.startGame(); // p2 此时仍在线
    room.setConnected('p2', false); // 本手打到一半才掉线
    const result = room.nextRound();
    expect(result.ok).toBe(true);
    const dealtIds = room.game.players.map(p => p.id);
    expect(dealtIds).toEqual(expect.arrayContaining(['p1', 'p2', 'p3']));
    expect(room.players.find(p => p.id === 'p2').left).toBe(false);
  });

  it('开局时就已断线、断线持续超过阈值、下一手仍未恢复 → 被移出牌桌（markLeft），账本记录保留', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    rooms.join(room.code, 'p3', 'Carol', 'socket3');
    room.setConnected('p2', false);
    room.startGame(); // p2 在开局这一刻就已经断线 → 这一手打完后触发离座判定
    room.players.find(p => p.id === 'p2').disconnectedAt = Date.now() - 61_000; // 断线已持续超过 60 秒阈值
    room.nextRound(); // 进入第二手：p2 仍断线且已超阈值，触发 markLeft
    expect(room.players.find(p => p.id === 'p2').left).toBe(true);
    expect(room.players.find(p => p.id === 'p2').chips).toBeGreaterThanOrEqual(0); // 账本没被清
    const dealtIds = room.game.players.map(p => p.id);
    expect(dealtIds).not.toContain('p2');
    expect(dealtIds).toEqual(expect.arrayContaining(['p1', 'p3']));
  });

  it('开局时断线，但在下一手开始前重新连接 → 不会被移出', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    rooms.join(room.code, 'p3', 'Carol', 'socket3');
    room.setConnected('p2', false);
    room.startGame();
    room.setConnected('p2', true); // 断线闪断后自己重连回来了
    room.nextRound();
    expect(room.players.find(p => p.id === 'p2').left).toBe(false);
    const dealtIds = room.game.players.map(p => p.id);
    expect(dealtIds).toContain('p2');
  });

  it('被移出后重新加入房间（addPlayer 走 left 重置逻辑）→ 能重新回到牌桌', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    rooms.join(room.code, 'p3', 'Carol', 'socket3');
    room.setConnected('p2', false);
    room.startGame();
    room.players.find(p => p.id === 'p2').disconnectedAt = Date.now() - 61_000;
    room.nextRound(); // p2 被移出
    expect(room.players.find(p => p.id === 'p2').left).toBe(true);

    room.addPlayer('p2', 'Bob', 'socket2-new'); // 重连
    expect(room.players.find(p => p.id === 'p2').left).toBe(false);
    expect(room.players.find(p => p.id === 'p2').connected).toBe(true);

    room.nextRound(); // 下一手正常把他重新发进去
    const dealtIds = room.game.players.map(p => p.id);
    expect(dealtIds).toContain('p2');
  });

  it('三人局中两人同时在开局时就断线、下一手都未恢复 → 不会一次性都被移出（保底：不能让剩余人数掉到2人以下），沿用"断线不影响发牌"的旧逻辑', () => {
    // 同一个房间的人常常共享网络（同一路由器），两人同时断线不一定是两人
    // 都真的走了，可能是一次共享的网络抖动跨越了整手边界——跟 Bug C 想防
    // 的"不能让掉线状态单方面判游戏结束"是同一类风险，所以这里保底不离座。
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    rooms.join(room.code, 'p3', 'Carol', 'socket3');
    room.setConnected('p2', false);
    room.setConnected('p3', false);
    room.startGame();
    room.players.find(p => p.id === 'p2').disconnectedAt = Date.now() - 61_000;
    room.players.find(p => p.id === 'p3').disconnectedAt = Date.now() - 61_000;
    const result = room.nextRound();
    expect(room.players.find(p => p.id === 'p2').left).toBe(false);
    expect(room.players.find(p => p.id === 'p3').left).toBe(false);
    expect(result.ok).toBe(true);
    expect(room.status).toBe('playing');
    const dealtIds = room.game.players.map(p => p.id);
    expect(dealtIds).toEqual(expect.arrayContaining(['p1', 'p2', 'p3']));
  });

  it('三人局中只有一人开局时就断线、下一手仍未恢复 → 正常单独移出（剩 2 人不受保底限制）', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    rooms.join(room.code, 'p3', 'Carol', 'socket3');
    room.setConnected('p2', false);
    room.startGame();
    room.players.find(p => p.id === 'p2').disconnectedAt = Date.now() - 61_000;
    room.nextRound();
    expect(room.players.find(p => p.id === 'p2').left).toBe(true);
    const dealtIds = room.game.players.map(p => p.id);
    expect(dealtIds).toEqual(expect.arrayContaining(['p1', 'p3']));
  });

  it('断线未超过阈值（比如刚断线几秒）→ 不会被移出，哪怕跨过了手牌边界', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    rooms.join(room.code, 'p3', 'Carol', 'socket3');
    room.startGame();
    room.setConnected('p2', false); // disconnectedAt 刚设成 Date.now()，远没到 60 秒
    room.nextRound();
    expect(room.players.find(p => p.id === 'p2').left).toBe(false);
    const dealtIds = room.game.players.map(p => p.id);
    expect(dealtIds).toContain('p2');
  });
});
