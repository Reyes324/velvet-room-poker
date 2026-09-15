import { useId } from 'react';

// Inline "筹码" glyph standing in for a currency symbol wherever chip amounts
// are shown (pot, bets, ledger, settlement, hand history). Deliberately not
// an emoji — cross-device emoji fonts render inconsistently and clash with
// the app's own gold/serif look — and deliberately not a real currency sign
// (¥ read as literal money in review; the earlier 🪙 swap fixed that but
// looked out of place against the felt/gold palette). currentColor lets it
// pick up whatever color the surrounding text already carries (gold by
// default, but also the ledger's red/green net-win/net-lose classes) with
// no extra prop needed.
//
// First pass had a dashed outer ring meant to read as a chip's notched edge —
// at the 14-20px inline sizes this actually renders at, the dashes just blur
// into a starburst (or vanish into a dot at the smallest sizes). Dropped
// entirely rather than tuned finer, since any dash pattern this small hits
// the same wall. The one bit of extra polish that DOES survive at this size
// is a soft off-center highlight — a single radial-gradient overlay, no new
// shape or line — reading as a matte-enamel disc catching light rather than
// a flat color swatch. useId keeps the gradient's id collision-safe since
// many chips render on one page (poker felt, ledger rows) sharing one <svg>
// document.
//
// verticalAlign calibrated against real rendered baselines, not eyeballed:
// measured the true digit-glyph optical center (canvas measureText's
// actualBoundingBoxAscent/Descent, not the inline box's line-height-padded
// bounding rect, which reads as if digits reached lower than their real
// ink) against the icon's own rendered center, at both 24px (.pot-amt) and
// 11px (.stack-chip-footer). -0.05em placed the icon 0.3-0.8px below the
// digits' optical center at both sizes — small, but consistent, so -0.02em
// (which the same two measurements agree on almost exactly) centers it
// rather than leaving a director's-eye-only offset in place uncorrected.
export default function ChipIcon() {
  const gradId = useId();
  return (
    <svg
      viewBox="0 0 24 24"
      width="0.85em"
      height="0.85em"
      aria-hidden="true"
      style={{ display: 'inline-block', verticalAlign: '-0.02em', flexShrink: 0 }}
    >
      <defs>
        <radialGradient id={gradId} cx="32%" cy="28%" r="70%">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.5" />
          <stop offset="45%" stopColor="#fff" stopOpacity="0.1" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      <circle cx="12" cy="12" r="10" fill={`url(#${gradId})`} />
      <circle cx="12" cy="12" r="10" fill="none" stroke="rgba(0,0,0,0.4)" strokeWidth="1.2" />
      <circle cx="12" cy="12" r="6.5" fill="none" stroke="rgba(0,0,0,0.35)" strokeWidth="1.2" />
    </svg>
  );
}
