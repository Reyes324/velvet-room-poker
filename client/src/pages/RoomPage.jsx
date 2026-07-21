import { useState, useEffect, useRef, useCallback } from 'react';
import { useSocket } from '../hooks/useSocket';
import GameTable from '../components/GameTable';
import Lobby from '../components/Lobby';
import SettlementModal from '../components/SettlementModal';
import BustDecisionModal from '../components/BustDecisionModal';
import LedgerModal from '../components/LedgerModal';

// Real showdowns give the table this long to actually show the revealed
// hands before the settlement sheet appears — the sheet used to appear in
// the same instant as the reveal, covering hero's own cards and most of the
// seat rail before anyone had a chance to look (confirmed via real-device
// feedback). A fold-win has nothing to reveal, so it skips the wait.
const SHOWDOWN_REVEAL_DELAY_MS = 1400;

export default function RoomPage({ roomCode, playerId, playerName, onLeave }) {
  const [roomState, setRoomState] = useState(null);
  const [gameState, setGameState] = useState(null);
  const [showdown, setShowdown] = useState(null);
  const [settlement, setSettlement] = useState(null);
  const [toast, setToast] = useState(null);
  const [copied, setCopied] = useState(false);
  const [actionDisabled, setActionDisabled] = useState(false);
  const [iAmReady, setIAmReady] = useState(false);
  const [settlementProgress, setSettlementProgress] = useState(null);
  const [showBustModal, setShowBustModal] = useState(false);
  const [showLedger, setShowLedger] = useState(false);
  const [pokedSeat, setPokedSeat] = useState(null); // { targetId, key } | null
  const settlementTimerRef = useRef(null);

  const showToast = useCallback((msg, type = 'info') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const { emit, socket } = useSocket({
    'room:state':  (state) => setRoomState(state),
    'game:state': (state) => {
      setGameState(state);
      setShowdown(null);
      setSettlement(null);
      setIAmReady(false);
      setSettlementProgress(null);
      setActionDisabled(false);
      // A previous hand's delayed settlement sheet (see game:showdown below)
      // may still be pending when the next hand's state already arrived —
      // without this it would fire late and resurrect a stale settlement
      // for a hand that's already moved on.
      clearTimeout(settlementTimerRef.current);
    },
    'game:showdown': ({ winners, foldWin }) => {
      setShowdown(winners);
      const showSettlement = () => {
        setSettlement({ winners });
        // Real per-player ack count arrives via game:settlement-progress; this is
        // just a reasonable first paint before that first event lands.
        setSettlementProgress({ readyCount: 0, totalCount: (roomState?.players ?? []).length });
      };
      clearTimeout(settlementTimerRef.current);
      // Fold-wins have nothing on the table to reveal, so they skip the wait;
      // real showdowns get SHOWDOWN_REVEAL_DELAY_MS to actually look at the
      // revealed hands before the settlement summary appears.
      if (foldWin) showSettlement();
      else settlementTimerRef.current = setTimeout(showSettlement, SHOWDOWN_REVEAL_DELAY_MS);
    },
    'game:settlement-progress': (progress) => setSettlementProgress(progress),
    'game:ended': ({ reason }) => {
      showToast(reason ?? '游戏结束', 'info');
      clearTimeout(settlementTimerRef.current);
      setGameState(null);
      setSettlement(null);
      setIAmReady(false);
      setSettlementProgress(null);
    },
    'room:kicked': () => {
      showToast('你已被房主移出房间', 'danger');
      setTimeout(onLeave, 2000);
    },
    'room:gone': () => {
      showToast('重新连接超时，房间已失效，请重新创建或加入', 'danger');
      setTimeout(onLeave, 2500);
    },
    'game:error': (msg) => { showToast(msg, 'danger'); setActionDisabled(false); },
    'player:poked': ({ targetId }) => {
      const key = Date.now();
      setPokedSeat({ targetId, key });
      setTimeout(() => {
        setPokedSeat(p => (p?.key === key ? null : p));
      }, 700);
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

  // Detect the >0 → 0 transition (just busted) to pop the decision modal
  // once, the same pattern GameTable.jsx uses for justDealt/justRevealed.
  // Re-crossing 0 → >0 (rebuy landed) auto-dismisses it.
  const prevChipsRef = useRef(myRoomChips);
  useEffect(() => {
    if (prevChipsRef.current > 0 && myRoomChips === 0) setShowBustModal(true);
    else if (myRoomChips > 0) setShowBustModal(false);
    prevChipsRef.current = myRoomChips;
  }, [myRoomChips]);

  function rebuy() {
    emit('player:rebuy', { playerId });
  }

  function poke(targetId) {
    emit('player:poke', { fromId: playerId, targetId });
  }

  function handleAction(action, amount) {
    setActionDisabled(true);
    emit('game:action', { playerId, action, amount });
  }

  function handleReady() {
    setIAmReady(true);
    emit('game:ready-next', { playerId });
  }

  function copyInvite() {
    const url = `${window.location.origin}/room/${roomCode}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function kick(targetId) {
    emit('room:kick', { hostId: playerId, targetId });
  }

  const isHost = roomState?.hostId === playerId;
  const inGame = roomState?.status === 'playing' && gameState;

  // Whoever's turn it currently is, cross-referenced against roomState's
  // connection flags (gameState doesn't carry `connected` — that lives on
  // the room-level player list, see server/RoomManager.js getLobbyState).
  const stuckPlayer = inGame
    ? roomState.players?.find(p => p.id === gameState.actionPlayerId && p.connected === false)
    : null;

  function foldForDisconnected() {
    emit('game:fold-disconnected', { hostId: playerId, targetId: stuckPlayer.id });
  }

  // ─── Lobby ───
  if (!inGame) {
    return (
      <>
        <Lobby
          roomState={{ code: roomCode, hostId: roomState?.hostId, players: roomState?.players ?? [] }}
          playerId={playerId}
          onCopy={copyInvite}
          onKick={kick}
          onStart={() => emit('room:start', { playerId })}
          onRestart={() => emit('room:restart', { playerId })}
          onRebuy={rebuy}
          onExit={onLeave}
          onOpenLedger={() => setShowLedger(true)}
          copied={copied}
        />
        {showLedger && (
          <LedgerModal
            players={roomState?.players ?? []}
            startingChips={roomState?.startingChips ?? 1000}
            myId={playerId}
            onClose={() => setShowLedger(false)}
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
        onPoke={poke}
        pokedSeat={pokedSeat}
        settlementOpen={!!settlement}
      />
      {showBustModal && !amPlaying && myRoomChips === 0 && (
        <BustDecisionModal
          onRebuy={rebuy}
          onSpectate={() => setShowBustModal(false)}
          onLeave={onLeave}
        />
      )}
      {showLedger && (
        <LedgerModal
          players={roomState?.players ?? []}
          startingChips={roomState?.startingChips ?? 1000}
          myId={playerId}
          onClose={() => setShowLedger(false)}
        />
      )}
      {settlement && settlement.winners?.length > 0 && (
        <SettlementModal
          winners={settlement.winners}
          myId={playerId}
          iAmReady={iAmReady}
          readyCount={settlementProgress?.readyCount ?? (iAmReady ? 1 : 0)}
          totalCount={settlementProgress?.totalCount ?? (roomState?.players ?? []).length}
          onReady={handleReady}
        />
      )}
      {stuckPlayer && (
        <div className="toast toast--info">
          {stuckPlayer.name} 断线中，等待重连…
          {isHost && (
            <span
              style={{ marginLeft: 12, textDecoration: 'underline', cursor: 'pointer' }}
              onClick={foldForDisconnected}
            >
              帮TA弃牌
            </span>
          )}
        </div>
      )}
      {toast && <div className={`toast toast--${toast.type}`}>{toast.msg}</div>}
    </>
  );
}
