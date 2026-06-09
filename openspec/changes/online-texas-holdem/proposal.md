## Why

用户需要一个可以和朋友在线实时对战的德州扑克小工具，目前没有轻量级、无需注册、直接分享房间链接就能玩的解决方案。

## What Changes

- 新增一个基于 Web 的德州扑克多人在线游戏，支持实时通信
- 玩家通过分享房间链接邀请朋友加入，无需注册账号
- 实现完整的德州扑克游戏规则：盲注、下注、翻牌/转牌/河牌、摊牌判定
- 实时同步所有玩家的游戏状态（牌面、筹码、下注）

## Capabilities

### New Capabilities

- `room-management`: 创建/加入游戏房间，生成唯一房间链接，管理玩家席位（2-9人）
- `game-engine`: 德州扑克核心逻辑——洗牌发牌、街次流转、下注轮次、底池计算、胜负判定
- `realtime-sync`: 基于 WebSocket 的实时状态同步，广播游戏事件给房间内所有玩家
- `player-ui`: 玩家操作界面——查看手牌、公共牌、筹码、下注按钮（Fold/Check/Call/Raise）

### Modified Capabilities

## Impact

- 新项目，无现有代码影响
- 依赖：Node.js + Express（后端）、Socket.io（实时通信）、React（前端 UI）
- 需要部署一个持久运行的 Node 服务来维持 WebSocket 连接
