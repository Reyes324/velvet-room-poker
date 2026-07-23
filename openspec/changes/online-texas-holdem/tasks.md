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

## 13. 每局开局发牌动画（第四轮，2026-07-18）

- [x] 13.1 修复 `justDealt` 判断条件只在组件首次挂载时成立的 bug（`GameEngine.js:9.9` 落地时的遗留问题），改成检测"进入 preflop"的转变，每一局开局都会触发，不再只播一次
- [x] 13.2 新增 `sbFirstOrder()`，按真实规则从小盲位置开始轮转排座，发牌 stagger 延迟按"轮次×人数+座位序号"计算（两轮，每人 2 张）
- [x] 13.3 对手座位在发牌期间新增背面小卡展示（复用 `.reveal` 定位槽位，跟摊牌揭牌互斥不冲突），按发牌顺序 stagger 弹入，发牌流程结束后消失
- [x] 13.4 英雄手牌先以背面按同样顺序 stagger 弹入，全桌发完后统一翻面（复用已有 `flip-reveal`），翻牌即"正式开始这一局"
- [x] 13.5 修复：翻面倒计时的 `useEffect` 依赖误写成一次性脉冲值 `justDealt`，导致下一次 render 就把刚设的 timeout 取消掉、牌永远翻不回正面；改成依赖 `gameState.phase`（整个 preflop 轮内稳定，只在真正进入 preflop 时触发一次）。回归测试（Playwright 连续验证两手牌）确认发牌动效在每一局都正确重播

## 13b. 发牌动画补全：公共牌先扣着发下来，到点再翻（第十一轮，2026-07-19）

- [ ] 13b.1 发牌顺序追加一段：手牌发完 → 5 张公共牌扣着按 stagger 摆上桌（新增）→ 英雄翻面；`totalDealTime` 顺延，覆盖新增的公共牌摆牌时间
- [ ] 13b.2 公共牌槽位从"没数据画虚线空框"改成"已经发过牌但没揭晓时画背面卡牌"，只有整手牌还没开始发（`waiting`/还没 `justDealt` 过）时才保留虚线空框
- [ ] 13b.3 街道揭晓时刻沿用现成 `flip-reveal`（`rotateY(-90deg)→0deg`），从"背面卡牌"切换成"正面卡牌+flip-reveal"，不用改动画关键帧本身，只改"翻牌前那张背面牌在不在"
- [ ] 13b.4 回归验证（Playwright 截图逐帧）：手牌发完瞬间 5 个公共牌槽位已是背面卡牌；翻牌/转牌/河牌揭晓瞬间对应槽位翻正面、其余仍背面；发牌总时长/英雄翻面时机正确顺延

## 14. 牌桌椭圆放大 + 头像贴边线（第五轮，2026-07-18）

- [x] 14.1 `.table-oval` 放大：rx 159.5→169.5，ry 180→195（两侧留白 28→18px，顶部往上顶到贴近状态栏留 14px 安全间隙；底部因为挨着英雄手牌区基本没有再放大的空间）
- [x] 14.2 `seatPositions()` 的 `cx/cy/rx/ry` 改为跟 `.table-oval` 实际盒子精确对应（此前两处数值有约 4px 历史误差），对手座位坐标现在是椭圆边线上的真实坐标，不再偏内侧
- [x] 14.3 `MIN_OPPONENT_Y` 安全下限保留（145，数值不变）——顶部状态栏是跟椭圆大小无关的硬约束，椭圆顶点位置的座位（单挑唯一对手/9人桌正上方座位）仍需要这条安全线，其余座位都精确落在新边线上。回归测试（Playwright，1v1 + 4 人桌）确认无遮挡、无溢出

## 15. 头像统一贴边线，去掉例外（第六轮，2026-07-18）

- [x] 15.1 英雄座位改用 `cy + ry`（椭圆真实顶点，去掉 -45px 上移）：实测后续改动（手牌 lg→md、`.hero-section` 下移）已经把间距顶到 ~74px，完全撤销上移后仍有 ~29px 安全间距，比原始触发 bug 的 15px 宽裕得多
- [x] 15.2 `MIN_OPPONENT_Y` 座位下限改造成 `CARDS_SIDE_BELOW_Y`（阈值仍是 148/145，语义从"压低座位"变成"卡片换方向"）：座位坐标不再被压低，改成让摊牌揭牌/发牌小卡片、行动气泡在座位 y 低于阈值时渲染到头像左右两侧（就近选靠近桌子中心的一侧）而不是正上方，从而不撞顶部状态栏
- [x] 15.3 修复 bet-chip "朝向池子中心" 方向向量误用了英雄座位坐标（应该用椭圆几何中心 187.5/285），是上一步改动时手滑引入的，构建前就发现并修正
- [x] 15.4 回归测试（Playwright，1v1 + 4 人桌）确认：头像中心坐标跟椭圆边线坐标完全相等（含英雄、含椭圆顶点），无遮挡、无溢出

## 16. 修复"房间不存在"根因 + 邀请体验补全（第七轮，2026-07-19）

