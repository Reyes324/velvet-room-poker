import { useRef, useEffect, useState } from 'react';
import PlayerSeat from './PlayerSeat';
import ActionBar from './ActionBar';
import Card from './Card';
import Pot from './Pot';
import { useTableScale } from '../hooks/useTableScale';

// Fixed design canvas for just the table scene (oval + seats + hero cards) —
// the single source of truth for both .table-canvas's inline size and
// useTableScale's fit calculation. Top bar and action bar live outside this
// canvas entirely now (real flex siblings, always full device width); this
// only has to describe the table itself.
const TABLE_REF_W = 375;
const TABLE_REF_H = 610;

const PHASE_LABEL = {
  waiting: '等待开始', preflop: '翻牌前', flop: '翻牌圈',
  turn: '转牌圈', river: '河牌圈', showdown: '摊牌',
};

function colorForId(id) {
  let h = 0;
  for (const ch of String(id)) h = (h + ch.charCodeAt(0)) % 8;
  return h;
}

const BET_CHIP_OFFSET = 40; // px toward the pot, from the seat center — was 65, tightened so the tail visibly reaches back to the avatar

// The bet-chip is offset from its seat toward the pot center by (dx,dy). Its
// little speech-bubble tail must point the opposite way — back at the seat it
// came from — for every seat around the oval, not just hero's (whose seat
// happens to sit at the bottom, the one position where "tail points straight
// down" was already correct by coincidence). --tail-deg rotates the tail
// (drawn pointing down by default) to match; see .bet-chip::after in velvet.css.
function betChipStyle(dx, dy) {
  const len = Math.hypot(dx, dy) || 1;
  const tailDeg = Math.atan2(dx, -dy) * (180 / Math.PI);
  return {
    transform: `translate(calc(-50% + ${(dx / len) * BET_CHIP_OFFSET}px), calc(-50% + ${(dy / len) * BET_CHIP_OFFSET}px))`,
    '--tail-deg': `${tailDeg}deg`,
  };
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
const COMMUNITY_COUNT = 5; // flop(3) + turn(1) + river(1), all dealt face-down up front

// Seat centers sit exactly on the table-oval's rail (center 187.5,215; rx
// 169.5, ry 195 — must match .table-canvas .table-oval's box in velvet.css
// exactly: top 20/height 390/left+right 18 within the TABLE_REF_W-wide
// canvas). Hero sits at the bottom (90°); opponents fill the remaining arc
// evenly around the same rail, every one of them exactly on the boundary —
// no exceptions, no inset.
//
// The showdown reveal / deal-in cards normally render ABOVE a seat, which
// would get clipped by .table-zone's own top edge for any seat landing near
// the oval's exact top vertex (always true for heads-up's lone opponent;
// also true for one seat on a 9-max table) — there's no top-bar to protect
// against anymore (it's outside the canvas entirely), just the canvas's own
// bounds. Below this Y, PlayerSeat renders those cards to the SIDE instead —
// the avatar itself still sits precisely on the rail.
const CARDS_SIDE_BELOW_Y = 70;
function seatPositions(n) {
  // ry is 180, not the box-matching 195, on purpose: at ry=195 the topmost
  // opponent's seat center sits at cy-ry=20, exactly the table-oval's own
  // top offset — which is *also* almost exactly the avatar's own radius, so
  // its unscaled top edge lands within a hair of canvas y=0 with zero spare
  // margin. Any rounding/border/badge pixel pushes it past table-zone's
  // overflow:hidden edge and clips it. Trimming ry by 15 moves the vertex
  // down to y=35, buying ~15px of real headroom above the avatar's own
  // radius — table-oval's CSS box (top/height) is trimmed to match.
  const cx = 187.5, cy = 215, rx = 169.5, ry = 180;
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

// Spectator variant: there's no hero seat to anchor from (a mid-game joiner
// waiting for the next hand, or a busted player who's been excluded from
// this one), so every player in gameState.players gets distributed evenly
// around the FULL ellipse instead of hero-at-bottom + a 240° arc for the
// rest. Same rail (cx/cy/rx/ry) as seatPositions(), just no reserved vertex.
function spectatorSeatPositions(n) {
  const cx = 187.5, cy = 215, rx = 169.5, ry = 180;
  if (n === 0) return [];
  const seats = [];
  for (let i = 0; i < n; i++) {
    const deg = -90 + i * (360 / n);
    const r = (deg * Math.PI) / 180;
    seats.push({ x: cx + rx * Math.cos(r), y: cy + ry * Math.sin(r) });
  }
  return seats;
}

export default function GameTable({ gameState, myId, roomCode, showdown, onAction, actionDisabled, onExit, amPlaying = true, myChips = 0, onRebuy, onOpenLedger }) {
  const [showExitModal, setShowExitModal] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const tableZoneRef = useRef(null);
  const { scaleX: tableScaleX, scaleY: tableScaleY } = useTableScale(tableZoneRef, TABLE_REF_W, TABLE_REF_H);
  // Position (seat rail, oval shape) stretches non-uniformly with tableScaleX/Y so the
  // table always fills the container's actual width/height. Content (cards, avatars,
  // text) must NOT stretch with it — each content layer below counters the parent's
  // non-uniform scale back down to this single uniform factor via its own
  // scale(csx, csy), so a wide-but-short viewport spreads seats out further apart
  // without ever squashing a card or number into an ellipse.
  const tableScaleUniform = Math.min(tableScaleX, tableScaleY) || 1;
  const csx = tableScaleX ? tableScaleUniform / tableScaleX : 1;
  const csy = tableScaleY ? tableScaleUniform / tableScaleY : 1;

  // amPlaying=false means myId isn't in gameState.players at all (mid-game
  // joiner waiting for next hand, or a busted player excluded from this
  // one) — there is no "me" to anchor the layout on, so every seat renders
  // via the opponent-style PlayerSeat, laid out on the full-ellipse variant.
  const ordered = amPlaying ? getOrderedPlayers(gameState.players, myId) : gameState.players;
  const me = amPlaying ? ordered[0] : null;
  const opponents = amPlaying ? ordered.slice(1) : ordered;
  const { hero: heroSeatPos, opponents: pos } = amPlaying
    ? seatPositions(opponents.length)
    : { hero: null, opponents: spectatorSeatPositions(opponents.length) };
  // Same "toward the pot center" bet-chip fly-in direction as the opponents.map loop
  // below, just for the hero's fixed bottom-vertex seat.
  const heroBetStyle = heroSeatPos && betChipStyle(187.5 - heroSeatPos.x, 215 - heroSeatPos.y);
  const winnerNames = new Set((showdown || []).map(w => w.name));
  const isShowdown = gameState.phase === 'showdown';
  const myTurn = amPlaying && gameState.actionPlayerId === myId && !actionDisabled;
  const dense = amPlaying ? opponents.length + 1 >= 7 : opponents.length >= 7;

  // ── Animation refs (track prev state to compute what's newly visible) ──────
  // prevCardCountRef starts at current length to skip flip-reveal on reconnect
  const prevCardCountRef = useRef(gameState.communityCards.length);
  const prevShowdownRef = useRef(null);

  const cardCount = gameState.communityCards.length;
  const newCardFrom = prevCardCountRef.current; // indices >= this are newly revealed
  const justShowdown = !prevShowdownRef.current && showdown && showdown.length > 0;

  useEffect(() => {
    prevCardCountRef.current = cardCount;
    prevShowdownRef.current = showdown;
  }, [cardCount, showdown]);

  // ── Hole-card deal sequence: SB-first round-robin stagger, hero flips
  // face-up only once every player's two cards — AND the 5 community cards
  // dealt face-down right after them (below) — have finished landing. ──────
  const dealOrder = sbFirstOrder(gameState.players);
  const dealDelayFor = (playerId, cardIdx) => {
    const idx = dealOrder.findIndex(p => p.id === playerId);
    return (cardIdx * dealOrder.length + (idx === -1 ? 0 : idx)) * DEAL_STEP;
  };
  // Community cards are dealt face-down as one continuous extension of the
  // same round-robin sequence, landing right after the last hole card.
  const holeDealSteps = dealOrder.length * 2;
  const communityDealDelayFor = (i) => (holeDealSteps + i) * DEAL_STEP;
  const totalDealTime = (holeDealSteps + COMMUNITY_COUNT - 1) * DEAL_STEP + DEAL_CARD_DURATION;

  const [heroRevealed, setHeroRevealed] = useState(true);
  // The single source of truth for "the deal-in animation is currently playing" —
  // stays true for the whole totalDealTime+0.15s window below, unlike the earlier
  // justDealt (removed): that was a one-render pulse computed straight from a ref,
  // which got reset to false by this very effect's OWN commit before the browser
  // ever painted the in-between state — so anything gated on it (community cards,
  // hero's own face-down cards, the opponent seat fly-in) silently never animated.
  // Gating all of those on this persistent `dealing` state instead — exactly like
  // the opponent reveal-card animation already correctly did — fixes that.
  const dealing = !heroRevealed;
  const prevHeroRevealedRef = useRef(true);
  const justRevealed = !prevHeroRevealedRef.current && heroRevealed;
  useEffect(() => { prevHeroRevealedRef.current = heroRevealed; }, [heroRevealed]);

  useEffect(() => {
    // gameState.phase (not `dealing`, which this effect itself sets) only changes
    // value on an actual transition into preflop, so this only fires once per hand.
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
        <div className="menu-btn" onClick={() => setShowMenu(true)}>≡</div>
        <div className="bankroll">¥{(amPlaying ? me.chips : myChips).toLocaleString()}</div>
      </div>
      {showMenu && (
        <div className="modal-overlay" onClick={() => setShowMenu(false)}>
          <div className="modal menu-popover" onClick={e => e.stopPropagation()}>
            <div className="menu-row" onClick={() => { setShowMenu(false); onOpenLedger?.(); }}>账本</div>
            <div className="menu-row menu-row--danger" onClick={() => { setShowMenu(false); setShowExitModal(true); }}>退出游戏</div>
          </div>
        </div>
      )}
      {showExitModal && (
        <div className="modal-overlay" onClick={() => setShowExitModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">退出游戏</div>
            <div className="modal-body">{amPlaying ? '游戏进行中，退出将自动弃牌。确定退出吗？' : '确定退出房间吗？'}</div>
            <div className="modal-btns">
              <div className="modal-btn-cancel" onClick={() => setShowExitModal(false)}>取消</div>
              <div className="modal-btn-danger" onClick={onExit}>退出</div>
            </div>
          </div>
        </div>
      )}

      <div className="table-zone" ref={tableZoneRef}>
      <div
        className="table-canvas"
        style={{
          width: `${TABLE_REF_W}px`, height: `${TABLE_REF_H}px`,
          transform: `translate(-50%, -50%) scale(${tableScaleX}, ${tableScaleY})`,
          '--csx': csx, '--csy': csy,
        }}
      >
      <div className="table-oval">
      <div className="table-oval-content">
        <Pot
          street={PHASE_LABEL[gameState.phase] ?? gameState.phase}
          amount={gameState.pot}
          burst={justShowdown}
        />
        <div className="community">
          {Array.from({ length: COMMUNITY_COUNT }).map((_, i) => {
            const card = gameState.communityCards[i];
            const isNew = card && i >= newCardFrom;
            if (card) {
              return (
                <Card
                  key={i}
                  card={card}
                  size="sm"
                  animate={isNew ? 'flip-reveal' : null}
                  delay={isNew ? (i - newCardFrom) * 0.1 : 0}
                />
              );
            }
            // Before the hand's first deal, there's genuinely nothing on the
            // table yet — dashed placeholder. Once dealing has happened
            // (waiting left), an unrevealed slot already has a card sitting
            // there face-down (dealt during the `dealing` window below),
            // waiting for its street — not an empty box.
            if (gameState.phase === 'waiting') {
              return <div key={i} className="c-empty" />;
            }
            return (
              <Card
                key={i}
                size="sm"
                faceDown
                animate={dealing ? 'card-deal' : null}
                delay={dealing ? communityDealDelayFor(i) : 0}
              />
            );
          })}
        </div>
      </div>
      </div>

      {amPlaying && (
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
          {/* Same persistent chip-bubble every opponent gets below — hero's own bet
              used to only flash as fading action text, never sat on the felt like
              everyone else's, which read as inconsistent from hero's own viewpoint. */}
          {me.bet > 0 && <div className="bet-chip" style={heroBetStyle}>¥{me.bet.toLocaleString()}</div>}
        </div>
      )}

      {opponents.map((p, i) => {
        const s = pos[i];
        // 187.5, 215: table-oval's true center (must match seatPositions' cx/cy) —
        // this is the "toward the pot" direction for the bet-chip fly-in, not hero's seat.
        const betStyle = betChipStyle(187.5 - s.x, 215 - s.y);
        const dealDelay = i * 0.1;
        // Seats too close to the table-zone's own top edge render their cards to the side instead
        // of above (toward whichever side has more room) — see CARDS_SIDE_BELOW_Y.
        const cardsSide = s.y < CARDS_SIDE_BELOW_Y ? (s.x <= 187.5 ? 'right' : 'left') : null;
        return (
          <div
            key={p.id}
            className={`player-slot${dealing ? ' deal-in' : ''}`}
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
              dealing={dealing}
              dealDelays={[dealDelayFor(p.id, 0), dealDelayFor(p.id, 1)]}
              cardsSide={cardsSide}
            />
            {p.bet > 0 && <div className="bet-chip" style={betStyle}>¥{p.bet.toLocaleString()}</div>}
          </div>
        );
      })}

      {amPlaying && (
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
                        animate={dealing ? 'card-deal' : null}
                        delay={dealing ? dealDelayFor(myId, i) : 0}
                      />
                    )))
              : [<Card key={0} size="md" faceDown />, <Card key={1} size="md" faceDown />]}
          </div>
          <div className="hero-info">
            <div className="hero-name">{me.name}（我）</div>
            <div className="hero-chips">¥{me.chips.toLocaleString()}</div>
          </div>
        </div>
      )}

      </div>
      </div>

      {amPlaying
        ? (myTurn
            ? <ActionBar gameState={gameState} myId={myId} onAction={onAction} disabled={actionDisabled} />
            : <div className="waiting-bar"><div className="waiting-text">{isShowdown ? '正在比牌…' : '等待其他玩家行动…'}</div></div>)
        : (myChips > 0
            ? <div className="waiting-bar"><div className="waiting-text">旁观中，下一手自动入座</div></div>
            : <div className="waiting-bar waiting-bar--spectate">
                <div className="waiting-text">旁观中</div>
                <div className="spectate-rebuy-btn" onClick={onRebuy}>+借一底</div>
              </div>)}
    </div>
  );
}
