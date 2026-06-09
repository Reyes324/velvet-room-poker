const { test, expect } = require('@playwright/test');

async function setupTwoPlayers(browser) {
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const p1 = await ctx1.newPage();
  const p2 = await ctx2.newPage();

  await p1.goto('/');
  await p1.fill('.home-input', 'Alice');
  await p1.click('button:has-text("创建房间")');
  await p1.click('button:has-text("创建")');
  await expect(p1.locator('.lobby-code')).toBeVisible();
  const code = await p1.locator('.lobby-code').textContent();

  await p2.goto('/');
  await p2.fill('.home-input', 'Bob');
  await p2.click('button:has-text("加入房间")');
  await p2.fill('.home-input--code', code);
  await p2.click('button:has-text("加入")');
  await expect(p2.locator('.lobby-players')).toContainText('Alice');

  return { p1, p2, ctx1, ctx2, code };
}

test.describe('游戏流程', () => {
  test('非房主点击开始游戏无效', async ({ browser }) => {
    const { p1, p2, ctx1, ctx2 } = await setupTwoPlayers(browser);

    // p2 不是房主，开始按钮不存在（只有等待文字）
    await expect(p2.locator('.waiting-text')).toBeVisible();
    await expect(p2.locator('.start-btn')).not.toBeVisible();

    await ctx1.close();
    await ctx2.close();
  });

  test('房主开始游戏，双方进入翻牌前状态', async ({ browser }) => {
    const { p1, p2, ctx1, ctx2 } = await setupTwoPlayers(browser);

    await p1.click('.start-btn');

    // 双方都进入牌桌视图
    await expect(p1.locator('.table-view')).toBeVisible();
    await expect(p2.locator('.table-view')).toBeVisible();

    // 阶段显示"翻牌前"
    await expect(p1.locator('.table-phase')).toHaveText('翻牌前');
    await expect(p2.locator('.table-phase')).toHaveText('翻牌前');

    await ctx1.close();
    await ctx2.close();
  });

  test('只有行动玩家能看到操作栏', async ({ browser }) => {
    const { p1, p2, ctx1, ctx2 } = await setupTwoPlayers(browser);

    await p1.click('.start-btn');
    await expect(p1.locator('.table-view')).toBeVisible();
    await expect(p2.locator('.table-view')).toBeVisible();

    // 恰好一方有 action bar，另一方没有
    const p1HasBar = await p1.locator('.action-bar').isVisible();
    const p2HasBar = await p2.locator('.action-bar').isVisible();
    expect(p1HasBar !== p2HasBar).toBe(true); // XOR: 恰好一方

    await ctx1.close();
    await ctx2.close();
  });

  test('行动玩家弃牌，对方赢得底池', async ({ browser }) => {
    const { p1, p2, ctx1, ctx2 } = await setupTwoPlayers(browser);

    await p1.click('.start-btn');
    await expect(p1.locator('.table-view')).toBeVisible();

    // 找到有操作栏的那一页
    const p1HasBar = await p1.locator('.action-bar').isVisible();
    const actor = p1HasBar ? p1 : p2;

    // 弃牌
    await actor.click('button:has-text("弃牌")');

    // 摊牌结果显示
    await expect(p1.locator('.showdown-overlay')).toBeVisible({ timeout: 8000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('大厅中房主看到重新开始按钮，非房主看不到', async ({ browser }) => {
    const { p1, p2, ctx1, ctx2 } = await setupTwoPlayers(browser);

    // 大厅里房主有"重新开始"按钮，非房主没有
    await expect(p1.locator('button:has-text("重新开始")')).toBeVisible();
    await expect(p2.locator('button:has-text("重新开始")')).not.toBeVisible();

    await ctx1.close();
    await ctx2.close();
  });

  test('点击重新开始后所有玩家筹码重置为 $10,000', async ({ browser }) => {
    const { p1, p2, ctx1, ctx2 } = await setupTwoPlayers(browser);

    await p1.click('button:has-text("重新开始")');

    // 双方都收到更新，筹码显示 $10,000
    await expect(p1.locator('.lobby-players')).toContainText('$10,000');
    await expect(p2.locator('.lobby-players')).toContainText('$10,000');

    await ctx1.close();
    await ctx2.close();
  });

  test('完整一局：跟注→翻牌→转牌→河牌→摊牌', async ({ browser }) => {
    const { p1, p2, ctx1, ctx2 } = await setupTwoPlayers(browser);

    await p1.click('.start-btn');
    await expect(p1.locator('.table-view')).toBeVisible();

    // 打完一局（每轮都跟注或过牌，直到摊牌）
    for (let street = 0; street < 4; street++) {
      // 第一个行动者
      const p1Bar = await p1.locator('.action-bar').isVisible();
      const actor = p1Bar ? p1 : p2;
      const other = p1Bar ? p2 : p1;

      const toCall = await actor.locator('button:has-text("跟注")').isVisible();
      if (toCall) {
        await actor.click('button:has-text("跟注")');
      } else {
        await actor.click('button:has-text("过牌")');
      }

      // 第二个行动者（如果还没进入下一街）
      const otherBar = await other.locator('.action-bar').isVisible({ timeout: 3000 }).catch(() => false);
      if (otherBar) {
        const otherToCall = await other.locator('button:has-text("跟注")').isVisible();
        if (otherToCall) {
          await other.click('button:has-text("跟注")');
        } else {
          await other.click('button:has-text("过牌")');
        }
      }

      // 检查是否已到摊牌
      const isShowdown = await p1.locator('.showdown-overlay').isVisible({ timeout: 1000 }).catch(() => false);
      if (isShowdown) break;
    }

    await expect(p1.locator('.showdown-overlay')).toBeVisible({ timeout: 10000 });

    await ctx1.close();
    await ctx2.close();
  });
});
