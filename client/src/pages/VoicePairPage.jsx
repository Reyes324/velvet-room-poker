// 双机连通性实测页（路由 /voice-pair）
//
// 存在的理由见 docs/superpowers/specs/2026-08-09-voice-intercom-design.md
// 「实施顺序」第 2 步：/voice-check 的本机自环**证否能力不足**——自环失败推不出
// "两台手机连不上"（iOS 上自环要靠 mDNS 解析 host 候选，而真实两端走的是 STUN
// 拿到的公网地址，两条路径根本不同）。所以 go/no-go 只能靠真实的两端连接来定，
// 这一页就是那个判据。
//
// **这不是一次性探针**：这里的信令编排 + 建连 + 音频收发就是完整语音功能的内核，
// 验证通过后直接长成正式功能（届时把 1v1 扩成 mesh、把界面接进牌桌）。
//
// 验收标准刻意定成"**你听得见对方**"而不是"音量条动了"：iOS 上把远端流接到
// AudioContext 量音量本身就不可靠，用一个可能撒谎的仪表当唯一判据，正是这两页
// 一直在避免的事。音量条留着，但只当辅助证据。
import { useState, useEffect, useRef, useCallback } from 'react';
import './VoiceCheckPage.css';
import './VoicePairPage.css';
import Meter from '../components/VoiceMeter';
import { getSocket } from '../hooks/useSocket';
import {
  ICE_SERVERS, SOUND_THRESHOLD,
  detectEnv, envLabel, micErrorText, attachSink, meterStream,
} from '../utils/voice';

// 建连超时。比自环的 15 秒更宽：真实两端要等 STUN 往返 + 候选交换，跨运营商
// 的手机网络上慢是常态，宁可多等也不要误报"连不上"。
const CONNECT_TIMEOUT_MS = 25000;

function randomCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// 从 URL 里取暗号——微信里把链接发给对方，对方点开就直接进同一个暗号，
// 不用手输（手输 4 位数在微信里是实打实的流失点）。
function codeFromUrl() {
  const fromQuery = new URLSearchParams(window.location.search).get('code');
  return /^\d{4}$/.test(fromQuery ?? '') ? fromQuery : null;
}

