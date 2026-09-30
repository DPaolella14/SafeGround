// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * SafeGround Playwright config.
 *  npm test          → full suite with mocked USGS / NWS data (fast, deterministic, works offline)
 *  npm run test:live → smoke test against the REAL USGS & NWS feeds (needs internet)
 */
module.exports = defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    geolocation: { latitude: 34.0522, longitude: -118.2437 }, // Los Angeles
  },
  projects: [
    { name: 'chromium', testIgnore: /(live|mobile)\.spec\.js/, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', testIgnore: /live\.spec\.js/, testMatch: /mobile\.spec\.js/, use: { ...devices['Pixel 7'] } },
    { name: 'live', testMatch: /live\.spec\.js/, retries: 1, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: 'node scripts/serve.js 4173',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
});
