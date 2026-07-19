import { useEffect, useState } from 'react';

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
export function useTableScale(containerRef, refW, refH) {
  const [scaleX, setScaleX] = useState(1);
  const [scaleY, setScaleY] = useState(1);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) {
        setScaleX(width / refW);
        setScaleY(height / refH);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef]);

  return { scaleX, scaleY };
}
