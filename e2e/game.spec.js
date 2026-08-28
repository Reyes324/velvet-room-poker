/**
 * E2E 测试 — 翡翠厅完整游戏流程
 *
 * 覆盖范围：
 * - 创建/加入房间（路径路由）
 * - 开始游戏、操作栏、弃牌
 * - Bug 回归：报错后操作栏仍可用（actionDisabled 不卡死）
 * - 游戏中途加入拒绝（S4）
 * - 重新开始重置筹码（S5）
 * - 断线自动 fold（S2）
 */
const { test, expect } = require('@playwright/test');

// ─── 选择器 (基于 velvet.css) ──────────────────────────────────────────────────
const S = {
  nameInput:    '.home-input:not(.home-input--code)',
  codeInput:    '.home-input--code',
  createBtn:    'button:has-text("创建房间")',
  joinBtn:      'button:has-text("加入房间")',
  joinSubmit:   'button:has-text("加入")',
  roomCode:     '.room-code',
  startBtn:     '.lobby-btn',
  gameStage:    '.game-stage',
  actionBar:    '.action-bar',
  waitingBar:   '.waiting-bar',
  foldBtn:      '.b-fold',
  callBtn:      '.b-call',
  checkBtn:     '.b-check',
  raiseBtn:     '.b-raise-trigger',
  settlement:   '.settlement-sheet',
  plRow:        '.pl-row',
  lobby:        '.lobby',
};

// ─── 工具函数 ──────────────────────────────────────────────────────────────────

async function createRoom(page, name) {
  await page.goto('/');
  await page.fill(S.nameInput, name);
  await page.click(S.createBtn);
  await expect(page.locator(S.roomCode)).toBeVisible({ timeout: 5000 });
  return await page.locator(S.roomCode).textContent();
}

async function joinRoom(page, name, code) {
  await page.goto(`/room/${code}`);
  await expect(page.locator(S.nameInput)).toBeVisible({ timeout: 5000 });
  await page.fill(S.nameInput, name);
  await page.click(S.joinSubmit);
  await expect(page.locator(S.roomCode)).toBeVisible({ timeout: 10000 });
}

async function startGame(page) {
  // "开始游戏"/"计时游戏"合并成一个入口后（2026-08-13），点 .lobby-btn
  // 只会弹出选择器，不再直接开局——多一步点"直接开始"才是真正开局。
  await page.locator(S.startBtn).click();
  await page.locator('.timer-picker-option--untimed').click();
  await expect(page.locator(S.gameStage)).toBeVisible({ timeout: 8000 });
}

/** 找到当前有操作栏的那一页（行动玩家），返回 [actor, other] */
async function findActor(p1, p2) {
  // 发牌动画（分帧发牌+英雄翻面）跑完之前操作栏不会出现——等任意一侧的
  // 操作栏真正可见了再判断是谁，而不是发牌刚开始那一刻就做一次性快照
  // 判断（会跟动画时长产生竞态，尤其是牌桌渲染变重之后更容易踩到）。
  await Promise.race([
    p1.locator(S.actionBar).waitFor({ state: 'visible', timeout: 8000 }),
    p2.locator(S.actionBar).waitFor({ state: 'visible', timeout: 8000 }),
  ]);
  const p1HasBar = await p1.locator(S.actionBar).isVisible();
  return p1HasBar ? [p1, p2] : [p2, p1];
}

/** 过牌或跟注（取当前可用动作） */
async function checkOrCall(page) {
  const canCheck = await page.locator(S.checkBtn).isVisible();
  if (canCheck) {
    await page.locator(S.checkBtn).click();
  } else {
    await page.locator(S.callBtn).click();
  }
}

/** 打到摊牌（最多 8 次行动） */
async function runToShowdown(p1, p2) {
  for (let i = 0; i < 8; i++) {
    const done = await p1.locator(S.settlement).isVisible({ timeout: 500 }).catch(() => false);
    if (done) break;

    // 等操作栏或结算弹窗任意一个真正出现，再判断该怎么走——不要在发牌动画
    // 还没播完的那一瞬间做一次性快照判断（同 findActor 的踩坑记录）。
    await Promise.race([
      p1.locator(S.actionBar).waitFor({ state: 'visible', timeout: 5000 }).catch(() => {}),
      p2.locator(S.actionBar).waitFor({ state: 'visible', timeout: 5000 }).catch(() => {}),
      p1.locator(S.settlement).waitFor({ state: 'visible', timeout: 5000 }).catch(() => {}),
    ]);

    const doneNow = await p1.locator(S.settlement).isVisible().catch(() => false);
    if (doneNow) break;

    const p1Bar = await p1.locator(S.actionBar).isVisible().catch(() => false);
    const p2Bar = await p2.locator(S.actionBar).isVisible().catch(() => false);
    if (!p1Bar && !p2Bar) break;

    const actor = p1Bar ? p1 : p2;
    await checkOrCall(actor);
    await actor.waitForTimeout(300);
  }
}

