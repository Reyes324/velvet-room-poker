// iOS Safari — especially launched standalone from the home screen — can
// report a taller-than-actually-visible height on first paint; 100dvh is
// computed against that stale value and leaves a white gap at the bottom
// until some layout event (a scroll, a resize) makes WebKit recompute.
// This is a tracked WebKit engine bug, not something fixable in CSS alone
// (see https://bugs.webkit.org/show_bug.cgi?id=243452 and the Apple
// developer forum threads on "white space at the bottom on iOS Safari").
//
// Workaround: expose the real height as --vh and have every full-bleed
// container prefer it over raw dvh. On a standalone launch, additionally
// force WebKit to recompute immediately (a 1px scroll-and-back, done
// before the user's first frame) instead of waiting for them to scroll
// themselves.
export function initViewportHeightFix() {
  function applyRealHeight() {
    // Stored as 1% of the real height (not the full height) so CSS can do
    // `calc(var(--vh) * 100)` as a drop-in replacement for `100dvh`.
    const h = window.visualViewport?.height ?? window.innerHeight;
    document.documentElement.style.setProperty('--vh', `${h / 100}px`);
  }

  applyRealHeight();
  window.addEventListener('resize', applyRealHeight);
  window.addEventListener('orientationchange', applyRealHeight);
  window.visualViewport?.addEventListener('resize', applyRealHeight);

  if (window.navigator.standalone) {
    requestAnimationFrame(() => {
      window.scrollTo(0, 1);
      requestAnimationFrame(() => {
        window.scrollTo(0, 0);
        applyRealHeight();
      });
    });
  }
}
