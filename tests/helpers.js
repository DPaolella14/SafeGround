// Shared test helpers: realistic mock data for USGS, NWS and Nominatim, generated relative to "now"
// so the app's time-based logic (past hour, past 24h, "new") behaves exactly as it would live.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// 1x1 transparent PNG used for map tiles so tests never depend on the tile CDN.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

function quake(id, mag, place, lat, lon, agoMs, extra = {}) {
  const time = Date.now() - agoMs;
  return {
    type: 'Feature',
    id,
    properties: {
      mag, place, time, updated: time, url: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}`,
      felt: extra.felt ?? null, tsunami: extra.tsunami ?? 0, alert: extra.alert ?? null, sig: Math.round((mag || 0) * 100),
      type: 'earthquake', status: 'reviewed', magType: 'ml', title: `M ${mag} - ${place}`,
    },
    geometry: { type: 'Point', coordinates: [lon, lat, extra.depth ?? 10] },
  };
}

/** The standard "past day" set. Home in tests is San Francisco (37.7749, -122.4194). */
function dayQuakes() {
  return [
    quake('tst_hollister', 4.6, '12 km NE of Hollister, CA', 36.85, -121.40, 10 * MIN, { felt: 842, depth: 8 }),
    quake('tst_geysers', 1.2, '5 km NW of The Geysers, CA', 38.80, -122.80, 30 * MIN, { depth: 2 }),
    quake('tst_hawaii', 0.9, '8 km SW of Volcano, Hawaii', 19.40, -155.30, 3 * MIN, { depth: 1 }),
    quake('tst_japan', 5.8, '40 km E of Mito, Japan', 36.10, 140.10, 2 * HOUR, { depth: 45 }),
    quake('tst_alaska', 3.1, '30 km N of Anchorage, Alaska', 61.20, -150.00, 5 * HOUR, { depth: 35 }),
    quake('tst_pr', 2.7, '10 km S of Ponce, Puerto Rico', 18.00, -66.80, 12 * HOUR, { depth: 12 }),
    quake('tst_chile', 6.4, 'offshore Valparaíso, Chile', -33.00, -71.60, 20 * HOUR, { tsunami: 1, alert: 'yellow', depth: 30, felt: 3100 }),
  ];
}

/** Quakes that "arrive" on a later refresh. */
function arrivals() {
  return [
    quake('tst_berkeley', 3.4, '3 km E of Berkeley, CA', 37.87, -122.27, 1 * MIN, { depth: 9 }),
    quake('tst_indonesia', 6.1, '100 km SW of Bengkulu, Indonesia', -4.5, 101.5, 2 * MIN, { depth: 25 }),
  ];
}

function weekQuakes() {
  return dayQuakes().filter((f) => f.properties.mag >= 2.5).concat([
    quake('tst_tonga', 4.9, '120 km NE of Neiafu, Tonga', -17.9, -173.2, 4 * 24 * HOUR, { depth: 110 }),
  ]);
}

function feed(features) {
  return JSON.stringify({ type: 'FeatureCollection', metadata: { generated: Date.now(), count: features.length, title: 'test' }, features });
}

function nwsAlert(id, event, severity, areaDesc, geometry, extra = {}) {
  const now = Date.now();
  return {
    id: `https://api.weather.gov/alerts/${id}`,
    type: 'Feature',
    geometry,
    properties: {
      id, event, severity, areaDesc,
      urgency: 'Immediate', certainty: 'Observed',
      headline: extra.headline || `${event} issued for ${areaDesc}`,
      description: extra.description || `${event} in effect. Take protective action.`,
      instruction: extra.instruction || 'Follow instructions from local officials.',
      senderName: 'NWS Test Office',
      sent: new Date(now - 20 * MIN).toISOString(),
      effective: new Date(now - 20 * MIN).toISOString(),
      expires: new Date(now + 3 * HOUR).toISOString(),
    },
  };
}

const box = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });

function nwsSevere() {
  return [
    nwsAlert('tst-tornado', 'Tornado Warning', 'Extreme', 'Oklahoma County, OK', box(-97.7, 35.3, -97.1, 35.7)),
    nwsAlert('tst-flood', 'Flash Flood Warning', 'Severe', 'Harris County, TX', box(-95.8, 29.5, -95.0, 30.1)),
  ];
}

