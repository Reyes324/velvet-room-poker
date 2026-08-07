/**
 * 用户反馈 #9：「现在其他玩家断线的提示好频繁，是怎么触发的，确定玩家是
 * 真的断线了吗」
 *
 * 复现的是一个竞态：客户端换到新 socket 重连之后，**旧 socket 的
 * disconnect 事件才姗姗来迟**（socket.io 靠 ping 超时发现旧连接已死，可
 * 能滞后十几秒）。旧 socket 的处理函数无条件把该玩家标成 connected:false，
 * 把刚建立的活连接覆盖掉——于是全桌看到一个正在正常打牌的人显示「断线中」。
 *
 * 手机上尤其频繁：微信里切出去、iOS 切后台、WiFi↔蜂窝切换都会触发一次
 * 断开+重连，每次都可能撞上这个竞态。
 *
 * 注意 index.js 里 PVE 那条路径**已经**防了同一个竞态（socketToPveId /
 * pveActiveSocket 那段的注释明说了"don't let it clobber the new, live
 * association"），多人房间这条路径漏了。
 */
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

// 断线是服务端自己观察到的，没有一个"处理完了"的事件可以等——而等
// room:state 会误捕到前一次广播（第一版测试就踩了这个坑，把真实断线判成了
// 没标记）。所以直接轮询服务端状态本身。
async function waitUntil(predicate, { timeout = 2000, step = 25 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, step));
  }
  return false;
}

// 断言某件事在一段时间内**始终没有**发生。用于"不该被标成断线"这类否定
// 命题：只查一次会因为迟到的事件还没到而假阳性。
async function staysTrue(predicate, { duration = 800, step = 25 } = {}) {
  const deadline = Date.now() + duration;
  while (Date.now() < deadline) {
    if (!predicate()) return false;
    await new Promise(r => setTimeout(r, step));
  }
  return true;
}

beforeEach(async () => {
  const created = createServer();
  server = created.server;
  rooms = created.rooms;
  await new Promise((resolve) => server.listen(0, resolve));
  url = `http://localhost:${server.address().port}`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.disconnect();
  await new Promise((resolve) => server.close(resolve));
});

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

describe('迟到的旧 socket disconnect 不应把已重连的玩家标成断线（用户反馈 #9）', () => {
  it('新 socket 重连后，旧 socket 的 disconnect 迟到到达 → connected 仍为 true', async () => {
    const { c1, c2, code } = await setupRoom();

    // Bob 在一个新 socket 上重连（真实场景：网络抖动/切后台后 socket.io
    // 自动重连），此时服务端还没意识到旧 socket 已经死了。
    const c2b = await connect();
    const synced = waitFor(c2b, 'room:state');
    c2b.emit('room:sync', { playerId: 'p2' });
    await synced;

    const room = rooms.getRoom(code);
    const bobConnected = () => room.players.find(p => p.id === 'p2').connected === true;
    expect(bobConnected()).toBe(true);

    // 现在旧 socket 才断开——迟到的 disconnect 事件。
    c2.disconnect();

    // Bob 明明还连着（c2b 是活的），全程都不该被标成断线。
    expect(await staysTrue(bobConnected)).toBe(true);

    // 其他人看到的广播状态也必须是"在线"——这才是玩家实际看到的东西。
    const check = waitFor(c1, 'room:state');
    c1.emit('room:sync', { playerId: 'p1' });
    const lobby = await check;
    expect(lobby.players.find(p => p.id === 'p2').connected).toBe(true);
  });

  it('真的断线时仍然要标记 connected:false（别把防护做成永不标记）', async () => {
    const { c2, code } = await setupRoom();
    const room = rooms.getRoom(code);

    c2.disconnect(); // 没有任何新 socket 接手——这是货真价实的断线

    const marked = await waitUntil(() => room.players.find(p => p.id === 'p2').connected === false);
    expect(marked).toBe(true);
  });
});
