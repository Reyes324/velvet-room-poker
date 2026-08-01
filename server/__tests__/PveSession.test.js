import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { PveSession, AI_ID } = require('../PveSession');

// Deterministic stub injected via the constructor's `strategy` option, so
// hand-lifecycle tests don't depend on real probability sampling —
// pveStrategy's own math (band tables, equity, sizing/allin edge cases) is
// already covered by its own unit tests.
let fakeStrategy;
// Same reasoning as fakeStrategy — a no-op fake store keeps these tests from
// touching the real on-disk pveProfiles.json (pveStore.js has its own tests
// for the actual persistence behavior).
let fakeStore;
beforeEach(() => {
  fakeStrategy = {
    computeEquity: vi.fn(() => 0.5),
    pickAction: vi.fn(() => ({ action: 'check' })),
  };
  fakeStore = { loadProfile: vi.fn(() => null), saveProfile: vi.fn() };
});

function makeSession(opts = {}) {
  return new PveSession('me', 'Alice', { startingChips: 1000, bigBlind: 20, strategy: fakeStrategy, store: fakeStore, ...opts });
}

describe('PveSession — 对手画像/牌局历史跨会话持久化（用户反馈 2026-07-30）', () => {
  it('构造时用 store.loadProfile(humanId) 加载已有画像/历史，而不是从零开始', () => {
    fakeStore.loadProfile = vi.fn(() => ({
      oppStats: { totalActions: 10, raises: 5, raiseFacedCount: 4, foldsFacingRaise: 2 },
      handHistory: [{ handNumber: 1 }],
    }));
    const s = makeSession();
    expect(fakeStore.loadProfile).toHaveBeenCalledWith('me');
    expect(s.oppStats.totalActions).toBe(10);
    expect(s.handHistory).toEqual([{ handNumber: 1 }]);
  });

  it('store 没有该玩家的记录（新对手）时，回退到默认初始值，不抛异常', () => {
    const s = makeSession();
    expect(s.oppStats).toEqual({ totalActions: 0, raises: 0, raiseFacedCount: 0, foldsFacingRaise: 0 });
    expect(s.handHistory).toEqual([]);
  });

  it('persist() 用当前的 oppStats/handHistory 调用 store.saveProfile(humanId, ...)', () => {
    const s = makeSession();
    s.oppStats.totalActions = 3;
    s.handHistory.push({ handNumber: 1 });
    s.persist();
    expect(fakeStore.saveProfile).toHaveBeenCalledWith('me', {
      oppStats: s.oppStats,
      handHistory: s.handHistory,
    });
  });

  it('persist() 把内存里的 handHistory 也裁剪到最近 200 手，不是只在落盘时裁剪', () => {
    const s = makeSession();
    for (let i = 0; i < 210; i++) s.handHistory.push({ handNumber: i });
    s.persist();
    expect(s.handHistory.length).toBe(200);
    expect(s.handHistory[0].handNumber).toBe(10); // oldest 10 entries dropped
    expect(s.handHistory[199].handNumber).toBe(209);
  });
});

describe('PveSession — 初始化', () => {
  it('创建时双方各持初始筹码，人类是庄家（heads-up 庄家/小盲翻前先行动）', () => {
    const s = makeSession();
    expect(s.players).toEqual([
      { id: 'me', name: 'Alice', chips: 1000, debt: 0 },
      { id: AI_ID, name: '电脑', chips: 1000, debt: 0 },
    ]);
    expect(s.handNumber).toBe(1);
    expect(s.isAiTurn()).toBe(false);
    expect(s.actionPlayerId).toBe('me');
  });
});

