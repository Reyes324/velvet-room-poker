# 暂停/继续功能 — 设计文档

**日期**：2026-08-11
**背景**：用户提出希望能有一个"暂停/继续"按钮，让桌上任何一位坐位玩家都能触发，给大家一个临时讨论的空间（规则争议、有人需要处理点别的事），而不被回合倒计时/自动过牌弃牌打断。

## 参考先例

项目里已经有一个结构上非常相似的机制——"计时游戏"（`room.gameTimerEndsAt` / `room.awaitingTimerDecision`，`server/index.js`）：整局设一个时长上限，到点后暂停等房主决定继续还是结束。但那个机制刻意设计成**只在两手之间的边界生效**，绝不打断正在进行的一手——这是为了避免"倒计时中途冻结"这类时序复杂度。

这次的暂停功能不能照搬这个简化：用户明确要求必须能**立刻**冻住当前正在进行的回合倒计时（比如正吵着规则、卡在某人行动中间），不能等到这手打完。这是本设计要解决的核心复杂点。

## 决策摘要（brainstorming 过程中用户确认的点）

1. **暂停必须能立刻冻结当前回合的行动倒计时**（而不是等到下一手开始前）。
2. **恢复时接着暂停前剩余的时间继续走**（不重新给满 30 秒），保证公平。
3. **不设自动恢复超时**——一直暂停到有人主动点"继续"为止，不因为怕有人忘记点而强加一个时间上限。
4. **暂停期间手牌可见性不受影响**——只挡操作，不挡视觉，跟平时一样只有自己能看到自己的牌。
5. **只有坐位玩家能触发暂停/继续**，旁观者看不到按钮（或按钮对旁观禁用）。
6. **测试覆盖**：服务端单测覆盖全部分支 + 一条关键 e2e（真实渲染断言倒计时确实冻结了）。

## 状态模型

在 `room` 对象上新增：

```js
room.paused = false;              // 唯一真相来源
room.pauseRemainingMs = null;     // 暂停那一刻，当前行动人倒计时还剩多少毫秒；暂停时没人在行动（两手之间/结算等待）则为 null
room.pausedActionPlayerId = null; // 暂停时轮到谁；配合 pauseRemainingMs 在恢复时校验"还是不是同一个人的同一回合"
```

`room.paused` 是唯一权威状态，服务端所有涉及暂停/恢复的入口都先检查它——这天然解决了"两个人几乎同时点暂停/继续"的竞态：先到的生效，后到的因为状态已经翻转而变成空操作，不需要额外加锁或版本号。

## 服务端逻辑

### `room:pause`（客户端 → 服务端，`{ playerId }`）

```js
socket.on('room:pause', ({ playerId }) => {
  const room = findRoomBySocket(socket);
  if (!room || room.paused) return; // 已经暂停，空操作
  if (!room.players.some(p => p.id === playerId)) return; // 只有坐位玩家能触发

  if (room.isAwaitingAction()) {
    // room.turnClock 是 RoomManager 上的普通属性（不是 getter 方法），
    // 结构见 startTurnClock：{ playerId, startedAt, endsAt, seq }。
    const clock = room.turnClock;
    room.pauseRemainingMs = Math.max(0, clock.endsAt - Date.now());
    room.pausedActionPlayerId = room.getActionPlayerId();
  }
  room.paused = true;
  clearTurnTimer(room);   // 已有函数：清掉正在跑的 setTimeout
  room.clearTurnClock();  // 已有函数：客户端不再收到 endsAt，倒计时数字自然消失
  broadcastRoom(room);
});
```

### `room:resume`（客户端 → 服务端，`{ playerId }`）

