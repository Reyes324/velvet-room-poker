/**
 * 语音对讲正式接入牌桌后的信令中转（voice:mesh-join / voice:mesh-signal /
 * voice:speaking / voice:mesh-leave）。
 *
 * 跟探路阶段的 voiceSignaling.test.js 是同一层职责（只转发建连所需的信息，
 * 音频本身永远不经过服务器），但这里换成了 N 人 mesh、且信令边界是真实的
 * 游戏房间号，不再是独立"暗号"——所以要多守两条探路阶段不存在的东西：
 *
 *  1. 语音成员关系必须挂在一个真实的游戏房间上——没进过牌桌的连接拿不到
 *     mesh 资格。
 *  2. "正在说话"广播必须只到同一个游戏房间的语音成员，不能溢出到另一个
 *     房间——两桌互不干扰是牌桌隔离的既有原则，语音这层不能破例。
 */
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

function waitFor(socket, event, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for '${event}'`)), timeout);
    socket.once(event, data => { clearTimeout(t); resolve(data); });
  });
}

function neverArrives(socket, event, duration = 400) {
  return new Promise(resolve => {
    let got = false;
    const handler = () => { got = true; };
    socket.on(event, handler);
    setTimeout(() => { socket.off(event, handler); resolve(!got); }, duration);
  });
}

function createRoom(socket, playerId, playerName = '房主') {
  return new Promise(resolve => {
    socket.once('room:joined', resolve);
    socket.emit('room:create', { playerId, playerName });
  });
}

function joinRoom(socket, code, playerId, playerName) {
  return new Promise(resolve => {
    socket.once('room:joined', resolve);
    socket.emit('room:join', { code, playerId, playerName });
  });
}

function meshJoin(socket, playerId) {
  return new Promise(resolve => socket.emit('voice:mesh-join', { playerId }, resolve));
}

beforeEach(async () => {
  const created = createServer();
  server = created.server;
  await new Promise(resolve => server.listen(0, resolve));
  url = `http://localhost:${server.address().port}`;
});

afterEach(async () => {
  clients.forEach(c => c.close());
  clients.length = 0;
  await new Promise(resolve => server.close(resolve));
});

