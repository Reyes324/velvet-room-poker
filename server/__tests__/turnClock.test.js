/**
 * 回合倒计时 + 时间银行（用户反馈 #7「页面没有倒计时」/ #10「太慢了……每次
 * 轮到一个玩家发言时，都没有倒计时」）。
 *
 * 时长全部注入成很小的值，否则每条用例都得真等 20 秒。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createServer } = require('../index');
const { io: Client } = require('socket.io-client');

const BASE_MS = 250;
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
    settlementDisplayMs: 5000, // 别让结算推进干扰本文件的断言
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

describe('回合倒计时', () => {
  it('轮到某人时就起计时，并把截止时刻发给所有人', async () => {
    const { c1, room, actorId } = await startedRoom();

    expect(room.turnClock).not.toBeNull();
    expect(room.turnClock.playerId).toBe(actorId);

    const lobby = waitFor(c1, 'room:state');
    c1.emit('room:sync', { playerId: 'p1' });
    const state = await lobby;
    // 公开信息：所有人都该看到轮到谁、还剩多久，不只是行动方自己
    expect(state.turnClock.playerId).toBe(actorId);
    expect(state.turnClock.endsAt).toBeGreaterThan(Date.now());
  });

  it('到点没行动 → 自动执行默认动作（单挑翻牌前是弃牌，本手随之结束）', async () => {
    const { room, actorId } = await startedRoom();

    // 单挑翻牌前面对大盲无法过牌，默认动作是弃牌，于是这手直接结束进入结算。
    const acted = await waitUntil(() => room.isAwaitingSettlementAck() || room.getActionPlayerId() !== actorId);
    expect(acted).toBe(true);
  });

  it('一手结束后不再起计时——否则会对着已结束的牌反复执行默认动作', async () => {
    // 这条是实测踩出来的：牌局对象在一手结束后仍然存在，actionIndex 也还停在
    // 最后行动的人身上，只看 getActionPlayerId() 会让超时回调每个周期触发一
    // 次、不停地给同一个人弃牌。
    const { room } = await startedRoom();
    await waitUntil(() => room.isAwaitingSettlementAck());

    expect(room.isAwaitingAction()).toBe(false);
    await new Promise(r => setTimeout(r, BASE_MS * 3));
    expect(room.turnClock).toBeNull();
  });

  it('计时对所有人一视同仁，不看 connected', async () => {
    // 这是本设计的核心决策：倒计时问的是"有没有在时限内行动"。把行动方标成
    // 在线，到点照样执行——不存在"在线就能无限拖"这条路。
    const { room, actorId } = await startedRoom();
    room.setConnected(actorId, true);

    const acted = await waitUntil(() => room.isAwaitingSettlementAck() || room.getActionPlayerId() !== actorId);
    expect(acted).toBe(true);
  });

  it('无关的广播不会给当前行动方续命', async () => {
    // 别人重连/同步都会触发 broadcastRoom。如果每次广播都重置计时，一个人只
    // 要旁边有人不断重连就能永远不被超时。
    const { c1, c2, room, actorId } = await startedRoom();
    const endsAtBefore = room.turnClock.endsAt;

    const other = actorId === 'p1' ? c2 : c1;
    const otherId = actorId === 'p1' ? 'p2' : 'p1';
    other.emit('room:sync', { playerId: otherId });
    await new Promise(r => setTimeout(r, 60));

    expect(room.turnClock.playerId).toBe(actorId);
    expect(room.turnClock.endsAt).toBe(endsAtBefore);
  });
});

describe('时间银行（+15 秒延时）', () => {
  it('点延时会把截止时刻往后推，并从储备池扣除', async () => {
    const { c1, c2, room, actorId } = await startedRoom();
    const actor = actorId === 'p1' ? c1 : c2;
    const endsAtBefore = room.turnClock.endsAt;

    actor.emit('game:extend-turn', { playerId: actorId });
    await waitUntil(() => room.turnClock.endsAt > endsAtBefore);

    expect(room.turnClock.endsAt).toBe(endsAtBefore + STEP_MS);
    expect(room.timeBankFor(actorId)).toBe(BANK_MS - STEP_MS);
  });

  it('储备池用完后不能再延时', async () => {
    const { c1, c2, room, actorId } = await startedRoom();
    const actor = actorId === 'p1' ? c1 : c2;

    // BANK_MS / STEP_MS = 2 次
    actor.emit('game:extend-turn', { playerId: actorId });
    await waitUntil(() => room.timeBankFor(actorId) === BANK_MS - STEP_MS);
    actor.emit('game:extend-turn', { playerId: actorId });
    await waitUntil(() => room.timeBankFor(actorId) === 0);

    const err = waitFor(actor, 'game:error');
    actor.emit('game:extend-turn', { playerId: actorId });
    expect(await err).toBe('延时时间已用完');
  });

  it('不是自己的回合不能延时', async () => {
    const { c1, c2, actorId } = await startedRoom();
    const other = actorId === 'p1' ? c2 : c1;
    const otherId = actorId === 'p1' ? 'p2' : 'p1';

    const err = waitFor(other, 'game:error');
    other.emit('game:extend-turn', { playerId: otherId });
    expect(await err).toBe('现在不是你的回合');
  });

  it('延时之后到点时间也跟着推迟，不会按原时刻就把人弃牌', async () => {
    // 这是最容易写错的一处：加了时间但没有重新排期定时器，玩家会看到"我明明
    // 加了时间，还是被弃牌了"。
    const { c1, c2, room, actorId } = await startedRoom();
    const actor = actorId === 'p1' ? c1 : c2;

    actor.emit('game:extend-turn', { playerId: actorId });
    await waitUntil(() => room.timeBankFor(actorId) < BANK_MS);

    // 原本的截止时刻已经过去，但延时后的还没到——此时行动权必须还在他手上
    await new Promise(r => setTimeout(r, BASE_MS + 40));
    expect(room.getActionPlayerId()).toBe(actorId);

    // 再等过延长后的时刻，默认动作才该执行
    const acted = await waitUntil(() => room.isAwaitingSettlementAck() || room.getActionPlayerId() !== actorId);
    expect(acted).toBe(true);
  });
});

describe('同一个人连续两个回合（评审 high 档发现的缺陷）', () => {
  it('单挑：大盲翻牌前最后行动、翻牌后第一个行动 → 必须重新计时，不能继承上一街的剩余时间', async () => {
    // 单挑里 SB/庄家翻牌前先动，BB 后动；进入翻牌圈后顺序反转，BB 变成第一个
    // 行动的人。于是同一个 playerId 连着占了两个回合。只比对 playerId 会把这
    // 两个回合当成同一个，倒计时不重启，BB 在翻牌圈继承的是翻牌前用剩的时间
    // ——极端情况下翻牌一落地就只剩 1、2 秒，甚至直接被自动过牌。
    const { c1, c2, room, actorId } = await startedRoom();
    const sb = actorId === 'p1' ? c1 : c2;
    const bbId = actorId === 'p1' ? 'p2' : 'p1';
    const bb = actorId === 'p1' ? c2 : c1;

    sb.emit('game:action', { playerId: actorId, action: 'call' });
    await waitUntil(() => room.getActionPlayerId() === bbId);

    // 故意把 BB 这个回合的时间用掉大半，再过牌进翻牌圈
    await new Promise(r => setTimeout(r, BASE_MS * 0.7));
    const preflopEndsAt = room.turnClock.endsAt;

    bb.emit('game:action', { playerId: bbId, action: 'check' });
    await waitUntil(() => room.game?.phase === 'flop');

    // 翻牌圈行动方仍是 BB——这正是触发条件
    expect(room.getActionPlayerId()).toBe(bbId);
    // 必须是一个全新的截止时刻，而不是翻牌前那个
    expect(room.turnClock.endsAt).toBeGreaterThan(preflopEndsAt);
    expect(room.turnClock.endsAt - Date.now()).toBeGreaterThan(BASE_MS * 0.8);
  });
});
