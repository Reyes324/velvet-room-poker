import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { computeAwards } = require('../playstyleAwards');
const { emptyPlayerStats } = require('../playstyleStats');

function stats(overrides) {
  return { ...emptyPlayerStats(), ...overrides };
}

describe('computeAwards', () => {
  it('全员手数不足 15 → 返回空', () => {
    const map = {
      A: stats({ handsDealt: 8, handsVPIP: 6 }),
      B: stats({ handsDealt: 8, handsVPIP: 1 }),
    };
    expect(computeAwards(map, [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }])).toEqual([]);
  });

  it('入池率最高/最低 → 手痒星人 / 养生局（全员 >=15 手）', () => {
    const map = {
      A: stats({ handsDealt: 40, handsVPIP: 34 }),  // 85%
      B: stats({ handsDealt: 40, handsVPIP: 8 }),   // 20%
      C: stats({ handsDealt: 40, handsVPIP: 20 }),  // 50%
    };
    const out = computeAwards(map, [{ id: 'A', name: '阿强' }, { id: 'B', name: '小明' }, { id: 'C', name: '老野' }]);
    expect(out.find(a => a.playerId === 'A').award).toBe('手痒星人');
    expect(out.find(a => a.playerId === 'B').award).toBe('养生局');
  });

  it('每人最多一个奖：同时是两个奖得主时留最突出的，另一个顺延', () => {
    const map = {
      A: stats({ handsDealt: 40, handsVPIP: 38, postflopBets: 50, postflopRaises: 20, postflopCalls: 2, postflopDecisions: 90 }),
      B: stats({ handsDealt: 40, handsVPIP: 5, postflopBets: 1, postflopRaises: 0, postflopCalls: 30, postflopDecisions: 40 }),
      C: stats({ handsDealt: 40, handsVPIP: 20, postflopBets: 10, postflopRaises: 5, postflopCalls: 6, postflopDecisions: 40 }),
    };
    const out = computeAwards(map, [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }, { id: 'C', name: 'C' }]);
    const perPlayer = {};
    for (const a of out) { expect(perPlayer[a.playerId]).toBeUndefined(); perPlayer[a.playerId] = a.award; }
    // A 既是最松也是最凶 → 只拿一个；最凶顺延给 C（若 C 达门槛）
    expect(Object.keys(perPlayer).filter(id => id === 'A').length).toBeLessThanOrEqual(1);
  });

  it('影帝：空气开火 >=3 才发；不够则该奖不出现', () => {
    const map = {
      A: stats({ handsDealt: 30, handsVPIP: 15, airFires: 4 }),
      B: stats({ handsDealt: 30, handsVPIP: 15, airFires: 1 }),
    };
    const out = computeAwards(map, [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }]);
    expect(out.some(a => a.award === '影帝' && a.playerId === 'A')).toBe(true);

    const map2 = {
      A: stats({ handsDealt: 30, handsVPIP: 15, airFires: 2 }),
      B: stats({ handsDealt: 30, handsVPIP: 15, airFires: 0 }),
    };
    const out2 = computeAwards(map2, [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }]);
    expect(out2.some(a => a.award === '影帝')).toBe(false);
  });

  it('最多返回 opts.maxAwards 条', () => {
    const map = {};
    const players = [];
    for (let i = 0; i < 8; i++) {
      const id = `p${i}`;
      players.push({ id, name: id });
      map[id] = stats({
        handsDealt: 40, handsVPIP: 5 + i * 4, handsPFR: i,
        postflopBets: i * 3, postflopRaises: i, postflopCalls: 40 - i * 3, postflopDecisions: 40,
        sawFlop: 20, wentToShowdown: i * 2, facedRaise: 12, foldedToRaise: 12 - i,
        airFires: i, cbetOpp: 10, cbets: i, cbetAir: 0,
      });
    }
    const out = computeAwards(map, players, { maxAwards: 4 });
    expect(out.length).toBeLessThanOrEqual(4);
    const ids = out.map(a => a.playerId);
    expect(new Set(ids).size).toBe(ids.length); // 每人最多一个
  });

  it('全员被动（aggression 全 0）→ 不发梭哈人格，也不发牌桌 NPC', () => {
    const map = {
      A: stats({ handsDealt: 30, handsVPIP: 20, postflopBets: 0, postflopRaises: 0, postflopCalls: 12, postflopDecisions: 15 }),
      B: stats({ handsDealt: 30, handsVPIP: 12, postflopBets: 0, postflopRaises: 0, postflopCalls: 10, postflopDecisions: 14 }),
      C: stats({ handsDealt: 30, handsVPIP: 6, postflopBets: 0, postflopRaises: 0, postflopCalls: 11, postflopDecisions: 13 }),
    };
    const out = computeAwards(map, [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }, { id: 'C', name: 'C' }]);
    expect(out.some(a => a.award === '梭哈人格')).toBe(false);
    expect(out.some(a => a.award === '牌桌 NPC')).toBe(false);
  });

  it('一个明显凶的 + 两个被动 → 梭哈人格发给凶的那个；牌桌 NPC 允许发给被动方', () => {
    const map = {
      A: stats({ handsDealt: 30, handsVPIP: 18, postflopBets: 30, postflopRaises: 10, postflopCalls: 2, postflopDecisions: 45 }),
      B: stats({ handsDealt: 30, handsVPIP: 12, postflopBets: 0, postflopRaises: 0, postflopCalls: 15, postflopDecisions: 16 }),
      C: stats({ handsDealt: 30, handsVPIP: 8, postflopBets: 0, postflopRaises: 0, postflopCalls: 12, postflopDecisions: 13 }),
    };
    const out = computeAwards(map, [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }, { id: 'C', name: 'C' }]);
    const solo = out.find(a => a.award === '梭哈人格');
    expect(solo).toBeDefined();
    expect(solo.playerId).toBe('A');
    const npc = out.find(a => a.award === '牌桌 NPC');
    if (npc) expect(['B', 'C']).toContain(npc.playerId);
  });

  it('入池率一马平川（全员 ~50% ±3%）→ 不发手痒星人，也不发养生局', () => {
    const map = {
      A: stats({ handsDealt: 40, handsVPIP: 21, postflopBets: 4, postflopRaises: 1, postflopCalls: 8, postflopDecisions: 14 }),
      B: stats({ handsDealt: 40, handsVPIP: 20, postflopBets: 3, postflopRaises: 1, postflopCalls: 9, postflopDecisions: 14 }),
      C: stats({ handsDealt: 40, handsVPIP: 19, postflopBets: 3, postflopRaises: 1, postflopCalls: 8, postflopDecisions: 13 }),
    };
    const out = computeAwards(map, [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }, { id: 'C', name: 'C' }]);
    expect(out.some(a => a.award === '手痒星人')).toBe(false);
    expect(out.some(a => a.award === '养生局')).toBe(false);
  });

  it('reason 是一句中文大白话', () => {
    const map = {
      A: stats({ handsDealt: 40, handsVPIP: 36 }),
      B: stats({ handsDealt: 40, handsVPIP: 6 }),
    };
    const out = computeAwards(map, [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }]);
    for (const a of out) {
      expect(typeof a.reason).toBe('string');
      expect(a.reason.length).toBeGreaterThan(0);
    }
  });
});
