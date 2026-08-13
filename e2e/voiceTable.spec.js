/**
 * E2E — 语音对讲正式接入牌桌（3 人桌 mesh）
 *
 * 跟 voicePair.spec.js 覆盖的是同一层"信令 + 建连 + 音频收发"链路，但这里
 * 换成了 N 人、真实游戏房间、真实牌桌 UI，而不是独立测试页。三方两两连
 * 通、说话状态正确广播、退出清理干净——这几条正是设计文档「接入实际牌
 * 桌」章节定的验收方式。
 *
 * 断言分两层，不能只信"说话中"这个视觉状态：
 *  1. `window.__voiceMeshPcs`（useVoiceMesh.js 暴露的调试钩子）——真的读
 *     WebRTC 的 iceConnectionState，证明协商本身连上了，不是只有旁边那条
 *     更简单的 voice:speaking 信令广播在动（那条不经过 ICE）。
 *  2. `.speak-glow` / `.speak-badge` 这两个真实渲染出来的 DOM 元素——证明
 *     UI 层真的把状态画出来了，不是"状态对但没显示"。
 */
const { test, expect } = require('@playwright/test');

const S = {
  nameInput: '.home-input:not(.home-input--code)',
  codeInput: '.home-input--code',
  createBtn: 'button:has-text("创建房间")',
  joinSubmit: 'button:has-text("加入")',
  roomCode: '.room-code',
  startBtn: '.lobby-btn',
  gameStage: '.game-stage',
  pttBtn: '.ptt-btn',
  seat: '.seat',
  seatName: '.seat-name',
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

async function startGame(page) {
  // "开始游戏"/"计时游戏"合并成一个入口后（2026-08-13），点 .lobby-btn
  // 只会弹出选择器，不再直接开局——多一步点"直接开始"才是真正开局。
  await page.locator(S.startBtn).click();
  await page.locator('.timer-picker-option--untimed').click();
  await expect(page.locator(S.gameStage)).toBeVisible({ timeout: 8000 });
}

/** 找到某个玩家名字所在的座位容器（这一页上渲染出来的 DOM，不是全局）。 */
function seatOf(page, name) {
  return page.locator(S.seat).filter({ has: page.locator(S.seatName, { hasText: name }) });
}

/** 语音默认对所有人自动开启（2026-08-10 UX 修正后不再有手动开关），进牌
 * 桌后 useVoiceMesh 会自己接入 mesh——这里只需要等"说话"按钮出现，代表
 * 自动 enable() 已经跑完，不用再手动点任何按钮。 */
async function openVoice(page) {
  await expect(page.locator(S.pttBtn)).toBeVisible({ timeout: 5000 });
}

/** 等某一页真的连上了期望数量的对端（真实 ICE 状态，不是只看信令 join
 * 成功那一下）。不点按钮，纯粹等待——语音是不是已经开着由调用方保证。 */
async function waitForPeerCount(page, expectedPeerCount, timeout = 20000) {
  await expect(async () => {
    const states = await page.evaluate(() => {
      const map = window.__voiceMeshPcs;
      if (!map) return [];
      return [...map.values()].map(v => v.pc.iceConnectionState);
    });
    expect(states.length).toBe(expectedPeerCount);
    expect(states.every(s => s === 'connected' || s === 'completed')).toBe(true);
  }).toPass({ timeout });
}

test.describe('语音对讲接入实际牌桌', () => {
  test('三人桌：两两建连成功（真实 ICE 状态，不是只看信令）', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const ctxC = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    const c = await ctxC.newPage();

    const code = await createRoom(a, 'Alice');
    await joinRoom(b, 'Bob', code);
    await joinRoom(c, 'Carol', code);
    await startGame(a);
    await expect(b.locator(S.gameStage)).toBeVisible({ timeout: 8000 });
    await expect(c.locator(S.gameStage)).toBeVisible({ timeout: 8000 });

    // 语音默认自动接入（2026-08-10 UX 修正后不再手动逐个开），三个人进桌
    // 的先后顺序不再由测试控制，只等最终状态：每个人都跟另外两个建上连
    // 接。服务端仍然是"后加入的人对每个已在场的人发 offer"这套约定，只是
    // 现在触发时机是组件挂载，不是用户点击。
    await openVoice(a);
    await openVoice(b);
    await openVoice(c);
    await waitForPeerCount(a, 2);
    await waitForPeerCount(b, 2);
    await waitForPeerCount(c, 2);

    await ctxA.close();
    await ctxB.close();
    await ctxC.close();
  });

  test('按住说话：对方屏幕上出现说话指示，松开后消失，且不影响第三人', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const ctxC = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    const c = await ctxC.newPage();

    const code = await createRoom(a, 'Alice');
    await joinRoom(b, 'Bob', code);
    await joinRoom(c, 'Carol', code);
    await startGame(a);
    await expect(b.locator(S.gameStage)).toBeVisible({ timeout: 8000 });
    await expect(c.locator(S.gameStage)).toBeVisible({ timeout: 8000 });

    await openVoice(a);
    await openVoice(b);
    await openVoice(c);
    await waitForPeerCount(a, 2);
    await waitForPeerCount(b, 2);
    await waitForPeerCount(c, 2);

    // Alice 按住说话——她自己屏幕上也该立刻亮起（本地状态，不用等广播），
    // 且 Bob/Carol 屏幕上 Alice 那个座位也该亮起（经服务端转发的广播）。
    await a.locator(S.pttBtn).dispatchEvent('pointerdown');
    await expect(seatOf(a, 'Alice').locator('.speak-glow')).toBeVisible({ timeout: 3000 });
    await expect(seatOf(b, 'Alice').locator('.speak-glow')).toBeVisible({ timeout: 3000 });
    await expect(seatOf(b, 'Alice').locator('.speak-badge')).toBeVisible();
    await expect(seatOf(c, 'Alice').locator('.speak-glow')).toBeVisible({ timeout: 3000 });

    // 没在说话的人不该被误点亮
    await expect(seatOf(b, 'Bob').locator('.speak-glow')).toHaveCount(0);
    await expect(seatOf(c, 'Carol').locator('.speak-glow')).toHaveCount(0);

    // 松开后各方都该恢复
    await a.locator(S.pttBtn).dispatchEvent('pointerup');
    await expect(seatOf(a, 'Alice').locator('.speak-glow')).toHaveCount(0);
    await expect(seatOf(b, 'Alice').locator('.speak-glow')).toHaveCount(0, { timeout: 3000 });
    await expect(seatOf(c, 'Alice').locator('.speak-glow')).toHaveCount(0, { timeout: 3000 });

    await ctxA.close();
    await ctxB.close();
    await ctxC.close();
  });

  test('离开牌桌后连接清理干净，对方收到离开通知', async ({ browser }) => {
    // 2026-08-10 UX 修正后语音没有手动开关了（默认全员自动接入），"退出
    // 语音"这件事现在只能通过离开牌桌触发——对应 useVoiceMesh 卸载时的
    // 清理副作用（closeAllPcs + 停麦克风轨道 + voice:mesh-leave）。用关掉
    // 页面模拟真实的"离开"，而不是再去点一个已经不存在的按钮。
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    const code = await createRoom(a, 'Alice');
    await joinRoom(b, 'Bob', code);
    await startGame(a);
    await expect(b.locator(S.gameStage)).toBeVisible({ timeout: 8000 });

    await openVoice(a);
    await openVoice(b);
    await waitForPeerCount(a, 1);
    await waitForPeerCount(b, 1);

    // Bob 离开（关掉页面/context）——模拟真实的"退出牌桌"
    await ctxB.close();

    // Alice 这边这条连接该被清理掉——不再出现在 pcs 表里
    await expect(async () => {
      const count = await a.evaluate(() => window.__voiceMeshPcs?.size ?? -1);
      expect(count).toBe(0);
    }).toPass({ timeout: 5000 });

    await ctxA.close();
  });

  test('两桌互相隔离：不同房间的语音互相听不见对方说话', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const ctxX = await browser.newContext();
    const ctxY = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    const x = await ctxX.newPage();
    const y = await ctxY.newPage();

    const codeAB = await createRoom(a, 'Alice');
    await joinRoom(b, 'Bob', codeAB);
    await startGame(a);
    await expect(b.locator(S.gameStage)).toBeVisible({ timeout: 8000 });

    const codeXY = await createRoom(x, 'Xin');
    await joinRoom(y, 'Yao', codeXY);
    await startGame(x);
    await expect(y.locator(S.gameStage)).toBeVisible({ timeout: 8000 });

    await openVoice(a);
    await openVoice(b);
    await openVoice(x);
    await openVoice(y);
    await waitForPeerCount(a, 1);
    await waitForPeerCount(b, 1);
    await waitForPeerCount(x, 1);
    await waitForPeerCount(y, 1);

    await a.locator(S.pttBtn).dispatchEvent('pointerdown');
    await expect(seatOf(b, 'Alice').locator('.speak-glow')).toBeVisible({ timeout: 3000 });
    // 另一桌完全不该受影响——既不该多出一条 pc，也不该出现任何说话指示
    const xPcCount = await x.evaluate(() => window.__voiceMeshPcs?.size ?? -1);
    expect(xPcCount).toBe(1); // 只跟 y 那一条，不该凭空多出一条
    await expect(x.locator('.speak-glow')).toHaveCount(0);
    await expect(y.locator('.speak-glow')).toHaveCount(0);

    await ctxA.close();
    await ctxB.close();
    await ctxX.close();
    await ctxY.close();
  });
});
