# 打法点评（本场之最）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一局游戏结束、账本弹出时，在账本里加一段"本场之最"颁奖式打法点评（9 个奖、每人最多一个），根据这个房间打过的所有牌算。

**Architecture:** 两个服务端纯函数模块——累加器（每手动作 → per-player 计数器）+ 奖项计算器（全桌计数器 → 奖项列表）。`Room` 上挂一份计数器 map，每手结束增量累加，随房间生命周期、不持久化。客户端在打开账本时用一个 `room:get-style-recap` 请求拿现算的奖项列表，`LedgerModal` 渲染。

**Tech Stack:** Node + socket.io（服务端）、vitest（测试）、`pokersolver`（已有依赖，手牌评估）、React/Vite（客户端）、Playwright（e2e）。

## Global Constraints

- **只处理多人房间对局**；人机对战（PVE）完全不涉及，不碰 `PveSession` / `pveStore` / `pveStrategy` 的调用方（`pveStrategy` 的纯函数可 `require` 复用）。
- **不做持久化、不做快照**：计数器活在 `Room` 实例上，`restart()` 时清空（跟 `handHistory`/`chatLog` 一致），房主"结束游戏"不清、服务重启自然没。
- **v1 不做"剔除自己"开关**，全员公开，服务端算一次全桌同一份。
- **不长期存原始逐动作**：`GameEngine.actionLog` 只在一手内存在，每手结束喂给累加器后随 `game` 对象一起被丢弃；累加器只留固定大小的计数器。
- 奖名固定为这 9 个中文标签，逐字：`手痒星人` `养生局` `梭哈人格` `牌桌 NPC` `我倒要看看` `秒怂` `影帝` `惯性开火` `加你一脸`。
- 测试：服务端单测为主（vitest，构造确定性 fixture）；新增 e2e 一条（`server/__tests__/integration.test.js`，两 socket 打若干手 + 请求 recap）。
- commit message 用英文，`type: description` 格式。

---

## File Structure

| 文件 | 职责 | 新建/改 |
|---|---|---|
| `server/playstyleStats.js` | 纯函数：手牌强度分类 + 单手累加器 + 空计数器工厂 | 新建 |
| `server/playstyleAwards.js` | 纯函数：全桌计数器 → 奖项列表（门槛过滤 + 每人一个奖冲突顺延 + 上限） | 新建 |
| `server/__tests__/playstyleStats.test.js` | 上者的单测 | 新建 |
| `server/__tests__/playstyleAwards.test.js` | 上者的单测 | 新建 |
| `server/GameEngine.js` | `_recordAction` 里往新的 `this.actionLog` push 一条结构化记录 | 改 |
| `server/RoomManager.js` | `Room` 挂 `playstyleStats` + `recordHandForPlaystyle(hand)`；`restart()` 清空 | 改 |
| `server/index.js` | `handleActionResult` 里每手结束调 `recordHandForPlaystyle`；新增 `room:get-style-recap` → `room:style-recap` handler | 改 |
| `client/src/pages/RoomPage.jsx` | `styleRecap` state + `room:style-recap` handler + 打开账本时 `emit('room:get-style-recap')` + 传 prop（两处 `<LedgerModal>`） | 改 |
| `client/src/components/LedgerModal.jsx` | 账本盈亏表下加"本场之最"段，读新 prop `styleRecap` | 改 |
| `client/src/styles/velvet.css` | "本场之最"段的样式（`.ledger-recap*`），紧挨现有 `.ledger-egg-note`（约 1369 行） | 改 |
| `server/__tests__/integration.test.js` | e2e：两 socket 打几手 + 房主结束 + 请求 recap，断言返回结构 | 改 |

---

## 计数器字段（`emptyPlayerStats()` 的返回，全 0）

```js
{
  handsDealt: 0,        // 被发牌的手数
  handsVPIP: 0,         // 这手主动往池里放过钱（跟注/加注/再加注；只发盲注不算）
  handsPFR: 0,          // 这手翻前主动加注过
  light3bet: 0,         // 翻前：面对别人的加注，自己又再加注（近似"空手 3-bet"，不看牌力，只看动作）
  postflopBets: 0,      // 翻后主动下注次数（该街此前无人下注）
  postflopRaises: 0,    // 翻后加注次数（该街此前已有下注）
  postflopCalls: 0,     // 翻后跟注次数
  postflopDecisions: 0, // 翻后总决策次数（bet/raise/call/check/fold 都算）——门槛用
  sawFlop: 0,           // 看到翻牌的手数（发到翻牌时还没弃牌）
  wentToShowdown: 0,    // 看到翻牌 且 打到摊牌没弃牌的手数
  facedRaise: 0,        // 翻后轮到自己时面前有需要跟的注的次数
  foldedToRaise: 0,     // 上者中选择弃牌的次数
  airFires: 0,          // 见「airFires 判定」
  cbetOpp: 0,           // 这手是翻前最后加注方 且 看到了翻牌
  cbets: 0,             // 上者中翻牌圈由自己第一个下注
  cbetAir: 0,           // 上者中下注时牌是 air
}
```

### `accumulateHand` 输入

```js
hand = {
  actionLog,        // GameEngine.actionLog：[{ playerId, phase, type, amount }]
                    //   phase ∈ 'preflop'|'flop'|'turn'|'river'
                    //   type  ∈ 'fold'|'check'|'call'|'raise'|'allin'
  allHoleCards,     // result.allHoleCards：[{ id, holeCards: ['As','Kd'] }]（每手都有，含弃牌方）
  communityCards,   // result.state.communityCards：最终公共牌，0/3/4/5 张（'Ah' 字符串）
  dealtInIds,       // 这手被发牌的 playerId 列表（= allHoleCards.map(c => c.id)）
}
```

### 每街的可见公共牌

- `flop` 动作看 `communityCards.slice(0, 3)`
- `turn` 动作看 `communityCards.slice(0, 4)`
- `river` 动作看 `communityCards.slice(0, 5)`

（一手若在翻牌圈结束，`communityCards` 只有 3 张——此时不会有 turn/river 动作，安全。）

### airFires 判定

对每个玩家在 **flop/turn/river** 的每次 `raise`（含首个 `bet`——引擎里首个下注也是 `type:'raise'`，见下方 Task 1 说明）或加注型 `allin`：

- 用 `classifyHoldingStrength(holeCards, boardVisibleThisStreet)` 得到 `'made'|'draw'|'air'`
- 若为 `'air'`：
  - `turn`/`river`：直接 `airFires += 1`
  - `flop`：**排除标准持续下注**——若该玩家是本手翻前最后加注方（`isPreflopAggressor`）且这是翻牌圈第一个下注动作，则算 `cbet`（`cbets++`, `cbetAir++`），**不计 airFires**；否则（空气 check-raise / donk / 反加）`airFires += 1`

`classifyHoldingStrength`：

- `made` = `pokersolver` 的 `Hand.solve([...hole, ...board]).name !== 'High Card'`（任何成对及以上）
- `draw` = 不是 made，但（4 张同花色）或（4 连张顺子听牌，A 可高可低）
- `air` = 其余

### 其它计数细节

