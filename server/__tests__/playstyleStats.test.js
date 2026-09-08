import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { classifyHoldingStrength } = require('../playstyleStats');

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