- [x] 16.1 **根因修复**：大厅（`room.status==='waiting'`）阶段的 socket 断线不再立即 `rooms.leave()`，改为宽限期定时器（初始 30 秒，用户反馈"可能不够"后改为 120 秒），到期时检查玩家是否已用新 socket 重新关联（未关联才真正移除）。修复了"房主建房后切 App 分享链接，手机浏览器挂起标签页导致 socket 短暂断开 → 房间被立即删除 → 朋友点链接提示'房间不存在'"这个根因。游戏进行中的断线仍立即处理（自动 fold + 移除），不受影响
- [x] 16.9 新增 `room:gone` 事件：`room:sync` 找不到房间时（超过宽限期才回来，房间已被真正移除）不再静默返回，显式告知客户端；`RoomPage.jsx` 弹出"重新连接超时，房间已失效，请重新创建或加入" toast，2.5 秒后跳回首页
- [x] 16.2 修复连带 bug：`room:sync` 从未真正执行"重新关联" —— 没调用 `room.updateSocket()`、没 `socket.join(room.code)`、没设置这条连接自己的 `myPlayerId`，导致重连后的客户端收不到后续广播、且这条连接自己下次断线时不会被正确处理。补全这三步
- [x] 16.3 `RoomPage.jsx` 的 `room:sync` 调用从"仅挂载时一次"改成"每次 socket `connect` 事件都发一次"（覆盖初次连接和之后任意一次重连），配合 16.1/16.2 让宽限期内的重连真正生效
- [x] 16.4 `useSocket.js` 新增 `window.__vrSocket` 调试钩子，用于测试直接强制断开/重连单个页面的 socket——`context.setOffline()`/CDP 网络模拟在这个沙盒环境里会影响同进程内其他不相关页面的网络，不适合模拟"只有一个玩家断线"的场景
- [x] 16.5 新增只读 `room:peek` socket 事件（`{code}` → `{hostName, playerCount}`，无副作用，不需要先加入），配合客户端在 `/room/XXXXXX` 深链接页面显示"「房主名字」邀请你加入战局"横幅
- [x] 16.6 大厅新增显式「🔗 复制邀请链接，分享给好友」按钮（原来只能点房间码数字复制，没有任何视觉提示是可点的）
- [x] 16.7 移动端首页布局排查：用户反馈"首页有些内容看不见"，多视口尺寸测试（含模拟地址栏可见的矮视口）均未复现，内容始终完整可见。暂时记录为未复现，需要用户提供实机截图才能继续定位
- [x] 16.8 端到端回归验证（Playwright，用页面内暴露的真实 socket 实例强制断开/重连，而非浏览器级离线模拟）：房主断线 3 秒期间房间不删除、朋友能成功加入、房主重连后正确看到朋友已在大厅

## 17. 移动端布局重构：顶部/底部贴边 + 仅中间牌桌缩放（第八轮，2026-07-19）

- [x] 17.1 定位 16.7 记录的"移动端有些内容看不见"用户实机截图后，确认是另一个问题：`.game-stage` 整体单一 `transform:scale` 缩放，浏览器上下 UI 占用高度较多时会把宽度一起顶小，两侧留白（不是内容被裁切/看不见，是整体变窄了）
- [x] 17.2 `.game-stage` 从固定 375×812+整体缩放改成 `width:100%;height:100dvh;display:flex;flex-direction:column`，`.top-bar`/`.action-bar`/`.waiting-bar`/`.lobby` 全部改成真实 flex 子元素（贴顶/贴底，宽度永远等于视口宽度），只有新增的 `.table-zone`+`.table-canvas`（牌桌椭圆+座位+英雄手牌）跟随剩余空间弹性缩放
- [x] 17.3 新增 `useTableScale.js`（`ResizeObserver` 直接测量牌桌区域实际渲染尺寸算缩放系数），删除 `useStageScale.js`（整页缩放逻辑作废）
- [x] 17.4 `GameTable.jsx` 座位/牌桌坐标因参考画布从 812 缩到 `TABLE_REF_H=610` 做了等比重新推导（`seatPositions() cy`、`table-oval` 顶部偏移、`hero-section bottom`、`CARDS_SIDE_BELOW_Y` 阈值）
- [x] 17.5 意外收益：加注面板不再可能覆盖英雄手牌信息条（`.action-bar` 现在是牌桌画布外的独立 flex 兄弟节点，面板变高会自动挤压牌桌区域整体缩小，而不是绝对定位重叠），第 12 轮为此专门做的像素级精调不再需要手动维护
- [x] 17.6 回归验证（Playwright，4 种视口含完全复现用户截图问题的场景 + 更极端场景）：顶部/底部宽度精确等于视口宽度、零溢出；加注面板展开截图确认全宽显示、不重叠

## 18. 顶部头像飘出 + 牌桌区域横纵独立缩放（第九轮，2026-07-19）

