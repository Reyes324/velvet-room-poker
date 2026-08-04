const { GameEngine } = require('./GameEngine');
const pveStrategy = require('./pveStrategy');
const { STYLES } = pveStrategy;
const { defaultStore, MAX_HAND_HISTORY } = require('./pveStore');

const AI_ID = '__ai__'; // legacy single-AI id — kept exact for seatCount=2 (heads-up, the default)
const AI_NAME = '电脑';
// 多电脑对战新增（2026-08-02）：坐位名字池，风格对玩家不可见，名字本身
// 也刻意不带风格暗示（比如不叫"保守老K"），避免间接泄露。
const AI_NAME_POOL = ['老K', '赌神', '扑克脸', '幸运星', '黑桃A', '河神', '影子玩家', '常胜将军'];

// 对手下注尺寸 -> 对手范围形状（组件 B，2026-08-03）。系数是相对既有
// "按加注频率算出来的基础宽度"的乘数：疯子的满池注和岩石的满池注含义不
// 同，那一层保留，这里只叠加"这一注有多重"这个信号。
//
// 系数按 baseRangePct 取默认值 0.35 时落到设计文档那张表来标定：
// ≤1/3 池 -> 前 60%（0.35×1.7）、~半池 -> 前 45%（0.35×1.3）、
// ~满池 -> 前 30%（0.35×0.85）。
const BET_SIZE_RANGE_FACTORS = [
  { maxRatio: 0.4, factor: 1.7 },
  { maxRatio: 0.8, factor: 1.3 },
  { maxRatio: 1.5, factor: 0.85 },
];
// 超过这个下注/底池比就按"两极化"建模，而不是继续单调收窄——真实德扑里
// 超池是"要么坚果要么纯诈唬"。只做单调收窄会让 AI 对超池过度弃牌，那是
// 另一种不真实（设计文档有实测数据）。
const OVERBET_RATIO = 1.5;
const OVERBET_TOP_PCT = 0.12;
const OVERBET_BOTTOM_PCT = 0.15;
// 会来跟我加注的人，牌力必然强于随机（组件 C）。取 min 是因为对手已经超
// 池施压时，还敢跟我再加的只会更强，不该反过来被放宽。
const CALLER_RANGE_PCT = 0.35;

// 持续施压 → 范围收窄。**两种施压强度不同，必须分开算**：
//
//  · BARREL（跨街）：翻牌下注、转牌又下注、河牌再下注。持续下注确实偏强，
//    但也可能是标准的持续下注/半诈唬，信号温和 → 0.75，沿用原值。
//  · RERAISE（同一条街内再加注）：3bet / 4bet / 5bet 战争。真实德扑里 4bet
//    基本就是 AA/KK/AK 级别，是**极强**信号 → 0.40。这个数字对齐真实德扑
//    的范围收窄比例（开池 ~20% → 3bet ~7% → 4bet ~2.5%，每级约 0.35-0.4 倍）。
//
// 2026-08-04 之前这两者被合并成「面对过加注的街的集合」，同一条街内的再加
// 注根本不计数（Set 里始终只有那一条街），导致 3bet/4bet 战争完全不收窄。
const BARREL_NARROWING = 0.75;
const RERAISE_NARROWING = 0.40;
// 范围下限。原值 0.10 是按街收窄时定的（最多 3-4 次，够用）；改成按次数计
// 数后深度能到 5-6 次，0.10 会成为瓶颈——实测收窄到第 5 次就被它挡住，加注
// 率纹丝不动。真实德扑 4bet 范围约 2-3%（AA/KK/AK），5bet 更窄，所以放到
// 0.03。已实测确认 computeEquity 的拒绝采样在 2-3% 宽度下趋势仍然正确。
const RANGE_PCT_FLOOR = 0.03;

// 同一手牌里允许的 AI 连续决策次数上限——超过即判定"牌局停止推进"并抛错。
// 见 aiAction() 里的说明：这是为了让残余的死循环自己暴露现场，而不是无限
// 空转把桌子冻死。8 人桌 × 4 条街、每街可多轮再加注，正常量级在几十次，
// 200 是有充足余量的上限。
const AI_DECISIONS_PER_HAND_LIMIT = 200;

