// LIVE smoke test — talks to the real USGS and NWS APIs. Needs an internet connection.
// Run with:  npm run test:live
const { test, expect } = require('@playwright/test');

test('live: real USGS earthquakes load and render', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('#liveStatus')).toHaveAttribute('data-state', 'live', { timeout: 25_000 });
  const count = await page.evaluate(() => window.SafeGround.state.dayQuakes.length);
  console.log(`USGS past-day feed returned ${count} earthquakes`);
  expect(count).toBeGreaterThan(0); // there are always earthquakes somewhere in the last 24h
  await expect(page.locator('#quakeList .quake').first()).toBeVisible();
  await expect(page.locator('#statCount')).not.toHaveText('–');
  expect(errors).toEqual([]);
});

test('live: NWS alerts endpoint responds', async ({ page }) => {
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => window.SafeGround.state.nwsLoadedOnce), { timeout: 25_000 }).toBe(true);
  const n = await page.evaluate(() => window.SafeGround.state.nwsSevere.length);
  console.log(`NWS reports ${n} active Extreme/Severe alerts`);
  await expect(page.locator('#statNws')).not.toHaveText('–');
});

test('live: map tiles load', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.leaflet-tile-loaded').first()).toBeVisible({ timeout: 20_000 });
});