- [x] 18.1 用 Playwright 量出真实包围盒坐标，确认顶部对手头像飘出是真实几何 bug：`seatPositions()` 里最顶座位中心点 y=cy-ry=20，跟 `table-oval` CSS 顶部偏移 20px、头像自身半径 ~20px 三者几乎相等，设计上就是零边距，取整/边框一推就裁到 `.table-zone` 的 `overflow:hidden` 之外——3/4 测试视口下实测 ~1px 裁切
- [x] 18.2 `seatPositions()` 的 `ry` 从 195 收紧到 180（`table-oval` CSS `top`/`height` 同步从 20/390 改成 35/360），给最顶座位腾出约 15px 真实缓冲；`rx`/`cy` 不变
- [x] 18.3 `useTableScale.js` 从返回单一 `scale = min(w/refW, h/refH)` 改成返回独立的 `{scaleX, scaleY}`（分别等于容器实际宽/高 ÷ 参考宽/高），`GameTable.jsx` 改用 `scale(scaleX, scaleY)` 非等比缩放——牌桌区域横向永远贴满容器宽度，不再因为高度是瓶颈而两侧留白；代价是极端视口下头像轻微椭圆化（用户已认可此取舍）
- [x] 18.4 回归验证（Playwright，4 种视口 × 双方视角量头像包围盒 + 牌桌椭圆左右留白）：修复前 3/4 视口下顶部头像裁切 ~1px，修复后归零；牌桌椭圆左右留白始终等于设计稿 18px 按 scaleX 换算后的对称固定值，不再随高度瓶颈变化

## 19. 游戏中途加入 + 筹码归零个人决策 + 账本视图（第十轮，2026-07-19）

- [x] 19.1 两轮 Explore + 一轮 Plan 子代理逐行核实源码，确认 `GameEngine.js`/`server/index.js` 不需要改动（`GameEngine.players` 每手从 `Room.players` 重新过滤构建，插入点天然在两手之间）；确认并记录一个已存在的潜伏 bug：`GameTable.jsx` 的 `const me = ordered[0]` 在"我不在当前这一手玩家列表里"时会把某个真实对手的座位错误渲染成"我"，而不是报错或掉回大厅
- [x] 19.2 `Room.addPlayer`（`RoomManager.js`）去掉 `status!=='waiting'` 拒绝，只保留 9 人满座 + 重复 id 检查，中途加入的人从下一次 `nextRound()` 自动生效
- [x] 19.3 `Room.rebuy`（`RoomManager.js`）门禁从"仅 waiting 状态"改成"仅本人 chips===0"，与房间状态无关
- [x] 19.4 `Room.nextRound()` 庄位轮转从 `dealerIndex` 改成 `dealerId`（记玩家 id，下一手在新数组里找该 id 位置、顺延到下一个座位；找不到则退回座位 0）——顺带修复的潜伏 bug，不是用户原始请求，因为这两个新功能会让牌桌人数变动频率大幅提高
- [x] 19.5 `Room.getLobbyState()` 新增 `startingChips` 字段（server 单测 32/32 通过，全量 server 测试 75/75 通过）
- [x] 19.6 `RoomPage.jsx` 新增 `amPlaying`/`myRoomChips` 派生状态，`prevChipsRef` 检测本人筹码 `>0→0` 跳变触发决策弹窗；挂载新的 `BustDecisionModal`/`LedgerModal`
- [x] 19.7 `GameTable.jsx` 新增旁观渲染路径（不再回退到 `ordered[0]`）：座位几何新增"无英雄锚点、全员均匀分布在完整椭圆"的变体（`spectatorSeatPositions()`）；`dense` 判断、顶部筹码显示改用新 `myChips` prop；footer 扩成三态（正常参与 / 旁观等待下一手 / 旁观且归零时常驻"+借一底"入口）
- [x] 19.8 顶部 ≡ 菜单从"直接弹退出确认框"改成两行小弹层（账本 / 退出游戏），`GameTable.jsx`+`Lobby.jsx` 两处入口一致
- [x] 19.9 新增 `BustDecisionModal.jsx`（借一底/旁观留下/离开，借一底带防抖）、`LedgerModal.jsx`（玩家/初始筹码/已借入/当前筹码四列）；`Lobby.jsx` 现成的"+借一底"徽章顺手补上同样的防抖
- [x] 19.10 更新现有测试断言（不只是新增）：`RoomManager.test.js` "游戏进行中不能借入" 拆成"筹码充足时不能借入"+"归零时游戏进行中可以借入"两条；`e2e/game.spec.js` 的 S4"游戏进行中拒绝新玩家"改成"游戏进行中加入新玩家"（断言加入成功、1000 筹码、不在当前这一手里）
- [x] 19.11 踩坑记录：这个沙盒环境存在一个跟本次改动无关的硬限制——单个测试进程里第 3 个浏览器 page（不论是否属于同一个 context）几乎总是卡死在 `page.goto`，用完全不含任何游戏逻辑的 3 个空白页复现过同样的结果，确认是环境资源上限（很可能是代理层的并发连接数限制），不是应用代码问题；旧版 S4 测试（3 个 context）本来就是本 session 记录在案的已知偶发失败之一。应对方式：① 服务端集成验证改用 socket.io 服务端自带的 `/socket.io/socket.io.js` 客户端脚本，在已有的 page 里开一条裸 socket 连接模拟"第三个玩家"，只用 2 个真实 page 就验证了 `room:join` 在游戏进行中真的会被服务端接受、返回 1000 筹码且不在当前这一手里；② 客户端旁观渲染路径（不会错标座位、footer 三态、两个新弹窗）改用项目已有的 `?states=N` 开发自检画廊（`fixtures.js`/`StatesGallery.jsx`），单 page 直接给 `GameTable`/新组件喂真实 props，规避了多开 page 的限制，覆盖力度不打折扣；③ 服务端的"归零玩家单独借入、其他人不受影响"由 `RoomManager.test.js` 的专门单测覆盖（更精确，且不受这个环境限制影响）
- [x] 19.12 回归验证：服务端单测 75/75 通过；全量 e2e（`game.spec.js`+`lobby.spec.js`）对比已知的环境级偶发失败基线（"完整一局"/S2，S4 已改造为新场景），确认无新增失败

