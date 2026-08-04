# Investigation: PVE blank-screen crash (4-player, human folded, AI-only continuation)

**Status: NOT REPRODUCED** (after 1,168 real hands / 660s continuous real-time play at seatCount=4)

## Bug report (recap)

User folded in a 4-player PVE (1 human + 3 AI) game, leaving 3 AI seats to keep
playing each other. After playing "for a while," the screen went completely
blank — solid background color, no top bar, no seats, no action bar. Never
seen in heads-up PVE. Suspected trigger: the human folded but the hand
continues with 2+ AI seats still acting against each other — a code path that
literally cannot happen in heads-up (seatCount=2), since if the only human
folds against the only AI, the hand ends immediately.

## Environment / setup

- Checkout: `/Users/reyes/测试 OpenStack` (main branch)
- Server: `node server/index.js` → `http://localhost:3001` (health-checked via `/health`)
- Client: `cd client && npm run dev` (Vite) → `http://localhost:5173`, proxies `/socket.io` to :3001
- Playwright: real headless Chromium via this repo's `@playwright/test` devDependency (`node_modules/@playwright/test`), invoked directly with `chromium.launch()` from a standalone Node script — not through `npx playwright test` / the project's `playwright.config.js`, since this was an ad-hoc investigation, not a suite run.
- Reviewed `e2e/game.spec.js` first and reused its selector conventions (`.game-stage`, `.action-bar`, `.settlement-sheet`, `.b-fold`, `.b-check`, `.b-call`, `window.__vrSocket` debug hook) rather than inventing new ones.

## Script

Wrote a throwaway diagnostic script (per this project's convention for one-off
investigation scripts) at
`/private/tmp/claude-501/-Users-reyes/bae0b46b-ddf0-4703-93a5-f0f1494aee6c/scratchpad/pve-blank-screen-repro.js`.
**Deleted after use** — it was never committed and is not part of the repo.

What it did:
1. Attached `page.on('console', ...)`, `page.on('pageerror', ...)`, and
   `page.on('crash', ...)` listeners **before** any navigation, logging
   everything unfiltered (not just errors) to catch the full stack if/when a
   crash happened.
2. Navigated to `http://localhost:5173`, filled the nickname field, clicked
   `人机对战` → `4 人` to start a real 4-seat PVE session (1 human + 3 AI).
