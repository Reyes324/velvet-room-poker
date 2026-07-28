const { Hand } = require('pokersolver');
const { makeDeck, RANKS } = require('./GameEngine');

// ═══════════════════════════════════════════════════════════════════════
// PVE (人机对战) 决策引擎 — 单人模式专用，不被多人房间引用。
//
// 设计依据见 openspec/changes/online-texas-holdem/design.md「新增：单人
// 人机对战（PVE）模式」：扑克作为信息不完整零和博弈的均衡解（GTO）在大量
// 决策点上本身就是一个概率分布，不是确定动作——专业解牌器算出来的答案经
// 常是"这手牌 70% 加注、30% 弃牌"。下面两张表就是这个结论的简化近似（胜率
// 分档代替真正求解均衡），刻意把"打法"完全收敛成数据，不散落在决策流程里
// ——以后要调紧/调松，改这两张表的数字，不用碰 pickAction 本身。
// ═══════════════════════════════════════════════════════════════════════

const RANK_VALUE = Object.fromEntries(RANKS.map((r, i) => [r, i])); // '2'→0 … 'A'→12

function rankOf(card) { return card[0]; }
function suitOf(card) { return card[1]; }

// 翻前起手牌分档：heads-up（1v1）本身就该打得比全桌宽很多——这里的分档
// 是标准起手牌强度表的一个粗粒度简化，不是全桌保守范围。
function preflopTier(holeCards) {
  const [a, b] = holeCards;
  const [rA, rB] = [rankOf(a), rankOf(b)];
  const [vA, vB] = [RANK_VALUE[rA], RANK_VALUE[rB]];
  const hi = Math.max(vA, vB), lo = Math.min(vA, vB);
  const suited = suitOf(a) === suitOf(b);
  const isPair = vA === vB;
  const gap = hi - lo - 1; // 0 = connectors, e.g. Q-J

  const A = RANK_VALUE['A'], K = RANK_VALUE['K'], Q = RANK_VALUE['Q'], J = RANK_VALUE['J'], T = RANK_VALUE['T'];

  if (isPair && vA >= T) return 'premium'; // TT+
  if ((hi === A && lo === K)) return 'premium'; // AK suited or offsuit

  if (isPair && vA >= RANK_VALUE['7']) return 'strong'; // 77-99
  if (hi === A && (lo === Q || lo === J)) return 'strong'; // AQ/AJ
  if (hi === K && lo === Q && suited) return 'strong'; // KQs
  if (hi === A && suited) return 'strong'; // any suited ace (Axs)

  if (isPair) return 'playable'; // 22-66
  if (hi === K && suited) return 'playable'; // Kxs
  if (hi === Q && lo === J) return 'playable'; // QJ
  if (hi === J && lo === T) return 'playable'; // JT
  if (suited && gap <= 1 && hi >= RANK_VALUE['5']) return 'playable'; // suited (near-)connectors

  if (hi >= J && lo >= RANK_VALUE['9']) return 'marginal'; // broadway-ish offsuit
  if (suited && gap <= 2) return 'marginal';

  return 'trash';
}

const PREFLOP_TABLE = {
  premium:  { fold: 0.00, call: 0.20, raise: 0.80 },
  strong:   { fold: 0.05, call: 0.45, raise: 0.50 },
  playable: { fold: 0.20, call: 0.50, raise: 0.30 },
  marginal: { fold: 0.45, call: 0.40, raise: 0.15 },
  trash:    { fold: 0.70, call: 0.20, raise: 0.10 },
};

// 翻后：按胜率分档映射到动作概率，而不是硬阈值 if-else——"低胜率也留一点
// 小概率加注"是在做 range balance（诈唬跟价值下注在下注方式上不可区分），
// 不是为了随机而随机。`max` 是该档的胜率上限（含），按顺序取第一个命中的。
const POSTFLOP_BANDS = [
  { max: 0.20, fold: 0.78, call: 0.12, raise: 0.10 },
  { max: 0.40, fold: 0.55, call: 0.35, raise: 0.10 },
  { max: 0.55, fold: 0.15, call: 0.55, raise: 0.30 },
  { max: 0.70, fold: 0.03, call: 0.47, raise: 0.50 },
  { max: 0.85, fold: 0.00, call: 0.30, raise: 0.70 },
  { max: 1.01, fold: 0.00, call: 0.20, raise: 0.80 }, // >85%，含 100%
];

function bandFor(equity) {
  return POSTFLOP_BANDS.find(b => equity <= b.max) ?? POSTFLOP_BANDS[POSTFLOP_BANDS.length - 1];
}

// ─── 胜率计算 ──────────────────────────────────────────────────────────
// board.length===5（河牌，无未知公共牌）时用穷举而不是采样：剩余未知的只
// 有对手的 2 张底牌，C(45,2)≈990 种组合，穷举比蒙特卡洛更快也更准确，还
// 让河牌胜率变成一个确定值，方便测试和调试。翻前/翻牌/转牌阶段公共牌还没
// 完全揭晓，改用蒙特卡洛采样（iterations 次），random 可注入以便测试复现。
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

  const needed = 5 - board.length; // community cards still to come, dealt to BOTH hands identically per trial
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

