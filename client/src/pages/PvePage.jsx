import { useState, useCallback, useRef, useEffect } from 'react';
import { useSocket } from '../hooks/useSocket';
import { useActionLock } from '../hooks/useActionLock';
import GameTable from '../components/GameTable';
import SettlementModal from '../components/SettlementModal';
import BustDecisionModal from '../components/BustDecisionModal';
import LedgerModal from '../components/LedgerModal';
import HandHistoryModal from '../components/HandHistoryModal';
import PveStatsModal from '../components/PveStatsModal';
import FeedbackModal from '../components/FeedbackModal';

// Same pacing as RoomPage's real-showdown reveal — see that file's own
// comment. Duplicated rather than imported: it's one constant, and PVE is
// deliberately kept structurally independent from the room/multiplayer
// page (see design.md「新增：单人人机对战（PVE）模式」).
const SHOWDOWN_REVEAL_DELAY_MS = 1400;

// Reuses vr_playerId — the same anonymous per-device id multiplayer already
// persists — rather than inventing a separate PVE identity. There's no
// namespace collision risk (RoomManager and the server's pveSessions Map are
// entirely separate keyed structures); this is just "this browser", same as
// multiplayer already treats it.
function getPveId() {
  let id = localStorage.getItem('vr_playerId');
  if (!id) { id = Math.random().toString(36).slice(2, 10); localStorage.setItem('vr_playerId', id); }
  return id;
}

