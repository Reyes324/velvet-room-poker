const { test, expect } = require('@playwright/test');

// 复盘面板的真机验证（扑克教练，2026-09-20）。服务端 handReview.js 的判定逻辑
// 有自己的单测，这里验的是端到端那条线真的通：打几手 → 菜单点"复盘" → 服务端
// 真的算出结果并回传 → 面板把结论渲染出来 → 翻页能换到另一手。
//
// 人类侧一律跟注/过牌（故意打成"什么都跟"的烂玩家），这样大概率能制造出至少
// 一处被判失误的决策，顺便验证失误行的渲染分支，而不是只看到"没有明显失误"。
test('PVE：打几手之后能从菜单打开复盘，看到逐手的判定，并且能翻页', async ({ page }) => {
  // 要真的把三手牌打完（每手四条街 + AI 思考延迟 + 发牌/摊牌动画），
  // 配置里默认的 30 秒不够。
  test.setTimeout(150000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

  await page.goto('/pve');
  await page.getByText('人机对战').first().click().catch(() => {});
  // 单挑（2 人桌）——牌局最短，同样的等待时间里能攒下最多的完整手数
  const seatBtn = page.locator('.home-pve-seat-btn', { hasText: '单挑' });
  if (await seatBtn.count()) await seatBtn.click();
  await expect(page.locator('.game-stage')).toBeVisible({ timeout: 10000 });

  // 攒牌局记录：尽量跟注/过牌把牌打到底，而不是弃牌——弃牌太快结束，攒不出
  // 面对下注的决策点，复盘就没东西可判。
  //
  // 按结果驱动而不是跑固定圈数：一手牌在单挑里要走四条街、每步都有 AI 思考
  // 延迟和发牌动画，固定圈数很容易只打完一手，翻页就没得翻（第一版就栽在
  // 这）。这里数真正结算过几手，够 3 手再停。
  let handsFinished = 0;
  for (let i = 0; i < 160 && handsFinished < 3; i++) {
    for (const label of ['跟注', '过牌', '看牌']) {
      const btn = page.locator('.action-bar button', { hasText: label });
      if (await btn.count() && await btn.first().isEnabled().catch(() => false)) {
        await btn.first().click().catch(() => {});
        break;
      }
    }
    const okBtn = page.locator('.modal-btn', { hasText: '我知道了' });
    if (await okBtn.count()) {
      await okBtn.click().catch(() => {});
      handsFinished += 1;
    }
    await page.waitForTimeout(300);
  }
  expect(handsFinished, '没能在超时前打完 3 手，后面的翻页断言无从谈起').toBeGreaterThanOrEqual(3);

  // 菜单 → 复盘
  await page.locator('.menu-btn').first().click();
  await page.locator('.menu-row', { hasText: '复盘' }).click();

  // 面板出来，并且真的等到服务端算完（"正在算…"消失、内容渲染出来）
  await expect(page.locator('.hh-panel-title', { hasText: '复盘' })).toBeVisible();
  await expect(page.locator('.rv-body')).toBeVisible({ timeout: 15000 });

  // 至少要有一步决策被渲染出来，并且总结行在
  await expect(page.locator('.rv-step').first()).toBeVisible();
  await expect(page.locator('.rv-verdict')).toBeVisible();
  const verdictText = await page.locator('.rv-verdict').textContent();
  expect(verdictText).toMatch(/没有明显失误|步亏了/);

  // 头部显示的是"第 N 手 / 共 M 手"
  await expect(page.locator('.hh-panel-count')).toContainText('手');
  const firstHeader = await page.locator('.hh-panel-count').textContent();

  // 翻页：默认落在最近一手，所以"上一手"应该可用，点了之后手号要真的变
  const prevBtn = page.locator('.rv-pager-btn', { hasText: '上一手' });
  await expect(prevBtn).toBeEnabled();
  await prevBtn.click();
  await expect(page.locator('.rv-body')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.hh-panel-count')).not.toHaveText(firstHeader);


  expect(errors, `控制台/页面报错：\n${errors.join('\n')}`).toEqual([]);
});
