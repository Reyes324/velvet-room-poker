import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { PveSession, AI_ID } = require('../PveSession');

// Deterministic stub injected via the constructor's `strategy` option, so
// hand-lifecycle tests don't depend on real probability sampling —
// pveStrategy's own math (band tables, equity, sizing/allin edge cases) is
// already covered by its own unit tests.
let fakeStrategy;
beforeEach(() => {
  fakeStrategy = {
    computeEquity: vi.fn(() => 0.5),
    pickAction: vi.fn(() => ({ action: 'check' })),
  };
});

function makeSession(opts = {}) {
  return new PveSession('me', 'Alice', { startingChips: 1000, bigBlind: 20, strategy: fakeStrategy, ...opts });
}

describe('PveSession — 初始化', () => {
  it('创建时双方各持初始筹码，人类是庄家（heads-up 庄家/小盲翻前先行动）', () => {
    const s = makeSession();
    expect(s.players).toEqual([
      { id: 'me', name: 'Alice', chips: 1000 },
      { id: AI_ID, name: '电脑', chips: 1000 },
    ]);
    expect(s.handNumber).toBe(1);
    expect(s.isAiTurn()).toBe(false);
    expect(s.actionPlayerId).toBe('me');
  });
});

describe('PveSession — humanAction', () => {
  it('轮到人类时可以正常行动', () => {
    const s = makeSession();
    const first = s.humanAction('call'); // legal — human acts first as dealer/SB
    expect(first.error).toBeUndefined();
  });

  it('已结束的这一手再行动应报错', () => {
    const s = makeSession();
    // Human (dealer/SB) folds preflop → heads-up instant fold-win, hand over.
    const r = s.humanAction('fold');
    expect(r.error).toBeUndefined();
    expect(s.isOver()).toBe(true);
    const after = s.humanAction('check');
    expect(after.error).toBe('这一手已经结束');
  });
});

describe('PveSession — aiAction', () => {
  it('不是 AI 回合时返回 null，不调用策略引擎', () => {
    const s = makeSession(); // human's turn first
    const r = s.aiAction();
    expect(r).toBeNull();
    expect(fakeStrategy.pickAction).not.toHaveBeenCalled();
  });

  it('轮到 AI 时调用策略引擎并执行返回的动作', () => {
    const s = makeSession();
    s.humanAction('call'); // human (dealer/SB) calls → action passes to AI (BB)
    expect(s.isAiTurn()).toBe(true);
    fakeStrategy.pickAction.mockReturnValue({ action: 'fold' });
    const r = s.aiAction();
    expect(r.decision.action).toBe('fold');
    expect(s.isOver()).toBe(true); // AI folding heads-up ends the hand immediately
  });

  it('AI 的加注决策会被换算成 raise(playerId, totalAmount) 真实执行，不是原样塞一个非法数字', () => {
    const s = makeSession();
    s.humanAction('call');
    fakeStrategy.pickAction.mockReturnValue({ action: 'raise', raiseTo: 60 });
    const r = s.aiAction();
    expect(r.result.error).toBeUndefined();
    expect(s.game.currentBet).toBe(60);
  });

  it('把上下文正确传给策略引擎：wasAggressor/facingRaise/对手读数', () => {
    const s = makeSession({ bigBlind: 20 });
    s.humanAction('call'); // human (SB/dealer) just calls the blind — not a real raise
    fakeStrategy.pickAction.mockReturnValue({ action: 'check' });
    s.aiAction(); // AI is BB, gets a free check option
    let call = fakeStrategy.pickAction.mock.calls[0][0];
    expect(call.wasAggressor).toBe(false); // nobody raised yet
    expect(call.facingRaise).toBe(false); // just a blind call, not a real raise
    expect(call.opponentAggressionRate).toBeNull(); // not enough sample yet
    expect(call.opponentFoldToRaiseRate).toBeNull();
  });

  it('对手统计只在样本量够时才生效（不会被前几手过拟合）', () => {
    const s = makeSession();
    // Play several hands where the human always raises when it's their
    // turn, to build up sample size in oppStats.
    for (let i = 0; i < 3; i++) {
      fakeStrategy.pickAction.mockReturnValue({ action: 'fold' }); // AI folds → hand ends fast
      s.humanAction('raise', 100);
      if (!s.isOver()) s.aiAction();
      if (s.isOver() && i < 2) s.readyNext();
    }
    fakeStrategy.pickAction.mockReturnValue({ action: 'check' });
    if (s.isAiTurn()) s.aiAction();
    const lastCall = fakeStrategy.pickAction.mock.calls.at(-1)[0];
    // 3 human actions total (raise/raise/raise) is still short of the >=8
    // totalActions threshold _opponentReads() requires for aggression rate.
    expect(lastCall.opponentAggressionRate).toBeNull();
  });

  it('AI 的 allin 决策会被换算成真正的 allIn() 调用', () => {
    const s = makeSession();
    s.humanAction('call');
    fakeStrategy.pickAction.mockReturnValue({ action: 'allin' });
    const r = s.aiAction();
    expect(r.result.error).toBeUndefined();
    expect(s.game.players.find(p => p.id === AI_ID).status).toBe('allin');
  });
});