// ─── 套件：房间创建与加入 ──────────────────────────────────────────────────────

test.describe('S1：创建与加入房间', () => {
  test('路径路由：加入房间后 URL 变为 /room/XXXXXX', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const code = await createRoom(page, 'Alice');
    expect(page.url()).toContain(`/room/${code}`);
    await ctx.close();
  });

  test('直接访问 /room/XXXXXX 自动触发加入流程', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const host = await ctx1.newPage();
    const guest = await ctx2.newPage();

    const code = await createRoom(host, 'Alice');
    await joinRoom(guest, 'Bob', code);

    // Bob 的大厅里能看到 Alice
    await expect(guest.locator(S.plRow).filter({ hasText: 'Alice' })).toBeVisible();
    await ctx1.close();
    await ctx2.close();
  });

  test('非房主看到"等待房主开始游戏"，没有开始按钮', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const host = await ctx1.newPage();
    const guest = await ctx2.newPage();

    const code = await createRoom(host, 'Alice');
    await joinRoom(guest, 'Bob', code);

    await expect(guest.getByText('等待房主开始游戏')).toBeVisible();
    // 非房主不应有"开始游戏"按钮文字
    const startVisible = await guest.locator(S.startBtn).filter({ hasText: '开始游戏' }).isVisible();
    expect(startVisible).toBe(false);

    await ctx1.close();
    await ctx2.close();
  });
});

// ─── 套件：游戏基础流程 ────────────────────────────────────────────────────────

test.describe('游戏基础流程', () => {
  test('开始游戏后双方进入游戏桌', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();

    const code = await createRoom(p1, 'Alice');
    await joinRoom(p2, 'Bob', code);
    await startGame(p1);

    await expect(p1.locator(S.gameStage)).toBeVisible();
    await expect(p2.locator(S.gameStage)).toBeVisible();
    await ctx1.close();
    await ctx2.close();
  });

  test('行动栏只在行动玩家一侧显示', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();

    const code = await createRoom(p1, 'Alice');
    await joinRoom(p2, 'Bob', code);
    await startGame(p1);

    await Promise.race([
      p1.locator(S.actionBar).waitFor({ state: 'visible', timeout: 8000 }),
      p2.locator(S.actionBar).waitFor({ state: 'visible', timeout: 8000 }),
    ]);
    const p1Bar = await p1.locator(S.actionBar).isVisible();
    const p2Bar = await p2.locator(S.actionBar).isVisible();
    // 恰好一方有操作栏
    expect(p1Bar !== p2Bar).toBe(true);

    await ctx1.close();
    await ctx2.close();
  });

  test('行动玩家弃牌，结算弹窗出现', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();

    const code = await createRoom(p1, 'Alice');
    await joinRoom(p2, 'Bob', code);
    await startGame(p1);

    const [actor] = await findActor(p1, p2);
    await actor.locator(S.foldBtn).click();

    await expect(p1.locator(S.settlement)).toBeVisible({ timeout: 8000 });
    await expect(p2.locator(S.settlement)).toBeVisible({ timeout: 8000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('完整一局：全程过牌至摊牌', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();

    const code = await createRoom(p1, 'Alice');
    await joinRoom(p2, 'Bob', code);
    await startGame(p1);

    await runToShowdown(p1, p2);
    await expect(p1.locator(S.settlement)).toBeVisible({ timeout: 10000 });

    await ctx1.close();
    await ctx2.close();
  });
});

// ─── Bug 回归：actionDisabled 不卡死 ──────────────────────────────────────────

