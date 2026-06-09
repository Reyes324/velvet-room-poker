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
