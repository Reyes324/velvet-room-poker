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

function waitFor(socket, event, timeout = 3000) {
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

describe('集成测试 — 房间管理', () => {
  it('创建房间后收到 room:joined 和 6位房间码', async () => {
    const c = await connect();
    const joined = waitFor(c, 'room:joined');
    c.emit('room:create', { playerId: 'p1', playerName: 'Alice' });
    const data = await joined;
    expect(data.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(data.playerId).toBe('p1');
  });

  it('两个玩家加入同一房间，双方都收到 room:state', async () => {
    const [c1, c2] = await Promise.all([connect(), connect()]);

    const joined1 = waitFor(c1, 'room:joined');
    c1.emit('room:create', { playerId: 'p1', playerName: 'Alice' });
    const { code } = await joined1;

    const state2 = waitFor(c2, 'room:state');
    c2.emit('room:join', { code, playerId: 'p2', playerName: 'Bob' });
    const state = await state2;

    expect(state.players).toHaveLength(2);
    expect(state.players.map(p => p.id)).toContain('p1');
    expect(state.players.map(p => p.id)).toContain('p2');
  });

  it('加入不存在的房间 → 收到 game:error（关键回归测试）', async () => {
    const c = await connect();
    const errMsg = waitFor(c, 'game:error');
    c.emit('room:join', { code: 'XXXXXX', playerId: 'p1', playerName: 'Alice' });
    const msg = await errMsg;
    expect(msg).toBe('房间不存在');
  });

  it('同一 playerId 重复加入 → 收到 game:error', async () => {
    const [c1, c2] = await Promise.all([connect(), connect()]);

    const joined = waitFor(c1, 'room:joined');
    c1.emit('room:create', { playerId: 'p1', playerName: 'Alice' });
    const { code } = await joined;

    const errMsg = waitFor(c2, 'game:error');
    c2.emit('room:join', { code, playerId: 'p1', playerName: 'Alice' });
    const msg = await errMsg;
    expect(msg).toBe('已在房间内');
  });
});

describe('集成测试 — 游戏流程', () => {
  async function setupRoom() {
    const [c1, c2] = await Promise.all([connect(), connect()]);
    const joined1 = waitFor(c1, 'room:joined');
    c1.emit('room:create', { playerId: 'p1', playerName: 'Alice' });
    const { code } = await joined1;
    const roomReady = waitFor(c2, 'room:state');
    c2.emit('room:join', { code, playerId: 'p2', playerName: 'Bob' });
    await roomReady;
    return { c1, c2, code };
  }

  it('非房主开始游戏 → 收到 game:error', async () => {
    const { c2 } = await setupRoom();
    const errMsg = waitFor(c2, 'game:error');
    c2.emit('room:start', { playerId: 'p2' });
    const msg = await errMsg;
    expect(msg).toBe('只有房主可以开始游戏');
  });

  it('房主开始游戏后双方收到 game:state', async () => {
    const { c1, c2 } = await setupRoom();
    const gs1 = waitFor(c1, 'game:state');
    const gs2 = waitFor(c2, 'game:state');
    c1.emit('room:start', { playerId: 'p1' });
    const [state1, state2] = await Promise.all([gs1, gs2]);
    expect(state1.phase).toBe('preflop');
    expect(state2.phase).toBe('preflop');
    const myCards = state1.players.find(p => p.id === 'p1').holeCards;
    const oppCards = state1.players.find(p => p.id === 'p2').holeCards;
    expect(myCards[0]).not.toBeNull();
    expect(oppCards[0]).toBeNull();
  });

  it('房主发送 room:restart → 双方收到 status=waiting 的 room:state', async () => {
    const { c1, c2 } = await setupRoom();
    const rs1 = waitFor(c1, 'room:state');
    const rs2 = waitFor(c2, 'room:state');
    c1.emit('room:restart', { playerId: 'p1' });
    const [state1] = await Promise.all([rs1, rs2]);
    expect(state1.status).toBe('waiting');
    expect(state1.players.every(p => p.chips === 1000)).toBe(true);
  });

  it('非房主发送 room:restart → 收到 game:error', async () => {
    const { c2 } = await setupRoom();
    const errMsg = waitFor(c2, 'game:error');
    c2.emit('room:restart', { playerId: 'p2' });
    const msg = await errMsg;
    expect(msg).toBeDefined();
  });

  it('不是自己回合时行动 → 收到 game:error', async () => {
    const { c1, c2 } = await setupRoom();
    const gs1 = waitFor(c1, 'game:state');
    c1.emit('room:start', { playerId: 'p1' });
    const gameState = await gs1;

    const notActingId = gameState.actionPlayerId === 'p1' ? 'p2' : 'p1';
    const notActing = notActingId === 'p2' ? c2 : c1;

    const errMsg = waitFor(notActing, 'game:error');
    notActing.emit('game:action', { playerId: notActingId, action: 'check' });
    const msg = await errMsg;
    expect(msg).toBeDefined();
  });
});