## 20. 撤销「牌桌内容随非等比缩放变形」的取舍 + 菜单按钮放大（第十二轮，2026-07-19）

- [x] 20.1 用户反馈 18.3 认可的取舍其实不可接受：浏览器变宽拉伸时，牌、数字、头像、文字全都跟着 `scale(scaleX, scaleY)` 变形，而不只是轻微椭圆化——撤销该决策，见 design.md 对应条目
- [x] 20.2 `GameTable.jsx` 新增 `tableScaleUniform = min(scaleX, scaleY)` 及反向抵消系数 `csx/csy`，写入 `.table-canvas` 的 CSS 变量 `--csx`/`--csy`；`.table-oval` 内新增 `.table-oval-content` 包裹层
- [x] 20.3 `velvet.css`：`.table-oval-content`、`.table-canvas .player-slot`（含 hero）、`.table-canvas .hero-section` 追加 `scale(var(--csx,1), var(--csy,1))`——座位/牌桌位置继续用非等比 scaleX/scaleY 铺开，但头像/卡牌/文字/数字统一用抵消后的等比系数渲染，不再变形
- [x] 20.4 `.menu-btn` 从 32×32px/字号 15px 放大到 44×44px/字号 20px，达到触屏最小可点击尺寸标准

## 21. 行动指示气泡统一 + 发牌质感/动画补全（第十三轮，2026-07-19）

- [x] 21.1 去掉"轮到谁"的雷达波纹圈（`.seat.is-active::before/::after` + `@keyframes activeRing`）——用户反馈这个视觉效果读起来像"断续、线框不完整的圈"
- [x] 21.2 定位并修复气泡不统一的根因：对手下注一直有持久的 `.bet-chip` 气泡（不会消失），但 hero 自己下注只有会在 1.6 秒后淡出的文字提示、没有对应的持久气泡——`GameTable.jsx` 新增 `heroBetStyle`（跟对手 `betStyle` 同一套"朝向池心"计算），给 hero 的 `player-slot--hero` 补上跟对手完全一致的 `.bet-chip`
- [x] 21.3 `.c-back`（牌背）从纯色渐变+单个星标，改成叠加内嵌高光/暗部阴影模拟厚度（不再是纯平矩形），加一层低透明度菱格纹理（`::before`，4-5% 不透明度，材质感而非装饰条纹）
- [x] 21.4 `@keyframes cardDeal` 从"原地缩放淡入"改成"从右上方带旋转位移滑入再摆平"，更像真实发牌的手部动作；`.card-deal` 动画时长 .35s→.4s 让旋转有时间读出来
- [x] 21.5 定位并修复"对手好像没有牌"的根因：`PlayerSeat.jsx` 里对手的两张背面小牌只在 `dealing`（发牌那一瞬间，约1秒）渲染，发完就彻底消失、直到摊牌才重新出现。改成整手牌局期间常驻显示（`hasCards = gamePhase !== 'waiting'`），只在刚发牌那一下播放 `card-deal` 飞入动画，之后静止显示；弃牌后隐藏
- [x] 21.6 连带修复：持久显示的对手手牌会跟"说了什么"的文字气泡（`.action-bubble`）在同一个位置打架（两者都默认贴在头像正上方）——新增 `bubbleStyle()`，文字气泡改成堆叠在手牌上方（`bottom:calc(100% + 50px)`），或者手牌被推到侧边时文字气泡改用头像正上方的默认位置（互补，不重叠）
- [x] 21.7 用 Playwright 实测 9 人密集桌场景（临时 fixture，验证后已移除），发现相邻座位的常驻手牌互相重叠/被裁切；`.game-stage--dense` 新增头像 38→34px、手牌 28×40→21×30px、间距收紧的密集桌专属尺寸，实测重叠消除
- [x] 21.8 回归验证（`?states=` 自检画廊 0/1/3 三态 + 临时下注/密集桌 fixture）：正常桌不同下注/弃牌状态下气泡位置无重叠、hero 气泡样式与对手一致、摊牌揭示逻辑未受影响、控制台无报错

