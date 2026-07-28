import { useState } from 'react';

// Progressive disclosure: default 3 buttons (fold / call|check / raise▸);
// tapping raise expands a stepper panel. Styled by shared velvet.css.
export default function ActionBar({ gameState, myId, onAction, disabled }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(null);

  const me = gameState?.players.find(p => p.id === myId);
  if (!gameState || gameState.actionPlayerId !== myId || disabled || !me) return null;

  const toCall = Math.max(0, gameState.currentBet - me.bet);
  // What I'll actually put in if I call — never the raw toCall when it
  // exceeds my own stack (call() already clamps this server-side; the
  // button used to just show the unclamped number, reading like "跟注
  // ¥1000" when the player only has ¥20 left — user feedback, 2026-07-28).
  const callAmount = Math.min(toCall, me.chips);
  const canCheck = toCall === 0;
  const step = gameState.bigBlind || 20;
  const minRaise = Math.max(gameState.currentBet * 2, gameState.currentBet + step) || step;
  // Capped not just by my own stack but by the deepest stack any other
  // still-live opponent could ever match — user feedback (2026-07-28):
  // shoving more than literally anyone at the table could call always just
  // comes back via the side-pot refund anyway (see GameEngine._endHand),
  // so offering it as a selectable amount only invites the exact "why did
  // it look like I bet 1000 when only 95 of it was ever real" confusion
  // that prompted that fix. p.chips+p.bet is each opponent's own ceiling
  // this street (same formula the engine itself uses for maxTotal), so an
  // opponent who's already all-in for less is naturally included at their
  // own already-fixed ceiling, not excluded.
  const liveOpponents = gameState.players.filter(p => p.id !== myId && p.status !== 'folded');
  const opponentCeiling = liveOpponents.length > 0
    ? Math.max(...liveOpponents.map(p => p.chips + p.bet))
    : Infinity; // no live opponent to matter — fall back to just my own stack
  const maxRaise = Math.min(me.chips + me.bet, opponentCeiling);
  const amt = Math.min(maxRaise, Math.max(minRaise, amount ?? minRaise));

  // Pot-fraction quick sizing: raise TO (call + a fraction of the pot as it
  // stands), clamped into the legal [minRaise, maxRaise] range. A preset
  // whose raw (pre-clamp) value falls outside that range doesn't actually
  // represent its own fraction anymore — it silently collapses to whatever
  // it got clamped to, which can coincide with a neighboring preset's value
  // (e.g. pot is small enough that both "1/3 池" and "半池" clamp up to the
  // same minRaise). `clamped` flags that case so the UI can show it as
  // unavailable instead of letting two buttons look identically "picked".
  const potPresets = [
    { label: '1/3 池', frac: 1 / 3 },
    { label: '半池', frac: 1 / 2 },
    { label: '2/3 池', frac: 2 / 3 },
    { label: '满池', frac: 1 },
    { label: '2倍超池', frac: 2 },
  ].map(p => {
    const raw = me.bet + toCall + Math.round(gameState.pot * p.frac);
    const value = Math.min(maxRaise, Math.max(minRaise, raw));
    return { ...p, value, clamped: value !== raw };
  });

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
          <div className="preset-row">
            {potPresets.map(p => (
              <div
                key={p.label}
                className={`preset-btn${p.clamped ? ' is-clamped' : (amt === p.value ? ' is-picked' : '')}`}
                onClick={() => setAmount(p.value)}
              >
                {p.label}
              </div>
            ))}
          </div>
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