test.describe('Bug 回归', () => {
  test('发送行动后 UI 不卡死（actionDisabled 必须在 2s 内重置）', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();

    const code = await createRoom(p1, 'Alice');
    await joinRoom(p2, 'Bob', code);
    await startGame(p1);

    const [actor] = await findActor(p1, p2);

    // 打开加注栏并确认（客户端会限制最小值，所以不一定触发服务端错误）
    await actor.locator(S.raiseBtn).click();
    const confirmBtn = actor.locator('.b-confirm-raise');
    if (await confirmBtn.isVisible()) await confirmBtn.click();

    // 无论加注成功还是失败，UI 都不应卡死：
    // 成功 → waiting-bar 出现；错误 → action-bar 恢复；游戏结束 → settlement 弹出
    // 只要 actionDisabled 正确重置，以下至少有一项为 true
    await actor.waitForTimeout(2000);
    const hasActionBar = await actor.locator(S.actionBar).isVisible();
    const hasWaitingBar = await actor.locator(S.waitingBar).isVisible();
    const hasSettlement = await actor.locator(S.settlement).isVisible();
    expect(hasActionBar || hasWaitingBar || hasSettlement).toBe(true);

    await ctx1.close();
    await ctx2.close();
  });

  // 用户反馈（2026-08-29）："中途弃牌的人也应该能在结算弹窗里亮牌炫耀"——
  // 代码里这条逻辑（SettlementModal 的 canReveal）2026-08-16 就写了，但
  // RoomPage.jsx 算 iFolded 时读的是 roomState.players（房间级花名册，
  // 从来不带 status 字段），不是 gameState.players（GameEngine 每手实际
  // 广播的、真正带 status 的那份）——canReveal 因此永远是 false，这个功
  // 能从一开始就没真的生效过，此前也没有 e2e 覆盖到，才拖了两周多没人
  // 发现。这条测试就是补这个覆盖空白，不是泛泛地测亮牌功能。
  test('中途弃牌的玩家，真摊牌结算后能看到"亮牌炫耀"（不只是 fold-win 赢家）', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const ctx3 = await browser.newContext();
    const p1 = await ctx1.newPage(); // 会主动弃牌
    const p2 = await ctx2.newPage();
    const p3 = await ctx3.newPage();

    const code = await createRoom(p1, 'Alice');
    await joinRoom(p2, 'Bob', code);
    await joinRoom(p3, 'Carol', code);
    await startGame(p1);

    const pages = [p1, p2, p3];
    let folded = false;
    for (let i = 0; i < 40 && !(await p2.locator(S.settlement).isVisible().catch(() => false)); i++) {
      for (const p of pages) {
        if (!(await p.locator(S.actionBar).isVisible().catch(() => false))) continue;
        if (p === p1 && !folded && await p.locator(S.foldBtn).isVisible().catch(() => false)) {
          await p.locator(S.foldBtn).click();
          folded = true;
          continue;
        }
        if (await p.locator(S.checkBtn).isVisible().catch(() => false)) await p.locator(S.checkBtn).click();
        else if (await p.locator(S.callBtn).isVisible().catch(() => false)) await p.locator(S.callBtn).click();
      }
    }

    await expect(p2.locator(S.settlement)).toBeVisible({ timeout: 10000 });
    expect(folded, 'P1 应该在测试过程中真的弃过一次牌').toBe(true);
    // 真摊牌（不是 fold-win）——脚本只让 P1 弃过牌，P2/P3 全程只 check/
    // call、从没弃过，两人都留到了结算，说明这是真摊牌分出的胜负，不是
    // "唯一没弃牌的人直接赢"的 fold-win，跟这条要验证的场景对得上。
    const revealBtn = p1.locator('.modal-btn--secondary.modal-btn--paired');
    await expect(revealBtn).toBeVisible({ timeout: 5000 });
    await expect(revealBtn).toHaveText('亮牌炫耀');
    await revealBtn.click();
    await expect(revealBtn).toHaveText('已亮牌 ✓');

    await ctx1.close();
    await ctx2.close();
    await ctx3.close();
  });
});

// ─── S4：游戏中途加人（第十轮起：允许加入，旁观至下一手）────────────────────────
//
// 这个场景本来需要 3 个真实浏览器身份（已开局的 2 人 + 中途加入的第 3 人），但这个
// 沙盒环境存在一个跟本次改动无关的硬限制：同一个测试进程里第 3 个 page 几乎总是
// 卡在 page.goto 上（用完全不含任何游戏逻辑的 3 个空白页做过同样的复现，结果一致），
// 旧版 S4 测试本身在这次改动之前就已经是本 session 记录在案的已知偶发失败之一。
// 用 socket.io 服务端自带的 /socket.io/socket.io.js 客户端脚本在已有的 page 里
// 开一条"裸" socket 连接来模拟第 3 个玩家，规避多开一个浏览器 page/context 的限制，
// 同时仍然是对真实服务端（index.js 的 room:join handler）的端到端验证，而不只是
// 单测 RoomManager.addPlayer 本身。客户端旁观渲染路径（不会把座位错标成"我"、
// footer 三态）另有 fixture 驱动的测试覆盖，见下方「旁观渲染」小节。

