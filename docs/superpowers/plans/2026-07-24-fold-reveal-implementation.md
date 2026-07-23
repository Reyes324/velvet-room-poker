# Fold-Win Winner Card Reveal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the fold-win winner reveal their hole cards during settlement wait — self sees hero cards scale up + golden glow, others see cards appear near the winner's seat.

**Architecture:** New `game:reveal-cards` WebSocket event flows through server (validate → broadcast) to RoomPage (state → props) → SettlementModal (button) + GameTable/PlayerSeat (card rendering). CSS-only animations — no new dependencies.

**Tech Stack:** Socket.io, React (existing), pure CSS (existing velvet.css + tokens.css design system)

## Global Constraints

- Design tokens: gold `#D4AF37`, surface `#08120A`, text-primary `#F2EAD0`, font-display `'Cinzel'`
- Button pattern: `border-radius: 24px`, `height: 48px`, font-display 14px/700
- Animations: pure CSS `@keyframes`, use `cubic-bezier(.34,1.56,.64,1)` for spring-like, `animation-delay` via CSS custom property `--d`
- `parseCard` already exported from `server/GameEngine.js:419`

---

### Task 1: Server — `game:reveal-cards` event + RoomManager cleanup

**Files:**
- Modify: `server/index.js` (add import + event handler)
- Modify: `server/RoomManager.js:208-210` (clear revealedPlayerIds)

**Interfaces:**
- Consumes: `parseCard` from `./GameEngine`, `rooms.getRoomByPlayer()`, `room.isAwaitingSettlementAck()`, `room.game.players`
- Produces: emits `game:cards-revealed { playerId, playerName, holeCards }` to room

- [ ] **Step 1: Add `parseCard` import to server/index.js**

At the top of `server/index.js`, line 5 after the `RoomManager` require, add:

```js
const { parseCard } = require('./GameEngine');
```

- [ ] **Step 2: Add `game:reveal-cards` event handler**

Insert after the `game:ready-next` handler block (after line 333 in `server/index.js`), before the `disconnect` handler:

```js
socket.on('game:reveal-cards', ({ playerId }) => {
  const room = rooms.getRoomByPlayer(playerId);
  if (!room?.isAwaitingSettlementAck() || !room.game) return;

  const player = room.game.players.find(p => p.id === playerId);
  // Must be a fold-win: this player didn't fold, and is the ONLY non-folded player
  const activePlayers = room.game.players.filter(p => p.status !== 'folded');
  if (!player || player.status === 'folded' || activePlayers.length !== 1) return;
  // No double-reveal
  if (!room.revealedPlayerIds) room.revealedPlayerIds = new Set();
  if (room.revealedPlayerIds.has(playerId)) return;
  room.revealedPlayerIds.add(playerId);

  io.to(room.code).emit('game:cards-revealed', {
    playerId,
    playerName: player.name,
    holeCards: player.holeCards.map(parseCard),
  });
});
```

- [ ] **Step 3: Clear `revealedPlayerIds` in RoomManager.clearSettlementWait()**

Modify `server/RoomManager.js` line 208-210:

```js
clearSettlementWait() {
  this.settlementWait = null;
  this.revealedPlayerIds = null;
}
```

- [ ] **Step 4: Verify server starts cleanly**

Run: `cd ~/测试\ OpenStack && node -e "require('./server/GameEngine'); require('./server/RoomManager'); require('./server/index.js')" 2>&1 | head -5`