## 22. 牌背改经典蓝格纹 + 账本盈亏合计 + 中文标签 + 结算强制全员确认（第十四轮，2026-07-19）

- [x] 22.1 `.c-back` 从深绿+金色改成经典蓝色格纹（市面常见扑克牌背样式）：深蓝渐变底、白色菱格纹理（可见对比度，不再是低调材质感）、白色描边
- [x] 22.2 `PlayerSeat.jsx` 的位置角标从 D/SB/BB 改成中文"庄家/小盲/大盲"，`.pos-badge` 加宽适配双字
- [x] 22.3 `LedgerModal.jsx` 新增"盈亏"列（= 当前 − 初始 − 已借，借来的筹码不算赢的），正负用绿/红区分，说明文案同步补充公式
- [x] 22.4 头像/对手常驻手牌默认尺寸各降一档（头像 40→36px，`.c-xs` 手牌 28×40→24×34px），密集桌（7-9人）尺寸相应同步收紧（头像→31px，手牌→19×27px），缓解玩家变多时的拥挤感
- [x] 22.5 **修复结算强制全员确认被绕过的 bug**：`server/index.js` 里"摊牌后 15 秒无论如何自动进入下一手"的兜底定时器（`settlementFallbacks`）整个删掉——之前哪怕一个人都没点"我知道了"，15 秒后也会自动开下一局，跟"必须每个人都确认"的产品要求矛盾。现在只有两条路能进入下一手：全员真实点击确认，或掉线玩家被移出待确认名单后剩余的人已经都确认了
- [x] 22.6 连带修复：结算弹窗"等待其他人确认（X/Y）"这个数字之前是客户端伪造的（`iAmReady?1:0`，只反映"我自己点没点"，从来不是真实的其他人确认进度）。`RoomManager.js` 新增 `getSettlementProgress()`，`server/index.js` 在每次有人确认或掉线时广播真实的 `{readyCount,totalCount}`（新事件 `game:settlement-progress`），`RoomPage.jsx` 接住并传给弹窗，数字现在是真的
- [x] 22.7 服务端单测回归：75/75 通过，删掉 15 秒兜底定时器没有破坏任何既有断言

## 23. 下注气泡尾巴指向修正 + 牌背去边框加深 + 金额字重统一（第十五轮，2026-07-19）

- [x] 23.1 **修复气泡尾巴方向 bug**：`.bet-chip` 的小尾巴之前写死指向正下方，只有 hero（座位正好在椭圆底部顶点、气泡本来就是往正上方偏移）碰巧看起来是对的——其余每一个座位的气泡都是朝着池心方向偏移（可能是任意角度：左、右、斜上、斜下），尾巴却仍然只会指向正下方，看起来完全不像是"从头像那里长出来的"。`GameTable.jsx` 新增共享的 `betChipStyle(dx,dy)`，用 `atan2` 算出尾巴应该转的角度（`--tail-deg`，方向永远指回气泡对应的座位），hero 和所有对手统一用这一套；顺手把气泡离座位的偏移距离从 65px 收紧到 40px，让尾巴视觉上更贴近头像
- [x] 23.2 `.c-back` 去掉外层白色描边（真实扑克牌边缘就是圆角矩形本身，没有单独一圈边框线；内层菱格纹理自带的白色留白框保留，起到同样的"卡片边框"观感）；蓝色渐变整体加深（`#1B4B9C/#163E82/#0E2C5E` → `#123A78/#0F2F63/#081C42`）
- [x] 23.3 修复金额字体粗细不统一：`.hero-chips`、`.hero-bet`、`.bankroll` 三处此前都用了跟 `.pot-amt`/`.bet-chip`/`.stack-chip` 相同的字体家族（`--font-amount`）但漏了 `font-weight:700`，视觉上比其他金额数字细一截、像是不同字体——统一补上 `font-weight:700`
- [x] 23.4 回归验证（`?states=` 自检画廊 0/1 两态截图）：陈/李/王等分布在椭圆不同角度的座位，气泡尾巴均正确指回各自头像；牌背无外框、蓝色明显更深；hero-chips/bankroll 金额粗细与底池/下注气泡一致

## 24. 气泡尖角可见性修复 + hero 筹码样式改回归对手一致 + 发牌规则核实（第十六轮，2026-07-19）

