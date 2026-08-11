import { useState, useEffect } from 'react';

// 把一个服务端下发的绝对时间戳（endsAt）转成本地每秒刷新的"还剩几秒"。
// 原本只在 SettlementModal 里用（结算画面自动推进倒计时），现在破产决策
// 弹窗（BustDecisionModal/BustWaitModal）也需要同一种"绝对时间戳→倒计时
// 秒数"的展示，提出来共享，不是新逻辑。
//
// null 表示没有倒计时信息（旧服务端，或当前没有对应的计时状态），这时
// 调用方应退回到原来的纯等待文案。
export function useSecondsLeft(endsAt) {
  // Date.now() 只在回调里读，不在渲染期、也不在 effect 体内同步 setState
  // ——这两种写法 eslint 的 react-hooks 规则都会拦（前者不纯，后者会引发
  // 级联渲染）。首次取值走一个 0ms 的 timeout，同样是回调。
  const [left, setLeft] = useState(null);

  useEffect(() => {
    if (!endsAt) { setLeft(null); return; }
    const update = () => setLeft(Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)));
    const first = setTimeout(update, 0);
    const t = setInterval(update, 250);
    return () => { clearTimeout(first); clearInterval(t); };
  }, [endsAt]);

  return left;
}
