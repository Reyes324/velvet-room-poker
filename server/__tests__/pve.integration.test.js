import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createServer } = require('../index');
const { io: Client } = require('socket.io-client');

let server;
let url;
const clients = [];

function connect() {
  return new Promise((resolve, reject) => {
    const socket = Client(url, { forceNew: true });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
    clients.push(socket);
  });
}

function waitFor(socket, event, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for '${event}'`)), timeout);
    socket.once(event, (data) => { clearTimeout(t); resolve(data); });
  });
}

beforeEach(async () => {
  const created = createServer();
  server = created.server;
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  url = `http://localhost:${port}`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.disconnect();
  await new Promise((resolve) => server.close(resolve));
});

describe('集成测试 — PVE 人机对战', () => {
  it('pve:start 开局，收到只有两位玩家（自己+电脑）的 game:state', async () => {
    const c = await connect();
    const state = waitFor(c, 'game:state');
    c.emit('pve:start', { playerName: 'Alice', pveId: 'p-alice-1' });
    const s = await state;
    expect(s.players).toHaveLength(2);
    expect(s.players.some(p => p.name === 'Alice')).toBe(true);
    expect(s.players.some(p => p.name === '电脑')).toBe(true);
    expect(s.phase).toBe('preflop');
  });

  it('pve:start 传 seatCount=4 时，game:state 里有 4 个玩家', async () => {
    const c = await connect();
    const state = waitFor(c, 'game:state');
    c.emit('pve:start', { playerName: 'Alice', pveId: 'multi-test-1', seatCount: 4 });
    const s = await state;
    expect(s.players.length).toBe(4);
  });

  it('pve:start 传非法 seatCount（如 3 或缺省）时，回退到 2 人桌，不报错', async () => {
    const c = await connect();
    const state = waitFor(c, 'game:state');
    c.emit('pve:start', { playerName: 'Alice', pveId: 'multi-test-2', seatCount: 3 });
    const s = await state;
    expect(s.players.length).toBe(2);
  });

  it('没有 pveId 时 pve:start 报错，不静默用 socket.id 兜底', async () => {
    const c = await connect();
    const err = waitFor(c, 'game:error');
    c.emit('pve:start', { playerName: 'Alice' });
    expect(await err).toBe('缺少玩家标识');
  });

  it('pve:peek 对不存在的 pveId 返回 exists:false，不创建新会话', async () => {
    const c = await connect();
    const res = await new Promise((resolve) => c.emit('pve:peek', { pveId: 'no-such-session' }, resolve));
    expect(res).toEqual({ exists: false });
    // 确认真的没有副作用创建出一局——peek 之后再 pve:peek 同一个 pveId，
    // 应该仍然是 exists:false（如果 peek 本身悄悄建过会话，这里就会变
    // true）。
    const res2 = await new Promise((resolve) => c.emit('pve:peek', { pveId: 'no-such-session' }, resolve));
    expect(res2).toEqual({ exists: false });
  });

  it('pve:peek 对存在的会话返回 exists:true + handNumber/seatCount，只读不影响会话本身', async () => {
    const c = await connect();
    const state = waitFor(c, 'game:state');
    c.emit('pve:start', { playerName: 'Alice', pveId: 'p-peek-1', seatCount: 4 });
    await state;
    const res = await new Promise((resolve) => c.emit('pve:peek', { pveId: 'p-peek-1' }, resolve));
    expect(res).toEqual({ exists: true, handNumber: 1, seatCount: 4 });
  });

  it('完整打一手（真人一路跟注/过牌，AI 自动行动），最终收到 game:showdown', async () => {
    const c = await connect();
    const state1 = waitFor(c, 'game:state');
    c.emit('pve:start', { playerName: 'Alice', pveId: 'p-alice-2' });
    let s = await state1;

    const showdownPromise = waitFor(c, 'game:showdown', 15000);

    // Drive the hand to completion: whenever it's our turn (actionPlayerId
    // matches — we don't know our own id client-side in this raw-socket
    // test, so use "does a legal call/check exist" instead), call if there's
    // a bet to match, otherwise check. Stop once showdown arrives.
    let guard = 0;
    while (guard < 50 && s.phase !== 'showdown') {
      guard += 1;
      // Masked opponent holeCards are still [null, null] (length 2, but
      // null contents) — only our own real cards have a truthy [0].
      const isMyTurn = s.players.find(p => p.id === s.actionPlayerId && p.holeCards?.[0]);
      if (!isMyTurn) {
        // Not our turn (AI thinking) — wait for the next state push.
        s = await waitFor(c, 'game:state', 5000);
        continue;
      }
      const me = s.players.find(p => p.id === s.actionPlayerId);
      const toCall = s.currentBet - me.bet;
      const nextState = waitFor(c, 'game:state', 5000);
      c.emit('pve:action', { action: toCall > 0 ? 'call' : 'check' });
      s = await nextState;
    }
    const showdown = await showdownPromise;
    expect(showdown.winners.length).toBeGreaterThan(0);
  }, 20000);

  it('对局不存在时 pve:action 返回 game:error，不抛服务端异常', async () => {
    const c = await connect();
    const err = waitFor(c, 'game:error');
    c.emit('pve:action', { action: 'check' });
    expect(await err).toBe('对局不存在');
  });

  describe('断线重连（用户反馈：关掉浏览器再打开显示"对局不存在"）', () => {
    it('同一 pveId 用新 socket 重新 pve:start → 恢复原有对局，不是一局新的（手数/筹码/座位不变）', async () => {
      const c1 = await connect();
      const state1 = waitFor(c1, 'game:state');
      c1.emit('pve:start', { playerName: 'Bob', pveId: 'p-reconnect-1' });
      const before = await state1;

      c1.disconnect();
      await new Promise(r => setTimeout(r, 100)); // let the server's disconnect handler actually run

      const c2 = await connect();
      const state2 = waitFor(c2, 'game:state');
      // playerName intentionally omitted/blank here — a resume should
      // ignore it and still come back with the original "Bob".
      c2.emit('pve:start', { playerName: '', pveId: 'p-reconnect-1' });
      const after = await state2;

      expect(after.players.find(p => p.name === 'Bob')).toBeDefined();
      expect(after.players).toHaveLength(2); // still 2 rows, not a fresh 3rd
      expect(after.phase).toBe('preflop');
      expect(after.pot).toBe(before.pot); // same hand still in progress, not reset
    });

    it('同一 pveId 再次 pve:start 时传了不同的 seatCount → 视为选了新桌型，丢弃旧会话开新局（用户反馈：选桌人数不生效，总是沿用上次的选择）', async () => {
      const c1 = await connect();
      const state1 = waitFor(c1, 'game:state');
      c1.emit('pve:start', { playerName: 'Eve', pveId: 'p-reseat-1', seatCount: 2 });
      const before = await state1;
      expect(before.players).toHaveLength(2);

      c1.disconnect();
      await new Promise(r => setTimeout(r, 100));

      const c2 = await connect();
      const state2 = waitFor(c2, 'game:state');
      c2.emit('pve:start', { playerName: 'Eve', pveId: 'p-reseat-1', seatCount: 4 });
      const after = await state2;

      expect(after.players).toHaveLength(4); // new 4-seat table, not the stale 2-seat one
      expect(after.handNumber ?? 1).toBe(1); // brand-new hand, not the old one resumed
    });

    it('同一 pveId 再次 pve:start 且 seatCount 跟旧会话一致 → 照常续局，不受新分支影响', async () => {
      const c1 = await connect();
      const state1 = waitFor(c1, 'game:state');
      c1.emit('pve:start', { playerName: 'Frank', pveId: 'p-reseat-2', seatCount: 4 });
      const before = await state1;

      c1.disconnect();
      await new Promise(r => setTimeout(r, 100));

      const c2 = await connect();
      const state2 = waitFor(c2, 'game:state');
      c2.emit('pve:start', { playerName: 'Frank', pveId: 'p-reseat-2', seatCount: 4 });
      const after = await state2;

      expect(after.players).toHaveLength(4);
      expect(after.pot).toBe(before.pot); // same hand still in progress, not reset
    });

    it('不同 pveId 各自独立——重连不会把两个不同玩家的对局混在一起', async () => {
      const c1 = await connect();
      const s1 = waitFor(c1, 'game:state');
      c1.emit('pve:start', { playerName: 'Carol', pveId: 'p-independent-A' });
      await s1;
      c1.disconnect();
      await new Promise(r => setTimeout(r, 100));

      const c2 = await connect();
      const s2 = waitFor(c2, 'game:state');
      c2.emit('pve:start', { playerName: 'Dave', pveId: 'p-independent-B' });
      const state = await s2;
      // A brand-new pveId must get a brand-new session, not Carol's.
      expect(state.players.some(p => p.name === 'Dave')).toBe(true);
      expect(state.players.some(p => p.name === 'Carol')).toBe(false);
    });

    it('pve:leave 显式清掉对局——同一 pveId 之后重新 pve:start 得到全新的一局，不是恢复', async () => {
      const c = await connect();
      const s1 = waitFor(c, 'game:state');
      c.emit('pve:start', { playerName: 'Eve', pveId: 'p-leave-1' });
      await s1;

      c.emit('pve:leave');
      await new Promise(r => setTimeout(r, 50));

      const s2 = waitFor(c, 'game:state');
      c.emit('pve:start', { playerName: 'Eve', pveId: 'p-leave-1' });
      const fresh = await s2;
      expect(fresh.phase).toBe('preflop');
      // Blinds are already posted by the time this state arrives (see
      // GameEngine constructor), so chips alone won't read 1000 — check
      // chips+bet (their total commitment) sums back to the starting stack.
      expect(fresh.players.every(p => p.chips + p.bet === 1000)).toBe(true);
    });

    it('断线发生在摊牌之后、下一手开始之前 → 重连要重新收到 game:showdown，不能卡在"正在比牌"（用户反馈，2026-07-31）', async () => {
      const c1 = await connect();
      const state1 = waitFor(c1, 'game:state');
      c1.emit('pve:start', { playerName: 'Frank', pveId: 'p-showdown-resume-1' });
      let s = await state1;

      const showdownPromise = waitFor(c1, 'game:showdown', 15000);
      let guard = 0;
      while (guard < 50 && s.phase !== 'showdown') {
        guard += 1;
        const isMyTurn = s.players.find(p => p.id === s.actionPlayerId && p.holeCards?.[0]);
        if (!isMyTurn) { s = await waitFor(c1, 'game:state', 5000); continue; }
        const me = s.players.find(p => p.id === s.actionPlayerId);
        const toCall = s.currentBet - me.bet;
        const nextState = waitFor(c1, 'game:state', 5000);
        c1.emit('pve:action', { action: toCall > 0 ? 'call' : 'check' });
        s = await nextState;
      }
      const firstShowdown = await showdownPromise;

      // Simulate closing the tab BEFORE the (client-side, 1.4s-delayed)
      // settlement sheet ever appeared — readyNext() never got called, so
      // the session is still parked on this exact finished hand.
      c1.disconnect();
      await new Promise(r => setTimeout(r, 100));

      const c2 = await connect();
      const state2 = waitFor(c2, 'game:state');
      const showdown2 = waitFor(c2, 'game:showdown', 5000);
      c2.emit('pve:start', { playerName: '', pveId: 'p-showdown-resume-1' });
      const resumedState = await state2;
      const resumedShowdown = await showdown2;

      expect(resumedState.phase).toBe('showdown');
      expect(resumedShowdown.winners).toEqual(firstShowdown.winners);
    }, 20000);
  });
});
