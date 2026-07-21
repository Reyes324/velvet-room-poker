import { useRef, useEffect, useState } from 'react';
import PlayerSeat from './PlayerSeat';
import ActionBar from './ActionBar';
import Card from './Card';
import Pot from './Pot';
import { useTableScale } from '../hooks/useTableScale';

// Fixed design canvas for just the table scene (felt + seats + hero cards) —
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

const BET_CHIP_OFFSET = 58; // px toward the pot, from the seat center — was raised to 92 to clear the opponent reveal cards, but those were removed entirely afterward (see design.md), so that reason no longer applies; brought back down closer to the seat for visual intimacy, per real-device feedback. Value tuned empirically against real rendered bounding boxes, not hand-computed.

// The bet-chip (a chip icon + amount, no tail — see .bet-chip in velvet.css)
// is offset from its seat toward the pot center by (dx,dy).
function betChipStyle(dx, dy) {
  const len = Math.hypot(dx, dy) || 1;
  return {
    transform: `translate(calc(-50% + ${(dx / len) * BET_CHIP_OFFSET}px), calc(-50% + ${(dy / len) * BET_CHIP_OFFSET}px))`,
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

// Column layout constants — reference canvas is TABLE_REF_W×TABLE_REF_H
// (375×610). Two vertical columns hug the left/right edges; the vertical
// strip between them stays clear for the pot/community-card zone. Seats
// fill alternating left/right by array order (opponents[0]→left row 0,
// opponents[1]→right row 0, opponents[2]→left row 1, …) so turn order still
// reads as a simple top-to-bottom zigzag instead of jumping across columns.
const COL_LEFT_X = 40;
const COL_RIGHT_X = 335;
const COL_TOP_Y = 46;

// Row spacing is looser with fewer players and only tightens as the table
// fills up — a 2-handed table shouldn't be as cramped as a 9-max one just
// because they share the same column x-positions. `rowsPerColumn` is
// however many rows the taller of the two columns needs (opponents[0]→left
// row 0, opponents[1]→right row 0, … so the two columns differ by at most
// one row). Values tuned empirically against real rendered bounding boxes
// (reveal cards must not collide with the row above/below, or with the
// community-card zone in the center strip), not hand-computed.
function rowPitchFor(rowsPerColumn) {
  if (rowsPerColumn <= 2) return 130;
  if (rowsPerColumn === 3) return 100;
  return 76; // 4 rows — the densest supported table (7-9 handed)
}

function seatPositions(n) {
  const heroPos = { x: 187.5, y: 430 };
  if (n === 0) return { hero: heroPos, opponents: [] };
  const pitch = rowPitchFor(Math.ceil(n / 2));
  const opponents = [];
  let leftRow = 0, rightRow = 0;
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) {
      opponents.push({ x: COL_LEFT_X, y: COL_TOP_Y + leftRow * pitch, side: 'left' });
      leftRow++;
    } else {
      opponents.push({ x: COL_RIGHT_X, y: COL_TOP_Y + rightRow * pitch, side: 'right' });
      rightRow++;
    }
  }
  return { hero: heroPos, opponents };
}

// Spectator variant: no hero seat to anchor from, so every player in
// gameState.players fills the same two columns from the top — no reserved
// bottom slot.
function spectatorSeatPositions(n) {
  if (n === 0) return [];
  const pitch = rowPitchFor(Math.ceil(n / 2));
  const seats = [];
  let leftRow = 0, rightRow = 0;
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) {
      seats.push({ x: COL_LEFT_X, y: COL_TOP_Y + leftRow * pitch, side: 'left' });
      leftRow++;
    } else {
      seats.push({ x: COL_RIGHT_X, y: COL_TOP_Y + rightRow * pitch, side: 'right' });
      rightRow++;
    }
  }
  return seats;
}