function betSizeRangeFactor(ratio) {
  for (const { maxRatio, factor } of BET_SIZE_RANGE_FACTORS) {
    if (ratio <= maxRatio) return factor;
  }
  return 0.85;
}

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
    // 2026-08-04（Finding 6）：以前只在构造 aiSeats（名字/风格）时用了这个
    // 参数，之后每手牌的洗牌（GameEngine）、每次 AI 决策（computeEquity/
    // pickAction 内部的采样与感知噪声）都各自默认 Math.random，测试没法把
    // 一整手牌钉死成确定性的——这正是弃牌率不变量测试偶发失败的根因（被动
    // 对手弃牌率在 0.00~0.32 间摆动，样本量小，门槛留白被压缩）。存成
    // this.random，后面洗牌和策略调用都传同一个实例，测试注入一个 seeded
    // random 就能让整手牌（含发牌顺序和 AI 决策）逐位可复现。
    this.random = random;
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
    // 持续施压收窄：按 AI 坐位记录"这手牌里、轮到它决策时已经面对过多少次
    // 加注"，每手开局清空（_dealNewHand 里重置）——见 aiAction() 里的用法。
    // 2026-08-04 从「面对过加注的街的集合」改成「次数计数」，原因见那里的
    // 长注释（同一条街内的 3bet/4bet 战争原本完全不收窄）。
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
    this.game = new GameEngine(this.players, this.dealerIndex, this.bigBlind, this.random);
    this.handAggressionCount = {};
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
    // 不推进检测（2026-08-04）：2026-08-03 修掉了一个"零增量加注"导致牌桌
    // 永久冻结的 bug（见 tasks.md 69.23），但之后一次 15×200 的平衡回归里
    // 守卫又触发了一次——说明还有一条更罕见的路径没堵住，且多次尝试都没能
    // 稳定复现。与其继续盲猜，不如让程序自己抓：同一手牌里 AI 连续决策数
    // 超过上限就抛错并带上完整现场，而不是无限空转。
    //
    // 双重作用：(1) 线上真碰上时，玩家看到的是一个明确的错误而不是永久
    // 卡死的桌子；(2) 离线跑量（pveBalanceCheck/pvePreflopStats）能直接
    // 拿到"卡在哪一手、什么牌面、谁在行动、筹码多少"，不用再靠复现去猜。
    //
    // 上限依据：8 人桌 × 4 条街，每条街理论上可以多轮再加注，正常一手牌的
    // AI 决策数在几十次量级，200 留了充足余量——正常牌局绝不会碰到。
    if (this.handNumber !== this._aiDecisionHand) {
      this._aiDecisionHand = this.handNumber;
      this._aiDecisionCount = 0;
    }
    this._aiDecisionCount += 1;
    if (this._aiDecisionCount > AI_DECISIONS_PER_HAND_LIMIT) {
      const g = this.game;
      const actor = this.actionPlayerId;
      const p = g.players.find(x => x.id === actor);
      const seats = g.players
        .map(x => `${x.id}(chips=${x.chips},bet=${x.bet},${x.status})`)
        .join(' ');
      throw new Error(
        `PVE 牌局停止推进：第 ${this.handNumber} 手内 AI 已连续决策 ${this._aiDecisionCount} 次。`
        + ` phase=${g.phase} actor=${actor} currentBet=${g.currentBet} pot=${g.pot}`
        + ` toCall=${p ? g.currentBet - p.bet : 'n/a'} maxTotal=${g.maxTotalFor(actor)}`
        + ` seats=[${seats}]`,
      );
    }
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
    // 持续施压收窄：对手每多施压一次，他手里是强牌的可能性就更大，假设的
    // 范围就该更窄。
    //
    // 2026-08-04 修复（用户实测反馈"动不动 all in、3bet 尺度都挺大"）：这里
    // 原本用一个 Set 装「已经面对过加注的**街**」，同一条街内不管对手 3bet、
    // 4bet、5bet 多少次，Set 里始终只有那一条街、size 恒为 1、收窄系数恒为
    // 1.000——**同一条街内的再加注完全不收窄**。实测后果是一个正反馈死循环：
    //   面对开池 假设对手范围13% 加注率50%
    //   面对3bet 假设对手范围13%(没变) 加注率73%
    //   面对4bet 假设对手范围13%(没变) 加注率80%
    //   面对5bet 假设对手范围13%(没变) 加注率87%
    // 对手范围估计一路锁死不动，而底池越滚越大让加注的潜在收益越看越诱人，
    // 于是越打越激进，一路 6bet/7bet 打到全下。实测 3bet 频率占开池 75%
    // （真人 5-10%）、4bet 占 3bet 88%，翻后 all-in 率 37.9%，120 手里破产
    // 30 次——用户看到的"筹码差距上万"正是反复破产重买堆出来的。
    //
    // 改成按「面对加注的次数」计数：真实德扑里对手 4bet 基本就是 AA/KK/AK
    // 级别（2-3% 范围），必须随每一次再加注收窄。按次数计数天然同时涵盖了
    // 原来想要的跨街 barrel（每条街的下注各算一次），所以不需要再单独记街。
    let opponentRangePct = 1;
    let opponentBottomPct = 0;
    if (facingRaise) {
      // 分别累计「跨街施压」和「本街内再加注」，两者收窄强度不同（见常量注释）。
      const rec = this.handAggressionCount[actingId]
        ?? (this.handAggressionCount[actingId] = { streets: new Set(), street: null, reraises: 0 });
      if (rec.street !== street) { rec.street = street; rec.reraises = 0; }
      rec.streets.add(street);
      rec.reraises += 1;
      const narrowingFactor = (BARREL_NARROWING ** Math.max(0, rec.streets.size - 1))
        * (RERAISE_NARROWING ** Math.max(0, rec.reraises - 1));
      // 组件 B（2026-08-03）：把"对手下了多重"这个信号叠进来。改动前只看
      // 加没加注、不看多大，导致玩家超池和下 1/4 池在 AI 眼里是同一件事。
      //
      // 分母用 this.game.pot - toCall（下注前的底池），不是 this.game.pot 本
      // 身：this.game.pot 在这里读到的时候已经含了对手刚下的那注（GameEngine
      // 下注即入池，见上面 potSize 那行的注释），所以 toCall / this.game.pot
      // 数学上恒小于 1（toCall 是分子也是分母的一部分），OVERBET_RATIO=1.5
      // 这个阈值永远不可能触发——这是设计稿那版公式实测下来会踩的一个真实
      // 除零/量纲问题，这里改成"下注前的池子"作分母才是超池的真实定义
      // （下注额 / 下注前的池子 > 1 才叫超池）。
      //
      // 这个重建不是精确的，而且偏差不只是边界舍入误差（2026-08-03 code
      // review 指出）：翻牌后是精确的（这条街的下注在下注前都是 0，
      // pot - toCall 就等于真实的下注前底池）；但翻前面对第一次加注时，
      // 加注额本身会在代数上被约掉——不管 R 多大：
      //   potBeforeBet = pot_after - toCall
      //                = (30 + R - SB已投10) - (R - BB已投20)
      //                = 30 + (SB已投 - BB已投) = 30 + 10 = 40
      // 而真实的下注前底池是 30（大小盲之和）。也就是说翻前面对开局加注这
      // 个全场最高频的 AI 决策点，分母被系统性地高估了约 33%，跟加注金额
      // 无关，不是偶发的边界情况。后果：一个真实 betRatio=0.53（该落进
      // "≤0.8 → factor 1.3"档位）在这里会被算成 0.53×30/40≈0.40，反而落进
      // "≤0.4 → factor 1.7"档，让 AI 以为对手范围比实际更宽——对一次普通
      // 大小的翻前加注，档位判断整整错了一档。
      //
      // 这里选择接受这个偏差、不现在修：偏差方向对这一期的目标是保守的——
      // 分母被高估 → betRatio 被低估 → 推断出的对手范围偏宽 → 收窄得更
      // 少 → AI 弃牌更少，而这一期要解决的正是"AI 加注过头"，不是"AI 弃牌
      // 太多"，所以这个偏差不会削弱本期目标；真正的验收口径是下一个任务里
      // 对 VPIP/PFR 的实测数据，不是这行公式本身的精确度。要真正修好需要
      // 在每次下注动作发生时就地记录"下注前的真实底池快照"，而不是事后从
      // this.game.pot 反推——那是一次单独的设计改动，这里不顺手做。
      const potBeforeBet = this.game.pot - toCall;
      const betRatio = potBeforeBet > 0 ? toCall / potBeforeBet : (toCall > 0 ? Infinity : 0);
      if (betRatio > OVERBET_RATIO) {
        // 超池：两极化，不再是"前 X%"这种单调形状。
        opponentRangePct = OVERBET_TOP_PCT;
        opponentBottomPct = OVERBET_BOTTOM_PCT;
      } else {
        const sizeFactor = betSizeRangeFactor(betRatio);
        opponentRangePct = Math.min(0.90, Math.max(RANGE_PCT_FLOOR, baseRangePct * narrowingFactor * sizeFactor));
      }
    }
    // 翻前现在也算真实胜率（board=[]），不再走单独的起手牌分档表——见
    // docs/superpowers/specs/2026-08-02-pve-ev-driven-ai-design.md。
    const numOpponents = Math.max(1, liveOpponentCount);
    const equity = this.strategy.computeEquity(ai.holeCards, board, {
      iterations: 300,
      opponentRangePct,
      opponentBottomPct,
      numOpponents,
      random: this.random,
    });
    // 组件 C（2026-08-03）：加注分支要用"会来跟我的人"的范围重算一次胜率。
    // 实测多算一次约 +15ms，而 AI 每步本来就有 300ms 起的拟人思考延迟，占
    // 比约 5%，可忽略（见设计文档）。取 min 而不是固定 0.35：对手已经超池
    // 施压时，还敢跟我再加注的人只会更强，不该被放宽回 35%。这里刻意用单
    // 调形状而非两极化——愿意跟注的是对手范围里的强牌那一半，不是诈唬那
    // 一半。
    //
    // 2026-08-04 全面审查修复（Finding 2+3）：这次 computeEquity 调用刻意
    // 传 numOpponents:1，跟上面那次（对手范围）不一样，不是漏改。
    // computeEquity 内部对 numOpponents 个对手都从同一个收窄范围里抽牌
    // （见 pveStrategy.js 里的实现），上面那次调用的语义是"N 个对手各自
    // 可能有一手强于随机的牌"，N 份同源采样各自独立、互不冲突，没问题；
    // 但这次调用的语义是"其中有人跟注了我这个加注"——不是"全部 N 个人都
    // 跟注了"，只是至少一个。如果照旧传 numOpponents=liveOpponentCount，
    // 相当于建模成"N 个对手全都跟、且全都从同一个收窄到 callerRangePct 的
    // 强牌范围里抽牌"，人数越多，这些高牌范围之间互相"抢牌"（同一副牌里
    // 大牌本来就少）的效应越明显，实测在 seatCount=8（numOpponents=7）时
    // 会整个反过来：72o/32o 这类烂牌面对"7 人都是强范围"algorithm算出来
    // 的胜率反而比面对随机范围更高（.063→.079，.065→.089，8000 次迭代实
    // 测）——因为强范围彼此挤占大牌之后，对手实际持有的牌反而更容易跟这
    // 手烂牌的牌面重叠/形成较弱组合，这正好推翻了"跟注的人更强"这个前提要
    // 压制的东西。加上 potIfCalled 那边的口径（pveStrategy.js 里 evRaise
    // 的注释，Task/组件 A 起）本来就是"只有一个对手跟注了并把钱放进池
    // 子"，equityIfCalled 面对的对手数就该跟着变成 1，两边口径统一，"被跟
    // 注时池子和胜率算的是不是同一个跟注人数"不再对不上。上面那次
    // opponentRangePct 的计算保持不变，两次调用的差异只在这一个参数。
    const callerRangePct = Math.min(CALLER_RANGE_PCT, opponentRangePct);
    const equityIfCalled = this.strategy.computeEquity(ai.holeCards, board, {
      iterations: 300,
      opponentRangePct: callerRangePct,
      numOpponents: 1,
      random: this.random,
    });

    const decision = this.strategy.pickAction({
      street,
      equity,
      equityIfCalled,
      toCall,
      potSize: this.game.pot, // GameEngine adds every bet to .pot as it's placed (verified: it's already the true current pot, not just prior streets), no correction needed
      myChips: ai.chips,
      currentBet: this.game.currentBet,
      minRaiseTo: this.game.currentBet + this.game.lastRaiseAmount,
      opponentCeiling: this.game.maxTotalFor(actingId),
      // 底池投入承诺（2026-08-04）：对手在这手牌里已经投进去多少、身后还剩
      // 多少。投得越深越不可能弃牌——缺这一层时，「弃牌率 × 底池」这一项会
      // 随底池膨胀而膨胀，把深度加注战争推成正反馈（详见 pveStrategy.js 里
      // POT_COMMIT_PIVOT 的注释）。多个对手时取投入最深的那个：只要还有一个
      // 人已经陷进去了，靠加注把所有人吓跑就不现实。
      ...(() => {
        const others = this.game.players.filter(p => p.id !== actingId && p.status !== 'folded');
        if (!others.length) return {};
        const deepest = others.reduce((a, b) => (a.totalBet >= b.totalBet ? a : b));
        return { opponentCommitted: deepest.totalBet, opponentRemaining: deepest.chips };
      })(),
      liveOpponentCount,
      bigBlind: this.bigBlind,
      opponentFoldToRaiseRate,
      style: seat.style,
      facingRaise,
      random: this.random,
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
