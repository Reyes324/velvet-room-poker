// Rail seat: avatar + unified position badge + platinum stack (styled by shared velvet.css).
// Emits the approved preview's classes (.seat/.avatar/.av-*/.pos-badge/.stack-chip/.reveal).
// Bet chip is rendered by RoomPage (owns toward-center offset). Opponents show two
// face-down cards for the whole hand once dealt; their faces only reveal at showdown.
import Card from './Card';
import { useThinkSeconds } from '../hooks/useThinkSeconds';

const AV = ['av-green', 'av-purple', 'av-teal', 'av-rust', 'av-olive', 'av-blue', 'av-magenta', 'av-gold'];

// Card groups (dealing / showdown reveal) always render to the side of the
// seat (toward whichever direction GameTable's cardsSide picks — the center
// strip, per column). Rows are only COL_ROW_PITCH apart, so anything
// rendered above/below a seat overlaps the neighboring row's card/footer —
// side placement is the only direction with real room to spare, confirmed
// on a real device. The "above" fallback below is unreachable in normal
// play (GameTable always passes a side now) — kept only as a safe default
// if this component is ever rendered without one.
function sideStyle(cardsSide) {
  if (cardsSide === 'left') return { position: 'absolute', right: 'calc(100% + 3px)', top: '50%', transform: 'translateY(-50%)' };
  if (cardsSide === 'right') return { position: 'absolute', left: 'calc(100% + 3px)', top: '50%', transform: 'translateY(-50%)' };
  return { position: 'absolute', bottom: 'calc(100% + 4px)', left: '50%', transform: 'translateX(-50%)' };
}

// The action-text bubble sits in the avatar's own top slot — free now that
// the reveal cards always render to the side instead of above it.
function bubbleStyle(cardsSide) {
  if (cardsSide) return undefined;
  return { bottom: 'calc(100% + 50px)' }; // fallback if ever rendered without a side (see sideStyle)
}

export default function PlayerSeat({ player, isMe, isAction, isWinner, gamePhase, color = 0, bubble, dealing = false, dealDelays, cardsSide = null, onPoke, poked = false }) {
  const isShowdown = gamePhase === 'showdown';
  const hasCards = gamePhase !== 'waiting';
  const folded = player.status === 'folded';
  const allin = player.status === 'allin';
  const badge = player.isDealer ? '庄家' : player.isSB ? '小盲' : player.isBB ? '大盲' : null;
  const avClass = isMe ? 'av-gold' : AV[color % AV.length];
  const thinkSeconds = useThinkSeconds(isAction);

  const seatClass = [
    'seat',
    isWinner && 'is-winner',
    isAction && !isWinner && 'is-active',
    folded && 'is-folded',
    allin && 'is-allin',
    poked && 'is-poked',
  ].filter(Boolean).join(' ');

  return (
    <div className={seatClass}>
      <div className="seat-name">{player.name}</div>
      <div className={`avatar-card ${avClass}`} onClick={!isMe ? onPoke : undefined} role={!isMe ? 'button' : undefined}>
        <div className="avatar-photo">
          {player.name[0].toUpperCase()}
          {badge && <span className="pos-badge">{badge}</span>}
          {isAction && (
            <div className="think-overlay">{thinkSeconds}s</div>
          )}
        </div>
        <div className="stack-chip-footer">¥{player.chips.toLocaleString()}</div>
      </div>

      {bubble && <div key={bubble.key} className="action-bubble" style={bubbleStyle(cardsSide)}>{bubble.text}</div>}
      {poked && <div className="action-bubble poke-bubble" style={bubbleStyle(cardsSide)}>戳了戳</div>}

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
