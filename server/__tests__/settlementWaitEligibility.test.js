// 讨论"结算是否该要求所有人点确认"时发现的疑似缺陷：结算等待名单用
// `p.socketId` 筛人，而 socketId 按设计"永不清除"（见 RoomManager
// setConnected 上方的注释），leave() 也只是把 left 置 true。所以一个已经
// 退出房间的人可能仍被算作"需要点确认的人"，而他永远不会再点。
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { RoomManager } = require('../RoomManager');

function threeHandedRoom() {
  const rooms = new RoomManager();
  const room = rooms.create('p1', 'Alice');
  room.updateSocket('p1', 'sock-1');
  room.addPlayer('p2', 'Bob', 'sock-2');
  room.addPlayer('p3', 'Carol', 'sock-3');
  return room;
}

describe('结算等待名单的构成', () => {
  it('已退出房间的玩家不应被计入结算等待名单', () => {
    const room = threeHandedRoom();

    // Bob 点了"退出房间"。leave() 只置 left=true，socketId 保留不清。
    room.markLeft('p2');
    expect(room.players.find(p => p.id === 'p2').left).toBe(true);

    room.beginSettlementWait();

    expect([...room.settlementWait.eligiblePlayerIds]).not.toContain('p2');
  });

  it('已退出的玩家被计入时，其余人全点确认也无法推进（卡住的机制）', () => {
    const room = threeHandedRoom();
    room.markLeft('p2');

    room.beginSettlementWait();
    room.ackReady('p1');
    const allAcksIn = room.ackReady('p3');

    // 在场的两个人都点了确认 → 本该可以推进到下一手
    expect(allAcksIn).toBe(true);
  });
});