Expected: No import errors (server may fail to bind port — that's fine, just confirm no `MODULE_NOT_FOUND` or syntax errors).

- [ ] **Step 5: Commit**

```bash
git add server/index.js server/RoomManager.js
git commit -m "feat: add game:reveal-cards server event for fold-win winner card reveal"
```

---

### Task 2: RoomPage — state + event handler + prop threading

**Files:**
- Modify: `client/src/pages/RoomPage.jsx`

**Interfaces:**
- Consumes: `useSocket` event `game:cards-revealed`, existing `settlement` state (for determining foldWin)
- Produces: `revealedPlayers` state, passes `isFoldWin`, `iAmWinner`, `myCardsRevealed`, `onReveal` to `SettlementModal`, passes `revealedPlayers` to `GameTable`

- [ ] **Step 1: Add `revealedPlayers` state**

After the `const [pokedSeat, setPokedSeat] = useState(null);` line (line 28), add:

```js
const [revealedPlayers, setRevealedPlayers] = useState({});
// { [playerId]: { playerName, holeCards } }
```

- [ ] **Step 2: Add `game:cards-revealed` event handler**

In the `useSocket` call (after the `'player:poked'` handler, around line 90), add:

```js
'game:cards-revealed': ({ playerId, playerName, holeCards }) => {
  setRevealedPlayers(prev => ({ ...prev, [playerId]: { playerName, holeCards } }));
},
```

- [ ] **Step 3: Clear `revealedPlayers` on new hand or game end**

In the `'game:state'` handler (line 38-49), add `setRevealedPlayers({});` after the existing `setActionDisabled(false);` line.

In the `'game:ended'` handler (line 67-74), add `setRevealedPlayers({});` after the existing `setSettlementProgress(null);` line.

- [ ] **Step 4: Add `handleReveal` callback**

After the `handleReady` function (line 151-154), add:

```js
function handleReveal() {
  emit('game:reveal-cards', { playerId });
}
```

- [ ] **Step 5: Determine fold-win props for SettlementModal**

Before the SettlementModal render (around line 266), add computed values. Find the block:

```js
{settlement && settlement.winners?.length > 0 && (
  <SettlementModal
    winners={settlement.winners}
    myId={playerId}
    iAmReady={iAmReady}
    readyCount={settlementProgress?.readyCount ?? (iAmReady ? 1 : 0)}
    totalCount={settlementProgress?.totalCount ?? (roomState?.players ?? []).length}
    onReady={handleReady}
  />
)}
```

Replace with:

```js
{settlement && settlement.winners?.length > 0 && (() => {
  const isFoldWin = settlement.winners.length === 1 && settlement.winners[0].handName === '其他人全部弃牌';
  const iAmWinner = isFoldWin && settlement.winners[0].id === playerId;
  const myCardsRevealed = !!revealedPlayers[playerId];
  return (
    <SettlementModal
      winners={settlement.winners}
      myId={playerId}
      iAmReady={iAmReady}
      readyCount={settlementProgress?.readyCount ?? (iAmReady ? 1 : 0)}
      totalCount={settlementProgress?.totalCount ?? (roomState?.players ?? []).length}
      onReady={handleReady}
      isFoldWin={isFoldWin}
      iAmWinner={iAmWinner}
      myCardsRevealed={myCardsRevealed}
      onReveal={handleReveal}
    />
  );
})()}
```

- [ ] **Step 6: Pass `revealedPlayers` to GameTable**

In the `<GameTable .../>` JSX (line 222-237), add:

```jsx
revealedPlayers={revealedPlayers}
```

- [ ] **Step 7: Build client**

Run: `cd ~/测试\ OpenStack/client && npm run build`

Expected: `✓ built in ...` with no errors.

- [ ] **Step 8: Commit**

```bash
git add client/src/pages/RoomPage.jsx
git commit -m "feat: add revealedPlayers state and prop threading to RoomPage"
```

---

### Task 3: SettlementModal — "亮牌" button

**Files:**
- Modify: `client/src/components/SettlementModal.jsx`

**Interfaces:**
- Consumes: new props `isFoldWin`, `iAmWinner`, `myCardsRevealed`, `onReveal`
- Produces: renders secondary gold-outline "亮牌" button above "我知道了" for fold-win winner

- [ ] **Step 1: Update component signature and add reveal button**

Replace the entire `SettlementModal.jsx` content:

```jsx
const AV = ['av-green', 'av-purple', 'av-teal', 'av-rust', 'av-olive', 'av-blue', 'av-magenta', 'av-gold'];
function colorForId(id) {
  let h = 0;
  for (const ch of String(id)) h = (h + ch.charCodeAt(0)) % 8;
  return h;
}

export default function SettlementModal({
  winners = [], myId, readyCount, totalCount, iAmReady, onReady,
  isFoldWin = false, iAmWinner = false, myCardsRevealed = false, onReveal,
}) {
  if (winners.length === 0) return null;

  return (
    <div className="settlement-sheet">
      <div className="modal-title">✦ 本局结算</div>

      <div className="settlement-winners">
        {winners.map((w) => {
          const isMe = w.id === myId;
          const avClass = isMe ? 'av-gold' : AV[colorForId(w.id)];
          return (
            <div key={w.id} className="settlement-winner-row">
              <div className={`modal-winner-av ${avClass}`}>{w.name[0].toUpperCase()}</div>
              <div className="modal-winner-info">
                <div className="modal-winner-name" style={isMe ? { color: '#D4AF37' } : undefined}>
                  {w.name}
                  {isMe ? '（我）' : ''} 赢得本局
                </div>
                <div className="modal-win-amt">+ ¥{Number(w.won).toLocaleString()}</div>
              </div>
              {w.handName && <div className="modal-hand">{w.handName}</div>}
            </div>
          );
        })}
      </div>

      {isFoldWin && iAmWinner && (
        <div
          className={`modal-btn modal-btn--secondary${myCardsRevealed ? ' modal-btn--revealed' : ''}`}
          onClick={myCardsRevealed ? undefined : onReveal}
        >
          {myCardsRevealed ? '已亮牌 ✓' : '🃏 亮牌'}
        </div>
      )}

      <div className={`modal-btn${iAmReady ? ' modal-btn--waiting' : ''}`} onClick={iAmReady ? undefined : onReady}>
        {iAmReady ? `等待其他人确认…（${readyCount}/${totalCount}）` : '我知道了'}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build client**

Run: `cd ~/测试\ OpenStack/client && npm run build`

Expected: `✓ built in ...` with no errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/SettlementModal.jsx
git commit -m "feat: add 亮牌 button to SettlementModal for fold-win winner"
```

---

### Task 4: GameTable + PlayerSeat — render revealed cards

**Files:**
- Modify: `client/src/components/GameTable.jsx` (add hero glow class + pass revealedCards to PlayerSeat)
- Modify: `client/src/components/PlayerSeat.jsx` (new `revealedCards` prop + render)

**Interfaces:**
- Consumes: `revealedPlayers` prop from RoomPage, `myId`
- Produces: `.hero-cards--revealed` class on hero, `<Card>` elements in PlayerSeat with `.reveal-fold-show`

- [ ] **Step 1: GameTable — hero cards glow when revealed**

In `GameTable.jsx`, find the hero section (around line 393-419). The hero-cards div is:

```jsx
<div className="hero-cards">
```

Change to:

```jsx
<div className={`hero-cards${revealedPlayers?.[myId] ? ' hero-cards--revealed' : ''}`}>
```

Note: `revealedPlayers` needs to be destructured from props. Add `revealedPlayers = {}` to the destructured props on line 110:

```jsx
export default function GameTable({ ..., revealedPlayers = {} }) {
```

- [ ] **Step 2: GameTable — pass revealedCards to opponent PlayerSeat**

Find the `<PlayerSeat ... />` inside the opponents map (around line 376-389). After the `poked={...}` prop, add:

```jsx
revealedCards={revealedPlayers[p.id]?.holeCards ?? null}
```

- [ ] **Step 3: PlayerSeat — render revealedCards**

In `PlayerSeat.jsx`, add new prop `revealedCards = null` to the destructured props (line 44):

```jsx
export default function PlayerSeat({ player, isMe, isAction, isWinner, gamePhase, color = 0, bubble, cardsSide = null, bubbleSide = null, onPoke, poked = false, revealedCards = null }) {
```

After the showdown reveal block (line 80-86), add the fold-reveal block:

```jsx
{revealedCards && revealedCards.length === 2 && (
  <div className="reveal-fold-show" style={sideStyle(cardsSide)}>
    {revealedCards.map((c, i) => (
      <Card key={i} card={c} size="xs" animate="flip-reveal" delay={i * 0.1} />
    ))}
  </div>
)}
```

- [ ] **Step 4: Build client**

Run: `cd ~/测试\ OpenStack/client && npm run build`

Expected: `✓ built in ...` with no errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/GameTable.jsx client/src/components/PlayerSeat.jsx
git commit -m "feat: render fold-reveal cards — hero glow + seat-side reveal"
```

---

### Task 5: CSS — animations and button style

**Files:**
- Modify: `client/src/styles/velvet.css`

- [ ] **Step 1: Add `@keyframes revealGlow`**

After the existing `@keyframes actionBubbleOut` block (around line 222), add:

```css
@keyframes revealGlow {
  0%, 100% { box-shadow: 0 0 6px rgba(212, 175, 55, 0.25); }
  50%      { box-shadow: 0 0 22px rgba(212, 175, 55, 0.65); }
}
```

- [ ] **Step 2: Add `.hero-cards--revealed`**

After the existing `.hero-cards` rule (line 235), add:

```css
.hero-cards--revealed {
  transform: scale(1.15);
  transition: transform .3s cubic-bezier(.34,1.56,.64,1), box-shadow .3s ease;
  animation: revealGlow 1.5s ease-in-out infinite;
}
```

- [ ] **Step 3: Add `.reveal-fold-show`**

After the existing `.reveal` rule (line 231), add:

```css
.reveal-fold-show { display:flex; gap:3px; animation:revealGlow 1.5s ease-in-out infinite; }
.reveal-fold-show .card { border: 2px solid #D4AF37; border-radius: 5px; }
```

- [ ] **Step 4: Add `.modal-btn--secondary` and `.modal-btn--revealed`**

After the existing `.modal-btn` rule (line 359), add:

```css
/* Secondary outline button — used for "亮牌" alongside the primary "我知道了" */
.modal-btn--secondary {
  background: transparent;
  border: 1.5px solid rgba(212, 175, 55, .4);
  color: #D4AF37;
  box-shadow: none;
  margin-bottom: 0;
}
.modal-btn--revealed {
  opacity: .45;
  border-color: rgba(212, 175, 55, .18);
  cursor: default;
}
```

- [ ] **Step 5: Build client to verify CSS compiles**

Run: `cd ~/测试\ OpenStack/client && npm run build`

Expected: `✓ built in ...` with no errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/styles/velvet.css
git commit -m "style: add revealGlow animation, hero-cards--revealed, reveal-fold-show, secondary button"
```

---

### Task 6: End-to-end verification

**Files:**
- No new files — run the app and verify the full flow

- [ ] **Step 1: Start the server**

```bash
cd ~/测试\ OpenStack && node server/index.js &
sleep 2
```

Expected: Server starts on port (check with `curl -s http://localhost:3000/health`).

- [ ] **Step 2: Build and serve client**

```bash
cd ~/测试\ OpenStack/client && npm run build
```

Expected: build succeeds, `dist/` contains `apple-touch-icon.png`, `favicon.svg`, and the updated `index.html` with all meta tags.

- [ ] **Step 3: Open two browser tabs to simulate two players**

Manually connect to `http://localhost:3000`, create a room as Player A, join as Player B.
Play through a hand where Player B folds and Player A wins without showdown (fold-win).

- [ ] **Step 4: Verify "亮牌" button appears for winner**

On Player A's screen after the hand ends:
- Settlement sheet should show "✦ 本局结算" with Player A as winner, handName "其他人全部弃牌"
- "🃏 亮牌" button should appear above "我知道了"
- Player B should see only "我知道了" (no 亮牌 button)

- [ ] **Step 5: Verify reveal animation**

Player A clicks "🃏 亮牌":
- Button changes to "已亮牌 ✓" (grayed out)
- Player A's hero cards scale up with golden breathing glow
- On Player B's screen, Player A's seat shows two cards flipping in with golden border + glow

- [ ] **Step 6: Verify players can still proceed**

Both players click "我知道了" → game advances to next hand.
Revealed cards and glow should disappear.

- [ ] **Step 7: Kill server**

```bash
kill %1 2>/dev/null
```

- [ ] **Step 8: Commit any final tweaks**

```bash
git add -A
git commit -m "chore: end-to-end verification of fold-reveal feature"
```
