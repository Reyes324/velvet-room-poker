# 暂停/继续功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让任意坐位玩家能立刻暂停/恢复对局——暂停会真正冻结当前正在进行的回合倒计时（而不是等到下一手边界），恢复后从暂停时剩余的时间继续走。

**Architecture:** 服务端在 `Room`（`server/RoomManager.js`）上加一个权威的 `paused` 布尔字段，配合 `pauseRemainingMs`/`pausedActionPlayerId` 两个辅助字段记录"暂停时冻结了谁的多少剩余时间"。两个新 socket 事件 `room:pause`/`room:resume`（`server/index.js`）分别负责冻结（清掉计时器、记剩余时间）和解冻（用记下来的剩余时间重新调用已有的 `startTurnClock`/`scheduleTurnExpiry`，不新增计时基础设施）。关键的一处既有代码改动：`maybeArmTurnClock` 必须在最前面加一道 `room.paused` 短路，否则 `broadcastRoom` 里对它的常规调用会在暂停期间把计时器重新点起来，直接抵消暂停——这是本计划里最容易遗漏、也是唯一动到既有函数行为的地方。客户端在 `GameTable.jsx` 顶部加一个暂停/继续按钮 + 暂停态遮罩，`ActionBar` 复用已有的 `disabled` prop 在暂停时整体隐藏。

**Tech Stack:** Node.js + Socket.IO（服务端，`server/index.js` + `server/RoomManager.js`），React（客户端，`client/src/`），Vitest（服务端测试），Playwright（e2e）。

## Global Constraints

- 服务端是唯一真相来源：客户端隐藏按钮/遮罩只是体验层，`RoomManager.playerAction` 必须在数据层也拒绝暂停期间的行动，两层防御缺一不可（design.md 决策已定）。
- 不新增计时基础设施——恢复时复用现成的 `startTurnClock(playerId, baseMs)` / `scheduleTurnExpiry(room, playerId, endsAt)`，只是把 `baseMs` 换成剩余毫秒数。
- 不做自动恢复超时、不做暂停原因留言、不扩展给旁观者权限——这三条在 spec 里明确标为本轮不做，任何任务都不应该悄悄加回来。
- 只有坐位玩家（`room.players` 里 `!left` 的成员）能触发暂停/继续，服务端和客户端都要拦。
- 每个任务完成后跑一次相关测试 + `cd client && npm run build` / `npx eslint .`（对照当前 `main` 基线 39 problems / 30 errors，不能变多）确认没有回归，再提交。

---

## File Structure

| File | 改动 |
|---|---|
| `server/RoomManager.js` | `Room` 构造函数加 `this.paused`/`this.pauseRemainingMs`/`this.pausedActionPlayerId`；`playerAction()` 顶部加暂停拒绝；`getLobbyState()` 暴露 `paused` 字段 |
| `server/index.js` | `maybeArmTurnClock` 顶部加暂停短路；新增 `room:pause`/`room:resume` 两个 socket handler |
| `server/__tests__/RoomManager.test.js` | 新增一组直接测 `playerAction` 在 `paused=true` 时被拒绝的用例（不需要起服务器） |
| `server/__tests__/pauseResume.test.js`（新建） | 完整的 socket 级测试：冻结/恢复剩余时间、竞态、非坐位玩家被拒、暂停期间行动被拒、两手之间暂停不报错、暂停期间断线不触发异常路径 |
| `client/src/components/GameTable.jsx` | 顶部加暂停/继续按钮；暂停时渲染遮罩；`ActionBar` 的 `disabled` 加上 `paused` |
| `client/src/pages/RoomPage.jsx` | 把 `roomState.paused` 和两个新的 `emit` 回调传给 `GameTable` |
| `client/src/styles/velvet.css` | 新增 `.pause-btn`/`.pause-btn--active`/`.pause-overlay` 样式 |
| `e2e/pauseResume.spec.js`（新建） | 真实渲染断言：暂停后倒计时不再变化，继续后才重新开始跳动 |

---

## Task 1: RoomManager — 暂停状态 + 行动拦截

**Files:**
- Modify: `server/RoomManager.js:56-67`（`Room` 构造函数，`this.turnClock = null;` 那一行附近）
- Modify: `server/RoomManager.js:483-493`（`playerAction` 方法）
- Modify: `server/RoomManager.js:500-514`（`getLobbyState` 方法）
- Test: `server/__tests__/RoomManager.test.js`

