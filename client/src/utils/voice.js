// 语音相关的公共件，被 /voice-check（单机自检）和 /voice-pair（双机实测）共用。
//
// 抽出来的理由不是"文件太长"，而是这两页对同一件事必须给出**同一个**答案：
// 环境识别、麦克风报错文案、音量怎么算、远端流怎么挂——任何一处两边各存一份，
// 都会出现"自检说能用、双机说不能用"这种自己打自己的结论，而这两页的全部价值
// 就在于结论可信。

// STUN 探测用。Google 那台在国内大概率不通，特意跟国内几台放在一起测——
// "哪几台能用"本身就是后续实现要用的信息，不是顺带的。
export const STUN_SERVERS = [
  { url: 'stun:stun.qq.com:3478', label: '腾讯' },
  { url: 'stun:stun.miwifi.com:3478', label: '小米' },
  { url: 'stun:stun.l.google.com:19302', label: 'Google（国内多半不通）' },
];

export const STUN_TIMEOUT_MS = 6000;

// TURN 中继。加这一层的理由见设计文档「双机实测第二轮」：真机实测下**同一网络
// 能通、跨网络（4G ↔ WiFi）连不上**，而"各在各家各用各的网络"恰恰是这个产品的
// 主场景——原先"跨网络失败是极少数情况、不值得加中继"的判断被证伪了。
//
// STUN 只是帮两端**发现**自己的公网地址，打不通时无能为力；TURN 是真的把音频
// **转发**一遍，所以它能兜住 STUN 兜不住的情况，代价是消耗中继方的带宽。
//
// 2026-08-10：OpenRelay（openrelayproject/openrelayproject）停摆，换成 Metered
// 专属账号。原因见设计文档「跨网络实测：OpenRelay 故障」——那组账密是全网教程
// 共用的公开测试凭证，被真机实测（协议层 Allocate 请求超时无响应，用 coturn 的
// turnutils_uclient 验证，不是靠读文档下结论）证实已失效。这里换的是自己账号下
// 专属铸造的凭证（500MB/月免费、无需绑卡），已用同样的工具验证过协议层真的能
// 建连收发数据（0 丢包）。80/443、UDP/TCP 都留着——限制严格的网络里往往只有
// 某一条能过。
export const TURN_SERVERS = [
  { urls: 'turn:global.relay.metered.ca:80', username: 'cb43a5318f5f4fc6ae0d6a78', credential: 'z7M6Al/3AJdkGhxH', label: 'Metered 80' },
  { urls: 'turn:global.relay.metered.ca:80?transport=tcp', username: 'cb43a5318f5f4fc6ae0d6a78', credential: 'z7M6Al/3AJdkGhxH', label: 'Metered 80/TCP' },
  { urls: 'turn:global.relay.metered.ca:443', username: 'cb43a5318f5f4fc6ae0d6a78', credential: 'z7M6Al/3AJdkGhxH', label: 'Metered 443' },
  { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: 'cb43a5318f5f4fc6ae0d6a78', credential: 'z7M6Al/3AJdkGhxH', label: 'Metered 443/TLS' },
];

// 真实建连要用的 ICE 配置：STUN 优先（直连成本最低、音质最好），打不通时
// 浏览器自己会退到 TURN 中继——两者不是二选一，是同一次协商里的先后顺序。
export const ICE_SERVERS = [
  ...STUN_SERVERS.map(s => ({ urls: s.url })),
  ...TURN_SERVERS.map(({ label, ...cfg }) => cfg), // eslint-disable-line no-unused-vars
];

export function detectEnv() {
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

export function envLabel(env) {
  const parts = [];
  if (env.isWechat) parts.push(`微信 ${env.wechatVersion ?? ''}`.trim());
  if (env.isMiniProgram) parts.push('小程序 webview');
  if (env.isIOS) parts.push(`iOS ${env.iosVersion ?? ''}`.trim());
  if (env.isAndroid) parts.push('Android');
  if (env.isX5) parts.push('X5/TBS 内核');
  if (!env.isWechat) parts.push('非微信浏览器');
  return parts.join(' · ') || '未知';
}

export function micErrorText(e) {
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

// 把远端流挂到一个 <audio> 上。
//
// `muted` 不是可选项而是两种截然不同的用途，调用方必须想清楚：
//  - 自检页的自环流要 muted=true（自己的声音回放出来就是啸叫）；
//  - 双机实测要 muted=false，因为**"听得见对方"才是这一步唯一的验收标准**。
//
// 另外这一步在 Chromium 上是必须的、不是可选的：远端流不挂到 <audio> 元素上，
// 音频根本不会流动，接到 AudioContext 上量到的恒为静音（e2e 实测踩到过，
// 不是推测）。
export function attachSink(stream, { muted = true } = {}) {
  const el = document.createElement('audio');
  el.srcObject = stream;
  el.muted = muted;
  el.autoplay = true;
  el.playsInline = true;
  const played = el.play?.().catch(() => { /* 自动播放被拦也不影响拉流，忽略 */ });
  return {
    played,
    detach: () => {
      try { el.pause(); el.srcObject = null; } catch { /* 已释放 */ }
    },
  };
}

// 把一条流接到 AudioContext 上，持续回报音量（0–1）。返回停止函数。
export function meterStream(stream, audioCtx, onLevel) {
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

// 音量条判定"有声音"的门槛。两页共用一个值——否则会出现同一段声音在一页算
// 有、另一页算没有的荒唐结论。
export const SOUND_THRESHOLD = 0.06;

// 语音诊断上报的判定：一条 mesh 连接"广播说在说话，但音频包确实没到"要
// 不要上报证据。见 design.md「生产环境语音诊断上报」——沙盒复现不了真实
// 网络里的 NAT/TURN 失败，只能让线上环境自己在出问题的一刻留证据。
//
// 只在"最近广播过 speaking:true"这个窗口内判断，不是任何时刻 bytesReceived
// 没涨都算：对方本来沉默着不说话时 bytesReceived 当然不涨，那是正常状态，
// 不是这次要抓的 bug（"广播了说在说话、但没听到"）。
export const SPEAKING_SILENCE_WINDOW_MS = 5000;

export function shouldReportVoiceDiagnostic({ lastSpeakingAt, bytesReceivedDelta, now }) {
  if (lastSpeakingAt == null) return false;
  if (now - lastSpeakingAt > SPEAKING_SILENCE_WINDOW_MS) return false;
  return bytesReceivedDelta <= 0;
}
