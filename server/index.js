const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { RoomManager } = require('./RoomManager');
const { parseCard } = require('./GameEngine');
const { PveSession } = require('./PveSession');
const { getServerIdentity } = require('./serverIdentity');

// 固定四档，非法/缺省一律回退单挑——不接受任意人数。Module scope (not
// re-allocated per pve:start call) and coerced with Number() before the
// .includes() check below, so a client sending "4" (string) doesn't
// silently fall back to heads-up just because `"4" !== 4`.
const VALID_SEAT_COUNTS = [2, 4, 6, 8];

// 拍一拍可选表情（GitHub #19）——固定白名单而不是接受任意字符串，客户端的
// 拍一拍表情选择器只会发送这几个之一，服务端按白名单校验后再广播。🥚 是
// 第一个"特效"类表情（GitHub #26）：跟其他表情走同一条 player:poke 广播
// 链路，客户端单独识别这个表情、在目标座位上多播一段砸蛋动画（不是新协
// 议，只是客户端渲染分支）。用户反馈（2026-08-12）：现在这版砸蛋动画效
// 果不够好，先从选择器里屏蔽（PlayerSeat.jsx 的 POKE_PICKER_EMOJI 不再
// 包含它），换成更成熟的方案后再放出来——服务端白名单继续保留 🥚（不删），
// 避免屏蔽期间万一有旧版前端缓存还在发这个表情时被拒绝。
const POKE_EMOJI = ['😄', '😢', '👍', '😡', '❤️', '😂', '🥚', '☕️', '😈', '🤨', '❓', '🤡', '👏'];

// 反馈提交的服务端校验上限——见下方 feedback:submit 处理逻辑。
const FEEDBACK_MAX_TEXT_LENGTH = 2000;
const FEEDBACK_MAX_IMAGE_BASE64_LENGTH = 3_000_000; // ~2.25MB decoded; client compresses to ~2MB target
// 多图上传（用户反馈 #3，2026-08-03 已标 accepted）。张数上限取 4：一个问题
// 通常"操作前/操作后"或"几个不同界面"就够说清楚，再多会让 Issue 正文变得难
// 读，也会把 payload 推得很大。总量上限单独设，不是简单的 4×单张上限——单张
// 3MB 是给"偶尔一张没压好的大图"留的余量，四张同时顶满并不是要支持的场景。
const FEEDBACK_MAX_IMAGES = 4;
const FEEDBACK_MAX_IMAGES_TOTAL_BASE64_LENGTH = 6_000_000;

// 语音对讲：双机连通性实测的信令中转（见
// docs/superpowers/specs/2026-08-09-voice-intercom-design.md「实施顺序」第 2 步）。
//
// 服务器**只转发建连所需的那几句话**（SDP/ICE），语音本身走点对点，永远不经
// 过这里——这正是整个方案能在 Render 免费档上白嫖的原因，别在这里加任何碰音
// 频数据的东西。
//
// 探路阶段刻意封顶 2 人：先单独回答"两台设备到底连不连得上"，mesh 留到验证
// 通过之后。封顶而不是放任，是为了让第三个人进来时得到一句明确的错误，而不是
// 一个说不清的半连接状态。
const VOICE_TEST_MAX_PEERS = 2;
const voiceRoomKey = code => `voice:${code}`;

// 正式接入牌桌的语音 mesh（见 index 下方「语音对讲信令」一节）。跟牌桌人数
// 上限保持一致，而不是复用 VOICE_TEST_MAX_PEERS——那是探路阶段专门封顶到 2
// 人的产物，跟正式功能的规模无关。
const VOICE_MESH_MAX_PEERS = 8;
const voiceMeshKey = code => `voice-mesh:${code}`;

