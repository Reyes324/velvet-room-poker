import { useState, useEffect, useRef } from 'react';
import './styles/global.css';
import HomePage from './pages/HomePage';
import RoomPage from './pages/RoomPage';
import PvePage from './pages/PvePage';
import VoiceCheckPage from './pages/VoiceCheckPage';
import VoicePairPage from './pages/VoicePairPage';
import StatesGallery from './StatesGallery';
import ServerResetModal from './components/ServerResetModal';
import { getSocket } from './hooks/useSocket';
import {
  classifyServerChange, readStoredIdentity, writeStoredIdentity,
  hasActiveSession, clearSessionMarkers,
} from './utils/serverIdentity';

// 人机对战的"回来接着打"只在离开后不太久才有意义——用户反馈（2026-07-31）：
// 联机房间不一样（房间是共享状态，只要房间还在就该带你回去），但人机对战
// 纯粹是自己一个人的会话，隔了很久再打开书签，直接回首页反而更符合直觉，
// 不用被"上次那盘还没走完"这件事绑住。窗口长度跟服务端 PveSession 的空闲
// 回收时间（server/index.js 的 PVE_IDLE_TTL_MS）保持一致——超过这个时间，
// 服务端那边的对局本来就已经被清掉了，客户端再尝试"恢复"也只是拿到一局
// 全新的，不如干脆回首页，语义更诚实。
const PVE_RESUME_WINDOW_MS = 30 * 60 * 1000;

// 等 server:hello 的兜底上限。会话恢复要等这个事件（见下方 identityReady），
// 所以它必须有个下限保障：万一服务器是还没带 server:hello 的旧版本、或者
// 连接迟迟建不起来，恢复流程不能被永久卡住——超时就按"一切正常"继续，最
// 坏情况退回到改动前的行为，而不是把人锁在首页。
const HELLO_TIMEOUT_MS = 3000;

