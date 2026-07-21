// Fold-win ending — everyone else folded, there's no hand to compare and
// nothing on the table to reveal, so this deliberately isn't the same
// bottom sheet the real showdown gets: a small non-blocking card near the
// top of the screen, out of the way of hero's own cards and the seat rail.
export default function FoldWinBanner({ winner, myId, iAmReady, readyCount, totalCount, onReady }) {
  if (!winner) return null;
  const isMe = winner.id === myId;

  return (
    <div className="fold-win-banner">
      <div className="fwb-line">
        <span className="fwb-name" style={isMe ? { color: '#D4AF37' } : undefined}>
          {winner.name}{isMe ? '（我）' : ''}
        </span>
        <span className="fwb-amt">+¥{Number(winner.won).toLocaleString()}</span>
      </div>
      <div className="fwb-reason">对手全部弃牌</div>
      <div className={`fwb-btn${iAmReady ? ' fwb-btn--waiting' : ''}`} onClick={iAmReady ? undefined : onReady}>
        {iAmReady ? `等待其他人确认…（${readyCount}/${totalCount}）` : '我知道了'}
      </div>
    </div>
  );
}
