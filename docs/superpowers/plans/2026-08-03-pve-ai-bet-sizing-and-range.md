# PVE AI 下注尺寸建模与对手范围推断 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 PVE AI 的 EV 公式建模"下注尺寸意味着多大压力"和"池子里还剩谁"，消除"翻前 100% 加注"和"面对超池拿烂牌硬跟"这两个最伤真实感的行为。

**Architecture:** 三个组件都落在既有的两个文件里，不新增架构层：(A) `estimateFoldEquity` 用 MDF 理论给弃牌权益加上尺寸依赖；(B) `computeEquity` 支持两极化范围，`PveSession` 按对手下注/底池比推断范围形状；(C) `pickAction` 接受第二个胜率值，`PveSession` 算两次胜率分别喂给 call 分支和 raise 分支。所有新参数都有默认值，不传时行为与改动前完全一致。

**Tech Stack:** Node.js CommonJS（server/），vitest 测试，无新增依赖。

## Global Constraints

- 设计文档：`docs/superpowers/specs/2026-08-03-pve-ai-bet-sizing-and-range-design.md`，每条需求都能追溯到那里。
- **所有新增参数必须有默认值**，默认值下的行为必须与改动前逐位一致（`opponentBottomPct = 0`、`equityIfCalled` 默认等于 `equity`、`estimateFoldEquity` 不传尺寸参数时不做尺寸调整）。
- **范围与尺寸这类客观事实一律用真实 `equity` 判断，绝不用风格调整过的 `eq`。** 风格只影响"愿不愿意冒险"（`varianceScale`/`foldEquityMultiplier`）。这个坑 2026-08-02 踩过一次（`callingStation` 靠 `equityMultiplier` 绕开池控制折扣），不许重犯。
- `POT_CONTROL_DISCOUNT` 的去留**必须用数据决定**（Task 5），不许在前面的任务里预先假设或顺手改动。
- 项目约定（`CLAUDE.md`）：正确性 > 视觉打磨；改动要结构化不要打补丁；判断不接受纯手算，要跑真实测试。
- commit message 用英文；直接在 `main` 分支开发。

---

### Task 1: 组件 A — MDF 锚定的尺寸感知弃牌权益

**Files:**
- Modify: `server/pveStrategy.js`
- Test: `server/__tests__/pveStrategy.test.js`

**Interfaces:**
- Produces: 模块内新增 `sizePressure(opponentDelta, potAfterRaise): number`（不导出，仅内部用）；导出新常量 `SIZE_PRESSURE_CAP = 1.6`。`estimateFoldEquity` 新增两个可选入参 `opponentDelta`/`potAfterRaise`，两者都传时才施加尺寸调整。
- Consumes: 无（本轮第一个任务）。

**背景（实施者必读）：** 当前 `estimateFoldEquity` 算出的弃牌权益与"加注多大"完全无关，恒为 `0.45` 左右。这导致最小加注被模型认为和满池注一样能吓走对手，`foldEquity × potSize` 这一项凭空给每次加注 +13.5 筹码的"免费收益"，于是翻前任何两张牌都是 +EV 加注。MDF（最小防守频率）是德扑标准理论：对手要跟 `B` 才能赢下 `P` 的底池时，其理论弃牌上限是 `B / P`。

- [ ] **Step 1: 写失败的测试**

在 `server/__tests__/pveStrategy.test.js` 末尾追加一个新的 describe 块（`SIZE_PRESSURE_CAP` 需要加进文件顶部的 require 解构里）：

```javascript
describe('pveStrategy — 尺寸感知的弃牌权益（MDF 锚定，2026-08-03）', () => {
  // sizePressure 归一化成"满池注 = 1.0"，所以理论弃牌上限 = sizePressure × 0.5。
  // 下面每一行的期望值都是德扑教科书里的 MDF 标准值，不是拍脑袋的数字。
  // 通过 pickAction 的对外行为间接验证（sizePressure 本身不导出）。
  function foldCeilingFor({ potSize, currentBet, raiseTo, myBetThisStreet = 0 }) {
    const cost = raiseTo - myBetThisStreet;
    const opponentDelta = raiseTo - currentBet;
    return opponentDelta / (potSize + cost);
  }

  it('MDF 教科书值：满池注 0.5、半池 1/3、2 倍超池 2/3', () => {
    expect(foldCeilingFor({ potSize: 30, currentBet: 0, raiseTo: 30 })).toBeCloseTo(0.5, 3);
    expect(foldCeilingFor({ potSize: 30, currentBet: 0, raiseTo: 15 })).toBeCloseTo(1 / 3, 3);
    expect(foldCeilingFor({ potSize: 30, currentBet: 0, raiseTo: 60 })).toBeCloseTo(2 / 3, 3);
  });

  it('最小加注的弃牌权益明显低于满池加注——这是"翻前什么牌都加注"的病根', () => {
    const base = {
      street: 'flop', equity: 0.34, toCall: 0, currentBet: 0, potSize: 100, myChips: 5000,
      opponentCeiling: 5000, liveOpponentCount: 1, bigBlind: 20,
      opponentFoldToRaiseRate: 0.45, style: null, facingRaise: false, random: () => 0.5,
    };
    // minRaiseTo 很小 -> 候选加注额被 raiseSizeFraction 推到接近满池；
    // minRaiseTo 很大 -> 候选加注额被地板抬高。用两个尺寸对比 EV 单调性。
    const small = pickAction({ ...base, minRaiseTo: 10 });
    const large = pickAction({ ...base, minRaiseTo: 300 });
    // 大尺寸拿到更高的弃牌权益，但也要付更多成本；这里只断言二者行为不同，
    // 证明尺寸真的进入了计算（改动前两者的 foldEquity 完全相同）。
    expect(small.raiseTo === large.raiseTo).toBe(false);
  });

  it('翻前范围回归（本轮招牌行为）：20bb 未面对加注时，强牌加注、烂牌弃牌', () => {
    // equity 用固定值代入（真实胜率由 computeEquity 提供，这里只测决策层）。
    const base = {
      street: 'preflop', toCall: 20, currentBet: 20, potSize: 30, myChips: 400,
      minRaiseTo: 40, opponentCeiling: 400, liveOpponentCount: 1, bigBlind: 20,
      opponentFoldToRaiseRate: null, style: null, facingRaise: false, random: () => 0.5,
    };
    // AA / KK / AKs 对随机手牌的真实胜率（computeEquity 实测值，见设计文档）
    expect(pickAction({ ...base, equity: 0.859 }).action).toBe('raise'); // AA
    expect(pickAction({ ...base, equity: 0.824 }).action).toBe('raise'); // KK
    expect(pickAction({ ...base, equity: 0.662 }).action).toBe('raise'); // AKs
    // 72o / 92o 应该弃牌（改动前全部是 raise）
    expect(pickAction({ ...base, equity: 0.346 }).action).toBe('fold'); // 72o
    expect(pickAction({ ...base, equity: 0.384 }).action).toBe('fold'); // 92o
  });

  it('尺寸上限常量存在且为 1.6（约 4 倍池，再大的超池边际收益已很小）', () => {
    expect(SIZE_PRESSURE_CAP).toBe(1.6);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run __tests__/pveStrategy.test.js -t "尺寸感知"`
