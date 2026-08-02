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

// 2026-08-02 全面审查修复：AI 有效后手（maxTotal）小于 currentBet 时——即
// 只能全下一部分、凑不齐对手已经下的注——之前的 evCall/evRaise 公式会算
// 错（evCall 按名义 toCall 而非实际能付的钱算成本/赢的份额；potIfCalled 里
// (raiseCandidate - currentBet) 会变负，把整个 potIfCalled 拉低甚至拉成负
// 数），导致像"10 筹码面对 500 的下注、进 100 的底池，80% 胜率"这种明显该
// 跟/该全下的局面被误判成 fold——纯送筹码，且是"AI 是不是真的在尝试赢"这
// 个引擎存在前提本身被破坏的程度。
// potSize:600/currentBet:500 是"engine-shaped"（可达）的参数组合——
// GameEngine 的 pot 是每次下注立刻累加的（_placeBet 里 this.pot += actual），
// 所以任何真实局面下 potSize >= currentBet 恒成立；toCall:500/myChips:10 对应
// "对手下注 500、自己只剩 10 筹码只能全下一部分"这个 all-in-for-less 场景。
// 上一版这里用的 potSize:100 < currentBet:500 是引擎实际造不出来的组合，
// 复核时被证明这几个测试当时测的是一个不存在的局面，即使公式算错也测不出
// 来——这一版全部换成可达参数，并且手算校验过（见每个 it 内的注释）。
describe('pveStrategy — all-in-for-less（有效后手小于 currentBet）时的 EV 定价（2026-08-02 全面审查修复 + 复核修正）', () => {
  // myBetThisStreet=0, actualCallCost=min(500,10)=10, uncalledExcess=490,
  // evCall = 0.80*(600+10-490) - 10 = 0.80*120-10 = 86 -> +EV，该跟/该全下。
  // 真实盈亏平衡点是 10/(120+10)=7.7% 胜率，80% 远高于此。
  it('复现案例：10 筹码面对 500 的下注、有效底池 120（潜池 600、当前注 500）、80% 胜率，不应该弃牌', () => {
    const a = pickAction({
      street: 'flop', equity: 0.80, toCall: 500, potSize: 600, myChips: 10,
      currentBet: 500, opponentCeiling: 10, bigBlind: 20, random: () => 0.5,
    });
    expect(a.action).not.toBe('fold');
    expect(['call', 'allin']).toContain(a.action);
  });

  // 同样的筹码/底池关系，换成翻前浅筹码 push/fold 分支：effectiveStackBB =
  // maxTotal(10)/bigBlind(20) = 0.5 <= 15，isShortStackPreflop 生效，加注
  // 候选直接是 maxTotal=10，跟上面 flop 案例算出同一个 evRaise=86。
  it('同样是短筹码大幅落后对手下注，但换成翻前浅筹码 push/fold 分支（isShortStackPreflop）时，也不应该弃一手 80% 胜率的牌', () => {
    const a = pickAction({
      street: 'preflop', equity: 0.80, toCall: 500, potSize: 600, myChips: 10,
      currentBet: 500, opponentCeiling: 10, bigBlind: 20, random: () => 0.5,
    });
    expect(a.action).not.toBe('fold');
  });

  // 同样的场景换成 5% 胜率：evCall = 0.05*120-10 = -4，低于 7.7% 盈亏平衡
  // 点，EV 最优确实是 fold；raiseCandidate(=maxTotal=10) < currentBet(500)
  // 触发 all-in-for-less，foldEquity 强制为 0，诈唬层（foldEquity>0 才生效）
  // 必须被拦住，不能把这手烂牌的 fold 翻成 raise（random()=0 是诈唬判定的
  // 必中值，专门用来验证拦截确实生效，不是巧合躲开）。
  it('all-in-for-less 时 foldEquity 必须强制为 0，诈唬层也不能把这种局面的 fold 翻成 raise', () => {
    const a = pickAction({
      street: 'flop', equity: 0.05, toCall: 500, potSize: 600, myChips: 10,
      currentBet: 500, opponentCeiling: 10, bigBlind: 20, random: () => 0,
    });
    expect(a.action).toBe('fold');
  });

  // 复核发现的真正回归点：evCall 若不扣 uncalledExcess，会在"欠下注额远大
  // 于自己全下量"的场景里把接近 0% 胜率的烂牌也算成正 EV。用 potSize 取
  // 可达的最小值（等于 currentBet）让 uncalledExcess 占比最大化：
  // potSize=currentBet=toCall=1500, myChips=10 -> actualCallCost=10,
  // uncalledExcess=1490。正确公式：evCall=0.05*(1500+10-1490)-10=
  // 0.05*20-10=-9（fold，跟真实盈亏平衡点 10/20=50% 相比，5% 明显该弃）；
  // 若不扣 uncalledExcess（这一轮要修的那个回归）：evCall=
  // 0.05*(1500+10)-10=65.5（误判成 call）。手算之外也跑了脚本核对过实际
  // 代码输出，见本文件所在 commit 的实现修复。
  it('多人桌短筹码场景：不扣 uncalledExcess 会把接近 0% 胜率的烂牌错判成 +EV 跟注，正确定价下必须 fold', () => {
    const a = pickAction({
      street: 'flop', equity: 0.05, toCall: 1500, potSize: 1500, myChips: 10,
      currentBet: 1500, opponentCeiling: 10, bigBlind: 20, random: () => 0.99,
    });
    expect(a.action).toBe('fold');
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

  // Finding 3 (2026-08-02 最终整体审查): push/fold 分支之前仍然把 'call'
  // 摆在候选选项里跟 fold/raise 一起比 EV，跟 spec 描述的"只比较 fold 和
  // all-in"矛盾——design.md 之前声称有单测覆盖这一点，但实际上并没有（只
  // 测了"加注候选变成全下"，不是"call 被排除"，这两者是不同的事）。这里
  // 补一个真的能抓住回归的测试：构造一个中性 EV 比较下本该选 call 的局面
  // （用同样的 equity/toCall/potSize 在深筹码下验证一遍，先证明"不排除的
  // 话确实会选 call"），再确认浅筹码（push/fold）下同一个局面绝不会选
  // call，只能是 fold 或 allin。
  it('浅筹码 push/fold 模式下，即使中性 EV 比较本该选 call，也绝不会返回 call——只比较 fold 和 all-in', () => {
    const base = {
      street: 'preflop', equity: 0.44, toCall: 40, potSize: 60, currentBet: 40,
      bigBlind: 20, opponentFoldToRaiseRate: 0.02, minRaiseTo: 900, random: () => 0.5,
    };
    // Same spot, deep stack (effectiveStackBB = 3000/20 = 150, no push/fold
    // special-case): call is genuinely the EV-best action — proves this
    // spot isn't just "always folds regardless".
    const deep = pickAction({ ...base, myChips: 3000 });
    expect(deep.action).toBe('call');

    // Same equity/toCall/potSize, but effectiveStackBB = 150/20 = 7.5,
    // under SHORT_STACK_BB_THRESHOLD -> push/fold mode. Call must never be
    // the returned action here.
    const short = pickAction({ ...base, myChips: 150 });
    expect(short.action).not.toBe('call');
    expect(['fold', 'allin', 'raise']).toContain(short.action);
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
  // street:'river' so realizedEquity is a no-op (STREETS_LEFT.river===0,
  // R=1) — keeps this test's hand-verified numbers exactly as derived from
  // the raw EV formula, not entangled with the separate realization-curve
  // behavior (which is its own dedicated test below).
  // neutral: evCall=-10, evRaise=-25.9, evFold=0 -> fold wins.
  // callingStation: eq inflated to 0.44 -> evCall=+4 (crosses breakeven
  // 150/(200+150)=0.4286), evRaise=-2.05 -> call wins.
  it('callingStation（跟注型）比不传 style 更容易跟注（高估自己的胜率）', () => {
    const base = {
      street: 'river', equity: 0.40, toCall: 150, potSize: 200, myChips: 1000,
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

describe('pveStrategy — 具体牌局的动作断言（Finding 1 最终审查修复后新增，2026-08-02）', () => {
  // design.md「修正：AI 几乎从不弃牌」一节点名的这类测试此前完全缺失——
  // 三轮 review 都只验证"公式实现是否符合 spec"，从没断言过"这手牌最终该
  // 做什么"，这正是 bug 连续三轮都没被抓到的原因。这里补几个最核心的
  // canonical spot：固定底牌/公共牌/底池/toCall，seeded random，断言真实
  // 落地的动作。

  it('72o 面对 3 倍加注（翻前）应该弃牌', () => {
    // 3bb open (bigBlind=20 -> raise to 60), toCall = 60-20(BB已下)=40.
    // iterations 拉到 800（不是随手取的 300 默认值）压统计噪声——用真实
    // Math.random，72o 在窄范围下的胜率稳定在 0.27-0.33 附近，跑几次都没
    // 有落进"折算后 evCall/evRaise 反超 evFold"的区间，但样本太小时偶尔
    // 会抖到边界附近，所以放大样本量而不是收窄断言容错。
    const equity = computeEquity(['7c', '2d'], [], {
      iterations: 800, opponentRangePct: 0.35, // facing a raise -> range-restricted
    });
    const a = pickAction({
      street: 'preflop', equity, toCall: 40, potSize: 60, currentBet: 60, myChips: 1000,
      bigBlind: 20, facingRaise: true, random: () => 0.99,
    });
    expect(a.action).toBe('fold');
  });

  it('AA 面对加注不应该弃牌（仍然保持激进）', () => {
    const equity = computeEquity(['As', 'Ac'], [], {
      iterations: 400, opponentRangePct: 0.35,
    });
    const a = pickAction({
      street: 'preflop', equity, toCall: 40, potSize: 60, currentBet: 60, myChips: 1000,
      bigBlind: 20, facingRaise: true, random: () => 0.99,
    });
    expect(a.action).not.toBe('fold');
  });

  it('明显很差的翻后局面（胜率很低，面对底池大小的下注）应该弃牌', () => {
    const a = pickAction({
      street: 'river', equity: 0.08, toCall: 200, potSize: 200, currentBet: 200,
      myChips: 1000, bigBlind: 20, opponentFoldToRaiseRate: 0.3, facingRaise: true,
      random: () => 0.99,
    });
    expect(a.action).toBe('fold');
  });
});

describe('pveStrategy — computeEquity 的 opponentRangePct 行为（Finding 1 微测试）', () => {
  // 用真实 Math.random（不是 seeded fakeRandom）——拒绝采样会消耗不定数量
  // 的 random() 调用，用同一个 seeded 序列跑两次（一次不限制、一次限制）
  // 会让后续抽样错位、产生虚假的相关性，反而算不出真实差异。样本量拉大
  // （4000 次）压统计噪声，阈值留够余量。
  it('72o 的胜率在收窄对手范围（opponentRangePct=0.15）后应明显低于不限制范围；AA 则几乎不受影响', () => {
    const seven2Full = computeEquity(['7c', '2d'], [], { iterations: 4000 });
    const seven2Narrow = computeEquity(['7c', '2d'], [], { iterations: 4000, opponentRangePct: 0.15 });
    expect(seven2Full - seven2Narrow).toBeGreaterThanOrEqual(0.03);

    const aaFull = computeEquity(['As', 'Ac'], [], { iterations: 4000 });
    const aaNarrow = computeEquity(['As', 'Ac'], [], { iterations: 4000, opponentRangePct: 0.15 });
    expect(Math.abs(aaFull - aaNarrow)).toBeLessThanOrEqual(0.05);
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
