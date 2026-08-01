# PVE 多人机对战 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a human play PVE against multiple AI opponents (4/6/8-max tables, not just heads-up), each AI seat with a randomly assigned play-style flavor.

**Architecture:** `GameEngine`, the AI-turn loop in `server/index.js`, and `SettlementModal`/`GameTable` on the client are already N-player-generic (proven by the existing multiplayer path). Only `server/PveSession.js` hardcodes a single AI opponent — generalize it to an array of AI seats, thread a `seatCount` choice from a new HomePage picker through to it, and add a small per-seat "style" delta table in `pveStrategy.js` for flavor. No changes to `GameEngine.js` or the AI-turn scheduling loop.

**Tech Stack:** Node.js/Express/Socket.IO server, React client, Vitest for server tests.

## Global Constraints

- Table sizes are exactly four fixed tiers: 2 (单挑, existing), 4, 6, 8. No arbitrary seat counts.
- Heads-up (seatCount=2, the default) must behave byte-for-byte identically to today — same AI id (`__ai__`), same name (`电脑`), same unstyled strategy (no `style` adjustment applied). All existing tests in `PveSession.test.js` and `pveStrategy.test.js` must keep passing unmodified.
- No difficulty tiers — every AI seat plays at the current single strength level.
- No multiway preflop-range tightening this round — reuse the heads-up range tables as-is.
- No cross-seat exploitative tracking this round — `oppStats`/`_opponentReads()` stay exactly as they are today (a single shared profile), not split per AI seat.
- AI seat styles are never shown to the player — no UI badge/label revealing style.
- AI seat names are drawn from this fixed pool (see spec): 老K、赌神、扑克脸、幸运星、黑桃A、河神、影子玩家、常胜将军.
- Spec: `docs/superpowers/specs/2026-08-02-pve-multi-opponent-design.md`.

---

### Task 1: Style delta table in `pveStrategy.js`

**Files:**
- Modify: `server/pveStrategy.js`
- Test: `server/__tests__/pveStrategy.test.js`

**Interfaces:**
- Consumes: existing `contextDeltas()`, `adjustDistribution()`, `bandFor()`, `preflopTier()` (all already in this file, unchanged).
- Produces: `pickAction(params)` gains a new optional `params.style` (string, one of `'steady' | 'aggressive' | 'bluffer' | 'callingStation'`, default `null` = no adjustment, fully backward compatible). New export `STYLES` — `['steady', 'aggressive', 'bluffer', 'callingStation']` — for `PveSession.js` (Task 2) to pick from.

- [ ] **Step 1: Write the failing tests**

Add this new `describe` block to `server/__tests__/pveStrategy.test.js`, right after the existing `describe('pveStrategy — 位置调整...')` block (i.e. after its closing `});` around line 249, before `describe('pveStrategy — boardTexture', ...)`):

```js
describe('pveStrategy — 风格微调（多人机对战新增，2026-08-02）', () => {
  // Baseline for all four cases: equity=0.5 -> POSTFLOP_BANDS band
  // {fold:0.15, call:0.55, raise:0.30}. toCall=100 (>0, no fold-merge).
  // board=[] (length<3, boardTexture branch never triggers). No position,
  // no wasAggressor, no facingRaise, no opponent reads -> contextDeltas()
  // returns all-zero deltas, so the baseline distribution here is exactly
  // the raw band: fold=[0,0.15), call=[0.15,0.70), raise=[0.70,1).
  const base = {
    street: 'flop', equity: 0.5, toCall: 100, currentBet: 100, potSize: 300, myChips: 1000,
  };

  it('不传 style（单挑模式）时行为和改动前完全一致：r=0.60 落在 call', () => {
    const a = pickAction({ ...base, random: () => 0.60 });
    expect(a.action).toBe('call');
  });

  it('steady（稳健型）比不传 style 更容易弃牌：r=0.18 从 call 变成 fold', () => {
    const noStyle = pickAction({ ...base, random: () => 0.18 });
    const steady = pickAction({ ...base, random: () => 0.18, style: 'steady' });
    expect(noStyle.action).toBe('call');
    expect(steady.action).toBe('fold');
  });

  it('aggressive（激进型）比不传 style 更容易加注：r=0.60 从 call 变成 raise', () => {
    const noStyle = pickAction({ ...base, random: () => 0.60 });
    const aggressive = pickAction({ ...base, random: () => 0.60, style: 'aggressive' });
    expect(noStyle.action).toBe('call');
    expect(aggressive.action).toBe('raise');
  });

  it('bluffer（诈唬型）比不传 style 更容易加注：r=0.65 从 call 变成 raise', () => {
    const noStyle = pickAction({ ...base, random: () => 0.65 });
    const bluffer = pickAction({ ...base, random: () => 0.65, style: 'bluffer' });
    expect(noStyle.action).toBe('call');
    expect(bluffer.action).toBe('raise');
  });

  it('callingStation（跟注型）比不传 style 更少弃牌：r=0.10 从 fold 变成 call', () => {
    const noStyle = pickAction({ ...base, random: () => 0.10 });
    const station = pickAction({ ...base, random: () => 0.10, style: 'callingStation' });
    expect(noStyle.action).toBe('fold');
    expect(station.action).toBe('call');
  });

  it('未知的 style 字符串静默忽略（不抛异常，等价于不传）', () => {
    const noStyle = pickAction({ ...base, random: () => 0.60 });
    const unknown = pickAction({ ...base, random: () => 0.60, style: 'not-a-real-style' });
    expect(unknown.action).toBe(noStyle.action);
  });
});
```

