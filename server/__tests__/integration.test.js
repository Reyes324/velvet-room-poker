import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  it('房主踢人 → 目标玩家收到 room:kicked，房间人数减少', async () => {
    const { c1, c2 } = await setupRoom();
    const kicked = waitFor(c2, 'room:kicked');
    c1.emit('room:kick', { hostId: 'p1', targetId: 'p2' });
    await kicked;
    // room:kicked 先于 room:state 广播发出（见 index.js room:kick 处理顺序），
    // 用 room:sync 主动拉取最新状态，避免与广播事件产生竞态断言。
    const stateCheck = waitFor(c1, 'room:state');
    c1.emit('room:sync', { playerId: 'p1' });
    const state = await stateCheck;
    expect(state.players).toHaveLength(1);
    expect(state.players.map(p => p.id)).not.toContain('p2');
  });

  it('非房主发送 room:kick → 房间人数不变（被静默忽略）', async () => {
    const { c1, c2 } = await setupRoom();
    c2.emit('room:kick', { hostId: 'p2', targetId: 'p1' });
    // 给服务端一点时间处理（若错误地生效会广播 room:state 变化）
    await new Promise(r => setTimeout(r, 200));
    const stateCheck = waitFor(c1, 'room:state');
    c1.emit('room:sync', { playerId: 'p1' });
    const state = await stateCheck;
    expect(state.players).toHaveLength(2);
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

  it('筹码归零导致游戏结束时，双方仍收到含最新筹码的 room:state（回归：曾经只发 game:ended 不发 room:state）', async () => {
    const { c1, c2 } = await setupRoom();
    const gs1 = waitFor(c1, 'game:state');
    c1.emit('room:start', { playerId: 'p1' });
    const state1 = await gs1;
    // 首手 dealerIndex=0：p1 是庄+大盲，p2 是小盲，小盲先行动（确定性，不依赖随机发牌）
    expect(state1.actionPlayerId).toBe('p2');

    // 直接模拟 p2 本局已经输光（不依赖具体牌局随机结果）
    const room = rooms.getRoomByPlayer('p1');
    room.game.players.find(p => p.id === 'p2').chips = 0;

    // 用持续监听收集每一次 room:state 广播，取 game:ended 后的最后一次，
    // 避免与 fold 处理本身立即触发的那次广播（此时 status 还是 'playing'）产生竞态。
    const roomStates = [];
    c1.on('room:state', (s) => roomStates.push(s));

    // p2 弃牌 → p1 赢下底池，p2 维持 0 筹码 → 不足2人有筹码，游戏结束
    const ended = waitFor(c1, 'game:ended', 6000);
    c2.emit('game:action', { playerId: 'p2', action: 'fold' });
    await ended;
    await new Promise((r) => setTimeout(r, 200)); // 让同批次的 room:state 广播送达

    const finalState = roomStates[roomStates.length - 1];
    expect(finalState.status).toBe('waiting');
    expect(finalState.players.find(p => p.id === 'p2').chips).toBe(0);
  });
});
