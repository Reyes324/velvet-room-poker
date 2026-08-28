import { useRef, useEffect, useState } from 'react';
import PlayerSeat from './PlayerSeat';
import VoiceChatDock from './VoiceChatDock';
import ActionBar from './ActionBar';
import Card from './Card';
import Pot from './Pot';
import { useTableScale } from '../hooks/useTableScale';
import { playDealSfx, isSfxMuted, setSfxMuted } from '../utils/sfx';

// Fixed design canvas for just the table scene (felt + seats + hero cards) —
// the single source of truth for both .table-canvas's inline size and
// useTableScale's fit calculation. Top bar and action bar live outside this
// canvas entirely now (real flex siblings, always full device width); this
// only has to describe the table itself.
const TABLE_REF_W = 375;
const TABLE_REF_H = 610;

// Shared "deal origin" point every dealt card visually flies from (user
// feedback, GitHub #18/#6: "派牌的动画，每张牌都是从同一个中心点（页面的
// 中心点）派出"). Reuses .table-oval's own resting spot — .table-oval sits
// `top:0; bottom:200px` inside the TABLE_REF_H canvas (see velvet.css), so
// its content (Pot + community cards) is vertically centered around
// (TABLE_REF_H-200)/2 already — that's the natural "table center" reference
// point other code in this file already treats as a landmark, not a new
// coordinate invented for this fix.
const DEAL_ORIGIN_X = TABLE_REF_W / 2;
const DEAL_ORIGIN_Y = (TABLE_REF_H - 200) / 2;
// Card footprint + row gap, both read straight from velvet.css (.c-sm /
// .c-md / .community / .hero-cards) — used to work out each card's own
// resting offset from ITS row's center, so the per-card --dx/--dy below can
// place that row-center exactly at DEAL_ORIGIN and have every card in the
// row fan out from there, instead of guessing pixels.
const COMMUNITY_CARD_STEP = 41; // .c-sm width 36 + .community gap 5
const HERO_CARD_STEP = 62; // .c-md width 52 + .hero-cards gap 10
// Hero's card row itself sits well below the table's visual center (down in
// the fixed bottom hero-section) — approximated by the hero seat's own
// design-canvas position below, close enough that the flight direction and
// distance both read correctly (confirmed by real render, not hand-computed
// alone — see verification notes).
const HERO_ROW_Y = 430;

// A dealt card's start offset (--dx/--dy, consumed by .card-deal in
// velvet.css) so it visually originates at DEAL_ORIGIN and lands at its own
// slot — `i` is the card's index within its row, `count` the row length,
// `step` the row's per-card pitch, `rowX`/`rowY` the row's own center.
function dealOriginOffset(i, count, step, rowX, rowY) {
  const cardX = rowX + (i - (count - 1) / 2) * step;
  return { dx: DEAL_ORIGIN_X - cardX, dy: DEAL_ORIGIN_Y - rowY };
}

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

