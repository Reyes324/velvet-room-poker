import { useState, useEffect } from 'react';
import './styles/global.css';
import HomePage from './pages/HomePage';
import RoomPage from './pages/RoomPage';
import StatesGallery from './StatesGallery';

export default function App() {
  const [room, setRoom] = useState(null); // { code, playerId, playerName } | { autoJoinCode }

  useEffect(() => {
    // Path-based join: /room/123456
    const pathMatch = window.location.pathname.match(/^\/room\/([0-9]{6})$/i);
    if (pathMatch && !room) {
      setRoom({ autoJoinCode: pathMatch[1].toUpperCase() });
      return;
    }
    // Legacy query param: /?room=123456
    const params = new URLSearchParams(window.location.search);
    const roomFromUrl = params.get('room');
    if (roomFromUrl && !room) {
      setRoom({ autoJoinCode: roomFromUrl.toUpperCase() });
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
