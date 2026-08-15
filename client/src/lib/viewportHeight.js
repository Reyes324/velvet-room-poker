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
  // 曾经这里还监听 `resize` 和 `visualViewport.resize`，想靠"跟 innerHeight
  // 比差值"来分辨"这次变化是键盘弹出还是真的要重算"——真机（iPhone
  // Safari）测出这个判断站不住：键盘第一次弹出/收起一轮之后，
  // innerHeight 本身在 iOS 上就不再稳定复位（这是有记录的 WebKit 行为，
  // 不是这份代码的猜测），"拿 innerHeight 当键盘无关的基准"这个前提在
  // 第二次开始就不成立了，表现就是用户反馈的"第一次点没事，关了再点就
  // 顶"。
  //
  // 干脆不再持续监听——这份 --vh 本来就只是为了修"首屏留白"这一次性的
  // 问题（见上面注释），不需要长期跟踪视口尺寸变化：只在页面加载时算一
  // 次，加上 orientationchange（真的转屏才更新）。日常滚动导致地址栏收
  // 起/展开这类场景，原生的 100dvh fallback 本来就会自己适配，不需要靠
  // 这段 JS 去追。少了持续监听，也就从根上不会再跟键盘弹出/收起搅在一
  // 起（2026-08-15，真机反馈两轮排查后的结论）。
  function applyRealHeight() {
    const h = window.visualViewport?.height ?? window.innerHeight;
    // Stored as 1% of the real height (not the full height) so CSS can do
    // `calc(var(--vh) * 100)` as a drop-in replacement for `100dvh`.
    document.documentElement.style.setProperty('--vh', `${h / 100}px`);
  }

  applyRealHeight();
  window.addEventListener('orientationchange', applyRealHeight);

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