// Shared by both seatPositions() and spectatorSeatPositions() below.
//
// 玩家反馈（2026-08-12）：opponents[i] 原来是"左一个右一个"来回交替填充
// （[0]→left row0, [1]→right row0, [2]→left row1, [3]→right row1…），拿
// 真实多人对局实测庄家/小盲/大盲的座位后发现，这个交替顺序**不是顺时针
// 绕桌一圈**——3 人以上时会在左右两侧来回横跳（左上→右上→左中→右中→
// 左下…），玩家反馈"看不出行动顺序"正是这个原因。
//
// 这里改的只是"第 i 个玩家该填哪个已经算好的座位槽"这一步映射，坐标计
// 算本身（leftYs/rightYs 每一个具体的 x/y 值、每列多少人、TOP_ZONE/
// BOTTOM_ZONE 分配、行距）完全不动——用户明确要求"位置不动，只改顺序"，
// 这一批坐标之前经过大量真机截图调校过，不该跟着重新验证一遍。
//
// 顺时针从 hero（画面底部）出发，下一个座位应该是离 hero 最近的左侧座位
// （心算+3 人局真机实测确认过：hero 在 6 点钟方向，顺时针下一步先经过
// 9 点钟——也就是左侧——不是右侧）。所以左列按"离 hero 最近→最远"（也
// 就是 leftYs 数组倒过来，因为 leftYs 本身是 columnYs() 算出来的"离 hero
// 最远→最近"顺序，TOP_ZONE 在前、BOTTOM_ZONE 在后）依次分配给
// opponents[0..leftCount-1]；越过桌子顶端之后沿右列"离 hero 最远→最近"
// （rightYs 原本的顺序，不用倒）分配给 opponents[leftCount..n-1]，正好绕
//回到 hero 身边，完整走完一圈顺时针。
function twoColumnPositions(n) {
  if (n === 0) return [];
  const leftCount = Math.ceil(n / 2);
  const rightCount = n - leftCount;
  const leftYs = columnYs(leftCount);
  const rightYs = columnYs(rightCount);
  const seats = [];
  for (let i = leftCount - 1; i >= 0; i--) {
    seats.push({ x: COL_LEFT_X, y: leftYs[i], side: 'left' });
  }
  for (let i = 0; i < rightCount; i++) {
    seats.push({ x: COL_RIGHT_X, y: rightYs[i], side: 'right' });
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

export default function GameTable({ gameState, myId, roomCode, showdown, onAction, actionDisabled, onExit, amPlaying = true, myChips = 0, onRebuy, onOpenLedger, onOpenHandHistory, onOpenChatHistory, onOpenFeedback, onPoke, pokedSeat, settlementOpen = false, revealedPlayers = {}, isHost = false, onEndGame, gameTimerEndsAt = null, turnClock = null, myTimeBankMs = 0, onExtendTurn, paused = false, onPause, onResume, isPve = false, voiceEnabled = false, voiceTalking = false, voiceMicError = null, speakingPlayerIds = null, getVoiceVolume = null, onStartTalking, onStopTalking, onSendChat, chatBubble = null, disconnectedIds = null, actionBubbles = {}, setActionBubbles = () => {} }) {
  const [showExitModal, setShowExitModal] = useState(false);
  const [showEndGameModal, setShowEndGameModal] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  // Game sfx mute toggle (top-bar button, 用户反馈 2026-08-14) — mirrors
  // sfx.js's own persisted flag into local state so the button icon
  // re-renders; the actual mute/unmute effect lives in sfx.js's single
  // choke point (isSfxMuted()/setSfxMuted()), not here.
  const [sfxMuted, setSfxMutedState] = useState(() => isSfxMuted());
  function toggleSfxMuted() {
    const next = !sfxMuted;
    setSfxMuted(next);
    setSfxMutedState(next);
  }
  const [codeCopied, setCodeCopied] = useState(false);
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

  // 2026-08-13：拍一拍带蛋（🥚）的抛出起点从"桌子中心固定原点"改成"发起
  // 人自己的头像"（用户反馈：想要"从发起人扔到接收人"的抛物线，而不是
  // 所有蛋都从桌子中心冒出来）。每个客户端的 hero 固定在底部、对手的排布
  // 顺序因人而异，所以只能用【这次渲染自己算出来的】heroSeatPos/pos，不
  // 能假设所有客户端的坐标系一致——这里建一张"这一帧、这个客户端视角下
  // 每个座位 id 对应的画布坐标"的表，跟下面渲染每个座位用的是同一份数据。
  const seatPosById = {};
  if (amPlaying) seatPosById[me.id] = heroSeatPos;
  opponents.forEach((p, i) => { seatPosById[p.id] = pos[i]; });

  // 算某个目标座位（targetX/targetY）这次该收到的 pokeThrowFrom：起点是
  // 发起人（pokedSeat.fromId）的座位坐标，查不到（理论上不该发生，比如
  // 发起人这一帧还没进当前渲染的座位表）就退回原来的桌子中心，不让动画
  // 直接跑不出来。
  // arc：抛物线弧顶相对直线路径的额外高度，随抛掷距离缩放——两个相邻座
  // 位之间扔，弧线不该跟横跨整张桌子扔一样夸张；min/max 两头封顶避免距
  // 离极端时弧顶要么看不出来、要么"飞"得离谱高。具体用法见 velvet.css 的
  // eggFall 关键帧（拿 --throw-dx/--throw-dy/--throw-arc 算真正的抛物线
  // 路径，不是简单的直线位移）。
  function throwOffsetTo(targetX, targetY) {
    const fromPos = pokedSeat?.fromId ? seatPosById[pokedSeat.fromId] : null;
    const originX = fromPos ? fromPos.x : DEAL_ORIGIN_X;
    const originY = fromPos ? fromPos.y : DEAL_ORIGIN_Y;
    const dx = originX - targetX;
    const dy = originY - targetY;
    const dist = Math.hypot(dx, dy);
    const arc = Math.min(90, Math.max(26, dist * 0.4));
    return { dx, dy, arc };
  }

  // Seats are fixed — they should NOT replay an entrance animation every new
  // hand, only when a genuinely new player takes a seat (user feedback,
  // GitHub #18/#6: "玩家头像应该是固定的呀，除非有新人加入才会变动呀").
  // Computed fresh every render (not memoized on the id list) and compared
  // against the PREVIOUS render's roster, snapshotted into this ref by the
  // effect below right after each commit — same prev-vs-current ref pattern
  // as prevShowdownRef/prevHeroRevealedRef elsewhere in this file. Because
  // it's recomputed every render rather than cached, an id only ever reads
  // as "new" for the render(s) between the join actually happening and that
  // effect flushing — once the ref catches up, the same id compares as
  // already-known on every later hand. On this component's very first
  // render (table just mounted), the ref starts empty, so every seat
  // already at the table also flags as "new" once — a reasonable one-time
  // "table populating" moment on first view, not a per-hand replay.
  const opponentIdsKey = opponents.map(p => p.id).join(',');
  const [knownOpponentIds, setKnownOpponentIds] = useState(() => new Set());
  const [knownOpponentIdsKey, setKnownOpponentIdsKey] = useState(null);
  const newJoinerIds = new Set(opponents.filter(p => !knownOpponentIds.has(p.id)).map(p => p.id));
  // React-blessed "adjust state during render" pattern (not an effect) —
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  // — updates the "known ids" snapshot synchronously in the SAME render the
  // roster changed in, so newJoinerIds above only ever reads as non-empty
  // for that one render (React re-renders immediately with the new state
  // before committing, no extra effect round-trip / flash needed).
  if (opponentIdsKey !== knownOpponentIdsKey) {
    setKnownOpponentIdsKey(opponentIdsKey);
    setKnownOpponentIds(new Set(opponents.map(p => p.id)));
  }

  // GameEngine zeroes this.pot the instant a hand ends (the chips already
  // moved into the winner's stack — see _endHand) and that's the very same
  // game:state broadcast that flips phase to 'showdown', so gameState.pot
  // reads ¥0 from the first showdown frame onward. Neither RoomPage nor
  // PvePage's game:showdown handler threads its own `pot` field (the
  // pre-payout amount) down into gameState, so freeze the last positive pot
  // value seen here instead and show that through the reveal/settlement
  // window — otherwise the felt reads as "the pot vanished" right as the
  // winner is announced (user feedback, 2026-07-30).
  const [frozenPot, setFrozenPot] = useState(gameState.pot);
  // Adjusted directly during render (React's sanctioned pattern for "derive
  // state from a prop change" — see "You Might Not Need an Effect") rather
  // than in a useEffect: it only ever needs to happen in lockstep with this
  // exact render, not as a separate reaction afterward.
  if (gameState.pot > 0 && gameState.pot !== frozenPot) setFrozenPot(gameState.pot);
  const displayedPot = isShowdown ? frozenPot : gameState.pot;

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
      const t = setTimeout(() => {
        setRevealPhase('showdown');
      }, SHOWDOWN_REVEAL_HOLD_MS);
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
  // !isShowdown matters specifically for the action that ENDS a hand
  // (fold-to-one-left, or river call straight into showdown): GameEngine
  // deliberately leaves actionIndex/actionPlayerId untouched in that case
  // (see its own comment on lastActionSeq — "那一刻已经没有下一个该谁"), so
  // actionPlayerId still equals the very player who just folded/called.
  // Combined with the 'game:state' handler resetting actionDisabled back to
  // false on every broadcast (including this terminal one, which arrives
  // together with game:showdown before the delayed settlement sheet shows),
  // myTurn would otherwise flip true again for a beat — resurrecting the
  // ActionBar for a hand that's already over (user feedback, 2026-07-30:
  // clicking fold briefly showed the action bar again before the settlement
  // modal appeared).
  const myTurn = amPlaying && gameState.actionPlayerId === myId && !actionDisabled && !isShowdown;
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
  // hero's own face-down cards) silently never animated. Gating those on this
  // persistent `dealing` state instead — exactly like the opponent reveal-card
  // animation already correctly did — fixes that.
  // NOTE: the opponent SEAT fly-in (.deal-in, below) is deliberately NOT gated
  // on this — see newJoinerIds below for why.
  const dealing = !heroRevealed;
  const prevHeroRevealedRef = useRef(true);
  const justRevealed = !prevHeroRevealedRef.current && heroRevealed;
  // Only tracks the ref for the render-time `justRevealed` flip-animation
  // flag above — the hero's own reveal used to also play a flip sfx here
  // (removed per user feedback, 2026-08-14: "自己开牌的声音也去掉").
  useEffect(() => {
    prevHeroRevealedRef.current = heroRevealed;
  }, [heroRevealed]);

  useEffect(() => {
    // gameState.phase (not `dealing`, which this effect itself sets) only changes
    // value on an actual transition into preflop, so this only fires once per hand.
    if (gameState.phase !== 'preflop') return;
    setHeroRevealed(false);
    const t = setTimeout(() => setHeroRevealed(true), (totalDealTime + 0.15) * 1000);
    const cancelDealSfx = playDealSfx(totalDealTime);
    return () => { clearTimeout(t); cancelDealSfx?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState.phase]);

  // ── Action feedback bubbles ── actionBubbles/setActionBubbles are owned by
  // the parent page (RoomPage.jsx/PvePage.jsx), not here. They used to be
  // local state, set from an effect that read gameState.lastActionBy/
  // lastActionLabel — a single-slot snapshot of "the most recent action",
  // reset on every game:state broadcast. That effect only fires once per
  // React render of gameState, but the server can legitimately emit several
  // game:state broadcasts back-to-back in the same tick (bots acting near-
  // instantly) — React collapses those into one render, and the effect then
  // only ever sees the LAST action's actorId, silently dropping every
  // earlier actor's bubble in that batch entirely (not just its sfx, which
  // was already known to have this problem — see the matching comment in
  // RoomPage.jsx/PvePage.jsx). Confirmed as a real bug from a live game
  // screenshot (2026-08-16): an opponent's raise never got a bubble at all
  // because it landed in the same collapsed render as another player's
  // later action. Fixed by moving the setActionBubbles call directly into
  // the 'action:happened' socket handler (see those two files) — socket.io
  // invokes that callback once per actual emitted event, never collapsed,
  // so every action's functional setState update is correctly queued and
  // applied even when the resulting re-renders themselves get batched.
  // The phase-tagged sweep below (clearing stale bubbles on a new street)
  // stays here — it only cares about the current gameState.phase, not about
  // replaying every individual action, so the collapsing problem above
  // never applied to it.
  const currentPhaseRef = useRef(gameState.phase);
  useEffect(() => { currentPhaseRef.current = gameState.phase; });

  // The action that ENDS a hand (river call straight into showdown, or a
  // fold-to-one-left) gets tagged with gameState.phase as of THAT broadcast
  // — which is already 'showdown' by then (GameEngine flips phase inside
  // the very same fold()/call() dispatch — see its own lastActionSeq
  // comment). The sweep effect below only clears bubbles tagged with a
  // phase OTHER than the current one, so a bubble tagged 'showdown' reads
  // as "belongs to the current street" and is never swept on its own — it
  // was sitting there through the ENTIRE reveal + settlement sheet,
  // overlapping the opponent's just-revealed cards (user feedback,
  // 2026-07-31, screenshot). That last bubble briefly showing right as
  // showdown starts is deliberate though — see the comment above on
  // revealPhase (2026-07-28: the reveal itself is delayed exactly so this
  // bubble gets a beat to be seen before the flip covers it) — so this
  // can't just hide every showdown bubble on sight, only once it's
  // overstayed that welcome. settlementOpen (true once the settlement
  // sheet has actually slid up, ~1.4s later) is the right signal: it's
  // gone from "this bubble is the whole point of the pause" to "this
  // bubble is now stale and in the way of the reveal + hand-summary
  // panel". Fold bubbles stay exempt — a folded player's cards are never
  // shown, so there's nothing for that bubble to cover.
  // Room-code display so others can be pointed to the room without leaving
  // the table (user feedback, #14: "别人可以进来" — showing the code makes
  // it actually actionable, not just decorative). Reuses the same
  // copy-invite-link pattern as Lobby/RoomPage's .room-code, not a fresh
  // clipboard implementation.
  function copyRoomCode() {
    const url = `${window.location.origin}/room/${roomCode}`;
    navigator.clipboard.writeText(url).then(() => {
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    }).catch(() => {});
  }

  function visibleBubble(id) {
    const b = actionBubbles[id];
    if (!b) return undefined;
    return (settlementOpen && !b.folded) ? undefined : b;
  }

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
      //
      // 只按 phase 标签清，不再无差别清空当前所有非弃牌气泡——这个 effect
      // 只依赖 gameState.phase，一条街里晚到的动作（比如电脑思考了很久才
      // 加注）可能发生在这个 timer 已经排上、但还没触发的这段时间里；旧版
      // 触发时会把"当前这条街刚设置好的气泡"也一并冲掉，因为它不知道那是
      // 新气泡还是上一条街的旧气泡（用户反馈，2026-07-30：转牌圈电脑加注
      // 的气泡几乎立刻就消失了）。现在气泡自带 phase 标签，这里只清"标签
      // 不等于目标街"的那些，同一条街内新设置的气泡永远不会被自己这条街
      // 的 timer 误伤。
      const targetPhase = gameState.phase;
      const t = setTimeout(() => {
        // 街已经又往前走了（这个 timer 是给更早的街排的），交给那条更新
        // 的街自己的 timer 去清，这里不再动手，避免把当前最新街的气泡也
        // 当成"目标街之外"的东西清掉。
        if (currentPhaseRef.current !== targetPhase) return;
        setActionBubbles(b => {
          const kept = {};
          for (const [id, bub] of Object.entries(b)) {
            if (bub.folded || bub.phase === targetPhase) kept[id] = bub;
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
      if (p.isSB) seeded[p.id] = { text: `小盲 ¥${p.bet.toLocaleString()}`, key, phase: 'preflop' };
      else if (p.isBB) seeded[p.id] = { text: `大盲 ¥${p.bet.toLocaleString()}`, key, phase: 'preflop' };
    }
    setActionBubbles(seeded);
  }, [gameState.phase]);

  // 计时游戏 countdown — server is the authority on WHEN the timer ends
  // (an absolute timestamp), this just re-diffs against the client's own
  // clock every second. Shown for the whole session now (user feedback,
  // 2026-08-16 — used to only appear in the final 5 minutes, sharing the
  // room-code slot exclusively; now stacks under the room code instead, so
  // there's no exclusivity to gate on). Still switches to the urgent
  // orange-red color in the final 5 minutes — see .timer-countdown--urgent.
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    if (!gameTimerEndsAt) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [gameTimerEndsAt]);
  const timeLeftMs = gameTimerEndsAt ? gameTimerEndsAt - nowTick : null;
  const showCountdown = timeLeftMs != null && timeLeftMs > 0;
  const countdownUrgent = showCountdown && timeLeftMs <= 5 * 60_000;
  const countdownText = showCountdown
    ? `${String(Math.floor(timeLeftMs / 60000)).padStart(2, '0')}:${String(Math.floor((timeLeftMs % 60000) / 1000)).padStart(2, '0')}`
    : null;

  return (
    <div className={`game-stage game-stage--table${dense ? ' game-stage--dense' : ''}`}>
      {/* 顶部原来常驻的筹码数字去掉了——筹码在座位卡自己的 footer 上已经有
          一份，顶部重复显示没有必要（用户反馈，2026-08-10）。"听"这一侧
          默认全员开启，没有独立开关（见 useVoiceMesh 的自动 enable 效
          果），说话状态改成直接叠在座位头像发光上（见下方 PlayerSeat 的
          speak-ripple），顶部不再需要单独的语音指示。 */}
      <div className="top-bar">
        <div className="top-bar-left">
          {/* 三个点竖排（kebab menu）替代原来的 ≡（hamburger）——面包屑图标
              在国内用户群体里不是个熟悉的符号，用户反馈"不习惯"（2026-08-11）。
              用真的 SVG 画三个圆点，不用 unicode 字符（⋮ 在不同字体下粗
              细/间距不受控，跟牌桌其余全 SVG 画的图形不一致，这条跟麦克风
              图标改 SVG 是同一个理由）。 */}
          <div className="menu-btn" onClick={() => setShowMenu(true)} aria-label="菜单" role="button">
            <svg viewBox="0 0 20 6" width="18" height="5" aria-hidden="true">
              <circle cx="3" cy="3" r="2.4" fill="currentColor" />
              <circle cx="10" cy="3" r="2.4" fill="currentColor" />
              <circle cx="17" cy="3" r="2.4" fill="currentColor" />
            </svg>
          </div>
          {/* "问题反馈"以前只是菜单里一行不起眼的文字，用户要求拎出来放到
              顶部（2026-08-12），复用首页 .home-feedback-link 同一套边框
              样式，后来简化成纯文字"反馈"、去掉图标（2026-08-14，给静音
              按钮腾地方）。三易其位——最早在右边跟暂停按钮并排、之后单独
              留在右边组最左侧，用户最终要求挪到左边跟三个点菜单按钮放在
              一起，右边只留静音+暂停两个图标（2026-08-14 三次调整）。 */}
          <div className="top-feedback-link" onClick={() => onOpenFeedback?.()} role="button" aria-label="反馈">
            <span>反馈</span>
          </div>
        </div>
        {/* Room code sits in the same absolutely-centered slot as the final-5-
            minutes timer countdown — mutually exclusive with it (the timer
            only appears rarely, near the end of a timed game) so there's no
            layout collision to reconcile; whichever is relevant wins.
            人机对战没有真实房间号可分享——PvePage.jsx 传进来的 roomCode 是
            字面量"人机对战"这四个字，不是可邀请的房间码。之前这里不分场
            景一律套"点击复制邀请链接"这套点击行为，人机对战下点了会静默
            写一个 `/room/人机对战` 这种坏链接进剪贴板，还谎称"已复制邀请
            链接 ✓"（用户反馈，2026-08-12）。isPve 时改成纯文字、不可点、
            不带那句"点击复制邀请链接"的提示文案。 */}
        {/* 房间号/倒计时是真正的绝对屏幕居中（left:50%），不是"居中在两边
            剩余空间里"——用户看过 grid 三栏那版之后明确要求换回绝对居中
            （2026-08-14，见 velvet.css 的 .top-bar-center 注释）。 */}
        <div className="top-bar-center">
          {roomCode && isPve ? (
            <div className="top-room-code top-room-code--static">{roomCode}</div>
          ) : roomCode ? (
            <div className="top-room-code" onClick={copyRoomCode} title="点击复制邀请链接" role="button" aria-label="房间号，点击复制邀请链接">
              {codeCopied ? '已复制邀请链接 ✓' : roomCode}
            </div>
          ) : null}
          {countdownText && (
            <div className={`timer-countdown${countdownUrgent ? ' timer-countdown--urgent' : ''}`}>⏱ {countdownText}</div>
          )}
        </div>
        <div className="top-bar-right">
          {/* 静音（用户反馈，2026-08-14）：一键开关下注/发牌/翻牌这几个
              游戏音效（不影响语音对讲——那是完全独立的一套，见 useVoiceMesh）。
              状态持久化在 sfx.js 自己的 localStorage 里，这里的 sfxMuted
              只是镜像出来给按钮图标用。旁观者也能点——静音是"我不想听"，
              跟坐没坐下无关。紧挨着暂停按钮（用户要求两个图标按钮挨在一
              起，"反馈"挪去左边跟菜单按钮放一起了，见 .top-bar-left）。 */}
          <div className="top-mute-btn" onClick={toggleSfxMuted} aria-label={sfxMuted ? '取消静音' : '静音'} role="button">
            {sfxMuted ? (
              <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
                <path d="M4 9v6h4l5 4V5L8 9H4Z" fill="currentColor" />
                <path d="M16 9l5 5M21 9l-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
                <path d="M4 9v6h4l5 4V5L8 9H4Z" fill="currentColor" />
                <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
              </svg>
            )}
          </div>
          {/* 暂停/继续（用户反馈，2026-08-11）：只有坐位玩家（amPlaying）能
              触发，旁观者看不到这个按钮。图标用真的 SVG 画（跟其余全部图标
              按钮统一），不是 emoji/unicode 字符。
              人机对战不接这个功能——PvePage.jsx 没有传 onPause/onResume，
              之前不看 isPve 只看 amPlaying 时按钮照样渲染，点了却是个完
              全没反应的死按钮（跟拍一拍在人机对战里犯过的是同一类问题，
              2026-08-12 一起查出来的）。暂停本来就是"协调一桌真人"的功
              能，人机对战里只有你自己，想停随时能停，不需要这个按钮。 */}
          {amPlaying && !isPve && (
            <div
              className={`pause-btn${paused ? ' pause-btn--active' : ''}`}
              onClick={paused ? onResume : onPause}
              aria-label={paused ? '继续对局' : '暂停对局'}
              role="button"
            >
              {paused ? (
                <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                  <path d="M6 4 L16 10 L6 16 Z" fill="currentColor" />
                </svg>
              ) : (
                <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                  <rect x="5" y="4" width="4" height="12" rx="1" fill="currentColor" />
                  <rect x="11" y="4" width="4" height="12" rx="1" fill="currentColor" />
                </svg>
              )}
            </div>
          )}
          {/* 聊天记录（用户反馈 2026-08-28）：从菜单里挪出来单独一个顶部图
              标——菜单是"低频操作抽屉"，聊天记录是"想到就想立刻翻一下"的
              东西，藏在菜单第三层不够顺手。跟静音/暂停同一套 44px 圆角矩
              形图标按钮语言。PVE 没有真人聊天可回溯（PvePage 的聊天纯本
              地气泡、不走服务端），不显示这个按钮。 */}
          {!isPve && (
            <div className="top-chat-history-btn" onClick={() => onOpenChatHistory?.()} aria-label="聊天记录" role="button">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">
                <path d="M4 5h16v11H8l-4 4V5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
              </svg>
            </div>
          )}
        </div>
      </div>
      {paused && (
        <div className="pause-overlay">
          <div className="pause-overlay__text">已暂停</div>
          <div className="pause-overlay__btn" onClick={onResume}>继续</div>
        </div>
      )}
      {voiceMicError && (
        <div className="toast toast--danger voice-error-toast">{voiceMicError}</div>
      )}
      {voiceEnabled && (
        <VoiceChatDock
          voiceTalking={voiceTalking}
          onStartTalking={onStartTalking}
          onStopTalking={onStopTalking}
          onSendChat={onSendChat}
        />
      )}
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
          // left/top used to be plain CSS `50%` (see velvet.css comment on
          // .table-canvas) — the browser recomputes a percentage against
          // .table-zone's REAL, current pixel size, instantly, the moment
          // that size changes (the raise panel opening/closing resizes
          // .table-zone with no transition of its own). scale(tableScaleX,
          // tableScaleY) is a smooth ~250ms JS tween (useTableScale), but
          // that instant `50%` recompute doesn't wait for it — so the
          // whole canvas snapped to its new center FIRST, in one frame, and
          // only THEN eased its scale from there. User feedback (2026-07-31,
          // confirmed by scrubbing a screen recording frame-by-frame): "点
          // 击的瞬间桌布元素突然换了位置，然后再执行动画" — a position jump,
          // not (just) a scale jank. Deriving left/top from the SAME
          // tweened tableScaleX/tableScaleY instead keeps position and
          // scale locked to the same interpolated value on every single
          // frame — there's no separate "real" size for the browser to
          // jump to ahead of the animation anymore.
          left: `${tableScaleX * TABLE_REF_W / 2}px`, top: `${tableScaleY * TABLE_REF_H / 2}px`,
          transform: `translate(-50%, -50%) scale(${tableScaleX}, ${tableScaleY})`,
          '--csx': csx, '--csy': csy,
        }}
      >
      <div className="table-oval">
      <div className="table-oval-content">
        <Pot
          amount={displayedPot}
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
            // Community row is itself centered on DEAL_ORIGIN, so each
            // card's own offset from the row's center IS its offset from
            // the shared deal point — no extra row-position math needed.
            const origin = dealOriginOffset(i, COMMUNITY_COUNT, COMMUNITY_CARD_STEP, DEAL_ORIGIN_X, DEAL_ORIGIN_Y);
            return (
              <Card
                key={i}
                size="sm"
                faceDown
                animate={dealing ? 'card-deal' : null}
                delay={dealing ? communityDealDelayFor(i) : 0}
                dx={dealing ? origin.dx : null}
                dy={dealing ? origin.dy : null}
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
            bubble={visibleBubble(me.id)}
            poked={pokedSeat?.targetId === me.id}
            pokeKey={pokedSeat?.targetId === me.id ? pokedSeat.key : null}
            pokeEmoji={pokedSeat?.targetId === me.id ? pokedSeat.emoji : null}
            pokeFromName={pokedSeat?.targetId === me.id ? pokedSeat.fromName : null}
            chatText={chatBubble?.fromId === me.id ? chatBubble.text : null}
            chatKey={chatBubble?.fromId === me.id ? chatBubble.key : null}
            turnEndsAt={turnClock?.playerId === me.id ? turnClock.endsAt : null}
            turnStartedAt={turnClock?.playerId === me.id ? turnClock.startedAt : null}
            isSpeaking={voiceTalking || !!speakingPlayerIds?.has(me.id)}
            getVoiceVolume={getVoiceVolume}
            paused={paused}
            disconnected={!!disconnectedIds?.has(me.id)}
            pokeThrowFrom={throwOffsetTo(heroSeatPos.x, heroSeatPos.y)}
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
            className={`player-slot${newJoinerIds.has(p.id) ? ' deal-in' : ''}`}
            style={{ left: `${s.x}px`, top: `${s.y}px`, '--d': `${dealDelay}s` }}
          >
            <PlayerSeat
              player={p}
              isMe={false}
              isAction={gameState.actionPlayerId === p.id}
              isWinner={winnerNames.has(p.name)}
              gamePhase={revealPhase}
              color={colorForId(p.id)}
              bubble={visibleBubble(p.id)}
              cardsSide={cardsSide}
              bubbleSide={bubbleSide}
              onPoke={emoji => onPoke?.(p.id, emoji)}
              poked={pokedSeat?.targetId === p.id}
              pokeKey={pokedSeat?.targetId === p.id ? pokedSeat.key : null}
              pokeEmoji={pokedSeat?.targetId === p.id ? pokedSeat.emoji : null}
              pokeFromName={pokedSeat?.targetId === p.id ? pokedSeat.fromName : null}
              chatText={chatBubble?.fromId === p.id ? chatBubble.text : null}
              chatKey={chatBubble?.fromId === p.id ? chatBubble.key : null}
              pokeThrowFrom={throwOffsetTo(s.x, s.y)}
              bubbleAnchorTop={s.y <= TOP_ZONE.end}
              turnEndsAt={turnClock?.playerId === p.id ? turnClock.endsAt : null}
              turnStartedAt={turnClock?.playerId === p.id ? turnClock.startedAt : null}
              revealedCards={revealedPlayers[p.id]?.holeCards ?? null}
              bestCardRaws={hasBestCards ? bestCardRaws : null}
              isSpeaking={!!speakingPlayerIds?.has(p.id)}
              getVoiceVolume={getVoiceVolume}
              paused={paused}
              disconnected={!!disconnectedIds?.has(p.id)}
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
                  : me.holeCards.map((_, i) => {
                      const origin = dealOriginOffset(i, 2, HERO_CARD_STEP, DEAL_ORIGIN_X, HERO_ROW_Y);
                      return (
                        <Card
                          key={`back-${i}`}
                          size="md"
                          faceDown
                          animate={dealing ? 'card-deal' : null}
                          delay={dealing ? dealDelayFor(myId, i) : 0}
                          dx={dealing ? origin.dx : null}
                          dy={dealing ? origin.dy : null}
                        />
                      );
                    }))
              : [<Card key={0} size="md" faceDown />, <Card key={1} size="md" faceDown />]}
          </div>
        </div>
      )}

      </div>
      </div>

      {amPlaying
        ? (myTurn
            ? <ActionBar gameState={gameState} myId={myId} onAction={onAction} disabled={actionDisabled || paused} timeBankMs={myTimeBankMs} onExtendTurn={onExtendTurn} />
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
