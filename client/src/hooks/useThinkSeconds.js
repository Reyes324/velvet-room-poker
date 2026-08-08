import { useState, useEffect, useRef } from 'react';

// Purely client-local, non-authoritative "how long has this player been
// thinking" display. Resets to 0 the moment `isAction` becomes true for
// this seat; ticks up once per second while it stays true. Different
// clients may show slightly different values under network latency — that
// is expected and fine, this is an atmosphere indicator, not a rule.
export function useThinkSeconds(isAction) {
  const [seconds, setSeconds] = useState(0);
  const wasActiveRef = useRef(false);

  useEffect(() => {
    if (isAction && !wasActiveRef.current) setSeconds(0);
    wasActiveRef.current = isAction;
    if (!isAction) return;
    const id = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(id);
  }, [isAction]);

  return seconds;
}

// 回合倒计时 + 走线环的共同数据源（用户反馈 #7「页面没有倒计时」，以及后来
// 加的走线描边）。startedAt/endsAt 是服务端下发的绝对时间戳。
//
// 这两样东西以前是两个独立 hook（各自一个 setTimeout(fn, 0) 起播），会在
// 回合刚开始的那一两帧里各自独立 resolve：一个已经算出新值、另一个还没，
// 期间 PlayerSeat 认为"还没进入计时状态"，于是旧版 UI（金色呼吸边框 +
// 数字方块）先闪一帧，等两边都 resolve 完才切到新版走线环——这就是"新旧动画
// 堆叠"的根因。
//
// 现在改成单一状态源，且换回合时用 React 官方推荐的"渲染期比较 key、不一致
// 就立即 setState"模式（而不是等 effect/timeout）：state 在本次渲染流程内
// 就跟着新的 startedAt/endsAt 一起更新完，不会有中途只有一半数据的过渡帧。
// 之前避免在渲染期读 Date.now() 是怕破坏纯度——但这里只在 key 变化时读一次
// （不是每次渲染都读），且只用于捕捉"这一回合开始时经过了多久"这个一次性
// 基准值，属于 React 文档认可的"渲染期用 key 变化重置状态"写法，不会有多次
// render 结果不一致的问题。
function computeTurnClock(startedAt, endsAt) {
  const now = Date.now();
  return {
    key: `${startedAt}-${endsAt}`,
    totalMs: Math.max(1, endsAt - startedAt),
    elapsedMs: Math.max(0, now - startedAt),
    secondsLeft: Math.max(0, Math.ceil((endsAt - now) / 1000)),
  };
}

// endsAt/startedAt 缺失（人机对战、或还没收到状态）时返回 null——调用方据此
// 回退到 useThinkSeconds 那条正数计时路径，行为跟改动前一致。
export function useTurnClock(isAction, startedAt, endsAt) {
  const active = !!(isAction && startedAt && endsAt);
  const key = active ? `${startedAt}-${endsAt}` : null;

  const [clock, setClock] = useState(() => (active ? computeTurnClock(startedAt, endsAt) : null));
  const clockKeyRef = useRef(clock?.key ?? null);

  // 渲染期重置：key 变了就立刻算好新值再继续渲染，不留一帧空档。setState 在
  // 渲染期调用是 React 认可的"根据 prop 变化重置状态"写法（不是在 effect
  // 里做，避免多一轮 commit）——但下面的 useEffect 仍必须无条件调用，Hooks
  // 的调用顺序不能因为这个分支而改变。
  let value = clock;
  if (clockKeyRef.current !== key) {
    clockKeyRef.current = key;
    value = active ? computeTurnClock(startedAt, endsAt) : null;
    setClock(value);
  }

  // key 没变——同一回合内，只需要每 250ms 刷新一次剩余时间用于秒数显示，
  // 走线环本身靠 CSS animation-delay 走时间，不依赖这个 interval。
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setClock(computeTurnClock(startedAt, endsAt)), 250);
    return () => clearInterval(id);
  }, [active, startedAt, endsAt]);

  return value && value.key === key ? value : null;
}
