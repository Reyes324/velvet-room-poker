import { useState, useEffect, useCallback } from 'react';
import { useSocket } from '../hooks/useSocket';
import GameTable from '../components/GameTable';
import Lobby from '../components/Lobby';
import SettlementModal from '../components/SettlementModal';

export default function RoomPage({ roomCode, playerId, playerName, onLeave }) {
  const [roomState, setRoomState] = useState(null);
  const [gameState, setGameState] = useState(null);
  const [showdown, setShowdown] = useState(null);
  const [settlement, setSettlement] = useState(null);
  const [toast, setToast] = useState(null);
  const [copied, setCopied] = useState(false);
  const [actionDisabled, setActionDisabled] = useState(false);

  const showToast = useCallback((msg, type = 'info') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const { emit } = useSocket({
    'room:state':  (state) => setRoomState(state),
    'game:state': (state) => {
      setGameState(state);
      setShowdown(null);
      setSettlement(null);
      setActionDisabled(false);
    },
    'game:showdown': ({ winners, pot, settle }) => {
      setShowdown(winners);
      setSettlement({ winners, pot, settle });
    },
    'game:ended': ({ reason }) => {
      showToast(reason ?? '游戏结束', 'info');
      setGameState(null);
    },
    'room:kicked': () => {
      showToast('你已被房主移出房间', 'danger');
      setTimeout(onLeave, 2000);
    },
    'game:error': (msg) => { showToast(msg, 'danger'); setActionDisabled(false); },
  });

  useEffect(() => {
    emit('room:sync', { playerId });
  }, []);

  function handleAction(action, amount) {
    setActionDisabled(true);
    emit('game:action', { playerId, action, amount });
  }

  function copyInvite() {
    const url = `${window.location.origin}?room=${roomCode}`;
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
          onRebuy={() => emit('player:rebuy', { playerId })}
          copied={copied}
        />
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
      />
      {settlement && settlement.winners?.length > 0 && (
        <SettlementModal
          winner={{
            id: settlement.winners[0].id,
            name: settlement.winners[0].name,
            amount: settlement.winners[0].won,
            hand: settlement.winners[0].handName,
            isMe: settlement.winners[0].id === playerId,
          }}
          results={(settlement.settle ?? []).map(s => ({
            name: s.name + (s.id === playerId ? '（我）' : ''),
            delta: s.net === 0 ? null : s.net,
            isMe: s.id === playerId,
          }))}
          onClose={() => setSettlement(null)}
          seconds={5}
        />
      )}
      {toast && <div className={`toast toast--${toast.type}`}>{toast.msg}</div>}
    </>
  );
}