- **VPIP**：`actionLog` 里该玩家 `phase==='preflop'` 有过 `call`/`raise`/`allin` → `handsVPIP++`（`check` 不算，大盲无人加注时轮到他 check 也不算主动放钱）
- **PFR**：preflop 有过 `raise` 或加注型 `allin` → `handsPFR++`
- **light3bet**：preflop 动作序列里，在该玩家某次 `raise` 之前，已经有过**别人**的 `raise`（即盘面已经不是"首次加注"）→ `light3bet++`（每手最多计一次）
- **翻后 bet vs raise**：遍历某街动作，维护"这街是否已有人下过注"标记；该玩家动作是 `raise` 且标记为 false → `postflopBets++` 且把标记置 true；标记为 true → `postflopRaises++`
- **facedRaise / foldedToRaise**：翻后轮到该玩家时，若该街在他此次动作之前已有人 `raise`/加注型 `allin`（面前有注要跟）→ `facedRaise++`；他这次动作是 `fold` → `foldedToRaise++`
- **sawFlop**：`communityCards.length >= 3` 且该玩家在 preflop 没弃牌（preflop 动作序列里他最后一个动作不是 `fold`，或他 preflop 没动作但在 `dealtInIds` 里且盲注没弃——简化：preflop 里他没 `fold` 过就算看到翻牌，只要 `communityCards.length>=3`）
- **wentToShowdown**：`sawFlop` 命中 且 该玩家整手（所有街）没有 `fold` 动作
- **postflopDecisions**：该玩家在 flop/turn/river 的动作条数

---

## Task 1: GameEngine 记录逐动作日志

**Files:**
- Modify: `server/GameEngine.js`（constructor 约 126 行、`_recordAction` 约 197-203 行）
- Test: `server/__tests__/GameEngine.test.js`

**Interfaces:**
- Produces: `GameEngine` 实例新增 `this.actionLog: Array<{ playerId: string, phase: 'preflop'|'flop'|'turn'|'river', type: 'fold'|'check'|'call'|'raise'|'allin', amount: number }>`，一手内累积，按发生顺序。`amount` 对 `fold`/`check` 为 `0`。

- [ ] **Step 1: 写失败测试**

在 `server/__tests__/GameEngine.test.js` 末尾（最后一个 `describe` 之后）加：

```js
describe('GameEngine — actionLog（打法点评用）', () => {
  it('初始为空数组', () => {
    const game = new GameEngine(makePlayers(3), 0, 200);
    expect(game.actionLog).toEqual([]);
  });

  it('记录每个合法动作的 playerId/phase/type/amount，按顺序', () => {
    const game = new GameEngine(makePlayers(3), 0, 200);
    // 3 人局，行动从 dealer+3 开始（=p1，dealerIndex=0）
    const first = game.players[game.actionIndex].id;
    game.call(first);                       // 跟大盲 200
    const second = game.players[game.actionIndex].id;
    game.raise(second, 600);               // 加注到 600
    const third = game.players[game.actionIndex].id;
    game.fold(third);

    expect(game.actionLog).toEqual([
      { playerId: first, phase: 'preflop', type: 'call', amount: 200 },
      { playerId: second, phase: 'preflop', type: 'raise', amount: 600 },
      { playerId: third, phase: 'preflop', type: 'fold', amount: 0 },
    ]);
  });

  it('被拒绝的非法动作不进 actionLog', () => {
    const game = new GameEngine(makePlayers(2), 0, 200);
    const notTurn = game.players[(game.actionIndex + 1) % 2].id;
    game.fold(notTurn); // '还没轮到你'
    expect(game.actionLog).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run __tests__/GameEngine.test.js -t "actionLog"`
Expected: FAIL —`game.actionLog` 为 `undefined`。

- [ ] **Step 3: 实现**

`server/GameEngine.js` constructor 里，紧挨 `this.lastActionPhase = null;`（约 168 行）之后加：

```js
    // 一手内的逐动作日志——打法点评（本场之最）的累加器要用。只在一手内存在，
    // 每手结束喂给累加器后随 game 对象一起被丢弃，不长期保留。
    this.actionLog = [];
```

`_recordAction(playerId, label)` 方法体末尾（`this.lastActionPhase = this.phase;` 之后）加：

```js
    this.actionLog.push({
      playerId,
      phase: this.phase,
      type: label.type,
      amount: label.amount ?? 0,
    });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx vitest run __tests__/GameEngine.test.js`
Expected: PASS（新 3 条 + 既有全过）。

- [ ] **Step 5: Commit**

```bash
git add server/GameEngine.js server/__tests__/GameEngine.test.js
git commit -m "feat: GameEngine records a per-hand actionLog for playstyle stats"
```

---

## Task 2: 手牌强度分类器

**Files:**
- Create: `server/playstyleStats.js`
- Test: `server/__tests__/playstyleStats.test.js`

**Interfaces:**
- Produces: `classifyHoldingStrength(holeCards: string[2], board: string[]): 'made'|'draw'|'air'`。牌用 `pokersolver` 记法（`'As'`,`'Td'`,`'9h'`,`'2c'`）。`board` 3-5 张。

- [ ] **Step 1: 写失败测试**

Create `server/__tests__/playstyleStats.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { classifyHoldingStrength } = require('../playstyleStats');

describe('classifyHoldingStrength', () => {
  it('成对及以上 = made', () => {
    expect(classifyHoldingStrength(['Ah', 'Kd'], ['Ac', '7s', '2d'])).toBe('made'); // 一对A
    expect(classifyHoldingStrength(['5h', '5d'], ['Ac', '7s', '2d'])).toBe('made'); // 口袋对
    expect(classifyHoldingStrength(['Ah', 'Kh'], ['Qh', 'Jh', 'Th'])).toBe('made'); // 皇家同花顺
  });

  it('同花听牌（4 张同花色）= draw', () => {
    expect(classifyHoldingStrength(['Ah', 'Kh'], ['7h', '2h', '9c'])).toBe('draw');
  });

  it('两头顺听牌（4 连张）= draw', () => {
    expect(classifyHoldingStrength(['9c', '8d'], ['7h', '6s', '2c'])).toBe('draw'); // 6-7-8-9
    expect(classifyHoldingStrength(['Ac', '2d'], ['3h', '4s', 'Kc'])).toBe('draw'); // A-2-3-4（A 可低）
  });

  it('没对、没听牌 = air', () => {
    expect(classifyHoldingStrength(['Kc', '7d'], ['Ah', '9s', '2c'])).toBe('air');
    expect(classifyHoldingStrength(['Qc', '4d'], ['Ah', '9s', '2c', 'Js'])).toBe('air');
  });

  it('卡顺听牌不算 draw（只认两头顺）', () => {
    // 9-8 + J-7-2：缺 T，卡顺
    expect(classifyHoldingStrength(['9c', '8d'], ['Jh', '7s', '2c'])).toBe('air');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run __tests__/playstyleStats.test.js`
Expected: FAIL —`Cannot find module '../playstyleStats'`。

- [ ] **Step 3: 实现**

Create `server/playstyleStats.js`:

