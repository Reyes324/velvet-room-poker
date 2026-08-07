/**
 * E2E 测试 — 服务器重启/发版导致牌局重置时的提示
 *
 * Render 免费档全内存，进程一换（推送重新部署、闲置休眠冷启动、崩溃）所有
 * 房间就没了。在此之前这件事对玩家是完全静默的：客户端拿着过期房间号去
 * rejoin，服务器回"未找到房间"，人卡在原地不知道发生了什么。
 *
 * 触发条件（服务器进程真的重启）在测试里很难复现，但客户端的判断只依赖
 * "localStorage 里存的身份 vs server:hello 带来的身份"——所以往
 * localStorage 塞一个过期的 bootId 就能完整走通这条路径，不需要真的重启。
 */
const { test, expect } = require('@playwright/test');

const S = {
  nameInput: '.home-input:not(.home-input--code)',
  createBtn: 'button:has-text("创建房间")',
  roomCode:  '.room-code',
  modal:     '.modal',
  modalTitle:'.modal-title',
  dismissBtn:'.modal-btn:has-text("知道了")',
};

/** 建个房间，让本地留下"有进行中会话"的标记 */
async function createRoom(page, name) {
  await page.goto('/');
  await page.fill(S.nameInput, name);
  await page.click(S.createBtn);
  await expect(page.locator(S.roomCode)).toBeVisible({ timeout: 5000 });
}

/** 伪造一个"上次连的是另一个进程"的记录，再重新进站 */
async function seedStaleIdentity(page, version) {
  await page.evaluate((v) => {
    localStorage.setItem('vr_serverIdentity', JSON.stringify({ bootId: 'stale-boot-id', version: v }));
  }, version);
  await page.reload();
}

test.describe('服务器重置提示', () => {
  test('commit 变了 → 提示发布了新版本，关掉回首页并清干净本地标记', async ({ page }) => {
    await createRoom(page, '版本测试');
    // 本地服务器的 version 恒为 'dev'，这里塞一个不同的值模拟"线上换了 commit"
    await seedStaleIdentity(page, 'old1234');

    await expect(page.locator(S.modalTitle)).toHaveText('开发者刚发布了新版本', { timeout: 8000 });
    await expect(page.locator(S.modal)).toContainText('牌局已经重置了');

    await page.click(S.dismissBtn);

    await expect(page.locator(S.modal)).toHaveCount(0);
    await expect(page.locator(S.createBtn)).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/');
    // 过期标记必须清掉，否则下次进站又会去 rejoin 一个不存在的房间
    expect(await page.evaluate(() => localStorage.getItem('vr_roomCode'))).toBeNull();
  });

  test('commit 没变、只有进程换了 → 说"服务器重启了"，不谎称发版', async ({ page }) => {
    await createRoom(page, '重启测试');
    // version 跟本地服务器一致（都是 'dev'），只有 bootId 不同——这正是免费
    // 档闲置休眠冷启动的形态
    await seedStaleIdentity(page, 'dev');

    await expect(page.locator(S.modalTitle)).toHaveText('服务器重启了', { timeout: 8000 });
  });

  test('没有进行中的会话时不打扰——首页访客什么都没丢', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator(S.createBtn)).toBeVisible();
    await seedStaleIdentity(page, 'old1234');

    await expect(page.locator(S.createBtn)).toBeVisible();
    await expect(page.locator(S.modal)).toHaveCount(0);
  });

  test('同一进程内正常重连不弹窗', async ({ page }) => {
    await createRoom(page, '正常重连');
    // 不动 localStorage，直接刷新：bootId 跟服务器一致，应当照常回到房间
    await page.reload();

    await expect(page.locator(S.roomCode)).toBeVisible({ timeout: 8000 });
    await expect(page.locator(S.modal)).toHaveCount(0);
  });
});
