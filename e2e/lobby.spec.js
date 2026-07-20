const { test, expect } = require('@playwright/test');

test.describe('大厅流程', () => {
  test('首页正确加载', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.home-logo')).toHaveText('翡翠厅');
    await expect(page.locator('button:has-text("创建房间")')).toBeVisible();
    await expect(page.locator('button:has-text("加入房间")')).toBeVisible();
  });

  test('创建房间后进入大厅，显示6位房间码', async ({ page }) => {
    await page.goto('/');
    await page.fill('.home-input', 'Alice');
    await page.click('button:has-text("创建房间")');
    await page.click('button:has-text("创建")');

    await expect(page.locator('.room-code')).toBeVisible();
    const code = await page.locator('.room-code').textContent();
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
  });

  test('两个玩家通过房间码加入同一房间', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();

    // Player 1 创建房间
    await p1.goto('/');
    await p1.fill('.home-input', 'Alice');
    await p1.click('button:has-text("创建房间")');
    await p1.click('button:has-text("创建")');
    await expect(p1.locator('.room-code')).toBeVisible();
    const code = await p1.locator('.room-code').textContent();

    // Player 2 加入
    await p2.goto('/');
    await p2.fill('.home-input', 'Bob');
    await p2.click('button:has-text("加入房间")');
    await p2.fill('.home-input--code', code);
    await p2.click('button:has-text("加入")');

    // 双方大厅里都能看到对方
    await expect(p1.locator('.pl-row').filter({ hasText: 'Bob' })).toBeVisible();
    await expect(p2.locator('.pl-row').filter({ hasText: 'Alice' })).toBeVisible();

    await ctx1.close();
    await ctx2.close();
  });

  test('加入不存在的房间显示错误提示', async ({ page }) => {
    await page.goto('/');
    await page.fill('.home-input', 'Alice');
    await page.click('button:has-text("加入房间")');
    await page.fill('.home-input--code', 'XXXXXX');
    await page.click('button:has-text("加入")');

    await expect(page.locator('.home-error')).toContainText('房间不存在');
  });

  test('邀请链接自动填入房间码并切换到加入模式', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();

    // 创建房间，获取邀请链接
    await p1.goto('/');
    await p1.fill('.home-input', 'Alice');
    await p1.click('button:has-text("创建房间")');
    await p1.click('button:has-text("创建")');
    await expect(p1.locator('.room-code')).toBeVisible();
    const code = await p1.locator('.room-code').textContent();

    // 用邀请链接打开（新版路由用 /room/CODE 格式）
    await p2.goto(`/room/${code}`);
    await expect(p2.locator('.home-input--code')).toHaveValue(code);

    await ctx1.close();
    await ctx2.close();
  });
});

