const { GameEngine } = require('./GameEngine');
const pveStrategy = require('./pveStrategy');
const { defaultStore, MAX_HAND_HISTORY } = require('./pveStore');

const AI_ID = '__ai__';
const AI_NAME = '电脑';

// One PveSession per solo game — deliberately NOT a Room and NOT held in
// RoomManager.rooms. MVP decision (design.md「新增：单人人机对战（PVE）
// 模式」): real players and AI never share a room, so this has to be
// structurally unable to intersect with the multiplayer state machine, not
// just "well-behaved" at runtime. It reuses GameEngine (the same
// dealing/betting/showdown logic every multiplayer hand already runs on) —
// the only new part is that the AI seat's actions come from pveStrategy
// instead of a socket message.
class PveSession {
  constructor(humanId, humanName, { startingChips = 1000, bigBlind = 20, strategy = pveStrategy, store = defaultStore } = {}) {
    this.humanId = humanId;
    this.aiId = AI_ID;
    this.startingChips = startingChips;
    this.bigBlind = bigBlind;
    // Injectable so tests can stub decisions without fighting CJS/ESM
    // module-mock interop — pveStrategy's own math is unit-tested
    // separately; this class only needs to prove it calls the strategy
    // correctly and executes whatever it returns.
    this.strategy = strategy;
    // Same injectable-for-tests reasoning as `strategy` above — see
    // pveStore.js. `humanId` doubles as the persistent cross-session key
    // (it's the client's `vr_playerId`, not a per-session id), so a
    // returning opponent on the same browser picks up right where their
    // profile/history left off instead of both resetting to zero every
    // session (用户反馈 2026-07-30：AI 应该"记住"这个对手一直以来的打法倾向).
    this.store = store;
    const saved = this.store.loadProfile(humanId);
    this.players = [
      { id: humanId, name: humanName, chips: startingChips, debt: 0 },
      { id: AI_ID, name: AI_NAME, chips: startingChips, debt: 0 },
    ];
    this.dealerIndex = 0;
    this.handNumber = 0;
    this.game = null;
    // 用户反馈（2026-07-28）：之前筹码归零直接补满、完全不留痕迹，导致整个
    // session 打完都不知道自己对电脑到底是赢是输——"电脑也算是一个玩家"，
    // 应该跟真人牌局一样：每次补满算一次新的买入（debt），最终盈亏 = 当前
    // 筹码 − 总买入，用同一套 LedgerModal/账本逻辑（见 RoomManager.rebuy）。
    this.handHistory = saved?.handHistory ?? [];
    // Running read on the human's tendencies — NOW persisted across
    // sessions/process restarts (not just within one session, as before
    // 2026-07-30), keyed by humanId via `store`. Gated behind a minimum
    // sample size in _opponentReads() below so early hands (no real signal
    // yet) don't overfit to noise.
    this.oppStats = saved?.oppStats ?? { totalActions: 0, raises: 0, raiseFacedCount: 0, foldsFacingRaise: 0 };
    // For the idle-session reaper (server/index.js) — same touch()
    // convention Room already uses, not a bare property poked from outside.
    this.lastActivityAt = Date.now();
    this._dealNewHand();
  }

  // Called by index.js once per completed hand (mirrors where
  // handHistory.push already happens) — persists the running opponent
  // profile and hand history so they survive a disconnect/process restart.
  // Trimming handHistory here (not just in pveStore.saveProfile) also caps
  // its in-memory size for long-running sessions, not just the on-disk copy.
  persist() {
    if (this.handHistory.length > MAX_HAND_HISTORY) {
      this.handHistory = this.handHistory.slice(-MAX_HAND_HISTORY);
    }
    this.store.saveProfile(this.humanId, { oppStats: this.oppStats, handHistory: this.handHistory });
  }

  touch() {
    this.lastActivityAt = Date.now();
  }

  _syncChipsFromGame() {
    if (!this.game) return;
    for (const p of this.players) {
      const gp = this.game.players.find(x => x.id === p.id);
      if (gp) p.chips = gp.chips;
    }
  }

  _dealNewHand() {
    this._syncChipsFromGame();
    // Solo mode still has no separate "borrow or leave" decision UI to
    // build (unlike multiplayer's 借一底 flow) — a bust just gets topped
    // back up automatically so the human can keep playing without
    // interrupting the session. But it DOES count as a real buy-in against
    // the ledger now, exactly like RoomManager.rebuy(): otherwise there's
    // no way to ever tell whether the human is actually up or down against
    // the AI across the session.
    for (const p of this.players) {
      if (p.chips <= 0) {
        p.debt = (p.debt || 0) + this.startingChips;
        p.chips = this.startingChips;
      }
    }
    if (this.handNumber > 0) this.dealerIndex = 1 - this.dealerIndex;
    this.handNumber += 1;
    this.game = new GameEngine(this.players, this.dealerIndex, this.bigBlind);
  }

  get actionPlayerId() {
    return this.game.players[this.game.actionIndex]?.id ?? null;
  }

  isOver() {
    return this.game.phase === 'showdown';
  }

  isAiTurn() {
    return !this.isOver() && this.actionPlayerId === this.aiId;
  }

