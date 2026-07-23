// Rail seat: avatar + unified position badge + platinum stack (styled by shared velvet.css).
// The action bubble (bet amount + category label, e.g. "加注 ¥40"/"小盲 ¥10")
// is this seat's only "what did they put in, and why" indicator — there's no
// separate bare-number bet-chip anymore, that duplicated the same info
// without the label (confirmed on a real device). Opponents' hole cards are
// never shown face-down pre-showdown (removed — they carried no information
// and only ate into the tight center-strip space); they only appear at real
// showdown.
import { useThinkSeconds } from '../hooks/useThinkSeconds';
import Card from './Card';

const AV = ['av-green', 'av-purple', 'av-teal', 'av-rust', 'av-olive', 'av-blue', 'av-magenta', 'av-gold'];

// The showdown reveal always renders to the side of the seat (toward
// whichever direction GameTable's cardsSide picks — the center strip, per
// column). Rows are only COL_ROW_PITCH apart, so anything rendered
// above/below a seat overlaps the neighboring row's card/footer — side
// placement is the only direction with real room to spare, confirmed on a
// real device. The "above" fallback below is unreachable in normal play
// (GameTable always passes a side now) — kept only as a safe default if
// this component is ever rendered without one.
// Every branch fully specifies all four of left/right/top/bottom (using
// 'auto' for the unused ones) rather than only the properties it cares
// about — .action-bubble's own CSS class sets `left:50%` and `bottom:...`
// at rest, and an inline style that only overrides `right`/`top` leaves
// that `left:50%` still active alongside the new `right`, which makes the
// browser treat both edges as constraints and squash the element's width
// down to whatever's between them (confirmed via computed-style inspection
// on a real render, not guessed).
function sideStyle(cardsSide) {
  if (cardsSide === 'left') return { position: 'absolute', left: 'auto', right: 'calc(100% + 3px)', top: '50%', bottom: 'auto', transform: 'translateY(-50%)' };
  if (cardsSide === 'right') return { position: 'absolute', left: 'calc(100% + 3px)', right: 'auto', top: '50%', bottom: 'auto', transform: 'translateY(-50%)' };
  return { position: 'absolute', left: '50%', right: 'auto', bottom: 'calc(100% + 4px)', top: 'auto', transform: 'translateX(-50%)' };
}

// Hero's own bubble is the one case that still defaults to "above" (no
// bubbleSide passed) — hero sits centered at the bottom of the canvas with
// clear room above toward the community cards, confirmed via a real render;
// every other seat always gets an explicit side from GameTable now.
function bubbleStyle(bubbleSide) {
  return bubbleSide ? sideStyle(bubbleSide) : undefined;
}

export default function PlayerSeat({ player, isMe, isAction, isWinner, gamePhase, color = 0, bubble, cardsSide = null, bubbleSide = null, onPoke, poked = false, revealedCards = null }) {
  const isShowdown = gamePhase === 'showdown';
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
      <div className="seat-name-row">
        <div className="seat-name">{player.name}{isMe && '（我）'}</div>
        {badge && <span className="pos-badge">{badge}</span>}
      </div>
      <div className={`avatar-card ${avClass}`} onClick={!isMe ? onPoke : undefined} role={!isMe ? 'button' : undefined}>
        <div className="avatar-photo">
          {player.name[0].toUpperCase()}
          {isAction && (
            <div className="think-overlay">{thinkSeconds}s</div>
          )}
        </div>
        <div className="stack-chip-footer">¥{player.chips.toLocaleString()}</div>
      </div>

      {bubble && <div key={bubble.key} className="action-bubble" style={bubbleStyle(bubbleSide)}>{bubble.text}</div>}
      {poked && <div className="action-bubble poke-bubble" style={bubbleStyle(bubbleSide)}>戳了戳</div>}

      {isShowdown && !folded && !isMe && player.holeCards?.length === 2 && (
        <div className="reveal" style={sideStyle(cardsSide)}>
          {player.holeCards.map((c, i) => (
            <Card key={i} card={c} size="xs" />
          ))}
        </div>
      )}

      {revealedCards && revealedCards.length === 2 && (
        <div className="reveal-fold-show" style={sideStyle(cardsSide)}>
          {revealedCards.map((c, i) => (
            <Card key={i} card={c} size="xs" animate="flip-reveal" delay={i * 0.1} />
          ))}
        </div>
      )}
    </div>
  );
}
