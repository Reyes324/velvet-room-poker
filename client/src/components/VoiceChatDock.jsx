// 语音/打字的吸附式统一入口（2026-08-15，用户设计驱动：贴边可拖拽、展开
// 成同一轮廓的连续胶囊，不用嵌套矩形——设计过程见 brainstorming 会话，
// 定稿理由记在 openspec/changes/online-texas-holdem/design.md）。
//
// 收起态是个贴边的圆（呼应筹码/座位头像的圆形语言），点一下原地拉伸成
// 竖排的"说话/打字"胶囊，再点收起箭头缩回去。拖拽只在收起态可用——
// 展开态的"说话"区域要保留原有的按住说话手势（pointerdown/up），展开
// 态再叠一层拖拽会跟这个手势打架，所以设计上就没让它们同时存在。
//
// 拖拽只能沿竖直方向 + 松手贴左或贴右边（不是自由二维位置）——保证任何
// 时候都贴着屏幕边缘，不会被拖到桌子中间挡住牌。位置记忆在 localStorage
// 里存"贴哪边 + 垂直位置占舞台高度的比例"，用比例不用绝对像素，换手机
// 屏幕高度不同也不会跑偏。
import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'vr-voice-dock-pos';
const DRAG_THRESHOLD_PX = 6;
// 跟服务端 RoomManager.js 的 CHAT_MAX_LEN 对齐——前端这道限制只是不让用
// 户打了老长一段之后才被服务端截断得莫名其妙，真正的上限判定在服务端。
const CHAT_MAX_LEN = 40;

function loadSavedPos() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.edge !== 'left' && parsed?.edge !== 'right') return null;
    if (typeof parsed.topPercent !== 'number') return null;
    return parsed;
  } catch { return null; }
}

function savePos(pos) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(pos)); } catch { /* 存不了就算了，不影响当次使用 */ }
}

