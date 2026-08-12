import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createServer } = require('../index');
const { io: Client } = require('socket.io-client');

let server;
let url;
let rooms;
const clients = [];

function connect() {
  return new Promise((resolve, reject) => {
    const socket = Client(url, { forceNew: true });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
    clients.push(socket);
  });
}

function waitFor(socket, event, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for '${event}'`)), timeout);
    socket.once(event, (data) => { clearTimeout(t); resolve(data); });
  });
}

beforeEach(async () => {
  const created = createServer();
  server = created.server;
  rooms = created.rooms;
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  url = `http://localhost:${port}`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.disconnect();
  await new Promise((resolve) => server.close(resolve));
});

async function setupPlayingRoom() {
  const [c1, c2] = await Promise.all([connect(), connect()]);
  const joined1 = waitFor(c1, 'room:joined');
  c1.emit('room:create', { playerId: 'p1', playerName: 'Alice' });
  const { code } = await joined1;
  const roomReady = waitFor(c2, 'room:state');
  c2.emit('room:join', { code, playerId: 'p2', playerName: 'Bob' });
  await roomReady;
  const gs1 = waitFor(c1, 'game:state');
  c1.emit('room:start', { playerId: 'p1' });
  const state1 = await gs1;
  return { c1, c2, code, actingId: state1.actionPlayerId };
}

describe('打牌中断线：暂停而不是自动弃牌/踢出', () => {
  it('非行动方断线 → 仍留在 room.players 里，且被标记 connected:false', async () => {
    const { c1, c2, actingId } = await setupPlayingRoom();
    const notActingSocket = actingId === 'p1' ? c2 : c1;
    const notActingId = actingId === 'p1' ? 'p2' : 'p1';

    notActingSocket.disconnect();
    await new Promise((r) => setTimeout(r, 300));

    const room = rooms.getRoomByPlayer(actingId);
    const player = room.players.find(p => p.id === notActingId);
    expect(player).toBeDefined();
    expect(player.connected).toBe(false);
  });

  it('行动方断线 → 牌局不推进（对方看到的行动人始终未变），人仍在房间里', async () => {
    // Note: this deliberately does NOT assert "opponent receives zero
    // game:state events". broadcastRoom (called from the disconnect handler
    // to reflect the connected:false flag, and the intended future hook
    // point for Task 7's safety-timeout) unconditionally pings every
    // connected player with a fresh game:state on every call — so a status
    // ping is expected and correct. What must NOT happen is the hand
    // actually advancing: every game:state the opponent receives must still
    // show the disconnected player as the one action is waiting on.
    const { c1, c2, actingId } = await setupPlayingRoom();
    const actingSocket = actingId === 'p1' ? c1 : c2;
    const otherSocket = actingId === 'p1' ? c2 : c1;

    const receivedStates = [];
    const listener = (data) => { receivedStates.push(data); };
    otherSocket.on('game:state', listener);

    actingSocket.disconnect();
    await new Promise((r) => setTimeout(r, 500));

    otherSocket.off('game:state', listener);
    for (const state of receivedStates) {
      expect(state.actionPlayerId).toBe(actingId);
    }

    const room = rooms.getRoomByPlayer(actingId === 'p1' ? 'p2' : 'p1');
    expect(room.players.map(p => p.id)).toContain(actingId);
    expect(room.getActionPlayerId()).toBe(actingId);
  });

  it('room:sync 重连后 connected 恢复 true，且对手也能收到更新后的 room:state', async () => {
    const { c1, c2, actingId } = await setupPlayingRoom();
    const actingSocket = actingId === 'p1' ? c1 : c2;
    const otherSocket = actingId === 'p1' ? c2 : c1;

    actingSocket.disconnect();
    await new Promise((r) => setTimeout(r, 300));

    const otherSeesReconnect = waitFor(otherSocket, 'room:state');
    actingSocket.connect();
    await new Promise((resolve) => actingSocket.once('connect', resolve));
    actingSocket.emit('room:sync', { playerId: actingId });

    const stateSeenByOther = await otherSeesReconnect;
    const player = stateSeenByOther.players.find(p => p.id === actingId);
    expect(player.connected).toBe(true);
  });

});

describe('打牌中断线：回合倒计时兜底', () => {
  // 原来这里是 5 分钟的 PAUSE_TIMEOUT_MS，且只对断线玩家生效——一个在线但
  // 不动的人可以无限拖住全桌（用户反馈 #10）。现在改成对所有人一视同仁的
  // 20 秒回合倒计时，断线玩家不再需要任何特判：他按不了延时按钮，到点自然
  // 就被执行默认动作。见 design.md「行动倒计时 + 时间银行」。
  it('轮到断线玩家、到点没人处理 → 自动执行默认动作，且人仍留在座位上', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { c1, c2, actingId } = await setupPlayingRoom();
      const actingSocket = actingId === 'p1' ? c1 : c2;
      const otherSocket = actingId === 'p1' ? c2 : c1;

      actingSocket.disconnect();
      await vi.advanceTimersByTimeAsync(500); // let the disconnect land server-side

      // NOTE: deviates from the plan's literal `10000` here. Under fake
      // timers, waitFor's own internal reject-setTimeout is itself a fake
      // timer — a 10s timeout fires (in virtual time) well before the 301s
      // advanceTimersByTimeAsync below reaches the pause-timer's fire time,
      // so the test failed deterministically with `10000` regardless of
      // implementation correctness. Verified: raising this above the total
      // advance amount fixes it, with the assertions unchanged.
      const TURN_BASE_MS = 20 * 1000; // createServer 的默认值
      const advanced = waitFor(otherSocket, 'room:state', TURN_BASE_MS + 10000);
      await vi.advanceTimersByTimeAsync(TURN_BASE_MS + 1000);
      await advanced;

      const room = rooms.getRoomByPlayer(actingId === 'p1' ? 'p2' : 'p1');
      expect(room.players.map(p => p.id)).toContain(actingId); // 断线不等于离座
      // 默认动作确实执行了：要么行动权转走，要么这手已经因弃牌结束。只断言
      // "人还在座位上"是不够的——那在超时逻辑完全失效时同样成立。
      expect(room.isAwaitingSettlementAck() || room.getActionPlayerId() !== actingId).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('5 分钟内玩家重连 → 不会被自动弃牌', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { c1, c2, actingId } = await setupPlayingRoom();
      const actingSocket = actingId === 'p1' ? c1 : c2;

      actingSocket.disconnect();
      await vi.advanceTimersByTimeAsync(500);
      actingSocket.connect();
      await new Promise((resolve) => actingSocket.once('connect', resolve));
      actingSocket.emit('room:sync', { playerId: actingId });
      await vi.advanceTimersByTimeAsync(500);

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000);

      const room = rooms.getRoomByPlayer(actingId === 'p1' ? 'p2' : 'p1');
      expect(room.getActionPlayerId()).toBe(actingId); // still their turn, not auto-folded
    } finally {
      vi.useRealTimers();
    }
  });
});
