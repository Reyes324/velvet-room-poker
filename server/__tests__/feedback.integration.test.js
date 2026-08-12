import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createServer } = require('../index');
const { io: Client } = require('socket.io-client');

let server;
let url;
let fakeReporter;
const clients = [];

function connect() {
  return new Promise((resolve, reject) => {
    const socket = Client(url, { forceNew: true });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
    clients.push(socket);
  });
}

function emitWithAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

beforeEach(async () => {
  fakeReporter = {
    isConfigured: vi.fn(() => true),
    createFeedbackIssue: vi.fn(async () => ({ issueNumber: 7, issueUrl: 'https://github.com/x/y/issues/7' })),
    listFeedbackWithComments: vi.fn(async () => ([
      { number: 23, title: '断线问题', body: '正文', state: 'closed', labels: ['feedback'], createdAt: 't1', url: 'u1', comments: [] },
    ])),
  };
  const created = createServer({ feedbackReporter: fakeReporter });
  server = created.server;
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  url = `http://localhost:${port}`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.disconnect();
  await new Promise((resolve) => server.close(resolve));
});

describe('feedback:submit', () => {
  it('正常提交（无图片）：调用 createFeedbackIssue，回调 { ok: true, issueUrl }', async () => {
    const c = await connect();
    const res = await emitWithAck(c, 'feedback:submit', { text: '结算算错了' });
    expect(fakeReporter.createFeedbackIssue).toHaveBeenCalledWith({ text: '结算算错了', images: [], authorName: undefined });
    expect(res).toEqual({ ok: true, issueUrl: 'https://github.com/x/y/issues/7' });
  });

  // 用户反馈（2026-08-12）：反馈列表要显示"谁提交的"——不新增专门的称呼
  // 输入框，直接复用调用方已有的昵称，原样透传给 createFeedbackIssue。
  it('带 authorName 提交：原样透传给 createFeedbackIssue', async () => {
    const c = await connect();
    await emitWithAck(c, 'feedback:submit', { text: '结算算错了', authorName: 'Alice' });
    expect(fakeReporter.createFeedbackIssue).toHaveBeenCalledWith({ text: '结算算错了', images: [], authorName: 'Alice' });
  });

  it('带图片提交：images 原样透传给 createFeedbackIssue', async () => {
    const c = await connect();
    const image = { base64: 'ZmFrZQ==', mimeType: 'image/png' };
    await emitWithAck(c, 'feedback:submit', { text: '截图见附件', images: [image] });
    expect(fakeReporter.createFeedbackIssue).toHaveBeenCalledWith({ text: '截图见附件', images: [image], authorName: undefined });
  });

  // 用户反馈 #3（2026-08-03）：只能上传一张图不够用
  it('多图提交：多张图按顺序透传', async () => {
    const c = await connect();
    const imgs = [
      { base64: 'YQ==', mimeType: 'image/png' },
      { base64: 'Yg==', mimeType: 'image/jpeg' },
      { base64: 'Yw==', mimeType: 'image/webp' },
    ];
    await emitWithAck(c, 'feedback:submit', { text: '三张图', images: imgs });
    expect(fakeReporter.createFeedbackIssue).toHaveBeenCalledWith({ text: '三张图', images: imgs, authorName: undefined });
  });

  it('旧客户端兼容：只发单个 image 字段时归一化成 images 数组', async () => {
    // 前端是静态资源，用户浏览器里可能还缓存着改版前的包。丢掉这个兼容等于
    // 让旧标签页的反馈静默失败，而反馈系统本身不能有沉默的失败模式。
    const c = await connect();
    const image = { base64: 'ZmFrZQ==', mimeType: 'image/png' };
    await emitWithAck(c, 'feedback:submit', { text: '旧版客户端', image });
    expect(fakeReporter.createFeedbackIssue).toHaveBeenCalledWith({ text: '旧版客户端', images: [image], authorName: undefined });
  });

  it('超过张数上限：直接回错误，不调用 createFeedbackIssue', async () => {
    const c = await connect();
    const many = Array.from({ length: 5 }, () => ({ base64: 'YQ==', mimeType: 'image/png' }));
    const res = await emitWithAck(c, 'feedback:submit', { text: '五张图', images: many });
    expect(res.error).toBeTruthy();
    expect(fakeReporter.createFeedbackIssue).not.toHaveBeenCalled();
  });

  it('多图总大小超限：直接回错误（单张都合法也要拦）', async () => {
    const c = await connect();
    // 每张 2.2MB（低于单张 3MB 上限），三张合计 6.6MB 超过 6MB 总量上限。
    // 张数刻意取 3 而不是 4：总量必须落在 (总量上限, maxHttpBufferSize) 这个
    // 区间里，超出 buffer 的 payload 会被 socket.io 在传输层直接丢掉，我们
    // 自己的校验根本不会执行，测的就不是这条规则了（第一版写 4×2.5MB=10MB
    // 就是这样超时的）。
    const big = Array.from({ length: 3 }, () => ({ base64: 'x'.repeat(2_200_000), mimeType: 'image/png' }));
    const res = await emitWithAck(c, 'feedback:submit', { text: '三张大图', images: big });
    expect(res.error).toBeTruthy();
    expect(fakeReporter.createFeedbackIssue).not.toHaveBeenCalled();
  });

  it('文字为空/只有空白：直接回错误，不调用 createFeedbackIssue', async () => {
    const c = await connect();
    const res = await emitWithAck(c, 'feedback:submit', { text: '   ' });
    expect(res.error).toBeTruthy();
    expect(fakeReporter.createFeedbackIssue).not.toHaveBeenCalled();
  });

  it('文字超过 2000 字：直接回错误，不调用 createFeedbackIssue', async () => {
    const c = await connect();
    const res = await emitWithAck(c, 'feedback:submit', { text: 'x'.repeat(2001) });
    expect(res.error).toBeTruthy();
    expect(fakeReporter.createFeedbackIssue).not.toHaveBeenCalled();
  });

  it('图片 base64 超过大小上限：直接回错误，不调用 createFeedbackIssue', async () => {
    const c = await connect();
    const res = await emitWithAck(c, 'feedback:submit', {
      text: '图太大',
      image: { base64: 'x'.repeat(3_000_001), mimeType: 'image/png' },
    });
    expect(res.error).toBeTruthy();
    expect(fakeReporter.createFeedbackIssue).not.toHaveBeenCalled();
  });

  it('isConfigured() 返回 false（没配 token）：直接回错误，不调用 createFeedbackIssue', async () => {
    fakeReporter.isConfigured = vi.fn(() => false);
    const c = await connect();
    const res = await emitWithAck(c, 'feedback:submit', { text: '正常反馈' });
    expect(res.error).toBeTruthy();
    expect(fakeReporter.createFeedbackIssue).not.toHaveBeenCalled();
  });

  it('createFeedbackIssue 抛错：回调 { error }，不让异常冒泡把 socket 断掉', async () => {
    fakeReporter.createFeedbackIssue = vi.fn(async () => { throw new Error('GitHub 502'); });
    const c = await connect();
    const res = await emitWithAck(c, 'feedback:submit', { text: '正常反馈' });
    expect(res.error).toBeTruthy();
    expect(c.connected).toBe(true);
  });
});