- [x] 24.1 **修复 23.1 尾巴"转对了方向但看不见"的问题**：裁图放大后发现单层无描边的深色三角形，紧贴在 `.bet-chip` 自己的圆角金边内侧，视觉上被吃掉了，根本露不出尖角。改成两层三角形叠加（金色描边层在后、更大更远；深色填充层在前、略小更近），伪造出一个真正带金色描边、清晰可辨的speech bubble尖角
- [x] 24.2 **hero 筹码样式改回归对手一致**：`.hero-chips` 之前是金色描边胶囊+粗体（跟 22.3 反过来了），用户指出"同一含义的内容应该保持样式统一：大小可以不一样，但同一含义的样式表达应该大体相近"——hero 自己的筹码数字和对手的 `.stack-chip` 表达的是同一件事（当前筹码），改成同款灰白色纯文字（去掉背景/边框/粗体），字号保留比对手大一档（13px vs 10px）体现主次
- [x] 24.3 用户要求核实德州扑克真实发牌规则再对照代码——Web 搜索确认标准规则：从小盲开始、顺时针、一次给每人发一张、发完一轮再发第二张（两轮），公共牌在所有玩家的手牌发完之后才开始发。核对 `GameTable.jsx` 的 `sbFirstOrder()`（从 SB 开始、顺着 `gameState.players` 数组顺序＝座位顺时针顺序）+ `dealDelayFor()`（先按张数分轮、轮内按玩家顺序）+ `communityDealDelayFor()`（延迟从 `holeDealSteps` 之后开始）——发牌顺序本来就完全符合真实规则，这次是确认没有改动，不是发现 bug
- [x] 24.4 回归验证（`?states=` 自检画廊 0 态，裁图放大核实尾巴渲染）：气泡尖角清晰可见且方向正确；hero 筹码视觉上与对手 stack-chip 同一系（灰白纯文字），字号仍更大更醒目

## 25. 修复发牌动画从未真正播放过的 bug（第十七轮，2026-07-19）

- [x] 25.1 **纠正 24.3 的结论**：用户实测反馈"公共牌没有动画"，重新排查后发现 24.3 只核实了发牌*顺序*的算法对不对（对的），没有核实动画*有没有真的播出来*——这是两件事，后者确实是个 bug，24.3 判断"不用改"是不完整的
- [x] 25.2 **根因（真·竞态条件，不是取时机凑巧的问题）**：`justDealt` 是纯粹从 `prevPhaseRef.current`（一个 ref）派生的"单次渲染脉冲"——只在 `prevPhaseRef` 还没追上 `gameState.phase` 的那一次渲染里是 `true`。但更新 `prevPhaseRef.current` 的 effect，和触发 `setHeroRevealed(false)` 的 effect，在同一次 mount 的 effect 刷新周期里按声明顺序依次同步执行——前一个 effect 先把 `prevPhaseRef.current` 追平，后一个 effect 才触发的那次重渲染里，`justDealt` 早就已经变回 `false` 了。也就是说浏览器**从来没有机会把 `justDealt=true` 那一帧真正画出来**——用它控制的公共牌、hero 自己的初始扣牌、对手座位飞入动画，全部被无声跳过，只是外观上一直是"已经在那了"，而不是报错或者卡住，所以肉眼很难第一时间发现
- [x] 25.3 用真实证据定位（不是靠猜）：临时把 `DEAL_STEP` 从 0.07 调到 4 秒（拉长到 ~1 分钟），刷新页面后立刻用 Playwright 读 DOM 的 `getComputedStyle(...).animationName`——公共牌/hero 扣牌/对手座位的 class 里根本没有 `card-deal`/`deal-in`，`animationName` 全部是 `none`；反观本来就在用「持续存在的 `dealing`（`=!heroRevealed`）状态」而不是 `justDealt` 的对手手牌 reveal 动画，就是好的——这个对照直接坐实了问题出在 `justDealt` 本身
- [x] 25.4 **修复**：整个删掉 `justDealt`（连带它专属的 `prevPhaseRef`），公共牌、hero 初始扣牌、对手座位飞入，三处全部改用早就存在、且已验证可靠的 `dealing` 状态（`GameTable.jsx` 顶部新增具名变量 `const dealing = !heroRevealed`）——这是"用已经验证work的机制统一掉一个还在用旧机制的角落"，不是引入新概念
- [x] 25.5 回归验证：`DEAL_STEP=4` 重新测，公共牌/hero/对手座位三处的 `animationName` 都正确变成 `cardDeal`/`dealFly`，且 `animation-delay` 数值跟预期的交错时间完全对上（如公共牌 i=0 对应 48s = (12+0)×4）；改回 `DEAL_STEP=0.07`；`eslint` 对比改动前后（22→21 处既有告警，未新增，此文件里的 `react-hooks/refs` 告警是改动前就有的历史技术债，跟本次改动无关）；控制台无报错

## 26. 下注气泡尖角改用 SVG 绘制的弧形尾巴（第十八轮，2026-07-19，用 frontend-design skill）

- [x] 26.1 用户反馈 24.1 的双层三角形尖角"好奇怪"，要求用设计 skill 重新看——`.bet-chip::before/::after` 的两层纯直边三角形叠加改成单个 SVG data-URI 背景图（`path` 画一条微弯的弧形尾巴，深色填充+细金色描边，跟气泡本体同材质），尾巴根部叠在气泡圆角矩形下方（`z-index:-1`）隐藏衔接处，只露出弧形尖端，比直挺挺的三角形更像手绘漫画对话气泡
- [x] 26.2 回归验证：裁图放大核对陈（左侧，尾巴指左下）、李（右侧，尾巴指右上）、hero（正下方，尾巴指上）三个不同角度，弧形尾巴方向都正确且视觉自然

## 27. 牌桌骨架从椭圆改为贴边双栏 + 座位卡片/气泡/读秒/拍一拍全面重做（第十九轮，2026-07-20）

