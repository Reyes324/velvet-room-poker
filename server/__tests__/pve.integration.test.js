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
    c.emit('pve:start', { playerName: 'Alice' });
    const s = await state;
    expect(s.players).toHaveLength(2);
    expect(s.players.some(p => p.name === 'Alice')).toBe(true);
    expect(s.players.some(p => p.name === '电脑')).toBe(true);
    expect(s.phase).toBe('preflop');
  });

  it('完整打一手（真人一路跟注/过牌，AI 自动行动），最终收到 game:showdown', async () => {
    const c = await connect();
    const state1 = waitFor(c, 'game:state');
    c.emit('pve:start', { playerName: 'Alice' });
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
});
