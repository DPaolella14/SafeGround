// Mobile layout checks (runs in the "mobile" project — Pixel 7 viewport).
const { test, expect } = require('@playwright/test');
const { mockApis, openApp } = require('./helpers');

test('mobile: map on top, panel below, no horizontal scroll', async ({ page }) => {
  await mockApis(page);
  await openApp(page);
  const map = await page.locator('.map-wrap').boundingBox();
  const panel = await page.locator('.panel').boundingBox();
  expect(map.width).toBeGreaterThan(300);
  expect(panel.y).toBeGreaterThanOrEqual(map.y + map.height - 1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.locator('#quakeList .quake')).toHaveCount(7);
});

test('mobile: tabs and quake details work by tap', async ({ page }) => {
  await mockApis(page);
  await openApp(page);
  await page.locator('#quakeList .quake', { hasText: 'Japan' }).tap();
  await expect(page.locator('#detail')).toBeVisible();
  await expect(page.locator('#detail')).toContainText('Mito, Japan');
  await page.locator('#detailClose').tap();
  await page.locator('#tabbtn-prepare').tap();
  await expect(page.locator('#prepPct')).toBeVisible();
});
