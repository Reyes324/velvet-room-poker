/**
 * 回归用例（2026-09-11，用户反馈）："加到最后一次时，按钮直接消失，导致
 * 整个布局发生了变化，左边的按钮移过去了"。
 *
 * 根因：ActionBar.jsx 原来是 `{timeBankMs > 0 && <button class="b-extend">}`
 * ——额度用完就把按钮整个从 DOM 里摘掉。`.ab-main` 是 flex 布局，
 * `.b-fold`/`.b-call`/`.b-check`/`.b-raise-trigger` 都是 flex:1/2 会撑开
 * 吃掉腾出来的空间，摘掉 `.b-extend` 会让左边几颗按钮跟着变宽/挪位置。
 * 修法：按钮永远在，额度用完只切换到置灰的 disabled 态，不再离开 DOM。
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

test('「+15s」额度用完后按钮置灰留在原地，不再触发左侧按钮的布局跳动', async ({ browser }) => {
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

  const foldBefore = await actor.locator('.b-fold').boundingBox();
  await expect(actor.locator('.b-extend')).toBeVisible();

  // 连点「+15s」到额度用完（本手储备池封顶，点几次必然会用完）。
  for (let i = 0; i < 6; i++) {
    if (await actor.locator('.b-extend').isDisabled()) break;
    await actor.locator('.b-extend').click();
    await actor.waitForTimeout(200);
  }
  expect(await actor.locator('.b-extend').isDisabled()).toBe(true);

  // 按钮还在（占位没丢），左边弃牌按钮的位置/宽度分毫未变。
  await expect(actor.locator('.b-extend')).toBeVisible();
  const foldAfter = await actor.locator('.b-fold').boundingBox();
  expect(Math.abs(foldAfter.x - foldBefore.x)).toBeLessThan(1);
  expect(Math.abs(foldAfter.width - foldBefore.width)).toBeLessThan(1);

  await ctx1.close();
  await ctx2.close();
});
