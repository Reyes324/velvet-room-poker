// iOS 微信内置浏览器（WKWebView 内核）键盘弹出把整个页面顶起来的问题
// （用户反馈，2026-08-15）：查证过——viewportHeight.js 那处已经堵了"我们
// 自己的 --vh 计算被键盘误触发"，global.css 也把 body/html 锁了纵向滚
// 动，但用户真机测试仍然会顶。查了社区资料才确认根因更深一层：这不是
// DOM/CSS 层面的滚动，WKWebView 自带的原生 UIScrollView（包着整个网页
// 内容那一层）在输入框获得焦点、键盘弹出时会自己把网页内容滚上去，让
// 输入框留在键盘上方——这一层滚动完全在浏览器/系统层面发生，CSS 的
// `overflow:hidden` 管的是网页 DOM 内部的滚动容器，管不到这个。
//
// 修法只能是"顺着它滚、再用 JS 把它拉回来"：输入框获得焦点后，键盘弹出
// 动画本身要跑一小段时间，在这段时间内多次尝试把 window 滚动位置重置回
// (0, 0)——固定延时一次容易踩在动画还没跑完的时间点上不生效，多来几次
// 覆盖整个动画窗口更稳。失焦（键盘收起）时也补一次，处理键盘收起动画
// 期间可能残留的滚动偏移。
export function initKeyboardScrollFix() {
  const resetScroll = () => {
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  };
  const onFocusIn = e => {
    if (!/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    [50, 150, 300, 500, 800].forEach(ms => setTimeout(resetScroll, ms));
  };
  const onFocusOut = () => {
    [100, 300].forEach(ms => setTimeout(resetScroll, ms));
  };
  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('focusout', onFocusOut);
}
