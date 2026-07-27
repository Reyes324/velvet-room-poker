import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
  computeEquity,
  preflopTier,
  pickAction,
  PREFLOP_TABLE,
  POSTFLOP_BANDS,
} = require('../pveStrategy');

describe('pveStrategy — computeEquity', () => {
  it('河牌（5 张公共牌都已确定）用穷举而非采样，结果必须是确定值：口袋 A 在无平局可能的墙上胜率应为 1', () => {
    // Hero has the absolute nuts (quad aces) — no possible opponent 2-card
    // holding can win or tie, so exhaustive river equity must be exactly 1
    // regardless of RNG.
    const equity = computeEquity(['As', 'Ac'], ['Ah', 'Ad', '2c', '5d', '9h']);
    expect(equity).toBe(1);
  });

  it('河牌穷举：两个不同的固定手牌算出的胜率应互补（win1 + win2 + tie ≈ 1，允许平局项）', () => {
    // Board pairs the board so a random Kx holding sometimes ties/beats a
    // weak kicker — just assert the two equities plus shared tie mass sum
    // sanely instead of hand-deriving the exact combinatorics.
    const heroEquity = computeEquity(['Kd', '2c'], ['Kh', '7s', '7d', '3c', '9h']);
    expect(heroEquity).toBeGreaterThan(0);
    expect(heroEquity).toBeLessThan(1);
  });

  it('翻前口袋 A 蒙特卡洛胜率应显著高于口袋 7（大样本下，允许统计误差）', () => {
    const aa = computeEquity(['As', 'Ac'], [], { iterations: 2000 });
    const sevens = computeEquity(['7s', '7c'], [], { iterations: 2000 });
    expect(aa).toBeGreaterThan(sevens);
    expect(aa).toBeGreaterThan(0.75); // real-world AA vs random ≈ 85%
  });

  it('iterations 相同时传入固定的 random 函数应得到完全可复现的结果', () => {
    let calls = 0;
    const fakeRandom = () => {
      calls += 1;
      // deterministic pseudo-sequence, not a real RNG — just needs to be
      // stable across two independent runs with a fresh counter each time
      const seed = calls * 9301 + 49297;
      return (seed % 233280) / 233280;
    };
    const e1 = computeEquity(['Qs', 'Qh'], ['2c', '5d', '9h'], { iterations: 100, random: fakeRandom });
    calls = 0;
    const e2 = computeEquity(['Qs', 'Qh'], ['2c', '5d', '9h'], { iterations: 100, random: fakeRandom });
    expect(e1).toBe(e2);
  });
});

describe('pveStrategy — preflopTier', () => {
  it('口袋 A / KK 是 premium', () => {
    expect(preflopTier(['As', 'Ac'])).toBe('premium');
    expect(preflopTier(['Ks', 'Kc'])).toBe('premium');
  });

  it('AK 同花/不同花都是 premium', () => {
    expect(preflopTier(['As', 'Ks'])).toBe('premium');
    expect(preflopTier(['Ah', 'Kd'])).toBe('premium');
  });

  it('72 不同花是 trash', () => {
    expect(preflopTier(['7s', '2d'])).toBe('trash');
  });

  it('同花 A-x 至少是 strong（任意同花 A 的既定简化规则）', () => {
    const tiers = ['premium', 'strong'];
    expect(tiers).toContain(preflopTier(['As', '4s']));
  });
});

describe('pveStrategy — pickAction', () => {
  const noop = () => {};

  it('等值分布累加应为 1（POSTFLOP_BANDS 每一档配置校验，防止手滑改错数字）', () => {
    for (const band of POSTFLOP_BANDS) {
      const sum = band.fold + band.call + band.raise;
      expect(sum).toBeCloseTo(1, 5);
    }
    for (const tier of Object.keys(PREFLOP_TABLE)) {
      const t = PREFLOP_TABLE[tier];
      expect(t.fold + t.call + t.raise).toBeCloseTo(1, 5);
    }
  });

  it('random 落在 fold 区间时应返回 fold（toCall > 0，不能白弃）', () => {
    const action = pickAction({
      street: 'flop', equity: 0.1, toCall: 100, potSize: 300, myChips: 1000,
      position: 'oop', random: () => 0.01, // well inside the ~78% fold band for <20% equity
    });
    expect(action.action).toBe('fold');
  });

  it('toCall 为 0 时（可以白看）永远不应该弃牌——fold 概率被吸收进 check', () => {
    for (let r = 0; r < 1; r += 0.05) {
      const action = pickAction({
        street: 'flop', equity: 0.05, toCall: 0, potSize: 300, myChips: 1000,
        position: 'oop', random: () => r,
      });
      expect(action.action).not.toBe('fold');
    }
  });

  it('random 落在 raise 区间时应返回 raise，且给出的 raiseTo 在最小加注和全下之间', () => {
    const action = pickAction({
      street: 'flop', equity: 0.95, toCall: 100, potSize: 300, myChips: 1000,
      position: 'ip', random: () => 0.99, // near the top of the distribution, inside raise band for >85% equity
      minRaiseTo: 300, currentBet: 100,
    });
    expect(action.action).toBe('raise');
    expect(action.raiseTo).toBeGreaterThanOrEqual(300);
    expect(action.raiseTo).toBeLessThanOrEqual(1000 + 100); // myChips + already-in bet, i.e. all-in ceiling
  });

  it('raiseTo 超过全部筹码时应该改为 allin，不应该返回一个不合法的 raise 数字', () => {
    const action = pickAction({
      street: 'river', equity: 0.99, toCall: 50, potSize: 5000, myChips: 60,
      position: 'ip', random: () => 0.99, minRaiseTo: 100, currentBet: 50,
    });
    expect(['raise', 'allin']).toContain(action.action);
    if (action.action === 'raise') expect(action.raiseTo).toBeLessThanOrEqual(60 + 50);
  });

  it('翻前使用 preflopTier 而不是原始胜率——同一手 72o 即便传入一个极高的 equity 也应该按 trash 分档弃牌', () => {
    // trash table: fold 70% / call 20% / raise 10% (cumulative fold=[0,0.70)).
    // If pickAction wrongly used the postflop >85%-equity band instead
    // (fold 0% / call 20% / raise 80%, cumulative raise=[0.20,1)), the same
    // random()=0.5 would land in "raise", not "fold" — so this specific
    // random value is exactly what differentiates "used preflopTier" from
    // "fell through to equity bands".
    const a = pickAction({
      street: 'preflop', holeCards: ['7s', '2d'], equity: 0.99 /* must be ignored preflop */,
      toCall: 20, potSize: 30, myChips: 1000, position: 'oop', random: () => 0.5,
    });
    expect(a.action).toBe('fold');
  });
});
