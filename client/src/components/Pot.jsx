// Pot — bare focal number on the felt (styled by shared velvet.css: .pot/.street-tag/.pot-amt)
// burst: true briefly flares the pot amount (used on showdown)
export default function Pot({ street, amount, burst = false }) {
  return (
    <div className={`pot${burst ? ' pot-burst' : ''}`}>
      {street && <div className="street-tag">{street}</div>}
      <div className="pot-label">底池</div>
      <div className="pot-amt">¥{Number(amount).toLocaleString()}</div>
    </div>
  );
}
