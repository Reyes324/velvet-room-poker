# Table Layout Overhaul (Oval → Edge-Hugging Columns) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the elliptical seat-rail table skeleton with a portrait-optimized two-column layout, redesign the seat card (rounded-rect avatar+chip card with a persistent nickname), make action-status bubbles persistent, replace the pulsing active-seat ring with a static highlight + client-local "thinking seconds" overlay, and add a poke/pat social interaction — per `openspec/changes/online-texas-holdem/design.md` §"牌桌骨架从椭圆改为贴边双栏…（第十九轮）".

**Architecture:** Pure-function seat-position algorithm swap inside `GameTable.jsx` (same call sites, new math) + a `PlayerSeat.jsx`/`velvet.css` visual rewrite of the seat card + a new tiny server-authoritative-free poke feature (cooldown lives server-side for anti-spam only, timing/animation is client-only). No changes to `GameEngine.js` or game-logic correctness paths — this is presentation-layer only, except the new `player:poke` socket event.

**Tech Stack:** React (client), Express + Socket.io (server), Vitest (server unit tests), Playwright (e2e), existing `?states=` self-check gallery (`StatesGallery.jsx`/`fixtures.js`) for visual regression.

## Global Constraints

- Currency symbol ¥ everywhere (existing convention) — no new money-like UI introduces `$`.
- Room capacity stays 2–9 (9 = 8 opponents + hero); full room still rejects joins. Do not touch this check.
- No server-authoritative timing/timeout added for the read-timer — it is purely a client-local, non-blocking display (per design.md: "不需要任何服务端改动或状态同步").
- Commit messages in English, format `type: description` (project CLAUDE.md rule). Do not push (no auto-push).
- Do not introduce a new client unit-test framework — this codebase has none for the client (only server Vitest + Playwright e2e + the in-app `?states=` gallery); follow that existing pattern for client-side verification.
- Exact pixel/spacing/color values in this plan are concrete starting values, not placeholders — per design.md they are expected to get refined via the `?states=` gallery with the user before being considered final; do not skip implementing them as real numbers now.

---

### Task 1: Server — `Room.poke()` cooldown logic (TDD)

**Files:**
- Modify: `server/RoomManager.js` (add `poke()` method to the `Room` class, near `rebuy()`/`removePlayer()`, roughly line 34-52)
- Test: `server/__tests__/RoomManager.test.js` (new `describe('RoomManager — 拍一拍')` block, appended at end of file)

**Interfaces:**
- Produces: `Room.poke(fromId, targetId)` → `{ ok: true }` on success, `{ error: string }` on failure (same result shape as `addPlayer`/`rebuy`). Cooldown state stored on the instance as `this.pokeCooldowns` (a `Map` keyed by `` `${fromId}→${targetId}` `` → timestamp in ms).
- Consumes: nothing new — takes plain player-id strings, no dependency on `this.players` beyond existence checks.

- [ ] **Step 1: Write the failing tests**

Append to `server/__tests__/RoomManager.test.js`:

```javascript
describe('RoomManager — 拍一拍', () => {
  it('成功拍一拍返回 ok', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    const result = room.poke('p1', 'p2');
    expect(result.ok).toBe(true);
  });

  it('不能拍自己', () => {
    const room = rooms.create('p1', 'Alice');
    const result = room.poke('p1', 'p1');
    expect(result.error).toBe('不能拍自己');
  });

  it('2 秒冷却内重复拍同一人 → 拒绝', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    expect(room.poke('p1', 'p2').ok).toBe(true);
    const second = room.poke('p1', 'p2');
    expect(second.error).toBe('拍得太快了');
  });

  it('冷却只按 fromId→targetId 这一对生效，不影响拍别人', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    rooms.join(room.code, 'p3', 'Carol', 'socket3');
    expect(room.poke('p1', 'p2').ok).toBe(true);
    expect(room.poke('p1', 'p3').ok).toBe(true);
  });

  it('冷却过期后可以再次拍同一人', async () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    expect(room.poke('p1', 'p2').ok).toBe(true);
    room.pokeCooldowns.set('p1→p2', Date.now() - 3000); // simulate 3s elapsed
    expect(room.poke('p1', 'p2').ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --prefix server`
Expected: 5 new failures with `TypeError: room.poke is not a function`

- [ ] **Step 3: Implement `Room.poke()`**

In `server/RoomManager.js`, add a constant near the top (with `STARTING_CHIPS`/`BIG_BLIND`):

```javascript
const POKE_COOLDOWN_MS = 2000;
```

In the `Room` constructor, alongside the other instance fields (after `this.settlementWait = null;`):

```javascript
    this.pokeCooldowns = new Map(); // `${fromId}→${targetId}` -> last-poke timestamp (ms)
```

Add the method after `removePlayer(id)`:

```javascript
  // Purely social — no game-state effect. Cooldown is keyed by the ordered
  // pair so A repeatedly poking B doesn't also throttle A poking C, or B
  // poking A back.
  poke(fromId, targetId) {
    if (fromId === targetId) return { error: '不能拍自己' };
    const key = `${fromId}→${targetId}`;
    const last = this.pokeCooldowns.get(key);
    if (last && Date.now() - last < POKE_COOLDOWN_MS) return { error: '拍得太快了' };
    this.pokeCooldowns.set(key, Date.now());
    return { ok: true };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --prefix server`
Expected: all tests pass (75 existing + 5 new = 80)

- [ ] **Step 5: Commit**

```bash
git add server/RoomManager.js server/__tests__/RoomManager.test.js
git commit -m "feat: add Room.poke() with per-pair cooldown"
```

---

### Task 2: Server — wire `player:poke` / `player:poked` socket events

**Files:**
- Modify: `server/index.js` (add handler near the other simple room-scoped handlers, e.g. right after `player:rebuy` around line 128-134)

