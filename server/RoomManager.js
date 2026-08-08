const { GameEngine } = require('./GameEngine');

const STARTING_CHIPS = 1000;
const BIG_BLIND = 20;
const POKE_COOLDOWN_MS = 2000;

function randomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

class Room {
  constructor(hostId, hostName) {
    let code;
    do { code = randomCode(); } while (false); // uniqueness checked by RoomManager
    this.code = code;
    this.hostId = hostId;
    this.players = [{ id: hostId, name: hostName, chips: STARTING_CHIPS, socketId: null, debt: 0, connected: true, left: false }];
    this.game = null;       // GameEngine instance when in progress
    // Tracked by player id (not array index) so the button reliably lands on
    // "whoever sits after the previous dealer" even when the roster's size or
    // order changes between hands (mid-game joins, busted players dropping
    // out) — a raw index recomputed against a freshly-filtered array would
    // otherwise jump non-adjacently whenever the active set changes shape.
    this.dealerId = hostId;
    this.status = 'waiting'; // waiting | playing
    this.settlementWait = null; // { eligiblePlayerIds, readyPlayerIds } while waiting for post-showdown acks
    // True between a hand ending and every busted (chips===0, not left)
    // player having resolved their rebuy-or-leave decision — see
    // server/index.js's tryAdvanceIfClear. While true, nextRound() is
    // deliberately not called, so the room stays on the table instead of
    // snapping back to the lobby the instant someone busts.
    this.awaitingBustResolution = false;
    this.lastShowdown = null; // Last showdown data, stored for reconnection during settlement wait
    this.pokeCooldowns = new Map(); // `${fromId}→${targetId}` -> last-poke timestamp (ms)
    // Per-hand result log for this session ("牌局记录") — result summary
    // only (community cards, who won what, how), not a full action replay.
    // In-memory like everything else in Room; cleared by restart() along
    // with chips/debt (a fresh night), but NOT by the host's "结束游戏"
    // (which deliberately keeps the session's numbers intact).
    this.handHistory = [];
    // Idle-expiry bookkeeping (see RoomManager.sweepIdleRooms) — updated by
    // touch() on essentially every successful room event. Deliberately NOT
    // touched by a disconnect itself (that's the absence of activity, not
    // an instance of it).
    this.lastActivityAt = Date.now();
    // Optional session timer ("计时游戏") — null means untimed, same as
    // plain "开始游戏". Absolute timestamp (not a duration) so every
    // client just diffs against its own Date.now(), no server round-trip
    // needed to keep a countdown ticking, and no clock-drift accumulation
    // from repeatedly re-deriving "time left" from a stored duration.
    this.gameTimerEndsAt = null;
    // True from the moment the timer expires until the host picks 结束对局
    // or 忽略继续 — checked in server/index.js's tryAdvanceIfClear, which
    // only ever runs at a real hand boundary (after settlement wait
    // resolves, or after a bust-pause clears), so this can never interrupt
    // a hand that's still in progress — the current hand always finishes
    // first, by construction, not by an extra timing check.
    this.awaitingTimerDecision = false;
    // 当前回合的倒计时：{ playerId, endsAt }。endsAt 是**绝对时间戳**，跟
    // gameTimerEndsAt 同样的理由——客户端拿自己的 Date.now() 一减就能显示
    // 倒计时，不用问服务端，也不会因反复从时长推算而累积漂移。
    //
    // 刻意**不参考 connected**：倒计时问的是"有没有在时限内行动"，而切后台
    // 的人、断线的人、发呆的人都不会行动，结果本就相同。断线判定（socket.io
    // 默认 25s/20s 心跳，手机锁屏/切后台会误判）在这里没有任何作用，只会多
    // 一个可能出错的输入。见 design.md 同名章节。
    this.turnClock = null;
  }

  touch() {
    this.lastActivityAt = Date.now();
  }

