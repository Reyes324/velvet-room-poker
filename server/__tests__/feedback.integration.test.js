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
    expect(fakeReporter.createFeedbackIssue).toHaveBeenCalledWith({ text: '结算算错了', image: null });
    expect(res).toEqual({ ok: true, issueUrl: 'https://github.com/x/y/issues/7' });
  });

  it('带图片提交：image 原样透传给 createFeedbackIssue', async () => {
    const c = await connect();
    const image = { base64: 'ZmFrZQ==', mimeType: 'image/png' };
    await emitWithAck(c, 'feedback:submit', { text: '截图见附件', image });
    expect(fakeReporter.createFeedbackIssue).toHaveBeenCalledWith({ text: '截图见附件', image });
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
