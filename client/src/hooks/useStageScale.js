import { useEffect } from 'react';

export function useStageScale() {
  useEffect(() => {
    function update() {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // 712 = 812 - 100: allow up to 100px of top-clip (top bar only).
      // Keeps opponent seats (y≥112) visible while filling width on small phones.
      const scale = Math.min(vw / 375, vh / 712);
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
