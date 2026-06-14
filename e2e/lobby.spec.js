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