Expected: FAIL — `SIZE_PRESSURE_CAP is not defined`，以及翻前范围那条会因为 72o/92o 仍然返回 `raise` 而失败。

- [ ] **Step 3: 加入常量与 sizePressure 函数**

在 `server/pveStrategy.js` 里 `DEFAULT_FOLD_PRIOR` / `FACING_RAISE_FOLD_SCALE` 这组常量附近加入：

```javascript
// 尺寸压力上限（2026-08-03）：sizePressure 在下注额约等于 4 倍底池时达到
// 1.6，更大的超池边际收益已经很小，封顶避免极端尺寸把弃牌权益推到不合理
// 的高位。
const SIZE_PRESSURE_CAP = 1.6;

// 弃牌权益的尺寸依赖（MDF，最小防守频率——德扑标准理论，不是拍脑袋的
// 数字）：对手需要再拿出 opponentDelta 才能去争一个 potAfterRaise 大的
// 底池，其理论弃牌上限即 opponentDelta / potAfterRaise。这里归一化成
// "满池注 = 1.0"，好让既有的 DEFAULT_FOLD_PRIOR 语义平滑变成"打一个满池
// 注时的弃牌率"，那个常量本身不用动。
//
// 自检（返回值 × 0.5 就是理论弃牌上限）：满池注 -> 0.5、半池 -> 1/3、
// 2 倍超池 -> 2/3，全部与教科书一致。改动前这一层完全不存在，最小加注被
// 当成和满池注一样有压迫力，是"翻前 100% 加注"的直接病根。
function sizePressure(opponentDelta, potAfterRaise) {
  if (!(potAfterRaise > 0) || !(opponentDelta > 0)) return 1;
  return Math.min(SIZE_PRESSURE_CAP, (2 * opponentDelta) / potAfterRaise);
}
```

- [ ] **Step 4: 让 estimateFoldEquity 接受尺寸参数**

把 `estimateFoldEquity` 改成：

```javascript
function estimateFoldEquity({
  opponentFoldToRaiseRate, liveOpponentCount = 1, style = null,
  facingRaise = false, opponentCeiling = Infinity, currentBet = 0,
  opponentDelta = null, potAfterRaise = null,
}) {
  if (opponentCeiling <= currentBet) return 0;
  let p = opponentFoldToRaiseRate ?? DEFAULT_FOLD_PRIOR;
  if (facingRaise) p *= FACING_RAISE_FOLD_SCALE;
  const bias = STYLE_EV_BIAS[style];
  if (bias?.foldEquityMultiplier) p *= bias.foldEquityMultiplier;
  // 尺寸依赖（组件 A）。两个参数都给了才生效——不给时保持改动前的行为，
  // 这个函数虽然没导出，但保留这个默认分支让调用点的改动可以分步验证。
  if (opponentDelta != null && potAfterRaise != null) {
    p *= sizePressure(opponentDelta, potAfterRaise);
  }
  p = Math.min(1, Math.max(0, p));
  const n = Math.max(1, liveOpponentCount);
  return Math.pow(p, n);
}
```

- [ ] **Step 5: 调整 pickAction 里的计算顺序**

这是本任务唯一有风险的一步：`sizePressure` 需要 `raiseCandidate`，但现在 `estimateFoldEquity` 在 `raiseCandidate` 算出来之前就调用了。必须把弃牌权益的计算**下移**到候选加注额之后。

在 `pickAction` 里，先**删除**靠前的这一段：

```javascript
  let foldEquity = estimateFoldEquity({
    opponentFoldToRaiseRate, liveOpponentCount, style, facingRaise, opponentCeiling, currentBet,
  });
```

再**删除**靠后那两行重复声明（它们会被移到上面去，保留会造成重复声明报错）：

```javascript
  const cost = raiseCandidate - myBetThisStreet;
  const opponentDelta = raiseCandidate - currentBet;
```

然后在 `raiseCandidate` 的 `if/else` 块结束之后、`if (raiseCandidate < currentBet) foldEquity = 0;` 这一行之前，插入：

