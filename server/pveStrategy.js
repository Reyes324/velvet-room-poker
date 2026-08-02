const { Hand } = require('pokersolver');
const { makeDeck, RANKS } = require('./GameEngine');
// No rank/suit helpers here anymore — preflopTier/boardTexture (the only
// consumers) were deleted along with the table-driven machinery they
// existed for; don't reintroduce them as unused dead code.

// ─── 起手牌范围建模（最终整体审查修复，2026-08-02）───────────────────────
// 详见 docs/superpowers/specs/2026-08-02-pve-ev-driven-ai-design.md「修正：
// AI 几乎从不弃牌」一节。面对真实加注时，computeEquity 不再把对手模拟成
// "随机两张牌"，而是从"对手的加注范围"（前 X% 强的起手牌）里抽样。范围
// 宽窄用 Bill Chen 的起手牌打分公式排出 169 种典型起手牌类别的强弱顺序，
// 按真实组合数加权（对子 6 组合、同花 4 组合、非同花 12 组合，共 1326 种）
// 算出每个类别的累积百分位，一次性在模块加载时建好，之后按百分位阈值切
// 一个 Set 出来即可，不用每次都重新枚举。
const RANK_VALUE = {};
RANKS.forEach((r, i) => { RANK_VALUE[r] = i + 2; });

function chenHighCardValue(rank) {
  if (rank === 'A') return 10;
  if (rank === 'K') return 8;
  if (rank === 'Q') return 7;
  if (rank === 'J') return 6;
  if (rank === 'T') return 5;
  return RANK_VALUE[rank] / 2; // 2..9 -> 1..4.5
}

// rankHigh/rankLow: rank 字符，rankHigh 的牌面值 >= rankLow。
function chenScore(rankHigh, rankLow, suited) {
  if (rankHigh === rankLow) return Math.max(chenHighCardValue(rankHigh) * 2, 5);
  let score = chenHighCardValue(rankHigh);
  if (suited) score += 2;
  const gap = RANK_VALUE[rankHigh] - RANK_VALUE[rankLow] - 1;
  let gapPenalty;
  if (gap <= 0) gapPenalty = 0;
  else if (gap === 1) gapPenalty = -1;
  else if (gap === 2) gapPenalty = -2;
  else if (gap === 3) gapPenalty = -4;
  else gapPenalty = -5;
  // A5 这类"大 gap 但有轮子（wheel）潜力"的组合，罚分松 1 分。
  if (gap >= 4 && rankHigh === 'A') gapPenalty += 1;
  score += gapPenalty;
  // 两张牌都不高于 Q 且 gap<=1（顺子潜力好）时给一点顺子连接奖励。
  if (gap <= 1 && rankHigh !== 'A' && rankHigh !== 'K') score += 1;
  return score;
}

function buildHandClasses() {
  const classes = [];
  for (let i = 0; i < RANKS.length; i++) {
    for (let j = i; j < RANKS.length; j++) {
      const rLow = RANKS[i];
      const rHigh = RANKS[j];
      if (rLow === rHigh) {
        classes.push({ key: `pair-${rHigh}`, score: chenScore(rHigh, rLow, false), weight: 6 });
      } else {
        classes.push({ key: `${rHigh}${rLow}s`, score: chenScore(rHigh, rLow, true), weight: 4 });
        classes.push({ key: `${rHigh}${rLow}o`, score: chenScore(rHigh, rLow, false), weight: 12 });
      }
    }
  }
  return classes;
}

// 一次性在模块加载时建好：按分数降序排列，并记录每个类别"排在它前面的
// 所有更强类别"的组合数累计（cumBefore）——判断某个类别是否属于"前 X%"
// 只需要比较 cumBefore 和 X% × 1326 即可。
const HAND_CLASSES = buildHandClasses().sort((a, b) => b.score - a.score);
(function annotateCumulative() {
  let cum = 0;
  for (const c of HAND_CLASSES) {
    c.cumBefore = cum;
    cum += c.weight;
  }
})();
const TOTAL_COMBOS = HAND_CLASSES.reduce((sum, c) => sum + c.weight, 0); // 1326

function handClassKey(c1, c2) {
  const r1 = c1[0], r2 = c2[0];
  const suited = c1[1] === c2[1];
  if (r1 === r2) return `pair-${r1}`;
  const [rHigh, rLow] = RANK_VALUE[r1] >= RANK_VALUE[r2] ? [r1, r2] : [r2, r1];
  return `${rHigh}${rLow}${suited ? 's' : 'o'}`;
}

