const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 30000,
  expect: { timeout: 8000 },
  fullyParallel: false, // multiplayer tests share server state
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3001',
    trace: 'on-first-retry',
    // 假麦克风：语音相关的用例（e2e/voiceCheck.spec.js）要真的跑一遍
    // getUserMedia → WebRTC → 收到音频这条链路，headless 下没有真实录音
    // 设备就跑不了。Chromium 的 fake device 会持续播一段正弦音，所以音量
    // 条能真的动起来，而不是把音频 mock 掉。
    //
    // 放在这里而不是单个 spec 的 test.use() 里：test.use({ launchOptions })
    // 是**整体替换**配置级的 launchOptions，不是合并——写在 spec 里会把
    // 别处（以及本地调试时）设的 executablePath 之类一并冲掉。
    // 对不碰麦克风的用例这两个开关没有任何作用，不影响既有测试。
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  webServer: {
    command: 'node server/index.js',
    url: 'http://localhost:3001/health',
    reuseExistingServer: true,
    env: { PORT: '3001' },
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
