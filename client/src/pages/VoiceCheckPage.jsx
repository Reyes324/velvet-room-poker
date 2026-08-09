// 麦克风 / WebRTC 自检页（路由 /voice-check）
//
// 这是语音对讲功能的**探路**步骤，不是最终功能本身。存在的唯一理由见
// design.md「语音对讲功能」：用户和朋友实际是在**微信内置浏览器**里玩的，
// 而微信对麦克风/WebRTC 的支持存在真实不确定性，公开资料互相矛盾且大多是
// 2021 年前后的。按 CLAUDE.md「不接受纯读文档下结论、要真机实测」，先花小
// 成本探路，能用再投入完整功能。
//
// 两个刻意的设计点，都是为了**不产生假阳性结论**：
//
//  1. 区分"权限拿到了"和"声音真的在流动"。两者不等价——微信环境下有拿到
//     stream 但收不到音频的报告。所以必须有实时音量条，不能只报"授权成功"。
//  2. 区分"WebRTC API 存在"和"真的能建立连接"。所以做页面内本机自环连接，
//     并且**把音量条挂在自环回来的远端流上**——这是最强的证据：声音确实穿过
//     了一条真实的 WebRTC 连接又出来了，而不只是 API 没报错。
//
// 零新增依赖：不引入 simple-peer。自检不该依赖一个还没决定要不要用的库，
// 否则"自检失败"会多出一个"是不是库本身的问题"的干扰项。
import { useState, useEffect, useRef, useCallback } from 'react';
import './VoiceCheckPage.css';

// STUN 探测用。Google 那台在国内大概率不通，特意跟国内几台放在一起测——
// "哪几台能用"本身就是后续实现要用的信息，不是顺带的。
const STUN_SERVERS = [
  { url: 'stun:stun.qq.com:3478', label: '腾讯' },
  { url: 'stun:stun.miwifi.com:3478', label: '小米' },
  { url: 'stun:stun.l.google.com:19302', label: 'Google（国内多半不通）' },
];

const STUN_TIMEOUT_MS = 6000;
const LOOPBACK_TIMEOUT_MS = 8000;

function detectEnv() {
  const ua = navigator.userAgent || '';
  const wechatMatch = ua.match(/MicroMessenger\/([\d.]+)/i);
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  const iosVersion = ua.match(/OS (\d+)[._](\d+)/);
  return {
    ua,
    isWechat: !!wechatMatch,
    wechatVersion: wechatMatch?.[1] ?? null,
    // 微信小程序里嵌的 webview 跟微信内置浏览器不是一回事，限制更多，
    // 单独识别出来——否则结论会被混为一谈。
    isMiniProgram: /miniProgram/i.test(ua),
    isIOS,
    isAndroid,
    iosVersion: iosVersion ? `${iosVersion[1]}.${iosVersion[2]}` : null,
    isX5: /MQQBrowser|TBS/i.test(ua),
  };
}

// 静态能力检查：不需要任何权限，页面一打开就能给结论。
function staticChecks(env) {
  const list = [];
  list.push({
    key: 'secure',
    label: '安全连接（HTTPS）',
    ok: window.isSecureContext === true,
    // localhost 也算安全上下文，所以本地调试时协议是 http 但这项照样是 ✓ ——
    // 把协议写出来，免得线上真的跑在 http 下时被这个 ✓ 蒙混过去。
    detail: window.isSecureContext
      ? `${location.protocol}//${location.hostname}（安全上下文）`
      : `${location.protocol} — 非安全上下文，浏览器会直接禁掉麦克风`,
  });
  const hasGUM = !!navigator.mediaDevices?.getUserMedia;
  list.push({
    key: 'gum',
    label: '麦克风接口（getUserMedia）',
    ok: hasGUM,
    detail: hasGUM ? '存在' : '不存在——这个环境拿不到麦克风',
  });
  const hasPC = typeof window.RTCPeerConnection === 'function';
  list.push({
    key: 'pc',
    label: 'WebRTC 接口（RTCPeerConnection）',
    ok: hasPC,
    detail: hasPC ? '存在' : '不存在——这个环境建不了点对点连接',
  });
  const hasAC = !!(window.AudioContext || window.webkitAudioContext);
  list.push({
    key: 'ac',
    label: '音频分析接口（AudioContext）',
    ok: hasAC,
    // 仅影响自检页画音量条的能力，不影响语音功能本身能不能用——写清楚，
    // 免得把一个"自检工具的限制"误读成"功能不可用"。
    detail: hasAC ? '存在' : '不存在——只影响本页画音量条，不代表语音功能不可用',
  });
  if (env.isIOS) {
    const major = Number(env.iosVersion?.split('.')[0] ?? 0);
    const minor = Number(env.iosVersion?.split('.')[1] ?? 0);
    // iOS 14.3 才给 WKWebView（微信 iOS 用的就是它）开放 WebRTC。
    const ok = major > 14 || (major === 14 && minor >= 3) || major === 0;
    list.push({
      key: 'iosver',
      label: 'iOS 版本 ≥ 14.3',
      ok,
      detail: env.iosVersion ? `iOS ${env.iosVersion}` : '版本号读不出来（不一定有问题）',
    });
  }
  return list;
}

