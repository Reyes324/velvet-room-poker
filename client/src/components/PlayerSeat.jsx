import Card from './Card';
import './PlayerSeat.css';

const STATUS_LABEL = { active: '等待中', folded: '已弃牌', allin: '全押' };

export default function PlayerSeat({ player, isMe, isAction, gamePhase }) {
  const isShowdown = gamePhase === 'showdown';

  return (
    <div className={[
      'seat',
      isAction && 'seat--active',
      player.status === 'folded' && 'seat--folded',
      player.status === 'allin'  && 'seat--allin',
      isMe && 'seat--me',
    ].filter(Boolean).join(' ')}>

      {player.isDealer && <span className="dealer-btn">D</span>}
      {player.isSB    && <span className="blind-badge blind--sb">小盲</span>}
      {player.isBB    && <span className="blind-badge blind--bb">大盲</span>}

      <div className="seat-header">
        <div className="seat-avatar">{player.name[0].toUpperCase()}</div>
        <div className="seat-info">
          <div className="seat-name">{player.name}{isMe && ' (我)'}</div>
          <div className={`seat-status seat-status--${player.status}`}>
            {isAction ? '行动中…' : STATUS_LABEL[player.status] ?? ''}
          </div>
        </div>
      </div>

      <div className="seat-cards">
        {(player.holeCards && player.holeCards.length === 2)
          ? player.holeCards.map((c, i) =>
              <Card key={i} card={c} size="xs" faceDown={c === null && !isShowdown} />
            )
          : [<Card key={0} size="xs" faceDown />, <Card key={1} size="xs" faceDown />]
        }
      </div>

      <div className="seat-footer">
        <div>
          <div className="seat-label">筹码</div>
          <div className="seat-chips">${player.chips.toLocaleString()}</div>
        </div>
      </div>

      {player.bet > 0 && (
        <div className="seat-bet">
          <span className="seat-bet-label">下注</span>
          <span className="seat-bet-amount">${player.bet.toLocaleString()}</span>
        </div>
      )}

    </div>
  );
}
