import { useState, useEffect, useRef } from 'react';
import { useSecondsLeft } from '../hooks/useSecondsLeft';

// Shown to a player the moment their own chips hit 0 — the room holds the
// next hand until they resolve this (see RoomPage's awaitingBustResolution
// handling), so everyone else sees a matching "等待中" modal in the
// meantime rather than the game silently moving on without them.
//
// "旁观留下" was cut once (see git history) because it didn't clearly
// resolve the room's pause — a player picking it just sat there, still
// blocking everyone else. Brought back under the sit-out design (2026-08-08):
// picking it now explicitly resolves the pause (server: Room.spectate),
// same as rebuy/leave do — the room continues immediately, this player
// just falls out of the next hand like any other spectator. No
// backdrop-dismiss, since every path here does end in a real resolution.
//
// `onSpectate` is optional — PvePage doesn't pass it. Watching AI-vs-AI
// with no other human at the table has no audience to spectate for, so
// that surface keeps the original two-choice modal (rebuy or exit).
// bustDecisionEndsAt：服务端的破产决策超时兜底（server/index.js 的
// BUST_DECISION_TIMEOUT_MS，20 秒），本来就存在——之前只是没有可见倒计时、
// 时限还长达 5 分钟。用户反馈（2026-08-12）：其他玩家陪等太久；这个人自己
// 的弹窗也该让他知道还剩多久。到点仍未决策，服务端会自动帮他标记离开
// （markLeft），这里在客户端同步触发 onLeave 只是让本地体验立刻跟上（真正
// 生效的是服务端那一份，onLeave 内部走的还是原有的 leaveRoom 流程）。
export default function BustDecisionModal({ onRebuy, onSpectate, onLeave, bustDecisionEndsAt = null }) {
  const [pending, setPending] = useState(false);
  const secondsLeft = useSecondsLeft(bustDecisionEndsAt);
  const autoLeftRef = useRef(false);

  useEffect(() => {
    autoLeftRef.current = false;
  }, [bustDecisionEndsAt]);

  useEffect(() => {
    if (secondsLeft !== 0 || autoLeftRef.current) return;
    autoLeftRef.current = true;
    onLeave();
  }, [secondsLeft, onLeave]);

  function handleRebuy() {
    if (pending) return;
    setPending(true);
    onRebuy();
    setTimeout(() => setPending(false), 3000); // safety-net reset if room:state never arrives
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-title">筹码已用完</div>
        <div className="modal-body">
          要再借一底回到牌桌{onSpectate ? '，先旁观看看，' : '，'}还是退出本局对局？
          {secondsLeft != null && <div className="modal-bust-countdown">{secondsLeft} 秒后自动退出</div>}
        </div>
        <div className="modal-btns">
          <div
            className={`modal-btn modal-btn--paired${pending ? ' modal-btn--waiting' : ''}`}
            onClick={handleRebuy}
          >
            +借一底
          </div>
          {onSpectate && <div className="modal-btn modal-btn--paired" onClick={onSpectate}>旁观留下</div>}
          <div className="modal-btn-danger" onClick={onLeave}>退出对局</div>
        </div>
      </div>
    </div>
  );
}
