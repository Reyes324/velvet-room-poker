# PVE AI 决策引擎重构：从概率表抽样改成 EV 最大化

## 背景

现有 `server/pveStrategy.js` 的决策核心是"查表抽概率"：翻前按起手牌分档（`PREFLOP_TABLE`），翻后按胜率分档（`POSTFLOP_BANDS`），再叠加若干具名的上下文/位置/风格调整量（`contextDeltas`/`STYLE_DELTAS`），最后按调整后的概率随机抽样出 fold/call/raise。这套机制能打出统计上"看起来均衡"的牌，但没有一个真正的目标函数在驱动决策——它不是"算一下每个选项到底能赚多少、选最赚的"，只是按经验调出来的分布在抽签。

用户明确要求：AI 应该有"想赢"的目标感——以**自己最终赢得的筹码最大化**为目标，从这个目标出发推导具体策略，而不是反过来先定好一套打法分布。同时要求把**后手深度**（自己的、对手的）作为决策的核心变量，而不是像现在这样只在"加注不能超过身家"这种被动场景里出现。

## 调研结论：不引入外部工具

查过开源方案：成熟的 GTO/CFR 求解器（PioSOLVER 类）基本是 Python/Rust/C++ 写的离线求解工具，喂一个局面要跑几分钟到几小时，没法嵌进 Node 服务器做实时决策；专门的 heads-up push/fold Nash 表覆盖面太窄（只覆盖极浅筹码这一种场景）。我们真正要的不是"求解均衡"这么重的问题，是标准的、成熟的 EV 计算（胜率 × 底池赔率 × 后手深度），而且已有的 `computeEquity`（复用 `pokersolver`，支持翻前/翻后蒙特卡洛或穷举）已经是这套计算需要的核心积木——不需要新依赖，自己实现即可，更快也更贴合现有架构。

## 架构

`pickAction()` 不再按 `street` 分两套机制（`PREFLOP_TABLE` vs `POSTFLOP_BANDS`），翻前也改用 `computeEquity(holeCards, [], {...})`（该函数已支持空公共牌的蒙特卡洛计算）得到真实胜率，翻前翻后统一走同一套"算三个动作的 EV，选最大值"的流程。`preflopTier()`/`PREFLOP_TABLE`/`POSTFLOP_BANDS`/`bandFor()`/`adjustDistribution()`/`contextDeltas()`/`STYLE_DELTAS` 这套"概率表 + 调整量"机制整体废弃（`preflopTier` 本身可能仍用于展示/调试，但不再驱动决策）。

## EV 公式

给定：胜率 `equity`（`computeEquity` 算出）、当前底池 `potSize`、跟注额 `toCall`、加注候选额 `raiseTo`、弃牌权益 `foldEquity`（下节详述）：

- `EV(fold) = 0`
- `EV(call) = equity × (potSize + toCall) − toCall`
- `EV(raise to raiseTo)`：复用现有代码已有的变量口径（`myBetThisStreet = currentBet − toCall`，即自己这条街已经投入的部分）：
  - `cost = raiseTo − myBetThisStreet`（这次决策相对"什么都不做"额外要多投入的筹码）
  - `potIfCalled = potSize + (raiseTo − currentBet) + cost`（自己加注到 raiseTo、且对手跟注到 raiseTo 之后的总底池——底池先加上"自己从 currentBet 追加到 raiseTo 的部分"，再加上"假设对手也跟到 raiseTo 需要再放入的部分"，即对手也补齐 `raiseTo − 对手当前已投入`；简化实现时可直接按"对手跟注同额" 近似为 `potSize + 2×(raiseTo − currentBet)`，具体按实现阶段跑测试核对是否跟 `GameEngine` 实际的底池增量一致）
  - `EV(raise) = foldEquity × potSize + (1 − foldEquity) × (equity × potIfCalled − cost)`

三个数取最大值对应的动作。**不枚举连续加注尺度**——加注候选额沿用现有的 `raiseSizeFraction()` 极化启发式（强牌/诈唬用大尺度、中等牌力用小尺度）选一个候选，只对这一个候选算 EV；是否要加注，由"这个候选的 EV 是否是三者中最高"决定，不单独做尺度优化（超出本轮范围，属于求解器级别的问题）。

## 弃牌权益（多人聚合）

```
p_single = opponentFoldToRaiseRate ?? DEFAULT_FOLD_PRIOR   // 无数据时的先验，建议 0.5
foldEquity = clamp(p_single, 0, 1) ^ liveOpponentCount
```

`liveOpponentCount` = 本手牌里还没弃牌、除自己以外的玩家数（`PveSession.aiAction()` 需要新算出来传给 `pickAction`）。人越多，"全员弃牌"的概率天然指数下降——不用单独给每个对手建模，聚合估计自然体现"多人锅诈唬更难"这条牌理，跟你确认的方向一致。

## 后手深度（SPR + 翻前浅筹码 push/fold）

`effectiveStack`：复用已有的 `GameEngine.maxTotalFor(actingId)`——它本来就返回"自己的筹码 与 场上最深对手身家 的较小值"（即标准的"有效后手"定义），不需要新写。`SPR = effectiveStack / potSize`。