**Interfaces:**
- Produces：`room.paused`（boolean，默认 `false`）、`room.pauseRemainingMs`（number|null，默认 `null`）、`room.pausedActionPlayerId`（string|null，默认 `null`）——这三个字段是 Task 2 里 `room:pause`/`room:resume` handler 要读写的。
- Produces：`room.playerAction(playerId, action, amount)` 在 `room.paused === true` 时返回 `{ error: '已暂停' }`，不改变 `this.game` 任何状态。
- Produces：`room.getLobbyState()` 返回值新增 `paused: this.paused` 字段，供客户端读取。

- [ ] **Step 1: 写失败测试——`playerAction` 在暂停时拒绝**

在 `server/__tests__/RoomManager.test.js` 文件末尾新增一个 `describe` 块（照抄文件里已有的 `describe('RoomManager — 加入房间', ...)` 这类结构）：

```js
describe('RoomManager — 暂停期间拒绝行动', () => {
  it('paused=true 时 playerAction 返回错误，不改变牌局状态', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    room.startGame();
    const actorId = room.getActionPlayerId();

    room.paused = true;
    const result = room.playerAction(actorId, 'fold');

    expect(result.error).toBe('已暂停');
    // 牌局没有真的翻掉——行动方还是原来那个人。
    expect(room.getActionPlayerId()).toBe(actorId);
  });

  it('paused=false（默认）时 playerAction 正常放行', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    room.startGame();
    expect(room.paused).toBe(false);

    const actorId = room.getActionPlayerId();
    const result = room.playerAction(actorId, 'fold');
    expect(result.error).toBeUndefined();
  });

  it('getLobbyState() 暴露 paused 字段', () => {
    const room = rooms.create('p1', 'Alice');
    expect(room.getLobbyState().paused).toBe(false);
    room.paused = true;
    expect(room.getLobbyState().paused).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run __tests__/RoomManager.test.js -t "暂停期间拒绝行动"`
Expected: 三条全部 FAIL——`playerAction` 还没有 `paused` 字段可读，`result.error` 是 `undefined` 不是 `'已暂停'`；`getLobbyState()` 也还没有 `paused` 字段。

- [ ] **Step 3: 实现**

在 `server/RoomManager.js` 的 `Room` 构造函数里，紧跟 `this.turnClock = null;` 这一行之后加：

```js
    // 暂停/继续（用户反馈，2026-08-11）：room.paused 是唯一权威状态，所有
    // 涉及暂停的入口都先检查它——两个人几乎同时点暂停/继续时，先到的生
    // 效，后到的因为状态已经翻转而自然变成空操作，不需要额外加锁。
    // pauseRemainingMs/pausedActionPlayerId 只在"暂停时正好有人在行动"这
    // 种情况下有值，用来在恢复时把倒计时接回暂停前的剩余时间——如果暂停
    // 发生在两手之间/结算等待期，这两个字段保持 null，恢复时走正常的下
    // 一手流程，不需要特殊处理。
    this.paused = false;
    this.pauseRemainingMs = null;
    this.pausedActionPlayerId = null;
```

在 `playerAction` 方法最前面加一行：

```js
  playerAction(playerId, action, amount) {
    if (this.paused) return { error: '已暂停' };
    if (!this.game) return { error: '游戏未开始' };
```

在 `getLobbyState()` 返回对象里，紧跟 `turnClock: this.turnClock,` 之后加一行：

```js
      turnClock: this.turnClock,
      paused: this.paused,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx vitest run __tests__/RoomManager.test.js`
Expected: 全部 PASS（包括新加的三条和文件里原有的全部用例）。

- [ ] **Step 5: 提交**

```bash
cd "/Users/reyes/测试 OpenStack"
git add server/RoomManager.js server/__tests__/RoomManager.test.js
git commit -m "feat: add paused state + defensive action-blocking to Room"
```

---

## Task 2: server/index.js — `room:pause`/`room:resume` 事件 + 计时器冻结/恢复

**Files:**
- Modify: `server/index.js:378-401`（`maybeArmTurnClock` 函数）
- Modify: `server/index.js`（`socket.on('game:action', ...)` 附近，加两个新 handler）
- Test: `server/__tests__/pauseResume.test.js`（新建）

