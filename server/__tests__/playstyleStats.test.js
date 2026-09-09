import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { classifyHoldingStrength, emptyPlayerStats, accumulateHand } = require('../playstyleStats');

describe('classifyHoldingStrength', () => {
  it('成对及以上 = made', () => {
    expect(classifyHoldingStrength(['Ah', 'Kd'], ['Ac', '7s', '2d'])).toBe('made'); // 一对A
    expect(classifyHoldingStrength(['5h', '5d'], ['Ac', '7s', '2d'])).toBe('made'); // 口袋对
    expect(classifyHoldingStrength(['Ah', 'Kh'], ['Qh', 'Jh', 'Th'])).toBe('made'); // 皇家同花顺
  });

  it('同花听牌（4 张同花色）= draw', () => {
    expect(classifyHoldingStrength(['Ah', 'Kh'], ['7h', '2h', '9c'])).toBe('draw');
  });

  it('两头顺听牌（4 连张）= draw', () => {
    expect(classifyHoldingStrength(['9c', '8d'], ['7h', '6s', '2c'])).toBe('draw'); // 6-7-8-9
    expect(classifyHoldingStrength(['Ac', '2d'], ['3h', '4s', 'Kc'])).toBe('draw'); // A-2-3-4（A 可低）
  });

  it('没对、没听牌 = air', () => {
    expect(classifyHoldingStrength(['Kc', '7d'], ['Ah', '9s', '2c'])).toBe('air');
    expect(classifyHoldingStrength(['Qc', '4d'], ['Ah', '9s', '2c', 'Js'])).toBe('air');
  });

  it('卡顺听牌不算 draw（只认两头顺）', () => {
    // 9-8 + J-7-2：缺 T，卡顺
    expect(classifyHoldingStrength(['9c', '8d'], ['Jh', '7s', '2c'])).toBe('air');
  });
});

describe('emptyPlayerStats', () => {
  it('所有字段为 0', () => {
    const s = emptyPlayerStats();
    for (const k of ['handsDealt', 'handsVPIP', 'handsPFR', 'light3bet', 'postflopBets',
      'postflopRaises', 'postflopCalls', 'postflopDecisions', 'sawFlop', 'wentToShowdown',
      'facedRaise', 'foldedToRaise', 'airFires', 'cbetOpp', 'cbets', 'cbetAir']) {
      expect(s[k]).toBe(0);
    }
  });
});

