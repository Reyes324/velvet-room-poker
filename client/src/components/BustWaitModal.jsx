import { useSecondsLeft } from '../hooks/useSecondsLeft';

// Shown to everyone except the busted player(s) themselves while the room
// is paused (see RoomPage's awaitingBustResolution) — the table already
// stays visible underneath (this never covers the whole screen), it's just
// telling people why the next hand hasn't dealt yet.
//
// 用户反馈（2026-08-12）：这些人没有理由退出游戏，之前唯一的按钮是"退
// 出"——一点手滑就真的离开了对局。改成纯等待：没有任何可点的按钮，弹窗
// 也不会自己消失；唯一给的信息是一个跟归零玩家那边同步的倒计时（同一个
// bustDecisionEndsAt），让人知道不是无限期等待，最多 20 秒左右就会有结
// 果（不管对方是自己选的还是超时被系统自动处理）。
export default function BustWaitModal({ names, bustDecisionEndsAt = null }) {
  const secondsLeft = useSecondsLeft(bustDecisionEndsAt);
  if (!names?.length) return null;
  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-title">等待决策</div>
        <div className="modal-body">{names.join('、')}筹码清空，等待{names.length > 1 ? '他们' : '他'}决策是否再借一底</div>
        <div className="modal-btn-cancel modal-btn-cancel--static" style={{ width: '100%' }}>
          {secondsLeft != null ? `等待中… ${secondsLeft} 秒` : '等待中…'}
        </div>
      </div>
    </div>
  );
}
