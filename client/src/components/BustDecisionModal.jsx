import { useState } from 'react';

// Shown to a player the moment their own chips hit 0 — the room holds the
// next hand until they resolve this (see RoomPage's awaitingBustResolution
// handling), so everyone else sees a matching "等待中" modal in the
// meantime rather than the game silently moving on without them. Only two
// choices for now — a third "旁观留下" (spectate, no decision) option was
// cut per explicit user feedback: every bust should end in an actual
// resolution, not a player left in limbo holding the room open. No
// backdrop-dismiss either, for the same reason.
export default function BustDecisionModal({ onRebuy, onLeave }) {
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
        <div className="modal-body">要再借一底回到牌桌，还是退出本局对局？</div>
        <div
          className="modal-btn"
          style={pending ? { opacity: .5, cursor: 'default' } : undefined}
          onClick={handleRebuy}
        >
          +借一底（¥1,000）
        </div>
        <div className="modal-btn-danger" style={{ width: '100%' }} onClick={onLeave}>退出对局</div>
      </div>
    </div>
  );
}
