import { useState } from 'react';

const AV = ['av-green', 'av-purple', 'av-teal', 'av-rust', 'av-olive', 'av-blue', 'av-magenta', 'av-gold'];
function colorForId(id) {
  let h = 0;
  for (const ch of String(id)) h = (h + ch.charCodeAt(0)) % 8;
  return h;
}

// Lobby / waiting room — styled by shared velvet.css (.lobby/.room-code/.pl-row/...)
export default function Lobby({ roomState, playerId, onCopy, onKick, onStart, onRestart, onRebuy, onExit, onOpenLedger, copied, maxSeats = 9 }) {
  const [showExit, setShowExit] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [rebuying, setRebuying] = useState(false);
  const players = roomState?.players ?? [];
  const isHost = roomState?.hostId === playerId;
  const me = players.find(p => p.id === playerId);
  const canStart = players.filter(p => p.chips > 0).length >= 2;
  const empty = Math.max(0, Math.min(maxSeats, 6) - players.length);

  function handleRebuy() {
    if (rebuying) return;
    setRebuying(true);
    onRebuy();
    setTimeout(() => setRebuying(false), 3000); // safety-net reset if room:state never arrives
  }

  return (
    <div className="game-stage">
      <div className="top-bar">
        <div className="menu-btn" onClick={() => setShowMenu(true)}>≡</div>
        <div className="bankroll">¥{(me?.chips ?? 0).toLocaleString()}</div>
      </div>
      {showMenu && (
        <div className="modal-overlay" onClick={() => setShowMenu(false)}>
          <div className="modal menu-popover" onClick={e => e.stopPropagation()}>
            <div className="menu-row" onClick={() => { setShowMenu(false); onOpenLedger?.(); }}>账本</div>
            <div className="menu-row menu-row--danger" onClick={() => { setShowMenu(false); setShowExit(true); }}>退出房间</div>
          </div>
        </div>
      )}
      {showExit && (
        <div className="modal-overlay" onClick={() => setShowExit(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">退出房间</div>
            <div className="modal-body">确定要退出当前房间吗？</div>
            <div className="modal-btns">
              <div className="modal-btn-cancel" onClick={() => setShowExit(false)}>取消</div>
              <div className="modal-btn-danger" onClick={onExit}>退出</div>
            </div>
          </div>
        </div>
      )}

      <div className="lobby">
        <div className="lobby-head">
          <div>
            <div className="lobby-room-name">翡翠桌</div>
            <div className="lobby-blind">BLIND ¥10 / ¥20</div>
          </div>
          <div className="room-code" onClick={onCopy} title="点击复制邀请链接">{roomState?.code ?? ''}</div>
        </div>

        <div className="share-invite-btn" onClick={onCopy}>
          <span className="share-icon">🔗</span>
          <span>{copied ? '链接已复制 ✓' : '复制邀请链接，分享给好友'}</span>
        </div>

        <div className="lobby-sec">玩家 {players.length} / {maxSeats}</div>

        <div className="lobby-scroll">
          {players.map(p => (
            <div key={p.id} className="pl-row">
              <div className={`pr-av ${p.id === playerId ? 'av-gold' : AV[colorForId(p.id)]}`}>{p.name[0].toUpperCase()}</div>
              <div className="pr-info">
                <div className="pr-name">{p.name}{p.id === playerId ? '（我）' : ''}</div>
                <div className="pr-chips">
                  {p.chips === 0 ? <span style={{ color: '#E08A4A' }}>¥0 · 筹码不足</span> : `¥${p.chips.toLocaleString()}`}
                </div>
              </div>
              {roomState.hostId === p.id && <span className="pr-badge">房主</span>}
              {p.debt > 0 && <span className="pr-badge debt-badge">借¥{p.debt.toLocaleString()}</span>}
              {p.id === playerId && p.chips === 0 && onRebuy && (
                <span
                  className="pr-badge"
                  style={{
                    cursor: rebuying ? 'default' : 'pointer',
                    opacity: rebuying ? .5 : 1,
                    color: '#E8C24A', background: 'rgba(212,175,55,.12)', border: '1px solid rgba(212,175,55,.3)',
                  }}
                  onClick={handleRebuy}
                >
                  +借一底
                </span>
              )}
              {isHost && p.id !== playerId && (
                <span className="pr-badge" style={{ cursor: 'pointer', color: '#E08080', background: 'rgba(192,57,43,.15)' }} onClick={() => onKick(p.id)}>移出</span>
              )}
            </div>
          ))}

          {Array.from({ length: empty }).map((_, i) => (
            <div key={i} className="empty-slot"><div className="es-dot">+</div><div className="es-txt">等待玩家加入…</div></div>
          ))}
        </div>

        {isHost ? (
          <div className="lobby-footer">
            <div className="lobby-btn" onClick={canStart ? onStart : undefined} style={!canStart ? { opacity: .5, cursor: 'default' } : undefined}>
              {canStart ? '开始游戏' : '等待更多玩家…'}
            </div>
            <div className="lobby-restart" onClick={onRestart}>重新开始</div>
          </div>
        ) : (
          <div className="lobby-footer">
            <div className="lobby-restart" style={{ color: '#2A4A2C', cursor: 'default' }}>等待房主开始游戏…</div>
          </div>
        )}
      </div>
    </div>
  );
}
