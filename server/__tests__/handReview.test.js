import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
  reviewHand, requiredEquity, evOfCalling, MISTAKE_THRESHOLD_BB,
} = require('../handReview');

const BIG_BLIND = 20;
const BOARD = ['2s', 'Jc', '7c', '2h', 'Qd'];

// 用桩替掉蒙特卡洛，让每条断言都能手算验证——真实 computeEquity 的采样正确性
// 由 pveStrategy 自己的测试覆盖，这里要验的是复盘的判定逻辑。
function stubStrategy(equity) {
  return { computeEquity: vi.fn(() => equity) };
}

function makeHand(actions, opts = {}) {
  return {
    handNumber: 1,
    communityCards: BOARD.map(raw => ({ raw })),
    settle: [{ id: 'me' }, { id: '__ai__' }],
    reveals: [{ id: 'me', holeCards: [{ raw: 'Kd' }, { raw: '5c' }] }],
    actions,
    ...opts,
  };
}

function review(hand, equity, opts = {}) {
  return reviewHand(hand, {
    playerId: 'me', bigBlind: BIG_BLIND, strategy: stubStrategy(equity), ...opts,
  });
}

describe('handReview — 底池赔率口径', () => {
  it('requiredEquity 是 跟注额 ÷（底池+跟注额），跟 pickAction 的 evCall 同一口径', () => {
    // 实录过的一手：河牌要跟 ¥49、底池 ¥89 → 49/138
    expect(requiredEquity(49, 89)).toBeCloseTo(0.3551, 4);
    // 教科书自检。注意 pot 记的是对手那注**已经入池之后**的底池（GameEngine
    // 下注即入池，跟 pickAction 的 potSize 同一口径），所以：
    //   满池注：池 100 → 对手下 100 → 记录 pot=200、toCall=100 → 要 1/3
    //   半池注：池 100 → 对手下  50 → 记录 pot=150、toCall= 50 → 要 1/4
    expect(requiredEquity(100, 200)).toBeCloseTo(1 / 3, 6);
    expect(requiredEquity(50, 150)).toBe(0.25);
    expect(requiredEquity(0, 100)).toBe(0);
  });

  it('evOfCalling 在胜率正好等于 requiredEquity 时为 0（不赚不亏的分界点）', () => {
    const toCall = 49, pot = 89;
    expect(evOfCalling(requiredEquity(toCall, pot), toCall, pot)).toBeCloseTo(0, 6);
  });
});

describe('handReview — 判定', () => {
  it('胜率不够却跟注 → 判为失误，亏损额等于这次跟注的负 EV', () => {
    const hand = makeHand([{ street: 'river', id: 'me', action: 'call', toCall: 333, pot: 757, chips: 500 }]);
    const out = review(hand, 0.19);
    const d = out.decisions[0];
    expect(d.verdict).toBe('mistake');
    // 0.19×(757+333) − 333 = 207.1 − 333 = −125.9
    expect(d.evLoss).toBeCloseTo(125.9, 1);
    expect(out.totalEvLoss).toBeCloseTo(125.9, 1);
  });

  it('胜率足够的跟注 → 判为 ok，不计亏损', () => {
    const hand = makeHand([{ street: 'river', id: 'me', action: 'call', toCall: 49, pot: 89, chips: 500 }]);
    const out = review(hand, 0.5);
    expect(out.decisions[0].verdict).toBe('ok');
    expect(out.totalEvLoss).toBe(0);
  });

  // 用户反馈 2026-09-20："为什么复盘只讲亏的呀？其他呢？"——该弃就弃是实打实
  // 省下了钱，不能只给一个静默的对勾。
  it('该弃就弃 → 判 ok，并给出省下多少（= 跟下去会亏的那个数）', () => {
    const hand = makeHand([{ street: 'river', id: 'me', action: 'fold', toCall: 333, pot: 757, chips: 500 }]);
    const out = review(hand, 0.19);
    const d = out.decisions[0];
    expect(d.verdict).toBe('ok');
    // 跟下去是 0.19×1090 − 333 = −125.9，弃掉就省下这 125.9
    expect(d.evSaved).toBeCloseTo(125.9, 1);
    expect(out.totalEvLoss).toBe(0); // 省下的不能被算成亏损
  });

  it('跟注为正 EV、弃牌只是略亏（没到阈值）时不报"省下"——那是无中生有', () => {
    const hand = makeHand([{ street: 'river', id: 'me', action: 'fold', toCall: 100, pot: 100, chips: 500 }]);
    const out = review(hand, 0.52); // 0.52×200−100 = +4，弃牌略亏但在阈值内
    expect(out.decisions[0].verdict).toBe('ok');
    expect(out.decisions[0].evSaved).toBeUndefined();
  });

  it('带上这一手的真实输赢，好让面板能把"结果"和"决策对不对"分开讲', () => {
    const hand = makeHand(
      [{ street: 'river', id: 'me', action: 'call', toCall: 49, pot: 89, chips: 500 }],
      { settle: [{ id: 'me', net: -230 }, { id: '__ai__', net: 230 }] },
    );
    expect(review(hand, 0.5).net).toBe(-230);
  });

  it('该跟却弃了 → 同样判为失误（弃牌放弃的正 EV 就是亏损额）', () => {
    const hand = makeHand([{ street: 'river', id: 'me', action: 'fold', toCall: 49, pot: 89, chips: 500 }]);
    const out = review(hand, 0.6);
    const d = out.decisions[0];
    expect(d.verdict).toBe('mistake');
    // 0.6×138 − 49 = 33.8
    expect(d.evLoss).toBeCloseTo(33.8, 1);
  });

  it('差额小于阈值的边界决策不判失误——采样误差和范围假设撑不起"你打错了"这个结论', () => {
    // 0.48×200 − 100 = −4，小于 0.5bb（¥10），属于模糊地带
    const hand = makeHand([{ street: 'river', id: 'me', action: 'call', toCall: 100, pot: 100, chips: 500 }]);
    const out = review(hand, 0.48);
    expect(MISTAKE_THRESHOLD_BB * BIG_BLIND).toBe(10);
    expect(out.decisions[0].verdict).toBe('ok');
    expect(out.decisions[0].evLoss).toBe(0);
  });

  it('主动下注/加注/过牌不给对错结论，但仍然算出当时的胜率供参考', () => {
    const hand = makeHand([
      { street: 'flop', id: 'me', action: 'check', toCall: 0, pot: 40, chips: 980 },
      { street: 'river', id: 'me', action: 'raise', toCall: 49, pot: 89, chips: 500, raiseTo: 200 },
    ]);
    const out = review(hand, 0.55);
    expect(out.decisions.map(d => d.verdict)).toEqual(['unjudged', 'unjudged']);
    expect(out.decisions.every(d => d.equity === 0.55)).toBe(true);
    expect(out.totalEvLoss).toBe(0);
  });
});

