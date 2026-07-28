const { GameEngine } = require('./GameEngine');
const pveStrategy = require('./pveStrategy');

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
  constructor(humanId, humanName, { startingChips = 1000, bigBlind = 20, strategy = pveStrategy } = {}) {
    this.humanId = humanId;
    this.aiId = AI_ID;
    this.startingChips = startingChips;
    this.bigBlind = bigBlind;
    // Injectable so tests can stub decisions without fighting CJS/ESM
    // module-mock interop — pveStrategy's own math is unit-tested
    // separately; this class only needs to prove it calls the strategy
    // correctly and executes whatever it returns.
    this.strategy = strategy;
    this.players = [
      { id: humanId, name: humanName, chips: startingChips },
      { id: AI_ID, name: AI_NAME, chips: startingChips },
    ];
    this.dealerIndex = 0;
    this.handNumber = 0;
    this.game = null;
    // Running read on the human's tendencies across the WHOLE session (not
    // reset per hand) — user feedback (2026-07-28) was that the AI played
    // "too easy to read"; part of the fix is having it actually adapt to
    // how this specific opponent plays, not just re-run the same static
    // tables forever. Gated behind a minimum sample size in
    // _opponentReads() below so early hands (no real signal yet) don't
    // overfit to noise.
    this.oppStats = { totalActions: 0, raises: 0, raiseFacedCount: 0, foldsFacingRaise: 0 };
    // For the idle-session reaper (server/index.js) — same touch()
    // convention Room already uses, not a bare property poked from outside.
    this.lastActivityAt = Date.now();
    this._dealNewHand();
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
    // Solo mode has no ledger/借一底 — a bust just gets topped back up so
    // the human can keep playing without a separate rebuy flow to build.
    for (const p of this.players) if (p.chips <= 0) p.chips = this.startingChips;
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
    return this.game.getStateForPlayer(playerId);
  }
}

module.exports = { PveSession, AI_ID };