export default function PvePage({ playerName, seatCount, onLeave }) {
  const [gameState, setGameState] = useState(null);
  const [showdown, setShowdown] = useState(null);
  const [settlement, setSettlement] = useState(null);
  // 破产决策弹窗：只在结算看完（点了"我知道了"）之后才出，见下方渲染处的注释
  const [bustPrompt, setBustPrompt] = useState(false);
  const [toast, setToast] = useState(null);
  const [showLedger, setShowLedger] = useState(false);
  const [showHandHistory, setShowHandHistory] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [handHistory, setHandHistory] = useState([]);
  const settlementTimerRef = useRef(null);
  // 拍一拍在人机对战里没有服务端广播这条路可走（AI 收不到，也没有第二个
  // 真人需要同步）——用户反馈（2026-08-13）："人机对战也保留发表情这个
  // 交互和效果，我测试比较方便"，纯本地 state 就够，不需要 pve:xxx 事件。
  const [pokedSeat, setPokedSeat] = useState(null); // { targetId, key, emoji } | null

  // fromId 作为参数传入（调用处 onPoke={(targetId, emoji) => poke(targetId,
  // emoji, me?.id)} 绑定），而不是在函数体内直接闭包读 me——me 声明在这个
  // 函数下方（早退 return 之后才算出来），react-hooks/purity 的静态检查
  // 会把"函数体内引用一个源码位置更靠后的组件变量、又调用了 Date.now()
  // 这种非纯函数"这个组合判定成潜在的渲染期副作用风险而报错，即使这个函
  // 数实际只在点击事件里才会被调用。让调用方在 JSX 里就地读 me?.id 传进
  // 来，函数体本身不再触碰这个变量，规避这条误报。
  function poke(targetId, emoji, fromId) {
    const key = Date.now();
    setPokedSeat({ targetId, fromId: fromId ?? null, key, emoji: emoji ?? null, fromName: null });
    // 1.6s 跟 RoomPage.jsx 的真实实现、以及 velvet.css 里 .poke-bubble 的
    // 淡出时机保持一致。
    setTimeout(() => {
      setPokedSeat(p => (p?.key === key ? null : p));
    }, 1600);
  }

  const showToast = useCallback((msg, type = 'info') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }, []);

  // 出牌乐观锁（见 hooks/useActionLock.js）。必须声明在 useSocket 之前——
  // 下面的 game:state / game:error 两个 handler 都要调用 unlock。
  const { locked: actionDisabled, lock: lockAction, unlock: unlockAction } = useActionLock();

  const { emit, socket } = useSocket({
    'game:state': (state) => {
      setGameState(state);
      setShowdown(null);
      setSettlement(null);
      setBustPrompt(false);
      unlockAction();
      clearTimeout(settlementTimerRef.current);
      // Keeps App.jsx's cold-start resume window (PVE_RESUME_WINDOW_MS)
      // anchored to real activity, not just whenever pve:start last ran —
      // a session that's been sitting untouched should age out even if the
      // tab technically never closed (user feedback, 2026-07-31).
      localStorage.setItem('vr_pveLastActive', String(Date.now()));
    },
    'game:showdown': ({ winners, foldWin }) => {
      setShowdown(winners);
      const showSettlement = () => setSettlement({ winners, foldWin });
      clearTimeout(settlementTimerRef.current);
      // Used to skip the wait for fold-wins — see RoomPage.jsx's matching
      // comment (2026-07-28): the last folder's own "弃牌" bubble needs the
      // same pause as a real showdown, not just the card reveal.
      settlementTimerRef.current = setTimeout(showSettlement, SHOWDOWN_REVEAL_DELAY_MS);
    },
    'game:error': (msg) => { showToast(msg, 'danger'); unlockAction(); },
    'pve:hand-history': (hands) => setHandHistory(hands),
  });

  useEffect(() => {
    // Re-sync on every (re)connect, not just mount — mirrors RoomPage's own
    // reasoning: a backgrounded mobile tab or brief network blip drops the
    // socket without necessarily unmounting this component. Server-side
    // pve:start resumes the existing session (matched by pveId) instead of
    // starting fresh when one's already there — see server/index.js.
    function sync() { emit('pve:start', { playerName, pveId: getPveId(), seatCount }); }
    sync();
    socket.on('connect', sync);
    return () => {
      socket.off('connect', sync);
      clearTimeout(settlementTimerRef.current);
    };
  }, []);

  function handleAction(action, amount) {
    lockAction();
    emit('pve:action', { action, amount });
  }

  function handleReady() {
    emit('pve:ready-next');
  }

  function handleExit() {
    emit('pve:leave');
    onLeave();
  }

  if (!gameState) {
    return <div className="pve-loading">开局中…</div>;
  }

  // getStateForPlayer only ever sends the real hole cards for the viewer's
  // own seat (see GameEngine.getStateForPlayer) — every other seat's
  // holeCards is either [] (folded) or [null, null] (masked). That makes
  // "whose entry has a real first card" a reliable way to find "me" without
  // depending on name matching (which could collide with a blank/default
  // name landing on both seats).
  const me = gameState.players.find(p => p.holeCards?.[0]);
  // 用户反馈（2026-08-02）："人机对战，为什么没有借一手的那个弹窗呢"——
  // PveSession._dealNewHand() 一直是破产自动补满、不打断（PVE 是单人对
  // 局，没有"别人在等你"这个理由），但用户希望即使是单人对局也保留跟多
  // 人房间一致的"要不要继续"确认，不要在没问过的情况下悄悄重新买入。
  // 只在结算阶段（settlement 已经渲染出来、这手真正打完了）判断——这时
  // gameState.players 里的筹码还是"这手打完后"的真实值，_dealNewHand 的
  // 自动补满要等 pve:ready-next 才会触发，所以 0 筹码就是真的破产、不是
  // 已经被悄悄补过了。
  const myBust = me?.chips === 0;

  return (
    <>
      <GameTable
        gameState={gameState}
        myId={me?.id}
        roomCode="人机对战"
        showdown={showdown}
        onAction={handleAction}
        actionDisabled={actionDisabled}
        onExit={handleExit}
        amPlaying
        myChips={me?.chips ?? 0}
        settlementOpen={!!settlement}
        onOpenLedger={() => setShowLedger(true)}
        onOpenHandHistory={() => { emit('pve:get-hand-history'); setShowHandHistory(true); }}
        onOpenStats={() => { emit('pve:get-hand-history'); setShowStats(true); }}
        onOpenFeedback={() => setShowFeedback(true)}
        onPoke={(targetId, emoji) => poke(targetId, emoji, me?.id)}
        pokedSeat={pokedSeat}
        isPve
      />
      {showLedger && (
        <LedgerModal
          players={gameState.ledger}
          startingChips={gameState.startingChips ?? 1000}
          myId={me?.id}
          onClose={() => setShowLedger(false)}
        />
      )}
      {showHandHistory && (
        <HandHistoryModal
          hands={handHistory}
          myId={me?.id}
          onClose={() => setShowHandHistory(false)}
        />
      )}
      {showStats && (
        <PveStatsModal
          hands={handHistory}
          myId={me?.id}
          ledgerEntry={gameState.ledger?.find(p => p.id === me?.id)}
          startingChips={gameState.startingChips ?? 1000}
          onClose={() => setShowStats(false)}
        />
      )}
      {/* 用户反馈 #5（2026-08-04）："结算弹窗没出来，就先出来这个了，我都
          没看清楚怎么输的"。原来这里是个三元表达式——破产时用借一底弹窗
          **替代**结算弹窗，于是输光的那一手永远看不到自己是怎么输的，而那
          恰恰是最想看清楚的一手。
          这两个弹窗本来就是先后两步（先看结果、再决定要不要继续），不是二
          选一。改成：结算永远先显示，破产时它的"我知道了"引出借一底弹窗。 */}
      {settlement && settlement.winners?.length > 0 && !bustPrompt && (
        <SettlementModal
          winners={settlement.winners}
          myId={me?.id}
          iAmReady={false}
          readyCount={0}
          totalCount={1}
          onReady={myBust ? () => setBustPrompt(true) : handleReady}
          isFoldWin={false}
        />
      )}
      {bustPrompt && (
        <BustDecisionModal
          onRebuy={() => { setBustPrompt(false); handleReady(); }}
          onLeave={handleExit}
        />
      )}
      {showFeedback && <FeedbackModal onClose={() => setShowFeedback(false)} playerName={playerName} />}
      {toast && <div className={`toast toast--${toast.type}`}>{toast.msg}</div>}
    </>
  );
}