- **翻后**：SPR 直接作为 EV 计算的自然输入（`myChips`/`opponentCeiling` 已经在参与加注封顶的计算），不需要额外的特判分支——SPR 低时，小尺度加注的 EV 通常打不过"梭哈"或"弃牌"，三选一的 EV 比较会自然倾向这两端。
- **翻前浅筹码（push/fold）**：`effectiveStackBB = effectiveStack / bigBlind`（`pickAction` 新增 `bigBlind` 入参，`PveSession` 已有 `this.bigBlind`，直接传）。当 `effectiveStackBB <= SHORT_STACK_BB_THRESHOLD`（建议 15）时，加注候选额固定为"全下"（不再用 `raiseSizeFraction` 算尺度），只比较 `EV(fold)` vs `EV(all-in)` 两个选项——这是标准 push/fold 理论的直接落地，也是"不做的话浅筹码根本不会自然出现全下"的必要特判（`raiseSizeFraction` 是按底池比例算尺码的，筹码很浅时按底池比例算出来的加注额远小于全下，不会自动收敛到 push/fold 行为）。

## 风格 → EV 计算里的认知偏差

风格不再加减概率表，改成对 EV 计算输入的偏差乘数：

```js
const STYLE_EV_BIAS = {
  steady:         { varianceDiscount: 0.85 },  // 高方差动作（raise/allin）的 EV 打折，模拟风险厌恶
  aggressive:     { varianceBoost: 1.15 },      // EV 相近时偏好方差更大的选项（更容易选 raise 而非 call）
  bluffer:        { foldEquityMultiplier: 1.2 }, // 高估自己的弃牌权益
  callingStation: { equityMultiplier: 1.1 },    // 高估自己的胜率（算 EV(call) 前对 equity 先乘这个系数，封顶 1.0）
};
```

单挑模式（`style: null`）不受影响，等价于四个乘数全部是 1（不调整）。

## 保留的随机性（诈唬层）

EV 选出最优动作之后，不是无条件执行：胜率明显偏低（低于某个阈值，比如 `computeEquity` 结果 ≤ 0.30）且 EV-最优动作是弃牌时，保留一个小概率（建议 `BLUFF_DEVIATION_RATE = 0.08`~`0.10`）不按最优走、改成诈唬式加注——避免"胜率一低就必弃牌"这种能被一眼看穿的规律。这一层在 EV-argmax 算完之后叠加，是最后一步，不影响 EV 计算本身。

## 接口变更

`pickAction(params)` 新增两个必需字段（PveSession 调用方需要一并更新）：
- `liveOpponentCount`（number）
- `bigBlind`（number）

`opponentCeiling` 参数含义不变（其实一直就是 `effectiveStack`，只是命名历史遗留，这轮顺便在内部把它当 `effectiveStack` 用，不强制改名以减少无关改动）。

`style` 参数含义变化：不再是概率表 delta 表的 key，而是 `STYLE_EV_BIAS` 的 key——`PveSession.buildAiSeats()` 随机分配的 style 值（`steady`/`aggressive`/`bluffer`/`callingStation`）保持不变，只是消费方式变了，`PveSession.js` 侧不需要改动。

## 测试策略

- `pveStrategy.test.js` 里 `PREFLOP_TABLE`/`POSTFLOP_BANDS`/`contextDeltas`/`adjustDistribution`/`STYLE_DELTAS` 相关的旧测试整体删除或按新机制重写（旧机制被整体替换，不是新增）。
- 新增：`computeEV`（或等价的内部函数，具体导出粒度留给实施阶段决定）对 fold/call/raise 三种情况的单元测试，用手算的期望值核对公式实现正确。
- 新增：弃牌权益聚合公式 `p^n` 的测试（`liveOpponentCount` 从 1 到 7 时的单调性/具体数值）。
- 新增：浅筹码 push/fold 分支的测试（`effectiveStackBB` 跨过阈值前后，加注候选是否正确切换成"全下"，是否只比较 fold/all-in 两个选项）。
- 新增：四种风格的 EV 偏差方向测试（同一局面下，`bluffer` 更容易选 raise、`callingStation` 更容易选 call、`steady` 更少选高方差动作、`aggressive` 相反）。
- `PveSession.test.js`：更新 `aiAction()` 调用 `pickAction` 时传入的参数（新增 `liveOpponentCount`/`bigBlind`），确认现有的多坐位/摊牌/风格相关测试在新机制下依然成立（可能需要调整具体断言的数值，机制变了、结论不能直接照搬旧测试的期望值）。
- 真机/Playwright 走几局完整对局（单挑 + 多人桌各至少一局），确认没有明显的死循环/异常动作（比如浅筹码时是否真的会在合适的时候全下）。

## 明确不做（这轮范围之外）

- 不枚举/优化连续加注尺度，沿用现有极化启发式选一个候选
- 不做真正的多街前瞻（跟现在一样，用胜率模拟"如果现在摊牌"当近似，不单独建模"这一注下完以后对手还会怎么加/怎么诈唬我"）
- 多人锅不逐个建模每个对手的弃牌概率，只做聚合估计（`p^n`）
- 不做 ICM/锦标赛权益模型——这是现金局式的筹码最大化（破产直接补满重买，见现有 `_dealNewHand` 逻辑），不是锦标赛生存模型，聚合胜率×底池的筹码 EV 就是正确的目标函数，不需要 ICM 那层复杂度
