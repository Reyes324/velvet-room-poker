// 麦克风自检页（/voice-check）的回归测试。
//
// 这一页存在的意义是"给出可信的结论"，所以测试的重点不是它能渲染出来，而是
// **它在能用的环境下会不会漏报、在不能用的环境下会不会误报**——这页要是给出
// 假结论，比没有这页更糟：用户会据此决定要不要投入整个语音功能的开发。
//
// Chromium 的 fake media device 会持续播一段正弦音，所以三条关键链路（拿到
// 麦克风 → 麦克风收到声音 → 声音穿过一条真实的 WebRTC 连接回来）都能在
// headless 下真跑一遍，而不是 mock 掉。
const { test, expect } = require('@playwright/test');

// 假麦克风的浏览器开关在 playwright.config.js 的 use.launchOptions 里 ——
// **不要**挪到这里的 test.use()：那是整体替换而非合并，会把配置级的其他
// launchOptions（比如本地指定的 executablePath）一起冲掉。这里只声明本
// 文件额外需要的权限授予。
test.use({ permissions: ['microphone'] });

test.describe('麦克风自检页', () => {
  test('环境能力检查在支持的浏览器下全部通过', async ({ page }) => {
    await page.goto('/voice-check');
    await expect(page.locator('.vc-title')).toHaveText('麦克风自检');

    // 静态检查项应当在真实 Chromium 下全绿。任何一项报 ✕ 都说明检查逻辑
    // 本身写错了（误报），而不是环境有问题。
    const bad = page.locator('.vc-section .vc-check--bad');
    await expect(bad).toHaveCount(0);
    await expect(page.locator('.vc-check--ok')).not.toHaveCount(0);
  });

  test('还没点检测之前不给任何结论', async ({ page }) => {
    await page.goto('/voice-check');
    // 结论区必须等真的测过才出现——先给结论再测，正是这页要避免的事。
    await expect(page.locator('.vc-verdict')).toHaveCount(0);
    await expect(page.locator('.vc-meter')).toHaveCount(0);
  });

  test('点击检测后：拿到麦克风 → 收到声音 → 声音穿过真实连接回来', async ({ page }) => {
    await page.goto('/voice-check');
    await page.locator('.vc-btn', { hasText: '开始检测' }).click();

    // ① 权限
    await expect(page.locator('.vc-result--ok')).toContainText('麦克风权限拿到了');

    // ② 本机音量条真的动了。断言的是"峰值刻线离开了 0"，不是"元素存在"——
    //    条子不动恰恰是这页要抓的那种失败（权限给了但收不到声音）。
    const localPeak = page.locator('.vc-meter').first().locator('.vc-meter-peak');
    await expect.poll(
      async () => parseFloat((await localPeak.getAttribute('style') ?? '').match(/left:\s*([\d.]+)%/)?.[1] ?? '0'),
      { timeout: 15000, message: '麦克风音量条始终没动，说明没真的收到声音' },
    ).toBeGreaterThan(0);

    // ③ 本机自环连接建起来了
    await expect(page.locator('.vc-tag--ok').first()).toHaveText('已连通');

    // ④ 最强的一条：声音穿过 WebRTC 连接之后回来了，远端条子也动了。
    //    这才是"语音真的能用"的判据，前面几条单独成立都不够。
    const remoteMeter = page.locator('.vc-meter', { hasText: '穿过连接后回来的声音' });
    await expect(remoteMeter).toBeVisible();
    await expect.poll(
      async () => parseFloat((await remoteMeter.locator('.vc-meter-peak').getAttribute('style') ?? '').match(/left:\s*([\d.]+)%/)?.[1] ?? '0'),
      { timeout: 15000, message: '远端音量条没动，说明音频没真的穿过连接' },
    ).toBeGreaterThan(0);

    // 结论必须等 STUN 也跑完才是终局的——本机自环只证明"这台设备上 WebRTC
    // 能用"，证明不了两台设备之间连得上。
    await expect(page.locator('.vc-stun .vc-tag')).toHaveText('完成', { timeout: 20000 });

    // 这里刻意**按实际结果分支**，而不是无脑断言全绿：STUN/TURN 可达性取决于跑
    // 测试的网络（沙箱/CI 常常出不去 UDP），写死"必须全绿"会变成一条跟着
    // 网络环境随机红的测试。真正要守住的不变式是"结论如实反映测出来的东西"。
    //
    // 三分支对应真机实测教给我们的三种处境：中继可用 → 跨网络有兜底，能做；
    // 只有直连可用 → 同网络能用、跨网络没着落（真机第二轮实测到的正是这一档）；
    // 都不可用 → 网络这关整个没过。
    const directOk = await page.locator('.vc-stun-group--direct .vc-check--ok').count();
    const relayOk = await page.locator('.vc-stun-group--relay .vc-check--ok').count();
    if (relayOk > 0) {
      await expect(page.locator('.vc-verdict--ok')).toContainText('可以做语音对讲');
    } else if (directOk > 0) {
      await expect(page.locator('.vc-verdict--warn')).toContainText('跨网络还没着落');
    } else {
      await expect(page.locator('.vc-verdict--warn')).toContainText('网络这一关没过');
    }
    // 无论网络如何，都不该出现"用不了"——麦克风和连接这两关明明过了。
    await expect(page.locator('.vc-verdict--bad')).toHaveCount(0);

    // 这里是 JSX 不是 markdown，写 ** 会原样显示给用户看（真机截图里抓到过
    // 一次）。结论文案是这页最该讲人话的地方，留一条守卫。
    await expect(page.locator('.vc-verdict-body')).not.toContainText('**');
  });

  test('诊断报告带上真实测试数据，不是空模板', async ({ page }) => {
    await page.goto('/voice-check');
    await page.locator('.vc-btn', { hasText: '开始检测' }).click();
    await expect(page.locator('.vc-verdict')).toBeVisible();

    const report = page.locator('.vc-report');
    await expect(report).toContainText('翡翠厅 麦克风自检结果');
    await expect(report).toContainText('麦克风权限：OK');
    // 直连和中继必须分开列——用户把报告发回来时，"直连不行"和"连中继都不行"
    // 对应完全不同的下一步，混在一起等于没测。
    await expect(report).toContainText('[STUN 直连穿透]');
    await expect(report).toContainText('[TURN 中继（跨网络时的兜底）]');
    // 峰值必须是真实测出来的数字，不能停在 0.000——否则用户把报告发回来
    // 我也判断不了任何东西。
    await expect.poll(
      async () => {
        const text = await report.inputValue();
        return parseFloat(text.match(/麦克风收到声音峰值：([\d.]+)/)?.[1] ?? '0');
      },
      { timeout: 15000 },
    ).toBeGreaterThan(0);
  });
});
