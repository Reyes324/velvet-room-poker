/**
 * 用户旅程回归（2026-09-16）——不是针对某一个具体 bug，是用户在排查完
 * "已在房间内卡死"那次之后明确要求："用户没有点退出游戏，而是直接离线
 * 了，这种情况下再打开会怎么样？...用户旅程上的每个路径，你可能走查一
 * 遍都是 OK 的"。这几条覆盖的是"人没有主动点任何退出按钮，就是关了页
 * 面/掉线/刷新"这几种最常见的真实场景，跟 roomListRejoin.spec.js（针对
 * 那次具体 bug 的复现）和 lobby.spec.js（大厅阶段的冷启动恢复）是互补关
 * 系，不重复覆盖同一件事。
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

test('旅程1：牌局进行中，用户直接关掉页面（没点退出），重新打开邀请链接应该原样回到牌局', async ({ browser }) => {
  test.setTimeout(30000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pA = await ctxA.newPage();
  const pB = await ctxB.newPage();

  const code = await createRoom(pA, 'JourneyA1');
  await joinRoom(pB, 'JourneyB1', code);
  await pA.locator(S.startBtn).click();
  await pA.locator('.timer-picker-option--untimed').click();
  await expect(pA.locator(S.gameStage)).toBeVisible({ timeout: 8000 });
  await Promise.race([
    pA.locator(S.actionBar).waitFor({ state: 'visible', timeout: 8000 }),
    pB.locator(S.actionBar).waitFor({ state: 'visible', timeout: 8000 }),
  ]);

  const inviteUrl = pB.url();
  // 真正关掉页面（不是断开 socket 再连回来）——最接近"用户直接划掉/关标
  // 签页"的真实动作。
  await pB.close();
  await new Promise(r => setTimeout(r, 500));

  const pB2 = await ctxB.newPage();
  await pB2.goto(inviteUrl);
  await expect(pB2.locator(S.gameStage)).toBeVisible({ timeout: 10000 });
  // 不应该落在加入表单上——本地已经有这个身份，应该直接被认出来。
  await expect(pB2.locator(S.nameInput)).toHaveCount(0);
  console.log('[旅程1] PASS：直接关闭后用邀请链接重开，直接回到牌桌，没有经过加入表单');

  await ctxA.close();
  await ctxB.close();
});

test('旅程2：牌局进行中，用户直接关掉页面，重新打开首页——应该看到"继续上局"卡片（不是走普通房间列表：那个是留给"别人的房间"用的，自己当前这间本来就该走更显眼的续局卡片）', async ({ browser }) => {
  test.setTimeout(30000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pA = await ctxA.newPage();
  const pB = await ctxB.newPage();

  const code = await createRoom(pA, 'JourneyA2');
  await joinRoom(pB, 'JourneyB2', code);
  await pA.locator(S.startBtn).click();
  await pA.locator('.timer-picker-option--untimed').click();
  await expect(pA.locator(S.gameStage)).toBeVisible({ timeout: 8000 });
  await Promise.race([
    pA.locator(S.actionBar).waitFor({ state: 'visible', timeout: 8000 }),
    pB.locator(S.actionBar).waitFor({ state: 'visible', timeout: 8000 }),
  ]);

  await pB.close();
  await new Promise(r => setTimeout(r, 500));

  const pB2 = await ctxB.newPage();
  await pB2.goto('/'); // 走首页，不走邀请链接
  await expect(pB2.locator('.home-resume-card', { hasText: code })).toBeVisible({ timeout: 8000 });
  await pB2.locator('.home-resume-card').click();
  await expect(pB2.locator(S.gameStage)).toBeVisible({ timeout: 10000 });
  await expect(pB2.locator('.home-error')).toHaveCount(0);
  console.log('[旅程2] PASS：直接关闭后重开首页，看到"继续上局"卡片，点了正常回到牌桌');

  await ctxA.close();
  await ctxB.close();
});

test('旅程3：牌局进行中整页刷新（F5），应该直接恢复到牌桌，不经过加入表单/首页', async ({ browser }) => {
  test.setTimeout(30000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pA = await ctxA.newPage();
  const pB = await ctxB.newPage();

  const code = await createRoom(pA, 'JourneyA3');
  await joinRoom(pB, 'JourneyB3', code);
  await pA.locator(S.startBtn).click();
  await pA.locator('.timer-picker-option--untimed').click();
  await expect(pA.locator(S.gameStage)).toBeVisible({ timeout: 8000 });
  await Promise.race([
    pA.locator(S.actionBar).waitFor({ state: 'visible', timeout: 8000 }),
    pB.locator(S.actionBar).waitFor({ state: 'visible', timeout: 8000 }),
  ]);

  await pB.reload();
  await expect(pB.locator(S.gameStage)).toBeVisible({ timeout: 10000 });
  await expect(pB.locator(S.nameInput)).toHaveCount(0);
  console.log('[旅程3] PASS：整页刷新直接恢复到牌桌');

  await ctxA.close();
  await ctxB.close();
});

test('旅程5：大厅阶段（还没开局）掉线，宽限期内重连回来，房主看到的名单应该恢复正常，没有把这个人踢出去', async ({ browser }) => {
  test.setTimeout(30000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pA = await ctxA.newPage();
  const pB = await ctxB.newPage();

  const code = await createRoom(pA, 'JourneyA5');
  await joinRoom(pB, 'JourneyB5', code);
  // 还没开局，都在大厅。
  await expect(pA.locator('.lobby-btn')).toBeVisible({ timeout: 5000 });

  // 真实断开（不是关页面），停留几秒再连回来——覆盖"网络抖了一下/切了下
  // 后台"这种最常见的短暂掉线，不是真的走了。
  await pB.evaluate(() => window.__vrSocket.disconnect());
  await expect(pA.locator('.pl-row', { hasText: '（断线中）' })).toBeVisible({ timeout: 8000 });

  await pB.evaluate(() => window.__vrSocket.connect());
  await expect(pA.locator('.pl-row', { hasText: '（断线中）' })).toHaveCount(0, { timeout: 8000 });
  // 名单里人还在，不是被移出去重进——两边看到的玩家数应该还是 2。
  await expect(pA.locator('.pl-row')).toHaveCount(2);
  await expect(pB.locator('.pl-row')).toHaveCount(2);
  console.log('[旅程5] PASS：大厅阶段短暂掉线、宽限期内重连，名单正常恢复，没有被移出房间');

  await ctxA.close();
  await ctxB.close();
});

test('旅程4：正常点"退出游戏"后，分别用邀请链接和房间列表两条路重新加入', async ({ browser }) => {
  test.setTimeout(30000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pA = await ctxA.newPage();
  const pB = await ctxB.newPage();

  const code = await createRoom(pA, 'JourneyA4');
  await joinRoom(pB, 'JourneyB4', code);
  const inviteUrl = pB.url();

  // pB 点"退出房间"（大厅态下的退出入口）
  await pB.locator('.menu-btn').click();
  await pB.locator('.menu-row', { hasText: '退出房间' }).click();
  await pB.locator('.modal-btn-danger', { hasText: '退出' }).click();
  await expect(pB.locator(S.nameInput)).toBeVisible({ timeout: 5000 }); // 回到首页

  // 路1：邀请链接重新加入
  await pB.goto(inviteUrl);
  await pB.fill(S.nameInput, 'JourneyB4');
  await pB.click(S.joinSubmit);
  await expect(pB.locator(S.roomCode)).toBeVisible({ timeout: 8000 });
  console.log('[旅程4-路1] PASS：退出后用邀请链接重新加入正常');

  // 再退一次，改走房间列表
  await pB.locator('.menu-btn').click();
  await pB.locator('.menu-row', { hasText: '退出房间' }).click();
  await pB.locator('.modal-btn-danger', { hasText: '退出' }).click();
  await expect(pB.locator(S.nameInput)).toBeVisible({ timeout: 5000 });
  await pB.goto('/');
  await expect(pB.locator('.home-room-row', { hasText: 'JourneyA4' })).toBeVisible({ timeout: 8000 });
  await pB.locator('.home-room-row', { hasText: 'JourneyA4' }).locator('.home-room-row__join').click();
  await expect(pB.locator(S.roomCode)).toBeVisible({ timeout: 8000 });
  await expect(pB.locator('.home-error')).toHaveCount(0);
  console.log('[旅程4-路2] PASS：退出后从房间列表重新加入正常');

  await ctxA.close();
  await ctxB.close();
});
