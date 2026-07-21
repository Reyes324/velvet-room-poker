// Shown to everyone except the busted player(s) themselves while the room
// is paused (see RoomPage's awaitingBustResolution) — the table already
// stays visible underneath (this never covers the whole screen), it's just
// telling people why the next hand hasn't dealt yet. "退出" here is this
// viewer's own choice to stop waiting, not a vote on whether the busted
// player should be allowed to continue — see BustDecisionModal for that.
export default function BustWaitModal({ names, onLeave }) {
  if (!names?.length) return null;
  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-title">等待决策</div>
        <div className="modal-body">等待 {names.join('、')} 决策中……</div>
        <div className="modal-btn-cancel" style={{ width: '100%' }} onClick={onLeave}>退出</div>
      </div>
    </div>
  );
}
