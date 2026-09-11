/**
 * 回归用例（2026-09-11，用户反馈）：A 下注、B all-in 盖过、轮回 A、A 也
 * all-in——应该直接摊牌，不该有任何座位继续显示"轮到你了"的行动环。
 *
 * 根因不在 GameEngine（服务端下注轮结束判断本身是对的，真实两人对局一路
 * 打到摊牌，逻辑没问题）——是 GameTable.jsx 里除了 hero 自己的 ActionBar
 * （2026-07-30 已经修过一次 stale actionPlayerId）之外，座位环（`isAction`，
 * hero 和对手座位都用）漏加了同一个 `!isShowdown` 守卫。GameEngine 在"下
 * 注轮靠自动跑完全部街道直接收尾"（fold-to-one-left / all-in 跟到摊牌）
 * 这类场景里，`actionIndex` 会停留在最后一个还是 'active' 状态的玩家身
 * 上，不会被清空——这个字段本身不算 bug（服务端从设计上就没打算在这类
 * 终局场景里维护它），但任何直接拿 actionPlayerId 渲染"轮到谁了"的地方，
 * 都得自己补上"是不是已经摊牌"这层判断，不能假设它只在真的该有人行动
 * 时才有值。见 GameTable.jsx 的 `isActingNow` 与 design.md 同名章节。
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
  raiseTrigger: '.b-raise-trigger',
  confirmRaise: '.b-confirm-raise',
  allin: '.b-allin',
  settlement: '.settlement-sheet',
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

test('A 下注、B all-in、A 也 all-in 跟上 -> 直接摊牌，任何一方座位都不该再显示"行动中"环', async ({ browser }) => {
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

  // 一路过牌/跟注打到翻牌（脱离盲注这条强制下注的街）。
  const checkOrCall = async (page) => {
    const canCheck = await page.locator('.b-check').isVisible().catch(() => false);
    if (canCheck) await page.locator('.b-check').click();
    else await page.locator('.b-call').click();
  };
  for (let i = 0; i < 6; i++) {
    await Promise.race([
      p1.locator(S.actionBar).waitFor({ state: 'visible', timeout: 6000 }),
      p2.locator(S.actionBar).waitFor({ state: 'visible', timeout: 6000 }),
    ]);
    const communityCount = await p1.locator('.community-cards .card, .board .card').count().catch(() => 0);
    if (communityCount >= 3) break;
    const actor = (await p1.locator(S.actionBar).isVisible().catch(() => false)) ? p1 : p2;
    await checkOrCall(actor);
    await p1.waitForTimeout(300);
  }

  await Promise.race([
    p1.locator(S.actionBar).waitFor({ state: 'visible', timeout: 6000 }),
    p2.locator(S.actionBar).waitFor({ state: 'visible', timeout: 6000 }),
  ]);
  const aIsP1 = await p1.locator(S.actionBar).isVisible().catch(() => false);
  const A = aIsP1 ? p1 : p2; // 翻牌先手，扮演题目里的 "A 先推了 500"
  const B = aIsP1 ? p2 : p1; // 扮演 "B 这个时候推了他满池"

  await A.locator(S.raiseTrigger).click();
  await A.locator(S.confirmRaise).click(); // A：加注（不 all-in）

  await B.locator(S.actionBar).waitFor({ state: 'visible', timeout: 6000 });
  await B.locator(S.raiseTrigger).click();
  await B.locator(S.allin).click(); // B：all-in 盖过

  await A.locator(S.actionBar).waitFor({ state: 'visible', timeout: 6000 }); // 轮回到 A
  await A.locator(S.raiseTrigger).click();
  await A.locator(S.allin).click(); // A 也 all-in 跟上

  await expect(p1.locator(S.settlement)).toBeVisible({ timeout: 8000 }); // 应直接进摊牌/结算

  for (const page of [A, B]) {
    const activeSeats = await page.locator('.seat.is-active, .seat.is-timed, .seat.is-timed-urgent').count();
    expect(activeSeats).toBe(0);
  }

  await ctx1.close();
  await ctx2.close();
});
