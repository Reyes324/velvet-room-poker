/**
 * 新功能（2026-09-11，用户反馈）："有时候等不及了，点开他头像的面板里能
 * 有一个帮他弃牌的按钮"——断线玩家轮到自己行动时，其他人可以在对方头像
 * 弹出的表情面板里看到一个"帮他弃牌"按钮，点了就能替断线的人弃牌，不用
 * 干等读秒/储备池耗尽才自动处理。
 */
const { test, expect } = require('@playwright/test');

const S = {
  nameInput: '.home-input:not(.home-input--code)',
  createBtn: 'button:has-text("创建房间")',
  joinSubmit: 'button:has-text("加入")',
  roomCode: '.room-code',
  startBtn: '.lobby-btn',
  gameStage: '.game-stage',
  actionBar: '.action-bar',
};

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

test('断线玩家轮到自己行动时，对方能在表情面板里点"帮他弃牌"，牌局立刻继续', async ({ browser }) => {
  test.setTimeout(60000);
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const p1 = await ctx1.newPage();
  const p2 = await ctx2.newPage();

  const code = await createRoom(p1, 'Alice');
  await joinRoom(p2, 'Bob', code);

  await p1.locator(S.startBtn).click();
  await p1.locator('.timer-picker-option--untimed').click();
  await expect(p1.locator(S.gameStage)).toBeVisible({ timeout: 8000 });

  await Promise.race([
    p1.locator(S.actionBar).waitFor({ state: 'visible', timeout: 8000 }),
    p2.locator(S.actionBar).waitFor({ state: 'visible', timeout: 8000 }),
  ]);
  const actor = (await p1.locator(S.actionBar).isVisible().catch(() => false)) ? p1 : p2;
  const other = actor === p1 ? p2 : p1;

  // 行动方断线（保留 context，后面不需要它恢复——这条用例只关心"对方能不
  // 能帮他弃牌"，跟 game.spec.js 里"断线后暂停等待"那条覆盖的是同一个断
  // 线判定，不重复验证重连）。
  await actor.evaluate(() => window.__vrSocket.disconnect());
  await other.locator('.disconnect-badge', { hasText: '断线中' }).waitFor({ state: 'visible', timeout: 8000 });

  // 这一刻不该有任何一方看到行动栏（断线的人真做不了，另一方也不该被自动
  // 塞一个行动机会）。
  expect(await other.locator(S.actionBar).isVisible().catch(() => false)).toBe(false);

  // 点断线那位的头像，弹出表情面板，面板里应该有"帮他弃牌"。
  const disconnectedSeat = other.locator('.seat', { has: other.locator('.disconnect-badge') });
  await disconnectedSeat.locator('.avatar-card').click();
  const foldForBtn = other.locator('.poke-picker-foldfor');
  await expect(foldForBtn).toBeVisible({ timeout: 5000 });
  await foldForBtn.click();

  // 断线玩家的手应该被弃掉，牌局继续（结算弹窗出现，或者至少不再卡住）。
  await expect(other.locator('.settlement-sheet')).toBeVisible({ timeout: 8000 });

  await ctx1.close();
  await ctx2.close();
});
