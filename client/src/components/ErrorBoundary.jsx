import { Component } from 'react';
import './ErrorBoundary.css';

// Catches any render-time exception below it and shows a real fallback UI
// instead of the whole tree silently unmounting to nothing but the page
// background (user feedback, 2026-08-02, screenshot: "整个画面消失,只剩
// 背景色"). We never found a root cause after a real 11-minute/1168-hand
// Playwright session failed to reproduce it — this doesn't fix whatever's
// actually throwing, but it means the NEXT time this happens the player
// can just copy the error text straight off the screen and send it over,
// instead of needing Mac + USB + Safari remote debugging to get it out
// (user feedback, 2026-08-02: "能不能不要搞那么多执行 Safari 的开发者工
// 具？你直接把报错的东西直接显示在出错了的页面行不行？").
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null, copied: false };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Still logged to console + window.__lastCrash too — belt and
    // suspenders, in case the on-screen copy button itself can't run for
    // some reason.
    console.error('[ErrorBoundary] caught render crash:', error, info?.componentStack);
    window.__lastCrash = { message: error?.message, stack: error?.stack, componentStack: info?.componentStack, at: new Date().toISOString() };
    this.setState({ info });
  }

  errorText() {
    const { error, info } = this.state;
    const lines = [
      `时间: ${new Date().toISOString()}`,
      `信息: ${error?.message ?? String(error)}`,
      error?.stack ? `\n调用栈:\n${error.stack}` : '',
      info?.componentStack ? `\n组件栈:\n${info.componentStack}` : '',
    ];
    return lines.filter(Boolean).join('\n');
  }

  // Plain "刷新页面" alone doesn't help when the crash comes from the
  // resumed session's own data (e.g. the 2026-08-02 masked-showdown-cards
  // crash) — a reload just re-fetches the same broken hand and crashes
  // again immediately (user feedback, 2026-08-02: "这个时候刷新页面好像
  // 都没有用" / there's also no separate URL for PVE to escape to, "始终
  // 用这个链接...依然还是回不到首页"). This button breaks that loop
  // directly from the crash screen: clear every local-storage marker that
  // would auto-resume a room or PVE session, then hard-navigate home.
  handleAbandonAndGoHome = () => {
    localStorage.removeItem('vr_roomCode');
    localStorage.removeItem('vr_pveActive');
    localStorage.removeItem('vr_pveLastActive');
    localStorage.removeItem('vr_pveSeatCount');
    window.location.href = '/';
  };

  handleCopy = async () => {
    const text = this.errorText();
    try {
      await navigator.clipboard.writeText(text);
      this.setState({ copied: true });
      setTimeout(() => this.setState({ copied: false }), 2000);
    } catch {
      // Clipboard API unavailable/blocked — the text is already selectable
      // in the <pre> below, so select it programmatically as a fallback so
      // the user can just long-press-copy instead of needing the button.
      const el = this.preRef;
      if (el && window.getSelection) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="error-boundary">
        <div className="error-boundary-card">
          <div className="error-boundary-title">出错了</div>
          <p className="error-boundary-desc">页面遇到了一个没处理好的问题。下面是具体报错——点"复制错误信息"发给开发者。如果刷新恢复不了（同一局会一直卡在这），用"放弃这局，回首页"跳出去。</p>
          <pre className="error-boundary-detail" ref={el => { this.preRef = el; }}>{this.errorText()}</pre>
          <div className="error-boundary-btns">
            <button className="error-boundary-copy" onClick={this.handleCopy}>
              {this.state.copied ? '已复制 ✓' : '复制错误信息'}
            </button>
            <button className="error-boundary-reload" onClick={() => window.location.reload()}>刷新页面</button>
          </div>
          <button className="error-boundary-abandon" onClick={this.handleAbandonAndGoHome}>放弃这局，回首页</button>
        </div>
      </div>
    );
  }
}
