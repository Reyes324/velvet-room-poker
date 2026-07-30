import { useRef, useState } from 'react';

// Vertical drag slider for fine-tuning the raise amount — replaces the old
// horizontal −/+ stepper (user feedback, 2026-07-31): that stepper's "+"
// button sat right next to "确认加注" in the same row, and a slip while
// nudging the amount could land on "确认加注" instead, committing a raise by
// accident. A vertical slider on its own side column has no shared edge
// with any confirm button at all — physically can't misfire into one.
// Dragging anywhere on the track jumps straight to that position (common
// slider convention); the two arrow caps nudge by exactly one `step` for
// precise single increments.
function VerticalSlider({ min, max, step, value, onChange }) {
  const trackRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const range = Math.max(1, max - min);
  const frac = Math.min(1, Math.max(0, (value - min) / range));

  function valueFromClientY(clientY) {
    const rect = trackRef.current.getBoundingClientRect();
    // Track fills bottom-up (higher on screen = more money), matching the
    // physical mental model of a volume/temperature slider.
    const f = 1 - Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    const raw = min + f * (max - min);
    return Math.min(max, Math.max(min, Math.round(raw / step) * step));
  }

  function handlePointerDown(e) {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    onChange(valueFromClientY(e.clientY));
  }
  function handlePointerMove(e) {
    if (!dragging) return; // plain hover (no press yet) must not move the value
    onChange(valueFromClientY(e.clientY));
  }
  function endDrag() { setDragging(false); }

  return (
    <div className="raise-vslider">
      <div className="vslider-arrow" onClick={() => onChange(Math.min(max, value + step))}>▲</div>
      <div
        className="vslider-track"
        ref={trackRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="vslider-fill" style={{ height: `${frac * 100}%` }} />
        <div className="vslider-thumb" style={{ bottom: `${frac * 100}%` }} />
      </div>
      <div className="vslider-arrow" onClick={() => onChange(Math.max(min, value - step))}>▼</div>
    </div>
  );
}

// Progressive disclosure: default 3 buttons (fold / call|check / raise▸);
// tapping raise expands a sizing panel. Styled by shared velvet.css.
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
  // bigBlind used to read as undefined here — GameEngine never actually put
  // it in getPublicState's return value, so this always silently fell back
  // to the literal 20. Wired through for real now (see GameEngine.js).
  const bigBlind = gameState.bigBlind || 20;
  // minRaise approximates the engine's own currentBet+lastRaiseAmount rule
  // (exact for every case that matters here — see raise()'s server-side
  // validation, which is the actual authority) — this has to stay pegged to
  // a full big blind, not the slider's finer granularity below, or a
  // client-side "minimum" raise the slider lets you confirm would get
  // rejected by the server as under the real minimum.
  const minRaise = Math.max(gameState.currentBet * 2, gameState.currentBet + bigBlind) || bigBlind;
  // 用户反馈（2026-07-31）：微调粒度按大盲（¥20）一档太粗，改成半个大盲
  // （=小盲，¥10）——只影响滑动条/箭头这个手动微调的 granularity，不影响
  // 上面的合法最小加注额度。
  const step = Math.max(1, Math.round(bigBlind / 2));
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
          <div className="raise-panel-row">
            <div className="raise-panel-left">
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
              <div className="raise-amount">¥{amt.toLocaleString()}</div>
            </div>
            <VerticalSlider min={minRaise} max={maxRaise} step={step} value={amt} onChange={setAmount} />
          </div>
          <div className="raise-bottom">
            <button className="btn b-cancel b-h46" onClick={() => setOpen(false)}>← 返回</button>
            <button className="btn b-allin b-h46" onClick={() => act('raise', maxRaise)}>全下 ALL IN</button>
            <button className="btn b-confirm-raise b-h46" onClick={() => act('raise', amt)}>确认加注 ¥{amt.toLocaleString()}</button>
          </div>
        </div>
      )}
    </div>
  );
}
