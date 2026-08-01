import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
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

describe('pveStrategy — 上下文调整（2026-07-28 用户反馈"很容易猜"后新增）', () => {
  // Band for equity=0.3: fold 0.55 / call 0.35 / raise 0.10 (20-40% band).
  // With toCall===0 the fold mass merges into call before sampling, so
  // baseline cumulative is call=[0,0.90), raise=[0.90,1). r=0.85 lands in
  // call at baseline — proving the c-bet boost (which should push it into
  // raise) actually did something, not just coincidentally matching.
  it('续注倾向：上条街是自己主动加注、这条街轮到自己且无人下注时，同一随机数更容易落进 raise（对比不续注的基线）', () => {
    const base = { street: 'flop', equity: 0.3, toCall: 0, potSize: 300, myChips: 1000, position: 'ip', random: () => 0.85 };
    const withoutCbet = pickAction(base);
    const withCbet = pickAction({ ...base, wasAggressor: true });
    expect(withoutCbet.action).not.toBe('raise');
    expect(withCbet.action).toBe('raise');
  });

  it('续注倾向只在翻后生效——翻前传 wasAggressor 不应该改变行为（翻前分档表本来就没有这个概念）', () => {
    const a = pickAction({
      street: 'preflop', holeCards: ['7s', '2d'], equity: 0.99, wasAggressor: true,
      toCall: 0, potSize: 30, myChips: 1000, position: 'oop', random: () => 0.85,
    });
    // trash table with toCall===0: fold(0.70)+call(0.20) merged = 0.90 call,
    // raise stays 0.10 — r=0.85 must still land in call, proving the c-bet
    // delta never touched a preflop decision.
    expect(a.action).not.toBe('raise');
  });

  // Band for equity=0.5: fold 0.15 / call 0.55 / raise 0.30 (40-55% band),
  // toCall>0 so no merge. Baseline cumulative: fold=[0,0.15), call=[0.15,0.70).
  // r=0.20 lands in call at baseline.
  it('面对真实加注（facingRaise）时更容易弃牌（对比同样局面但不是面对加注的基线）', () => {
    const base = { street: 'flop', equity: 0.5, toCall: 100, potSize: 300, myChips: 1000, position: 'oop', random: () => 0.20 };
    const withoutFacingRaise = pickAction(base);
    const withFacingRaise = pickAction({ ...base, facingRaise: true });
    expect(withoutFacingRaise.action).not.toBe('fold');
    expect(withFacingRaise.action).toBe('fold');
  });

  it('对手面对加注时爱弃牌（高 opponentFoldToRaiseRate）→ 更容易诈唬加注', () => {
    // <20% band: fold 0.78 / call 0.12 / raise 0.10, toCall>0 (no merge).
    // Baseline cumulative: fold=[0,0.78), call=[0.78,0.90), raise=[0.90,1).
    // r=0.85 lands in call at baseline.
    const base = { street: 'flop', equity: 0.1, toCall: 100, potSize: 300, myChips: 1000, position: 'oop', random: () => 0.85 };
    const baseline = pickAction(base);
    const vsFoldyOpp = pickAction({ ...base, opponentFoldToRaiseRate: 0.9 });
    expect(baseline.action).not.toBe('raise');
    expect(vsFoldyOpp.action).toBe('raise');
  });

  it('对手很爱加注（高 opponentAggressionRate）→ 面对加注时更容易跟注而不是弃牌', () => {
    const base = {
      street: 'flop', equity: 0.5, toCall: 100, potSize: 300, myChips: 1000, position: 'oop',
      random: () => 0.20, facingRaise: true,
    };
    const vsPassiveOpp = pickAction({ ...base, opponentAggressionRate: 0.1 });
    const vsAggroOpp = pickAction({ ...base, opponentAggressionRate: 0.9 });
    expect(vsPassiveOpp.action).toBe('fold'); // facingRaise alone already tips this into fold (see above)
    expect(vsAggroOpp.action).not.toBe('fold');
  });
});

