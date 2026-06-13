// Pot — bare focal number on the felt (styled by shared velvet.css: .pot/.street-tag/.pot-amt)
export default function Pot({ street, amount }) {
  return (
    <div className="pot">
      {street && <div className="street-tag">{street}</div>}
      <div className="pot-label">底池</div>
      <div className="pot-amt">¥{Number(amount).toLocaleString()}</div>
    </div>
  );
}
