import { useState, useEffect, useCallback } from 'react';
import { useSocket } from '../hooks/useSocket';
import PlayerSeat from '../components/PlayerSeat';
import ActionBar from '../components/ActionBar';
import Card from '../components/Card';
import './RoomPage.css';

const PHASE_LABEL = {
  waiting: '等待开始',
  preflop: '翻牌前',
  flop: '翻牌圈',
  turn: '转牌圈',
  river: '河牌圈',
  showdown: '摊牌',
};

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
    'room:state': (state) => setRoomState(state),
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
      showToast(reason, 'info');
      setGameState(null);
    },
    'room:kicked': () => {
      showToast('你已被房主移出房间', 'danger');
      setTimeout(onLeave, 2000);
    },
    error: (msg) => showToast(msg, 'danger'),
  });

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
                <div className="lobby-player-chips">${p.chips.toLocaleString()}</div>
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
              ? <button
                  className="start-btn"
                  disabled={(roomState?.players.length ?? 0) < 2}
                  onClick={() => emit('room:start', { playerId })}
                >
                  {(roomState?.players.length ?? 0) < 2 ? '等待更多玩家…' : '开始游戏'}
                </button>
              : <p className="waiting-text">等待房主开始游戏…</p>
            }
          </div>
        </div>

        {toast && <div className={`toast toast--${toast.type}`}>{toast.msg}</div>}
      </div>
    );
  }

  // ─── Game Table ───────────────────────────────────────────────────────────
  const myPlayer = gameState.players.find(p => p.id === playerId);
  const isMyTurn = gameState.actionPlayerId === playerId;

  return (
    <div className="table-view">
      <div className="table-felt">
        {/* Header */}
        <div className="table-header">
          <div className="table-code">{roomCode}</div>
          <div className="table-phase">{PHASE_LABEL[gameState.phase] ?? gameState.phase}</div>
        </div>

        {/* Players */}
        <div className={`players-layout players-layout--${gameState.players.length}`}>
          {gameState.players.map(p => (
            <div key={p.id} className="player-slot">
              <PlayerSeat
                player={p}
                isMe={p.id === playerId}
                isAction={gameState.actionPlayerId === p.id}
                gamePhase={gameState.phase}
              />
            </div>
          ))}
        </div>

        {/* Center */}
        <div className="table-center">
          <div className="community-cards">
            {Array.from({ length: 5 }).map((_, i) => {
              const card = gameState.communityCards[i];
              return <Card key={i} card={card} size="sm" faceDown={!card} />;
            })}
          </div>
          <div className="pot-display">
            <span className="pot-label">底池</span>
            <span className="pot-amount">${gameState.pot.toLocaleString()}</span>
          </div>
          {gameState.currentBet > 0 && (
            <div className="current-bet">当前注 ${gameState.currentBet.toLocaleString()}</div>
          )}
        </div>

        {/* Showdown overlay */}
        {showdown && (
          <div className="showdown-overlay">
            {showdown.map((w, i) => (
              <div key={i} className="showdown-winner">
                <span className="sw-icon">🏆</span>
                <span className="sw-name">{w.name}</span>
                <span className="sw-hand">{w.handName}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* My hole cards (fixed bottom center) */}
      {myPlayer && (
        <div className="my-cards">
          {myPlayer.holeCards?.length === 2
            ? myPlayer.holeCards.map((c, i) =>
                <Card key={i} card={c} size="lg" className="card--animate" />
              )
            : [<Card key={0} size="lg" faceDown />, <Card key={1} size="lg" faceDown />]
          }
        </div>
      )}

      {/* Action Bar */}
      <ActionBar
        gameState={gameState}
        myId={playerId}
        onAction={handleAction}
        disabled={actionDisabled}
      />

      {/* Toast */}
      {toast && <div className={`toast toast--${toast.type}`}>{toast.msg}</div>}
    </div>
  );
}
