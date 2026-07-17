import { useState } from 'react';

// Progressive disclosure: default 3 buttons (fold / call|check / raise▸);
// tapping raise expands a stepper panel. Styled by shared velvet.css.
export default function ActionBar({ gameState, myId, onAction, disabled }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(null);

  const me = gameState?.players.find(p => p.id === myId);
  if (!gameState || gameState.actionPlayerId !== myId || disabled || !me) return null;

  const toCall = Math.max(0, gameState.currentBet - me.bet);
  const canCheck = toCall === 0;
  const step = gameState.bigBlind || 20;
  const minRaise = Math.max(gameState.currentBet * 2, gameState.currentBet + step) || step;
  const maxRaise = me.chips + me.bet;
  const amt = Math.min(maxRaise, Math.max(minRaise, amount ?? minRaise));

  function openRaise() { setAmount(minRaise); setOpen(true); }
  function adj(d) { setAmount(a => Math.min(maxRaise, Math.max(minRaise, (a ?? minRaise) + d))); }
  function act(action, val) { onAction(action, val); setOpen(false); setAmount(null); }

  return (
    <div className="action-bar">
      {!open ? (
        <div className="ab-main">
          <button className="btn b-fold b-h52" onClick={() => act('fold')}>弃牌</button>
          {canCheck
            ? <button className="btn b-check b-h52" onClick={() => act('check')}>过牌</button>
            : <button className="btn b-call b-h52" onClick={() => act('call')}>跟注 ¥{toCall.toLocaleString()}</button>}
          <button className="btn b-raise-trigger b-h52" onClick={openRaise}>加注 ▸</button>
        </div>
      ) : (
        <div className="ab-raise open">
          <div className="stepper-row">
            <div className="stepper">
              <div className="step-btn" onClick={() => adj(-step)}>−</div>
              <div className="step-val">¥{amt.toLocaleString()}</div>
              <div className="step-btn" onClick={() => adj(step)}>+</div>
            </div>
            <button className="btn b-confirm-raise b-h46" onClick={() => act('raise', amt)}>确认加注</button>
          </div>
          <div className="raise-bottom">
            <button className="btn b-cancel b-h46" onClick={() => setOpen(false)}>← 返回</button>
            <button className="btn b-allin b-h46" style={{ flex: 1 }} onClick={() => act('raise', maxRaise)}>全下 ALL IN</button>
            <button className="btn b-fold b-h46" style={{ flex: 1 }} onClick={() => act('fold')}>弃牌</button>
          </div>
        </div>
      )}
    </div>
  );
}