- [ ] 27.1 **骨架重写**：废弃 `seatPositions()`/`spectatorSeatPositions()` 的椭圆参数方程，改为贴边双栏分配算法（英雄固定底部；对手按人数尽量均分左右两栏，从上往下固定行距堆叠；中间留竖直通道给底池/公共牌）。`betChipStyle` 简化为水平朝中间通道方向。`.table-canvas` 的 scaleX/scaleY 独立缩放 + csx/csy 内容反向抵消机制沿用，只是坐标来源换成双栏算法
- [ ] 27.2 具体行距/栏宽/头像尺寸随人数（2-9）的缩放规则，先搭进 `states-preview.html` 出图，用户确认后再回填 tokens/组件（项目既有"预览即状态画廊"工作流，见「样式架构」决策）
- [ ] 27.3 发牌/摊牌相关动画（`dealDelayFor`、`cardsSide` 判断、`reveal` 定位）从"椭圆角度"改用"栏位序号"重新推导，Playwright 实测确认无遮挡/裁切（含 9 人密集桌）
- [ ] 27.4 **座位卡片改造**：`PlayerSeat.jsx` 从圆形头像+外部飘字，改成竖圆角矩形卡片（上区头像照片 + 下区筹码 footer，同一外边框）；`.avatar`/`.stack-chip`/`.pos-badge` 对应改版
- [ ] 27.5 昵称恢复显示（卡片上方一行，超宽省略号截断），9 人密集桌下昵称随卡片收窄降字号、不隐藏
- [ ] 27.6 **气泡常驻化**：`.action-bubble` 从 1.6s 淡出改为常驻至该玩家下次行动/进入下一街；`.fold-tag`/`.allin-tag` 下线，弃牌/ALL IN 并入常驻气泡机制；`.bet-chip` 浮标不变
- [ ] 27.7 **行动指示**：`.is-active .avatar` 去掉 `activePulse` 动画改静态描边；新增读秒遮罩（半透明遮罩 + 正向读秒数字，纯客户端本地计时，`actionPlayerId` 变化时清零，无上限无惩罚，不动服务端）
- [ ] 27.8 **拍一拍**：新增 socket 事件 `player:poke`/`player:poked`（服务端广播），目标卡片抖动动画 + 瞬时"戳了戳"气泡；服务端按 `fromId→targetId` 2 秒冷却防刷，禁止拍自己；弃牌/旁观玩家可被拍
- [ ] 27.9 视觉打磨：英雄手牌 `md`→`sm`；底池/街道文字对比度提升；桌面绒面噪点纹理（用 `frontend-design` skill 出图，预览页确认）
- [ ] 27.10 服务端单测覆盖拍一拍冷却/禁止拍自己；Playwright 回归全部既有座位/发牌/摊牌/密集桌场景，确认骨架替换未破坏既有功能；真实浏览器实测确认，不只看 checklist

## 28. 修复冷启动（整页重载）场景下的会话恢复缺失（第二十轮，2026-07-20）

- [x] 28.1 **根因确认**：第七轮修的是"socket 断线又重连、页面不重载"这一种路径（`RoomPage.jsx` 挂载/`connect` 事件发 `room:sync`）。移动端切 App 被系统回收标签页对应的是另一种路径——整页冷启动，`App.jsx` 从不读 `localStorage` 里的 `vr_playerId`/`vr_roomCode` 做会话恢复判断，无差别渲染 `HomePage` 走人工加入表单，最终发的是 `room:join` 而不是 `room:sync`，导致宽限期内报"已在房间内"、宽限期外被当全新玩家塞入（房主身份/筹码全部丢失）。详见 design.md「房主切 App 再切回来，重连后变成"全新受邀者"」
- [x] 28.2 `App.jsx`：挂载时检查 `localStorage.vr_playerId` + `vr_roomCode`，且当前 URL 未指定房间号或与 `vr_roomCode` 一致时，直接以 `{code, playerId}` 挂载 `RoomPage`（复用其已有的 `room:sync` 挂载逻辑），不新增单独的恢复态/新 socket 事件
- [x] 28.3 `App.jsx` 的 `handleLeave`：`room:gone`/`room:kicked`/主动退出这三条最终都会走到这里，一并清掉 `localStorage.vr_roomCode`（`vr_playerId` 保留作为跨房间的匿名设备身份），避免退出/失效后下次冷启动又尝试恢复同一个死会话
- [x] 28.4 Playwright 回归（`e2e/lobby.spec.js`「冷启动会话恢复」describe 块，4 条用例）：房主 `page.reload()` 后直接看到大厅、`hostId` 不变、看得到"开始游戏/重新开始"；非房主 reload 后仍在房间且不重复加入；被踢出后本地会话被清除、reload 不再尝试恢复（跟"宽限期耗尽"共用同一条 `handleLeave` 清理路径，用被踢这个确定性事件触发，而不是真的等 120 秒宽限期超时——行为等价，但没有单独跑一条真实等待 120 秒的用例）；持有另一房间旧会话时点新邀请链接不会被误判为恢复。过程中还修了一个纯测试层面的竞态 bug（用 p1 的广播确认 p2 已加入，不能保证 p2 自己的 `room:joined`/localStorage 写入已完成，导致偶发 flake），跟本次功能修复无关
- [x] 28.5 服务端本次无改动（问题根因和修复都在客户端）；`npm test`（server，75/75）与 `npm run test:e2e`（29/29，含既有回归）全绿

