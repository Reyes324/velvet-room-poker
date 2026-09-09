// 打法点评：把全桌计数器变成"本场之最"奖项列表。纯函数。
// 门槛哲学（见 design.md「宽容版」）：这场 >= 15 手才出段；每条奖各有小门槛，
// 撑不起就静默跳过；每人最多一个奖，冲突按"突出程度"顺延。

const MIN_HANDS_FOR_SECTION = 15;

// 每个奖：从哪个指标取、取最大还是最小、得主要满足的门槛、文案模板。
// metric(s) 入参是单个玩家的 stats；gate(s, ctx) 返回该玩家能否作为这个奖的得主。
const AWARDS = [
  {
    key: '手痒星人', dir: 'max',
    metric: s => s.handsDealt ? s.handsVPIP / s.handsDealt : 0,
    // 全桌入池率挤在一起时（极差 < 0.20）没人算"标新立异"，不发。
    gate: (s, ctx) => ctx.everyoneHas15 && ctx.vpipSpread >= 0.20,
    reason: (s, v) => `入池率 ${pct(v)}，什么牌都想下场`,
  },
  {
    key: '养生局', dir: 'min',
    metric: s => s.handsDealt ? s.handsVPIP / s.handsDealt : 1,
    gate: (s, ctx) => ctx.everyoneHas15 && ctx.vpipSpread >= 0.20,
    reason: (s, v) => `入池率 ${pct(v)}，非大牌不玩`,
  },
  {
    key: '梭哈人格', dir: 'max',
    metric: s => aggression(s),
    // 得主自己真的够凶：下注加注至少和跟注一样多（aggression >= 1）。
    gate: s => s.postflopDecisions >= 10 && aggression(s) >= 1,
    reason: (s, v) => `翻后进攻性拉满（下注加注是跟注的 ${v.toFixed(1)} 倍）`,
  },
  {
    key: '牌桌 NPC', dir: 'min',
    metric: s => aggression(s),
    // 得主自己够被动（aggression < 0.5），且桌上真有个凶人（别人 aggression >= 1）作对照；
    // 全桌都被动时"最被动"不算突出，不发。
    gate: (s, ctx) => s.postflopDecisions >= 10 && aggression(s) < 0.5 && ctx.anyOtherAggressive(s),
    reason: () => `翻后几乎从不主动，全程跟着走`,
  },
  {
    key: '我倒要看看', dir: 'max',
    metric: s => s.sawFlop ? s.wentToShowdown / s.sawFlop : 0,
    gate: (s, ctx) => s.sawFlop >= 15 && ctx.margin('wtsd', s) >= 0.12,
    reason: (s, v) => `摊牌率 ${pct(v)}，几乎不弃牌`,
  },
  {
    key: '秒怂', dir: 'max',
    metric: s => s.facedRaise ? s.foldedToRaise / s.facedRaise : 0,
    gate: s => s.facedRaise >= 8,
    reason: (s, v) => `面对下注 ${pct(v)} 直接弃`,
  },
  {
    key: '影帝', dir: 'max',
    metric: s => s.airFires,
    gate: s => s.airFires >= 3,
    reason: s => `空手大举下注 ${s.airFires} 次，面不改色`,
  },
  {
    key: '惯性开火', dir: 'max',
    metric: s => s.cbetOpp ? s.cbets / s.cbetOpp : 0,
    gate: s => s.cbetOpp >= 8,
    reason: (s, v) => `当加注方进到翻牌，${pct(v)} 都会再开一枪`,
  },
  {
    key: '加你一脸', dir: 'max',
    metric: s => s.light3bet,
    gate: s => s.light3bet >= 2,
    reason: s => `别人加注后又反手再加 ${s.light3bet} 次`,
  },
];

function pct(v) { return `${Math.round(v * 100)}%`; }
function aggression(s) {
  const aggro = s.postflopBets + s.postflopRaises;
  return aggro / Math.max(1, s.postflopCalls);
}