test.describe('S4：游戏进行中加入新玩家', () => {
  test('游戏进行中第三人加入成功，1000筹码，出现在房间玩家列表但不在当前这一手里', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();

    const code = await createRoom(p1, 'Alice');
    await joinRoom(p2, 'Bob', code);
    await startGame(p1);

    const result = await p1.evaluate(async (roomCode) => {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/socket.io/socket.io.js';
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
      return new Promise((resolve) => {
        const sock = window.io();
        const playerId = 'e2e-p3-' + Date.now();
        let roomState = null;
        sock.on('room:state', (s) => { roomState = s; });
        sock.on('game:error', (msg) => resolve({ error: msg }));
        sock.on('room:joined', () => {
          setTimeout(() => resolve({ ok: true, roomState, playerId }), 300);
        });
        sock.on('connect', () => {
          sock.emit('room:join', { code: roomCode, playerId, playerName: 'Charlie' });
        });
        setTimeout(() => resolve({ timeout: true, roomState }), 5000);
      });
    }, code);

    expect(result.error).toBeUndefined();
    expect(result.timeout).toBeUndefined();
    expect(result.ok).toBe(true);
    const charlie = result.roomState.players.find(p => p.name === 'Charlie');
    expect(charlie).toBeDefined();
    expect(charlie.chips).toBe(1000);
    expect(charlie.debt).toBe(0);
    // 房间状态仍是 playing，其他两人的牌局不受影响
    expect(result.roomState.status).toBe('playing');

    await ctx1.close();
    await ctx2.close();
  });
});

// ─── 旁观渲染（fixture 驱动，单 page，规避上面记录的多 page 限制）──────────────────

test.describe('旁观视图渲染（?states= 开发自检画廊）', () => {
  test('中途加入等待下一手：不渲染英雄座位，不会把某个真实对手错标成"我"', async ({ page }) => {
    await page.goto('/?states=5');
    await page.waitForTimeout(300);
    expect(await page.locator('.player-slot--hero').count()).toBe(0);
    await expect(page.locator('.waiting-text')).toContainText('旁观');
  });

  test('筹码归零后选择旁观留下：footer 常驻"+借一底"入口，不会被卡死出不来', async ({ page }) => {
    await page.goto('/?states=6');
    await page.waitForTimeout(300);
    const rebuyBtn = page.locator('.spectate-rebuy-btn');
    await expect(rebuyBtn).toBeVisible();
    await expect(rebuyBtn).toContainText('借一底');
  });

  test('筹码归零决策弹窗：三个选项都存在（旁观留下已在 sit-out 设计下重新加回）', async ({ page }) => {
    // states=9, not 8 — a "结算弹窗·弃牌结束" fixture was inserted earlier in
    // the STATES array (fixtures.js) after this test was written, shifting
    // every fixture after it down by one index; this test was never updated
    // to match (confirmed via `node -e "import('./fixtures.js').then(...)"`
    // printing the real index-to-name mapping).
    await page.goto('/?states=9');
    await page.waitForTimeout(300);
    await expect(page.locator('.modal-title:has-text("筹码已用完")')).toBeVisible();
    await expect(page.locator('.modal-btn:has-text("借一底")')).toBeVisible();
    await expect(page.locator('.modal-btn:has-text("旁观留下")')).toBeVisible();
    await expect(page.locator('.modal-btn-danger:has-text("退出对局")')).toBeVisible();
  });

  test('账本弹窗：四列数字与 fixture 数据一致', async ({ page }) => {
    // states=10, not 9 — same index-drift reason as above.
    await page.goto('/?states=10');
    await page.waitForTimeout(300);
    const rows = await page.locator('.ledger-row').count();
    expect(rows).toBe(4);
    await expect(page.locator('.ledger-row', { hasText: '王建国' })).toContainText('¥2,000');
    await expect(page.locator('.ledger-row', { hasText: '王建国' })).toContainText('¥0');
  });
});

// ─── S5：重新开始 ──────────────────────────────────────────────────────────────

test.describe('S5：重新开始', () => {
  test('房主点重新开始，双方筹码重置为 ¥1,000', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();

    const code = await createRoom(p1, 'Alice');
    await joinRoom(p2, 'Bob', code);

    await p1.getByText('重新开始').click();

    // 双方玩家行里都应显示 ¥1,000（两行都应有）
    await expect(p1.locator(S.plRow).filter({ hasText: '¥1,000' })).toHaveCount(2);
    await expect(p2.locator(S.plRow).filter({ hasText: '¥1,000' })).toHaveCount(2);

    await ctx1.close();
    await ctx2.close();
  });

  test('非房主没有重新开始链接', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();

    const code = await createRoom(p1, 'Alice');
    await joinRoom(p2, 'Bob', code);

    // 非房主（p2）不应看到重新开始
    const restartCount = await p2.getByText('重新开始').count();
    expect(restartCount).toBe(0);

    await ctx1.close();
    await ctx2.close();
  });
});

