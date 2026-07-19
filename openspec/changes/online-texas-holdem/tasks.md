## 1. 项目初始化与依赖

- [x] 1.1 初始化 Node.js 项目（`npm init`），安装后端依赖：`express`、`socket.io`、`pokersolver`
- [x] 1.2 使用 Vite 初始化 React 前端项目，安装 `socket.io-client`
- [x] 1.3 配置开发环境：后端 `node --watch` 热重载，前端 Vite dev server

## 2. 游戏引擎核心

- [x] 2.1 实现 `Deck` 类：52 张牌生成、Fisher-Yates 洗牌算法 — `GameEngine.js` `makeDeck`/`shuffle`
- [x] 2.2 实现 `GameState` 数据结构：players、communityCards、pot、phase、currentBet 等字段
- [x] 2.3 实现盲注逻辑：庄家位确定、SB/BB 自动下注、行动顺序计算
- [x] 2.4 实现下注轮次状态机：preflop → flop → turn → river → showdown 流转逻辑
- [x] 2.5 实现玩家操作处理：fold/check/call/raise 合法性校验与状态更新
- [x] 2.6 集成 `pokersolver` 实现摊牌判定：取每位玩家最佳 5 张牌型、多人比较、平局处理
- [x] 2.7 实现边池（Side Pot）计算逻辑（All-In 场景）— `GameEngine._buildSidePots`/`_endHand`；修复了此前"不等额 All-In 时短码玩家赢得全部底池"的错误分配 bug，见 `GameEngine.scenarios.test.js`「边池」用例
- [x] 2.8 实现底池分配与下一局初始化：筹码结算、庄家位轮换（超时自动 fold 已取消，见 4.4）

## 3. 房间管理（后端）

- [x] 3.1 实现 `RoomManager`：创建房间（生成唯一 6 位码）、加入/离开房间、内存存储
- [x] 3.2 实现房主踢人功能 — `room:kick` 已实现（server/index.js + Lobby.jsx 房主可见的"移出"按钮），补充集成测试覆盖成功踢人与非房主踢人被静默忽略两种情况
- [x] 3.3 房间座位上限（统一 9 人）与不存在校验：满 9 人即拒绝加入并返回"房间已满，无法加入"（见 design.md 容量决策）；与 S4"游戏中途加人拒绝"为两条独立校验

## 4. WebSocket 服务（后端）

- [x] 4.1 配置 Socket.io，定义事件：`room:create`/`room:join`/`room:start`/`game:action`/`room:kick` 等（详见 index.js）
- [x] 4.2 实现状态广播：每次状态变化后对房间 channel 广播，手牌按玩家身份过滤 — 修复了"筹码归零导致游戏结束"分支曾经只发 `game:ended` 不发 `room:state` 的 bug（大厅筹码/借一底按钮不会更新），见 `integration.test.js` 回归用例
- [x] 4.3 实现断线处理：socket 断开时自动 fold 并广播玩家离线
- [x] ~~4.4 实现操作超时（30 秒）：服务端 setTimeout 到期后自动 check/fold~~ **已取消** — 用户决策：不加超时，体验上朋友局不需要强制限时

## 5. 前端 — 路由与状态管理

- [x] 5.1 配置 React Router：`/`（首页）、`/room/:code`（房间页）
- [x] 5.2 封装 `useSocket` hook，管理 Socket.io 连接与事件监听
- [x] 5.3 用 React 组件内 state（RoomPage）管理房间/游戏状态（未引入 Context/Zustand，规模上足够）

## 6. 前端 — 页面与组件

- [x] 6.1 实现首页：昵称输入、创建房间按钮、加入房间（输入码）按钮
- [x] 6.2 实现等待室：玩家列表、房间码展示、复制邀请链接、开始游戏按钮（房主限定）
- [x] 6.3 实现牌桌布局：椭圆形桌面、玩家座位分布（支持 2-9 人）、庄家/SB/BB 标记
- [x] 6.4 实现公共牌区域：5 张牌位，未发出的显示牌背
- [x] 6.5 实现玩家卡片组件：昵称、筹码、当前注、状态标签（active/folded/all-in）、高亮当前操作者
- [x] 6.6 实现手牌展示：本玩家正面朝上，其他玩家牌背，摊牌翻开动画
- [x] 6.7 实现操作按钮区：Fold/Check/Call/Raise，Raise 附带 stepper（未做拖动 slider，点击 +/- 步进）
- [x] ~~6.8 实现倒计时组件：当前操作玩家显示 30 秒倒计时进度条~~ **已取消** — 同 4.4，整个倒计时功能移除
- [x] 6.9 实现结算界面：获胜者高亮、赢得筹码提示、自动进入下一局（SettlementModal，见 8.1/8.2）

## 8. 场景补全（来自用户场景评审）

