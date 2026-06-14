const AV = ['av-green', 'av-purple', 'av-teal', 'av-rust', 'av-olive', 'av-blue', 'av-magenta', 'av-gold'];
function colorForId(id) {
  let h = 0;
  for (const ch of String(id)) h = (h + ch.charCodeAt(0)) % 8;
  return h;
}

// Lobby / waiting room — styled by shared velvet.css (.lobby/.room-code/.pl-row/...)
export default function Lobby({ roomState, playerId, onCopy, onKick, onStart, onRestart, copied, maxSeats = 9 }) {
  const players = roomState?.players ?? [];
  const isHost = roomState?.hostId === playerId;
  const me = players.find(p => p.id === playerId);
  const canStart = players.length >= 2;
  const empty = Math.max(0, Math.min(maxSeats, 6) - players.length);

  return (
    <div className="game-stage">
      <div className="top-bar">
        <div className="menu-btn">≡</div>
        <div className="bankroll">¥{(me?.chips ?? 0).toLocaleString()}</div>
      </div>

      <div className="lobby">
        <div className="lobby-head">
          <div>
            <div className="lobby-room-name">翡翠桌</div>
            <div className="lobby-blind">BLIND ¥10 / ¥20</div>
          </div>
          <div className="room-code" onClick={onCopy} title="点击复制邀请链接">{roomState?.code ?? ''}</div>
        </div>

        <div className="lobby-sec">玩家 {players.length} / {maxSeats}{copied ? ' · 链接已复制 ✓' : ''}</div>

        {players.map(p => (
          <div key={p.id} className="pl-row">
            <div className={`pr-av ${p.id === playerId ? 'av-gold' : AV[colorForId(p.id)]}`}>{p.name[0].toUpperCase()}</div>
            <div className="pr-info">
              <div className="pr-name">{p.name}{p.id === playerId ? '（我）' : ''}</div>
              <div className="pr-chips">¥{p.chips.toLocaleString()}</div>
            </div>
            {roomState.hostId === p.id && <span className="pr-badge">房主</span>}
            {isHost && p.id !== playerId && (
              <span className="pr-badge" style={{ cursor: 'pointer', color: '#E08080', background: 'rgba(192,57,43,.15)' }} onClick={() => onKick(p.id)}>移出</span>
            )}
          </div>
        ))}

        {Array.from({ length: empty }).map((_, i) => (
          <div key={i} className="empty-slot"><div className="es-dot">+</div><div className="es-txt">等待玩家加入…</div></div>
        ))}

        {isHost ? (
          <>
            <div className="lobby-btn" onClick={canStart ? onStart : undefined} style={!canStart ? { opacity: .5, cursor: 'default' } : undefined}>
              {canStart ? '开始游戏' : '等待更多玩家…'}
            </div>
            <div className="lobby-sec" style={{ textAlign: 'center', border: 'none', margin: '8px 0 0', cursor: 'pointer', opacity: .7 }} onClick={onRestart}>重新开始</div>
          </>
        ) : (
          <div className="lobby-sec" style={{ textAlign: 'center', marginTop: 'auto', borderBottom: 'none' }}>等待房主开始游戏…</div>
        )}
      </div>
    </div>
  );
}
