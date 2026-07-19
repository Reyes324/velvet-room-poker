// Rail seat: avatar + unified position badge + platinum stack (styled by shared velvet.css).
// Emits the approved preview's classes (.seat/.avatar/.av-*/.pos-badge/.stack-chip/.reveal).
// Bet chip is rendered by RoomPage (owns toward-center offset). Opponents show two
// face-down cards for the whole hand once dealt; their faces only reveal at showdown.
import Card from './Card';

const AV = ['av-green', 'av-purple', 'av-teal', 'av-rust', 'av-olive', 'av-blue', 'av-magenta', 'av-gold'];

// Card groups (dealing / showdown reveal) default to sitting above the avatar.
// Seats near the top-bar (cardsSide set by GameTable) push them to whichever
// side has more room instead, so the avatar itself can still sit exactly on
// the table rail.
function sideStyle(cardsSide) {
  if (cardsSide === 'left') return { position: 'absolute', right: 'calc(100% + 6px)', top: '50%', transform: 'translateY(-50%)' };
  if (cardsSide === 'right') return { position: 'absolute', left: 'calc(100% + 6px)', top: '50%', transform: 'translateY(-50%)' };
  return { position: 'absolute', bottom: 'calc(100% + 4px)', left: '50%', transform: 'translateX(-50%)' };
}

// The action-text bubble must never sit on top of the (now permanent) face-down
// reveal cards. When the reveal sits above the avatar (the common case) the
// bubble stacks further above it; when the reveal has been pushed to a side
// instead (near-top-edge seats), the avatar's own default top slot is free and
// the bubble uses that (same sideStyle call the reveal used to also use here).
function bubbleStyle(cardsSide) {
  if (cardsSide) return undefined;
  return { bottom: 'calc(100% + 50px)' }; // clears the 40px-tall xs reveal card + its own 4px gap + margin
}

export default function PlayerSeat({ player, isMe, isAction, isWinner, gamePhase, color = 0, bubble, dealing = false, dealDelays, cardsSide = null }) {
  const isShowdown = gamePhase === 'showdown';
  const hasCards = gamePhase !== 'waiting';
  const folded = player.status === 'folded';
  const allin = player.status === 'allin';
  const badge = player.isDealer ? '庄家' : player.isSB ? '小盲' : player.isBB ? '大盲' : null;
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
      <div className="seat-name">{player.name}</div>
      <div className={`avatar-card ${avClass}`}>
        <div className="avatar-photo">
          {player.name[0].toUpperCase()}
          {badge && <span className="pos-badge">{badge}</span>}
        </div>
        <div className="stack-chip-footer">¥{player.chips.toLocaleString()}</div>
      </div>

      {bubble && <div key={bubble.key} className="action-bubble" style={bubbleStyle(cardsSide)}>{bubble.text}</div>}

      {hasCards && !isMe && !folded && !isShowdown && (
        <div className="reveal" style={sideStyle(cardsSide)}>
          <Card size="xs" faceDown animate={dealing ? 'card-deal' : null} delay={dealing ? (dealDelays?.[0] ?? 0) : 0} />
          <Card size="xs" faceDown animate={dealing ? 'card-deal' : null} delay={dealing ? (dealDelays?.[1] ?? 0) : 0} />
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
