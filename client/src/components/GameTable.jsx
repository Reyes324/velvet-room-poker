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

// 最后一家跟注、这一手进入摊牌时，先让这个动作气泡实际停留这么久，再翻开
// 对手的底牌——不然摊牌揭示会跟这次动作的状态更新同一瞬间到达，气泡还没
// 看清就已经被翻牌盖过去了（用户反馈，2026-07-28）。
const SHOWDOWN_REVEAL_HOLD_MS = 1200;
// 用户反馈追问（2026-07-28）：不只是摊牌，每一条街最后一家行动（跟注/弃
// 牌/加注）都有同样的问题——下面清空气泡的 effect 一旦 gameState.phase
// 变了就立刻执行，跟设置气泡的 effect 挤在同一次渲染里，清空直接把刚设
// 好的气泡冲掉，浏览器根本没机会画出来。这个常量控制"清空气泡"这一步要
// 拖多久，跟上面揭牌用的时长保持一致的节奏感。
const ACTION_BUBBLE_CLEAR_HOLD_MS = 1200;

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

// Both bumped up from 0.07/0.35 per user feedback ("发牌和翻牌的动画都可以
// 稍微慢一点，让用户有临场感") — cards landing a little more deliberately
// reads as more "dealt by a person" than machine-gunned onto the table.
const DEAL_STEP = 0.09; // seconds between each card landing
const DEAL_CARD_DURATION = 0.48; // matches .card-deal's animation-duration
const COMMUNITY_COUNT = 5; // flop(3) + turn(1) + river(1), all dealt face-down up front

// Column layout constants — reference canvas is TABLE_REF_W×TABLE_REF_H
// (375×610). Two vertical columns hug the left/right edges; the vertical
// strip between them stays clear for the pot/community-card zone. Seats
// fill alternating left/right by array order (opponents[0]→left row 0,
// opponents[1]→right row 0, opponents[2]→left row 1, …) so turn order still
// reads as a simple top-to-bottom zigzag instead of jumping across columns.
const COL_LEFT_X = 40;
const COL_RIGHT_X = 335;

// Seats used to stack from a fixed top margin at a per-density fixed pitch,
// only ever using the space ABOVE the community strip — real bounding
// boxes (Playwright, not hand-computed) showed a wide unused band below
// the community cards that this never touched, and on a dense table rows
// got compressed enough to invade the community band itself (a real bug:
// a bottom-row seat's showdown reveal physically overlapped it).
//
// Model now: two fixed zones, TOP_ZONE above the Pot/community block and
// BOTTOM_ZONE below it, each holding up to ZONE_ROW_CAP rows per column —
// this exact "2 above, 2 below, per side" cap is what the user asked for
// directly (annotated a screenshot with a line through the community row:
// "红线以上极限能放四个，左右各两个，红线以下也是"). It's a ceiling, not a
// guarantee: `maxRowsInZone` below still checks a zone can actually fit
// that many rows before honoring the cap.
//
// Every boundary constant is a real measured position (Playwright bounding
// boxes), not computed from the other UI elements' nominal sizes — Pot's
// own layout (padding, the street tag, flex centering) makes it cheaper to
// just measure the rendered result than to keep every constant in sync by
// hand. Re-measure these if Pot, community, or hero's card layout changes.
const POT_TOP = 173;               // .pot top, after the down-shift below
const COMMUNITY_BOTTOM = 285;      // .community bottom
const HERO_CARDS_TOP = 511.6;      // .hero-cards top (the big face-up hand, not the small avatar seat)
// A seat's showdown reveal card renders vertically CENTERED on the seat's
// own y (PlayerSeat's sideStyle: translateY(-50%)), so a zone boundary
// that only clears the neighboring element's edge still lets the card's
// own half-height poke across it. SAFE_MARGIN = 26 (sm card half-height,
// the only size reveal cards render at now) + 4px buffer.
const SAFE_MARGIN = 30;
const TOP_ZONE = { start: 46, end: POT_TOP - SAFE_MARGIN };                        // 46 – 143
const BOTTOM_ZONE = { start: COMMUNITY_BOTTOM + SAFE_MARGIN, end: HERO_CARDS_TOP - SAFE_MARGIN }; // 315 – 481.6
const ZONE_ROW_CAP = 2; // the user's explicit "2 above, 2 below, per side" — a ceiling, not a guarantee
// A seat WITH a position badge (庄家/小盲/大盲) is taller than one without —
// measured ≈88.7 vs ≈71.5 — and any seat can carry one on a given hand, so
// the pitch has to clear the taller case or two rows' badges/avatars overlap.
const MIN_SEAT_PITCH = 90;
// Target spacing within a zone when there's room to spare (a zone bigger
// than it needs stretched rows apart to fill it otherwise, reading as
// oddly sparse rather than a natural seating cluster).
const ROW_PITCH = 100;