  // Returns { ok: true, id } — `id` is the ACTUAL identity now associated
  // with this socket, which may differ from the `id` passed in (see the
  // nickname-fallback branch below). The caller (RoomManager.join) must use
  // this returned id, not the one it was given, for the playerRoom mapping
  // and the room:joined response — the client already treats whatever
  // playerId comes back over the wire as authoritative and overwrites its
  // own localStorage with it (HomePage.jsx's room:joined handler), so no
  // client changes were needed for this.
  addPlayer(id, name, socketId) {
    // Same playerId (browser-local token — survives an explicit "退出房间",
    // only the room-code half of localStorage gets cleared client-side)
    // rejoining a room they'd previously left, OR reconnecting after a mere
    // disconnect (network drop, backgrounded tab): reactivate their
    // existing row instead of rejecting them as a duplicate, so their
    // chips/debt/hand-history association comes back instead of being
    // orphaned. Only reject when the row is BOTH still marked present
    // (`!left`) AND still actively connected — that's the only state a
    // second join with the same id could mean a genuine duplicate session,
    // mirroring the connected-check the name-fallback branch below already
    // relies on.
    const existing = this.players.find(p => p.id === id);
    if (existing) {
      if (!existing.left && existing.connected !== false) return { error: '已在房间内' };
      existing.left = false;
      existing.connected = true;
      existing.socketId = socketId;
      existing.name = name;
      return { ok: true, id: existing.id };
    }
    // No playerId match — most commonly a different browser/app on the
    // same physical device (e.g. WeChat's in-app browser vs. the phone's
    // own browser have entirely separate localStorage, so vr_playerId
    // never carries over). Fall back to name-based reclaiming, but ONLY
    // of a row that's currently OFFLINE (`connected === false`) — a row
    // still connected is never touched, no matter how it got there or how
    // long it's been idle. This is the one guard that makes name-matching
    // safe here: an identity can only ever be held by one connected
    // socket at a time, so a second device can never silently displace a
    // first one that's still actually present (confirmed safe against two
    // real people typing the same name too — Node's single-threaded event
    // loop processes joins one at a time, so by the time a second
    // simultaneous join is handled, the first has already flipped
    // connected:true and this branch no longer matches it).
    const sameName = this.players.find(p => p.name === name && p.connected === false);
    if (sameName) {
      sameName.left = false;
      sameName.connected = true;
      sameName.socketId = socketId;
      return { ok: true, id: sameName.id };
    }
    if (this.players.length >= 9) return { error: '房间已满，无法加入' };
    this.players.push({ id, name, chips: STARTING_CHIPS, socketId, debt: 0, connected: true, left: false });
    return { ok: true, id };
  }

  // Only a busted (chips === 0) player can rebuy — independent of room
  // status, so someone who busts mid-game in a 3+ player table isn't stuck
  // waiting for the whole room to end before they can buy back in.
  rebuy(playerId) {
    const p = this.players.find(p => p.id === playerId);
    if (!p) return { error: '玩家不存在' };
    if (p.chips !== 0) return { error: '筹码充足，无需借入' };
    p.chips += STARTING_CHIPS;
    p.debt = (p.debt || 0) + STARTING_CHIPS;
    // nextRound() unconditionally re-syncs room.players' chips FROM
    // this.game.players every time it runs, including when a rebuy is
    // exactly what just cleared a bust-wait pause — without also writing
    // through to the (still-referenced, already-finished-hand) game
    // engine's own copy here, that resync would clobber the rebuy right
    // back down to 0 using the old pre-rebuy chip count.
    const gp = this.game?.players.find(gp => gp.id === playerId);
    if (gp) gp.chips = p.chips;
    return { ok: true };
  }

  // 归零之后的第三个选择——旁观留下，不借钱也不退出。跟 rebuy/markLeft 一
  // 样解除 index.js 的 awaitingBustResolution 暂停（房间不会被他晾在那
  // 儿），但既不加筹码也不动 left。之后这个人自然落进 nextRound() 的
  // chips>0 过滤之外（他本来就是 0），跟"中途加入还没赶上"是同一条旁观展
  // 示路径，界面上不区分。
  spectate(playerId) {
    const p = this.players.find(p => p.id === playerId);
    if (!p) return { error: '玩家不存在' };
    if (p.chips !== 0) return { error: '筹码充足，无需旁观' };
    p.bustResolved = true;
    return { ok: true };
  }