**Interfaces:**
- Consumes：Task 1 产出的 `room.paused`/`room.pauseRemainingMs`/`room.pausedActionPlayerId`/`room.getLobbyState().paused`。
- Consumes：既有的 `room.isAwaitingAction()`、`room.getActionPlayerId()`、`room.turnClock`（`{playerId, startedAt, endsAt, seq}`）、`room.startTurnClock(playerId, baseMs)` → 返回 `{playerId, startedAt, endsAt, seq}`、`room.players`（数组，元素有 `.id`/`.left`）、既有的 `clearTurnTimer(room)`、`scheduleTurnExpiry(room, playerId, endsAt)`、`broadcastRoom(room)`、`rooms.getRoomByPlayer(playerId)`。
- Produces：客户端发 `room:pause`/`room:resume`（payload `{playerId}`）会触发 `room:state`/`game:state` 广播（复用 `broadcastRoom`），其中 `room:state` 携带 `paused: true/false`。

- [ ] **Step 1: 写失败测试——暂停真的冻结了倒计时，恢复后接着剩余时间走**

创建 `server/__tests__/pauseResume.test.js`，照抄 `server/__tests__/turnClock.test.js` 开头的连接/等待 helper（`connect`/`waitFor`/`waitUntil`/`beforeEach`/`afterEach`/`startedRoom`），改成这样：

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run __tests__/pauseResume.test.js`
Expected: 全部 FAIL（`room:pause`/`room:resume` 事件还不存在，服务端不会响应，`room.paused` 永远是 `false`）。

- [ ] **Step 3: 实现——`maybeArmTurnClock` 加暂停短路**

在 `server/index.js` 里找到 `maybeArmTurnClock` 函数（约第 378 行），在函数体最前面加一道短路：

```js
  function maybeArmTurnClock(room) {
    // 暂停时绝不能重新起表——broadcastRoom 每次都会调用这个函数，暂停后
    // 如果不短路，下一次任意广播都会把刚清掉的计时器重新点起来，暂停等
    // 于白做。清空残留的 turnClock（正常情况下 room:pause handler 已经清
    // 过了，这里是防御性的二次保证）之后直接返回，不碰 turnTimers。
    if (room.paused) { room.clearTurnClock(); return; }
    const existing = turnTimers.get(room.code);
```

（后面原有的函数体不变，只是在最前面插入这几行。）

- [ ] **Step 4: 实现——新增 `room:pause`/`room:resume` handler**

在 `server/index.js` 里 `socket.on('game:extend-turn', ...)` 那个 handler 结束的 `});` 之后（`game:action` 和 `game:extend-turn` 中间任意合理位置都可以，紧跟在 `game:extend-turn` 后面最自然）插入：

```js
    // 暂停/继续（用户反馈，2026-08-11）：任意坐位玩家都能触发，立刻冻结
    // 当前回合的行动倒计时。room.paused 是唯一权威状态，两次几乎同时的
    // 调用天然安全——先到的生效，后到的因为状态已经翻转而在下面的 guard
    // 处变成空操作。设计文档：
    // docs/superpowers/specs/2026-08-11-pause-resume-design.md
    socket.on('room:pause', ({ playerId }) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room) return socket.emit('game:error', '未找到房间');
      if (room.paused) return; // 已经暂停，空操作——竞态安全的关键
      if (!room.players.some(p => p.id === playerId && !p.left)) return; // 只有坐位玩家能触发

      if (room.isAwaitingAction()) {
        room.pauseRemainingMs = Math.max(0, room.turnClock.endsAt - Date.now());
        room.pausedActionPlayerId = room.getActionPlayerId();
      }
      room.paused = true;
      clearTurnTimer(room);
      room.clearTurnClock();
      broadcastRoom(room);
    });

    socket.on('room:resume', ({ playerId }) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room) return socket.emit('game:error', '未找到房间');
      if (!room.paused) return; // 没在暂停，空操作
      if (!room.players.some(p => p.id === playerId && !p.left)) return;

      room.paused = false;
      const samePlayerSameTurn =
        room.pausedActionPlayerId &&
        room.isAwaitingAction() &&
        room.getActionPlayerId() === room.pausedActionPlayerId;

      if (samePlayerSameTurn) {
        // 复用 startTurnClock，只是把固定的 TURN_BASE_MS 换成暂停前记
        // 下来的剩余时间——引擎这边不用改一行。
        const { endsAt } = room.startTurnClock(room.pausedActionPlayerId, room.pauseRemainingMs);
        scheduleTurnExpiry(room, room.pausedActionPlayerId, endsAt);
      }
      // samePlayerSameTurn 为假的情况（理论上不会发生，暂停期间所有行动
      // 都被挡）交给下面 broadcastRoom 里的 maybeArmTurnClock 兜底——它
      // 现在已经不会被 room.paused 短路了（刚设成 false），会按正常逻辑
      // 重新评估该不该起表。

      room.pauseRemainingMs = null;
      room.pausedActionPlayerId = null;
      broadcastRoom(room);
    });

