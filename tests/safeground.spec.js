// SafeGround end-to-end tests (mocked data — deterministic and offline-safe).
const { test, expect } = require('@playwright/test');
const path = require('path');
const { mockApis, openApp, seedStorage, dayQuakes, arrivals, SF_HOME } = require('./helpers');

test.describe('Loading & live data', () => {
  test('loads the app, shows LIVE status, stats and the earthquake list', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await mockApis(page);
    await openApp(page);

    await expect(page).toHaveTitle(/SafeGround/);
    await expect(page.locator('#liveLabel')).toHaveText('LIVE');
    await expect(page.locator('#updatedAgo')).toContainText('Updated');
    await expect(page.locator('#statCount')).toHaveText('7');
    await expect(page.locator('#statCountSub')).toHaveText('3 in the past hour');
    await expect(page.locator('#statMax')).toHaveText('M6.4');
    await expect(page.locator('#statMaxSub')).toContainText('Chile');
    await expect(page.locator('#quakeList .quake')).toHaveCount(7);
    await expect(page.locator('#listCount')).toHaveText('7 earthquakes · past 24 hours');
    // Newest first by default
    await expect(page.locator('#quakeList .quake').first()).toContainText('Volcano, Hawaii');
    expect(errors).toEqual([]);
  });

  test('renders the map, legend and 24-hour activity timeline', async ({ page }) => {
    await mockApis(page);
    await openApp(page);
    await expect(page.locator('#map.leaflet-container')).toBeVisible();
    await expect(page.locator('.leaflet-control-zoom-in')).toBeVisible();
    await expect(page.locator('#legend')).toBeVisible();
    await expect(page.locator('#timeline rect')).toHaveCount(24);
    // Recent quakes (< 1h, M2.5+) pulse on the map so it feels alive
    await expect(page.locator('.quake-pulse').first()).toBeAttached();
    // NWS polygons drawn (2 severe alerts with geometry)
    const nwsCount = await page.evaluate(() => window.SafeGround.state.nwsSevere.length);
    expect(nwsCount).toBe(2);
    await expect(page.locator('#statNws')).toHaveText('2');
  });

  test('works when opened straight from disk (file://)', async ({ page }) => {
    await mockApis(page);
    const fileUrl = 'file://' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
    await page.goto(fileUrl);
    await expect(page.locator('#liveStatus')).toHaveAttribute('data-state', 'live');
    await expect(page.locator('#quakeList .quake')).toHaveCount(7);
  });

  test('refresh brings in new quakes, flags them NEW and toasts big ones', async ({ page }) => {
    const ctl = await mockApis(page);
    await openApp(page);
    ctl.day = dayQuakes().concat(arrivals());
    await page.locator('#refreshBtn').click();

    await expect(page.locator('#statCount')).toHaveText('9');
    const newItems = page.locator('#quakeList .quake.is-new');
    await expect(newItems).toHaveCount(2);
    await expect(page.locator('#quakeList .tag-new')).toHaveCount(2);
    await expect(page.locator('.toast', { hasText: 'New M6.1 earthquake' })).toBeVisible();
  });

  test('auto-refreshes on its own timer', async ({ page }) => {
    const ctl = await mockApis(page);
    await openApp(page, '/?refresh=5');
    await expect(page.locator('#countdownText')).toHaveText(/^[0-5]$/);
    ctl.day = dayQuakes().concat(arrivals());
    await expect(page.locator('#statCount')).toHaveText('9', { timeout: 12_000 });
  });

  test('shows an error banner when USGS is down and recovers on retry', async ({ page }) => {
    const ctl = await mockApis(page);
    ctl.usgsStatus = 503;
    await page.goto('/');
    await expect(page.locator('#errorBanner')).toBeVisible();
    await expect(page.locator('#liveLabel')).toHaveText('OFFLINE');
    await expect(page.locator('#quakeList')).toContainText('couldn’t load the USGS feed');
    ctl.usgsStatus = 200;
    await page.locator('#errorRetry').click();
    await expect(page.locator('#errorBanner')).toBeHidden();
    await expect(page.locator('#liveLabel')).toHaveText('LIVE');
    await expect(page.locator('#quakeList .quake')).toHaveCount(7);
  });
});

