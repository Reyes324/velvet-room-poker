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
