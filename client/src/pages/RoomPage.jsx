import { useState, useEffect, useRef, useCallback } from 'react';
import { useSocket } from '../hooks/useSocket';
import { useActionLock } from '../hooks/useActionLock';
import { useVoiceMesh } from '../hooks/useVoiceMesh';
import { playActionFeedbackSfx } from '../utils/sfx';
import GameTable from '../components/GameTable';
import Lobby from '../components/Lobby';
import SettlementModal from '../components/SettlementModal';
import BustDecisionModal from '../components/BustDecisionModal';
import BustWaitModal from '../components/BustWaitModal';
import LedgerModal from '../components/LedgerModal';
import HandHistoryModal from '../components/HandHistoryModal';
import TimerDecisionModal from '../components/TimerDecisionModal';
import FeedbackModal from '../components/FeedbackModal';

// Real showdowns give the table this long to actually show the revealed
// hands before the settlement sheet appears — the sheet used to appear in
// the same instant as the reveal, covering hero's own cards and most of the
// seat rail before anyone had a chance to look (confirmed via real-device
// feedback). A fold-win has nothing to reveal, so it skips the wait.
const SHOWDOWN_REVEAL_DELAY_MS = 1400;

export default function RoomPage({ roomCode, playerId, playerName, justCreated, onLeave }) {
  const [roomState, setRoomState] = useState(null);
  const [gameState, setGameState] = useState(null);
  const [showdown, setShowdown] = useState(null);
  const [settlement, setSettlement] = useState(null);
  const [toast, setToast] = useState(null);
  const [copied, setCopied] = useState(false);
  const [iAmReady, setIAmReady] = useState(false);
  const [settlementProgress, setSettlementProgress] = useState(null);
  const [showLedger, setShowLedger] = useState(false);
  const [showHandHistory, setShowHandHistory] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [handHistory, setHandHistory] = useState([]);
  const [pokedSeat, setPokedSeat] = useState(null); // { targetId, key } | null
  const [chatBubble, setChatBubble] = useState(null); // { fromId, text, key } | null
  const [revealedPlayers, setRevealedPlayers] = useState({});
  // { [playerId]: { playerName, holeCards } }
  const settlementTimerRef = useRef(null);

  const showToast = useCallback((msg, type = 'info') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }, []);

  // 出牌乐观锁（见 hooks/useActionLock.js）。必须声明在 useSocket 之前——
  // 下面的 game:state / game:error 两个 handler 都要调用 unlock。
  const { locked: actionDisabled, lock: lockAction, unlock: unlockAction } = useActionLock();

  const { emit, socket } = useSocket({
    'room:state':  (state) => setRoomState(state),
    'game:state': (state) => {
      setGameState(state);
      setShowdown(null);
      setSettlement(null);
      setIAmReady(false);
      setSettlementProgress(null);
      unlockAction();
      setRevealedPlayers({});
      // A previous hand's delayed settlement sheet (see game:showdown below)
      // may still be pending when the next hand's state already arrived —
      // without this it would fire late and resurrect a stale settlement
      // for a hand that's already moved on.
      clearTimeout(settlementTimerRef.current);
    },
    'game:showdown': ({ winners, foldWin }) => {
      setShowdown(winners);
      const showSettlement = () => {
        setSettlement({ winners, foldWin });
        // Real per-player ack count arrives via game:settlement-progress; this is
        // just a reasonable first paint before that first event lands.
        setSettlementProgress({ readyCount: 0, totalCount: (roomState?.players ?? []).length });
      };
      clearTimeout(settlementTimerRef.current);
      // Used to skip the wait entirely for fold-wins ("nothing on the table
      // to reveal") — but the settlement sheet sliding up instantly also
      // meant the last folding player's own action bubble ("弃牌") never
      // had a moment to actually be seen before it got covered/upstaged
      // (user feedback, 2026-07-28). Give every showdown — fold-win or
      // real — the same pause.
      settlementTimerRef.current = setTimeout(showSettlement, SHOWDOWN_REVEAL_DELAY_MS);
    },
    'game:settlement-progress': (progress) => setSettlementProgress(progress),
    'game:ended': ({ reason, hostEnded }) => {
      showToast(reason ?? '游戏结束', 'info');
      clearTimeout(settlementTimerRef.current);
      setGameState(null);
      setSettlement(null);
      setIAmReady(false);
      setSettlementProgress(null);
      setRevealedPlayers({});
      // Host deliberately ending the night, not the chips-ran-out auto-pause
      // — surface the final tally immediately instead of leaving everyone to
      // dig for it in the menu after the fact.
      if (hostEnded) setShowLedger(true);
    },
    'room:kicked': () => {
      showToast('你已被房主移出房间', 'danger');
      setTimeout(onLeave, 2000);
    },
    'room:gone': () => {
      showToast('重新连接超时，房间已失效，请重新创建或加入', 'danger');
      setTimeout(onLeave, 2500);
    },
    'game:error': (msg) => { showToast(msg, 'danger'); unlockAction(); },
    'room:hand-history': (hands) => setHandHistory(hands),
    // No separate transient toast for game:timer-expired — it's redundant
    // with (and visually overlapped, confirmed on a real render) the
    // persistent state already driven off roomState.awaitingTimerDecision
    // below: the host gets TimerDecisionModal, everyone else gets a
    // persistent (not self-dismissing) banner. Both stay up until the host
    // actually resolves it, unlike a 3.5s toast that would vanish while
    // the host is still deciding.
    'player:poked': ({ fromId, targetId, emoji }) => {
      const key = Date.now();
      const fromName = roomState?.players?.find(p => p.id === fromId)?.name ?? null;
      setPokedSeat({ targetId, fromId, key, emoji: emoji ?? null, fromName });
      // 700ms 太短，表情还没看清就没了（用户反馈，2026-08-11）——拉到
      // 1.6s，跟 velvet.css 里 .poke-bubble 的淡出时机（pokeBubbleOut
      // 延迟到 1.3s 才开始）对齐，动画本身走完了这里才清状态，不会提前
      // 把还没播完淡出动画的气泡从 DOM 里砍掉。
      setTimeout(() => {
        setPokedSeat(p => (p?.key === key ? null : p));
      }, 1600);
    },
    // 打字聊天气泡（2026-08-15）——复用拍一拍这套"单个 key 化气泡+定时自
    // 清"的机制，不是另起一套状态管理。文字比表情需要更长的阅读时间，
    // 拉到 4s（拍一拍那个 1.6s 是给一个 emoji + 几个字的短标签，聊天是一
    // 整句话）。
    'chat:message': ({ fromId, text }) => {
      const key = Date.now();
      setChatBubble({ fromId, text, key });
      setTimeout(() => {
        setChatBubble(b => (b?.key === key ? null : b));
      }, 4000);
    },
    'game:cards-revealed': ({ playerId, playerName, holeCards }) => {
      setRevealedPlayers(prev => ({ ...prev, [playerId]: { playerName, holeCards } }));
    },
    // Fired once per real action, independent of game:state — see this
    // event's own comment in server/index.js (actionHappenedPayload) for
    // why sound can't just ride along on the game:state render the way the
    // action bubble text still does. Own actions are skipped here: ActionBar
    // already played this the instant the button was tapped (see its
    // playOwnActionSfx), well before this round-trip lands.
    'action:happened': ({ actorId, label }) => {
      if (actorId !== playerId) playActionFeedbackSfx(label);
    },
  });

  useEffect(() => {
    // Re-sync on every (re)connect, not just mount — a backgrounded mobile
    // tab or a brief network blip disconnects the socket without unmounting
    // this component, so mount-only sync would leave the server never
    // finding out this client came back (see server/index.js's grace period
    // for lobby disconnects).
    function sync() { emit('room:sync', { playerId }); }
    sync();
    socket.on('connect', sync);
    return () => socket.off('connect', sync);
  }, []);

  // roomState.players (not gameState.players) is the source of truth for my
  // own chip count once I've busted — gameState.players no longer has a row
  // for me at all once I'm excluded from the current hand.
  const myRoomChips = roomState?.players?.find(p => p.id === playerId)?.chips ?? 0;
  const amPlaying = gameState?.players?.some(p => p.id === playerId) ?? false;

  // Fires when someone else (the host, via room:leave-for) marks me left —
  // my own self-triggered leave (leaveRoom below) navigates immediately
  // and doesn't need to wait for this round-trip, but a host acting on my
  // behalf while I'm unresponsive has no other way to tell my client to
  // navigate away.
  useEffect(() => {
    const me = roomState?.players?.find(p => p.id === playerId);
    if (me?.left) {
      showToast('已离开对局', 'info');
      setTimeout(onLeave, 1500);
    }
  }, [roomState]);

  function rebuy() {
    emit('player:rebuy', { playerId });
  }

  function spectate() {
    emit('player:spectate', { playerId });
  }

  // Intentional leave — used by the busted player's "退出对局", an
  // impatient other player's "退出" while waiting on someone else's bust
  // decision, and the lobby's own "退出房间". Resolves immediately server-
  // side (marks left, keeps the ledger row) rather than relying on the
  // disconnect grace period, then navigates away right away.
  function leaveRoom() {
    emit('player:leave-room', { playerId });
    onLeave();
  }

  function bustLeaveFor(targetId) {
    emit('room:leave-for', { hostId: playerId, targetId });
  }

  function poke(targetId, emoji) {
    emit('player:poke', { fromId: playerId, targetId, emoji });
  }

  function sendChat(text) {
    emit('chat:message', { playerId, text });
  }

  function handleAction(action, amount) {
    lockAction();
    emit('game:action', { playerId, action, amount });
  }

  function handleReady() {
    setIAmReady(true);
    emit('game:ready-next', { playerId });
  }

  function handleReveal() {
    emit('game:reveal-cards', { playerId });
  }

  function copyInvite() {
    const url = `${window.location.origin}/room/${roomCode}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {}); // clipboard permission denied/unavailable — silent, manual "复制邀请链接" button still works
  }

  // Auto-copy the invite link the moment a just-created room's host lands
  // in the lobby, saving the manual tap — only for the host's own creation
  // (justCreated), never on a rejoin/reconnect into an already-existing
  // room, where re-copying on every reload would be surprising, not helpful.
  useEffect(() => {
    if (justCreated) copyInvite();
  }, []);

  function kick(targetId) {
    emit('room:kick', { hostId: playerId, targetId });
  }

  const isHost = roomState?.hostId === playerId;
  const inGame = roomState?.status === 'playing' && gameState;

  const voice = useVoiceMesh({ socket, emit, playerId });

  // Every disconnected seat, not just the one currently expected to act —
  // used to be scoped to `stuckPlayer` (the action-player-only case) and
  // surfaced as a single page-level toast. That hid any other player who'd
  // dropped but wasn't mid-turn, and put a heavy top-of-screen banner on
  // screen for what's really a per-seat fact (issue #20: "不同玩家断线
  // 中...放顶部是不是太重了"). Now every disconnected seat gets its own
  // small badge in PlayerSeat, so this only needs to be an id set — no
  // separate "gameState doesn't carry connected" cross-reference beyond
  // that lookup (still true: connection flags live on roomState.players,
  // see server/RoomManager.js getLobbyState).
  const disconnectedIds = inGame
    ? new Set((roomState.players ?? []).filter(p => p.connected === false).map(p => p.id))
    : null;

  // Anyone with 0 chips who hasn't left AND hasn't already resolved their
  // bust decision is exactly who the room is holding the next hand for
  // (server-side: awaitingBustResolution) — the room stays on 'playing'
  // status throughout, so this only needs the roomState.players list, not
  // any dedicated event. `bustResolved` excludes a player who already
  // picked "旁观留下" — without it they'd see this same blocking modal
  // again on every subsequent hand instead of the passive spectate view.
  const bustedPlayers = inGame ? (roomState.players ?? []).filter(p => p.chips === 0 && !p.left && !p.bustResolved) : [];
  const myBust = bustedPlayers.find(p => p.id === playerId);
  const othersBust = bustedPlayers.filter(p => p.id !== playerId);

  // ─── Lobby ───
  if (!inGame) {
    return (
      <>
        <Lobby
          roomState={{ code: roomCode, hostId: roomState?.hostId, players: roomState?.players ?? [] }}
          playerId={playerId}
          onCopy={copyInvite}
          onKick={kick}
          onStart={(durationMinutes) => emit('room:start', { playerId, durationMinutes })}
          onRestart={() => { emit('room:restart', { playerId }); showToast('已重新开始，筹码已重置', 'info'); }}
          onRebuy={rebuy}
          onExit={leaveRoom}
          onOpenLedger={() => setShowLedger(true)}
          onOpenHandHistory={() => { emit('room:get-hand-history', { playerId }); setShowHandHistory(true); }}
          copied={copied}
        />
        {showLedger && (
          <LedgerModal
            players={roomState?.players ?? []}
            startingChips={roomState?.startingChips ?? 1000}
            myId={playerId}
            onClose={() => setShowLedger(false)}
            eggCounts={roomState?.eggCounts}
          />
        )}
        {showHandHistory && (
          <HandHistoryModal
            hands={handHistory}
            myId={playerId}
            onClose={() => setShowHandHistory(false)}
          />
        )}
        {toast && <div className={`toast toast--${toast.type}`}>{toast.msg}</div>}
      </>
    );
  }

  // ─── Game Table ───
  return (
    <>
      <GameTable
        gameState={gameState}
        myId={playerId}
        roomCode={roomCode}
        showdown={showdown}
        onAction={handleAction}
        actionDisabled={actionDisabled}
        onExit={onLeave}
        amPlaying={amPlaying}
        myChips={myRoomChips}
        onRebuy={rebuy}
        onOpenLedger={() => setShowLedger(true)}
        onOpenHandHistory={() => { emit('room:get-hand-history', { playerId }); setShowHandHistory(true); }}
        onOpenFeedback={() => setShowFeedback(true)}
        onPoke={poke}
        pokedSeat={pokedSeat}
        settlementOpen={!!settlement}
        revealedPlayers={revealedPlayers}
        isHost={isHost}
        onEndGame={() => emit('room:end-game', { playerId })}
        gameTimerEndsAt={roomState?.gameTimerEndsAt ?? null}
        turnClock={roomState?.turnClock ?? null}
        myTimeBankMs={roomState?.players?.find(p => p.id === playerId)?.timeBankMs ?? 0}
        onExtendTurn={() => emit('game:extend-turn', { playerId })}
        paused={roomState?.paused ?? false}
        onPause={() => emit('room:pause', { playerId })}
        onResume={() => emit('room:resume', { playerId })}
        voiceEnabled={voice.enabled}
        voiceTalking={voice.talking}
        voiceMicError={voice.micError}
        speakingPlayerIds={voice.speakingPlayerIds}
        getVoiceVolume={voice.getVolume}
        onStartTalking={voice.startTalking}
        onStopTalking={voice.stopTalking}
        onSendChat={sendChat}
        chatBubble={chatBubble}
        disconnectedIds={disconnectedIds}
      />
      {roomState?.awaitingTimerDecision && isHost && (
        <TimerDecisionModal
          onEndGame={() => emit('room:timer-end-game', { playerId })}
          onContinue={() => emit('room:timer-continue', { playerId })}
        />
      )}
      {showHandHistory && (
        <HandHistoryModal
          hands={handHistory}
          myId={playerId}
          onClose={() => setShowHandHistory(false)}
        />
      )}
      {/* 用户反馈 #5（2026-08-04）：破产那一手看不到结算，不知道自己怎么输
          的。这个弹窗是全屏 overlay，会直接盖住底部的结算表——而输光筹码的
          那一手恰恰是最想看清楚的一手。
          真人局这里不能像 PVE 那样把它挂到结算的"我知道了"上：房间在等这个
          玩家做决定（服务端 awaitingBustResolution），别人都被卡着，不能让
          他停在结算页上无限拖延。
          闸门用的是 iAmReady（玩家已点"我知道了"）而**不是** !settlement。
          这个区别是致命的：settlement 只在 game:state / game:ended 时清除，
          而破产玩家点完确认后，房间正卡着等他做破产决策、根本不会发新状态
          ——用 !settlement 当条件的话，结算表永远不消失、借一底弹窗永远不
          出现，直接死锁，比原来的 bug 还严重。 */}
      {myBust && (!settlement || iAmReady) && (
        <BustDecisionModal
          onRebuy={rebuy}
          onSpectate={spectate}
          onLeave={leaveRoom}
          bustDecisionEndsAt={roomState?.bustDecisionEndsAt ?? null}
        />
      )}
      {!myBust && othersBust.length > 0 && (
        <BustWaitModal
          names={othersBust.map(p => p.name)}
          bustDecisionEndsAt={roomState?.bustDecisionEndsAt ?? null}
        />
      )}
      {!myBust && othersBust.length > 0 && isHost && (
        <div className="toast toast--info">
          {othersBust.map(p => p.name).join('、')}筹码清空，等待{othersBust.length > 1 ? '他们' : '他'}决策是否再借一底
          {othersBust.map(p => (
            <span
              key={p.id}
              style={{ marginLeft: 12, textDecoration: 'underline', cursor: 'pointer' }}
              onClick={() => bustLeaveFor(p.id)}
            >
              帮{p.name}离开
            </span>
          ))}
        </div>
      )}
      {roomState?.awaitingTimerDecision && !isHost && (
        <div className="toast toast--info">计时已到，等待房主决定是否结束…</div>
      )}
      {showLedger && (
        <LedgerModal
          players={roomState?.players ?? []}
          startingChips={roomState?.startingChips ?? 1000}
          myId={playerId}
          onClose={() => setShowLedger(false)}
          eggCounts={roomState?.eggCounts}
        />
      )}
      {settlement && settlement.winners?.length > 0 && (() => {
        const isFoldWin = !!settlement.foldWin;
        const iAmWinner = isFoldWin && settlement.winners[0].id === playerId;
        const iFolded = roomState?.players?.find(p => p.id === playerId)?.status === 'folded';
        const myCardsRevealed = !!revealedPlayers[playerId];
        return (
          <SettlementModal
            winners={settlement.winners}
            myId={playerId}
            iAmReady={iAmReady}
            readyCount={settlementProgress?.readyCount ?? (iAmReady ? 1 : 0)}
            totalCount={settlementProgress?.totalCount ?? (roomState?.players ?? []).length}
            endsAt={settlementProgress?.endsAt ?? null}
            onReady={handleReady}
            isFoldWin={isFoldWin}
            iAmWinner={iAmWinner}
            iFolded={iFolded}
            myCardsRevealed={myCardsRevealed}
            onReveal={handleReveal}
          />
        );
      })()}
      {showFeedback && <FeedbackModal onClose={() => setShowFeedback(false)} playerName={playerName} />}
      {toast && <div className={`toast toast--${toast.type}`}>{toast.msg}</div>}
    </>
  );
}
