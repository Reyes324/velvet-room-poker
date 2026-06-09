import { useState, useEffect } from 'react';
import './styles/global.css';
import HomePage from './pages/HomePage';
import RoomPage from './pages/RoomPage';

export default function App() {
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

  if (!room?.code) {
    return <HomePage onJoined={handleJoined} initialCode={room?.autoJoinCode} />;
  }

  return (
    <RoomPage
      roomCode={room.code}
      playerId={room.playerId}
      playerName={room.playerName}
      onLeave={() => setRoom(null)}
    />
  );
}