```js
// 打法点评（本场之最）的纯函数：手牌强度分类 + 单手累加器。
// 不依赖 socket / Room，只吃数据、吐数据，方便单测。
const { Hand } = require('pokersolver');

const RANK_ORDER = '23456789TJQKA';

// 'made'：成对及以上 | 'draw'：同花听牌或两头顺听牌 | 'air'：其余
function classifyHoldingStrength(holeCards, board) {
  const cards = [...holeCards, ...board];
  const solved = Hand.solve(cards);
  if (solved.name !== 'High Card') return 'made';

  // 同花听牌：任一花色出现 >= 4 次
  const suitCounts = {};
  for (const c of cards) suitCounts[c[1]] = (suitCounts[c[1]] || 0) + 1;
  if (Object.values(suitCounts).some(n => n >= 4)) return 'draw';

  // 两头顺听牌：存在 4 个连续 rank（A 可高可低）。只认两头顺，不认卡顺。
  const idxSet = new Set();
  for (const c of cards) {
    const i = RANK_ORDER.indexOf(c[0]);
    idxSet.add(i);
    if (c[0] === 'A') idxSet.add(-1); // A 也当作 2 之下一格
  }
  const sorted = [...idxSet].sort((a, b) => a - b);
  let run = 1;
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k] === sorted[k - 1] + 1) {
      run += 1;
      if (run >= 4) return 'draw';
    } else {
      run = 1;
    }
  }
  return 'air';
}

module.exports = { classifyHoldingStrength };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx vitest run __tests__/playstyleStats.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/playstyleStats.js server/__tests__/playstyleStats.test.js
git commit -m "feat: playstyleStats.classifyHoldingStrength (made/draw/air)"
```

---

## Task 3: 空计数器 + 单手累加器

**Files:**
- Modify: `server/playstyleStats.js`
- Test: `server/__tests__/playstyleStats.test.js`

**Interfaces:**
- Produces:
  - `emptyPlayerStats(): object` —— 上文「计数器字段」全 0 的对象。
  - `accumulateHand(statsMap: Record<string, PlayerStats>, hand: { actionLog, allHoleCards, communityCards, dealtInIds }): void` —— 原地更新 `statsMap`；`statsMap` 里没有的 playerId 会用 `emptyPlayerStats()` 补上。

- [ ] **Step 1: 写失败测试**

在 `server/__tests__/playstyleStats.test.js` 顶部 require 改为：

```js
const { classifyHoldingStrength, emptyPlayerStats, accumulateHand } = require('../playstyleStats');
```

追加：

```js
describe('emptyPlayerStats', () => {
  it('所有字段为 0', () => {
    const s = emptyPlayerStats();
    for (const k of ['handsDealt', 'handsVPIP', 'handsPFR', 'light3bet', 'postflopBets',
      'postflopRaises', 'postflopCalls', 'postflopDecisions', 'sawFlop', 'wentToShowdown',
      'facedRaise', 'foldedToRaise', 'airFires', 'cbetOpp', 'cbets', 'cbetAir']) {
      expect(s[k]).toBe(0);
    }
  });
});

describe('accumulateHand', () => {
  // 三人手：A 翻前加注、B 跟、C 弃；翻牌 A 空气持续下注、B 跟；转牌 A 空气再开火、B 弃
  const hand = {
    dealtInIds: ['A', 'B', 'C'],
    communityCards: ['2c', '7d', 'Ts', 'Jh'],
    allHoleCards: [
      { id: 'A', holeCards: ['Kd', '4c'] }, // 翻牌/转牌都是空气
      { id: 'B', holeCards: ['9h', '9s'] }, // 口袋对（made）
      { id: 'C', holeCards: ['2h', '3h'] },
    ],
    actionLog: [
      { playerId: 'A', phase: 'preflop', type: 'raise', amount: 600 },
      { playerId: 'B', phase: 'preflop', type: 'call', amount: 600 },
      { playerId: 'C', phase: 'preflop', type: 'fold', amount: 0 },
      { playerId: 'A', phase: 'flop', type: 'raise', amount: 400 }, // 首个下注 = bet；A 是翻前加注方 → cbet
      { playerId: 'B', phase: 'flop', type: 'call', amount: 400 },
      { playerId: 'A', phase: 'turn', type: 'raise', amount: 800 }, // 转牌空气开火
      { playerId: 'B', phase: 'turn', type: 'fold', amount: 0 },
    ],
  };

  it('VPIP / PFR / 翻后动作 / 摊牌 / cbet / airFires 计数正确', () => {
    const m = {};
    accumulateHand(m, hand);

    expect(m.A.handsDealt).toBe(1);
    expect(m.B.handsDealt).toBe(1);
    expect(m.C.handsDealt).toBe(1);

    expect(m.A.handsVPIP).toBe(1);
    expect(m.A.handsPFR).toBe(1);
    expect(m.B.handsVPIP).toBe(1); // 跟注
    expect(m.B.handsPFR).toBe(0);
    expect(m.C.handsVPIP).toBe(0); // 只弃牌

    expect(m.A.sawFlop).toBe(1);
    expect(m.B.sawFlop).toBe(1);
    expect(m.C.sawFlop).toBe(0);
    expect(m.A.wentToShowdown).toBe(0); // 没打到摊牌（B 转牌弃了，但这里看 A/B 各自）
    expect(m.B.wentToShowdown).toBe(0); // B 转牌 fold

    // A 翻牌：bet（首下注）+ 是翻前加注方 + 空气 → cbet & cbetAir，不计 airFires
    expect(m.A.cbetOpp).toBe(1);
    expect(m.A.cbets).toBe(1);
    expect(m.A.cbetAir).toBe(1);
    expect(m.A.postflopBets).toBe(1); // 翻牌那次
    // A 转牌 raise（该街首下注也算 bet）+ 空气 → airFires
    expect(m.A.airFires).toBe(1);
    expect(m.A.postflopBets).toBeGreaterThanOrEqual(1);

    // B 面对 A 的转牌下注选择弃牌
    expect(m.B.facedRaise).toBe(1);
    expect(m.B.foldedToRaise).toBe(1);
    expect(m.B.postflopCalls).toBe(1); // 翻牌跟注
  });

  it('同一 map 连续喂两手会累加', () => {
    const m = {};
    accumulateHand(m, hand);
    accumulateHand(m, hand);
    expect(m.A.handsDealt).toBe(2);
    expect(m.A.airFires).toBe(2);
  });

  it('light3bet：翻前有人先加注、自己再加注', () => {
    const m = {};
    accumulateHand(m, {
      dealtInIds: ['A', 'B'],
      communityCards: [],
      allHoleCards: [{ id: 'A', holeCards: ['7c', '2d'] }, { id: 'B', holeCards: ['As', 'Ad'] }],
      actionLog: [
        { playerId: 'A', phase: 'preflop', type: 'raise', amount: 600 },
        { playerId: 'B', phase: 'preflop', type: 'raise', amount: 1800 }, // 3-bet
        { playerId: 'A', phase: 'preflop', type: 'fold', amount: 0 },
      ],
    });
    expect(m.B.light3bet).toBe(1);
    expect(m.A.light3bet).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run __tests__/playstyleStats.test.js`
Expected: FAIL —`emptyPlayerStats is not a function`。

- [ ] **Step 3: 实现**

`server/playstyleStats.js` 追加（`module.exports` 之前）：

