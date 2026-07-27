// Pot — bare focal number on the felt (styled by shared velvet.css: .pot/.street-tag/.pot-amt)
// burst: true briefly flares the pot amount (used on showdown)
// handNameLabel: the winner's short hand name ("三条") — replaces the "底池"
// label in the same slot rather than adding a new line, so a real showdown
// doesn't grow Pot's own height and shift the community strip below it (see
// GameTable's TOP_ZONE/BOTTOM_ZONE, which depend on that position staying
// fixed regardless of showdown state).
export default function Pot({ street, amount, burst = false, handNameLabel = null }) {
  return (
    <div className={`pot${burst ? ' pot-burst' : ''}`}>
      {street && <div className="street-tag">{street}</div>}
      <div className={`pot-label${handNameLabel ? ' pot-label--hand' : ''}`}>{handNameLabel || '底池'}</div>
      <div className="pot-amt">¥{Number(amount).toLocaleString()}</div>
    </div>
  );
}