// k rows packed from zone.start downward at ROW_PITCH (clamped to fit if
// the zone's too small). Both zones pack in the same direction so that
// walking down a column in array order — which is real seat/turn order,
// dealer→SB→BB follow it directly — always reads as one consistent
// top-to-bottom pass. (An earlier version packed TOP_ZONE from its far end
// instead, so a lone row would sit closer to the Pot — but that reversed
// its internal order relative to BOTTOM_ZONE's, breaking the dealer/blind
// badges' clockwise reading. BOTTOM_ZONE.start already being the
// community-adjacent edge means this same simple rule still gives a lone
// bottom-zone row the "close to the table" position on its own, with no
// special-casing needed.)
function spreadInZone(k, zone) {
  if (k <= 0) return [];
  const zoneLen = zone.end - zone.start;
  const pitch = k > 1 ? Math.min(ROW_PITCH, zoneLen / (k - 1)) : 0;
  return Array.from({ length: k }, (_, i) => zone.start + i * pitch);
}

// How many rows a zone can actually hold at MIN_SEAT_PITCH — a ceiling
// this respects only when there's room, never forcing a row count the
// zone can't fit (TOP_ZONE, with Pot fixed at its current position, only
// ever fits 1).
function maxRowsInZone(zone) {
  const zoneLen = zone.end - zone.start;
  return zoneLen >= MIN_SEAT_PITCH ? Math.floor(zoneLen / MIN_SEAT_PITCH) + 1 : 1;
}
const TOP_ZONE_CAP = Math.min(ZONE_ROW_CAP, maxRowsInZone(TOP_ZONE));

// Fills TOP_ZONE first up to its (fit-checked) cap, spills the remainder
// into BOTTOM_ZONE uncapped — every seat must get a position, and
// BOTTOM_ZONE is generously sized enough in practice (see maxRowsInZone)
// that this never needs a tighter pitch than TOP_ZONE already uses. The
// app's max table size (9-max, 8 opponents) means a column never needs
// more than 4 rows anyway.
function columnYs(rows) {
  if (rows <= 0) return [];
  const topCount = Math.min(rows, TOP_ZONE_CAP);
  const bottomCount = rows - topCount;
  return [...spreadInZone(topCount, TOP_ZONE), ...spreadInZone(bottomCount, BOTTOM_ZONE)];
}

// Shared by both seatPositions() and spectatorSeatPositions() below — the
// two-column zigzag fill (opponents[0]→left row 0, [1]→right row 0, …) is
// identical either way, they only differ in whether a hero slot gets
// reserved on top of it.
function twoColumnPositions(n) {
  if (n === 0) return [];
  const leftCount = Math.ceil(n / 2);
  const rightCount = n - leftCount;
  const leftYs = columnYs(leftCount);
  const rightYs = columnYs(rightCount);
  const seats = [];
  let leftRow = 0, rightRow = 0;
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) {
      seats.push({ x: COL_LEFT_X, y: leftYs[leftRow], side: 'left' });
      leftRow++;
    } else {
      seats.push({ x: COL_RIGHT_X, y: rightYs[rightRow], side: 'right' });
      rightRow++;
    }
  }
  return seats;
}

function seatPositions(n) {
  return { hero: { x: 187.5, y: 430 }, opponents: twoColumnPositions(n) };
}

// Spectator variant: no hero seat to anchor from, so every player in
// gameState.players fills the same two columns — no reserved bottom slot.
function spectatorSeatPositions(n) {
  return twoColumnPositions(n);
}

