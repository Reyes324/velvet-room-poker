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
    // window.innerHeight doesn't shrink when the on-screen keyboard opens
    // (only visualViewport.height does — the layout viewport itself is
    // unchanged, just partially covered). Compare the two: if
    // visualViewport is meaningfully shorter than innerHeight, that's the
    // keyboard, not a real orientation/resize/gap-bug event — skip the
    // update so .game-stage doesn't shrink and reflow every seat/card
    // position while someone's typing a chat message (user-reported,
    // 2026-08-15: "键盘唤起能不要把页面往上顶吗"). Falls back to
    // innerHeight itself in that case, same as browsers without
    // visualViewport support.
    const vv = window.visualViewport?.height;
    const keyboardLikelyOpen = vv != null && window.innerHeight - vv > 120;
    const h = keyboardLikelyOpen ? window.innerHeight : (vv ?? window.innerHeight);
    // Stored as 1% of the real height (not the full height) so CSS can do
    // `calc(var(--vh) * 100)` as a drop-in replacement for `100dvh`.
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