export default function VoicePairPage() {
  const [env] = useState(detectEnv);
  const [code, setCode] = useState(() => codeFromUrl() ?? randomCode());
  const [phase, setPhase] = useState('idle'); // idle | starting | waiting | connecting | connected | error
  const [error, setError] = useState(null);
  const [peerId, setPeerId] = useState(null);
  const [iceState, setIceState] = useState(null);
  const [localLevel, setLocalLevel] = useState(0);
  const [localPeak, setLocalPeak] = useState(0);
  const [remoteLevel, setRemoteLevel] = useState(0);
  const [remotePeak, setRemotePeak] = useState(0);
  const [copied, setCopied] = useState(false);
  const [route, setRoute] = useState(null); // 实际选中的连接路径（host/srflx/relay）

  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const stopMetersRef = useRef([]);
  const detachSinkRef = useRef(null);
  const timeoutRef = useRef(null);
  const peerIdRef = useRef(null);

  const stopAll = useCallback(() => {
    clearTimeout(timeoutRef.current);
    stopMetersRef.current.forEach(fn => { try { fn(); } catch { /* 已停 */ } });
    stopMetersRef.current = [];
    detachSinkRef.current?.();
    detachSinkRef.current = null;
    try { pcRef.current?.close(); } catch { /* 已关闭 */ }
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    localStreamRef.current = null;
    try { audioCtxRef.current?.close(); } catch { /* 已关闭 */ }
    audioCtxRef.current = null;
    peerIdRef.current = null;
  }, []);

  useEffect(() => () => {
    getSocket().emit('voice:leave');
    stopAll();
  }, [stopAll]);

  // 建 RTCPeerConnection 并把本地音轨推上去。发起方/接听方共用，区别只在
  // 谁先 createOffer——由服务端下发的 shouldInitiate 决定，不由客户端猜。
  const buildPc = useCallback((socket, remoteId) => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pcRef.current = pc;
    peerIdRef.current = remoteId;

    pc.onicecandidate = e => {
      if (e.candidate) socket.emit('voice:signal', { to: remoteId, signal: { candidate: e.candidate } });
    };
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      setIceState(s);
      if (s === 'connected' || s === 'completed') {
        clearTimeout(timeoutRef.current);
        setPhase('connected');
        // 连上之后把真正选中的那条路径读出来——"到底是靠本地网络直连还是靠
        // STUN 打通的"，这决定了朋友之间隔着不同网络能不能用，是这次实测最
        // 想拿到的信息之一。
        pc.getStats?.().then(stats => {
          let selected = null;
          stats.forEach(r => {
            if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated !== false) selected = r;
          });
          if (!selected) return;
          const local = stats.get?.(selected.localCandidateId);
          const remote = stats.get?.(selected.remoteCandidateId);
          if (local || remote) setRoute(`${local?.candidateType ?? '?'} ↔ ${remote?.candidateType ?? '?'}`);
        }).catch(() => { /* 拿不到统计不影响结论 */ });
      } else if (s === 'failed') {
        clearTimeout(timeoutRef.current);
        setPhase('error');
        // 真机第二轮实测确认过这条失败的实际含义：同网络能通、跨网络（4G↔WiFi）
        // 不通。所以这里不能只说"没打通"就完事——那句话对用户毫无信息量，也没法
        // 指导下一步。把最可能的原因和一个可执行的对照实验一起给出来。
        setError('两台设备之间没能打通。最常见的原因是两边不在同一个网络（比如一台用流量、一台用 WiFi）——'
          + '可以让两台连同一个 WiFi 再试一次做对照。');
      }
    };
    pc.ontrack = e => {
      const stream = e.streams?.[0] ?? new MediaStream([e.track]);
      // muted:false —— 这一页的验收标准就是"听得见对方"，不能静音。
      detachSinkRef.current = attachSink(stream, { muted: false }).detach;
      const ctx = audioCtxRef.current;
      if (ctx) stopMetersRef.current.push(meterStream(stream, ctx, v => {
        setRemoteLevel(v);
        setRemotePeak(p => Math.max(p, v));
      }));
    };

    localStreamRef.current.getAudioTracks().forEach(t => pc.addTrack(t, localStreamRef.current));
    return pc;
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setPhase('starting');
    const socket = getSocket();
    if (!socket.connected) socket.connect();

    // 麦克风必须在点击这个手势里申请——微信里 getUserMedia 不由用户手势触发
    // 会直接失败（见设计文档「麦克风权限申请时机」）。
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (e) {
      setPhase('error');
      setError(`拿不到麦克风 — ${micErrorText(e)}`);
      return;
    }
    localStreamRef.current = stream;

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      ctx.resume?.().catch(() => { /* 被策略拦住也不影响连接本身 */ });
      stopMetersRef.current.push(meterStream(stream, ctx, v => {
        setLocalLevel(v);
        setLocalPeak(p => Math.max(p, v));
      }));
    }

    socket.emit('voice:join', { code }, res => {
      if (res?.error) {
        setPhase('error');
        setError(res.error);
        return;
      }
      if (!res?.shouldInitiate) {
        // 先到的人：什么都不做，等对方进来触发 voice:peer-joined
        setPhase('waiting');
        return;
      }
      setPhase('connecting');
      const remoteId = res.peers[0];
      setPeerId(remoteId);
      const pc = buildPc(socket, remoteId);
      timeoutRef.current = setTimeout(() => {
        setPhase('error');
        setError(`${CONNECT_TIMEOUT_MS / 1000} 秒内没连上（ICE：${pc.iceConnectionState}）`);
      }, CONNECT_TIMEOUT_MS);
      pc.createOffer()
        .then(o => pc.setLocalDescription(o).then(() => {
          socket.emit('voice:signal', { to: remoteId, signal: { sdp: pc.localDescription } });
        }))
        .catch(e => { setPhase('error'); setError(`协商失败：${e.message}`); });
    });
  }, [code, buildPc]);

  // 信令处理。offer/answer/candidate 三种消息走同一个事件，靠 payload 区分——
  // 少一层事件名就少一处两端要对齐的约定。
  useEffect(() => {
    const socket = getSocket();

    const onPeerJoined = ({ id }) => {
      // 我是先到的那个，对方进来了：由**后进来的人**发 offer（服务端定的规则），
      // 所以这里只记下对端 id 并等他的 offer，不主动发起，避免双方同时 offer。
      setPeerId(id);
      setPhase('connecting');
      timeoutRef.current = setTimeout(() => {
        setPhase(p => (p === 'connected' ? p : 'error'));
        setError(`${CONNECT_TIMEOUT_MS / 1000} 秒内没连上`);
      }, CONNECT_TIMEOUT_MS);
    };

    const onSignal = async ({ from, signal }) => {
      if (!localStreamRef.current) return; // 还没点开始，忽略
      let pc = pcRef.current;
      if (!pc || peerIdRef.current !== from) pc = buildPc(socket, from);

      try {
        if (signal.sdp) {
          await pc.setRemoteDescription(signal.sdp);
          if (signal.sdp.type === 'offer') {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit('voice:signal', { to: from, signal: { sdp: pc.localDescription } });
          }
        } else if (signal.candidate) {
          await pc.addIceCandidate(signal.candidate);
        }
      } catch (e) {
        setPhase('error');
        setError(`处理信令失败：${e.message}`);
      }
    };

    const onPeerLeft = () => {
      if (!pcRef.current) return;
      setPhase('waiting');
      setPeerId(null);
      setError('对方断开了');
      try { pcRef.current.close(); } catch { /* 已关闭 */ }
      pcRef.current = null;
      peerIdRef.current = null;
    };

    socket.on('voice:peer-joined', onPeerJoined);
    socket.on('voice:signal', onSignal);
    socket.on('voice:peer-left', onPeerLeft);
    if (!socket.connected) socket.connect();
    return () => {
      socket.off('voice:peer-joined', onPeerJoined);
      socket.off('voice:signal', onSignal);
      socket.off('voice:peer-left', onPeerLeft);
    };
  }, [buildPc]);

  const inviteUrl = `${location.origin}/voice-pair?code=${code}`;

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('复制失败，请手动长按选中上面的链接');
    }
  };

  const busy = phase !== 'idle' && phase !== 'error';

  return (
    <div className="vc-page">
      <h1 className="vc-title">双机语音实测</h1>
      <p className="vc-sub">
        两台手机各开一次这个页面、用<strong>同一个暗号</strong>，看看能不能真的听见对方说话。
        这是决定语音对讲能不能做的最后一道判据。
      </p>
      <p className="vc-env">环境：{envLabel(env)}</p>

      <section className="vp-code-card">
        <div className="vp-code-label">暗号</div>
        <input
          className="vp-code-input"
          value={code}
          inputMode="numeric"
          maxLength={4}
          disabled={busy}
          onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
        />
        <div className="vp-invite">
          <div className="vp-invite-url">{inviteUrl}</div>
          <button className="vc-btn vc-btn--ghost" onClick={copyInvite}>
            {copied ? '已复制 ✓' : '复制链接发给对方'}
          </button>
        </div>
      </section>

      <button className="vc-btn vp-start" onClick={start} disabled={busy}>
        {phase === 'idle' || phase === 'error' ? '开始通话（会申请麦克风）' : '进行中…'}
      </button>

      <section className="vp-status">
        <div className={`vp-phase vp-phase--${phase}`}>
          {{
            idle: '还没开始',
            starting: '正在拿麦克风…',
            waiting: '已就位，等对方点开始…',
            connecting: '正在连接对方…',
            connected: '已连接 ✓',
            error: '出错了',
          }[phase]}
        </div>
        {peerId && <div className="vp-line">对方：{peerId.slice(0, 6)}…</div>}
        {iceState && <div className="vp-line">连接状态：{iceState}</div>}
        {route && <div className="vp-line">走的路径：{route}</div>}
        {error && <div className="vp-line vc-warn">{error}</div>}
      </section>

      <Meter title="① 你的麦克风" hint="对着手机说话，这条要动。" level={localLevel} peak={localPeak} />
      <Meter title="② 对方的声音" hint="对方说话时这条要动。" level={remoteLevel} peak={remotePeak} />

      {phase === 'connected' && (
        <section className={`vc-verdict vc-verdict--${remotePeak > SOUND_THRESHOLD ? 'ok' : 'warn'}`}>
          <div className="vc-verdict-title">
            {remotePeak > SOUND_THRESHOLD ? '连接成功，而且收到对方的声音了' : '连接建立了，但还没收到对方的声音'}
          </div>
          <div className="vc-verdict-body">
            {remotePeak > SOUND_THRESHOLD
              ? '这就是要的结论：两台真实设备之间的语音通了。'
              : '让对方多说几句看第②条会不会动。'}
            <strong>
              最终以耳朵为准——你真的听见对方说话了吗？音量条在 iPhone 上有可能不准，听得见才算数。
            </strong>
          </div>
        </section>
      )}

      <button
        className="vc-btn vc-btn--ghost vp-report"
        onClick={() => {
          const report = [
            '=== 翡翠厅 双机语音实测 ===',
            `时间：${new Date().toLocaleString()}`,
            `环境：${envLabel(env)}`,
            `UA：${env.ua}`,
            `暗号：${code}`,
            `阶段：${phase}`,
            `对端：${peerId ?? '无'}`,
            `ICE：${iceState ?? '未开始'}`,
            `路径：${route ?? '未知'}`,
            `我的麦克风峰值：${localPeak.toFixed(3)}`,
            `对方声音峰值：${remotePeak.toFixed(3)}`,
            `错误：${error ?? '无'}`,
          ].join('\n');
          navigator.clipboard?.writeText(report).then(
            () => { setCopied(true); setTimeout(() => setCopied(false), 2000); },
            () => setError('复制失败'),
          );
        }}
      >
        复制诊断结果
      </button>
    </div>
  );
}