  // Was removePlayer(id) — deleted the row outright, which silently wiped
  // that player's chips/debt from the shared ledger the moment they left
  // (confirmed by user feedback: the ledger is meant to be the group's
  // real-money settlement record, not just a live scoreboard). Marking
  // `left` instead keeps their final numbers visible in 账本 forever, and
  // just excludes them from anything seating-related (dealt hands, the
  // lobby's open-seat count, host handoff).
  markLeft(id) {
    const p = this.players.find(p => p.id === id);
    if (!p) return;
    p.left = true;
    if (this.hostId === id) {
      const next = this.players.find(p => !p.left);
      if (next) this.hostId = next.id;
    }
    if (this.settlementWait) {
      this.settlementWait.eligiblePlayerIds.delete(id);
    }
  }

  // Purely social — no game-state effect. Cooldown is keyed by the ordered
  // pair so A repeatedly poking B doesn't also throttle A poking C, or B
  // poking A back.
  poke(fromId, targetId) {
    if (fromId === targetId) return { error: '不能拍自己' };
    const key = `${fromId}→${targetId}`;
    const last = this.pokeCooldowns.get(key);
    if (last && Date.now() - last < POKE_COOLDOWN_MS) return { error: '拍得太快了' };
    this.pokeCooldowns.set(key, Date.now());
    return { ok: true };
  }

  updateSocket(playerId, socketId) {
    const p = this.players.find(p => p.id === playerId);
    if (p) p.socketId = socketId;
  }

  // Explicit connection-status flag, separate from `socketId` (which is
  // never cleared on disconnect and so doesn't reflect live status). Set
  // false on disconnect, true on room:create/room:join/room:sync — see
  // server/index.js.
  setConnected(playerId, connected) {
    const p = this.players.find(p => p.id === playerId);
    if (p) p.connected = connected;
  }

  // 标记断线，但只在 socketId 仍然是该玩家当前连接时才生效；返回是否真的
  // 标记了，调用方据此决定要不要广播。
  //
  // 用户反馈 #9「其他玩家断线的提示好频繁，确定玩家是真的断线了吗」的根
  // 因：socket.io 靠 ping 超时发现死连接，旧 socket 的 disconnect 可能在
  // 客户端已经用新 socket 重连**之后**才姗姗来迟。无条件 setConnected
  // (false) 会把刚建立的活连接覆盖掉，全桌于是看到一个正在正常打牌的人显
  // 示"断线中"。手机上尤其频繁：微信切出去、iOS 切后台、WiFi↔蜂窝切换，
  // 每次都是一轮断开+重连。
  //
  // 同样的"这个 socket 还是当前那个吗"检查，本项目已经在另外两处做了：
  // server/index.js 的 PVE 路径（pveActiveSocket）和大厅宽限期移除定时器
  // （player.socketId === deadSocketId）。这里补上第三处。
  markDisconnectedIfCurrent(playerId, socketId) {
    const p = this.players.find(p => p.id === playerId);
    if (!p) return false;
    // socketId 为空表示没有任何活连接记录，这时按真实断线处理——不能因为
    // 记录缺失就永远不标记（否则这个防护会变成"再也不显示断线"）。
    if (p.socketId && p.socketId !== socketId) return false;
    p.connected = false;
    return true;
  }

  // durationMinutes: null/omitted → untimed (plain "开始游戏"); a number →
  // "计时游戏", room.gameTimerEndsAt is set to that many minutes from now.
  startGame(durationMinutes = null) {
    const seated = this.players.filter(p => !p.left);
    if (seated.length < 2) return { error: '至少需要2名玩家' };
    if (this.status !== 'waiting') return { error: '游戏已在进行中' };
    this.status = 'playing';
    const idx = seated.findIndex(p => p.id === this.dealerId);
    const dealerIndex = idx === -1 ? 0 : idx;
    this.dealerId = seated[dealerIndex].id;
    this.game = new GameEngine(seated, dealerIndex, BIG_BLIND);
    this.clearTurnClock();
    this.gameTimerEndsAt = durationMinutes ? Date.now() + durationMinutes * 60_000 : null;
    this.awaitingTimerDecision = false;
    return { ok: true };
  }

