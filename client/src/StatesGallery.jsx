import GameTable from './components/GameTable';
import SettlementModal from './components/SettlementModal';
import { STATES } from './fixtures';

// Dev self-check page: renders the REAL GameTable with fixed data for one state.
// Open ?states=0..N to render each production state fullscreen.
export default function StatesGallery({ index = 0 }) {
  const s = STATES[index] || STATES[0];
  return (
    <>
      <GameTable
        gameState={s.gameState}
        myId={s.myId}
        roomCode={s.roomCode}
        showdown={s.showdown}
        onAction={() => {}}
        actionDisabled={false}
      />
      {s.settlement && (
        <SettlementModal
          winner={s.settlement.winner}
          results={s.settlement.results}
          onClose={() => {}}
          seconds={99}
        />
      )}
      <div style={{
        position: 'fixed', top: 6, left: 6, zIndex: 999,
        font: '11px monospace', color: '#D4AF37',
        background: 'rgba(0,0,0,.6)', padding: '3px 8px', borderRadius: 6,
      }}>{index} · {s.name}</div>
    </>
  );
}
