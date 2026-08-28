import { useState, useRef, useCallback, useEffect } from 'react';
import { ICE_SERVERS, micErrorText, shouldReportVoiceDiagnostic, detectEnv } from '../utils/voice';

// 语音诊断上报的轮询间隔——见 design.md「生产环境语音诊断上报」。10 秒
// 是"够密集到能抓住 SPEAKING_SILENCE_WINDOW_MS（5 秒）那个窗口、又不会
// 每条连接每几秒就打一次 getStats()"之间的折中，不是精确标定值。
const VOICE_DIAGNOSTIC_POLL_MS = 10000;

// 语音对讲正式接入牌桌后的 N 人 mesh。跟 VoicePairPage 那个 2 人探路版本
// 的核心协商逻辑同源（同一套 STUN/TURN、同样的 sdp/candidate 信令 payload
// 形状），但这里要多处理两件探路阶段不存在的事：
//
//  1. 人数是 N 不是 2——加入时要对每一个已在场的成员各发一条 offer，退出/
//     断线时只清理对应那一条连接，不影响其余连接。
//  2. 麦克风只在第一次按下"说话"时申请（已锁定的产品决策 + 微信硬约束），
//     而不是加入语音房间的时候。这意味着连接一开始只是 recvonly（随时能
//     听，不需要权限），第一次按下说话时才把拿到的音轨升级挂上去——这是
//     一次真正的 WebRTC renegotiation，不是简单的参数切换，所以下面用了
//     标准的 "perfect negotiation" 模式（polite/impolite 两个角色）来避免
//     双方同时重新协商时的冲突（glare）：谁是这条连接最初的发起方
//     （offerTo 调用方）就一直是 impolite，谁是最初的应答方就一直是
//     polite，角色在连接建立时定死、后续所有重新协商复用同一个角色，不
//     用每次都重新协商"谁让谁"。
export function useVoiceMesh({ socket, emit, playerId }) {
  const [enabled, setEnabled] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [talking, setTalking] = useState(false);
  const [speakingPlayerIds, setSpeakingPlayerIds] = useState(() => new Set());
  const [micError, setMicError] = useState(null);

  const pcsRef = useRef(new Map()); // socketId -> { pc, playerId }
  // playerId -> 最近一次收到该人 speaking:true 广播的时间戳，语音诊断
  // 上报用（见下面的轮询 effect）。跟 speakingPlayerIds 那个 state 分开
  // 存：那个是给 UI 渲染用的离散状态，这个是给诊断判定用的精确时间点，
  // 合并成一个会导致每次说话状态变化都触发诊断相关的重渲染。
  const lastSpeakingAtRef = useRef(new Map());
  // socketId -> 上一次轮询时读到的 bytesReceived，用来算增量。
  const lastBytesReceivedRef = useRef(new Map());
  // socketId -> 已经为"当前这次 speaking 窗口"上报过，避免同一次说话
  // 期间每 10 秒重复上报同一条证据。speaking 变化或连接重建时清掉。
  const reportedRef = useRef(new Set());
  const localStreamRef = useRef(null);
  const enabledRef = useRef(false);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  // 远端音轨到达时创建的 <audio> 元素调 .play() 可能被浏览器的自动播放策略
  // 拦下（NotAllowedError）——之前这里是 `.catch(() => {})` 直接吞掉，注释
  // 写的是"不影响拉流"，这话只对了一半：ontrack/WebRTC 层确实不受影响，但
  // 播放本身失败意味着这个人的声音真的听不见，且没有任何重试，会一直哑到
  // 页面刷新为止。3 人以上的 mesh 里，不同连接的音轨到达时间点不同，有的
  // 落在浏览器允许自动播放的窗口内（能听见），有的落在窗口外（悄悄哑掉）——
  // 这跟"整体连上了但某个人听不到某个人"的报告完全吻合。
  // 修法：失败的 <audio> 元素记下来，下一次用户在页面上有任何真实交互
  // （pointerdown）时统一重试——浏览器的自动播放限制本质上就是"要有一次
  // 用户手势"，用户按下"说话"或者点别的什么都算，不需要专门为这件事再造一
  // 个按钮。
  const pendingPlayRef = useRef(new Set());
  useEffect(() => {
    if (!enabled) return;
    const retry = () => {
      for (const el of pendingPlayRef.current) {
        el.play?.().then(() => pendingPlayRef.current.delete(el)).catch(() => { /* 还是不行，等下一次手势 */ });
      }
    };
    document.addEventListener('pointerdown', retry);
    // 微信内置浏览器（XWeb 内核）对"什么算用户手势"判断比标准浏览器更严格——
    // 一个 `pointerdown` 事件监听器里异步调用的 `.play()`，在微信里不一定被
    // 认可为用户触发，标准解法是额外监听微信自己的 `WeixinJSBridgeReady`
    // （用户反馈 2026-08-27：在微信内置浏览器里从头到尾听不到任何人说话，
    // 且确认点过按钮——单靠 pointerdown 重试没能恢复，符合这个已知坑）。
    // 非微信环境这个事件永远不会触发，注册了也没有副作用。
    document.addEventListener('WeixinJSBridgeReady', retry);
    return () => {
      document.removeEventListener('pointerdown', retry);
      document.removeEventListener('WeixinJSBridgeReady', retry);
    };
  }, [enabled]);

  // 实时音量（0..1），playerId -> 强度，自己和对方共用同一张表。刻意不进
  // React state——这是每帧都在变的数据，真做成 state 会在说话的整个过程
  // 里持续触发整棵树重渲染。改成 ref + 命令式 getVolume()，由用到它的组
  // 件自己在 rAF 里读、直接改 DOM 的 CSS 变量，State 只负责"在不在说话"
  // 这个离散事实（已有的 speakingPlayerIds），音量这个连续量完全绕开 React。
  const volumesRef = useRef(new Map());
  const analysersRef = useRef(new Map()); // playerId -> { analyser, data }
  const audioCtxRef = useRef(null);

  const getAudioCtx = useCallback(() => {
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtxRef.current = new Ctx();
    }
    return audioCtxRef.current;
  }, []);

  // source 接到 analyser 上但不接 destination——这条支路只用来量音量，接
  // 到 destination 会导致同一路音频被播放两次。
  const attachAnalyser = useCallback((pid, stream) => {
    try {
      const ctx = getAudioCtx();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      analysersRef.current.set(pid, { analyser, data: new Uint8Array(analyser.fftSize), source });
    } catch { /* 不支持 AnalyserNode 时静默降级——只是没有波纹强度，说话发光本身不受影响 */ }
  }, [getAudioCtx]);

  const detachAnalyser = useCallback(pid => {
    const entry = analysersRef.current.get(pid);
    if (!entry) return;
    try { entry.source.disconnect(); } catch { /* 已断开 */ }
    analysersRef.current.delete(pid);
    volumesRef.current.delete(pid);
  }, []);

  // 单个共享 rAF 循环，覆盖所有当前接了 analyser 的 playerId（自己 + 每个
  // 已连上的对方），比每路各开一个循环省事也省性能。
  useEffect(() => {
    let raf;
    const tick = () => {
      for (const [pid, { analyser, data }] of analysersRef.current) {
        analyser.getByteTimeDomainData(data);
        let sumSq = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / data.length);
        // 人声正常说话的 RMS 大概在 0.02~0.15 这个量级，乘个系数把它拉到
        // 视觉上有感的 0~1 区间，属于视觉标定不是精确的分贝换算。
        volumesRef.current.set(pid, Math.min(1, rms * 6));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const getVolume = useCallback(pid => volumesRef.current.get(pid) ?? 0, []);

  const closePc = useCallback(socketId => {
    const entry = pcsRef.current.get(socketId);
    if (!entry) return;
    if (entry.pc.__audioEl) pendingPlayRef.current.delete(entry.pc.__audioEl);
    try { entry.pc.__audioEl?.pause(); } catch { /* 已释放 */ }
    try { entry.pc.close(); } catch { /* 已关闭 */ }
    pcsRef.current.delete(socketId);
    lastBytesReceivedRef.current.delete(socketId);
    reportedRef.current.delete(socketId);
    detachAnalyser(entry.playerId);
    setSpeakingPlayerIds(prev => {
      if (!prev.has(entry.playerId)) return prev;
      const next = new Set(prev);
      next.delete(entry.playerId);
      return next;
    });
  }, [detachAnalyser]);

  const closeAllPcs = useCallback(() => {
    for (const socketId of [...pcsRef.current.keys()]) closePc(socketId);
  }, [closePc]);

  // polite：见文件头注释。impolite（发起方）自己的 offer 跟对方撞车时直接
  // 忽略对方那条；polite（应答方）撞车时反过来回滚自己的、接受对方的——
  // 两边规则不同，缺一不可，不能对称地各退一步（那样谁都不让，会卡死）。
  const buildPc = useCallback((remoteSocketId, remotePlayerId, polite) => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.__polite = polite;
    const transceiver = pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.__transceiver = transceiver;
    if (localStreamRef.current) {
      transceiver.direction = 'sendrecv';
      transceiver.sender.replaceTrack(localStreamRef.current.getAudioTracks()[0]);
    }

    pc.onicecandidate = e => {
      if (e.candidate) emit('voice:mesh-signal', { to: remoteSocketId, signal: { candidate: e.candidate } });
    };
    pc.ontrack = e => {
      const stream = e.streams?.[0] ?? new MediaStream([e.track]);
      const el = document.createElement('audio');
      el.srcObject = stream;
      el.autoplay = true;
      el.playsInline = true;
      el.play?.().catch(() => {
        pendingPlayRef.current.add(el);
        // 跟 bytesReceived 停滞那种"包没到"的诊断是两类完全不同的失败——这里
        // 音频包已经到了（ontrack 已触发），单纯是浏览器不让播，会被现有的
        // shouldReportVoiceDiagnostic 判定漏掉（那个只看 bytesReceived），所以
        // 单独上报一次，见 design.md「#48 语音听不到」2026-08-27 复查记录。
        emit('voice:diagnostic', {
          kind: 'autoplay-blocked',
          remotePlayerId,
          ua: navigator.userAgent,
          isWechat: detectEnv().isWechat,
          at: Date.now(),
        });
      });
      pc.__audioEl = el;
      attachAnalyser(remotePlayerId, stream);
    };
    pc.onnegotiationneeded = async () => {
      try {
        pc.__makingOffer = true;
        await pc.setLocalDescription();
        emit('voice:mesh-signal', { to: remoteSocketId, signal: { sdp: pc.localDescription } });
      } catch { /* 这条连接协商失败不影响其他人 */ } finally {
        pc.__makingOffer = false;
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') closePc(remoteSocketId);
    };

    pcsRef.current.set(remoteSocketId, { pc, playerId: remotePlayerId });
    // 测试专用调试钩子，跟 useSocket.js 里的 window.__vrSocket 是同一个
    // 用途——e2e 要断言的是"WebRTC 协商真的连上了"，不能只信旁边那条更
    // 简单的 voice:speaking 信令广播（那条不经过 ICE，即使音频连接没建
    // 起来也照样能收发）。生产环境这个属性不会被读取，纯粹是可观测性。
    if (typeof window !== 'undefined') {
      window.__voiceMeshPcs = pcsRef.current;
    }
    return pc;
  }, [emit, closePc, attachAnalyser]);

  const offerTo = useCallback((remoteSocketId, remotePlayerId) => {
    const pc = buildPc(remoteSocketId, remotePlayerId, false); // 我是发起方 → impolite
    return pc.createOffer()
      .then(o => pc.setLocalDescription(o))
      .then(() => emit('voice:mesh-signal', { to: remoteSocketId, signal: { sdp: pc.localDescription } }));
  }, [buildPc, emit]);

  const enable = useCallback(() => {
    setConnecting(true);
    setMicError(null);
    // useSocket.js 的 emit 包装只转发 (event, data) 两个参数，不支持 ack
    // 回调——这里要读服务端的返回值，得绕过那层包装直接用 socket.emit。
    socket.emit('voice:mesh-join', { playerId }, res => {
      setConnecting(false);
      if (res?.error) { setMicError(res.error); return; }
      setEnabled(true);
      for (const peer of res.peers ?? []) offerTo(peer.socketId, peer.playerId).catch(() => {});
    });
  }, [socket, playerId, offerTo]);

  // 默认所有人自动接入语音网络（只是"能听"，不涉及麦克风权限）——不再需
  // 要手动点开关才能收到别人的声音。麦克风权限仍然只在第一次按住"说话"
  // 时才申请，这条硬约束不变，这里只是去掉了"听"这一侧的额外开关。
  useEffect(() => {
    if (!socket || !playerId) return;
    // setTimeout(0) 而不是直接调用：enable() 内部同步 setState，直接在
    // effect body 里调会触发级联渲染（lint 会拦），推迟到下一个 tick 等价
    // 于常规的"挂载后触发一次副作用"，行为不变。
    const timer = setTimeout(enable, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, playerId]);

  const startTalking = useCallback(async () => {
    if (!enabled) return;
    if (!localStreamRef.current) {
      try {
        localStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } catch (e) {
        setMicError(micErrorText(e));
        return;
      }
      const track = localStreamRef.current.getAudioTracks()[0];
      // 把这条新拿到的音轨一次性挂到所有已存在的连接上——每条连接都会
      // 各自触发一次 onnegotiationneeded，自动完成升级成 sendrecv 所需的
      // 重新协商，这里不用手动再发一次 offer。
      for (const { pc } of pcsRef.current.values()) {
        pc.__transceiver.direction = 'sendrecv';
        pc.__transceiver.sender.replaceTrack(track);
      }
      // 自己的说话波纹强度跟对方共用同一张 volumesRef 表，key 用自己的
      // playerId——PlayerSeat 读音量时不用区分"这是我自己还是对方"。
      attachAnalyser(playerId, localStreamRef.current);
    } else {
      localStreamRef.current.getAudioTracks().forEach(t => { t.enabled = true; });
    }
    setTalking(true);
    emit('voice:speaking', { playerId, speaking: true });
  }, [enabled, emit, playerId, attachAnalyser]);

  const stopTalking = useCallback(() => {
    localStreamRef.current?.getAudioTracks().forEach(t => { t.enabled = false; });
    setTalking(false);
    emit('voice:speaking', { playerId, speaking: false });
  }, [emit, playerId]);

  useEffect(() => {
    const onSignal = async ({ from, fromPlayerId, signal }) => {
      let entry = pcsRef.current.get(from);
      let pc = entry?.pc;
      // 还没有这条连接：说明对方是新进来的、正在给我发第一条 offer——
      // 我是应答方 → polite。
      if (!pc) pc = buildPc(from, fromPlayerId, true);

      try {
        if (signal.sdp) {
          const isOffer = signal.sdp.type === 'offer';
          const collision = isOffer && (pc.__makingOffer || pc.signalingState !== 'stable');
          if (collision && !pc.__polite) return; // impolite：撞车时忽略对方，坚持自己那条
          if (collision) {
            await Promise.all([
              pc.setLocalDescription({ type: 'rollback' }),
              pc.setRemoteDescription(signal.sdp),
            ]);
          } else {
            await pc.setRemoteDescription(signal.sdp);
          }
          if (isOffer) {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            emit('voice:mesh-signal', { to: from, signal: { sdp: pc.localDescription } });
          }
        } else if (signal.candidate) {
          await pc.addIceCandidate(signal.candidate).catch(() => { /* 迟到的候选，忽略 */ });
        }
      } catch { /* 单条连接协商失败不影响其他人 */ }
    };
    const onPeerLeft = ({ socketId }) => closePc(socketId);
    const onSpeaking = ({ playerId: pid, speaking }) => {
      if (speaking) {
        lastSpeakingAtRef.current.set(pid, Date.now());
        for (const [socketId, entry] of pcsRef.current) {
          if (entry.playerId === pid) reportedRef.current.delete(socketId);
        }
      }
      setSpeakingPlayerIds(prev => {
        const has = prev.has(pid);
        if (speaking === has) return prev;
        const next = new Set(prev);
        if (speaking) next.add(pid); else next.delete(pid);
        return next;
      });
    };

    // voice:mesh-peer-joined 不需要单独处理——后进来的人负责主动发 offer
    // （见服务端约定），我这边只要等它的信令到达即可，onSignal 里已经会
    // 按需 lazily 建连接。
    socket.on('voice:mesh-signal', onSignal);
    socket.on('voice:mesh-peer-left', onPeerLeft);
    socket.on('voice:speaking', onSpeaking);
    return () => {
      socket.off('voice:mesh-signal', onSignal);
      socket.off('voice:mesh-peer-left', onPeerLeft);
      socket.off('voice:speaking', onSpeaking);
    };
  }, [socket, buildPc, closePc, emit]);

  // 语音诊断上报：不影响任何现有连接/协商逻辑，纯观测。见 design.md
  // 「生产环境语音诊断上报」——沙盒复现不了跨真实网络的 NAT/TURN 问题，
  // 只能让线上环境在出问题的那一刻把 getStats() 里的证据留下来。
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(async () => {
      const now = Date.now();
      for (const [socketId, { pc, playerId: remotePlayerId }] of pcsRef.current) {
        if (reportedRef.current.has(socketId)) continue;
        const lastSpeakingAt = lastSpeakingAtRef.current.get(remotePlayerId) ?? null;
        let stats;
        try {
          stats = await pc.getStats();
        } catch { continue; /* 连接已经关了，下一轮跳过 */ }

        let bytesReceived = null;
        let localCandidateType = null;
        let remoteCandidateType = null;
        for (const report of stats.values()) {
          if (report.type === 'inbound-rtp' && report.kind === 'audio') {
            bytesReceived = report.bytesReceived;
          } else if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
            const local = stats.get(report.localCandidateId);
            const remote = stats.get(report.remoteCandidateId);
            localCandidateType = local?.candidateType ?? null;
            remoteCandidateType = remote?.candidateType ?? null;
          }
        }
        if (bytesReceived == null) continue; // 这条连接还没有 inbound-rtp 报表，跳过

        const prevBytes = lastBytesReceivedRef.current.get(socketId);
        lastBytesReceivedRef.current.set(socketId, bytesReceived);
        if (prevBytes == null) continue; // 第一次轮询，没有增量可比，跳过

        const shouldReport = shouldReportVoiceDiagnostic({
          lastSpeakingAt,
          bytesReceivedDelta: bytesReceived - prevBytes,
          now,
        });
        if (!shouldReport) continue;

        reportedRef.current.add(socketId);
        emit('voice:diagnostic', {
          remotePlayerId,
          ua: navigator.userAgent,
          iceConnectionState: pc.iceConnectionState,
          localCandidateType,
          remoteCandidateType,
          silentForMs: now - lastSpeakingAt,
          at: now,
        });
      }
    }, VOICE_DIAGNOSTIC_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, emit]);

  // 重连：跟 RoomPage 里 room:sync 在 connect 时重新同步的模式一致——旧
  // socket.id 上的信令状态在新连接上已经失效，语音这层也要跟着重新握手。
  useEffect(() => {
    const onConnect = () => {
      if (!enabledRef.current) return;
      closeAllPcs();
      socket.emit('voice:mesh-join', { playerId }, res => {
        if (res?.error) { setEnabled(false); setMicError(res.error); return; }
        for (const peer of res.peers ?? []) offerTo(peer.socketId, peer.playerId).catch(() => {});
      });
    };
    socket.on('connect', onConnect);
    return () => socket.off('connect', onConnect);
  }, [socket, playerId, closeAllPcs, offerTo]);

  // 卸载（离开牌桌/组件销毁）：清干净，不留悬挂的连接和麦克风占用。
  useEffect(() => () => {
    closeAllPcs();
    localStreamRef.current?.getAudioTracks().forEach(t => t.stop());
    if (enabledRef.current) emit('voice:mesh-leave');
    audioCtxRef.current?.close().catch(() => { /* 已关闭/不支持 */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { enabled, connecting, talking, speakingPlayerIds, micError, startTalking, stopTalking, getVolume };
}
