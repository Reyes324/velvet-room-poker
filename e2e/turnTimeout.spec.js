/**
 * 回合倒计时到点后的表现（用户反馈，2026-08-08）：
 * 「默认自动决策之后，是过牌还是弃牌，这个气泡怎么没有了，你应该跟手动决策
 *  的显示效果是一样才对」
 *
 * 用真实的 20 秒生产配置跑，不注入短时长——这条测的正是玩家实际会遇到的那
 * 条路径，缩短时长就可能绕开真正的问题。
 */
const { test, expect } = require('@playwright/test');

const S = {
  nameInput: '.home-input:not(.home-input--code)',
  createBtn: 'button:has-text("创建房间")',
  joinSubmit: 'button:has-text("加入")',
  roomCode:  '.room-code',
  startBtn:  '.lobby-btn',
  actionBar: '.action-bar',
  bubble:    '.action-bubble',
};

test('倒计时到点自动弃牌 → 动作气泡照常出现（与手动弃牌一致）', async ({ browser }) => {
  test.setTimeout(90000);
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
  const observer = actorIsA ? pB : pA;
  const actorPage = actorIsA ? pA : pB;

  // 谁都不动，等 20 秒倒计时到点，服务端替行动方执行默认动作。
  // 先确认这手确实结束了（结算浮层出现）——用来区分"倒计时没触发"和
  // "触发了但气泡没渲染"这两种完全不同的失败。
  await expect(observer.locator('.settlement-sheet')).toBeVisible({ timeout: 30000 });
  await expect(observer.locator(S.bubble).filter({ hasText: '弃牌' })).toHaveCount(1, { timeout: 5000 });
  // **被自动决策的人自己**也必须看到气泡——他才是最需要知道"系统替我做了什
  // 么"的那个人。前面两条断言的都是旁观视角，漏了这个最关键的视角。
  await expect(actorPage.locator(S.bubble).filter({ hasText: '弃牌' })).toHaveCount(1, { timeout: 5000 });

  await ctxA.close();
  await ctxB.close();
});

test('倒计时到点自动过牌 → 动作气泡照常出现（牌局继续，不是结束）', async ({ browser }) => {
  test.setTimeout(120000);
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

  // 手动打到翻牌圈：小盲跟注 → 大盲过牌
  let actor = (await pA.locator(S.actionBar).isVisible()) ? pA : pB;
  await actor.locator('.b-call').click();
  const other = actor === pA ? pB : pA;
  await other.locator('.b-check').waitFor({ state: 'visible', timeout: 10000 });
  await other.locator('.b-check').click();

  // 翻牌圈第一个行动的人什么都不做，等倒计时到点自动过牌
  const observer = other === pA ? pB : pA;
  // 先等进入翻牌圈、且上一街的气泡已被清空。不做这一步的话，断言会命中大盲
  // **手动**过牌留下的那个气泡，测试在 10 秒内就"通过"，压根没等到自动过牌
  // ——一个假阳性比没有测试更糟。
  // 气泡清空只在换街时发生，所以这一条同时证明了"已经进入翻牌圈"。
  await expect(observer.locator(S.bubble)).toHaveCount(0, { timeout: 15000 });

  // 此时再出现的过牌气泡，只可能来自倒计时到点的自动过牌
  await expect(observer.locator(S.bubble).filter({ hasText: '过牌' })).toHaveCount(1, { timeout: 40000 });
  // 牌局必须继续，不该因此结束
  await expect(observer.locator('.settlement-sheet')).toHaveCount(0);

  await ctxA.close();
  await ctxB.close();
});

test('倒计时视觉：环形描边渲染且在走，不与旧的呼吸边框叠加', async ({ browser }) => {
  test.setTimeout(90000);
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
  const observer = (await pA.locator(S.actionBar).isVisible()) ? pB : pA;

  // 底环（走完的轨迹）+ 走动的描边，两条都要在，才看得出"走了多少"
  await expect(observer.locator('.turn-ring-track')).toHaveCount(1, { timeout: 10000 });
  const ring = observer.locator('.turn-ring-progress');
  await expect(ring).toHaveCount(1);

  // 环必须真的在走：隔一段时间取两次 stroke-dashoffset，第二次应当更大
  const read = () => ring.evaluate(el => parseFloat(getComputedStyle(el).strokeDashoffset));
  const first = await read();
  await observer.waitForTimeout(2500);
  const second = await read();
  expect(second).toBeGreaterThan(first);

  // 旧的盖脸数字方块不该再出现在计时状态下
  await expect(observer.locator('.think-overlay')).toHaveCount(0);
  // 也不该同时挂着 is-active 的呼吸边框
  await expect(observer.locator('.seat.is-active')).toHaveCount(0);
  await expect(observer.locator('.seat.is-timed')).toHaveCount(1);

  // issue #17：走线环跟数字倒计时曾经对不上——环用的 stroke-dasharray
  // (232) 比真实描边路径长度（getTotalLength() 实测约 208.18）大了约
  // 11%，导致 stroke-dashoffset 走到「真实路径长度」时环就已经视觉上完全
  // 走空，而这时动画时长（跟数字倒计时同源）还没走完，数字还剩好几秒。
  // 用真实 20 秒生产配置轮询到环视觉走空（dashoffset 逼近 dasharray）的
  // 那一刻，此时数字倒计时必须也已经接近 0——否则就是这条对不上的 bug。
  const readSecs = () => observer.locator('.turn-secs').textContent();
  const readRingState = () => ring.evaluate(el => {
    const cs = getComputedStyle(el);
    return { offset: parseFloat(cs.strokeDashoffset), dasharray: parseFloat(cs.strokeDasharray) };
  });
  let drainedAtSecs = null;
  for (let i = 0; i < 40; i++) {
    const { offset, dasharray } = await readRingState();
    if (offset >= dasharray * 0.99) {
      drainedAtSecs = Number((await readSecs()).replace(/[^\d]/g, ''));
      break;
    }
    await observer.waitForTimeout(500);
  }
  expect(drainedAtSecs).not.toBeNull();
  expect(drainedAtSecs).toBeLessThanOrEqual(2);

  await ctxA.close();
  await ctxB.close();
});