function nwsAtHome() {
  return [nwsAlert('tst-heat', 'Heat Advisory', 'Moderate', 'San Francisco Bay Shoreline', null, { description: 'Hot temperatures up to 98 expected.' })];
}

const GEO = {
  'san francisco': [{ display_name: 'San Francisco, California, United States', lat: '37.7749', lon: '-122.4194' }],
  tokyo: [{ display_name: 'Tokyo, Japan', lat: '35.6762', lon: '139.6503' }],
  anchorage: [{ display_name: 'Anchorage, Alaska, United States', lat: '61.2181', lon: '-149.9003' }],
};

/**
 * Route every external request the app makes to deterministic fixtures.
 * Returns a controller so a test can change what the next refresh returns.
 */
async function mockApis(page, opts = {}) {
  const ctl = {
    day: opts.day || dayQuakes(),
    week: opts.week || weekQuakes(),
    severe: opts.severe || nwsSevere(),
    homeAlerts: opts.homeAlerts || nwsAtHome(),
    usgsStatus: 200,
    requests: [],
  };

  ctl.tileRequests = [];
  ctl.esriStatus = opts.esriStatus || 200;
  await page.route(/server\.arcgisonline\.com|tile\.openstreetmap\.org/, (route) => {
    const url = route.request().url();
    ctl.tileRequests.push(url);
    if (url.includes('arcgisonline') && ctl.esriStatus !== 200) return route.fulfill({ status: ctl.esriStatus, body: '' });
    return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  });

  // Skip the first-visit welcome guide unless a test asks for it.
  if (!opts.firstVisit) {
    await page.addInitScript(() => { try { localStorage.setItem('safeground:onboarded', 'true'); } catch (e) {} });
  }

  await page.route(/earthquake\.usgs\.gov\/earthquakes\/feed/, (route) => {
    const url = route.request().url();
    ctl.requests.push(url);
    if (ctl.usgsStatus !== 200) return route.fulfill({ status: ctl.usgsStatus, body: 'error' });
    let features = ctl.day;
    if (/_week\.geojson/.test(url)) features = ctl.week;
    else if (/_month\.geojson/.test(url)) features = ctl.week.filter((f) => f.properties.mag >= 4.5);
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: feed(features) });
  });

  await page.route(/api\.weather\.gov\/alerts/, (route) => {
    const url = new URL(route.request().url());
    ctl.requests.push(url.toString());
    let features = [];
    const point = url.searchParams.get('point');
    if (point) {
      const [lat, lon] = point.split(',').map(Number);
      // Only the San Francisco area has a local alert.
      if (Math.abs(lat - 37.77) < 0.5 && Math.abs(lon + 122.42) < 0.5) features = ctl.homeAlerts;
      if (lat < 15 || lat > 72) return route.fulfill({ status: 400, contentType: 'application/json', body: '{"title":"Bad Request"}' });
    } else {
      features = ctl.severe;
    }
    return route.fulfill({ status: 200, contentType: 'application/geo+json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ type: 'FeatureCollection', features }) });
  });

  await page.route(/nominatim\.openstreetmap\.org/, (route) => {
    const url = new URL(route.request().url());
    ctl.requests.push(url.toString());
    if (url.pathname.includes('reverse')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ display_name: 'Test Place', address: { city: 'Pinned City', state: 'Test State' } }) });
    }
    const q = (url.searchParams.get('q') || '').toLowerCase();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(GEO[q] || []) });
  });

  return ctl;
}

/** Open the app and wait for the first earthquake render. */
async function openApp(page, path = '/') {
  await page.goto(path);
  await page.locator('#liveStatus[data-state="live"]').waitFor();
}

/** Seed localStorage before the app boots. */
async function seedStorage(page, data) {
  await page.addInitScript((d) => {
    if (sessionStorage.getItem('__seeded')) return; // only once, so reload tests keep user changes
    sessionStorage.setItem('__seeded', '1');
    Object.entries(d).forEach(([k, v]) => localStorage.setItem('safeground:' + k, JSON.stringify(v)));
  }, data);
}

const SF_HOME = { name: 'San Francisco, California', lat: 37.7749, lon: -122.4194, radiusKm: 250, minMag: 2.5 };

module.exports = { mockApis, openApp, seedStorage, dayQuakes, arrivals, weekQuakes, SF_HOME, MIN, HOUR };
