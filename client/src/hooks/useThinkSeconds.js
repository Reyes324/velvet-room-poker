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
  const totalMs = Math.max(1, endsAt - startedAt);
  const elapsedMs = Math.max(0, now - startedAt);
  return {
    key: `${startedAt}-${endsAt}`,
    totalMs,
    elapsedMs,
    secondsLeft: Math.max(0, Math.ceil((endsAt - now) / 1000)),
    // 走线环用的 animationDuration/animationDelay 只在这里、这一回合开始
    // 的那一刻算一次，之后原样复用（PlayerSeat 直接读 clock.ringStyle，
    // 不会跟着下面每 250ms 一次的 interval 重算）。CSS 动画从 SVG 挂载起
    // 就已经在按真实挂钟时间自己往前播放了，如果每次 tick 都用新的
    // elapsedMs 重新赋值 animationDelay，等于把"动画自己已经播放的时长"
    // 和"手动算出来的已流逝时长"重复计了一遍，环会以约 2 倍真实速度走完
    // ——这正是 issue #17"倒数还剩 10 秒边框就走完了"的根因（20 秒回合，
    // 2 倍速度下真实过 10 秒时环已经走空，跟反馈的数字精确对应，
    // 2026-08-11 用 Playwright 实测 animationDelay/strokeDashoffset 随时
    // 间的变化率确认，不是猜的）。
    ringStyle: { animationDuration: `${totalMs}ms`, animationDelay: `-${elapsedMs}ms` },
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
  // ringStyle 必须原样保留上一次（key 变化时算的那次）的值——如果这里也
  // 跟着 computeTurnClock 一起重算，就是 issue #17 那个根因原样重现：把
  // 每 250ms 一次的最新 elapsedMs 塞给一条已经在自己按挂钟时间播放的 CSS
  // 动画，会跟动画自身的播放进度重复叠加。
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      setClock(prev => ({ ...computeTurnClock(startedAt, endsAt), ringStyle: prev?.ringStyle }));
    }, 250);
    return () => clearInterval(id);
  }, [active, startedAt, endsAt]);

  return value && value.key === key ? value : null;
}
