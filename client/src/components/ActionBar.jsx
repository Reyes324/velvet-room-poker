import { useState } from 'react';
import './ActionBar.css';

export default function ActionBar({ gameState, myId, onAction, disabled }) {
  const [raiseAmount, setRaiseAmount] = useState('');

  if (!gameState || gameState.actionPlayerId !== myId || disabled) return null;

  const me = gameState.players.find(p => p.id === myId);
  if (!me) return null;

  const toCall = Math.max(0, gameState.currentBet - me.bet);
  const canCheck = toCall === 0;
  const minRaise = gameState.currentBet * 2 || gameState.currentBet + 200;
  const maxRaise = me.chips + me.bet;
  const raiseVal = Number(raiseAmount) || minRaise;

  function act(action, amount) {
    onAction(action, amount);
    setRaiseAmount('');
  }

  return (
    <div className="action-bar">
      <div className="action-bar-inner">
        <button className="btn btn-fold" onClick={() => act('fold')}>弃牌</button>

        {canCheck
          ? <button className="btn btn-check" onClick={() => act('check')}>过牌</button>
          : <button className="btn btn-call" onClick={() => act('call')}>
              跟注 <span className="btn-amount">${toCall.toLocaleString()}</span>
            </button>
        }

        <div className="raise-group">
          <div className="raise-input-row">
            <span className="raise-prefix">$</span>
            <input
              className="raise-input"
              type="number"
              min={minRaise}
              max={maxRaise}
              value={raiseAmount}
              placeholder={minRaise}
              onChange={e => setRaiseAmount(e.target.value)}
            />
          </div>
          <input
            className="raise-slider"
            type="range"
            min={minRaise}
            max={maxRaise}
            value={raiseVal}
            onChange={e => setRaiseAmount(e.target.value)}
          />
          <button className="btn btn-raise" onClick={() => act('raise', raiseVal)}>
            加注 <span className="btn-amount">${raiseVal.toLocaleString()}</span>
          </button>
        </div>

        <button className="btn btn-allin" onClick={() => act('allin')}>
          全押 <span className="btn-amount">${(me.chips + me.bet).toLocaleString()}</span>
        </button>
      </div>
    </div>
  );
}