- [x] 8.1 实现"重新开始"功能：`room:restart` 事件，服务端重置所有玩家筹码为初始值，状态回到 waiting，广播 `room:state`
- [x] 8.2 前端大厅显示"重新开始"按钮（房主限定）
- [x] 8.3 为 S5 场景补充单元 + 集成 + E2E 测试（共 7 个新测试）
- [x] 8.4 S2/S3/S4 场景 E2E 测试（断线、筹码归零、中途加人）— 新增 S3「全下分出胜负后落败方归零 → 游戏因筹码不足结束 → 借一底后可重新开始」完整流程用例（e2e/game.spec.js），过程中发现并修复了 4.2 记录的 room:state 广播 bug

## 9. 迭代变更（对话评审后）

- [x] 9.1 房间码改为 6 位纯数字（原：字母数字混合），方便口头分享
- [x] 9.2 UX：行动玩家高亮改为脉冲发光动画 + 顶部 shimmer 线
- [x] 9.3 UX：下注金额从右下角小字改为座位内居中筹码徽章
- [x] 9.6 移动端椭圆牌桌布局：英雄固定底部中央，绝对坐标定位 2-9 人座位，消除手牌重复显示，下注筹码浮动至桌面中心方向
- [x] 9.4 筹码归零 Rebuy（借一底）：玩家输光后留在房间（不被踢出），大厅可借一底 ¥1,000，累计 debt 广播给全员；nextRound 仅让 chips>0 的玩家入局
- [x] 9.5 调整初始筹码为 ¥1,000，小盲 ¥10，大盲 ¥20
- [x] 9.7 UI 精修：对手头像坐上椭圆 rail、统一座位渲染、对手座位精简为头像+角标+筹码（无姓名）— 已落地 PlayerSeat.jsx/.css + RoomPage
- [x] 9.8 UI：底池区上方加低调街道指示（翻牌前/翻牌/转牌/河牌）；顶栏只留房间码 — 已落地 RoomPage
- [x] 9.9 关键节点动效：deal-in（发牌飞入 stagger）、flip-reveal（公共牌 3D 翻面）、chipAppear（下注筹码淡入）、pot-burst（摊牌底池闪光）、slideUp（action bar 滑入）— 均已落地 velvet.css + Card.jsx + Pot.jsx + GameTable.jsx
- [x] 9.10 视觉层级与配色：去边框药丸、统一象牙角标、底池纯发光 DM Serif 数字、后手冷色 platinum、弃牌实心压暗 — 已落地 tokens.css + Card.css + PlayerSeat.css + RoomPage.css
- [x] 9.11 货币符号统一为人民币 ¥ — 已落地 client（RoomPage 大厅/底池/当前注/下注、座位后手）
- [x] 9.12 牌桌容量 2–9 人：头像随桌大小缩放（≤6 人 46px，7–9 人 38px），9 人桌已验证可行；座位按椭圆等角度均分+左右镜像对称
- [x] 9.13 容量统一 9 人（移动端与 PC 一致，不分端）；满 9 人拒绝加入"房间已满"（见 design.md 容量决策）

## 7. 收尾与测试

- [x] 7.1 在本地同时打开 2 个浏览器标签页，验证完整一局流程（preflop → showdown）— 用 Playwright 双页驱动真实浏览器走完整流程验证（非 UI 打磨），过牌到摊牌、全下到摊牌均已验证
- [x] 7.2 验证边界情况：All-In、只剩一人获胜（超时自动操作已取消，不适用）— All-In 双人对局在真实浏览器中验证；不等额多人 All-In 边池分配用单元测试覆盖（见 2.7）
- [x] 7.3 移动端响应式检查 — 已完成，添加 480px/640px 断点适配所有页面
- [x] 7.4 构建生产包（`npm run build`），确认静态资源正常加载

## 10. Bug 修复记录

- [x] 10.1 边池分配错误：不等额 All-In 时，全场最强牌力的短码玩家会赢得包括边池在内的全部底池（应只赢主池，边池只在没被短码封顶的玩家间瓜分）。修复：`GameEngine.js` 新增 `_buildSidePots()`，`_endHand` 按池层分别结算。回归测试：`GameEngine.scenarios.test.js`「边池」describe 块（2 个用例）
- [x] 10.2 筹码归零导致游戏结束时，大厅数据不更新：`nextRound()` 返回 `ended:true` 时，服务端只广播了 `game:ended`，没有再广播 `room:state`，导致落败玩家的客户端筹码显示、"+借一底"按钮都停留在游戏开始前的旧数据，需要手动刷新/离开重进才能看到。修复：`server/index.js` 的 `handleActionResult` 里，`nextRound()` 之后统一调用 `broadcastRoom(room)`。回归测试：`integration.test.js`「筹码归零导致游戏结束时...」+ `e2e/game.spec.js` S3 场景（真实浏览器复现过一次，确认修复前后行为差异）

## 11. 用户实测反馈修复（2026-07-17）