test.describe('Filtering & details', () => {
  test('filters by magnitude and place text', async ({ page }) => {
    await mockApis(page);
    await openApp(page);
    await page.locator('#magSelect').selectOption('2.5');
    await expect(page.locator('#quakeList .quake')).toHaveCount(5);
    await page.locator('#magSelect').selectOption('6');
    await expect(page.locator('#quakeList .quake')).toHaveCount(1);
    await page.locator('#magSelect').selectOption('0');
    await page.locator('#searchInput').fill('alaska');
    await expect(page.locator('#quakeList .quake')).toHaveCount(1);
    await page.locator('#searchInput').fill('nowhere-at-all');
    await expect(page.locator('#quakeList')).toContainText('No earthquakes match');
  });

  test('sorts by largest', async ({ page }) => {
    await mockApis(page);
    await openApp(page);
    await page.locator('#sortSelect').selectOption('largest');
    await expect(page.locator('#quakeList .quake .mag-badge').first()).toHaveText('6.4');
    await expect(page.locator('#quakeList .quake .mag-badge').nth(1)).toHaveText('5.8');
  });

  test('switching the time window loads the matching USGS feed', async ({ page }) => {
    const ctl = await mockApis(page);
    await openApp(page);
    await page.locator('#windowSelect').selectOption('week');
    await expect(page.locator('#listCount')).toHaveText('6 earthquakes · past 7 days');
    expect(ctl.requests.some((u) => u.includes('2.5_week.geojson'))).toBeTruthy();
    await page.locator('#windowSelect').selectOption('hour');
    await expect(page.locator('#listCount')).toHaveText('3 earthquakes · past hour');
    await page.locator('#windowSelect').selectOption('month');
    await expect(page.locator('#listCount')).toHaveText('4 earthquakes · past 30 days');
  });

  test('clicking a quake opens a detail card with USGS link; Escape closes it', async ({ page }) => {
    await mockApis(page);
    await openApp(page);
    await page.locator('#quakeList .quake', { hasText: 'Chile' }).click();
    const detail = page.locator('#detail');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('Valparaíso');
    await expect(detail).toContainText('Tsunami');
    await expect(detail).toContainText('PAGER yellow');
    await expect(detail.locator('a', { hasText: 'USGS event page' })).toHaveAttribute('href', /eventpage\/tst_chile/);
    await expect(page.locator('#quakeList .quake.selected')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(detail).toBeHidden();
  });
});

test.describe('Home, saved areas & alerts', () => {
  test('set home by search → nearest stat, near-home tags and alerts', async ({ page }) => {
    await mockApis(page);
    await openApp(page);
    await page.locator('#tabbtn-places').click();
    await page.locator('#homeSearch').fill('San Francisco');
    await page.locator('#homeSearchForm button[type=submit]').click();
    await page.locator('#homeResults button', { hasText: 'San Francisco' }).click();

    await expect(page.locator('#homeName')).toContainText('San Francisco');
    await expect(page.locator('#statNear')).toHaveText(/\d+ km/);
    await expect(page.locator('#statNearSub')).toContainText('M1.2');
    await expect(page.locator('.home-pin')).toBeAttached();

    // Hollister M4.6 (≈135 km) + Heat Advisory at home → 2 alerts
    await expect(page.locator('#alertBadge')).toHaveText('2');
    await page.locator('#tabbtn-alerts').click();
    await expect(page.locator('#alertList .alert-item')).toHaveCount(2);
    await expect(page.locator('#alertList')).toContainText('M4.6 earthquake near Home');
    await expect(page.locator('#alertList')).toContainText('Heat Advisory');
    await page.locator('#tabbtn-live').click();
    await expect(page.locator('#quakeList .tag-near')).toHaveCount(2); // Hollister + Geysers within 250 km
  });

  test('a new nearby quake triggers a toast and bumps the badge', async ({ page }) => {
    const ctl = await mockApis(page);
    await seedStorage(page, { home: SF_HOME });
    await openApp(page);
    await expect(page.locator('#alertBadge')).toHaveText('2');
    ctl.day = dayQuakes().concat(arrivals());
    await page.locator('#refreshBtn').click();
    await expect(page.locator('.toast', { hasText: 'M3.4 earthquake near Home' })).toBeVisible();
    await expect(page.locator('#alertBadge')).toHaveText('3');
    await page.locator('#tabbtn-alerts').click();
    await page.locator('#markReadBtn').click();
    await expect(page.locator('#alertBadge')).toBeHidden();
  });

  test('clicking an NWS alert expands its details', async ({ page }) => {
    await mockApis(page);
    await seedStorage(page, { home: SF_HOME });
    await openApp(page);
    await page.locator('#tabbtn-alerts').click();
    const heat = page.locator('#alertList .alert-item', { hasText: 'Heat Advisory' });
    await heat.click();
    await expect(page.locator('#alertList .alert-item.open')).toContainText('Hot temperatures up to 98');
    await expect(page.locator('#nwsList .alert-item')).toHaveCount(2);
    await expect(page.locator('#nwsList .alert-item').first()).toContainText('Tornado Warning'); // Extreme sorts first
  });

  test('set home with geolocation', async ({ page, context }) => {
    await context.grantPermissions(['geolocation']);
    await mockApis(page);
    await openApp(page);
    await page.locator('#tabbtn-places').click();
    await page.locator('#homeGeoBtn').click();
    await expect(page.locator('#homeName')).toHaveText('Pinned City, Test State');
    const home = await page.evaluate(() => window.SafeGround.state.home);
    expect(home.lat).toBeCloseTo(34.0522, 3);
  });

  test('pick home on the map', async ({ page }) => {
    await mockApis(page);
    await openApp(page);
    await page.locator('#tabbtn-places').click();
    await page.locator('#homePickBtn').click();
    await expect(page.locator('#pickBanner')).toBeVisible();
    const box = await page.locator('#map').boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.6);
    await expect(page.locator('#pickBanner')).toBeHidden();
    await expect(page.locator('#homeName')).toHaveText('Pinned City, Test State');
  });

  test('add, edit, persist and delete a saved area', async ({ page }) => {
    await mockApis(page);
    await openApp(page);
    await page.locator('#tabbtn-places').click();
    await page.locator('#addAreaBtn').click();
    await page.locator('#areaSearch').fill('Tokyo');
    await page.locator('#areaSearchBtn').click();
    await page.locator('#areaResults button', { hasText: 'Tokyo' }).click();
    await expect(page.locator('#areaName')).toHaveValue('Tokyo');
    await page.locator('#areaName').fill('Aunt in Tokyo');
    await page.locator('#areaRadius').fill('500');
    await page.locator('#areaSave').click();

    const card = page.locator('#areaList .place-card', { hasText: 'Aunt in Tokyo' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('500 km · M2.5+ · 1 active alert'); // Japan M5.8 ≈ 50 km away
    await expect(page.locator('#alertBadge')).toHaveText('1');

    await page.reload();
    await page.locator('#tabbtn-places').click();
    await expect(page.locator('#areaList .place-card', { hasText: 'Aunt in Tokyo' })).toBeVisible();

    await page.locator('#areaList [data-edit]').click();
    await page.locator('#areaMinMag').selectOption('6');
    await page.locator('#areaSave').click();
    await expect(page.locator('#areaList .place-card')).toContainText('M6+ · 0 active alerts');

    await page.locator('#areaList [data-delete]').click();
    await expect(page.locator('#areaList .place-card')).toHaveCount(0);
  });

  test('area form requires a location', async ({ page }) => {
    await mockApis(page);
    await openApp(page);
    await page.locator('#tabbtn-places').click();
    await page.locator('#addAreaBtn').click();
    await page.locator('#areaName').fill('Somewhere');
    await page.locator('#areaSave').click();
    await expect(page.locator('#areaCoords')).toContainText('Choose a location');
    await expect(page.locator('#areaList .place-card')).toHaveCount(0);
  });
});

test.describe('Preparedness checklist', () => {
  test('check items, add custom items, progress persists', async ({ page }) => {
    await mockApis(page);
    await openApp(page);
    await page.locator('#tabbtn-prepare').click();
    const total = await page.locator('#checklist input[type=checkbox]').count();
    expect(total).toBeGreaterThan(15);
    await expect(page.locator('#prepPct')).toHaveText('0%');

    await page.locator('.check-item', { hasText: 'First aid kit' }).locator('input').check();
    await page.locator('.check-item', { hasText: 'Water: 1 gallon' }).locator('input').check();
    await expect(page.locator('#prepCount')).toHaveText(`2 of ${total} ready`);

    await page.locator('#customItem').fill('Spare glasses');
    await page.locator('#customItemForm button').click();
    await expect(page.locator('.check-item', { hasText: 'Spare glasses' })).toBeVisible();
    await expect(page.locator('#prepCount')).toHaveText(`2 of ${total + 1} ready`);

    await page.reload();
    await page.locator('#tabbtn-prepare').click();
    await expect(page.locator('#prepCount')).toHaveText(`2 of ${total + 1} ready`);
    await expect(page.locator('.check-item', { hasText: 'First aid kit' }).locator('input')).toBeChecked();

    await page.locator('.check-item', { hasText: 'Spare glasses' }).locator('.remove').click();
    await expect(page.locator('.check-item', { hasText: 'Spare glasses' })).toHaveCount(0);

    page.once('dialog', (d) => d.accept());
    await page.locator('#resetChecklist').click();
    await expect(page.locator('#prepPct')).toHaveText('0%');
  });
});

test.describe('Preferences', () => {
  test('theme and units toggle and persist', async ({ page }) => {
    await mockApis(page);
    await seedStorage(page, { home: SF_HOME });
    await openApp(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.locator('#themeBtn').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    await expect(page.locator('#statNear')).toHaveText(/km$/);
    await page.locator('#unitsBtn').click();
    await expect(page.locator('#unitsBtn')).toHaveText('mi');
    await expect(page.locator('#statNear')).toHaveText(/mi$/);

    await page.reload();
    await page.locator('#liveStatus[data-state="live"]').waitFor();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('#statNear')).toHaveText(/mi$/);
  });
});

test.describe('Map tiles', () => {
  test('uses keyless Esri basemap tiles (no CARTO / API-key providers)', async ({ page }) => {
    const ctl = await mockApis(page);
    await openApp(page);
    await expect(page.locator('.leaflet-tile-loaded').first()).toBeAttached();
    expect(ctl.tileRequests.some((u) => u.includes('server.arcgisonline.com'))).toBeTruthy();
    const html = await page.content();
    expect(html).not.toContain('cartocdn');
  });

  test('map style switcher changes basemap and remembers it', async ({ page }) => {
    const ctl = await mockApis(page);
    await openApp(page);
    await expect(page.locator('#basemapSwitch [data-basemap="dark"]')).toHaveAttribute('aria-checked', 'true');
    ctl.tileRequests.length = 0;
    await page.locator('#basemapSwitch [data-basemap="satellite"]').click();
    await expect(page.locator('#basemapSwitch [data-basemap="satellite"]')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => ctl.tileRequests.some((u) => u.includes('World_Imagery'))).toBeTruthy();
    await page.reload();
    await page.locator('#liveStatus[data-state="live"]').waitFor();
    await expect(page.locator('#basemapSwitch [data-basemap="satellite"]')).toHaveAttribute('aria-checked', 'true');
  });

  test('falls back to OpenStreetMap if Esri tiles fail', async ({ page }) => {
    const ctl = await mockApis(page, { esriStatus: 403 });
    await openApp(page);
    await expect(page.locator('.toast', { hasText: 'Switched map provider' })).toBeVisible();
    expect(ctl.tileRequests.some((u) => u.includes('tile.openstreetmap.org'))).toBeTruthy();
  });
});

test.describe('Guidance & navigation', () => {
  test('first visit shows the welcome guide; "Set my home" jumps to Places', async ({ page }) => {
    await mockApis(page, { firstVisit: true });
    await page.goto('/');
    const modal = page.locator('#welcome');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Welcome to SafeGround');
    await page.locator('#welcomeSetHome').click();
    await expect(modal).toBeHidden();
    await expect(page.locator('#tab-places')).toBeVisible();
    await expect(page.locator('#homeSection')).toHaveClass(/highlight/);
    // Not shown again after reload
    await page.reload();
    await page.locator('#liveStatus[data-state="live"]').waitFor();
    await expect(modal).toBeHidden();
  });

  test('Help button reopens the guide; Escape closes it', async ({ page }) => {
    await mockApis(page);
    await openApp(page);
    await expect(page.locator('#welcome')).toBeHidden();
    await page.locator('#helpBtn').click();
    await expect(page.locator('#welcome')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#welcome')).toBeHidden();
  });

  test('getting-started steps track progress and can be dismissed', async ({ page }) => {
    await mockApis(page);
    await openApp(page);
    const card = page.locator('#setupCard');
    await expect(card).toBeVisible();
    await expect(page.locator('#setupProgress')).toHaveText('0 of 3 done');
    await page.locator('[data-setup="home"]').click();
    await expect(page.locator('#tab-places')).toBeVisible();
    await page.locator('#homeSearch').fill('San Francisco');
    await page.locator('#homeSearchForm button[type=submit]').click();
    await page.locator('#homeResults button').first().click();
    await page.locator('#tabbtn-live').click();
    await expect(page.locator('#setupProgress')).toHaveText('1 of 3 done');
    await page.locator('#setupDismiss').click();
    await expect(card).toBeHidden();
  });

  test('summary cards on the map are shortcuts', async ({ page }) => {
    await mockApis(page);
    await openApp(page);
    await page.locator('#statMaxBtn').click();
    await expect(page.locator('#detail')).toContainText('Valparaíso');
    await page.keyboard.press('Escape');
    await page.locator('#statNearBtn').click(); // no home yet → goes to Places
    await expect(page.locator('#tab-places')).toBeVisible();
    await page.locator('#statNwsBtn').click();
    await expect(page.locator('#tab-alerts')).toBeVisible();
  });

  test('header shows when the next update happens', async ({ page }) => {
    await mockApis(page);
    await openApp(page);
    await expect(page.locator('#refreshLabel')).toHaveText(/Next update in \d+s/);
  });
});