// ─── 上下文调整（用户实测反馈"很容易猜"后新增，2026-07-28）──────────────
// 光有分档概率表还不够——真人玩家会记得自己这手牌之前做过什么、会看对手
// 打法调整、下注尺度会按"这是价值下注还是诈唬"而不是均匀分布。下面几个
// 调整量都是独立、具名的常量（不是散落的魔法数字），每个对应一条具体的
// 可读牌理由，调紧/调松改这几个数字就够。
const CBET_RAISE_BOOST = 0.25;      // 续注倾向：上一条街是自己主动加注、这条街率先行动时，把这么多概率从 call 挪去 raise
const FACING_RAISE_FOLD_BOOST = 0.10; // 尊重真实加注：面对真加注（不只是盲注差额）时，把这么多概率从 call 挪去 fold
const BLUFF_VS_FOLDY_SCALE = 0.4;   // 对手爱弃牌就多诈唬：(对手面对加注的弃牌率 - 0.5) * 此系数，从 fold 挪去 raise（可为负，对方是跟注站时反而少诈唬）
const CALL_VS_AGGRO_SCALE = 0.4;    // 对手爱加注就多跟注：面对加注时，(对手加注频率 - 0.35) * 此系数，从 fold 挪去 call
const DRY_BOARD_BLUFF_BOOST = 0.12; // 干燥面更适合诈唬（对手很少中牌）：胜率偏低时，把这么多概率从 fold 挪去 raise
const WET_BOARD_BLUFF_PENALTY = 0.12; // 湿润面（同花/顺子听牌多）诈唬不划算：胜率偏低时，把这么多概率从 raise 挪回 fold
const BLUFF_EQUITY_CEILING = 0.40;  // 板面纹理只影响"这是不是诈唬"这类决策——胜率高于这个值就是真价值下注，不该被板面干湿改变要不要下注

// 板面干湿判断：只看两个最主要的驱动因素——是否已经有同花听牌（2 张以上
// 同花色公共牌）、牌面是否连张（存在两张公共牌点数相差 ≤4，順子听牌密
// 度高）。刻意不看对子（成同花顺/葫芦的次要因素，MVP 简化不计）——二元
// 判断（湿/干）足够驱动诈唬频率这一件事，不需要连续的"湿润度"分数。
function boardTexture(board) {
  if (board.length < 3) return 'dry'; // 翻前/还没发公共牌，中性，不触发额外惩罚
  const suitCounts = {};
  for (const c of board) suitCounts[suitOf(c)] = (suitCounts[suitOf(c)] || 0) + 1;
  const maxSuitCount = Math.max(...Object.values(suitCounts));
  const ranks = [...new Set(board.map(c => RANK_VALUE[rankOf(c)]))].sort((a, b) => a - b);
  let connected = false;
  for (let i = 0; i < ranks.length && !connected; i++) {
    for (let j = i + 1; j < ranks.length; j++) {
      if (ranks[j] - ranks[i] <= 4) { connected = true; break; }
    }
  }
  return (maxSuitCount >= 2 || connected) ? 'wet' : 'dry';
}

function adjustDistribution(dist, deltas) {
  let { fold, call, raise } = dist;
  fold = Math.max(0, fold + (deltas.fold ?? 0));
  call = Math.max(0, call + (deltas.call ?? 0));
  raise = Math.max(0, raise + (deltas.raise ?? 0));
  const sum = fold + call + raise;
  return sum === 0 ? dist : { fold: fold / sum, call: call / sum, raise: raise / sum };
}

