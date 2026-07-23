# 赢家亮牌炫耀 — 设计文档

## 概述

fold-win 局（所有人弃牌，一人不战而胜）里，赢家的手牌从未亮过。在结算等待阶段，赢家可以选择"亮牌"，把自己的底牌晒给全桌看——"看，我拿着这个赢的。"

正常摊牌局不需要这个功能，因为牌已经在摊牌阶段亮过了。

## 动机

德州扑克中，fold-win 赢家通吃后经常想炫耀自己的手牌（无论是真有强牌，还是 bluff 成功）。这是一个社交互动点。

## 范围

- **谁可以用**：只有 fold-win 的赢家（全场唯一没弃牌的玩家），且只能亮一次
- **亮的是什么**：赢家的两张底牌（`holeCards`，GameEngine 在 `_endHand` 中存有）
- **什么时候亮**：结算弹窗打开后、点"我知道了"之前
- **展示持续多久**：从亮牌那一刻到下一局开始，不退场
- **不影响核心流程**：亮牌不推进游戏，所有人仍需点"我知道了"才进入下一手

## 交互流程

```
一手 fold-win 结束 → game:showdown { foldWin: true }
→ 结算弹窗出现
   ↓
赢家看到 "亮牌" 按钮（弃牌玩家只看到"我知道了"）
   ↓ 点击
emit game:reveal-cards
   ↓
服务端验证：
- 确实是 fold-win 赢家（status !== 'folded'，且只有一个非弃牌玩家）
- 没重复亮
   ↓
广播 game:cards-revealed { playerId, holeCards }
   ↓
所有客户端：
├─ 赢家自己：hero 区手牌放大 + 金色呼吸光晕
├─ 其他玩家：赢家座位旁翻牌亮出 + 金色脉冲
└─ 牌一直展示到下一手 game:state 清掉
```

## 动画设计

### 赢家自己视角

hero 区的手牌已经摊开在屏幕底部。点"亮牌"后：
- `.hero-cards` 容器加上 `.hero-cards--revealed` 类
- CSS：`transform: scale(1.15)` + 金色 box-shadow 呼吸动画（`revealGlow`，~1.5s 周期）
- 过渡：`transition: transform 0.3s ease, box-shadow 0.3s ease`

### 其他玩家视角

赢家座位旁边出现两张手牌（复用 `sideStyle` 定位）：
- 牌面用 `flip-reveal` 翻牌动画逐个亮出（错开 0.1s）
- 外框金色脉冲（复用 `revealGlow` 呼吸），区别于普通摊牌的静态亮牌

## 服务端改动

### 新事件：`game:reveal-cards`

```js
socket.on('game:reveal-cards', ({ playerId }) => {
  const room = rooms.getRoomByPlayer(playerId);
  if (!room?.isAwaitingSettlementAck()) return;
  if (!room.game) return;

  const player = room.game.players.find(p => p.id === playerId);
  // 只有 fold-win 赢家：自己没弃牌，且全场只剩一个非弃牌玩家
  const activeCount = room.game.players.filter(p => p.status !== 'folded').length;
  if (!player || player.status === 'folded' || activeCount !== 1) return;
  if (room.revealedPlayerIds?.has(playerId)) return;  // 防重复

  if (!room.revealedPlayerIds) room.revealedPlayerIds = new Set();
  room.revealedPlayerIds.add(playerId);

  const cards = player.holeCards.map(parseCard);
  io.to(room.code).emit('game:cards-revealed', {
    playerId,
    playerName: player.name,
    holeCards: cards,
  });
});
```

### 清理时机

- `clearSettlementWait()` 时一并清 `revealedPlayerIds`
- `nextRound()` 时 `game` 被重建，自然失效

## 客户端改动

### RoomPage.jsx

新增 state：
```js
const [revealedPlayers, setRevealedPlayers] = useState({});
// { [playerId]: { playerName, holeCards } }
```

新事件处理：
```js
'game:cards-revealed': ({ playerId, playerName, holeCards }) => {
  setRevealedPlayers(prev => ({ ...prev, [playerId]: { playerName, holeCards } }));
},
```

`game:state` 和 `game:ended` 处理器中加 `setRevealedPlayers({})`。

新增 props 透：
- `SettlementModal` 新增 `isFoldWin`、`iAmWinner`、`myCardsRevealed`、`onReveal`
- `GameTable` 新增 `revealedPlayers`

### SettlementModal.jsx

新增 props：`isFoldWin`（是否 fold-win 局）、`iAmWinner`（当前玩家是否是赢家）、`myCardsRevealed`（已亮）、`onReveal`（亮牌回调）。

仅当 `isFoldWin && iAmWinner` 时，在"我知道了"上方显示"亮牌"按钮。亮过后变灰。

### GameTable.jsx

接收 `revealedPlayers`。渲染时：
- `revealedPlayers[myId]` 存在 → hero 区加 `.hero-cards--revealed`
- opponent 的 `revealedPlayers[p.id]` 存在 → `PlayerSeat` 传 `revealedCards`

### PlayerSeat.jsx

新增 prop `revealedCards`。非空时在座位旁渲染手牌（`sideStyle`），带 `.reveal-fold-show` 类——金色光晕 + `flip-reveal` 动画。

## CSS 新增

```css
.hero-cards--revealed {
  transform: scale(1.15);
  animation: revealGlow 1.5s ease-in-out infinite;
}

.reveal-fold-show {
  animation: revealGlow 1.5s ease-in-out infinite;
}
.reveal-fold-show .card {
  border: 2px solid #D4AF37;
}

@keyframes revealGlow {
  0%, 100% { box-shadow: 0 0 8px rgba(212, 175, 55, 0.3); }
  50%      { box-shadow: 0 0 20px rgba(212, 175, 55, 0.7); }
}
```

## 边界情况

| 情况 | 处理 |
|---|---|
| 赢家重复点"亮牌" | 服务端 `revealedPlayerIds` 防重复，客户端亮了后按钮变灰 |
| 摊牌局（不是 fold-win） | 按钮不出现，`isFoldWin=false` |
| fold-win 有多个赢家（理论上不存在） | `activeCount !== 1` 守卫拒绝 |
| 亮牌瞬间赢家断开 | 牌已广播，留在其他人屏幕上直到下一手 |
| 亮牌瞬间有人断开 | 牌已广播，`dropFromSettlementWait` 独立处理，不干扰 |
| 结算弹窗还没到就有人亮牌 | `isAwaitingSettlementAck()` 守卫拒绝 |

## 非目标

- 不支持选亮哪张（亮就是亮两张）
- 不支持取消亮牌
- 不改变游戏结果
- 不做音效
