import { useLayoutEffect, useRef, useState } from 'react';

// Measures a container's actual rendered box (via ResizeObserver, not window
// dimensions) and returns independent x/y scale factors that stretch a
// refW×refH design canvas to exactly fill it — width always matches the
// container exactly (no side margin, ever) and height scales on its own to
// fill the remaining flex space, rather than a single uniform factor that
// picks whichever axis is tighter and leaves the other with slack. This
// replaces the old whole-page useStageScale: the container here is just the
// flexible middle zone between the (now real, unscaled, edge-pinned) top bar
// and action bar, so top/bottom chrome always fills the true device width
// and this only has to account for whatever's left for the table itself.
// Trade-off: on aspect ratios far from the refW:refH design ratio, circles
// (avatars) render very slightly elliptical rather than perfectly round —
// accepted in exchange for the table always using the full device width.
//
// scaleX/scaleY change whenever the raise panel opens/closes (it's a flex
// sibling of this container — growing it shrinks the space left for the
// table). GameTable derives a per-seat *counter*-scale from these two
// numbers (csx/csy = min(scaleX,scaleY)/scaleX, /scaleY) so avatars/cards
// render at one uniform size regardless of the non-uniform outer stretch —
// see its own comment. A first attempt at smoothing the resulting jump used
// a plain CSS `transition:transform` on the outer canvas AND on every
// counter-scaled child. That doesn't actually work: csx/csy are a *product*
// of TWO numbers that are each independently eased by CSS, and
// (a+Δa·e(t))·(b+Δb·e(t)) only equals the constant a·b at the transition's
// two endpoints, not at any point between them — so seats visibly wobbled
// off their real path mid-transition instead of moving in a straight line
// (user feedback, 2026-07-31: "not a two-point change, other points mixed
// in"). The fix has to keep scaleX and scaleY mathematically in lockstep at
// every single instant, which CSS transitioning two separate values can
// never guarantee — so this hook now tweens scaleX/scaleY itself, in JS,
// recomputing both together on every animation frame. GameTable's csx/csy
// calculation (already re-run on every render) then reads a matched
// {scaleX, scaleY} pair at each of those frames, so the counter-scale
// cancels the outer scale exactly throughout the whole motion, not just at
// the start and end. (No CSS `transition` on any of these transforms
// anymore — see velvet.css.)
const TWEEN_MS = 180; // 用户反馈（2026-07-31）：250ms 感觉偏慢，缩短一点
function easeOutCubic(t) { return 1 - (1 - t) ** 3; }

export function useTableScale(containerRef, refW, refH) {
  // Starting both at 0 (a guess unrelated to the container's real size, which
  // is essentially never refW×refH) meant the very first paint rendered the
  // canvas unscaled, then visibly snapped to the right scale once the async
  // ResizeObserver callback landed — the "stretches blurry, then pops
  // correct" flash on every table entry a real device kept showing. Reading
  // the container synchronously in a layout effect (before the browser
  // paints, unlike a regular effect) means the first paint already has the
  // real scale — no default to guess, no visible jump.
  const [scale, setScale] = useState({ x: 0, y: 0 });
  // Holds whatever's actually on screen right now (mid-tween or settled) —
  // read as the START point of the NEXT tween, so a resize that lands while
  // a previous one is still animating continues smoothly from wherever it
  // visually is, instead of restarting from the old target.
  const currentRef = useRef({ x: 0, y: 0 });
  const rafIdRef = useRef(null);

  function tweenTo(targetX, targetY) {
    cancelAnimationFrame(rafIdRef.current);
    const from = currentRef.current;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / TWEEN_MS);
      const e = easeOutCubic(t);
      const next = { x: from.x + (targetX - from.x) * e, y: from.y + (targetY - from.y) * e };
      currentRef.current = next;
      setScale(next);
      if (t < 1) rafIdRef.current = requestAnimationFrame(step);
    };
    rafIdRef.current = requestAnimationFrame(step);
  }

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      // First measurement ever: snap instantly, nothing to tween from (see
      // comment above on why the very first paint can't animate in).
      const initial = { x: rect.width / refW, y: rect.height / refH };
      currentRef.current = initial;
      setScale(initial);
    }
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) tweenTo(width / refW, height / refH);
    });
    ro.observe(el);
    return () => { ro.disconnect(); cancelAnimationFrame(rafIdRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef]);

  return { scaleX: scale.x, scaleY: scale.y };
}