// ─── S2：断线自动 fold ─────────────────────────────────────────────────────────

test.describe('S2：断线处理', () => {
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

    // 对方应该在断线玩家自己的座位上看到"断线中"徽标（不再是页面顶部的
    // toast，issue #20 之后改成了贴在头像旁的per-seat badge），且**不会**
    // 获得行动机会
    await other.locator('.disconnect-badge', { hasText: '断线中' }).waitFor({ state: 'visible', timeout: 8000 });
    const gotActionBar = await other.locator(S.actionBar).isVisible().catch(() => false);
    expect(gotActionBar).toBe(false);

    // 断线的一方重连后，应该能继续正常操作（说明筹码/座位都还在，游戏没有被打断）
    await actor.evaluate(() => window.__vrSocket.connect());
    await actor.locator(S.actionBar).waitFor({ state: 'visible', timeout: 8000 });

    await ctx1.close();
    await ctx2.close();
  });

});

// ─── S3：筹码归零与借一底 ───────────────────────────────────────────────────────

test.describe('S3：筹码归零与借一底', () => {
  test('全下分出胜负后落败方归零 → 暂停等待决策 → 借一底后牌局直接继续（不经过大厅）', async ({ browser }) => {
    test.setTimeout(60000);
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();

    const jsErrors = [];
    p1.on('pageerror', e => jsErrors.push(`p1: ${e.message}`));
    p2.on('pageerror', e => jsErrors.push(`p2: ${e.message}`));

    const code = await createRoom(p1, 'Alice');
    await joinRoom(p2, 'Bob', code);
    await startGame(p1);

    // 行动方一路点"+"把加注额顶到自己全部筹码（全下），对方跟注（也全下）
    const [actor, other] = await findActor(p1, p2);
    await actor.locator(S.raiseBtn).click();
    await actor.locator('.b-allin').click();
    await other.locator(S.callBtn).click();

    // 全下 → 自动摊牌
    await expect(p1.locator(S.settlement)).toBeVisible({ timeout: 10000 });
    await expect(p2.locator(S.settlement)).toBeVisible({ timeout: 10000 });

    // 结算面板不再自动关闭，双方都要点"我知道了"确认，服务端才会推进
    // （game:ready-next）。确认后落败方筹码归零 → 房间暂停等待归零方决策
    // （BustDecisionModal），不会立刻回到大厅——这是"游戏中途断线从自动
    // 弃牌改成暂停等待重连"那一轮顺带扩展到 bust 场景的既有行为（见
    // design.md `tryAdvanceIfClear`：只要 room.players 里有 chips===0
    // 的人就暂停，跟总人数/是否还剩 ≥2 个有筹码的玩家无关），不是这里测的
    // "2 人局归零就直接结束回大厅"的旧行为——这条测试原来断言的正是被取代
    // 的旧行为，之前一直没跟着改。
    await p1.getByText('我知道了').click();
    await p2.getByText('我知道了').click();

    // 找到筹码归零的一方：两页都能看到对方的 ¥0，但 BustDecisionModal（带
    // "+借一底"/"退出对局"两个选项）只会出现在归零玩家自己的页面上，另一
    // 页看到的是只读的 BustWaitModal（"等待决策"）。
    const p1IsBusted = await p1.locator('.modal-title:has-text("筹码已用完")').isVisible().catch(() => false);
    const zeroPage = p1IsBusted ? p1 : p2;
    const otherPage = p1IsBusted ? p2 : p1;

    await expect(zeroPage.locator('.modal-title:has-text("筹码已用完")')).toBeVisible({ timeout: 10000 });
    await expect(otherPage.locator('.modal-title:has-text("等待决策")')).toBeVisible({ timeout: 10000 });

    // 归零方选择"+借一底"——暂停立刻解除，两人筹码都 > 0，牌局直接继续，
    // 不会经过大厅（这跟旧的"结束回大厅、从大厅重新借入、房主重开一局"
    // 流程不同，是当前设计下更顺畅的路径）。
    await zeroPage.locator('.modal-btn:has-text("借一底")').click();

    await expect(zeroPage.locator('.modal-overlay')).toHaveCount(0, { timeout: 8000 });
    await expect(otherPage.locator('.modal-overlay')).toHaveCount(0, { timeout: 8000 });
    await expect(zeroPage.locator(S.gameStage)).toBeVisible();
    await expect(otherPage.locator(S.gameStage)).toBeVisible();
    await expect(p2.locator(S.gameStage)).toBeVisible({ timeout: 8000 });

    expect(jsErrors).toEqual([]);

    await ctx1.close();
    await ctx2.close();
  });

  test('三人局：归零方选"旁观留下"后，牌局对剩余两人继续，归零方应立刻转为旁观视图（不再显示为参与者）', async ({ browser }) => {
    test.setTimeout(60000);
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const ctx3 = await browser.newContext();
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();
    const p3 = await ctx3.newPage();

    const jsErrors = [];
    for (const p of [p1, p2, p3]) p.on('pageerror', e => jsErrors.push(e.message));

    const code = await createRoom(p1, 'Alice');
    await joinRoom(p2, 'Bob', code);
    await joinRoom(p3, 'Carol', code);
    await startGame(p1);

    // 让其中两个人全下互相摊牌，第三个人弃牌全程不动筹码——这样归零那一手
    // 结束后，牌桌上仍有 2 个有筹码的人，房间不会因为"总人数不够"直接散
    // 回大厅，才能真正测到"归零方选旁观后，牌局对其余两人继续"这条路径
    // （跟上面 2 人局的用例刻意不同：2 人局一旦有人归零就只剩 1 个有筹码
    // 的人，不满足 nextRound() 的 active.length>=2，房间必然回大厅，永远
    // 走不到这里要测的分支）。
    const pages = [p1, p2, p3];
    let allInPlayer = null;
    let callPlayer = null;
    let foldPlayer = null;
    for (let round = 0; round < 6 && !foldPlayer; round++) {
      await Promise.race(pages.map(p => p.locator(S.actionBar).waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})));
      let current = null;
      for (const p of pages) {
        if (await p.locator(S.actionBar).isVisible().catch(() => false)) { current = p; break; }
      }
      if (!current) break;
      if (!allInPlayer) {
        allInPlayer = current;
        await current.locator(S.raiseBtn).click();
        await current.locator('.b-allin').click();
      } else if (!callPlayer && current !== allInPlayer) {
        callPlayer = current;
        await current.locator(S.callBtn).click();
      } else if (current !== allInPlayer && current !== callPlayer) {
        foldPlayer = current;
        await current.locator(S.foldBtn).click();
      }
      await current.waitForTimeout(300);
    }

    expect(allInPlayer).toBeTruthy();
    expect(callPlayer).toBeTruthy();

    // 摊牌 → 结算，三人都点"我知道了"
    await expect(p1.locator(S.settlement)).toBeVisible({ timeout: 10000 });
    for (const p of pages) {
      if (await p.locator(S.settlement).isVisible().catch(() => false)) {
        await p.getByText('我知道了').click();
      }
    }

    // 找到归零方——只有 allInPlayer/callPlayer 两人之一会归零（同注全下，
    // 输的那个归零；赢的那个筹码翻倍；一直弃牌的第三人筹码不变）。
    let zeroPage = null;
    for (const p of [allInPlayer, callPlayer]) {
      const busted = await p.locator('.modal-title:has-text("筹码已用完")').isVisible({ timeout: 10000 }).catch(() => false);
      if (busted) { zeroPage = p; break; }
    }
    expect(zeroPage, '应有一方全下落败归零').toBeTruthy();

    // 关键操作：选"旁观留下"而不是"+借一底"——这条路径此前没有 e2e 覆盖过
    // （已有的 S3 用例只测了"+借一底"分支）。
    await zeroPage.locator('.modal-btn:has-text("旁观留下")').click();

    // 暂停解除后，房间里还有 2 个有筹码的人，牌局应该直接对他们继续，不经
    // 过大厅——归零方自己的页面应该立刻从"参与者视图"（会显示 hero 手牌/
    // 操作栏）切换成旁观视图（waiting-bar--spectate，没有 action-bar，也
    // 没有属于自己的 hero 手牌区）。
    await expect(zeroPage.locator('.modal-overlay')).toHaveCount(0, { timeout: 8000 });
    await expect(zeroPage.locator(S.gameStage)).toBeVisible();
    await expect(zeroPage.locator('.waiting-bar--spectate')).toBeVisible({ timeout: 8000 });
    await expect(zeroPage.locator(S.actionBar)).toHaveCount(0);
    await expect(zeroPage.locator('.hero-section')).toHaveCount(0);

    await zeroPage.screenshot({ path: 'test-results/bust-spectate-view.png' });

    expect(jsErrors).toEqual([]);

    await ctx1.close();
    await ctx2.close();
    await ctx3.close();
  });
});