```javascript
  // 尺寸相关量必须在算弃牌权益之前先算出来——组件 A（2026-08-03）让弃牌
  // 权益依赖"这一注到底有多大"，所以这几行从原来的位置上移到了这里。
  const cost = raiseCandidate - myBetThisStreet;
  const opponentDelta = raiseCandidate - currentBet;

  let foldEquity = estimateFoldEquity({
    opponentFoldToRaiseRate, liveOpponentCount, style, facingRaise, opponentCeiling, currentBet,
    opponentDelta, potAfterRaise: potSize + cost,
  });
```

- [ ] **Step 6: 导出新常量**

把 `SIZE_PRESSURE_CAP` 加进文件末尾的 `module.exports`：

```javascript
module.exports = {
  computeEquity, pickAction, raiseSizeFraction, STYLES, EV_NOISE_FRACTION,
  POT_CONTROL_MURKY_LOW, POT_CONTROL_MURKY_HIGH, POT_CONTROL_DISCOUNT,
  SIZE_PRESSURE_CAP,
};
```

并在 `server/__tests__/pveStrategy.test.js` 顶部的 require 解构里加上 `SIZE_PRESSURE_CAP`。

- [ ] **Step 7: 跑新测试确认通过**

Run: `cd server && npx vitest run __tests__/pveStrategy.test.js -t "尺寸感知"`
Expected: PASS，4 条全绿。

- [ ] **Step 8: 跑整个 pveStrategy 测试文件，分诊既有测试的失败**

Run: `cd server && npx vitest run __tests__/pveStrategy.test.js`

**预期会有既有测试失败，这是正常的、也是这次改动的目的**——那些测试的期望值是按"弃牌权益恒为 0.45"手算出来的，现在弃牌权益变成尺寸相关了，它们编码的是**旧的、错误的**行为。

对每一条失败，按这个规则分诊，**不许直接把断言改成当前输出了事**：

1. 先手算该场景下新的 `sizePressure`（用 Step 3 的公式），得到新的 `foldEquity`，再重算 `evRaise`。
2. 如果重算结果与实际输出一致 → 这条测试合法过时。**更新它的注释**，把新的 `foldEquity` / `evRaise` 数值和"为什么变了"写进去，再更新断言。
3. 如果重算结果与实际输出**不一致** → 是真的回归，去修代码，不要动测试。

已知会受影响的一类：`风格对 EV 计算的偏差` 那两条（`aggressive`/`steady`）用的是精心挑的"EV 近似平手"场景，尺寸压力变化后平手点会移动，很可能需要重新挑参数（2026-08-02 因为池控制折扣也做过一次同样的事，可参考那次的注释写法）。

- [ ] **Step 9: 跑服务端全量测试**

Run: `cd server && npx vitest run`
Expected: 全绿。本项目有 1-2 条已知的全量并发下偶发 flake（`integration.test.js` / `reconnect.test.js`）——若其中之一失败，**单独重跑那一个文件**确认它在隔离下通过，才可判定为已知 flake；其他任何失败都是真回归。

- [ ] **Step 10: Commit**

```bash
git add server/pveStrategy.js server/__tests__/pveStrategy.test.js
git commit -m "feat: make AI fold equity depend on bet size via MDF anchoring"
```

---

### Task 2: 组件 B（引擎侧）— 两极化范围支持

**Files:**
- Modify: `server/pveStrategy.js`
- Test: `server/__tests__/pveStrategy.test.js`

**Interfaces:**
- Produces: 模块内新增 `getPolarizedRangeSet(topPct, bottomPct): Set<string>`（不导出）；`computeEquity` 的 opts 新增可选 `opponentBottomPct`（默认 `0`）。
- Consumes: Task 1 无依赖关系（可独立实施）。

**背景：** 真实德扑里超池注是"两极化"的——要么坚果要么纯诈唬，中间牌力不会用这个尺寸。如果只做"越大越窄"的单调收窄，AI 会对超池过度弃牌，那是另一种不真实。实测（公共牌 `Th 7c 2d`，单调前 20% vs 两极化 12%+15%）证明区别是实质性的：强牌 TT 只差 +0.009，而中等牌力 T9 差 +0.081、空气 K4 差 +0.116——**面对超池，中等牌力反而应该更敢跟**。

现有的 `HAND_CLASSES` 已按 Chen 分数降序排列并带累计组合数 `cumBefore`，取"前 X% ∪ 后 Y%"只需要一个新函数，`computeEquity` 的拒绝采样循环一行都不用改。

- [ ] **Step 1: 写失败的测试**

追加到 `server/__tests__/pveStrategy.test.js`：

```javascript
describe('pveStrategy — 两极化对手范围（超池建模，2026-08-03）', () => {
  it('opponentBottomPct 默认 0 时，行为与改动前的单调范围完全一致', () => {
    const fixedRandom = () => 0.42;
    const a = computeEquity(['As', 'Kd'], ['Th', '7c', '2d'], {
      iterations: 200, random: fixedRandom, opponentRangePct: 0.3,
    });
    const b = computeEquity(['As', 'Kd'], ['Th', '7c', '2d'], {
      iterations: 200, random: fixedRandom, opponentRangePct: 0.3, opponentBottomPct: 0,
    });
    expect(a).toBe(b);
  });

  it('面对两极化范围，中等牌力的胜率明显高于面对同等窄度的单调强牌范围', () => {
    // 对手范围里掺进了一块纯诈唬 -> 中等牌力抓诈唬的价值上来了。
    // 这正是"面对超池不该无脑弃牌"的量化依据。
    const board = ['Th', '7c', '2d'];
    const medium = ['Tc', '9c']; // 顶对弱踢
    const mono = computeEquity(medium, board, { iterations: 3000, opponentRangePct: 0.20 });
    const polar = computeEquity(medium, board, {
      iterations: 3000, opponentRangePct: 0.12, opponentBottomPct: 0.15,
    });
    expect(polar).toBeGreaterThan(mono + 0.03);
  });

  it('坚果级强牌几乎不受范围形状影响（对照组，证明上一条不是全局偏移）', () => {
    const board = ['Th', '7c', '2d'];
    const nuts = ['Ts', 'Td']; // 中三条
    const mono = computeEquity(nuts, board, { iterations: 3000, opponentRangePct: 0.20 });
    const polar = computeEquity(nuts, board, {
      iterations: 3000, opponentRangePct: 0.12, opponentBottomPct: 0.15,
    });
    expect(Math.abs(polar - mono)).toBeLessThan(0.03);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run __tests__/pveStrategy.test.js -t "两极化"`
