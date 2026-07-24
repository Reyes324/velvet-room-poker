import { useState, useEffect, useRef, useCallback } from 'react';
import { useSocket } from '../hooks/useSocket';
import GameTable from '../components/GameTable';
import Lobby from '../components/Lobby';
import SettlementModal from '../components/SettlementModal';
import BustDecisionModal from '../components/BustDecisionModal';
import BustWaitModal from '../components/BustWaitModal';
import LedgerModal from '../components/LedgerModal';
import HandHistoryModal from '../components/HandHistoryModal';

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
  const [showLedger, setShowLedger] = useState(false);
  const [showHandHistory, setShowHandHistory] = useState(false);
  const [handHistory, setHandHistory] = useState([]);
  const [pokedSeat, setPokedSeat] = useState(null); // { targetId, key } | null
  const [revealedPlayers, setRevealedPlayers] = useState({});
  // { [playerId]: { playerName, holeCards } }
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
      // Fold-wins have nothing on the table to reveal, so they skip the wait;
      // real showdowns get SHOWDOWN_REVEAL_DELAY_MS to actually look at the
      // revealed hands before the settlement summary appears.
      if (foldWin) showSettlement();
      else settlementTimerRef.current = setTimeout(showSettlement, SHOWDOWN_REVEAL_DELAY_MS);
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
    'game:error': (msg) => { showToast(msg, 'danger'); setActionDisabled(false); },
    'room:hand-history': (hands) => setHandHistory(hands),
    'player:poked': ({ targetId }) => {
      const key = Date.now();
      setPokedSeat({ targetId, key });
      setTimeout(() => {
        setPokedSeat(p => (p?.key === key ? null : p));
      }, 700);
    },
    'game:cards-revealed': ({ playerId, playerName, holeCards }) => {
      setRevealedPlayers(prev => ({ ...prev, [playerId]: { playerName, holeCards } }));
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

  function handleReveal() {
    emit('game:reveal-cards', { playerId });
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

  // Anyone with 0 chips who hasn't left yet is exactly who the room is
  // holding the next hand for (server-side: awaitingBustResolution) — the
  // room stays on 'playing' status throughout, so this only needs the
  // roomState.players list, not any dedicated event.
  const bustedPlayers = inGame ? (roomState.players ?? []).filter(p => p.chips === 0 && !p.left) : [];
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
          onStart={() => emit('room:start', { playerId })}
          onRestart={() => emit('room:restart', { playerId })}
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
        onPoke={poke}
        pokedSeat={pokedSeat}
        settlementOpen={!!settlement}
        revealedPlayers={revealedPlayers}
        isHost={isHost}
        onEndGame={() => emit('room:end-game', { playerId })}
      />
      {showHandHistory && (
        <HandHistoryModal
          hands={handHistory}
          myId={playerId}
          onClose={() => setShowHandHistory(false)}
        />
      )}
      {myBust && (
        <BustDecisionModal onRebuy={rebuy} onLeave={leaveRoom} />
      )}
      {!myBust && othersBust.length > 0 && (
        <BustWaitModal names={othersBust.map(p => p.name)} onLeave={leaveRoom} />
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
      {showLedger && (
        <LedgerModal
          players={roomState?.players ?? []}
          startingChips={roomState?.startingChips ?? 1000}
          myId={playerId}
          onClose={() => setShowLedger(false)}
        />
      )}
      {settlement && settlement.winners?.length > 0 && (() => {
        const isFoldWin = !!settlement.foldWin;
        const iAmWinner = isFoldWin && settlement.winners[0].id === playerId;
        const myCardsRevealed = !!revealedPlayers[playerId];
        return (
          <SettlementModal
            winners={settlement.winners}
            myId={playerId}
            iAmReady={iAmReady}
            readyCount={settlementProgress?.readyCount ?? (iAmReady ? 1 : 0)}
            totalCount={settlementProgress?.totalCount ?? (roomState?.players ?? []).length}
            onReady={handleReady}
            isFoldWin={isFoldWin}
            iAmWinner={iAmWinner}
            myCardsRevealed={myCardsRevealed}
            onReveal={handleReveal}
          />
        );
      })()}
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
