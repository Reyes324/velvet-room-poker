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