describe('accumulateHand', () => {
  // 三人手：A 翻前加注、B 跟、C 弃；翻牌 A 空气持续下注、B 跟；转牌 A 空气再开火、B 弃
  const hand = {
    dealtInIds: ['A', 'B', 'C'],
    communityCards: ['2c', '7d', 'Ts', 'Jh'],
    allHoleCards: [
      { id: 'A', holeCards: ['Kd', '4c'] }, // 翻牌/转牌都是空气
      { id: 'B', holeCards: ['9h', '9s'] }, // 口袋对（made）
      { id: 'C', holeCards: ['2h', '3h'] },
    ],
    actionLog: [
      { playerId: 'A', phase: 'preflop', type: 'raise', amount: 600, aggressive: true },
      { playerId: 'B', phase: 'preflop', type: 'call', amount: 600, aggressive: false },
      { playerId: 'C', phase: 'preflop', type: 'fold', amount: 0, aggressive: false },
      { playerId: 'A', phase: 'flop', type: 'raise', amount: 400, aggressive: true }, // 首个下注 = bet；A 是翻前加注方 → cbet
      { playerId: 'B', phase: 'flop', type: 'call', amount: 400, aggressive: false },
      { playerId: 'A', phase: 'turn', type: 'raise', amount: 800, aggressive: true }, // 转牌空气开火
      { playerId: 'B', phase: 'turn', type: 'fold', amount: 0, aggressive: false },
    ],
  };

  it('VPIP / PFR / 翻后动作 / 摊牌 / cbet / airFires 计数正确', () => {
    const m = {};
    accumulateHand(m, hand);

    expect(m.A.handsDealt).toBe(1);
    expect(m.B.handsDealt).toBe(1);
    expect(m.C.handsDealt).toBe(1);

    expect(m.A.handsVPIP).toBe(1);
    expect(m.A.handsPFR).toBe(1);
    expect(m.B.handsVPIP).toBe(1); // 跟注
    expect(m.B.handsPFR).toBe(0);
    expect(m.C.handsVPIP).toBe(0); // 只弃牌

    expect(m.A.sawFlop).toBe(1);
    expect(m.B.sawFlop).toBe(1);
    expect(m.C.sawFlop).toBe(0);
    expect(m.A.wentToShowdown).toBe(0); // 没打到摊牌（B 转牌弃了，但这里看 A/B 各自）
    expect(m.B.wentToShowdown).toBe(0); // B 转牌 fold

    // A 翻牌：bet（首下注）+ 是翻前加注方 + 空气 → cbet & cbetAir，不计 airFires
    expect(m.A.cbetOpp).toBe(1);
    expect(m.A.cbets).toBe(1);
    expect(m.A.cbetAir).toBe(1);
    expect(m.A.postflopBets).toBe(2); // 翻牌 c-bet + 转牌空气开火，两次街首下注
    // A 转牌 raise（该街首下注也算 bet）+ 空气 → airFires
    expect(m.A.airFires).toBe(1);
    expect(m.A.postflopBets).toBeGreaterThanOrEqual(1);

    // B 面对下注两次：翻牌 c-bet（跟）+ 转牌下注（弃）——I2 回退后翻牌 c-bet 也计 facedRaise
    expect(m.B.facedRaise).toBe(2);
    expect(m.B.foldedToRaise).toBe(1);
    expect(m.B.postflopCalls).toBe(1); // 翻牌跟注
  });

  it('同一 map 连续喂两手会累加', () => {
    const m = {};
    accumulateHand(m, hand);
    accumulateHand(m, hand);
    expect(m.A.handsDealt).toBe(2);
    expect(m.A.airFires).toBe(2);
  });

  it('light3bet：翻前有人先加注、自己再加注', () => {
    const m = {};
    accumulateHand(m, {
      dealtInIds: ['A', 'B'],
      communityCards: [],
      allHoleCards: [{ id: 'A', holeCards: ['7c', '2d'] }, { id: 'B', holeCards: ['As', 'Ad'] }],
      actionLog: [
        { playerId: 'A', phase: 'preflop', type: 'raise', amount: 600, aggressive: true },
        { playerId: 'B', phase: 'preflop', type: 'raise', amount: 1800, aggressive: true }, // 3-bet
        { playerId: 'A', phase: 'preflop', type: 'fold', amount: 0, aggressive: false },
      ],
    });
    expect(m.B.light3bet).toBe(1);
    expect(m.A.light3bet).toBe(0);
  });
});

describe('accumulateHand — C1：牌是 parseCard 对象（生产链路的真实形状）', () => {
  const { parseCard } = require('../GameEngine');

  it('喂 parseCard 对象数组，made / draw / air 都能正确判', () => {
    // made：一对 A
    expect(classifyHoldingStrength(
      ['Ah', 'Kd'].map(parseCard),
      ['Ac', '7s', '2d'].map(parseCard),
    )).toBe('made');
    // draw：4 张同花
    expect(classifyHoldingStrength(
      ['Ah', 'Kh'].map(parseCard),
      ['7h', '2h', '9c'].map(parseCard),
    )).toBe('draw');
    // air：没对没听牌
    expect(classifyHoldingStrength(
      ['Kc', '7d'].map(parseCard),
      ['Ah', '9s', '2c'].map(parseCard),
    )).toBe('air');
  });

  it('accumulateHand 用 parseCard 对象也能算出 cbetAir / airFires（此前恒为 0）', () => {
    const m = {};
    accumulateHand(m, {
      dealtInIds: ['A', 'B'],
      communityCards: ['2c', '7d', 'Ts', 'Jh', '4s'].map(parseCard),
      allHoleCards: [
        { id: 'A', holeCards: ['Kd', '4c'].map(parseCard) }, // 全程空气
        { id: 'B', holeCards: ['9h', '9s'].map(parseCard) },
      ],
      actionLog: [
        { playerId: 'A', phase: 'preflop', type: 'raise', amount: 600, aggressive: true },
        { playerId: 'B', phase: 'preflop', type: 'call', amount: 600, aggressive: false },
        { playerId: 'A', phase: 'flop', type: 'raise', amount: 400, aggressive: true }, // 空气 c-bet
        { playerId: 'B', phase: 'flop', type: 'call', amount: 400, aggressive: false },
        { playerId: 'A', phase: 'turn', type: 'raise', amount: 800, aggressive: true }, // 空气开火
        { playerId: 'B', phase: 'turn', type: 'fold', amount: 0, aggressive: false },
      ],
    });
    expect(m.A.cbetAir).toBe(1);
    expect(m.A.airFires).toBe(1);
  });
});

