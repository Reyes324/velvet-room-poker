// PVE AI 风格平衡性检查——用户反馈"太容易赢了"（2026-08-02）排查过程中写
// 出来的诊断脚本，正式收进仓库供以后调 STYLE_EV_BIAS 参数时重复跑。
//
// 用法：node scripts/pveBalanceCheck.js [seatCount] [trials] [handsPerTrial]
// 默认：seatCount=4 trials=6 handsPerTrial=200
//
// 原理：让人类座位每手都直接弃牌（零技巧输入），只跑 PveSession 自己的
// aiAction()——它本身同步、无延迟，天然适合脚本化批量跑（见其类注释），
// 不用起 socket/server，几秒钟能跑完几千手。多组独立试验分开跑（不是一次
// 跑更多手数）是为了区分"某个风格这一把手气差"和"某个风格结构性送筹码"：
// 前者输赢方向会在不同试验之间反转，后者会稳定地每次都输（或赢）。
//
// 怎么读结果：如果哪个风格在几乎每一组试验里都是同一个方向（全输或全
// 赢），且量级远超其他风格，那大概率是 STYLE_EV_BIAS 里的某个偏差参数
// 校准过头了，不是正常的高方差人设——参见 2026-08-02 对 bluffer.
// foldEquityMultiplier 从 1.2 调到 1.05 的那次修复。
//
// 小样本假阳性提醒（同样是 2026-08-02 实测踩过的坑）：默认 trials=6 时，
// 4 人桌每组只随机分到 3 个风格坐位，某个风格单次运行可能只出现 2-3
// 次——"3 组全正"这种结果单看很像系统性偏差，但扩到 15 组之后同一个风格
// 完全可能变成 3 胜 5 负，只是正常方差凑巧撞在一起。下面这个 allSameSign
// 标记只是提示"值得多跑几组确认"，不是"已经确诊有 bug"，看到标记后先把
// trials 提到 15+ 再下结论，不要只看一次 6 组的结果就动参数。
const path = require('path');
const { PveSession } = require(path.join(__dirname, '..', 'PveSession'));

const STARTING_CHIPS = 1000;
const BIG_BLIND = 20;

function foldEveryHand(session) {
  const r = session.humanAction('fold');
  if (r.error) throw new Error('unexpected fold error: ' + r.error);
}

function runOneTrial(seatCount, hands) {
  const fakeStore = { loadProfile: () => null, saveProfile: () => {} };
  const session = new PveSession('probe-player', 'Probe', {
    startingChips: STARTING_CHIPS, bigBlind: BIG_BLIND, seatCount, store: fakeStore,
  });
  let handsPlayed = 0;
  let guard = 0;
  const GUARD_MAX = hands * 500; // 防止未知 bug 导致死循环，不是业务逻辑的一部分
  while (handsPlayed < hands && guard++ < GUARD_MAX) {
    if (session.isOver()) { handsPlayed++; session.readyNext(); continue; }
    if (session.isAiTurn()) { session.aiAction(); continue; }
    foldEveryHand(session);
  }
  if (guard >= GUARD_MAX) {
    throw new Error(`未能在 ${GUARD_MAX} 次循环内跑完 ${hands} 手——可能是死循环 bug，不是正常结果`);
  }
  const byStyle = {};
  for (const p of session.players) {
    if (p.id === 'probe-player') continue;
    const style = session.aiSeats.find(s => s.id === p.id)?.style ?? 'null';
    const net = p.chips - STARTING_CHIPS - (p.debt || 0);
    byStyle[style] = (byStyle[style] || 0) + net;
  }
  return byStyle;
}

function main() {
  const [, , seatCountArg, trialsArg, handsArg] = process.argv;
  const seatCount = Number(seatCountArg) || 4;
  const trials = Number(trialsArg) || 6;
  const handsPerTrial = Number(handsArg) || 200;

  console.log(`PVE 风格平衡性检查：seatCount=${seatCount} trials=${trials} handsPerTrial=${handsPerTrial}\n`);

  const totals = {};
  const perTrialSign = {}; // style -> [+1/-1/0, ...]，用来判断是不是"每次都同一个方向"
  for (let t = 0; t < trials; t++) {
    const r = runOneTrial(seatCount, handsPerTrial);
    console.log(`trial ${t + 1}:`, r);
    for (const [style, net] of Object.entries(r)) {
      totals[style] = (totals[style] || 0) + net;
      (perTrialSign[style] ??= []).push(Math.sign(net));
    }
  }

  console.log(`\n=== 汇总（${trials} 组独立试验 x ${handsPerTrial} 手）===`);
  for (const [style, net] of Object.entries(totals)) {
    const signs = perTrialSign[style];
    const allSameSign = signs.length >= 3 && signs.every(s => s === signs[0] && s !== 0);
    const flag = allSameSign ? '  ⚠️ 每次都是同一个方向，疑似系统性偏差，不是正常方差' : '';
    console.log(`  ${style.padEnd(16)} 汇总净值 = ${String(net).padStart(10)}${flag}`);
  }
}

main();
