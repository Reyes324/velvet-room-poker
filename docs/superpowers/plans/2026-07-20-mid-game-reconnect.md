# Mid-Game Reconnect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a player disconnects mid-hand, stop auto-folding and removing them from the room; instead pause on their turn and let them reconnect, the host manually fold for them, or a 5-minute safety timeout fold for them — never a plain "time's up" removal.

**Architecture:** The turn-based `GameEngine` already refuses actions unless it's the acting player's turn (`idx !== this.actionIndex` guard) — so simply *not* auto-folding/removing a disconnected player on `disconnect` makes the hand naturally stall until someone (them, the host, or a timeout) acts. `Room` gains an explicit `connected` flag per player (replacing the implicit, ad-hoc "was there ever a live socket" tracking) and three new methods (`getActionPlayerId`, `resolveDisconnectedTurn`, `foldForDisconnected`) that `server/index.js` wires into the existing `disconnect`/`room:sync`/`broadcastRoom` flow. A new `maybeArmPauseTimer` helper, called from the single `broadcastRoom` funnel point, owns the 5-minute safety-timeout lifecycle.

**Tech Stack:** Node.js/Express/Socket.io backend (`server/`), React/Vite frontend (`client/`), Vitest for unit/integration tests, Playwright for e2e.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-20-mid-game-reconnect-design.md`
- Lobby-phase (`room.status==='waiting'`) disconnect/grace-period behavior is UNCHANGED — this plan only touches `room.status==='playing'` behavior.
- Post-showdown settlement-ack disconnect handling (`dropFromSettlementWait`) is UNCHANGED — out of scope per spec.
- Safety timeout is fixed at 5 minutes (`300000` ms), confirmed by the user.
- UI changes are intentionally minimal this round (plain toast text + a plain button) — do NOT touch `client/src/components/GameTable.jsx`, `client/src/components/PlayerSeat.jsx`, or `client/src/styles/velvet.css`. Those files are under active rework in a parallel branch; touching them risks merge conflicts and is explicitly out of scope per the spec.
- Commit message format: `type: description` (English). Do not push unless explicitly asked.
- Every task must leave `npm test` (server, Vitest) green before moving to the next task.

---

### Task 1: `Room` — explicit `connected` field + `setConnected()` + expose in `getLobbyState()`

**Files:**
- Modify: `server/RoomManager.js:16-17` (constructor player object), `server/RoomManager.js:30-33` (`addPlayer`), `server/RoomManager.js:68-71` (near `updateSocket`), `server/RoomManager.js:186-190` (`getLobbyState`)
- Test: `server/__tests__/RoomManager.test.js`

**Interfaces:**
- Produces: `Room.setConnected(playerId, connected)` — sets `players[i].connected`. `Room.getLobbyState().players[i].connected` — boolean, `true` unless explicitly disconnected.

- [ ] **Step 1: Write the failing tests**

Append to `server/__tests__/RoomManager.test.js` (find the existing `describe('RoomManager — 创建房间', ...)` block near the top and add a new describe block after it, e.g. right after the closing of the "加入房间" describe block):

```js
describe('RoomManager — 连接状态', () => {
  it('新创建/新加入的玩家默认 connected 为 true', () => {
    const room = rooms.create('p1', 'Alice');
    rooms.join(room.code, 'p2', 'Bob', 'socket2');
    expect(room.players.find(p => p.id === 'p1').connected).toBe(true);
    expect(room.players.find(p => p.id === 'p2').connected).toBe(true);
  });

  it('setConnected(false) 标记玩家为断线，不影响其他字段', () => {
    const room = rooms.create('p1', 'Alice');
    room.setConnected('p1', false);
    const p = room.players.find(p => p.id === 'p1');
    expect(p.connected).toBe(false);
    expect(p.chips).toBe(1000);
  });

  it('setConnected(true) 能把断线状态改回来', () => {
    const room = rooms.create('p1', 'Alice');
    room.setConnected('p1', false);
    room.setConnected('p1', true);
    expect(room.players.find(p => p.id === 'p1').connected).toBe(true);
  });

  it('setConnected 对不存在的 playerId 静默忽略', () => {
    const room = rooms.create('p1', 'Alice');
    expect(() => room.setConnected('nope', false)).not.toThrow();
  });

  it('getLobbyState() 的 players 里带上 connected 字段', () => {
    const room = rooms.create('p1', 'Alice');
    room.setConnected('p1', false);
    const state = room.getLobbyState();
    expect(state.players.find(p => p.id === 'p1').connected).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --prefix server -- RoomManager.test.js`
Expected: FAIL — `room.setConnected is not a function`, and `connected` is `undefined` in the lobby-state assertion.

- [ ] **Step 3: Implement**

In `server/RoomManager.js`, change the constructor's initial player (line 16):

```js
    this.players = [{ id: hostId, name: hostName, chips: STARTING_CHIPS, socketId: null, debt: 0, connected: true }];
```

Change `addPlayer` (around line 30-33):

```js
  addPlayer(id, name, socketId) {
    if (this.players.length >= 9) return { error: '房间已满，无法加入' };
    if (this.players.find(p => p.id === id)) return { error: '已在房间内' };
    this.players.push({ id, name, chips: STARTING_CHIPS, socketId, debt: 0, connected: true });
    return { ok: true };
  }
```

Add a new method right after `updateSocket` (around line 68-71):

```js
  updateSocket(playerId, socketId) {
    const p = this.players.find(p => p.id === playerId);
    if (p) p.socketId = socketId;
  }

  // Explicit connection-status flag, separate from `socketId` (which is
  // never cleared on disconnect and so doesn't reflect live status). Set
  // false on disconnect, true on room:create/room:join/room:sync — see
  // server/index.js.
  setConnected(playerId, connected) {
    const p = this.players.find(p => p.id === playerId);
    if (p) p.connected = connected;
  }
```

Change `getLobbyState()` (around line 186-190):

```js
  getLobbyState() {
    return {
      code: this.code,
      hostId: this.hostId,
      status: this.status,
      startingChips: STARTING_CHIPS,
      players: this.players.map(p => ({ id: p.id, name: p.name, chips: p.chips, debt: p.debt || 0, connected: p.connected !== false })),
    };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --prefix server -- RoomManager.test.js`
Expected: PASS, all tests in the file green.

- [ ] **Step 5: Commit**

```bash
git add server/RoomManager.js server/__tests__/RoomManager.test.js
git commit -m "feat: track explicit per-player connection status on Room"
```

---

### Task 2: `Room.nextRound()` skips disconnected players when dealing a new hand

**Files:**
- Modify: `server/RoomManager.js:84-106` (`nextRound`)
- Test: `server/__tests__/RoomManager.test.js`

**Interfaces:**
- Consumes: `Room.setConnected` (Task 1), `Room.players[i].connected`.
- Produces: `Room.nextRound()` — `active` roster now excludes `connected===false` players in addition to the existing `chips>0` filter.

- [ ] **Step 1: Write the failing test**

Find the existing `describe` block that covers `nextRound` in `server/__tests__/RoomManager.test.js` (search for `nextRound`); if none exists yet, add a new describe block at the end of the file:

```js
describe('RoomManager — nextRound 跳过断线玩家', () => {
  it('断线的玩家不会被发进下一手，即使筹码 > 0', () => {
    const rooms2 = new RoomManager();
    const room = rooms2.create('p1', 'Alice');
    rooms2.join(room.code, 'p2', 'Bob', 'socket2');
    rooms2.join(room.code, 'p3', 'Carol', 'socket3');
    room.startGame();
    room.setConnected('p2', false);
    const result = room.nextRound();
    expect(result.ok).toBe(true);
    const dealtIds = room.game.players.map(p => p.id);
    expect(dealtIds).not.toContain('p2');
    expect(dealtIds).toEqual(expect.arrayContaining(['p1', 'p3']));
  });

  it('重连后下一次 nextRound 会把玩家重新算进去', () => {
    const rooms2 = new RoomManager();
    const room = rooms2.create('p1', 'Alice');
    rooms2.join(room.code, 'p2', 'Bob', 'socket2');
    rooms2.join(room.code, 'p3', 'Carol', 'socket3');
    room.startGame();
    room.setConnected('p2', false);
    room.nextRound();
    room.setConnected('p2', true);
    const result = room.nextRound();
    expect(result.ok).toBe(true);
    const dealtIds = room.game.players.map(p => p.id);
    expect(dealtIds).toContain('p2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --prefix server -- RoomManager.test.js`
Expected: FAIL — first test's `dealtIds` still contains `'p2'` because the filter doesn't check `connected` yet.

- [ ] **Step 3: Implement**

In `server/RoomManager.js`, in `nextRound()` (around line 92-93), change:

```js
    // Only active (chips > 0) players enter the next hand — this already
    // naturally picks up anyone who joined mid-game or just rebought, since
    // it's filtered fresh from the full room roster every time, not carried
    // over from the previous hand's player list.
    const active = this.players.filter(p => p.chips > 0);
```

to:

```js
    // Only active (chips > 0, currently connected) players enter the next
    // hand — this already naturally picks up anyone who joined mid-game,
    // just rebought, or just reconnected, since it's filtered fresh from
    // the full room roster every time, not carried over from the previous
    // hand's player list. Disconnected players are skipped (not dealt in)
    // rather than force-included, so the same absent player doesn't stall
    // every subsequent hand — they're picked back up automatically the
    // next time nextRound() runs after they reconnect.
    const active = this.players.filter(p => p.chips > 0 && p.connected !== false);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --prefix server -- RoomManager.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/RoomManager.js server/__tests__/RoomManager.test.js
git commit -m "feat: skip disconnected players when dealing the next hand"
```

---

### Task 3: `Room.getActionPlayerId()` / `resolveDisconnectedTurn()` / `foldForDisconnected()`

**Files:**
- Modify: `server/RoomManager.js` (add methods near `playerAction`, around line 166-176)
- Test: `server/__tests__/RoomManager.test.js`

**Interfaces:**
- Consumes: `GameEngine.players`, `GameEngine.actionIndex`, `GameEngine.fold(playerId)` (all pre-existing, unchanged).
- Produces:
  - `Room.getActionPlayerId(): string | null`
  - `Room.resolveDisconnectedTurn(targetId): { ok: true } | { error: string }` — no host check, used by both the host-triggered path and the system timeout (Task 7).
  - `Room.foldForDisconnected(hostId, targetId): { ok: true } | { error: string }` — host-gated wrapper around `resolveDisconnectedTurn`.

- [ ] **Step 1: Write the failing tests**

Add to `server/__tests__/RoomManager.test.js`:

```js
describe('RoomManager — 断线玩家的行动兜底', () => {
  function setupPlayingRoom() {
    const rooms2 = new RoomManager();
    const room = rooms2.create('p1', 'Alice');
    rooms2.join(room.code, 'p2', 'Bob', 'socket2');
    room.startGame();
    return room;
  }

  it('getActionPlayerId 返回当前该行动的玩家 id', () => {
    const room = setupPlayingRoom();
    const id = room.getActionPlayerId();
    expect(['p1', 'p2']).toContain(id);
  });

  it('getActionPlayerId 在没有牌局时返回 null', () => {
    const rooms2 = new RoomManager();
    const room = rooms2.create('p1', 'Alice');
    expect(room.getActionPlayerId()).toBeNull();
  });

  it('resolveDisconnectedTurn：目标玩家没断线 → 拒绝', () => {
    const room = setupPlayingRoom();
    const actingId = room.getActionPlayerId();
    const result = room.resolveDisconnectedTurn(actingId);
    expect(result.error).toBeDefined();
  });

  it('resolveDisconnectedTurn：目标玩家断线但不是他的回合 → 拒绝', () => {
    const room = setupPlayingRoom();
    const actingId = room.getActionPlayerId();
    const otherId = actingId === 'p1' ? 'p2' : 'p1';
    room.setConnected(otherId, false);
    const result = room.resolveDisconnectedTurn(otherId);
    expect(result.error).toBeDefined();
  });

  it('resolveDisconnectedTurn：目标玩家断线且正是他的回合 → 成功弃牌', () => {
    const room = setupPlayingRoom();
    const actingId = room.getActionPlayerId();
    room.setConnected(actingId, false);
    const result = room.resolveDisconnectedTurn(actingId);
    expect(result.error).toBeUndefined();
    expect(room.players.find(p => p.id === actingId)).toBeDefined(); // still seated
  });

  it('foldForDisconnected：非房主调用 → 拒绝', () => {
    const room = setupPlayingRoom();
    const actingId = room.getActionPlayerId();
    room.setConnected(actingId, false);
    const result = room.foldForDisconnected('p2', actingId); // p2 isn't always host but this asserts the check exists
    if (room.hostId !== 'p2') {
      expect(result.error).toBeDefined();
    }
  });

  it('foldForDisconnected：房主调用、目标断线且轮到他 → 成功', () => {
    const room = setupPlayingRoom();
    const actingId = room.getActionPlayerId();
    room.setConnected(actingId, false);
    const result = room.foldForDisconnected(room.hostId, actingId);
    expect(result.error).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --prefix server -- RoomManager.test.js`
Expected: FAIL — `room.getActionPlayerId is not a function`.

- [ ] **Step 3: Implement**

In `server/RoomManager.js`, add these methods right before `playerAction` (around line 166):

```js
  // The id of whoever's turn it currently is, or null if no hand is in
  // progress. Cross-references GameEngine's own actionIndex — GameEngine
  // doesn't know about room-level connection status, so this is the seam
  // between "whose turn is it" (GameEngine) and "are they actually here"
  // (Room).
  getActionPlayerId() {
    if (!this.game) return null;
    return this.game.players[this.game.actionIndex]?.id ?? null;
  }

  // Shared by the host's manual "帮TA弃牌" button and the system safety
  // timeout (see server/index.js maybeArmPauseTimer) — the only difference
  // between those two callers is who's allowed to trigger it, not what
  // happens once triggered, so both funnel through here.
  resolveDisconnectedTurn(targetId) {
    if (!this.game) return { error: '游戏未开始' };
    const target = this.players.find(p => p.id === targetId);
    if (!target || target.connected !== false) return { error: '该玩家未处于断线状态' };
    if (this.getActionPlayerId() !== targetId) return { error: '还没轮到该玩家' };
    return this.game.fold(targetId);
  }

  foldForDisconnected(hostId, targetId) {
    if (this.hostId !== hostId) return { error: '只有房主可以这样做' };
    return this.resolveDisconnectedTurn(targetId);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --prefix server -- RoomManager.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/RoomManager.js server/__tests__/RoomManager.test.js
git commit -m "feat: add Room.foldForDisconnected and its shared resolver"
```

---

### Task 4: `disconnect` handler stops auto-folding/removing players mid-game

**Files:**
- Modify: `server/index.js:193-233` (`disconnect` handler)
- Test: `server/__tests__/reconnect.test.js` (new file)

**Interfaces:**
- Consumes: `Room.setConnected` (Task 1), `Room.isAwaitingSettlementAck`, `Room.dropFromSettlementWait`, `advanceRoom`, `broadcastRoom` (all pre-existing or Task 1).
- Produces: disconnecting mid-game no longer calls `rooms.leave()` or auto-`fold`s; the player stays in `room.players` with `connected:false`.

- [ ] **Step 1: Write the failing test**

Create `server/__tests__/reconnect.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createServer } = require('../index');
const { io: Client } = require('socket.io-client');

let server;
let url;
let rooms;
const clients = [];

function connect() {
  return new Promise((resolve, reject) => {
    const socket = Client(url, { forceNew: true });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
    clients.push(socket);
  });
}

function waitFor(socket, event, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for '${event}'`)), timeout);
    socket.once(event, (data) => { clearTimeout(t); resolve(data); });
  });
}

beforeEach(async () => {
  const created = createServer();
  server = created.server;
  rooms = created.rooms;
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  url = `http://localhost:${port}`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.disconnect();
  await new Promise((resolve) => server.close(resolve));
});

async function setupPlayingRoom() {
  const [c1, c2] = await Promise.all([connect(), connect()]);
  const joined1 = waitFor(c1, 'room:joined');
  c1.emit('room:create', { playerId: 'p1', playerName: 'Alice' });
  const { code } = await joined1;
  const roomReady = waitFor(c2, 'room:state');
  c2.emit('room:join', { code, playerId: 'p2', playerName: 'Bob' });
  await roomReady;
  const gs1 = waitFor(c1, 'game:state');
  c1.emit('room:start', { playerId: 'p1' });
  const state1 = await gs1;
  return { c1, c2, code, actingId: state1.actionPlayerId };
}

describe('打牌中断线：暂停而不是自动弃牌/踢出', () => {
  it('非行动方断线 → 仍留在 room.players 里，且被标记 connected:false', async () => {
    const { c1, c2, actingId } = await setupPlayingRoom();
    const notActingSocket = actingId === 'p1' ? c2 : c1;
    const notActingId = actingId === 'p1' ? 'p2' : 'p1';

    notActingSocket.disconnect();
    await new Promise((r) => setTimeout(r, 300));

    const room = rooms.getRoomByPlayer(actingId);
    const player = room.players.find(p => p.id === notActingId);
    expect(player).toBeDefined();
    expect(player.connected).toBe(false);
  });

  it('行动方断线 → 牌局不推进（对方收不到 game:state），人仍在房间里', async () => {
    const { c1, c2, actingId } = await setupPlayingRoom();
    const actingSocket = actingId === 'p1' ? c1 : c2;
    const otherSocket = actingId === 'p1' ? c2 : c1;

    let gotNextState = false;
    const listener = () => { gotNextState = true; };
    otherSocket.on('game:state', listener);

    actingSocket.disconnect();
    await new Promise((r) => setTimeout(r, 500));

    expect(gotNextState).toBe(false);
    otherSocket.off('game:state', listener);

    const room = rooms.getRoomByPlayer(actingId === 'p1' ? 'p2' : 'p1');
    expect(room.players.map(p => p.id)).toContain(actingId);
    expect(room.getActionPlayerId()).toBe(actingId);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --prefix server -- reconnect.test.js`
Expected: FAIL — both tests fail because current `disconnect` handler still removes the player from `room.players` (`rooms.leave`) instead of just marking `connected:false`.

- [ ] **Step 3: Implement**

In `server/index.js`, replace the entire `disconnect` handler (lines 193-233):

```js
    socket.on('disconnect', () => {
      if (!myPlayerId) return;
      const room = rooms.getRoomByPlayer(myPlayerId);
      if (!room) return;

      room.setConnected(myPlayerId, false);

      if (room.isAwaitingSettlementAck()) {
        // Unchanged: settlement-ack disconnects still drop the player from
        // the "must ack" set immediately rather than pausing — this is a
        // lower-stakes confirmation click, not an in-hand decision, and is
        // explicitly out of scope for the pause-and-wait behavior below.
        if (room.dropFromSettlementWait(myPlayerId)) advanceRoom(room);
        else io.to(room.code).emit('game:settlement-progress', room.getSettlementProgress());
      } else if (room.game) {
        // Mid-hand disconnect: no auto-fold, no removal. broadcastRoom lets
        // everyone see the "connected:false" flag immediately, and (once
        // Task 7 lands) arms the safety-timeout if it's this player's turn.
        broadcastRoom(room);
      } else {
        io.to(room.code).emit('room:state', room.getLobbyState());
      }

      if (room.status === 'waiting') {
        // Lobby disconnect: give them a grace period to reconnect (e.g. they
        // just backgrounded the tab to paste the invite link somewhere)
        // instead of yanking them — and possibly deleting the whole room,
        // if they were its only player — immediately. Unchanged from before.
        const pid = myPlayerId;
        const deadSocketId = socket.id;
        const timer = setTimeout(() => {
          pendingRemovals.delete(pid);
          const stillRoom = rooms.getRoomByPlayer(pid);
          const player = stillRoom?.players.find(p => p.id === pid);
          if (stillRoom && player && player.socketId === deadSocketId) {
            rooms.leave(pid);
            if (stillRoom.players.length > 0) {
              io.to(stillRoom.code).emit('room:state', stillRoom.getLobbyState());
            }
          }
        }, GRACE_PERIOD_MS);
        pendingRemovals.set(pid, timer);
      }
      // Mid-game (room.status !== 'waiting'): deliberately no removal timer
      // at all. The only ways a mid-game player loses their seat are an
      // explicit host kick (room:kick, unchanged) or busting out of chips
      // (existing nextRound() elimination, unchanged) — see design.md.
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --prefix server -- reconnect.test.js`
Expected: PASS.

Then run the full server suite to check for regressions:

Run: `npm test --prefix server`
Expected: some pre-existing tests may now fail — specifically anything in `integration.test.js` that asserted the old "disconnect mid-game auto-folds/removes" behavior. Note which tests fail; they'll be addressed in Task 10 (this task only needs `reconnect.test.js` and `RoomManager.test.js` green, plus no *new, unexpected* failures beyond ones traceable to this intentional behavior change).

- [ ] **Step 5: Commit**

```bash
git add server/index.js server/__tests__/reconnect.test.js
git commit -m "fix: stop auto-folding and removing players on mid-game disconnect"
```

---

### Task 5: `room:sync` marks the player reconnected and broadcasts to everyone

**Files:**
- Modify: `server/index.js:152-173` (`room:sync` handler)
- Test: `server/__tests__/reconnect.test.js`

**Interfaces:**
- Consumes: `Room.setConnected` (Task 1), `broadcastRoom` (existing).
- Produces: reconnecting via `room:sync` sets `connected:true` and notifies the whole room (not just the reconnecting socket), so others see the "断线中" state clear.

- [ ] **Step 1: Write the failing test**

Add to `server/__tests__/reconnect.test.js`:

```js
  it('room:sync 重连后 connected 恢复 true，且对手也能收到更新后的 room:state', async () => {
    const { c1, c2, actingId } = await setupPlayingRoom();
    const actingSocket = actingId === 'p1' ? c1 : c2;
    const otherSocket = actingId === 'p1' ? c2 : c1;

    actingSocket.disconnect();
    await new Promise((r) => setTimeout(r, 300));

    const otherSeesReconnect = waitFor(otherSocket, 'room:state');
    actingSocket.connect();
    await new Promise((resolve) => actingSocket.once('connect', resolve));
    actingSocket.emit('room:sync', { playerId: actingId });

    const stateSeenByOther = await otherSeesReconnect;
    const player = stateSeenByOther.players.find(p => p.id === actingId);
    expect(player.connected).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --prefix server -- reconnect.test.js`
Expected: FAIL — `player.connected` is still `false` because `room:sync` doesn't call `setConnected(true)` yet, and/or the opponent never receives a fresh `room:state` broadcast (current code only emits to the reconnecting socket).

- [ ] **Step 3: Implement**

In `server/index.js`, replace the `room:sync` handler (lines 152-173):

```js
    socket.on('room:sync', ({ playerId }) => {
      const room = rooms.getRoomByPlayer(playerId);
      if (!room) {
        // Reconnected too late — the grace period already expired and the
        // room (or this player's spot in it) is gone. Say so explicitly
        // instead of leaving the client sitting on a stale lobby forever.
        socket.emit('room:gone');
        return;
      }
      // Re-associate this (possibly new, post-reconnect) socket with the
      // room: without this, a reconnected client never gets back into the
      // socket.io room (misses future broadcasts) and this connection's own
      // future 'disconnect' wouldn't know which player it was for.
      myPlayerId = playerId;
      room.updateSocket(playerId, socket.id);
      room.setConnected(playerId, true);
      socket.join(room.code);
      clearTimeout(pendingRemovals.get(playerId));
      pendingRemovals.delete(playerId);
      // Broadcast to the whole room (not just this socket) so everyone
      // else's "XXX 断线中" indicator clears too, and — once a game is in
      // progress — so maybeArmPauseTimer (Task 7) re-evaluates whether the
      // safety timeout should still be ticking.
      if (room.game) broadcastRoom(room);
      else io.to(room.code).emit('room:state', room.getLobbyState());
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --prefix server -- reconnect.test.js`
Expected: PASS.

Run: `npm test --prefix server`
Expected: no new failures beyond the ones already identified in Task 4.

- [ ] **Step 5: Commit**

```bash
git add server/index.js server/__tests__/reconnect.test.js
git commit -m "fix: room:sync marks player reconnected and broadcasts to the whole room"
```

---

### Task 6: Host-triggered "帮TA弃牌" via new `game:fold-disconnected` event

**Files:**
- Modify: `server/index.js` (add new socket handler near `room:kick`, around line 175-184)
- Test: `server/__tests__/reconnect.test.js`

**Interfaces:**
- Consumes: `Room.foldForDisconnected` (Task 3), `handleActionResult` (existing).
- Produces: socket event `game:fold-disconnected` — payload `{ hostId, targetId }`.

- [ ] **Step 1: Write the failing test**

Add to `server/__tests__/reconnect.test.js`:

```js
  it('房主对轮到行动的断线玩家发 game:fold-disconnected → 牌局推进', async () => {
    const { c1, c2, code, actingId } = await setupPlayingRoom();
    const actingSocket = actingId === 'p1' ? c1 : c2;
    const otherSocket = actingId === 'p1' ? c2 : c1;
    const hostId = 'p1'; // setupPlayingRoom always creates the room as p1

    actingSocket.disconnect();
    await new Promise((r) => setTimeout(r, 300));

    const hostSocket = hostId === actingId ? otherSocket : (hostId === 'p1' ? c1 : c2);
    // Host must be online to fire the button — if the host is the one who
    // disconnected, this specific path can't run (covered by Task 7 instead).
    if (hostId === actingId) return;

    const advanced = waitFor(hostSocket, 'room:state');
    hostSocket.emit('game:fold-disconnected', { hostId, targetId: actingId });
    await advanced;

    const room = rooms.getRoomByPlayer(hostId);
    expect(room.players.map(p => p.id)).toContain(actingId); // still seated
  });

  it('非房主发 game:fold-disconnected → 收到 game:error，牌局不推进', async () => {
    const { c1, c2, actingId } = await setupPlayingRoom();
    const actingSocket = actingId === 'p1' ? c1 : c2;
    const otherSocket = actingId === 'p1' ? c2 : c1;

    actingSocket.disconnect();
    await new Promise((r) => setTimeout(r, 300));

    const nonHostId = 'p2'; // p1 is always host per setupPlayingRoom
    if (nonHostId === actingId) return; // needs the caller to be online

    const err = waitFor(otherSocket, 'game:error');
    otherSocket.emit('game:fold-disconnected', { hostId: nonHostId, targetId: actingId });
    const msg = await err;
    expect(msg).toBeDefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --prefix server -- reconnect.test.js`
Expected: FAIL — no `game:fold-disconnected` handler exists yet, so neither `room:state` nor `game:error` ever arrives (tests time out).

- [ ] **Step 3: Implement**

In `server/index.js`, add a new handler right after the `room:kick` handler (after line 184, before `game:ready-next`):

```js
    socket.on('game:fold-disconnected', ({ hostId, targetId }) => {
      const room = rooms.getRoomByPlayer(hostId);
      if (!room) return socket.emit('game:error', '未找到房间');
      const result = room.foldForDisconnected(hostId, targetId);
      if (result.error) return socket.emit('game:error', result.error);
      handleActionResult(room, result);
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --prefix server -- reconnect.test.js`
Expected: PASS.

Run: `npm test --prefix server`
Expected: no new failures.

- [ ] **Step 5: Commit**

```bash
git add server/index.js server/__tests__/reconnect.test.js
git commit -m "feat: host can fold a stuck disconnected player's turn"
```

---

### Task 7: 5-minute safety timeout (`maybeArmPauseTimer`)

**Files:**
- Modify: `server/index.js:14-24` (new constant + Map), `server/index.js:36-43` (`broadcastRoom`, add call), add new `maybeArmPauseTimer` function near `broadcastRoom`
- Test: `server/__tests__/reconnect.test.js`

**Interfaces:**
- Consumes: `Room.getActionPlayerId`, `Room.resolveDisconnectedTurn` (Task 3), `handleActionResult` (existing).
- Produces: a room-code-keyed timer that auto-folds a stuck disconnected player after 5 minutes if nothing else has resolved it first.

- [ ] **Step 1: Write the failing test**

Add to `server/__tests__/reconnect.test.js`. This test needs fake timers, so add the vitest import at the top of the file — change the first line from:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
```

to:

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
```

Then add:

```js
describe('打牌中断线：5 分钟安全兜底', () => {
  it('轮到断线玩家超过 5 分钟没人处理 → 自动帮他弃牌', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { c1, c2, actingId } = await setupPlayingRoom();
      const actingSocket = actingId === 'p1' ? c1 : c2;
      const otherSocket = actingId === 'p1' ? c2 : c1;

      actingSocket.disconnect();
      await vi.advanceTimersByTimeAsync(500); // let the disconnect land server-side

      const advanced = waitFor(otherSocket, 'room:state', 10000);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000);
      await advanced;

      const room = rooms.getRoomByPlayer(actingId === 'p1' ? 'p2' : 'p1');
      expect(room.players.map(p => p.id)).toContain(actingId); // still seated
    } finally {
      vi.useRealTimers();
    }
  });

  it('5 分钟内玩家重连 → 不会被自动弃牌', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { c1, c2, actingId } = await setupPlayingRoom();
      const actingSocket = actingId === 'p1' ? c1 : c2;

      actingSocket.disconnect();
      await vi.advanceTimersByTimeAsync(500);
      actingSocket.connect();
      await new Promise((resolve) => actingSocket.once('connect', resolve));
      actingSocket.emit('room:sync', { playerId: actingId });
      await vi.advanceTimersByTimeAsync(500);

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000);

      const room = rooms.getRoomByPlayer(actingId === 'p1' ? 'p2' : 'p1');
      expect(room.getActionPlayerId()).toBe(actingId); // still their turn, not auto-folded
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --prefix server -- reconnect.test.js`
Expected: FAIL — first test times out waiting for `room:state` (no timer exists yet to trigger it); second test may pass vacuously right now (nothing ever auto-folds) but re-verify after Step 3 that it stays passing for the right reason.

- [ ] **Step 3: Implement**

In `server/index.js`, add a new constant and Map right after the existing `GRACE_PERIOD_MS` declaration (line 24):

```js
  const pendingRemovals = new Map();
  const GRACE_PERIOD_MS = 120000;
  // Safety-timeout for a mid-hand pause: if the player whose turn it is
  // stays disconnected this long with nobody (them or the host) resolving
  // it, auto-fold on their behalf so the table isn't stuck forever if the
  // host is unreachable too. Keyed by room code — only one turn can be
  // "stuck" at a time per room. See maybeArmPauseTimer below.
  const pauseTimers = new Map();
  const PAUSE_TIMEOUT_MS = 5 * 60 * 1000;
```

Add the `maybeArmPauseTimer` function right after `broadcastRoom` (after line 43, before the `advanceRoom` comment):

```js
  // Arms, re-arms, or clears the pause-timeout for a room, based on
  // whether whoever's turn it currently is is disconnected. Called from
  // the single broadcastRoom() funnel point below, so it re-evaluates
  // after every event that could change whose turn it is or someone's
  // connection status (actions, disconnects, reconnects).
  function maybeArmPauseTimer(room) {
    const existing = pauseTimers.get(room.code);
    const actionPlayerId = room.getActionPlayerId();
    const player = actionPlayerId ? room.players.find(p => p.id === actionPlayerId) : null;
    const shouldBeArmed = !!player && player.connected === false;

    if (existing && existing.playerId === actionPlayerId && shouldBeArmed) return; // already correct
    if (existing) {
      clearTimeout(existing.timer);
      pauseTimers.delete(room.code);
    }
    if (!shouldBeArmed) return;

    const timer = setTimeout(() => {
      pauseTimers.delete(room.code);
      // Re-validate at fire time — the situation may have resolved itself
      // (reconnect, host fold, hand ended) between arming and firing.
      const result = room.resolveDisconnectedTurn(actionPlayerId);
      if (!result.error) handleActionResult(room, result);
    }, PAUSE_TIMEOUT_MS);
    pauseTimers.set(room.code, { playerId: actionPlayerId, timer });
  }
```

Then wire it into `broadcastRoom` (line 36-43):

```js
  function broadcastRoom(room) {
    maybeArmPauseTimer(room);
    for (const p of room.players) {
      if (!p.socketId) continue;
      const state = room.getStateForPlayer(p.id);
      if (state) io.to(p.socketId).emit('game:state', state);
    }
    io.to(room.code).emit('room:state', room.getLobbyState());
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --prefix server -- reconnect.test.js`
Expected: PASS, all describe blocks in the file green.

Run: `npm test --prefix server`
Expected: no new failures beyond the ones already identified in Task 4 (to be resolved in Task 10).

- [ ] **Step 5: Commit**

```bash
git add server/index.js server/__tests__/reconnect.test.js
git commit -m "feat: 5-minute safety timeout auto-folds a stuck disconnected player"
```

---

### Task 8: Client — "断线中" toast + host "帮TA弃牌" button

**Files:**
- Modify: `client/src/pages/RoomPage.jsx`
- Test: manual verification via `npm run dev` (no client unit-test harness in this project — client behavior is verified via Playwright e2e in Task 10)

**Interfaces:**
- Consumes: `roomState.players[i].connected` (Task 1), `gameState.actionPlayerId` (existing), `emit('game:fold-disconnected', { hostId, targetId })` (Task 6).

- [ ] **Step 1: Read the current game-table render branch**

In `client/src/pages/RoomPage.jsx`, locate the `// ─── Game Table ───` section (the final `return (...)` block, after the lobby early-return). This is where the new toast/button will be added — as siblings alongside the existing `{toast && ...}` line, NOT inside `<GameTable>` (which is off-limits per the Global Constraints).

- [ ] **Step 2: Implement the derived "stuck" state and button handler**

In `client/src/pages/RoomPage.jsx`, find this block (present after `const isHost = roomState?.hostId === playerId;`):

```js
  const isHost = roomState?.hostId === playerId;
  const inGame = roomState?.status === 'playing' && gameState;
```

Change it to also compute who's stuck:

```js
  const isHost = roomState?.hostId === playerId;
  const inGame = roomState?.status === 'playing' && gameState;

  // Whoever's turn it currently is, cross-referenced against roomState's
  // connection flags (gameState doesn't carry `connected` — that lives on
  // the room-level player list, see server/RoomManager.js getLobbyState).
  const stuckPlayer = inGame
    ? roomState.players?.find(p => p.id === gameState.actionPlayerId && p.connected === false)
    : null;

  function foldForDisconnected() {
    emit('game:fold-disconnected', { hostId: playerId, targetId: stuckPlayer.id });
  }
```

- [ ] **Step 3: Add the toast + button to the game-table render branch**

In the final `return (...)` block (game table branch), find the closing toast line:

```jsx
      {toast && <div className={`toast toast--${toast.type}`}>{toast.msg}</div>}
    </>
  );
}
```

Change it to add the stuck-player indicator right before the existing toast:

```jsx
      {stuckPlayer && (
        <div className="toast toast--info">
          {stuckPlayer.name} 断线中，等待重连…
          {isHost && (
            <span
              style={{ marginLeft: 12, textDecoration: 'underline', cursor: 'pointer' }}
              onClick={foldForDisconnected}
            >
              帮TA弃牌
            </span>
          )}
        </div>
      )}
      {toast && <div className={`toast toast--${toast.type}`}>{toast.msg}</div>}
    </>
  );
}
```

- [ ] **Step 4: Manually verify in the dev server**

Run: `npm run dev --prefix client` (in one terminal) and `npm run dev --prefix server` (in another, or `node --watch server/index.js`)
Open two browser tabs, create a room in one, join in the other, start the game. In the tab whose turn it is NOT, open devtools console and run `window.__vrSocket.disconnect()` — confirm the *other* (host) tab shows the "XXX 断线中，等待重连…" toast when it becomes that player's turn, or immediately if it already is. Confirm the "帮TA弃牌" link only appears for the host, and clicking it advances the hand.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/RoomPage.jsx
git commit -m "feat: show disconnected-player toast and host fold-for-them button"
```

---

### Task 9: Client — "（断线中）" text badge in the lobby player list

**Files:**
- Modify: `client/src/components/Lobby.jsx:70-99` (player row rendering)

**Interfaces:**
- Consumes: `roomState.players[i].connected` (Task 1).

- [ ] **Step 1: Implement**

In `client/src/components/Lobby.jsx`, find the player row's name line (around line 74):

```jsx
                <div className="pr-name">{p.name}{p.id === playerId ? '（我）' : ''}</div>
```

Change it to also show the disconnected marker:

```jsx
                <div className="pr-name">
                  {p.name}{p.id === playerId ? '（我）' : ''}
                  {p.connected === false && <span style={{ color: '#B08A3A' }}>（断线中）</span>}
                </div>
```

- [ ] **Step 2: Manually verify in the dev server**

With two tabs in the same room's lobby (before starting the game), disconnect one (`window.__vrSocket.disconnect()` in its console) and confirm the other tab's player list shows "（断线中）" next to that player's name, and that it clears once reconnected (`window.__vrSocket.connect()`).

- [ ] **Step 3: Commit**

```bash
git add client/src/components/Lobby.jsx
git commit -m "feat: show disconnected-player marker in the lobby list"
```

---

### Task 10: Update/add Playwright e2e coverage for the new pause behavior

**Files:**
- Modify: `e2e/game.spec.js` (the existing `'行动玩家关闭页面后对方获得行动机会'` test, around line 389-413, now asserts the *opposite* of what it used to)
- Modify: `server/__tests__/integration.test.js` (any pre-existing test broken by Task 4's behavior change — identify by running the full suite)

**Interfaces:**
- Consumes: `window.__vrSocket.disconnect()`/`.connect()` debug hook (existing, `client/src/hooks/useSocket.js`), `game:fold-disconnected` event (Task 6).

- [ ] **Step 1: Find and fix any now-broken integration tests**

Run: `npm test --prefix server`
Read the failure output. Any test whose name or assertions describe "断线自动弃牌" or "断线立即移出房间" during `room.status==='playing'` is asserting the OLD (now intentionally changed) behavior. For each such test found in `server/__tests__/integration.test.js`, update its assertions to match the new behavior (player stays connected:false, hand pauses, doesn't auto-fold) rather than deleting the test — if you're unsure whether a given failure is expected from this change or a real regression, stop and check the diff from Task 4/5 against what the test asserts before editing it.

- [ ] **Step 2: Rewrite the existing e2e test to match the new pause behavior**

In `e2e/game.spec.js`, find:

```js
  test('行动玩家关闭页面后对方获得行动机会', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();

    const code = await createRoom(p1, 'Alice');
    await joinRoom(p2, 'Bob', code);
    await startGame(p1);

    const [actor, other] = await findActor(p1, p2);

    // 行动玩家关闭标签
    await actor.close();

    // 对方应在短时间内获得行动机会（或直接看到摊牌）
    // waitFor 才会真正轮询等待元素出现，isVisible 是即时快照不会等待
    const [gotBar, gotResult] = await Promise.all([
      other.locator(S.actionBar).waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false),
      other.locator(S.settlement).waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false),
    ]);
    expect(gotBar || gotResult).toBe(true);

    await ctx2.close();
  });
});
```

Replace it with (same file location, same `test.describe` block it's currently in):

```js
  test('行动玩家断线后牌局暂停等待，不会自动弃牌给对方行动机会', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();

    const code = await createRoom(p1, 'Alice');
    await joinRoom(p2, 'Bob', code);
    await startGame(p1);

    const [actor, other] = await findActor(p1, p2);

    // 用页面里暴露的调试钩子强制断开 socket（不是关闭标签页）——关闭标签页
    // 之后这个 context 就没法再操作了，没法验证"重连后恢复正常"这一半；
    // 用 __vrSocket.disconnect() 保留 context，可以后续重连回来。
    await actor.evaluate(() => window.__vrSocket.disconnect());

    // 对方应该看到"断线中，等待重连"的提示，且**不会**获得行动机会
    await other.locator('.toast--info', { hasText: '断线中' }).waitFor({ state: 'visible', timeout: 8000 });
    const gotActionBar = await other.locator(S.actionBar).isVisible().catch(() => false);
    expect(gotActionBar).toBe(false);

    // 断线的一方重连后，应该能继续正常操作（说明筹码/座位都还在，游戏没有被打断）
    await actor.evaluate(() => window.__vrSocket.connect());
    await actor.locator(S.actionBar).waitFor({ state: 'visible', timeout: 8000 });

    await ctx1.close();
    await ctx2.close();
  });
});
```

- [ ] **Step 3: Add a new e2e test for the host "帮TA弃牌" path**

In the same `test.describe` block in `e2e/game.spec.js`, add a new test right after the one from Step 2:

```js
  test('房主可以帮断线且轮到行动的玩家弃牌，牌局能继续', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();

    const code = await createRoom(p1, 'Alice'); // p1 is host
    await joinRoom(p2, 'Bob', code);
    await startGame(p1);

    const [actor, other] = await findActor(p1, p2);
    const actorIsHost = actor === p1;
    if (actorIsHost) {
      // Host is the one who's stuck — the host-fold-button path can't run
      // (no one else can click it); this scenario is covered by the
      // 5-minute safety timeout instead (server-side test, Task 7), not
      // re-tested here since it isn't practical to wait 5 real minutes in
      // an e2e run.
      await ctx1.close();
      await ctx2.close();
      return;
    }

    await actor.evaluate(() => window.__vrSocket.disconnect());
    await other.locator('.toast--info', { hasText: '断线中' }).waitFor({ state: 'visible', timeout: 8000 });

    // `other` here is the host (p1) since actor !== p1 in this branch
    await other.locator('text=帮TA弃牌').click();

    // Hand should advance past the disconnected player — settlement or a
    // fresh action bar for whoever's next both indicate progress happened.
    const [gotBar, gotResult] = await Promise.all([
      other.locator(S.actionBar).waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false),
      other.locator(S.settlement).waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false),
    ]);
    expect(gotBar || gotResult).toBe(true);

    await ctx1.close();
    await ctx2.close();
  });
```

- [ ] **Step 4: Run the full test suite**

Run: `npm test --prefix server`
Expected: PASS, all files green (including the reconnect.test.js from Tasks 4-7 and any fixes from Step 1 of this task).

Run: `cd client && npm run build && cd ..`
Expected: builds without errors.

Run: `npx playwright test`
Expected: PASS, all tests green (including the two rewritten/added in this task).

- [ ] **Step 5: Commit**

```bash
git add e2e/game.spec.js server/__tests__/integration.test.js
git commit -m "test: update e2e/integration coverage for mid-game reconnect pause behavior"
```

---

### Task 11: Update SDD (design.md / tasks.md) and final verification

**Files:**
- Modify: `openspec/changes/online-texas-holdem/design.md`
- Modify: `openspec/changes/online-texas-holdem/tasks.md`

**Interfaces:** None — documentation only.

- [ ] **Step 1: Append the design decision to design.md**

Per this project's `CLAUDE.md` SDD workflow, add a new dated entry to `openspec/changes/online-texas-holdem/design.md` (find the end of the most recent "用户反馈" section and add after it, before "## Open Questions"). Summarize: the root cause (mid-game disconnect had zero grace period, by original MVP-era design), the decision (pause-and-wait instead of auto-fold/remove, host manual override, 5-minute safety timeout, disconnected players skipped from future hands until reconnect, only host-kick/bust-out lose a seat), and reference the full spec at `docs/superpowers/specs/2026-07-20-mid-game-reconnect-design.md` rather than re-deriving all details inline. Use the same numbered-round heading convention as existing entries (check the highest round number already used in the file and increment).

- [ ] **Step 2: Add a new numbered task section to tasks.md**

Add a new section (increment the highest existing section number) to `openspec/changes/online-texas-holdem/tasks.md` listing each of Tasks 1-10 above as a checked `[x]` sub-item (all done by this point), following the existing file's format (see any recent section for the pattern — bold lead sentence + explanation, matching the terse style already used throughout the file).

- [ ] **Step 3: Run the complete verification suite one more time**

Run: `npm test --prefix server`
Expected: PASS, all green.

Run: `cd client && npm run build && cd ..`
Expected: builds cleanly.

Run: `npx playwright test`
Expected: PASS, all green (should include the pre-existing suite plus this feature's new/updated tests).

- [ ] **Step 4: Commit**

```bash
git add openspec/changes/online-texas-holdem/design.md openspec/changes/online-texas-holdem/tasks.md
git commit -m "docs: record mid-game reconnect design in SDD"
```

- [ ] **Step 5: Report completion**

Summarize to the user: what changed, what the full test counts are (server unit+integration, e2e), and that nothing was pushed (per project convention — pushing requires explicit user instruction).
