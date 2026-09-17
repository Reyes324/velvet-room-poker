/**
 * 回归用例（2026-09-16，用户反馈）："操作失败显示不在房间内，退出房间
 * 后，点下方的加入，又说我已在房间内进不去"。
 *
 * 根因：2026-08-12 已经为"点邀请链接/手输房间码回到自己房间却报'已在房
 * 间内'"这个场景做过自愈（收到这个报错时自动 room:sync 重新接上，不用
 * 用户自己再想办法）——但那次自愈只在 mode==='join'（走手输房间码/邀请
 * 链接那条表单）时触发。首页房间列表那一行"加入"
 * （HomePage.jsx#handleRoomRowClick，已经填过昵称时直接 emit，完全不碰
 * mode/code 这两个 state）撞上同一个"已在房间内"，却因为条件对不上，没
 * 人接住，只剩一句报错、卡死在原地进不去。同一个报错、同一个本该通用的
 * 自愈逻辑，只覆盖了两条 join 入口里的一条。
 */
const { test, expect } = require('@playwright/test');

const S = {
  nameInput: '.home-input:not(.home-input--code)',
  createBtn: 'button:has-text("创建房间")',
  roomCode: '.room-code',
};

test('room-list quick-join self-heals from "已在房间内" the same way the join-form path already does', async ({ browser }) => {
  test.setTimeout(30000);
  const ctx = await browser.newContext();
  const page1 = await ctx.newPage();

  // page1: create a room and stay connected — its socket genuinely stays
  // alive the whole test, so the server really does see this player as
  // connected:true the whole time (not a simulated/faked state).
  await page1.goto('/');
  await page1.fill(S.nameInput, 'RejoinTestHost');
  await page1.click(S.createBtn);
  await expect(page1.locator(S.roomCode)).toBeVisible({ timeout: 5000 });

  // page2: same browser context → shares localStorage (same vr_playerId,
  // same vr_playerName as page1 already wrote). This reproduces "the exact
  // same person, a second tab/reload" without touching server internals.
  const page2 = await ctx.newPage();
  // Simulate what a failed/aborted "退出房间" leaves behind — vr_roomCode
  // gone locally (so the room re-appears in the home room list) while
  // vr_playerId/vr_playerName (the actual identity) survive, exactly the
  // state that made handleRoomRowClick's "name already filled" branch fire
  // in the real report.
  await page2.goto('/');
  await page2.evaluate(() => localStorage.removeItem('vr_roomCode'));
  await page2.reload();

  await expect(page2.locator('.home-room-row', { hasText: 'RejoinTestHost' })).toBeVisible({ timeout: 8000 });
  await page2.locator('.home-room-row', { hasText: 'RejoinTestHost' }).locator('.home-room-row__join').click();

  // Before the fix: this hangs on `.home-error` showing "已在房间内" and
  // never gets in. After the fix: self-heals via room:sync and lands on
  // the room the same way clicking the invite link/manual code already did.
  await expect(page2.locator(S.roomCode)).toBeVisible({ timeout: 8000 });
  await expect(page2.locator('.home-error')).toHaveCount(0);

  await ctx.close();
});
