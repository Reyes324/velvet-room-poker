const pveStrategy = require('./pveStrategy');

// ═══════════════════════════════════════════════════════════════════════
// 牌局复盘（扑克教练第 1 步，2026-09-20）
//
// 方向见 design.md「方向决策：扑克教练（离线复盘）+ 人机对战双模式」。这是
// **离线分析**，不是对局中的策略——它跟 pveStrategy 的决策路径完全分开：
//   · 迭代数拉高（实时决策用 300，这里默认 4000），没有延迟压力；
//   · 不带风格偏差、不带感知噪声、不带池控制折扣——分析要的是客观值，不是
//     一个"有脾气"的值。
//
// 原料来自 PveSession._dispatch 记下的动作序列（见那里的注释）：每个动作都带
// 着**动作发生前**的 street/toCall/pot/chips。本模块是纯函数，不碰 IO、不碰
// socket，方便单测和离线跑批。
// ═══════════════════════════════════════════════════════════════════════

// 实测定的数，不是"离线没有延迟压力所以往大了调"（那个想法是错的：服务端是
// 单线程的，这里每多算一秒，正在打牌的其他人就卡一秒）。同一局面各跑 12 次量
// 抖动：
//   iters=1000 → 标准差 0.9-1.9pp、极差 2.8-5.1pp，约 50ms/次
//   iters=2000 → 标准差 0.75-1.0pp、极差 2.6-3.0pp，约 100ms/次
//   iters=4000 → 耗时再翻倍，精度只再收窄约 0.2pp
// 2000 是拐点。而且真正的不确定性来自 ASSUMED_RANGE_FACING_BET 这个简化假设，
// 量级远大于 ±1pp 的采样噪声——把迭代数堆到 4000 是在给一个本来就有系统性
// 假设的数字做无意义的精修。
//
// 河牌圈不受这个数影响：board 满 5 张且只剩一个对手时 computeEquity 走精确
// 穷举而不是采样（实测同一河牌局面 8 次采样结果完全一致）。
const DEFAULT_ITERATIONS = 2000;

// 面对下注时假设的对手范围（前 X% 强的起手牌）。真实德扑里主动下注的人手牌
// 强于随机，用"随机两张"算胜率会系统性高估自己。
//
// 这是一个刻意的简化：对局中的 pveStrategy 会用真实观测到的对手激进度动态
// 收窄这个范围，复盘不照搬那一套——那套参数是为了"打得像人"调出来的，不是
// 为了"判断对错"。这里用一个固定的、说得清楚的值，宁可简单也不要给出一个
// 解释不了来源的数字。
const ASSUMED_RANGE_FACING_BET = 0.4;

const STREET_BOARD_SIZE = { preflop: 0, flop: 3, turn: 4, river: 5 };

// 判定为"明显失误"的 EV 阈值，单位是大盲。小于这个量级的偏差落在蒙特卡洛
// 采样误差和范围假设的模糊地带里，摆出"你打错了"的结论是不诚实的。
const MISTAKE_THRESHOLD_BB = 0.5;

function boardAt(street, communityCards) {
  const size = STREET_BOARD_SIZE[street];
  if (size == null) return null;
  return communityCards.slice(0, size).map(c => c.raw);
}

function holeCardsOf(hand, playerId) {
  const entry = hand.reveals?.find(r => r.id === playerId);
  if (!entry?.holeCards || entry.holeCards.length < 2) return null;
  return entry.holeCards.map(c => c.raw);
}

// 这一步之前还有几个对手没弃牌。从 settle（这手牌的全部参与者）减去动作序列
// 里在这一步**之前**已经弃牌的人——人越多，同样的牌力越难赢，胜率必须按多
// 人算，否则多人桌的复盘会系统性高估。
function liveOpponentsBefore(hand, index, playerId) {
  const folded = new Set();
  for (let i = 0; i < index; i++) {
    if (hand.actions[i].action === 'fold') folded.add(hand.actions[i].id);
  }
  const everyone = hand.settle?.map(s => s.id) ?? [];
  return everyone.filter(id => id !== playerId && !folded.has(id)).length;
}