test.describe('冷启动会话恢复（切 App 被系统回收标签页 → 整页重载）', () => {
  // page.reload() 是这个 bug 场景的真实模型：localStorage 保留，但 React
  // state（包括 App.jsx 的 room state）从零开始——跟系统回收后台标签页、
  // 用户切回来时拿到一个全新页面加载是同一回事。跟"标签页不刷新、只是
  // socket 断了又连上"（第七轮已覆盖）是两条不同的路径。
  test('房主整页刷新后仍是房主，直接回到大厅（不经过加入表单）', async ({ page }) => {
    await page.goto('/');
    await page.fill('.home-input', 'Alice');
    await page.click('button:has-text("创建房间")');
    await page.click('button:has-text("创建")');
    await expect(page.locator('.room-code')).toBeVisible();
    const code = await page.locator('.room-code').textContent();

    await page.reload();

    // 直接落回大厅，不应该看到加入表单
    await expect(page.locator('.home-card')).toHaveCount(0);
    await expect(page.locator('.room-code')).toHaveText(code);
    // 房主身份保留：能看到"开始游戏/等待更多玩家…"这个只有房主才有的按钮
    await expect(page.locator('.lobby-btn')).toBeVisible();
    await expect(page.locator('.lobby-restart')).toHaveText('重新开始');
  });

  test('非房主玩家整页刷新后仍在房间里，不会被当成新访客', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();

    await p1.goto('/');
    await p1.fill('.home-input', 'Alice');
    await p1.click('button:has-text("创建房间")');
    await p1.click('button:has-text("创建")');
    await expect(p1.locator('.room-code')).toBeVisible();
    const code = await p1.locator('.room-code').textContent();

    await p2.goto('/');
    await p2.fill('.home-input', 'Bob');
    await p2.click('button:has-text("加入房间")');
    await p2.fill('.home-input--code', code);
    await p2.click('button:has-text("加入")');
    // 必须等 Bob 自己这一端也确认进了大厅（room:joined 落地、localStorage
    // 写完）才能 reload——只看 p1 广播里出现了 Bob 不能保证这一点，两者是
    // 两条独立的网络消息，谁先到没有顺序保证。
    await expect(p2.locator('.room-code')).toBeVisible();
    await expect(p1.locator('.pl-row').filter({ hasText: 'Bob' })).toBeVisible();

    await p2.reload();

    // Bob 直接回到同一个大厅，不是加入表单；房间里仍然只有一个 Bob（没有
    // 被当成新玩家重复加入、筹码也没被重置成一个新的条目）
    await expect(p2.locator('.home-card')).toHaveCount(0);
    await expect(p2.locator('.room-code')).toHaveText(code);
    await expect(p2.locator('.pl-row').filter({ hasText: 'Bob' })).toHaveCount(1);
    await expect(p1.locator('.pl-row').filter({ hasText: 'Bob' })).toHaveCount(1);
    // Bob 不是房主，看到的是"等待房主开始游戏…"而不是开始/重新开始按钮
    await expect(p2.locator('.lobby-restart')).toHaveText('等待房主开始游戏…');

    await ctx1.close();
    await ctx2.close();
  });

  test('被踢出后本地会话被清除，刷新不会试图恢复到已经不在的房间', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();

    await p1.goto('/');
    await p1.fill('.home-input', 'Alice');
    await p1.click('button:has-text("创建房间")');
    await p1.click('button:has-text("创建")');
    const code = await p1.locator('.room-code').textContent();

    await p2.goto('/');
    await p2.fill('.home-input', 'Bob');
    await p2.click('button:has-text("加入房间")');
    await p2.fill('.home-input--code', code);
    await p2.click('button:has-text("加入")');
    await expect(p2.locator('.room-code')).toBeVisible();
    await expect(p1.locator('.pl-row').filter({ hasText: 'Bob' })).toBeVisible();

    // 房主把 Bob 踢出去
    await p1.locator('.pr-badge', { hasText: '移出' }).click();
    await expect(p2.locator('.toast--danger')).toContainText('移出');

    // room:kicked 会在 2 秒后自动 onLeave() → 回首页；给它跑完
    await p2.waitForTimeout(2500);
    await expect(p2.locator('.home-card')).toBeVisible();

    // 刷新：不应该再尝试恢复到已经被踢出的房间，应该停留在首页/加入表单
    await p2.reload();
    await expect(p2.locator('.home-card')).toBeVisible();
    await expect(p2.locator('.room-code')).toHaveCount(0);

    await ctx1.close();
    await ctx2.close();
  });

  test('持有另一个房间的旧会话时，打开新邀请链接应走加入表单，不会被误判为恢复旧房间', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();

    // 房间 A：Alice 建房，Carol 加入并留下一份本地会话
    await p1.goto('/');
    await p1.fill('.home-input', 'Alice');
    await p1.click('button:has-text("创建房间")');
    await p1.click('button:has-text("创建")');
    const codeA = await p1.locator('.room-code').textContent();

    await p2.goto('/');
    await p2.fill('.home-input', 'Carol');
    await p2.click('button:has-text("加入房间")');
    await p2.fill('.home-input--code', codeA);
    await p2.click('button:has-text("加入")');
    await expect(p2.locator('.room-code')).toHaveText(codeA);

    // 房间 B：另一个房主建的新房间
    const ctx3 = await browser.newContext();
    const p3 = await ctx3.newPage();
    await p3.goto('/');
    await p3.fill('.home-input', 'Dave');
    await p3.click('button:has-text("创建房间")');
    await p3.click('button:has-text("创建")');
    const codeB = await p3.locator('.room-code').textContent();

    // Carol（本地存的是房间 A 的会话）现在点开房间 B 的邀请链接
    await p2.goto(`/room/${codeB}`);

    // 应该走人工加入表单（预填房间 B 的房间码），而不是被当成"恢复房间 A"
    await expect(p2.locator('.home-input--code')).toHaveValue(codeB);
    await expect(p2.locator('.room-code')).toHaveCount(0);

    await ctx1.close();
    await ctx2.close();
    await ctx3.close();
  });
});
