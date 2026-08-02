import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
  computeEquity,
  pickAction,
  raiseSizeFraction,
  STYLES,
  POT_CONTROL_MURKY_LOW,
  POT_CONTROL_MURKY_HIGH,
  POT_CONTROL_DISCOUNT,
  SIZE_PRESSURE_CAP,
  sizePressure,
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
  // 真实盈亏平衡点是 10/120=8.33% 胜率（120 已经含自己这 10 筹码），80% 远高于此。
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

  // 3 人桌 all-in-for-less：两个还没弃牌的对手都下到 1500，潜池 3000，自己
  // 只剩 10 筹码。真实能赢的底池 = potSize + actualCallCost - uncalledExcess
  // × liveOpponentCount = 3000+10-1490×2 = 30，真实盈亏平衡点 10/30=33.3%。
  // 若只按一个对手退款算（这轮要修的多人桌回归）：能赢的底池会算成
  // 3000+10-1490=1520，盈亏平衡点只有 10/1520≈0.66%，2%/30%胜率都会被误判
  // 成 +EV 全下。
  it('多人桌（3 人）all-in-for-less：退款要按还没弃牌的对手数各退一份，不能只退一次', () => {
    const base = {
      street: 'flop', toCall: 1500, potSize: 3000, myChips: 10,
      currentBet: 1500, opponentCeiling: 10, liveOpponentCount: 2, bigBlind: 20,
    };
    const veryLow = pickAction({ ...base, equity: 0.02, random: () => 0.99 });
    const belowBreakeven = pickAction({ ...base, equity: 0.30, random: () => 0.5 });
    const aboveBreakeven = pickAction({ ...base, equity: 0.35, random: () => 0.5 });
    expect(veryLow.action).toBe('fold');
    expect(belowBreakeven.action).toBe('fold');
    expect(aboveBreakeven.action).not.toBe('fold');
  });

  // 正常加注（raiseCandidate 能超过 currentBet，不是 all-in-for-less）时，
  // potIfCalled 不该跟着 liveOpponentCount 放大——这个口径这次不在 all-in-
  // for-less 专项修复范围内，确认没被连带改动：跟"弃牌权益随对手数量指数
  // 下降"那组测试用一样的参数，只是换一个不那么极端的对手数，加注 EV 不
  // 应该因为 potIfCalled 被放大而意外翻正。
  //
  // 2026-08-03 组件 A（尺寸感知弃牌权益）实现后手算校正：这个场景里
  // raiseCandidate=518（cost=518），currentBet=100 -> opponentDelta=418,
  // potAfterRaise=818 -> sizePressure=2*418/818≈1.022（比"满池注"基线 1.0
  // 略高一点，因为这实际上是一次略超池的再加注，理论上确实该比基线更有
  // 压迫力，不是 bug）。单对手 p=0.9*1.022≈0.920（比改动前的 0.9 略高）。
  // liveOpponentCount=5 时 p^5≈0.658（比改动前的 0.9^5=0.590 高），
  // evRaise≈+37.4，仍是正 EV，5 人时的翻转点因此往后移了一格——把对手数
  // 从 5 改成 6：p^6≈0.606，evRaise≈-3.17，翻负，重新演示"对手越多，加注
  // 从 +EV 变成 -EV"这个论点，跟实际输出（raise / fold）一致。
  it('正常加注场景（非 all-in-for-less）的 potIfCalled 不受 liveOpponentCount 影响', () => {
    const base = {
      street: 'flop', equity: 0.05, toCall: 100, potSize: 300, myChips: 1000,
      currentBet: 100, opponentFoldToRaiseRate: 0.9, bigBlind: 20, random: () => 0.99,
    };
    const oneOpp = pickAction({ ...base, liveOpponentCount: 1 });
    const sixOpp = pickAction({ ...base, liveOpponentCount: 6 });
    expect(oneOpp.action).toBe('raise');
    expect(sixOpp.action).toBe('fold');
  });
});