```js
function emptyPlayerStats() {
  return {
    handsDealt: 0, handsVPIP: 0, handsPFR: 0, light3bet: 0,
    postflopBets: 0, postflopRaises: 0, postflopCalls: 0, postflopDecisions: 0,
    sawFlop: 0, wentToShowdown: 0, facedRaise: 0, foldedToRaise: 0,
    airFires: 0, cbetOpp: 0, cbets: 0, cbetAir: 0,
  };
}

const STREET_BOARD_LEN = { flop: 3, turn: 4, river: 5 };
const AGGRO_TYPES = new Set(['raise', 'allin']); // 引擎里首个下注也是 'raise'；'allin' 里含加注型

function accumulateHand(statsMap, hand) {
  const { actionLog, allHoleCards, communityCards, dealtInIds } = hand;
  const get = (id) => (statsMap[id] || (statsMap[id] = emptyPlayerStats()));
  const holeOf = (id) => allHoleCards.find((c) => c.id === id)?.holeCards || null;
  const boardFor = (phase) => communityCards.slice(0, STREET_BOARD_LEN[phase] ?? 0);

  for (const id of dealtInIds) get(id).handsDealt += 1;

  // ── 翻前 ──
  const preflop = actionLog.filter((a) => a.phase === 'preflop');

  // VPIP / PFR：每手每人最多 +1（有没有主动放钱 / 有没有加注，是布尔）
  for (const id of new Set(preflop.map((a) => a.playerId))) {
    const acts = preflop.filter((a) => a.playerId === id).map((a) => a.type);
    if (acts.some((t) => t === 'call' || AGGRO_TYPES.has(t))) get(id).handsVPIP += 1;
    if (acts.some((t) => AGGRO_TYPES.has(t))) get(id).handsPFR += 1;
  }

  // light3bet：按顺序扫，某人 raise 之前盘面已经有过别人的 raise（即不是首次加注）。每手每人最多 +1。
  let seenPreflopRaise = false;
  const countedLight3bet = new Set();
  for (const a of preflop) {
    if (!AGGRO_TYPES.has(a.type)) continue;
    if (seenPreflopRaise && !countedLight3bet.has(a.playerId)) {
      get(a.playerId).light3bet += 1;
      countedLight3bet.add(a.playerId);
    }
    seenPreflopRaise = true;
  }

  // 翻前最后加注方（cbet 判定用）
  let preflopAggressor = null;
  for (const a of preflop) if (AGGRO_TYPES.has(a.type)) preflopAggressor = a.playerId;

  // preflop 弃牌的人
  const foldedPreflop = new Set();
  for (const a of preflop) if (a.type === 'fold') foldedPreflop.add(a.playerId);

  // ── 翻后（flop/turn/river）──
  const sawFlopIds = communityCards.length >= 3
    ? dealtInIds.filter((id) => !foldedPreflop.has(id))
    : [];
  for (const id of sawFlopIds) get(id).sawFlop += 1;

  const foldedAnyStreet = new Set([...foldedPreflop]);
  for (const a of actionLog) if (a.type === 'fold') foldedAnyStreet.add(a.playerId);

  for (const phase of ['flop', 'turn', 'river']) {
    const street = actionLog.filter((a) => a.phase === phase);
    if (street.length === 0) continue;
    const board = boardFor(phase);
    let betOpened = false;   // 这街是否已有人下注
    let firstBettor = null;

    for (const a of street) {
      const s = get(a.playerId);
      s.postflopDecisions += 1;

      // 面对注 → facedRaise / foldedToRaise
      if (betOpened && (a.type === 'fold' || a.type === 'call' || AGGRO_TYPES.has(a.type))) {
        // 只在"面前确实有需要跟的注"时算——betOpened 为 true 即代表本街已有 raise/加注型 allin
        if (a.type === 'fold') { s.facedRaise += 1; s.foldedToRaise += 1; }
        else if (a.type === 'call') { s.facedRaise += 1; }
        else { s.facedRaise += 1; } // 面对注再加注也算"面对过注"
      }

      if (a.type === 'call') {
        s.postflopCalls += 1;
      } else if (AGGRO_TYPES.has(a.type)) {
        const hole = holeOf(a.playerId);
        const cls = hole ? classifyHoldingStrength(hole, board) : 'made';
        if (!betOpened) {
          // 该街首个下注 = bet
          s.postflopBets += 1;
          betOpened = true;
          firstBettor = a.playerId;
          if (phase === 'flop' && a.playerId === preflopAggressor) {
            // 标准持续下注：单独计，不进 airFires
            s.cbets += 1;
            if (cls === 'air') s.cbetAir += 1;
          } else if (cls === 'air') {
            s.airFires += 1; // 非 cbet 的空气下注（含转河首下注）
          }
        } else {
          s.postflopRaises += 1;
          if (cls === 'air') s.airFires += 1; // 空气加注（含空气 check-raise）
        }
      }
      // check 不加任何进攻/跟注计数，只 postflopDecisions
    }
  }

  // cbetOpp：翻前最后加注方 且 看到翻牌
  if (preflopAggressor && sawFlopIds.includes(preflopAggressor)) {
    get(preflopAggressor).cbetOpp += 1;
  }

  // wentToShowdown：看到翻牌 且 整手没弃牌
  for (const id of sawFlopIds) {
    if (!foldedAnyStreet.has(id)) get(id).wentToShowdown += 1;
  }
}
```

`module.exports` 改为：

```js
module.exports = { classifyHoldingStrength, emptyPlayerStats, accumulateHand };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx vitest run __tests__/playstyleStats.test.js`
Expected: PASS（全部）。若 `wentToShowdown`/`facedRaise` 断言与实现有出入，以**测试里注释描述的语义**为准调整实现，不要改测试期望的语义。

- [ ] **Step 5: Commit**

```bash
git add server/playstyleStats.js server/__tests__/playstyleStats.test.js
git commit -m "feat: playstyleStats.accumulateHand — per-hand counter accumulation"
```

---

## Task 4: 奖项计算器

**Files:**
- Create: `server/playstyleAwards.js`
- Test: `server/__tests__/playstyleAwards.test.js`

**Interfaces:**
- Consumes: `emptyPlayerStats()` 结构的计数器（Task 3）。
- Produces: `computeAwards(statsMap, players, opts?): Array<{ award: string, playerId: string, playerName: string, reason: string }>`
  - `players`：`[{ id, name }]`，在场（未 left）玩家。
  - `opts.maxAwards`：默认 `5`。
  - 返回列表：每个 `playerId` 至多出现一次；按"突出程度"降序；撑不起任何奖时返回 `[]`。

- [ ] **Step 1: 写失败测试**

