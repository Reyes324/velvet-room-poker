import { useState } from 'react';

const AV = ['av-green', 'av-purple', 'av-teal', 'av-rust', 'av-olive', 'av-blue', 'av-magenta', 'av-gold'];
function colorForId(id) {
  let h = 0;
  for (const ch of String(id)) h = (h + ch.charCodeAt(0)) % 8;
  return h;
}

// Lobby / waiting room — styled by shared velvet.css (.lobby/.room-code/.pl-row/...)
const TIMER_OPTIONS = [15, 30, 60];

export default function Lobby({ roomState, playerId, onCopy, onKick, onStart, onRestart, onRebuy, onExit, onOpenLedger, onOpenHandHistory, copied, maxSeats = 9 }) {
  const [showExit, setShowExit] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [rebuying, setRebuying] = useState(false);
  const [showTimerPicker, setShowTimerPicker] = useState(false);
  const [showRestartConfirm, setShowRestartConfirm] = useState(false);
  // Players who've left (voluntarily, kicked, or timed out) stay in
  // roomState.players so their final numbers survive in 账本 — but the
  // lobby's own seat list, open-seat count, and start-game eligibility
  // should only ever reflect who's actually still here.
  const allPlayers = roomState?.players ?? [];
  const players = allPlayers.filter(p => !p.left);
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
            <div className="menu-row" onClick={() => { setShowMenu(false); onOpenHandHistory?.(); }}>牌局记录</div>
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
      {showRestartConfirm && (
        <div className="modal-overlay" onClick={() => setShowRestartConfirm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">重新开始</div>
            <div className="modal-body">所有人的筹码将重置为初始值，借款和牌局记录也会清空。确定要重新开始吗？</div>
            <div className="modal-btns">
              <div className="modal-btn-cancel" onClick={() => setShowRestartConfirm(false)}>取消</div>
              <div className="modal-btn-danger" onClick={() => { setShowRestartConfirm(false); onRestart(); }}>重新开始</div>
            </div>
          </div>
        </div>
      )}
      {/* "开始游戏"（不限时）和"计时游戏"原来是两个入口——用户反馈
          （2026-08-13）想合并成一个，点"开始游戏"统一先弹这个选择器。
          弹窗内部分两组，不是四个平铺的按钮：第一组"选时间"标签 +
          15/30/60 分钟（对应原来的"计时游戏"，onStart(min)）；"直接开始"
          （对应原来的"开始游戏"，onStart() 不传参）单独放在"取消"下面、
          整个弹窗最底部——用户反馈这样最顺手点到的位置应该留给最常用的
          "直接开始"，"取消"放在它上面而不是最下面。 */}
      {showTimerPicker && (
        <div className="modal-overlay" onClick={() => setShowTimerPicker(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">开始游戏</div>
            <div className="modal-body">直接开始可以随时手动结束；选个时长，时间到会提醒房主决定是否结束</div>
            <div className="timer-picker-options">
              <div className="timer-picker-group-label">选时间</div>
              {TIMER_OPTIONS.map(min => (
                <div
                  key={min}
                  className="timer-picker-option"
                  onClick={() => { setShowTimerPicker(false); onStart?.(min); }}
                >
                  {min < 60 ? `${min} 分钟` : `${min / 60} 小时`}
                </div>
              ))}
            </div>
            <div className="modal-btn-cancel" style={{ width: '100%' }} onClick={() => setShowTimerPicker(false)}>取消</div>
            {/* .modal 的 align-items:center 会让直接子节点按内容宽度收缩，
                跟上面 .timer-picker-options 里那几个撑满宽度的按钮不一致——
                "取消"本来就靠内联 style 撑宽度，这里跟着补上同一个，不然
                "直接开始"会看起来比其它按钮窄一圈。 */}
            <div
              className="timer-picker-option timer-picker-option--untimed"
              style={{ width: '100%' }}
              onClick={() => { setShowTimerPicker(false); onStart?.(); }}
            >
              直接开始
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
                <div className="pr-name">
                {p.name}{p.id === playerId ? '（我）' : ''}
                {p.connected === false && <span style={{ color: '#B08A3A' }}>（断线中）</span>}
              </div>
                <div className="pr-chips">
                  {p.chips === 0 ? <span style={{ color: '#E08A4A' }}>¥0 · 筹码不足</span> : `¥${p.chips.toLocaleString()}`}
                </div>
              </div>
              {roomState.hostId === p.id && <span className="pr-badge">房主</span>}
              {p.debt > 0 && <span className="pr-badge debt-badge">借¥{p.debt.toLocaleString()}</span>}
              {p.id === playerId && p.chips === 0 && onRebuy && (
                <span
                  className="pr-badge pr-badge--action"
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
                <span className="pr-badge pr-badge--action" style={{ cursor: 'pointer', color: '#E08080', background: 'rgba(192,57,43,.15)' }} onClick={() => onKick(p.id)}>移出</span>
              )}
            </div>
          ))}

          {Array.from({ length: empty }).map((_, i) => (
            <div key={i} className="empty-slot"><div className="es-dot">+</div><div className="es-txt">等待玩家加入…</div></div>
          ))}
        </div>

        {isHost ? (
          <div className="lobby-footer">
            {/* 原来"开始游戏"（不限时，直接 onStart()）和"计时游戏"（弹
                时长选择器）是两个并排按钮，合并成一个入口：点击统一弹
                上面那个选择器，"不限时"是选择器里的第一个选项——不再有
                直接调 onStart() 的路径留在这里了。 */}
            <div className="lobby-btn" onClick={canStart ? () => setShowTimerPicker(true) : undefined} style={!canStart ? { opacity: .5, cursor: 'default' } : undefined}>
              {canStart ? '开始游戏' : '等待更多玩家…'}
            </div>
            <div className="lobby-restart" onClick={() => setShowRestartConfirm(true)}>重新开始</div>
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
