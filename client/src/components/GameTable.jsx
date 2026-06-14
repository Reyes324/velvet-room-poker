import PlayerSeat from './PlayerSeat';
import ActionBar from './ActionBar';
import Card from './Card';
import Pot from './Pot';

const PHASE_LABEL = {
  waiting: '等待开始', preflop: '翻牌前', flop: '翻牌圈',
  turn: '转牌圈', river: '河牌圈', showdown: '摊牌',
};

function colorForId(id) {
  let h = 0;
  for (const ch of String(id)) h = (h + ch.charCodeAt(0)) % 8;
  return h;
}

function getOrderedPlayers(players, myId) {
  const idx = players.findIndex(p => p.id === myId);
  if (idx === -1) return players;
  return [...players.slice(idx), ...players.slice(0, idx)];
}

// Opponent seat centers on the preview oval (center 187.5,292; rx 159.5, ry 180),
// evenly across the top arc (150°→390°), hero stays at the bottom (not a rail seat).
function oppPositions(n) {
  const cx = 187.5, cy = 292, rx = 159.5, ry = 180;
  const out = [];
  for (let i = 0; i < n; i++) {
    const deg = n === 1 ? 270 : 150 + i * (240 / (n - 1));
    const r = (deg * Math.PI) / 180;
    out.push({ x: cx + rx * Math.cos(r), y: cy + ry * Math.sin(r) });
  }
  return out;
}

export default function GameTable({ gameState, myId, roomCode, showdown, onAction, actionDisabled }) {
  const ordered = getOrderedPlayers(gameState.players, myId);
  const me = ordered[0];
  const opponents = ordered.slice(1);
  const pos = oppPositions(opponents.length);
  const dense = opponents.length + 1 >= 7;
  const winnerNames = new Set((showdown || []).map(w => w.name));
  const isShowdown = gameState.phase === 'showdown';
  const myTurn = gameState.actionPlayerId === myId && !actionDisabled;

  return (
    <div className={`game-stage${dense ? ' game-stage--dense' : ''}`}>
      <div className="top-bar">
        <div className="menu-btn">≡</div>
        <div className="bankroll">¥{me.chips.toLocaleString()}</div>
      </div>

      <div className="table-oval">
        <Pot street={PHASE_LABEL[gameState.phase] ?? gameState.phase} amount={gameState.pot} />
        <div className="community">
          {Array.from({ length: 5 }).map((_, i) => {
            const card = gameState.communityCards[i];
            return card
              ? <Card key={i} card={card} size="sm" />
              : <div key={i} className="c-empty" />;
          })}
        </div>
      </div>

      {opponents.map((p, i) => {
        const s = pos[i];
        const dx = 187.5 - s.x, dy = 292 - s.y, len = Math.hypot(dx, dy) || 1;
        const betStyle = { transform: `translate(calc(-50% + ${(dx / len) * 40}px), calc(-50% + ${(dy / len) * 40}px))` };
        return (
          <div key={p.id} className="player-slot" style={{ left: `${s.x}px`, top: `${s.y}px` }}>
            <PlayerSeat
              player={p}
              isMe={false}
              isAction={gameState.actionPlayerId === p.id}
              isWinner={winnerNames.has(p.name)}
              gamePhase={gameState.phase}
              color={colorForId(p.id)}
            />
            {p.bet > 0 && <div className="bet-chip" style={betStyle}>¥{p.bet.toLocaleString()}</div>}
          </div>
        );
      })}

      <div className="hero-section">
        <div className="hero-cards">
          {me.holeCards?.length === 2
            ? me.holeCards.map((c, i) => <Card key={i} card={c} size="lg" />)
            : [<Card key={0} size="lg" faceDown />, <Card key={1} size="lg" faceDown />]}
        </div>
        <div className="hero-info">
          <div className="hero-name">{me.name}（我）</div>
          <div className="hero-chips">¥{me.chips.toLocaleString()}</div>
        </div>
      </div>

      {myTurn
        ? <ActionBar gameState={gameState} myId={myId} onAction={onAction} disabled={actionDisabled} />
        : <div className="waiting-bar"><div className="waiting-text">{isShowdown ? '正在比牌…' : '等待其他玩家行动…'}</div></div>}
    </div>
  );
}