describe('accumulateHand — C2：全下跟注不算进攻', () => {
  it('type:allin 但 aggressive:false 按 call 处理（记 VPIP/postflopCalls，不记 PFR/airFires/cbet）', () => {
    const m = {};
    accumulateHand(m, {
      dealtInIds: ['A', 'B'],
      communityCards: ['2c', '7d', 'Ts'],
      allHoleCards: [
        { id: 'A', holeCards: ['Kd', '4c'] }, // 空气
        { id: 'B', holeCards: ['9h', '9s'] },
      ],
      actionLog: [
        // A 短码全下跟注：引擎标 type:'allin' 但 aggressive:false
        { playerId: 'A', phase: 'preflop', type: 'allin', amount: 300, aggressive: false },
        { playerId: 'B', phase: 'preflop', type: 'raise', amount: 600, aggressive: true },
        { playerId: 'A', phase: 'flop', type: 'allin', amount: 0, aggressive: false },
      ],
    });
    expect(m.A.handsVPIP).toBe(1);      // 自愿入池
    expect(m.A.handsPFR).toBe(0);       // 不是主动加注
    expect(m.A.light3bet).toBe(0);
    expect(m.A.airFires).toBe(0);       // 没有诈唬开火
    expect(m.A.cbets).toBe(0);
    expect(m.A.postflopCalls).toBe(1);  // 翻牌那条 allin(call) 记成跟注
    // B 才是翻前加注方
    expect(m.B.handsPFR).toBe(1);
  });
});

