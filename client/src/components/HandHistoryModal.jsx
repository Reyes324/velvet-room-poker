import { useState, useRef, useEffect, useCallback } from 'react';
import Card from './Card';

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

// Result-only per-hand log ("牌局记录") — community cards, who won what,
// how (摊牌 vs 弃牌获胜), and each player's net for that hand. Deliberately
// not a full action-by-action replay (out of scope per user request).
// `hands` (fetched via room:get-hand-history) is already personalized
// server-side per viewer: `reveals` always includes MY own hole cards for
// any hand I was dealt into (win/lose, showdown/fold — same "own cards
// always visible" rule the live table uses), plus whichever OTHER players'
// cards were made public (real showdown contenders, or a fold-win winner
// who opted into 亮牌炫耀). Never anyone else's hidden cards.
//
// Full-screen side panel, not a centered modal — a night's session can run
// to dozens of hands, and the previous small centered .modal (shared with
// 账本's much shorter single-screen table) read as cramped once there was
// real content to scroll through (user feedback). Slides in from the right
// like a stacked page, not a popover.
//
// Left rail + content are two INDEPENDENTLY scrollable panes, linked both
// ways (per user request, referencing a hand-replay tool they'd seen):
// tapping a rail number scrolls the content pane to that hand; scrolling
// the content pane highlights the matching rail number (via
// IntersectionObserver, not a scroll-position calculation) and keeps that
// rail button in view.
export default function HandHistoryModal({ hands, myId, onClose }) {
  const sorted = [...hands].sort((a, b) => b.handNumber - a.handNumber);
  const [expanded, setExpanded] = useState(null);
  const [activeHand, setActiveHand] = useState(null);

  const contentRef = useRef(null);
  const rowRefs = useRef(new Map());
  const railRefs = useRef(new Map());
  const hasDefaultedRef = useRef(false);

  // Default to the most recent hand open (sorted[0] — "most recent" since
  // the list sorts newest-first, NOT literally hand #1) — whoever opens
  // this right after a hand wraps up almost always wants to see that hand
  // first, not an empty collapsed list they have to tap into. Can't do
  // this as a useState initializer: the panel mounts immediately with
  // `hands=[]` (the real data arrives a moment later over the socket as a
  // prop update on the SAME mounted instance), and a useState initializer
  // only ever runs on that first, still-empty render — it never re-fires
  // just because the prop changed afterward.
  useEffect(() => {
    if (!hasDefaultedRef.current && hands.length > 0) {
      const newest = [...hands].sort((a, b) => b.handNumber - a.handNumber)[0];
      setExpanded(newest.handNumber);
      hasDefaultedRef.current = true;
    }
  }, [hands]);

  const setRowRef = useCallback((handNumber, el) => {
    if (el) rowRefs.current.set(handNumber, el);
    else rowRefs.current.delete(handNumber);
  }, []);
  const setRailRef = useCallback((handNumber, el) => {
    if (el) railRefs.current.set(handNumber, el);
    else railRefs.current.delete(handNumber);
  }, []);

  // Scrollspy: whichever hand row currently sits at the top of the content
  // viewport becomes "active". rootMargin collapses the observation band to
  // a thin strip near the top instead of the whole viewport, so the active
  // hand changes right as it reaches the top rather than whenever any part
  // of it is merely still visible.
  useEffect(() => {
    const root = contentRef.current;
    if (!root || sorted.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter(e => e.isIntersecting);
        if (visible.length === 0) return;
        // DOM order among sorted rows follows sorted (newest-first) order —
        // the first visible entry in that order is the topmost on screen.
        const topMost = visible.reduce((a, b) => (
          a.boundingClientRect.top <= b.boundingClientRect.top ? a : b
        ));
        const handNumber = Number(topMost.target.dataset.handNumber);
        setActiveHand(handNumber);
      },
      { root, rootMargin: '0px 0px -80% 0px', threshold: 0 }
    );
    for (const el of rowRefs.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [sorted.length]);

  // Keep the active rail button in view as the content scroll changes it —
  // 'nearest' so it only scrolls the rail when the active button actually
  // falls outside the visible strip, not on every single change.
  useEffect(() => {
    if (activeHand == null) return;
    railRefs.current.get(activeHand)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeHand]);

  function jumpTo(handNumber) {
    rowRefs.current.get(handNumber)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    setExpanded(handNumber);
  }

  return (
    <div className="hh-panel-overlay" onClick={onClose}>
      <div className="hh-panel" onClick={e => e.stopPropagation()}>
        <div className="hh-panel-header">
          <div className="hh-panel-back" onClick={onClose}>‹</div>
          <div className="hh-panel-title">牌局记录</div>
          <div className="hh-panel-count">{sorted.length > 0 ? `共 ${sorted.length} 手` : ''}</div>
        </div>
        {sorted.length === 0 ? (
          <div className="hh-empty">还没有打完的牌局</div>
        ) : (
          <div className="hh-panel-body">
            <div className="hh-rail">
              {sorted.map(h => (
                <div
                  key={h.handNumber}
                  ref={el => setRailRef(h.handNumber, el)}
                  className={`hh-rail-num${activeHand === h.handNumber ? ' hh-rail-num--active' : ''}`}
                  onClick={() => jumpTo(h.handNumber)}
                >
                  {h.handNumber}
                </div>
              ))}
            </div>
            <div className="hh-content" ref={contentRef}>
              <div className="hh-list">
                {sorted.map(h => {
                  const isOpen = expanded === h.handNumber;
                  const revealMap = Object.fromEntries((h.reveals ?? []).map(r => [r.id, r.holeCards]));
                  // Real showdowns have an actual hand type to show off ("两对，
                  // 对9和对5") — a fold-win's handName is just the "其他人全部
                  // 弃牌" placeholder text, already covered by the 弃牌获胜 tag,
                  // so only surface this for real showdowns.
                  const handNameMap = h.foldWin ? {} : Object.fromEntries(h.winners.map(w => [w.id, w.handName]));
                  return (
                    <div
                      key={h.handNumber}
                      ref={el => setRowRef(h.handNumber, el)}
                      data-hand-number={h.handNumber}
                      className={`hh-hand${isOpen ? ' hh-hand--open' : ''}`}
                    >
                      <div className="hh-hand-row" onClick={() => setExpanded(isOpen ? null : h.handNumber)}>
                        <div className="hh-hand-num">
                          第 {h.handNumber} 手
                          <span className="hh-hand-time">{formatTime(h.timestamp)}</span>
                        </div>
                        <div className="hh-hand-summary">
                          {h.winners.map(w => w.name).join('、')}
                          <span className="hh-hand-amt"> +¥{h.winners.reduce((s, w) => s + w.won, 0).toLocaleString()}</span>
                        </div>
                        <div className={`hh-hand-tag${h.foldWin ? ' hh-hand-tag--foldwin' : ''}`}>
                          {h.foldWin ? '弃牌获胜' : '摊牌'}
                        </div>
                        <div className="hh-hand-chevron">⌄</div>
                      </div>
                      {isOpen && (
                        <div className="hh-hand-detail">
                          {h.communityCards.length > 0 && (
                            <div className="hh-community">
                              {h.communityCards.map((c, i) => <Card key={i} card={c} size="sm" />)}
                            </div>
                          )}
                          <div className="hh-players">
                            {h.settle.map(s => {
                              const cards = revealMap[s.id];
                              const handName = handNameMap[s.id];
                              return (
                                <div key={s.id} className="hh-player-row">
                                  <div className="hh-player-name">
                                    {s.name}{s.id === myId ? '（我）' : ''}
                                    {s.status === 'folded' && !cards && <span className="hh-folded-tag">弃牌</span>}
                                    {handName && <span className="hh-hand-type">{handName}</span>}
                                  </div>
                                  {cards && (
                                    <div className="hh-player-cards">
                                      {cards.map((c, i) => <Card key={i} card={c} size="sm" />)}
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
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
