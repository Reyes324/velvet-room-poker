// PVE AI 翻前范围诊断（2026-08-03）——用德扑标准指标量化"这个 AI 的打法
// 像不像真人"。
//
// 用法：node scripts/pvePreflopStats.js [seatCount] [hands]
// 默认：seatCount=4 hands=400
//
// VPIP（Voluntarily Put money In Pot）：翻前主动投钱（跟注或加注）的手数
//   占比。盲注是被迫投入，不算；大盲免费过牌也不算。
// PFR（PreFlop Raise）：翻前加注的手数占比。
// 翻后主动率：翻后所有决策里选择下注/加注的比例。
//
// 判读标准（本轮验收）：
//   - PFR 落在 15-25% 附近 = 像真人。100% = 什么牌都加注（2026-08-03 之前
//     的状态）。接近 0% = 矫枉过正成了岩石。
//   - 翻后主动率不能接近 0——AI 仍需保持正常的诈唬/价值下注频率。
// 这两条是**双向**判据，只满足一边不算通过。
const path = require('path');
const { PveSession } = require(path.join(__dirname, '..', 'PveSession'));

function runTrial(seatCount, hands) {
  const fakeStore = { loadProfile: () => null, saveProfile: () => {} };
  const session = new PveSession('probe-player', 'Probe', {
    startingChips: 1000, bigBlind: 20, seatCount, store: fakeStore,
  });
  const styleOf = (id) => session.aiSeats.find((s) => s.id === id)?.style ?? 'unknown';
  // stats[style] = { hands, vpip, pfr, postflopDecisions, postflopAggressive }
  const stats = {};
  const bump = (style, key, by = 1) => {
    stats[style] ??= { hands: 0, vpip: 0, pfr: 0, postflopDecisions: 0, postflopAggressive: 0 };
    stats[style][key] += by;
  };

  let handsPlayed = 0;
  let guard = 0;
  const GUARD_MAX = hands * 500;
  let seenThisHand = new Set();

  while (handsPlayed < hands && guard++ < GUARD_MAX) {
    if (session.isOver()) {
      handsPlayed += 1;
      seenThisHand = new Set();
      session.readyNext();
      continue;
    }
    if (session.isAiTurn()) {
      const actingId = session.actionPlayerId;
      const style = styleOf(actingId);
      const isPreflop = session.game.phase === 'preflop';
      const r = session.aiAction();
      const action = r?.decision?.action;
      if (!action) continue;
      if (isPreflop) {
        // 每手每个座位只统计第一次翻前决策，避免被 3bet 战争重复计数。
        if (!seenThisHand.has(actingId)) {
          seenThisHand.add(actingId);
          bump(style, 'hands');
          if (action === 'call' || action === 'raise' || action === 'allin') bump(style, 'vpip');
          if (action === 'raise' || action === 'allin') bump(style, 'pfr');
        }
      } else {
        bump(style, 'postflopDecisions');
        if (action === 'raise' || action === 'allin') bump(style, 'postflopAggressive');
      }
      continue;
    }
    // 人类座位：每手直接弃牌，把台面完全让给 AI 之间的互动。
    const res = session.humanAction('fold');
    if (res.error) throw new Error('unexpected fold error: ' + res.error);
  }
  if (guard >= GUARD_MAX) throw new Error('循环没能在预算内跑完，可能有死循环 bug');
  return stats;
}

function main() {
  const seatCount = Number(process.argv[2]) || 4;
  const hands = Number(process.argv[3]) || 400;
  console.log(`PVE 翻前范围诊断：seatCount=${seatCount} hands=${hands}\n`);
  const stats = runTrial(seatCount, hands);
  console.log('风格              样本   VPIP    PFR   翻后主动率');
  const totals = { hands: 0, vpip: 0, pfr: 0, postflopDecisions: 0, postflopAggressive: 0 };
  for (const [style, s] of Object.entries(stats)) {
    for (const k of Object.keys(totals)) totals[k] += s[k];
    const pct = (a, b) => (b > 0 ? ((100 * a) / b).toFixed(1) + '%' : '   n/a');
    console.log(
      '  ' + style.padEnd(16) + String(s.hands).padStart(4)
      + pct(s.vpip, s.hands).padStart(8) + pct(s.pfr, s.hands).padStart(7)
      + pct(s.postflopAggressive, s.postflopDecisions).padStart(11),
    );
  }
  const pct = (a, b) => (b > 0 ? ((100 * a) / b).toFixed(1) + '%' : 'n/a');
  console.log('\n=== 合计 ===');
  console.log('  VPIP       = ' + pct(totals.vpip, totals.hands));
  console.log('  PFR        = ' + pct(totals.pfr, totals.hands) + '   （真人约 15-25%；100% = 什么牌都加注；接近 0 = 矫枉过正）');
  console.log('  翻后主动率 = ' + pct(totals.postflopAggressive, totals.postflopDecisions) + '   （不能接近 0，否则 AI 变成岩石）');
}

main();