```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd server && npx vitest run __tests__/pauseResume.test.js`
Expected: 全部 PASS。

- [ ] **Step 6: 跑服务端全量测试确认没有回归**

Run: `cd server && npm test`
Expected: 全部通过（既有的两条零星 flaky——`integration.test.js` 一条断连测试、`aiPersonaSimulation` 一条概率性弃牌率测试——单独重跑会过，属已知问题，不是本次改动引入；如果这次跑到了，按老规矩单独重跑那一个文件确认）。

- [ ] **Step 7: 提交**

```bash
cd "/Users/reyes/测试 OpenStack"
git add server/index.js server/__tests__/pauseResume.test.js
git commit -m "feat: add room:pause/room:resume events with turn-clock freeze/restore"
```

---

## Task 3: 客户端 — 暂停按钮 + 遮罩 + ActionBar 禁用

**Files:**
- Modify: `client/src/pages/RoomPage.jsx`（`<GameTable ... />` 的 props 列表附近）
- Modify: `client/src/components/GameTable.jsx`（`top-bar` 附近、`ActionBar` 渲染附近）
- Modify: `client/src/styles/velvet.css`（新增样式）

**Interfaces:**
- Consumes：Task 2 产出的 `room:pause`/`room:resume` 事件（客户端发）、`roomState.paused`（客户端收，来自 `room:state`）。
- Consumes：已有的 `emit(event, payload)`（`useSocket.js` 的包装，`RoomPage.jsx` 里已经在用，比如 `emit('game:extend-turn', { playerId })`）、`GameTable.jsx` 已有的 `amPlaying` prop（判断"是不是坐位玩家"）、`ActionBar` 已有的 `disabled` prop（`disabled` 为真时整个 `ActionBar` 返回 `null`，见 `client/src/components/ActionBar.jsx:63`）。
- Produces：`GameTable` 新增 props `paused`（boolean）、`onPause`/`onResume`（无参回调）。

- [ ] **Step 1: RoomPage.jsx 传入新 props**

在 `client/src/pages/RoomPage.jsx` 的 `<GameTable ... />` 调用里，找到这一段（现状）：

```jsx
        onEndGame={() => emit('room:end-game', { playerId })}
        gameTimerEndsAt={roomState?.gameTimerEndsAt ?? null}
        turnClock={roomState?.turnClock ?? null}
```

改成：

```jsx
        onEndGame={() => emit('room:end-game', { playerId })}
        gameTimerEndsAt={roomState?.gameTimerEndsAt ?? null}
        turnClock={roomState?.turnClock ?? null}
        paused={roomState?.paused ?? false}
        onPause={() => emit('room:pause', { playerId })}
        onResume={() => emit('room:resume', { playerId })}
```

- [ ] **Step 2: GameTable.jsx 加暂停按钮 + 遮罩**

在 `client/src/components/GameTable.jsx` 的函数签名里加两个新 prop（找到现有的长长的 props 解构，在 `onExtendTurn` 后面加）：

```jsx
export default function GameTable({ gameState, myId, roomCode, showdown, onAction, actionDisabled, onExit, amPlaying = true, myChips = 0, onRebuy, onOpenLedger, onOpenHandHistory, onOpenStats, onOpenFeedback, onPoke, pokedSeat, settlementOpen = false, revealedPlayers = {}, isHost = false, onEndGame, gameTimerEndsAt = null, turnClock = null, myTimeBankMs = 0, onExtendTurn, paused = false, onPause, onResume, voiceEnabled = false, voiceTalking = false, voiceMicError = null, speakingPlayerIds = null, getVoiceVolume = null, onStartTalking, onStopTalking }) {
```

在 `top-bar` 的 JSX 里，找到这一段（现状）：

