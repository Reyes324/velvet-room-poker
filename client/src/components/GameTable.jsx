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

// Real deal order: starts at the small blind, goes round the table once per
// hole card (2 rounds for hold'em) — matches how an actual dealer deals.
function sbFirstOrder(players) {
  const sbIdx = players.findIndex(p => p.isSB);
  const start = sbIdx === -1 ? 0 : sbIdx;
  return [...players.slice(start), ...players.slice(0, start)];
}

const DEAL_STEP = 0.07; // seconds between each card landing
const DEAL_CARD_DURATION = 0.35; // matches .card-deal's animation-duration

// Seat centers sit exactly on the table-oval's rail (center 187.5,285; rx
// 169.5, ry 195 — must match .table-oval's box in velvet.css exactly: top
// 90/height 390/left+right 18 around the 375-wide stage). Hero sits at the
// bottom (90°); opponents fill the remaining arc evenly around the same rail,
// every one of them exactly on the boundary — no exceptions, no inset.
//
// The showdown reveal / deal-in cards normally render ABOVE a seat, which
// would push above the top-bar for any seat landing near the oval's exact
// top vertex (always true for heads-up's lone opponent; also true for one
// seat on a 9-max table). Below this Y, PlayerSeat renders those cards to
// the SIDE instead — the avatar itself still sits precisely on the rail.
const CARDS_SIDE_BELOW_Y = 148;
function seatPositions(n) {
  const cx = 187.5, cy = 285, rx = 169.5, ry = 195;
  // Hero sits exactly on the oval's bottom vertex, same as every opponent seat
  // sits exactly on the rail. This used to need a -45px nudge to clear
  // .hero-section below it (smaller cards + a lower hero-section since then
  // freed up enough room — measured ~74px of clearance at the old -45 nudge,
  // i.e. ~29px left even fully undoing it — comfortably safe now).
  const heroPos = { x: cx, y: cy + ry };
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
  // prevPhaseRef starts null so justDealt also fires on first mount; the "!== preflop"
  // check (rather than "=== null") makes it fire on every hand, not just the first —
  // any transition INTO preflop (from showdown, or from nothing) is a fresh deal.
  const prevPhaseRef = useRef(null);
  // prevCardCountRef starts at current length to skip flip-reveal on reconnect
  const prevCardCountRef = useRef(gameState.communityCards.length);
  const prevShowdownRef = useRef(null);

  const cardCount = gameState.communityCards.length;
  const justDealt = prevPhaseRef.current !== 'preflop' && gameState.phase === 'preflop';
  const newCardFrom = prevCardCountRef.current; // indices >= this are newly revealed
  const justShowdown = !prevShowdownRef.current && showdown && showdown.length > 0;

  useEffect(() => {
    prevPhaseRef.current = gameState.phase;
    prevCardCountRef.current = cardCount;
    prevShowdownRef.current = showdown;
  }, [gameState.phase, cardCount, showdown]);

  // ── Hole-card deal sequence: SB-first round-robin stagger, hero flips
  // face-up only once every player's two cards have finished landing. ──────
  const dealOrder = sbFirstOrder(gameState.players);
  const dealDelayFor = (playerId, cardIdx) => {
    const idx = dealOrder.findIndex(p => p.id === playerId);
    return (cardIdx * dealOrder.length + (idx === -1 ? 0 : idx)) * DEAL_STEP;
  };
  const totalDealTime = (dealOrder.length * 2 - 1) * DEAL_STEP + DEAL_CARD_DURATION;

  const [heroRevealed, setHeroRevealed] = useState(true);
  const prevHeroRevealedRef = useRef(true);
  const justRevealed = !prevHeroRevealedRef.current && heroRevealed;
  useEffect(() => { prevHeroRevealedRef.current = heroRevealed; }, [heroRevealed]);

  useEffect(() => {
    // Depend on gameState.phase itself (not justDealt): justDealt is a one-render
    // pulse that reverts to false on the very next render (as soon as
    // prevPhaseRef catches up), which would immediately cancel this effect's
    // cleanup and clear the timeout before it ever fires. gameState.phase stays
    // 'preflop' across every render of the whole preflop betting round, so this
    // only re-runs on the actual transition into preflop, exactly once per hand.
    if (gameState.phase !== 'preflop') return;
    setHeroRevealed(false);
    const t = setTimeout(() => setHeroRevealed(true), (totalDealTime + 0.15) * 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState.phase]);

  // ── Action feedback bubbles ── whoever held actionPlayerId last render just
  // acted; diff their bet/status against the previous snapshot to say what they
  // did, and pop a fading bubble from their seat for a couple seconds.
  const prevActionSnapshotRef = useRef(null);
  const [actionBubbles, setActionBubbles] = useState({});

  useEffect(() => {
    const prevSnap = prevActionSnapshotRef.current;
    if (prevSnap && prevSnap.actionPlayerId && prevSnap.actionPlayerId !== gameState.actionPlayerId) {
      const actorId = prevSnap.actionPlayerId;
      const prevP = prevSnap.players.find(p => p.id === actorId);
      const currP = gameState.players.find(p => p.id === actorId);
      if (prevP && currP) {
        let text = null;
        if (currP.status === 'folded' && prevP.status !== 'folded') text = '弃牌';
        else if (currP.status === 'allin' && prevP.status !== 'allin') text = 'ALL IN';
        else if (currP.bet > prevP.bet) {
          text = currP.bet > prevSnap.currentBet
            ? `加注 ¥${currP.bet.toLocaleString()}`
            : `跟注 ¥${(currP.bet - prevP.bet).toLocaleString()}`;
        } else {
          text = '过牌';
        }
        const key = Date.now();
        setActionBubbles(b => ({ ...b, [actorId]: { text, key } }));
        setTimeout(() => {
          setActionBubbles(b => (b[actorId]?.key === key ? { ...b, [actorId]: undefined } : b));
        }, 1650);
      }
    }
    prevActionSnapshotRef.current = {
      actionPlayerId: gameState.actionPlayerId,
      currentBet: gameState.currentBet,
      players: gameState.players.map(p => ({ id: p.id, bet: p.bet, status: p.status })),
    };
  }, [gameState]);

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
          bubble={actionBubbles[me.id]}
        />
      </div>

      {opponents.map((p, i) => {
        const s = pos[i];
        // 187.5, 285: table-oval's true center (must match seatPositions' cx/cy) —
        // this is the "toward the pot" direction for the bet-chip fly-in, not hero's seat.
        const dx = 187.5 - s.x, dy = 285 - s.y, len = Math.hypot(dx, dy) || 1;
        const betStyle = { transform: `translate(calc(-50% + ${(dx / len) * 65}px), calc(-50% + ${(dy / len) * 65}px))` };
        const dealDelay = i * 0.1;
        // Seats too close to the top-bar render their cards to the side instead
        // of above (toward whichever side has more room) — see CARDS_SIDE_BELOW_Y.
        const cardsSide = s.y < CARDS_SIDE_BELOW_Y ? (s.x <= 187.5 ? 'right' : 'left') : null;
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
              bubble={actionBubbles[p.id]}
              dealing={!heroRevealed}
              dealDelays={[dealDelayFor(p.id, 0), dealDelayFor(p.id, 1)]}
              cardsSide={cardsSide}
            />
            {p.bet > 0 && <div className="bet-chip" style={betStyle}>¥{p.bet.toLocaleString()}</div>}
          </div>
        );
      })}

      <div className="hero-section">
        <div className="hero-cards">
          {me.holeCards?.length === 2
            ? (heroRevealed
                ? me.holeCards.map((c, i) => (
                    <Card
                      key={`face-${i}`}
                      card={c}
                      size="md"
                      animate={justRevealed ? 'flip-reveal' : null}
                      delay={justRevealed ? i * 0.1 : 0}
                    />
                  ))
                : me.holeCards.map((_, i) => (
                    <Card
                      key={`back-${i}`}
                      size="md"
                      faceDown
                      animate={justDealt ? 'card-deal' : null}
                      delay={justDealt ? dealDelayFor(myId, i) : 0}
                    />
                  )))
            : [<Card key={0} size="md" faceDown />, <Card key={1} size="md" faceDown />]}
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