## 29. 游戏中途断线从"自动弃牌+移出房间"改为"暂停等待重连"（第二十一轮，2026-07-20）

- [x] 29.1 `Room` 新增显式 `connected` 字段：构造函数/`addPlayer` 默认 `connected: true`，新增 `setConnected(playerId, connected)`，`getLobbyState()` 的 players 里带上这个字段
- [x] 29.2 `Room.nextRound()` 发下一手时的 `active` 过滤条件从 `chips > 0` 扩展为 `chips > 0 && connected !== false`——断线玩家跳过不发进新一手，重连后下次 `nextRound()` 自动重新计入
- [x] 29.3 新增 `Room.getActionPlayerId()` / `resolveDisconnectedTurn(targetId)` / `foldForDisconnected(hostId, targetId)`——分别用于查询当前该行动的玩家、对"断线且正是他的回合"这一具体场景执行弃牌、以及房主触发的带权限校验的包装
- [x] 29.4 `server/index.js` 的 `disconnect` handler 去掉游戏进行中自动弃牌 + 移出房间这两个动作，只调用 `setConnected(id, false)` 并广播；这一步暂时打破了一条既有集成测试（预期行为改变，非回归），推迟到 Task 10 一并修正
- [x] 29.5 `room:sync` 重连路径调用 `setConnected(id, true)` 并广播给全房间，让其他玩家客户端看到断线状态解除
- [x] 29.6 新增房主专属 socket 事件 `game:fold-disconnected`，走 `foldForDisconnected` 权限校验后调用 `resolveDisconnectedTurn`，即"帮TA弃牌"按钮的服务端支撑
- [x] 29.7 新增 `maybeArmPauseTimer` 辅助函数，从唯一的 `broadcastRoom` 汇聚点调用，管理 5 分钟安全超时定时器的完整生命周期（武装/续期/清除），到点后对断线中的行动玩家调用 `resolveDisconnectedTurn` 自动弃牌；定时器的 6 种状态迁移逐一手动跟踪验证过
- [x] 29.8 客户端新增"断线中"纯文字 toast + 房主可见的"帮TA弃牌"按钮；本轮不改 `GameTable.jsx`/`PlayerSeat.jsx`/`velvet.css`，因为这些文件正在并行分支里做视觉重做，完整视觉呈现推迟
- [x] 29.9 大厅玩家列表里断线玩家名字后追加"（断线中）"文字角标
- [x] 29.10 Playwright e2e：用页面调试钩子 `window.__vrSocket.disconnect()`/`.connect()` 模拟牌局进行中真实断线再重连，覆盖玩家自己重连、房主"帮TA弃牌"两条路径；同时修正 Task 4 打破的那条服务端集成测试，并新增 5 分钟安全超时的假定时器测试
- [x] 29.11 SDD 收尾 + 全量验证：`npm test`（server，101/101）、`npm run build`（client，构建通过）、`npx playwright test`（31/31，含既有回归）全绿——过程中两次遇到同一进程内反复起停测试服务器导致的偶发 `ERR_CONNECTION_REFUSED`，清掉残留进程后重跑即恢复全绿，判断为本次沙盒会话的环境噪音，非代码回归

## 30. 修复结算等待期断线导致游戏意外结束（Bug 3 结构性修复，2026-07-23）

- [x] 30.1 设计决策记录：已在 design.md 新增「结算等待期断线不应自动推进」决策节
- [x] 30.2 `RoomManager.js`：构造函数新增 `lastShowdown` 字段用于重连恢复；`removePlayer` 增加结算期待确认列表清理
- [x] 30.3 `server/index.js` 的 `disconnect` handler 移除 settlement wait 特殊推进逻辑，改为仅广播 `room:state` + `game:settlement-progress`（不广播 `game:state` 以保持其他玩家结算弹窗不被清掉）
- [x] 30.4 `server/index.js` 的 `handleActionResult` 存储 `lastShowdown` 到房间对象
- [x] 30.5 `server/index.js` 的 `room:sync` 增加结算等待期重连路径：向重连 socket 发 `game:state` + `game:showdown` + `game:settlement-progress`，不广播 full state 给所有人
- [x] 30.6 `server/index.js` 的 `advanceRoom` 清空 `lastShowdown` + 清空结算超时定时器
- [x] 30.7 `server/index.js` 新增结算等待期安全超时（10 分钟），断线的待确认玩家到点后自动 drop 以解锁房间
- [x] 30.8 `server/index.js` 的 `room:kick` 踢人后检查是否解锁 settlement
- [x] 30.9 更新集成测试：原测试断言断线后自动 advance 改为断言不自动 advance，新增超时模拟验证
- [x] 30.10 回归验证：`npm test`（server，101/101）全绿
