import { useEffect } from 'react';

export function useStageScale() {
  useEffect(() => {
    function update() {
      const vw = window.innerWidth;
      // screen.height is the physical device height (stable, unaffected by Safari
      // address-bar visibility), so the scale never shrinks when the browser chrome
      // appears — prevents narrow black side-bars on iPhone SE / small phones.
      const vh = window.screen?.height ?? window.innerHeight;
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