export default function GameTable({ gameState, myId, roomCode, showdown, onAction, actionDisabled, onExit, amPlaying = true, myChips = 0, onRebuy, onOpenLedger, onPoke, pokedSeat }) {
  const [showExitModal, setShowExitModal] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const tableZoneRef = useRef(null);
  const { scaleX: tableScaleX, scaleY: tableScaleY } = useTableScale(tableZoneRef, TABLE_REF_W, TABLE_REF_H);
  // Position (seat columns, felt background) stretches non-uniformly with tableScaleX/Y
  // so the table always fills the container's actual width/height. Content (cards,
  // avatars, text) must NOT stretch with it — each content layer below counters the
  // parent's non-uniform scale back down to this single uniform factor via its own
  // scale(csx, csy), so a wide-but-short viewport spreads seats out further apart
  // without ever squashing a card or number.
  const tableScaleUniform = Math.min(tableScaleX, tableScaleY) || 1;
  const csx = tableScaleX ? tableScaleUniform / tableScaleX : 1;
  const csy = tableScaleY ? tableScaleUniform / tableScaleY : 1;

  // amPlaying=false means myId isn't in gameState.players at all (mid-game
  // joiner waiting for next hand, or a busted player excluded from this
  // one) — there is no "me" to anchor the layout on, so every seat renders
  // via the opponent-style PlayerSeat, laid out via spectatorSeatPositions()
  // (same two-column layout, no reserved hero slot).
  const ordered = amPlaying ? getOrderedPlayers(gameState.players, myId) : gameState.players;
  const me = amPlaying ? ordered[0] : null;
  const opponents = amPlaying ? ordered.slice(1) : ordered;
  const { hero: heroSeatPos, opponents: pos } = amPlaying
    ? seatPositions(opponents.length)
    : { hero: null, opponents: spectatorSeatPositions(opponents.length) };
  // Same "toward the pot center" bet-chip fly-in direction as the opponents.map loop
  // below, just for the hero's fixed bottom-vertex seat.
  const heroBetStyle = heroSeatPos && betChipStyle(0, 187.5 - heroSeatPos.y); // straight up, toward the pot
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
        // Persistent now — no self-clearing timeout. The bubble stays until
        // this same player's status/bet changes again (this effect re-fires
        // and overwrites their entry) or a new street/hand clears everyone
        // (see the phase-watching effect below).
        const key = Date.now();
        setActionBubbles(b => ({ ...b, [actorId]: { text, key } }));
      }
    }
    prevActionSnapshotRef.current = {
      actionPlayerId: gameState.actionPlayerId,
      currentBet: gameState.currentBet,
      players: gameState.players.map(p => ({ id: p.id, bet: p.bet, status: p.status })),
    };
  }, [gameState]);

  // Persistent action bubbles represent "what happened this street" — clear
  // them all when the street (or the whole hand) advances, otherwise a
  // "跟注 ¥20" from preflop would still be sitting there during the flop.
  useEffect(() => {
    setActionBubbles({});
  }, [gameState.phase]);

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
            poked={pokedSeat?.targetId === me.id}
          />
          {/* Same persistent chip-bubble every opponent gets below — hero's own bet
              used to only flash as fading action text, never sat on the felt like
              everyone else's, which read as inconsistent from hero's own viewpoint. */}
          {me.bet > 0 && <div className="bet-chip" style={heroBetStyle}>¥{me.bet.toLocaleString()}</div>}
        </div>
      )}

      {opponents.map((p, i) => {
        const s = pos[i];
        // Column layout: always fly straight toward the center strip (x=187.5),
        // never vertically — the center strip is where the pot/community cards
        // live, directly between the two columns at every row.
        const betStyle = betChipStyle(187.5 - s.x, 0);
        const dealDelay = i * 0.1;
        // Reveal cards / action bubble always render toward the center strip,
        // never above/below the seat — with rows only COL_ROW_PITCH (76px)
        // apart, anything rendered above a seat overlaps the row above it
        // (its footer/avatar), and anything below overlaps the row below
        // (confirmed on a real device, not hand-computed). The center strip
        // is the one direction with real room to spare, for every row, not
        // just the topmost one.
        const cardsSide = s.side === 'left' ? 'right' : 'left';
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
              cardsSide={cardsSide}
              onPoke={() => onPoke?.(p.id)}
              poked={pokedSeat?.targetId === p.id}
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
                        size="sm"
                        animate={justRevealed ? 'flip-reveal' : null}
                        delay={justRevealed ? i * 0.1 : 0}
                      />
                    ))
                  : me.holeCards.map((_, i) => (
                      <Card
                        key={`back-${i}`}
                        size="sm"
                        faceDown
                        animate={dealing ? 'card-deal' : null}
                        delay={dealing ? dealDelayFor(myId, i) : 0}
                      />
                    )))
              : [<Card key={0} size="sm" faceDown />, <Card key={1} size="sm" faceDown />]}
          </div>
          <div className="hero-info">
            {/* 筹码量已经在上面小头像座位的 footer 显示（跟其他玩家卡片样式保持一致），
                这里不再重复展示，只留姓名。 */}
            <div className="hero-name">{me.name}（我）</div>
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
