import { useState, useEffect } from 'react';

const AV = ['av-green', 'av-purple', 'av-teal', 'av-rust', 'av-olive', 'av-blue', 'av-magenta', 'av-gold'];
function colorForId(id) {
  let h = 0;
  for (const ch of String(id)) h = (h + ch.charCodeAt(0)) % 8;
  return h;
}
function amtText(delta) {
  if (delta == null) return '弃牌';
  return (delta > 0 ? '+¥' : '−¥') + Math.abs(delta).toLocaleString();
}

// Settlement modal — styled by shared velvet.css (.modal-*). Auto-closes after `seconds`.
export default function SettlementModal({ winner, results = [], onClose, seconds = 5 }) {
  const [t, setT] = useState(seconds);
  useEffect(() => {
    if (t <= 0) { onClose?.(); return; }
    const id = setTimeout(() => setT(t - 1), 1000);
    return () => clearTimeout(id);
  }, [t]);

  if (!winner) return null;
  const avClass = winner.isMe ? 'av-gold' : AV[colorForId(winner.id ?? winner.name)];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-title">✦ 本局结算</div>
        <div className={`modal-winner-av ${avClass}`}>{winner.name[0].toUpperCase()}</div>
        <div className="modal-winner-name" style={winner.isMe ? { color: '#D4AF37' } : undefined}>{winner.name}</div>
        <div className="modal-win-amt">+ ¥{Number(winner.amount).toLocaleString()}</div>
        {winner.hand && <div className="modal-hand">{winner.hand}</div>}
        <div className="modal-divider" />
        <div className="settle-list">
          {results.map((r, i) => (
            <div key={i} className={`settle-row${r.isMe ? ' hero' : ''}`}>
              <span className="sr-name">{r.name}</span>
              <span className={`sr-amt ${r.delta == null ? 'sr-neutral' : r.delta > 0 ? 'sr-win' : 'sr-lose'}`}>
                {amtText(r.delta)}
              </span>
            </div>
          ))}
        </div>
        <div className="modal-btn" onClick={onClose}>我知道了（<span className="cd">{t}</span>s）</div>
      </div>
    </div>
  );
}