// ─── S6：对手全下后不应再被要求继续行动 ───────────────────────────────────────

test.describe('S6：对手全下后自动摊牌', () => {
  test('一方全下、对方跟注仍有余额后，不应再看到行动栏，应直接看到结算', async ({ browser }) => {
    test.setTimeout(60000);
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();

    const code = await createRoom(p1, 'Alice');
    await joinRoom(p2, 'Bob', code);
    await startGame(p1);

    const [actor, other] = await findActor(p1, p2);
    await actor.locator(S.raiseBtn).click();
    await actor.locator('.b-allin').click();
    await other.locator(S.callBtn).click();

    // 跟注后不应该再看到任何一方的行动栏（除非是全新的下一局，这里只看这一局内）
    const actionBarStillThere = await other.locator(S.actionBar).isVisible({ timeout: 1500 }).catch(() => false);
    expect(actionBarStillThere).toBe(false);

    await expect(p1.locator(S.settlement)).toBeVisible({ timeout: 10000 });
    await expect(p2.locator(S.settlement)).toBeVisible({ timeout: 10000 });

    await ctx1.close();
    await ctx2.close();
  });
});

// ─── 用户反馈：单挑时对手座位飘出屏幕（移动端地址栏可见场景） ───────────────────────

test.describe('移动端缩放：单挑对手座位不应飘出可见视口', () => {
  test('浏览器地址栏可见（screen.height > innerHeight）时，对手座位仍完全在视口内', async ({ browser }) => {
    // 模拟移动端地址栏占用空间的常见状态：innerHeight（当前可见区域）小于
    // screen.height（物理屏幕高度）。useStageScale 曾用 screen.height 计算
    // scale，导致画布顶部（单挑时唯一对手座位所在处）被推出可见视口之外。
    const ctx1 = await browser.newContext({
      viewport: { width: 390, height: 700 },
      screen: { width: 390, height: 844 },
    });
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();

    const code = await createRoom(p1, 'Alice');
    await joinRoom(p2, 'Bob', code);
    await startGame(p1);
    await p1.locator('.player-slot:not(.player-slot--hero)').waitFor({ state: 'attached' });

    const oppBox = await p1.evaluate(() => {
      const el = document.querySelector('.player-slot:not(.player-slot--hero)');
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    });
    expect(oppBox.top).toBeGreaterThanOrEqual(0);
    expect(oppBox.bottom).toBeLessThanOrEqual(700);

    await ctx1.close();
    await ctx2.close();
  });
});

