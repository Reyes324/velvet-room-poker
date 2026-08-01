# PVE EV-Driven AI Decision Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the PVE AI's probability-table-sampling decision core with an EV-maximizing one — every decision computes fold/call/raise expected value (using real equity, pot odds, fold equity, and stack depth) and picks the highest, with a small bluff-deviation layer preserved for unpredictability.

**Architecture:** `server/pveStrategy.js`'s `pickAction()` is rewritten from "look up a probability table, sample a bucket" to "compute EV(fold)/EV(call)/EV(raise), pick the max, then a bluff-deviation roll." The table-driven machinery (`PREFLOP_TABLE`, `POSTFLOP_BANDS`, `bandFor`, `contextDeltas`, `adjustDistribution`, `STYLE_DELTAS`, `preflopTier`, `PREFLOP_EQUITY_PROXY`, `boardTexture`) is deleted outright, not kept alongside the new code — it's being replaced, not extended. `computeEquity()` (Monte Carlo/exhaustive equity via `pokersolver`) is unchanged and now used for both preflop and postflop (previously preflop used a tier-table instead). `server/PveSession.js`'s `aiAction()` changes what it computes and passes to `pickAction()`: always computes real equity (including preflop), computes the true current-street pot (previously `potSize` excluded this street's already-placed bets — an actual precision bug in the pot value being fed to any EV-style formula, not just a style change), counts live (non-folded) opponents, and passes `bigBlind`.