```jsx
        <div className="menu-btn" onClick={() => setShowMenu(true)} aria-label="菜单" role="button">
          <svg viewBox="0 0 20 6" width="18" height="5" aria-hidden="true">
            <circle cx="3" cy="3" r="2.4" fill="currentColor" />
            <circle cx="10" cy="3" r="2.4" fill="currentColor" />
            <circle cx="17" cy="3" r="2.4" fill="currentColor" />
          </svg>
        </div>
        {countdownText && <div className="timer-countdown">⏱ {countdownText}</div>}
      </div>
```

改成（`top-bar` 本身是 `justify-content:space-between`，这个新按钮加在 `menu-btn` 之后、`timer-countdown` 之外，会自动被推到右侧，不需要额外定位）：

```jsx
        <div className="menu-btn" onClick={() => setShowMenu(true)} aria-label="菜单" role="button">
          <svg viewBox="0 0 20 6" width="18" height="5" aria-hidden="true">
            <circle cx="3" cy="3" r="2.4" fill="currentColor" />
            <circle cx="10" cy="3" r="2.4" fill="currentColor" />
            <circle cx="17" cy="3" r="2.4" fill="currentColor" />
          </svg>
        </div>
        {countdownText && <div className="timer-countdown">⏱ {countdownText}</div>}
        {/* 暂停/继续（用户反馈，2026-08-11）：只有坐位玩家（amPlaying）能
            触发，旁观者看不到这个按钮。图标用真的 SVG 画（跟其余全部图标
            按钮统一），不是 emoji/unicode 字符。 */}
        {amPlaying && (
          <div
            className={`pause-btn${paused ? ' pause-btn--active' : ''}`}
            onClick={paused ? onResume : onPause}
            aria-label={paused ? '继续对局' : '暂停对局'}
            role="button"
          >
            {paused ? (
              <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                <path d="M6 4 L16 10 L6 16 Z" fill="currentColor" />
              </svg>
            ) : (
              <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                <rect x="5" y="4" width="4" height="12" rx="1" fill="currentColor" />
                <rect x="11" y="4" width="4" height="12" rx="1" fill="currentColor" />
              </svg>
            )}
          </div>
        )}
      </div>
      {paused && (
        <div className="pause-overlay">
          <div className="pause-overlay__text">已暂停</div>
          <div className="pause-overlay__btn" onClick={onResume}>继续</div>
        </div>
      )}
```

在 `ActionBar` 的渲染处（现状 `disabled={actionDisabled}`），改成把 `paused` 也并进去：

```jsx
            ? <ActionBar gameState={gameState} myId={myId} onAction={onAction} disabled={actionDisabled || paused} timeBankMs={myTimeBankMs} onExtendTurn={onExtendTurn} />
```

- [ ] **Step 3: velvet.css 新增样式**

在 `client/src/styles/velvet.css` 里 `.menu-btn` 规则之后（跟其余顶部按钮放在一起）加：

```css
/* 暂停/继续按钮，跟 .menu-btn 同一套圆角矩形芯片语言。暂停态用绿色系
   （跟 --state-safe/说话发光同一色系，读作"这个功能当前生效中"），静止态
   用金色，跟其余顶部图标一致。 */
.pause-btn {
  width:44px; height:44px; background:rgba(212,175,55,.16); border:1px solid rgba(212,175,55,.32);
  border-radius:12px; display:flex; align-items:center; justify-content:center;
  color:#D4AF37; cursor:pointer; transition:background .2s ease, border-color .2s ease, color .2s ease;
}
.pause-btn--active {
  background:rgba(39,174,96,.20); border-color:rgba(39,174,96,.55); color:#27AE60;
  box-shadow:0 0 10px rgba(39,174,96,.25);
}

/* 暂停态遮罩：只挡操作，不挡视觉——手牌/公共牌照常可见，只是盖一层半透
   明条幅提示"已暂停"，附一个继续按钮。z-index 要高于 ActionBar 但不影
   响座位卡的说话发光等叠加层。 */
.pause-overlay {
  position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
  display:flex; flex-direction:column; align-items:center; gap:10px;
  background:rgba(10,20,15,.82); border:1px solid rgba(212,175,55,.35); border-radius:16px;
  padding:20px 28px; z-index:30; pointer-events:auto;
}
.pause-overlay__text {
  font-family:var(--font-display); font-size:18px; font-weight:700; color:var(--text-primary);
  letter-spacing:.05em;
}
.pause-overlay__btn {
  background:rgba(39,174,96,.85); border:1px solid #27AE60; border-radius:10px;
  padding:8px 24px; font-family:var(--font-body); font-size:14px; font-weight:700; color:#EAFBF0;
  cursor:pointer;
}
```