describe('语音 mesh 信令（正式接入牌桌）', () => {
  it('没进过任何牌桌的连接拿不到 mesh 资格', async () => {
    const a = await connect();
    const res = await meshJoin(a, '不存在的玩家id');
    expect(res.error).toBeTruthy();
  });

  it('三人桌：第三个人加入时能拿到前两位的 playerId 列表，前两位收到通知', async () => {
    const a = await connect();
    const b = await connect();
    const c = await connect();
    const { code } = await createRoom(a, 'p-a', 'Alice');
    await joinRoom(b, code, 'p-b', 'Bob');
    await joinRoom(c, code, 'p-c', 'Carol');

    const resA = await meshJoin(a, 'p-a');
    expect(resA.peers).toEqual([]);

    const joinedAtA = waitFor(a, 'voice:mesh-peer-joined');
    const resB = await meshJoin(b, 'p-b');
    expect(resB.peers).toEqual([{ socketId: a.id, playerId: 'p-a' }]);
    expect((await joinedAtA)).toEqual({ socketId: b.id, playerId: 'p-b' });

    const joinedAtA2 = waitFor(a, 'voice:mesh-peer-joined');
    const joinedAtB = waitFor(b, 'voice:mesh-peer-joined');
    const resC = await meshJoin(c, 'p-c');
    expect(resC.peers.sort((x, y) => x.playerId.localeCompare(y.playerId))).toEqual([
      { socketId: a.id, playerId: 'p-a' },
      { socketId: b.id, playerId: 'p-b' },
    ]);
    expect((await joinedAtA2)).toEqual({ socketId: c.id, playerId: 'p-c' });
    expect((await joinedAtB)).toEqual({ socketId: c.id, playerId: 'p-c' });
  });

  it('信令原样转发并带上发送者的 playerId（不只是 socket id）', async () => {
    const a = await connect();
    const b = await connect();
    const { code } = await createRoom(a, 'p-a');
    await joinRoom(b, code, 'p-b', 'Bob');
    await meshJoin(a, 'p-a');
    await meshJoin(b, 'p-b');

    const incoming = waitFor(a, 'voice:mesh-signal');
    b.emit('voice:mesh-signal', { to: a.id, signal: { sdp: { type: 'offer' } } });
    const msg = await incoming;
    expect(msg.from).toBe(b.id);
    expect(msg.fromPlayerId).toBe('p-b');
  });

  it('不转发给不在同一语音房间的人，也不接受没走过 mesh-join 的信令', async () => {
    const a = await connect();
    const b = await connect();
    const outsider = await connect();
    const { code: codeA } = await createRoom(a, 'p-a');
    await joinRoom(b, codeA, 'p-b', 'Bob');
    await createRoom(outsider, 'p-out', 'Outsider'); // 另一桌
    await meshJoin(a, 'p-a');
    await meshJoin(b, 'p-b');
    // outsider 在另一桌，没加入语音 mesh

    const notDelivered = neverArrives(a, 'voice:mesh-signal');
    outsider.emit('voice:mesh-signal', { to: a.id, signal: { sdp: { type: 'offer' } } });
    expect(await notDelivered).toBe(true);
  });

  it('"正在说话"只广播给同一游戏房间的语音成员，不溢出到另一桌', async () => {
    const a = await connect();
    const b = await connect();
    const other = await connect();
    const { code: codeA } = await createRoom(a, 'p-a');
    await joinRoom(b, codeA, 'p-b', 'Bob');
    await createRoom(other, 'p-other', 'Other'); // 另一桌
    await meshJoin(a, 'p-a');
    await meshJoin(b, 'p-b');
    await meshJoin(other, 'p-other');

    const heardByB = waitFor(b, 'voice:speaking');
    const notHeardByOther = neverArrives(other, 'voice:speaking');
    a.emit('voice:speaking', { playerId: 'p-a', speaking: true });
    expect(await heardByB).toEqual({ playerId: 'p-a', speaking: true });
    expect(await notHeardByOther).toBe(true);
  });

  it('冒充别人的 playerId 广播说话状态会被拒绝', async () => {
    const a = await connect();
    const b = await connect();
    const { code } = await createRoom(a, 'p-a');
    await joinRoom(b, code, 'p-b', 'Bob');
    await meshJoin(a, 'p-a');
    await meshJoin(b, 'p-b');

    const notHeard = neverArrives(b, 'voice:speaking');
    a.emit('voice:speaking', { playerId: 'p-b', speaking: true }); // a 冒充 b
    expect(await notHeard).toBe(true);
  });

  it('断开连接时对端收到 voice:mesh-peer-left', async () => {
    const a = await connect();
    const b = await connect();
    const { code } = await createRoom(a, 'p-a');
    await joinRoom(b, code, 'p-b', 'Bob');
    await meshJoin(a, 'p-a');
    await meshJoin(b, 'p-b');

    const bId = b.id;
    const left = waitFor(a, 'voice:mesh-peer-left');
    b.close();
    expect(await left).toEqual({ socketId: bId, playerId: 'p-b' });
  });

  it('主动 voice:mesh-leave 同样通知对端，离开后不再转发信令给它', async () => {
    const a = await connect();
    const b = await connect();
    const { code } = await createRoom(a, 'p-a');
    await joinRoom(b, code, 'p-b', 'Bob');
    await meshJoin(a, 'p-a');
    await meshJoin(b, 'p-b');

    const left = waitFor(a, 'voice:mesh-peer-left');
    b.emit('voice:mesh-leave');
    expect(await left).toEqual({ socketId: b.id, playerId: 'p-b' });

    const notDelivered = neverArrives(b, 'voice:mesh-signal');
    a.emit('voice:mesh-signal', { to: b.id, signal: { sdp: { type: 'offer' } } });
    expect(await notDelivered).toBe(true);
  });

  it('第 9 个人加入语音会被拒绝——封顶跟牌桌人数上限一致', async () => {
    const host = await connect();
    const { code } = await createRoom(host, 'p-0', 'P0');
    const others = [];
    for (let i = 1; i < 9; i++) {
      const s = await connect();
      await joinRoom(s, code, `p-${i}`, `P${i}`);
      others.push(s);
    }
    // 房间现在有 9 个人（p-0..p-8）。前 8 个进语音都该成功。
    await meshJoin(host, 'p-0');
    for (let i = 0; i < 7; i++) {
      const res = await meshJoin(others[i], `p-${i + 1}`);
      expect(res.error).toBeUndefined();
    }
    const res9 = await meshJoin(others[7], 'p-8');
    expect(res9.error).toBeTruthy();
  });

  it('语音信令不碰游戏状态：单测里从没触发过任何 game:* 事件', async () => {
    const a = await connect();
    const b = await connect();
    const gameErrors = [];
    a.on('game:error', e => gameErrors.push(e));
    const { code } = await createRoom(a, 'p-a');
    await joinRoom(b, code, 'p-b', 'Bob');
    await meshJoin(a, 'p-a');
    await meshJoin(b, 'p-b');
    expect(gameErrors).toEqual([]);
  });
});
