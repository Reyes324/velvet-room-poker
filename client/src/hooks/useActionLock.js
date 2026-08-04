import { useState, useRef, useEffect, useCallback } from 'react';
import { getSocket } from './useSocket';

// 玩家点了动作之后、服务器回状态之前，操作栏要先禁掉，避免手抖连点发出两次
// 动作。这个锁本身是必要的，但它原来的实现有个致命缺陷——**只有一条解锁路
// 径**：等 `game:state` 回来。一旦那条状态没回来（断线重连时 emit 丢了、服
// 务器没收到这个动作），锁就永远解不开：操作栏消失、座位上的倒计时却照常
// 走，桌子看起来"卡住了，动不了"。
//
// 这正是用户反馈 #4 的现场（2026-08-04 截图）：翻牌圈、自己是大盲、座位倒计
// 时 44s 在走，底部却写着"等待其他玩家行动…"，没有任何按钮可点。
//
// 关键认知：**这是个乐观锁，而乐观锁必须有兜底解锁路径**。服务器状态才是唯
// 一真相，本地锁只是等待期间的临时 UI 状态，不能让它盖过真相。所以这里给出
// 三条独立的解锁路径，任何一条成立都会释放：
//   1. 收到新的 game:state（正常路径，服务器确认动作已处理）
//   2. socket 重连（重连意味着中间可能丢过消息，页面会重新 sync 状态，
//      此时继续锁着毫无意义）
//   3. 超时兜底（上面两条都没发生——比如服务器压根没收到那个 emit——
//      到点自动释放，把控制权还给玩家）
//
// 提成公共 hook 而不是在两个页面各写一遍：真人局（RoomPage）和人机局
// （PvePage）本来就各有一份逐字相同的锁逻辑，#4 这个 bug 两边都有。修一处
// 漏一处正是这个项目约定里要避免的"打补丁"。
const UNLOCK_TIMEOUT_MS = 8000;

// 直接用模块级的 socket 单例，而不是让调用方把 useSocket 返回的 socket 传
// 进来：两个页面都需要在 useSocket 的 handlers 里调用 unlock（收到 game:state
// 时解锁），而 handlers 是 useSocket 的入参——如果这个 hook 依赖 useSocket 的
// 返回值，就形成了"要先有 socket 才能建锁、要先有锁才能建 handlers"的循环。
export function useActionLock() {
  const socket = getSocket();
  const [locked, setLocked] = useState(false);
  const timerRef = useRef(null);

  const unlock = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = null;
    setLocked(false);
  }, []);

  const lock = useCallback(() => {
    setLocked(true);
    clearTimeout(timerRef.current);
    // 兜底解锁。8 秒的依据：正常一次动作往返在百毫秒量级，服务器还要跑完
    // AI 循环才回状态，留足余量；同时又远短于出牌倒计时（45s），玩家不会
    // 因为这个锁而错过自己的回合。
    timerRef.current = setTimeout(() => setLocked(false), UNLOCK_TIMEOUT_MS);
  }, []);

  useEffect(() => {
    if (!socket) return undefined;
    socket.on('connect', unlock);
    return () => {
      socket.off('connect', unlock);
      clearTimeout(timerRef.current);
    };
  }, [socket, unlock]);

  return { locked, lock, unlock };
}

export { UNLOCK_TIMEOUT_MS };
