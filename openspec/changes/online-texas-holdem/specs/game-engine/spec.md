## ADDED Requirements

### Requirement: 发牌与街次流转
系统 SHALL 按照标准 No-Limit Texas Hold'em 规则进行发牌和街次推进。

#### Scenario: Preflop 发牌
- **WHEN** 游戏开始
- **THEN** 系统随机洗牌，每位玩家发 2 张暗牌，小盲/大盲自动下注，从大盲左侧开始行动

#### Scenario: 翻牌圈（Flop）
- **WHEN** Preflop 下注轮结束
- **THEN** 系统翻出 3 张公共牌，从小盲位开始新一轮下注

#### Scenario: 转牌（Turn）和河牌（River）
- **WHEN** 上一街下注轮结束
- **THEN** 系统各翻出 1 张公共牌，开始新一轮下注

#### Scenario: 摊牌（Showdown）
- **WHEN** 河牌下注轮结束且剩余活跃玩家 ≥ 2
- **THEN** 系统展示所有未弃牌玩家手牌，计算最佳 5 张牌型，判定获胜者，底池分配给获胜者

### Requirement: 下注操作
玩家 SHALL 能够执行 Fold、Check、Call、Raise 操作，系统 SHALL 验证操作合法性。

#### Scenario: Fold 弃牌
- **WHEN** 玩家选择 Fold
- **THEN** 玩家退出本轮，其手牌不公开，游戏继续

#### Scenario: Call 跟注
- **WHEN** 玩家选择 Call
- **THEN** 玩家筹码减少至与当前最高注相同，底池增加对应金额

#### Scenario: Raise 加注
- **WHEN** 玩家输入加注金额并确认，且金额 ≥ 当前最高注的 2 倍
- **THEN** 当前最高注更新，其他玩家需重新决策

#### Scenario: All-In
- **WHEN** 玩家筹码不足以 Call 全额
- **THEN** 玩家可选择 All-In，投入全部剩余筹码，系统自动处理边池

### Requirement: 胜负判定与底池分配
系统 SHALL 在摊牌时正确比较牌型并分配底池，支持边池（Side Pot）。

#### Scenario: 单底池胜者
- **WHEN** 只有一个底池且有一个最强牌型
- **THEN** 获胜玩家获得全部底池筹码

#### Scenario: 平局分池
- **WHEN** 多个玩家牌型相同且最强
- **THEN** 底池平均分配给这些玩家（零头归入下一局）

#### Scenario: 剩余一人获胜
- **WHEN** 其他玩家全部弃牌只剩一名活跃玩家
- **THEN** 该玩家直接获得底池，无需摊牌

### Requirement: 盲注与庄家位循环
系统 SHALL 在每局结束后自动轮换庄家（Dealer Button）、小盲（SB）、大盲（BB）位置。

#### Scenario: 庄家位轮换
- **WHEN** 一局结束后开始新一局
- **THEN** 庄家标记顺时针移至下一位活跃玩家，SB/BB 相应更新