  humanAction(action, amount) {
    if (this.isOver()) return { error: '这一手已经结束' };
    if (this.actionPlayerId !== this.humanId) return { error: '还没轮到你' };

    const idx = this.game.players.findIndex(p => p.id === this.humanId);
    const human = this.game.players[idx];
    const toCall = this.game.currentBet - human.bet;
    const facedRaise = this._facingRaise(this.game.phase, toCall);
    const result = this._dispatch(this.humanId, action, amount);
    if (!result.error) {
      this.oppStats.totalActions += 1;
      if (action === 'raise' || action === 'allin') this.oppStats.raises += 1;
      if (facedRaise) {
        this.oppStats.raiseFacedCount += 1;
        if (action === 'fold') this.oppStats.foldsFacingRaise += 1;
      }
    }
    return result;
  }

  _facingRaise(street, toCall) {
    // Preflop, "toCall" is at minimum the blind differential even with no
    // real raise yet — only count it as facing a raise once it's bigger
    // than just that. Postflop there's no blind, so any toCall>0 is a real
    // bet/raise.
    return street === 'preflop' ? toCall > this.bigBlind : toCall > 0;
  }

  // Only returns non-null once there's enough sample to mean anything —
  // early hands fall back to pveStrategy's un-adjusted tables (deltas of 0)
  // rather than overreacting to 2-3 data points.
  _opponentReads() {
    const { totalActions, raises, raiseFacedCount, foldsFacingRaise } = this.oppStats;
    return {
      opponentAggressionRate: totalActions >= 8 ? raises / totalActions : null,
      opponentFoldToRaiseRate: raiseFacedCount >= 3 ? foldsFacingRaise / raiseFacedCount : null,
    };
  }

  // Computes and executes exactly one AI decision. Callers (index.js's
  // socket layer, or a test) control the pacing between successive calls —
  // this class stays synchronous/timer-free so it's trivially unit
  // testable; the human-like "thinking" delay belongs to the transport
  // layer, not the decision engine.
  aiAction() {
    if (!this.isAiTurn()) return null;
    const aiIdx = this.game.players.findIndex(p => p.id === this.aiId);
    const ai = this.game.players[aiIdx];
    const toCall = this.game.currentBet - ai.bet;
    const street = this.game.phase;
    const board = this.game.communityCards;
    const equity = street === 'preflop'
      ? null // pickAction ignores equity preflop and uses preflopTier instead
      : this.strategy.computeEquity(ai.holeCards, board, { iterations: 300 });
    const position = aiIdx === this.game.dealerIndex ? 'ip' : 'oop';
    const wasAggressor = this.game.lastAggressorIndex === aiIdx;
    const facingRaise = this._facingRaise(street, toCall);
    const { opponentAggressionRate, opponentFoldToRaiseRate } = this._opponentReads();

    const decision = this.strategy.pickAction({
      street,
      holeCards: ai.holeCards,
      board,
      equity,
      toCall,
      potSize: this.game.pot,
      myChips: ai.chips,
      position,
      currentBet: this.game.currentBet,
      minRaiseTo: this.game.currentBet + this.game.lastRaiseAmount,
      opponentCeiling: this.game.maxTotalFor(this.aiId),
      wasAggressor,
      facingRaise,
      opponentAggressionRate,
      opponentFoldToRaiseRate,
    });

    const result = decision.action === 'raise'
      ? this._dispatch(this.aiId, 'raise', decision.raiseTo)
      : this._dispatch(this.aiId, decision.action);
    return { decision, result };
  }

  _dispatch(playerId, action, amount) {
    switch (action) {
      case 'fold':  return this.game.fold(playerId);
      case 'check': return this.game.check(playerId);
      case 'call':  return this.game.call(playerId);
      case 'raise': return this.game.raise(playerId, Number(amount));
      case 'allin': return this.game.allIn(playerId);
      default:      return { error: '未知操作' };
    }
  }

  readyNext() {
    if (!this.isOver()) return { error: '这一手还没结束' };
    this._dealNewHand();
    return { state: this.game.getPublicState() };
  }

  getStateForPlayer(playerId) {
    const state = this.game.getStateForPlayer(playerId);
    // Bug fix (用户反馈 2026-07-30): state.players[].chips is the LIVE
    // in-hand engine state (already net of this hand's posted blinds/bets —
    // correct for table rendering, where a stack visibly shrinks as you
    // bet). The ledger must NOT read chips from there: mid-hand, whatever's
    // currently sitting in this.game.pot is subtracted from both players'
    // live chips but isn't a real loss yet, so it looked like chips had
    // vanished (¥2000 total in, but live chips summed to less while a hand
    // was in progress). RoomManager avoids this the same way — its
    // getLobbyState() (ledger source) reads its OWN this.players, frozen at
    // hand boundaries by _syncChips, entirely separate from
    // getStateForPlayer() (live, for the table). Mirror that split here:
    // state.players stays live/untouched; the ledger gets its own field
    // sourced from this.players (only synced in _dealNewHand/_syncChipsFromGame).
    state.startingChips = this.startingChips;
    state.ledger = this.players.map(p => ({ id: p.id, name: p.name, chips: p.chips, debt: p.debt || 0 }));
    return state;
  }
}

module.exports = { PveSession, AI_ID };
