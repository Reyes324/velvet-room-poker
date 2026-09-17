// 打法点评（本场之最）的纯函数：手牌强度分类 + 单手累加器。
// 不依赖 socket / Room，只吃数据、吐数据，方便单测。
const { Hand } = require('pokersolver');

const RANK_ORDER = '23456789TJQKA';

// 牌可能是原始字符串（如 'Th'），也可能是 GameEngine.parseCard 产出的对象
// { rank, suit, color, raw }——生产链路传的是后者。统一归一化到原始字符串，
// 让下面的分类逻辑无论上游传什么都自洽。
const rawOf = (c) => (typeof c === 'string' ? c : (c && c.raw) || null);

// 'made'：成对及以上 | 'draw'：同花听牌或两头顺听牌 | 'air'：其余
function classifyHoldingStrength(holeCards, board) {
  const cards = [...holeCards, ...board].map(rawOf).filter(Boolean);
  if (cards.length < 5) return 'air';
  const solved = Hand.solve(cards);
  if (solved.name !== 'High Card') return 'made';

  // 同花听牌：任一花色出现 >= 4 次
  const suitCounts = {};
  for (const c of cards) suitCounts[c[1]] = (suitCounts[c[1]] || 0) + 1;
  if (Object.values(suitCounts).some(n => n >= 4)) return 'draw';

  // 两头顺听牌：存在 4 个连续 rank（A 可高可低）。只认两头顺，不认卡顺。
  const idxSet = new Set();
  for (const c of cards) {
    const i = RANK_ORDER.indexOf(c[0]);
    idxSet.add(i);
    if (c[0] === 'A') idxSet.add(-1); // A 也当作 2 之下一格
  }
  const sorted = [...idxSet].sort((a, b) => a - b);
  let run = 1;
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k] === sorted[k - 1] + 1) {
      run += 1;
      if (run >= 4) return 'draw';
    } else {
      run = 1;
    }
  }
  return 'air';
}

function emptyPlayerStats() {
  return {
    handsDealt: 0, handsVPIP: 0, handsPFR: 0, light3bet: 0,
    postflopBets: 0, postflopRaises: 0, postflopCalls: 0, postflopDecisions: 0,
    sawFlop: 0, wentToShowdown: 0, facedRaise: 0, foldedToRaise: 0,
    airFires: 0, cbetOpp: 0, cbets: 0, cbetAir: 0,
  };
}

const STREET_BOARD_LEN = { flop: 3, turn: 4, river: 5 };

// 进攻意图由引擎在 actionLog 里显式带出（label.aggressive）：真正的下注/加注
// （含加注型全下）才是 true。纯全下跟注、封顶降级成的 call 虽然 type 仍是
// 'allin'，但 aggressive 为 false，这里完全按 call 处理。
const isAggro = (a) => a.aggressive === true;
// 非进攻的放钱动作：跟注，或 type 标成 'allin' 但其实是全下跟注。
const isCallLike = (a) => !isAggro(a) && (a.type === 'call' || a.type === 'allin');

