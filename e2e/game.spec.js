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
  createSubmit: 'button:has-text("创建")',
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
  await page.click(S.createSubmit);
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
  await page.locator(S.startBtn).click();
  await expect(page.locator(S.gameStage)).toBeVisible({ timeout: 8000 });
}

/** 找到当前有操作栏的那一页（行动玩家），返回 [actor, other] */
async function findActor(p1, p2) {
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

    const p1Bar = await p1.locator(S.actionBar).isVisible({ timeout: 3000 }).catch(() => false);
    const p2Bar = await p2.locator(S.actionBar).isVisible({ timeout: 3000 }).catch(() => false);
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

    const p1Bar = await p1.locator(S.actionBar).isVisible({ timeout: 5000 });
    const p2Bar = await p2.locator(S.actionBar).isVisible({ timeout: 500 }).catch(() => false);
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
});

// ─── S4：游戏中途加人拒绝 ─────────────────────────────────────────────────────

test.describe('S4：游戏进行中拒绝新玩家', () => {
  test('游戏进行中第三人加入收到错误提示', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const ctx3 = await browser.newContext();
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();
    const p3 = await ctx3.newPage();

    const code = await createRoom(p1, 'Alice');
    await joinRoom(p2, 'Bob', code);
    await startGame(p1);

    // 游戏进行中，第三人尝试加入
    await p3.goto(`/room/${code}`);
    await expect(p3.locator(S.nameInput)).toBeVisible({ timeout: 5000 });
    await p3.fill(S.nameInput, 'Charlie');
    await p3.click(S.joinSubmit);

    // 应该收到错误提示（toast 或停在首页）
    const errorVisible = await p3.locator('.toast--danger').isVisible({ timeout: 5000 }).catch(() => false);
    const stillOnHome = await p3.locator(S.nameInput).isVisible({ timeout: 1000 }).catch(() => false);
    expect(errorVisible || stillOnHome).toBe(true);

    await ctx1.close();
    await ctx2.close();
    await ctx3.close();
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

// ─── S3：筹码归零与借一底 ───────────────────────────────────────────────────────

test.describe('S3：筹码归零与借一底', () => {
  test('全下分出胜负后落败方归零 → 游戏因筹码不足结束 → 借一底后可重新开始', async ({ browser }) => {
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
    const plusBtn = actor.locator('.step-btn').nth(1);
    for (let i = 0; i < 60; i++) await plusBtn.click();
    await actor.locator('.b-confirm-raise').click();
    await other.locator(S.callBtn).click();

    // 全下 → 自动摊牌
    await expect(p1.locator(S.settlement)).toBeVisible({ timeout: 10000 });
    await expect(p2.locator(S.settlement)).toBeVisible({ timeout: 10000 });

    // 结算面板不再自动关闭，双方都要点"我知道了"确认，服务端才会推进
    // （game:ready-next）。确认后落败方筹码归零、房间人数不足2人可继续 → 回到大厅。
    // 注意：.game-stage / .room-code 在 Lobby 和 GameTable 里都会用到，不能用来
    // 区分是否已回到大厅，这里用 .lobby（仅 Lobby 组件有）判断。
    await p1.getByText('我知道了').click();
    await p2.getByText('我知道了').click();
    await expect(p1.locator(S.lobby)).toBeVisible({ timeout: 15000 });
    await expect(p2.locator(S.lobby)).toBeVisible({ timeout: 15000 });

    // 找到筹码归零的一方：两页都能看到对方的 ¥0 行，但"+借一底"只出现在
    // 归零玩家自己的页面上（Lobby.jsx 里 p.id===playerId 才渲染），不能用 ¥0
    // 行数来判断是哪一页，要直接看哪一页能看到这个按钮。
    const p1HasRebuy = await p1.getByText('+借一底').isVisible().catch(() => false);
    const zeroPage = p1HasRebuy ? p1 : p2;

    const rebuyBadge = zeroPage.getByText('+借一底');
    await expect(rebuyBadge).toBeVisible({ timeout: 5000 });
    await rebuyBadge.click();

    await expect(zeroPage.locator(S.plRow).filter({ hasText: '¥1,000' })).toHaveCount(1);
    await expect(zeroPage.getByText(/借¥1,000/)).toBeVisible();

    // 借入后双方筹码都 > 0，房主可以重新开始下一局
    await p1.getByText('开始游戏').click();
    await expect(p1.locator(S.gameStage)).toBeVisible({ timeout: 8000 });
    await expect(p2.locator(S.gameStage)).toBeVisible({ timeout: 8000 });

    expect(jsErrors).toEqual([]);

    await ctx1.close();
    await ctx2.close();
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
    const plusBtn = actor.locator('.step-btn').nth(1);
    for (let i = 0; i < 60; i++) await plusBtn.click();
    await actor.locator('.b-confirm-raise').click();
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
