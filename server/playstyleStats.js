// 打法点评（本场之最）的纯函数：手牌强度分类 + 单手累加器。
// 不依赖 socket / Room，只吃数据、吐数据，方便单测。
const { Hand } = require('pokersolver');

const RANK_ORDER = '23456789TJQKA';

// 'made'：成对及以上 | 'draw'：同花听牌或两头顺听牌 | 'air'：其余
function classifyHoldingStrength(holeCards, board) {
  const cards = [...holeCards, ...board];
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

module.exports = { classifyHoldingStrength };
