// 双机连通性实测页（/voice-pair）的回归测试。
//
// 这个文件是整个语音功能里**最重要的一条测试**，理由见设计文档：/voice-check
// 的本机自环是"同一个页面自己跟自己连"，证明不了两台独立设备之间连得上。这里
// 用两个**互相独立的浏览器上下文**（各自的进程状态、各自的 socket 连接），经真
// 实的服务端信令建连，再断言声音真的从一端流到了另一端。
//
// 也就是说：这条测试跑绿 = 信令编排 + 建连 + 音频收发这条链路是通的。真机上
// 万一还是连不上，就能把问题范围直接收窄到"网络环境/微信内核"，而不用怀疑我们
// 自己的实现——这正是它值得写的原因。
//
// 假麦克风的浏览器开关在 playwright.config.js 的 use.launchOptions 里。
const { test, expect } = require('@playwright/test');

test.use({ permissions: ['microphone'] });

// 两端建连要等 SDP 往返 + ICE 候选交换，比单页自环慢；本地环境通常 2-3 秒，
// 给到 30 秒是为了慢机器上不假失败。
const CONNECT_TIMEOUT = 30000;

// 每条用例用不同的暗号，避免同一个 server 上跑多条时互相串房间。
let seq = 0;
const nextCode = () => String(1000 + (seq++ % 8999));

async function openPair(browser, code) {
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  await page.goto(`/voice-pair?code=${code}`);
  return { ctx, page };
}

test.describe('双机语音实测页', () => {
  test('URL 里带的暗号会被读进来——微信里发链接对方点开就能直接用', async ({ page }) => {
    await page.goto('/voice-pair?code=7788');
    await expect(page.locator('.vp-code-input')).toHaveValue('7788');
    // 邀请链接要能原样发出去
    await expect(page.locator('.vp-invite-url')).toContainText('/voice-pair?code=7788');
  });

  test('还没点开始之前不下任何结论', async ({ page }) => {
    await page.goto('/voice-pair');
    await expect(page.locator('.vc-verdict')).toHaveCount(0);
    await expect(page.locator('.vp-phase')).toHaveText('还没开始');
  });

  test('两个独立浏览器之间真的连上，并且声音从一端传到了另一端', async ({ browser }) => {
    const code = nextCode();
    const a = await openPair(browser, code);
    const b = await openPair(browser, code);

    // 先到的人点开始 → 应当进入"等对方"，而不是自作主张发起连接
    await a.page.locator('.vp-start').click();
    await expect(a.page.locator('.vp-phase')).toHaveText('已就位，等对方点开始…');

    // 后到的人点开始 → 由他发起
    await b.page.locator('.vp-start').click();

    await expect(a.page.locator('.vp-phase')).toHaveText('已连接 ✓', { timeout: CONNECT_TIMEOUT });
    await expect(b.page.locator('.vp-phase')).toHaveText('已连接 ✓', { timeout: CONNECT_TIMEOUT });

    // **最关键的断言**：对方的声音条真的动了。连上了但没有声音，正是这一整套
    // 自检要防的假阳性——两边都要验，不能只验一头。
    const remoteMeterA = a.page.locator('.vc-meter').nth(1);
    const remoteMeterB = b.page.locator('.vc-meter').nth(1);
    await expect(remoteMeterA).toContainText('已经检测到声音', { timeout: CONNECT_TIMEOUT });
    await expect(remoteMeterB).toContainText('已经检测到声音', { timeout: CONNECT_TIMEOUT });

    // 结论区要在这种情况下给出正面结论，且必须保留"以耳朵为准"这句——
    // 音量条在 iPhone 上可能不准，这句话不是客套，是这页的判据声明。
    await expect(a.page.locator('.vc-verdict--ok')).toContainText('收到对方的声音');
    await expect(a.page.locator('.vc-verdict')).toContainText('最终以耳朵为准');

    await a.ctx.close();
    await b.ctx.close();
  });

  test('连上之后能读出真正走的连接路径——这决定了朋友之间隔着不同网络行不行', async ({ browser }) => {
    const code = nextCode();
    const a = await openPair(browser, code);
    const b = await openPair(browser, code);
    await a.page.locator('.vp-start').click();
    await b.page.locator('.vp-start').click();
    await expect(a.page.locator('.vp-phase')).toHaveText('已连接 ✓', { timeout: CONNECT_TIMEOUT });

    // 本地环境走的是 host↔host，真机跨网络时应当出现 srflx。这里只断言这项
    // **确实被读出来了**，不断言具体值——值本身是实测时要看的信息。
    await expect(a.page.locator('.vp-line').filter({ hasText: '走的路径' })).toBeVisible({ timeout: CONNECT_TIMEOUT });

    await a.ctx.close();
    await b.ctx.close();
  });

  test('对方离开时如实告知，而不是继续显示"已连接"', async ({ browser }) => {
    const code = nextCode();
    const a = await openPair(browser, code);
    const b = await openPair(browser, code);
    await a.page.locator('.vp-start').click();
    await b.page.locator('.vp-start').click();
    await expect(a.page.locator('.vp-phase')).toHaveText('已连接 ✓', { timeout: CONNECT_TIMEOUT });

    await b.ctx.close();
    await expect(a.page.locator('.vp-phase')).toHaveText('已就位，等对方点开始…', { timeout: CONNECT_TIMEOUT });
    await expect(a.page.locator('.vp-status')).toContainText('对方断开了');

    await a.ctx.close();
  });

  test('第三个人进同一个暗号时拿到明确错误，而不是一个说不清的半连接', async ({ browser }) => {
    // 这条要开三个浏览器上下文，是本文件里最重的一条。默认 30 秒在慢环境下
    // 光是三次 page.goto 就用光了（实测某些环境单次 goto 就要十几秒），失败
    // 原因与被测行为无关。放宽到 90 秒——这是环境余量，不是在掩盖慢。
    test.setTimeout(90000);
    const code = nextCode();
    const a = await openPair(browser, code);
    const b = await openPair(browser, code);
    await a.page.locator('.vp-start').click();
    await b.page.locator('.vp-start').click();
    await expect(a.page.locator('.vp-phase')).toHaveText('已连接 ✓', { timeout: CONNECT_TIMEOUT });

    const c = await openPair(browser, code);
    await c.page.locator('.vp-start').click();
    await expect(c.page.locator('.vp-phase')).toHaveText('出错了', { timeout: CONNECT_TIMEOUT });
    await expect(c.page.locator('.vp-status')).toContainText('两个人');

    await a.ctx.close();
    await b.ctx.close();
    await c.ctx.close();
  });
});