- [ ] **Step 4: 构建 + lint 确认没有回归**

Run:
```bash
cd "/Users/reyes/测试 OpenStack/client" && npm run build && npx eslint .
```
Expected: build 成功；eslint 停在 39 problems / 30 errors（不能比这个多）。

- [ ] **Step 5: 提交**

```bash
cd "/Users/reyes/测试 OpenStack"
git add client/src/pages/RoomPage.jsx client/src/components/GameTable.jsx client/src/styles/velvet.css
git commit -m "feat: add pause/resume button and overlay to GameTable"
```

---

## Task 4: e2e — 真实渲染断言倒计时确实冻结

**Files:**
- Create: `e2e/pauseResume.spec.js`

**Interfaces:**
- Consumes：Task 3 产出的 `.pause-btn`/`.pause-btn--active`/`.pause-overlay__btn` DOM 结构、`.action-bar`（既有的下注操作栏，`actionBar` selector 沿用 `e2e/turnTimeout.spec.js` 里已经验证过的写法）、`.timer-countdown`（顶部倒计时文字，`GameTable.jsx` 里 `countdownText` 渲染出的元素——这是"5 分钟内才显示"的那个计时游戏倒计时，不是本任务要断言的对象，注意别搞混；本任务要断言的是回合倒计时环，实际读数来自 `ActionBar`/`PlayerSeat` 里的 `turn-secs`/`turn-ring`，具体 selector 见 Step 1 里现场确认）。

- [ ] **Step 1: 确认真实倒计时数字的 DOM selector**

回合倒计时数字渲染在 `PlayerSeat.jsx` 里（不是顶部 `timer-countdown`，那个是"计时游戏"剩 5 分钟才出现的整局倒计时，跟回合倒计时是两回事）。跑一次现有的 `e2e/turnTimeout.spec.js` 之前，先搜一下具体 class：

```bash
cd "/Users/reyes/测试 OpenStack" && grep -n "turn-secs\|useThinkSeconds\|useTurnClock" client/src/components/PlayerSeat.jsx client/src/hooks/useThinkSeconds.js
```

把搜出来的、渲染秒数文字的那个 class name 记下来，下面 Step 2 的 selector 要用真实值替换（写这份计划时没有现场跑这条 grep，实现者必须自己确认一次，不能照抄一个猜的 class name）。

- [ ] **Step 2: 写测试**

创建 `e2e/pauseResume.spec.js`：

