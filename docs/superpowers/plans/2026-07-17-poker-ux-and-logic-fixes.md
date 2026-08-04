# 翡翠厅 UX 与核心逻辑修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复用户实测发现的一批问题：两条真实的核心玩法逻辑 bug（All-In 后仍要求已跟注方继续行动；加注/全下金额校验不完整）、一条移动端布局 bug（缩放比例算错导致顶部内容溢出屏幕）、以及结算流程与牌桌视觉的一组体验改进（弹窗遮挡摊牌、赢家信息不全、没有本人座位、操作区偏大、行动高亮不够明显、金额字体不统一、缺 All In 快捷键）。

**Architecture:** 后端只改 `server/GameEngine.js`（下注状态机）和 `server/index.js`（结算后的"等所有人确认"流程，新增一个 socket 事件）。前端改 `client/src/components/`（SettlementModal / GameTable / PlayerSeat / ActionBar / Pot）、`client/src/hooks/useStageScale.js`、`client/src/styles/`（tokens.css / velvet.css）。不引入新依赖，不改数据库/存储结构（本项目本来就是纯内存房间状态）。

**Tech Stack:** Node.js + Socket.io（server），React + 原生 CSS（client），Vitest（server 单测），Playwright（E2E，已有套件，本计划不强制为纯 CSS 任务补 E2E，但改完要过现有全部套件）。

## Global Constraints

- 后端逻辑改动（Task 1、2、4）必须先写失败测试再改实现，遵循 TDD；提交前 `npm test --prefix server` 全绿。
- 纯 CSS/视觉调整任务（Task 6-11）不强行套用自动化测试模板——这类任务改完后用 `npm run dev`（或已跑通的 Playwright E2E）在浏览器里实际看一眼验证，计划里给出明确的"看什么"清单代替单测步骤。
- 每个任务改完跑一次 `npm test --prefix server`（server 相关任务）或 `npx playwright test`（涉及前端交互流程的任务），确认没有回归。
- 金额相关的所有数字改动，不允许引入"客户端算一套、服务端算一套"的重复逻辑——服务端 `GameEngine.js` 永远是权威来源，前端只读它广播的字段。
- commit message 用英文，格式 `type: description`（沿用本仓库 `CLAUDE.md` 约定）。
- 不 push（除非用户明确要求）。

---

## 归类总览（用户原始反馈 → 分类 → 根因）

| 用户反馈 | 分类 | 根因 / 状态 |
|---|---|---|
| 移动端显示不全，上方内容超出屏幕 | 一、移动端适配 | `useStageScale.js:11` 缩放公式用了错误的高度常量 `712`，但牌桌 `.game-stage` 实际 CSS 高度是 `812px`（`velvet.css:220` 注释也写明"375×812"）。缩放算大了，从底部为轴心往上超出屏幕。**确认为 bug，1 行修复。** |
| 结算弹窗消失太快 / 应等所有人点确认 | 二、交互与布局 | `SettlementModal.jsx` 内置 5 秒本地倒计时自动关闭，服务端也是固定 4 秒后无条件推进下一局（`server/index.js:41-45`），两边都不看玩家是否看清楚。**确认为设计缺陷，需要新协议。** |
| 弹窗没写清楚谁赢、还挡住摊牌的牌 | 二、交互与布局 | `RoomPage.jsx:100-108` 只取 `settlement.winners[0]`，多个赢家（边池分给不同人时）看不全；`.modal-overlay`（`velvet.css:183`）是 `inset:0` 全屏遮罩，摊牌时会整个盖住桌面，即使 `PlayerSeat.jsx:34` 已经在摊牌阶段把对手底牌摊开了，用户也看不到。**确认为 bug。** |
| 操作区可以再压缩，把空间留给牌桌 | 二、交互与布局 | 视觉调整，非 bug。当前 `.action-bar` padding `10px 14px 26px` + 按钮高 `52px`（`velvet.css:162,166`）。 |
| 牌桌上看不到自己的位置 | 二、交互与布局 | `GameTable.jsx:24-25` 注释明确写"hero stays at the bottom (not a rail seat)"——本人从设计上就没有被画成牌桌上的一个座位，只有底部单独的手牌区。**确认为功能缺口。** |
| 行动方头像闪烁不够明显 | 二、交互与布局 | 已有 `activePulse` 动画（`velvet.css:97-98`），是强度问题，非"没做"。 |
| 加注/下注应该有气泡冒出筹码量 | 二、交互与布局 | 已有 `.bet-chip` 徽章（`GameTable.jsx:127`），但是静态徽章样式，不是"气泡指向头像"的观感。视觉增强，非 bug。 |
| 底池数字太大、金额字体不好看，统一用 Inter | 二、交互与布局 | `tokens.css` 没有引入 Inter；金额类文本全部用 `--font-mono`（Space Mono）或 `--font-numerals`（DM Serif Display），`pot-amt` 字号 33px（`velvet.css:73`）。**确认，需要新 token + 批量替换金额相关的类。** |
| 加注区应该加 All In 快捷键 | 二、交互与布局 | `ActionBar.jsx` 只有 fold/check/call/raise-stepper，没有一键全下按钮。**确认为功能缺口**（不过服务端 `raise()` 已经原生支持"加注到等于自己全部筹码"当全下用，客户端只是没暴露这个入口）。 |
| 一方 All-In 后，另一方跟注完不该再被要求继续操作 | 三、核心逻辑漏洞 | **真实 bug**，已用真实牌局手算复现：heads-up 里短码方 all-in、长码方 call（还有余额，call 后状态仍是 `active` 不是 `allin`）之后，`GameEngine._nextStreet()`（`GameEngine.js:238-244`）只在 `actionIndex === -1`（零个可行动玩家）时才自动跑完剩余公共牌；"只剩 1 个可行动玩家、对手已全下没法再回应"这种情况没被识别，于是长码方在翻牌/转牌/河牌每条街都会被重新弹出操作栏，其实这些操作毫无意义（没有对手可以跟注/弃牌）。 |
| All-In/加注金额不能超过自己拥有的筹码 | 三、核心逻辑漏洞 | `GameEngine.raise()`（`GameEngine.js:150-166`）当前只在"金额既小于最小加注、又小于玩家全部筹码"时报错——完全没有"金额超过玩家全部筹码"的上限校验。实际下注金额因为 `_placeBet` 内部有 `Math.min(amount, p.chips)` 兜底所以不会真的超发筹码，**但** `this.lastRaiseAmount`（`GameEngine.js:159`）是拿未校验的 `totalAmount` 算的，一旦真的传入超额值，会把 `lastRaiseAmount` 污染成一个夸张的大数，后续"最小加注"门槛会变得不合理，可能间接把后续加注全部卡死。当前客户端 UI 已经用 `maxRaise` 夹住了发送值（`ActionBar.jsx:16-17`）所以打不出这个洞，**但服务端必须是权威校验方，不能只靠客户端自觉**，这是一条防御性但真实存在的漏洞，按用户要求的"绝对不能超出"一并修掉。 |

**额外发现的同类边界情况（本次不修，记录在案）：** `GameEngine` 构造函数（`GameEngine.js:68-74`）在极端情况下——如果小盲/大盲刚好比玩家剩余筹码还多，两人在发牌前就已经因为强制下盲注变成 `allin`——`this.actionIndex` 会被设成 `-1`，此时没有人能行动，牌局会卡死不会自动摊牌。这种情况需要玩家剩余筹码低于盲注（本项目起始 1000、盲注 10/20，多手之后被打到个位数筹码才会触发），概率很低，且要正确修复需要让 `Room.startGame()`/`nextRound()` 感知"牌局在构造时就已经结束"并广播 `game:showdown`，改动面比本计划其他任务大一截。本次先记录清楚（含精确位置），不纳入本轮任务，需要时单独立项。

---

## 文件改动清单

