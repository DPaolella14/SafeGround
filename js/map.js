/* SafeGround — Leaflet map layer management */
(function () {
  'use strict';
  const SG = (window.SG = window.SG || {});
  const { esc, fmtMag, magColor, magRadius, timeAgo, cssVar } = SG.util;

  // Basemaps that need NO API key. Esri's public ArcGIS Online tile services are the default
  // (they also work when the page is opened straight from disk); OpenStreetMap is the automatic fallback.
  const ESRI = (svc) => `https://server.arcgisonline.com/ArcGIS/rest/services/${svc}/MapServer/tile/{z}/{y}/{x}`;
  const ESRI_ATTR = 'Tiles &copy; <a href="https://www.esri.com">Esri</a> — Esri, HERE, Garmin, USGS, NGA, EPA, NPS';
  const BASEMAPS = {
    dark: { label: 'Dark', layers: [{ url: ESRI('Canvas/World_Dark_Gray_Base'), max: 16 }, { url: ESRI('Canvas/World_Dark_Gray_Reference'), max: 16, overlay: true }] },
    light: { label: 'Light', layers: [{ url: ESRI('Canvas/World_Light_Gray_Base'), max: 16 }, { url: ESRI('Canvas/World_Light_Gray_Reference'), max: 16, overlay: true }] },
    streets: { label: 'Streets', layers: [{ url: ESRI('World_Street_Map'), max: 19 }] },
    satellite: { label: 'Satellite', layers: [{ url: ESRI('World_Imagery'), max: 19 }, { url: ESRI('Reference/World_Boundaries_and_Places'), max: 19, overlay: true }] },
    terrain: { label: 'Terrain', layers: [{ url: ESRI('World_Topo_Map'), max: 19 }] },
  };
  const OSM_FALLBACK = { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', max: 19, attr: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' };

  const SEV_VAR = { Extreme: '--sev-extreme', Severe: '--sev-severe', Moderate: '--sev-moderate', Minor: '--sev-minor' };
  const sevColor = (s) => cssVar(SEV_VAR[s] || '--sev-minor');

  const HOME_SVG = '<svg viewBox="0 0 24 24"><path d="M3 11 12 4l9 7v9h-6v-6H9v6H3z" fill="currentColor"/></svg>';

  let map = null;
  const layers = {};
  const quakeLayers = new Map();
  let clickHandler = null;
  let ready = false;

  function init(el, opts) {
    const { theme, onQuakeClick, onAlertClick } = opts;
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
    map.createPane('labels');
    map.getPane('labels').style.zIndex = 450; // above NWS polygons, below markers
    map.getPane('labels').style.pointerEvents = 'none';
    onFallback = opts.onFallback || null;
    setBasemap(opts.basemap || (theme === 'light' ? 'light' : 'dark'));

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

  let baseGroup = null;
  let currentBase = null;
  let usingFallback = false;
  let onFallback = null;

  /** Switch the background map. `key` is one of BASEMAPS. */
  function setBasemap(key) {
    if (!map) return;
    if (!BASEMAPS[key]) key = 'dark';
    currentBase = key;
    if (baseGroup) map.removeLayer(baseGroup);
    baseGroup = L.layerGroup();
    if (usingFallback) {
      L.tileLayer(OSM_FALLBACK.url, { attribution: OSM_FALLBACK.attr, maxZoom: 19, className: key === 'dark' ? 'tiles-dim' : '' }).addTo(baseGroup);
    } else {
      let loaded = 0;
      let failed = 0;
      BASEMAPS[key].layers.forEach((def, i) => {
        const tl = L.tileLayer(def.url, {
          attribution: i === 0 ? ESRI_ATTR : '',
          maxNativeZoom: def.max,
          maxZoom: 19,
          pane: def.overlay ? 'labels' : 'tilePane',
          crossOrigin: false,
        });
        if (i === 0) {
          tl.on('tileload', () => { loaded++; });
          tl.on('tileerror', () => {
            failed++;
            // Provider unreachable (blocked network, outage…) → fall back to OpenStreetMap once.
            if (!usingFallback && loaded === 0 && failed >= 4) {
              usingFallback = true;
              setBasemap(currentBase);
              if (onFallback) onFallback();
            }
          });
        }
        tl.addTo(baseGroup);
      });
    }
    baseGroup.addTo(map);
    el().dataset.basemap = key;
  }

  function el() { return map.getContainer(); }

  // Back-compat: theme switch maps onto dark/light basemaps.
  function setTheme(theme) { setBasemap(theme === 'light' ? 'light' : 'dark'); }

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
    BASEMAPS, init, setTheme, setBasemap, renderQuakes, renderNws, renderPlaces, focusQuake, flyTo, fitRadius, fitGeometry, onPick, invalidate,
    get instance() { return map; },
    get ready() { return ready; },
    get basemap() { return currentBase; },
    get usingFallback() { return usingFallback; },
  };
})();