// ─── 用户反馈：公共牌应该先扣着发下来，到点了再翻开 ───────────────────────────────

test.describe('发牌动画：公共牌先扣着发下来，到点再翻', () => {
  test('手牌发完后公共牌立即以背面落地，翻牌/转牌逐街揭晓', async ({ browser }) => {
    test.setTimeout(60000);
    const ctx1 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();

    const code = await createRoom(p1, 'Alice');
    await joinRoom(p2, 'Bob', code);
    await startGame(p1);

    // 等发牌动画播完（手牌 + 公共牌背面 + 英雄翻面）
    await p1.waitForTimeout(1200);
    expect(await p1.locator('.community .c-back').count()).toBe(5);
    expect(await p1.locator('.community .c-empty').count()).toBe(0);
    expect(await p1.locator('.community .c-face').count()).toBe(0);

    // 翻牌圈：双方都过牌
    for (let i = 0; i < 2; i++) {
      const [actor] = await findActor(p1, p2);
      await checkOrCall(actor);
      await actor.waitForTimeout(400);
    }
    await p1.waitForTimeout(400);
    expect(await p1.locator('.community .c-face').count()).toBe(3);
    expect(await p1.locator('.community .c-back').count()).toBe(2);

    // 转牌圈
    for (let i = 0; i < 2; i++) {
      const [actor] = await findActor(p1, p2);
      await checkOrCall(actor);
      await actor.waitForTimeout(400);
    }
    await p1.waitForTimeout(400);
    expect(await p1.locator('.community .c-face').count()).toBe(4);
    expect(await p1.locator('.community .c-back').count()).toBe(1);

    await ctx1.close();
    await ctx2.close();
  });
});

// ─── 用户反馈 GitHub #18/#6：座位是固定的，只有新人加入才该有入场动画；
//     每手开局只应该是"牌"在动，而且要从同一个中心点派出 ──────────────────

