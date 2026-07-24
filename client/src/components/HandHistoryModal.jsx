import { useState } from 'react';
import Card from './Card';

// Result-only per-hand log ("牌局记录") — community cards, who won what,
// how (摊牌 vs 弃牌获胜), and each player's net for that hand. Deliberately
// not a full action-by-action replay (out of scope per user request).
// Card visibility mirrors the live game's own rule instead of a new one:
// a real showdown already revealed every non-folded player's cards to the
// whole table, so those are always in `reveals`; a fold-win only carries
// cards if the winner later opted into 亮牌炫耀 — until then `reveals` is
// empty and this hand shows no cards at all, same as nobody could see them
// live either.
export default function HandHistoryModal({ hands, myId, onClose }) {
  const [expanded, setExpanded] = useState(null);
  const sorted = [...hands].sort((a, b) => b.handNumber - a.handNumber);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal hand-history-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-title">牌局记录</div>
        {sorted.length === 0 ? (
          <div className="hh-empty">还没有打完的牌局</div>
        ) : (
          <div className="hh-list">
            {sorted.map(h => {
              const isOpen = expanded === h.handNumber;
              const revealMap = Object.fromEntries((h.reveals ?? []).map(r => [r.id, r.holeCards]));
              return (
                <div key={h.handNumber} className="hh-hand">
                  <div className="hh-hand-row" onClick={() => setExpanded(isOpen ? null : h.handNumber)}>
                    <div className="hh-hand-num">第 {h.handNumber} 手</div>
                    <div className="hh-hand-summary">
                      {h.winners.map(w => w.name).join('、')}
                      <span className="hh-hand-amt"> +¥{h.winners.reduce((s, w) => s + w.won, 0).toLocaleString()}</span>
                    </div>
                    <div className={`hh-hand-tag${h.foldWin ? ' hh-hand-tag--foldwin' : ''}`}>
                      {h.foldWin ? '弃牌获胜' : '摊牌'}
                    </div>
                  </div>
                  {isOpen && (
                    <div className="hh-hand-detail">
                      {h.communityCards.length > 0 && (
                        <div className="hh-community">
                          {h.communityCards.map((c, i) => <Card key={i} card={c} size="xs" />)}
                        </div>
                      )}
                      <div className="hh-players">
                        {h.settle.map(s => {
                          const cards = revealMap[s.id];
                          return (
                            <div key={s.id} className="hh-player-row">
                              <div className="hh-player-name">
                                {s.name}{s.id === myId ? '（我）' : ''}
                                {s.status === 'folded' && !cards && <span className="hh-folded-tag">弃牌</span>}
                              </div>
                              {cards && (
                                <div className="hh-player-cards">
                                  {cards.map((c, i) => <Card key={i} card={c} size="xs" />)}
                                </div>
                              )}
                              <div className={`hh-player-net ${s.net > 0 ? 'net-win' : s.net < 0 ? 'net-lose' : 'net-neutral'}`}>
                                {s.net === 0 ? '¥0' : (s.net > 0 ? '+¥' : '−¥') + Math.abs(s.net).toLocaleString()}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className="modal-btn" onClick={onClose}>关闭</div>
      </div>
    </div>
  );
}
