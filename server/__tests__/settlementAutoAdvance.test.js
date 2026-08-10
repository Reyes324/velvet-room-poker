/**
 * 用户反馈 #10：「多个玩家的时候，现在的交互设计太慢了。因为现在很多步骤
 * 都依赖于所有玩家确认」
 *
 * 结算等待原本要求名单里每个人都点确认才推进，任何一个人（断线的、已退出
 * 的、就是在发呆的）都能卡住其他所有人。现在改成：所有在场者都点了就立即
 * 继续，否则到点自动继续。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createServer } = require('../index');
const { io: Client } = require('socket.io-client');

const DISPLAY_MS = 300; // 注入的结算展示时长，让测试不用真等 15 秒

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

async function waitUntil(predicate, { timeout = 3000, step = 25 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, step));
  }
  return false;
}

beforeEach(async () => {
  const created = createServer({ settlementDisplayMs: DISPLAY_MS });
  server = created.server;
  rooms = created.rooms;
  await new Promise((resolve) => server.listen(0, resolve));
  url = `http://localhost:${server.address().port}`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.disconnect();
  await new Promise((resolve) => server.close(resolve));
});

/** 建一个两人房、开局，并打到摊牌（一方直接弃牌最快） */
async function playToSettlement() {
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

  // 让当前行动方弃牌，立刻进入结算
  const actorId = state.actionPlayerId;
  const actor = actorId === 'p1' ? c1 : c2;
  const showdown = waitFor(c1, 'game:showdown');
  actor.emit('game:action', { playerId: actorId, action: 'fold' });
  await showdown;

  return { c1, c2, code, room: rooms.getRoom(code) };
}

describe('结算自动推进（用户反馈 #10）', () => {
  it('没有任何人点确认，到点也会自动进入下一手', async () => {
    const { room } = await playToSettlement();
    expect(room.isAwaitingSettlementAck()).toBe(true);

    const advanced = await waitUntil(() => room.isAwaitingSettlementAck() === false);
    expect(advanced).toBe(true);
  });

  it('已退出房间的玩家不会把整桌卡住（旧行为下会永久卡死）', async () => {
    const { c2, room } = await playToSettlement();

    // Bob 退出房间——他的 socket 仍然活着（人回到首页了），所以旧的兜底
    // 定时器（只在名单里有人被标成断线时才启动）根本不会启动。
    c2.emit('player:leave-room', { playerId: 'p2' });

    const advanced = await waitUntil(() => room.isAwaitingSettlementAck() === false);
    expect(advanced).toBe(true);
  });

  it('所有在场者都点了确认 → 不必等满展示时长，立即推进', async () => {
    const { c1, c2, room } = await playToSettlement();

    const t0 = Date.now();
    c1.emit('game:ready-next', { playerId: 'p1' });
    c2.emit('game:ready-next', { playerId: 'p2' });

    const advanced = await waitUntil(() => room.isAwaitingSettlementAck() === false);
    expect(advanced).toBe(true);
    // 快路径必须真的比展示时长快，否则"都点了就立即继续"名存实亡
    expect(Date.now() - t0).toBeLessThan(DISPLAY_MS);
  });

  // GitHub issue #16：牌局已经开始，有新人进房间后，结算弹窗的倒计时自动
  // 推进就失灵了，变成要求每个人都手动点"我知道了"。
  //
  // 新玩家 room:join 成功后，客户端会导航到 RoomPage，其 mount 时的
  // useEffect 会立刻 emit 一次 'room:sync'（不止用于重连——mount 本身就
  // 会触发，见 RoomPage.jsx 里的注释"Re-sync on every (re)connect, not
  // just mount"）。这个 room:sync 落进 index.js 里"重连时清理结算兜底定
  // 时器"的分支（因为此时 room.isAwaitingSettlementAck() && room.game 都
  // 成立），把刚刚 armSettlementTimer 立好的定时器 clearSettlementTimer
  // 掉，但没有重新 arm——不管这个 socket 是不是真的"重连"。于是全场唯一
  // 的自动推进机制被静默关闭，只能靠所有人手动点确认了。
  it('结算等待期间有新玩家加入（触发一次 room:sync）不应关掉自动推进', async () => {
    const { c1, code, room } = await playToSettlement();
    expect(room.isAwaitingSettlementAck()).toBe(true);

    // 新玩家加入，随后其客户端会照 RoomPage 的真实行为在 mount 时 sync 一次
    const c3 = await connect();
    const joined3 = waitFor(c3, 'room:joined');
    c3.emit('room:join', { code, playerId: 'p3', playerName: 'Carol' });
    await joined3;
    c3.emit('room:sync', { playerId: 'p3' });

    const advanced = await waitUntil(() => room.isAwaitingSettlementAck() === false);
    expect(advanced).toBe(true);
  });
});