- [x] 11.1 加注/全下金额不能超过玩家自己筹码——服务端 `raise()` 补上限校验（GameEngine.js）
- [x] 11.2 一方 All-In 后，剩余唯一可行动玩家不应再被要求继续操作——`_nextStreet()` 补"≤1可行动玩家自动摊牌"判断（GameEngine.js）
- [x] 11.3 移动端缩放常量修复：`useStageScale.js` 高度基准 712→812，修正顶部内容溢出屏幕
- [x] 11.4 结算流程改为"所有人确认才推进"：新增 `game:ready-next` 协议 + 15 秒兜底超时
- [x] 11.5 结算面板改为底部抽屉（不再遮挡摊牌），展示全部赢家（含边池场景的多个赢家）
- [x] 11.6 牌桌座位环新增本人座位标记
- [x] 11.7 压缩底部操作区域尺寸
- [x] 11.8 行动方高亮动画加强
- [x] 11.9 下注气泡加"指向头像"的视觉样式
- [x] 11.10 金额统一 Inter 字体，底池数字缩小
- [x] 11.11 加注区新增 All-In 快捷按钮
- [x] 11.12 单挑（1v1）时对手座位飘出屏幕：`useStageScale.js` 的 `vh` 改用 `window.screen.height` 后（11.3 引入），只要浏览器地址栏可见（`screen.height > innerHeight`），算出的 scale 就偏大，画布顶部被推出可见视口——单挑时唯一的对手座位正好在桌面顶点，首当其冲。修复：`vh` 改回读 `visualViewport.height`（回退 `innerHeight`），并监听 `visualViewport.resize`。详见 design.md「移动端设计规范」踩坑记录

**已知边界情况（记录不修）**：`GameEngine` 构造函数在两人筹码都低于盲注、开局即全下的极端场景下，`actionIndex` 会变成 -1 导致牌局卡死无法自动摊牌（`GameEngine.js:68-74`）。触发概率低（需要玩家被打到个位数筹码），完整修复需要改 `Room.startGame()`/`nextRound()` 让调用方感知"构造时即结束"，改动面较大，本轮不做，需要时单独立项。

## 12. 用户实测反馈修复（第二轮，2026-07-18）

- [x] 12.1 英雄手牌离自己头像太近，行动高亮发光动画视觉上"糊"到牌上：`GameTable.jsx` 座位上移量 `-20`→`-45`，间距 ~15px→~40px
- [x] 12.2 对手座位新增 `MIN_OPPONENT_Y` 下限，避免摊牌揭牌区域跟顶部状态栏重叠（单挑时唯一对手座位、9 人桌顶点座位都受影响）
- [x] 12.3 加注面板新增「1/3 池」「2/3 池」「满池」「2倍超池」快捷预设按钮（`ActionBar.jsx`）
- [x] 12.4 行动方头像新增双圈雷达 ping 动画，叠加在原有脉冲发光之上（`.seat.is-active::before/::after`）
- [x] 12.5 新增行动反馈气泡：对手行动后从头像上方弹出"过牌/跟注 ¥X/加注 ¥X/弃牌/ALL IN"提示，1.6s 后淡出（纯前端状态推断，无需服务端新增事件）
- [x] 12.6 摊牌全员亮牌：确认服务端/客户端链路本来就通（`getStateForPlayer` 在 showdown 阶段下发全员 holeCards，`PlayerSeat` 已渲染 `.reveal`），此前"看不到"是 12.2 的座位重叠问题，随之修复，无需额外改动
- [x] 12.7 英雄手牌区下方空白过大：压缩加注面板高度（预设按钮/stepper/间距/padding 都收紧），`.hero-section` 的 `bottom` 从 178px 降到 148px（数值由实测的加注面板展开高度反推，留 ~6px 安全余量，不会跟展开的加注面板重叠）。曾尝试直接降到 120px 靠 z-index 盖住英雄信息条省空间，实测发现操作栏渐变背景在该区域是渐隐的，文字会糊在一起，弃用该方案，详见 design.md「用户实测反馈第三轮」
- [x] 12.8 加注预设补上「半池」（1/2 池，`ActionBar.jsx`，现为 1/3・半池・2/3・满池・2倍超池 共 5 档）
- [x] 12.9 英雄手牌尺寸从 `lg`(62×84) 缩到 `md`(52×72)，进一步收窄手牌区下方空白，用户反馈"手牌是不是可以小一点"
- [x] 12.10 用户反馈"手牌跟头像的关系不居中"：`.pos-badge`（D/SB/BB）默认 `bottom:-4px;right:-5px`，是为了在对手座位上避开正下方居中的 `.stack-chip`；但英雄座位的 `.stack-chip` 本来就是隐藏的（筹码显示在下方大卡里），这个右偏移就白白让头像+徽章这一整簇看起来往右歪，跟正下方精确居中的手牌对不上。新增 `.player-slot--hero .pos-badge` 覆盖规则把徽章改回水平居中，只影响英雄座位，不影响对手座位的避让逻辑。实测确认头像、徽章、手牌三者中心点完全重合