Create `server/__tests__/playstyleAwards.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { computeAwards } = require('../playstyleAwards');
const { emptyPlayerStats } = require('../playstyleStats');

function stats(overrides) {
  return { ...emptyPlayerStats(), ...overrides };
}

describe('computeAwards', () => {
  it('全员手数不足 15 → 返回空', () => {
    const map = {
      A: stats({ handsDealt: 8, handsVPIP: 6 }),
      B: stats({ handsDealt: 8, handsVPIP: 1 }),
    };
    expect(computeAwards(map, [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }])).toEqual([]);
  });

  it('入池率最高/最低 → 手痒星人 / 养生局（全员 >=15 手）', () => {
    const map = {
      A: stats({ handsDealt: 40, handsVPIP: 34 }),  // 85%
      B: stats({ handsDealt: 40, handsVPIP: 8 }),   // 20%
      C: stats({ handsDealt: 40, handsVPIP: 20 }),  // 50%
    };
    const out = computeAwards(map, [{ id: 'A', name: '阿强' }, { id: 'B', name: '小明' }, { id: 'C', name: '老野' }]);
    expect(out.find(a => a.playerId === 'A').award).toBe('手痒星人');
    expect(out.find(a => a.playerId === 'B').award).toBe('养生局');
  });

  it('每人最多一个奖：同时是两个奖得主时留最突出的，另一个顺延', () => {
    const map = {
      A: stats({ handsDealt: 40, handsVPIP: 38, postflopBets: 50, postflopRaises: 20, postflopCalls: 2, postflopDecisions: 90 }),
      B: stats({ handsDealt: 40, handsVPIP: 5, postflopBets: 1, postflopRaises: 0, postflopCalls: 30, postflopDecisions: 40 }),
      C: stats({ handsDealt: 40, handsVPIP: 20, postflopBets: 10, postflopRaises: 5, postflopCalls: 6, postflopDecisions: 40 }),
    };
    const out = computeAwards(map, [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }, { id: 'C', name: 'C' }]);
    const perPlayer = {};
    for (const a of out) { expect(perPlayer[a.playerId]).toBeUndefined(); perPlayer[a.playerId] = a.award; }
    // A 既是最松也是最凶 → 只拿一个；最凶顺延给 C（若 C 达门槛）
    expect(Object.keys(perPlayer).filter(id => id === 'A').length).toBeLessThanOrEqual(1);
  });

  it('影帝：空气开火 >=3 才发；不够则该奖不出现', () => {
    const map = {
      A: stats({ handsDealt: 30, handsVPIP: 15, airFires: 4 }),
      B: stats({ handsDealt: 30, handsVPIP: 15, airFires: 1 }),
    };
    const out = computeAwards(map, [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }]);
    expect(out.some(a => a.award === '影帝' && a.playerId === 'A')).toBe(true);

    const map2 = {
      A: stats({ handsDealt: 30, handsVPIP: 15, airFires: 2 }),
      B: stats({ handsDealt: 30, handsVPIP: 15, airFires: 0 }),
    };
    const out2 = computeAwards(map2, [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }]);
    expect(out2.some(a => a.award === '影帝')).toBe(false);
  });

  it('最多返回 opts.maxAwards 条', () => {
    const map = {};
    const players = [];
    for (let i = 0; i < 8; i++) {
      const id = `p${i}`;
      players.push({ id, name: id });
      map[id] = stats({
        handsDealt: 40, handsVPIP: 5 + i * 4, handsPFR: i,
        postflopBets: i * 3, postflopRaises: i, postflopCalls: 40 - i * 3, postflopDecisions: 40,
        sawFlop: 20, wentToShowdown: i * 2, facedRaise: 12, foldedToRaise: 12 - i,
        airFires: i, cbetOpp: 10, cbets: i, cbetAir: 0,
      });
    }
    const out = computeAwards(map, players, { maxAwards: 4 });
    expect(out.length).toBeLessThanOrEqual(4);
    const ids = out.map(a => a.playerId);
    expect(new Set(ids).size).toBe(ids.length); // 每人最多一个
  });

  it('reason 是一句中文大白话', () => {
    const map = {
      A: stats({ handsDealt: 40, handsVPIP: 36 }),
      B: stats({ handsDealt: 40, handsVPIP: 6 }),
    };
    const out = computeAwards(map, [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }]);
    for (const a of out) {
      expect(typeof a.reason).toBe('string');
      expect(a.reason.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run __tests__/playstyleAwards.test.js`
Expected: FAIL —`Cannot find module '../playstyleAwards'`。

- [ ] **Step 3: 实现**

Create `server/playstyleAwards.js`:

```js
// 打法点评：把全桌计数器变成"本场之最"奖项列表。纯函数。
// 门槛哲学（见 design.md「宽容版」）：这场 >= 15 手才出段；每条奖各有小门槛，
// 撑不起就静默跳过；每人最多一个奖，冲突按"突出程度"顺延。

const MIN_HANDS_FOR_SECTION = 15;

// 每个奖：从哪个指标取、取最大还是最小、得主要满足的门槛、文案模板。
// metric(s) 入参是单个玩家的 stats；gate(s, ctx) 返回该玩家能否作为这个奖的得主。
const AWARDS = [
  {
    key: '手痒星人', dir: 'max',
    metric: s => s.handsDealt ? s.handsVPIP / s.handsDealt : 0,
    gate: (s, ctx) => ctx.everyoneHas15,
    reason: (s, v) => `入池率 ${pct(v)}，什么牌都想下场`,
  },
  {
    key: '养生局', dir: 'min',
    metric: s => s.handsDealt ? s.handsVPIP / s.handsDealt : 1,
    gate: (s, ctx) => ctx.everyoneHas15,
    reason: (s, v) => `入池率 ${pct(v)}，非大牌不玩`,
  },
  {
    key: '梭哈人格', dir: 'max',
    metric: s => aggression(s),
    gate: s => s.postflopDecisions >= 10,
    reason: (s, v) => `翻后进攻性拉满（下注加注是跟注的 ${v.toFixed(1)} 倍）`,
  },
  {
    key: '牌桌 NPC', dir: 'min',
    metric: s => aggression(s),
    gate: s => s.postflopDecisions >= 10,
    reason: () => `翻后几乎从不主动，全程跟着走`,
  },
  {
    key: '我倒要看看', dir: 'max',
    metric: s => s.sawFlop ? s.wentToShowdown / s.sawFlop : 0,
    gate: (s, ctx) => s.sawFlop >= 15 && ctx.margin('wtsd', s) >= 0.12,
    reason: (s, v) => `摊牌率 ${pct(v)}，几乎不弃牌`,
  },
  {
    key: '秒怂', dir: 'max',
    metric: s => s.facedRaise ? s.foldedToRaise / s.facedRaise : 0,
    gate: s => s.facedRaise >= 8,
    reason: (s, v) => `面对下注 ${pct(v)} 直接弃`,
  },
  {
    key: '影帝', dir: 'max',
    metric: s => s.airFires,
    gate: s => s.airFires >= 3,
    reason: s => `空手大举下注 ${s.airFires} 次，面不改色`,
  },
  {
    key: '惯性开火', dir: 'max',
    metric: s => s.cbetOpp ? s.cbets / s.cbetOpp : 0,
    gate: s => s.cbetOpp >= 8,
    reason: (s, v) => `当加注方进到翻牌，${pct(v)} 都会再开一枪`,
  },
  {
    key: '加你一脸', dir: 'max',
    metric: s => s.light3bet,
    gate: s => s.light3bet >= 2,
    reason: s => `别人加注后又反手再加 ${s.light3bet} 次`,
  },
];

function pct(v) { return `${Math.round(v * 100)}%`; }
function aggression(s) {
  const aggro = s.postflopBets + s.postflopRaises;
  return aggro / Math.max(1, s.postflopCalls);
}

function computeAwards(statsMap, players, opts = {}) {
  const maxAwards = opts.maxAwards ?? 5;
  const present = players.filter(p => statsMap[p.id]);
  if (present.length < 2) return [];

  const totalHands = Math.max(0, ...present.map(p => statsMap[p.id].handsDealt));
  if (totalHands < MIN_HANDS_FOR_SECTION) return [];

  const everyoneHas15 = present.every(p => statsMap[p.id].handsDealt >= 15);

  // "偏离中位数多少"——给"我倒要看看"这种要求"明显偏高"的奖用
  function margin(kind, s) {
    if (kind === 'wtsd') {
      const vals = present.map(p => {
        const x = statsMap[p.id];
        return x.sawFlop ? x.wentToShowdown / x.sawFlop : 0;
      }).sort((a, b) => a - b);
      const med = vals[Math.floor(vals.length / 2)];
      const mine = s.sawFlop ? s.wentToShowdown / s.sawFlop : 0;
      return mine - med;
    }
    return 0;
  }
  const ctx = { everyoneHas15, margin };

  // 每个奖先算候选：按 dir 排序，取满足 gate 的第一名；记 (winner, value, gap)
  // gap = |first - second| / (max - min + eps)，代表这个人在这个维度多离谱
  const candidates = [];
  for (const def of AWARDS) {
    const ranked = present
      .map(p => ({ id: p.id, name: p.name, v: def.metric(statsMap[p.id]) }))
      .sort((a, b) => def.dir === 'max' ? b.v - a.v : a.v - b.v);
    const vals = ranked.map(r => r.v);
    const spread = (Math.max(...vals) - Math.min(...vals)) || 1e-9;
    const winner = ranked.find(r => def.gate(statsMap[r.id], ctx));
    if (!winner) continue;
    const idxInRanked = ranked.findIndex(r => r.id === winner.id);
    const next = ranked[idxInRanked + 1];
    const gap = next ? Math.abs(winner.v - next.v) / spread : 1;
    candidates.push({
      award: def.key, playerId: winner.id, playerName: winner.name,
      value: winner.v, gap,
      reason: def.reason(statsMap[winner.id], winner.v),
      _def: def, _ranked: ranked,
    });
  }

  // 每人最多一个奖：按 gap 降序处理；一个人已拿奖则这个奖顺延给 _ranked 里
  // 下一个满足 gate 且尚未拿奖的人（顺延后不重算 gap，用一个略降的值排序）。
  candidates.sort((a, b) => b.gap - a.gap);
  const takenBy = new Set();      // playerId
  const result = [];
  for (const c of candidates) {
    if (!takenBy.has(c.playerId)) {
      takenBy.add(c.playerId);
      result.push({ award: c.award, playerId: c.playerId, playerName: c.playerName, reason: c.reason });
      continue;
    }
    // 顺延
    const alt = c._ranked.find(r => !takenBy.has(r.id) && c._def.gate(statsMap[r.id], ctx));
    if (alt) {
      takenBy.add(alt.id);
      result.push({ award: c.award, playerId: alt.id, playerName: alt.name, reason: c._def.reason(statsMap[alt.id], alt.v) });
    }
  }

  // 上限：按处理顺序（已是 gap 优先）截断
  return result.slice(0, maxAwards);
}

module.exports = { computeAwards };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx vitest run __tests__/playstyleAwards.test.js`
Expected: PASS。个别断言若因排序细节挂，调整实现细节（不是测试语义）——例如顺延时 gap 排序、`margin` 阈值。

