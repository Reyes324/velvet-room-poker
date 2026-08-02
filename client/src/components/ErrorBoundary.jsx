import { Component } from 'react';
import './ErrorBoundary.css';

// Catches any render-time exception below it and shows a real fallback UI
// instead of the whole tree silently unmounting to nothing but the page
// background (user feedback, 2026-08-02, screenshot: "整个画面消失,只剩
// 背景色"). We never found a root cause after a real 11-minute/1168-hand
// Playwright session failed to reproduce it — this doesn't fix whatever's
// actually throwing, but it means the NEXT time this happens we get the
// real error logged (not just a blank screen and a guess) and the player
// gets a way out (reload) instead of being stuck.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Logged with a distinct, greppable prefix so it's easy to find in
    // remote-debugging console output or any future log aggregation —
    // and kept on window so it survives past the console being cleared,
    // in case someone screenshots devtools after scrolling past it.
    console.error('[ErrorBoundary] caught render crash:', error, info?.componentStack);
    window.__lastCrash = { message: error?.message, stack: error?.stack, componentStack: info?.componentStack, at: new Date().toISOString() };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="error-boundary">
        <div className="error-boundary-card">
          <div className="error-boundary-title">出错了</div>
          <p className="error-boundary-desc">页面遇到了一个没处理好的问题，刷新一下就能恢复。</p>
          <button className="error-boundary-reload" onClick={() => window.location.reload()}>刷新页面</button>
        </div>
      </div>
    );
  }
}
