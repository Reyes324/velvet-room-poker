import GameTable from './components/GameTable';
import SettlementModal from './components/SettlementModal';
import Lobby from './components/Lobby';
import BustDecisionModal from './components/BustDecisionModal';
import LedgerModal from './components/LedgerModal';
import { STATES } from './fixtures';

const badge = (index, name) => (
  <div style={{
    position: 'fixed', top: 6, left: 6, zIndex: 999,
    font: '11px monospace', color: '#D4AF37',
    background: 'rgba(0,0,0,.6)', padding: '3px 8px', borderRadius: 6,
  }}>{index} · {name}</div>
);

// Dev self-check page: renders the REAL components with fixed data for one state.
export default function StatesGallery({ index = 0 }) {
  const s = STATES[index] || STATES[0];

  if (s.lobby) {
    return (
      <>
        <Lobby roomState={s.lobby.roomState} playerId={s.lobby.playerId}
          onCopy={() => {}} onKick={() => {}} onStart={() => {}} onRestart={() => {}} copied={false} maxSeats={9} />
        {badge(index, s.name)}
      </>
    );
  }

  return (
    <>
      <GameTable
        gameState={s.gameState}
        myId={s.myId}
        roomCode={s.roomCode}
        showdown={s.showdown}
        onAction={() => {}}
        actionDisabled={false}
        amPlaying={s.amPlaying ?? true}
        myChips={s.myChips ?? 0}
        onRebuy={() => {}}
        onOpenLedger={() => {}}
      />
      {s.settlement && (
        <SettlementModal
          winner={s.settlement.winner}
          results={s.settlement.results}
          onClose={() => {}}
          seconds={99}
        />
      )}
      {s.bustPreview && <BustDecisionModal onRebuy={() => {}} onSpectate={() => {}} onLeave={() => {}} />}
      {s.ledgerPreview && (
        <LedgerModal
          players={s.ledgerPreview.players}
          startingChips={s.ledgerPreview.startingChips}
          myId={s.myId}
          onClose={() => {}}
        />
      )}
      {badge(index, s.name)}
    </>
  );
}