```js
/**
 * 暂停/继续（用户反馈，2026-08-11）：暂停要能真的冻结当前回合的行动倒计
 * 时，不是只有服务端状态对但界面看不出来。这条测试断言的是真实渲染出来
 * 的倒计时数字，不是服务端单测那种"信任 room.turnClock 为 null 就够了"
 * ——用户会盯着屏幕看，界面上数字有没有变化才是他们真正在意的。
 */
const { test, expect } = require('@playwright/test');

const S = {
  nameInput: '.home-input:not(.home-input--code)',
  createBtn: 'button:has-text("创建房间")',
  joinSubmit: 'button:has-text("加入")',
  roomCode: '.room-code',
  startBtn: '.lobby-btn',
  actionBar: '.action-bar',
  pauseBtn: '.pause-btn',
  pauseOverlay: '.pause-overlay',
  resumeBtn: '.pause-overlay__btn',
  turnSecs: '.turn-secs', // TODO(实现者)：Task 4 Step 1 确认后的真实 class name，如果不是这个要改
};

test('暂停后回合倒计时冻结，继续后才重新开始跳动', async ({ browser }) => {
  test.setTimeout(60000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pA = await ctxA.newPage();
  const pB = await ctxB.newPage();

  await pA.goto('/');
  await pA.fill(S.nameInput, '甲');
  await pA.click(S.createBtn);
  await expect(pA.locator(S.roomCode)).toBeVisible({ timeout: 8000 });
  const code = (await pA.locator(S.roomCode).textContent()).trim();

  await pB.goto(`/room/${code}`);
  await pB.fill(S.nameInput, '乙');
  await pB.click(S.joinSubmit);
  await expect(pB.locator(S.roomCode)).toBeVisible({ timeout: 10000 });

  await pA.locator(S.startBtn).click();
  await Promise.race([
    pA.locator(S.actionBar).waitFor({ state: 'visible', timeout: 15000 }),
    pB.locator(S.actionBar).waitFor({ state: 'visible', timeout: 15000 }),
  ]);

  const actorIsA = await pA.locator(S.actionBar).isVisible();
  const actorPage = actorIsA ? pA : pB;
  const observerPage = actorIsA ? pB : pA;

  // 非行动方也能看到并点暂停——验证"任意坐位玩家都能触发"，不只是行动方自己。
  await observerPage.locator(S.pauseBtn).click();
  await expect(observerPage.locator(S.pauseOverlay)).toBeVisible({ timeout: 3000 });
  await expect(actorPage.locator(S.pauseOverlay)).toBeVisible({ timeout: 3000 });

  // 行动方的操作栏在暂停期间应该消失（禁用逻辑生效）。
  await expect(actorPage.locator(S.actionBar)).toHaveCount(0);

  // 记下暂停那一刻的秒数，等 3 秒，确认没有变化——这是"真的冻结了"的核心断言。
  const secondsAtPause = await actorPage.locator(S.turnSecs).textContent();
  await actorPage.waitForTimeout(3000);
  const secondsAfterWait = await actorPage.locator(S.turnSecs).textContent();
  expect(secondsAfterWait).toBe(secondsAtPause);

  // 继续——操作栏重新出现，倒计时重新开始跳动。
  await observerPage.locator(S.resumeBtn).click();
  await expect(actorPage.locator(S.actionBar)).toBeVisible({ timeout: 3000 });
  await actorPage.waitForTimeout(1500);
  const secondsAfterResume = await actorPage.locator(S.turnSecs).textContent();
  expect(secondsAfterResume).not.toBe(secondsAtPause);

  await ctxA.close();
  await ctxB.close();
});

test('旁观者看不到暂停按钮', async ({ browser }) => {
  test.setTimeout(60000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ctxC = await browser.newContext();
  const pA = await ctxA.newPage();
  const pB = await ctxB.newPage();
  const pC = await ctxC.newPage();

  await pA.goto('/');
  await pA.fill(S.nameInput, '甲');
  await pA.click(S.createBtn);
  await expect(pA.locator(S.roomCode)).toBeVisible({ timeout: 8000 });
  const code = (await pA.locator(S.roomCode).textContent()).trim();

  await pB.goto(`/room/${code}`);
  await pB.fill(S.nameInput, '乙');
  await pB.click(S.joinSubmit);
  await expect(pB.locator(S.roomCode)).toBeVisible({ timeout: 10000 });

  await pA.locator(S.startBtn).click();
  await Promise.race([
    pA.locator(S.actionBar).waitFor({ state: 'visible', timeout: 15000 }),
    pB.locator(S.actionBar).waitFor({ state: 'visible', timeout: 15000 }),
  ]);

  // 丙中途加入——牌局已经开始，丙是旁观者（amPlaying=false）。
  await pC.goto(`/room/${code}`);
  await pC.fill(S.nameInput, '丙');
  await pC.click(S.joinSubmit);
  await expect(pC.locator(S.roomCode)).toBeVisible({ timeout: 10000 });

  await expect(pC.locator(S.pauseBtn)).toHaveCount(0);

  await ctxA.close();
  await ctxB.close();
  await ctxC.close();
});
```

- [ ] **Step 3: 跑测试确认通过**

Run: `cd "/Users/reyes/测试 OpenStack" && npx playwright test e2e/pauseResume.spec.js`
Expected: 两条都 PASS。如果 `turn-secs` selector 不对，测试会在 `secondsAtPause`/`secondsAfterWait` 那几行报"找不到元素"或读到空字符串——按 Step 1 的说明去 `PlayerSeat.jsx` 里确认真实 class name 再改。

- [ ] **Step 4: 跑相关既有 e2e 套件确认没有回归**

Run: `cd "/Users/reyes/测试 OpenStack" && npx playwright test e2e/turnTimeout.spec.js e2e/game.spec.js`
Expected: `turnTimeout.spec.js` 全过；`game.spec.js` 跟本会话之前确认过的基线一致（23/25，2 条既有的旁观旁路 flaky 测试不算回归）。

- [ ] **Step 5: 提交**

```bash
cd "/Users/reyes/测试 OpenStack"
git add e2e/pauseResume.spec.js
git commit -m "test: add e2e coverage for pause/resume turn-clock freeze"
```

---