```js
socket.on('room:resume', ({ playerId }) => {
  const room = findRoomBySocket(socket);
  if (!room || !room.paused) return; // 没在暂停，空操作
  if (!room.players.some(p => p.id === playerId)) return;

  room.paused = false;
  const samePlayerSameTurn =
    room.pausedActionPlayerId &&
    room.isAwaitingAction() &&
    room.getActionPlayerId() === room.pausedActionPlayerId;

  if (samePlayerSameTurn) {
    // 复用 startTurnClock，只是把固定的 TURN_BASE_MS 换成剩余时间——
    // 引擎这边不用改一行。
    const { endsAt } = room.startTurnClock(room.pausedActionPlayerId, room.pauseRemainingMs);
    scheduleTurnExpiry(room, room.pausedActionPlayerId, endsAt);
  } else {
    // 理论上不会发生（暂停期间所有行动都被挡），保留作为防御性兜底：
    // 走正常的重新起表逻辑，而不是假设一定是同一个人。
    maybeArmTurnClock(room);
  }

  room.pauseRemainingMs = null;
  room.pausedActionPlayerId = null;
  broadcastRoom(room);
});
```

### 行动入口的防御性拦截

所有会修改牌局状态的入口（跟注/加注/弃牌/allin/…）在最前面统一加一道检查：

```js
if (room.paused) return { error: 'paused' };
```

这是防御性的——就算客户端因为某种意外没禁用按钮，服务端也绝不会在暂停期间真的把动作应用到牌局上。服务端是唯一真相来源，这跟项目一贯的原则一致。

## 不需要特殊处理的边界情况（复用现有机制自然覆盖）

- **暂停期间断线**：不受影响，因为倒计时压根没在跑。恢复后如果轮到的正好是断线的人，倒计时照常从剩余时间开始走，到点照样按现有规则自动弃牌/过牌（现有超时机制本来就不看 `connected` 状态，见 `maybeArmTurnClock` 上方注释）。
- **暂停时房主离开**：不受影响。暂停状态本身不依赖房主身份，房主重连/替换是已有的独立逻辑，两者正交。
- **两手之间/结算等待期暂停**：`pauseRemainingMs` 为 `null`，恢复时 `samePlayerSameTurn` 判定为假，走 `maybeArmTurnClock` 的正常路径（等价于什么都不用做，下一手正常开始）。

## 客户端

- **入口**：`GameTable.jsx` 顶部 `top-bar`，新增一个 ⏸/▶ 图标按钮，风格跟现有 `menu-btn` 统一（圆角矩形芯片）。只对坐位玩家可见/可点，旁观者看不到。
- **暂停态 UI**：半透明遮罩条，文案"已暂停 · 点击继续"，附一个明显的"继续"按钮；下注操作栏（`ActionBar`）同时隐藏/禁用——这跟服务端的拦截是同一件事的两层保险，不是各管各的。
- **手牌可见性**：完全不受影响，遮罩只挡操作，不挡视觉。
- 谁暂停的（`pausedBy`）可以顺手在遮罩文案里带一句"XX 暂停了对局"，小加成，不是本轮的核心诉求，实现时看方不方便顺手做。

## 测试计划

- **服务端单测**（新文件，比如 `server/__tests__/pauseResume.test.js`）：
  - 暂停冻结当前回合倒计时（`clearTurnTimer` 被调用、`turnClock` 变 `null`）
  - 恢复后用剩余时间重新起表，而不是满时长
  - 两个人几乎同时暂停/恢复——竞态安全，不会出现状态错乱
  - 非坐位玩家（旁观）触发暂停/恢复被拒绝
  - 暂停期间行动请求（跟注/弃牌等）被服务端拒绝，不改变牌局状态
  - 暂停发生在两手之间（`pauseRemainingMs` 为 null 的分支）不报错，恢复后正常走下一手
  - 暂停期间断线不触发任何异常路径；恢复后断线玩家的回合超时行为跟平时一致
- **e2e**（追加到已有套件或新文件）：真实渲染断言暂停后倒计时环/数字确实消失，且过一段时间后仍然停在原地没有继续跳数，点了继续之后才重新开始倒计时——不能只信服务端单测，倒计时的"看起来冻结了"要靠真实浏览器渲染确认。

## 明确不做（本轮范围外）

- 不做自动恢复超时（用户明确表示"一直暂停到有人点继续为止"）。
- 不做暂停原因/留言这类附加信息（比如"因为规则争议暂停"），只有基础的暂停/继续。
- 不扩展给旁观者暂停权限。