- [ ] **Step 5: Commit**

```bash
git add server/playstyleAwards.js server/__tests__/playstyleAwards.test.js
git commit -m "feat: playstyleAwards.computeAwards — per-session award list"
```

---

## Task 5: Room 挂计数器 + 每手累加入口

**Files:**
- Modify: `server/RoomManager.js`（`Room` constructor 约 46-50 行、`restart()` 约 430-440 行）
- Test: `server/__tests__/RoomManager.test.js`

**Interfaces:**
- Consumes: `accumulateHand`（Task 3）。
- Produces:
  - `Room.playstyleStats: Record<string, PlayerStats>` —— 初始 `{}`。
  - `Room.recordHandForPlaystyle(hand: { actionLog, allHoleCards, communityCards, dealtInIds }): void` —— 转调 `accumulateHand(this.playstyleStats, hand)`。
  - `restart()` 里 `this.playstyleStats = {}`。

- [ ] **Step 1: 写失败测试**

在 `server/__tests__/RoomManager.test.js` 末尾加：

```js
describe('Room — 打法点评计数器', () => {
  it('新房间 playstyleStats 为空对象', () => {
    const room = rooms.create('p1', 'Alice');
    expect(room.playstyleStats).toEqual({});
  });

  it('recordHandForPlaystyle 累加进 playstyleStats', () => {
    const room = rooms.create('p1', 'Alice');
    room.recordHandForPlaystyle({
      dealtInIds: ['p1', 'p2'],
      communityCards: [],
      allHoleCards: [{ id: 'p1', holeCards: ['Ah', 'Kh'] }, { id: 'p2', holeCards: ['7c', '2d'] }],
      actionLog: [
        { playerId: 'p1', phase: 'preflop', type: 'raise', amount: 600 },
        { playerId: 'p2', phase: 'preflop', type: 'fold', amount: 0 },
      ],
    });
    expect(room.playstyleStats.p1.handsPFR).toBe(1);
    expect(room.playstyleStats.p1.handsDealt).toBe(1);
    expect(room.playstyleStats.p2.handsDealt).toBe(1);
  });

  it('restart() 清空 playstyleStats', () => {
    const room = rooms.create('p1', 'Alice');
    room.recordHandForPlaystyle({
      dealtInIds: ['p1'], communityCards: [],
      allHoleCards: [{ id: 'p1', holeCards: ['Ah', 'Kh'] }],
      actionLog: [{ playerId: 'p1', phase: 'preflop', type: 'raise', amount: 600 }],
    });
    room.restart();
    expect(room.playstyleStats).toEqual({});
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run __tests__/RoomManager.test.js -t "打法点评计数器"`
Expected: FAIL —`room.playstyleStats` 为 `undefined`。

- [ ] **Step 3: 实现**

`server/RoomManager.js` 顶部 require 区（约 1 行，`const { GameEngine } = require('./GameEngine');` 附近）加：

```js
const { accumulateHand } = require('./playstyleStats');
```

`Room` constructor 里，紧挨 `this.chatLog = [];`（约 58 行）之后加：

```js
    // 打法点评（本场之最）的 per-player 计数器 —— 跟 handHistory/chatLog 同一个
    // 生命周期：只在内存、随房间、restart() 清空、"结束游戏"不清、服务重启自然没。
    this.playstyleStats = {};
```

`Room` 类里新增方法（放在 `chat(...)` 方法之后、`recordEggPoke` 之前均可）：

```js
  // 每手结束调用一次（server/index.js 的 handleActionResult showdown 分支）。
  // hand: { actionLog, allHoleCards, communityCards, dealtInIds }
  recordHandForPlaystyle(hand) {
    accumulateHand(this.playstyleStats, hand);
  }
```

`restart()` 里，紧挨 `this.chatLog = [];`（约 436 行）之后加：

```js
    this.playstyleStats = {};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx vitest run __tests__/RoomManager.test.js`
Expected: PASS（新 3 条 + 既有全过）。

- [ ] **Step 5: Commit**

```bash
git add server/RoomManager.js server/__tests__/RoomManager.test.js
git commit -m "feat: Room accumulates playstyle stats per hand, cleared on restart"
```

---

