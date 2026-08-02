# 用户反馈系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Task 6 is NOT a code task** — it uses a session-level scheduling tool (`RemoteTrigger`), not a git diff, and must be executed directly by whoever is orchestrating this plan (not dispatched to an implementer subagent).

**Goal:** Let players submit text+image feedback from the site, store it durably as GitHub Issues (Render's free tier has no persistent disk), triage it against the product's actual positioning on a recurring schedule, auto-fix unambiguous bugs, and show a player-facing changelog on the homepage.

**Architecture:** A new `server/feedbackReporter.js` module wraps the GitHub REST API (Issues + Contents) behind two functions; a new Socket.IO event (`feedback:submit`) in `server/index.js` calls it. Client side, a shared `FeedbackModal` component (client-side image compression via canvas) is wired into both `HomePage.jsx` (idle) and `GameTable.jsx`'s existing hamburger menu (in-game), matching the app's existing `LedgerModal`/`HandHistoryModal` prop-drilling pattern. A static `client/src/changelog.json`, shipped with the code, backs a read-only `ChangelogModal` shown from the homepage. A `RemoteTrigger` (durable, account-level — not session-scoped, unlike `CronCreate`) wakes a fresh Claude session daily to triage open `feedback`-labeled issues.

**Tech Stack:** Node 20+ global `fetch` (no new dependency) for the GitHub API calls; existing Socket.IO transport for submission (no `multer`/multipart — image goes over the socket as base64, matching how this app already avoids REST file uploads); React + `<canvas>` for client-side image compression; vitest with the same injectable-dependency pattern already used by `PveSession` (`strategy`/`store` params) for testing `feedbackReporter` without hitting the real GitHub API.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-02-user-feedback-system-design.md` — every requirement in this plan traces back to a section there.
- Render free tier has no persistent disk — feedback data MUST live in GitHub Issues, never in a local file (see spec background section).
- Fully anonymous submission — no name/id field, ever.
- Auto-fix is allowed ONLY for issues satisfying all four conditions in the spec's Section 3 (bug category, clear repro, no product/visual/AI-style decision involved, small diff) — this is a judgment call made by whoever is running the periodic triage, not something to hard-code as an automated check.
- `design`/`off-topic` issues are never auto-fixed — they get a triage comment and stay open for a real conversation.
- Commit messages in English (project convention, `CLAUDE.md`). SDD: `openspec/changes/online-texas-holdem/tasks.md`/`design.md` get a new entry for this feature (Task 7 below).
- GitHub token: `FEEDBACK_GITHUB_TOKEN` env var (Render), never committed. Target repo: `Reyes324/velvet-room-poker` (constant, overridable via `FEEDBACK_GITHUB_REPO` env var for testing/forks).

---

### Task 1: `feedbackReporter.js` — GitHub Issue creation module

**Files:**
- Create: `server/feedbackReporter.js`
- Test: `server/__tests__/feedbackReporter.test.js`

**Interfaces:**
- Produces: `isConfigured(): boolean`, `createFeedbackIssue({ text, image }, { fetchImpl?, token?, repo? } = {}): Promise<{ issueNumber: number, issueUrl: string }>` where `image` is `{ base64: string, mimeType: string } | null`. Throws on missing token, empty text, unsupported image mime type, or a non-ok GitHub response.
- Consumes: nothing from other tasks (this is the base module).

- [ ] **Step 1: Write the failing tests**

```javascript
// server/__tests__/feedbackReporter.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createFeedbackIssue, isConfigured } = require('../feedbackReporter');

function fakeResponse(ok, status, jsonBody) {
  return { ok, status, json: async () => jsonBody };
}

describe('feedbackReporter — isConfigured', () => {
  it('返回 false 当 token 没配置', () => {
    expect(isConfigured({ token: undefined })).toBe(false);
  });
  it('返回 true 当 token 存在', () => {
    expect(isConfigured({ token: 'ghp_fake' })).toBe(true);
  });
});

describe('feedbackReporter — createFeedbackIssue', () => {
  const token = 'ghp_fake_token';
  const repo = 'someone/somerepo';

  it('没有 token 时直接抛错，不发请求', async () => {
    const fetchImpl = vi.fn();
    await expect(createFeedbackIssue({ text: '有问题' }, { fetchImpl, token: undefined, repo }))
      .rejects.toThrow(/FEEDBACK_GITHUB_TOKEN/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('text 是空字符串（或只有空白）时抛错，不发请求', async () => {
    const fetchImpl = vi.fn();
    await expect(createFeedbackIssue({ text: '   ' }, { fetchImpl, token, repo }))
      .rejects.toThrow(/反馈内容/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('无图片：只调用一次 Issues API，body 里带文字，没有图片 markdown', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      fakeResponse(true, 201, { number: 42, html_url: 'https://github.com/x/y/issues/42' })
    );
    const result = await createFeedbackIssue({ text: '结算的时候少算了一个底池' }, { fetchImpl, token, repo });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://api.github.com/repos/${repo}/issues`);
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe(`Bearer ${token}`);
    const body = JSON.parse(opts.body);
    expect(body.labels).toEqual(['feedback']);
    expect(body.body).toContain('结算的时候少算了一个底池');
    expect(body.body).not.toContain('![');
    expect(result).toEqual({ issueNumber: 42, issueUrl: 'https://github.com/x/y/issues/42' });
  });

  it('带图片：先调 Contents API 上传，再调 Issues API，body 里带图片 markdown 用的是返回的 download_url', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(fakeResponse(true, 201, {
        content: { download_url: 'https://raw.githubusercontent.com/x/y/main/feedback-attachments/abc.png' },
      }))
      .mockResolvedValueOnce(fakeResponse(true, 201, { number: 43, html_url: 'https://github.com/x/y/issues/43' }));

    const result = await createFeedbackIssue(
      { text: '气泡卡住了', image: { base64: 'ZmFrZQ==', mimeType: 'image/png' } },
      { fetchImpl, token, repo },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [contentsUrl, contentsOpts] = fetchImpl.mock.calls[0];
    expect(contentsUrl).toMatch(new RegExp(`^https://api.github.com/repos/${repo}/contents/feedback-attachments/.+\\.png$`));
    expect(contentsOpts.method).toBe('PUT');
    expect(JSON.parse(contentsOpts.body).content).toBe('ZmFrZQ==');

    const [, issueOpts] = fetchImpl.mock.calls[1];
    const issueBody = JSON.parse(issueOpts.body);
    expect(issueBody.body).toContain('https://raw.githubusercontent.com/x/y/main/feedback-attachments/abc.png');
    expect(result.issueNumber).toBe(43);
  });

  it('不支持的图片格式直接抛错，不发任何请求', async () => {
    const fetchImpl = vi.fn();
    await expect(createFeedbackIssue(
      { text: '文字', image: { base64: 'ZmFrZQ==', mimeType: 'image/gif' } },
      { fetchImpl, token, repo },
    )).rejects.toThrow(/不支持的图片格式/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('GitHub API 返回非 2xx 时抛错，错误信息带状态码', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(false, 422, { message: 'Validation Failed' }));
    await expect(createFeedbackIssue({ text: '文字' }, { fetchImpl, token, repo }))
      .rejects.toThrow(/422/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run __tests__/feedbackReporter.test.js`
Expected: FAIL — `Cannot find module '../feedbackReporter'`

- [ ] **Step 3: Write the implementation**

```javascript
// server/feedbackReporter.js
// GitHub Issue 作为反馈存储层——Render 免费档没有持久化磁盘，本地文件在
// 每次 git push 触发的重新部署时都会被清空重置（这正是"人机对战牌局重
// 置"那个 bug 的根因）。见 docs/superpowers/specs/2026-08-02-user-feedback-
// system-design.md 的"关键约束"一节。fetchImpl/token/repo 都可注入，跟
// PveSession 的 strategy/store 参数是同一个"方便测试、不用真的打
// GitHub"的模式。

const API_BASE = 'https://api.github.com';
const DEFAULT_REPO = 'Reyes324/velvet-room-poker';

// 只接受这几种格式——限制格式既是安全考虑（不接受任意扩展名拼进 URL 路
// 径），也是因为浏览器 canvas.toBlob 只会产出这几种。
const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

function isConfigured({ token = process.env.FEEDBACK_GITHUB_TOKEN } = {}) {
  return Boolean(token);
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };
}

async function uploadImage({ base64, mimeType }, { fetchImpl, token, repo }) {
  const ext = EXT_BY_MIME[mimeType];
  if (!ext) throw new Error(`不支持的图片格式: ${mimeType}`);
  const filename = `feedback-attachments/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const res = await fetchImpl(`${API_BASE}/repos/${repo}/contents/${filename}`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify({ message: `feedback: add attachment ${filename}`, content: base64 }),
  });
  if (!res.ok) throw new Error(`图片上传失败（GitHub ${res.status}）`);
  const data = await res.json();
  return data.content.download_url;
}

async function createFeedbackIssue(
  { text, image = null },
  { fetchImpl = fetch, token = process.env.FEEDBACK_GITHUB_TOKEN, repo = process.env.FEEDBACK_GITHUB_REPO || DEFAULT_REPO } = {},
) {
  if (!token) throw new Error('FEEDBACK_GITHUB_TOKEN 未配置');
  const trimmed = (text || '').trim();
  if (!trimmed) throw new Error('缺少反馈内容');

  let imageMarkdown = '';
  if (image) {
    const downloadUrl = await uploadImage(image, { fetchImpl, token, repo });
    imageMarkdown = `\n\n![反馈图片](${downloadUrl})`;
  }

  const title = trimmed.slice(0, 60).replace(/\n/g, ' ');
  const body = `${trimmed}${imageMarkdown}`;
  const res = await fetchImpl(`${API_BASE}/repos/${repo}/issues`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ title, body, labels: ['feedback'] }),
  });
  if (!res.ok) throw new Error(`GitHub Issue 创建失败（${res.status}）`);
  const data = await res.json();
  return { issueNumber: data.number, issueUrl: data.html_url };
}

module.exports = { createFeedbackIssue, isConfigured };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run __tests__/feedbackReporter.test.js`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add server/feedbackReporter.js server/__tests__/feedbackReporter.test.js
git commit -m "feat: add GitHub-Issue-backed feedback reporter module"
```

---

### Task 2: Wire `feedback:submit` into `server/index.js`

**Files:**
- Modify: `server/index.js` (the `createServer()` function signature and its `io.on('connection', ...)` block)
- Test: `server/__tests__/feedback.integration.test.js`

**Interfaces:**
- Consumes: `feedbackReporter.isConfigured()`, `feedbackReporter.createFeedbackIssue({ text, image })` from Task 1.
- Produces: socket event `feedback:submit` — client emits `{ text, image }` (`image` optional, `{ base64, mimeType } | undefined`) with an ack callback; server calls back `{ ok: true, issueUrl }` or `{ error: string }`. `createServer({ feedbackReporter } = {})` now accepts an injectable reporter (defaults to `require('./feedbackReporter')`) for tests — same DI shape `PveSession` already uses for `strategy`/`store`.

- [ ] **Step 1: Write the failing tests**

```javascript
// server/__tests__/feedback.integration.test.js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run __tests__/feedback.integration.test.js`
Expected: FAIL — `feedback:submit` handler doesn't exist yet, all acks time out/are undefined, or `createServer({ feedbackReporter })` option is ignored (real module gets required instead, `isConfigured` on real module returns false in test env since `FEEDBACK_GITHUB_TOKEN` isn't set, and `fakeReporter.createFeedbackIssue` is never called).

- [ ] **Step 3: Implement**

In `server/index.js`, change the factory signature (near the top, `function createServer() {`):

```javascript
function createServer({ feedbackReporter = require('./feedbackReporter') } = {}) {
```

Add near the other top-of-file constants (alongside `VALID_SEAT_COUNTS`):

```javascript
const FEEDBACK_MAX_TEXT_LENGTH = 2000;
const FEEDBACK_MAX_IMAGE_BASE64_LENGTH = 3_000_000; // ~2.25MB decoded; client compresses to ~2MB target
```

Inside `io.on('connection', (socket) => { ... })`, add (a natural neighbor for `room:peek`/`pve:peek` — same "read-only-ish, no session state" flavor):

```javascript
// 反馈入口——用户反馈（2026-08-02）："能不能直接在网页上提供一个类似
// 问题反馈的入口"。存储层是 GitHub Issue，不是本地文件，见
// server/feedbackReporter.js 顶部注释里的持久化约束说明。
socket.on('feedback:submit', async ({ text, image } = {}, callback) => {
  if (!feedbackReporter.isConfigured()) {
    return callback?.({ error: '反馈服务暂时不可用，请稍后再试' });
  }
  const trimmed = (text || '').trim();
  if (!trimmed) return callback?.({ error: '请输入反馈内容' });
  if (trimmed.length > FEEDBACK_MAX_TEXT_LENGTH) {
    return callback?.({ error: `反馈内容太长（最多 ${FEEDBACK_MAX_TEXT_LENGTH} 字）` });
  }
  if (image && (typeof image.base64 !== 'string' || image.base64.length > FEEDBACK_MAX_IMAGE_BASE64_LENGTH)) {
    return callback?.({ error: '图片太大，请压缩后再试' });
  }
  try {
    const { issueUrl } = await feedbackReporter.createFeedbackIssue({ text: trimmed, image: image || null });
    callback?.({ ok: true, issueUrl });
  } catch (e) {
    callback?.({ error: '提交失败，请稍后再试' });
  }
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run __tests__/feedback.integration.test.js`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Run the full server suite to confirm no regressions**

Run: `cd server && npx vitest run`
Expected: PASS (all previously-passing tests still pass; the project has 2 known pre-existing flaky tests in `integration.test.js`/`reconnect.test.js` under full-suite concurrent load — confirm any failure is one of those specific two by re-running just that file alone before treating it as a real regression).

- [ ] **Step 6: Commit**

```bash
git add server/index.js server/__tests__/feedback.integration.test.js
git commit -m "feat: wire feedback:submit socket event into the server"
```

---

### Task 3: Client image compression utility

**Files:**
- Create: `client/src/utils/compressImage.js`

**Interfaces:**
- Produces: `compressImage(file: File, { maxDim?: number, quality?: number } = {}): Promise<{ base64: string, mimeType: string }>` — resizes so the longer edge is at most `maxDim` (default 1600), re-encodes as JPEG at `quality` (default 0.8) via canvas, returns the base64 payload (no `data:...;base64,` prefix) and the mime type used. Rejects the promise if `file` isn't decodable as an image.
- Consumes: nothing from other tasks — pure browser utility, no dependency on Task 1/2's server code.

This task has no automated test (no client test framework in this project — see `CLAUDE.md`/session history: client correctness is verified via build + Playwright/manual browser checks, same as every other client change this session). It gets exercised end-to-end in Task 4's manual verification step.

- [ ] **Step 1: Implement**

```javascript
// client/src/utils/compressImage.js
// 反馈图片在真的发去服务器（转成 GitHub Issue 附件）之前先在浏览器里压
// 缩——见 docs/superpowers/specs/2026-08-02-user-feedback-system-design.md
// Section 1：长边压到 1600px 以内、控制在 2MB 左右，跟服务端
// FEEDBACK_MAX_IMAGE_BASE64_LENGTH 的上限留出安全余量，不是靠服务端拒绝
// 来把关。
export function compressImage(file, { maxDim = 1600, quality = 0.8 } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => {
          if (!blob) return reject(new Error('图片压缩失败'));
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result; // "data:image/jpeg;base64,...."
            const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
            resolve({ base64, mimeType: 'image/jpeg' });
          };
          reader.onerror = () => reject(new Error('图片读取失败'));
          reader.readAsDataURL(blob);
        },
        'image/jpeg',
        quality,
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('无法读取这张图片'));
    };
    img.src = objectUrl;
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/utils/compressImage.js
git commit -m "feat: add client-side image compression utility for feedback uploads"
```

---

### Task 4: `FeedbackModal` component + wiring into `HomePage.jsx` and `GameTable.jsx`

**Files:**
- Create: `client/src/components/FeedbackModal.jsx`
- Create: `client/src/components/FeedbackModal.css`
- Modify: `client/src/pages/HomePage.jsx`, `client/src/pages/HomePage.css`
- Modify: `client/src/components/GameTable.jsx`
- Modify: `client/src/pages/RoomPage.jsx`
- Modify: `client/src/pages/PvePage.jsx`

**Interfaces:**
- Consumes: `compressImage` from Task 3; emits socket event `feedback:submit` from Task 2 (via the existing `useSocket` hook's exposed raw `socket`, same pattern `HomePage.jsx` already uses for `room:peek`/`pve:peek` — `socket.emit(event, payload, callback)`, not the hook's simplified `emit()` which has no ack support).
- Produces: `<FeedbackModal onClose={fn} />` — self-contained, no other props needed (fully anonymous, no player id/name passed in).

- [ ] **Step 1: Implement `FeedbackModal.jsx`**

```jsx
// client/src/components/FeedbackModal.jsx
import { useState } from 'react';
import { useSocket } from '../hooks/useSocket';
import { compressImage } from '../utils/compressImage';
import './FeedbackModal.css';

const MAX_TEXT_LENGTH = 2000;

export default function FeedbackModal({ onClose }) {
  const { socket } = useSocket({});
  const [text, setText] = useState('');
  const [imagePreview, setImagePreview] = useState(null); // object URL, for on-screen preview only
  const [imagePayload, setImagePayload] = useState(null); // { base64, mimeType }, actually sent
  const [status, setStatus] = useState('idle'); // idle | submitting | done | error
  const [error, setError] = useState('');

  async function handleImageChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    try {
      const compressed = await compressImage(file);
      setImagePayload(compressed);
      setImagePreview(URL.createObjectURL(file));
    } catch {
      setError('这张图片没法上传，换一张试试');
    }
  }

  function handleSubmit() {
    if (!text.trim()) return setError('请输入反馈内容');
    setStatus('submitting');
    setError('');
    socket.emit('feedback:submit', { text: text.trim(), image: imagePayload }, (res) => {
      if (res?.error) {
        setStatus('error');
        setError(res.error);
        return;
      }
      setStatus('done');
    });
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal feedback-modal" onClick={(e) => e.stopPropagation()}>
        {status === 'done' ? (
          <>
            <div className="modal-title">已收到，谢谢反馈！</div>
            <div className="modal-btn" onClick={onClose}>关闭</div>
          </>
        ) : (
          <>
            <div className="modal-title">问题反馈</div>
            <textarea
              className="feedback-textarea"
              placeholder="说说遇到的问题或想法…"
              value={text}
              maxLength={MAX_TEXT_LENGTH}
              onChange={(e) => setText(e.target.value)}
            />
            <label className="feedback-image-picker">
              {imagePreview ? <img src={imagePreview} alt="预览" className="feedback-image-preview" /> : '+ 上传图片（可选）'}
              <input type="file" accept="image/*" onChange={handleImageChange} hidden />
            </label>
            {error && <p className="home-error">{error}</p>}
            <div className="modal-btns">
              <div className="modal-btn modal-btn--secondary" onClick={onClose}>取消</div>
              <div
                className={`modal-btn${status === 'submitting' ? ' modal-btn--waiting' : ''}`}
                onClick={status === 'submitting' ? undefined : handleSubmit}
              >
                {status === 'submitting' ? '提交中…' : '提交'}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Implement `FeedbackModal.css`**

```css
/* client/src/components/FeedbackModal.css */
.feedback-modal {
  text-align: left;
  max-width: 360px;
}
.feedback-textarea {
  width: 100%;
  min-height: 100px;
  box-sizing: border-box;
  background: rgba(255,255,255,.04);
  border: 1px solid rgba(255,255,255,.1);
  border-radius: var(--r-md);
  color: var(--text-primary);
  font-family: var(--font-body);
  font-size: 15px;
  padding: 12px;
  margin: var(--sp-3) 0;
  resize: vertical;
}
.feedback-textarea:focus {
  outline: none;
  border-color: rgba(212,175,55,.4);
}
.feedback-image-picker {
  display: block;
  text-align: center;
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text-muted);
  border: 1px dashed rgba(255,255,255,.15);
  border-radius: var(--r-md);
  padding: 12px;
  margin-bottom: var(--sp-3);
  cursor: pointer;
}
.feedback-image-preview {
  max-width: 100%;
  max-height: 160px;
  border-radius: var(--r-sm);
}
```

- [ ] **Step 3: Add the entry point in `HomePage.jsx`**

Add state and render, next to the existing `home-refresh-link` (same visual tier — see that element's own comment for why it's placed outside `mode`-conditional rendering):

```javascript
// near the other useState declarations
const [showFeedback, setShowFeedback] = useState(false);
```

```jsx
{/* 问题反馈入口——用户反馈（2026-08-02）"要不要在网页上提供反馈入
    口"，跟 home-refresh-link 同一视觉层级，不受 mode 影响，任何界面
    状态下都能点到。 */}
<div className="home-feedback-link" onClick={() => setShowFeedback(true)}>问题反馈</div>
{showFeedback && <FeedbackModal onClose={() => setShowFeedback(false)} />}
```

Import at the top of `HomePage.jsx`:

```javascript
import FeedbackModal from '../components/FeedbackModal';
```

In `HomePage.css`, near `.home-refresh-link`:

```css
.home-feedback-link {
  position: absolute;
  top: max(env(safe-area-inset-top, 0px), var(--sp-4));
  left: var(--sp-4);
  z-index: 1;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-muted);
  cursor: pointer;
}
.home-feedback-link:active { opacity: .6; }
```

- [ ] **Step 4: Add the entry point in `GameTable.jsx`'s hamburger menu**

`GameTable` already takes `onOpenLedger`/`onOpenHandHistory` props and renders `menu-row` items for them (see the existing `showMenu` block). Add a matching prop and row:

In the function signature, add `onOpenFeedback` alongside the other `onOpen*` props:

```javascript
export default function GameTable({ gameState, myId, roomCode, showdown, onAction, actionDisabled, onExit, amPlaying = true, myChips = 0, onRebuy, onOpenLedger, onOpenHandHistory, onOpenStats, onOpenFeedback, onPoke, pokedSeat, settlementOpen = false, revealedPlayers = {}, isHost = false, onEndGame, gameTimerEndsAt = null }) {
```

In the menu's JSX, add a row next to `账本`/`牌局记录` (before the danger-styled rows):

```jsx
<div className="menu-row" onClick={() => { setShowMenu(false); onOpenFeedback?.(); }}>问题反馈</div>
```

- [ ] **Step 5: Wire the prop + local modal state in `RoomPage.jsx`**

Add local state (near the other `show*` states):

```javascript
const [showFeedback, setShowFeedback] = useState(false);
```

Pass the prop into `<GameTable ... onOpenFeedback={() => setShowFeedback(true)} />`, and render the modal alongside the other conditionally-rendered modals in the "Game Table" return block:

```jsx
{showFeedback && <FeedbackModal onClose={() => setShowFeedback(false)} />}
```

Import at the top: `import FeedbackModal from '../components/FeedbackModal';`

- [ ] **Step 6: Wire the same prop + state in `PvePage.jsx`**

Same pattern — add `showFeedback` state, `onOpenFeedback={() => setShowFeedback(true)}` on `<GameTable>`, `{showFeedback && <FeedbackModal onClose={() => setShowFeedback(false)} />}` in the render, and the import.

- [ ] **Step 7: Build and manually verify in a real browser**

```bash
cd client && npm run build
```

Start the server (`node server/index.js` from repo root) and, without a real `FEEDBACK_GITHUB_TOKEN` set, use Playwright (or the Chrome extension tools) against `http://localhost:3001` to:
1. Click "问题反馈" on the homepage, type text, submit — confirm the UI shows the server's `{ error: '反馈服务暂时不可用，请稍后再试' }` (expected, since no token is configured locally) rather than crashing or hanging.
2. Start a PVE game, open the hamburger menu, confirm "问题反馈" appears and opens the same modal.
3. Confirm the image picker accepts a file and shows a preview before submitting.

Real end-to-end verification against a real GitHub repo (actually creating an Issue) happens once `FEEDBACK_GITHUB_TOKEN` is configured on Render post-deploy — not something to fake locally by hand-editing `.env`, since that would require a real token with write access to the actual `Reyes324/velvet-room-poker` repo.

- [ ] **Step 8: Commit**

```bash
git add client/src/components/FeedbackModal.jsx client/src/components/FeedbackModal.css client/src/pages/HomePage.jsx client/src/pages/HomePage.css client/src/components/GameTable.jsx client/src/pages/RoomPage.jsx client/src/pages/PvePage.jsx
git commit -m "feat: add feedback submission entry points to homepage and in-game menu"
```

---

### Task 5: Changelog file + `ChangelogModal` + homepage entry

**Files:**
- Create: `client/src/changelog.json`
- Create: `client/src/components/ChangelogModal.jsx`
- Modify: `client/src/pages/HomePage.jsx`, `client/src/pages/HomePage.css`

**Interfaces:**
- Produces: `client/src/changelog.json` — array of `{ date: "YYYY-MM-DD", text: string }`, newest first. `<ChangelogModal onClose={fn} />` — reads the JSON, renders it as a list, no other props.
- Consumes: nothing from other tasks (independent of Tasks 1-4; could be done first or in parallel, sequenced last here only because it's lower-priority than getting submission working).

- [ ] **Step 1: Seed the changelog data**

```json
[
  { "date": "2026-08-02", "text": "新增：问题反馈入口——现在可以直接在网页上提交问题或想法，还能附一张截图" },
  { "date": "2026-08-02", "text": "新增：这个更新日志，方便随时看到最近改了什么" }
]
```

- [ ] **Step 2: Implement `ChangelogModal.jsx`**

```jsx
// client/src/components/ChangelogModal.jsx
import changelog from '../changelog.json';

export default function ChangelogModal({ onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal changelog-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">最近更新</div>
        <div className="changelog-list">
          {changelog.map((entry, i) => (
            <div key={i} className="changelog-entry">
              <div className="changelog-date">{entry.date}</div>
              <div className="changelog-text">{entry.text}</div>
            </div>
          ))}
        </div>
        <div className="modal-btn" onClick={onClose}>关闭</div>
      </div>
    </div>
  );
}
```

Add matching styles to `HomePage.css` (reuses `.modal`/`.modal-overlay`/`.modal-title`/`.modal-btn` already defined globally for the other modals in this app):

```css
.changelog-modal { text-align: left; max-width: 360px; }
.changelog-list { max-height: 50vh; overflow-y: auto; margin: var(--sp-3) 0; }
.changelog-entry { padding: var(--sp-2) 0; border-bottom: 1px solid rgba(255,255,255,.06); }
.changelog-entry:last-child { border-bottom: none; }
.changelog-date { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); }
.changelog-text { font-family: var(--font-body); font-size: 14px; color: var(--text-primary); margin-top: 2px; }
```

- [ ] **Step 3: Add the entry point in `HomePage.jsx`**

```javascript
const [showChangelog, setShowChangelog] = useState(false);
```

```jsx
<div className="home-changelog-link" onClick={() => setShowChangelog(true)}>最近更新</div>
{showChangelog && <ChangelogModal onClose={() => setShowChangelog(false)} />}
```

Import: `import ChangelogModal from '../components/ChangelogModal';`

In `HomePage.css`, placed next to `.home-feedback-link` (same left-side stack, feedback above changelog):

```css
.home-changelog-link {
  position: absolute;
  top: calc(max(env(safe-area-inset-top, 0px), var(--sp-4)) + 22px);
  left: var(--sp-4);
  z-index: 1;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-muted);
  cursor: pointer;
}
.home-changelog-link:active { opacity: .6; }
```

- [ ] **Step 4: Build and manually verify**

```bash
cd client && npm run build
```

Use Playwright (or the Chrome extension tools) against the running server: click "最近更新" on the homepage, confirm both seed entries render with their dates, newest first, and the modal closes cleanly.

- [ ] **Step 5: Commit**

```bash
git add client/src/changelog.json client/src/components/ChangelogModal.jsx client/src/pages/HomePage.jsx client/src/pages/HomePage.css
git commit -m "feat: add player-facing changelog display to homepage"
```

---

### Task 6: Daily triage trigger (NOT a code task — executed directly, not dispatched)

**Why this task is different:** every other task in this plan produces a git diff a fresh implementer subagent can write and a reviewer can review. This task configures a *session-level scheduling mechanism* — there's nothing to diff or review in the repo. Whoever is running this plan (the orchestrator, not a dispatched implementer) does this step directly, after Tasks 1-5 are merged and deployed (the trigger's prompt references live behavior — labeling issues, checking test suites — that only makes sense once the feedback submission path is actually live).

**Important correction from the design doc:** the spec's Section 3 says "用这个环境自带的定时唤醒能力" without naming a specific mechanism. `CronCreate` (session-scoped, jobs vanish when the session ends, recurring jobs auto-expire after 7 days regardless) is **not** durable enough for "every day, indefinitely." Use `RemoteTrigger` instead (`action: "create"`) — it's an account-level scheduled routine on claude.ai, not tied to any one conversation's lifetime, which is what "每天一次" in the approved design actually requires.

- [ ] **Step 1: Inspect the RemoteTrigger API shape before guessing field names**

`RemoteTrigger`'s tool description documents the actions but not the exact `create` body schema. Call `RemoteTrigger` with `action: "list"` first to see any existing triggers' shape (field names, cron format) as a concrete reference before constructing the `create` call — don't invent field names from the design doc's prose.

- [ ] **Step 2: Create the trigger**

Call `RemoteTrigger` with `action: "create"` and a body whose prompt instructs the woken session to:
1. Use `gh issue list --repo Reyes324/velvet-room-poker --label feedback --state open` to find untriaged feedback.
2. For each: read it, classify against the product positioning in `docs/superpowers/specs/2026-08-02-user-feedback-system-design.md` Section 2 (bug / design / off-topic, accepted / wontfix), and post a `gh issue comment` explaining the call.
3. Only if ALL FOUR conditions in that spec's Section 3 hold (bug category, clear repro, no product/visual/AI-style decision, small diff) — fix it following this project's normal root-cause-first + test-then-commit workflow (see `CLAUDE.md`), reference the issue number in the commit message, comment on and close the issue.
4. Append one player-facing line to `client/src/changelog.json` for anything actually shipped this run (matches the shape already seeded in Task 5).
5. Push only what's actually tested and green — same standing rule as every other commit in this project.

Schedule: once daily, at an off-the-hour minute (per `RemoteTrigger`/cron conventions elsewhere in this environment — avoid `:00`/`:30`).

- [ ] **Step 3: Confirm with the user**

Relay the created trigger's parsed run time and its claude.ai URL back to the user (the `RemoteTrigger create` response includes both per the tool's own description) so they can confirm the schedule looks right.

---

### Task 7: SDD documentation

**Files:**
- Modify: `openspec/changes/online-texas-holdem/tasks.md`
- Modify: `docs/superpowers/specs/2026-08-02-user-feedback-system-design.md` (only if implementation surfaced a real deviation from the approved design — e.g., the `RemoteTrigger` vs `CronCreate` correction in Task 6 — note it there too, not just in the plan)

- [ ] **Step 1: Add a new numbered entry to `tasks.md`**

Follow the exact style of the existing `69.x` entries in that file (one bullet per shipped increment, English/Chinese mixed matching the file's existing convention, referencing the design doc path, noting test counts). Cover: the GitHub-Issue storage decision and why (Render has no persistent disk), the submission entry points, the changelog display, and the `RemoteTrigger`-not-`CronCreate` correction for the daily trigger.

- [ ] **Step 2: Commit**

```bash
git add openspec/changes/online-texas-holdem/tasks.md docs/superpowers/specs/2026-08-02-user-feedback-system-design.md
git commit -m "docs: record user feedback system in SDD tasks"
```

---

## Post-implementation: token setup reminder

Task 1's `feedbackReporter.isConfigured()` returning `false` locally (no `FEEDBACK_GITHUB_TOKEN` in the dev environment) is expected and already handled gracefully (Task 2's tests cover it). The feature is fully dead — cleanly, with a user-facing error, not a crash — until the user follows the token-generation steps already relayed earlier in this conversation and sets `FEEDBACK_GITHUB_TOKEN` in Render's environment variables. This is a manual, account-level step outside this plan's scope (nothing in this plan can or should do it on the user's behalf).
