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
      const vw = window.innerWidth;
      // screen.height is the physical device height (stable, unaffected by Safari
      // address-bar visibility), so the scale never shrinks when the browser chrome
      // appears — prevents narrow black side-bars on iPhone SE / small phones.
      const vh = window.screen?.height ?? window.innerHeight;
      const stageW = readStagePx('--stage-w', 375);
      const stageH = readStagePx('--stage-h', 812);
      const scale = Math.min(vw / stageW, vh / stageH);
      document.documentElement.style.setProperty('--stage-scale', scale);
    }
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);
}