// pct: 0-1 之间的分数，"前 pct 强的起手牌"。返回一个 Set<classKey>。
function getRangeSet(pct) {
  const threshold = pct * TOTAL_COMBOS;
  const set = new Set();
  for (const c of HAND_CLASSES) {
    if (c.cumBefore < threshold) set.add(c.key);
    else break; // 已按分数降序排列，过了阈值后面只会更弱，不用继续扫
  }
  return set;
}

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
// opponentRangePct（默认 1 = 不限制，必须完全复现旧行为，保证所有不传这
// 个 opt 的既有调用/测试原样通过）：<1 时把对手的底牌限制在"前 X% 强"的
// 起手牌范围内，用拒绝采样实现——抽两张牌，不在范围内就放回重抽，最多试
// 40 次，仍不中就将就用最后抽到的那手（不做无限循环）。
// numOpponents（默认 1，同样必须完全复现旧行为）：>1 时每次试验都发
// numOpponents 副互不重叠的对手底牌，用 pokersolver 的 Hand.winners 做
// N 人比大小；河牌圈穷举分支只在 numOpponents===1 时启用（多对手穷举组
// 合数太大，不划算），numOpponents>1 一律走蒙特卡洛，即使是河牌圈。
function computeEquity(holeCards, board, opts = {}) {
  const { iterations = 300, random = Math.random, opponentRangePct = 1, numOpponents = 1 } = opts;
  const known = new Set([...holeCards, ...board]);
  const remaining = makeDeck().filter(c => !known.has(c));
  const rangeSet = opponentRangePct < 1 ? getRangeSet(opponentRangePct) : null;

  if (board.length === 5 && numOpponents === 1) {
    let win = 0, tie = 0, total = 0;
    const heroHand = Hand.solve([...holeCards, ...board]);
    for (let i = 0; i < remaining.length; i++) {
      for (let j = i + 1; j < remaining.length; j++) {
        if (rangeSet && !rangeSet.has(handClassKey(remaining[i], remaining[j]))) continue;
        const oppHand = Hand.solve([remaining[i], remaining[j], ...board]);
        const winners = Hand.winners([heroHand, oppHand]);
        total++;
        if (winners.length === 2) tie++;
        else if (winners[0] === heroHand) win++;
      }
    }
    if (total === 0) {
      // rangeSet filtered out every remaining combo (extreme pct edge case) —
      // fall back to unrestricted so we still return a real number, not NaN.
      if (rangeSet) return computeEquity(holeCards, board, { ...opts, opponentRangePct: 1 });
      return 1; // exact old behavior: no remaining cards at all -> treat as certain win
    }
    return (win + tie / 2) / total;
  }

  const needed = 5 - board.length;
  let equitySum = 0;
  for (let n = 0; n < iterations; n++) {
    const pool = [...remaining];
    const draw = () => {
      const idx = Math.floor(random() * pool.length);
      return pool.splice(idx, 1)[0];
    };
    const drawHole = () => {
      if (!rangeSet) return [draw(), draw()];
      const maxAttempts = 40;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const c1 = draw();
        const c2 = draw();
        // 中了范围，或者已经是最后一次尝试（将就用它）：直接返回，两张牌
        // 保持"已从 pool 移除"的状态，绝不能在返回的同时又塞回 pool——
        // 那样会导致同一张牌既被当成对手底牌、又还留在 pool 里被后续抽到
        // （之前这里有过这个 bug：最后一次失败尝试仍执行了"放回重抽"，
        // 但函数其实已经把这手牌返回出去了，河牌/转牌就可能抽到重复的
        // 那张牌，pokersolver 直接抛 "Duplicate cards"）。
        if (rangeSet.has(handClassKey(c1, c2)) || attempt === maxAttempts - 1) return [c1, c2];
        pool.push(c1, c2); // 不在范围内，放回去重抽
      }
      return undefined; // 理论上不可达（循环体内最后一次必 return）
    };

    const oppHoles = [];
    for (let o = 0; o < numOpponents; o++) oppHoles.push(drawHole());
    const runoutBoard = [...board];
    for (let k = 0; k < needed; k++) runoutBoard.push(draw());

    const heroHand = Hand.solve([...holeCards, ...runoutBoard]);
    const oppHands = oppHoles.map(h => Hand.solve([...h, ...runoutBoard]));
    const winners = Hand.winners([heroHand, ...oppHands]);
    if (winners.includes(heroHand)) equitySum += 1 / winners.length;
  }
  return equitySum / iterations;
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