## Task 6: index.js 接线（每手累加 + room:get-style-recap）

**Files:**
- Modify: `server/index.js`（`handleActionResult` 约 706-742 行；socket handler 区，`room:get-hand-history` 约 1089 行附近）
- Test: `server/__tests__/integration.test.js`

**Interfaces:**
- Consumes: `Room.recordHandForPlaystyle`（Task 5）、`computeAwards`（Task 4）。
- Produces: 新 socket 事件对 `room:get-style-recap`（客户端发 `{ playerId }`）→ `room:style-recap`（服务端单播 `{ awards: Array<{award,playerId,playerName,reason}> }`）。

- [ ] **Step 1: 写失败测试**

在 `server/__tests__/integration.test.js` 的 `describe('集成测试 — 房间管理'`（或任一合适 describe）里加一条。注意需要真正打几手牌——用现有的 helper（若文件里已有打牌 helper 就复用；否则用下面的最小驱动）：

```js
it('room:get-style-recap 打若干手后返回奖项数组（结构正确）', async () => {
  const [c1, c2] = await Promise.all([connect(), connect()]);
  const j1 = waitFor(c1, 'room:joined');
  c1.emit('room:create', { playerId: 'h1', playerName: '阿强' });
  const { code } = await j1;
  const s2 = waitFor(c2, 'room:state');
  c2.emit('room:join', { code, playerId: 'h2', playerName: '小明' });
  await s2;

  // 开局
  c1.emit('room:start', { playerId: 'h1' });
  await waitFor(c1, 'game:state');

  // 打 ~20 手：每手轮到谁就 fold，直到 game:ended 或够 20 手。
  // 用一个循环监听 game:state，找到 actionPlayerId 就让对应 client fold。
  let hands = 0;
  await new Promise((resolve) => {
    const onState = (st) => {
      if (!st || !st.game) return;
      hands = st.handNumber ?? hands;
      const actor = st.game.actionPlayerId;
      if (!actor) return;
      const c = actor === 'h1' ? c1 : c2;
      c.emit('game:action', { playerId: actor, action: 'fold' });
    };
    c1.on('game:state', onState);
    c1.on('game:ended', resolve);
    setTimeout(resolve, 4000); // 兜底
  });

  const recap = waitFor(c1, 'room:style-recap');
  c1.emit('room:get-style-recap', { playerId: 'h1' });
  const body = await recap;
  expect(Array.isArray(body.awards)).toBe(true);
  for (const a of body.awards) {
    expect(typeof a.award).toBe('string');
    expect(typeof a.playerId).toBe('string');
    expect(typeof a.playerName).toBe('string');
    expect(typeof a.reason).toBe('string');
  }
});
```

> 若 `integration.test.js` 已有更顺手的"打 N 手"helper，用它替换上面手写循环；断言部分不变。字段名 `st.game.actionPlayerId` / `st.handNumber` 以该文件里既有测试的读法为准（照抄同文件其它用例的写法）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run __tests__/integration.test.js -t "style-recap"`
Expected: FAIL —`Timeout waiting for 'room:style-recap'`（handler 不存在）。

- [ ] **Step 3: 实现**

**(a)** `server/index.js` 顶部 require 区加：

```js
const { computeAwards } = require('./playstyleAwards');
```

**(b)** `handleActionResult` 里，`room.handHistory.push({ ... })` 这段之后（约 738 行 `});` 之后、函数结束的 `}` 之前）加：

```js
      // 打法点评（本场之最）——每手结束把逐动作日志喂给计数器，随后 game
      // 对象连同其 actionLog 一起在下一手/结束时被替换掉，不长期保留。
      room.recordHandForPlaystyle({
        actionLog: room.game.actionLog,
        allHoleCards: result.allHoleCards,
        communityCards: result.state.communityCards,
        dealtInIds: result.allHoleCards.map(c => c.id),
      });
```

**(c)** socket handler 区，`socket.on('room:get-hand-history', ...)` 之后加：

```js
    // 打法点评（本场之最）——账本弹出时客户端请求一次，服务端现算。跟
    // room:get-hand-history 同一个"请求-单播响应"模式。全员看到同一份（v1
    // 不做剔除自己）。
    socket.on('room:get-style-recap', ({ playerId } = {}) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room) return socket.emit('game:error', '未找到房间');
      const present = room.players.filter(p => !p.left).map(p => ({ id: p.id, name: p.name }));
      const awards = computeAwards(room.playstyleStats, present);
      socket.emit('room:style-recap', { awards });
    });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx vitest run __tests__/integration.test.js`
Expected: PASS（新用例 + 既有无回归；`integration.test.js` 偶发的既有 flake 单独重跑）。

再跑全量服务端：`cd server && npm test`
Expected: 全绿（既有 flake 除外，单独重跑通过）。

- [ ] **Step 5: Commit**

```bash
git add server/index.js server/__tests__/integration.test.js
git commit -m "feat: wire playstyle accumulation + room:get-style-recap socket event"
```

---

## Task 7: 客户端 —— RoomPage 拉取 recap

**Files:**
- Modify: `client/src/pages/RoomPage.jsx`（`useState` 区约 26-40 行；`useSocket` handlers 区约 62-124 行；两处 `<LedgerModal>` 约 322 行、458 行；`onOpenLedger` 约 316/364 行）

**Interfaces:**
- Consumes: `room:style-recap` 事件（Task 6）。
- Produces: `<LedgerModal>` 新增 prop `styleRecap: Array<{award,playerId,playerName,reason}> | null`。

- [ ] **Step 1: 加 state + 事件 handler + 拉取**

`RoomPage.jsx` `useState` 区（`const [showLedger, setShowLedger] = useState(false);` 附近）加：

```jsx
  const [styleRecap, setStyleRecap] = useState(null);
```

`useSocket({ ... })` 的事件对象里（跟 `'room:state'` 等并列）加：

```jsx
    'room:style-recap': ({ awards }) => setStyleRecap(awards ?? []),
```

找到打开账本的两个地方，改成打开的同时请求 recap：

- 约 316 行 `onOpenLedger={() => setShowLedger(true)}` → 
  ```jsx
  onOpenLedger={() => { setStyleRecap(null); emit('room:get-style-recap', { playerId }); setShowLedger(true); }}
  ```
- 约 364 行同样的 `onOpenLedger={() => setShowLedger(true)}` → 同上替换。

`game:ended` handler 里，`if (hostEnded) setShowLedger(true);` 之前加一行（账本自动弹时也要有 recap）：

```jsx
      if (hostEnded) { setStyleRecap(null); emit('room:get-style-recap', { playerId }); setShowLedger(true); }
```

（把原来的 `if (hostEnded) setShowLedger(true);` 整行替换成上面这行。）

- [ ] **Step 2: 传 prop 给两处 LedgerModal**

约 322 行和约 458 行的两个 `<LedgerModal ... />`，各加一个 prop：

```jsx
            styleRecap={styleRecap}
```

- [ ] **Step 3: 构建确认无报错**

Run: `cd client && npm run build`
Expected: 构建成功。

Run: `cd client && npx eslint src/pages/RoomPage.jsx`
Expected: 无新增 error（跟基线 27 errors / 9 warnings 持平）。

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/RoomPage.jsx
git commit -m "feat: RoomPage fetches style recap when the ledger opens"
```

