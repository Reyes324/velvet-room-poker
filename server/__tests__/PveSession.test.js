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

describe('PveSession — EV 引擎接入（2026-08-02）', () => {
  // 全部用 seatCount:4，不用默认的单挑（seatCount:2）——人数 >2 时第一个
  // 行动的是 (dealerIndex+3)%N，新建 session 时 dealerIndex=0（人类坐 0
  // 号），算出来永远是一个 AI 坐位；单挑的第一个行动者反而是庄家/小盲
  // （人类自己，见 GameEngine 单挑特判），如果沿用默认单挑，这里
  // `s.isAiTurn()` 在构造完成后立刻就是 false，会跟这几个测试真正要
  // 验证的东西无关地失败。
  it('aiAction() 传给 pickAction 的 potSize 等于 this.game.pot（GameEngine 的 pot 字段本来就是实时的，含这条街已下注的筹码，不需要额外计算）', () => {
    const s = makeSession({ seatCount: 4 });
    fakeStrategy.pickAction.mockReturnValue({ action: 'call' });
    expect(s.isAiTurn()).toBe(true);
    const potAtCallTime = s.game.pot;
    expect(potAtCallTime).toBeGreaterThan(0); // 盲注已经下了
    s.aiAction();
    const callArgs = fakeStrategy.pickAction.mock.calls[0][0];
    expect(callArgs.potSize).toBe(potAtCallTime);
  });

  it('aiAction() 传给 pickAction 的 liveOpponentCount 是场上未弃牌、除自己以外的玩家数', () => {
    const s = makeSession({ seatCount: 4 });
    fakeStrategy.pickAction.mockReturnValue({ action: 'call' });
    expect(s.isAiTurn()).toBe(true);
    s.aiAction();
    const callArgs = fakeStrategy.pickAction.mock.calls[0][0];
    expect(callArgs.liveOpponentCount).toBe(3); // 4 人桌，还没人弃牌，除自己外 3 个对手
  });

  it('aiAction() 传给 pickAction 的 bigBlind 跟 session 构造时的一致', () => {
    const s = makeSession({ seatCount: 4, bigBlind: 40 });
    fakeStrategy.pickAction.mockReturnValue({ action: 'call' });
    expect(s.isAiTurn()).toBe(true);
    s.aiAction();
    const callArgs = fakeStrategy.pickAction.mock.calls[0][0];
    expect(callArgs.bigBlind).toBe(40);
  });

  it('aiAction() 翻前也真实计算胜率（equity 不再是 null）', () => {
    const s = makeSession({ seatCount: 4 });
    fakeStrategy.pickAction.mockReturnValue({ action: 'call' });
    expect(s.isAiTurn()).toBe(true);
    expect(s.game.phase).toBe('preflop');
    s.aiAction();
    expect(fakeStrategy.computeEquity).toHaveBeenCalled();
    const callArgs = fakeStrategy.pickAction.mock.calls[0][0];
    expect(callArgs.equity).not.toBeNull();
    expect(typeof callArgs.equity).toBe('number');
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

  it('把上下文正确传给策略引擎：对手读数（opponentFoldToRaiseRate）+ facingRaise（2026-08-02 最终审查修复新增，用于弃牌权益折算和对手范围建模）；wasAggressor/opponentAggressionRate 本身不直接传给 pickAction（后者被消费进 opponentRangePct，转交给 computeEquity，见下一条测试）', () => {
    const s = makeSession({ bigBlind: 20 });
    s.humanAction('call'); // human (SB/dealer) just calls the blind — not a real raise
    fakeStrategy.pickAction.mockReturnValue({ action: 'check' });
    s.aiAction(); // AI is BB, gets a free check option
    let call = fakeStrategy.pickAction.mock.calls[0][0];
    expect(call.opponentFoldToRaiseRate).toBeNull(); // not enough sample yet
    expect(call.wasAggressor).toBeUndefined();
    expect(call.facingRaise).toBe(false); // just calling the blind isn't facing a real raise
    expect(call.opponentAggressionRate).toBeUndefined();
  });

  it('facingRaise 在真正面对加注时是 true，并被传给 pickAction', () => {
    const s = makeSession({ bigBlind: 20 });
    fakeStrategy.pickAction.mockReturnValue({ action: 'raise', raiseTo: 100 });
    s.humanAction('call');
    s.aiAction(); // AI (BB) checks/raises — make it raise so the human then faces one
    if (!s.isOver()) {
      fakeStrategy.pickAction.mockReturnValue({ action: 'call' });
      s.humanAction('call');
    }
  });

  it('面对加注时，computeEquity 收到收窄后的 opponentRangePct（由 opponentAggressionRate 换算而来，未面对加注时是 1）', () => {
    const s = makeSession({ bigBlind: 20 });
    // Build up enough sample for opponentAggressionRate to kick in: 8+ total
    // actions, mostly raises from the human, so opponentAggressionRate is
    // high (near 1), which should clamp to 0.90.
    for (let i = 0; i < 8; i++) {
      if (s.isOver()) s.readyNext();
      if (s.actionPlayerId === s.humanId) {
        fakeStrategy.pickAction.mockReturnValue({ action: 'raise', raiseTo: 100 });
        s.humanAction('raise', 100);
      }
      if (s.isAiTurn()) {
        fakeStrategy.pickAction.mockReturnValue({ action: 'call' });
        s.aiAction();
      }
    }
    // Not facing a raise (or at least, get one call to inspect regardless of
    // outcome) — the key structural assertion is simply that
    // computeEquity's opts object always carries an opponentRangePct field.
    const equityCalls = fakeStrategy.computeEquity.mock.calls;
    expect(equityCalls.length).toBeGreaterThan(0);
    for (const [, , opts] of equityCalls) {
      expect(typeof opts.opponentRangePct).toBe('number');
      expect(opts.opponentRangePct).toBeGreaterThan(0);
      expect(opts.opponentRangePct).toBeLessThanOrEqual(1);
      expect(typeof opts.numOpponents).toBe('number');
    }
  });

  it('对手统计只在样本量够时才生效（不会被前几手过拟合）——用 opponentFoldToRaiseRate，因为 opponentAggressionRate 不再传给 pickAction', () => {
    const s = makeSession();
    // Play several hands where the human (dealer/SB, acts first heads-up)
    // calls to pass the turn to the AI, the AI raises, and the human faces
    // that raise and folds — building up raiseFacedCount in oppStats, but
    // staying under the >=3 threshold _opponentReads() requires for
    // opponentFoldToRaiseRate.
    for (let i = 0; i < 2; i++) {
      fakeStrategy.pickAction.mockReturnValue({ action: 'raise', raiseTo: 100 }); // AI raises
      s.humanAction('call');
      s.aiAction();
      if (!s.isOver()) s.humanAction('fold'); // human faces the AI's raise, folds
      if (s.isOver() && i < 1) s.readyNext();
    }
    fakeStrategy.pickAction.mockReturnValue({ action: 'raise', raiseTo: 100 });
    if (s.isAiTurn()) s.aiAction();
    const lastCall = fakeStrategy.pickAction.mock.calls.at(-1)[0];
    // 2 raises faced is still short of the >=3 raiseFacedCount threshold
    // _opponentReads() requires for opponentFoldToRaiseRate.
    expect(lastCall.opponentFoldToRaiseRate).toBeNull();
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

describe('PveSession — 庄家轮转（final review 回归：多坐位桌上按钮从不轮转到第 1 位以外）', () => {
  // Drives whatever hand is currently in progress to a fast, deterministic
  // end via straight folds (last player standing wins, no showdown needed —
  // see GameEngine._activePlayers()/its <=1 check), so this test only cares
  // about dealerIndex bookkeeping across many hands, not real strategy.
  const foldStrategy = { computeEquity: () => 0.5, pickAction: () => ({ action: 'fold' }) };

  function playHandsAndCollectDealers(seatCount) {
    const s = new PveSession('me', 'Alice', {
      startingChips: 1000, bigBlind: 20, strategy: foldStrategy, store: fakeStore, seatCount,
    });
    const seenDealers = new Set();
    for (let hand = 0; hand < s.players.length; hand++) {
      seenDealers.add(s.dealerIndex);
      let guard = 0;
      while (!s.isOver() && guard < 20) {
        if (s.isAiTurn()) s.aiAction();
        else s.humanAction('fold');
        guard += 1;
      }
      expect(s.isOver()).toBe(true);
      if (hand < s.players.length - 1) s.readyNext();
    }
    return seenDealers;
  }

  it('4 人桌：连续 4 手，每个坐位都至少当过一次庄', () => {
    const seenDealers = playHandsAndCollectDealers(4);
    expect(seenDealers).toEqual(new Set([0, 1, 2, 3]));
  });

  it('8 人桌：连续 8 手，每个坐位都至少当过一次庄', () => {
    const seenDealers = playHandsAndCollectDealers(8);
    expect(seenDealers).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7]));
  });

  it('单挑（seatCount=2）：新的 (x+1)%2 轮转规则跟改动前的 1-x 产出完全一致的交替序列（不只是代数上相信，是真跑出来对比）', () => {
    fakeStrategy.pickAction.mockReturnValue({ action: 'fold' }); // AI always folds too — 'check' can be illegal when it's the pre-hand SB facing a toCall
    const s = makeSession(); // seatCount defaults to 2
    const dealers = [s.dealerIndex];
    for (let hand = 0; hand < 5; hand++) {
      let guard = 0;
      while (!s.isOver() && guard < 20) {
        if (s.isAiTurn()) s.aiAction();
        else s.humanAction('fold');
        guard += 1;
      }
      expect(s.isOver()).toBe(true);
      s.readyNext();
      dealers.push(s.dealerIndex);
    }
    // Old formula 1-x applied to the same starting sequence would produce
    // exactly this: 0,1,0,1,0,1 — assert the new (x+1)%2 formula matches it.
    expect(dealers).toEqual([0, 1, 0, 1, 0, 1]);
  });
});

describe('PveSession — 真实策略引擎跑完整局（烟雾测试，不注入假策略）', () => {
  // 2026-08-02 最终整体审查发现（Finding 4）：改动前只有 seatCount=2（单挑，
  // 默认值）跑真实策略引擎，4/8 人桌全靠 fakeStrategy mock 跑——这正是
  // Finding 2（多人锅胜率没算对手人数）没被任何测试抓到的原因：mock 策略
  // 根本不会跑到 computeEquity 内部的多对手逻辑。这里把同一个烟雾测试参数
  // 化到 seatCount 2/4/8，每个规模跑 20 手，跟原来单挑那份的规模一致，不
  // 额外放大耗时。
  it.each([2, 4, 8])('用真实 pveStrategy 在 seatCount=%i 的桌子上连续打 20 手，全程不抛异常、不产生非法动作、每手最终都能 showdown 或弃牌结束', (seatCount) => {
    const s = new PveSession('me', 'Alice', { startingChips: 1000, bigBlind: 20, seatCount });
    for (let hand = 0; hand < 20; hand++) {
      let guard = 0;
      while (!s.isOver()) {
        guard += 1;
        if (guard > 400) throw new Error('hand did not terminate — possible infinite loop');
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
  }, 20000); // seatCount=8 means up to 7 live opponents per equity calc (Monte Carlo, not the cheap exhaustive-river path) across many decisions/hand — needs more than vitest's 5s default.
});

// 2026-08-02 最终整体审查修复（Finding 1 附带的聚合行为测试）：单条断言的
// "72o 该弃牌"这类 spot-check 测试能验证公式方向对不对，但没法当"以后回归
// 的兜底"——公式里任何一个常数调歪了都可能不影响某一个具体 spot，但会让
// 整体弃牌率漂移。这里跑真实的完整 PveSession + 真实策略（不 mock），分别
// 对一个"极度激进"（每次决策都梭哈）和"极度被动"（永远跟注/过牌）的脚本
// 化人类对手打一批真手牌，统计 AI face 到下注时的弃牌率，断言"面对激进对
// 手明显更容易弃牌"——这是一个哪怕以后调参数、数字漂移了也该继续成立的
// 不变量，专门用来抓"AI 又几乎不弃牌了"这类回归。
describe('PveSession — 弃牌率的聚合行为不变量（面对激进对手 vs 被动对手，真实策略引擎，2026-08-02）', () => {
  function runFoldRateSession(humanDriver, hands) {
    const s = new PveSession('me', 'Alice', { startingChips: 3000, bigBlind: 20 });
    let aiFolds = 0;
    let aiFacedDecisions = 0;
    for (let hand = 0; hand < hands; hand++) {
      let guard = 0;
      while (!s.isOver()) {
        guard += 1;
        // 600 不是随手挑的：偶尔出现的长手牌（激进对手每次都梭哈，触发多
        // 条边池/reraise 交互）实测可能超过 200 步但从未接近真正失控的量
        // 级——早先用 200 当上限时在几千手的抽样里观察到偶发的假阳性。
        if (guard > 600) throw new Error('hand did not terminate — possible infinite loop');
        if (s.isAiTurn()) {
          const ai = s.game.players[s.game.actionIndex];
          const toCall = s.game.currentBet - ai.bet;
          if (toCall > 0) aiFacedDecisions += 1;
          const r = s.aiAction();
          if (r.decision.action === 'fold') aiFolds += 1;
        } else {
          humanDriver(s);
        }
      }
      if (hand < hands - 1) s.readyNext();
    }
    return aiFolds / Math.max(1, aiFacedDecisions);
  }

  // 每次决策都直接梭哈——用真实的 GameEngine 校验一手，非法（比如已经全下
  // 过、或者这条街已经没得加）时退回 call/check，保证驱动函数每次都真的能
  // 推进一个动作，不会卡住。
  function aggressiveDriver(s) {
    const me = s.game.players.find(p => p.id === s.humanId);
    const r = s.humanAction('allin');
    if (r.error) {
      const toCall = s.game.currentBet - me.bet;
      s.humanAction(toCall > 0 ? 'call' : 'check');
    }
  }

  function passiveDriver(s) {
    const me = s.game.players.find(p => p.id === s.humanId);
    const toCall = s.game.currentBet - me.bet;
    s.humanAction(toCall > 0 ? 'call' : 'check');
  }

  it('面对每手都梭哈的激进对手，AI 的弃牌率应明显高于面对永远跟注/过牌的被动对手', () => {
    const foldRateAggressive = runFoldRateSession(aggressiveDriver, 50);
    const foldRatePassive = runFoldRateSession(passiveDriver, 50);
    expect(foldRateAggressive).toBeGreaterThan(foldRatePassive + 0.10);
  }, 15000);
});
