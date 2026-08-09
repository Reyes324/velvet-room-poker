/**
 * 语音对讲的信令中转（voice:join / voice:signal / voice:leave）。
 *
 * 这一层的职责非常窄：**只转发建连所需的那几句话**，语音本身走点对点、永远
 * 不经过服务器。所以这里要守的不是"音频对不对"，而是几条会让双机实测得出
 * 错误结论的行为：
 *
 *  1. 发起方由服务端一次性指定。两边各自猜就会同时发 offer（glare），是这类
 *     实现最常见的卡死原因，而且症状是"偶发连不上"——一旦漏了，真机实测拿到
 *     的 no-go 结论就是假的。
 *  2. 信令只能转给同一个语音房间里的人。否则任何人拿一个 socket id 就能往
 *     任意连接上推消息。
 *  3. 探路阶段封顶 2 人，第三个人要拿到明确错误而不是一个说不清的半连接。
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

function join(socket, code) {
  return new Promise(resolve => socket.emit('voice:join', { code }, resolve));
}

function waitFor(socket, event, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for '${event}'`)), timeout);
    socket.once(event, data => { clearTimeout(t); resolve(data); });
  });
}

// 断言某个事件在一段时间内**没有**到达。用于"不该被转发"这类否定命题——
// 只查一次会因为消息还在路上而假阳性。
function neverArrives(socket, event, duration = 400) {
  return new Promise(resolve => {
    let got = false;
    const handler = () => { got = true; };
    socket.on(event, handler);
    setTimeout(() => { socket.off(event, handler); resolve(!got); }, duration);
  });
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

describe('语音信令中转', () => {
  it('第一个进来的人不当发起方，第二个才是——避免双方同时发 offer', async () => {
    const a = await connect();
    const b = await connect();

    const resA = await join(a, '1234');
    expect(resA.error).toBeUndefined();
    expect(resA.shouldInitiate).toBe(false);
    expect(resA.peers).toEqual([]);

    const resB = await join(b, '1234');
    expect(resB.shouldInitiate).toBe(true);
    expect(resB.peers).toEqual([a.id]);
  });

  it('后进来的人会让先到的人收到 voice:peer-joined', async () => {
    const a = await connect();
    const b = await connect();
    await join(a, '1234');
    const joined = waitFor(a, 'voice:peer-joined');
    await join(b, '1234');
    expect((await joined).id).toBe(b.id);
  });

  it('信令被原样转给指定的对端，并带上发送者 id', async () => {
    const a = await connect();
    const b = await connect();
    await join(a, '1234');
    await join(b, '1234');

    const incoming = waitFor(a, 'voice:signal');
    b.emit('voice:signal', { to: a.id, signal: { sdp: { type: 'offer', sdp: 'v=0...' } } });
    const msg = await incoming;
    expect(msg.from).toBe(b.id);
    expect(msg.signal.sdp.type).toBe('offer');
  });

  it('不转发给不在同一个语音房间的人——白送的越权面必须堵掉', async () => {
    const a = await connect();
    const b = await connect();
    const outsider = await connect();
    await join(a, '1234');
    await join(b, '1234');
    await join(outsider, '9999');

    const notDelivered = neverArrives(outsider, 'voice:signal');
    a.emit('voice:signal', { to: outsider.id, signal: { sdp: { type: 'offer' } } });
    expect(await notDelivered).toBe(true);
  });

  it('同一个暗号最多两个人，第三个人拿到明确错误而不是半连接', async () => {
    const a = await connect();
    const b = await connect();
    const c = await connect();
    await join(a, '1234');
    await join(b, '1234');

    const res = await join(c, '1234');
    expect(res.error).toMatch(/两个人/);
    expect(res.shouldInitiate).toBeUndefined();
  });

  it('暗号必须是 4 位数字，非法输入直接拒绝', async () => {
    const a = await connect();
    expect((await join(a, 'abcd')).error).toBeTruthy();
    expect((await join(a, '12')).error).toBeTruthy();
    expect((await join(a, '')).error).toBeTruthy();
    expect((await join(a, undefined)).error).toBeTruthy();
  });

  it('断开连接时对端收到 voice:peer-left（靠 disconnecting，disconnect 时房间已清空）', async () => {
    const a = await connect();
    const b = await connect();
    await join(a, '1234');
    await join(b, '1234');

    // id 必须在 close() 之前取——socket.io 客户端断开后会把 socket.id 清成
    // undefined，事后再读会拿到 undefined 跟 undefined 比，测试永远"通过"。
    const bId = b.id;
    const left = waitFor(a, 'voice:peer-left');
    b.close();
    expect((await left).id).toBe(bId);
  });

  it('主动 voice:leave 同样通知对端', async () => {
    const a = await connect();
    const b = await connect();
    await join(a, '1234');
    await join(b, '1234');

    const left = waitFor(a, 'voice:peer-left');
    b.emit('voice:leave');
    expect((await left).id).toBe(b.id);
  });

  it('换暗号会退出旧房间，旧房间的人收到通知而不是一直以为他还在', async () => {
    const a = await connect();
    const b = await connect();
    await join(a, '1234');
    await join(b, '1234');

    const left = waitFor(a, 'voice:peer-left');
    const res = await join(b, '5678');
    expect((await left).id).toBe(b.id);
    // 进了新房间就是新房间的第一个人，不该继承旧房间的发起方身份
    expect(res.shouldInitiate).toBe(false);
  });

  it('语音信令不碰游戏状态：没进过任何牌桌也能用', async () => {
    const a = await connect();
    const b = await connect();
    const resA = await join(a, '4321');
    const resB = await join(b, '4321');
    expect(resA.error).toBeUndefined();
    expect(resB.error).toBeUndefined();
    expect(resB.peers).toEqual([a.id]);
  });
});