---

## Task 8: 客户端 —— LedgerModal 渲染"本场之最" + 样式

**Files:**
- Modify: `client/src/components/LedgerModal.jsx`
- Modify: `client/src/styles/velvet.css`（`.ledger-egg-note` 之后，约 1369 行）

**Interfaces:**
- Consumes: prop `styleRecap`（Task 7）。

- [ ] **Step 1: 渲染**

`LedgerModal.jsx` 函数签名加 prop：

```jsx
export default function LedgerModal({ players, startingChips, myId, onClose, eggCounts, styleRecap }) {
```

在 `{topEggTargets.length > 0 && (...)}` 那段**之后**、`<div className="modal-btn" onClick={onClose}>关闭</div>` 之前，加：

```jsx
        {styleRecap !== null && (
          <div className="ledger-recap">
            <div className="ledger-recap__title">本场之最</div>
            {styleRecap.length === 0 ? (
              <div className="ledger-recap__empty">这场手数还少，没看出谁特别怎样</div>
            ) : (
              styleRecap.map((a) => (
                <div key={a.award + a.playerId} className="ledger-recap__row">
                  <span className="ledger-recap__award">{a.award}</span>
                  <span className="ledger-recap__who">{a.playerName}</span>
                  <span className="ledger-recap__reason">{a.reason}</span>
                </div>
              ))
            )}
          </div>
        )}
```

（`styleRecap === null` 时——还没拉到——整段不渲染，避免闪。）

- [ ] **Step 2: 样式**

`client/src/styles/velvet.css` 里 `.ledger-egg-note { ... }` 那行之后加：

```css
.ledger-recap { margin-top:14px; padding-top:12px; border-top:1px solid rgba(212,175,55,.18); }
.ledger-recap__title { font-family:var(--font-display); font-size:12px; font-weight:700; letter-spacing:1px; color:var(--gold-300); text-align:center; margin-bottom:8px; }
.ledger-recap__empty { font-family:var(--font-body); font-size:12px; color:var(--text-secondary); text-align:center; }
.ledger-recap__row { display:flex; align-items:baseline; gap:8px; padding:5px 0; font-family:var(--font-body); font-size:12px; }
.ledger-recap__award { flex-shrink:0; font-weight:700; color:var(--gold-200); }
.ledger-recap__who { flex-shrink:0; font-weight:600; color:var(--text-primary); }
.ledger-recap__reason { color:var(--text-secondary); line-height:1.4; }
```

- [ ] **Step 3: 构建 + 真实浏览器验证**

Run: `cd client && npm run build`
Expected: 成功。

起本地服务（`cd .. && PORT=3001 node server/index.js &`，另开 `python3 -m http.server` 不需要——server 直接托管 `client/dist`），用两个浏览器 context（或复用现有 e2e 里的 seed 脚本）建房、打十几手、房主结束游戏，确认账本弹出、"本场之最"段渲染出来、每条一行（奖名 + 人名 + 依据）。截图存档。

手数不足时确认显示"这场手数还少，没看出谁特别怎样"。

- [ ] **Step 4: Commit**

```bash
git add client/src/components/LedgerModal.jsx client/src/styles/velvet.css
git commit -m "feat: LedgerModal renders 本场之最 playstyle recap section"
```

---

## Task 9: 端到端回归 + 全量测试

**Files:** 无新增，只跑测试。

- [ ] **Step 1: 服务端全量**

Run: `cd server && npm test`
Expected: 全绿。既有 `integration.test.js` / `PveSession.test.js` 概率性 flake 若出现，单独重跑该文件确认通过、且失败用例与本功能无关。

- [ ] **Step 2: 客户端构建 + lint**

Run: `cd client && npm run build && npx eslint src`
Expected: 构建成功；lint 与基线持平（27 errors / 9 warnings，零新增）。

- [ ] **Step 3: e2e（若环境可跑）**

Run: `npx playwright test e2e/game.spec.js`
Expected: 与基线一致（账本/结算相关用例不回归）。

- [ ] **Step 4: 更新 SDD 勾选**

`openspec/changes/online-texas-holdem/tasks.md` 末尾加一条 `- [x]`，一句话概括本功能 + 指向 `docs/superpowers/specs/2026-09-08-playstyle-recap-design.md` 和本 plan。

- [ ] **Step 5: Commit**

```bash
git add openspec/changes/online-texas-holdem/tasks.md
git commit -m "docs: mark playstyle recap (本场之最) done in SDD tasks"
```

---

## Self-Review

**Spec coverage：**

| 设计文档要点 | 对应 Task |
|---|---|
| 逐动作记录 | Task 1（GameEngine.actionLog） |
| 累加器（纯函数） | Task 2 + 3（playstyleStats.js） |
| 奖项计算器（门槛 + 每人一个奖 + 顺延 + 上限 + 兜底文案） | Task 4（playstyleAwards.js） |
| Room 挂计数器 / restart 清空 / 每手累加 | Task 5 + 6 |
| 一局结束在账本显示；账本自动弹时也带 recap | Task 7（`game:ended` 里也 emit） |
| 计时结束也弹账本 | 已有：`endGameNow` 统一走 `hostEnded:true`（Task 7 的 `game:ended` handler 覆盖此路径） |
| 渲染"本场之最"段 | Task 8 |
| 全员公开、v1 不做 opt-out | Task 6 handler 直接对全体 present 算，无过滤 |
| 不持久化、随房间生命周期 | Task 5（只在 Room 实例、restart 清） |
| 人机对战不涉及 | 全程只碰 `Room`/多人 socket 事件；PVE 路径未改 |
| 9 个奖名逐字 | Task 4 `AWARDS[].key` |
| "空气"判定（made/draw/air，半诈唬不算） | Task 2 `classifyHoldingStrength` |
| "持续下注"排除 | Task 3 accumulateHand 的 flop 分支 |
| 翻前不单列诈唬、只 light 3-bet | Task 3（`light3bet`）+ Task 4（`加你一脸`） |
| 宽松门槛（15 手出段 + 各奖小门槛 + 撑不起跳过） | Task 4 |

**Placeholder scan：** 无。每个改代码的 Step 都给了完整代码块；每个跑命令的 Step 都给了命令 + 期望输出。Task 6 Step 1 对"打 N 手"的 helper 写法留了"照抄同文件既有用例"的余地——这是对既有测试基建的合理引用，不是 placeholder（手写兜底版本也给全了）。

**Type consistency：**
- `hand` 对象形状 `{ actionLog, allHoleCards, communityCards, dealtInIds }` 在 Task 3/5/6 一致。
- `actionLog` 条目 `{ playerId, phase, type, amount }` 在 Task 1 定义、Task 3 消费，一致。
- `computeAwards(statsMap, players, opts)` 返回 `{ award, playerId, playerName, reason }`，Task 4 定义、Task 6 透传、Task 7/8 消费，字段名一致。
- socket 事件对 `room:get-style-recap` / `room:style-recap`，payload `{ playerId }` / `{ awards }`，Task 6 定义、Task 7 消费，一致。
- `Room.playstyleStats` / `Room.recordHandForPlaystyle` 命名在 Task 5 定义、Task 6 调用，一致。

---

## Execution Handoff

见文件末尾——写完 plan 后由 writing-plans skill 给出执行方式选择。