## Task 5: SDD 文档同步 + 收尾

**Files:**
- Modify: `openspec/changes/online-texas-holdem/design.md`
- Modify: `openspec/changes/online-texas-holdem/tasks.md`

按项目 `CLAUDE.md` 的规矩，功能完成后要把最终验收数据记进 SDD 文档（不是重复整份设计文档，是加一段"已实现+验收数据"的简短记录，呼应 Task 1 之前写的 `docs/superpowers/specs/2026-08-11-pause-resume-design.md`）。

- [ ] **Step 1: design.md 加一段实现完成的记录**

在 `openspec/changes/online-texas-holdem/design.md` 末尾追加一个新的 `###` 小节（跟着文件里现有的其他功能小节同样的格式），标题类似"暂停/继续功能实现完成（2026-08-11）"，内容包括：链接到 `docs/superpowers/specs/2026-08-11-pause-resume-design.md`、实现方式一句话概括（复用 `startTurnClock` 而不是新建计时基础设施）、`maybeArmTurnClock` 那处关键的既有函数改动（这是最容易被忽略、回头看代码最需要解释"为什么要有这一行"的地方）、最终验收数据（跑完 Task 1-4 之后的测试数字，构建/lint 结果）。

- [ ] **Step 2: tasks.md 加一条 `[x]` 任务记录**

在 `openspec/changes/online-texas-holdem/tasks.md` 末尾追加：

```markdown
- [x] **暂停/继续功能**（2026-08-11，用户反馈，方案见 docs/superpowers/specs/2026-08-11-pause-resume-design.md）
  - 服务端 `room.paused` 唯一权威状态 + `room:pause`/`room:resume` 事件，暂停能立刻冻结当前回合行动倒计时（不等到下一手边界），恢复后接着暂停前剩余时间继续走——复用既有 `startTurnClock`/`scheduleTurnExpiry`，没有新建计时基础设施
  - 关键的既有函数改动：`maybeArmTurnClock` 加了 `room.paused` 短路——不加的话 `broadcastRoom` 里对它的常规调用会在暂停期间把计时器重新点起来，直接抵消暂停
  - 断线/房主离开/两手之间暂停这些边界情况全部复用现有机制自然覆盖，没有额外特判代码
  - 只有坐位玩家能触发，服务端（`room.players.some(...)`）和客户端（`amPlaying` 门控按钮可见性）两层拦
  - **验收**：[实现完成后填入实际数字——服务端单测新增 N 条全过、e2e 2 条全过、构建/lint 与基线持平]
```

（方括号里的占位提示是给 Task 5 执行者自己在跑完前面所有任务后填真实数字用的，不是要留在最终提交里的占位符——提交前必须替换成实际测试输出的数字。）

- [ ] **Step 3: 提交**

```bash
cd "/Users/reyes/测试 OpenStack"
git add openspec/changes/online-texas-holdem/design.md openspec/changes/online-texas-holdem/tasks.md
git commit -m "docs: record pause/resume feature completion in SDD"
```

---

## Self-Review 记录

- **Spec 覆盖**：design 文档的状态模型/服务端逻辑/防御性拦截/边界情况/客户端/测试计划六个部分，分别对应 Task 1（状态模型+拦截）、Task 2（服务端逻辑+测试计划里的服务端部分）、Task 3（客户端）、Task 4（测试计划里的 e2e 部分）——全部覆盖，没有遗漏。design.md 里"明确不做"的三条（自动恢复超时/暂停留言/旁观权限）在任何任务里都没有出现，确认没有范围蔓延。
- **占位符扫描**：Task 4 Step 1 那个 `turn-secs` class name 是唯一一处没有 100% 确定值的地方（写计划时没有现场跑 grep 确认）——已经在 Step 1 里明确要求实现者现场确认，并在 selector 定义处留了行内注释说明"如果不是这个要改"，不是含糊的"TODO 待补全"，是给出了具体的确认方法。Task 5 的"[填入实际数字]"同理，是流程性的"跑完测试后填真实结果"，不是逃避设计的占位符。
- **类型一致性**：`room.paused`/`room.pauseRemainingMs`/`room.pausedActionPlayerId` 三个字段名在 Task 1（定义处）、Task 2（读写处）、测试文件里保持一致；`onPause`/`onResume`/`paused` 三个 prop 名在 Task 3 的 `RoomPage.jsx`/`GameTable.jsx` 两处保持一致。
