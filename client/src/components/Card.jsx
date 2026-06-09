import './Card.css';

export default function Card({ card, size = 'md', faceDown = false }) {
  if (faceDown || !card) {
    return <div className={`card card--back card--${size}`} />;
  }
  return (
    <div className={`card card--${card.color} card--${size}`}>
      <div className="card-corner tl">
        <span className="card-rank">{card.rank}</span>
        <span className="card-suit">{card.suit}</span>
      </div>
      <div className="card-center">{card.suit}</div>
      <div className="card-corner br">
        <span className="card-rank">{card.rank}</span>
        <span className="card-suit">{card.suit}</span>
      </div>
    </div>
  );
}
