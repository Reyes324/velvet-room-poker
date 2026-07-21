const AV = ['av-green', 'av-purple', 'av-teal', 'av-rust', 'av-olive', 'av-blue', 'av-magenta', 'av-gold'];
function colorForId(id) {
  let h = 0;
  for (const ch of String(id)) h = (h + ch.charCodeAt(0)) % 8;
  return h;
}
function amtText(delta) {
  return (delta > 0 ? '+¥' : '−¥') + Math.abs(delta).toLocaleString();
}

// Settlement sheet — bottom drawer (not a full-screen overlay), so the
// showdown reveal on the table stays visible behind it. Only dismissed
// when the server actually advances to the next hand (see RoomPage).
export default function SettlementModal({ winners = [], settle = [], myId, readyCount, totalCount, iAmReady, onReady }) {
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
              <div>
                <div className="modal-winner-name" style={isMe ? { color: '#D4AF37' } : undefined}>
                  {w.name}
                  {isMe ? '（我）' : ''} 赢得本局
                </div>
                <div className="modal-win-amt">+ ¥{Number(w.won).toLocaleString()}</div>
                {w.handName && <div className="modal-hand">{w.handName}</div>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="modal-divider" />
      <div className="settle-list">
        {settle.map((s) => (
          <div key={s.id} className={`settle-row${s.id === myId ? ' hero' : ''}`}>
            <span className="sr-name">{s.name}{s.id === myId ? '（我）' : ''}</span>
            <span className={`sr-amt ${s.net === 0 ? 'sr-neutral' : s.net > 0 ? 'sr-win' : 'sr-lose'}`}>
              {amtText(s.net)}
            </span>
          </div>
        ))}
      </div>

      <div className={`modal-btn${iAmReady ? ' modal-btn--waiting' : ''}`} onClick={iAmReady ? undefined : onReady}>
        {iAmReady ? `等待其他人确认…（${readyCount}/${totalCount}）` : '我知道了'}
      </div>
    </div>
  );
}