function computeAwards(statsMap, players, opts = {}) {
  const maxAwards = opts.maxAwards ?? 5;
  const present = players.filter(p => statsMap[p.id]);
  if (present.length < 2) return [];

  const totalHands = Math.max(0, ...present.map(p => statsMap[p.id].handsDealt));
  if (totalHands < MIN_HANDS_FOR_SECTION) return [];

  const everyoneHas15 = present.every(p => statsMap[p.id].handsDealt >= 15);

  // "偏离中位数多少"——给"我倒要看看"这种要求"明显偏高"的奖用
  function margin(kind, s) {
    if (kind === 'wtsd') {
      const vals = present.map(p => {
        const x = statsMap[p.id];
        return x.sawFlop ? x.wentToShowdown / x.sawFlop : 0;
      }).sort((a, b) => a - b);
      const med = vals[Math.floor(vals.length / 2)];
      const mine = s.sawFlop ? s.wentToShowdown / s.sawFlop : 0;
      return mine - med;
    }
    return 0;
  }
  // 全桌入池率的极差——给"手痒星人/养生局"判断"这桌到底有没有明显的松/紧分化"。
  const vpipRates = present.map(p => {
    const x = statsMap[p.id];
    return x.handsDealt ? x.handsVPIP / x.handsDealt : 0;
  });
  const vpipSpread = (Math.max(...vpipRates) - Math.min(...vpipRates)) || 0;

  // 桌上除了 s 以外，有没有别的在场玩家是真凶（aggression >= 1）——给"牌桌 NPC"做对照。
  function anyOtherAggressive(s) {
    return present.some(p => statsMap[p.id] !== s && aggression(statsMap[p.id]) >= 1);
  }

  const ctx = { everyoneHas15, margin, vpipSpread, anyOtherAggressive };

  // 每个奖先算候选：按 dir 排序，取满足 gate 的第一名；记 (winner, value, gap)
  // gap = |first - second| / (max - min + eps)，代表这个人在这个维度多离谱
  const candidates = [];
  for (const def of AWARDS) {
    const ranked = present
      .map(p => ({ id: p.id, name: p.name, v: def.metric(statsMap[p.id]) }))
      .sort((a, b) => def.dir === 'max' ? b.v - a.v : a.v - b.v);
    const vals = ranked.map(r => r.v);
    const spread = (Math.max(...vals) - Math.min(...vals)) || 1e-9;
    const winner = ranked.find(r => def.gate(statsMap[r.id], ctx));
    if (!winner) continue;
    const idxInRanked = ranked.findIndex(r => r.id === winner.id);
    const next = ranked[idxInRanked + 1];
    const gap = next ? Math.abs(winner.v - next.v) / spread : 1;
    // 奖项可声明 minGap：得主在这个维度没拉开足够差距（gap 不达标）就静默跳过。
    if (typeof def.minGap === 'number' && gap < def.minGap) continue;
    candidates.push({
      award: def.key, playerId: winner.id, playerName: winner.name,
      value: winner.v, gap,
      reason: def.reason(statsMap[winner.id], winner.v),
      _def: def, _ranked: ranked,
    });
  }

  // 每人最多一个奖：按 gap 降序处理；一个人已拿奖则这个奖顺延给 _ranked 里
  // 下一个满足 gate 且尚未拿奖的人（顺延后不重算 gap，用一个略降的值排序）。
  candidates.sort((a, b) => b.gap - a.gap);
  const takenBy = new Set();      // playerId
  const result = [];
  for (const c of candidates) {
    if (!takenBy.has(c.playerId)) {
      takenBy.add(c.playerId);
      result.push({ award: c.award, playerId: c.playerId, playerName: c.playerName, reason: c.reason });
      continue;
    }
    // 顺延
    const alt = c._ranked.find(r => !takenBy.has(r.id) && c._def.gate(statsMap[r.id], ctx));
    if (alt) {
      takenBy.add(alt.id);
      result.push({ award: c.award, playerId: alt.id, playerName: alt.name, reason: c._def.reason(statsMap[alt.id], alt.v) });
    }
  }

  // 上限：按处理顺序（已是 gap 优先）截断
  return result.slice(0, maxAwards);
}

module.exports = { computeAwards };
