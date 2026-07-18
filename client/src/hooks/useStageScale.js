import { useEffect } from 'react';

// Reads the stage's real size from CSS (tokens.css --stage-w/--stage-h)
// instead of hardcoding a second copy of the dimensions here — two
// independent copies of the same number drifting apart (712 vs the real
// 812) was a real bug once. The fallback values only matter if the
// stylesheet somehow hasn't loaded yet; they're not a second source of
// truth to keep in sync by hand.
function readStagePx(varName, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName);
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function useStageScale() {
  useEffect(() => {
    function update() {
      // visualViewport.height (falling back to innerHeight) is the actually
      // visible area right now. window.screen.height was tried here before,
      // but it's the physical screen size — larger than the visible area
      // whenever the browser's address bar is on-screen, which overshoots
      // the scale and pushes the (bottom-anchored) stage's top off-screen.
      const vw = window.innerWidth;
      const vh = window.visualViewport?.height ?? window.innerHeight;
      const stageW = readStagePx('--stage-w', 375);
      const stageH = readStagePx('--stage-h', 812);
      const scale = Math.min(vw / stageW, vh / stageH);
      document.documentElement.style.setProperty('--stage-scale', scale);
    }
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, []);
}
