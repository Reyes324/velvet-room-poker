// 玩家 / 初始筹码 / 已借入 / 当前筹码 / 盈亏 — reads straight off roomState.players
// (already carries chips/debt/left) plus the server-supplied startingChips
// constant. "盈亏" = 当前 − 初始 − 已借（借来的筹码不算赢的，要扣掉才是真实净输赢）.
// Openable any time from the ≡ menu, in the lobby or mid-game. Players who
// left mid-session still show up here (server keeps their row, just marked
// `left`, specifically so this final number doesn't disappear the moment
// someone steps away — that used to happen when leaving deleted the row
// outright).
export default function LedgerModal({ players, startingChips, myId, onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal ledger-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-title">账本</div>
        <div className="ledger-table">
          <div className="ledger-head-row">
            <div>玩家</div>
            <div className="ledger-cell">初始</div>
            <div className="ledger-cell">已借</div>
            <div className="ledger-cell">当前</div>
            <div className="ledger-cell">盈亏</div>
          </div>
          {players.map(p => {
            const net = p.chips - startingChips - (p.debt || 0);
            return (
              <div key={p.id} className={`ledger-row${p.id === myId ? ' hero' : ''}`}>
                <div className="ledger-name">
                  {p.name}{p.id === myId ? '（我）' : ''}
                  {p.left && <span className="ledger-left-tag">已离开</span>}
                </div>
                <div className="ledger-cell">¥{startingChips.toLocaleString()}</div>
                <div className="ledger-cell ledger-cell--debt">{p.debt > 0 ? `¥${p.debt.toLocaleString()}` : '—'}</div>
                <div className="ledger-cell">¥{p.chips.toLocaleString()}</div>
                <div className={`ledger-cell ledger-cell--net ${net === 0 ? 'net-neutral' : net > 0 ? 'net-win' : 'net-lose'}`}>
                  {net === 0 ? '¥0' : (net > 0 ? '+¥' : '−¥') + Math.abs(net).toLocaleString()}
                </div>
              </div>
            );
          })}
        </div>
        <div className="ledger-note">"盈亏" = 当前 − 初始 − 已借，牌局进行中显示的是上一手结束时同步的筹码，不含本手实时下注变动</div>
        <div className="modal-btn" onClick={onClose}>关闭</div>
      </div>
    </div>
  );
}