Also add `STYLES` to the import destructure at the top of the test file:

```js
const {
  computeEquity,
  preflopTier,
  pickAction,
  PREFLOP_TABLE,
  POSTFLOP_BANDS,
  raiseSizeFraction,
  boardTexture,
  STYLES,
} = require('../pveStrategy');
```

Add one more assertion-only test (no new describe needed, put it right before the closing of the new describe block above, as the last `it`):

```js
  it('STYLES 导出四个风格键名，供 PveSession 随机分配', () => {
    expect(STYLES).toEqual(['steady', 'aggressive', 'bluffer', 'callingStation']);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run __tests__/pveStrategy.test.js`
Expected: FAIL — `STYLES` is undefined (import), and `style` param has no effect yet (the new `steady`/`aggressive`/`bluffer`/`callingStation` assertions fail because the styled call produces the same action as the unstyled one).

- [ ] **Step 3: Implement the style delta table and wire it into `pickAction`**

In `server/pveStrategy.js`, add this block right after the existing `OOP_FACING_RAISE_TIGHTEN` constant declaration (i.e. after the line `const OOP_FACING_RAISE_TIGHTEN = 0.08; ...` and before the `// 板面干湿判断：...` comment):

```js
// 风格微调（多电脑对战新增，2026-08-02）：给同桌的多个 AI 坐位增加打法
// 辨识度用的，跟 contextDeltas 是同一种"具名微调量"模式，只是维度换成
// "这个坐位是什么性格"而不是"当前局面"——不改变 preflopTier/bandFor 的
// 分档判断本身。单挑模式不传 style（值为 null/未知字符串），行为跟改动
// 前完全一致。四组 delta 都刻意让 fold+call+raise 的调整量相加为 0，
// 保证不触发 adjustDistribution 的负值裁剪/重归一化，纯粹是概率质量在
// 三个桶之间挪动。
const STYLE_DELTAS = {
  steady:         { fold:  0.06, call: -0.02, raise: -0.04 }, // 稳健型：更容易弃牌，少加注
  aggressive:     { fold: -0.05, call: -0.07, raise:  0.12 }, // 激进型：更少弃牌也更少跟注，多加注
  bluffer:        { fold: -0.08, call:  0.00, raise:  0.08 }, // 诈唬型：弃牌概率直接让给加注，跟注频率不变
  callingStation:  { fold: -0.10, call:  0.13, raise: -0.03 }, // 跟注型：明显更少弃牌、更多跟注
};
const STYLES = Object.keys(STYLE_DELTAS);
```

Then modify `pickAction()`'s destructure and body. Find this existing code:

```js
function pickAction(params) {
  const {
    street, holeCards, board = [], equity, toCall, potSize, myChips, position,
    random = Math.random, currentBet = toCall, minRaiseTo,
    // 场上对手能跟到的最高上限（GameEngine.maxTotalFor 同一套口径）——不
    // 传就是不设上限，纯向后兼容；PveSession 会传真实值，见 design.md「用
    // 户反馈：全下应该按场上最长对手的身家封顶」。
    opponentCeiling = Infinity,
    // 上下文调整，全部可选、默认不生效（向后兼容旧调用方）：
    wasAggressor = false, facingRaise = false,
    opponentFoldToRaiseRate = null, opponentAggressionRate = null,
  } = params;

  const baseDist = street === 'preflop'
    ? PREFLOP_TABLE[preflopTier(holeCards)]
    : bandFor(equity);
  const deltas = contextDeltas({ street, board, equity, toCall, wasAggressor, facingRaise, opponentFoldToRaiseRate, opponentAggressionRate, position });
  const dist = adjustDistribution(baseDist, deltas);
```

Replace it with:

```js
function pickAction(params) {
  const {
    street, holeCards, board = [], equity, toCall, potSize, myChips, position,
    random = Math.random, currentBet = toCall, minRaiseTo,
    // 场上对手能跟到的最高上限（GameEngine.maxTotalFor 同一套口径）——不
    // 传就是不设上限，纯向后兼容；PveSession 会传真实值，见 design.md「用
    // 户反馈：全下应该按场上最长对手的身家封顶」。
    opponentCeiling = Infinity,
    // 上下文调整，全部可选、默认不生效（向后兼容旧调用方）：
    wasAggressor = false, facingRaise = false,
    opponentFoldToRaiseRate = null, opponentAggressionRate = null,
    // 风格微调（多电脑对战），未知/未传都等价于不调整——见 STYLE_DELTAS。
    style = null,
  } = params;

  const baseDist = street === 'preflop'
    ? PREFLOP_TABLE[preflopTier(holeCards)]
    : bandFor(equity);
  const deltas = contextDeltas({ street, board, equity, toCall, wasAggressor, facingRaise, opponentFoldToRaiseRate, opponentAggressionRate, position });
  const styleDelta = STYLE_DELTAS[style];
  if (styleDelta) {
    deltas.fold += styleDelta.fold;
    deltas.call += styleDelta.call;
    deltas.raise += styleDelta.raise;
  }
  const dist = adjustDistribution(baseDist, deltas);
```

