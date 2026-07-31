import { useEffect, useState } from 'react';

// Temporary diagnostic overlay for the iOS standalone "white gap at bottom,
// fixed by swiping" bug (2026-08-01) — no Mac/remote-debugging available in
// this environment, so instead of guessing at CSS fixes, this just prints
// the real numbers on screen so they can be screenshotted directly from the
// device: once right after a cold open (before touching anything), and
// again after doing the swipe that "fixes" it. Comparing the two tells us
// exactly which metric is wrong on load. Reachable via ?debug=viewport —
// remove this file (and its App.jsx wiring) once the bug's actually fixed.
function readSafeAreaInset(side) {
  const probe = document.createElement('div');
  probe.style.position = 'fixed';
  probe.style.top = '0';
  probe.style.height = `env(safe-area-inset-${side})`;
  document.body.appendChild(probe);
  const px = getComputedStyle(probe).height;
  document.body.removeChild(probe);
  return px;
}

function snapshot() {
  const vv = window.visualViewport;
  const rootRect = document.getElementById('root')?.getBoundingClientRect();
  const bodyStyle = getComputedStyle(document.body);
  return {
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    'window.innerWidth/Height': `${window.innerWidth} / ${window.innerHeight}`,
    'document.documentElement.clientW/H': `${document.documentElement.clientWidth} / ${document.documentElement.clientHeight}`,
    'visualViewport.width/height': vv ? `${vv.width} / ${vv.height}` : 'n/a',
    'visualViewport.offsetTop/Left': vv ? `${vv.offsetTop} / ${vv.offsetLeft}` : 'n/a',
    'visualViewport.scale': vv ? vv.scale : 'n/a',
    'window.scrollX/Y': `${window.scrollX} / ${window.scrollY}`,
    'devicePixelRatio': window.devicePixelRatio,
    'navigator.standalone': String(window.navigator.standalone),
    'body computed height': bodyStyle.height,
    'body computed min-height': bodyStyle.minHeight,
    '#root getBoundingClientRect': rootRect ? `w=${rootRect.width.toFixed(1)} h=${rootRect.height.toFixed(1)} top=${rootRect.top.toFixed(1)}` : 'n/a',
    'env(safe-area-inset-top)': readSafeAreaInset('top'),
    'env(safe-area-inset-bottom)': readSafeAreaInset('bottom'),
    'document.body.scrollHeight': document.body.scrollHeight,
    'document.documentElement.scrollHeight': document.documentElement.scrollHeight,
  };
}

export default function ViewportDebug() {
  const [data, setData] = useState(snapshot);

  useEffect(() => {
    const id = setInterval(() => setData(snapshot()), 300);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{
      position: 'fixed', inset: 0, background: '#000', color: '#0F0',
      fontFamily: 'monospace', fontSize: 13, lineHeight: 1.6,
      padding: '12px', overflow: 'auto', zIndex: 99999, whiteSpace: 'pre-wrap',
    }}>
      <div style={{ color: '#FF0', marginBottom: 8 }}>
        视口诊断 — 现在马上截一张图（不要动屏幕），然后上下划一下页面让白边消失，
        再截一张图，两张都发给我。
      </div>
      {Object.entries(data).map(([k, v]) => (
        <div key={k}>{k}: <span style={{ color: '#fff' }}>{String(v)}</span></div>
      ))}
    </div>
  );
}