  // Sync chips from the (just-finished) game engine back onto the room's
  // own player records — keeps busted players' rows around at chips===0
  // for rebuy instead of dropping them. Split out from nextRound() because
  // index.js's tryAdvanceIfClear needs this to have already happened
  // *before* it decides whether nextRound() should even be called — chips
  // dropping to 0 is exactly the condition it's checking for, and checking
  // stale (pre-sync) values silently never caught anyone busting (confirmed
  // the hard way: a live test only passed because the bust-pause it was
  // meant to exercise never actually engaged).
  syncChipsFromGame() {
    for (const rp of this.players) {
      const gp = this.game?.players.find(p => p.id === rp.id);
      if (!gp) continue;
      // 刚从有筹码变成 0——这是一次新的归零，之前那次的"旁观留下"决定不能
      // 沿用到这一次（否则借回筹码又打光之后，会直接跳过决策弹窗）。只在
      // 这个 >0→0 的瞬间重置，chips 本来就是 0 或者还 >0 都不动它。
      if (rp.chips > 0 && gp.chips === 0) rp.bustResolved = false;
      rp.chips = gp.chips;
    }
  }

  nextRound() {
    this.syncChipsFromGame();
    // Only active (chips > 0, hasn't left) players enter the next hand —
    // this already naturally picks up anyone who joined mid-game, just
    // rebought, or just reconnected, since it's filtered fresh from the
    // full room roster every time, not carried over from the previous
    // hand's player list.
    //
    // Deliberately NOT gated on `connected` (used to be — see git history
    // and design.md's "Bug C 确认根因并修复" for the full story). A mobile
    // WebSocket disconnect (screen lock, backgrounding — routine on a PWA)
    // is common enough that in a 3-handed game, two players flickering
    // offline at exactly the moment a hand ends was enough to drop the
    // online count below 2 and wrongly end the whole session with a
    // misleading "筹码不足" message, even though nobody had actually
    // busted. This was the ONE place in the codebase still treating a
    // disconnect as equivalent to elimination — everywhere else (a
    // disconnected player's own turn, settlement-wait acks) already
    // follows "断线只标记 connected:false，不推动游戏状态": a disconnected
    // player whose turn comes up just gets picked up by the existing
    // 5-minute pause-timeout (auto-fold) or the host's manual "帮TA弃牌",
    // the same safety net a mid-hand disconnect already relies on — there
    // was never a need to also exclude them here.
    const active = this.players.filter(p => p.chips > 0 && !p.left);
    if (active.length < 2) {
      this.status = 'waiting';
      this.game = null;
      return { ended: true, reason: '筹码不足，等待玩家买入后重新开始' };
    }
    // Move the button to the seat after the previous dealer, found by id in
    // the freshly-filtered array. If that player busted out (or otherwise
    // isn't active this hand), fall back to seat 0 rather than guessing.
    const prevIdx = active.findIndex(p => p.id === this.dealerId);
    const dealerIndex = prevIdx === -1 ? 0 : (prevIdx + 1) % active.length;
    this.dealerId = active[dealerIndex].id;
    this.game = new GameEngine(active, dealerIndex, BIG_BLIND);
    this.clearTurnClock();
    return { ok: true };
  }

  // The one place that actually clears the session's history — chips,
  // debt (accumulated rebuys), and anyone who'd left all reset, since a
  // restart is explicitly "start a fresh night", unlike a player leaving
  // mid-session (markLeft), which deliberately keeps their final numbers
  // on the ledger.
  restart() {
    for (const p of this.players) { p.chips = STARTING_CHIPS; p.debt = 0; p.left = false; }
    this.status = 'waiting';
    this.game = null;
    this.awaitingBustResolution = false;
    this.handHistory = [];
    this.gameTimerEndsAt = null;
    this.awaitingTimerDecision = false;
    this.dealerId = this.players.find(p => !p.left)?.id ?? null;
  }

