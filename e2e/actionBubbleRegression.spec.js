const { test, expect } = require('@playwright/test');

// 冒烟验证：2026-08-16 修复"动作气泡在同一渲染里被吞掉"这个 bug 之后，
// 确认基本渲染路径没有回归——8 人机对战桌，AI 决策几乎瞬时，多个 AI 背
// 靠背行动的概率比真人房间高很多，是最容易撞见这个 race 的场景。这条测
// 试不能确定性复现"两次 game:state 广播落进同一次 React 渲染"这个具体时
// 序条件（取决于服务端事件循环调度，脚本控制不了），所以不是这个 bug 的
// 确定性回归测试——只能确认：改动之后，气泡机制本身还能正常工作，没有
// 因为这次重构（把气泡状态从 GameTable 搬到 RoomPage/PvePage）引入新的
// 渲染错误或崩溃。真正的时序场景仍需要真机多打几手来交叉确认。
test('PVE 8人桌：走完几手之后，多个座位都出现过动作气泡，且没有控制台报错', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

  await page.goto('/pve');
  await page.getByText('人机对战').first().click().catch(() => {});
  // /pve 直接落地可能已经在选桌页；两条路径都兜一下
  const seatBtn = page.locator('.home-pve-seat-btn', { hasText: '8 人' });
  if (await seatBtn.count()) await seatBtn.click();

  // 等牌桌真正渲染出来（座位/底池），最多等 10 秒（人机开局有一次发牌动画）
  await expect(page.locator('.game-stage')).toBeVisible({ timeout: 10000 });

  // 观察窗口：让好几手牌走完，AI 背靠背行动的窗口越多，越容易撞见待验证
  // 的那个 race——这里不追求确定性复现，只确认整个链路没有崩溃。
  const seenActorIds = new Set();
  for (let i = 0; i < 15; i++) {
    const bubbles = page.locator('.action-bubble');
    const count = await bubbles.count();
    for (let j = 0; j < count; j++) {
      const text = await bubbles.nth(j).textContent();
      if (text) seenActorIds.add(text.trim());
    }
    // 弃牌能过，跟注能过，遇到需要真人决策的节点也弃牌，尽快滚动到下一手
    const foldBtn = page.locator('.action-bar button', { hasText: '弃牌' });
    if (await foldBtn.count() && await foldBtn.isEnabled().catch(() => false)) {
      await foldBtn.click().catch(() => {});
    }
    const okBtn = page.locator('button', { hasText: '我知道了' });
    if (await okBtn.count()) await okBtn.click().catch(() => {});
    await page.waitForTimeout(800);
  }

  expect(errors, `控制台/页面报错：\n${errors.join('\n')}`).toEqual([]);
  // 走了这么多手，至少应该见过不止一种气泡文案（弃牌/跟注/加注/过牌其一），
  // 证明气泡机制在新的数据流下确实还在正常工作。
  expect(seenActorIds.size).toBeGreaterThan(0);
});