describe('PveSession — readyNext / 结算与筹码结转', () => {
  it('这一手没结束时调用应报错', () => {
    const s = makeSession();
    const r = s.readyNext();
    expect(r.error).toBe('这一手还没结束');
  });

  it('结束后调用：庄家轮换、手数递增、双方筹码从上一手结转（不重置为初始值）', () => {
    const s = makeSession();
    s.humanAction('fold'); // human folds preflop as SB — loses the blind, AI wins the pot
    expect(s.isOver()).toBe(true);
    // s.players only re-syncs from the live engine at the next hand
    // boundary (by design — see _dealNewHand) — the authoritative live
    // total right after a hand ends is on s.game.players, same source
    // getStateForPlayer()/getPublicState() already read from for broadcast.
    const aiChipsAfterHand1 = s.game.players.find(p => p.id === AI_ID).chips;
    expect(aiChipsAfterHand1).toBeGreaterThan(1000); // AI won the folded blind

    const before = { dealerIndex: s.dealerIndex, handNumber: s.handNumber };
    const r = s.readyNext();
    expect(r.error).toBeUndefined();
    expect(s.dealerIndex).toBe(1 - before.dealerIndex);
    expect(s.handNumber).toBe(before.handNumber + 1);
    expect(s.players.find(p => p.id === AI_ID).chips).toBe(aiChipsAfterHand1); // carried over, not reset
  });

  it('归零的一方在下一手开始前自动补回初始筹码（单人模式没有借一底流程）', () => {
    const s = makeSession();
    // Force human to 0 chips directly on the live engine (simulating a
    // hand that busted them) rather than playing out a real all-in, which
    // isn't the point of this test.
    const humanGp = s.game.players.find(p => p.id === 'me');
    humanGp.chips = 0;
    s.humanAction('fold');
    expect(s.isOver()).toBe(true);
    s.readyNext();
    expect(s.players.find(p => p.id === 'me').chips).toBe(1000);
  });
});

describe('PveSession — 真实策略引擎跑完整局（烟雾测试，不注入假策略）', () => {
  it('用真实 pveStrategy 连续打 20 手，全程不抛异常、不产生非法动作、每手最终都能 showdown 或弃牌结束', () => {
    const s = new PveSession('me', 'Alice', { startingChips: 1000, bigBlind: 20 });
    for (let hand = 0; hand < 20; hand++) {
      let guard = 0;
      while (!s.isOver()) {
        guard += 1;
        if (guard > 200) throw new Error('hand did not terminate — possible infinite loop');
        if (s.isAiTurn()) {
          const r = s.aiAction();
          expect(r.result.error).toBeUndefined();
        } else {
          // Human just always calls/checks — the point of this test is AI
          // robustness, not human strategy.
          const toCall = s.game.currentBet - s.game.players.find(p => p.id === 'me').bet;
          const r = s.humanAction(toCall > 0 ? 'call' : 'check');
          expect(r.error).toBeUndefined();
        }
      }
      if (hand < 19) s.readyNext();
    }
  });
});