// 无 oppStats 数据时的中性先验——业余牌局的真实弃牌率明显低于对半开
// （0.5 是纯拍脑袋的数字，2026-08-02 最终审查修复调到 0.45）。
const DEFAULT_FOLD_PRIOR = 0.45;
// 面对真实加注（不只是盲注差额）时的折算系数——已经主动下注过的对手，
// 面对再加注比"面对第一次下注"更不容易被吓跑。同时作用于默认先验和真实
// 观测到的 opponentFoldToRaiseRate。
const FACING_RAISE_FOLD_SCALE = 0.65;
// 翻前有效后手（单位：大盲）低于这个阈值时，直接进入 push/fold 模式：
// 加注候选固定为全下，不再用尺度启发式算一个"加一点点"的数字——按底池
// 比例算的尺度在筹码这么浅的时候天然算不出接近全下的数，不加这个特判，
// 浅筹码根本不会自然收敛到标准的 push/fold 打法。
const SHORT_STACK_BB_THRESHOLD = 15;
// EV-最优动作是弃牌、且自己胜率明显偏低时，保留这么大的概率不按最优走、
// 改成诈唬式加注——避免"胜率一低就必弃牌"这种能被一眼看穿的规律。
// 2026-08-02 最终审查修复：AI 几乎从不弃牌的问题修好之后，会有远多于以前
// 的决策走到这条诈唬判定路径上，原速率 0.08 若不调整，实际诈唬频率会变成
// 大约 3 倍，所以砍半。
const BLUFF_DEVIATION_RATE = 0.04;
const BLUFF_EQUITY_CEILING = 0.30;

// 胜率实现率（2026-08-02 最终审查修复新增）：computeEquity 算出的是"现在
// 摊牌"的静态胜率，但后面往往还有牌要发、还有街要打——烂牌很难把纸面胜率
// 真正兑现成筹码，这个折扣此前完全没建模，是"AI 几乎从不弃牌"的根因之一
// （见 design.md 对应小节，手算验证过 72o/AKo 两个案例）。只用在
// evCall/evRaise 内部，raiseSizeFraction 和诈唬层继续吃未打折的原始
// （styled 但未 realize 的）胜率，避免连带改变加注尺度/诈唬频率的分布。
const REALIZATION_FLOOR = 0.78; // 胜率趋近 0 时的折扣下限
const REALIZATION_FULL_EQ = 0.60; // 胜率达到这个门槛起，基本不打折（约等于 R=1）
// 当前街之后还剩几条街要打——街数越多，纸面胜率离真正摊牌越远，越该打折。
const STREETS_LEFT = { preflop: 3, flop: 2, turn: 1, river: 0 };

function realizedEquity(equity, street, sprAfterCall) {
  const streetsLeft = STREETS_LEFT[street] ?? 0;
  // 河牌圈/摊牌，或者跟注后 SPR 已经很低（基本等于全下、后面没有更多下注
  // 空间博弈）：没有更多街要打，R=1，不打折。
  if (streetsLeft === 0 || sprAfterCall <= 1) return equity;
  if (equity >= REALIZATION_FULL_EQ) return equity; // 强牌基本不打折
  const t = Math.max(0, equity) / REALIZATION_FULL_EQ;
  const r = REALIZATION_FLOOR + (1 - REALIZATION_FLOOR) * t; // 在 [FLOOR, 1) 之间插值
  return equity * r;
}

