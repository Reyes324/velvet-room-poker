import { useState, useEffect } from 'react';
import './styles/global.css';
import HomePage from './pages/HomePage';
import RoomPage from './pages/RoomPage';
import StatesGallery from './StatesGallery';

export default function App() {
  const [room, setRoom] = useState(null); // { code, playerId, playerName } | { autoJoinCode }

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

  function handleJoined(code, playerId, playerName) {
    window.history.pushState({}, '', '/room/' + code);
    setRoom({ code, playerId, playerName });
  }

  function handleLeave() {
    // vr_playerId stays — it's just an anonymous device identity, fine to
    // reuse for the next room. vr_roomCode must go, or the next cold start
    // (see the resume effect above) tries to restore this now-dead session.
    localStorage.removeItem('vr_roomCode');
    window.history.pushState({}, '', '/');
    setRoom(null);
  }

  // Dev self-check: ?states=N renders the real GameTable for one fixed state
  const statesParam = new URLSearchParams(window.location.search).get('states');
  if (statesParam !== null) {
    return <StatesGallery index={Number(statesParam) || 0} />;
  }

  if (!room?.code) {
    return <HomePage onJoined={handleJoined} initialCode={room?.autoJoinCode} />;
  }

  return (
    <div className="stage-wrap">
      <RoomPage
        roomCode={room.code}
        playerId={room.playerId}
        playerName={room.playerName}
        onLeave={handleLeave}
      />
    </div>
  );
}