**Known behavior change (flagged for the record, not something to preserve):** the old `position`(IP/OOP)-based widening and `wasAggressor`(c-bet continuation)-based boosts are dropped, not ported into the EV formula — modeling "how does having position or having been the last aggressor change this decision" properly requires multi-street lookahead, which is explicitly out of scope (see the design spec's "明确不做" section). This is a real simplification, not an oversight — flagged here so a reviewer doesn't need to go hunting for where `position`/`wasAggressor` went.

## Global Constraints

- Heads-up (seatCount=2, single AI seat, `style: null`) must keep working (it's still the most common path); it does NOT need to reproduce old numeric outputs (the whole engine changed on purpose), but it must produce a legal, terminating decision every time — the smoke test in `PveSession.test.js` ("真实策略引擎跑完整局") already covers this and must keep passing unmodified.
- No difficulty tiers — this is still true after the rewrite (no strength/skill parameter anywhere).
- No per-opponent modeling in multiway pots — fold equity is estimated once, aggregated as `p^n` where `n` = live opponent count (see spec).
- No continuous bet-size optimization — one candidate raise size (via the existing `raiseSizeFraction` polarization heuristic, or the full effective stack in short-stack preflop push/fold mode), EV computed only for that candidate.
- `PREFLOP_TABLE`, `POSTFLOP_BANDS`, `bandFor`, `contextDeltas`, `adjustDistribution`, `STYLE_DELTAS`, `preflopTier`, `PREFLOP_EQUITY_PROXY`, `boardTexture` are deleted from `pveStrategy.js` (not deprecated-but-kept) along with their exports and all their dedicated tests in `pveStrategy.test.js`.
- `STYLES` must still export exactly `['steady', 'aggressive', 'bluffer', 'callingStation']` (same 4 keys, same order) — `PveSession.js`'s `pickRandomStyle()`/`buildAiSeats()` consume this array directly and must not need any change.
- Spec: `docs/superpowers/specs/2026-08-02-pve-ev-driven-ai-design.md`.

---

### Task 1: Rewrite `pveStrategy.js`'s decision core (EV engine)

**Files:**
- Modify: `server/pveStrategy.js`
- Modify: `server/__tests__/pveStrategy.test.js` (near-total rewrite — the old table-driven tests are being replaced, not extended)

**Interfaces:**
- Consumes: nothing new (still only `pokersolver` and `./GameEngine`'s `makeDeck`/`RANKS`).
- Produces: `pickAction(params)` — **new parameter shape**, replacing the old one:
  ```
  pickAction({
    street,               // 'preflop' | 'flop' | 'turn' | 'river' — only used to gate short-stack preflop push/fold mode
    equity,               // real equity in [0,1], caller (PveSession) always computes this now, preflop included
    toCall,               // number
    potSize,              // number — the current pot (GameEngine's `.pot` field already includes every bet as it's placed, current street included — see Task 2, no separate "visible pot" computation needed)
    myChips,              // number
    currentBet = toCall,  // number
    minRaiseTo,           // number | undefined
    random = Math.random,
    opponentCeiling = Infinity,  // effective-stack cap, same semantics as before (GameEngine.maxTotalFor)
    liveOpponentCount = 1,       // NEW — count of non-folded opponents excluding the actor
    bigBlind,                    // NEW — needed for the short-stack-preflop threshold
    opponentFoldToRaiseRate = null,
    style = null,          // same 4 values as before, now consumed differently (see below)
  })
  ```
  Returns the same shape as before: `{ action: 'fold' }` | `{ action: 'check' }` | `{ action: 'call' }` | `{ action: 'raise', raiseTo }` | `{ action: 'allin', raiseTo }`.
  Also produces: `STYLES` (unchanged export, same 4 keys), `computeEquity` (unchanged), `raiseSizeFraction` (signature changes — see Step 3).

- [ ] **Step 1: Write the failing tests**

Replace the ENTIRE contents of `server/__tests__/pveStrategy.test.js` with:

```js
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
  computeEquity,
  pickAction,
  raiseSizeFraction,
  STYLES,
} = require('../pveStrategy');

describe('pveStrategy — computeEquity', () => {
  it('河牌（5 张公共牌都已确定）用穷举而非采样，结果必须是确定值：口袋 A 在无平局可能的墙上胜率应为 1', () => {
    const equity = computeEquity(['As', 'Ac'], ['Ah', 'Ad', '2c', '5d', '9h']);
    expect(equity).toBe(1);
  });

  it('翻前口袋 A 蒙特卡洛胜率应显著高于口袋 7（大样本下，允许统计误差）', () => {
    const aa = computeEquity(['As', 'Ac'], [], { iterations: 2000 });
    const sevens = computeEquity(['7s', '7c'], [], { iterations: 2000 });
    expect(aa).toBeGreaterThan(sevens);
    expect(aa).toBeGreaterThan(0.75);
  });

  it('iterations 相同时传入固定的 random 函数应得到完全可复现的结果', () => {
    let calls = 0;
    const fakeRandom = () => {
      calls += 1;
      const seed = calls * 9301 + 49297;
      return (seed % 233280) / 233280;
    };
    const e1 = computeEquity(['Qs', 'Qh'], ['2c', '5d', '9h'], { iterations: 100, random: fakeRandom });
    calls = 0;
    const e2 = computeEquity(['Qs', 'Qh'], ['2c', '5d', '9h'], { iterations: 100, random: fakeRandom });
    expect(e1).toBe(e2);
  });
});

describe('pveStrategy — STYLES', () => {
  it('导出四个风格键名，供 PveSession 随机分配', () => {
    expect(STYLES).toEqual(['steady', 'aggressive', 'bluffer', 'callingStation']);
  });
});

describe('pveStrategy — pickAction 基础 EV 比较（无风格、无对手数据、正常筹码深度）', () => {
  // High equity, facing a real bet: calling is clearly +EV, folding is
  // clearly wrong. EV(call) = 0.9*(300+100)-100 = 260. This alone should
  // beat EV(fold)=0 by a wide margin regardless of the raise candidate's
  // own EV, so the action must not be 'fold'.
  it('高胜率、面对真实下注时不应该弃牌', () => {
    const a = pickAction({
      street: 'flop', equity: 0.9, toCall: 100, potSize: 300, myChips: 1000,
      currentBet: 100, bigBlind: 20, random: () => 0.5,
    });
    expect(a.action).not.toBe('fold');
  });

  // Very low equity, facing a real bet, no fold equity (opponentFoldToRaiseRate
  // defaults to the neutral 0.5 prior, single opponent -> foldEquity=0.5,
  // not enough to make a bluff-raise +EV against a large-ish bet), and the
  // bluff-deviation roll is forced to not fire (random always returns a
  // value >= BLUFF_DEVIATION_RATE for that specific call — see Step 3 for
  // the exact constant. Using random:()=>0.99 for every call, comfortably
  // above any reasonable deviation rate, keeps this test robust to the
  // exact constant value chosen in Step 3).
  it('极低胜率、面对下注、没有弃牌权益优势时应该弃牌', () => {
    const a = pickAction({
      street: 'flop', equity: 0.05, toCall: 200, potSize: 200, myChips: 1000,
      currentBet: 200, bigBlind: 20, random: () => 0.99,
    });
    expect(a.action).toBe('fold');
  });

  it('toCall 为 0 时（可以白看）永远不应该弃牌', () => {
    for (let r = 0; r < 1; r += 0.2) {
      const a = pickAction({
        street: 'flop', equity: 0.05, toCall: 0, potSize: 300, myChips: 1000,
        currentBet: 0, bigBlind: 20, random: () => r,
      });
      expect(a.action).not.toBe('fold');
    }
  });

  it('raise 时 raiseTo 必须落在 [minRaiseTo, 全下] 之间', () => {
    const a = pickAction({
      street: 'flop', equity: 0.95, toCall: 100, potSize: 300, myChips: 1000,
      currentBet: 100, minRaiseTo: 300, bigBlind: 20, random: () => 0.01,
    });
    if (a.action === 'raise') {
      expect(a.raiseTo).toBeGreaterThanOrEqual(300);
      expect(a.raiseTo).toBeLessThanOrEqual(1000 + 100);
    } else {
      expect(a.action).toBe('allin');
    }
  });

  it('筹码太浅、连最小加注都摸不到全下时应该返回 allin 而不是不合法的 raise 数字', () => {
    const a = pickAction({
      street: 'river', equity: 0.99, toCall: 50, potSize: 5000, myChips: 60,
      currentBet: 50, minRaiseTo: 100, bigBlind: 20, random: () => 0.01,
    });
    expect(['raise', 'allin']).toContain(a.action);
    if (a.action === 'raise') expect(a.raiseTo).toBeLessThanOrEqual(60 + 50);
  });
});

describe('pveStrategy — 弃牌权益（多人聚合 p^n）', () => {
  // Hand-verified against the exact Step 3 formula (see plan's verification
  // script — do not loosen these numbers without re-deriving by hand):
  // equity=0.05, toCall=100, potSize=300, currentBet=100 -> myBetThisStreet=0,
  // raiseCandidate=518 (sizeFraction at random()=0.99, polarized branch),
  // cost=518, potIfCalled=1236. opponentFoldToRaiseRate=0.9:
  //   liveOpponentCount=1 -> foldEquity=0.9^1=0.9 -> evRaise≈224.4 (raise wins)
  //   liveOpponentCount=5 -> foldEquity=0.9^5≈0.590 -> evRaise≈-9.7 (fold wins, evFold=0 > evRaise > evCall=-80)
  it('弃牌权益随对手数量指数下降：同一个纯诈唬局面，对手越多弃牌权益越低，加注从 +EV 变成 -EV', () => {
    const base = {
      street: 'flop', equity: 0.05, toCall: 100, potSize: 300, myChips: 1000,
      currentBet: 100, bigBlind: 20, opponentFoldToRaiseRate: 0.9, random: () => 0.99,
    };
    const oneOpp = pickAction({ ...base, liveOpponentCount: 1 });
    const fiveOpp = pickAction({ ...base, liveOpponentCount: 5 });
    expect(oneOpp.action).toBe('raise');
    expect(fiveOpp.action).toBe('fold');
  });
});

describe('pveStrategy — 后手深度（SPR + 翻前浅筹码 push/fold）', () => {
  it('翻前后手极浅（低于阈值）时，加注候选直接是全下，不是按底池比例算的小尺度', () => {
    // effectiveStackBB = 200/20 = 10, well under the 15bb threshold.
    const a = pickAction({
      street: 'preflop', equity: 0.55, toCall: 20, potSize: 30, myChips: 200,
      currentBet: 20, bigBlind: 20, random: () => 0.01,
    });
    expect(['raise', 'allin']).toContain(a.action);
    if (a.action === 'raise') {
      // Push/fold mode raises to the full effective stack, not a
      // pot-fraction size — assert it's at or near the full stack, not a
      // small sizing-heuristic amount.
      expect(a.raiseTo).toBeGreaterThanOrEqual(190);
    }
  });

  it('翻前后手够深时，不会强制全下——正常按尺度启发式算加注额', () => {
    // effectiveStackBB = 3000/20 = 150, well over the threshold.
    const a = pickAction({
      street: 'preflop', equity: 0.95, toCall: 20, potSize: 30, myChips: 3000,
      currentBet: 20, minRaiseTo: 60, bigBlind: 20, random: () => 0.01,
    });
    if (a.action === 'raise') {
      expect(a.raiseTo).toBeLessThan(3000); // nowhere near a forced shove
    }
  });
});

describe('pveStrategy — 风格对 EV 计算的偏差', () => {
  // All four cases below are hand-verified against the exact Step 3 formula
  // (see plan's verification script) — every number here was chosen so the
  // neutral (no-style) case sits just barely on one side of the fold/call/
  // raise boundary, and the style's bias tips it to the other side. Do not
  // "simplify" these numbers without re-running the verification script —
  // several rounds of hand-picked-but-unverified numbers in an earlier
  // draft of this plan turned out to not actually produce the claimed
  // outcome once checked against the real formula.

  // equity=0.40, toCall=150, potSize=200, currentBet=150 -> raiseCandidate=289,
  // cost=289, potIfCalled=628. opponentFoldToRaiseRate=0.05 -> foldEquity=0.05.
  // neutral: evCall=-10, evRaise=-25.9, evFold=0 -> fold wins.
  // callingStation: eq inflated to 0.44 -> evCall=+4 (crosses breakeven
  // 150/(200+150)=0.4286), evRaise=-2.05 -> call wins.
  it('callingStation（跟注型）比不传 style 更容易跟注（高估自己的胜率）', () => {
    const base = {
      street: 'flop', equity: 0.40, toCall: 150, potSize: 200, myChips: 1000,
      currentBet: 150, bigBlind: 20, opponentFoldToRaiseRate: 0.05, random: () => 0.99,
    };
    const neutral = pickAction(base);
    const station = pickAction({ ...base, style: 'callingStation' });
    expect(neutral.action).toBe('fold');
    expect(station.action).toBe('call');
  });

  // equity=0.10, toCall=150, potSize=200, currentBet=150 -> raiseCandidate=428,
  // cost=428, potIfCalled=906, "called" outcome eq*potIfCalled-cost=-337.4.
  // opponentFoldToRaiseRate=0.55 -> neutral foldEquity=0.55 -> evRaise=-41.8
  // (fold wins, evFold=0). bluffer -> foldEquity=min(1,0.55*1.2)=0.66 ->
  // evRaise=+17.3 -> raise wins.
  it('bluffer（诈唬型）比不传 style 更容易诈唬加注（高估自己的弃牌权益）', () => {
    const base = {
      street: 'flop', equity: 0.10, toCall: 150, potSize: 200, myChips: 1000,
      currentBet: 150, bigBlind: 20, opponentFoldToRaiseRate: 0.55, random: () => 0.99,
    };
    const neutral = pickAction(base);
    const bluffer = pickAction({ ...base, style: 'bluffer' });
    expect(neutral.action).toBe('fold');
    expect(bluffer.action).toBe('raise');
  });

  // equity=0.4, toCall=100, potSize=300, currentBet=100, minRaiseTo=150 ->
  // raiseCandidate=205, cost=205, potIfCalled=610. opponentFoldToRaiseRate=
  // 0.08 -> foldEquity=0.08 -> neutral evCall=60, evRaise=59.88 (call wins
  // by a hair). aggressive multiplies evRaise by 1.15 -> 68.86 -> raise wins.
  it('aggressive（激进型）比不传 style 更容易加注（EV 相近时偏好高方差选项）', () => {
    const base = {
      street: 'flop', equity: 0.4, toCall: 100, potSize: 300, myChips: 1000,
      currentBet: 100, minRaiseTo: 150, bigBlind: 20, opponentFoldToRaiseRate: 0.08,
      random: () => 0,
    };
    const neutral = pickAction(base);
    const aggressive = pickAction({ ...base, style: 'aggressive' });
    expect(neutral.action).toBe('call');
    expect(aggressive.action).toBe('raise');
  });

  // Same shape as the aggressive case but opponentFoldToRaiseRate=0.12 ->
  // neutral foldEquity=0.12 -> evRaise=70.32 > evCall=60 (raise wins by a
  // hair). steady multiplies evRaise by 0.85 -> 59.77 < 60 -> call wins.
  it('steady（稳健型）比不传 style 更少加注（给高方差选项的 EV 打折）', () => {
    const base = {
      street: 'flop', equity: 0.4, toCall: 100, potSize: 300, myChips: 1000,
      currentBet: 100, minRaiseTo: 150, bigBlind: 20, opponentFoldToRaiseRate: 0.12,
      random: () => 0,
    };
    const neutral = pickAction(base);
    const steady = pickAction({ ...base, style: 'steady' });
    expect(neutral.action).toBe('raise');
    expect(steady.action).toBe('call');
  });

  it('未知的 style 字符串静默忽略（不抛异常，等价于不传）', () => {
    const base = {
      street: 'flop', equity: 0.5, toCall: 100, potSize: 300, myChips: 1000,
      currentBet: 100, bigBlind: 20, random: () => 0.5,
    };
    const neutral = pickAction(base);
    const unknown = pickAction({ ...base, style: 'not-a-real-style' });
    expect(unknown.action).toBe(neutral.action);
  });
});

describe('pveStrategy — raiseSizeFraction（下注尺度极化，签名简化：直接吃 equity）', () => {
  it('极端胜率（价值/诈唬两端）应该比中等胜率有更宽、更大的尺度范围', () => {
    const polarizedFractions = [];
    const mergedFractions = [];
    for (let i = 0; i <= 20; i++) {
      const r = i / 20;
      polarizedFractions.push(raiseSizeFraction(0.95, () => r));
      mergedFractions.push(raiseSizeFraction(0.5, () => r));
    }
    expect(Math.max(...polarizedFractions)).toBeGreaterThan(Math.max(...mergedFractions));
    const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    expect(avg(polarizedFractions)).toBeGreaterThan(avg(mergedFractions));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run __tests__/pveStrategy.test.js`
Expected: FAIL — most of these reference the new `pickAction` parameter shape and behavior, which doesn't exist yet (old `pickAction` will error or behave differently on several of these).

- [ ] **Step 3: Replace `server/pveStrategy.js` with the new EV-driven implementation**

Replace the entire file contents with:

```js
const { Hand } = require('pokersolver');
const { makeDeck } = require('./GameEngine');
// No rank/suit helpers here anymore — preflopTier/boardTexture (the only
// consumers) were deleted along with the table-driven machinery they
// existed for; don't reintroduce them as unused dead code.

// ═══════════════════════════════════════════════════════════════════════
// PVE (人机对战) 决策引擎 — 单人模式专用，不被多人房间引用。
//
// 设计依据见 docs/superpowers/specs/2026-08-02-pve-ev-driven-ai-design.md：
// 每个动作直接算期望价值（EV）——胜率 × 底池赔率 × 弃牌权益 × 后手深度——
// 选 EV 最高的那个，而不是像之前那样查一张手工调过的概率表再抽样。旧的
// PREFLOP_TABLE/POSTFLOP_BANDS/contextDeltas/STYLE_DELTAS 那套"分档 + 具名
// 调整量叠加"的机制整体替换掉，不是在它旁边再加一层。
// ═══════════════════════════════════════════════════════════════════════

// ─── 胜率计算（不变）────────────────────────────────────────────────────
// board.length===5（河牌，无未知公共牌）时用穷举而不是采样：剩余未知的只
// 有对手的 2 张底牌，C(45,2)≈990 种组合，穷举比蒙特卡洛更快也更准确。翻前
// /翻牌/转牌阶段公共牌还没完全揭晓，改用蒙特卡洛采样（iterations 次），
// random 可注入以便测试复现。现在翻前也用这个函数算真实胜率（board=[]），
// 不再走单独的起手牌分档表。
function computeEquity(holeCards, board, opts = {}) {
  const { iterations = 300, random = Math.random } = opts;
  const known = new Set([...holeCards, ...board]);
  const remaining = makeDeck().filter(c => !known.has(c));

  if (board.length === 5) {
    let win = 0, tie = 0, total = 0;
    const heroHand = Hand.solve([...holeCards, ...board]);
    for (let i = 0; i < remaining.length; i++) {
      for (let j = i + 1; j < remaining.length; j++) {
        const oppHand = Hand.solve([remaining[i], remaining[j], ...board]);
        const winners = Hand.winners([heroHand, oppHand]);
        total++;
        if (winners.length === 2) tie++;
        else if (winners[0] === heroHand) win++;
      }
    }
    return total === 0 ? 1 : (win + tie / 2) / total;
  }

  const needed = 5 - board.length;
  let win = 0, tie = 0;
  for (let n = 0; n < iterations; n++) {
    const pool = [...remaining];
    const draw = () => {
      const idx = Math.floor(random() * pool.length);
      return pool.splice(idx, 1)[0];
    };
    const oppHole = [draw(), draw()];
    const runoutBoard = [...board];
    for (let k = 0; k < needed; k++) runoutBoard.push(draw());

    const heroHand = Hand.solve([...holeCards, ...runoutBoard]);
    const oppHand = Hand.solve([...oppHole, ...runoutBoard]);
    const winners = Hand.winners([heroHand, oppHand]);
    if (winners.length === 2) tie++;
    else if (winners[0] === heroHand) win++;
  }
  return (win + tie / 2) / iterations;
}

// ─── 风格 → EV 计算的认知偏差（多人机对战沿用，2026-08-02 改成偏差参数）──
// 风格不再加减概率表，而是对 EV 计算的输入做偏差——诈唬型高估自己的弃牌
// 权益、跟注型高估自己的胜率、激进型给高方差动作（raise）的 EV 加成、
// 稳健型给高方差动作打折扣。单挑模式 style 是 null，四个偏差都不生效。
const STYLE_EV_BIAS = {
  steady:         { varianceScale: 0.85 },  // 高方差（raise）动作的 EV 打折，模拟风险厌恶
  aggressive:     { varianceScale: 1.15 },  // 高方差（raise）动作的 EV 加成，更容易选 raise
  bluffer:        { foldEquityMultiplier: 1.2 }, // 高估自己的弃牌权益
  callingStation: { equityMultiplier: 1.1 },     // 高估自己的胜率（封顶 1.0）
};
const STYLES = Object.keys(STYLE_EV_BIAS);

// 无 oppStats 数据时的中性先验——不假设对手特别爱弃牌或特别爱跟注。
const DEFAULT_FOLD_PRIOR = 0.5;
// 翻前有效后手（单位：大盲）低于这个阈值时，直接进入 push/fold 模式：
// 加注候选固定为全下，不再用尺度启发式算一个"加一点点"的数字——按底池
// 比例算的尺度在筹码这么浅的时候天然算不出接近全下的数，不加这个特判，
// 浅筹码根本不会自然收敛到标准的 push/fold 打法。
const SHORT_STACK_BB_THRESHOLD = 15;
// EV-最优动作是弃牌、且自己胜率明显偏低时，保留这么大的概率不按最优走、
// 改成诈唬式加注——避免"胜率一低就必弃牌"这种能被一眼看穿的规律。
const BLUFF_DEVIATION_RATE = 0.08;
const BLUFF_EQUITY_CEILING = 0.30;

// 弃牌权益：单个对手的基础估计（默认先验，或已有的 oppStats 数据），乘上
// 风格偏差，再按"剩余所有活跃对手当一个整体"聚合成 p^n——人越多，全员
// 弃牌的概率天然指数下降，不用逐个对手单独建模。
function estimateFoldEquity({ opponentFoldToRaiseRate, liveOpponentCount = 1, style = null }) {
  let p = opponentFoldToRaiseRate ?? DEFAULT_FOLD_PRIOR;
  const bias = STYLE_EV_BIAS[style];
  if (bias?.foldEquityMultiplier) p *= bias.foldEquityMultiplier;
  p = Math.min(1, Math.max(0, p));
  const n = Math.max(1, liveOpponentCount);
  return Math.pow(p, n);
}

// 跟注型高估自己的胜率——只影响它自己怎么看待这手牌，不影响真实胜率计算
// 本身（computeEquity 算出来的数是客观的）。
function styledEquity(equity, style) {
  const bias = STYLE_EV_BIAS[style];
  if (!bias?.equityMultiplier) return equity;
  return Math.min(1, equity * bias.equityMultiplier);
}

// 下注尺度极化：真实强牌（价值）和明显诈唬用大且浮动范围更宽的尺度
// （0.6-1.4 倍底池），中等牌力用偏小、偏窄的"保护性"尺度（0.35-0.7 倍底
// 池）。直接吃 equity（翻前翻后现在都有真实胜率，不再需要按街区分/靠起
// 手牌分档代理）。
function raiseSizeFraction(equity, random) {
  const polarized = equity >= 0.70 || equity <= 0.30;
  const [lo, hi] = polarized ? [0.6, 1.4] : [0.35, 0.7];
  return lo + random() * (hi - lo);
}

// ─── EV 计算 + 动作选择 ────────────────────────────────────────────────
function pickAction(params) {
  const {
    street, equity, toCall, potSize, myChips, currentBet = toCall, minRaiseTo,
    random = Math.random,
    opponentCeiling = Infinity,
    liveOpponentCount = 1,
    bigBlind,
    opponentFoldToRaiseRate = null,
    style = null,
  } = params;

  const myBetThisStreet = currentBet - toCall;
  const maxTotal = Math.min(myChips + myBetThisStreet, opponentCeiling); // 有效后手能加到的最高总额
  const foldEquity = estimateFoldEquity({ opponentFoldToRaiseRate, liveOpponentCount, style });
  const eq = styledEquity(equity, style);

  // 加注候选额：翻前浅筹码直接全下；否则用极化尺度启发式选一个候选，不
  // 枚举/优化连续尺度。
  const effectiveStackBB = bigBlind ? maxTotal / bigBlind : Infinity;
  const isShortStackPreflop = street === 'preflop' && effectiveStackBB <= SHORT_STACK_BB_THRESHOLD;

  let raiseCandidate;
  if (isShortStackPreflop) {
    raiseCandidate = maxTotal;
  } else {
    const sizeFraction = raiseSizeFraction(eq, random);
    const fallbackMinRaiseTo = currentBet + Math.max(1, Math.round(potSize * 0.5));
    const wantRaiseTo = Math.round(currentBet + potSize * sizeFraction);
    const floor = minRaiseTo ?? fallbackMinRaiseTo;
    raiseCandidate = Math.min(maxTotal, Math.max(floor, wantRaiseTo));
  }

  const evFold = 0;
  const evCall = eq * (potSize + toCall) - toCall;

  // potSize 约定为"此刻真实可见的底池"（含这条街所有已下注的筹码——见
  // PveSession 的调用方，Task 2），所以：加注到 raiseCandidate 后，自己
  // 这条街的追加投入是 cost；假设对手跟注到同一个总额，对手的追加投入是
  // (raiseCandidate - currentBet)；两者都加进当前 potSize 就是"若被跟注"
  // 的最终底池。
  const cost = raiseCandidate - myBetThisStreet;
  const potIfCalled = potSize + cost + (raiseCandidate - currentBet);
  let evRaise = foldEquity * potSize + (1 - foldEquity) * (eq * potIfCalled - cost);

  const bias = STYLE_EV_BIAS[style];
  if (bias?.varianceScale) evRaise *= bias.varianceScale;

  let bestAction;
  if (toCall === 0) {
    // 白看：弃牌不是真实选项（等价于白白放弃一次免费看牌的机会），只在
    // "加注"和"过牌"之间选。
    bestAction = evRaise > evCall ? 'raise' : 'check';
  } else {
    const options = [
      { action: 'fold', ev: evFold },
      { action: 'call', ev: evCall },
      { action: 'raise', ev: evRaise },
    ];
    options.sort((a, b) => b.ev - a.ev);
    bestAction = options[0].action;
  }

  // 诈唬层：EV 最优是弃牌、且自己客观胜率确实很低时，小概率不按最优走。
  if (bestAction === 'fold' && eq <= BLUFF_EQUITY_CEILING && random() < BLUFF_DEVIATION_RATE) {
    bestAction = 'raise';
  }

  if (bestAction === 'fold') return { action: 'fold' };
  if (bestAction === 'call') return { action: 'call' };
  if (bestAction === 'check') return { action: 'check' };

  // raise：夹到 [minRaiseTo或默认下限, 全下] 之间；连最小加注都摸不到全
  // 下（筹码太浅）时直接报 allin，不返回不合法的加注数字。
  if (raiseCandidate >= maxTotal) return { action: 'allin', raiseTo: maxTotal };
  return { action: 'raise', raiseTo: raiseCandidate };
}

module.exports = {
  computeEquity, pickAction, raiseSizeFraction, STYLES,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run __tests__/pveStrategy.test.js`
Expected: PASS (all tests in the rewritten file). If any test's expected action doesn't match (the hand-derived EV numbers in a test's comment don't match actual output), recompute by hand using the exact formulas in the Step 3 code — do not loosen an assertion to make it pass without first confirming by hand which side (test expectation vs. implementation) is actually wrong.

- [ ] **Step 5: Run the full server test suite to confirm no regression outside this file**

Run: `cd server && npm test`
Expected: Other test files may now fail (`PveSession.test.js`, `pve.integration.test.js` reference the old `pveStrategy` shape indirectly through `PveSession`) — that's expected and is Task 2's job to fix, not this task's. Confirm specifically that `__tests__/pveStrategy.test.js` itself is 100% green and that no *unrelated* file (`GameEngine.test.js`, `GameEngine.scenarios.test.js`, `RoomManager.test.js`, `pveStore.test.js`, `reconnect.test.js`, `integration.test.js`) newly fails — those don't touch `pveStrategy` and must be unaffected.

- [ ] **Step 6: Commit**

```bash
cd "/Users/reyes/测试 OpenStack"
git add server/pveStrategy.js server/__tests__/pveStrategy.test.js
git commit -m "feat: replace PVE AI's probability-table sampling with EV-maximizing decisions

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Update `PveSession.js` to feed the new engine correctly

**Files:**
- Modify: `server/PveSession.js`
- Modify: `server/__tests__/PveSession.test.js`

**Interfaces:**
- Consumes: Task 1's new `pickAction()` parameter shape (`liveOpponentCount`, `bigBlind` are new; `potSize` is unchanged — still just `this.game.pot`, verified to already include every bet as it's placed, current street included, not just prior streets; `style` unchanged in meaning to this caller — still just a string key from `STYLES` or `null`).
- Produces: no change to `PveSession`'s own public interface (`isAiTurn()`, `aiAction()`, `humanAction()`, `readyNext()`, `getStateForPlayer()` all keep their existing signatures) — only `aiAction()`'s internal call to `this.strategy.pickAction(...)` changes what it passes.

- [ ] **Step 1: Write the failing test**

Add this test to `server/__tests__/PveSession.test.js`, in a new `describe` block placed after the existing `describe('PveSession — 多电脑对战...')` block (find where that block's closing `});` is and insert after it):

```js
describe('PveSession — EV 引擎接入（2026-08-02）', () => {
  // 全部用 seatCount:4，不用默认的单挑（seatCount:2）——人数 >2 时第一个
  // 行动的是 (dealerIndex+3)%N，新建 session 时 dealerIndex=0（人类坐 0
  // 号），算出来永远是一个 AI 坐位；单挑的第一个行动者反而是庄家/小盲
  // （人类自己，见 GameEngine 单挑特判），如果沿用默认单挑，这里
  // `s.isAiTurn()` 在构造完成后立刻就是 false，会跟这几个测试真正要
  // 验证的东西无关地失败。
  it('aiAction() 传给 pickAction 的 potSize 等于 this.game.pot（GameEngine 的 pot 字段本来就是实时的，含这条街已下注的筹码，不需要额外计算）', () => {
    const s = makeSession({ seatCount: 4 });
    fakeStrategy.pickAction.mockReturnValue({ action: 'call' });
    expect(s.isAiTurn()).toBe(true);
    const potAtCallTime = s.game.pot;
    expect(potAtCallTime).toBeGreaterThan(0); // 盲注已经下了
    s.aiAction();
    const callArgs = fakeStrategy.pickAction.mock.calls[0][0];
    expect(callArgs.potSize).toBe(potAtCallTime);
  });

  it('aiAction() 传给 pickAction 的 liveOpponentCount 是场上未弃牌、除自己以外的玩家数', () => {
    const s = makeSession({ seatCount: 4 });
    fakeStrategy.pickAction.mockReturnValue({ action: 'call' });
    expect(s.isAiTurn()).toBe(true);
    s.aiAction();
    const callArgs = fakeStrategy.pickAction.mock.calls[0][0];
    expect(callArgs.liveOpponentCount).toBe(3); // 4 人桌，还没人弃牌，除自己外 3 个对手
  });

  it('aiAction() 传给 pickAction 的 bigBlind 跟 session 构造时的一致', () => {
    const s = makeSession({ seatCount: 4, bigBlind: 40 });
    fakeStrategy.pickAction.mockReturnValue({ action: 'call' });
    expect(s.isAiTurn()).toBe(true);
    s.aiAction();
    const callArgs = fakeStrategy.pickAction.mock.calls[0][0];
    expect(callArgs.bigBlind).toBe(40);
  });

  it('aiAction() 翻前也真实计算胜率（equity 不再是 null）', () => {
    const s = makeSession({ seatCount: 4 });
    fakeStrategy.pickAction.mockReturnValue({ action: 'call' });
    expect(s.isAiTurn()).toBe(true);
    expect(s.game.phase).toBe('preflop');
    s.aiAction();
    expect(fakeStrategy.computeEquity).toHaveBeenCalled();
    const callArgs = fakeStrategy.pickAction.mock.calls[0][0];
    expect(callArgs.equity).not.toBeNull();
    expect(typeof callArgs.equity).toBe('number');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run __tests__/PveSession.test.js`
Expected: FAIL — `aiAction()` still computes `equity: null` preflop and doesn't pass `liveOpponentCount`/`bigBlind` at all yet.

- [ ] **Step 3: Update `aiAction()` in `server/PveSession.js`**

Find:

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
    // 翻前现在也算真实胜率（board=[]），不再走单独的起手牌分档表——见
    // docs/superpowers/specs/2026-08-02-pve-ev-driven-ai-design.md。
    const equity = this.strategy.computeEquity(ai.holeCards, board, { iterations: 300 });
    const liveOpponentCount = this.game.players.filter(
      p => p.id !== actingId && p.status !== 'folded',
    ).length;
    const { opponentFoldToRaiseRate } = this._opponentReads();

    const decision = this.strategy.pickAction({
      street,
      equity,
      toCall,
      potSize: this.game.pot, // GameEngine adds every bet to .pot as it's placed (verified: it's already the true current pot, not just prior streets), no correction needed
      myChips: ai.chips,
      currentBet: this.game.currentBet,
      minRaiseTo: this.game.currentBet + this.game.lastRaiseAmount,
      opponentCeiling: this.game.maxTotalFor(actingId),
      liveOpponentCount,
      bigBlind: this.bigBlind,
      opponentFoldToRaiseRate,
      style: seat.style,
    });

    const result = decision.action === 'raise'
      ? this._dispatch(actingId, 'raise', decision.raiseTo)
      : this._dispatch(actingId, decision.action);
    return { decision, result };
  }
```

Note: `opponentAggressionRate` and `_facingRaise()`'s result are no longer passed to `pickAction` (the new engine doesn't consume them) — but `_facingRaise()` itself and `_opponentReads()`'s `opponentAggressionRate` field are still used elsewhere (`humanAction()` still records `oppStats` using `_facingRaise`, and `_opponentReads()` still computes both fields even though only `opponentFoldToRaiseRate` is consumed now) — leave `_facingRaise()` and `_opponentReads()` unchanged, just don't pass `opponentAggressionRate`/`facingRaise`/`wasAggressor`/`position`/`holeCards`/`board` into the `pickAction()` call itself.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run __tests__/PveSession.test.js`
Expected: PASS (all tests, including the new describe block and the pre-existing "真实策略引擎跑完整局" smoke test using the real, now-rewritten `pveStrategy`).

- [ ] **Step 5: Run the full server test suite**

Run: `cd server && npm test`
Expected: PASS across all files. If `pve.integration.test.js` fails, check whether it asserts anything about specific AI action probabilities/outcomes tied to the old engine (unlikely — it's a socket-layer integration test, not a strategy test) — if so, fix the assertion to not depend on old-engine-specific behavior; if it's just checking things like "seatCount 4 gets 4 players" or "invalid seatCount falls back to 2", it shouldn't be affected at all.

- [ ] **Step 6: Commit**

```bash
cd "/Users/reyes/测试 OpenStack"
git add server/PveSession.js server/__tests__/PveSession.test.js
git commit -m "feat: feed PveSession's real pot/opponent-count/bigBlind into the EV engine

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Real-device verification, SDD update

**Files:**
- Modify: `openspec/changes/online-texas-holdem/design.md`
- Modify: `openspec/changes/online-texas-holdem/tasks.md`

No code changes — verification + documentation close-out, matching this project's CLAUDE.md rule that "判断一项任务是否做完了...要读代码、跑测试、真实跑一遍浏览器确认".

- [ ] **Step 1: Manual play-through covering the new behaviors specifically**

Start the dev server (`cd server && node index.js &`, `cd client && npm run dev`), open the app, play PVE hands covering:
1. A normal-stack heads-up hand to a few streets — confirm the AI still makes legal decisions, doesn't crash, doesn't get stuck.
2. A hand where you deliberately let your own/the AI's stack get shallow (bet/raise repeatedly to drain chips down near the `SHORT_STACK_BB_THRESHOLD` in the implementation, e.g. under ~15×bigBlind) — confirm the AI's preflop behavior visibly shifts toward all-in-or-fold rather than small raises.
3. A 4-seat or 6-seat PVE table — confirm multiple AI opponents still act in sequence without errors (this exercises `liveOpponentCount` varying as seats fold).

Note any crash, illegal action, or infinite-loop-feeling stall (AI never acting) — these would indicate a bug in the EV math (e.g. a NaN from a division, or an unreachable branch), not just "AI plays worse than hoped." Playing style quality itself is subjective and not something to block on — legality and termination are the bar for this step.

- [ ] **Step 2: Update `design.md`**

Add a new section at the end of `openspec/changes/online-texas-holdem/design.md` (after the current last section, before the closing risk-mitigation bullet list), following the file's established background/dec策/验证 format, summarizing: the AI decision engine changed from probability-table sampling to EV-maximization (link to `docs/superpowers/specs/2026-08-02-pve-ev-driven-ai-design.md` for the full rationale instead of repeating it), note the dropped position/c-bet-continuation heuristics (flagged as an accepted simplification, not an oversight — see this plan's Global Constraints), and record the actual Step 1 verification results (what was played, what was observed, pass/fail).

- [ ] **Step 3: Update `tasks.md`**

Add a new numbered section to `openspec/changes/online-texas-holdem/tasks.md` (next number after the current highest), with `- [x]` lines for Tasks 1-3 above, matching the terse-but-specific voice of the file's existing entries (see the most recent numbered sections for the exact format to match).

- [ ] **Step 4: Commit**

```bash
cd "/Users/reyes/测试 OpenStack"
git add openspec/changes/online-texas-holdem/design.md openspec/changes/online-texas-holdem/tasks.md
git commit -m "docs: record EV-driven PVE AI engine in SDD, verification results

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Report back to the user**

Summarize what changed and what was verified; ask whether to push to `main` (this project's CLAUDE.md rule: never push without explicit instruction).
