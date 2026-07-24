// Emits the approved preview's card markup/classes (styled by shared velvet.css).
// size: 'xs' | 'sm' | 'md' | 'lg' → c-xs / c-sm / c-md / c-lg
// animate: 'deal-in' | 'flip-reveal' | null  delay: seconds (sets CSS --d var)
export default function Card({ card, size = 'md', faceDown = false, animate = null, delay = 0 }) {
  const animClass = animate ? ` ${animate}` : '';
  const style = delay ? { '--d': `${delay}s` } : undefined;
  if (faceDown || !card) {
    return <div className={`card c-${size} c-back${animClass}`} style={style} />;
  }
  const red = card.color === 'red';
  return (
    <div className={`card c-${size} c-face${red ? ' c-red' : ''}${animClass}`} style={style}>
      <div className="c-tl"><span className="cr">{card.rank}</span><span className="cs">{card.suit}</span></div>
      <div className="c-ct">{card.suit}</div>
    </div>
  );
}
