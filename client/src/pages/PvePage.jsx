import { useState, useCallback, useRef, useEffect } from 'react';
import { useSocket } from '../hooks/useSocket';
import GameTable from '../components/GameTable';
import SettlementModal from '../components/SettlementModal';

// Same pacing as RoomPage's real-showdown reveal — see that file's own
// comment. Duplicated rather than imported: it's one constant, and PVE is
// deliberately kept structurally independent from the room/multiplayer
// page (see design.md「新增：单人人机对战（PVE）模式」).
const SHOWDOWN_REVEAL_DELAY_MS = 1400;

// Reuses vr_playerId — the same anonymous per-device id multiplayer already
// persists — rather than inventing a separate PVE identity. There's no
// namespace collision risk (RoomManager and the server's pveSessions Map are
// entirely separate keyed structures); this is just "this browser", same as
// multiplayer already treats it.
function getPveId() {
  let id = localStorage.getItem('vr_playerId');
  if (!id) { id = Math.random().toString(36).slice(2, 10); localStorage.setItem('vr_playerId', id); }
  return id;
}

export default function PvePage({ playerName, onLeave }) {
  const [gameState, setGameState] = useState(null);
  const [showdown, setShowdown] = useState(null);
  const [settlement, setSettlement] = useState(null);
  const [toast, setToast] = useState(null);
  const [actionDisabled, setActionDisabled] = useState(false);
  const settlementTimerRef = useRef(null);

  const showToast = useCallback((msg, type = 'info') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const { emit, socket } = useSocket({
    'game:state': (state) => {
      setGameState(state);
      setShowdown(null);
      setSettlement(null);
      setActionDisabled(false);
      clearTimeout(settlementTimerRef.current);
    },
    'game:showdown': ({ winners, foldWin }) => {
      setShowdown(winners);
      const showSettlement = () => setSettlement({ winners, foldWin });
      clearTimeout(settlementTimerRef.current);
      if (foldWin) showSettlement();
      else settlementTimerRef.current = setTimeout(showSettlement, SHOWDOWN_REVEAL_DELAY_MS);
    },
    'game:error': (msg) => { showToast(msg, 'danger'); setActionDisabled(false); },
  });

  useEffect(() => {
    // Re-sync on every (re)connect, not just mount — mirrors RoomPage's own
    // reasoning: a backgrounded mobile tab or brief network blip drops the
    // socket without necessarily unmounting this component. Server-side
    // pve:start resumes the existing session (matched by pveId) instead of
    // starting fresh when one's already there — see server/index.js.
    function sync() { emit('pve:start', { playerName, pveId: getPveId() }); }
    sync();
    socket.on('connect', sync);
    return () => {
      socket.off('connect', sync);
      clearTimeout(settlementTimerRef.current);
    };
  }, []);

  function handleAction(action, amount) {
    setActionDisabled(true);
    emit('pve:action', { action, amount });
  }

  function handleReady() {
    emit('pve:ready-next');
  }

  function handleExit() {
    emit('pve:leave');
    onLeave();
  }

  if (!gameState) {
    return <div className="pve-loading">开局中…</div>;
  }

  // getStateForPlayer only ever sends the real hole cards for the viewer's
  // own seat (see GameEngine.getStateForPlayer) — every other seat's
  // holeCards is either [] (folded) or [null, null] (masked). That makes
  // "whose entry has a real first card" a reliable way to find "me" without
  // depending on name matching (which could collide with a blank/default
  // name landing on both seats).
  const me = gameState.players.find(p => p.holeCards?.[0]);

  return (
    <>
      <GameTable
        gameState={gameState}
        myId={me?.id}
        roomCode="人机对战"
        showdown={showdown}
        onAction={handleAction}
        actionDisabled={actionDisabled}
        onExit={handleExit}
        amPlaying
        myChips={me?.chips ?? 0}
        settlementOpen={!!settlement}
      />
      {settlement && settlement.winners?.length > 0 && (
        <SettlementModal
          winners={settlement.winners}
          myId={me?.id}
          iAmReady={false}
          readyCount={0}
          totalCount={1}
          onReady={handleReady}
          isFoldWin={false}
        />
      )}
      {toast && <div className={`toast toast--${toast.type}`}>{toast.msg}</div>}
    </>
  );
}
