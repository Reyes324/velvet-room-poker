import Card from './Card';
import './PlayerSeat.css';

// v3 rail seat: avatar disc + unified position badge + platinum stack.
// Bet chip is rendered by RoomPage (it owns the toward-center offset).
// Opponent hole cards are hidden until showdown (no persistent card backs).
export default function PlayerSeat({ player, isMe, isAction, gamePhase }) {
  const isShowdown = gamePhase === 'showdown';
  const folded = player.status === 'folded';
  const allin = player.status === 'allin';
  const badge = player.isDealer ? 'D' : player.isSB ? 'SB' : player.isBB ? 'BB' : null;

  return (
    <div className={[
      'seat',
      isAction && 'seat--active',
      folded && 'seat--folded',
      allin && 'seat--allin',
      isMe && 'seat--me',
    ].filter(Boolean).join(' ')}>

      <div className="seat-avatar">
        {player.name[0].toUpperCase()}
        {badge && <span className="pos-badge">{badge}</span>}
      </div>

      {folded
        ? <div className="seat-tag seat-tag--fold">弃牌</div>
        : allin
          ? <div className="seat-tag seat-tag--allin">ALL IN</div>
          : <div className="seat-stack">¥{player.chips.toLocaleString()}</div>}

      {/* Reveal opponents' cards only at showdown (hero sees own cards large at bottom) */}
      {isShowdown && !folded && !isMe && player.holeCards?.length === 2 && (
        <div className="seat-reveal">
          {player.holeCards.map((c, i) => <Card key={i} card={c} size="xs" />)}
        </div>
      )}
    </div>
  );
}