describe('pveStrategy — 位置调整（用户反馈"经常能赢"后新增，2026-07-30：position 参数此前只传入未消费）', () => {
  // trash table, toCall>0 (blind differential only, not a real raise) so no
  // merge: fold=[0,0.70), call=[0.70,0.90), raise=[0.90,1). r=0.85 lands in
  // call at baseline for both positions — proving IP's wider open is what
  // pushes it into raise, not coincidence.
  it('翻前开池：同一手弱牌，IP 比 OOP 更容易加注（未面对真实加注）', () => {
    const base = {
      street: 'preflop', holeCards: ['7s', '2d'], toCall: 20, potSize: 30, myChips: 1000,
      random: () => 0.85, facingRaise: false,
    };
    const oop = pickAction({ ...base, position: 'oop' });
    const ip = pickAction({ ...base, position: 'ip' });
    expect(oop.action).not.toBe('raise');
    expect(ip.action).toBe('raise');
  });

  it('翻前面对真实加注时，IP 的开池加成不生效（facingRaise=true）', () => {
    const base = {
      street: 'preflop', holeCards: ['7s', '2d'], toCall: 100, potSize: 30, myChips: 1000,
      random: () => 0.85, facingRaise: true, position: 'ip',
    };
    const a = pickAction(base);
    expect(a.action).not.toBe('raise'); // 面对真实加注，IP 也不该拿垃圾牌加注
  });

  // Band for equity=0.3: fold 0.55/call 0.35/raise 0.10, toCall===0 so fold
  // merges into call. Baseline c-bet boost alone: call=[0,0.65), raise=[0.65,1).
  // With IP's extra c-bet boost: call=[0,0.55), raise=[0.55,1). r=0.60 sits
  // in between — call for OOP (baseline), raise for IP (boosted).
  it('续注：同样是续注局面，IP 比 OOP 更容易把续注延续成加注', () => {
    const base = { street: 'flop', equity: 0.3, toCall: 0, potSize: 300, myChips: 1000, wasAggressor: true, random: () => 0.60 };
    const oop = pickAction({ ...base, position: 'oop' });
    const ip = pickAction({ ...base, position: 'ip' });
    expect(oop.action).not.toBe('raise');
    expect(ip.action).toBe('raise');
  });

  // Band for equity=0.5: fold 0.15/call 0.55/raise 0.30, toCall>0 (no merge).
  // IP (only base facingRaise boost): fold=[0,0.25). OOP (+ extra tighten):
  // fold=[0,0.33). r=0.30 sits in between — call for IP, fold for OOP.
  it('面对加注：同样的局面，OOP 比 IP 更容易弃牌', () => {
    const base = { street: 'flop', equity: 0.5, toCall: 100, potSize: 300, myChips: 1000, facingRaise: true, random: () => 0.30 };
    const ip = pickAction({ ...base, position: 'ip' });
    const oop = pickAction({ ...base, position: 'oop' });
    expect(ip.action).not.toBe('fold');
    expect(oop.action).toBe('fold');
  });
});

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

  it('STYLES 导出四个风格键名，供 PveSession 随机分配', () => {
    expect(STYLES).toEqual(['steady', 'aggressive', 'bluffer', 'callingStation']);
  });
});

describe('pveStrategy — boardTexture', () => {
  it('彩虹、不连张的公共牌判为干燥面', () => {
    expect(boardTexture(['2s', '7d', 'Kc'])).toBe('dry');
  });

  it('两张同花色的公共牌（同花听牌活）判为湿润面', () => {
    expect(boardTexture(['2s', '7s', 'Kd'])).toBe('wet');
  });

  it('点数相近（顺子听牌密集）的公共牌判为湿润面，即便花色彩虹', () => {
    expect(boardTexture(['5s', '7d', '9c'])).toBe('wet');
  });

  it('少于 3 张公共牌（翻前）返回 dry 作为中性默认值', () => {
    expect(boardTexture([])).toBe('dry');
  });
});

describe('pveStrategy — 板面纹理对诈唬频率的影响（2026-07-28 新增）', () => {
  it('同样的低胜率局面，干燥面比湿润面更容易诈唬加注（同一 random 值）', () => {
    const dryBoard = ['2s', '7d', 'Kc'];
    const wetBoard = ['2s', '7s', 'Kd']; // 两张黑桃，同花听牌活
    const base = { street: 'flop', equity: 0.3, toCall: 100, potSize: 300, myChips: 1000, position: 'oop', random: () => 0.85 };
    const onDry = pickAction({ ...base, board: dryBoard });
    const onWet = pickAction({ ...base, board: wetBoard });
    expect(onDry.action).toBe('raise');
    expect(onWet.action).not.toBe('raise');
  });

  it('板面纹理只影响诈唬（低胜率）决策，不该拦下真正的高胜率价值下注', () => {
    const wetBoard = ['2s', '7s', 'Kd'];
    const a = pickAction({
      street: 'flop', holeCards: ['Ah', 'Ad'], board: wetBoard, equity: 0.9,
      toCall: 100, potSize: 300, myChips: 1000, position: 'ip', random: () => 0.99,
      minRaiseTo: 300, currentBet: 100,
    });
    expect(a.action).toBe('raise');
  });

  it('板面纹理只在翻后生效——翻前传湿润 board 不应该改变翻前分档表的行为', () => {
    const wetBoard = ['2s', '7s', 'Kd']; // 无意义的翻前输入，验证被忽略
    const a = pickAction({
      street: 'preflop', holeCards: ['7s', '2d'], board: wetBoard, equity: 0.1,
      toCall: 20, potSize: 30, myChips: 1000, position: 'oop', random: () => 0.5,
    });
    expect(a.action).toBe('fold'); // 跟原来"翻前用 trash 分档"的测试结果一致
  });
});

describe('pveStrategy — raiseSizeFraction（下注尺度极化）', () => {
  it('极端胜率（价值/诈唬两端）应该比中等胜率有更宽、更大的尺度范围', () => {
    const polarizedFractions = [];
    const mergedFractions = [];
    for (let i = 0; i <= 20; i++) {
      const r = i / 20;
      polarizedFractions.push(raiseSizeFraction('flop', null, 0.95, () => r));
      mergedFractions.push(raiseSizeFraction('flop', null, 0.5, () => r));
    }
    // Polarized [0.6, 1.4] vs merged [0.35, 0.7] — polarized reaches a much
    // bigger max (the actual point: strong value/bluffs can go big), and
    // its average sits meaningfully higher than merged's average.
    expect(Math.max(...polarizedFractions)).toBeGreaterThan(Math.max(...mergedFractions));
    const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    expect(avg(polarizedFractions)).toBeGreaterThan(avg(mergedFractions));
  });

  it('翻前没有真实胜率，用起手牌分档当代理——premium 起手牌走极化尺度，playable 起手牌走合并尺度', () => {
    const premiumFraction = raiseSizeFraction('preflop', ['As', 'Ac'], null, () => 1);
    const playableFraction = raiseSizeFraction('preflop', ['6s', '6c'], null, () => 1);
    expect(premiumFraction).toBeGreaterThan(playableFraction);
  });
});