function createServer({
  feedbackReporter = require('./feedbackReporter'),
  // 可注入，跟 feedbackReporter 是同一个"方便测试"的模式——否则验证"到点
  // 自动推进"就得让测试真的等 15 秒。
  settlementDisplayMs = 15 * 1000,
  // 回合倒计时（用户反馈 #7 / #10）。同样可注入——否则每条"到点自动执行"的
  // 测试都得真等 20 秒。
  turnBaseMs = 20 * 1000,
  timeBankPerHandMs = 30 * 1000,
  turnExtendStepMs = 15 * 1000,
} = {}) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: '*' },
    // socket.io defaults to 1MB, which is below our own feedback size limits —
    // without raising this, an over-limit feedback image payload is silently
    // dropped at the transport before our own size check ever runs, hanging
    // the client's ack instead of returning a clean error.
    //
    // 多图之后这条不变式只在总量上限之内成立：buffer（7MB）> 总量上限（6MB），
    // 所以任何**会被我们接受**的 payload 都能完整到达，超限的也能走到我们自
    // 己的校验、拿到明确错误。但张数上限 4 × 单张上限 3MB = 12MB 理论上可以
    // 超过 buffer——那种 payload 仍会在传输层被丢掉、客户端看到的是超时而不
    // 是明确错误。没有把 buffer 提到 12MB 是刻意的：那是纯理论上界（客户端
    // 压缩后每张约 0.3-0.6MB，四张不到 3MB），为一个构造不出来的场景常驻
    // 12MB 缓冲，在免费档实例上不划算。
    maxHttpBufferSize: FEEDBACK_MAX_IMAGES_TOTAL_BASE64_LENGTH + 1_000_000,
  });

  const rooms = new RoomManager();
  // PVE (人机对战): deliberately NOT stored in `rooms` — see design.md
  // 「新增：单人人机对战（PVE）模式」. Reconnect support added 2026-07-28
  // (user feedback: closing the browser and coming back showed "对局不存
  // 在", same rough edge multiplayer went through several rounds fixing —
  // PVE shouldn't be worse):
  // - pveSessions: keyed by a persistent client-supplied id (localStorage
  //   `vr_playerId`, same one multiplayer already uses as an anonymous
  //   device identity — reused here, not a new namespace), NOT socket.id.
  //   A session survives a disconnect; only an explicit pve:leave or the
  //   idle reaper below removes one.
  // - pveActiveSocket: pveId -> the socket.id currently "owning" that
  //   session, so broadcasts always reach whoever's actually connected
  //   right now, not a stale closed-over socket from whenever the session
  //   was created. Re-pointed on every pve:start (including a resume).
  // - socketToPveId: the reverse lookup pve:action/pve:ready-next/
  //   disconnect need, since those only have `socket.id` in scope.
  const pveSessions = new Map();
  const pveActiveSocket = new Map();
  const socketToPveId = new Map();
  const PVE_IDLE_TTL_MS = 30 * 60 * 1000; // 30 分钟无人接回就清掉，避免内存无限攒着废弃对局

  function pveBroadcastState(session) {
    const socketId = pveActiveSocket.get(session.humanId);
    if (!socketId) return; // currently disconnected — next resume re-sends full state anyway
    io.to(socketId).emit('game:state', session.getStateForPlayer(session.humanId));
  }

  // A single "someone just acted" notification, separate from game:state.
  // game:state is a wholesale snapshot — if two of them land close enough
  // together that the client's UI framework collapses them into one render
  // (bursty delivery after a network stall is the common case), whichever
  // snapshot never gets its own render silently loses everything gated on
  // seeing it, including the action's sound cue. This event exists so sound
  // playback doesn't depend on a render ever happening for that specific
  // snapshot — the client fires it straight from the socket message itself.
  // Built from the engine's own lastAction* fields (set synchronously by
  // _recordAction, same source getStateForPlayer's lastActionSeq etc. read
  // from) rather than threading a value through every action method's
  // return, since both playerAction() and PveSession._dispatch() already
  // leave the engine in that state right after any successful action.
  function actionHappenedPayload(engine) {
    if (!engine?.lastActionBy) return null;
    return {
      actorId: engine.lastActionBy,
      label: engine.lastActionLabel,
      seq: engine.lastActionSeq,
      phase: engine.lastActionPhase,
    };
  }

  function pveHandleResult(session, result) {
    if (!result || result.error) return;
    pveBroadcastState(session);
    const actionEvent = actionHappenedPayload(session.game);
    if (actionEvent) {
      const socketId = pveActiveSocket.get(session.humanId);
      if (socketId) io.to(socketId).emit('action:happened', actionEvent);
    }
    if (result.showdown) {
      // Stashed on the session (mirrors Room.lastShowdown) so a resume
      // (pve:start on an existing session — see that handler below) can
      // re-send this exact payload if the human reconnects before ever
      // getting past this hand's settlement — otherwise the client is left
      // waiting on a game:showdown that will never come again. Cleared in
      // PveSession._dealNewHand() once the next hand actually starts.
      session.lastShowdown = {
        winners: result.winners,
        pot: result.pot,
        settle: result.settle,
        foldWin: result.foldWin,
      };
      const socketId = pveActiveSocket.get(session.humanId);
      if (socketId) io.to(socketId).emit('game:showdown', session.lastShowdown);

      // Mirrors handleActionResult's room.handHistory.push below, but
      // simpler: PVE only ever has the one human viewer, so there's no
      // multi-player privacy dance to defer to a per-request "personalize"
      // step (room:get-hand-history) — bake the human's own cards in
      // directly at record time. A fold-win's public showdownReveal is
      // empty (nobody had to prove anything), but the human should still
      // always be able to see their own cards for a hand they played,
      // win or lose, same rule the live table itself follows.
      const reveals = result.foldWin
        ? result.allHoleCards
            .filter(c => c.id === session.humanId)
            .map(c => ({ ...c, name: session.players.find(p => p.id === c.id)?.name }))
        : result.showdownReveal;
      session.handHistory.push({
        handNumber: session.handHistory.length + 1,
        timestamp: Date.now(),
        communityCards: result.state.communityCards,
        foldWin: result.foldWin,
        winners: result.winners.map(w => ({ id: w.id, name: w.name, won: w.won, handName: w.handName })),
        settle: result.settle,
        reveals,
      });
      session.persist(); // 跨会话保留对手画像/历史（design.md「PVE AI 剥削性强化」）
    }
  }

  // Drives the AI's turn(s) one at a time with a human-like delay between
  // each — PveSession itself stays synchronous/timer-free (see its own
  // comment) so this pacing lives entirely in the transport layer. Reads
  // pveSessions fresh on every tick (by pveId, not a closed-over session)
  // so a disconnect mid-delay — or a reconnect that re-points
  // pveActiveSocket to a new socket — is picked up correctly rather than
  // stuck emitting to whatever socket happened to be live when the timer
  // was scheduled.
  function pveRunAiLoop(pveId) {
    const session = pveSessions.get(pveId);
    if (!session || !session.isAiTurn()) return;
    // Base 0.5-2s "拟人延迟" (design.md) was tuned for exactly one AI
    // opponent (heads-up). At 8-max, up to 7 AI seats can each take a turn
    // per street across up to 4 streets, so the unscaled delay could stack
    // up to ~a minute of pure waiting in a single hand — final-review
    // finding (2026-08-02). Scale the delay down as the AI seat count
    // grows (divided by sqrt of seat count, so heads-up is untouched and
    // 8-max lands around a third of the original wait) but never below
    // 300ms, so it still reads as a deliberate "thinking" pause rather
    // than instant/robotic action.
    const scale = Math.sqrt(session.aiSeats.length);
    const delay = Math.max(300, (500 + Math.random() * 1500) / scale);
    setTimeout(() => {
      const s = pveSessions.get(pveId);
      if (!s || !s.isAiTurn()) return;
      s.touch();
      // aiAction 现在会在"这手牌停止推进"时主动抛错（见 PveSession 的
      // AI_DECISIONS_PER_HAND_LIMIT）。接住它：把现场打进服务端日志供事后
      // 定位，给玩家一个明确提示并结束这局，而不是让循环继续自我重排、把
      // 桌子永久冻死——那正是这个守卫要防的结果。
      let r;
      try {
        r = s.aiAction();
      } catch (e) {
        console.error('[pve] 牌局停止推进，已中止该局:', e.message);
        const socketId = pveActiveSocket.get(pveId);
        if (socketId) io.to(socketId).emit('game:error', '这局出现异常已中止，请重新开始一局');
        pveSessions.delete(pveId);
        return;
      }
      if (r) pveHandleResult(s, r.result);
      pveRunAiLoop(pveId);
    }, delay);
  }

  // Sweeps sessions nobody's come back to in a while — mirrors the spirit
  // of multiplayer's idle-room reaper (see RoomManager.sweepIdleRooms).
  // Only ever removes a session with NO currently-active socket; a session
  // someone's still connected to is never touched no matter how long since
  // its last action (same principle multiplayer's reaper already follows).
  setInterval(() => {
    const now = Date.now();
    for (const [pveId, session] of pveSessions) {
      if (pveActiveSocket.has(pveId)) continue;
      if (now - (session.lastActivityAt ?? 0) > PVE_IDLE_TTL_MS) pveSessions.delete(pveId);
    }
  }, 5 * 60 * 1000);
  // Grace-period timers for lobby (pre-game) disconnects, keyed by playerId.
  // A disconnect while just sitting in the lobby is very often transient —
  // backgrounding the tab to paste the invite link into a messaging app,
  // a brief network blip — not "this player is gone". Removing them (and
  // deleting the room, if they were its only player, which is exactly the
  // case right after a host creates a room and before anyone's joined)
  // immediately on disconnect turned "share the link" into a room-deleting
  // action a large fraction of the time on mobile. See GRACE_PERIOD_MS.
  const pendingRemovals = new Map();
  const GRACE_PERIOD_MS = 120000;
  // 当前回合的倒计时定时器，按房间号存——一个房间同一时刻只可能有一个人在
  // 行动。见 maybeArmTurnClock。取代了原来的 pauseTimers/PAUSE_TIMEOUT_MS
  // （5 分钟，且只对断线玩家生效）。
  const turnTimers = new Map();
  const TURN_BASE_MS = turnBaseMs;
  const TIME_BANK_PER_HAND_MS = timeBankPerHandMs;
  const TURN_EXTEND_STEP_MS = turnExtendStepMs;
  // "有人破产了却不做决定"的兜底，跟回合倒计时是两回事——倒计时管的是牌桌上
  // 的行动，这个管的是 awaitingBustResolution 这个暂停。Keyed by room code,
  // see maybeArmBustTimer below.
  //
  // 原本是 5 分钟——用户反馈（2026-08-12）：其他玩家在等待期间只能干等，
  // 5 分钟太长；同时归零玩家自己的弹窗此前完全没有时限。改成 20 秒，并配
  // 上可见倒计时（见 room.bustDecisionEndsAt/BustDecisionModal/BustWaitModal），
  // 到点的行为不变，仍是下面这段既有的 markLeft（相当于自动帮他选"退出"）。
  const BUST_DECISION_TIMEOUT_MS = 20 * 1000;
  const bustTimers = new Map();
  // Settlement safety-timeout: if an eligible player disconnects during
  // settlement wait and never returns, auto-drop them after 10 minutes so
  // the remaining connected players can advance instead of being stuck
  // forever. Analogous to maybeArmTurnClock but for the settlement phase
  // — the action-phase timer fires fold, this one fires dropFromSettlementWait.
  const settlementTimers = new Map();
  // 结算画面的展示时长——到点自动进入下一手。既是"给大家看一眼结果"的节奏，
  // 也是唯一的推进保障（见 armSettlementTimer 的说明）。
  const SETTLEMENT_DISPLAY_MS = settlementDisplayMs;

  app.use(express.static(path.join(__dirname, '../client/dist')));
  app.get('/health', (_, res) => {
    let roomPlayers = 0;
    for (const room of rooms.rooms.values()) {
      roomPlayers += room.players.filter(p => p.connected && !p.left).length;
    }
    res.json({
      ok: true,
      rooms: rooms.rooms.size,
      roomPlayers,
      pveSessions: pveSessions.size,
      pvePlayersOnline: pveActiveSocket.size,
    });
  });
  // 谁在线（用户反馈 2026-08-28）——/health 只给数量，push 前想知道"是不是
  // 认识的人在玩、能不能等"就得猜。跟 /health 分开一个接口，不是往里面加
  // 字段：/health 给自动化健康检查用，越精简越好；这个是给人看的，可以带
  // 名字。不加鉴权——这个项目现在只有几个朋友玩，跟 /health 本身已经公开
  // 暴露房间数/人数是同一个信任级别，不是新增的风险面。
  app.get('/status', (_, res) => {
    const roomsOut = [];
    for (const room of rooms.rooms.values()) {
      const players = room.players.filter(p => p.connected && !p.left).map(p => p.name);
      if (players.length > 0) roomsOut.push({ code: room.code, players });
    }
    res.json({ ok: true, rooms: roomsOut });
  });
  // Pass root+relative (not a raw absolute path) so express/send's dotfile
  // check only inspects "index.html", not every ancestor directory in the
  // checkout path — a raw absolute path 404s if the checkout lives under
  // any dot-prefixed directory (e.g. a `.claude/worktrees/...` worktree).
  app.get('/{*path}', (_, res) => res.sendFile('index.html', { root: path.join(__dirname, '../client/dist') }));

  // ─── helpers ───────────────────────────────────────────────────────────────

  // Still owes the room a bust decision (rebuy / spectate / leave) — the one
  // definition of "pending", shared by the pause check, its timer, and the
  // timer's own timeout fallback, so the three can't drift apart.
  function bustPending(room) {
    return room.players.filter(p => p.chips === 0 && !p.left && !p.bustResolved);
  }

  function broadcastRoom(room) {
    room.touch();
    maybeArmTurnClock(room);
    maybeArmBustTimer(room);
    for (const p of room.players) {
      if (!p.socketId) continue;
      const state = room.getStateForPlayer(p.id);
      if (state) io.to(p.socketId).emit('game:state', state);
    }
    io.to(room.code).emit('room:state', room.getLobbyState());
  }

  // Mirrors maybeArmTurnClock, for the "someone busted, hasn't rebought or
  // left yet" pause instead of a stuck mid-hand turn. Re-evaluated from the
  // same broadcastRoom funnel point after every event that could change who's
  // pending (a bust, a rebuy, a leave).
  function maybeArmBustTimer(room) {
    const existing = bustTimers.get(room.code);
    const pendingIds = bustPending(room).map(p => p.id).sort().join(',');
    const shouldBeArmed = room.awaitingBustResolution && pendingIds.length > 0;

    if (existing && existing.pendingIds === pendingIds) return; // already correct
    if (existing) {
      clearTimeout(existing.timer);
      bustTimers.delete(room.code);
    }
    if (!shouldBeArmed) {
      room.bustDecisionEndsAt = null;
      return;
    }

    room.bustDecisionEndsAt = Date.now() + BUST_DECISION_TIMEOUT_MS;
    const timer = setTimeout(() => {
      bustTimers.delete(room.code);
      room.bustDecisionEndsAt = null;
      // Re-validate at fire time — someone may have resolved (rebought,
      // spectated, or left) between arming and firing.
      for (const p of bustPending(room)) room.markLeft(p.id);
      tryAdvanceIfClear(room);
    }, BUST_DECISION_TIMEOUT_MS);
    bustTimers.set(room.code, { pendingIds, timer });
  }

  // The single place that decides whether the room can actually deal the
  // next hand: holds (and broadcasts the pause) if anyone's chips===0 and
  // hasn't resolved yet, otherwise proceeds to nextRound() as before. Called
  // both right after the settlement-ack wait clears, and again whenever a
  // pending player resolves (rebuy, spectate, or leave) — any of the three
  // can be the thing that finally clears the pause.
  function tryAdvanceIfClear(room) {
    // Deliberately does NOT call room.syncChipsFromGame() itself — that
    // must happen exactly once, right when a hand finishes (see
    // advanceRoom), not on every call here. This function is also called
    // after a rebuy/spectate/leave resolves the pause, and by then
    // room.players already holds the current truth (the rebuy already
    // incremented chips directly); re-syncing from the finished, untouched
    // game engine at that point would clobber the rebuy's chips right back
    // down to 0 (confirmed the hard way — a live test kept looping instead
    // of clearing the pause).
    const busted = bustPending(room);
    if (busted.length > 0) {
      room.awaitingBustResolution = true;
      broadcastRoom(room);
      return;
    }
    room.awaitingBustResolution = false;

    // Session timer ("计时游戏") check — deliberately placed AFTER the bust
    // check clears, and this function only ever runs at a genuine hand
    // boundary (post-settlement-wait, or after a bust-pause resolves), so
    // an expired timer can never interrupt a hand still in progress; it
    // always waits for at least the current hand to finish first.
    if (room.gameTimerEndsAt && Date.now() >= room.gameTimerEndsAt) {
      if (!room.awaitingTimerDecision) {
        room.awaitingTimerDecision = true;
        io.to(room.code).emit('game:timer-expired');
      }
      broadcastRoom(room);
      return;
    }

    const nr = room.nextRound();
    // 储备池按手重置——每手都是新的 30 秒，不跨手累积也不跨手透支。
    room.resetTimeBanks(TIME_BANK_PER_HAND_MS);
    if (nr.ended) io.to(room.code).emit('game:ended', nr);
    broadcastRoom(room);
  }

  // Shared by the host's manual "结束游戏" and the timer-expiry "结束对局"
  // decision — same end state (chips synced, back to lobby, ledger
  // auto-opens client-side via `hostEnded`), just a different reason
  // string and caller.
  function endGameNow(room, reason) {
    room.syncChipsFromGame();
    room.game = null;
    room.status = 'waiting';
    room.awaitingBustResolution = false;
    room.gameTimerEndsAt = null;
    room.awaitingTimerDecision = false;
    // 这个函数直接发 room:state，绕过了 broadcastRoom 这个漏斗，所以
    // maybeArmTurnClock 不会跑——必须自己把倒计时收干净。否则 getLobbyState()
    // 会继续给一个已经结束的牌局下发 turnClock，而残留的定时器还可能在房主
    // 立刻重开一局时替新的行动方执行默认动作。
    clearTurnTimer(room);
    room.clearTurnClock();
    room.touch();
    io.to(room.code).emit('room:state', room.getLobbyState());
    io.to(room.code).emit('game:ended', { ended: true, reason, hostEnded: true });
  }

  // Arms, re-arms, or clears the pause-timeout for a room, based on
  // whether whoever's turn it currently is is disconnected. Called from
  // the single broadcastRoom() funnel point below, so it re-evaluates
  // after every event that could change whose turn it is or someone's
  // connection status (actions, disconnects, reconnects).
  // 回合倒计时（用户反馈 #7 / #10）。取代了原来那个 5 分钟的
  // PAUSE_TIMEOUT_MS——那个只对**断线**玩家生效，所以一个在线但不动的人可以
  // 无限拖住全桌，正是 #10 抱怨的"太慢了"。
  //
  // 刻意**不看 connected**：倒计时问的是"有没有在时限内行动"，切后台的、断线
  // 的、发呆的都不会行动，结果本就相同。断线判定（socket.io 默认心跳，手机锁
  // 屏/切后台会误判——见 RoomManager nextRound 上方那段历史）在这里没有任何
  // 作用，只会多一个可能出错的输入。断线玩家因此自然地在到点被执行默认动作，
  // 无需任何特判。
  function clearTurnTimer(room) {
    const existing = turnTimers.get(room.code);
    if (existing) {
      clearTimeout(existing.timer);
      turnTimers.delete(room.code);
    }
  }

  function maybeArmTurnClock(room) {
    // 暂停时绝不能重新起表——broadcastRoom 每次都会调用这个函数，暂停后
    // 如果不短路，下一次任意广播都会把刚清掉的计时器重新点起来，暂停等
    // 于白做。清空残留的 turnClock（正常情况下 room:pause handler 已经清
    // 过了，这里是防御性的二次保证）之后直接返回，不碰 turnTimers。
    if (room.paused) { room.clearTurnClock(); return; }
    const existing = turnTimers.get(room.code);
    // isAwaitingAction() 而不是裸的 getActionPlayerId()：一手结束后牌局对象
    // 仍在、actionIndex 也还停在最后行动的人身上，只信后者会让倒计时对着一
    // 手已经结束的牌反复执行默认动作（实测：每个周期给同一个人弃牌一次）。
    const actionPlayerId = room.isAwaitingAction() ? room.getActionPlayerId() : null;
    const seq = room.getTurnSeq();

    // 还是同一个人的**同一个回合**（比如别人重连触发了一次无关的广播）——绝
    // 不能重置计时，否则任意一次广播都能给当前行动方无限续命。
    //
    // 必须连 seq 一起比：单挑里大盲翻牌前最后行动、翻牌后第一个行动，光比
    // playerId 会把这两个回合当成一个，于是他在翻牌圈继承上一街用剩的时间
    // （实测：翻牌一落地就只剩几十毫秒，直接被自动过牌）。
    if (existing && existing.playerId === actionPlayerId && existing.seq === seq) return;

    clearTurnTimer(room);
    if (!actionPlayerId) { room.clearTurnClock(); return; }

    const { endsAt } = room.startTurnClock(actionPlayerId, TURN_BASE_MS);
    scheduleTurnExpiry(room, actionPlayerId, endsAt);
  }

  // 单独拆出来，因为「+15 秒」延时也要用它重新排期（见 game:extend-turn）。
  function scheduleTurnExpiry(room, playerId, endsAt) {
    const existing = turnTimers.get(room.code);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      turnTimers.delete(room.code);
      // 到点前重新确认一次：这中间他可能已经行动了、这手可能已经结束了。
      // 用 isAwaitingAction() 而不是裸的 getActionPlayerId()——后者在一手结束
      // 后仍会返回最后行动那个人的 id，分不出"还轮着他"和"牌已经打完了"。
      if (!room.isAwaitingAction() || room.getActionPlayerId() !== playerId) return;
      const result = defaultActionFor(room, playerId);
      if (!result.error) handleActionResult(room, result);
    }, Math.max(0, endsAt - Date.now()));
    timer.unref?.();
    turnTimers.set(room.code, { playerId, timer, seq: room.getTurnSeq() });
  }

  // 超时默认动作：无人加注就过牌，有人加注就弃牌（业内标准的 check/fold
  // default，也是用户在 #10 里提的）。
  //
  // 判定方式是"先试 check，被引擎拒绝就 fold"，而不是在这里重新推导"当前有
  // 没有需要跟的注"——后者等于把引擎的下注规则复制一份出来，两份迟早会不
  // 一致。GameEngine.check() 的两个错误分支都在任何状态改动之前返回，所以
  // 这样试探是安全的。
  function defaultActionFor(room, playerId) {
    const checked = room.playerAction(playerId, 'check');
    if (!checked.error) return checked;
    return room.playerAction(playerId, 'fold');
  }

  // Arms a safety-timeout for the settlement-wait phase: if any eligible
  // (not-yet-acked) player is disconnected, starts a 10-minute timer. At
  // fire time, all disconnected eligible players are dropped so the room
  // can advance. Clears + rearms on each call (lives alongside the pause
  // timer for the action phase, which is a different concern).
  // 结算展示时间到就推进，**不问原因**。用户反馈 #10「多个玩家的时候，
  // 现在的交互设计太慢了。因为现在很多步骤都依赖于所有玩家确认」。
  //
  // 旧版本是三层条件缠在一起：只在"名单里有人被标成断线"时才启动、10 分钟
  // 超时、超时后逐个把断线的人摘出名单再看能不能推进。三层都建立在"要先
  // 判断出这个人为什么不点"之上——而断线、已退出、就是在发呆，这三种情况
  // 本来就该是同一个结果：别让一个人卡住其他所有人。所以合并成一条无条件
  // 的规则，删掉的分支比留下的多。
  //
  // 信息不会因此丢失：这一手在 beginSettlementWait 的下一行就已经写进
  // room.handHistory，随时可以从牌局记录里回看。这个等待保护的从来只是
  // "给大家几秒看一眼结果"的节奏，而节奏用计时就够，不需要一个 N 人全票
  // 通过的阻塞依赖。
  function armSettlementTimer(room) {
    clearSettlementTimer(room);
    if (!room.isAwaitingSettlementAck()) return;

    const timer = setTimeout(() => {
      settlementTimers.delete(room.code);
      if (!room.isAwaitingSettlementAck()) return;
      advanceRoom(room);
    }, SETTLEMENT_DISPLAY_MS);
    // .unref() 跟下方的 idle-room reaper 一致：这个计时器本身不该让 Node
    // 进程（或一次测试运行）为了等它而活着。
    timer.unref?.();
    settlementTimers.set(room.code, timer);
  }

  function clearSettlementTimer(room) {
    const existing = settlementTimers.get(room.code);
    if (existing) clearTimeout(existing);
    settlementTimers.delete(room.code);
  }

  // Advances a room past its post-showdown settlement wait: clears the
  // room's ready-tracking state and moves the game on. This is the single
  // place that does so — either trigger (all acks in, or a departing player
  // unblocking everyone still left) funnels through here. No fallback timer
  // — the room waits for every seated player to actually click "我知道了"
  // before the next hand deals, full stop.
  function advanceRoom(room) {
    room.lastShowdown = null;
    clearSettlementTimer(room);
    room.clearSettlementWait();
    room.syncChipsFromGame();
    tryAdvanceIfClear(room);
  }

  function handleActionResult(room, result) {
    if (result.error) return;
    broadcastRoom(room);
    const actionEvent = actionHappenedPayload(room.game);
    if (actionEvent) io.to(room.code).emit('action:happened', actionEvent);

    if (result.showdown) {
      const showdownData = {
        winners: result.winners,
        pot: result.pot,
        settle: result.settle,
        foldWin: result.foldWin,
      };
      io.to(room.code).emit('game:showdown', showdownData);
      room.lastShowdown = showdownData;
      room.beginSettlementWait(SETTLEMENT_DISPLAY_MS);
      // 每次结算都起计时，不再等"发现有人断线"才补救——那正是旧版本会让
      // 一个已退出/发呆的玩家把整桌永久卡住的原因。
      armSettlementTimer(room);
      // 连同 endsAt 一起立刻发一次：客户端要靠它显示"Ns 后自动继续"。以前
      // 这个事件只在有人点确认或有人断线时才发，弹窗一出来的那段时间里客
      // 户端手里是没有进度信息的。
      io.to(room.code).emit('game:settlement-progress', room.getSettlementProgress());

      room.handHistory.push({
        handNumber: room.handHistory.length + 1,
        timestamp: Date.now(),
        communityCards: result.state.communityCards,
        foldWin: result.foldWin,
        winners: result.winners.map(w => ({ id: w.id, name: w.name, won: w.won, handName: w.handName })),
        settle: result.settle,
        reveals: result.showdownReveal, // public — sent to everyone as-is
        _privateHoleCards: result.allHoleCards, // never broadcast directly — see room:get-hand-history
      });
    }
  }

  // ─── socket events ─────────────────────────────────────────────────────────

  io.on('connection', (socket) => {
    let myPlayerId = null;

    // 第一件事就报出进程身份——客户端要靠它判断"我存着的房间还在不在"，
    // 所以必须先于任何 rejoin 尝试到达。见 client/src/utils/serverIdentity.js。
    socket.emit('server:hello', getServerIdentity());

    // Read-only lookup for the "XXX invited you" banner on the join screen —
    // no side effects (doesn't touch players/sockets), safe to call before
    // the visitor has entered their name or committed to joining.
    socket.on('room:peek', ({ code }, callback) => {
      const room = rooms.getRoom(code);
      if (!room) return callback?.({ error: '房间不存在' });
      const host = room.players.find(p => p.id === room.hostId);
      callback?.({ hostName: host?.name ?? null, playerCount: room.players.length });
    });

    // 反馈入口——用户反馈（2026-08-02）："能不能直接在网页上提供一个类似
    // 问题反馈的入口"。存储层是 GitHub Issue，不是本地文件，见
    // server/feedbackReporter.js 顶部注释里的持久化约束说明。
    socket.on('feedback:submit', async ({ text, image, images, authorName } = {}, callback) => {
      if (!feedbackReporter.isConfigured()) {
        return callback?.({ error: '反馈服务暂时不可用，请稍后再试' });
      }
      const trimmed = (text || '').trim();
      if (!trimmed) return callback?.({ error: '请输入反馈内容' });
      if (trimmed.length > FEEDBACK_MAX_TEXT_LENGTH) {
        return callback?.({ error: `反馈内容太长（最多 ${FEEDBACK_MAX_TEXT_LENGTH} 字）` });
      }
      // 同时接受新的 images 数组和旧的单个 image 字段：客户端是静态资源，
      // 用户浏览器里可能还缓存着改版前的包，那种版本发的仍是 image。丢掉这
      // 个兼容等于让旧标签页的反馈静默失败，而反馈系统本身就是用来收集问题
      // 的，它自己不能有沉默的失败模式。
      const imageList = Array.isArray(images) ? images : (image ? [image] : []);
      if (imageList.length > FEEDBACK_MAX_IMAGES) {
        return callback?.({ error: `最多上传 ${FEEDBACK_MAX_IMAGES} 张图片` });
      }
      let totalBase64 = 0;
      for (const img of imageList) {
        if (!img || typeof img.base64 !== 'string' || img.base64.length > FEEDBACK_MAX_IMAGE_BASE64_LENGTH) {
          return callback?.({ error: '图片太大，请压缩后再试' });
        }
        totalBase64 += img.base64.length;
      }
      if (totalBase64 > FEEDBACK_MAX_IMAGES_TOTAL_BASE64_LENGTH) {
        return callback?.({ error: '图片总大小超出限制，请减少张数或压缩后再试' });
      }
      try {
        const { issueUrl } = await feedbackReporter.createFeedbackIssue({ text: trimmed, images: imageList, authorName });
        callback?.({ ok: true, issueUrl });
      } catch (e) {
        console.error('[feedback] createFeedbackIssue failed:', e.message);
        callback?.({ error: '提交失败，请稍后再试' });
      }
    });

    // 反馈进展可见（用户反馈，2026-08-12）——列表直接读 GitHub Issue（连各
    // 自的评论一起只读展示，客户端要求整页展示、不做二级详情导航），不建
    // 独立存储，见 feedbackReporter.js 顶部注释。评论只读、不支持在 app 里
    // 加评论（用户明确不需要这个）。
    socket.on('feedback:list', async (_payload, callback) => {
      if (!feedbackReporter.isConfigured()) {
        return callback?.({ error: '反馈服务暂时不可用，请稍后再试' });
      }
      try {
        const issues = await feedbackReporter.listFeedbackWithComments();
        callback?.({ ok: true, issues });
      } catch (e) {
        console.error('[feedback] listFeedbackWithComments failed:', e.message);
        callback?.({ error: '获取反馈列表失败，请稍后再试' });
      }
    });

    socket.on('room:create', ({ playerId, playerName }) => {
      myPlayerId = playerId;
      clearTimeout(pendingRemovals.get(playerId));
      pendingRemovals.delete(playerId);
      const room = rooms.create(playerId, playerName);
      room.updateSocket(playerId, socket.id);
      socket.join(room.code);
      socket.emit('room:joined', { code: room.code, playerId });
      io.to(room.code).emit('room:state', room.getLobbyState());
    });

    socket.on('room:join', ({ code, playerId, playerName }) => {
      clearTimeout(pendingRemovals.get(playerId));
      pendingRemovals.delete(playerId);
      const result = rooms.join(code, playerId, playerName, socket.id);
      if (result.error) return socket.emit('game:error', result.error);
      // The actual identity for this socket — may differ from the
      // client-sent playerId if this join was reclaimed by name-fallback
      // (different browser/app, same name, old identity currently
      // offline; see RoomManager.addPlayer). The client always adopts
      // whatever playerId comes back in room:joined as authoritative.
      const actualId = result.playerId;
      myPlayerId = actualId;
      result.room.touch();
      result.room.updateSocket(actualId, socket.id);
      socket.join(code.toUpperCase());
      socket.emit('room:joined', { code: code.toUpperCase(), playerId: actualId });
      io.to(code.toUpperCase()).emit('room:state', result.room.getLobbyState());
    });

    socket.on('room:start', ({ playerId, durationMinutes }) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room) return socket.emit('game:error', '未找到房间');
      if (room.hostId !== playerId) return socket.emit('game:error', '只有房主可以开始游戏');
      const result = room.startGame(durationMinutes);
      if (result.error) return socket.emit('game:error', result.error);
      room.resetTimeBanks(TIME_BANK_PER_HAND_MS);
      broadcastRoom(room);
    });

    socket.on('game:action', ({ playerId, action, amount }) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room) return socket.emit('game:error', '未找到房间');
      const result = room.playerAction(playerId, action, amount);
      if (result.error) return socket.emit('game:error', result.error);
      handleActionResult(room, result);
    });

    // 「+15 秒」延时。从玩家自己每手 30 秒的储备池里扣，扣完为止——用户原
    // 方案是无上限续杯，那会把"一个人拖住全桌"原样带回来。
    socket.on('game:extend-turn', ({ playerId }) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room) return socket.emit('game:error', '未找到房间');
      const result = room.extendTurn(playerId, TURN_EXTEND_STEP_MS);
      if (result.error) return socket.emit('game:error', result.error);
      room.touch();
      // 定时器要按新的截止时刻重新排期，否则时间加了但到点动作照旧在原时刻
      // 触发——这正是"加了时间却还是被弃牌"那类最难查的 bug。
      scheduleTurnExpiry(room, playerId, result.endsAt);
      broadcastRoom(room);
    });

    // 暂停/继续（用户反馈，2026-08-11）：任意坐位玩家都能触发，立刻冻结
    // 当前回合的行动倒计时。room.paused 是唯一权威状态，两次几乎同时的
    // 调用天然安全——先到的生效，后到的因为状态已经翻转而在下面的 guard
    // 处变成空操作。设计文档：
    // docs/superpowers/specs/2026-08-11-pause-resume-design.md
    socket.on('room:pause', ({ playerId }) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room) return socket.emit('game:error', '未找到房间');
      if (room.paused) return; // 已经暂停，空操作——竞态安全的关键
      if (!room.players.some(p => p.id === playerId && !p.left)) return; // 只有坐位玩家能触发

      if (room.isAwaitingAction()) {
        room.pauseRemainingMs = Math.max(0, room.turnClock.endsAt - Date.now());
        room.pausedActionPlayerId = room.getActionPlayerId();
      }
      room.paused = true;
      clearTurnTimer(room);
      room.clearTurnClock();
      broadcastRoom(room);
    });

    socket.on('room:resume', ({ playerId }) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room) return socket.emit('game:error', '未找到房间');
      if (!room.paused) return; // 没在暂停，空操作
      if (!room.players.some(p => p.id === playerId && !p.left)) return;

      room.paused = false;
      const samePlayerSameTurn =
        room.pausedActionPlayerId &&
        room.isAwaitingAction() &&
        room.getActionPlayerId() === room.pausedActionPlayerId;

      if (samePlayerSameTurn) {
        // 复用 startTurnClock，只是把固定的 TURN_BASE_MS 换成暂停前记
        // 下来的剩余时间——引擎这边不用改一行。
        const { endsAt } = room.startTurnClock(room.pausedActionPlayerId, room.pauseRemainingMs);
        scheduleTurnExpiry(room, room.pausedActionPlayerId, endsAt);
      }
      // samePlayerSameTurn 为假的情况（理论上不会发生，暂停期间所有行动
      // 都被挡）交给下面 broadcastRoom 里的 maybeArmTurnClock 兜底——它
      // 现在已经不会被 room.paused 短路了（刚设成 false），会按正常逻辑
      // 重新评估该不该起表。

      room.pauseRemainingMs = null;
      room.pausedActionPlayerId = null;
      broadcastRoom(room);
    });

    socket.on('player:rebuy', ({ playerId }) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room) return socket.emit('game:error', '未找到房间');
      const result = room.rebuy(playerId);
      if (result.error) return socket.emit('game:error', result.error);
      room.touch();
      // If the room was paused waiting on this player's bust decision,
      // rebuying is one of the two ways to resolve it — re-check whether
      // everyone's clear to deal the next hand now.
      if (room.awaitingBustResolution) tryAdvanceIfClear(room);
      else io.to(room.code).emit('room:state', room.getLobbyState());
    });

    // Third bust-decision option — stay and watch, no rebuy, no leaving.
    // Resolves the room's pause the same as rebuy/leave-room do; the
    // player then simply falls out of nextRound()'s chips>0 filter like
    // any other spectator (mid-game joiner, previous busted-and-waiting).
    socket.on('player:spectate', ({ playerId }) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room) return socket.emit('game:error', '未找到房间');
      const result = room.spectate(playerId);
      if (result.error) return socket.emit('game:error', result.error);
      room.touch();
      if (room.awaitingBustResolution) tryAdvanceIfClear(room);
      else io.to(room.code).emit('room:state', room.getLobbyState());
    });

    // Self-triggered "I'm intentionally leaving" — used for the busted
    // player's "退出对局" choice, an impatient other player's "退出" while
    // waiting on someone else's bust decision, and the lobby's own "退出
    // 房间" button. Unlike a disconnect, this resolves immediately rather
    // than waiting out a grace period, and (via RoomManager.leave) marks
    // the player left instead of deleting their row, so their final
    // numbers stay on the ledger.
    socket.on('player:leave-room', ({ playerId }) => {
      const room = rooms.leave(playerId);
      if (!room) return;
      room.touch();
      if (room.awaitingBustResolution) tryAdvanceIfClear(room);
      else io.to(room.code).emit('room:state', room.getLobbyState());
    });

    // Host-only equivalent of "player:leave-room", for a busted player who
    // won't decide. Only usable while that specific player is actually the
    // thing the room is paused on — can't be used to force out a player
    // who simply hasn't rebought yet outside a bust pause.
    socket.on('room:leave-for', ({ hostId, targetId }) => {
      const room = rooms.getRoomByPlayer(hostId);
      if (!room || room.hostId !== hostId) return;
      const target = room.players.find(p => p.id === targetId);
      if (!target || target.chips !== 0 || target.left) return;
      const result = rooms.leave(targetId);
      if (!result) return;
      result.touch();
      if (result.awaitingBustResolution) tryAdvanceIfClear(result);
      else io.to(result.code).emit('room:state', result.getLobbyState());
    });

    socket.on('player:poke', ({ fromId, targetId, emoji }) => {
      const room = rooms.getRoomByPlayer(fromId);
      if (!room) return socket.emit('game:error', '未找到房间');
      const result = room.poke(fromId, targetId);
      if (result.error) return socket.emit('game:error', result.error);
      // Cooldown hit: silently drop, no broadcast, no error toast (see
      // RoomManager.poke's comment — this is the fix for GitHub #19's "过于
      // 频繁的提示" complaint).
      if (result.ignored) return;
      room.touch();
      // emoji is an optional user-picked reaction (see PlayerSeat's poke
      // picker) — validated against a fixed allowlist so an arbitrary
      // string can't be broadcast as-is.
      const safeEmoji = POKE_EMOJI.includes(emoji) ? emoji : null;
      if (safeEmoji === '🥚') room.recordEggPoke(targetId);
      io.to(room.code).emit('player:poked', { fromId, targetId, emoji: safeEmoji });
    });

    // 打字聊天广播（2026-08-15）——跟 player:poke 是同一层"纯社交、不碰
    // 游戏状态"广播，唯一区别是没有 targetId，全房间都收。
    socket.on('chat:message', ({ playerId, text } = {}) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room) return socket.emit('game:error', '未找到房间');
      const result = room.chat(playerId, text);
      if (result.error) return socket.emit('game:error', result.error);
      if (result.ignored) return; // 冷却期内静默丢弃，跟拍一拍的处理一致，不单独报错打扰
      room.touch();
      io.to(room.code).emit('chat:message', { fromId: playerId, text: result.text });
    });

    socket.on('room:restart', ({ playerId }) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room) return socket.emit('game:error', '未找到房间');
      if (room.hostId !== playerId) return socket.emit('game:error', '只有房主可以重新开始');
      room.restart();
      room.touch();
      io.to(room.code).emit('room:state', room.getLobbyState());
    });

    // Host-only "call it a night" — unlike room:restart, chips/debt are
    // NOT reset (this is the final tally, not a fresh session), and unlike
    // the chips-run-out auto-pause, this is a deliberate action, so the
    // client marks it `hostEnded` to auto-open the ledger instead of just
    // toasting a reason.
    socket.on('room:end-game', ({ playerId }) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room) return socket.emit('game:error', '未找到房间');
      if (room.hostId !== playerId) return socket.emit('game:error', '只有房主可以结束游戏');
      endGameNow(room, '房主结束了本局对局');
    });

    // Resolving the "计时游戏" time's-up pause (room.awaitingTimerDecision) —
    // only reachable once the current hand has actually finished (see
    // tryAdvanceIfClear), never mid-hand. Host-only, same as the other
    // room-lifecycle decisions.
    socket.on('room:timer-end-game', ({ playerId }) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room) return socket.emit('game:error', '未找到房间');
      if (room.hostId !== playerId) return socket.emit('game:error', '只有房主可以决定');
      if (!room.awaitingTimerDecision) return;
      endGameNow(room, '计时结束，房主结束了本局对局');
    });

    socket.on('room:timer-continue', ({ playerId }) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room) return socket.emit('game:error', '未找到房间');
      if (room.hostId !== playerId) return socket.emit('game:error', '只有房主可以决定');
      if (!room.awaitingTimerDecision) return;
      // "忽略继续" goes untimed from here on, rather than silently
      // restarting the same duration — an explicit "ignore" reads as
      // "stop tracking time for this session", not "give me another 30
      // minutes without asking".
      room.awaitingTimerDecision = false;
      room.gameTimerEndsAt = null;
      room.touch();
      tryAdvanceIfClear(room);
    });

    // On-demand only (not folded into the high-frequency room:state
    // broadcast every action already triggers) — the history can grow to
    // dozens of hands across a night, no need to ship all of it on every
    // single check/call.
    socket.on('room:get-hand-history', ({ playerId }) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room) return socket.emit('game:error', '未找到房间');
      // Per-viewer response: everyone gets the same public `reveals`
      // (showdown contenders, or a fold-win winner who opted into 亮牌炫耀),
      // plus this one viewer's own hole cards for hands they were dealt
      // into — same rule the live table already applies (own cards always
      // visible, others' hidden unless publicly shown). Built fresh per
      // request; `_privateHoleCards` never leaves the server directly.
      const personalized = room.handHistory.map(h => {
        const { _privateHoleCards, ...pub } = h;
        const mine = _privateHoleCards?.find(c => c.id === playerId);
        const alreadyPublic = pub.reveals.some(r => r.id === playerId);
        const myName = h.settle.find(s => s.id === playerId)?.name;
        const reveals = mine && !alreadyPublic
          ? [...pub.reveals, { id: playerId, name: myName, holeCards: mine.holeCards }]
          : pub.reveals;
        return { ...pub, reveals };
      });
      socket.emit('room:hand-history', personalized);
    });

    socket.on('room:sync', ({ playerId }) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room) {
        // Reconnected too late — the grace period already expired and the
        // room (or this player's spot in it) is gone. Say so explicitly
        // instead of leaving the client sitting on a stale lobby forever.
        socket.emit('room:gone');
        return;
      }
      // Re-associate this (possibly new, post-reconnect) socket with the
      // room: without this, a reconnected client never gets back into the
      // socket.io room (misses future broadcasts) and this connection's own
      // future 'disconnect' wouldn't know which player it was for.
      myPlayerId = playerId;
      room.touch();
      room.updateSocket(playerId, socket.id);
      room.setConnected(playerId, true);
      socket.join(room.code);
      clearTimeout(pendingRemovals.get(playerId));
      pendingRemovals.delete(playerId);
      // Broadcast to the whole room (not just this socket) so everyone
      // else's "XXX 断线中" indicator clears too, and — once a game is in
      // progress — so maybeArmTurnClock re-evaluates whether the
      // safety timeout should still be ticking.
      if (room.isAwaitingSettlementAck() && room.game) {
        // Reconnection during settlement wait: send room:state to everyone
        // (connected markers), then send game:state + showdown data +
        // settlement progress to the reconnecting socket only. We avoid
        // broadcastRoom here because it sends game:state to all players,
        // which the client handler uses to clear settlement modals.
        io.to(room.code).emit('room:state', room.getLobbyState());
        socket.emit('game:state', room.getStateForPlayer(playerId));
        if (room.lastShowdown) socket.emit('game:showdown', room.lastShowdown);
        socket.emit('game:settlement-progress', room.getSettlementProgress());
        // NOTE: deliberately does NOT touch the settlement timer. This used
        // to call clearSettlementTimer(room) here, left over from when
        // armSettlementTimer only ever armed a 10-minute safety timeout for
        // a *disconnected* eligible player (see git history, "remove
        // auto-advance on settlement-wait disconnect") — clearing made
        // sense there because a reconnect removed the reason the timer
        // existed. Since the "多个玩家的时候…太慢了" rewrite, armSettlementTimer
        // is instead the ONE unconditional auto-advance timer for the whole
        // display window, armed once in handleActionResult right after
        // beginSettlementWait — nothing should cancel it early. But
        // room:sync fires on every RoomPage mount, not just real
        // reconnects — including a brand-new player's own client navigating
        // to the room right after room:join — so the stale clear call was
        // silently killing the only auto-advance mechanism for the rest of
        // the display window whenever anyone's client (re)mounted mid-wait
        // (GitHub issue #16).
      } else if (room.game) {
        broadcastRoom(room);
      } else {
        io.to(room.code).emit('room:state', room.getLobbyState());
      }
    });

    socket.on('room:kick', ({ hostId, targetId }) => {
      const room = rooms.getRoomByPlayer(hostId);
      if (!room || room.hostId !== hostId) return;
      const target = room.players.find(p => p.id === targetId);
      if (target?.socketId) {
        io.to(target.socketId).emit('room:kicked');
      }
      const wasAwaitingSettlement = room.isAwaitingSettlementAck();
      rooms.leave(targetId);
      room.touch();
      io.to(room.code).emit('room:state', room.getLobbyState());
      // If settlement was blocked by the kicked player (who was removed
      // from eligiblePlayerIds by Room.removePlayer), check if all
      // remaining eligible players have now acked. dropFromSettlementWait
      // is idempotent on an already-removed ID: Set.delete returns false
      // (no-op) but still returns _allSettlementAcksIn().
      if (wasAwaitingSettlement && room.isAwaitingSettlementAck() &&
          room.dropFromSettlementWait(targetId)) {
        advanceRoom(room);
      }
    });

    socket.on('game:ready-next', ({ playerId }) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room?.isAwaitingSettlementAck()) return;
      room.touch();
      if (room.ackReady(playerId)) advanceRoom(room);
      else io.to(room.code).emit('game:settlement-progress', room.getSettlementProgress());
    });

    socket.on('game:reveal-cards', ({ playerId }) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room?.isAwaitingSettlementAck() || !room.game) return;

      const player = room.game.players.find(p => p.id === playerId);
      if (!player) return;
      // Two people can legitimately opt into showing a hand nobody made
      // them prove: (a) a fold-win winner — nobody called them down, so
      // showing is purely voluntary; (b) anyone who folded this hand — they
      // can show off what they gave up. Both only during the post-hand
      // settlement wait, never mid-hand (that would leak live info to
      // still-active opponents).
      const activePlayers = room.game.players.filter(p => p.status !== 'folded');
      const isFoldWinWinner = player.status !== 'folded' && activePlayers.length === 1 && activePlayers[0].id === playerId;
      if (!isFoldWinWinner && player.status !== 'folded') return;
      // No double-reveal
      if (!room.revealedPlayerIds) room.revealedPlayerIds = new Set();
      if (room.revealedPlayerIds.has(playerId)) return;
      room.revealedPlayerIds.add(playerId);
      room.touch();

      const revealedHoleCards = player.holeCards.map(parseCard);
      io.to(room.code).emit('game:cards-revealed', {
        playerId,
        playerName: player.name,
        holeCards: revealedHoleCards,
      });

      // Same settlement-wait invariant room.lastShowdown already relies on:
      // no new hand can start until this one's wait resolves, so the most
      // recent handHistory entry is still this hand — patch its reveals in
      // now that this player opted in, instead of their folded cards
      // staying private forever. A folded player is never already in
      // `reveals` (showdownReveal only ever contains contenders who didn't
      // fold), so no dedupe check needed here.
      const lastHand = room.handHistory[room.handHistory.length - 1];
      if (lastHand) {
        lastHand.reveals.push({ id: playerId, name: player.name, holeCards: revealedHoleCards });
      }
    });

    // ─── PVE (人机对战) ───────────────────────────────────────────────────
    // pveBroadcastState/pveHandleResult/pveRunAiLoop are defined once at
    // server scope above (not per-connection) — they route by pveId via
    // pveActiveSocket, not by closing over this specific socket, so a
    // reconnect under the same pveId picks up correctly.

    // Read-only lookup for the homepage "继续上局" card (2026-08-02 路由
    // 重构)——mirrors room:peek above: no side effects, doesn't touch
    // pveSessions/pveActiveSocket, safe to call before the client commits
    // to actually resuming.
    // ─── 语音对讲信令（双机实测阶段）────────────────────────────────────────
    // 这三个事件与游戏状态完全无关：不碰 rooms、不碰 myPlayerId，靠 socket.io
    // 自己的 room 机制维护成员关系。之所以不复用牌桌房间号，是因为这一步要能
    // 在**不开局**的情况下单独测连通性。

    socket.on('voice:join', ({ code } = {}, callback) => {
      const normalized = String(code ?? '').trim();
      if (!/^\d{4}$/.test(normalized)) return callback?.({ error: '暗号要是 4 位数字' });

      const key = voiceRoomKey(normalized);
      // members 已经排除了自己，所以满员条件就是"另外那些人已经占满上限"——
      // 这里写成 MAX - 1 会把**第二个**人就挡在外面（测试第一版实测到）。
      const members = [...(io.sockets.adapter.rooms.get(key) ?? [])].filter(id => id !== socket.id);
      if (members.length >= VOICE_TEST_MAX_PEERS) {
        return callback?.({ error: '这个暗号已经有两个人在用了，换一个试试' });
      }

      // 换暗号时先退掉旧的，否则旧房间里的人会一直以为他还在
      for (const room of socket.rooms) {
        if (room.startsWith('voice:') && room !== key) {
          socket.leave(room);
          socket.to(room).emit('voice:peer-left', { id: socket.id });
        }
      }

      socket.join(key);
      socket.to(key).emit('voice:peer-joined', { id: socket.id });
      // 谁先谁后由服务端一次性定死：**已经在房间里的人当接听方，后进来的当
      // 发起方**。两边各自猜的话会同时发 offer（glare），是这类实现最常见的
      // 卡死原因。
      callback?.({ selfId: socket.id, peers: members, shouldInitiate: members.length > 0 });
    });

    // 转发建连信令。**必须校验目标在同一个语音房间**——否则任何人都能拿一个
    // socket id 往任意连接上推消息，这是白送的越权面，加一行就能堵掉。
    socket.on('voice:signal', ({ to, signal } = {}) => {
      if (!to || !signal) return;
      const shared = [...socket.rooms].some(
        room => room.startsWith('voice:') && io.sockets.adapter.rooms.get(room)?.has(to),
      );
      if (!shared) return;
      io.to(to).emit('voice:signal', { from: socket.id, signal });
    });

    socket.on('voice:leave', () => {
      for (const room of [...socket.rooms]) {
        if (!room.startsWith('voice:')) continue;
        socket.leave(room);
        socket.to(room).emit('voice:peer-left', { id: socket.id });
      }
    });

    // ─── 语音对讲信令（正式接入牌桌，2026-08-10）──────────────────────────
    // 复用游戏房间号做语音 mesh 的边界：玩家已经因为在牌桌里而在 room.code
    // 这个 socket.io 房间，不需要上面探路阶段那种单独"暗号"发现流程。另开
    // voice-mesh:${roomCode} 房间，只装"已开语音的人"，跟承载游戏广播的
    // room.code 分开，避免信令推给没开语音的人。音频数据依然不经过这
    // 里——这几个事件只转发 SDP/ICE，跟上面 voice:* 探路事件、跟游戏状态
    // 都互不影响。
    socket.on('voice:mesh-join', ({ playerId } = {}, callback) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room) return callback?.({ error: '不在任何房间里' });

      const key = voiceMeshKey(room.code);
      const members = [...(io.sockets.adapter.rooms.get(key) ?? [])].filter(id => id !== socket.id);
      if (members.length >= VOICE_MESH_MAX_PEERS) {
        return callback?.({ error: '语音房间已满' });
      }

      socket.data.voicePlayerId = playerId;
      socket.join(key);
      // 已在场的每一位都要收到通知——新成员对每个已在场的人主动发 offer，
      // 已在场的只应答，跟探路阶段"后进来的当发起方"是同一条规则，扩到 N
      // 人只是循环次数变了，协议本身没变，不存在双方同时发 offer 的竞态。
      socket.to(key).emit('voice:mesh-peer-joined', { socketId: socket.id, playerId });

      const peers = members
        .map(id => ({ socketId: id, playerId: io.sockets.sockets.get(id)?.data?.voicePlayerId ?? null }))
        .filter(p => p.playerId);
      callback?.({ selfId: socket.id, peers });
    });

    // 必须校验发信人真的走过 mesh-join、且目标在同一个语音房间——否则任何
    // 人拿一个 socket id 就能往任意连接推消息，是白送的越权面。
    socket.on('voice:mesh-signal', ({ to, signal } = {}) => {
      if (!to || !signal) return;
      const fromPlayerId = socket.data.voicePlayerId;
      if (!fromPlayerId) return;
      const shared = [...socket.rooms].some(
        room => room.startsWith('voice-mesh:') && io.sockets.adapter.rooms.get(room)?.has(to),
      );
      if (!shared) return;
      io.to(to).emit('voice:mesh-signal', { from: socket.id, fromPlayerId, signal });
    });

    // "正在说话"由按下/松开说话按钮直接驱动广播，不靠对远端音量做分析——
    // 项目已经定了按住说话（非常开麦、非语音激活），按下这个动作本身就是
    // 最可靠的信号，不依赖 ICE 是否协商完成、也不受中继延迟/抖动影响。
    // 服务端只做同房间转发，不判断真假。
    socket.on('voice:speaking', ({ playerId, speaking } = {}) => {
      const fromPlayerId = socket.data.voicePlayerId;
      if (!fromPlayerId || fromPlayerId !== playerId) return;
      const room = rooms.getRoomByPlayer(playerId);
      if (!room) return;
      socket.to(voiceMeshKey(room.code)).emit('voice:speaking', { playerId, speaking: !!speaking });
    });

    // 语音诊断上报（2026-08-15）：只记日志，不做任何判断/告警——见 design.md
    // 「生产环境语音诊断上报」。要求发信人真的走过 mesh-join，理由跟
    // voice:mesh-signal 一样：不校验的话任何 socket 都能刷诊断日志。
    socket.on('voice:diagnostic', (payload = {}) => {
      const fromPlayerId = socket.data.voicePlayerId;
      if (!fromPlayerId) return;
      const room = rooms.getRoomByPlayer(fromPlayerId);
      console.log('[voice-diag]', JSON.stringify({ ...payload, roomCode: room?.code ?? null, fromPlayerId, fromSocketId: socket.id }));
    });

    socket.on('voice:mesh-leave', () => {
      for (const room of [...socket.rooms]) {
        if (!room.startsWith('voice-mesh:')) continue;
        socket.leave(room);
        socket.to(room).emit('voice:mesh-peer-left', { socketId: socket.id, playerId: socket.data.voicePlayerId });
      }
      socket.data.voicePlayerId = null;
    });

    // 用 disconnecting 而不是 disconnect：disconnect 触发时 socket.rooms 已经
    // 被清空了，那时候再想通知"他走了"已经不知道该往哪儿发。
    socket.on('disconnecting', () => {
      for (const room of socket.rooms) {
        if (room.startsWith('voice-mesh:')) {
          socket.to(room).emit('voice:mesh-peer-left', { socketId: socket.id, playerId: socket.data.voicePlayerId });
        } else if (room.startsWith('voice:')) {
          socket.to(room).emit('voice:peer-left', { id: socket.id });
        }
      }
    });

    socket.on('pve:peek', ({ pveId }, callback) => {
      const session = pveId && pveSessions.get(pveId);
      if (!session) return callback?.({ exists: false });
      callback?.({ exists: true, handNumber: session.handNumber, seatCount: session.seatCount });
    });

    socket.on('pve:start', ({ playerName, pveId, seatCount }) => {
      if (!pveId) return socket.emit('game:error', '缺少玩家标识');
      socketToPveId.set(socket.id, pveId);
      pveActiveSocket.set(pveId, socket.id);
      let session = pveSessions.get(pveId);
      // A picked seatCount that differs from the live session's own means
      // the player explicitly chose a different table size (the seat
      // picker buttons pass their own literal count; only the "继续上局"
      // resume card ever passes back resumeCard.seatCount, which by
      // construction always matches the existing session) — treat that as
      // "start fresh", not "resume". Otherwise a stale session for this
      // device's pveId would silently keep winning over whatever table
      // size was just picked, forever.
      const requestedSeatCount = Number(seatCount);
      if (session && VALID_SEAT_COUNTS.includes(requestedSeatCount) && requestedSeatCount !== session.seatCount) {
        pveSessions.delete(pveId);
        session = null;
      }
      if (!session) {
        const name = (playerName || '').trim() || '玩家';
        const count = VALID_SEAT_COUNTS.includes(requestedSeatCount) ? requestedSeatCount : 2;
        session = new PveSession(pveId, name, { seatCount: count });
        session.touch();
        pveSessions.set(pveId, session);
      } else {
        // Resuming an existing session — playerName is whatever's in the
        // (possibly blank, on a cold-start resume) form field right now,
        // not the name this session actually started with. Ignore it.
        session.touch();
      }
      pveBroadcastState(session);
      // Resuming mid-showdown (session never advanced past the finished
      // hand because the human closed/backgrounded the tab before its
      // settlement sheet ever showed) — pveBroadcastState above already
      // sent the post-showdown game:state, but that alone left the client
      // stuck on "正在比牌…" forever with nothing to trigger its settlement
      // flow (see PveSession's lastShowdown comment for the full story).
      // Re-fire the same game:showdown this hand already sent once.
      if (session.isOver() && session.lastShowdown) socket.emit('game:showdown', session.lastShowdown);
      pveRunAiLoop(pveId); // heads-up: AI may be dealer/SB and act first, or may owe a move from before the disconnect
    });

    socket.on('pve:action', ({ action, amount }) => {
      const pveId = socketToPveId.get(socket.id);
      const session = pveId && pveSessions.get(pveId);
      if (!session) return socket.emit('game:error', '对局不存在');
      session.touch();
      const result = session.humanAction(action, amount);
      if (result.error) return socket.emit('game:error', result.error);
      pveHandleResult(session, result);
      pveRunAiLoop(pveId);
    });

    socket.on('pve:get-hand-history', () => {
      const pveId = socketToPveId.get(socket.id);
      const session = pveId && pveSessions.get(pveId);
      if (!session) return socket.emit('game:error', '对局不存在');
      socket.emit('pve:hand-history', session.handHistory);
    });

    socket.on('pve:ready-next', () => {
      const pveId = socketToPveId.get(socket.id);
      const session = pveId && pveSessions.get(pveId);
      if (!session) return socket.emit('game:error', '对局不存在');
      session.touch();
      const result = session.readyNext();
      if (result.error) return socket.emit('game:error', result.error);
      pveBroadcastState(session);
      pveRunAiLoop(pveId);
    });

    // Explicit "退出游戏" — free the session immediately instead of waiting
    // out the idle reaper, mirroring multiplayer's player:leave-room.
    socket.on('pve:leave', () => {
      const pveId = socketToPveId.get(socket.id);
      if (pveId) pveSessions.delete(pveId);
      socketToPveId.delete(socket.id);
      if (pveId) pveActiveSocket.delete(pveId);
    });

    socket.on('disconnect', () => {
      const pveId = socketToPveId.get(socket.id);
      if (pveId) {
        socketToPveId.delete(socket.id);
        // Only clear the pveId->socket pointer if it's still THIS socket —
        // if the same pveId already reconnected on a newer socket (fast
        // reload) before this stale disconnect event fires, don't let it
        // clobber the new, live association.
        if (pveActiveSocket.get(pveId) === socket.id) pveActiveSocket.delete(pveId);
      }

      if (!myPlayerId) return;
      const room = rooms.getRoomByPlayer(myPlayerId);
      if (!room) return;

      // 迟到的旧 socket 的 disconnect：玩家早就用新 socket 重连了，这条事
      // 件不代表任何真实的断线。什么都不做——既不标记，也不广播，更不给
      // 一个活着的玩家安排移除定时器。见 markDisconnectedIfCurrent 的注释。
      if (!room.markDisconnectedIfCurrent(myPlayerId, socket.id)) return;

      if (room.isAwaitingSettlementAck()) {
        // Settlement-wait disconnect: unlike the old behavior, we do NOT
        // drop the player from settlement wait or auto-advance (which was
        // the root cause of Bug 3 — in heads-up, the brief disconnect
        // would trigger advanceRoom → nextRound → only 1 active player →
        // game ends). Instead, treat it like any other mid-game disconnect:
        // just mark connected:false. 结算的推进由 beginSettlementWait 时就
        // 已经起好的 15 秒计时负责，这里**不重新起计时**——断线不该把结算
        // 画面延长，否则每来一次断线全桌就多等 15 秒。We broadcast
        // room:state and settlement-progress (but NOT game:state, which
        // would clear other players' settlement modals via the client's
        // game:state handler).
        io.to(room.code).emit('room:state', room.getLobbyState());
        io.to(room.code).emit('game:settlement-progress', room.getSettlementProgress());
      } else if (room.game) {
        // Mid-hand disconnect: no auto-fold, no removal. broadcastRoom lets
        // everyone see the "connected:false" flag immediately, and (once
        // Task 7 lands) arms the safety-timeout if it's this player's turn.
        broadcastRoom(room);
      } else {
        io.to(room.code).emit('room:state', room.getLobbyState());
      }

      if (room.status === 'waiting') {
        // Lobby disconnect: give them a grace period to reconnect (e.g. they
        // just backgrounded the tab to paste the invite link somewhere)
        // instead of yanking them — and possibly deleting the whole room,
        // if they were its only player — immediately. Unchanged from before.
        const pid = myPlayerId;
        const deadSocketId = socket.id;
        const timer = setTimeout(() => {
          pendingRemovals.delete(pid);
          const stillRoom = rooms.getRoomByPlayer(pid);
          const player = stillRoom?.players.find(p => p.id === pid);
          if (stillRoom && player && player.socketId === deadSocketId) {
            rooms.leave(pid);
            if (stillRoom.players.length > 0) {
              io.to(stillRoom.code).emit('room:state', stillRoom.getLobbyState());
            }
          }
        }, GRACE_PERIOD_MS);
        pendingRemovals.set(pid, timer);
      }
      // Mid-game (room.status !== 'waiting'): deliberately no removal timer
      // at all. The only ways a mid-game player loses their seat are an
      // explicit host kick (room:kick, unchanged) or busting out of chips
      // (existing nextRound() elimination, unchanged) — see design.md.
    });
  });

  // Idle-room reaper: mid-game disconnects have no per-player timeout (see
  // the comment above), so a room abandoned mid-hand would otherwise sit in
  // memory forever with nothing to ever clear it. Sweeps every 15 minutes;
  // .unref() so this interval alone never keeps the Node process (or a test
  // run) alive.
  const ROOM_IDLE_TTL_MS = 60 * 60 * 1000; // 用户反馈（2026-08-17）：12 小时太久了，缩到 1 小时
  const sweepInterval = setInterval(() => rooms.sweepIdleRooms(ROOM_IDLE_TTL_MS), 15 * 60 * 1000);
  sweepInterval.unref();

  return { app, server, io, rooms };
}

if (require.main === module) {
  const { server } = createServer();
  const PORT = process.env.PORT || 3001;
  server.listen(PORT, () => console.log(`🃏  翡翠厅 server → http://localhost:${PORT}`));
}

module.exports = { createServer };