  // ─── post-showdown "wait for everyone to ack" state ───────────────────────
  // Owned here (like `game`/`status`/`dealerId`) rather than as an ad-hoc
  // property set from outside — index.js only decides *when* to advance
  // (the fallback timer) and broadcasts the result; the ready-tracking data
  // itself belongs to the room.

  // displayMs：结算画面展示多久后自动推进。存成**绝对时间戳**而不是时长，
  // 跟 gameTimerEndsAt 同样的理由——每个客户端拿自己的 Date.now() 一减就
  // 能显示倒计时，不用来回问服务端，也不会因为反复从时长重新推算而累积漂移。
  beginSettlementWait(displayMs = null) {
    this.settlementWait = {
      endsAt: displayMs == null ? null : Date.now() + displayMs,
      // `!p.left` 是必须的：socketId 按设计永不清除（见 setConnected 上方
      // 的注释），而 leave() 只把 left 置 true——只筛 socketId 的话，一个
      // 已经点了"退出房间"、人已经回到首页的玩家仍会被算作"还需要点确认
      // 的人"，而他永远不会再点。在无条件超时推进落地之前，这会让整桌永久
      // 卡死（旧的兜底定时器只在名单里有人被标成断线时才启动，而主动退出
      // 的人 socket 往往还活着，connected 仍是 true）。
      eligiblePlayerIds: new Set(this.players.filter(p => p.socketId && !p.left).map(p => p.id)),
      readyPlayerIds: new Set(),
    };
  }

  isAwaitingSettlementAck() {
    return this.settlementWait !== null;
  }

  // Records that a player has acked. Returns true if everyone currently
  // eligible has now acked (caller should advance the round).
  ackReady(playerId) {
    if (!this.settlementWait) return false;
    this.settlementWait.readyPlayerIds.add(playerId);
    return this._allSettlementAcksIn();
  }

  // Removes a departing player from the eligible set (e.g. on disconnect)
  // so they can't block the room forever. Returns true if everyone
  // remaining has now acked.
  dropFromSettlementWait(playerId) {
    if (!this.settlementWait) return false;
    this.settlementWait.eligiblePlayerIds.delete(playerId);
    return this._allSettlementAcksIn();
  }

  clearSettlementWait() {
    this.settlementWait = null;
    this.revealedPlayerIds = null;
  }

  // Real per-player ack progress for the settlement modal's "等待其他人确认
  // (X/Y)" — was previously faked client-side as "am I ready: 1 or 0", which
  // never reflected who else had actually acked.
  getSettlementProgress() {
    if (!this.settlementWait) return null;
    const { eligiblePlayerIds, readyPlayerIds, endsAt } = this.settlementWait;
    return { readyCount: readyPlayerIds.size, totalCount: eligiblePlayerIds.size, endsAt };
  }

  _allSettlementAcksIn() {
    const { eligiblePlayerIds, readyPlayerIds } = this.settlementWait;
    return [...eligiblePlayerIds].every((id) => readyPlayerIds.has(id));
  }

  // The id of whoever's turn it currently is, or null if no hand is in
  // progress. Cross-references GameEngine's own actionIndex — GameEngine
  // doesn't know about room-level connection status, so this is the seam
  // between "whose turn is it" (GameEngine) and "are they actually here"
  // (Room).
  getActionPlayerId() {
    if (!this.game) return null;
    return this.game.players[this.game.actionIndex]?.id ?? null;
  }

  // Shared by the host's manual "帮TA弃牌" button and the system safety
  // timeout (see server/index.js maybeArmPauseTimer) — the only difference
  // between those two callers is who's allowed to trigger it, not what
  // happens once triggered, so both funnel through here.
  resolveDisconnectedTurn(targetId) {
    if (!this.game) return { error: '游戏未开始' };
    const target = this.players.find(p => p.id === targetId);
    if (!target || target.connected !== false) return { error: '该玩家未处于断线状态' };
    if (this.getActionPlayerId() !== targetId) return { error: '还没轮到该玩家' };
    return this.game.fold(targetId);
  }

