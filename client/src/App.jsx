import { useState, useEffect } from 'react';
import './styles/global.css';
import HomePage from './pages/HomePage';
import RoomPage from './pages/RoomPage';
import PvePage from './pages/PvePage';
import StatesGallery from './StatesGallery';

// 人机对战的"回来接着打"只在离开后不太久才有意义——用户反馈（2026-07-31）：
// 联机房间不一样（房间是共享状态，只要房间还在就该带你回去），但人机对战
// 纯粹是自己一个人的会话，隔了很久再打开书签，直接回首页反而更符合直觉，
// 不用被"上次那盘还没走完"这件事绑住。窗口长度跟服务端 PveSession 的空闲
// 回收时间（server/index.js 的 PVE_IDLE_TTL_MS）保持一致——超过这个时间，
// 服务端那边的对局本来就已经被清掉了，客户端再尝试"恢复"也只是拿到一局
// 全新的，不如干脆回首页，语义更诚实。
const PVE_RESUME_WINDOW_MS = 30 * 60 * 1000;

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

  useEffect(() => {
    const pathMatch = window.location.pathname.match(/^\/room\/([0-9]{6})$/i);
    const params = new URLSearchParams(window.location.search);
    const urlCode = (pathMatch?.[1] ?? params.get('room'))?.toUpperCase() ?? null;

    // Cold-start session resume: a backgrounded mobile tab is very often
    // fully discarded by the OS, not just socket-disconnected — the next
    // "open" is a brand new page load with no React state, so this effect
    // (not RoomPage's own reconnect-on-socket-`connect` logic) is the only
    // place that can catch it. Resume whenever there's a saved session and
    // the URL doesn't point at a *different* room (a fresh invite link to
    // another room is a legitimate new join, not a session to restore).
    const savedPlayerId = localStorage.getItem('vr_playerId');
    const savedRoomCode = localStorage.getItem('vr_roomCode');
    if (savedPlayerId && savedRoomCode && (!urlCode || urlCode === savedRoomCode) && !room) {
      window.history.replaceState({}, '', '/room/' + savedRoomCode);
      setRoom({ code: savedRoomCode, playerId: savedPlayerId });
      return;
    }

    // Same idea, for PVE — user feedback (2026-07-28): closing the browser
    // mid-hand and coming back showed "对局不存在", the exact rough edge
    // the room-resume logic above exists to avoid for multiplayer. Only
    // checked once room-resume above didn't already claim this cold start
    // (a saved room session always wins if somehow both markers are stale
    // at once). playerName is passed as '' — server's pve:start resumes an
    // existing session by pveId and ignores the name in that case.
    //
    // Unlike a multiplayer room (shared state — if the room's still there,
    // go back to it, full stop, no matter how long it's been), PVE resume
    // is gated on PVE_RESUME_WINDOW_MS (user feedback, 2026-07-31): it's a
    // solo session, so coming back well after PVE_RESUME_WINDOW_MS should
    // land on the home page like any fresh visit, not drag you back into a
    // hand from ages ago. lastActive is written by PvePage on every
    // game:state it receives (see that file), so it tracks real activity,
    // not just "when pve:start last ran".
    const pveActive = localStorage.getItem('vr_pveActive');
    const pveLastActive = Number(localStorage.getItem('vr_pveLastActive') ?? 0);
    if (pveActive && !room && pveName === null) {
      if (Date.now() - pveLastActive < PVE_RESUME_WINDOW_MS) {
        setPveName('');
        return;
      }
      // Stale — the server would've already reaped this session anyway
      // (PVE_IDLE_TTL_MS, same window). Clear the markers so this doesn't
      // keep re-checking a resume that's never going to happen.
      localStorage.removeItem('vr_pveActive');
      localStorage.removeItem('vr_pveLastActive');
    }

    if (urlCode && !room) {
      setRoom({ autoJoinCode: urlCode });
    }
  }, []);

  // Browser back button → go home
  useEffect(() => {
    function onPop() { setRoom(null); }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

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
    window.history.pushState({}, '', '/');
    setRoom(null);
  }

  function handlePve(name, seatCount) {
    localStorage.setItem('vr_pveActive', '1');
    localStorage.setItem('vr_pveLastActive', String(Date.now()));
    setPveName(name);
    setPveSeatCount(seatCount ?? 2);
  }

  function handlePveLeave() {
    localStorage.removeItem('vr_pveActive');
    localStorage.removeItem('vr_pveLastActive');
    setPveName(null);
  }

  // Dev self-check: ?states=N renders the real GameTable for one fixed state
  const statesParam = new URLSearchParams(window.location.search).get('states');
  if (statesParam !== null) {
    return <StatesGallery index={Number(statesParam) || 0} />;
  }

  if (pveName !== null) {
    return (
      <div className="stage-wrap">
        <PvePage playerName={pveName} seatCount={pveSeatCount} onLeave={handlePveLeave} />
      </div>
    );
  }

  if (!room?.code) {
    return <HomePage onJoined={handleJoined} onPve={handlePve} initialCode={room?.autoJoinCode} />;
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
    </div>
  );
}