describe('handReview — 上下文还原', () => {
  it('按 street 从最终公共牌还原出决策当时的桌面（不另存一份）', () => {
    const hand = makeHand([
      { street: 'preflop', id: 'me', action: 'call', toCall: 10, pot: 30, chips: 990 },
      { street: 'flop', id: 'me', action: 'check', toCall: 0, pot: 40, chips: 980 },
      { street: 'turn', id: 'me', action: 'check', toCall: 0, pot: 40, chips: 980 },
      { street: 'river', id: 'me', action: 'check', toCall: 0, pot: 40, chips: 980 },
    ]);
    const out = review(hand, 0.5);
    expect(out.decisions.map(d => d.board)).toEqual([
      [], BOARD.slice(0, 3), BOARD.slice(0, 4), BOARD.slice(0, 5),
    ]);
  });

  it('只复盘目标玩家的决策，对手的动作只当上下文', () => {
    const hand = makeHand([
      { street: 'river', id: '__ai__', action: 'raise', toCall: 0, pot: 40, chips: 900, raiseTo: 49 },
      { street: 'river', id: 'me', action: 'call', toCall: 49, pot: 89, chips: 500 },
    ]);
    const out = review(hand, 0.5);
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0].action).toBe('call');
  });

  it('已经弃牌的对手不再计入人数——多人桌用错人数会系统性高估胜率', () => {
    const hand = makeHand([
      { street: 'preflop', id: 'b', action: 'fold', toCall: 20, pot: 30, chips: 980 },
      { street: 'flop', id: 'me', action: 'call', toCall: 40, pot: 80, chips: 900 },
    ], { settle: [{ id: 'me' }, { id: 'b' }, { id: 'c' }] });
    const out = review(hand, 0.5);
    expect(out.decisions[0].numOpponents).toBe(1); // c 还在，b 已弃
  });

  it('面对下注时才收窄对手范围；无人下注时不假设对手更强', () => {
    const strategy = stubStrategy(0.5);
    const hand = makeHand([
      { street: 'flop', id: 'me', action: 'check', toCall: 0, pot: 40, chips: 980 },
      { street: 'river', id: 'me', action: 'call', toCall: 49, pot: 89, chips: 500 },
    ]);
    reviewHand(hand, { playerId: 'me', bigBlind: BIG_BLIND, strategy });
    expect(strategy.computeEquity.mock.calls[0][2].opponentRangePct).toBe(1);
    expect(strategy.computeEquity.mock.calls[1][2].opponentRangePct).toBeLessThan(1);
  });

  it('记录里没有这名玩家的底牌时如实返回不可复盘，不猜牌也不抛异常', () => {
    const hand = makeHand(
      [{ street: 'river', id: 'me', action: 'call', toCall: 49, pot: 89, chips: 500 }],
      { reveals: [{ id: '__ai__', holeCards: [{ raw: 'As' }, { raw: 'Ad' }] }] },
    );
    const out = review(hand, 0.5);
    expect(out.reviewable).toBe(false);
    expect(out.decisions).toEqual([]);
  });

  it('老记录没有 actions 字段（动作明细被 persist 裁掉）时同样安全返回', () => {
    const out = review(makeHand([], { actions: undefined }), 0.5);
    expect(out.reviewable).toBe(false);
  });
});
