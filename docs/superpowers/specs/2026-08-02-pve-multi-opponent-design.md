# PVE 多人机对战（1 人 vs 多个电脑）

## 背景

现有人机对战（PVE）严格是单挑（1 人 vs 1 电脑），`PveSession.js` 里 `this.aiId`/`this.aiName` 都是单数，结构上没法扩展。用户希望能选择跟多个电脑同桌（而不只是单挑）。

跨多局分析玩家打法、给出建议这个想法本次**不在范围内**——用户已确认先做多电脑对战，建议/复盘功能留到以后单独一轮设计。

## 架构判断

底层大部分组件已经是"通用多人"的，不需要为这个功能重新设计：

- `GameEngine.js`（发牌/下注/边池/摊牌）本来就不区分人数，多人房间（`RoomManager`）一直在用同一个引擎跑 2-9 人桌。
- `server/index.js` 的 `pveRunAiLoop()` 已经是"只要 `isAiTurn()` 还成立就继续走"的循环，不是"只跑一次"的写法——已经能处理连续多个 AI 坐位依次行动。
- 客户端 `GameTable` 组件已有 7-9 人密集桌样式（`.game-stage--dense`），多人房间场景已验证过。
- `SettlementModal.jsx` 的 `winners` 本来就是数组、遍历渲染——摊牌结算本来就没有"只能一个赢家"的假设。

真正写死"只有一个电脑"的地方只有 `PveSession.js`（`this.aiId`/`this.aiName` 单数字段、`isAiTurn()`/`aiAction()` 按单一 id 判断）。这个功能因此是一个**范围很小的结构性改动**，不需要碰 `GameEngine`、AI 出牌调度循环、牌桌渲染组件。

## 范围（本次做什么，不做什么）

**做：**
- 桌形固定四档：单挑 / 4 人 / 6 人 / 8 人（不开放任意数字）——单挑即现有行为，保留不变
- 每个电脑坐位随机分配一个风格预设（微调打法概率），风格对玩家不可见
- 开局新增一步"选人数"（HomePage 的"人机对战"入口点了以后，先选桌形再进入对局）

**明确不做（YAGNI，用户已确认）：**
- 不做难度分层——所有电脑维持现有单挑 AI 的判断精度，没有"简单档故意犯错"这类逻辑
- 不做多人桌的翻前范围收紧——翻前起手牌范围表直接照搬单挑那套，不因为人数变多而调紧
- 不做跨对手的剥削性数据追踪（`oppStats`）——多电脑场景下 `_opponentReads()` 相关的剥削性调整这次不接入，只保留单挑模式原有行为
- 不做风格展示 UI——风格分配了但不告诉玩家，没有"电脑A是保守型"这样的标签

## 组件改动

### 1. `server/pveStrategy.js`：新增风格微调表

新增一张风格→概率微调表，复用文件里已有的"根因表 + 微调量"模式（与位置调整、剥削性调整是同一种写法，不引入新概念）。四个预设（稳健/激进/诈唬/跟注型）各自对 `PREFLOP_TABLE`/`POSTFLOP_BANDS` 的 fold/call/raise 概率做小幅加减（同一手牌强度下，稳健型更容易 fold、激进型更容易 raise，以此类推），不改变分档判断本身（`preflopTier`/`bandFor` 逻辑不动）。

`pickAction()` 新增一个可选 `style` 参数，默认 `null`（不调整，即现有单挑行为原样保留），单元测试新增每个风格的微调方向断言（比如同一手牌，激进型的 raise 概率应该比不传 style 时更高）。

### 2. `server/PveSession.js`：单 AI → 多 AI 坐位

- `this.aiId`（字符串）→ `this.aiSeats`（数组，每项 `{ id, name, style }`），构造函数按传入的桌形人数生成对应数量的 AI 坐位，风格从四个预设里随机分配（允许重复，不强制四人四风格）
- `AI_ID`/`AI_NAME` 常量改成按坐位序号生成 id（如 `__ai_1__`）+ 占位名字（如"电脑1"/"电脑2"，不体现风格，避免泄露）
- `isAiTurn()`：判断 `actionPlayerId` 是否在 `aiSeats` 的 id 集合里（而不是等于单一 `aiId`）
- `aiAction()`：先找出当前行动的是哪个 AI 坐位，取它的 `style` 传给 `strategy.pickAction()`
- `_opponentReads()` 相关的剥削性调整调用**保留但不改**——多 AI 场景下 `pickAction()` 收到的 `opponentAggressionRate`/`opponentFoldToRaiseRate` 沿用同一份 `this.oppStats`（不拆分成每坐位一份，按本次范围决策不做跨对手追踪，所以直接复用现有单一份数据即可，行为上约等于"暂不启用"）
- 构造函数签名新增桌形参数（如 `seatCount`），默认 2（保持单挑场景的现有调用方不用改）

### 3. `server/index.js`：`pve:start` 透传桌形

`pve:start` 的 payload 新增 `seatCount` 字段，透传给 `new PveSession(...)`。`pveRunAiLoop`/`pveHandleResult` 等不需要改（已经是通用循环）。

### 4. `client/src/pages/HomePage.jsx`：新增选人数步骤

点击"人机对战"后，不直接调用 `onPve(name)`，先展开一个人数选择（单挑/4人/6人/8人四个卡片，样式参考现有的"创建/加入房间"卡片），选完再调用 `onPve(name, seatCount)`，`App.jsx`/`PvePage.jsx` 透传到 `pve:start`。

### 5. `client/src/pages/PvePage.jsx` / `GameTable`

预期不需要改动逻辑——`gameState.players` 数组本来就是遍历渲染。需要真机/多视口验证 8 人桌下 UI 不溢出、不重叠（复用现有 `.game-stage--dense` 密集桌样式；如果 8 人桌实测有裁切问题，按项目一贯做法用 Playwright 量真实 bounding box 确认，不能手算认为没问题）。

## 测试

- `pveStrategy.test.js`：新增风格微调方向的断言（同一输入下，各风格相对基线的概率偏移方向正确）
- `PveSession.test.js`：新增多坐位场景测试——构造 4/6/8 人 session，断言 AI 坐位数量正确、`isAiTurn()`/`aiAction()` 能正确轮转所有 AI 坐位、边池/摊牌结算多人场景下金额守恒（复用已有的"筹码守恒"断言模式）
- 真机 Playwright：8 人桌视觉验证（不溢出、不重叠），完整走一局 4 人/6 人/8 人局确认能正常进行到摊牌结算
- 服务端全量单测跑通，客户端构建通过

## 已知限制 / 留待以后

- 多人桌翻前范围、跨对手剥削性追踪：本次不做，行为上"能打，但不是为多人桌专门调过的强度"
- 电脑坐位名字用占位"电脑1/电脑2"这类，不做更有辨识度的命名（如果之后要做，风格保密的前提下需要想一套不泄露信息的命名方式）
- 打法分析/建议功能：不在本次范围，是独立的下一个项目