export default function VoiceChatDock({
  defaultTop, // 没拖拽过时的默认垂直位置（px，相对舞台）——跟玩家自己座位对齐
  voiceTalking,
  onStartTalking,
  onStopTalking,
  onSendChat,
}) {
  const [expanded, setExpanded] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  // 关闭动画期间 chatOpen 已经是 false 了（触发退场 class），但节点还得
  // 留在 DOM 里等动画播完——closing 就是这段"还没真正卸载"的窗口期。
  const [closing, setClosing] = useState(false);
  const [chatText, setChatText] = useState('');
  const [pos, setPos] = useState(() => loadSavedPos());
  const dockRef = useRef(null);
  const dragRef = useRef(null); // { startX, startY, moved, stageRect }
  const chatInputRef = useRef(null);
  const chatInputBoxRef = useRef(null); // 输入条外层容器，点空白处判断要用
  const closeTimerRef = useRef(null);

  useEffect(() => {
    if (chatOpen) chatInputRef.current?.focus();
  }, [chatOpen]);

  const closeChat = useCallback(() => {
    setChatOpen(false);
    setClosing(true);
    clearTimeout(closeTimerRef.current);
    // 220ms 要跟下面 voiceDockInputOut 那条 keyframe 的时长对齐——退场
    // 动画播完才真正把输入框从 DOM 里拿掉，不然会是硬切没有淡出效果。
    closeTimerRef.current = setTimeout(() => { setClosing(false); setChatText(''); }, 220);
  }, []);

  useEffect(() => () => clearTimeout(closeTimerRef.current), []);

  // 点输入条以外的任何地方关闭它——跟按 Escape 是同一个"放弃这次输入"
  // 语义，不自动发送（用户没主动点发送/敲回车，视为不想发了）。只在
  // chatOpen 时挂监听，用 pointerdown 不用 click——避免跟输入框内部的
  // 文字选中/拖拽手势冲突（用户反馈要求"点空白处也能关"，2026-08-15）。
  useEffect(() => {
    if (!chatOpen) return;
    const onOutside = e => {
      if (chatInputBoxRef.current && !chatInputBoxRef.current.contains(e.target)) closeChat();
    };
    document.addEventListener('pointerdown', onOutside);
    return () => document.removeEventListener('pointerdown', onOutside);
  }, [chatOpen, closeChat]);

  const submitChat = useCallback(() => {
    const trimmed = chatText.trim();
    if (trimmed) onSendChat?.(trimmed);
    setChatText('');
    setChatOpen(false);
    setClosing(false); // 主动发送不用播退场动画——内容已经确认要走了，直接收
    clearTimeout(closeTimerRef.current);
  }, [chatText, onSendChat]);

  const topPx = pos != null
    ? `${pos.topPercent * 100}%`
    : (defaultTop != null ? `${defaultTop}px` : '50%');
  const edge = pos?.edge ?? 'right';

  const handlePointerDown = useCallback(e => {
    if (expanded) return; // 展开态不拖拽，见文件头注释
    const stageEl = dockRef.current?.closest('.game-stage');
    if (!stageEl) return;
    dragRef.current = {
      startX: e.clientX, startY: e.clientY, moved: false,
      stageRect: stageEl.getBoundingClientRect(),
    };
    dockRef.current.setPointerCapture?.(e.pointerId);
  }, [expanded]);

  const handlePointerMove = useCallback(e => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    const localY = e.clientY - drag.stageRect.top;
    const clampedPercent = Math.min(0.92, Math.max(0.08, localY / drag.stageRect.height));
    const nextEdge = e.clientX < drag.stageRect.left + drag.stageRect.width / 2 ? 'left' : 'right';
    setPos({ edge: nextEdge, topPercent: clampedPercent });
  }, []);

  const handlePointerUp = useCallback(e => {
    const drag = dragRef.current;
    dragRef.current = null;
    dockRef.current?.releasePointerCapture?.(e.pointerId);
    if (!drag) return;
    if (!drag.moved) {
      setExpanded(v => !v); // 没挪动过，算一次点击——展开/收起
      return;
    }
    setPos(current => {
      if (current) savePos(current);
      return current;
    });
  }, []);

  // pos 状态更新是异步的，上面 handlePointerUp 里直接读闭包里的 pos 会
  // 拿到旧值——改成用 effect 跟着 pos 变化落盘，簡單且不会存错时机的值。
  useEffect(() => {
    if (pos) savePos(pos);
  }, [pos]);

  return (
    <>
    {(chatOpen || closing) && (
      // 独立于 .voice-dock 渲染（不是塞进它内部）——胶囊的宽高是为"两个
      // 竖排分区"设计的固定尺寸，硬塞一个横向输入框进去要么被裁切要么把
      // 胶囊撑变形。改成紧挨着胶囊的同一条边、同一个垂直位置，独立浮出
      // 一个输入条，跟胶囊本身的形状语言脱钩，各自负责各自的形态。
      //
      // (chatOpen || closing)：点空白处/按 Escape 关闭时要有退场动画，
      // 不能 chatOpen 一变 false 节点就直接从 DOM 消失（那样只是硬切，
      // 没有动画播放的时间）——closing 这个窗口期专门留给 CSS 退场动画
      // 播完，见 closeChat() 里的 setTimeout。
      <div
        ref={chatInputBoxRef}
        className={`voice-dock-input voice-dock-input--${edge}${closing ? ' voice-dock-input--closing' : ''}`}
        style={{ top: topPx }}
      >
        <input
          ref={chatInputRef}
          className="voice-dock-input__field"
          value={chatText}
          maxLength={CHAT_MAX_LEN}
          placeholder="说点什么…"
          // enterKeyHint：手机虚拟键盘的回车键本身是系统原生 UI，网页改不
          // 了颜色/形状，但能指定它显示的文案/图标——默认是换行箭头，容
          // 易被当成"换行"而不是"提交"，改成 "send" 后系统键盘会显示
          // "发送"（或对应图标），跟这里 onKeyDown 里 Enter 触发发送的
          // 行为对上号，用户反馈问起来才发现这处没设（2026-08-15）。
          enterKeyHint="send"
          onChange={e => setChatText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') submitChat();
            if (e.key === 'Escape') closeChat();
          }}
          // 输入框跟"键盘在不在"绑定，不是只靠"点旁边空白处"这一种方式关
          // 掉——用户反馈"输入框不用一直在，键盘唤起它才需要在"（2026-08-
          // 15）：失焦（不管是被系统自带的收起键盘手势、切到别的 App、还
          // 是别的什么原因）就等于不再需要这个框了，直接走跟点空白处一样
          // 的关闭+动画流程。
          onBlur={closeChat}
        />
        {/* pointerDown 上 preventDefault——不这样做的话，点"发送"这个按
            钮本身会先让输入框失焦（触发上面新加的 onBlur→closeChat），
            跟 onClick 里的 submitChat 抢着关闭，两条路径谁先谁后不确
            定，容易看到一闪而过的空白态或者退场动画卡一下。preventDefault
            拦住"点击非输入元素导致输入框失焦"这个浏览器默认行为，让输
            入框在点发送的整个过程里都不失焦，onBlur 就不会被误触发。 */}
        <div
          className="voice-dock-input__send"
          onPointerDown={e => e.preventDefault()}
          onClick={submitChat}
          role="button"
          aria-label="发送"
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 12h16M14 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </div>
    )}
    <div
      ref={dockRef}
      className={`voice-dock voice-dock--${edge}${expanded ? ' voice-dock--expanded' : ''}`}
      style={{ top: topPx }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      role="group"
      aria-label="语音与打字"
    >
      {!expanded && (
        <svg className="voice-dock__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M4 5h16v11H8l-4 4V5Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        </svg>
      )}
      {expanded && (
        <div className="voice-dock__actions">
          <div
            className={`voice-dock__section voice-dock__section--talk${voiceTalking ? ' voice-dock__section--talking' : ''}`}
            onPointerDown={e => { e.stopPropagation(); e.preventDefault(); onStartTalking?.(); }}
            onPointerUp={e => { e.stopPropagation(); onStopTalking?.(); }}
            onPointerLeave={e => { e.stopPropagation(); onStopTalking?.(); }}
            onPointerCancel={e => { e.stopPropagation(); onStopTalking?.(); }}
            role="button"
            aria-label="按住说话"
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="9" y="2" width="6" height="12" rx="3" fill="currentColor" />
              <path d="M6 11a6 6 0 0 0 12 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <span>{voiceTalking ? '说话中' : '说话'}</span>
          </div>
          <div className="voice-dock__divider" />
          <div
            className="voice-dock__section voice-dock__section--chat"
            onPointerDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); clearTimeout(closeTimerRef.current); setClosing(false); setChatOpen(true); }}
            role="button"
            aria-label="打字"
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 5h16v11H8l-4 4V5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            </svg>
            <span>打字</span>
          </div>
          <div
            className="voice-dock__collapse"
            onPointerDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); setExpanded(false); }}
            role="button"
            aria-label="收起"
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d={edge === 'right' ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6'} stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>
      )}
    </div>
    </>
  );
}