3. Looped for a fixed wall-clock duration (real time, not sped-up — the
   server's AI "thinking" delays are real `setTimeout`s, so this genuinely
   exercises the same pacing a real user would see):
   - If `.settlement-sheet` was visible, clicked "我知道了" (ready-next) to
     advance to the next hand — this is the PVE equivalent of the multiplayer
     e2e suite's ready-next flow.
   - If the "筹码已用完" bust modal appeared, clicked "借一底" to keep the
     session going indefinitely rather than ending it.
   - If `.action-bar` was visible (human's turn), acted normally: check if
     legal, else call, else fold — **not** an always-fold strategy. (See
     "Course correction" below for why.)
   - Otherwise (AI seats acting, or mid-animation), just waited 300ms and
     re-polled — deliberately not fast-forwarding past the AI's real
     "thinking" delay.
   - Every 5 hands: logged progress and took a screenshot.
   - On every loop iteration: checked whether `.game-stage` / `.top-bar` had
     disappeared (0 count) — the literal signature of the reported bug
     (nothing rendered at all, not even chrome).

### Course correction mid-investigation

The task brief said to fold whenever legal, matching the bug report's literal
"human folds, AI plays on" framing. Partway through I received a coordinator
correction: the actual reported scenario is human **idle** for a stretch
while 2+ AI seats act against each other — which happens on *every* hand at
4+ seats any time it isn't the human's turn, not only on hands where the
human folds. I updated the script's turn strategy to check/call by default
(only falling back to fold when check/call weren't legal), to maximize time
spent with the human alive-but-idle watching multi-AI streets, and re-ran the
full-length session with that strategy. Results below are from that
corrected run.

## Run results

- **Duration**: 660 seconds (11 minutes) continuous real wall-clock, browser
  never closed/reloaded/navigated away.
- **Hands completed**: 1,168 (via the `game:ready-next` / "我知道了" flow
  between every hand — no restarts).
- **Console errors** (`console.error` type): **0**
- **Page errors** (uncaught exceptions, `pageerror` event): **0**
- **Renderer crashes** (`crash` event): **0**
- **Full console output** (3 entries total, all benign — Vite HMR connect
  messages and the standard React DevTools info line): saved at
  `/private/tmp/claude-501/-Users-reyes/bae0b46b-ddf0-4703-93a5-f0f1494aee6c/scratchpad/console-log.json`
- **Error log** (empty array, confirming zero errors/crashes the whole run):
  `/private/tmp/claude-501/-Users-reyes/bae0b46b-ddf0-4703-93a5-f0f1494aee6c/scratchpad/error-log.json`
- **Final state check** (`.game-stage` count / `.top-bar` count at the very
  end of the run, immediately after the loop exited): `stageCount: 1,
  topBarCount: 1` — the table was still fully rendered, mid-showdown, 1,168
  hands in. No blank screen at any point this run detected.
- Screenshots taken every 5 hands (233 total) plus a final-state screenshot;
  representative copies saved alongside this report:
  - `.superpowers/investigations/blank-screen-crash-hand600-sample.png` (mid-run, hand 600)
  - `.superpowers/investigations/blank-screen-crash-final-state.png` (end of run, hand 1168)
  Both show a fully-rendered table (top bar, seats, community cards,
  settlement sheet) — no blank/green-only frame in either.

This is roughly **20-30x** the 40-60-hand target given in the task brief, and
well past the "close to 10 minutes" / "played for a while" framing from the
original bug report, at realistic (non-accelerated) AI pacing.

## A secondary anomaly worth flagging (not a crash, but suspicious)

The script's own action counter (times it saw `.action-bar` visible and
clicked something) ended the run at only **5** total, despite 1,168 hands.
The final DOM snapshot showed the human seat's "thinking" overlay reading
`655s` — i.e. a `useThinkSeconds` counter (`client/src/hooks/useThinkSeconds.js`)
that had apparently been counting up for nearly the entire session without
resetting. `useThinkSeconds` only resets its counter when `isAction` flips
from false to true (see the hook's own comment); a monotonically-growing
655s value implies `gameState.actionPlayerId === myId` stayed true (or kept
re-triggering without an intervening false) for a very long stretch.

I did not chase this further — it doesn't match the reported bug (table was
still fully rendered, no error), and it's plausible this is partly an
artifact of my own polling granularity (300ms) racing very fast hands
(~570ms/hand average) rather than a real client bug. But it's a distinct code
smell in the exact area the reported bug lives (human-idle-while-AI-acts
bookkeeping) and worth a second look by whoever picks this up next — possibly
via `client/src/components/GameTable.jsx`'s `myTurn` computation (line ~276)
or the `isAction` prop threading into `PlayerSeat`/`useThinkSeconds`.

## Static analysis (secondary angle, as requested)

Read through, looking specifically for "assumes exactly one AI opponent" or
"human idle for an extended stretch while N>1 other seats act" assumptions:

- **`client/src/components/GameTable.jsx`**: No single-opponent assumption
  found. `opponents = ordered.slice(1)` and `seatPositions(opponents.length)`
  / `twoColumnPositions(n)` are all written generically for `n` opponents
  (comments explicitly reference the "9-max, 8 opponents" ceiling). The
  action-bubble bookkeeping (`actionBubbles` state, keyed by player id — line
  ~362), the showdown-reveal delay logic, and the deal-in animation stagger
  (`dealOrder`, `dealDelayFor`) are all keyed by player id / array length,
  not a fixed 2-player assumption.
- **`server/PveSession.js`**: `buildAiSeats` (line 39) explicitly branches
  `seatCount === 2` to preserve exact legacy behavior (single AI, id
  `AI_ID`), and generalizes to N AI seats otherwise via the name pool. Dealer
  rotation was fixed in an earlier commit (`dfa6357`) specifically because
  the old `1 - dealerIndex` heads-up-only toggle broke on 4/6/8-seat tables —
  this is exactly the class of "only tested heads-up" bug the coordinator
  suspected, but it's already fixed on `main`, not a new candidate.
- **`server/index.js`'s `pveRunAiLoop`**: explicitly scales the AI "thinking"
  delay by `1/sqrt(seatCount)` (line 115) specifically because it was
  "tuned for exactly one AI opponent" and could otherwise stack up to ~a
  minute of pure waiting per hand at 8-max — another already-fixed instance
  of the same root-cause class, not a new one.
- **`server/GameEngine.js`**: `_liveOpponentCeiling`, `_buildSidePots`,
  `_determineWinners`, `_advance`/`_nextStreet` are all written generically
  over `this.players` (filter/map, no hardcoded 2-player indexing). Existing
  tests in `server/__tests__/PveSession.test.js` explicitly cover 4- and
  8-seat tables, including an all-in/showdown chip-conservation test at
  seatCount=4 and a dealer-rotation test confirming every seat gets the
  button on a 4- and 8-seat table.
- **No React error boundary anywhere in the client** (confirmed:
  `client/src/main.jsx` renders `<App/>` directly inside `<StrictMode>` with
  no `componentDidCatch`/`getDerivedStateFromError` anywhere in
  `client/src`). This is a real structural gap, independent of whether this
  specific bug reproduces: **any** uncaught exception thrown during React's
  render/commit phase, anywhere in the component tree, will unmount the
  entire app down to the bare `#root` div — which is exactly the "solid
  background color, literally nothing rendered" symptom in the user's
  screenshot. If/when this bug (or any other render-time exception) does
  reproduce, this is the mechanism that turns "component X throws" into
  "the whole screen goes blank" rather than a contained, recoverable error.
  I'd flag adding an error boundary around `<GameTable>` (or around `<App>`)
  as a good defense-in-depth fix regardless of whether the specific trigger
  here is ever pinned down — it wouldn't fix the root cause, but it would
  turn a full blank-screen crash into a visible, reportable error state.

I did not find a concrete file:line root cause for the reported bug — static
reading did not surface an unguarded array access, undefined property read,
or NaN/undefined arithmetic specific to the "human folded/idle, 2+ AI act"
path that would explain a render-time throw.

## Recommendation for whoever picks this up next

1. Given no repro at 1,168 hands / 11 real minutes at seatCount=4, consider
   trying seatCount=6 or 8 (more AI seats acting per street increases
   surface area) and/or a much longer run (30-60+ minutes) before concluding
   this is unreproducible — the original report says "played for a while,"
   which could mean substantially longer than 11 minutes.
2. Add a React error boundary regardless — it's cheap, structurally correct
   (the "Structural over patch changes" project convention), and would
   convert any future instance of this exact symptom (full blank unmount)
   into a debuggable error message with a stack trace, instead of a silent
   blank screen a user has to screenshot and describe secondhand.
3. Follow up on the `useThinkSeconds`/`655s` anomaly noted above — even if
   benign, it's in the right neighborhood (human-idle bookkeeping) to be
   worth a deliberate look rather than a passing note.

## Files referenced

- `/Users/reyes/测试 OpenStack/client/src/components/GameTable.jsx`
- `/Users/reyes/测试 OpenStack/client/src/components/PlayerSeat.jsx`
- `/Users/reyes/测试 OpenStack/client/src/hooks/useThinkSeconds.js`
- `/Users/reyes/测试 OpenStack/client/src/main.jsx`
- `/Users/reyes/测试 OpenStack/server/PveSession.js`
- `/Users/reyes/测试 OpenStack/server/GameEngine.js`
- `/Users/reyes/测试 OpenStack/server/index.js` (`pveRunAiLoop`, line ~103-125)
- `/Users/reyes/测试 OpenStack/server/pveStrategy.js`
- `/Users/reyes/测试 OpenStack/e2e/game.spec.js` (selector/pattern reference)
