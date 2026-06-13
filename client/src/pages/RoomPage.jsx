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

// ── Oval seat positions (left%, top%) per player count ──────────────────────
const SEAT_POSITIONS = {
  2: [{ left:50, top:88 }, { left:50, top:12 }],
  3: [{ left:50, top:88 }, { left:78, top:30 }, { left:22, top:30 }],
  4: [{ left:50, top:88 }, { left:82, top:50 }, { left:50, top:12 }, { left:18, top:50 }],
  5: [{ left:50, top:88 }, { left:82, top:62 }, { left:78, top:24 }, { left:22, top:24 }, { left:18, top:62 }],
  6: [{ left:50, top:88 }, { left:82, top:65 }, { left:85, top:32 }, { left:50, top:10 }, { left:15, top:32 }, { left:18, top:65 }],
  7: [{ left:50, top:88 }, { left:80, top:72 }, { left:88, top:45 }, { left:72, top:15 }, { left:28, top:15 }, { left:12, top:45 }, { left:20, top:72 }],
  8: [{ left:50, top:88 }, { left:76, top:76 }, { left:88, top:50 }, { left:76, top:22 }, { left:50, top:10 }, { left:24, top:22 }, { left:12, top:50 }, { left:24, top:76 }],
  9: [{ left:50, top:88 }, { left:73, top:80 }, { left:88, top:58 }, { left:85, top:28 }, { left:64, top:10 }, { left:36, top:10 }, { left:15, top:28 }, { left:12, top:58 }, { left:27, top:80 }],
};

// Rotate players array so hero (myPlayerId) is always at index 0
function getOrderedPlayers(players, myPlayerId) {
  const idx = players.findIndex(p => p.id === myPlayerId);
  if (idx === -1) return players;
  return [...players.slice(idx), ...players.slice(0, idx)];
}

// Push bet chip toward table center from its seat position
function getBetChipOffset(pos) {
  const dx = 50 - pos.left;
  const dy = 50 - pos.top;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  return {
    transform: `translate(calc(-50% + ${(dx / len) * 32}px), calc(-50% + ${(dy / len) * 32}px))`,
  };
}

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

  // ─── Game Table ───────────────────────────────────────────────────────────
  const orderedPlayers = getOrderedPlayers(gameState.players, playerId);
  const count = orderedPlayers.length;
  const positions = SEAT_POSITIONS[count] ?? SEAT_POSITIONS[9];
  const myPlayer = orderedPlayers[0]; // hero is always index 0 after rotation

  return (
    <div className="table-view">
      <div className="table-felt">
        {/* Header */}
        <div className="table-header">
          <div className="table-code">{roomCode}</div>
        </div>

        {/* Oval table */}
        <div className="table-oval">
          <div className="table-oval-felt" />

          {/* Community cards + pot centered in oval */}
          <div className="table-center">
            <div className="community-cards">
              {Array.from({ length: 5 }).map((_, i) => {
                const card = gameState.communityCards[i];
                return <Card key={i} card={card} size="sm" faceDown={!card} />;
              })}
            </div>
            <div className="pot-display">
              <span className="street-tag">{PHASE_LABEL[gameState.phase] ?? gameState.phase}</span>
              <span className="pot-label">底池</span>
              <span className="pot-amount">¥{gameState.pot.toLocaleString()}</span>
            </div>
            {gameState.currentBet > 0 && (
              <div className="current-bet">当前注 ¥{gameState.currentBet.toLocaleString()}</div>
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

          {/* Player seats: absolutely positioned around oval */}
          {orderedPlayers.map((p, idx) => {
            const pos = positions[idx];
            return (
              <div
                key={p.id}
                className={`player-slot${idx === 0 ? ' player-slot--hero' : ''}`}
                style={{ left: `${pos.left}%`, top: `${pos.top}%` }}
              >
                <PlayerSeat
                  player={p}
                  isMe={idx === 0}
                  isAction={gameState.actionPlayerId === p.id}
                  gamePhase={gameState.phase}
                />
                {p.bet > 0 && (
                  <div className="bet-chip" style={getBetChipOffset(pos)}>
                    ¥{p.bet.toLocaleString()}
                  </div>
                )}
              </div>
            );
          })}
        </div>
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

      {toast && <div className={`toast toast--${toast.type}`}>{toast.msg}</div>}
    </div>
  );
}
