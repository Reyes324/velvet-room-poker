import { useState, useEffect, useCallback } from 'react';
import { useSocket } from '../hooks/useSocket';
import GameTable from '../components/GameTable';
import './RoomPage.css';

export default function RoomPage({ roomCode, playerId, playerName, onLeave }) {
  const [roomState, setRoomState] = useState(null);
  const [gameState, setGameState] = useState(null);
  const [showdown, setShowdown] = useState(null);
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
      setActionDisabled(false);
    },
    'game:showdown': (winners) => {
      setShowdown(winners);
      const names = winners.map(w => `${w.name}（${w.handName}）`).join('、');
      showToast(`🏆 ${names} 赢得底池！`, 'win');
    },
    'game:ended': ({ reason }) => {
      showToast(reason ?? '游戏结束', 'info');
      setGameState(null);
    },
    'room:kicked': () => {
      showToast('你已被房主移出房间', 'danger');
      setTimeout(onLeave, 2000);
    },
    'game:error': (msg) => showToast(msg, 'danger'),
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

  // ─── Lobby ───────────────────────────────────────────────────────────────
  if (!inGame) {
    return (
      <div className="lobby">
        <div className="lobby-bg" />
        <div className="lobby-card">
          <div className="lobby-header">
            <div className="lobby-logo">翡翠厅</div>
            <div className="lobby-code-row">
              <span className="lobby-code-label">房间码</span>
              <span className="lobby-code">{roomCode}</span>
              <button className="copy-btn" onClick={copyInvite}>
                {copied ? '已复制 ✓' : '复制邀请链接'}
              </button>
            </div>
          </div>

          <div className="lobby-players">
            {roomState?.players.map(p => (
              <div key={p.id} className="lobby-player">
                <div className="lobby-player-avatar">{p.name[0].toUpperCase()}</div>
                <div className="lobby-player-name">{p.name}{p.id === playerId ? ' (我)' : ''}</div>
                <div className="lobby-player-chips">¥{p.chips.toLocaleString()}</div>
                {isHost && p.id !== playerId && (
                  <button className="kick-btn" onClick={() => kick(p.id)}>移出</button>
                )}
                {roomState.hostId === p.id && (
                  <span className="host-badge">房主</span>
                )}
              </div>
            ))}
          </div>

          <div className="lobby-footer">
            {isHost
              ? <div className="lobby-host-actions">
                  <button
                    className="start-btn"
                    disabled={(roomState?.players.length ?? 0) < 2}
                    onClick={() => emit('room:start', { playerId })}
                  >
                    {(roomState?.players.length ?? 0) < 2 ? '等待更多玩家…' : '开始游戏'}
                  </button>
                  <button
                    className="restart-btn"
                    onClick={() => emit('room:restart', { playerId })}
                  >
                    重新开始
                  </button>
                </div>
              : <p className="waiting-text">等待房主开始游戏…</p>
            }
          </div>
        </div>

        {toast && <div className={`toast toast--${toast.type}`}>{toast.msg}</div>}
      </div>
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
      {toast && <div className={`toast toast--${toast.type}`}>{toast.msg}</div>}
    </>
  );
}
