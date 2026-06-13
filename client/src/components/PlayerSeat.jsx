// Rail seat: avatar + unified position badge + platinum stack (styled by shared velvet.css).
// Emits the approved preview's classes (.seat/.avatar/.av-*/.pos-badge/.stack-chip/.reveal).
// Bet chip is rendered by RoomPage (owns toward-center offset). Opponent cards reveal only at showdown.
const AV = ['av-green', 'av-purple', 'av-teal', 'av-rust', 'av-olive', 'av-blue', 'av-magenta', 'av-gold'];

export default function PlayerSeat({ player, isMe, isAction, gamePhase, color = 0 }) {
  const isShowdown = gamePhase === 'showdown';
  const folded = player.status === 'folded';
  const allin = player.status === 'allin';
  const badge = player.isDealer ? 'D' : player.isSB ? 'SB' : player.isBB ? 'BB' : null;
  const avClass = isMe ? 'av-gold' : AV[color % AV.length];

  const seatClass = [
    'seat',
    isAction && 'is-active',
    folded && 'is-folded',
    allin && 'is-allin',
  ].filter(Boolean).join(' ');

  return (
    <div className={seatClass}>
      <div className={`avatar ${avClass}`}>
        {player.name[0].toUpperCase()}
        {badge && <span className="pos-badge">{badge}</span>}
      </div>

      {folded
        ? <div className="fold-tag">弃牌</div>
        : allin
          ? <div className="allin-tag">ALL IN</div>
          : <div className="stack-chip">¥{player.chips.toLocaleString()}</div>}

      {isShowdown && !folded && !isMe && player.holeCards?.length === 2 && (
        <div className="reveal" style={{ position: 'absolute', bottom: 'calc(100% + 4px)', left: '50%', transform: 'translateX(-50%)' }}>
          {player.holeCards.map((c, i) => (
            <div key={i} className={`rc${c.color === 'red' ? ' red' : ''}`}>
              <span className="rct">{c.rank}</span><span className="rcc">{c.suit}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