  foldForDisconnected(hostId, targetId) {
    if (this.hostId !== hostId) return { error: '只有房主可以这样做' };
    return this.resolveDisconnectedTurn(targetId);
  }

  // 这手牌此刻是否真的在等某个人行动。
  //
  // 单看 getActionPlayerId() 是不够的：牌局对象在一手结束后仍然存在，
  // actionIndex 也还停在最后行动的那个人身上，所以摊牌/结算/破产决策期间它
  // 照样返回一个 id。倒计时如果只信它，就会对着一手**已经结束**的牌反复执行
  // 默认动作——实测表现为超时回调每 250ms 触发一次、不断给同一个人弃牌。
  isAwaitingAction() {
    if (!this.game) return false;
    if (this.game.phase === 'showdown') return false;
    if (this.isAwaitingSettlementAck()) return false;
    if (this.awaitingBustResolution) return false;
    return this.getActionPlayerId() != null;
  }

  // ─── 回合倒计时 & 时间银行 ────────────────────────────────────────────────
  // 时长一律由调用方传入（index.js 的 createServer 可注入），跟
  // beginSettlementWait(displayMs) 一个模式——否则每条超时测试都得真等 20 秒。

  // 每手开始时重置所有人的储备池。中途加入的人这一手没有 timeBankMs，
  // extendTurn 里按 0 处理，下一手就会被这里补上。
  resetTimeBanks(bankMs) {
    for (const p of this.players) p.timeBankMs = bankMs;
  }

  // seq 是引擎的行动权序号（GameEngine.turnSeq）。必须一起存：单挑里大盲翻牌
  // 前最后行动、翻牌后第一个行动，光看 playerId 分不出这是"同一个回合"还是
  // "同一个人的下一个回合"，后者必须重新计时。
  getTurnSeq() {
    return this.game?.turnSeq ?? null;
  }

  startTurnClock(playerId, baseMs) {
    // startedAt 一并下发：客户端的环形进度要知道"这一轮总共多长"才能把进度
    // 画准——只有 endsAt 的话，中途重连或延时之后拿到的是残缺信息，环只能
    // 从满格重画一遍，跟实际剩余时间对不上。
    const now = Date.now();
    this.turnClock = { playerId, startedAt: now, endsAt: now + baseMs, seq: this.getTurnSeq() };
    return this.turnClock;
  }

  clearTurnClock() {
    this.turnClock = null;
  }

  // 玩家点「+15 秒」。从他自己的储备池里扣，扣完为止——用户原方案是无上限
  // 续杯，那会把"一个人拖住全桌"原样带回来。
  extendTurn(playerId, stepMs) {
    if (!this.turnClock || this.turnClock.playerId !== playerId) return { error: '现在不是你的回合' };
    const p = this.players.find(p => p.id === playerId);
    if (!p) return { error: '玩家不存在' };
    const remaining = p.timeBankMs ?? 0;
    if (remaining <= 0) return { error: '延时时间已用完' };
    const spend = Math.min(stepMs, remaining);
    p.timeBankMs = remaining - spend;
    // 从**当前剩余时间**上加，而不是从"现在"重新计时——否则在还剩 18 秒时
    // 点一下反而会把时间缩短到 15 秒。
    //
    // 但要先跟"现在"取大：截止时刻可能已经过去（点击到达服务端时正好卡在到
    // 点前后）。直接在过去的时刻上加，算出来的剩余时间仍然是负的，玩家会扣
    // 掉 15 秒储备后立刻被执行默认动作——正是这个功能要防的事。
    this.turnClock.endsAt = Math.max(this.turnClock.endsAt, Date.now()) + spend;
    return { ok: true, endsAt: this.turnClock.endsAt, timeBankMs: p.timeBankMs };
  }

  timeBankFor(playerId) {
    return this.players.find(p => p.id === playerId)?.timeBankMs ?? 0;
  }

