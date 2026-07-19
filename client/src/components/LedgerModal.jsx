// 玩家 / 初始筹码 / 已借入 / 当前筹码 — reads straight off roomState.players
// (already carries chips/debt) plus the server-supplied startingChips
// constant. Openable any time from the ≡ menu, in the lobby or mid-game.
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
          </div>
          {players.map(p => (
            <div key={p.id} className={`ledger-row${p.id === myId ? ' hero' : ''}`}>
              <div className="ledger-name">{p.name}{p.id === myId ? '（我）' : ''}</div>
              <div className="ledger-cell">¥{startingChips.toLocaleString()}</div>
              <div className="ledger-cell ledger-cell--debt">{p.debt > 0 ? `¥${p.debt.toLocaleString()}` : '—'}</div>
              <div className="ledger-cell">¥{p.chips.toLocaleString()}</div>
            </div>
          ))}
        </div>
        <div className="ledger-note">牌局进行中显示的是上一手结束时同步的筹码，不含本手实时下注变动</div>
        <div className="modal-btn" onClick={onClose}>关闭</div>
      </div>
    </div>
  );
}
