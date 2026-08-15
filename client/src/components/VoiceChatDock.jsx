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
  const [chatText, setChatText] = useState('');
  const [pos, setPos] = useState(() => loadSavedPos());
  const dockRef = useRef(null);
  const dragRef = useRef(null); // { startX, startY, moved, stageRect }
  const chatInputRef = useRef(null);

  useEffect(() => {
    if (chatOpen) chatInputRef.current?.focus();
  }, [chatOpen]);

  const submitChat = useCallback(() => {
    const trimmed = chatText.trim();
    if (trimmed) onSendChat?.(trimmed);
    setChatText('');
    setChatOpen(false);
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
    {chatOpen && (
      // 独立于 .voice-dock 渲染（不是塞进它内部）——胶囊的宽高是为"两个
      // 竖排分区"设计的固定尺寸，硬塞一个横向输入框进去要么被裁切要么把
      // 胶囊撑变形。改成紧挨着胶囊的同一条边、同一个垂直位置，独立浮出
      // 一个输入条，跟胶囊本身的形状语言脱钩，各自负责各自的形态。
      <div
        className={`voice-dock-input voice-dock-input--${edge}`}
        style={{ top: topPx }}
      >
        <input
          ref={chatInputRef}
          className="voice-dock-input__field"
          value={chatText}
          maxLength={CHAT_MAX_LEN}
          placeholder="说点什么…"
          onChange={e => setChatText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') submitChat();
            if (e.key === 'Escape') { setChatText(''); setChatOpen(false); }
          }}
        />
        <div className="voice-dock-input__send" onClick={submitChat} role="button" aria-label="发送">
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
            onClick={e => { e.stopPropagation(); setChatOpen(true); }}
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