  playerAction(playerId, action, amount) {
    if (!this.game) return { error: '游戏未开始' };
    switch (action) {
      case 'fold':  return this.game.fold(playerId);
      case 'check': return this.game.check(playerId);
      case 'call':  return this.game.call(playerId);
      case 'raise': return this.game.raise(playerId, Number(amount));
      case 'allin': return this.game.allIn(playerId);
      default:      return { error: '未知操作' };
    }
  }

  getStateForPlayer(playerId) {
    if (!this.game) return null;
    return this.game.getStateForPlayer(playerId);
  }

  getLobbyState() {
    return {
      code: this.code,
      hostId: this.hostId,
      status: this.status,
      startingChips: STARTING_CHIPS,
      players: this.players.map(p => ({ id: p.id, name: p.name, chips: p.chips, debt: p.debt || 0, connected: p.connected !== false, left: p.left || false, timeBankMs: p.timeBankMs ?? 0, bustResolved: p.bustResolved || false })),
      awaitingBustResolution: this.awaitingBustResolution,
      // 当前回合的倒计时。公开信息——每个人都该看到轮到谁、还剩多久，不只是
      // 行动方自己。endsAt 是绝对时间戳，客户端自行与本地时间相减。
      turnClock: this.turnClock,
      gameTimerEndsAt: this.gameTimerEndsAt,
      awaitingTimerDecision: this.awaitingTimerDecision,
    };
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map(); // code -> Room
    this.playerRoom = new Map(); // playerId -> roomCode
  }

  create(hostId, hostName) {
    let code;
    do { code = randomCode(); } while (this.rooms.has(code));
    const room = new Room(hostId, hostName);
    room.code = code;
    this.rooms.set(code, room);
    this.playerRoom.set(hostId, code);
    return room;
  }

  join(code, playerId, playerName, socketId) {
    const room = this.rooms.get(code.toUpperCase());
    if (!room) return { error: '房间不存在' };
    const result = room.addPlayer(playerId, playerName, socketId);
    if (result.error) return result;
    // result.id may differ from the playerId passed in — see addPlayer's
    // name-based reclaim fallback. The playerRoom mapping (and whatever we
    // hand back to the caller) must key off the REAL identity, not
    // whatever id this particular socket happened to show up with.
    this.playerRoom.set(result.id, code.toUpperCase());
    return { ok: true, room, playerId: result.id };
  }

  leave(playerId) {
    const code = this.playerRoom.get(playerId);
    if (!code) return;
    const room = this.rooms.get(code);
    if (!room) return;
    room.markLeft(playerId);
    this.playerRoom.delete(playerId);
    // A room is only truly abandoned once everyone in it has left — the
    // player rows themselves stay (markLeft keeps them for the ledger), so
    // "empty" is no longer players.length === 0.
    if (room.players.every(p => p.left)) this.rooms.delete(code);
    return room;
  }

  getRoom(code) {
    return this.rooms.get(code?.toUpperCase());
  }

  // A mid-game disconnect deliberately has no per-player grace-period timer
  // (see server/index.js — the only auto-leave timeout is in the LOBBY,
  // before a game starts). Without this sweep, a room abandoned mid-game
  // would otherwise sit in memory forever, relying on an unrelated server
  // restart to ever clear it. Only rooms where EVERY player is currently
  // disconnected (or already left) are eligible — a room with anyone still
  // connected never expires here, no matter how long since real activity.
  sweepIdleRooms(ttlMs) {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      const allGone = room.players.every(p => p.connected === false || p.left);
      if (allGone && now - room.lastActivityAt > ttlMs) {
        for (const p of room.players) this.playerRoom.delete(p.id);
        this.rooms.delete(code);
      }
    }
  }

  getRoomByPlayer(playerId) {
    const code = this.playerRoom.get(playerId);
    return code ? this.rooms.get(code) : null;
  }

  updateSocket(playerId, socketId) {
    const room = this.getRoomByPlayer(playerId);
    if (room) room.updateSocket(playerId, socketId);
  }
}

module.exports = { RoomManager };