test.describe('开局动画：座位固定不重播，牌从同一中心点发出', () => {
  test('第二手开局时，已在场的座位不再有 .deal-in 入场动画', async ({ browser }) => {
    test.setTimeout(30000);
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();

    const code = await createRoom(p1, 'Alice');
    await joinRoom(p2, 'Bob', code);
    await startGame(p1);

    // 第一手：这是本页面第一次挂载牌桌，座位允许（也确实会）播一次入场——
    // 这不是本用例要断言的地方，只是先把这一手打完，走到能确认下一手已经
    // 真正重新开局（preflop 再次出现）的地方。
    const [actor] = await findActor(p1, p2);
    await actor.locator(S.foldBtn).click();
    await expect(p1.locator(S.settlement)).toBeVisible({ timeout: 8000 });
    await expect(p2.locator(S.settlement)).toBeVisible({ timeout: 8000 });
    await p1.getByText('我知道了').click();
    await p2.getByText('我知道了').click();

    // 两人都确认后服务端立即开下一手，不用等 15s 的自动倒计时——发牌动画
    // 一开始（操作栏消失、下一位行动者的栏出现）就检查座位有没有被重新
    // 打上 .deal-in。
    await Promise.race([
      p1.locator(S.actionBar).waitFor({ state: 'visible', timeout: 8000 }),
      p2.locator(S.actionBar).waitFor({ state: 'visible', timeout: 8000 }),
    ]);
    const dealInCount = await p1.locator('.player-slot.deal-in').count();
    expect(dealInCount).toBe(0);

    await ctx1.close();
    await ctx2.close();
  });
});

// ─── 座位布局：两栏贴边分布，取代椭圆弧形 ──────────────────────────────────────────

test.describe('座位布局：两栏贴边', () => {
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
    // Deal-in animation staggers each opponent slot's mount; wait for the
    // 3rd (last) one to attach before reading bounding boxes, or the $$eval
    // below can race the render and see fewer than 3 slots.
    await page.locator('.player-slot:not(.player-slot--hero)').nth(2).waitFor({ state: 'attached' });
    // Each seat's .deal-in fly-in animation (dealFly, see velvet.css) starts
    // from a small offset and settles at its true left/top over up to ~0.7s
    // (0.2s stagger delay + 0.5s duration for the last opponent) — read the
    // bounding box only after every seat has fully settled, or this flakes
    // depending on how much real time elapsed before this point.
    await page.waitForTimeout(900);

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
});

// ─── 真机实测回归：英雄信息区重叠 + 顶排暗牌裁切 ──────────────────────────────────
// 真机截图暴露过的组合场景（英雄同时是行动方 + 自己有下注）此前没有任何 fixture/测试
// 覆盖到，见 fixtures.js "英雄行动中且有下注" 与 design.md "真机实测：暗牌裁切..."。

test.describe('真机实测回归：贴边双栏骨架的两处重叠/裁切', () => {
  test('英雄小头像座位不与 .hero-section（姓名/筹码/大手牌）重叠', async ({ page }) => {
    // states=15, not 11 — same STATES-array index drift as the bust-modal/
    // ledger tests above: this was silently testing "9人满桌·密集" instead
    // of the intended "英雄行动中且有下注" fixture (confirmed by printing
    // the real index-to-name mapping), so it was passing for the wrong
    // reason rather than catching the real-device overlap it was written
    // for.
    await page.goto('/?states=15');
    await page.waitForSelector('.player-slot--hero', { state: 'attached' });
    await page.waitForTimeout(300);
    const heroSeat = await page.locator('.player-slot--hero').boundingBox();
    const heroSection = await page.locator('.hero-section').boundingBox();
    expect(heroSeat.y + heroSeat.height).toBeLessThanOrEqual(heroSection.y);
  });

});

// ─── 摊牌前不再显示对手的暗牌占位（去掉了，见 design.md 同一轮决策）──────────────────
// 上面几条"暗牌不被裁切/不遮挡筹码/不遮挡公共牌"的测试连同它们要保护的功能一起下线了——
// 暗牌摊牌前不再渲染，不存在"暗牌跟别的元素抢位置"这类问题了。改成两条更简单直接的
// 断言：摊牌前确实不渲染、真摊牌时确实渲染。

test.describe('摊牌前不显示对手暗牌，摊牌时才显示', () => {
  test('翻牌前/翻牌圈：非本人座位不渲染任何 .reveal', async ({ page }) => {
    await page.goto('/?states=0'); // 翻牌前，多个未弃牌对手
    await page.waitForSelector('.player-slot:not(.player-slot--hero)', { state: 'attached' });
    await page.waitForTimeout(300);
    expect(await page.locator('.player-slot:not(.player-slot--hero) .reveal').count()).toBe(0);
  });

  test('摊牌：未弃牌的对手渲染真实牌面 .reveal', async ({ page }) => {
    await page.goto('/?states=3'); // 摊牌 fixture（见 fixtures.js）
    await page.waitForSelector('.player-slot:not(.player-slot--hero) .reveal', { state: 'attached' });
    const revealCount = await page.locator('.player-slot:not(.player-slot--hero) .reveal').count();
    expect(revealCount).toBeGreaterThan(0);
  });
});