Finally, add `STYLES` to the `module.exports` at the bottom of the file. Find:

```js
module.exports = {
  computeEquity, preflopTier, pickAction, PREFLOP_TABLE, POSTFLOP_BANDS,
  // exported for direct unit testing / tuning visibility, not for PveSession to call directly
  adjustDistribution, contextDeltas, raiseSizeFraction, boardTexture,
};
```

Replace with:

```js
module.exports = {
  computeEquity, preflopTier, pickAction, PREFLOP_TABLE, POSTFLOP_BANDS, STYLES,
  // exported for direct unit testing / tuning visibility, not for PveSession to call directly
  adjustDistribution, contextDeltas, raiseSizeFraction, boardTexture,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run __tests__/pveStrategy.test.js`
Expected: PASS (all tests in the file, including the new describe block).

- [ ] **Step 5: Run the full server test suite to confirm no regression**

Run: `cd server && npm test`
Expected: PASS, same count as before plus the new tests (baseline was 212 passed; expect 212 + 7 new = 219).

- [ ] **Step 6: Commit**

```bash
cd "/Users/reyes/测试 OpenStack"
git add server/pveStrategy.js server/__tests__/pveStrategy.test.js
git commit -m "feat: add per-seat style delta table to pveStrategy for PVE multi-opponent

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Multi-seat `PveSession.js`

**Files:**
- Modify: `server/PveSession.js`
- Test: `server/__tests__/PveSession.test.js`

**Interfaces:**
- Consumes: `pveStrategy.STYLES` (Task 1's new export) — array of 4 style keys. `pveStrategy.pickAction()` now accepts `style`.
- Produces: `new PveSession(humanId, humanName, { ..., seatCount = 2 })` — when `seatCount` is 2 (default, omitted), behavior is byte-for-byte identical to today (`this.players` is exactly `[{human}, {id: AI_ID, name: '电脑', ...}]`, `AI_ID` export unchanged). When `seatCount` is 4/6/8, `this.players` has `seatCount` total entries (1 human + `seatCount - 1` AI), and a new `this.aiSeats` array (`[{ id, name, style }]`, one per AI) is exposed for tests/inspection. `isAiTurn()` and `aiAction()` behavior is unchanged in shape (same return types) but now handle any of the AI seat ids, not just the single `AI_ID`.

- [ ] **Step 1: Write the failing tests**

Add this new `describe` block to `server/__tests__/PveSession.test.js`, right after the `describe('PveSession — 初始化', ...)` block closes (find where that block's final `});` is, and insert after it, before the next `describe`):

```js
describe('PveSession — 多电脑对战（2026-08-02 新增）', () => {
  it('不传 seatCount（默认）时，行为跟改动前完全一致：单个 AI 坐位，id 是 AI_ID，name 是"电脑"', () => {
    const s = makeSession();
    expect(s.aiSeats).toEqual([{ id: AI_ID, name: '电脑', style: null }]);
    expect(s.players).toEqual([
      { id: 'me', name: 'Alice', chips: 1000, debt: 0 },
      { id: AI_ID, name: '电脑', chips: 1000, debt: 0 },
    ]);
  });

  it('seatCount=4 时，有 3 个 AI 坐位，id/name 互不重复，每个都有一个合法的 style', () => {
    const { STYLES } = require('../pveStrategy');
    const s = makeSession({ seatCount: 4 });
    expect(s.aiSeats.length).toBe(3);
    const ids = s.aiSeats.map(seat => seat.id);
    const names = s.aiSeats.map(seat => seat.name);
    expect(new Set(ids).size).toBe(3);
    expect(new Set(names).size).toBe(3);
    for (const seat of s.aiSeats) {
      expect(STYLES).toContain(seat.style);
    }
    expect(s.players.length).toBe(4);
  });

  it('seatCount=8 时，有 7 个 AI 坐位', () => {
    const s = makeSession({ seatCount: 8 });
    expect(s.aiSeats.length).toBe(7);
    expect(s.players.length).toBe(8);
  });

  it('AI 坐位名字全部来自固定名字池', () => {
    const NAME_POOL = ['老K', '赌神', '扑克脸', '幸运星', '黑桃A', '河神', '影子玩家', '常胜将军'];
    const s = makeSession({ seatCount: 8 });
    for (const seat of s.aiSeats) {
      expect(NAME_POOL).toContain(seat.name);
    }
  });

  it('isAiTurn()/aiAction() 能连续处理多个 AI 坐位的行动，不会卡在同一个坐位', () => {
    // 'call' (not the default 'check') — the first actor in a 4-max hand
    // faces a real toCall (blind differential), and 'check' would be an
    // illegal action there (GameEngine.check() rejects it, game state
    // never advances, actionPlayerId never changes) — that would make this
    // loop spin on the same seat 20 times and fail the "no seat visited
    // twice" assertion below for the wrong reason. 'call' is always legal
    // regardless of toCall.
    fakeStrategy.pickAction.mockReturnValue({ action: 'call' });
    const s = makeSession({ seatCount: 4 });
    const aiIds = s.aiSeats.map(seat => seat.id);
    const actedIds = [];
    let guard = 0;
    while (s.isAiTurn() && guard < 20) {
      actedIds.push(s.actionPlayerId);
      s.aiAction();
      guard += 1;
    }
    expect(guard).toBeGreaterThan(0); // at least one AI seat had to act before control reaches the human
    expect(guard).toBeLessThan(20); // didn't get stuck looping
    expect(new Set(actedIds).size).toBe(actedIds.length); // no seat visited twice in this stretch
    for (const id of actedIds) expect(aiIds).toContain(id);
  });

  it('aiAction() 把行动坐位自己的 style 传给 strategy.pickAction()', () => {
    const s = makeSession({ seatCount: 4 });
    fakeStrategy.pickAction.mockClear();
    expect(s.isAiTurn()).toBe(true);
    const actingId = s.actionPlayerId;
    const actingSeat = s.aiSeats.find(seat => seat.id === actingId);
    s.aiAction();
    expect(fakeStrategy.pickAction).toHaveBeenCalledWith(
      expect.objectContaining({ style: actingSeat.style })
    );
  });

  it('多人桌摊牌结算：4 人桌打到 all-in 全下比牌，筹码总量守恒', () => {
    // Deterministic strategy: everyone shoves every action, forcing a fast
    // all-in showdown regardless of hole cards — proves settlement/side-pot
    // math (already covered generically by GameEngine's own tests) actually
    // gets exercised end-to-end through PveSession with >2 players.
    const allinStrategy = {
      computeEquity: () => 0.5,
      pickAction: () => ({ action: 'allin' }),
    };
    const s = new PveSession('me', 'Alice', {
      startingChips: 1000, bigBlind: 20, strategy: allinStrategy, store: fakeStore, seatCount: 4,
    });
    // Human also shoves.
    let guard = 0;
    while (!s.isOver() && guard < 50) {
      if (s.isAiTurn()) s.aiAction();
      else s.humanAction('allin');
      guard += 1;
    }
    expect(s.isOver()).toBe(true);
    const total = s.game.players.reduce((sum, p) => sum + p.chips, 0);
    expect(total).toBe(4 * 1000); // conserved regardless of who won the side pots
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run __tests__/PveSession.test.js`
Expected: FAIL — `seatCount` option has no effect yet (`s.aiSeats` is undefined, since `aiSeats` doesn't exist on `PveSession` yet).

- [ ] **Step 3: Implement multi-seat support in `PveSession.js`**

Find this block near the top of `server/PveSession.js`:

```js
const AI_ID = '__ai__';
const AI_NAME = '电脑';
```

Replace with:

```js
const { STYLES } = require('./pveStrategy');

const AI_ID = '__ai__'; // legacy single-AI id — kept exact for seatCount=2 (heads-up, the default)
const AI_NAME = '电脑';
// 多电脑对战新增（2026-08-02）：坐位名字池，风格对玩家不可见，名字本身
// 也刻意不带风格暗示（比如不叫"保守老K"），避免间接泄露。
const AI_NAME_POOL = ['老K', '赌神', '扑克脸', '幸运星', '黑桃A', '河神', '影子玩家', '常胜将军'];

// 从名字池里不放回地随机抽 count 个（count 是 AI 坐位数，最多 7，池子有
// 8 个，够用不重复）。
function pickAiNames(count, random) {
  const pool = [...AI_NAME_POOL];
  const picked = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(random() * pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }
  return picked;
}

function pickRandomStyle(random) {
  return STYLES[Math.floor(random() * STYLES.length)];
}

// 单挑（seatCount===2，默认）保留改动前完全一致的行为：唯一的 AI 坐位
// id 是 AI_ID、name 是 AI_NAME、style 是 null（pickAction 收到 null 等价
// 于不调整，见 pveStrategy.js）。人数更多时才真正生成随机名字/风格的坐位。
function buildAiSeats(seatCount, random) {
  if (seatCount === 2) return [{ id: AI_ID, name: AI_NAME, style: null }];
  const count = seatCount - 1;
  const names = pickAiNames(count, random);
  return names.map((name, i) => ({
    id: `__ai_${i + 1}__`,
    name,
    style: pickRandomStyle(random),
  }));
}
```

Now find the constructor's option destructure and body. Locate:

```js
  constructor(humanId, humanName, { startingChips = 1000, bigBlind = 20, strategy = pveStrategy, store = defaultStore } = {}) {
    this.humanId = humanId;
    this.aiId = AI_ID;
    this.startingChips = startingChips;
```

Replace with:

```js
  constructor(humanId, humanName, {
    startingChips = 1000, bigBlind = 20, strategy = pveStrategy, store = defaultStore,
    seatCount = 2, random = Math.random,
  } = {}) {
    this.humanId = humanId;
    this.seatCount = seatCount;
    this.aiSeats = buildAiSeats(seatCount, random);
    this.aiSeatIds = new Set(this.aiSeats.map(seat => seat.id));
    this.startingChips = startingChips;
```

Now find where `this.players` is built:

```js
    this.players = [
      { id: humanId, name: humanName, chips: startingChips, debt: 0 },
      { id: AI_ID, name: AI_NAME, chips: startingChips, debt: 0 },
    ];
```

Replace with:

```js
    this.players = [
      { id: humanId, name: humanName, chips: startingChips, debt: 0 },
      ...this.aiSeats.map(seat => ({ id: seat.id, name: seat.name, chips: startingChips, debt: 0 })),
    ];
```

Now find `isAiTurn()`:

```js
  isAiTurn() {
    return !this.isOver() && this.actionPlayerId === this.aiId;
  }
```

Replace with:

```js
  isAiTurn() {
    return !this.isOver() && this.aiSeatIds.has(this.actionPlayerId);
  }
```

Now find `aiAction()`:

```js
  aiAction() {
    if (!this.isAiTurn()) return null;
    const aiIdx = this.game.players.findIndex(p => p.id === this.aiId);
    const ai = this.game.players[aiIdx];
    const toCall = this.game.currentBet - ai.bet;
    const street = this.game.phase;
    const board = this.game.communityCards;
    const equity = street === 'preflop'
      ? null // pickAction ignores equity preflop and uses preflopTier instead
      : this.strategy.computeEquity(ai.holeCards, board, { iterations: 300 });
    const position = aiIdx === this.game.dealerIndex ? 'ip' : 'oop';
    const wasAggressor = this.game.lastAggressorIndex === aiIdx;
    const facingRaise = this._facingRaise(street, toCall);
    const { opponentAggressionRate, opponentFoldToRaiseRate } = this._opponentReads();

    const decision = this.strategy.pickAction({
      street,
      holeCards: ai.holeCards,
      board,
      equity,
      toCall,
      potSize: this.game.pot,
      myChips: ai.chips,
      position,
      currentBet: this.game.currentBet,
      minRaiseTo: this.game.currentBet + this.game.lastRaiseAmount,
      opponentCeiling: this.game.maxTotalFor(this.aiId),
      wasAggressor,
      facingRaise,
      opponentAggressionRate,
      opponentFoldToRaiseRate,
    });

    const result = decision.action === 'raise'
      ? this._dispatch(this.aiId, 'raise', decision.raiseTo)
      : this._dispatch(this.aiId, decision.action);
    return { decision, result };
  }
```

Replace with:

```js
  aiAction() {
    if (!this.isAiTurn()) return null;
    const actingId = this.actionPlayerId;
    const seat = this.aiSeats.find(s => s.id === actingId);
    const aiIdx = this.game.players.findIndex(p => p.id === actingId);
    const ai = this.game.players[aiIdx];
    const toCall = this.game.currentBet - ai.bet;
    const street = this.game.phase;
    const board = this.game.communityCards;
    const equity = street === 'preflop'
      ? null // pickAction ignores equity preflop and uses preflopTier instead
      : this.strategy.computeEquity(ai.holeCards, board, { iterations: 300 });
    const position = aiIdx === this.game.dealerIndex ? 'ip' : 'oop';
    const wasAggressor = this.game.lastAggressorIndex === aiIdx;
    const facingRaise = this._facingRaise(street, toCall);
    const { opponentAggressionRate, opponentFoldToRaiseRate } = this._opponentReads();

    const decision = this.strategy.pickAction({
      street,
      holeCards: ai.holeCards,
      board,
      equity,
      toCall,
      potSize: this.game.pot,
      myChips: ai.chips,
      position,
      currentBet: this.game.currentBet,
      minRaiseTo: this.game.currentBet + this.game.lastRaiseAmount,
      opponentCeiling: this.game.maxTotalFor(actingId),
      wasAggressor,
      facingRaise,
      opponentAggressionRate,
      opponentFoldToRaiseRate,
      style: seat.style,
    });

    const result = decision.action === 'raise'
      ? this._dispatch(actingId, 'raise', decision.raiseTo)
      : this._dispatch(actingId, decision.action);
    return { decision, result };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run __tests__/PveSession.test.js`
Expected: PASS (all tests in the file, including the new describe block).

- [ ] **Step 5: Run the full server test suite to confirm no regression**

Run: `cd server && npm test`
Expected: PASS, count from Task 1's Step 5 plus these new tests (expect 219 + 7 = 226).

- [ ] **Step 6: Commit**

```bash
cd "/Users/reyes/测试 OpenStack"
git add server/PveSession.js server/__tests__/PveSession.test.js
git commit -m "feat: generalize PveSession from one AI opponent to N AI seats

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Thread `seatCount` through `server/index.js`

**Files:**
- Modify: `server/index.js`
- Test: `server/__tests__/pve.integration.test.js`

**Interfaces:**
- Consumes: `PveSession` constructor's new `seatCount` option (Task 2).
- Produces: `pve:start` socket event now accepts an optional `seatCount` field in its payload (`{ playerName, pveId, seatCount }`). Invalid or missing values fall back to `2` (heads-up) — never throws, never creates a session with an unsupported seat count.

- [ ] **Step 1: Check the existing integration test file's setup pattern**

Run: `cd server && sed -n '1,40p' __tests__/pve.integration.test.js`

Read the output to see how a test server/socket pair is spun up in this file (needed to write Step 2's test in the same style — this repo's integration tests each set up their own in-memory server/client socket pair, copy that exact pattern rather than guessing at one).

- [ ] **Step 2: Write the failing test**

Add a new test to `server/__tests__/pve.integration.test.js`, following the exact same setup pattern (server/client socket creation, `pve:start` emit, waiting for `game:state`) as the file's existing tests for `pve:start`. Add this as a new `it(...)` inside the same `describe` block that already covers `pve:start`:

```js
  it('pve:start 传 seatCount=4 时，game:state 里有 4 个玩家', async () => {
    const state = await new Promise((resolve) => {
      clientSocket.once('game:state', resolve);
      clientSocket.emit('pve:start', { playerName: 'Alice', pveId: 'multi-test-1', seatCount: 4 });
    });
    expect(state.players.length).toBe(4);
  });

  it('pve:start 传非法 seatCount（如 3 或缺省）时，回退到 2 人桌，不报错', async () => {
    const state = await new Promise((resolve) => {
      clientSocket.once('game:state', resolve);
      clientSocket.emit('pve:start', { playerName: 'Alice', pveId: 'multi-test-2', seatCount: 3 });
    });
    expect(state.players.length).toBe(2);
  });
```

(If the existing tests in this file use a different resolution pattern — e.g. a shared `waitFor` helper instead of a raw `Promise`/`once` — use that helper instead, matching whatever Step 1 showed you. The exact mechanics of "wait for the next `game:state`" must match the file's established convention, not necessarily this literal snippet.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && npx vitest run __tests__/pve.integration.test.js`
Expected: FAIL — `state.players.length` is 2 for the `seatCount=4` case (the field is currently ignored).

- [ ] **Step 4: Implement `seatCount` wiring in `server/index.js`**

Find the `pve:start` handler:

```js
    socket.on('pve:start', ({ playerName, pveId }) => {
      if (!pveId) return socket.emit('game:error', '缺少玩家标识');
      socketToPveId.set(socket.id, pveId);
      pveActiveSocket.set(pveId, socket.id);
      let session = pveSessions.get(pveId);
      if (!session) {
        const name = (playerName || '').trim() || '玩家';
        session = new PveSession(pveId, name);
        session.touch();
        pveSessions.set(pveId, session);
      } else {
```

Replace with:

```js
    socket.on('pve:start', ({ playerName, pveId, seatCount }) => {
      if (!pveId) return socket.emit('game:error', '缺少玩家标识');
      socketToPveId.set(socket.id, pveId);
      pveActiveSocket.set(pveId, socket.id);
      let session = pveSessions.get(pveId);
      if (!session) {
        const name = (playerName || '').trim() || '玩家';
        // 固定四档，非法/缺省一律回退单挑——不接受任意人数。
        const VALID_SEAT_COUNTS = [2, 4, 6, 8];
        const count = VALID_SEAT_COUNTS.includes(seatCount) ? seatCount : 2;
        session = new PveSession(pveId, name, { seatCount: count });
        session.touch();
        pveSessions.set(pveId, session);
      } else {
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && npx vitest run __tests__/pve.integration.test.js`
Expected: PASS.

- [ ] **Step 6: Run the full server test suite to confirm no regression**

Run: `cd server && npm test`
Expected: PASS, count from Task 2's Step 5 plus these 2 new tests (expect 226 + 2 = 228).

- [ ] **Step 7: Commit**

```bash
cd "/Users/reyes/测试 OpenStack"
git add server/index.js server/__tests__/pve.integration.test.js
git commit -m "feat: thread seatCount from pve:start through to PveSession

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: HomePage seat-count picker + client-side threading

**Files:**
- Modify: `client/src/pages/HomePage.jsx`
- Modify: `client/src/pages/HomePage.css`
- Modify: `client/src/App.jsx`
- Modify: `client/src/pages/PvePage.jsx`

**Interfaces:**
- Consumes: nothing new from the server (this task only changes what payload the client sends on `pve:start`, matching Task 3's now-accepted `seatCount` field).
- Produces: `HomePage`'s `onPve` prop is now called as `onPve(name, seatCount)` instead of `onPve(name)`. `App.jsx` stores `seatCount` alongside `pveName` and passes it to `PvePage` as a new `seatCount` prop. `PvePage`'s `emit('pve:start', ...)` call includes it.

This task has no server-side tests (no new test framework wired up for client components in this repo — client correctness here is verified in Task 5 via real-device/Playwright checks, matching how every other client-only UI change in this project's history has been verified). Each step below is still independently runnable/checkable via `npm run build`.

- [ ] **Step 1: Add the seat-count picker to `HomePage.jsx`**

Find:

```jsx
      {mode === null && (
        // 找不到真人对战时自己练练手——刻意放在卡片外面、页面下方，跟"创建/
        // 加入房间"这两个正式入口在视觉上分开一层，不经过任何房间码/邀请链接，
        // 点了直接开局。见 design.md「新增：单人人机对战（PVE）模式」，MVP 不
        // 跟多人房间混用。
        <div className="home-pve-link" onClick={() => onPve(name.trim())}>人机对战</div>
      )}
```

Replace with:

```jsx
      {mode === null && (
        // 找不到真人对战时自己练练手——刻意放在卡片外面、页面下方，跟"创建/
        // 加入房间"这两个正式入口在视觉上分开一层，不经过任何房间码/邀请链接。
        // 见 design.md「新增：单人人机对战（PVE）模式」，MVP 不跟多人房间混用。
        // 点了不直接开局，先切到 mode==='pve' 选桌形（2026-08-02 新增：支持
        // 多电脑同桌，不再只有单挑）。
        <div className="home-pve-link" onClick={() => setMode('pve')}>人机对战</div>
      )}
      {mode === 'pve' && (
        // 风格是随机分配、对玩家不可见的（design.md 已确认），所以这里只
        // 需要选人数，不需要选风格/难度。四档固定卡片，不开放任意数字。
        <div className="home-pve-picker">
          <div className="home-pve-picker-title">选择桌形</div>
          <div className="home-pve-picker-grid">
            <button className="home-pve-seat-btn" onClick={() => onPve(name.trim(), 2)}>单挑</button>
            <button className="home-pve-seat-btn" onClick={() => onPve(name.trim(), 4)}>4 人</button>
            <button className="home-pve-seat-btn" onClick={() => onPve(name.trim(), 6)}>6 人</button>
            <button className="home-pve-seat-btn" onClick={() => onPve(name.trim(), 8)}>8 人</button>
          </div>
          <div className="home-pve-picker-back" onClick={() => setMode(null)}>返回</div>
        </div>
      )}
```

- [ ] **Step 2: Add the picker styles to `HomePage.css`**

Find the existing `.home-pve-link` block:

```css
.home-pve-link {
  /* 贴近页面底部，跟卡片本身（垂直居中）的位置脱钩——不管卡片多高、
     视口多高，这个入口始终在接近视口底边的地方，而不是紧跟在卡片下方。 */
  position: absolute;
  left: 0;
  right: 0;
  bottom: max(env(safe-area-inset-bottom, 0px), var(--sp-8));
  z-index: 1;
  text-align: center;
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 1px;
  color: var(--text-secondary);
  cursor: pointer;
}
.home-pve-link:active { opacity: .6; }
```

Add this new block immediately after it:

```css
/* 2026-08-02 新增：点"人机对战"后先选桌形（单挑/4/6/8 人），风格随机
   分配且对玩家不可见（design.md 已确认），所以这里不需要选风格/难度。
   跟 .home-pve-link 用同一个"贴视口底边"定位方式，替换它而不是叠在
   它旁边。 */
.home-pve-picker {
  position: absolute;
  left: 0;
  right: 0;
  bottom: max(env(safe-area-inset-bottom, 0px), var(--sp-6));
  z-index: 1;
  padding: 0 var(--sp-6);
  text-align: center;
}
.home-pve-picker-title {
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 1px;
  color: var(--text-muted);
  margin-bottom: var(--sp-3);
}
.home-pve-picker-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--sp-2);
}
.home-pve-seat-btn {
  height: 44px;
  border-radius: var(--r-md);
  background: rgba(212,175,55,.08);
  border: 1px solid rgba(212,175,55,.24);
  color: var(--gold-200);
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition: background .15s, border-color .15s;
}
.home-pve-seat-btn:active { background: rgba(212,175,55,.18); border-color: rgba(212,175,55,.4); }
.home-pve-picker-back {
  margin-top: var(--sp-3);
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-muted);
  cursor: pointer;
}
.home-pve-picker-back:active { opacity: .6; }
```

- [ ] **Step 3: Thread `seatCount` through `App.jsx`**

Find:

```jsx
  const [pveName, setPveName] = useState(null);
```

Replace with:

```jsx
  const [pveName, setPveName] = useState(null);
  const [pveSeatCount, setPveSeatCount] = useState(2);
```

Find:

```jsx
  function handlePve(name) {
    localStorage.setItem('vr_pveActive', '1');
    setPveName(name);
  }
```

Replace with:

```jsx
  function handlePve(name, seatCount) {
    localStorage.setItem('vr_pveActive', '1');
    setPveName(name);
    setPveSeatCount(seatCount ?? 2);
  }
```

Find:

```jsx
        <PvePage playerName={pveName} onLeave={handlePveLeave} />
```

Replace with:

```jsx
        <PvePage playerName={pveName} seatCount={pveSeatCount} onLeave={handlePveLeave} />
```

- [ ] **Step 4: Thread `seatCount` through `PvePage.jsx`**

Find:

```jsx
export default function PvePage({ playerName, onLeave }) {
```

Replace with:

```jsx
export default function PvePage({ playerName, seatCount, onLeave }) {
```

Find:

```jsx
    function sync() { emit('pve:start', { playerName, pveId: getPveId() }); }
```

Replace with:

```jsx
    function sync() { emit('pve:start', { playerName, pveId: getPveId(), seatCount }); }
```

- [ ] **Step 5: Build the client to verify no errors**

Run: `cd client && npm run build`
Expected: build succeeds with no new errors (pre-existing lint errors/warnings unrelated to these files, if any, are not this task's concern).

- [ ] **Step 6: Commit**

```bash
cd "/Users/reyes/测试 OpenStack"
git add client/src/pages/HomePage.jsx client/src/pages/HomePage.css client/src/App.jsx client/src/pages/PvePage.jsx
git commit -m "feat: add table-size picker to PVE entry, thread seatCount to server

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Real-device verification, SDD update

**Files:**
- Modify: `openspec/changes/online-texas-holdem/design.md`
- Modify: `openspec/changes/online-texas-holdem/tasks.md`

This task has no code changes — it's the verification + documentation close-out required by this project's CLAUDE.md (SDD-first workflow) and its "判断一项任务是否做完了...要读代码、跑测试、真实跑一遍浏览器确认" rule. Do not skip it or mark the feature done without it.

- [ ] **Step 1: Start the dev server and manually play through one hand each at 4/6/8 seats**

Run: `cd server && node index.js &` then `cd client && npm run dev`, open the printed local URL in a browser, click "人机对战", pick "4 人", play at least one full hand to showdown or fold-win. Repeat for "6 人" and "8 人". Confirm: no console errors, settlement sheet shows the correct winner(s), ledger totals stay consistent (sum of all `state.ledger[].chips` equals `seatCount × startingChips` at any point between hands).

- [ ] **Step 2: Playwright visual check for the 8-max table**

Use this project's existing Playwright-based verification pattern (per CLAUDE.md: "不接受纯手算/读代码就下结论...要么用 Playwright 之类工具实测（比如量真实渲染出来的 bounding box）"). Write a one-off script (can live in `/tmp` or the scratchpad — not committed) that: launches a PVE session with `seatCount: 8` via the actual running dev server, takes a screenshot of the table view, and measures each seat's avatar bounding box against the visible viewport (reuse the same overlap-scanning approach already used for the 9-max multiplayer dense-table work referenced in design.md task 7). Confirm zero seats clipped/overlapping.

If clipping/overlap is found: this is a bug in the shared `GameTable`/`.game-stage--dense` styling that predates this feature (PVE now just exercises a seat count it didn't before) — file it as a normal bug fix task, don't silently patch it inside this plan without a test.

- [ ] **Step 3: Update `design.md`**

Add a new section at the end of `openspec/changes/online-texas-holdem/design.md` (after the current last section, before the closing risk-mitigation bullet list), following the file's established format (background / decision / verification), summarizing: PVE now supports 2/4/6/8-seat tables, AI seats get a random style from `pveStrategy.STYLE_DELTAS`, names from a fixed pool, no difficulty tiers, no multiway range tightening or cross-seat exploitation this round (link back to `docs/superpowers/specs/2026-08-02-pve-multi-opponent-design.md` for the full rationale instead of repeating it), and note the actual Step 1/Step 2 verification results (pass/fail, what was checked).

- [ ] **Step 4: Update `tasks.md`**

Add a new numbered section to `openspec/changes/online-texas-holdem/tasks.md` (next number after the current highest), with one `- [x]` line per task completed above (1 through 5), each summarizing what changed — matching the terse-but-specific style of every other entry already in that file (see e.g. section 65 or 66 for the exact voice/format to match).

- [ ] **Step 5: Commit**

```bash
cd "/Users/reyes/测试 OpenStack"
git add openspec/changes/online-texas-holdem/design.md openspec/changes/online-texas-holdem/tasks.md
git commit -m "docs: record PVE multi-opponent feature in SDD, verification results

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Report back to the user**

Summarize what was verified (Step 1/2 results) and ask whether to push to `main` (this project's CLAUDE.md rule: never push without explicit instruction).
