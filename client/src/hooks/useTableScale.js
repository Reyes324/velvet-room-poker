import { useEffect, useState } from 'react';

// Measures a container's actual rendered box (via ResizeObserver, not window
// dimensions) and returns the uniform scale that fits a refW×refH design
// canvas inside it without distorting circles/text. This replaces the old
// whole-page useStageScale: the container here is just the flexible middle
// zone between the (now real, unscaled, edge-pinned) top bar and action bar,
// so top/bottom chrome always fills the true device width and this scale
// only has to account for whatever's left for the table itself.
export function useTableScale(containerRef, refW, refH) {
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) setScale(Math.min(width / refW, height / refH));
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef]);

  return scale;
}
