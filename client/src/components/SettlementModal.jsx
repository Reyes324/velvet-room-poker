const AV = ['av-green', 'av-purple', 'av-teal', 'av-rust', 'av-olive', 'av-blue', 'av-magenta', 'av-gold'];
function colorForId(id) {
  let h = 0;
  for (const ch of String(id)) h = (h + ch.charCodeAt(0)) % 8;
  return h;
}

// Settlement sheet — bottom drawer (not a full-screen overlay), so the
// showdown reveal on the table stays visible behind it. Only dismissed
// when the server actually advances to the next hand (see RoomPage).
// Deliberately just "who won, how much, what beat it" — no per-player
// breakdown (that used to make this tall enough to reach hero's own cards
// near the bottom of the canvas; the running ledger already covers
// who's up/down overall, this doesn't need to repeat it every hand). Also
// shared by the fold-win case (`handName` reads "其他人全部弃牌" instead of
// a real hand description then) rather than a separate component — the
// wording difference alone is enough to tell the two apart.
export default function SettlementModal({ winners = [], myId, readyCount, totalCount, iAmReady, onReady }) {
  if (winners.length === 0) return null;

  return (
    <div className="settlement-sheet">
      <div className="modal-title">✦ 本局结算</div>

      <div className="settlement-winners">
        {winners.map((w) => {
          const isMe = w.id === myId;
          const avClass = isMe ? 'av-gold' : AV[colorForId(w.id)];
          return (
            <div key={w.id} className="settlement-winner-row">
              <div className={`modal-winner-av ${avClass}`}>{w.name[0].toUpperCase()}</div>
              <div className="modal-winner-info">
                <div className="modal-winner-name" style={isMe ? { color: '#D4AF37' } : undefined}>
                  {w.name}
                  {isMe ? '（我）' : ''} 赢得本局
                </div>
                <div className="modal-win-amt">+ ¥{Number(w.won).toLocaleString()}</div>
              </div>
              {w.handName && <div className="modal-hand">{w.handName}</div>}
            </div>
          );
        })}
      </div>

      <div className={`modal-btn${iAmReady ? ' modal-btn--waiting' : ''}`} onClick={iAmReady ? undefined : onReady}>
        {iAmReady ? `等待其他人确认…（${readyCount}/${totalCount}）` : '我知道了'}
      </div>
    </div>
  );
}