function contextDeltas({ street, board, equity, toCall, wasAggressor, facingRaise, opponentFoldToRaiseRate, opponentAggressionRate }) {
  const deltas = { fold: 0, call: 0, raise: 0 };

  // 续注（c-bet）：上条街是自己在加注、这条街轮到自己且没人下注——不管翻牌
  // 有没有连到，真实玩家大概率会延续攻势，不是每条街都从零重新算胜率。
  if (street !== 'preflop' && wasAggressor && toCall === 0) {
    deltas.call -= CBET_RAISE_BOOST;
    deltas.raise += CBET_RAISE_BOOST;
  }

  // 板面干湿：只在"这手牌明显不是真价值"（胜率偏低，raise 只能是诈唬）
  // 的场景下才有意义——胜率够高时该不该下注是牌力说了算，跟板面干湿无关。
  // 要求 board.length>=3（真正翻牌以后才有意义的公共牌）而不是只判断
  // `board` 真值——`pickAction` 里 board 默认是 `[]`，如果只判断真值，
  // 没传 board 的旧调用方会被 boardTexture([]) 的"dry"默认值悄悄叠加一
  // 层从未要求过的诈唬加成（实测踩过这个坑：两个已有的上下文调整测试因
  // 此意外变成"raise"，才发现这里的默认值语义有问题）。
  if (street !== 'preflop' && board.length >= 3 && equity != null && equity <= BLUFF_EQUITY_CEILING) {
    if (boardTexture(board) === 'dry') {
      deltas.fold -= DRY_BOARD_BLUFF_BOOST;
      deltas.raise += DRY_BOARD_BLUFF_BOOST;
    } else {
      deltas.raise -= WET_BOARD_BLUFF_PENALTY;
      deltas.fold += WET_BOARD_BLUFF_PENALTY;
    }
  }

  if (facingRaise) {
    deltas.call -= FACING_RAISE_FOLD_BOOST;
    deltas.fold += FACING_RAISE_FOLD_BOOST;

    if (opponentAggressionRate != null) {
      const bump = (opponentAggressionRate - 0.35) * CALL_VS_AGGRO_SCALE;
      deltas.fold -= bump;
      deltas.call += bump;
    }
  }

  if (opponentFoldToRaiseRate != null) {
    const bump = (opponentFoldToRaiseRate - 0.5) * BLUFF_VS_FOLDY_SCALE;
    deltas.fold -= bump;
    deltas.raise += bump;
  }

  return deltas;
}

// 翻前给不了真实胜率（还没公共牌），用分档给一个粗略的数值代理，只用来
// 决定下注尺度是"极化"还是"合并"，不影响弃牌/跟注/加注的概率本身（那个
// 仍然是 PREFLOP_TABLE 说了算）。
const PREFLOP_EQUITY_PROXY = { premium: 0.88, strong: 0.72, playable: 0.55, marginal: 0.38, trash: 0.18 };

// 下注尺度极化：真实强牌（价值）和明显诈唬用大且浮动范围更宽的尺度
// （0.6-1.4 倍底池)，中等牌力用偏小、偏窄的"保护性"尺度（0.35-0.7 倍底
// 池）——这是真实的极化/合并下注范围理论的简化落地，不是一个统一的
// 0.5-1.0 倍区间：后者本身就是最容易被摸出规律的"每次都差不多大"。
function raiseSizeFraction(street, holeCards, equity, random) {
  const e = street === 'preflop' ? PREFLOP_EQUITY_PROXY[preflopTier(holeCards)] : equity;
  const polarized = e >= 0.70 || e <= 0.30;
  const [lo, hi] = polarized ? [0.6, 1.4] : [0.35, 0.7];
  return lo + random() * (hi - lo);
}

// ─── 动作抽样 ──────────────────────────────────────────────────────────
// street==='preflop' 时完全忽略传入的 equity，改用 preflopTier——翻前用
// 翻后式的原始胜率容易导致不合理的松跟注（原因见 design.md）。
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
  const deltas = contextDeltas({ street, board, equity, toCall, wasAggressor, facingRaise, opponentFoldToRaiseRate, opponentAggressionRate });
  const dist = adjustDistribution(baseDist, deltas);

  // 白看（toCall===0）时不可能弃牌——把 fold 的概率吸收进 call（此时等价
  // 于 check），加注概率原样保留。
  const fold = toCall === 0 ? 0 : dist.fold;
  const call = toCall === 0 ? dist.fold + dist.call : dist.call;
  const raise = dist.raise;

  const r = random();
  let bucket;
  if (r < fold) bucket = 'fold';
  else if (r < fold + call) bucket = 'call';
  else bucket = 'raise';

  if (bucket === 'fold') return { action: 'fold' };
  if (bucket === 'call') return { action: toCall === 0 ? 'check' : 'call' };

  // raise：尺度按 raiseSizeFraction 极化浮动（第二次调用 random() 决定具
  // 体落点），再夹到 [minRaiseTo, 全下] 之间；夹完发现连最小加注都摸不到
  // 全下（筹码太浅），直接报 allin，不返回一个不合法的加注数字。
  const myBetThisStreet = currentBet - toCall;
  const maxTotal = Math.min(myChips + myBetThisStreet, opponentCeiling);
  const sizeFraction = raiseSizeFraction(street, holeCards, equity, random);
  const fallbackMinRaiseTo = currentBet + Math.max(1, Math.round(potSize * 0.5));
  const wantRaiseTo = Math.round(currentBet + potSize * sizeFraction);
  const floor = minRaiseTo ?? fallbackMinRaiseTo;

  if (floor > maxTotal) return { action: 'allin', raiseTo: maxTotal };
  const raiseTo = Math.min(maxTotal, Math.max(floor, wantRaiseTo));
  return { action: 'raise', raiseTo };
}

module.exports = {
  computeEquity, preflopTier, pickAction, PREFLOP_TABLE, POSTFLOP_BANDS,
  // exported for direct unit testing / tuning visibility, not for PveSession to call directly
  adjustDistribution, contextDeltas, raiseSizeFraction, boardTexture,
};