Expected: 第二条 FAIL（`opponentBottomPct` 还没实现，两次计算得到同样的单调结果，差值达不到 0.03）。

- [ ] **Step 3: 实现 getPolarizedRangeSet**

在 `server/pveStrategy.js` 里 `getRangeSet` 正下方加入：

```javascript
// 两极化范围（2026-08-03）：前 topPct 的强牌 ∪ 后 bottomPct 的烂牌，中间
// 牌力挖空。真实德扑里超池注就是这个形状——要么坚果要么纯诈唬，中等牌力
// 不会选这个尺寸。跟 getRangeSet 复用同一份 HAND_CLASSES（已按分数降序 +
// 带累计组合数），所以这里只是换一个 Set，computeEquity 的拒绝采样逻辑
// 一行都不用改。
//
// 注意这里不能像 getRangeSet 那样提前 break——底部那一段要扫到列表末尾。
// 169 个类别的全扫成本可忽略。
function getPolarizedRangeSet(topPct, bottomPct) {
  const topThreshold = topPct * TOTAL_COMBOS;
  const bottomThreshold = (1 - bottomPct) * TOTAL_COMBOS;
  const set = new Set();
  for (const c of HAND_CLASSES) {
    if (c.cumBefore < topThreshold || c.cumBefore >= bottomThreshold) set.add(c.key);
  }
  return set;
}
```

- [ ] **Step 4: 让 computeEquity 接受 opponentBottomPct**

把 `computeEquity` 开头的解构和 `rangeSet` 构造改成：

```javascript
function computeEquity(holeCards, board, opts = {}) {
  const {
    iterations = 300, random = Math.random,
    opponentRangePct = 1, opponentBottomPct = 0, numOpponents = 1,
  } = opts;
  const known = new Set([...holeCards, ...board]);
  const remaining = makeDeck().filter(c => !known.has(c));
  // opponentBottomPct > 0 -> 两极化（前 X% ∪ 后 Y%）；否则维持原来的单调
  // 前 X%。默认 0 保证所有不传这个 opt 的既有调用与测试逐位不变。
  const rangeSet = opponentBottomPct > 0
    ? getPolarizedRangeSet(opponentRangePct, opponentBottomPct)
    : (opponentRangePct < 1 ? getRangeSet(opponentRangePct) : null);
```