// 反馈进展可见 + 批注（2026-08-12，用户反馈）
describe('feedback:list', () => {
  it('正常调用：透传 listFeedbackWithComments 的结果', async () => {
    const c = await connect();
    const res = await emitWithAck(c, 'feedback:list');
    expect(fakeReporter.listFeedbackWithComments).toHaveBeenCalled();
    expect(res).toEqual({
      ok: true,
      issues: [{ number: 23, title: '断线问题', body: '正文', state: 'closed', labels: ['feedback'], createdAt: 't1', url: 'u1', comments: [] }],
    });
  });

  it('isConfigured() 返回 false：直接回错误，不调用 listFeedbackWithComments', async () => {
    fakeReporter.isConfigured = vi.fn(() => false);
    const c = await connect();
    const res = await emitWithAck(c, 'feedback:list');
    expect(res.error).toBeTruthy();
    expect(fakeReporter.listFeedbackWithComments).not.toHaveBeenCalled();
  });

  it('listFeedbackWithComments 抛错：回调 { error }，不让异常冒泡把 socket 断掉', async () => {
    fakeReporter.listFeedbackWithComments = vi.fn(async () => { throw new Error('GitHub 502'); });
    const c = await connect();
    const res = await emitWithAck(c, 'feedback:list');
    expect(res.error).toBeTruthy();
    expect(c.connected).toBe(true);
  });
});

