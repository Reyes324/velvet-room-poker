import { useEffect } from 'react';

export function useStageScale() {
  useEffect(() => {
    function update() {
      const scale = Math.min(window.innerWidth / 375, window.innerHeight / 812);
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
