# 弃牌亮牌炫耀 — 设计文档

## 概述

在每手牌结束后、所有人点"我知道了"之前的结算等待阶段，弃牌玩家可以点击"亮牌"按钮，把自己的手牌展示给桌上所有人看（俗称"晒牌"）。

## 动机

德州扑克中，弃牌玩家经常想炫耀"你看我扔掉了多好的牌"——这是一个社交互动点，增加趣味性。当前结算弹窗只有"我知道了"按钮，没有这个互动。

## 范围

- **谁可以用**：只有本手弃牌的玩家（`status === 'folded'`），且每人只能亮一次
- **亮的是什么**：该玩家实际持有的两张手牌（`holeCards`，服务端在 GameEngine 结束前存有）
- **展示持续多久**：从亮牌那一刻到下一局开始（`game:state` 清掉），不退场
- **不影响核心流程**：亮牌不推进游戏，所有人仍需点"我知道了"才进入下一手

## 交互流程

```
结算弹窗出现
  ↓
弃牌玩家看到 "亮牌" 按钮 ──→ 点击 → emit game:reveal-cards
  赢家只能看到 "我知道了"                    ↓
                                  服务端验证：
                                  - 确实是弃牌（status=folded）
                                  - 没重复亮
                                  - 手牌数据存在
                                    ↓
                                  广播 game:cards-revealed
                                    ↓
所有客户端收到：
  ├─ 亮牌者自己：hero 区已有手牌放大 + 金色呼吸光晕
  ├─ 其他玩家：该玩家座位旁出现手牌 + 金色高亮（区别于普通摊牌）
  └─ 牌一直展示，直到 game:state 清掉进入下一手
```

## 动画设计

### 自己视角（亮牌者）

hero 区的手牌已经摊开在屏幕底部，不需要变出。点"亮牌"后：
- `.hero-cards` 容器加上 `.hero-cards--revealed` 类
- CSS：`transform: scale(1.15)` + 金色 box-shadow 呼吸动画（`revealGlow`，~1.5s 周期），表示"我在晒"
- 过渡：`transition: transform 0.3s ease, box-shadow 0.3s ease`

### 其他人视角

该玩家座位旁边出现两张手牌（复用 `sideStyle` 定位）：
- 牌面用 `flip-reveal` 翻牌动画逐个亮出（错开 0.1s）
- 外框金色脉冲（复用同一个 `revealGlow` 呼吸），区别于普通摊牌的白色无动画亮牌
- 如果该玩家是弃牌状态，座位本身已经有 `is-folded` 样式（灰暗），亮牌不改变座位颜色——只加手牌 + 光晕

## 服务端改动

### 新事件：`game:reveal-cards`

```js
socket.on('game:reveal-cards', ({ playerId }) => {
  const room = rooms.getRoomByPlayer(playerId);
  if (!room?.isAwaitingSettlementAck()) return;  // 不在结算等待期，忽略
  if (!room.game) return;

  const player = room.game.players.find(p => p.id === playerId);
  if (!player || player.status !== 'folded') return;    // 只有弃牌玩家
  if (room.revealedPlayerIds?.has(playerId)) return;    // 不能重复亮

  // 记录已亮
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

- `advanceRoom()` / `clearSettlementWait()` 时一并清 `revealedPlayerIds`
- `nextRound()` 时 `game` 被重建，`revealedPlayerIds` 自然失效

## 客户端改动

### RoomPage.jsx

新增 state：
```js
const [revealedPlayers, setRevealedPlayers] = useState({});
// { [playerId]: { playerName, holeCards } }
```

新事件处理（加入 `useSocket`）：
```js
'game:cards-revealed': ({ playerId, playerName, holeCards }) => {
  setRevealedPlayers(prev => ({ ...prev, [playerId]: { playerName, holeCards } }));
},
```

`game:state` 和 `game:ended` 处理器中加一行 `setRevealedPlayers({})`。

透传 props 给 `SettlementModal` 和 `GameTable`。

### SettlementModal.jsx

新增 props：`foldedPlayerIds`（当前手弃牌的玩家 ID 列表）、`myCardsRevealed`（当前玩家是否已亮）、`onReveal`（亮牌回调）。

"我知道了"按钮上方，弃牌玩家看到"亮牌"按钮：
```
┌──────────────────────────────┐
│  🃏 亮牌                     │  ← 仅弃牌玩家可见，亮过后变灰
└──────────────────────────────┘
```

### GameTable.jsx

接收 `revealedPlayers` prop。在渲染时：
- 如果 `revealedPlayers[myId]` 存在 → hero 区套上 `.hero-cards--revealed`
- 渲染每个 opponent 时，如果 `revealedPlayers[p.id]` 存在 → 传给 `PlayerSeat` 一个新 prop `revealedCards`

### PlayerSeat.jsx

新增 prop `revealedCards`（`holeCards[]` 或 null）。当非空且玩家是弃牌状态时，在座位旁渲染手牌（复用 `sideStyle` 定位），带 `.reveal-fold-show` 类（金色光晕 + flip 动画）。

## CSS 新增

```css
/* Hero手牌放大+呼吸 — 亮牌炫耀（自己视角） */
.hero-cards--revealed {
  transform: scale(1.15);
  animation: revealGlow 1.5s ease-in-out infinite;
}

/* 弃牌亮牌（他人视角）— 金色脉冲区别于普通白色摊牌 */
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
| 弃牌玩家重复点"亮牌" | 服务端 `revealedPlayerIds` 已记录，拒绝；客户端亮了后按钮变灰 |
| 点亮的瞬间有人断开 | 牌已广播，所有人已看到，无影响 |
| 亮牌玩家自己也断开了 | 牌已广播，留在其他人屏幕上直到下一手 |
| 所有人都是摊牌赢家（没人弃牌） | 没人能用亮牌功能，按钮不出现 |
| 结算弹窗还没出现就有人亮牌 | 服务端守卫 `isAwaitingSettlementAck()` 拒绝 |
| 摊牌玩家尝试亮牌 | `player.status !== 'folded'` 守卫拒绝 |

## 非目标

- 不支持 select 要亮哪张（亮就是亮两张）
- 不支持取消亮牌（亮出去了收不回）
- 不改变手牌游戏结果
- 不做动画音效（纯视觉）