function micErrorText(e) {
  const name = e?.name ?? '未知错误';
  const map = {
    NotAllowedError: '被拒绝——你（或系统/微信）没有授予麦克风权限',
    PermissionDeniedError: '被拒绝——没有授予麦克风权限',
    NotFoundError: '找不到麦克风设备',
    NotReadableError: '麦克风被其他 App 占用，或系统层面读不到',
    SecurityError: '被安全策略拦截（通常是非 HTTPS）',
    AbortError: '被中断',
    TypeError: '接口调用方式不被支持——这个环境很可能根本没开放麦克风',
  };
  return `${name}：${map[name] ?? (e?.message || '没有更多信息')}`;
}

// 本机自环：同一个页面里建两条 RTCPeerConnection 互连，把麦克风轨道从
// pc1 推给 pc2。走的是真实的 SDP 协商 + ICE 流程，只是候选地址都在本机，
// 所以不需要 STUN、也不检验 NAT 穿透——它检验的是"这个环境的 WebRTC 到底
// 是真能用，还是只是接口存在"。
function runLoopback(stream) {
  return new Promise((resolve, reject) => {
    let pc1, pc2, timer;
    const cleanup = () => {
      clearTimeout(timer);
      try { pc1?.close(); } catch { /* 已关闭 */ }
      try { pc2?.close(); } catch { /* 已关闭 */ }
    };
    try {
      pc1 = new RTCPeerConnection();
      pc2 = new RTCPeerConnection();
    } catch (e) {
      cleanup();
      return reject(new Error(`建不了连接对象：${e.message}`));
    }

    let remoteStream = null;
    let connected = false;
    const settleIfReady = () => {
      if (remoteStream && connected) {
        clearTimeout(timer);
        // 刻意不 cleanup()——远端流还要挂音量条，连接得留着。
        // 关闭的责任交给调用方（见 stopAll）。
        resolve({ pc1, pc2, remoteStream });
      }
    };

    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${LOOPBACK_TIMEOUT_MS / 1000} 秒内没连起来（远端流：${remoteStream ? '有' : '无'}，连接状态：${pc1?.iceConnectionState ?? '未知'}）`));
    }, LOOPBACK_TIMEOUT_MS);

    pc1.onicecandidate = e => { if (e.candidate) pc2.addIceCandidate(e.candidate).catch(() => {}); };
    pc2.onicecandidate = e => { if (e.candidate) pc1.addIceCandidate(e.candidate).catch(() => {}); };
    pc2.ontrack = e => {
      remoteStream = e.streams?.[0] ?? new MediaStream([e.track]);
      settleIfReady();
    };
    pc1.oniceconnectionstatechange = () => {
      if (pc1.iceConnectionState === 'connected' || pc1.iceConnectionState === 'completed') {
        connected = true;
        settleIfReady();
      } else if (pc1.iceConnectionState === 'failed') {
        cleanup();
        reject(new Error('ICE 协商失败'));
      }
    };

    stream.getAudioTracks().forEach(t => pc1.addTrack(t, stream));
    pc1.createOffer()
      .then(o => pc1.setLocalDescription(o).then(() => pc2.setRemoteDescription(o)))
      .then(() => pc2.createAnswer())
      .then(a => pc2.setLocalDescription(a).then(() => pc1.setRemoteDescription(a)))
      .catch(e => { cleanup(); reject(new Error(`协商失败：${e.message}`)); });
  });
}

// 单台 STUN 探测：能不能拿到 srflx（公网映射地址）候选。拿得到说明这台
// STUN 在当前网络下可达，点对点直连有戏；拿不到就是不可达或被墙。
function probeStun({ url, label }) {
  return new Promise(resolve => {
    let pc, timer, done = false;
    const finish = (ok, reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { pc?.close(); } catch { /* 已关闭 */ }
      resolve({ url, label, ok, reason });
    };
    try {
      pc = new RTCPeerConnection({ iceServers: [{ urls: url }] });
    } catch (e) {
      return finish(false, `创建失败：${e.message}`);
    }
    timer = setTimeout(() => finish(false, '超时，没拿到公网地址'), STUN_TIMEOUT_MS);
    pc.onicecandidate = e => {
      if (!e.candidate) return finish(false, '收集结束，没有公网候选');
      if (e.candidate.type === 'srflx' || / typ srflx /.test(e.candidate.candidate)) {
        finish(true, '拿到公网地址');
      }
    };
    try {
      pc.createDataChannel('probe');
      pc.createOffer().then(o => pc.setLocalDescription(o)).catch(e => finish(false, `协商失败：${e.message}`));
    } catch (e) {
      finish(false, `协商失败：${e.message}`);
    }
  });
}

// 远端流必须挂到一个 <audio> 元素上，音频才会真的开始流动——否则光把它接到
// AudioContext 上量到的永远是静音。这是 Chromium 上确认过的行为（不是猜的：
// 第一版没有这一步，e2e 实测远端音量条恒为 0，加上之后才有读数），Safari 上
// 同样需要。静音是刻意的：自检页要是把麦克风声音外放出来会形成啸叫，判据交给
// 音量条就够了。
//
// 正式的语音功能里也逃不掉这一步——每个远端流本来就要挂 <audio> 才能听见，
// 只是那时候不能 muted。
function attachSink(stream) {
  const el = document.createElement('audio');
  el.srcObject = stream;
  el.muted = true;
  el.autoplay = true;
  el.playsInline = true;
  el.play?.().catch(() => { /* 自动播放被拦也不影响拉流，忽略 */ });
  return () => {
    try { el.pause(); el.srcObject = null; } catch { /* 已释放 */ }
  };
}

// 把一条流接到 AudioContext 上，持续回报音量（0–1）。返回停止函数。
function meterStream(stream, audioCtx, onLevel) {
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);
  let raf;
  const tick = () => {
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    // ×4 只是把常规说话音量拉到条子上看得见的范围，不是标定值。
    onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
    raf = requestAnimationFrame(tick);
  };
  tick();
  return () => {
    cancelAnimationFrame(raf);
    try { source.disconnect(); analyser.disconnect(); } catch { /* 已断开 */ }
  };
}

export default function VoiceCheckPage() {
  const [env] = useState(detectEnv);
  const [checks] = useState(() => staticChecks(detectEnv()));
  const [micState, setMicState] = useState('idle'); // idle | requesting | ok | error
  const [micError, setMicError] = useState(null);
  const [trackInfo, setTrackInfo] = useState(null);
  const [localLevel, setLocalLevel] = useState(0);
  const [localPeak, setLocalPeak] = useState(0);
  const [loopState, setLoopState] = useState('idle'); // idle | running | ok | error
  const [loopError, setLoopError] = useState(null);
  const [remoteLevel, setRemoteLevel] = useState(0);
  const [remotePeak, setRemotePeak] = useState(0);
  const [stunState, setStunState] = useState('idle'); // idle | running | done
  const [stunResults, setStunResults] = useState([]);
  const [copied, setCopied] = useState(false);

  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const stopLocalMeterRef = useRef(null);
  const stopRemoteMeterRef = useRef(null);
  const detachSinkRef = useRef(null);
  const loopRef = useRef(null);

  const stopAll = useCallback(() => {
    stopLocalMeterRef.current?.();
    stopRemoteMeterRef.current?.();
    detachSinkRef.current?.();
    stopLocalMeterRef.current = null;
    stopRemoteMeterRef.current = null;
    detachSinkRef.current = null;
    loopRef.current?.pc1?.close();
    loopRef.current?.pc2?.close();
    loopRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  }, []);

  useEffect(() => stopAll, [stopAll]);

  // 全流程都挂在这一次点击上：微信里 getUserMedia 必须由用户主动手势触发，
  // 页面加载后自动调用会直接失败——这也正是产品侧"点说话时才申请权限"那条
  // 决策的技术来源（design.md）。iOS 的 AudioContext 同样要手势后 resume。
  async function handleStart() {
    stopAll();
    setMicError(null); setLoopError(null);
    setLocalPeak(0); setRemotePeak(0);
    setLoopState('idle'); setStunState('idle'); setStunResults([]);
    setMicState('requesting');

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (e) {
      setMicState('error');
      setMicError(micErrorText(e));
      return;
    }
    streamRef.current = stream;
    const track = stream.getAudioTracks()[0];
    setTrackInfo(track ? { label: track.label || '(设备没报名字)', enabled: track.enabled, muted: track.muted, state: track.readyState } : null);
    setMicState('ok');

    // 音量条。拿不到 AudioContext 只是本页画不了条，不影响后面的连接测试，
    // 所以不 return。
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      try {
        const ctx = new AC();
        audioCtxRef.current = ctx;
        if (ctx.state === 'suspended') await ctx.resume();
        stopLocalMeterRef.current = meterStream(stream, ctx, v => {
          setLocalLevel(v);
          setLocalPeak(p => (v > p ? v : p));
        });
      } catch { /* 画不了条就算了，下面的连接测试才是主菜 */ }
    }

    // 本机自环连接 + 远端流音量条。
    setLoopState('running');
    try {
      const loop = await runLoopback(stream);
      loopRef.current = loop;
      setLoopState('ok');
      // 必须先挂 sink 再挂音量条，否则量到的是静音（见 attachSink 注释）。
      detachSinkRef.current = attachSink(loop.remoteStream);
      const ctx = audioCtxRef.current;
      if (ctx) {
        try {
          stopRemoteMeterRef.current = meterStream(loop.remoteStream, ctx, v => {
            setRemoteLevel(v);
            setRemotePeak(p => (v > p ? v : p));
          });
        } catch { /* 同上 */ }
      }
    } catch (e) {
      setLoopState('error');
      setLoopError(e.message);
    }

    // STUN 探测。放最后：它耗时最长，而且失败不影响前面两项的结论。
    setStunState('running');
    const results = await Promise.all(STUN_SERVERS.map(probeStun));
    setStunResults(results);
    setStunState('done');
  }

  const report = buildReport({ env, checks, micState, micError, trackInfo, localPeak, loopState, loopError, remotePeak, stunResults });

  function handleCopy() {
    navigator.clipboard?.writeText(report).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      // 微信里 clipboard API 经常不给用——下面的文本框本来就能长按全选，
      // 静默失败即可，不用弹错误吓人。
    });
  }

  const verdict = overallVerdict({ checks, micState, loopState, localPeak, remotePeak, stunState, stunResults });

  return (
    <div className="vc-page">
      <h1 className="vc-title">麦克风自检</h1>
      <p className="vc-sub">
        这是语音对讲功能的探路测试，<strong>不是</strong>正式功能。请用你平时玩牌的方式打开这个页面
        （比如在微信里点开），然后点下面的按钮，对着手机说几句话。
      </p>

      <div className="vc-env">
        <div className="vc-env-row"><span>运行环境</span><strong>{envLabel(env)}</strong></div>
        {env.isWechat && (
          <div className="vc-note">
            检测到你在微信里打开。这正是要测的场景——微信内置浏览器对麦克风的支持是这次最大的不确定性。
          </div>
        )}
        {env.isMiniProgram && (
          <div className="vc-note vc-note--warn">
            检测到是微信小程序内嵌网页，限制比普通微信浏览器更多，结果可能更差。
          </div>
        )}
      </div>

      <section className="vc-section">
        <h2 className="vc-h2">第一步：环境能力（不需要权限）</h2>
        {checks.map(c => (
          <div key={c.key} className={`vc-check vc-check--${c.ok ? 'ok' : 'bad'}`}>
            <span className="vc-check-icon">{c.ok ? '✓' : '✕'}</span>
            <span className="vc-check-label">{c.label}</span>
            <span className="vc-check-detail">{c.detail}</span>
          </div>
        ))}
      </section>

      <section className="vc-section">
        <h2 className="vc-h2">第二步：实际测试</h2>
        <button className="vc-btn" onClick={handleStart} disabled={micState === 'requesting'}>
          {micState === 'idle' ? '开始检测' : micState === 'requesting' ? '正在申请麦克风…' : '重新检测'}
        </button>

        {micState === 'error' && (
          <div className="vc-result vc-result--bad">
            <strong>拿不到麦克风</strong>
            <div className="vc-result-detail">{micError}</div>
          </div>
        )}

        {micState === 'ok' && (
          <>
            <div className="vc-result vc-result--ok">
              <strong>麦克风权限拿到了</strong>
              {trackInfo && (
                <div className="vc-result-detail">
                  设备：{trackInfo.label}
                  {trackInfo.muted && <span className="vc-warn">（系统报告当前是静音状态）</span>}
                </div>
              )}
            </div>

            {/* 权限拿到 ≠ 声音真的在流动。这条条子才是判据。 */}
            <Meter
              title="① 麦克风听到的声音"
              hint="对着手机说话，条子应该跟着动。不动 = 权限给了但收不到声音。"
              level={localLevel}
              peak={localPeak}
            />

            <div className="vc-loop">
              <div className="vc-loop-head">
                <span>② 点对点连接测试</span>
                <span className={`vc-tag vc-tag--${loopState}`}>
                  {loopState === 'running' ? '连接中…' : loopState === 'ok' ? '已连通' : loopState === 'error' ? '失败' : '等待'}
                </span>
              </div>
              {loopState === 'error' && <div className="vc-result-detail vc-warn">{loopError}</div>}
              {loopState === 'ok' && (
                <Meter
                  title="③ 穿过连接后回来的声音"
                  hint="这条会动，才真正说明语音能用——声音确实走了一条真实的点对点连接。"
                  level={remoteLevel}
                  peak={remotePeak}
                />
              )}
            </div>

            <div className="vc-stun">
              <div className="vc-loop-head">
                <span>④ 公网穿透测试（STUN）</span>
                <span className={`vc-tag vc-tag--${stunState === 'done' ? 'ok' : stunState}`}>
                  {stunState === 'running' ? '测试中…' : stunState === 'done' ? '完成' : '等待'}
                </span>
              </div>
              <div className="vc-stun-hint">
                真人之间要连上，需要至少一台服务器可达。这一步只测网络，跟麦克风无关。
              </div>
              {stunResults.map(r => (
                <div key={r.url} className={`vc-check vc-check--${r.ok ? 'ok' : 'bad'}`}>
                  <span className="vc-check-icon">{r.ok ? '✓' : '✕'}</span>
                  <span className="vc-check-label">{r.label}</span>
                  <span className="vc-check-detail">{r.reason}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      {verdict && (
        <section className={`vc-verdict vc-verdict--${verdict.kind}`}>
          <div className="vc-verdict-title">{verdict.title}</div>
          <div className="vc-verdict-body">{verdict.body}</div>
        </section>
      )}

      <section className="vc-section">
        <h2 className="vc-h2">把结果发回来</h2>
        <p className="vc-sub">下面这段是诊断结果，复制发给我就行（文本框可以长按全选）。</p>
        <button className="vc-btn vc-btn--ghost" onClick={handleCopy}>{copied ? '已复制' : '复制结果'}</button>
        <textarea className="vc-report" readOnly value={report} rows={12} />
      </section>
    </div>
  );
}

function Meter({ title, hint, level, peak }) {
  return (
    <div className="vc-meter">
      <div className="vc-meter-title">{title}</div>
      <div className="vc-meter-bar">
        <div className="vc-meter-fill" style={{ width: `${Math.round(level * 100)}%` }} />
        <div className="vc-meter-peak" style={{ left: `${Math.round(peak * 100)}%` }} />
      </div>
      <div className="vc-meter-hint">
        {hint}
        {peak > 0.06
          ? <strong className="vc-ok-text vc-meter-flag">已经检测到声音 ✓</strong>
          : <strong className="vc-warn vc-meter-flag">还没检测到声音</strong>}
      </div>
    </div>
  );
}

function envLabel(env) {
  const parts = [];
  if (env.isWechat) parts.push(`微信 ${env.wechatVersion ?? ''}`.trim());
  if (env.isMiniProgram) parts.push('小程序 webview');
  if (env.isIOS) parts.push(`iOS ${env.iosVersion ?? ''}`.trim());
  if (env.isAndroid) parts.push('Android');
  if (env.isX5) parts.push('X5/TBS 内核');
  if (!env.isWechat) parts.push('非微信浏览器');
  return parts.join(' · ') || '未知';
}

// 结论刻意分档，有两条不肯让步的地方：
//
//  1. "能用"这一档要求**远端音量条真的动过**。只凭"权限拿到了"就下结论，
//     正是这页要避免的假阳性。
//  2. 本机自环只证明"这台设备上 WebRTC 能用"，**不能证明两台不同设备之间
//     连得上**。STUN 可达性是对后者最接近的判据，所以 STUN 没跑完不给终局
//     结论、一台都不可达时必须降级说明——绕过这一步会让人以为已经万事俱备。
function overallVerdict({ checks, micState, loopState, localPeak, remotePeak, stunState, stunResults }) {
  if (micState === 'idle' || micState === 'requesting') return null;
  const staticOk = checks.every(c => c.ok);
  if (micState === 'error') {
    return { kind: 'bad', title: '结论：这个环境用不了语音', body: '连麦克风权限都拿不到。可以试试用「在浏览器中打开」跳到系统浏览器再测一次，对比结果。' };
  }
  if (loopState === 'error') {
    return { kind: 'bad', title: '结论：麦克风能用，但点对点连接建不起来', body: '这个环境的 WebRTC 有问题，语音对讲做不了。同样建议用系统浏览器再测一次对比。' };
  }
  if (remotePeak > 0.06) {
    if (stunState !== 'done') {
      return { kind: 'warn', title: '麦克风和连接都没问题，正在测网络…', body: '声音已经成功穿过一条真实的点对点连接。还剩最后一项公网穿透测试（第④条），跑完才是完整结论。' };
    }
    const reachable = stunResults.filter(r => r.ok);
    if (reachable.length === 0) {
      return {
        kind: 'warn',
        title: '结论：设备本身没问题，但网络这一关没过',
        // 这里是 JSX 不是 markdown——加粗要用元素，写 ** 会原样显示出来
        // （真机截图里抓到的，不是推测）。
        body: (
          <>
            麦克风和 WebRTC 都正常，声音也确实穿过了本机的点对点连接。但没有任何一台公网穿透服务器可达，这意味着
            <strong>两个人的设备之间能不能连上还不确定</strong>
            ——本机自环测不出这一点。把结果发回来，我再判断。
          </>
        ),
      };
    }
    return {
      kind: 'ok',
      title: '结论：这个环境可以做语音对讲',
      body: `麦克风收得到声音，点对点连接也真的把声音传回来了，公网穿透有 ${reachable.length} 台服务器可达（${reachable.map(r => r.label).join('、')}）。`
        + (staticOk ? '' : ' 不过上面有环境检查项没过，把结果发回来我看一下。'),
    };
  }
  if (localPeak > 0.06) {
    return { kind: 'warn', title: '还差一步：请对着手机多说几句', body: '麦克风已经收到声音了，但"穿过连接回来的声音"还没检测到。再说几句话看看第③条会不会动；如果一直不动，说明连接虽然建起来了但音频没真的通过。' };
  }
  return { kind: 'warn', title: '还差一步：还没听到你说话', body: '权限拿到了，但麦克风一直没收到声音。请确认没有静音、对着手机说几句话。如果条子始终不动，就是"权限给了但收不到声音"这种情况——这正是要查出来的问题。' };
}

function buildReport({ env, checks, micState, micError, trackInfo, localPeak, loopState, loopError, remotePeak, stunResults }) {
  const lines = [];
  lines.push('=== 翡翠厅 麦克风自检结果 ===');
  lines.push(`时间：${new Date().toLocaleString()}`);
  lines.push(`环境：${envLabel(env)}`);
  lines.push(`UA：${env.ua}`);
  lines.push('');
  lines.push('[环境能力]');
  checks.forEach(c => lines.push(`  ${c.ok ? 'OK ' : 'NG '} ${c.label} — ${c.detail}`));
  lines.push('');
  lines.push('[实际测试]');
  lines.push(`  麦克风权限：${{ idle: '未测试', requesting: '进行中', ok: 'OK', error: `NG ${micError}` }[micState]}`);
  if (trackInfo) lines.push(`  设备：${trackInfo.label}｜muted=${trackInfo.muted}｜state=${trackInfo.state}`);
  lines.push(`  麦克风收到声音峰值：${localPeak.toFixed(3)}${localPeak > 0.06 ? '（有声音）' : '（没检测到声音）'}`);
  lines.push(`  点对点连接：${{ idle: '未测试', running: '进行中', ok: 'OK', error: `NG ${loopError}` }[loopState]}`);
  lines.push(`  穿过连接回来的声音峰值：${remotePeak.toFixed(3)}${remotePeak > 0.06 ? '（有声音）' : '（没检测到声音）'}`);
  lines.push('');
  lines.push('[STUN 公网穿透]');
  if (stunResults.length === 0) lines.push('  未测试');
  stunResults.forEach(r => lines.push(`  ${r.ok ? 'OK ' : 'NG '} ${r.label} ${r.url} — ${r.reason}`));
  return lines.join('\n');
}