- Modify: `server/GameEngine.js` — Task 1（raise 上限校验）、Task 2（≤1 可行动玩家自动摊牌）
- Test: `server/__tests__/GameEngine.scenarios.test.js` — Task 1、2 的单测
- Modify: `server/index.js` — Task 4（结算后"等所有人确认"协议）
- Test: `server/__tests__/integration.test.js` — Task 4 的集成测试
- Modify: `client/src/hooks/useStageScale.js` — Task 3（缩放常量修复）
- Modify: `client/src/components/SettlementModal.jsx` — Task 5（多赢家展示 + 等待确认 + 底部抽屉样式）
- Modify: `client/src/pages/RoomPage.jsx` — Task 4/5 配套的客户端状态（ready 标记、winners 全量传递）
- Modify: `client/src/components/GameTable.jsx` — Task 6（本人座位标记）
- Modify: `client/src/components/PlayerSeat.jsx` — Task 6（座位组件要支持"这是我"变体）
- Modify: `client/src/components/ActionBar.jsx` — Task 7（压缩尺寸的同时顺手改）、Task 11（All In 按钮）
- Modify: `client/src/components/GameTable.jsx`（下注气泡）— Task 10
- Modify: `client/src/styles/tokens.css` — Task 9（Inter 字体 token）
- Modify: `client/src/styles/velvet.css` — Task 3 配套 CSS 常量确认、Task 5/6/7/8/9/10/11 涉及的样式

---

## Task 1: 加注/全下金额不能超过玩家自己的筹码（服务端权威校验）

**Files:**
- Modify: `server/GameEngine.js:150-166`（`raise` 方法）
- Test: `server/__tests__/GameEngine.scenarios.test.js`

**Interfaces:**
- Consumes: 无新依赖，沿用现有 `GameEngine` 构造和 `raise(playerId, totalAmount)` 签名。
- Produces: `raise()` 在 `totalAmount > p.chips + p.bet` 时返回 `{ error: string }`，且不产生任何副作用（不扣筹码、不改 `pot`/`currentBet`/`lastRaiseAmount`）。这个保证后面 Task 11 的 All-In 按钮可以放心地直接发送 `maxRaise`（等于玩家全部筹码）而不用担心被拒。

- [ ] **Step 1: 写失败测试**

在 `server/__tests__/GameEngine.scenarios.test.js` 文件末尾（最后一个 `describe` 块后面）追加：

```js
describe('加注金额上限校验', () => {
  it('加注超过自己筹码时应报错，且不改变任何状态', () => {
    const game = new GameEngine(makePlayers(2, 500), 0, BIG_BLIND);
    const actor = game.players[game.actionIndex];
    const before = {
      chips: actor.chips,
      bet: actor.bet,
      pot: game.pot,
      currentBet: game.currentBet,
      lastRaiseAmount: game.lastRaiseAmount,
    };

    const result = game.raise(actor.id, 999999); // 远超 actor 实际筹码

    expect(result.error).toBeDefined();
    expect(actor.chips).toBe(before.chips);
    expect(actor.bet).toBe(before.bet);
    expect(game.pot).toBe(before.pot);
    expect(game.currentBet).toBe(before.currentBet);
    expect(game.lastRaiseAmount).toBe(before.lastRaiseAmount);
  });

  it('加注到刚好等于自己全部筹码（全下）应该成功', () => {
    const game = new GameEngine(makePlayers(2, 500), 0, BIG_BLIND);
    const actor = game.players[game.actionIndex];
    const maxTotal = actor.chips + actor.bet;

    const result = game.raise(actor.id, maxTotal);

    expect(result.error).toBeUndefined();
    expect(actor.chips).toBe(0);
    expect(actor.status).toBe('allin');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && npx vitest run __tests__/GameEngine.scenarios.test.js -t "加注金额上限校验"`
Expected: 第一个用例 FAIL —— `result.error` 是 `undefined`，`expect(result.error).toBeDefined()` 报错。第二个用例应该已经是 PASS（现有代码本来就支持全下到刚好等于筹码，这条是回归保护，不是本任务要修的洞）。

- [ ] **Step 3: 修复实现**

打开 `server/GameEngine.js`，把 `raise` 方法替换为：

```js
  raise(playerId, totalAmount) {
    const idx = this._playerIndex(playerId);
    if (idx !== this.actionIndex) return { error: '还没轮到你' };
    const p = this.players[idx];
    const maxTotal = p.chips + p.bet;
    if (totalAmount > maxTotal) {
      return { error: `最多下注 ¥${maxTotal}` };
    }
    const minRaise = this.currentBet + this.lastRaiseAmount;
    if (totalAmount < minRaise && totalAmount < maxTotal) {
      return { error: `最小加注至 ¥${minRaise}` };
    }
    const raiseAmount = totalAmount - this.currentBet;
    this.lastRaiseAmount = raiseAmount;
    const additional = totalAmount - p.bet;
    this._placeBet(idx, additional);
    this.currentBet = p.bet; // after bet placed
    this.lastAggressorIndex = idx;
    this.actedThisStreet = new Set([playerId]); // everyone else must act again
    return this._advance();
  }
```

