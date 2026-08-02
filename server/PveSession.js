const { GameEngine } = require('./GameEngine');
const pveStrategy = require('./pveStrategy');
const { STYLES } = pveStrategy;
const { defaultStore, MAX_HAND_HISTORY } = require('./pveStore');

const AI_ID = '__ai__'; // legacy single-AI id — kept exact for seatCount=2 (heads-up, the default)
const AI_NAME = '电脑';
// 多电脑对战新增（2026-08-02）：坐位名字池，风格对玩家不可见，名字本身
// 也刻意不带风格暗示（比如不叫"保守老K"），避免间接泄露。
const AI_NAME_POOL = ['老K', '赌神', '扑克脸', '幸运星', '黑桃A', '河神', '影子玩家', '常胜将军'];

// 从名字池里不放回地随机抽 count 个（count 是 AI 坐位数，最多 7，池子有
// 8 个，够用不重复）。
function pickAiNames(count, random) {
  const pool = [...AI_NAME_POOL];
  const picked = [];
  // Safety net, not a real code path today: seatCount is capped at 8 (7 AI
  // seats max) everywhere it's validated (server/index.js's
  // VALID_SEAT_COUNTS), and the name pool has exactly 8 entries, so
  // count > pool.length can't currently happen. Clamping here makes that
  // 8-name/7-seat coupling explicit rather than an assumption baked
  // silently into the loop below (which would otherwise push `undefined`
  // names once the pool ran dry).
  const safeCount = Math.min(count, pool.length);
  for (let i = 0; i < safeCount; i++) {
    const idx = Math.floor(random() * pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }
  return picked;
}

function pickRandomStyle(random) {
  return STYLES[Math.floor(random() * STYLES.length)];
}

// 单挑（seatCount===2，默认）保留改动前完全一致的行为：唯一的 AI 坐位
// id 是 AI_ID、name 是 AI_NAME、style 是 null（pickAction 收到 null 等价
// 于不调整，见 pveStrategy.js）。人数更多时才真正生成随机名字/风格的坐位。
function buildAiSeats(seatCount, random) {
  if (seatCount === 2) return [{ id: AI_ID, name: AI_NAME, style: null }];
  const count = seatCount - 1;
  const names = pickAiNames(count, random);
  return names.map((name, i) => ({
    id: `__ai_${i + 1}__`,
    name,
    style: pickRandomStyle(random),
  }));
}

// One PveSession per solo game — deliberately NOT a Room and NOT held in
// RoomManager.rooms. MVP decision (design.md「新增：单人人机对战（PVE）
// 模式」): real players and AI never share a room, so this has to be
// structurally unable to intersect with the multiplayer state machine, not
// just "well-behaved" at runtime. It reuses GameEngine (the same
// dealing/betting/showdown logic every multiplayer hand already runs on) —
// the only new part is that the AI seat's actions come from pveStrategy
// instead of a socket message.
class PveSession {
  constructor(humanId, humanName, {
    startingChips = 1000, bigBlind = 20, strategy = pveStrategy, store = defaultStore,
    seatCount = 2, random = Math.random,
  } = {}) {
    this.humanId = humanId;
    this.seatCount = seatCount;
    this.aiSeats = buildAiSeats(seatCount, random);
    this.aiSeatIds = new Set(this.aiSeats.map(seat => seat.id));
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
      ...this.aiSeats.map(seat => ({ id: seat.id, name: seat.name, chips: startingChips, debt: 0 })),
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
    // Mirrors Room.lastShowdown (RoomManager.js) — "stored for reconnection
    // during settlement wait". Without this, a human who closes/backgrounds
    // the tab mid-showdown (very easy to do: the settlement sheet only
    // appears ~1.4s after the hand ends, and a backgrounded mobile tab can
    // get discarded/reloaded well before that) comes back to a session
    // that's still sitting in the SAME finished hand (isOver() still true,
    // readyNext() never got called) — pve:start's resume path re-sends
    // game:state showing that state, but never re-fires game:showdown,
    // since that's normally only emitted once, at the moment the hand
    // actually ended. The client's game:state handler resets its own
    // showdown/settlement state on every broadcast (see PvePage.jsx), so
    // without a re-sent game:showdown the UI has nothing left to trigger
    // the settlement sheet — it sits on "正在比牌…" forever (user feedback,
    // 2026-07-31, screenshot). set in index.js's pveHandleResult when a
    // hand ends, cleared in _dealNewHand below when the next one starts.
    this.lastShowdown = null;
    // 翻牌后范围收窄（用户反馈的遗留项——之前 opponentRangePct 只按跨局累计
    // 的 opponentAggressionRate 算一次，同一手牌里对手连续几条街都下注/加
    // 注也不会让范围继续收窄）。按 AI 坐位记录"这手牌里、轮到它决策时，已
    // 经在哪些街面对过加注"，每手开局清空（_dealNewHand 里重置）——见
    // aiAction() 里的用法。
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
    this.lastShowdown = null;
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
    // Rotate the button through every seat (matches RoomManager's own
    // rotation: `(prevIdx + 1) % active.length`) — NOT the old `1 -
    // this.dealerIndex` heads-up-only toggle, which only ever flipped
    // between seats 0 and 1 and left every other seat (including,
    // sometimes, the human) never posting a blind on 4/6/8-seat tables.
    // For seatCount===2 this produces the exact same alternation as
    // before: (0+1)%2===1===1-0, (1+1)%2===0===1-1 — see
    // PveSession.test.js's dealer-rotation tests for a runtime proof, not
    // just this algebra.
    if (this.handNumber > 0) this.dealerIndex = (this.dealerIndex + 1) % this.players.length;
    this.handNumber += 1;
    this.game = new GameEngine(this.players, this.dealerIndex, this.bigBlind);
    this.handAggressionStreets = {};
  }

  get actionPlayerId() {
    return this.game.players[this.game.actionIndex]?.id ?? null;
  }

  isOver() {
    return this.game.phase === 'showdown';
  }

  isAiTurn() {
    return !this.isOver() && this.aiSeatIds.has(this.actionPlayerId);
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
    const actingId = this.actionPlayerId;
    const seat = this.aiSeats.find(s => s.id === actingId);
    const aiIdx = this.game.players.findIndex(p => p.id === actingId);
    const ai = this.game.players[aiIdx];
    const toCall = this.game.currentBet - ai.bet;
    const street = this.game.phase;
    const board = this.game.communityCards;
    const facingRaise = this._facingRaise(street, toCall);
    const liveOpponentCount = this.game.players.filter(
      p => p.id !== actingId && p.status !== 'folded',
    ).length;
    const { opponentFoldToRaiseRate, opponentAggressionRate } = this._opponentReads();
    // 对手范围建模（2026-08-02 最终审查修复）：只在真的面对加注时才收窄
    // computeEquity 模拟的对手范围——用真实观测到的 opponentAggressionRate
    // （没数据时默认 35%），不面对加注时范围不收窄（=1，AI 没有理由假设对
    // 手手牌比随机更强）。clamp 到 [0.10, 0.90] 防止极端样本把范围收窄/放
    // 宽到不合理的程度。
    const baseRangePct = Math.min(0.90, Math.max(0.10, opponentAggressionRate ?? 0.35));
    // 翻牌后继续收窄（用户反馈的遗留项）：上面那个 baseRangePct 只反映"跨
    // 局累计的整体激进程度"，同一手牌里如果对手连续几条街都在下注/加注
    // （常说的"barrel"），这通常意味着牌更强，范围应该比单纯翻前那一次判
    // 断更窄。这里按"这手牌里、轮到这个 AI 坐位时已经面对过加注的街数"做
    // 指数收窄——第一次面对加注（streak=1）不额外收窄，跟以前行为一致；
    // 之后每多一条街还在面对加注，再乘 0.75，同样 clamp 到 [0.10, 0.90]。
    let opponentRangePct = 1;
    if (facingRaise) {
      const streets = this.handAggressionStreets[actingId] ?? (this.handAggressionStreets[actingId] = new Set());
      streets.add(street);
      const narrowingFactor = 0.75 ** Math.max(0, streets.size - 1);
      opponentRangePct = Math.min(0.90, Math.max(0.10, baseRangePct * narrowingFactor));
    }
    // 翻前现在也算真实胜率（board=[]），不再走单独的起手牌分档表——见
    // docs/superpowers/specs/2026-08-02-pve-ev-driven-ai-design.md。
    const equity = this.strategy.computeEquity(ai.holeCards, board, {
      iterations: 300,
      opponentRangePct,
      numOpponents: Math.max(1, liveOpponentCount),
    });

    const decision = this.strategy.pickAction({
      street,
      equity,
      toCall,
      potSize: this.game.pot, // GameEngine adds every bet to .pot as it's placed (verified: it's already the true current pot, not just prior streets), no correction needed
      myChips: ai.chips,
      currentBet: this.game.currentBet,
      minRaiseTo: this.game.currentBet + this.game.lastRaiseAmount,
      opponentCeiling: this.game.maxTotalFor(actingId),
      liveOpponentCount,
      bigBlind: this.bigBlind,
      opponentFoldToRaiseRate,
      style: seat.style,
      facingRaise,
      // 感知噪声关闭（用户反馈 2026-08-03："能否还是理性一点不要加什么情
      // 绪了"）——2026-08-02 曾按用户当时的要求（"加一点随机色彩、加点情
      // 绪，让这个比较像人类"）开过，现在改回不传，pickAction 默认
      // noiseFraction=0，回到纯 EV 精确比较。机制本身（EV_NOISE_FRACTION
      // 常量、gaussianNoise 辅助函数）保留在 pveStrategy.js 里没有删——只是
      // 不在真实对局里启用了，以后想再开随时能重新传回去。
    });

    const result = decision.action === 'raise'
      ? this._dispatch(actingId, 'raise', decision.raiseTo)
      : this._dispatch(actingId, decision.action);
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
