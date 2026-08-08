import { useState } from 'react';

// Shown to a player the moment their own chips hit 0 — the room holds the
// next hand until they resolve this (see RoomPage's awaitingBustResolution
// handling), so everyone else sees a matching "等待中" modal in the
// meantime rather than the game silently moving on without them.
//
// "旁观留下" was cut once (see git history) because it didn't clearly
// resolve the room's pause — a player picking it just sat there, still
// blocking everyone else. Brought back under the sit-out design (2026-08-08):
// picking it now explicitly resolves the pause (server: Room.spectate),
// same as rebuy/leave do — the room continues immediately, this player
// just falls out of the next hand like any other spectator. No
// backdrop-dismiss, since every path here does end in a real resolution.
//
// `onSpectate` is optional — PvePage doesn't pass it. Watching AI-vs-AI
// with no other human at the table has no audience to spectate for, so
// that surface keeps the original two-choice modal (rebuy or exit).
export default function BustDecisionModal({ onRebuy, onSpectate, onLeave }) {
  const [pending, setPending] = useState(false);

  function handleRebuy() {
    if (pending) return;
    setPending(true);
    onRebuy();
    setTimeout(() => setPending(false), 3000); // safety-net reset if room:state never arrives
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-title">筹码已用完</div>
        <div className="modal-body">要再借一底回到牌桌{onSpectate ? '，先旁观看看，' : '，'}还是退出本局对局？</div>
        <div className="modal-btns">
          <div
            className={`modal-btn modal-btn--paired${pending ? ' modal-btn--waiting' : ''}`}
            onClick={handleRebuy}
          >
            +借一底
          </div>
          {onSpectate && <div className="modal-btn modal-btn--paired" onClick={onSpectate}>旁观留下</div>}
          <div className="modal-btn-danger" onClick={onLeave}>退出对局</div>
        </div>
      </div>
    </div>
  );
}