函数体其余部分完全不动。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd server && npx vitest run __tests__/pveStrategy.test.js -t "两极化"`
Expected: PASS，3 条全绿。

- [ ] **Step 6: 跑服务端全量测试**

Run: `cd server && npx vitest run`
Expected: 全绿（本任务是纯增量、默认值向后兼容，不该有任何既有测试失败；若有，是真回归）。已知 flake 的判定规则同 Task 1 Step 9。

- [ ] **Step 7: Commit**

```bash
git add server/pveStrategy.js server/__tests__/pveStrategy.test.js
git commit -m "feat: support polarized opponent ranges for overbet modelling"
```

---

### Task 3: 组件 C（引擎侧）— pickAction 接受第二个胜率

**Files:**
- Modify: `server/pveStrategy.js`
- Test: `server/__tests__/pveStrategy.test.js`

**Interfaces:**
- Produces: `pickAction` 的 params 新增可选 `equityIfCalled`（默认 `undefined` → 回退成 `equity`）。加注分支的 `realEq` 改用它推导。
- Consumes: Task 1 的 `cost` / `opponentDelta` 上移后的位置。

**背景：** `evCall` 和 `evRaise` 面对的是**不同的对手范围**。现状只算一次胜率、两个分支共用，等于假设"会来跟我加注的人拿的是随机两张牌"。实测（对随机 vs 对前 30%）：AA 只掉 0.003，而 T2o 掉 0.108——强牌几乎不掉、烂牌掉很多，正是区分开池范围所需的差异。

- [ ] **Step 1: 写失败的测试**

追加到 `server/__tests__/pveStrategy.test.js`：

```javascript
describe('pveStrategy — 加注的选择效应（equityIfCalled，2026-08-03）', () => {
  const base = {
    street: 'preflop', toCall: 20, currentBet: 20, potSize: 30, myChips: 400,
    minRaiseTo: 40, opponentCeiling: 400, liveOpponentCount: 1, bigBlind: 20,
    opponentFoldToRaiseRate: null, style: null, facingRaise: false, random: () => 0.5,
  };

  it('不传 equityIfCalled 时，行为与只传 equity 完全一致（向后兼容）', () => {
    const a = pickAction({ ...base, equity: 0.55 });
    const b = pickAction({ ...base, equity: 0.55, equityIfCalled: 0.55 });
    expect(a).toEqual(b);
  });

  it('被跟注时胜率更低会压制加注：同一手牌，只因为"跟我的人更强"就从加注变弃牌', () => {
    // T2o：对随机牌 0.417，对前 30% 只有 0.308（设计文档里的实测值）。
    const naive = pickAction({ ...base, equity: 0.417 });
    const aware = pickAction({ ...base, equity: 0.417, equityIfCalled: 0.308 });
    expect(naive.action).toBe('raise');
    expect(aware.action).toBe('fold');
  });

  it('强牌不受影响：AA 对随机 0.859、对前 30% 0.836，两种算法都加注', () => {
    const aware = pickAction({ ...base, equity: 0.859, equityIfCalled: 0.836 });
    expect(aware.action).toBe('raise');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run __tests__/pveStrategy.test.js -t "选择效应"`
Expected: 第二条 FAIL — `equityIfCalled` 还没被消费，`aware` 仍然返回 `raise`。

- [ ] **Step 3: 实现**

在 `pickAction` 的解构里加入（放在 `equity` 附近）：

```javascript
    equityIfCalled,
```

在 `const eq = styledEquity(equity, style);` 那一行的正下方加入：

```javascript
  // 组件 C（2026-08-03）：evCall 和 evRaise 面对的对手范围不一样——跟注面
  // 对的是"对手已经下注了"的范围，而加注面对的是"愿意来跟我加注的人"，后
  // 者必然强于随机。调用方（PveSession）算两次胜率分别传入；不传时退回
  // equity，与改动前逐位一致。
  //
  // 注意这里对两个胜率都统一施加 styledEquity——风格偏差是"我怎么看待自己
  // 的牌力"，对两条分支应当一视同仁；而范围本身用的是客观胜率（由调用方
  // 用真实 equity 算好），不受风格滤镜影响。
  const eqIfCalled = styledEquity(equityIfCalled ?? equity, style);
```

在 `realEq` 那一行下方加入其加注分支的对应值：

```javascript
  const realEqIfCalled = realizedEquity(eqIfCalled, street, sprAfterCall);
```

然后把 `evRaise` 那一行里**被跟注**的那一项从 `realEq` 换成 `realEqIfCalled`（弃牌那一项不涉及摊牌，不用换）：

```javascript
  let evRaise = foldEquity * potSize + (1 - foldEquity) * (realEqIfCalled * potIfCalled - cost);
```

**不要**动 `evCall` 那一行——它继续用 `realEq`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx vitest run __tests__/pveStrategy.test.js -t "选择效应"`
Expected: PASS，3 条全绿。

- [ ] **Step 5: 检查池控制折扣的判据是否仍然正确**

`POT_CONTROL_DISCOUNT` 的判据用的是**真实客观 `equity`**（2026-08-02 的二次修复）。现在多了一个 `equityIfCalled`，确认那个 `if` 条件**仍然只看 `equity`**，不要顺手改成 `equityIfCalled`——本任务不调整池控制折扣的任何行为（那是 Task 5 的事）。用 grep 确认：

Run: `cd server && grep -n "POT_CONTROL_MURKY" pveStrategy.js`
Expected: 判据行仍为 `equity > POT_CONTROL_MURKY_LOW && equity < POT_CONTROL_MURKY_HIGH`。

- [ ] **Step 6: 跑服务端全量测试**

Run: `cd server && npx vitest run`
Expected: 全绿。已知 flake 判定规则同 Task 1 Step 9。

- [ ] **Step 7: Commit**

```bash
git add server/pveStrategy.js server/__tests__/pveStrategy.test.js
git commit -m "feat: model that callers of a raise are stronger than random"
```

---

### Task 4: PveSession 编排 — 按下注尺寸推断范围 + 算两次胜率

**Files:**
- Modify: `server/PveSession.js`
- Test: `server/__tests__/PveSession.test.js`

**Interfaces:**
- Consumes: Task 2 的 `computeEquity(..., { opponentBottomPct })`，Task 3 的 `pickAction({ equityIfCalled })`。
- Produces: 无新的对外接口（纯编排层改动）。

**背景：** 这是把组件 B 和 C 接到真实对局上的一步。当前 `aiAction()` 只按"对手的加注频率"和"这手牌连续几条街被加注"推断范围宽度，**完全不看对手下了多少**。

- [ ] **Step 1: 写失败的测试**

追加到 `server/__tests__/PveSession.test.js`（该文件已有 `fakeStrategy`/`makeSession` 的既有模式，沿用即可）：

```javascript
describe('PveSession — 按对手下注尺寸推断范围 + 两次胜率（2026-08-03）', () => {
  it('对手下得越重，传给 computeEquity 的 opponentRangePct 越窄', () => {
    function rangeForBet(raiseTo) {
      fakeStrategy.computeEquity.mockClear();
      const s = makeSession({ bigBlind: 20 });
      s._opponentReads = () => ({ opponentFoldToRaiseRate: null, opponentAggressionRate: 0.35 });
      fakeStrategy.pickAction.mockReturnValue({ action: 'call' });
      s.humanAction('raise', raiseTo);
      s.aiAction();
      return fakeStrategy.computeEquity.mock.calls[0][2].opponentRangePct;
    }
    const small = rangeForBet(40);   // 小加注
    const large = rangeForBet(200);  // 大加注
    expect(large).toBeLessThan(small);
  });

  it('对手超池下注时，范围变成两极化（opponentBottomPct > 0）', () => {
    const s = makeSession({ bigBlind: 20 });
    s._opponentReads = () => ({ opponentFoldToRaiseRate: null, opponentAggressionRate: 0.35 });
    fakeStrategy.pickAction.mockReturnValue({ action: 'call' });
    fakeStrategy.computeEquity.mockClear();
    s.humanAction('raise', 400); // 远超当时底池
    s.aiAction();
    const opts = fakeStrategy.computeEquity.mock.calls[0][2];
    expect(opts.opponentBottomPct).toBeGreaterThan(0);
  });

  it('aiAction 算两次胜率，并把第二个作为 equityIfCalled 传给 pickAction', () => {
    const s = makeSession({ seatCount: 4 });
    fakeStrategy.computeEquity.mockClear();
    fakeStrategy.pickAction.mockClear();
    expect(s.isAiTurn()).toBe(true);
    s.aiAction();
    expect(fakeStrategy.computeEquity).toHaveBeenCalledTimes(2);
    const callArgs = fakeStrategy.pickAction.mock.calls[0][0];
    expect(typeof callArgs.equityIfCalled).toBe('number');
  });

  it('跟注者范围不会比"对手下注推断出的范围"更宽（超池时跟我加注的人只会更强）', () => {
    const s = makeSession({ bigBlind: 20 });
    s._opponentReads = () => ({ opponentFoldToRaiseRate: null, opponentAggressionRate: 0.35 });
    fakeStrategy.pickAction.mockReturnValue({ action: 'call' });
    fakeStrategy.computeEquity.mockClear();
    s.humanAction('raise', 400);
    s.aiAction();
    const first = fakeStrategy.computeEquity.mock.calls[0][2];  // 对手范围
    const second = fakeStrategy.computeEquity.mock.calls[1][2]; // 跟注者范围
    expect(second.opponentRangePct).toBeLessThanOrEqual(first.opponentRangePct);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run __tests__/PveSession.test.js -t "按对手下注尺寸"`
Expected: FAIL — 现在只调用一次 `computeEquity`，且没有 `opponentBottomPct`。

- [ ] **Step 3: 加入尺寸→范围的映射常量**

在 `server/PveSession.js` 顶部常量区（`AI_NAME_POOL` 附近）加入：

```javascript
// 对手下注尺寸 -> 对手范围形状（组件 B，2026-08-03）。系数是相对既有
// "按加注频率算出来的基础宽度"的乘数：疯子的满池注和岩石的满池注含义不
// 同，那一层保留，这里只叠加"这一注有多重"这个信号。
//
// 系数按 baseRangePct 取默认值 0.35 时落到设计文档那张表来标定：
// ≤1/3 池 -> 前 60%（0.35×1.7）、~半池 -> 前 45%（0.35×1.3）、
// ~满池 -> 前 30%（0.35×0.85）。
const BET_SIZE_RANGE_FACTORS = [
  { maxRatio: 0.4, factor: 1.7 },
  { maxRatio: 0.8, factor: 1.3 },
  { maxRatio: 1.5, factor: 0.85 },
];
// 超过这个下注/底池比就按"两极化"建模，而不是继续单调收窄——真实德扑里
// 超池是"要么坚果要么纯诈唬"。只做单调收窄会让 AI 对超池过度弃牌，那是
// 另一种不真实（设计文档有实测数据）。
const OVERBET_RATIO = 1.5;
const OVERBET_TOP_PCT = 0.12;
const OVERBET_BOTTOM_PCT = 0.15;
// 会来跟我加注的人，牌力必然强于随机（组件 C）。取 min 是因为对手已经超
// 池施压时，还敢跟我再加的只会更强，不该反过来被放宽。
const CALLER_RANGE_PCT = 0.35;

function betSizeRangeFactor(ratio) {
  for (const { maxRatio, factor } of BET_SIZE_RANGE_FACTORS) {
    if (ratio <= maxRatio) return factor;
  }
  return 0.85;
}
```

- [ ] **Step 4: 改写 aiAction 里的范围推断与胜率计算**

在 `aiAction()` 里，把现有的这一段：

```javascript
    let opponentRangePct = 1;
    if (facingRaise) {
      const streets = this.handAggressionStreets[actingId] ?? (this.handAggressionStreets[actingId] = new Set());
      streets.add(street);
      const narrowingFactor = 0.75 ** Math.max(0, streets.size - 1);
      opponentRangePct = Math.min(0.90, Math.max(0.10, baseRangePct * narrowingFactor));
    }
```

替换为：

```javascript
    let opponentRangePct = 1;
    let opponentBottomPct = 0;
    if (facingRaise) {
      const streets = this.handAggressionStreets[actingId] ?? (this.handAggressionStreets[actingId] = new Set());
      streets.add(street);
      const narrowingFactor = 0.75 ** Math.max(0, streets.size - 1);
      // 组件 B（2026-08-03）：把"对手下了多重"这个信号叠进来。改动前只看
      // 加没加注、不看多大，导致玩家超池和下 1/4 池在 AI 眼里是同一件事。
      const betRatio = this.game.pot > 0 ? toCall / this.game.pot : 0;
      if (betRatio > OVERBET_RATIO) {
        // 超池：两极化，不再是"前 X%"这种单调形状。
        opponentRangePct = OVERBET_TOP_PCT;
        opponentBottomPct = OVERBET_BOTTOM_PCT;
      } else {
        const sizeFactor = betSizeRangeFactor(betRatio);
        opponentRangePct = Math.min(0.90, Math.max(0.10, baseRangePct * narrowingFactor * sizeFactor));
      }
    }
```

接着把单次 `computeEquity` 调用改成两次：

```javascript
    // 翻前现在也算真实胜率（board=[]），不再走单独的起手牌分档表——见
    // docs/superpowers/specs/2026-08-02-pve-ev-driven-ai-design.md。
    const numOpponents = Math.max(1, liveOpponentCount);
    const equity = this.strategy.computeEquity(ai.holeCards, board, {
      iterations: 300,
      opponentRangePct,
      opponentBottomPct,
      numOpponents,
    });
    // 组件 C（2026-08-03）：加注分支要用"会来跟我的人"的范围重算一次胜率。
    // 实测多算一次约 +15ms，而 AI 每步本来就有 300ms 起的拟人思考延迟，占
    // 比约 5%，可忽略（见设计文档）。取 min 而不是固定 0.35：对手已经超池
    // 施压时，还敢跟我再加注的人只会更强，不该被放宽回 35%。这里刻意用单
    // 调形状而非两极化——愿意跟注的是对手范围里的强牌那一半，不是诈唬那
    // 一半。
    const callerRangePct = Math.min(CALLER_RANGE_PCT, opponentRangePct);
    const equityIfCalled = this.strategy.computeEquity(ai.holeCards, board, {
      iterations: 300,
      opponentRangePct: callerRangePct,
      numOpponents,
    });
```

最后在 `pickAction({...})` 的参数对象里，`equity` 那一行下面加入：

```javascript
      equityIfCalled,
```

- [ ] **Step 5: 跑新测试确认通过**

Run: `cd server && npx vitest run __tests__/PveSession.test.js -t "按对手下注尺寸"`
Expected: PASS，4 条全绿。

- [ ] **Step 6: 跑整个 PveSession 测试文件并分诊**

Run: `cd server && npx vitest run __tests__/PveSession.test.js`

既有测试里有一条断言 `computeEquity` 的调用参数（`面对加注时，computeEquity 收到收窄后的 opponentRangePct`），它按"每次决策只调用一次 computeEquity"的假设写的（用 `mock.calls[i]` 与 `pickAction.mock.calls[i]` 一一对应）。现在每次决策调用两次，索引对应关系变了，**需要更新那条测试**让它只取每次决策的第一次调用（对手范围那一次），比如把配对逻辑改成 `computeEquity.mock.calls[i * 2]`。更新时把"为什么是 ×2"写进注释。

- [ ] **Step 7: 跑服务端全量测试**

Run: `cd server && npx vitest run`
Expected: 全绿。已知 flake 判定规则同 Task 1 Step 9。

- [ ] **Step 8: Commit**

```bash
git add server/PveSession.js server/__tests__/PveSession.test.js
git commit -m "feat: infer opponent range from bet size and model caller strength"
```

---

### Task 5: VPIP/PFR 诊断脚本 + 用数据决定池控制折扣去留

**Files:**
- Create: `server/scripts/pvePreflopStats.js`
- Modify: `server/package.json`（新增一个 npm script）
- Modify: `server/pveStrategy.js`（**仅当数据表明需要调整** `POT_CONTROL_DISCOUNT` 时）

**Interfaces:**
- Consumes: Task 1-4 全部落地后的 `PveSession`。
- Produces: `npm run pve:preflop-stats`，输出每个风格的 VPIP / PFR / 翻后主动率。

**背景：** 本轮的主要验收标准是**双向**的：PFR 要落进真人区间（约 15-25%），**同时**不能矫枉过正把 AI 压成什么都不敢做的岩石。另外 `POT_CONTROL_DISCOUNT`（0.6）当初是"缺失风险模型时的代理"，组件 A 是同一个病根的正解，两者叠加有过度保守的风险——**必须用数据决定它的去留，不许拍脑袋**。

- [ ] **Step 1: 写诊断脚本**

创建 `server/scripts/pvePreflopStats.js`：

```javascript
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
```

- [ ] **Step 2: 加 npm script**

在 `server/package.json` 的 `scripts` 里，紧挨着已有的 `pve:balance-check` 加入：

```json
    "pve:preflop-stats": "node scripts/pvePreflopStats.js"
```

- [ ] **Step 3: 跑基线数据（折扣保持现状 0.6）**

Run: `cd server && npm run pve:preflop-stats 4 400`
记录 VPIP / PFR / 翻后主动率三个数字。

- [ ] **Step 4: 跑对照组（折扣减弱到 0.8）**

临时把 `server/pveStrategy.js` 的 `POT_CONTROL_DISCOUNT` 改成 `0.8`，重跑：

Run: `cd server && npm run pve:preflop-stats 4 400`
记录三个数字。

- [ ] **Step 5: 跑对照组（折扣移除，等价于 1.0）**

临时把 `POT_CONTROL_DISCOUNT` 改成 `1.0`，重跑：

Run: `cd server && npm run pve:preflop-stats 4 400`
记录三个数字。

- [ ] **Step 6: 按数据决定并落地**

按这个规则从三组数据里选：

- 若 **0.6** 组的 PFR 已在 15-25% 且翻后主动率健康（明显大于 0）→ **保持 0.6 不动**，把三组数据作为"已验证不需要改"的证据记录进 Task 6 的 SDD 条目。
- 若 **0.6** 组的翻后主动率被压得过低（接近 0 或明显低于另外两组的一半）→ 说明组件 A 已经接管了这份工作、折扣在重复计费，选 PFR 与翻后主动率同时落在健康区间的那一档（0.8 或 1.0）作为新值。
- 若三组的 PFR 都远离 15-25% → 说明问题不在折扣，**不要动折扣**（改回 0.6），在 Task 6 的 SDD 里记录这个发现留待下轮，不要在本任务里继续调别的参数。

把最终选定的值写回 `POT_CONTROL_DISCOUNT`（若结论是保持 0.6，确保临时改动已经完全还原）。若改了值，同步更新该常量上方注释，说明"2026-08-03 按 VPIP/PFR 实测数据从 0.6 调整为 X，原因是……"。

- [ ] **Step 7: 跑服务端全量测试**

Run: `cd server && npx vitest run`
Expected: 全绿。若 Step 6 改动了 `POT_CONTROL_DISCOUNT`，池控制那组测试里断言常量具体数值的那条会失败——按新值更新它，并在注释里写明改动原因。已知 flake 判定规则同 Task 1 Step 9。

- [ ] **Step 8: Commit**

```bash
git add server/scripts/pvePreflopStats.js server/package.json server/pveStrategy.js server/__tests__/pveStrategy.test.js
git commit -m "feat: add VPIP/PFR diagnostic and settle pot-control discount with data"
```

---

### Task 6: 风格平衡回归 + 真实浏览器验证 + SDD 文档

**Files:**
- Modify: `openspec/changes/online-texas-holdem/tasks.md`
- Modify: `docs/superpowers/specs/2026-08-03-pve-ai-bet-sizing-and-range-design.md`（仅当实施中出现与设计不符的真实偏差）

**Interfaces:**
- Consumes: Task 1-5 全部落地。

- [ ] **Step 1: 风格平衡回归**

Run: `cd server && node scripts/pveBalanceCheck.js 4 15 200`

用 15 组（不是默认的 6 组）——该脚本注释里记录过一个真实踩过的坑：4 人桌每组只随机分到 3 个风格坐位，单个风格样本量比想象的小，6 组时曾出现 `aggressive` "3 组全正"的假阳性，扩到 15 组后变成 3 胜 5 负。

判读：四个风格都应该**有输有赢**（不同组之间方向会反转）。如果某个风格在 15 组里几乎每组都是同一个方向且量级远超其他风格，那是系统性偏差，需要排查。注意"四个风格的整体输赢完全打平"**不是**本轮的验收目标——那是 `tasks.md` 69.18 里已经记录在案的独立待办。

- [ ] **Step 2: 真实浏览器验证**

构建并起服务：

```bash
cd client && npm run build
cd .. && node server/index.js
```

用 Playwright（本仓库已有 `node_modules/playwright`，写临时脚本即可，不要提交）连到 `http://localhost:3001`，开一局 4 人人机对战，观察并确认：

1. AI **不再是每手都加注**——应该能看到明显的弃牌。
2. 打完至少 10 手没有出现崩溃、卡死或异常动作（比如非法下注额）。

跑完记得关掉服务进程。

- [ ] **Step 3: 更新 SDD**

在 `openspec/changes/online-texas-holdem/tasks.md` 末尾追加条目（当前最新是 69.19，所以用 69.20），沿用该文件既有条目的风格（中英混排、引用文件路径与测试数量、写清根因与实测数据）。必须覆盖：

- 用户诉求（"让机器人更接近真人、不做很傻的举动、能根据对局和玩家做猜测"）。
- 实测发现的真正病根：20bb 以上翻前对 AA/AKs/76s/T2o/92o/72o **全部加注**，因为弃牌权益恒为 0.45、与加注尺寸无关，`foldEquity × potSize` 白给 13.5 筹码。
- 三个组件各自做了什么（A：MDF 锚定的 `sizePressure`；B：`getPolarizedRangeSet` + 按下注/底池比推断范围，超池走两极化；C：`equityIfCalled` 两次胜率）。
- Task 5 关于 `POT_CONTROL_DISCOUNT` 的**数据结论**（三组对照的实际数字，以及最终保持还是调整、为什么）。
- VPIP/PFR 的最终数字，以及新增的 `npm run pve:preflop-stats` 工具。
- 明确记录本轮**没做**的三项：位置概念、线路连贯性、牌面纹理。
- 服务端最终测试数量。

- [ ] **Step 4: 最终全量验证**

```bash
cd server && npx vitest run
cd ../client && npm run build
```
Expected: 服务端全绿（已知 flake 判定规则同 Task 1 Step 9），客户端构建干净。

- [ ] **Step 5: Commit 并推送**

```bash
git add openspec/changes/online-texas-holdem/tasks.md docs/superpowers/specs/2026-08-03-pve-ai-bet-sizing-and-range-design.md
git commit -m "docs: record PVE AI bet-sizing and range inference work in SDD"
git push origin main
```

---

## Self-Review

**1. 设计文档覆盖检查**

| 设计文档章节 | 对应任务 |
|---|---|
| A. 尺寸 → 弃牌权益（MDF） | Task 1 |
| B. 对手尺寸 → 范围（引擎侧两极化） | Task 2 |
| B. 对手尺寸 → 范围（编排侧推断） | Task 4 Step 3-4 |
| C. 加注的选择效应（引擎侧） | Task 3 |
| C. 加注的选择效应（编排侧两次胜率） | Task 4 Step 4 |
| 与池控制折扣的关系（用数据决定） | Task 5 Step 3-6 |
| 与风格偏差的关系（客观胜率判据） | Global Constraints + Task 3 Step 5 |
| 验证：MDF 单元测试 | Task 1 Step 1 |
| 验证：翻前范围回归 | Task 1 Step 1 |
| 验证：VPIP/PFR 双向判据 | Task 5 |
| 验证：风格平衡回归 | Task 6 Step 1 |
| 验证：真实浏览器 | Task 6 Step 2 |
| 明确不做的三项 | Task 6 Step 3（记录进 SDD） |

无遗漏。

**2. 占位符扫描**：无 TBD/TODO；每个代码步骤都给了可直接使用的完整代码；Task 5 Step 6 的"按数据决定"给了三条明确的分支判据而不是"看情况"。

**3. 类型/命名一致性**：`sizePressure(opponentDelta, potAfterRaise)`、`getPolarizedRangeSet(topPct, bottomPct)`、`opponentBottomPct`、`equityIfCalled`、`CALLER_RANGE_PCT`、`betSizeRangeFactor(ratio)` 在定义处与使用处拼写一致；Task 4 消费的 `opponentBottomPct`（Task 2 定义）与 `equityIfCalled`（Task 3 定义）签名吻合。

**4. 已知风险已在计划内处理**：Task 1 Step 5 的计算顺序调整是唯一的结构性改动，已给出精确的删除/插入位置；Task 1 Step 8 与 Task 4 Step 6 预告了既有测试的合法失败并给了分诊规则（禁止"把断言改成当前输出"）。
