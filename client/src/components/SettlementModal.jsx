import { useSecondsLeft } from '../hooks/useSecondsLeft';

const AV = ['av-green', 'av-purple', 'av-teal', 'av-rust', 'av-olive', 'av-blue', 'av-magenta', 'av-gold'];

function colorForId(id) {
  let h = 0;
  for (const ch of String(id)) h = (h + ch.charCodeAt(0)) % 8;
  return h;
}

export default function SettlementModal({
  winners = [], myId, readyCount, totalCount, iAmReady, onReady,
  isFoldWin = false, iAmWinner = false, myCardsRevealed = false, onReveal,
  endsAt = null,
}) {
  const secondsLeft = useSecondsLeft(endsAt);

  // 点过确认之后的文案。以前写的是"等待其他人确认…"，暗示要无限等别人——
  // 而现在到点就会自动继续，不会真的卡在任何人身上（用户反馈 #10）。
  const waitingLabel = secondsLeft == null
    ? `等待其他人确认…（${readyCount}/${totalCount}）`
    : `${secondsLeft}s 后自动继续（${readyCount}/${totalCount}）`;

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
              <div className={`modal-winner-av ${avClass}${isFoldWin ? ' modal-winner-av--foldwin' : ''}`}>{w.name[0].toUpperCase()}</div>
              <div className="modal-winner-info">
                <div className="modal-winner-name" style={isMe ? { color: '#D4AF37' } : undefined}>
                  {w.name}
                  {isMe ? '（我）' : ''} 赢得本局
                </div>
                <div className="modal-win-amt">+ ¥{Number(w.won).toLocaleString()}</div>
              </div>
              {w.handName && <div className={`modal-hand${isFoldWin ? ' modal-hand--foldwin' : ''}`}>{w.handName}</div>}
            </div>
          );
        })}
      </div>

      {isFoldWin && iAmWinner ? (
        <div className="modal-btns">
          <div
            className={`modal-btn modal-btn--secondary modal-btn--paired${myCardsRevealed ? ' modal-btn--revealed' : ''}`}
            onClick={myCardsRevealed ? undefined : onReveal}
          >
            {myCardsRevealed ? '已亮牌 ✓' : '亮牌炫耀'}
          </div>
          <div
            className={`modal-btn modal-btn--paired${iAmReady ? ' modal-btn--waiting' : ''}`}
            onClick={iAmReady ? undefined : onReady}
          >
            {iAmReady ? waitingLabel : '我知道了'}
          </div>
        </div>
      ) : (
        <div className={`modal-btn${iAmReady ? ' modal-btn--waiting' : ''}`} onClick={iAmReady ? undefined : onReady}>
          {iAmReady ? waitingLabel : '我知道了'}
        </div>
      )}
    </div>
  );
}