describe('PveSession — 多电脑对战（2026-08-02 新增）', () => {
  it('不传 seatCount（默认）时，行为跟改动前完全一致：单个 AI 坐位，id 是 AI_ID，name 是"电脑"', () => {
    const s = makeSession();
    expect(s.aiSeats).toEqual([{ id: AI_ID, name: '电脑', style: null }]);
    expect(s.players).toEqual([
      { id: 'me', name: 'Alice', chips: 1000, debt: 0 },
      { id: AI_ID, name: '电脑', chips: 1000, debt: 0 },
    ]);
  });

  it('seatCount=4 时，有 3 个 AI 坐位，id/name 互不重复，每个都有一个合法的 style', () => {
    const { STYLES } = require('../pveStrategy');
    const s = makeSession({ seatCount: 4 });
    expect(s.aiSeats.length).toBe(3);
    const ids = s.aiSeats.map(seat => seat.id);
    const names = s.aiSeats.map(seat => seat.name);
    expect(new Set(ids).size).toBe(3);
    expect(new Set(names).size).toBe(3);
    for (const seat of s.aiSeats) {
      expect(STYLES).toContain(seat.style);
    }
    expect(s.players.length).toBe(4);
  });

  it('seatCount=8 时，有 7 个 AI 坐位', () => {
    const s = makeSession({ seatCount: 8 });
    expect(s.aiSeats.length).toBe(7);
    expect(s.players.length).toBe(8);
  });

  it('AI 坐位名字全部来自固定名字池', () => {
    const NAME_POOL = ['老K', '赌神', '扑克脸', '幸运星', '黑桃A', '河神', '影子玩家', '常胜将军'];
    const s = makeSession({ seatCount: 8 });
    for (const seat of s.aiSeats) {
      expect(NAME_POOL).toContain(seat.name);
    }
  });

  it('isAiTurn()/aiAction() 能连续处理多个 AI 坐位的行动，不会卡在同一个坐位', () => {
    // 'call' (not the default 'check') — the first actor in a 4-max hand
    // faces a real toCall (blind differential), and 'check' would be an
    // illegal action there (GameEngine.check() rejects it, game state
    // never advances, actionPlayerId never changes) — that would make this
    // loop spin on the same seat 20 times and fail the "no seat visited
    // twice" assertion below for the wrong reason. 'call' is always legal
    // regardless of toCall.
    fakeStrategy.pickAction.mockReturnValue({ action: 'call' });
    const s = makeSession({ seatCount: 4 });
    const aiIds = s.aiSeats.map(seat => seat.id);
    const actedIds = [];
    let guard = 0;
    while (s.isAiTurn() && guard < 20) {
      actedIds.push(s.actionPlayerId);
      s.aiAction();
      guard += 1;
    }
    expect(guard).toBeGreaterThan(0); // at least one AI seat had to act before control reaches the human
    expect(guard).toBeLessThan(20); // didn't get stuck looping
    expect(new Set(actedIds).size).toBe(actedIds.length); // no seat visited twice in this stretch
    for (const id of actedIds) expect(aiIds).toContain(id);
  });

  it('aiAction() 把行动坐位自己的 style 传给 strategy.pickAction()', () => {
    const s = makeSession({ seatCount: 4 });
    fakeStrategy.pickAction.mockClear();
    expect(s.isAiTurn()).toBe(true);
    const actingId = s.actionPlayerId;
    const actingSeat = s.aiSeats.find(seat => seat.id === actingId);
    s.aiAction();
    expect(fakeStrategy.pickAction).toHaveBeenCalledWith(
      expect.objectContaining({ style: actingSeat.style })
    );
  });

  it('多人桌摊牌结算：4 人桌打到 all-in 全下比牌，筹码总量守恒', () => {
    // Deterministic strategy: everyone shoves every action, forcing a fast
    // all-in showdown regardless of hole cards — proves settlement/side-pot
    // math (already covered generically by GameEngine's own tests) actually
    // gets exercised end-to-end through PveSession with >2 players.
    const allinStrategy = {
      computeEquity: () => 0.5,
      pickAction: () => ({ action: 'allin' }),
    };
    const s = new PveSession('me', 'Alice', {
      startingChips: 1000, bigBlind: 20, strategy: allinStrategy, store: fakeStore, seatCount: 4,
    });
    // Human also shoves.
    let guard = 0;
    while (!s.isOver() && guard < 50) {
      if (s.isAiTurn()) s.aiAction();
      else s.humanAction('allin');
      guard += 1;
    }
    expect(s.isOver()).toBe(true);
    const total = s.game.players.reduce((sum, p) => sum + p.chips, 0);
    expect(total).toBe(4 * 1000); // conserved regardless of who won the side pots
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

  it('归零的一方在下一手开始前自动补回初始筹码，且这次补回记一笔"买入"（单人模式没有借一底流程，但要能看出账本盈亏）', () => {
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
    expect(s.players.find(p => p.id === 'me').debt).toBe(1000);
    // AI didn't bust, so it never gets a debt entry.
    expect(s.players.find(p => p.id === AI_ID).debt).toBe(0);
  });

  it('getStateForPlayer 带上 startingChips 和 ledger（每个玩家的 chips/debt，用手数边界冻结的快照，不是牌局中的实时筹码），供客户端账本直接用', () => {
    const s = makeSession();
    const humanGp = s.game.players.find(p => p.id === 'me');
    humanGp.chips = 0;
    s.humanAction('fold');
    s.readyNext();
    const state = s.getStateForPlayer('me');
    expect(state.startingChips).toBe(1000);
    expect(state.ledger.find(p => p.id === 'me').debt).toBe(1000);
    expect(state.ledger.find(p => p.id === 'me').chips).toBe(1000);
    expect(state.ledger.find(p => p.id === AI_ID).debt).toBe(0);
  });

  it('getStateForPlayer 的 ledger 用手数边界快照，不受本手已下注的盲注/加注影响（回归：之前用实时筹码导致账本"盈亏总和不为 0"）', () => {
    const s = makeSession();
    // Blinds have already been posted into s.game.players[].chips for the
    // NEW hand (post-readyNext), but s.players (ledger source) shouldn't
    // move until the hand ends and _dealNewHand() re-syncs it.
    const state = s.getStateForPlayer('me');
    const totalLedgerChips = state.ledger.reduce((sum, p) => sum + p.chips, 0);
    expect(totalLedgerChips).toBe(2000); // 2x startingChips, blinds notwithstanding
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