export default function GameTable({ gameState, myId, roomCode, showdown, onAction, actionDisabled, onExit, amPlaying = true, myChips = 0, onRebuy, onOpenLedger, onOpenHandHistory, onPoke, pokedSeat, settlementOpen = false, revealedPlayers = {}, isHost = false, onEndGame, gameTimerEndsAt = null }) {
  const [showExitModal, setShowExitModal] = useState(false);
  const [showEndGameModal, setShowEndGameModal] = useState(false);
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
  const winnerNames = new Set((showdown || []).map(w => w.name));
  const isShowdown = gameState.phase === 'showdown';

  // 用户反馈（2026-07-28）：最后一家跟注直接就亮牌了，看不清最后那个动作
  // 气泡（跟注了多少）——根因是"这次动作完成"和"进入摊牌"是同一条
  // game:state 广播里一起到的，没有停顿，摊牌揭示（对手手牌翻开）就跟着
  // 立刻触发。这里只延迟"揭示对手底牌"这一件事本身（PlayerSeat 的
  // gamePhase 用这个而不是原始 gameState.phase），不影响上面 isShowdown
  // 驱动的其他即时反馈（比如底部提示文字"正在比牌…"可以照常立刻更新）。
  // 翻到其它任何阶段（包括下一手重新回到 preflop）都不延迟，只有"进入
  // showdown 这一下"要等一等。
  const [revealPhase, setRevealPhase] = useState(gameState.phase);
  useEffect(() => {
    if (gameState.phase === 'showdown' && revealPhase !== 'showdown') {
      const t = setTimeout(() => setRevealPhase('showdown'), SHOWDOWN_REVEAL_HOLD_MS);
      return () => clearTimeout(t);
    }
    if (gameState.phase !== 'showdown') setRevealPhase(gameState.phase);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState.phase]);
  // Winning hand highlight: the 5 cards making up the best hand are unique
  // across the whole deal (one card can't be in two different hands at
  // once), so a flat raw-notation lookup works regardless of whose card it
  // is — no need to track "whose bestCards" per seat. Absent entirely on a
  // fold-win (server sends no bestCards there — nobody had to prove a hand),
  // so `hasBestCards` doubles as "did a real showdown comparison happen".
  const bestCardRaws = new Set((showdown || []).flatMap(w => (w.bestCards || []).map(c => c.raw)));
  const hasBestCards = bestCardRaws.size > 0;
  const cardEffect = (raw) => hasBestCards ? { highlight: bestCardRaws.has(raw), dim: !bestCardRaws.has(raw) } : {};
  // Winners can differ in which hand they won with (side-pot layers can
  // resolve to different best-hands) — de-dupe by label so a normal
  // single-winner or matching-hand split pot still only shows it once.
  // Full handName ("两对，A和K"), not handNameShort ("两对") — matches what
  // the settlement modal shows a beat later, so the two don't disagree on
  // how specific the hand description is (user feedback, 2026-07-29).
  const handNameLabels = [...new Set((showdown || []).map(w => w.handName).filter(Boolean))];
  const myTurn = amPlaying && gameState.actionPlayerId === myId && !actionDisabled;
  const dense = amPlaying ? opponents.length + 1 >= 7 : opponents.length >= 7;

  // ── Animation refs (track prev state to compute what's newly visible) ──────
  const prevShowdownRef = useRef(null);

  const cardCount = gameState.communityCards.length;
  const justShowdown = !prevShowdownRef.current && showdown && showdown.length > 0;

  // newCardFrom used to be a ref updated in a passive useEffect right after
  // commit — a one-render pulse. Real bug (found via PVE, where the AI can
  // act fast enough that two 'game:state' updates land within the same
  // repaint window): if ANY second re-render fires within that same
  // ~1 frame — even one wholly unrelated to community cards — React's
  // effect had usually already advanced the ref before the browser ever
  // painted the "isNew" frame, so the flip-reveal class technically existed
  // for one commit but was never actually visible. Same root cause the
  // `dealing`/`heroRevealed` state below already had to work around once —
  // this is that same class of bug hitting the per-street reveal too.
  // Fixed the same way: a real state value that only advances after a
  // genuine timer (matching flipIn's .62s + up to 3 cards' 0.1s stagger —
  // see velvet.css), immune to how many extra renders happen in between,
  // instead of racing an effect against the next arbitrary re-render.
  const [newCardFrom, setNewCardFrom] = useState(gameState.communityCards.length);
  useEffect(() => {
    if (cardCount > newCardFrom) {
      const t = setTimeout(() => setNewCardFrom(cardCount), 950);
      return () => clearTimeout(t);
    }
    if (cardCount < newCardFrom) setNewCardFrom(cardCount); // new hand — snap, nothing to animate away from
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardCount]);

  useEffect(() => {
    prevShowdownRef.current = showdown;
  }, [showdown]);

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

  // ── Action feedback bubbles ── server tells us directly who just acted and
  // what they did (lastActionBy/lastActionLabel), keyed by lastActionSeq so we
  // only react once per real action. Used to be inferred client-side by diffing
  // actionPlayerId/bet/status between renders, but actionIndex never advances
  // for a hand's true final action (fold-to-one-left, or river call straight
  // into showdown — see GameEngine's own comment on lastActionSeq), so that
  // diff-based approach could never detect those actions at all, and even when
  // it did fire, _nextStreet() resets everyone's bet to 0 before the diff ever
  // runs, making the inferred text wrong for any street-ending action (user
  // feedback, 2026-07-28).
  const prevActionSeqRef = useRef(0);
  const [actionBubbles, setActionBubbles] = useState({});

  useEffect(() => {
    const seq = gameState.lastActionSeq ?? 0;
    if (seq && seq !== prevActionSeqRef.current) {
      const actorId = gameState.lastActionBy;
      const label = gameState.lastActionLabel;
      if (actorId && label) {
        let text = null;
        let folded = false;
        if (label.type === 'fold') { text = '弃牌'; folded = true; }
        else if (label.type === 'allin') text = `ALL IN ¥${label.amount.toLocaleString()}`;
        else if (label.type === 'raise') text = `加注 ¥${label.amount.toLocaleString()}`;
        else if (label.type === 'call') text = `跟注 ¥${label.amount.toLocaleString()}`;
        else text = '过牌'; // check
        // Persistent now — no self-clearing timeout. The bubble stays until
        // this same player's status/bet changes again (this effect re-fires
        // and overwrites their entry) or a new street/hand clears everyone
        // (see the phase-watching effect below).
        const key = Date.now();
        setActionBubbles(b => ({ ...b, [actorId]: { text, key, folded } }));
      }
    }
    prevActionSeqRef.current = seq;
  }, [gameState]);

  // Persistent action bubbles represent "what happened this street" — clear
  // them all when the street (or the whole hand) advances, otherwise a
  // "跟注 ¥20" from preflop would still be sitting there during the flop.
  // Entering a fresh preflop is the one exception: the blinds are posted
  // server-side before any actionPlayerId transition ever fires, so the
  // diff-based effect above has nothing to compare against and would never
  // otherwise label them — seed SB/BB's bubbles directly here instead.
  // Whoever acts first naturally overwrites their own seeded bubble the
  // moment they take a real action.
  useEffect(() => {
    if (gameState.phase !== 'preflop') {
      // 延迟清空，不是立刻清空——这个 effect 的依赖是 gameState.phase，
      // 最后一家行动导致进入新的一条街时，跟上面"设置气泡"的 effect 挤在
      // 同一次渲染里；不加这个延迟的话，气泡刚被设置就在同一个 commit 里
      // 被这里清掉，浏览器从来没机会真的画出来（用户反馈，2026-07-28：
      // 不只是摊牌，每一条街最后一家的动作气泡都是这样消失的）。
      const t = setTimeout(() => {
        // "弃牌" is a hand-long state, not a street-specific action like a
        // call/raise — it used to get wiped along with everything else the
        // moment the street advanced, so a folded player's bubble vanished
        // even though they were still out for the rest of the hand (user
        // feedback: looked like the fold indicator disappeared). Keep it
        // through subsequent streets; every other bubble still clears.
        setActionBubbles(b => {
          const kept = {};
          for (const p of gameState.players) {
            if (p.status === 'folded' && b[p.id]?.folded) kept[p.id] = b[p.id];
          }
          return kept;
        });
      }, ACTION_BUBBLE_CLEAR_HOLD_MS);
      return () => clearTimeout(t);
    }
    const seeded = {};
    const key = Date.now();
    for (const p of gameState.players) {
      if (p.bet <= 0) continue;
      if (p.isSB) seeded[p.id] = { text: `小盲 ¥${p.bet.toLocaleString()}`, key };
      else if (p.isBB) seeded[p.id] = { text: `大盲 ¥${p.bet.toLocaleString()}`, key };
    }
    setActionBubbles(seeded);
  }, [gameState.phase]);

  // 计时游戏 countdown — server is the authority on WHEN the timer ends
  // (an absolute timestamp), this just re-diffs against the client's own
  // clock every second. Only rendered in the final 5 minutes per the
  // original request — a full-session countdown badge would compete for
  // attention with everything else in the top bar for most of the game.
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    if (!gameTimerEndsAt) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [gameTimerEndsAt]);
  const timeLeftMs = gameTimerEndsAt ? gameTimerEndsAt - nowTick : null;
  const showCountdown = timeLeftMs != null && timeLeftMs > 0 && timeLeftMs <= 5 * 60_000;
  const countdownText = showCountdown
    ? `${String(Math.floor(timeLeftMs / 60000)).padStart(2, '0')}:${String(Math.floor((timeLeftMs % 60000) / 1000)).padStart(2, '0')}`
    : null;

  return (
    <div className={`game-stage game-stage--table${dense ? ' game-stage--dense' : ''}`}>
      <div className="top-bar">
        <div className="menu-btn" onClick={() => setShowMenu(true)}>≡</div>
        {countdownText && <div className="timer-countdown">⏱ {countdownText}</div>}
        <div className="bankroll">¥{(amPlaying ? me.chips : myChips).toLocaleString()}</div>
      </div>
      {showMenu && (
        <div className="modal-overlay" onClick={() => setShowMenu(false)}>
          <div className="modal menu-popover" onClick={e => e.stopPropagation()}>
            <div className="menu-row" onClick={() => { setShowMenu(false); onOpenLedger?.(); }}>账本</div>
            <div className="menu-row" onClick={() => { setShowMenu(false); onOpenHandHistory?.(); }}>牌局记录</div>
            {isHost && (
              <div className="menu-row menu-row--danger" onClick={() => { setShowMenu(false); setShowEndGameModal(true); }}>结束游戏</div>
            )}
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
      {showEndGameModal && (
        <div className="modal-overlay" onClick={() => setShowEndGameModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">结束游戏</div>
            <div className="modal-body">结束后将回到大厅并自动显示账本，所有人当前筹码保留，之后仍可重新开始。确定结束本局对局吗？</div>
            <div className="modal-btns">
              <div className="modal-btn-cancel" onClick={() => setShowEndGameModal(false)}>取消</div>
              <div className="modal-btn-danger" onClick={() => { setShowEndGameModal(false); onEndGame?.(); }}>结束游戏</div>
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
          handNameLabel={handNameLabels.length > 0 ? handNameLabels.join(' / ') : null}
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
                  {...cardEffect(card.raw)}
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
            gamePhase={revealPhase}
            color={colorForId(me.id)}
            bubble={actionBubbles[me.id]}
            poked={pokedSeat?.targetId === me.id}
          />
        </div>
      )}

      {opponents.map((p, i) => {
        const s = pos[i];
        const dealDelay = i * 0.1;
        // Showdown reveal always renders toward the center strip, never
        // above/below the seat — rows sit close enough together that
        // anything rendered above a seat overlaps the row above it (its
        // footer/avatar), and anything below overlaps the row below
        // (confirmed on a real device, not hand-computed). The center strip
        // is the one direction with real room to spare, for every row, not
        // just the topmost one.
        const cardsSide = s.side === 'left' ? 'right' : 'left';
        // The action bubble always sits toward the center strip, same
        // direction as the showdown reveal — never "above" the seat, for
        // the same row-spacing reason.
        const bubbleSide = cardsSide;
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
              gamePhase={revealPhase}
              color={colorForId(p.id)}
              bubble={actionBubbles[p.id]}
              cardsSide={cardsSide}
              bubbleSide={bubbleSide}
              onPoke={() => onPoke?.(p.id)}
              poked={pokedSeat?.targetId === p.id}
              revealedCards={revealedPlayers[p.id]?.holeCards ?? null}
              bestCardRaws={hasBestCards ? bestCardRaws : null}
            />
          </div>
        );
      })}

      {amPlaying && (
        <div className={`hero-section${settlementOpen ? ' hero-section--lifted' : ''}`}>
          <div className={`hero-cards${revealedPlayers[myId] ? ' hero-cards--revealed' : ''}`}>
            {me.holeCards?.length === 2
              ? (heroRevealed
                  ? me.holeCards.map((c, i) => (
                      <Card
                        key={`face-${i}`}
                        card={c}
                        size="md"
                        animate={justRevealed ? 'flip-reveal' : null}
                        delay={justRevealed ? i * 0.1 : 0}
                        {...cardEffect(c.raw)}
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
