// Pot — bare focal number on the felt (styled by shared velvet.css: .pot/.pot-amt)
// burst: true briefly flares the pot amount (used on showdown)
// handNameLabel: the winner's short hand name ("三条") — replaces the "底池"
// label in the same slot rather than adding a new line, so a real showdown
// doesn't grow Pot's own height and shift the community strip below it (see
// GameTable's TOP_ZONE/BOTTOM_ZONE, which depend on that position staying
// fixed regardless of showdown state).
// 阶段文字（"翻牌前"/"翻牌圈"...）曾经显示在这上面，用户反馈是废话、白占
// 空间（2026-08-11）——当前是哪个阶段本来就能从桌面上有几张公共牌直接看
// 出来，不需要额外用文字重复一遍。
export default function Pot({ amount, burst = false, handNameLabel = null }) {
  return (
    <div className={`pot${burst ? ' pot-burst' : ''}`}>
      <div className={`pot-label${handNameLabel ? ' pot-label--hand' : ''}`}>{handNameLabel || '底池'}</div>
      <div className="pot-amt">¥{Number(amount).toLocaleString()}</div>
    </div>
  );
}