// 跟注需要多少胜率才不亏（底池赔率）。EV(跟注) = 胜率 ×(底池+跟注额) − 跟注额，
// 令其为 0 即得。口径跟 pveStrategy.pickAction 的 evCall 一致——两边必须对得上，
// 否则复盘算出的数跟 AI 当时自己用的数是两回事。
function requiredEquity(toCall, pot) {
  const total = pot + toCall;
  return total > 0 ? toCall / total : 0;
}

function evOfCalling(equity, toCall, pot) {
  return equity * (pot + toCall) - toCall;
}

// 复盘一手牌里某个玩家的所有决策点。
//
// 只对**算得清**的决策给结论——面对下注时的跟/弃。主动下注、加注尺度、诈唬
// 频率这些需要多街前瞻和范围平衡才能评价的东西一律不判（pveStrategy 自己都
// 没有多街前瞻，见它的 POT_CONTROL_* 注释），只记录当时的胜率供参考。这条
// 自律写在 design.md 里，不是偷懒。
function reviewHand(hand, {
  playerId,
  iterations = DEFAULT_ITERATIONS,
  bigBlind = 20,
  strategy = pveStrategy,
  rangeFacingBet = ASSUMED_RANGE_FACING_BET,
} = {}) {
  const holeCards = holeCardsOf(hand, playerId);
  const actions = hand.actions ?? [];
  if (!holeCards || actions.length === 0) {
    // 多人桌里玩家早早弃牌、又没进摊牌时，记录里可能没有他的底牌（reveals
    // 只保证摊牌方和弃牌获胜方）。没有底牌就没法算胜率，如实返回"无法复盘"，
    // 不猜、不拿随机牌顶上。
    return { handNumber: hand.handNumber, playerId, reviewable: false, decisions: [] };
  }

  const decisions = [];
  actions.forEach((a, index) => {
    if (a.id !== playerId) return;
    const board = boardAt(a.street, hand.communityCards ?? []);
    if (board == null) return;

    const facingBet = a.toCall > 0;
    const numOpponents = Math.max(1, liveOpponentsBefore(hand, index, playerId));
    const equity = strategy.computeEquity(holeCards, board, {
      iterations,
      numOpponents,
      // 只在面对下注时才收窄对手范围——没人下注时，没有理由假设对手的牌比
      // 随机更强（跟 PveSession 对局中的同一条判断保持一致）。
      opponentRangePct: facingBet ? rangeFacingBet : 1,
    });

    const decision = {
      street: a.street,
      action: a.action,
      toCall: a.toCall,
      pot: a.pot,
      holeCards,
      board,
      numOpponents,
      equity,
      verdict: 'unjudged',
      evLoss: 0,
    };

    if (facingBet && (a.action === 'call' || a.action === 'fold')) {
      const needed = requiredEquity(a.toCall, a.pot);
      const evCall = evOfCalling(equity, a.toCall, a.pot);
      decision.requiredEquity = needed;
      decision.evCall = evCall;

      // 弃牌的 EV 恒为 0（不再投入、也不再赢），所以"这一步亏了多少"就是
      // 两个选项的差额：跟注是负 EV 却跟了，亏的是 |evCall|；跟注是正 EV
      // 却弃了，亏的是 evCall。
      const loss = a.action === 'call' ? -evCall : evCall;
      if (loss > MISTAKE_THRESHOLD_BB * bigBlind) {
        decision.verdict = 'mistake';
        decision.evLoss = loss;
      } else {
        decision.verdict = 'ok';
      }
    }

    decisions.push(decision);
  });

  return {
    handNumber: hand.handNumber,
    playerId,
    reviewable: true,
    decisions,
    totalEvLoss: decisions.reduce((sum, d) => sum + d.evLoss, 0),
  };
}

module.exports = {
  reviewHand,
  requiredEquity,
  evOfCalling,
  DEFAULT_ITERATIONS,
  ASSUMED_RANGE_FACING_BET,
  MISTAKE_THRESHOLD_BB,
};
