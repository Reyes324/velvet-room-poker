// Emits the approved preview's card markup/classes (styled by shared velvet.css).
// size: 'xs' | 'sm' | 'md' | 'lg' → c-xs / c-sm / c-md / c-lg
export default function Card({ card, size = 'md', faceDown = false }) {
  if (faceDown || !card) {
    return <div className={`card c-${size} c-back`} />;
  }
  const red = card.color === 'red';
  return (
    <div className={`card c-${size} c-face${red ? ' c-red' : ''}`}>
      <div className="c-tl"><span className="cr">{card.rank}</span><span className="cs">{card.suit}</span></div>
      <div className="c-ct">{card.suit}</div>
      <div className="c-br"><span className="cr">{card.rank}</span><span className="cs">{card.suit}</span></div>
    </div>
  );
}
