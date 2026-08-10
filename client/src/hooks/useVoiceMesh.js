import { useState, useRef, useCallback, useEffect } from 'react';
import { ICE_SERVERS, micErrorText } from '../utils/voice';

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
  const localStreamRef = useRef(null);
  const enabledRef = useRef(false);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  const closePc = useCallback(socketId => {
    const entry = pcsRef.current.get(socketId);
    if (!entry) return;
    try { entry.pc.__audioEl?.pause(); } catch { /* 已释放 */ }
    try { entry.pc.close(); } catch { /* 已关闭 */ }
    pcsRef.current.delete(socketId);
    setSpeakingPlayerIds(prev => {
      if (!prev.has(entry.playerId)) return prev;
      const next = new Set(prev);
      next.delete(entry.playerId);
      return next;
    });
  }, []);

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
      el.play?.().catch(() => { /* 自动播放被拦不影响拉流 */ });
      pc.__audioEl = el;
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
  }, [emit, closePc]);

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

  const disable = useCallback(() => {
    emit('voice:mesh-leave');
    closeAllPcs();
    // 彻底停掉麦克风轨道而不只是 enabled=false——不然浏览器的"麦克风使用
    // 中"指示灯会在用户已经把语音关掉之后继续亮着。下次再开语音说话，
    // 会在按下的那次点击手势里重新申请，符合权限只在按下时申请这条约束。
    localStreamRef.current?.getAudioTracks().forEach(t => t.stop());
    localStreamRef.current = null;
    setEnabled(false);
    setTalking(false);
    setSpeakingPlayerIds(new Set());
  }, [emit, closeAllPcs]);

  const toggle = useCallback(() => {
    if (enabled) disable(); else enable();
  }, [enabled, enable, disable]);

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
    } else {
      localStreamRef.current.getAudioTracks().forEach(t => { t.enabled = true; });
    }
    setTalking(true);
    emit('voice:speaking', { playerId, speaking: true });
  }, [enabled, emit, playerId]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { enabled, connecting, talking, speakingPlayerIds, micError, toggle, startTalking, stopTalking };
}