**Interfaces:**
- Consumes: `Room.poke(fromId, targetId)` from Task 1.
- Produces: client-facing socket contract — client emits `player:poke` with `{ fromId, targetId }`; server broadcasts `player:poked` with `{ fromId, targetId }` to the whole room (including the poker) on success, or emits `game:error` (existing generic error channel, already handled by `RoomPage.jsx`'s toast) back to the sender only on failure.

- [ ] **Step 1: Add the handler**

In `server/index.js`, insert after the `player:rebuy` handler (which ends `io.to(room.code).emit('room:state', room.getLobbyState());` around line 134):

```javascript
    socket.on('player:poke', ({ fromId, targetId }) => {
      const room = rooms.getRoomByPlayer(fromId);
      if (!room) return socket.emit('game:error', '未找到房间');
      const result = room.poke(fromId, targetId);
      if (result.error) return socket.emit('game:error', result.error);
      io.to(room.code).emit('player:poked', { fromId, targetId });
    });
```

- [ ] **Step 2: Manual smoke test**

Run: `npm start` (from repo root), open two browser tabs, create a room in one, join from the other, seat both (or just check via lobby — poke UI isn't wired client-side yet, this step only confirms the server doesn't crash on an unknown event). Use the browser devtools console on one tab:

```javascript
window.__vrSocket.emit('player:poke', { fromId: 'test-a', targetId: 'test-b' });
```

Expected: no server crash, no unhandled exception in the terminal running `npm start` (the room lookup will fail gracefully since `test-a` isn't a real player id, returning `game:error` silently — that's correct behavior, not a bug, since this pair doesn't exist yet).

- [ ] **Step 3: Commit**

```bash
git add server/index.js
git commit -m "feat: wire player:poke/player:poked socket events"
```

---

### Task 3: Column-based seat positioning algorithm

**Files:**
- Modify: `client/src/components/GameTable.jsx:77-118` (replace `seatPositions()` and `spectatorSeatPositions()`), and the `betChipStyle` call sites at lines ~147 and ~347
- Modify: `e2e/game.spec.js` (add a new geometry regression test)

**Interfaces:**
- Produces: `seatPositions(n)` → `{ hero: {x,y}, opponents: [{x,y,side}] }` (added `side: 'left'|'right'` field, new — every downstream consumer of `pos[i]` in the `opponents.map` render loop gains access to `s.side`). `spectatorSeatPositions(n)` → `[{x,y,side}]`, same new `side` field.
- Consumes: `TABLE_REF_W = 375`, `TABLE_REF_H = 610` (unchanged constants already in the file).

- [ ] **Step 1: Write the failing e2e regression test**

`e2e/game.spec.js`'s existing multi-player tests each open a real `browser.newContext()`/`newPage()` per player (see `createRoom`/`joinRoom`/`startGame` helpers already defined near the top of the file). Per `openspec/changes/online-texas-holdem/design.md`'s round-10 "踩坑记录", this sandbox reliably hangs on `page.goto` for the 3rd-or-later real browser page/context in one test process — that entry documents the established workaround: simulate extra players as raw `socket.io-client` connections opened inside one already-open page's own JS context (via the app's own served `/socket.io/socket.io.js`), instead of real additional pages. Use that same technique here — this test only needs one real page (the host, to read the rendered DOM from).

Append to `e2e/game.spec.js`:

```javascript
test('对手座位分两栏贴边分布，不再是椭圆弧形', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const code = await createRoom(page, '房主');

  // 3 synthetic opponents as raw sockets in the host's own page context —
  // see the Step 1 note above for why not 3 more real Playwright pages.
  await page.addScriptTag({ url: '/socket.io/socket.io.js' });
  await page.evaluate(async (roomCode) => {
    for (const name of ['p1', 'p2', 'p3']) {
      const s = window.io();
      await new Promise(resolve => s.on('connect', resolve));
      s.emit('room:join', { code: roomCode, playerId: name, playerName: name });
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }, code);

  await startGame(page);

  const seatBoxes = await page.$$eval('.player-slot:not(.player-slot--hero)', els =>
    els.map(el => {
      const r = el.getBoundingClientRect();
      return { centerX: (r.left + r.right) / 2 };
    })
  );

  expect(seatBoxes.length).toBe(3);
  const viewportWidth = page.viewportSize().width;
  // Column layout: every opponent seat's center must sit in the left third
  // or right third of the viewport — nothing should land near the horizontal
  // center (that band is reserved for pot/community cards).
  for (const box of seatBoxes) {
    const inLeftBand = box.centerX < viewportWidth * 0.35;
    const inRightBand = box.centerX > viewportWidth * 0.65;
    expect(inLeftBand || inRightBand).toBe(true);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test -g "对手座位分两栏贴边分布"`
Expected: FAIL — current oval math places seats across the full arc, including near-center x positions, so `inLeftBand || inRightBand` will be false for at least one seat.

- [ ] **Step 3: Replace the seat-position functions**

In `client/src/components/GameTable.jsx`, replace the entire block from the `CARDS_SIDE_BELOW_Y` comment/constant (line 76) through the end of `spectatorSeatPositions` (line 118) with:

```javascript
// Column layout constants — reference canvas is TABLE_REF_W×TABLE_REF_H
// (375×610). Two vertical columns hug the left/right edges; the vertical
// strip between them stays clear for the pot/community-card zone. Seats
// fill alternating left/right by array order (opponents[0]→left row 0,
// opponents[1]→right row 0, opponents[2]→left row 1, …) so turn order still
// reads as a simple top-to-bottom zigzag instead of jumping across columns.
const COL_LEFT_X = 40;
const COL_RIGHT_X = 335;
const COL_TOP_Y = 46;
const COL_ROW_PITCH = 76;
// A seat whose card would render its above-avatar reveal cards / action
// bubble off the top of the canvas (row 0 of either column, closest to
// COL_TOP_Y) renders them to its own outward side instead — same purpose as
// the old CARDS_SIDE_BELOW_Y threshold under the oval, recomputed for the
// new column geometry.
const CARDS_SIDE_BELOW_Y = COL_TOP_Y + COL_ROW_PITCH / 2;

function seatPositions(n) {
  const heroPos = { x: 187.5, y: 585 };
  if (n === 0) return { hero: heroPos, opponents: [] };
  const opponents = [];
  let leftRow = 0, rightRow = 0;
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) {
      opponents.push({ x: COL_LEFT_X, y: COL_TOP_Y + leftRow * COL_ROW_PITCH, side: 'left' });
      leftRow++;
    } else {
      opponents.push({ x: COL_RIGHT_X, y: COL_TOP_Y + rightRow * COL_ROW_PITCH, side: 'right' });
      rightRow++;
    }
  }
  return { hero: heroPos, opponents };
}

// Spectator variant: no hero seat to anchor from, so every player in
// gameState.players fills the same two columns from the top — no reserved
// bottom slot.
function spectatorSeatPositions(n) {
  if (n === 0) return [];
  const seats = [];
  let leftRow = 0, rightRow = 0;
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) {
      seats.push({ x: COL_LEFT_X, y: COL_TOP_Y + leftRow * COL_ROW_PITCH, side: 'left' });
      leftRow++;
    } else {
      seats.push({ x: COL_RIGHT_X, y: COL_TOP_Y + rightRow * COL_ROW_PITCH, side: 'right' });
      rightRow++;
    }
  }
  return seats;
}
```

- [ ] **Step 4: Update the two `betChipStyle` call sites to fly horizontally toward the center strip**

`betChipStyle(dx, dy)` itself (lines 35-42) is shape-agnostic — it already just points a tail via `atan2(dx, -dy)` and offsets `BET_CHIP_OFFSET` along `(dx,dy)`. Leave that function untouched. Update only the two call sites:

Hero (around line 147, `const heroBetStyle = ...`):

```javascript
  const heroBetStyle = heroSeatPos && betChipStyle(0, 187.5 - heroSeatPos.y); // straight up, toward the pot
```

Opponents (inside the `opponents.map` loop, around line 347):

```javascript
        // Column layout: always fly straight toward the center strip (x=187.5),
        // never vertically — the center strip is where the pot/community cards
        // live, directly between the two columns at every row.
        const betStyle = betChipStyle(187.5 - s.x, 0);
```

- [ ] **Step 5: Update `cardsSide` derivation to use the new `side` field**

Around line 351 (`const cardsSide = s.y < CARDS_SIDE_BELOW_Y ? (s.x <= 187.5 ? 'right' : 'left') : null;`), replace with:

```javascript
        // Only the topmost row of each column pushes its reveal cards to the
        // side (toward its own column's outward edge, away from the center
        // strip) to avoid clipping the canvas's top edge.
        const cardsSide = s.y < CARDS_SIDE_BELOW_Y ? (s.side === 'left' ? 'left' : 'right') : null;
```

- [ ] **Step 6: Run the e2e test to verify it passes**

Run: `npx playwright test -g "对手座位分两栏贴边分布"`
Expected: PASS

- [ ] **Step 7: Run full existing e2e + server suites for regressions**

Run: `npm run test:all`
Expected: server 80/80 (Task 1's new tests included), Playwright suite passes (any pre-existing oval-specific coordinate assertions should be re-checked here — if any fail because they hard-coded arc-based expectations, fix those assertions to match the new column geometry rather than reverting the layout change).

- [ ] **Step 8: Commit**

```bash
git add client/src/components/GameTable.jsx e2e/game.spec.js
git commit -m "feat: replace elliptical seat rail with edge-hugging two-column layout"
```

---

### Task 4: Seat card redesign — rounded-rect avatar+chip card with persistent nickname

**Files:**
- Modify: `client/src/components/PlayerSeat.jsx` (full rewrite of the avatar/name/chip markup)
- Modify: `client/src/styles/velvet.css` (`.seat`/`.avatar`/`.stack-chip`/`.pos-badge` block, lines ~98-134)

**Interfaces:**
- Consumes: `player.name` (already passed, was previously only used for its first character — now rendered in full).
- Produces: no prop signature changes to `PlayerSeat` — same props as today (`player, isMe, isAction, isWinner, gamePhase, color, bubble, dealing, dealDelays, cardsSide`). `GameTable.jsx` call sites need no changes for this task.

- [ ] **Step 1: Rewrite the CSS — card container replaces circular avatar**

In `client/src/styles/velvet.css`, replace the block from `.seat { ... }` through `.stack-chip { ... }` (lines 98-130) with:

```css
/* seat = the whole rounded-rect card (photo zone + chip footer), positioned
   on the layout grid by the context (gallery/RoomPage). Replaces the old
   circular-avatar-plus-floating-text treatment — the chip count now lives
   INSIDE the card's own footer strip, sharing one outer border with the
   photo zone above it, matching the reference layout's card construction. */
.seat { position:relative; width:42px; }
.seat-name {
  font-family:var(--font-body); font-size:10px; color:var(--text-secondary);
  text-align:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  max-width:56px; margin:0 auto 3px; margin-left:-7px; margin-right:-7px;
}
.avatar-card {
  width:42px; border-radius:10px; overflow:hidden; position:relative;
  border:2px solid rgba(212,175,55,.18); background:#0A1A0E;
  display:flex; flex-direction:column;
}
.avatar-photo {
  width:100%; height:42px; display:flex; align-items:center; justify-content:center;
  font-family:var(--font-display); font-size:16px; font-weight:700; color:var(--text-primary);
  position:relative;
}
.av-green  .avatar-photo { background:radial-gradient(circle at 38% 35%, #2E7A40, #0A2E14); }
.av-purple .avatar-photo { background:radial-gradient(circle at 38% 35%, #4A228A, #1E0855); }
.av-teal   .avatar-photo { background:radial-gradient(circle at 38% 35%, #0E6060, #042E2E); }
.av-rust   .avatar-photo { background:radial-gradient(circle at 38% 35%, #7A3018, #3A1008); }
.av-olive  .avatar-photo { background:radial-gradient(circle at 38% 35%, #4A6020, #1E2A0A); }
.av-blue   .avatar-photo { background:radial-gradient(circle at 38% 35%, #2A5A8A, #0A2238); }
.av-magenta .avatar-photo { background:radial-gradient(circle at 38% 35%, #8A2A5A, #380A22); }
.av-gold   .avatar-photo { background:radial-gradient(circle at 38% 35%, #8B6914, #3D2800); }
.av-gold.avatar-card { border-color:rgba(212,175,55,.45); }

.is-active .avatar-card { border:3px solid #D4AF37 !important; box-shadow:0 0 0 4px rgba(212,175,55,.3), 0 0 32px rgba(212,175,55,.6) !important; }
.is-folded .avatar-card { filter:grayscale(.75) brightness(.42); border-color:rgba(150,145,130,.22) !important; box-shadow:none !important; }
.is-folded .pos-badge { opacity:.5; }
.is-allin .avatar-card { border:2px solid var(--state-danger) !important; box-shadow:0 0 18px rgba(192,57,43,.65) !important; }
.is-winner .avatar-card { border:2.5px solid #D4AF37 !important; box-shadow:0 0 0 5px rgba(212,175,55,.32), 0 0 50px rgba(212,175,55,.95) !important; animation:winGlow 1.2s ease-in-out infinite; }

/* position badge — unchanged visually, still bottom-right of the card */
.pos-badge { position:absolute; bottom:-4px; right:-7px; min-width:24px; height:15px; padding:0 4px; border-radius:5px; background:#EAE0C8; color:var(--ink-black); font-family:var(--font-mono); font-size:8px; font-weight:700; line-height:15px; text-align:center; white-space:nowrap; z-index:3; box-shadow:0 1px 3px rgba(0,0,0,.55); }

/* chip footer — inside the same card border as the photo, not floating text below it */
.stack-chip-footer {
  width:100%; padding:3px 0; text-align:center;
  background:rgba(4,10,6,.75); border-top:1px solid rgba(212,175,55,.14);
  font-family:var(--font-amount); font-size:11px; font-weight:700; color:#C9D6D0;
}
```

Note: `winGlow` keyframe already exists elsewhere in the file (referenced by the old `.is-winner .avatar` rule) — leave it as-is, this new `.is-winner .avatar-card` rule reuses the same keyframe name.

- [ ] **Step 2: Rewrite `PlayerSeat.jsx`'s markup**

Replace the `return (...)` block in `client/src/components/PlayerSeat.jsx` (the whole JSX, lines 45-77) with:

```javascript
  return (
    <div className={seatClass}>
      <div className="seat-name">{player.name}</div>
      <div className={`avatar-card ${avClass}`}>
        <div className="avatar-photo">
          {player.name[0].toUpperCase()}
          {badge && <span className="pos-badge">{badge}</span>}
        </div>
        <div className="stack-chip-footer">¥{player.chips.toLocaleString()}</div>
      </div>

      {bubble && <div key={bubble.key} className="action-bubble" style={bubbleStyle(cardsSide)}>{bubble.text}</div>}

      {hasCards && !isMe && !folded && !isShowdown && (
        <div className="reveal" style={sideStyle(cardsSide)}>
          <Card size="xs" faceDown animate={dealing ? 'card-deal' : null} delay={dealing ? (dealDelays?.[0] ?? 0) : 0} />
          <Card size="xs" faceDown animate={dealing ? 'card-deal' : null} delay={dealing ? (dealDelays?.[1] ?? 0) : 0} />
        </div>
      )}

      {isShowdown && !folded && !isMe && player.holeCards?.length === 2 && (
        <div className="reveal" style={sideStyle(cardsSide)}>
          {player.holeCards.map((c, i) => (
            <div key={i} className={`rc${c.color === 'red' ? ' red' : ''}`}>
              <span className="rct">{c.rank}</span><span className="rcc">{c.suit}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
```

This removes the `folded`/`allin` conditional block that rendered `.fold-tag`/`.allin-tag`/`.stack-chip` as three mutually-exclusive footers — Task 5 folds fold/all-in into the persistent action-bubble system instead, so the footer is now unconditionally the chip count. Leave the rest of the file (imports, `AV` array, `sideStyle`, `bubbleStyle`, the `isShowdown`/`hasCards`/`folded`/`allin`/`badge`/`avClass`/`seatClass` variable declarations above the `return`) unchanged for this step — `folded`/`allin` are still used by `seatClass` (for the `is-folded`/`is-allin` CSS hooks) and by the `hasCards`/`isShowdown` conditionals just shown.

- [ ] **Step 3: Update `.player-slot--hero` overrides in velvet.css**

Around line 357-364, the old rule hid `.stack-chip`/`.allin-tag`/`.fold-tag` on the hero slot (chips already shown in the big bottom card) and re-centered `.pos-badge`. Replace with:

```css
.player-slot--hero .stack-chip-footer { display: none; } /* 筹码已经在底部大卡显示，这里只需要头像+位置徽章+行动高亮，避免信息重复 */
.player-slot--hero .pos-badge { right:auto; left:50%; transform:translateX(-50%); }
```

- [ ] **Step 4: Update `.game-stage--dense` overrides**

Around line 378-390, replace the dense-table sizing block (which targeted `.seat`/`.avatar`/`.stack-chip`) with:

```css
.game-stage--dense .seat { width:34px; }
.game-stage--dense .seat-name { font-size:8px; max-width:44px; }
.game-stage--dense .avatar-photo { height:34px; font-size:13px; }
.game-stage--dense .stack-chip-footer { font-size:9px; padding:2px 0; }
.game-stage--dense .pos-badge { font-size:7px; height:13px; line-height:13px; min-width:19px; padding:0 3px; }
.game-stage--dense .reveal { gap:2px; }
.game-stage--dense .reveal .c-xs { width:19px; height:27px; border-radius:4px; }
.game-stage--dense .reveal .c-xs.c-back::before { inset:2px; }
.game-stage--dense .reveal .c-xs.c-back::after { font-size:8px; }
```

- [ ] **Step 5: Visual check via the self-check gallery**

Run: `cd client && npm run dev`, open `http://localhost:5173/?states=0` through `?states=7` (each fixture index from `fixtures.js`) in a browser.
Expected: every opponent seat renders as a rounded-rect card (photo on top, chip footer below, one shared border), nickname visible above every card including the hero's own row label if applicable, no overlapping text, dense-table state (if you temporarily add a 9-seat fixture per Task 8) shows a proportionally smaller version of the same card — not a different shape.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/PlayerSeat.jsx client/src/styles/velvet.css
git commit -m "feat: redesign seat as rounded-rect avatar+chip card with persistent nickname"
```

---

### Task 5: Persistent action bubbles, remove `.fold-tag`/`.allin-tag`

**Files:**
- Modify: `client/src/components/GameTable.jsx` (the `actionBubbles` effect, ~lines 205-240)
- Modify: `client/src/styles/velvet.css` (`.fold-tag`/`.allin-tag` rules ~132-134, `.action-bubble` animation ~156-164)

**Interfaces:**
- Produces: `actionBubbles` state shape unchanged (`{ [playerId]: { text, key } }`) but semantics change — an entry now persists until overwritten by that player's next action or explicitly cleared on a new street/hand, instead of self-clearing via `setTimeout`.
- Consumes: `gameState.phase`, `gameState.players[].status` (existing).

- [ ] **Step 1: Remove the fade-out timeout and add street/hand clearing**

In `client/src/components/GameTable.jsx`, find the action-bubble effect (the `useEffect` that builds `text` and calls `setActionBubbles`, around lines 211-240). Replace the body of the `if (prevP && currP)` block's tail — the part that currently does:

```javascript
        const key = Date.now();
        setActionBubbles(b => ({ ...b, [actorId]: { text, key } }));
        setTimeout(() => {
          setActionBubbles(b => (b[actorId]?.key === key ? { ...b, [actorId]: undefined } : b));
        }, 1650);
```

with:

```javascript
        // Persistent now — no self-clearing timeout. The bubble stays until
        // this same player's status/bet changes again (this effect re-fires
        // and overwrites their entry) or a new street/hand clears everyone
        // (see the phase-watching effect below).
        const key = Date.now();
        setActionBubbles(b => ({ ...b, [actorId]: { text, key } }));
```

Immediately after that `useEffect`, add a new one that clears all bubbles when the street changes (new community card revealed) or a new hand begins:

```javascript
  // Persistent action bubbles represent "what happened this street" — clear
  // them all when the street (or the whole hand) advances, otherwise a
  // "跟注 ¥20" from preflop would still be sitting there during the flop.
  useEffect(() => {
    setActionBubbles({});
  }, [gameState.phase]);
```

- [ ] **Step 2: Remove the now-dead 1.6s fade keyframe usage note and keep the pop-in**

In `client/src/styles/velvet.css`, the existing `.action-bubble` rule (~line 157) already applies `animation:actionBubble 1.6s ease-out forwards;` which fades the bubble OUT by 100% opacity at the end. Since the bubble is no longer removed from state after that time, the CSS animation finishing at `opacity:0` would make it invisible while still "logically" bubbled. Replace the keyframe reference to only play the pop-IN portion once, then hold:

```css
.action-bubble { position:absolute; bottom:calc(100% + 6px); left:50%; padding:4px 10px; background:rgba(8,18,10,.95); border:1px solid rgba(212,175,55,.5); border-radius:14px; font-family:var(--font-amount); font-size:11px; font-weight:600; color:#F5E6A0; white-space:nowrap; box-shadow:0 2px 10px rgba(0,0,0,.6); z-index:8; animation:actionBubbleIn .35s cubic-bezier(.34,1.56,.64,1) both; pointer-events:none; }
@keyframes actionBubbleIn {
  0%   { opacity:0; transform:translate(-50%, 6px) scale(.75); }
  60%  { opacity:1; transform:translate(-50%, 0) scale(1.06); }
  100% { opacity:1; transform:translate(-50%, 0) scale(1); }
}
```

(This replaces the old `actionBubble` keyframe — leave the old `@keyframes actionBubble` definition deleted, it's no longer referenced anywhere after this change; grep the file to confirm no other rule uses it before deleting.)

- [ ] **Step 3: Remove `.fold-tag`/`.allin-tag` and fold that state into the bubble**

Delete the two rules at velvet.css ~132-134 (`.fold-tag { ... }` and `.allin-tag { ... }`) — Task 4 already removed their JSX usage in `PlayerSeat.jsx`. Fold/all-in now needs its own persistent bubble entry, driven from `GameTable.jsx`. The action-bubble effect (from Step 1) fires whenever `prevSnap.actionPlayerId !== gameState.actionPlayerId` — which is true after *every* action including a fold, since the engine always advances `actionPlayerId` to the next player to act once the current player's turn ends (fold included; it only stays put in the `showdown`/no-one-left-to-act case, which isn't a "someone just folded" transition). The existing branch inside that effect already produces `text = '弃牌'` / `text = 'ALL IN'` for those specific transitions (checking `currP.status === 'folded' && prevP.status !== 'folded'`, etc.) — no additional effect or code change is needed for this step beyond the deletions above; fold/all-in already flow through the same `setActionBubbles` call as every other action.

- [ ] **Step 4: Visual check**

Run: `cd client && npm run dev`, open `?states=0` (has a `folded` player — `zhang`/`zhao` in the fixture) and `?states=1`.
Expected: folded players show a persistent "弃牌" bubble near their card (not the old small gray text below it), no bubble disappears after a few seconds while the fixture is static.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/GameTable.jsx client/src/styles/velvet.css
git commit -m "feat: make action-status bubbles persistent, retire fold/allin tags"
```

---

### Task 6: Static active-seat highlight + client-local read-timer overlay

**Files:**
- Modify: `client/src/styles/velvet.css` (`.is-active .avatar-card` rule from Task 4, drop the pulse keyframe reference)
- Modify: `client/src/components/PlayerSeat.jsx` (add the read-timer overlay markup + a small local hook)
- Create: `client/src/hooks/useThinkSeconds.js`

**Interfaces:**
- Produces: `useThinkSeconds(isAction)` → `number` (seconds elapsed since `isAction` most recently became `true`; resets to `0` whenever `isAction` transitions `false→true`; stops updating — but keeps its last value — when `isAction` is `false`).
- Consumes: `isAction` prop already passed into `PlayerSeat` (`gameState.actionPlayerId === p.id`).

- [ ] **Step 1: Write the hook**

Create `client/src/hooks/useThinkSeconds.js`:

```javascript
import { useState, useEffect, useRef } from 'react';

// Purely client-local, non-authoritative "how long has this player been
// thinking" display. Resets to 0 the moment `isAction` becomes true for
// this seat; ticks up once per second while it stays true. Different
// clients may show slightly different values under network latency — that
// is expected and fine, this is an atmosphere indicator, not a rule.
export function useThinkSeconds(isAction) {
  const [seconds, setSeconds] = useState(0);
  const wasActiveRef = useRef(false);

  useEffect(() => {
    if (isAction && !wasActiveRef.current) setSeconds(0);
    wasActiveRef.current = isAction;
    if (!isAction) return;
    const id = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(id);
  }, [isAction]);

  return seconds;
}
```

- [ ] **Step 2: Confirm the pulse animation is already gone**

Task 4's Step 1 already replaced `.is-active .avatar { ... animation:activePulse ... }` with a static-border `.is-active .avatar-card` rule that has no `animation` property. Grep to confirm no remaining reference:

Run: `grep -n "activePulse" client/src/styles/velvet.css`
Expected: no matches (the `@keyframes activePulse` definition itself, if still present elsewhere in the file from before Task 4, should also be deleted now as dead code — remove it if `grep` finds it).

- [ ] **Step 3: Add the read-timer overlay to `PlayerSeat.jsx`**

Add the import at the top of `client/src/components/PlayerSeat.jsx`:

```javascript
import { useThinkSeconds } from '../hooks/useThinkSeconds';
```

Inside the component body, before the `return`:

```javascript
  const thinkSeconds = useThinkSeconds(isAction);
```

In the JSX, inside `.avatar-photo` (from Task 4's Step 2), add the overlay as the last child, right after the `{badge && ...}` line:

```javascript
          {isAction && (
            <div className="think-overlay">{thinkSeconds}s</div>
          )}
```

- [ ] **Step 4: Add the overlay CSS**

In `client/src/styles/velvet.css`, add after the `.avatar-photo` rule block (from Task 4):

```css
.think-overlay {
  position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  background:rgba(4,10,6,.55); color:#F5E6A0; font-family:var(--font-mono);
  font-size:11px; font-weight:700; border-radius:8px 8px 0 0;
}
```

- [ ] **Step 5: Visual check**

Run: `cd client && npm run dev`, open `?states=0` (`wang` has `actionPlayerId`).
Expected: `wang`'s card shows a static gold border (no pulsing) and a semi-transparent overlay reading "0s" over the photo zone (the self-check gallery renders a static frame, so it won't visibly count up — that's expected; confirm the counting behavior manually in a real game instead, per Step 6).

- [ ] **Step 6: Real-game manual verification**

Run: `npm start` (repo root), open two tabs, start a hand, watch the seat whose turn it is.
Expected: overlay digit increments once per second while it's that player's turn, resets to "0s" the instant turn passes to someone else.

- [ ] **Step 7: Commit**

```bash
git add client/src/hooks/useThinkSeconds.js client/src/components/PlayerSeat.jsx client/src/styles/velvet.css
git commit -m "feat: replace pulsing active-ring with static highlight + local think-seconds overlay"
```

---

### Task 7: Poke/pat client interaction

**Files:**
- Modify: `client/src/components/PlayerSeat.jsx` (click handler + shake class)
- Modify: `client/src/components/GameTable.jsx` (pass `onPoke`/`pokedSeat` down to each opponent `PlayerSeat`)
- Modify: `client/src/pages/RoomPage.jsx` (socket wiring: emit on click, listen for `player:poked`)
- Modify: `client/src/styles/velvet.css` (shake keyframe + transient bubble reuse)

**Interfaces:**
- Consumes: `player:poked` server event from Task 2 (`{ fromId, targetId }`).
- Produces: `PlayerSeat` gains two new optional props: `onPoke?: () => void` (called on card click/tap, only meaningful for non-`isMe` seats) and `poked?: boolean` (true for a brief window right after this seat was poked, driving the shake animation).

- [ ] **Step 1: `RoomPage.jsx` — track poke state and emit**

In `client/src/pages/RoomPage.jsx`, add a new state near the other `useState` calls:

```javascript
  const [pokedSeat, setPokedSeat] = useState(null); // { targetId, key } | null
```

Add a handler to the `useSocket({...})` handlers object (alongside `'game:error'`):

```javascript
    'player:poked': ({ targetId }) => {
      const key = Date.now();
      setPokedSeat({ targetId, key });
      setTimeout(() => {
        setPokedSeat(p => (p?.key === key ? null : p));
      }, 700);
    },
```

Add a function near `rebuy()`/`handleAction()`:

```javascript
  function poke(targetId) {
    emit('player:poke', { fromId: playerId, targetId });
  }
```

Pass both down to `GameTable` in the JSX (inside the `<GameTable ... />` call, alongside `onRebuy={rebuy}`):

```javascript
        onPoke={poke}
        pokedSeat={pokedSeat}
```

- [ ] **Step 2: `GameTable.jsx` — thread props to each opponent seat**

Add `onPoke` and `pokedSeat` to the destructured props in the `GameTable(...)` function signature (alongside `onRebuy, onOpenLedger`):

```javascript
export default function GameTable({ gameState, myId, roomCode, showdown, onAction, actionDisabled, onExit, amPlaying = true, myChips = 0, onRebuy, onOpenLedger, onPoke, pokedSeat }) {
```

In the `opponents.map((p, i) => { ... })` render loop, pass two new props to `<PlayerSeat ... />`:

```javascript
              onPoke={() => onPoke?.(p.id)}
              poked={pokedSeat?.targetId === p.id}
```

- [ ] **Step 3: `PlayerSeat.jsx` — click handler + shake class**

Add `onPoke` and `poked` to the destructured props (from Task 4's version):

```javascript
export default function PlayerSeat({ player, isMe, isAction, isWinner, gamePhase, color = 0, bubble, dealing = false, dealDelays, cardsSide = null, onPoke, poked = false }) {
```

Add `poked && 'is-poked'` to the `seatClass` array (alongside `isWinner && 'is-winner'`, etc.):

```javascript
  const seatClass = [
    'seat',
    isWinner && 'is-winner',
    isAction && !isWinner && 'is-active',
    folded && 'is-folded',
    allin && 'is-allin',
    poked && 'is-poked',
  ].filter(Boolean).join(' ');
```

Wire the click on the `.avatar-card` div (only non-hero seats get `onPoke` passed from `GameTable.jsx`, so no extra `isMe` guard is needed here, but add one anyway for safety since `PlayerSeat` is also reachable from the gallery without a click target):

```javascript
      <div className={`avatar-card ${avClass}`} onClick={!isMe ? onPoke : undefined} role={!isMe ? 'button' : undefined}>
```

- [ ] **Step 4: Shake animation + transient bubble CSS**

In `client/src/styles/velvet.css`, add:

```css
.is-poked .avatar-card { animation:pokeShake .5s ease-in-out; }
@keyframes pokeShake {
  0%, 100% { transform:rotate(0deg); }
  20%      { transform:rotate(-8deg); }
  40%      { transform:rotate(7deg); }
  60%      { transform:rotate(-5deg); }
  80%      { transform:rotate(3deg); }
}
```

The transient "戳了戳" bubble reuses the existing `.action-bubble`/`actionBubbleIn` styling from Task 5 rather than a new class — add it in `PlayerSeat.jsx`'s JSX, right after the persistent `{bubble && ...}` line:

```javascript
      {poked && <div className="action-bubble poke-bubble" style={bubbleStyle(cardsSide)}>戳了戳</div>}
```

and a small CSS override so this one instance still self-clears visually even though `.action-bubble` itself now holds (Task 5 made the base class persistent-looking by removing the fade-out — this variant needs its own fade since `poked` itself already auto-clears via the `setTimeout` in `RoomPage.jsx`, but without an explicit fade the bubble would pop out of the DOM abruptly when `poked` flips back to `false`):

```css
.poke-bubble { animation:actionBubbleIn .35s cubic-bezier(.34,1.56,.64,1) both, actionBubbleOut .3s ease-in .4s forwards; }
@keyframes actionBubbleOut { to { opacity:0; transform:translate(-50%, -8px) scale(.9); } }
```

- [ ] **Step 5: Manual two-tab verification**

Run: `npm start`, open two tabs, seat both players, start a hand.
Expected: clicking an opponent's card in tab A makes that same seat shake + show "戳了戳" in BOTH tabs (including tab A's own view of that opponent, and tab B seeing their own card shake if B is the target); clicking your own hero card does nothing; clicking the same target twice within 2 seconds shows a toast with "拍得太快了" on the second click (from the `game:error` handler already wired) and no second shake.

- [ ] **Step 6: Server test for the error path reaching the client**

This is already covered by Task 1's unit tests for the cooldown logic itself — no additional server test needed here, this step is purely the client wiring's manual check from Step 5.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/PlayerSeat.jsx client/src/components/GameTable.jsx client/src/pages/RoomPage.jsx client/src/styles/velvet.css
git commit -m "feat: add poke/pat interaction (shake animation + transient bubble)"
```

---

### Task 8: Visual polish — hero card size, pot/street contrast, felt texture

**Files:**
- Modify: `client/src/components/GameTable.jsx` (hero card `size` prop, ~line 384-397)
- Modify: `client/src/styles/velvet.css` (`.pot`/street-label color rules, `.table-canvas` background)

**Interfaces:** none new — visual-only.

- [ ] **Step 1: Shrink hero hole cards**

In `client/src/components/GameTable.jsx`, in the `.hero-cards` block (~lines 378-398), change every `size="md"` to `size="sm"` (there are two occurrences: the revealed-cards map and the face-down-cards map, plus the two-card fallback array at the bottom of that block).

- [ ] **Step 2: Fix pot-label text contrast**

The felt background is `#08120A` (`.game-stage` in `client/src/styles/velvet.css:333`). `.pot-label` (velvet.css:90, the small "底池" caption under the street tag) is `color:#5A4C24` — roughly 2.5:1 contrast against that background, well under the 4.5:1 AA minimum for small text, and the specific text the user called out. `.street-tag` (velvet.css:89, `#C9A94A` at `opacity:.8`) and `.pot-amt` (velvet.css:91, `#E8C24A`) are both already high-contrast and don't need changes.

In `client/src/styles/velvet.css`, change line 90:

```css
.pot-label { font-family:var(--font-mono); font-size:7px; color:#9C8556; letter-spacing:3px; text-transform:uppercase; margin-top:3px; }
```

(`#9C8556` against `#08120A` is roughly 5.3:1 — passes AA for small text — while staying visibly more muted than `.pot-amt`'s `#E8C24A`, preserving the existing "amount is the hero, label is secondary" hierarchy from the "视觉信息层级与配色" decision earlier in design.md.)

- [ ] **Step 3: Felt texture — use the frontend-design skill**

This step should be done by invoking the `frontend-design` skill (per design.md's explicit instruction not to guess texture parameters) to generate 2-3 candidate `background` CSS values (gradient + subtle noise, e.g. a small repeating SVG data-URI noise pattern layered under the existing radial gradient on `.table-canvas` or `.table-zone`) for the user to compare in the `?states=` gallery, rather than hand-picking one texture unilaterally here.

- [ ] **Step 4: Visual check**

Run: `cd client && npm run dev`, open `?states=0` through `?states=7`.
Expected: hero's own two hole cards are visibly smaller than before but still clearly readable; pot/street text is legible against the green felt at a glance; felt has a subtle non-flat texture.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/GameTable.jsx client/src/styles/velvet.css
git commit -m "style: shrink hero hole cards, raise pot/street text contrast, add felt texture"
```

---

### Task 9: Gallery fixtures + full regression pass

**Files:**
- Modify: `client/src/fixtures.js` (add a 9-max dense-table state and an active-seat-with-timer state if not already exercised by existing fixtures)
- Modify: `e2e/game.spec.js` (re-run and fix any stale oval-specific assertions found during Task 3's Step 7 that weren't already addressed)

**Interfaces:** none new.

- [ ] **Step 1: Add a 9-max fixture**

Append to `client/src/fixtures.js` (after the existing `STATES.push(...)` blocks), reusing the `c()` helper already defined at the top of the file:

```javascript
// 9-max dense table — verifies the column layout's two-per-row density and
// card-shrink rules under the fullest supported room size.
STATES.push({
  name: '9人满桌·密集', myId: 'me', roomCode: '4827',
  gameState: {
    phase: 'flop', pot: 480, currentBet: 0, actionPlayerId: 'p3',
    communityCards: [c('9', '♣'), c('4', '♦'), c('K', '♥'), null, null],
    players: [
      { id: 'me', name: 'Augustine', chips: 900, bet: 0, status: 'active', holeCards: [c('8', '♠'), c('J', '♥')] },
      { id: 'p1', name: '王建国', chips: 800, bet: 0, status: 'active', holeCards: [null, null], isDealer: true },
      { id: 'p2', name: '陈美玲', chips: 700, bet: 0, status: 'folded', holeCards: [null, null], isSB: true },
      { id: 'p3', name: '张伟', chips: 600, bet: 0, status: 'active', holeCards: [null, null], isBB: true },
      { id: 'p4', name: '李大明是个非常长的名字', chips: 500, bet: 0, status: 'active', holeCards: [null, null] },
      { id: 'p5', name: '赵军', chips: 400, bet: 0, status: 'allin', holeCards: [null, null] },
      { id: 'p6', name: '孙丽', chips: 300, bet: 0, status: 'folded', holeCards: [null, null] },
      { id: 'p7', name: '周涛', chips: 200, bet: 0, status: 'active', holeCards: [null, null] },
      { id: 'p8', name: '吴敏', chips: 100, bet: 0, status: 'active', holeCards: [null, null] },
    ],
  },
});
```

- [ ] **Step 2: Visual check the new fixture**

Run: `cd client && npm run dev`, open `?states=8` (index of the newly appended fixture — check the console-printed index list the gallery already logs, or count from 0 through the existing 8 states plus this new one).
Expected: 8 opponent cards split 4-left/4-right, all readable, `李大明是个非常长的名字` truncates with an ellipsis instead of overflowing or wrapping, no card overlaps its neighbor above/below it in the same column.

- [ ] **Step 3: Full regression**

Run: `npm run test:all` (from repo root)
Expected: server tests 80/80 pass, full Playwright suite passes with zero regressions. If any pre-existing Playwright assertion still references oval-specific geometry (found and possibly already patched during Task 3 Step 7), confirm it's fixed here; if new failures surface from Tasks 4-8's DOM/class changes (e.g. a selector like `.stack-chip` that no longer exists — now `.stack-chip-footer`), update those selectors to match.

- [ ] **Step 4: Commit**

```bash
git add client/src/fixtures.js e2e/game.spec.js
git commit -m "test: add 9-max gallery fixture, fix stale selectors after layout overhaul"
```

---

## Post-Plan: SDD bookkeeping

After all 9 tasks are committed and the full regression suite is green, go back to the **original checkout** (`/Users/reyes/测试 OpenStack`, not this worktree) and update `openspec/changes/online-texas-holdem/tasks.md`'s section 27 checkboxes from `- [ ]` to `- [x]` for every subtask actually completed (per the project's own rule: task completion must reflect real, verified code — not be checked off from this worktree's perspective in isolation). If any subtask was skipped or changed from what design.md §"第十九轮" describes, add a short note there explaining the deviation, matching every other round's documented pattern in that file.

Do not push this branch — merge/PR/push decisions are the user's call per project convention (no auto-push).
