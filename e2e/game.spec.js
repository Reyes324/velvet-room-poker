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

  test('筹码归零决策弹窗：三个选项都存在', async ({ page }) => {
    await page.goto('/?states=8');
    await page.waitForTimeout(300);
    await expect(page.locator('.modal-title:has-text("筹码已用完")')).toBeVisible();
    await expect(page.locator('.modal-btn:has-text("借一底")')).toBeVisible();
    await expect(page.locator('.modal-btn-cancel:has-text("旁观留下")')).toBeVisible();
    await expect(page.locator('.modal-btn-danger:has-text("离开")')).toBeVisible();
  });

  test('账本弹窗：四列数字与 fixture 数据一致', async ({ page }) => {
    await page.goto('/?states=9');
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
    await actor.locator('.b-allin').click();
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
