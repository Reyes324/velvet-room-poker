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

// ─── 动作抽样 ──────────────────────────────────────────────────────────
// street==='preflop' 时完全忽略传入的 equity，改用 preflopTier——翻前用
// 翻后式的原始胜率容易导致不合理的松跟注（原因见 design.md）。
function pickAction(params) {
  const {
    street, holeCards, equity, toCall, potSize, myChips, position,
    random = Math.random, currentBet = toCall, minRaiseTo,
  } = params;

  const dist = street === 'preflop'
    ? PREFLOP_TABLE[preflopTier(holeCards)]
    : bandFor(equity);

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

  // raise：尺度在底池的 50%-100% 之间浮动（第二次调用 random() 决定具体
  // 落点），再夹到 [minRaiseTo, 全下] 之间；夹完发现连最小加注都摸不到全
  // 下（筹码太浅），直接报 allin，不返回一个不合法的加注数字。
  const myBetThisStreet = currentBet - toCall;
  const maxTotal = myChips + myBetThisStreet;
  const sizeFraction = 0.5 + random() * 0.5; // [0.5, 1.0) of pot
  const fallbackMinRaiseTo = currentBet + Math.max(1, Math.round(potSize * 0.5));
  const wantRaiseTo = Math.round(currentBet + potSize * sizeFraction);
  const floor = minRaiseTo ?? fallbackMinRaiseTo;

  if (floor > maxTotal) return { action: 'allin', raiseTo: maxTotal };
  const raiseTo = Math.min(maxTotal, Math.max(floor, wantRaiseTo));
  return { action: 'raise', raiseTo };
}

module.exports = { computeEquity, preflopTier, pickAction, PREFLOP_TABLE, POSTFLOP_BANDS };