describe('accumulateHand — I4：边界手', () => {
  it('翻牌圈就结束（无 turn/river 条目）不崩、计数合理', () => {
    const m = {};
    expect(() => accumulateHand(m, {
      dealtInIds: ['A', 'B'],
      communityCards: ['2c', '7d', 'Ts'],
      allHoleCards: [
        { id: 'A', holeCards: ['Kd', '4c'] },
        { id: 'B', holeCards: ['9h', '9s'] },
      ],
      actionLog: [
        { playerId: 'A', phase: 'preflop', type: 'raise', amount: 600, aggressive: true },
        { playerId: 'B', phase: 'preflop', type: 'call', amount: 600, aggressive: false },
        { playerId: 'A', phase: 'flop', type: 'raise', amount: 400, aggressive: true },
        { playerId: 'B', phase: 'flop', type: 'fold', amount: 0, aggressive: false },
      ],
    })).not.toThrow();
    expect(m.A.sawFlop).toBe(1);
    expect(m.A.cbets).toBe(1);
    expect(m.B.foldedToRaise).toBe(1);
    expect(m.A.wentToShowdown).toBe(0);
  });

  it('翻前就弃、零动作的玩家：handsDealt 记，其它 0', () => {
    const m = {};
    accumulateHand(m, {
      dealtInIds: ['A', 'B', 'C'],
      communityCards: [],
      allHoleCards: [
        { id: 'A', holeCards: ['Kd', '4c'] },
        { id: 'B', holeCards: ['9h', '9s'] },
        { id: 'C', holeCards: ['2h', '3h'] },
      ],
      actionLog: [
        { playerId: 'A', phase: 'preflop', type: 'raise', amount: 600, aggressive: true },
        { playerId: 'B', phase: 'preflop', type: 'fold', amount: 0, aggressive: false },
        { playerId: 'C', phase: 'preflop', type: 'fold', amount: 0, aggressive: false },
      ],
    });
    expect(m.C.handsDealt).toBe(1);
    expect(m.C.handsVPIP).toBe(0);
    expect(m.C.sawFlop).toBe(0);
    expect(m.C.postflopDecisions).toBe(0);
  });

  it('单挑一手：两人计数各自独立', () => {
    const m = {};
    accumulateHand(m, {
      dealtInIds: ['A', 'B'],
      communityCards: ['2c', '7d', 'Ts', 'Jh', '4s'],
      allHoleCards: [
        { id: 'A', holeCards: ['Ah', 'Kd'] },
        { id: 'B', holeCards: ['9h', '9s'] },
      ],
      actionLog: [
        { playerId: 'A', phase: 'preflop', type: 'raise', amount: 600, aggressive: true },
        { playerId: 'B', phase: 'preflop', type: 'call', amount: 600, aggressive: false },
        { playerId: 'A', phase: 'flop', type: 'check', amount: 0, aggressive: false },
        { playerId: 'B', phase: 'flop', type: 'check', amount: 0, aggressive: false },
        { playerId: 'A', phase: 'turn', type: 'check', amount: 0, aggressive: false },
        { playerId: 'B', phase: 'turn', type: 'check', amount: 0, aggressive: false },
        { playerId: 'A', phase: 'river', type: 'check', amount: 0, aggressive: false },
        { playerId: 'B', phase: 'river', type: 'check', amount: 0, aggressive: false },
      ],
    });
    expect(m.A.handsDealt).toBe(1);
    expect(m.B.handsDealt).toBe(1);
    expect(m.A.wentToShowdown).toBe(1);
    expect(m.B.wentToShowdown).toBe(1);
  });

  it('真正的多人摊牌：跟到底的人 wentToShowdown === 1', () => {
    const m = {};
    accumulateHand(m, {
      dealtInIds: ['A', 'B', 'C'],
      communityCards: ['2c', '7d', 'Ts', 'Jh', '4s'],
      allHoleCards: [
        { id: 'A', holeCards: ['Ah', 'Kd'] },
        { id: 'B', holeCards: ['9h', '9s'] },
        { id: 'C', holeCards: ['Qc', 'Qd'] },
      ],
      actionLog: [
        { playerId: 'A', phase: 'preflop', type: 'raise', amount: 600, aggressive: true },
        { playerId: 'B', phase: 'preflop', type: 'call', amount: 600, aggressive: false },
        { playerId: 'C', phase: 'preflop', type: 'call', amount: 600, aggressive: false },
        { playerId: 'A', phase: 'flop', type: 'check', amount: 0, aggressive: false },
        { playerId: 'B', phase: 'flop', type: 'check', amount: 0, aggressive: false },
        { playerId: 'C', phase: 'flop', type: 'check', amount: 0, aggressive: false },
        { playerId: 'A', phase: 'turn', type: 'check', amount: 0, aggressive: false },
        { playerId: 'B', phase: 'turn', type: 'check', amount: 0, aggressive: false },
        { playerId: 'C', phase: 'turn', type: 'check', amount: 0, aggressive: false },
        { playerId: 'A', phase: 'river', type: 'check', amount: 0, aggressive: false },
        { playerId: 'B', phase: 'river', type: 'check', amount: 0, aggressive: false },
        { playerId: 'C', phase: 'river', type: 'check', amount: 0, aggressive: false },
      ],
    });
    expect(m.A.wentToShowdown).toBe(1);
    expect(m.B.wentToShowdown).toBe(1);
    expect(m.C.wentToShowdown).toBe(1);
  });
});
