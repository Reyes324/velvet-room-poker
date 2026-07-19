import { useState } from 'react';

// Shown once to a player the moment their own chips cross >0 → 0 (see
// RoomPage.jsx's prevChipsRef effect) — everyone else's game keeps running
// uninterrupted. Backdrop click and "旁观留下" do the same thing (dismiss,
// non-destructive default); "离开" is the only exit from the room itself.
export default function BustDecisionModal({ onRebuy, onSpectate, onLeave }) {
  const [pending, setPending] = useState(false);

  function handleRebuy() {
    if (pending) return;
    setPending(true);
    onRebuy();
    setTimeout(() => setPending(false), 3000); // safety-net reset if room:state never arrives
  }

  return (
    <div className="modal-overlay" onClick={onSpectate}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-title">筹码已用完</div>
        <div className="modal-body">其他玩家的牌局不受影响，继续进行。要再借一底回到牌桌，还是先留下来看牌？</div>
        <div
          className="modal-btn"
          style={pending ? { opacity: .5, cursor: 'default' } : undefined}
          onClick={handleRebuy}
        >
          +借一底（¥1,000）
        </div>
        <div className="modal-btns">
          <div className="modal-btn-cancel" onClick={onSpectate}>旁观留下</div>
          <div className="modal-btn-danger" onClick={onLeave}>离开</div>
        </div>
      </div>
    </div>
  );
}
