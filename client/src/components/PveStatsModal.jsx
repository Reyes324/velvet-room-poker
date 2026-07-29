// PVE 战绩面板（用户反馈"AI 经常能赢"后新增，2026-07-30）——用现成的
// handHistory + ledger 数据算一份简单统计，不需要额外的服务端接口：总局
// 数、净输赢（跟账本同一套 net 算法）、胜/负局数，以及"我在哪条街最常弃
// 牌"的分布（用 communityCards.length 反推弃牌发生在 preflop/flop/turn/
// river 的哪一条街）——这是"AI 到底在哪赢我"最直接的一个信号，比单纯的
// 胜率数字更有诊断价值。
const STREET_LABELS = { preflop: '翻前', flop: '翻牌', turn: '转牌', river: '河牌' };

function computeStats(hands, myId) {
  let wins = 0, losses = 0;
  const foldStreetCounts = { preflop: 0, flop: 0, turn: 0, river: 0 };
  for (const h of hands) {
    const mine = h.settle.find(s => s.id === myId);
    if (!mine) continue;
    if (mine.net > 0) wins += 1;
    else if (mine.net < 0) losses += 1;
    if (mine.status === 'folded') {
      const n = h.communityCards.length;
      const street = n === 0 ? 'preflop' : n === 3 ? 'flop' : n === 4 ? 'turn' : 'river';
      foldStreetCounts[street] += 1;
    }
  }
  return { total: hands.length, wins, losses, foldStreetCounts };
}

export default function PveStatsModal({ hands, myId, ledgerEntry, startingChips, onClose }) {
  const { total, wins, losses, foldStreetCounts } = computeStats(hands, myId);
  const net = ledgerEntry ? ledgerEntry.chips - startingChips - (ledgerEntry.debt || 0) : 0;
  const maxFoldCount = Math.max(1, ...Object.values(foldStreetCounts));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal stats-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-title">战绩</div>
        {total === 0 ? (
          <div className="hh-empty">还没有打完的牌局</div>
        ) : (
          <>
            <div className="stats-summary">
              <div className="stats-summary-item">
                <div className="stats-summary-label">总局数</div>
                <div className="stats-summary-value">{total}</div>
              </div>
              <div className="stats-summary-item">
                <div className="stats-summary-label">胜 / 负</div>
                <div className="stats-summary-value">{wins} / {losses}</div>
              </div>
              <div className="stats-summary-item">
                <div className={`stats-summary-value ${net === 0 ? 'net-neutral' : net > 0 ? 'net-win' : 'net-lose'}`}>
                  {net === 0 ? '¥0' : (net > 0 ? '+¥' : '−¥') + Math.abs(net).toLocaleString()}
                </div>
                <div className="stats-summary-label">净输赢</div>
              </div>
            </div>
            <div className="stats-section-title">我在哪条街最常弃牌</div>
            <div className="stats-fold-bars">
              {Object.entries(foldStreetCounts).map(([street, count]) => (
                <div key={street} className="stats-fold-row">
                  <div className="stats-fold-label">{STREET_LABELS[street]}</div>
                  <div className="stats-fold-bar-track">
                    <div className="stats-fold-bar-fill" style={{ width: `${(count / maxFoldCount) * 100}%` }} />
                  </div>
                  <div className="stats-fold-count">{count}</div>
                </div>
              ))}
            </div>
          </>
        )}
        <div className="modal-btn" onClick={onClose}>关闭</div>
      </div>
    </div>
  );
}
