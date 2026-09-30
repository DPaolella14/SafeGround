/* SafeGround — Leaflet map layer management */
(function () {
  'use strict';
  const SG = (window.SG = window.SG || {});
  const { esc, fmtMag, magColor, magRadius, timeAgo, cssVar } = SG.util;

  const TILES = {
    dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    light: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
  };
  const ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

  const SEV_VAR = { Extreme: '--sev-extreme', Severe: '--sev-severe', Moderate: '--sev-moderate', Minor: '--sev-minor' };
  const sevColor = (s) => cssVar(SEV_VAR[s] || '--sev-minor');

  const HOME_SVG = '<svg viewBox="0 0 24 24"><path d="M3 11 12 4l9 7v9h-6v-6H9v6H3z" fill="currentColor"/></svg>';

  let map = null;
  let tileLayer = null;
  const layers = {};
  const quakeLayers = new Map();
  let clickHandler = null;
  let ready = false;

  function init(el, { theme, onQuakeClick, onAlertClick }) {
    if (typeof window.L === 'undefined') {
      el.innerHTML = '<div class="empty-state" style="padding-top:120px">Map library failed to load. The lists still work.</div>';
      return false;
    }
    map = L.map(el, {
      center: [20, -30],
      zoom: 2,
      minZoom: 2,
      worldCopyJump: true,
      preferCanvas: true,
      zoomControl: false,
      attributionControl: true,
    });
    L.control.zoom({ position: 'topright' }).addTo(map);
    L.control.scale({ position: 'bottomright', imperial: true }).addTo(map);
    setTheme(theme);

    layers.nws = L.layerGroup().addTo(map);
    layers.areas = L.layerGroup().addTo(map);
    layers.quakes = L.layerGroup().addTo(map);
    layers.pulses = L.layerGroup().addTo(map);
    layers.places = L.layerGroup().addTo(map);

    layers._onQuakeClick = onQuakeClick;
    layers._onAlertClick = onAlertClick;

    map.on('click', (e) => {
      if (clickHandler) clickHandler(e.latlng);
    });
    ready = true;
    return true;
  }

  function setTheme(theme) {
    if (!map) return;
    if (tileLayer) map.removeLayer(tileLayer);
    tileLayer = L.tileLayer(TILES[theme] || TILES.dark, {
      attribution: ATTRIB,
      subdomains: 'abcd',
      maxZoom: 19,
      detectRetina: false,
    }).addTo(map);
  }

  /** Draw quakes. `freshIds` get an animated ripple (newly arrived, or very recent). */
  function renderQuakes(quakes, { freshIds = new Set(), selectedId = null } = {}) {
    if (!ready) return;
    layers.quakes.clearLayers();
    layers.pulses.clearLayers();
    quakeLayers.clear();
    const now = Date.now();
    // Draw small first so large events sit on top.
    const sorted = quakes.slice().sort((a, b) => (a.mag || 0) - (b.mag || 0));
    for (const q of sorted) {
      const ageH = (now - q.time) / 3.6e6;
      const color = magColor(q.mag);
      const marker = L.circleMarker([q.lat, q.lon], {
        radius: magRadius(q.mag),
        color: q.id === selectedId ? '#ffffff' : color,
        weight: q.id === selectedId ? 3 : 1,
        fillColor: color,
        fillOpacity: ageH < 1 ? 0.9 : ageH < 24 ? 0.65 : 0.4,
        opacity: 0.95,
      });
      marker.bindTooltip(`<b>M${fmtMag(q.mag)}</b> · ${esc(q.place)}<br><span style="opacity:.7">${timeAgo(q.time, now)}</span>`, { className: 'sg-tip', direction: 'top', offset: [0, -4] });
      marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        if (layers._onQuakeClick) layers._onQuakeClick(q.id);
      });
      marker.addTo(layers.quakes);
      quakeLayers.set(q.id, marker);

      if (freshIds.has(q.id)) {
        const s = Math.round(magRadius(q.mag) * 2 + 10);
        L.marker([q.lat, q.lon], {
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: 'quake-pulse',
            html: `<span style="--s:${s}px;--c:${color}"></span><span style="--s:${s}px;--c:${color}"></span>`,
            iconSize: [0, 0],
          }),
        }).addTo(layers.pulses);
      }
    }
  }

  function renderNws(alerts, visible) {
    if (!ready) return;
    layers.nws.clearLayers();
    if (!visible) return;
    for (const a of alerts) {
      if (!a.geometry) continue;
      const color = sevColor(a.severity);
      const layer = L.geoJSON(a.geometry, {
        style: { color, weight: 1.5, fillColor: color, fillOpacity: 0.18, dashArray: a.severity === 'Extreme' ? null : '4 3' },
      });
      layer.bindTooltip(`<b>${esc(a.event)}</b><br>${esc(a.areaDesc.slice(0, 120))}`, { className: 'sg-tip', sticky: true });
      layer.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        if (layers._onAlertClick) layers._onAlertClick(a.id);
      });
      layer.addTo(layers.nws);
    }
  }

  function renderPlaces(home, areas) {
    if (!ready) return;
    layers.places.clearLayers();
    layers.areas.clearLayers();
    const accent = cssVar('--accent');
    const info = cssVar('--info');
    if (home) {
      L.circle([home.lat, home.lon], { radius: home.radiusKm * 1000, color: accent, weight: 1.5, dashArray: '6 6', fill: true, fillOpacity: 0.05, interactive: false }).addTo(layers.areas);
      L.marker([home.lat, home.lon], {
        title: 'Home',
        icon: L.divIcon({ className: 'home-pin', html: `<div>${HOME_SVG}</div>`, iconSize: [34, 34], iconAnchor: [17, 40] }),
        zIndexOffset: 1000,
      }).bindTooltip(`<b>Home</b><br>${esc(home.name)}`, { className: 'sg-tip', direction: 'top', offset: [0, -36] }).addTo(layers.places);
    }
    areas.forEach((a) => {
      L.circle([a.lat, a.lon], { radius: a.radiusKm * 1000, color: info, weight: 1.5, dashArray: '4 6', fillOpacity: 0.04, interactive: false }).addTo(layers.areas);
      L.marker([a.lat, a.lon], {
        title: a.name,
        icon: L.divIcon({ className: 'area-pin', html: `<div>${esc((a.name || '?').trim().charAt(0).toUpperCase())}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
        zIndexOffset: 900,
      }).bindTooltip(`<b>${esc(a.name)}</b><br>${a.radiusKm} km radius · M${a.minMag}+`, { className: 'sg-tip', direction: 'top', offset: [0, -12] }).addTo(layers.places);
    });
  }

  function focusQuake(id, zoom) {
    if (!ready) return;
    const m = quakeLayers.get(id);
    if (!m) return;
    const ll = m.getLatLng();
    map.flyTo(ll, Math.max(map.getZoom(), zoom || 6), { duration: 0.9 });
  }

  function flyTo(lat, lon, zoom = 7) {
    if (ready) map.flyTo([lat, lon], zoom, { duration: 0.9 });
  }

  function fitRadius(lat, lon, radiusKm) {
    if (!ready) return;
    const b = L.latLng(lat, lon).toBounds(radiusKm * 2000);
    map.flyToBounds(b, { padding: [40, 40], duration: 0.9 });
  }

  function fitGeometry(geometry) {
    if (!ready || !geometry) return;
    try {
      map.flyToBounds(L.geoJSON(geometry).getBounds(), { padding: [60, 60], duration: 0.9, maxZoom: 9 });
    } catch (e) { /* ignore */ }
  }

  function onPick(fn) {
    clickHandler = fn;
  }

  function invalidate() {
    if (ready) map.invalidateSize();
  }

  SG.map = {
    init, setTheme, renderQuakes, renderNws, renderPlaces, focusQuake, flyTo, fitRadius, fitGeometry, onPick, invalidate,
    get instance() { return map; },
    get ready() { return ready; },
  };
})();
