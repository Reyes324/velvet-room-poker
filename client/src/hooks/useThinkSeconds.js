import { useState, useEffect, useRef } from 'react';

// Purely client-local, non-authoritative "how long has this player been
// thinking" display. Resets to 0 the moment `isAction` becomes true for
// this seat; ticks up once per second while it stays true. Different
// clients may show slightly different values under network latency — that
// is expected and fine, this is an atmosphere indicator, not a rule.
// 回合倒计时（用户反馈 #7「页面没有倒计时」）。endsAt 是服务端下发的绝对时
// 间戳，各客户端跟自己的 Date.now() 相减即可，不用来回问服务端。
//
// endsAt 为空时返回 null——调用方据此回退到上面那个正数计时。人机对战没有回
// 合倒计时（只有一个真人，不存在"拖住别人"这回事），走的正是这条回退路径。
//
// Date.now() 只在回调里读：写在渲染期会违反 react-hooks 的纯度规则，写在
// effect 体内同步 setState 又会触发级联渲染警告。首次取值走一个 0ms 的
// timeout，同样属于回调。
export function useCountdownSeconds(endsAt) {
  // 把值和它所属的 endsAt 绑在一起存。渲染期只做一次比较（纯操作），
  // setState 只发生在回调里——两条 react-hooks 规则都不碰。
  //
  // 绑定是必需的：不绑的话，新回合的头一两帧会渲染上一回合结束时那个 0，而
  // 0 同时会触发"最后 5 秒"的红色脉动，于是每个回合刚开始都闪一下红，正好和
  // 它要表达的意思相反。
  const [tick, setTick] = useState(null); // { endsAt, left } | null

  useEffect(() => {
    if (!endsAt) return;
    const update = () => setTick({ endsAt, left: Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)) });
    const first = setTimeout(update, 0);
    const id = setInterval(update, 250);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [endsAt]);

  return endsAt && tick?.endsAt === endsAt ? tick.left : null;
}

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