export default function App() {
  const [room, setRoom] = useState(null); // { code, playerId, playerName } | { autoJoinCode }
  // Deliberately a separate piece of state from `room`, not folded into it —
  // keeps this structurally distinct from the multiplayer path, matching
  // the server-side decision (PveSession isn't a Room) that real players
  // and AI never share state. null = not in PVE mode; a string = active,
  // using that player name (only meaningful when actually creating a new
  // session — see PvePage's pve:start, which ignores it on a resume).
  const [pveName, setPveName] = useState(null);
  const [pveSeatCount, setPveSeatCount] = useState(2);

  // 服务器进程换过了、玩家的牌局随内存一起没了 → { kind: 'version'|'restart' }。
  const [serverReset, setServerReset] = useState(null);
  // server:hello 已到达（或已超时兜底）。会话恢复必须等它——见下面那个 effect。
  const [identityReady, setIdentityReady] = useState(false);
  const restoredRef = useRef(false);

  // 进程身份握手。必须在任何 rejoin 之前完成：以前的顺序是"先拿旧房间号去
  // rejoin → 服务器回'未找到房间' → toast 报错 → 人卡在原地"，玩家完全不知
  // 道发生了什么。现在先问清楚"服务器还是不是刚才那个进程"，是重启就根本
  // 不发起那次注定失败的 rejoin，直接告诉玩家。
  useEffect(() => {
    const socket = getSocket();
    function onHello(incoming) {
      const result = classifyServerChange(readStoredIdentity(), incoming, hasActiveSession());
      writeStoredIdentity(incoming);
      if (result) setServerReset(result);
      setIdentityReady(true);
    }
    socket.on('server:hello', onHello);
    if (!socket.connected) socket.connect();
    const timer = setTimeout(() => setIdentityReady(true), HELLO_TIMEOUT_MS);
    return () => { socket.off('server:hello', onHello); clearTimeout(timer); };
  }, []);

  // 路由重构（2026-08-02，用户反馈"主域名无论什么时候访问都应该是首页"）：
  // 裸域名 `/` 永远只渲染首页，不再在这里做任何自动恢复——首页自己的
  // "继续上局"卡片（HomePage.jsx）才是从 `/` 进入已有会话的唯一入口。这个
  // effect 现在只处理"URL 本身就明确指向一个会话"的两种情况：`/room/CODE`
  // （邀请链接，或收藏/直接访问自己之前的房间）和 `/pve`（收藏/直接访问，
  // 或从首页卡片点进来后 pushState 到这里）——这两种都是明确的目的地导航，
  // 跟"裸域名该不该自动带你进会话"是两个问题。
  useEffect(() => {
    // 等握手结果再决定要不要恢复。serverReset 非空表示牌局确实已经没了——
    // 这时候恢复只会去 rejoin 一个不存在的房间，换来一句"未找到房间"。
    if (!identityReady || serverReset || restoredRef.current) return;
    restoredRef.current = true;

    const pathMatch = window.location.pathname.match(/^\/room\/([0-9]{6})$/i);
    const params = new URLSearchParams(window.location.search);
    const urlCode = (pathMatch?.[1] ?? params.get('room'))?.toUpperCase() ?? null;
    const onPvePath = window.location.pathname === '/pve';

    if (urlCode) {
      const savedPlayerId = localStorage.getItem('vr_playerId');
      const savedRoomCode = localStorage.getItem('vr_roomCode');
      // 如果本地保存的正好是这个房间，走恢复；否则（比如一个全新的邀请
      // 链接）走加入流程——两者都是靠 RoomPage 处理，这里只负责把正确的
      // 初始 props 传进去。
      if (savedPlayerId && savedRoomCode === urlCode && !room) {
        setRoom({ code: savedRoomCode, playerId: savedPlayerId });
      } else if (!room) {
        setRoom({ autoJoinCode: urlCode });
      }
      return;
    }

    // Same idea, for PVE — user feedback (2026-07-28): closing the browser
    // mid-hand and coming back showed "对局不存在", the exact rough edge
    // the room-resume logic above exists to avoid for multiplayer.
    // playerName is passed as '' — server's pve:start resumes an existing
    // session by pveId and ignores the name in that case.
    //
    // Unlike a multiplayer room (shared state — if the room's still there,
    // go back to it, full stop, no matter how long it's been), PVE resume
    // is gated on PVE_RESUME_WINDOW_MS (user feedback, 2026-07-31): it's a
    // solo session, so coming back well after PVE_RESUME_WINDOW_MS should
    // land on the home page like any fresh visit, not drag you back into a
    // hand from ages ago. lastActive is written by PvePage on every
    // game:state it receives (see that file), so it tracks real activity,
    // not just "when pve:start last ran".
    if (onPvePath && pveName === null) {
      const pveActive = localStorage.getItem('vr_pveActive');
      const pveLastActive = Number(localStorage.getItem('vr_pveLastActive') ?? 0);
      if (pveActive && Date.now() - pveLastActive < PVE_RESUME_WINDOW_MS) {
        // Final-review finding (2026-08-02): pveSeatCount defaults to 2 and
        // was never restored here, so if the server process actually
        // restarted (routine on this project's Render free-tier hosting —
        // see CLAUDE.md) while the client still thought it could resume,
        // pve:start would find no existing session and silently create a
        // brand-new one at whatever seatCount this cold-start request
        // happened to send — always 2, downgrading a 4/6/8-seat table to
        // heads-up with no explanation. Restore the seat count the player
        // actually chose (handlePve persists it below), falling back to 2
        // only if the value is missing/invalid.
        const savedSeatCount = Number(localStorage.getItem('vr_pveSeatCount'));
        const validSeatCounts = [2, 4, 6, 8];
        setPveSeatCount(validSeatCounts.includes(savedSeatCount) ? savedSeatCount : 2);
        setPveName('');
        return;
      }
      // No resumable session (stale, or a fresh direct visit to /pve with
      // nothing saved) — the server would've already reaped a stale one
      // anyway (PVE_IDLE_TTL_MS, same window). Clear the markers, bounce
      // back to the actual home route so this doesn't sit on a blank /pve.
      localStorage.removeItem('vr_pveActive');
      localStorage.removeItem('vr_pveLastActive');
      window.history.replaceState({}, '', '/');
    }
  }, [identityReady, serverReset]);

  // Browser back button → go home
  useEffect(() => {
    function onPop() { setRoom(null); setPveName(null); }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // 牌局已经确定不存在了，本地这些标记全是过期的——不清掉的话，下次进站
  // 又会拿着它们去 rejoin 一个不存在的房间，正是这次要堵掉的那条死路。
  function handleServerResetDismiss() {
    clearSessionMarkers();
    restoredRef.current = true; // 已经在首页了，别再触发一次恢复
    window.history.replaceState({}, '', '/');
    setRoom(null);
    setPveName(null);
    setServerReset(null);
  }

  function handleJoined(code, playerId, playerName, justCreated) {
    window.history.pushState({}, '', '/room/' + code);
    setRoom({ code, playerId, playerName, justCreated });
  }

  function handleLeave() {
    // vr_playerId stays — it's just an anonymous device identity, fine to
    // reuse for the next room. vr_roomCode must go, or the next cold start
    // (see the resume effect above) tries to restore this now-dead session.
    localStorage.removeItem('vr_roomCode');
    // Also clear any stale PVE marker — starting/resuming a multiplayer
    // room supersedes it, so a later cold start shouldn't try to resume a
    // PVE session that's no longer the point.
    localStorage.removeItem('vr_pveActive');
    localStorage.removeItem('vr_pveLastActive');
    localStorage.removeItem('vr_pveSeatCount');
    window.history.pushState({}, '', '/');
    setRoom(null);
  }

  function handlePve(name, seatCount) {
    localStorage.setItem('vr_pveActive', '1');
    localStorage.setItem('vr_pveLastActive', String(Date.now()));
    // Persisted alongside vr_pveActive so a cold-start resume (see the
    // effect above) can request the same table size the player actually
    // chose, instead of silently falling back to the pveSeatCount state
    // default (2) on a fresh page load.
    localStorage.setItem('vr_pveSeatCount', String(seatCount ?? 2));
    window.history.pushState({}, '', '/pve');
    setPveName(name);
    setPveSeatCount(seatCount ?? 2);
  }

  function handlePveLeave() {
    localStorage.removeItem('vr_pveActive');
    localStorage.removeItem('vr_pveLastActive');
    localStorage.removeItem('vr_pveSeatCount');
    window.history.pushState({}, '', '/');
    setPveName(null);
  }

  // Dev self-check: ?states=N renders the real GameTable for one fixed state
  const statesParam = new URLSearchParams(window.location.search).get('states');
  if (statesParam !== null) {
    return <StatesGallery index={Number(statesParam) || 0} />;
  }

  // 麦克风自检页（语音对讲的探路步骤，见 design.md「语音对讲功能」）。放在
  // 会话恢复之后、所有正常路由之前：它是一个不参与游戏状态的独立诊断页，
  // 用户要能在微信里直接打开这个链接，不该被"要不要恢复上一局"的逻辑干扰。
  if (window.location.pathname === '/voice-check') {
    return <VoiceCheckPage />;
  }

  // 双机连通性实测页。同上，独立于游戏状态；而且它必须能被"微信里发个链接
  // 对方点开"直接命中，所以要在会话恢复之后、正常路由之前拦下。
  if (window.location.pathname === '/voice-pair') {
    return <VoicePairPage />;
  }

  // 牌局没了的提示要盖在当前画面之上，所以每个分支都带上它——判定发生时
  // 恢复已经被拦住了，实际上人多半停在首页，但重连也可能发生在任何一屏。
  const resetModal = serverReset
    ? <ServerResetModal kind={serverReset.kind} onDismiss={handleServerResetDismiss} />
    : null;

  if (pveName !== null) {
    return (
      <div className="stage-wrap">
        <PvePage playerName={pveName} seatCount={pveSeatCount} onLeave={handlePveLeave} />
        {resetModal}
      </div>
    );
  }

  if (!room?.code) {
    return (
      <>
        <HomePage onJoined={handleJoined} onPve={handlePve} initialCode={room?.autoJoinCode} />
        {resetModal}
      </>
    );
  }

  return (
    <div className="stage-wrap">
      <RoomPage
        roomCode={room.code}
        playerId={room.playerId}
        playerName={room.playerName}
        justCreated={room.justCreated}
        onLeave={handleLeave}
      />
      {resetModal}
    </div>
  );
}