// 原地累加：把一手的 actionLog + 底牌 + 公共牌，摊进每个玩家的 per-hand 计数器。
// hand: { actionLog:[{playerId,phase,type,amount}], allHoleCards:[{id,holeCards}], communityCards:[], dealtInIds:[] }
function accumulateHand(statsMap, hand) {
  const { actionLog, allHoleCards, communityCards, dealtInIds } = hand;
  const get = (id) => (statsMap[id] || (statsMap[id] = emptyPlayerStats()));
  const holeOf = (id) => {
    const h = allHoleCards.find((c) => c.id === id)?.holeCards;
    return h ? h.map(rawOf).filter(Boolean) : null;
  };
  const boardFor = (phase) =>
    communityCards.slice(0, STREET_BOARD_LEN[phase] ?? 0).map(rawOf).filter(Boolean);

  for (const id of dealtInIds) get(id).handsDealt += 1;

  // ── 翻前 ──
  const preflop = actionLog.filter((a) => a.phase === 'preflop');

  // VPIP / PFR：每手每人最多 +1（主动放钱 / 主动加注，都是布尔）
  for (const id of new Set(preflop.map((a) => a.playerId))) {
    const acts = preflop.filter((a) => a.playerId === id);
    // 主动放钱：跟注 / 加注 / 全下（全下跟注也算自愿入池）。
    if (acts.some((a) => a.type === 'call' || a.type === 'allin' || isAggro(a))) get(id).handsVPIP += 1;
    // 主动加注：只认带进攻意图的动作。
    if (acts.some(isAggro)) get(id).handsPFR += 1;
  }

  // light3bet：某人加注之前，盘面已经有过别人的加注（即不是本手第一次加注）。每手每人最多 +1。
  let seenPreflopRaise = false;
  const countedLight3bet = new Set();
  for (const a of preflop) {
    if (!isAggro(a)) continue;
    if (seenPreflopRaise && !countedLight3bet.has(a.playerId)) {
      get(a.playerId).light3bet += 1;
      countedLight3bet.add(a.playerId);
    }
    seenPreflopRaise = true;
  }

  // 翻前最后加注方（cbet 判定用）
  let preflopAggressor = null;
  for (const a of preflop) if (isAggro(a)) preflopAggressor = a.playerId;

  // 翻前就弃牌的人
  const foldedPreflop = new Set();
  for (const a of preflop) if (a.type === 'fold') foldedPreflop.add(a.playerId);

  // ── 翻后（flop / turn / river）──
  const sawFlop = communityCards.length >= 3;
  const sawFlopIds = sawFlop ? dealtInIds.filter((id) => !foldedPreflop.has(id)) : [];
  for (const id of sawFlopIds) get(id).sawFlop += 1;

  const foldedAnyStreet = new Set(foldedPreflop);
  for (const a of actionLog) if (a.type === 'fold') foldedAnyStreet.add(a.playerId);
  // 真正摊牌：一手结束时还有 >= 2 人没弃牌（不是「打光所有人只剩一个」）
  const showdownReached = (dealtInIds.length - foldedAnyStreet.size) >= 2;

  for (const phase of ['flop', 'turn', 'river']) {
    const street = actionLog.filter((a) => a.phase === phase);
    if (street.length === 0) continue;
    const board = boardFor(phase);
    let betOpened = false;   // 这条街是否已有人下注

    for (const a of street) {
      const s = get(a.playerId);
      s.postflopDecisions += 1;

      // 面对下注 → facedRaise / foldedToRaise。
      // 按 spec（秒怂 = 面对加注弃牌率最高）：翻后轮到自己时面前有需要跟的注，
      // 每一次都计（含未被反加的翻牌 c-bet），弃牌就计 foldedToRaise。
      if (betOpened) {
        if (a.type === 'fold') { s.facedRaise += 1; s.foldedToRaise += 1; }
        else if (isCallLike(a) || isAggro(a)) { s.facedRaise += 1; }
      }

      if (isCallLike(a)) {
        s.postflopCalls += 1;
      } else if (isAggro(a)) {
        const hole = holeOf(a.playerId);
        const cls = hole ? classifyHoldingStrength(hole, board) : 'made';
        if (!betOpened) {
          // 这条街的首个下注 = bet
          betOpened = true;
          if (phase === 'flop' && a.playerId === preflopAggressor) {
            // 标准持续下注：单独计入 cbets / cbetAir，也算一次 postflopBets，不进 airFires
            s.postflopBets += 1;
            s.cbets += 1;
            if (cls === 'air') s.cbetAir += 1;
          } else if (cls === 'air') {
            // 非 c-bet 的空气首注（含转、河的空气开火）：算 airFires（诈唬开火），也算一次街首下注
            s.airFires += 1;
            s.postflopBets += 1;
          } else {
            s.postflopBets += 1;
          }
        } else {
          // 首注之后的加注
          s.postflopRaises += 1;
          if (cls === 'air') s.airFires += 1; // 空气加注 / 空气 check-raise
        }
      }
      // check 不加任何进攻 / 跟注计数，只 postflopDecisions
    }
  }

  // cbetOpp：翻前最后加注方 且 看到翻牌
  if (preflopAggressor && sawFlopIds.includes(preflopAggressor)) {
    get(preflopAggressor).cbetOpp += 1;
  }

  // wentToShowdown：看到翻牌、整手没弃牌、且这一手确实打到了摊牌
  if (showdownReached) {
    for (const id of sawFlopIds) {
      if (!foldedAnyStreet.has(id)) get(id).wentToShowdown += 1;
    }
  }
}

module.exports = { classifyHoldingStrength, emptyPlayerStats, accumulateHand };
