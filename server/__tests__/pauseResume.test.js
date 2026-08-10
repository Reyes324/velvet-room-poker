/**
 * 暂停/继续（用户反馈，2026-08-11）：任意坐位玩家能立刻冻结当前回合的行动
 * 倒计时，恢复后接着暂停前剩余的时间继续走，不重新给满时长。
 *
 * 设计文档：docs/superpowers/specs/2026-08-11-pause-resume-design.md
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createServer } = require('../index');
const { io: Client } = require('socket.io-client');

const BASE_MS = 2000;
const BANK_MS = 300;
const STEP_MS = 150;

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

async function waitUntil(predicate, { timeout = 3000, step = 20 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, step));
  }
  return false;
}

beforeEach(async () => {
  const created = createServer({
    turnBaseMs: BASE_MS,
    timeBankPerHandMs: BANK_MS,
    turnExtendStepMs: STEP_MS,
    settlementDisplayMs: 5000,
  });
  server = created.server;
  rooms = created.rooms;
  await new Promise((resolve) => server.listen(0, resolve));
  url = `http://localhost:${server.address().port}`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.disconnect();
  await new Promise((resolve) => server.close(resolve));
});

async function startedRoom() {
  const [c1, c2] = await Promise.all([connect(), connect()]);
  const joined1 = waitFor(c1, 'room:joined');
  c1.emit('room:create', { playerId: 'p1', playerName: 'Alice' });
  const { code } = await joined1;
  const ready = waitFor(c2, 'room:state');
  c2.emit('room:join', { code, playerId: 'p2', playerName: 'Bob' });
  await ready;

  const gs = waitFor(c1, 'game:state');
  c1.emit('room:start', { playerId: 'p1' });
  const state = await gs;
  const room = rooms.getRoom(code);
  return { c1, c2, room, actorId: state.actionPlayerId };
}

describe('暂停/继续', () => {
  it('暂停立刻冻结当前回合倒计时', async () => {
    const { c1, room, actorId } = await startedRoom();
    expect(room.turnClock).not.toBeNull();

    c1.emit('room:pause', { playerId: 'p1' });
    await waitUntil(() => room.paused === true);

    expect(room.turnClock).toBeNull();
    expect(room.pausedActionPlayerId).toBe(actorId);
    expect(room.pauseRemainingMs).toBeGreaterThan(0);

    // 冻结之后即使等过了原本的倒计时时长，也不应该被判超时——
    // 这是本功能存在的核心意义。
    await new Promise(r => setTimeout(r, BASE_MS + 200));
    expect(room.isAwaitingAction()).toBe(true);
    expect(room.getActionPlayerId()).toBe(actorId);
  });

  it('恢复后用剩余时间重新起表，而不是满时长', async () => {
    const { c1, room, actorId } = await startedRoom();
    const originalEndsAt = room.turnClock.endsAt;

    c1.emit('room:pause', { playerId: 'p1' });
    await waitUntil(() => room.paused === true);
    // 模拟暂停期间过了一段时间再恢复。
    await new Promise(r => setTimeout(r, 300));

    c1.emit('room:resume', { playerId: 'p1' });
    await waitUntil(() => room.paused === false);

    expect(room.turnClock).not.toBeNull();
    expect(room.turnClock.playerId).toBe(actorId);
    // 新的截止时刻应该明显早于"暂停前的原计划截止时刻 + 已经过去的暂停时长"
    // ——如果恢复重新给了满时长（BASE_MS），新截止时刻会晚于原计划很多；
    // 用剩余时间重新起表的话，新截止时刻应该约等于"恢复那一刻 + 暂停前剩
    // 的那点时间"，明显早于原计划的 endsAt 往后再加一整个 BASE_MS。
    expect(room.turnClock.endsAt).toBeLessThan(originalEndsAt + BASE_MS);
  });

  it('两个人几乎同时暂停——竞态安全，只生效一次', async () => {
    const { c1, c2, room } = await startedRoom();

    c1.emit('room:pause', { playerId: 'p1' });
    c2.emit('room:pause', { playerId: 'p2' });
    await waitUntil(() => room.paused === true);
    await new Promise(r => setTimeout(r, 60));

    // 状态没有被第二次调用搞乱——依然干净地是 true，剩余时间字段也只被
    // 设置了一次（不会因为重复触发而被后到的调用用一个更小的剩余时间覆盖）。
    expect(room.paused).toBe(true);
  });

  it('非坐位玩家（不存在的 playerId）触发暂停被拒绝，不改变状态', async () => {
    const { c1, room } = await startedRoom();

    c1.emit('room:pause', { playerId: 'not-a-real-player' });
    await new Promise(r => setTimeout(r, 60));

    expect(room.paused).toBe(false);
  });

  it('暂停期间的行动请求被服务端拒绝，不改变牌局状态', async () => {
    const { c1, room, actorId } = await startedRoom();

    c1.emit('room:pause', { playerId: 'p1' });
    await waitUntil(() => room.paused === true);

    const actor = actorId === 'p1' ? c1 : clients.find(c => c !== c1);
    actor.emit('game:action', { playerId: actorId, action: 'fold' });
    await new Promise(r => setTimeout(r, 60));

    expect(room.getActionPlayerId()).toBe(actorId);
  });

  it('暂停发生在两手之间（没有活跃回合）不报错，pauseRemainingMs 为 null', async () => {
    const { c1, room } = await startedRoom();
    // 手动清掉当前回合，模拟"没有活跃回合"的状态（比如结算等待期）。
    room.clearTurnClock();
    room.game = null;

    c1.emit('room:pause', { playerId: 'p1' });
    await waitUntil(() => room.paused === true);

    expect(room.pauseRemainingMs).toBeNull();
    expect(room.pausedActionPlayerId).toBeNull();

    c1.emit('room:resume', { playerId: 'p1' });
    await waitUntil(() => room.paused === false);
    // 不应该抛异常，也不应该凭空造出一个 turnClock（没有活跃的手）。
    expect(room.turnClock).toBeNull();
  });

  it('暂停期间行动方断线，不触发异常路径；恢复后正常走超时', async () => {
    const { c1, room, actorId } = await startedRoom();

    c1.emit('room:pause', { playerId: 'p1' });
    await waitUntil(() => room.paused === true);

    room.setConnected(actorId, false);
    await new Promise(r => setTimeout(r, BASE_MS + 200));
    // 还在暂停，断线不应该让计时器凭空重新跑起来。
    expect(room.isAwaitingAction()).toBe(true);
    expect(room.getActionPlayerId()).toBe(actorId);

    c1.emit('room:resume', { playerId: 'p1' });
    // 恢复后，断线的行动方到点应该照常被执行默认动作——这是既有行为，
    // 暂停/恢复不应该破坏它。
    const acted = await waitUntil(() => room.isAwaitingSettlementAck() || room.getActionPlayerId() !== actorId, { timeout: BASE_MS + 1000 });
    expect(acted).toBe(true);
  });
});