（改动点：新增 `maxTotal` 变量并在最开头做上限校验；原本内联写的 `p.chips + p.bet` 全部换成复用 `maxTotal`，避免两处算法不一致。）

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && npx vitest run __tests__/GameEngine.scenarios.test.js -t "加注金额上限校验"`
Expected: 两个用例都 PASS。

- [ ] **Step 5: 跑全部服务端测试，确认无回归**

Run: `npm test --prefix server`
Expected: 全部测试通过（不应该少于之前的 59 个）。

- [ ] **Step 6: Commit**

```bash
git add server/GameEngine.js server/__tests__/GameEngine.scenarios.test.js
git commit -m "fix: reject raise amounts exceeding player's own chip stack"
```

---

## Task 2: 只剩 ≤1 个可行动玩家时自动摊牌，不再重复要求行动

**Files:**
- Modify: `server/GameEngine.js:238-244`（`_nextStreet` 方法里"谁先行动"那一段）
- Test: `server/__tests__/GameEngine.scenarios.test.js`

**Interfaces:**
- Consumes: `this._activePlayers()`（已存在的方法，返回 `status==='active'` 的玩家数组）。
- Produces: `_nextStreet()` 在"存活玩家 ≥2 但可行动玩家 ≤1"时，直接递归推进到摊牌，不再把 `actionIndex` 停在那唯一的可行动玩家身上等它"行动"。这个行为后面 Task 5（结算弹窗）依赖的 `game:showdown` 事件会因此更早触发，属于连带的正确性提升。

- [ ] **Step 1: 写失败测试**

在 `server/__tests__/GameEngine.scenarios.test.js` 的「边池 — 三人不等额 All-In」`describe` 块后面（文件末尾）追加新的 `describe`：

```js
describe('对手全下后，剩余唯一可行动玩家不应被重复要求操作', () => {
  it('短码方全下、长码方跟注后仍有余额，应直接自动摊牌，不再弹出行动机会', () => {
    const game = new GameEngine(makePlayers(2, 1000), 0, BIG_BLIND);
    const total = 2000;

    // heads-up 里 dealerIndex=0 时，SB 先手；把 SB 改造成"短码"
    const short = game.players[game.actionIndex];
    short.chips = 100;

    const r1 = game.allIn(short.id);
    expect(r1.showdown).toBeFalsy(); // 对手还没决定跟注/弃牌，不该直接结束

    const caller = game.players[game.actionIndex];
    const r2 = game.call(caller.id);

    expect(caller.status).toBe('active'); // 跟注方筹码有富余，跟注后不是 allin
    expect(r2.showdown).toBe(true);       // 应该直接摊牌——不应该再给它发牌后的行动机会
    expect(r2.state.communityCards).toHaveLength(5);
    assertPotConservation(game, total);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && npx vitest run __tests__/GameEngine.scenarios.test.js -t "剩余唯一可行动玩家不应被重复要求操作"`
Expected: FAIL —— `r2.showdown` 是 `false`（当前代码会把 `actionIndex` 停在 caller 身上，等它在翻牌圈"行动"）。

- [ ] **Step 3: 修复实现**

打开 `server/GameEngine.js`，找到 `_nextStreet()` 方法里这一段（大约第 238-244 行）：

```js
    // Action starts left of dealer among active players
    this.actionIndex = this._nextActive((this.dealerIndex + 1) % this.players.length);

    // All remaining players are all-in — run out the board automatically
    if (this.actionIndex === -1) return this._nextStreet();

    return { state: this.getPublicState() };
  }
```

替换为：

```js
    // Action starts left of dealer among active players
    this.actionIndex = this._nextActive((this.dealerIndex + 1) % this.players.length);

    // If at most one player can still act (everyone else is folded or
    // all-in), there's no one left to bet against — no more meaningful
    // action is possible. Run the board out automatically instead of
    // prompting the lone remaining player for a pointless check/bet.
    if (this.actionIndex === -1 || this._activePlayers().length <= 1) {
      return this._nextStreet();
    }

    return { state: this.getPublicState() };
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && npx vitest run __tests__/GameEngine.scenarios.test.js -t "剩余唯一可行动玩家不应被重复要求操作"`
Expected: PASS。

- [ ] **Step 5: 跑全部服务端测试，确认无回归**

Run: `npm test --prefix server`
Expected: 全部通过，尤其留意「All-In 场景」「边池」两个 describe 块（这两块最容易被这处改动波及）。

- [ ] **Step 6: 补一条 E2E 覆盖（真实浏览器验证这条 bug 真的消失了）**

在 `e2e/game.spec.js` 的 `S3：筹码归零与借一底` 之后追加：

```js
// ─── S6：对手全下后不应再被要求继续行动 ───────────────────────────────────────

test.describe('S6：对手全下后自动摊牌', () => {
  test('一方全下、对方跟注仍有余额后，不应再看到行动栏，应直接看到结算', async ({ browser }) => {
    test.setTimeout(60000);
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();

    const code = await createRoom(p1, 'Alice');
    await joinRoom(p2, 'Bob', code);
    await startGame(p1);

    const [actor, other] = await findActor(p1, p2);
    await actor.locator(S.raiseBtn).click();
    const plusBtn = actor.locator('.step-btn').nth(1);
    for (let i = 0; i < 60; i++) await plusBtn.click();
    await actor.locator('.b-confirm-raise').click();
    await other.locator(S.callBtn).click();

    // 跟注后不应该再看到任何一方的行动栏（除非是全新的下一局，这里只看这一局内）
    const actionBarStillThere = await other.locator(S.actionBar).isVisible({ timeout: 1500 }).catch(() => false);
    expect(actionBarStillThere).toBe(false);

    await expect(p1.locator(S.settlement)).toBeVisible({ timeout: 10000 });
    await expect(p2.locator(S.settlement)).toBeVisible({ timeout: 10000 });

    await ctx1.close();
    await ctx2.close();
  });
});
```

Run: `npx playwright test e2e/game.spec.js -g "对手全下后自动摊牌"`
Expected: PASS。

> 注意：这条 E2E 依赖 Task 5 落地之后的"点击我知道了才关闭弹窗"新协议——如果先做 Task 2 再做 Task 5，这里的 `S.settlement` 断言在两种协议下都成立（弹窗出现即可，不依赖它几秒后自动消失），不需要等 Task 5 做完才能跑这条测试。

- [ ] **Step 7: Commit**

```bash
git add server/GameEngine.js server/__tests__/GameEngine.scenarios.test.js e2e/game.spec.js
git commit -m "fix: auto-runout to showdown once at most one player can still act"
```

---

## Task 3: 移动端缩放常量修复（顶部内容溢出屏幕）

**Files:**
- Modify: `client/src/hooks/useStageScale.js:11`

**Interfaces:**
- Consumes: 无。
- Produces: `--stage-scale` CSS 变量的计算不变逻辑，只改一个常量。

**根因**：`.game-stage` 的真实 CSS 尺寸是 `375×812`（`velvet.css:220`，注释也写"preview's fixed 375×812 phone"），但 `useStageScale.js:11` 拿 `vh / 712` 来算缩放比例——用了错误的高度基准（712 而不是 812）。`.stage-wrap` 是 `align-items:flex-end` 且 `.game-stage` 的 `transform-origin:bottom center`（`velvet.css:258-259`），缩放轴心在底部，所以算出来偏大的缩放比例会让超出的部分从**顶部**溢出屏幕——跟用户描述的"上方内容会超出屏幕"完全对得上。

- [ ] **Step 1: 确认当前行为（不需要写自动化测试，手动验证根因）**

Run: `cd "/Users/reyes/测试 OpenStack" && node -e "
const vw = 390, vh = 700; // 举例一个常见手机视口
const scale = Math.min(vw/375, vh/712);
console.log('当前(错误)算法 scale=', scale, '渲染后高度=', 812*scale, '可用高度=', vh, '溢出=', 812*scale - vh);
const fixedScale = Math.min(vw/375, vh/812);
console.log('修复后 scale=', fixedScale, '渲染后高度=', 812*fixedScale, '可用高度=', vh, '溢出=', 812*fixedScale - vh);
"`

Expected: 第一行显示"溢出"是个正数（当前算法真的会溢出）；第二行"溢出"应该是 0 或负数（修复后不会溢出）。

- [ ] **Step 2: 修复实现**

打开 `client/src/hooks/useStageScale.js`，把第 11 行：

```js
      const scale = Math.min(vw / 375, vh / 712);
```

改成：

```js
      const scale = Math.min(vw / 375, vh / 812);
```

（`812` 要跟 `velvet.css:220` 里 `.game-stage { width:375px; height:812px; ... }` 的 `812` 保持一致——这两个数字本质上是同一件事的两处表达，理想情况下应该只有一个来源，但这个 hook 是纯 JS、CSS 是纯 CSS，本次先保证数值一致，不做跨文件常量提取，避免过度设计。）

- [ ] **Step 3: 浏览器验证**

Run: `cd "/Users/reyes/测试 OpenStack" && npm run dev` 或走已有的 `run` 技能启动前端

用 Chrome DevTools 把视口模拟成常见的窄屏手机宽度（比如 iPhone SE：375×667，或 iPhone 12：390×844），进入一局游戏画面，确认：
- 顶部菜单按钮（≡）和筹码数字完整可见，没有被裁掉。
- 底池数字、公共牌区域都在视口内。
- 底部操作栏完整可见。

- [ ] **Step 4: 跑现有 E2E 移动端相关测试确认无回归**

Run: `npx playwright test`
Expected: 全部通过（这个 hook 只影响视觉缩放比例，不改变任何 DOM 结构/选择器，理论上不会让任何现有 E2E 断言变化）。

- [ ] **Step 5: Commit**

```bash
git add client/src/hooks/useStageScale.js
git commit -m "fix: correct mobile scale-to-fit height constant (712 -> 812)"
```

---

## Task 4: 结算后服务端等所有人确认才推进下一局（新增 `game:ready-next` 协议）

**Files:**
- Modify: `server/index.js:31-47`（`handleActionResult`）、新增 `game:ready-next` 事件监听、`disconnect` 处理里补一处联动
- Test: `server/__tests__/integration.test.js`

**Interfaces:**
- Consumes: 无新依赖，沿用现有 `room.nextRound()`、`broadcastRoom(room)`。
- Produces:
  - 新 socket 事件（client → server）：`game:ready-next` `{ playerId }`。
  - 行为变化：`result.showdown` 之后不再是固定 4 秒的 `setTimeout`，而是"所有当前在线玩家都发了 `game:ready-next`"或"15 秒兜底超时"两者谁先到就推进；这两个触发路径最终都调用同一个 `advance()` 函数，产生的广播（`game:ended` / `room:state` / `game:state`）跟修复前完全一样，Task 5 的客户端只需要在恰当时机 emit 这个新事件。

**为什么要写在 `room` 对象上而不是 `RoomManager`**：这是"这一手牌结算之后、下一手开始之前"这个短暂窗口期的临时状态，跟 `Room` 类本身的持久字段（玩家列表、筹码等）性质不同，参照现有代码里 `room.game` 这种"进行中才存在"的模式，直接挂在 `room._advanceRound` 上，用完即清，不需要改 `RoomManager.js`。

- [ ] **Step 1: 写失败的集成测试**

打开 `server/__tests__/integration.test.js`，在文件最后一个 `it`（"筹码归零导致游戏结束时..."）后面追加：

```js
  it('结算后必须所有在线玩家都发 game:ready-next，才会推进到下一局', async () => {
    const { c1, c2 } = await setupRoom();
    const gs1 = waitFor(c1, 'game:state');
    c1.emit('room:start', { playerId: 'p1' });
    await gs1;

    // 让当前行动方直接弃牌，快速制造一次 showdown
    const actingId = (await new Promise((resolve) => {
      c1.once('game:state', (s) => resolve(s.actionPlayerId));
      c1.emit('room:sync', { playerId: 'p1' });
    }));
    const actingSocket = actingId === 'p1' ? c1 : c2;

    const showdown = waitFor(c1, 'game:showdown');
    actingSocket.emit('game:action', { playerId: actingId, action: 'fold' });
    await showdown;

    // 只有 p1 确认，还不该收到下一局的 game:state
    let gotNextHand = false;
    const nextHandListener = () => { gotNextHand = true; };
    c1.on('game:state', nextHandListener);
    c1.emit('game:ready-next', { playerId: 'p1' });
    await new Promise((r) => setTimeout(r, 800));
    expect(gotNextHand).toBe(false);
    c1.off('game:state', nextHandListener);

    // p2 也确认后，应该很快收到下一局 game:state（不用等 4 秒/15 秒兜底）
    const nextHand = waitFor(c1, 'game:state', 3000);
    c2.emit('game:ready-next', { playerId: 'p2' });
    const state = await nextHand;
    expect(state.phase).toBe('preflop');
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && npx vitest run __tests__/integration.test.js -t "必须所有在线玩家都发"`
Expected: 超时失败（当前代码里没有 `game:ready-next` 这个事件，服务端 4 秒后无条件推进，跟测试预期的"不该立刻推进"矛盾，或者最后一步等不到及时的下一局广播）。

- [ ] **Step 3: 修复实现**

打开 `server/index.js`，把 `handleActionResult` 函数（第 31-47 行）替换为：

```js
  function handleActionResult(room, result) {
    if (result.error) return;
    broadcastRoom(room);

    if (result.showdown) {
      io.to(room.code).emit('game:showdown', {
        winners: result.winners,
        pot: result.pot,
        settle: result.settle,
      });

      const eligiblePlayerIds = new Set(room.players.filter(p => p.socketId).map(p => p.id));
      const readyPlayerIds = new Set();

      function advance() {
        clearTimeout(fallbackTimer);
        room._advanceRound = null;
        const nr = room.nextRound();
        if (nr.ended) io.to(room.code).emit('game:ended', nr);
        broadcastRoom(room);
      }

      const fallbackTimer = setTimeout(advance, 15000);
      room._advanceRound = { readyPlayerIds, eligiblePlayerIds, advance };
    }
  }
```

再找到 `socket.on('room:kick', ...)` 那一段（约第 114-123 行），紧接着它后面新增一个事件监听：

```js
    socket.on('game:ready-next', ({ playerId }) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room?._advanceRound) return;
      const { readyPlayerIds, eligiblePlayerIds, advance } = room._advanceRound;
      readyPlayerIds.add(playerId);
      if ([...eligiblePlayerIds].every((id) => readyPlayerIds.has(id))) {
        advance();
      }
    });
```

最后，找到 `socket.on('disconnect', ...)`（约第 125-136 行），在 `rooms.leave(myPlayerId)` 之后补一段处理——玩家在等待确认期间断线，不应该卡住其他人（否则要等满 15 秒兜底才会推进）：

```js
    socket.on('disconnect', () => {
      if (!myPlayerId) return;
      const room = rooms.getRoomByPlayer(myPlayerId);
      if (room?.game) {
        const result = room.playerAction(myPlayerId, 'fold');
        handleActionResult(room, result);
      }
      rooms.leave(myPlayerId);
      if (room?._advanceRound) {
        room._advanceRound.eligiblePlayerIds.delete(myPlayerId);
        const { readyPlayerIds, eligiblePlayerIds, advance } = room._advanceRound;
        if ([...eligiblePlayerIds].every((id) => readyPlayerIds.has(id))) advance();
      }
      if (room && room.players.length > 0) {
        io.to(room.code).emit('room:state', room.getLobbyState());
      }
    });
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && npx vitest run __tests__/integration.test.js -t "必须所有在线玩家都发"`
Expected: PASS。

- [ ] **Step 5: 跑全部服务端测试，确认无回归**

Run: `npm test --prefix server`
Expected: 全部通过。特别注意之前那条"筹码归零导致游戏结束时…仍收到 room:state"的回归测试——它现在也要走 `game:ready-next` 才会推进，如果那条测试还是假设"4 秒后自动推进"，需要同步改成先 emit `game:ready-next`（両个玩家都发）再等结果。检查并按需更新该测试的等待逻辑。

- [ ] **Step 6: Commit**

```bash
git add server/index.js server/__tests__/integration.test.js
git commit -m "feat: gate next-round advance on all players acking the settlement"
```

---

## Task 5: 结算弹窗改为底部抽屉、展示全部赢家、等待所有人确认

**Files:**
- Modify: `client/src/components/SettlementModal.jsx`
- Modify: `client/src/pages/RoomPage.jsx:29-32, 100-117`
- Modify: `client/src/styles/velvet.css`（新增 `.settlement-sheet*` 样式，替换原来复用的 `.modal-overlay`）

**Interfaces:**
- Consumes: Task 4 产出的 `game:ready-next` 事件；`game:showdown` payload 里已有的 `winners`（数组，可能不止一个，边池分给不同人时）和 `settle`（每个人的净输赢数组）。
- Produces: `SettlementModal` 新 props 签名：`{ winners, settle, myId, readyCount, totalCount, iAmReady, onReady }`（替换旧的 `{ winner, results, onClose, seconds }`）。

**设计**：不再是全屏遮罩+自动关闭，改成从底部滑上来的抽屉（跟 `.action-bar`/`.waiting-bar` 一样贴底，不盖住桌面上半部分），这样摊牌阶段 `PlayerSeat.jsx` 已经在做的对手亮牌动画天然就留在视野里，不需要额外加延迟。点击"我知道了"后本地进入"等待其他人"态，按钮失效，直到服务端真正推进到下一局（`game:state` 到达，`settlement` 被清空）才消失。

- [ ] **Step 1: 重写 `SettlementModal.jsx`**

```jsx
import { useState } from 'react';

const AV = ['av-green', 'av-purple', 'av-teal', 'av-rust', 'av-olive', 'av-blue', 'av-magenta', 'av-gold'];
function colorForId(id) {
  let h = 0;
  for (const ch of String(id)) h = (h + ch.charCodeAt(0)) % 8;
  return h;
}
function amtText(delta) {
  if (delta == null) return '弃牌';
  return (delta > 0 ? '+¥' : '−¥') + Math.abs(delta).toLocaleString();
}

// Settlement sheet — bottom drawer (not a full-screen overlay), so the
// showdown reveal on the table stays visible behind it. Only dismissed
// when the server actually advances to the next hand (see RoomPage).
export default function SettlementModal({ winners = [], settle = [], myId, readyCount, totalCount, iAmReady, onReady }) {
  if (winners.length === 0) return null;

  return (
    <div className="settlement-sheet">
      <div className="modal-title">✦ 本局结算</div>

      <div className="settlement-winners">
        {winners.map((w) => {
          const isMe = w.id === myId;
          const avClass = isMe ? 'av-gold' : AV[colorForId(w.id)];
          return (
            <div key={w.id} className="settlement-winner-row">
              <div className={`modal-winner-av ${avClass}`}>{w.name[0].toUpperCase()}</div>
              <div>
                <div className="modal-winner-name" style={isMe ? { color: '#D4AF37' } : undefined}>
                  {w.name}
                  {isMe ? '（我）' : ''} 赢得本局
                </div>
                <div className="modal-win-amt">+ ¥{Number(w.won).toLocaleString()}</div>
                {w.handName && <div className="modal-hand">{w.handName}</div>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="modal-divider" />
      <div className="settle-list">
        {settle.map((s) => (
          <div key={s.id} className={`settle-row${s.id === myId ? ' hero' : ''}`}>
            <span className="sr-name">{s.name}{s.id === myId ? '（我）' : ''}</span>
            <span className={`sr-amt ${s.net === 0 ? 'sr-neutral' : s.net > 0 ? 'sr-win' : 'sr-lose'}`}>
              {amtText(s.net)}
            </span>
          </div>
        ))}
      </div>

      <div className={`modal-btn${iAmReady ? ' modal-btn--waiting' : ''}`} onClick={iAmReady ? undefined : onReady}>
        {iAmReady ? `等待其他人确认…（${readyCount}/${totalCount}）` : '我知道了'}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 改 `RoomPage.jsx`**

打开 `client/src/pages/RoomPage.jsx`，改动分三处。

第一处，新增一个 `iAmReady` state（放在其他 `useState` 旁边，第 14 行附近）：

```js
  const [actionDisabled, setActionDisabled] = useState(false);
  const [iAmReady, setIAmReady] = useState(false);
```

第二处，`useSocket` 的 handlers（第 21-42 行），改两个地方——`game:state` 要重置 `iAmReady`，`game:showdown` 直接存下完整 `winners`（不再挑 `[0]`）：

```js
  const { emit } = useSocket({
    'room:state':  (state) => setRoomState(state),
    'game:state': (state) => {
      setGameState(state);
      setShowdown(null);
      setSettlement(null);
      setIAmReady(false);
      setActionDisabled(false);
    },
    'game:showdown': ({ winners, pot, settle }) => {
      setShowdown(winners);
      setSettlement({ winners, pot, settle });
    },
    'game:ended': ({ reason }) => {
      showToast(reason ?? '游戏结束', 'info');
      setGameState(null);
      setSettlement(null);
      setIAmReady(false);
    },
    'room:kicked': () => {
      showToast('你已被房主移出房间', 'danger');
      setTimeout(onLeave, 2000);
    },
    'game:error': (msg) => { showToast(msg, 'danger'); setActionDisabled(false); },
  });
```

第三处，新增一个 `handleReady` 函数（挨着 `handleAction` 放，第 48 行附近）：

```js
  function handleReady() {
    setIAmReady(true);
    emit('game:ready-next', { playerId });
  }
```

第四处，替换渲染 `SettlementModal` 那一段（原第 100-117 行）：

```js
      {settlement && settlement.winners?.length > 0 && (
        <SettlementModal
          winners={settlement.winners}
          settle={(settlement.settle ?? []).map(s => ({ ...s }))}
          myId={playerId}
          iAmReady={iAmReady}
          readyCount={iAmReady ? 1 : 0}
          totalCount={(roomState?.players ?? []).length}
          onReady={handleReady}
        />
      )}
```

> `readyCount` 目前只能反映"我自己是否点过"，服务端没有把已确认人数广播回来——这是一个已知的简化（够用，不阻塞主流程），如果后续想要精确的"2/3 人已确认"，需要 Task 4 的 `game:ready-next` 处理里再补一次 `room:state`-类的小广播，本计划先不做，保持范围可控。

- [ ] **Step 3: CSS——把 `.settlement-sheet` 做成贴底抽屉**

打开 `client/src/styles/velvet.css`，在 `.modal-overlay` 定义（第 183 行）附近新增：

```css
.settlement-sheet {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: 50;
  background: linear-gradient(to top, #050D06 78%, rgba(5,13,6,.94));
  border-top: 1px solid rgba(212,175,55,.3);
  border-radius: 20px 20px 0 0;
  padding: 18px 20px calc(20px + env(safe-area-inset-bottom, 0px));
  max-height: 62%;
  overflow-y: auto;
  animation: slideUp .35s cubic-bezier(.34,1.56,.64,1) both;
  box-shadow: 0 -10px 40px rgba(0,0,0,.5);
}
.settlement-winners { display: flex; flex-direction: column; gap: 10px; margin: 10px 0; }
.settlement-winner-row { display: flex; align-items: center; gap: 12px; }
.modal-btn--waiting { opacity: .55; cursor: default; }
```

（`slideUp` 动画已经在 `velvet.css:148` 定义过，直接复用，不重复造一个。）

- [ ] **Step 4: 浏览器验证清单**

Run: `npm run dev`（或已有 `run` 技能），两个标签页走一局到摊牌：

- [ ] 摊牌那一刻，公共牌和双方翻开的手牌应该完整可见（不被弹窗挡住）。
- [ ] 结算面板从底部滑上来，不挡住桌面上半部分。
- [ ] 面板里列出所有赢家（用一个之前写的 3 人边池场景手动验证：短码方赢主池、另一人赢边池，两个人应该都出现在"赢家"列表里）。
- [ ] 点"我知道了"后按钮变成"等待其他人确认…"且不可再点。
- [ ] 两边都点了之后，很快（不用等 15 秒）就进入下一局或回到大厅（视是否筹码不足而定）。
- [ ] 只有一边点击时，另一边迟迟不点，等 15 秒后应该还是会自动推进（验证兜底超时没被破坏）。

- [ ] **Step 5: 跑现有 E2E，按需修复因为选择器/流程变化导致的失败**

Run: `npx playwright test`

现有测试里所有走到"结算弹窗出现"这一步的用例（`S.settlement` 目前选择器是 `.modal-overlay`，改完之后这个类不再用于结算面板），需要同步把这些测试文件里的 `settlement` 选择器改成新的 `.settlement-sheet`，并且原本"弹窗几秒后自动消失"的等待逻辑要改成"点击我知道了"：

打开 `e2e/game.spec.js`，把顶部选择器表（约第 14-33 行）里：

```js
  settlement:   '.modal-overlay',
```

改成：

```js
  settlement:   '.settlement-sheet',
```

然后搜索文件里所有出现 `S.settlement` 之后紧跟着"等待它消失/进入下一局"的地方（比如 `S3` 场景里等 settlement 关闭那一段），补上点击确认的步骤，例如：

```js
await expect(p1.locator(S.settlement)).toBeVisible({ timeout: 10000 });
await expect(p2.locator(S.settlement)).toBeVisible({ timeout: 10000 });
await p1.getByText('我知道了').click();
await p2.getByText('我知道了').click();
```

（具体要改几处以实际运行失败的用例数量为准，把每一处失败的等待逻辑照这个模式修一遍。）

Expected: 改完之后 `npx playwright test` 全绿。

- [ ] **Step 6: Commit**

```bash
git add client/src/components/SettlementModal.jsx client/src/pages/RoomPage.jsx client/src/styles/velvet.css e2e/game.spec.js
git commit -m "feat: settlement panel as bottom sheet, show all winners, wait for all to ack"
```

---

## Task 6: 牌桌上显示本人的座位/顺位

**Files:**
- Modify: `client/src/components/GameTable.jsx`（把"我"也纳入座位环，而不是单独浮在底部）
- Modify: `client/src/components/PlayerSeat.jsx`（需要支持"这是我"的视觉变体）
- Modify: `client/src/styles/velvet.css`

**设计**：不推翻现有"本人手牌卡在底部单独展示"的布局（那块是操作时最需要看清楚的区域，不能动），而是在椭圆座位环上**追加**一个本人的小座位标记（跟对手座位一样有头像、D/SB/BB 徽章、行动高亮），让人一眼看出自己在牌桌上的相对位置。真人手牌本身还是走原来底部大卡的路径。

**参考**：用户给的参考截图（某德州扑克 App）里，本人座位（图中"本小歪"）就是紧挨着底部、跟其他座位视觉规格一致的一个小座位（头像+名字+筹码），手牌单独放大展示在座位旁边——整体布局思路和这里的设计一致，是"座位环里有本人的位置，手牌另外放大"，不是"本人完全脱离座位环"。这里选择不在小座位上重复显示筹码/状态标签（Step 3 会隐藏），是因为本项目已有单独的 `.hero-section` 大卡在展示筹码，避免同一个数字在屏幕上出现两遍；如果之后觉得小座位上也该看到筹码更符合参考图的感觉，把 Step 3 那条隐藏规则删掉即可，是可逆的一行改动。

- [ ] **Step 1: `GameTable.jsx` 改动**

打开 `client/src/components/GameTable.jsx`，找到 `oppPositions` 函数（第 26-35 行），改成同时能算出"我"的位置（固定在下方 90°，即椭圆底部）：

```js
// Seat centers on the preview oval (center 187.5,292; rx 159.5, ry 180).
// Hero sits at the bottom (90°); opponents fill the remaining arc evenly.
function seatPositions(n) {
  const cx = 187.5, cy = 292, rx = 159.5, ry = 180;
  const heroPos = { x: cx, y: cy + ry };
  if (n === 0) return { hero: heroPos, opponents: [] };
  const opponents = [];
  for (let i = 0; i < n; i++) {
    const deg = n === 1 ? 270 : 150 + i * (240 / (n - 1));
    const r = (deg * Math.PI) / 180;
    opponents.push({ x: cx + rx * Math.cos(r), y: cy + ry * Math.sin(r) });
  }
  return { hero: heroPos, opponents };
}
```

（这替换掉原来的 `oppPositions`，函数改名是因为它现在管全部座位，不只是对手——调用点也要同步改。）

紧接着，在函数体里（第 39-46 行附近）把：

```js
  const ordered = getOrderedPlayers(gameState.players, myId);
  const me = ordered[0];
  const opponents = ordered.slice(1);
  const pos = oppPositions(opponents.length);
```

改成：

```js
  const ordered = getOrderedPlayers(gameState.players, myId);
  const me = ordered[0];
  const opponents = ordered.slice(1);
  const { hero: heroSeatPos, opponents: pos } = seatPositions(opponents.length);
```

然后在渲染对手座位的 `.map(...)` 块（第 108-130 行）**之前**插入本人座位标记：

```jsx
      <div
        className="player-slot player-slot--hero"
        style={{ left: `${heroSeatPos.x}px`, top: `${heroSeatPos.y}px` }}
      >
        <PlayerSeat
          player={me}
          isMe={true}
          isAction={gameState.actionPlayerId === myId}
          isWinner={winnerNames.has(me.name)}
          gamePhase={gameState.phase}
          color={colorForId(me.id)}
        />
      </div>

      {opponents.map((p, i) => {
```

（原本这行是 `{opponents.map((p, i) => {`，现在前面多了本人座位的 JSX，`opponents.map` 那一行本身不用改。）

- [ ] **Step 2: `PlayerSeat.jsx` 确认 `isMe` 分支足够**

打开 `client/src/components/PlayerSeat.jsx`，确认第 34 行的摊牌亮牌逻辑 `!isMe` 条件本来就是为了"本人手牌不需要在座位环上再摊一次（已经在底部大卡展示）"——这个逻辑天然适配新加的本人座位标记，不需要改。唯一要确认的是第 11 行 `avClass = isMe ? 'av-gold' : ...` 已经处理了"我"用金色头像的样式，直接复用，不用新增代码。

- [ ] **Step 3: CSS——本人座位标记稍微区分一下，避免跟底部大卡重复干扰视线**

打开 `client/src/styles/velvet.css`，在 `.player-slot` 定义附近新增：

```css
.player-slot--hero { z-index: 4; }
.player-slot--hero .stack-chip,
.player-slot--hero .allin-tag,
.player-slot--hero .fold-tag { display: none; } /* 筹码/状态已经在底部大卡显示，这里只需要头像+位置徽章+行动高亮，避免信息重复 */
```

- [ ] **Step 4: 浏览器验证清单**

- [ ] 2 人、3 人、6 人、9 人局分别开一局，确认本人在椭圆座位环上有一个头像标记，位置固定在桌子最下方（自己视角的"离自己最近"的位置）。
- [ ] 轮到自己行动时，这个座位标记应该也跟对手一样有金色脉冲高亮（走的是同一个 `.is-active` 逻辑，不需要额外代码，但要实际看一眼确认没有因为新增的隐藏规则把高亮也一起藏掉——检查上面 Step 3 的 CSS 选择器有没有不小心连 `.avatar` 本体也隐藏了）。
- [ ] 确认没有把底部原有的本人手牌区（大牌+筹码）挤掉或重叠。

- [ ] **Step 5: 跑 E2E 确认无回归**

Run: `npx playwright test`
Expected: 全绿——这个改动新增了 DOM 节点但没有改动任何现有选择器命中的元素，理论上不影响已有断言。

- [ ] **Step 6: Commit**

```bash
git add client/src/components/GameTable.jsx client/src/components/PlayerSeat.jsx client/src/styles/velvet.css
git commit -m "feat: show hero's own seat position on the table oval"
```

---

## Task 7: 压缩底部操作区域，给牌桌更多空间

**Files:**
- Modify: `client/src/styles/velvet.css`

- [ ] **Step 1: 调整尺寸**

打开 `client/src/styles/velvet.css`，把第 162 行：

```css
.action-bar { position:absolute; bottom:0; left:0; right:0; padding:10px 14px 26px; background:linear-gradient(to top,#050D06 68%,transparent); z-index:40; animation:slideUp .42s cubic-bezier(.34,1.56,.64,1) both; }
```

改成：

```css
.action-bar { position:absolute; bottom:0; left:0; right:0; padding:8px 14px 16px; background:linear-gradient(to top,#050D06 68%,transparent); z-index:40; animation:slideUp .42s cubic-bezier(.34,1.56,.64,1) both; }
```

第 166 行：

```css
.b-h52 { height:52px; } .b-h46 { height:46px; }
```

改成：

```css
.b-h52 { height:46px; } .b-h46 { height:42px; }
```

第 227 行（`.waiting-bar`，跟操作栏是同一块区域的两种状态，要保持视觉一致）：

```css
.game-stage .waiting-bar { position:absolute; bottom:0; left:0; right:0; padding:12px 14px 26px; background:linear-gradient(to top,#050D06 68%,transparent); display:flex; flex-direction:column; gap:9px; align-items:center; z-index:30; }
```

改成：

```css
.game-stage .waiting-bar { position:absolute; bottom:0; left:0; right:0; padding:10px 14px 16px; background:linear-gradient(to top,#050D06 68%,transparent); display:flex; flex-direction:column; gap:9px; align-items:center; z-index:30; }
```

- [ ] **Step 2: 浏览器验证清单**

- [ ] 操作栏文字/按钮没有因为变矮而挤压变形或文字被裁切。
- [ ] 加注展开面板（stepper + 确认按钮）在变矮之后依然完整可点，不溢出屏幕底部。
- [ ] 主观对比压缩前后，桌面区域可视范围确实变大了。

这一步数值（46/42px、8/16px padding）是给你一个明显但不夸张的起点，具体多"紧凑"需要你实际看了截图/真机之后反馈，这不是靠代码能自动判定对错的任务，改完发给我看一眼效果，需要的话可以继续微调。

- [ ] **Step 3: Commit**

```bash
git add client/src/styles/velvet.css
git commit -m "style: compress bottom action bar footprint"
```

---

## Task 8: 加强行动方头像的高亮/闪烁

**Files:**
- Modify: `client/src/styles/velvet.css:97-98`

- [ ] **Step 1: 加强现有动画**

打开 `client/src/styles/velvet.css`，把第 97-98 行：

```css
.is-active .avatar { border:2.5px solid #D4AF37 !important; box-shadow:0 0 0 4px rgba(212,175,55,.22), 0 0 28px rgba(212,175,55,.7) !important; animation:activePulse 1.8s ease-in-out infinite; }
@keyframes activePulse { 0%,100%{box-shadow:0 0 0 4px rgba(212,175,55,.22),0 0 18px rgba(212,175,55,.55);} 50%{box-shadow:0 0 0 5px rgba(212,175,55,.36),0 0 42px rgba(212,175,55,.95),0 0 64px rgba(212,175,55,.2);} }
```

改成（缩短周期、加大缩放和光晕变化幅度，让"轮到谁了"一眼就能注意到）：

```css
.is-active .avatar { border:3px solid #D4AF37 !important; box-shadow:0 0 0 4px rgba(212,175,55,.3), 0 0 32px rgba(212,175,55,.8) !important; animation:activePulse 1.1s ease-in-out infinite; }
@keyframes activePulse {
  0%,100% { box-shadow:0 0 0 4px rgba(212,175,55,.28),0 0 16px rgba(212,175,55,.5); transform:scale(1); }
  50%     { box-shadow:0 0 0 7px rgba(212,175,55,.42),0 0 48px rgba(212,175,55,1),0 0 80px rgba(212,175,55,.3); transform:scale(1.06); }
}
```

- [ ] **Step 2: 浏览器验证**

开一局多人对局，切到别人回合，肉眼确认高亮比之前明显（周期从 1.8s 缩短到 1.1s，多了一个轻微放大的呼吸感）。如果还是觉得不够明显，可以进一步把 `1.1s` 缩短或把 `scale(1.06)` 调大，这个数值本质是主观审美，改完给你看效果再定。

- [ ] **Step 3: Commit**

```bash
git add client/src/styles/velvet.css
git commit -m "style: make active-player highlight pulse more noticeable"
```

---

## Task 9: 下注/加注的筹码气泡增强为"气泡指向头像"样式

**Files:**
- Modify: `client/src/styles/velvet.css:116`（`.bet-chip`）

**现状**：`GameTable.jsx:127` 已经在每个下注的座位旁边渲染一个 `.bet-chip` 徽章（显示金额，动画 `chipPop`），只是样式是一个普通药丸形状，不是"从头像那边冒泡出来"的视觉语言。这里只做样式增强，不改 `GameTable.jsx` 的渲染逻辑/数据流。

- [ ] **Step 1: 加一个指向头像的小尾巴**

打开 `client/src/styles/velvet.css`，把第 116 行：

```css
.bet-chip { display:inline-flex; align-items:center; justify-content:center; padding:3px 9px; background:rgba(8,18,10,.9); border:1px solid rgba(212,175,55,.65); border-radius:20px; font-family:var(--font-mono); font-size:11px; font-weight:700; color:#F5E6A0; white-space:nowrap; letter-spacing:.3px; box-shadow:0 2px 10px rgba(0,0,0,.7),0 0 8px rgba(212,175,55,.18); animation:chipPop .3s cubic-bezier(.34,1.56,.64,1) both; }
```

改成（加 `position:relative` 给伪元素当锚点，`::after` 做一个小三角尾巴）：

```css
.bet-chip { position:relative; display:inline-flex; align-items:center; justify-content:center; padding:3px 9px; background:rgba(8,18,10,.94); border:1px solid rgba(212,175,55,.65); border-radius:20px; font-family:var(--font-amount); font-size:11px; font-weight:700; color:#F5E6A0; white-space:nowrap; letter-spacing:.3px; box-shadow:0 2px 10px rgba(0,0,0,.7),0 0 8px rgba(212,175,55,.18); animation:chipPop .3s cubic-bezier(.34,1.56,.64,1) both; }
.bet-chip::after {
  content: '';
  position: absolute; bottom: -5px; left: 50%; transform: translateX(-50%);
  width: 0; height: 0;
  border-left: 5px solid transparent; border-right: 5px solid transparent;
  border-top: 6px solid rgba(8,18,10,.94);
}
```

（`font-family` 顺手换成 Task 10 会新建的 `--font-amount` token——如果你是按本计划顺序做，Task 10 要在这之前做，或者这里先留 `var(--font-mono)` 也行，两个任务谁先谁后不影响正确性，只是最终都要收敛到同一个 token，别漏改。）

- [ ] **Step 2: 浏览器验证**

有人下注/加注时，筹码徽章下方应该有一个小三角尾巴指向对应的座位方向（`GameTable.jsx:110-111` 已经在算 `betStyle` 把徽章往桌子中心方向偏移，尾巴视觉上应该看起来像"从头像那边冒出来的"）。

- [ ] **Step 3: Commit**

```bash
git add client/src/styles/velvet.css
git commit -m "style: give bet-chip badge a speech-bubble tail toward the seat"
```

---

## Task 10: 金额统一使用 Inter 字体，底池数字缩小

**Files:**
- Modify: `client/src/styles/tokens.css`
- Modify: `client/src/styles/velvet.css`

**范围界定**：只改"显示金额数字"的类（底池、个人筹码、下注气泡、结算金额、加注 stepper 数值），不改非金额的标签文字（街道名、D/SB/BB 徽章、"弃牌"/"ALL IN"标签、手牌描述文字）——那些继续用现有的 `--font-mono` 装饰性等宽字体，保留桌面的整体气质，只是"钱"这个最需要一眼看清楚的信息换成更清晰的无衬线字体。

- [ ] **Step 1: 引入 Inter，新增专用 token**

打开 `client/src/styles/tokens.css`，把第 4 行的 Google Fonts import：

```css
@import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700;900&family=Crimson+Pro:ital,wght@0,300;0,400;0,600;1,400&family=DM+Serif+Display&family=Oswald:wght@600;700&family=Space+Mono:wght@400;700&display=swap');
```

改成（加 Inter）：

```css
@import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700;900&family=Crimson+Pro:ital,wght@0,300;0,400;0,600;1,400&family=DM+Serif+Display&family=Oswald:wght@600;700&family=Space+Mono:wght@400;700&family=Inter:wght@500;600;700&display=swap');
```

再找到第 61-62 行：

```css
  --font-numerals: 'DM Serif Display', serif;  /* hero numbers: pot / win amount */
  --font-card: 'Oswald', sans-serif;            /* card ranks (tidy "10") */
```

在下面新增一行：

```css
  --font-numerals: 'DM Serif Display', serif;  /* hero numbers: pot / win amount */
  --font-card: 'Oswald', sans-serif;            /* card ranks (tidy "10") */
  --font-amount: 'Inter', -apple-system, sans-serif; /* 所有金额数字统一用这个 */
```

- [ ] **Step 2: 把金额相关的类切到新 token**

打开 `client/src/styles/velvet.css`，逐一替换以下几行的 `font-family`（只改这几处，其它用 `--font-mono` 的非金额标签不动）：

第 73 行（底池数字，顺手把字号从 33px 缩小到 24px，对应用户"底池数字不用太大"的反馈）：

```css
.pot-amt { font-family:var(--font-numerals); font-size:33px; font-weight:400; color:#E8C24A; letter-spacing:.5px; text-shadow:0 0 26px rgba(212,175,55,.5), 0 2px 10px rgba(0,0,0,.65); line-height:1.05; }
```

改成：

```css
.pot-amt { font-family:var(--font-amount); font-size:24px; font-weight:700; color:#E8C24A; letter-spacing:.2px; text-shadow:0 0 20px rgba(212,175,55,.45), 0 2px 8px rgba(0,0,0,.6); line-height:1.05; }
```

第 109 行（`.stack-chip`）：

```css
.stack-chip { position:absolute; top:calc(100% + 5px); left:50%; transform:translateX(-50%); font-family:var(--font-mono); font-size:10px; color:#9FB0AC; text-shadow:0 1px 3px rgba(0,0,0,.85); white-space:nowrap; }
```

`font-family` 改成 `var(--font-amount)`。

第 116 行（`.bet-chip`，如果 Task 9 已经做过这一步就跳过，两个任务改的是同一行，别重复加）：`font-family` 改成 `var(--font-amount)`。

第 130 行（`.hero-chips`）：

```css
.hero-chips { font-family:var(--font-mono); font-size:12px; color:#D4AF37; background:rgba(212,175,55,.08); border:1px solid rgba(212,175,55,.2); border-radius:13px; padding:3px 14px; display:inline-block; margin-top:3px; }
```

`font-family` 改成 `var(--font-amount)`。

第 131 行（`.hero-bet`）：`font-family` 改成 `var(--font-amount)`。

第 135 行（`.bankroll`）：`font-family` 改成 `var(--font-amount)`。

第 178 行（`.step-val`，加注 stepper 当前数值）：`font-family` 改成 `var(--font-amount)`。

第 190 行（`.modal-win-amt`，注意这个类在新的 `SettlementModal.jsx`——Task 5 里还在用）：

```css
.modal-win-amt { font-family:var(--font-numerals); font-size:32px; font-weight:400; letter-spacing:.5px; color:#D4AF37; }
```

改成：

```css
.modal-win-amt { font-family:var(--font-amount); font-size:26px; font-weight:700; letter-spacing:.2px; color:#D4AF37; }
```

第 197 行（`.sr-amt`，结算列表每行的输赢金额）：`font-family` 改成 `var(--font-amount)`。

第 214 行（`.pr-chips`，大厅玩家列表的筹码数）：`font-family` 改成 `var(--font-amount)`。

- [ ] **Step 2.5: 确认没有漏改/错改**

Run: `cd "/Users/reyes/测试 OpenStack/client/src" && grep -n "font-family" styles/velvet.css | grep -v "font-amount"`

检查输出，确认里面剩下的都是非金额的类（`.street-tag` `.pot-label` `.pos-badge` `.fold-tag` `.allin-tag` `.hand-rank` `.waiting-text` `.lobby-blind` `.lobby-sec` `.lobby-restart` 等标签/文案）——如果看到 `.stack-chip` `.bet-chip` `.hero-chips` `.hero-bet` `.bankroll` `.step-val` `.modal-win-amt` `.sr-amt` `.pr-chips` 这几个还留在结果里说明漏改了，回去补上。

- [ ] **Step 3: 浏览器验证清单**

- [ ] 底池数字、个人筹码、下注气泡、结算面板里的金额、加注 stepper 数值，字体应该都统一变成 Inter（无衬线，数字清晰），不再是原来花体/等宽混杂的样子。
- [ ] 底池数字明显比之前小一圈。
- [ ] 街道标签（"翻牌前"/"翻牌圈"…）、D/SB/BB 徽章、"弃牌"/"ALL IN"标签这些**不是**金额的文字，应该还是原来的等宽字体没变——确认没有被误改。

- [ ] **Step 4: 跑 E2E 确认无回归**

Run: `npx playwright test`
Expected: 全绿（纯字体/字号改动，不涉及任何选择器或文案变化）。

- [ ] **Step 5: Commit**

```bash
git add client/src/styles/tokens.css client/src/styles/velvet.css
git commit -m "style: unify money amounts to Inter font, shrink pot number"
```

---

## Task 11: 加注区新增 All-In 快捷按钮

**Files:**
- Modify: `client/src/components/ActionBar.jsx`
- Modify: `client/src/styles/velvet.css`

**依赖**：Task 1（服务端 `raise()` 上限校验）先做完，这样这里发送 `maxRaise`（等于玩家全部筹码）在任何情况下都是安全的，不会因为一个已知漏洞被下游放大成脏数据。

- [ ] **Step 1: 加按钮**

打开 `client/src/components/ActionBar.jsx`，找到 `raise-bottom` 那一段（第 43-46 行）：

```jsx
          <div className="raise-bottom">
            <button className="btn b-cancel b-h46" onClick={() => setOpen(false)}>← 返回</button>
            <button className="btn b-fold b-h46" style={{ flex: 1 }} onClick={() => act('fold')}>弃牌</button>
          </div>
```

改成：

```jsx
          <div className="raise-bottom">
            <button className="btn b-cancel b-h46" onClick={() => setOpen(false)}>← 返回</button>
            <button className="btn b-allin b-h46" style={{ flex: 1 }} onClick={() => act('raise', maxRaise)}>全下 ALL IN</button>
            <button className="btn b-fold b-h46" style={{ flex: 1 }} onClick={() => act('fold')}>弃牌</button>
          </div>
```

（`maxRaise` 这个变量在同一个组件的第 16 行已经算好了：`const maxRaise = me.chips + me.bet;`，直接复用，不需要新算一遍。）

- [ ] **Step 2: 加样式**

打开 `client/src/styles/velvet.css`，找一个已有按钮样式类（比如 `.b-fold` 或 `.b-call`）参考其结构，新增：

```css
.b-allin { background: linear-gradient(135deg, #8A2416, #C0392B); color: #F5E6A0; border: 1px solid rgba(212,175,55,.5); font-weight: 700; }
.b-allin:active { filter: brightness(1.15); }
```

（具体配色跟现有 `.b-fold`/`.b-call`/`.b-raise-trigger` 的写法风格保持一致——打开 `velvet.css` 搜 `.b-fold {` 抄一下现有按钮类的属性列表结构，别漏了 `border-radius`/`font-family` 这些每个按钮都有的基础属性，我这里只列出跟其它按钮不一样、需要区分开的部分。）

- [ ] **Step 3: 浏览器验证清单**

- [ ] 点开"加注 ▸"面板，能看到"全下 ALL IN"按钮，跟"返回"/"弃牌"并排。
- [ ] 点击后应该直接让本方全下（筹码变 0，状态变 `allin`），不需要先拖 stepper 到底。
- [ ] 结合 Task 1：故意在浏览器 devtools 里改小 `me.chips` 之类的手段是测不出服务端校验的（客户端状态跟服务端权威状态是分开的），如果想验证服务端校验生效，用 Task 1 的服务端单测覆盖即可，这里浏览器验证只需要确认正常点击流程好用。

- [ ] **Step 4: 跑 E2E 确认无回归，且原本"点击 stepper 60 次模拟全下"的测试可以顺便简化**

Run: `npx playwright test`

顺手可以把 `e2e/game.spec.js` 里原本靠"点 60 次 + 号"来模拟全下的地方（`S3` 场景、`S6` 场景，如果 Task 2 已经加了 `S6`）改成直接点新的全下按钮，减少测试的脆弱性和运行时间，例如把：

```js
    await actor.locator(S.raiseBtn).click();
    const plusBtn = actor.locator('.step-btn').nth(1);
    for (let i = 0; i < 60; i++) await plusBtn.click();
    await actor.locator('.b-confirm-raise').click();
```

改成：

```js
    await actor.locator(S.raiseBtn).click();
    await actor.locator('.b-allin').click();
```

这个简化是可选的（不改也不算错），但因为顺手就在这个任务里做了 UI，建议一起做掉，减少后续维护成本。

- [ ] **Step 5: Commit**

```bash
git add client/src/components/ActionBar.jsx client/src/styles/velvet.css e2e/game.spec.js
git commit -m "feat: add All-In quick action button to raise panel"
```

---

## 收尾：SDD 文档同步

- [ ] **Step 1: 更新 `openspec/changes/online-texas-holdem/tasks.md`**

在文件末尾新增一节，记录这批修复（跟之前"Bug 修复记录"章节风格保持一致）：

```markdown
## 11. 用户实测反馈修复（2026-07-17）

- [ ] 11.1 加注/全下金额不能超过玩家自己筹码——服务端 `raise()` 补上限校验（GameEngine.js）
- [ ] 11.2 一方 All-In 后，剩余唯一可行动玩家不应再被要求继续操作——`_nextStreet()` 补"≤1可行动玩家自动摊牌"判断（GameEngine.js）
- [ ] 11.3 移动端缩放常量修复：`useStageScale.js` 高度基准 712→812，修正顶部内容溢出屏幕
- [ ] 11.4 结算流程改为"所有人确认才推进"：新增 `game:ready-next` 协议 + 15 秒兜底超时
- [ ] 11.5 结算面板改为底部抽屉（不再遮挡摊牌），展示全部赢家（含边池场景的多个赢家）
- [ ] 11.6 牌桌座位环新增本人座位标记
- [ ] 11.7 压缩底部操作区域尺寸
- [ ] 11.8 行动方高亮动画加强
- [ ] 11.9 下注气泡加"指向头像"的视觉样式
- [ ] 11.10 金额统一 Inter 字体，底池数字缩小
- [ ] 11.11 加注区新增 All-In 快捷按钮

**已知边界情况（记录不修）**：`GameEngine` 构造函数在两人筹码都低于盲注、开局即全下的极端场景下，`actionIndex` 会变成 -1 导致牌局卡死无法自动摊牌（`GameEngine.js:68-74`）。触发概率低（需要玩家被打到个位数筹码），完整修复需要改 `Room.startGame()`/`nextRound()` 让调用方感知"构造时即结束"，改动面较大，本轮不做，需要时单独立项。
```

每个任务实际做完之后记得把对应的 `[ ]` 改成 `[x]`（照本仓库 `CLAUDE.md` 的 SDD 工作流约定，任务完成要勾选）。

- [ ] **Step 2: Commit**

```bash
git add "openspec/changes/online-texas-holdem/tasks.md"
git commit -m "docs: track user-reported UX and logic fixes in SDD tasks"
```

---

## Self-Review 记录

- **Spec 覆盖**：归类总览表里的 11 条用户反馈，每条都能对应到一个 Task（Task 1=筹码上限，Task 2=重复操作，Task 3=移动端，Task 4+5=结算弹窗两条反馈，Task 6=本人座位，Task 7=操作区压缩，Task 8=高亮，Task 9=下注气泡，Task 10=字体+底池字号，Task 11=All-In 按钮）。额外发现的构造函数边界情况已记录但明确标注不在本轮范围内。
- **占位符检查**：全文没有 TBD/"适当处理"/"类似 Task N 那样写"这类占位表达，每个 Step 要么是可直接运行的命令，要么是完整代码块。
- **类型/命名一致性**：`SettlementModal` 新 props（`winners`/`settle`/`myId`/`readyCount`/`totalCount`/`iAmReady`/`onReady`）在 Task 5 的 Step 1（组件定义）和 Step 2（`RoomPage.jsx` 调用处）保持一致；`game:ready-next` 事件名在 Task 4（服务端监听）和 Task 5（客户端 `emit`）保持一致；`--font-amount` token 在 Task 9 和 Task 10 都有引用，Task 10 是定义它的地方，两个任务哪个先做都不冲突（Task 9 如果先做，`var(--font-amount)` 在 token 还没定义前是无效引用，浏览器会 fallback 到继承字体，不会报错，但建议按本文档顺序先做 Task 10 再做 Task 9，或者两个一起做掉）。
