// Shown only to the host once the "计时游戏" session timer expires — this
// only ever appears after the current hand has actually finished (see
// server's tryAdvanceIfClear: the check only runs at a real hand boundary,
// never mid-hand), so it can't interrupt anyone's turn. Non-host players
// see a lightweight toast instead (see RoomPage's game:timer-expired
// handler) — only the host gets a decision to make.
export default function TimerDecisionModal({ onEndGame, onContinue }) {
  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-title">计时已到</div>
        <div className="modal-body">本局设定的时间到了，要结束对局，还是忽略继续打？</div>
        <div className="modal-btns">
          <div className="modal-btn-cancel" onClick={onContinue}>忽略继续</div>
          <div className="modal-btn-danger" onClick={onEndGame}>结束对局</div>
        </div>
      </div>
    </div>
  );
}
