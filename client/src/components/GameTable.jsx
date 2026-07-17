import { useRef, useEffect, useState } from 'react';
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

// Seat centers on the preview oval (center 187.5,292; rx 159.5, ry 180).
// Hero sits at the bottom (90°); opponents fill the remaining arc evenly.
function seatPositions(n) {
  const cx = 187.5, cy = 292, rx = 159.5, ry = 180;
  // Nudge the hero marker up off the oval's exact bottom vertex (cy + ry) so its
  // avatar + D/SB/BB position badge clear the .hero-section block anchored below.
  // Measured via Playwright at cy + ry: badge bottom ~494px vs hero-section top
  // ~489px → ~4.6px overlap (badge visibly clipped behind the hole cards).
  // -20px yields ~15px of clearance instead.
  const heroPos = { x: cx, y: cy + ry - 20 };
  if (n === 0) return { hero: heroPos, opponents: [] };
  const opponents = [];
  for (let i = 0; i < n; i++) {
    const deg = n === 1 ? 270 : 150 + i * (240 / (n - 1));
    const r = (deg * Math.PI) / 180;
    opponents.push({ x: cx + rx * Math.cos(r), y: cy + ry * Math.sin(r) });
  }
  return { hero: heroPos, opponents };
}

export default function GameTable({ gameState, myId, roomCode, showdown, onAction, actionDisabled, onExit }) {
  const [showExitModal, setShowExitModal] = useState(false);
  const ordered = getOrderedPlayers(gameState.players, myId);
  const me = ordered[0];
  const opponents = ordered.slice(1);
  const { hero: heroSeatPos, opponents: pos } = seatPositions(opponents.length);
  const winnerNames = new Set((showdown || []).map(w => w.name));
  const isShowdown = gameState.phase === 'showdown';
  const myTurn = gameState.actionPlayerId === myId && !actionDisabled;
  const dense = opponents.length + 1 >= 7;

  // ── Animation refs (track prev state to compute what's newly visible) ──────
  // prevPhaseRef starts null so justDealt fires exactly on first mount (game start)
  const prevPhaseRef = useRef(null);
  // prevCardCountRef starts at current length to skip flip-reveal on reconnect
  const prevCardCountRef = useRef(gameState.communityCards.length);
  const prevShowdownRef = useRef(null);

  const cardCount = gameState.communityCards.length;
  const justDealt = prevPhaseRef.current === null && gameState.phase === 'preflop';
  const newCardFrom = prevCardCountRef.current; // indices >= this are newly revealed
  const justShowdown = !prevShowdownRef.current && showdown && showdown.length > 0;

  useEffect(() => {
    prevPhaseRef.current = gameState.phase;
    prevCardCountRef.current = cardCount;
    prevShowdownRef.current = showdown;
  }, [gameState.phase, cardCount, showdown]);

  return (
    <div className={`game-stage${dense ? ' game-stage--dense' : ''}`}>
      <div className="top-bar">
        <div className="menu-btn" onClick={() => setShowExitModal(true)}>≡</div>
        <div className="bankroll">¥{me.chips.toLocaleString()}</div>
      </div>
      {showExitModal && (
        <div className="modal-overlay" onClick={() => setShowExitModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">退出游戏</div>
            <div className="modal-body">游戏进行中，退出将自动弃牌。确定退出吗？</div>
            <div className="modal-btns">
              <div className="modal-btn-cancel" onClick={() => setShowExitModal(false)}>取消</div>
              <div className="modal-btn-danger" onClick={onExit}>退出</div>
            </div>
          </div>
        </div>
      )}

      <div className="table-oval">
        <Pot
          street={PHASE_LABEL[gameState.phase] ?? gameState.phase}
          amount={gameState.pot}
          burst={justShowdown}
        />
        <div className="community">
          {Array.from({ length: 5 }).map((_, i) => {
            const card = gameState.communityCards[i];
            const isNew = card && i >= newCardFrom;
            return card
              ? <Card
                  key={i}
                  card={card}
                  size="sm"
                  animate={isNew ? 'flip-reveal' : null}
                  delay={isNew ? (i - newCardFrom) * 0.1 : 0}
                />
              : <div key={i} className="c-empty" />;
          })}
        </div>
      </div>

      <div
        className="player-slot player-slot--hero"
        style={{ left: `${heroSeatPos.x}px`, top: `${heroSeatPos.y}px` }}
      >
        <PlayerSeat
          player={me}
          isMe={true}
          isAction={gameState.actionPlayerId === myId}
          isWinner={winnerNames.has(me.name)}
          gamePhase={gameState.phase}
          color={colorForId(me.id)}
        />
      </div>

      {opponents.map((p, i) => {
        const s = pos[i];
        const dx = 187.5 - s.x, dy = 292 - s.y, len = Math.hypot(dx, dy) || 1;
        const betStyle = { transform: `translate(calc(-50% + ${(dx / len) * 65}px), calc(-50% + ${(dy / len) * 65}px))` };
        const dealDelay = i * 0.1;
        return (
          <div
            key={p.id}
            className={`player-slot${justDealt ? ' deal-in' : ''}`}
            style={{ left: `${s.x}px`, top: `${s.y}px`, '--d': `${dealDelay}s` }}
          >
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
            ? me.holeCards.map((c, i) => (
                <Card
                  key={i}
                  card={c}
                  size="lg"
                  animate={justDealt ? 'deal-in' : null}
                  delay={justDealt ? opponents.length * 0.1 + 0.15 + i * 0.1 : 0}
                />
              ))
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
