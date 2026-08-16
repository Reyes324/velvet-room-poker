import { useState, useEffect } from 'react';

// 白屏焦虑修复的第二段（用户反馈，2026-08-16）——覆盖"HTML/JS 已经到达、
// React 已经挂载，但 socket.io 还没连上后端"这段完全无反馈的空窗（此前
// HomePage 照常渲染出来，点"创建房间"看起来像没反应）。真正的"HTML 都还
// 没到浏览器"那种纯白屏，问过用户后明确不做（要么加 Service Worker 缓存
// 页面壳子、要么升级 Render 付费档不休眠，两条都有额外成本/复杂度，用户
// 选择接受现状），这个组件不覆盖那种情况。
//
// 5 秒是拍的一个门槛，不是精确测量出来的——短连接延迟（正常网络波动）不
// 值得提"服务器可能在休眠"这种更耸动的说法，给用户一点心理缓冲区间再升
// 级措辞。
const WAKING_HINT_DELAY_MS = 5000;

export default function ConnectingOverlay() {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => clearInterval(id);
  }, []);

  const showWakingHint = elapsedMs >= WAKING_HINT_DELAY_MS;

  return (
    <div className="connecting-overlay">
      <div className="connecting-overlay-spinner" />
      <div className="connecting-overlay-text">
        {showWakingHint ? '服务器可能正在从休眠中苏醒，最长约 1 分钟，请稍候…' : '连接中…'}
      </div>
    </div>
  );
}
