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

// 两极化范围（2026-08-03）：前 topPct 的强牌 ∪ 后 bottomPct 的烂牌，中间
// 牌力挖空。真实德扑里超池注就是这个形状——要么坚果要么纯诈唬，中等牌力
// 不会选这个尺寸。跟 getRangeSet 复用同一份 HAND_CLASSES（已按分数降序 +
// 带累计组合数），所以这里只是换一个 Set，computeEquity 的拒绝采样逻辑
// 一行都不用改。
//
// 注意这里不能像 getRangeSet 那样提前 break——底部那一段要扫到列表末尾。
// 169 个类别的全扫成本可忽略。
function getPolarizedRangeSet(topPct, bottomPct) {
  const topThreshold = topPct * TOTAL_COMBOS;
  const bottomThreshold = (1 - bottomPct) * TOTAL_COMBOS;
  const set = new Set();
  for (const c of HAND_CLASSES) {
    if (c.cumBefore < topThreshold || c.cumBefore >= bottomThreshold) set.add(c.key);
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
  const {
    iterations = 300, random = Math.random,
    opponentRangePct = 1, opponentBottomPct = 0, numOpponents = 1,
  } = opts;
  const known = new Set([...holeCards, ...board]);
  const remaining = makeDeck().filter(c => !known.has(c));
  // opponentBottomPct > 0 -> 两极化（前 X% ∪ 后 Y%）；否则维持原来的单调
  // 前 X%。默认 0 保证所有不传这个 opt 的既有调用与测试逐位不变。
  const rangeSet = opponentBottomPct > 0
    ? getPolarizedRangeSet(opponentRangePct, opponentBottomPct)
    : (opponentRangePct < 1 ? getRangeSet(opponentRangePct) : null);

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
  bluffer:        { foldEquityMultiplier: 1.05 }, // 高估自己的弃牌权益
  callingStation: { equityMultiplier: 1.1 },     // 高估自己的胜率（封顶 1.0）
};
const STYLES = Object.keys(STYLE_EV_BIAS);

// 无 oppStats 数据时的中性先验——业余牌局的真实弃牌率明显低于对半开
// （0.5 是纯拍脑袋的数字，2026-08-02 最终审查修复调到 0.45）。
const DEFAULT_FOLD_PRIOR = 0.45;
// 尺寸压力上限（2026-08-03）：sizePressure 在下注额约等于 4 倍底池时达到
// 1.6，更大的超池边际收益已经很小，封顶避免极端尺寸把弃牌权益推到不合理
// 的高位。
const SIZE_PRESSURE_CAP = 1.6;

// 弃牌权益的尺寸依赖（MDF，最小防守频率——德扑标准理论，不是拍脑袋的
// 数字）：对手需要再拿出 opponentDelta 才能去争一个 potAfterRaise 大的
// 底池，其理论弃牌上限即 opponentDelta / potAfterRaise。这里归一化成
// "满池注 = 1.0"，好让既有的 DEFAULT_FOLD_PRIOR 语义平滑变成"打一个满池
// 注时的弃牌率"，那个常量本身不用动。
//
// 自检（返回值 × 0.5 就是理论弃牌上限）：满池注 -> 0.5、半池 -> 1/3、
// 2 倍超池 -> 2/3，全部与教科书一致。改动前这一层完全不存在，最小加注被
// 当成和满池注一样有压迫力，是"翻前 100% 加注"的直接病根。
function sizePressure(opponentDelta, potAfterRaise) {
  if (!(potAfterRaise > 0) || !(opponentDelta > 0)) return 1;
  return Math.min(SIZE_PRESSURE_CAP, (2 * opponentDelta) / potAfterRaise);
}

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

// 感知噪声（用户需求，2026-08-02："加一点随机色彩、加点情绪，让这个比较
// 像人类"）：真人玩家哪怕真心想赢，判断也不是像计算器一样精确——会有情绪
// 波动、会看错、会觉得"这把感觉不太对"。给 fold/call/raise 三个算出来的
// EV 各自加一点跟底池成比例的高斯噪声，再比大小，而不是直接比精确值：
// EV 差距悬殊的决策几乎不受影响（一点噪声翻不动大的差距），EV 接近的边界
// 决策会自然变得不那么可预测——包括"强牌几乎从不过牌/慢打"这类此前纯粹
// 靠公式精确比较导致的"一刀切"，不需要再专门写一条"强牌偶尔慢打"的特判
// 规则，是同一个机制的自然结果。
//
// 默认不开启（noiseFraction=0，stdDev<=0 时直接返回 0、不消耗 random()），
// 对现有所有不传这个参数的调用方（包括这个文件里几十个手算验证过边界值
// 的单元测试）完全不影响——PveSession.aiAction() 给真实对局的决策显式传入
// 这个值来开启，不作为 pickAction 的默认行为。0.15 是"噪声标准差 = 底池的
// 15%"，量级上跟诈唬层的 BLUFF_DEVIATION_RATE 是同一类"小幅、不主导决策"
// 的调整，不是拍脑袋。
const EV_NOISE_FRACTION = 0.15;

// 池控制风险折扣（用户反馈 2026-08-02："有的电脑诈唬过度，不是nuts但是持
// 续下注好像不会控池"）——实测证实：翻牌圈没人下注、轮到 AI 决定要不要主
// 动下注时，只要还剩 1-2 个对手，胜率哪怕只有 45%（场均输面的烂牌，不是
// "不错但不是坚果"）也会被 raise，因为聚合弃牌权益模型算出来的 evRaise
// 只要数学上略微为正就赢了 argmax，没有任何"这个弃牌权益估计有多可靠"的
// 余量——真实玩家的"池控制"本质就是对这种不确定性的风险规避，现在的公式
// 完全没有这一层（跟 design.md「明确不做：真正的多街前瞻」是同一类局限
// 的具体表现）。不引入真正的前瞻（那是求解器级别的复杂度），只给"不算坚
// 果也不算明显该弃的烂牌"这个胜率区间的 raise 打一个折扣，让它要有更大的
// EV 优势才会被选中，而不是略微为正就下注——跟 raiseSizeFraction 已经在
// 用的 0.30/0.70 极化阈值是同一个"清晰 vs 模糊"的划分，不是另起一套数字。
const POT_CONTROL_MURKY_LOW = 0.30;
const POT_CONTROL_MURKY_HIGH = 0.70;
const POT_CONTROL_DISCOUNT = 0.6;

function gaussianNoise(random, stdDev) {
  if (stdDev <= 0) return 0;
  // Box-Muller 变换：两个独立均匀分布样本 -> 一个标准正态分布样本。
  const u1 = Math.max(random(), 1e-12); // 避免 u1===0 时 log(0) 变成 -Infinity
  const u2 = random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return z * stdDev;
}

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
  opponentDelta = null, potAfterRaise = null,
}) {
  if (opponentCeiling <= currentBet) return 0;
  let p = opponentFoldToRaiseRate ?? DEFAULT_FOLD_PRIOR;
  if (facingRaise) p *= FACING_RAISE_FOLD_SCALE;
  const bias = STYLE_EV_BIAS[style];
  if (bias?.foldEquityMultiplier) p *= bias.foldEquityMultiplier;
  // 尺寸依赖（组件 A）。两个参数都给了才生效——不给时保持改动前的行为，
  // 这个函数虽然没导出，但保留这个默认分支让调用点的改动可以分步验证。
  if (opponentDelta != null && potAfterRaise != null) {
    p *= sizePressure(opponentDelta, potAfterRaise);
  }
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
    street, equity, equityIfCalled, toCall, potSize, myChips, currentBet = toCall, minRaiseTo,
    random = Math.random,
    opponentCeiling = Infinity,
    liveOpponentCount = 1,
    bigBlind,
    opponentFoldToRaiseRate = null,
    style = null,
    facingRaise = false,
    noiseFraction = 0, // 感知噪声标准差 = potSize × 这个比例；0 = 不开启，精确比较（默认，向后兼容）
  } = params;

  const myBetThisStreet = currentBet - toCall;
  const maxTotal = Math.min(myChips + myBetThisStreet, opponentCeiling); // 有效后手能加到的最高总额
  const eq = styledEquity(equity, style);
  // 跟注后的 SPR：跟注后自己身后还剩多少筹码，相对跟注后底池的比例——用
  // 来判断 realizedEquity 要不要打折（SPR 很低≈快摊牌了，不用折）。
  const sprAfterCall = (potSize + toCall) > 0 ? (myChips - toCall) / (potSize + toCall) : Infinity;
  const realEq = realizedEquity(eq, street, sprAfterCall);

  // 组件 C（2026-08-03）：evCall 和 evRaise 面对的对手范围不一样——跟注面
  // 对的是"对手已经下注了"的范围，而加注面对的是"愿意来跟我加注的人"，后
  // 者必然强于随机。调用方（PveSession）算两次胜率分别传入；不传时退回
  // equity，与改动前逐位一致。
  //
  // 注意这里对两个胜率都统一施加 styledEquity——风格偏差是"我怎么看待自己
  // 的牌力"，对两条分支应当一视同仁；而范围本身用的是客观胜率（由调用方
  // 用真实 equity 算好），不受风格滤镜影响。
  const eqIfCalled = styledEquity(equityIfCalled ?? equity, style);
  const realEqIfCalled = realizedEquity(eqIfCalled, street, sprAfterCall);

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

  // 尺寸相关量必须在算弃牌权益之前先算出来——组件 A（2026-08-03）让弃牌
  // 权益依赖"这一注到底有多大"，所以这几行从原来的位置上移到了这里。
  const cost = raiseCandidate - myBetThisStreet;
  const opponentDelta = raiseCandidate - currentBet;

  let foldEquity = estimateFoldEquity({
    opponentFoldToRaiseRate, liveOpponentCount, style, facingRaise, opponentCeiling, currentBet,
    opponentDelta, potAfterRaise: potSize + cost,
  });

  // all-in-for-less（自己的加注/全下额度不到当前下注额，等价于筹码比对手
  // 短、只能全下一部分）：对手根本不用面对"要不要弃掉更多筹码"的抉择——
  // 他们已经投入的比我方全下的还多，没有任何"逼他们弃牌"的空间，弃牌权益
  // 强制为 0（2026-08-02 全面审查修复：修之前这里会按正常弃牌权益公式算出
  // 一个 >0 的数，误导 evRaise 高估）。
  if (raiseCandidate < currentBet) foldEquity = 0;

  const evFold = 0;
  // 跟注的真实成本要用"实际能付得起的跟注额"（被 myChips 封顶），不能直接
  // 用 toCall——当 toCall > myChips（筹码比对手短，只能跟注跟到全下）时，
  // toCall 是"名义上要跟到的差额"，不是自己真能拿出来的钱。
  //
  // 赢下的底池份额也要跟着调整，不能直接假设"potSize + actualCallCost"整
  // 个都能赢：toCall 里超出 actualCallCost 的部分（uncalled excess，记为
  // u = toCall - actualCallCost）对手根本没机会真正投进池里跟自己打——
  // GameEngine 的边池分层（_buildSidePots）只按每个人自己的 totalBet 分配
  // 资格，自己全下这么点钱，能赢的层就只到自己的总投入为止，u 这部分本来
  // 就会被退还给下注方，自己永远赢不到。多人桌时这个退款不是只发生一次——
  // liveOpponentCount 个还没弃牌的对手，只要都下到了 currentBet 这个层级
  // （聚合弃牌权益模型本来就是按"要么全弃、要么全跟"这个简化在算，参见
  // estimateFoldEquity 的 p^n 聚合——这里延用同一个简化，不单独对每个对手
  // 建模具体下注额），每一个人超出我方全下量的部分都会各自被退，退款总额
  // 是 u × liveOpponentCount，不是 u（2026-08-02 复核修复：上一版只按"一
  // 个对手"退款建模，独立复核构造出一个真实可达的 3 人全下场景验证——两人
  // 各下 1500、潜池 3000、自己只剩 10 筹码，正确的能赢底池是 30，只退一次
  // 算出来的是 1520，差了两个数量级，会把接近 0% 胜率的烂牌也在多人桌全下
  // 场景里错判成 +EV）。Math.max(0, …) 只是兜底"底池不能是负数"这个物理上
  // 恒成立的下限，不是在假设某个不可达的局面（不重犯上一轮的错）。
  const actualCallCost = Math.min(toCall, myChips);
  const uncalledExcess = toCall - actualCallCost; // toCall<=myChips 时恒为 0，公式退化回原来的样子
  const totalUncalledExcess = uncalledExcess * liveOpponentCount;
  const evCall = realEq * Math.max(0, potSize + actualCallCost - totalUncalledExcess) - actualCallCost;

  // potSize 约定为"此刻真实可见的底池"（含这条街所有已下注的筹码——见
  // PveSession 的调用方，Task 2）。加注到 raiseCandidate 后，自己这条街的
  // 追加投入是 cost；对手的追加投入是 (raiseCandidate - currentBet)。
  //
  // all-in-for-less（raiseCandidate < currentBet）时要跟上面 evCall 的退款
  // 建模保持一致：这个负数代表"对手超出我方全下量的部分会被退还"，
  // liveOpponentCount 个还没弃牌的对手每人各退一份，要乘 liveOpponentCount
  // （2026-08-02 复核修复：单人版本的公式已经验证过在可达局面下不需要裁
  // 剪，但那是 liveOpponentCount=1 的特例；乘上人数之后在 all-in-for-less+
  // 多对手场景下确实可能把这一项算成很负，用 Math.max(0, …) 兜底"底池不能
  // 是负数"这个恒成立的物理下限，不是针对某个不可达局面的特判）。
  //
  // 正常加注（raiseCandidate >= currentBet）时不乘 liveOpponentCount，维持
  // 这次全面审查里已经独立验证过的口径不变——"若被跟注"只按一个对手的追加
  // 投入算，不假设多人桌里所有对手都会跟注同一个加注（那个假设本身没有跟
  // estimateFoldEquity 的聚合弃牌权益模型对齐，会不会需要一起改是一个独立
  // 问题，这次不在 all-in-for-less 专项修复的范围内一起动）。
  const potIfCalled = raiseCandidate < currentBet
    ? Math.max(0, potSize + cost + liveOpponentCount * opponentDelta)
    : potSize + cost + opponentDelta;
  let evRaise = foldEquity * potSize + (1 - foldEquity) * (realEqIfCalled * potIfCalled - cost);

  // 池控制风险折扣（见上面 POT_CONTROL_* 常量的注释）：只在"不算坚果也不
  // 算明显该弃"的模糊胜率区间、且这个 raise 本身算出来是正 EV 时才打折——
  // 已经是负 EV 的加注不需要再折（折了反而会像 aggressive 那个符号 bug一
  // 样把方向搞反），清晰的强牌/纯诈唬区间也不受影响，只收窄"数学上略微为
  // 正就下注"这个中间地带。
  //
  // 用真实客观胜率 equity 判断是否落在模糊区间，不用风格调整过的 eq
  // （用户反馈这个折扣加上之后又实测跑出新的失衡，2026-08-02 当天二次修
  // 复）：callingStation 的 equityMultiplier 会把 eq 往上拉，如果拿 eq 来
  // 判断"是不是清晰强牌"，一手真实只有 65% 胜率的模糊牌会被它自己的乐观
  // 偏差拉到 71.5%、跨过 0.70 的上限，直接绕开了这层风险折扣——"越容易高
  // 估自己牌力的风格，越不需要池控制"，这跟池控制本来要防的东西正好相
  // 反。"是不是真的接近坚果"是客观事实，不该被风格滤镜改变；风格只影响
  // "面对同样的不确定性，愿不愿意冒这个险"，也就是下面 varianceScale 这
  // 一层，两者不能用同一个已经被扭曲过的数字来判断。
  if (evRaise > 0 && equity > POT_CONTROL_MURKY_LOW && equity < POT_CONTROL_MURKY_HIGH) {
    evRaise *= POT_CONTROL_DISCOUNT;
  }

  const bias = STYLE_EV_BIAS[style];
  if (bias?.varianceScale) {
    // 符号 bug 修复（2026-08-02 最终审查）：这个乘数此前隐式假设 evRaise
    // 恒正——AI 几乎不弃牌的旧世界里确实如此，但修好之后 evRaise 会经常是
    // 负数，此时直接乘 1.15（aggressive）会让负数更负，实际效果是"更不爱
    // 加注"，跟风格设计意图相反。只在正 EV 时用乘法放大/缩小幅度，负 EV
    // 时改用除法，保证符号方向不被乘反。
    evRaise = evRaise > 0 ? evRaise * bias.varianceScale : evRaise / bias.varianceScale;
  }

  // 感知噪声只用于"选哪个动作"这一步的比较，不改 evFold/evCall/evRaise
  // 这几个变量本身——诈唬层下面用的还是 eq（未打噪声的客观胜率），跟"是否
  // 要诈唬"这个判断脱钩，噪声只影响"EV 接近时选哪边"。
  const noiseStdDev = potSize * noiseFraction;
  const perceivedFold = evFold + gaussianNoise(random, noiseStdDev);
  const perceivedCall = evCall + gaussianNoise(random, noiseStdDev);
  const perceivedRaise = evRaise + gaussianNoise(random, noiseStdDev);

  let bestAction;
  if (toCall === 0) {
    // 白看：弃牌不是真实选项（等价于白白放弃一次免费看牌的机会），只在
    // "加注"和"过牌"之间选。
    bestAction = perceivedRaise > perceivedCall ? 'raise' : 'check';
  } else {
    const options = [
      { action: 'fold', ev: perceivedFold },
      { action: 'raise', ev: perceivedRaise },
    ];
    // 浅筹码 push/fold 模式：只比较 fold vs all-in，call 不是真实选项——加
    // 注候选在这个分支已经被强制设成全下（见上面 isShortStackPreflop 分
    // 支），这本来就是个"弃还是梭哈"的二选一决策。
    if (!isShortStackPreflop) options.push({ action: 'call', ev: perceivedCall });
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
  computeEquity, pickAction, raiseSizeFraction, STYLES, EV_NOISE_FRACTION,
  POT_CONTROL_MURKY_LOW, POT_CONTROL_MURKY_HIGH, POT_CONTROL_DISCOUNT,
  SIZE_PRESSURE_CAP, sizePressure,
};
