// Rail seat: avatar + unified position badge + platinum stack (styled by shared velvet.css).
// Emits the approved preview's classes (.seat/.avatar/.av-*/.pos-badge/.stack-chip/.reveal).
// Bet chip is rendered by RoomPage (owns toward-center offset). Opponent cards reveal only at showdown.
import Card from './Card';

const AV = ['av-green', 'av-purple', 'av-teal', 'av-rust', 'av-olive', 'av-blue', 'av-magenta', 'av-gold'];

// Card groups (dealing / showdown reveal) and the action bubble default to
// sitting above the avatar. Seats near the top-bar (cardsSide set by
// GameTable) push them to whichever side has more room instead, so the
// avatar itself can still sit exactly on the table rail.
function sideStyle(cardsSide) {
  if (cardsSide === 'left') return { position: 'absolute', right: 'calc(100% + 6px)', top: '50%', transform: 'translateY(-50%)' };
  if (cardsSide === 'right') return { position: 'absolute', left: 'calc(100% + 6px)', top: '50%', transform: 'translateY(-50%)' };
  return { position: 'absolute', bottom: 'calc(100% + 4px)', left: '50%', transform: 'translateX(-50%)' };
}

export default function PlayerSeat({ player, isMe, isAction, isWinner, gamePhase, color = 0, bubble, dealing = false, dealDelays, cardsSide = null }) {
  const isShowdown = gamePhase === 'showdown';
  const folded = player.status === 'folded';
  const allin = player.status === 'allin';
  const badge = player.isDealer ? 'D' : player.isSB ? 'SB' : player.isBB ? 'BB' : null;
  const avClass = isMe ? 'av-gold' : AV[color % AV.length];

  const seatClass = [
    'seat',
    isWinner && 'is-winner',
    isAction && !isWinner && 'is-active',
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

      {bubble && <div key={bubble.key} className="action-bubble" style={cardsSide ? sideStyle(cardsSide) : undefined}>{bubble.text}</div>}

      {dealing && !isMe && !folded && (
        <div className="reveal" style={sideStyle(cardsSide)}>
          <Card size="xs" faceDown animate="card-deal" delay={dealDelays?.[0] ?? 0} />
          <Card size="xs" faceDown animate="card-deal" delay={dealDelays?.[1] ?? 0} />
        </div>
      )}

      {isShowdown && !folded && !isMe && player.holeCards?.length === 2 && (
        <div className="reveal" style={sideStyle(cardsSide)}>
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
