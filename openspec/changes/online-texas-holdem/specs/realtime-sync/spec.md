## ADDED Requirements

### Requirement: WebSocket 实时连接
系统 SHALL 通过 WebSocket（Socket.io）维持服务端与每个客户端的持久连接，用于双向实时通信。

#### Scenario: 建立连接
- **WHEN** 玩家进入房间页面
- **THEN** 客户端与服务端建立 Socket.io 连接，服务端将该 socket 加入对应 room channel

#### Scenario: 断线处理
- **WHEN** 玩家 socket 断开连接
- **THEN** 若在游戏中，该玩家自动 Fold；服务端广播玩家离线通知；游戏继续

### Requirement: 游戏状态广播
服务端 SHALL 在每次状态变化后向房间内所有玩家广播更新，且每个玩家只收到自己有权看到的信息。

#### Scenario: 状态变化广播
- **WHEN** 任何游戏状态发生变化（玩家操作、发牌、街次切换）
- **THEN** 服务端在 100ms 内向所有房间玩家发送更新后的公开状态

#### Scenario: 手牌隐私保护
- **WHEN** 服务端广播游戏状态
- **THEN** 每个玩家只能看到自己的手牌，其他玩家手牌显示为「隐藏」，仅在摊牌时展示

### Requirement: 操作事件传递
客户端 SHALL 通过 Socket.io 事件向服务端发送玩家操作，服务端验证后更新状态并广播。

#### Scenario: 合法操作处理
- **WHEN** 轮到某玩家行动时，该玩家发送操作事件（fold/check/call/raise）
- **THEN** 服务端验证操作合法性，更新游戏状态，广播新状态给所有玩家

#### Scenario: 非法操作拒绝
- **WHEN** 非当前行动玩家发送操作事件，或操作不合规则
- **THEN** 服务端忽略该事件，仅向发送者返回错误消息，游戏状态不变