// 弃牌权益：单个对手的基础估计（默认先验，或已有的 oppStats 数据），乘上
// "面对真实加注"折算系数、风格偏差，再按"剩余所有活跃对手当一个整体"聚
// 合成 p^n——人越多，全员弃牌的概率天然指数下降，不用逐个对手单独建模。
// 对手已经没筹码可弃（opponentCeiling<=currentBet，等价于对手已全下）时，
// 弃牌权益直接为 0——不对一个没法再弃牌的对手"诈唬"。
function estimateFoldEquity({
  opponentFoldToRaiseRate, liveOpponentCount = 1, style = null,
  facingRaise = false, opponentCeiling = Infinity, currentBet = 0,
}) {
  if (opponentCeiling <= currentBet) return 0;
  let p = opponentFoldToRaiseRate ?? DEFAULT_FOLD_PRIOR;
  if (facingRaise) p *= FACING_RAISE_FOLD_SCALE;
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
    facingRaise = false,
  } = params;

  const myBetThisStreet = currentBet - toCall;
  const maxTotal = Math.min(myChips + myBetThisStreet, opponentCeiling); // 有效后手能加到的最高总额
  let foldEquity = estimateFoldEquity({
    opponentFoldToRaiseRate, liveOpponentCount, style, facingRaise, opponentCeiling, currentBet,
  });
  const eq = styledEquity(equity, style);
  // 跟注后的 SPR：跟注后自己身后还剩多少筹码，相对跟注后底池的比例——用
  // 来判断 realizedEquity 要不要打折（SPR 很低≈快摊牌了，不用折）。
  const sprAfterCall = (potSize + toCall) > 0 ? (myChips - toCall) / (potSize + toCall) : Infinity;
  const realEq = realizedEquity(eq, street, sprAfterCall);

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

  // all-in-for-less（自己的加注/全下额度不到当前下注额，等价于筹码比对手
  // 短、只能全下一部分）：对手根本不用面对"要不要弃掉更多筹码"的抉择——
  // 他们已经投入的比我方全下的还多，没有任何"逼他们弃牌"的空间，弃牌权益
  // 强制为 0（2026-08-02 全面审查修复：修之前这里会按正常弃牌权益公式算出
  // 一个 >0 的数，误导 evRaise 高估）。
  if (raiseCandidate < currentBet) foldEquity = 0;

  const evFold = 0;
  // 跟注的真实成本/真实能赢下的底池份额都要用"实际能付得起的跟注额"
  // （被 myChips 封顶），不能直接用 toCall——当 toCall > myChips（筹码比
  // 对手短，只能跟注跟到全下）时，toCall 是"名义上要跟到的差额"，不是自
  // 己真能拿出来的钱，用它算 EV 会同时算错成本项和赢下底池的份额项
  // （2026-08-02 全面审查修复：这是"AI 短筹码面对大注时该跟不跟错判成弃
  // 牌"这个 bug 的根因之一）。
  const actualCallCost = Math.min(toCall, myChips);
  const evCall = realEq * (potSize + actualCallCost) - actualCallCost;

  // potSize 约定为"此刻真实可见的底池"（含这条街所有已下注的筹码——见
  // PveSession 的调用方，Task 2），所以：加注到 raiseCandidate 后，自己
  // 这条街的追加投入是 cost；假设对手跟注到同一个总额，对手的追加投入是
  // (raiseCandidate - currentBet)；两者都加进当前 potSize 就是"若被跟注"
  // 的最终底池。all-in-for-less 时 raiseCandidate < currentBet，这一项会
  // 变负——对手不是在"跟注一个加注"，他们本来的下注额就够了，用 max(0, …)
  // 把它夹到 0，potIfCalled 最少也是 potSize + cost（2026-08-02 全面审查
  // 修复）。
  const cost = raiseCandidate - myBetThisStreet;
  const potIfCalled = potSize + cost + Math.max(0, raiseCandidate - currentBet);
  let evRaise = foldEquity * potSize + (1 - foldEquity) * (realEq * potIfCalled - cost);

  const bias = STYLE_EV_BIAS[style];
  if (bias?.varianceScale) {
    // 符号 bug 修复（2026-08-02 最终审查）：这个乘数此前隐式假设 evRaise
    // 恒正——AI 几乎不弃牌的旧世界里确实如此，但修好之后 evRaise 会经常是
    // 负数，此时直接乘 1.15（aggressive）会让负数更负，实际效果是"更不爱
    // 加注"，跟风格设计意图相反。只在正 EV 时用乘法放大/缩小幅度，负 EV
    // 时改用除法，保证符号方向不被乘反。
    evRaise = evRaise > 0 ? evRaise * bias.varianceScale : evRaise / bias.varianceScale;
  }

  let bestAction;
  if (toCall === 0) {
    // 白看：弃牌不是真实选项（等价于白白放弃一次免费看牌的机会），只在
    // "加注"和"过牌"之间选。
    bestAction = evRaise > evCall ? 'raise' : 'check';
  } else {
    const options = [
      { action: 'fold', ev: evFold },
      { action: 'raise', ev: evRaise },
    ];
    // 浅筹码 push/fold 模式：只比较 fold vs all-in，call 不是真实选项——加
    // 注候选在这个分支已经被强制设成全下（见上面 isShortStackPreflop 分
    // 支），这本来就是个"弃还是梭哈"的二选一决策。
    if (!isShortStackPreflop) options.push({ action: 'call', ev: evCall });
    options.sort((a, b) => b.ev - a.ev);
    bestAction = options[0].action;
  }

  // 诈唬层：EV 最优是弃牌、且自己客观胜率确实很低时，小概率不按最优走。
  // foldEquity > 0 这个条件是 2026-08-02 全面审查修复新增的：诈唬的前提是
  // "有可能吓跑对手"，foldEquity===0（对手已全下/资金不够被吓跑，或者自
  // 己是 all-in-for-less 逼不走任何人）时诈唬没有任何意义，还白白把一手
  // 该弃的牌变成加注，纯粹送筹码。
  if (bestAction === 'fold' && foldEquity > 0 && eq <= BLUFF_EQUITY_CEILING && random() < BLUFF_DEVIATION_RATE) {
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
