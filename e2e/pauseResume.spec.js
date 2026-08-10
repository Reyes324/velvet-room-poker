/**
 * 暂停/继续（用户反馈，2026-08-11）：暂停要能真的冻结当前回合的行动倒计
 * 时，不是只有服务端状态对但界面看不出来。这条测试断言的是真实渲染出来
 * 的倒计时数字，不是服务端单测那种"信任 room.turnClock 为 null 就够了"
 * ——用户会盯着屏幕看，界面上数字有没有变化才是他们真正在意的。
 *
 * 顺带抓到一个真 bug：暂停后 turnClock 变 null，PlayerSeat 原本会掉进
 * "没有倒计时"分支，显示成还在自己走的 think-overlay 正数计时——看起来
 * 像时间根本没冻结。修法是给 PlayerSeat 加 paused prop，暂停时两种计时
 * 显示都不渲染（见 PlayerSeat.jsx 改动）。
 */
const { test, expect } = require('@playwright/test');

const S = {
  nameInput: '.home-input:not(.home-input--code)',
  createBtn: 'button:has-text("创建房间")',
  joinSubmit: 'button:has-text("加入")',
  roomCode: '.room-code',
  startBtn: '.lobby-btn',
  actionBar: '.action-bar',
  pauseBtn: '.pause-btn',
  pauseOverlay: '.pause-overlay',
  resumeBtn: '.pause-overlay__btn',
  turnSecs: '.turn-secs',
};

test('暂停后回合倒计时冻结，继续后才重新开始跳动', async ({ browser }) => {
  test.setTimeout(60000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pA = await ctxA.newPage();
  const pB = await ctxB.newPage();

  await pA.goto('/');
  await pA.fill(S.nameInput, '甲');
  await pA.click(S.createBtn);
  await expect(pA.locator(S.roomCode)).toBeVisible({ timeout: 8000 });
  const code = (await pA.locator(S.roomCode).textContent()).trim();

  await pB.goto(`/room/${code}`);
  await pB.fill(S.nameInput, '乙');
  await pB.click(S.joinSubmit);
  await expect(pB.locator(S.roomCode)).toBeVisible({ timeout: 10000 });

  await pA.locator(S.startBtn).click();
  await Promise.race([
    pA.locator(S.actionBar).waitFor({ state: 'visible', timeout: 15000 }),
    pB.locator(S.actionBar).waitFor({ state: 'visible', timeout: 15000 }),
  ]);

  const actorIsA = await pA.locator(S.actionBar).isVisible();
  const actorPage = actorIsA ? pA : pB;
  const observerPage = actorIsA ? pB : pA;

  // 非行动方也能看到并点暂停——验证"任意坐位玩家都能触发"，不只是行动方自己。
  await observerPage.locator(S.pauseBtn).click();
  await expect(observerPage.locator(S.pauseOverlay)).toBeVisible({ timeout: 3000 });
  await expect(actorPage.locator(S.pauseOverlay)).toBeVisible({ timeout: 3000 });

  // 行动方的操作栏在暂停期间应该消失（禁用逻辑生效）。
  await expect(actorPage.locator(S.actionBar)).toHaveCount(0);

  // 倒计时数字本身在暂停时不渲染了（见文件头注释）——断言它确实消失，
  // 而不是留在 DOM 里但数字不变，两者都算"冻结"，但要断言实际发生的那种。
  await expect(actorPage.locator(S.turnSecs)).toHaveCount(0);

  // 等 3 秒，确认暂停覆盖层和操作栏隐藏这两个状态在这段时间里没有自己变化。
  await actorPage.waitForTimeout(3000);
  await expect(actorPage.locator(S.pauseOverlay)).toBeVisible();
  await expect(actorPage.locator(S.actionBar)).toHaveCount(0);

  // 继续——操作栏重新出现，倒计时数字重新出现并且在动。
  await observerPage.locator(S.resumeBtn).click();
  await expect(actorPage.locator(S.actionBar)).toBeVisible({ timeout: 3000 });
  await expect(actorPage.locator(S.turnSecs)).toBeVisible({ timeout: 3000 });
  await expect(actorPage.locator(S.pauseOverlay)).toHaveCount(0);

  const secondsRightAfterResume = await actorPage.locator(S.turnSecs).textContent();
  await actorPage.waitForTimeout(1200);
  const secondsLater = await actorPage.locator(S.turnSecs).textContent();
  expect(secondsLater).not.toBe(secondsRightAfterResume);

  await ctxA.close();
  await ctxB.close();
});

test('旁观者看不到暂停按钮', async ({ browser }) => {
  test.setTimeout(60000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ctxC = await browser.newContext();
  const pA = await ctxA.newPage();
  const pB = await ctxB.newPage();
  const pC = await ctxC.newPage();

  await pA.goto('/');
  await pA.fill(S.nameInput, '甲');
  await pA.click(S.createBtn);
  await expect(pA.locator(S.roomCode)).toBeVisible({ timeout: 8000 });
  const code = (await pA.locator(S.roomCode).textContent()).trim();

  await pB.goto(`/room/${code}`);
  await pB.fill(S.nameInput, '乙');
  await pB.click(S.joinSubmit);
  await expect(pB.locator(S.roomCode)).toBeVisible({ timeout: 10000 });

  await pA.locator(S.startBtn).click();
  await Promise.race([
    pA.locator(S.actionBar).waitFor({ state: 'visible', timeout: 15000 }),
    pB.locator(S.actionBar).waitFor({ state: 'visible', timeout: 15000 }),
  ]);

  // 丙中途加入——牌局已经开始，丙是旁观者（amPlaying=false）。
  await pC.goto(`/room/${code}`);
  await pC.fill(S.nameInput, '丙');
  await pC.click(S.joinSubmit);
  await expect(pC.locator(S.roomCode)).toBeVisible({ timeout: 10000 });

  await expect(pC.locator(S.pauseBtn)).toHaveCount(0);

  await ctxA.close();
  await ctxB.close();
  await ctxC.close();
});
