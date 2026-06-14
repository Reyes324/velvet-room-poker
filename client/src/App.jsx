import { useState, useEffect } from 'react';
import './styles/global.css';
import HomePage from './pages/HomePage';
import RoomPage from './pages/RoomPage';
import StatesGallery from './StatesGallery';
import { useStageScale } from './hooks/useStageScale';

export default function App() {
  useStageScale();
  const [room, setRoom] = useState(null); // { code, playerId, playerName } | { autoJoinCode }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomFromUrl = params.get('room');
    if (roomFromUrl && !room) {
      setRoom({ autoJoinCode: roomFromUrl.toUpperCase() });
    }
  }, []);

  function handleJoined(code, playerId, playerName) {
    window.history.replaceState({}, '', '/');
    setRoom({ code, playerId, playerName });
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
        onLeave={() => setRoom(null)}
      />
    </div>
  );
}
