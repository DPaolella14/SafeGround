/* SafeGround — data sources: USGS earthquakes, NOAA/NWS alerts, OSM Nominatim geocoding.
   All three are free, need no API key, and send CORS headers, so they work from a static page. */
(function () {
  'use strict';
  const SG = (window.SG = window.SG || {});

  const USGS_BASE = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/';
  const NWS_BASE = 'https://api.weather.gov/alerts/active';
  const GEOCODE_BASE = 'https://nominatim.openstreetmap.org/search';

  /** USGS feed for each time window. Longer windows use pre-filtered feeds to stay light. */
  const FEEDS = {
    hour: 'all_hour',
    day: 'all_day',
    week: '2.5_week',
    month: '4.5_month',
  };

  async function fetchJSON(url, { timeout = 20000, headers = {} } = {}) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;
    try {
      const res = await fetch(url, { headers, signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function normalizeQuake(f) {
    const p = f.properties || {};
    const c = (f.geometry && f.geometry.coordinates) || [0, 0, 0];
    return {
      id: f.id,
      mag: typeof p.mag === 'number' ? p.mag : null,
      place: p.place || p.title || 'Unknown location',
      time: p.time,
      updated: p.updated,
      lon: c[0],
      lat: c[1],
      depth: c[2],
      url: p.url,
      felt: p.felt,
      tsunami: p.tsunami === 1,
      alert: p.alert, // PAGER level: green / yellow / orange / red
      sig: p.sig,
      type: p.type || 'earthquake',
      status: p.status,
      magType: p.magType,
    };
  }

  async function getQuakes(windowKey) {
    const feed = FEEDS[windowKey] || FEEDS.day;
    const data = await fetchJSON(`${USGS_BASE}${feed}.geojson`);
    const list = (data.features || []).map(normalizeQuake).filter((q) => isFinite(q.lat) && isFinite(q.lon));
    return { quakes: list, generated: (data.metadata && data.metadata.generated) || Date.now(), feed };
  }

  function normalizeAlert(f) {
    const p = f.properties || {};
    return {
      id: p.id || f.id,
      event: p.event || 'Alert',
      headline: p.headline || p.event || 'Weather alert',
      severity: p.severity || 'Unknown',
      urgency: p.urgency,
      certainty: p.certainty,
      areaDesc: p.areaDesc || '',
      sent: p.sent ? Date.parse(p.sent) : null,
      effective: p.effective ? Date.parse(p.effective) : null,
      expires: p.expires ? Date.parse(p.expires) : null,
      ends: p.ends ? Date.parse(p.ends) : null,
      description: p.description || '',
      instruction: p.instruction || '',
      sender: p.senderName || 'National Weather Service',
      geometry: f.geometry || null,
      url: f.id || p['@id'] || 'https://alerts.weather.gov/',
    };
  }

  const NWS_HEADERS = { Accept: 'application/geo+json' };

  /** Active Extreme/Severe alerts across the US (for the map layer). */
  async function getNwsSevere() {
    const data = await fetchJSON(`${NWS_BASE}?status=actual&severity=Extreme,Severe`, { headers: NWS_HEADERS });
    return (data.features || []).map(normalizeAlert);
  }

  /** All active alerts at a single point. NWS only covers the US and its territories. */
  async function getNwsAtPoint(lat, lon) {
    try {
      const data = await fetchJSON(`${NWS_BASE}?status=actual&point=${lat.toFixed(4)},${lon.toFixed(4)}`, { headers: NWS_HEADERS });
      return (data.features || []).map(normalizeAlert);
    } catch (e) {
      if (e.status === 400 || e.status === 404) return []; // outside NWS coverage
      throw e;
    }
  }

  async function geocode(query) {
    const q = String(query || '').trim();
    if (!q) return [];
    // Accept raw "lat, lon" input without a network call.
    const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) {
      const lat = parseFloat(m[1]);
      const lon = parseFloat(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return [{ name: `${lat.toFixed(3)}, ${lon.toFixed(3)}`, lat, lon }];
    }
    const data = await fetchJSON(`${GEOCODE_BASE}?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`, { timeout: 12000 });
    return (data || []).map((r) => ({ name: r.display_name, lat: parseFloat(r.lat), lon: parseFloat(r.lon) }));
  }

  /** Best-effort place name for coordinates; falls back to the coordinates themselves. */
  async function reverseGeocode(lat, lon) {
    const fallback = `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
    try {
      const r = await fetchJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=${lat}&lon=${lon}`, { timeout: 8000 });
      const a = (r && r.address) || {};
      const town = a.city || a.town || a.village || a.hamlet || a.county;
      const region = a.state || a.region || a.country;
      return town ? `${town}${region ? ', ' + region : ''}` : (r && r.display_name) || fallback;
    } catch (e) {
      return fallback;
    }
  }

  SG.api = { FEEDS, getQuakes, getNwsSevere, getNwsAtPoint, geocode, reverseGeocode, normalizeQuake, normalizeAlert };
})();