describe('pveStrategy — 弃牌权益（多人聚合 p^n）', () => {
  // Hand-verified against the exact Step 3/5 formula (see plan's verification
  // script — do not loosen these numbers without re-deriving by hand):
  // equity=0.05, toCall=100, potSize=300, currentBet=100 -> myBetThisStreet=0,
  // raiseCandidate=518 (sizeFraction at random()=0.99, polarized branch),
  // cost=518, opponentDelta=418, potAfterRaise=818, potIfCalled=1236.
  // sizePressure(418,818) = 2*418/818 ≈ 1.022 (a mild overpot re-raise, so
  // slightly above the pot-sized baseline of 1.0 — larger than a pot bet
  // should exert a bit more pressure, that's the fix working as intended).
  // opponentFoldToRaiseRate=0.9, per-opponent p = 0.9*1.022 ≈ 0.9198:
  //   liveOpponentCount=1 -> foldEquity=0.9198^1≈0.920 -> evRaise≈+238.4 (raise wins)
  //   liveOpponentCount=6 -> foldEquity=0.9198^6≈0.606 -> evRaise≈-3.2 (fold wins, evFold=0 > evRaise > evCall)
  // 2026-08-03 组件 A 实现后手算校正：改动前 sizePressure 恒为 1，p 恒为
  // 0.9，5 个对手时 p^5≈0.590 才刚好翻负；组件 A 让这次再加注的 sizePressure
  // 略高于 1（≈1.022，因为它其实略超池），单对手/多对手的 p 都跟着上移了
  // 一点，5 个对手时 p^5≈0.658 还是正 EV，要 6 个对手（p^6≈0.606）才翻负——
  // 把断言里的对手数从 5 改成 6，其余不变，重新对齐实际输出。
  it('弃牌权益随对手数量指数下降：同一个纯诈唬局面，对手越多弃牌权益越低，加注从 +EV 变成 -EV', () => {
    const base = {
      street: 'flop', equity: 0.05, toCall: 100, potSize: 300, myChips: 1000,
      currentBet: 100, bigBlind: 20, opponentFoldToRaiseRate: 0.9, random: () => 0.99,
    };
    const oneOpp = pickAction({ ...base, liveOpponentCount: 1 });
    const sixOpp = pickAction({ ...base, liveOpponentCount: 6 });
    expect(oneOpp.action).toBe('raise');
    expect(sixOpp.action).toBe('fold');
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
  // cost=428, opponentDelta=278, potAfterRaise=628, potIfCalled=906.
  //
  // 2026-08-03 组件 A（尺寸感知弃牌权益）实现后手算校正：这次加注相对
  // "满池注基线"其实偏小（428 只比 currentBet 150 高不到两个 potSize），
  // sizePressure(278,628)=2*278/628≈0.885，小于 1，意味着这一注的压迫力比
  // 改动前假设的"任何加注都等同满池注"要弱——foldEquity 因此比改动前的
  // 原始值打了个折扣。opponentFoldToRaiseRate 原来定的 0.61 在这个折扣下，
  // neutral 和 bluffer 都不够跨过盈亏平衡点（neutral foldEquity=
  // 0.61*0.885≈0.540 -> evRaise≈-54.9；bluffer foldEquity=
  // min(1,0.61*1.05)*0.885≈0.567 -> evRaise≈-40.0，两者都还是负，全部
  // fold，没法演示"bluffer 比 neutral 更敢诈唬"这个论点）。把
  // opponentFoldToRaiseRate 从 0.61 调到 0.70（同一个观测对手弃牌率维度，
  // 没有换场景/换公式）：neutral foldEquity=0.70*0.885≈0.6195 ->
  // evRaise≈-10.8（仍然 fold，evFold=0 更高）；bluffer foldEquity=
  // min(1,0.70*1.05)*0.885≈0.6505 -> evRaise≈+6.3（跨过 0，raise 反超）。
  // 实测 pickAction 输出（neutral=fold, bluffer=raise/428）跟这个手算一致。
  //
  // foldEquityMultiplier 从 1.2 调到 1.05（用户反馈 2026-08-02 "太容易赢
  // 了" 之后跑的真实多手模拟验证：1.2 时 bluffer 在 6 组独立 200 手试验里
  // 全部、稳定巨额亏损（汇总 -122,856），远超其他风格的正常高方差输赢；
  // 因为这个乘数直接放大的是已经是真实观测值的 opponentFoldToRaiseRate，
  // 不只是没数据时的默认先验，系统性高估对手弃牌概率，导致频繁在不该加
  // 注的地方诈唬送筹码。调到 1.05 之后同样跑 6x200 手，bluffer 有输有赢，
  // 汇总量级也回到跟其他风格同一个数量级，不再是唯一的稳定送分风格）。
  it('bluffer（诈唬型）比不传 style 更容易诈唬加注（高估自己的弃牌权益，但幅度克制，不是系统性送筹码）', () => {
    const base = {
      street: 'flop', equity: 0.10, toCall: 150, potSize: 200, myChips: 1000,
      currentBet: 150, bigBlind: 20, opponentFoldToRaiseRate: 0.70, random: () => 0.99,
    };
    const neutral = pickAction(base);
    const bluffer = pickAction({ ...base, style: 'bluffer' });
    expect(neutral.action).toBe('fold');
    expect(bluffer.action).toBe('raise');
  });

  // equity=0.31（落在池控制模糊区间 (0.30,0.70) 内，见下面的池控制测试
  // 组），toCall=100, potSize=300, currentBet=100, minRaiseTo=150 ->
  // raiseCandidate=205（被 minRaiseTo 封住的小尺度加注），cost=205,
  // opponentDelta=105, potAfterRaise=505, potIfCalled=610。
  //
  // 2026-08-03 组件 A 实现后手算校正：raiseCandidate=205 相对满池注基线是
  // 一次很小的加注（远不到 1 个 potSize），sizePressure(105,505)=
  // 2*105/505≈0.416，明显小于 1——这次改动本身就是为了让"最小加注"不再
  // 被当成跟满池注一样有压迫力，这里正是那个效果的体现。opponentFoldToRaiseRate
  // 原来定的 0.16 在这个折算下 foldEquity 太低，neutral/aggressive 都只有
  // evCall(≈10.81) > evRaise，两边都选 call，没法演示"aggressive 更敢
  // 加注"。把 opponentFoldToRaiseRate 从 0.16 调到 0.38（同一个观测对手
  // 弃牌率维度，不换场景/公式）：neutral foldEquity=0.38*0.416≈0.158 ->
  // evRaise（含 0.6 倍池控制折扣，因为 equity 0.31 落在模糊区间且折扣前
  // 为正）≈10.25 < evCall≈10.81，neutral 选 call；aggressive 对这个已经
  // 打过池控折扣的 evRaise 再乘 1.15 -> ≈11.79 > evCall(10.81)，raise 反
  // 超。实测 pickAction 输出（neutral=call, aggressive=raise/205）跟这个
  // 手算一致。
  it('aggressive（激进型）比不传 style 更容易加注（EV 相近时偏好高方差选项）', () => {
    const base = {
      street: 'flop', equity: 0.31, toCall: 100, potSize: 300, myChips: 1000,
      currentBet: 100, minRaiseTo: 150, bigBlind: 20, opponentFoldToRaiseRate: 0.38,
      random: () => 0,
    };
    const neutral = pickAction(base);
    const aggressive = pickAction({ ...base, style: 'aggressive' });
    expect(neutral.action).toBe('call');
    expect(aggressive.action).toBe('raise');
  });

  // Same shape/equity as the aggressive case above (raiseCandidate=205,
  // sizePressure(105,505)≈0.416, evCall≈10.81，跟 aggressive 用例完全一样
  // 不受 opponentFoldToRaiseRate 影响）。
  //
  // 2026-08-03 组件 A 实现后手算校正：同样因为 sizePressure≈0.416 拉低了
  // foldEquity，原来的 opponentFoldToRaiseRate=0.17 不够让 neutral 本身先
  // 选 raise（无法演示"steady 把已经选中的 raise 打回 call"）。把
  // opponentFoldToRaiseRate 调到 0.40：neutral foldEquity=0.40*0.416≈
  // 0.166 -> evRaise（含 0.6 倍池控制折扣）≈11.93 > evCall≈10.81，neutral
  // 选 raise；steady 再对这个折扣后的 evRaise 乘 0.85 -> ≈10.14 <
  // 10.81，call 反超。实测 pickAction 输出（neutral=raise/205,
  // steady=call）跟这个手算一致。
  it('steady（稳健型）比不传 style 更少加注（给高方差选项的 EV 打折）', () => {
    const base = {
      street: 'flop', equity: 0.31, toCall: 100, potSize: 300, myChips: 1000,
      currentBet: 100, minRaiseTo: 150, bigBlind: 20, opponentFoldToRaiseRate: 0.40,
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

describe('pveStrategy — 池控制风险折扣（用户反馈 2026-08-02："有的电脑诈唬过度，不是nuts但是持续下注好像不会控池"）', () => {
  // 根因：翻牌圈没人下注、轮到 AI 决定要不要主动下注时，只要还剩 1-2 个
  // 对手，胜率哪怕只有 45%（场均输面的烂牌）也会被 raise——聚合弃牌权益
  // 模型算出来的 evRaise 只要数学上略微为正就赢，没有任何"这个弃牌权益估
  // 计有多可靠"的余量。修复：evRaise 为正、且胜率落在 (0.30,0.70) 这个
  // "不算坚果也不算明显该弃"的模糊区间时，打 POT_CONTROL_DISCOUNT 折扣。
  it('常量本身：模糊区间是 (0.30, 0.70)，折扣是 0.6', () => {
    expect(POT_CONTROL_MURKY_LOW).toBe(0.30);
    expect(POT_CONTROL_MURKY_HIGH).toBe(0.70);
    expect(POT_CONTROL_DISCOUNT).toBe(0.6);
  });

  it('模糊区间内（45% 胜率，2 个对手在场）：白看时选择过牌，而不是不管三七二十一下注', () => {
    const decision = pickAction({
      street: 'flop', equity: 0.45, toCall: 0, currentBet: 0, potSize: 200, myChips: 1000,
      minRaiseTo: 20, opponentCeiling: 1000, liveOpponentCount: 2, bigBlind: 20,
      opponentFoldToRaiseRate: 0.35, style: null, facingRaise: false, random: () => 0.5,
    });
    expect(decision.action).toBe('check');
  });

  it('清晰强牌区间（85% 胜率）不受影响：照样主动下注，折扣只压缩模糊区间', () => {
    const decision = pickAction({
      street: 'flop', equity: 0.85, toCall: 0, currentBet: 0, potSize: 200, myChips: 1000,
      minRaiseTo: 20, opponentCeiling: 1000, liveOpponentCount: 2, bigBlind: 20,
      opponentFoldToRaiseRate: 0.35, style: null, facingRaise: false, random: () => 0.5,
    });
    expect(decision.action).toBe('raise');
  });

  it('清晰的纯诈唬区间（20% 胜率，对手很爱弃牌）不受影响：折扣不会误伤合理的诈唬', () => {
    const decision = pickAction({
      street: 'flop', equity: 0.20, toCall: 0, currentBet: 0, potSize: 200, myChips: 1000,
      minRaiseTo: 20, opponentCeiling: 1000, liveOpponentCount: 1, bigBlind: 20,
      opponentFoldToRaiseRate: 0.75, style: null, facingRaise: false, random: () => 0.5,
    });
    expect(decision.action).toBe('raise');
  });

  it('已经是负 EV 的加注不会被折扣"救活"——折扣只作用于正 EV，不改变方向', () => {
    // 模糊区间内、但弃牌权益低到 evRaise 本来就是负数的场景：折扣（乘
    // 0.6）如果被错误地也应用在负数上，会让它更接近 0、可能反而变成正数
    // 选中 raise——这里断言它仍然选 evCall/evFold 那一边，没有被误伤。
    const decision = pickAction({
      street: 'flop', equity: 0.35, toCall: 0, currentBet: 0, potSize: 200, myChips: 1000,
      minRaiseTo: 20, opponentCeiling: 1000, liveOpponentCount: 4, bigBlind: 20,
      opponentFoldToRaiseRate: 0.05, style: null, facingRaise: false, random: () => 0.5,
    });
    expect(decision.action).not.toBe('raise');
  });

  // 二次修复回归测试（当天用 pveBalanceCheck.js 实测跑出新失衡才发现）：
  // 折扣最初拿风格调整过的 eq（styledEquity）判断是否落在模糊区间，
  // callingStation 的 equityMultiplier=1.1 会把真实 65% 胜率的模糊牌拉到
  // 71.5%、跨过 0.70 上限，直接绕开这层折扣——越容易高估自己牌力的风格，
  // 越不需要池控制，跟池控制本来要防的东西正好相反。改用真实客观胜率
  // equity 做判断之后，callingStation 在这手真实仍然模糊的牌上也应该跟
  // 别的风格一样被打折、选择过牌。
  it('模糊区间判断用真实客观胜率，不用风格夸大过的主观胜率——callingStation 不能靠"高估自己"绕开池控制折扣', () => {
    const base = {
      street: 'flop', equity: 0.65, toCall: 0, currentBet: 0, potSize: 200, myChips: 1000,
      minRaiseTo: 20, opponentCeiling: 1000, liveOpponentCount: 1, bigBlind: 20,
      opponentFoldToRaiseRate: 0.5, facingRaise: false, random: () => 0.5,
    };
    const neutral = pickAction({ ...base, style: null });
    const callingStation = pickAction({ ...base, style: 'callingStation' });
    expect(neutral.action).toBe('check');
    expect(callingStation.action).toBe('check');
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

describe('pveStrategy — 感知噪声（用户需求，2026-08-02："加一点随机色彩、加点情绪，让这个比较像人类"）', () => {
  it('不传 noiseFraction（默认 0）时行为跟改动前完全一致：同一个近似打平的局面，多个不同 random 序列都应该得到同一个结果', () => {
    // equity=0.4/toCall=100/potSize=300/currentBet=100/minRaiseTo=150/
    // opponentFoldToRaiseRate=0.08 是"aggressive 风格对 EV 计算的偏差"那组
    // 测试里已经手算验证过的近似打平局面（evCall=60, evRaise≈59.88，call
    // 微弱领先）——默认不开噪声时，不管 random 序列是什么，结果必须稳定是
    // call，因为 gaussianNoise 在 stdDev<=0 时直接返回 0，根本不消耗
    // random()。
    const base = {
      street: 'flop', equity: 0.4, toCall: 100, potSize: 300, myChips: 1000,
      currentBet: 100, minRaiseTo: 150, bigBlind: 20, opponentFoldToRaiseRate: 0.08,
    };
    const seqs = [[0], [0.99], [0.5], [0.1, 0.9, 0.2]];
    for (const seq of seqs) {
      let i = 0;
      const random = () => seq[i++ % seq.length];
      expect(pickAction({ ...base, random }).action).toBe('call');
    }
  });

  it('开启噪声后，同一个近似打平的局面换不同 random 序列会得到不同结果——EV 接近的边界决策不再是"一刀切"', () => {
    const base = {
      street: 'flop', equity: 0.4, toCall: 100, potSize: 300, myChips: 1000,
      currentBet: 100, minRaiseTo: 150, bigBlind: 20, opponentFoldToRaiseRate: 0.08,
      noiseFraction: 0.15,
    };
    const outcomes = new Set();
    const seqs = [
      [0.1, 0.9, 0.2, 0.8, 0.3, 0.7],
      [0.9, 0.1, 0.8, 0.2, 0.7, 0.3],
      [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
      [0.99, 0.01, 0.01, 0.99, 0.5, 0.5],
    ];
    for (const seq of seqs) {
      let i = 0;
      const random = () => seq[i++ % seq.length];
      outcomes.add(pickAction({ ...base, random }).action);
    }
    expect(outcomes.size).toBeGreaterThan(1);
  });

  it('开启噪声后，EV 差距悬殊的决策（比如 95% 胜率的坚果）几乎不受影响，多个 random 序列都应该稳定得到同一个结果', () => {
    const decisive = {
      street: 'flop', equity: 0.95, toCall: 100, potSize: 300, myChips: 1000,
      currentBet: 100, bigBlind: 20, noiseFraction: 0.15,
    };
    const seqs = [
      [0.1, 0.9, 0.2, 0.8, 0.3, 0.7],
      [0.9, 0.1, 0.8, 0.2, 0.7, 0.3],
      [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
      [0.99, 0.01, 0.01, 0.99, 0.5, 0.5],
    ];
    for (const seq of seqs) {
      let i = 0;
      const random = () => seq[i++ % seq.length];
      expect(pickAction({ ...decisive, random }).action).toBe('raise');
    }
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

describe('pveStrategy — 尺寸感知的弃牌权益（MDF 锚定，2026-08-03）', () => {
  // sizePressure 归一化成"满池注 = 1.0"，所以理论弃牌上限 = sizePressure × 0.5。
  // 下面每一行的期望值都是德扑教科书里的 MDF 标准值，不是拍脑袋的数字。
  // 直接测导出的 sizePressure 本身——不要在测试里重新实现一遍这个公式，
  // 那样只是在验证测试自己，碰不到生产代码。
  it('MDF 教科书值：满池注 0.5、半池 1/3、2 倍超池 2/3', () => {
    // 满池注：底池 30、下 30 -> opponentDelta=30, potAfterRaise=30+30=60
    expect(sizePressure(30, 60) * 0.5).toBeCloseTo(0.5, 3);
    // 半池注：底池 30、下 15 -> opponentDelta=15, potAfterRaise=45
    expect(sizePressure(15, 45) * 0.5).toBeCloseTo(1 / 3, 3);
    // 2 倍超池：底池 30、下 60 -> opponentDelta=60, potAfterRaise=90
    expect(sizePressure(60, 90) * 0.5).toBeCloseTo(2 / 3, 3);
    // 最小加注：底池 30、currentBet 20、加到 40 -> opponentDelta=20, potAfterRaise=70
    // 改动前这个场景拿到的弃牌权益和满池注一模一样，正是"翻前什么牌都加注"的病根。
    expect(sizePressure(20, 70) * 0.5).toBeCloseTo(0.286, 2);
  });

  it('尺寸压力单调递增：加注越大，压迫力越强', () => {
    const quarter = sizePressure(15, 75);  // 底池 60、下 15
    const half = sizePressure(30, 90);     // 底池 60、下 30
    const full = sizePressure(60, 120);    // 底池 60、下 60
    expect(quarter).toBeLessThan(half);
    expect(half).toBeLessThan(full);
  });

  it('极端超池被 SIZE_PRESSURE_CAP 封顶，不会把弃牌权益推到不合理的高位', () => {
    expect(sizePressure(10000, 10001)).toBe(SIZE_PRESSURE_CAP);
  });

  it('退化输入返回 1（不做尺寸调整），不产生 NaN/Infinity', () => {
    expect(sizePressure(0, 100)).toBe(1);
    expect(sizePressure(20, 0)).toBe(1);
  });

  it('翻前范围回归（本轮招牌行为）：20bb 未面对加注时，强牌加注、烂牌弃牌', () => {
    // equity 用固定值代入（真实胜率由 computeEquity 提供，这里只测决策层）。
    const base = {
      street: 'preflop', toCall: 20, currentBet: 20, potSize: 30, myChips: 400,
      minRaiseTo: 40, opponentCeiling: 400, liveOpponentCount: 1, bigBlind: 20,
      opponentFoldToRaiseRate: null, style: null, facingRaise: false, random: () => 0.5,
    };
    // AA / KK / AKs 对随机手牌的真实胜率（computeEquity 实测值，见设计文档）
    expect(pickAction({ ...base, equity: 0.859 }).action).toBe('raise'); // AA
    expect(pickAction({ ...base, equity: 0.824 }).action).toBe('raise'); // KK
    expect(pickAction({ ...base, equity: 0.662 }).action).toBe('raise'); // AKs
    // 72o / 32o 应该弃牌（改动前全部是 raise）。
    //
    // 2026-08-03 实现后手算校正：这个 describe 块最初起草时第二个反例用的
    // 是 92o（equity 0.384），但按 Step 3-6 给出的公式手算，这个具体几何
    // 关系（currentBet=20、potSize=30、raiseCandidate 被 minRaiseTo=40 封
    // 到 40，对应 opponentDelta=20、potAfterRaise=70）算出来的
    // sizePressure=2*20/70≈0.571，foldEquity=0.45*0.571≈0.257；92o 在
    // realizedEquity 折算后 realEq≈0.354，evRaise（含 0.6 倍池控制折扣，因
    // 为 equity 0.384 落在 (0.30,0.70) 模糊区间）≈0.98，仍是正 EV——92o 在
    // 这个具体尺寸下其实是一手合法的 SB 偷池加注（对手 25.7% 弃牌权益 +
    // 35.4% 真实胜率，即使打折依然为正），不是"改动没生效"。实测
    // pickAction 也确实返回 raise，跟手算吻合，说明是起草测试时估的示例牌
    // 不够弱，不是代码回归。
    //
    // 换成 32o（equity 0.321，同样是 computeEquity 实测值）：realEq≈0.288，
    // evRaise≈-2.73（跟 72o 一样是负数，murky 折扣不生效），fold 胜出，跟
    // 实际输出一致，是一手清楚地不该加注的烂牌。
    expect(pickAction({ ...base, equity: 0.346 }).action).toBe('fold'); // 72o
    expect(pickAction({ ...base, equity: 0.321 }).action).toBe('fold'); // 32o
  });

  it('尺寸上限常量存在且为 1.6（约 4 倍池，再大的超池边际收益已很小）', () => {
    expect(SIZE_PRESSURE_CAP).toBe(1.6);
  });
});

describe('pveStrategy — 两极化对手范围（超池建模，2026-08-03）', () => {
  it('opponentBottomPct 默认 0 时，行为与改动前的单调范围完全一致', () => {
    const fixedRandom = () => 0.42;
    const a = computeEquity(['As', 'Kd'], ['Th', '7c', '2d'], {
      iterations: 200, random: fixedRandom, opponentRangePct: 0.3,
    });
    const b = computeEquity(['As', 'Kd'], ['Th', '7c', '2d'], {
      iterations: 200, random: fixedRandom, opponentRangePct: 0.3, opponentBottomPct: 0,
    });
    expect(a).toBe(b);
  });

  it('面对两极化范围，中等牌力的胜率明显高于面对同等窄度的单调强牌范围', () => {
    // 对手范围里掺进了一块纯诈唬 -> 中等牌力抓诈唬的价值上来了。
    // 这正是"面对超池不该无脑弃牌"的量化依据。
    // 使用种子随机生成器确保确定性：两次计算都从同一个随机序列开始，
    // 差异纯粹来自范围形状（2026-08-04 防止 CI 随机失败）。
    const createSeededRandom = (seed) => {
      let state = seed;
      return () => {
        state = (state * 9301 + 49297) % 233280;
        return state / 233280;
      };
    };
    const board = ['Th', '7c', '2d'];
    const medium = ['Tc', '9c']; // 顶对弱踢
    const mono = computeEquity(medium, board, {
      iterations: 3000, opponentRangePct: 0.20, random: createSeededRandom(42),
    });
    const polar = computeEquity(medium, board, {
      iterations: 3000, opponentRangePct: 0.12, opponentBottomPct: 0.15, random: createSeededRandom(42),
    });
    expect(polar).toBeGreaterThan(mono + 0.03);
  });

  it('坚果级强牌几乎不受范围形状影响（对照组，证明上一条不是全局偏移）', () => {
    // 种子随机生成器确保确定性对照组：同一个随机序列下，坚果牌对范围
    // 形状的敏感度应远低于中等牌力（2026-08-04 防止 CI 随机失败）。
    const createSeededRandom = (seed) => {
      let state = seed;
      return () => {
        state = (state * 9301 + 49297) % 233280;
        return state / 233280;
      };
    };
    const board = ['Th', '7c', '2d'];
    const nuts = ['Ts', 'Td']; // 中三条
    const mono = computeEquity(nuts, board, {
      iterations: 3000, opponentRangePct: 0.20, random: createSeededRandom(42),
    });
    const polar = computeEquity(nuts, board, {
      iterations: 3000, opponentRangePct: 0.12, opponentBottomPct: 0.15, random: createSeededRandom(42),
    });
    expect(Math.abs(polar - mono)).toBeLessThan(0.03);
  });
});
