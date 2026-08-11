// Emits the approved preview's card markup/classes (styled by shared velvet.css).
// size: 'xs' | 'sm' | 'md' | 'lg' → c-xs / c-sm / c-md / c-lg
// animate: 'deal-in' | 'flip-reveal' | 'card-deal' | null  delay: seconds (sets CSS --d var)
// highlight: true → this card is part of the winning best-5 at showdown (gold glow)
// dim: true → showdown is resolved and this card is NOT part of the winning best-5
// dx/dy: pixel offset (sets CSS --dx/--dy) 'card-deal' reads to know where on
// the page this specific card should visually fly in FROM — see GameTable's
// dealOriginOffset (GitHub #18/#6: every dealt card originates from the same
// shared center point, not wherever it happens to land).
export default function Card({ card, size = 'md', faceDown = false, animate = null, delay = 0, highlight = false, dim = false, dx = null, dy = null }) {
  const animClass = animate ? ` ${animate}` : '';
  const stateClass = `${highlight ? ' c-highlight' : ''}${dim ? ' c-dim' : ''}`;
  const style = {
    ...(delay ? { '--d': `${delay}s` } : null),
    ...(dx != null ? { '--dx': `${dx}px` } : null),
    ...(dy != null ? { '--dy': `${dy}px` } : null),
  };
  const hasStyle = Object.keys(style).length > 0;
  const styleProp = hasStyle ? style : undefined;
  if (faceDown || !card) {
    return <div className={`card c-${size} c-back${animClass}${stateClass}`} style={styleProp} />;
  }
  const red = card.color === 'red';
  return (
    <div className={`card c-${size} c-face${red ? ' c-red' : ''}${animClass}${stateClass}`} style={styleProp}>
      <div className="c-tl"><span className="cr">{card.rank}</span><span className="cs">{card.suit}</span></div>
      <div className="c-ct">{card.suit}</div>
    </div>
  );
}
