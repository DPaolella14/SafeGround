/* SafeGround — application controller */
(function () {
  'use strict';
  const SG = window.SG;
  const { $, $$, esc, distanceKm, bearing, timeAgo, fmtDateTime, fmtDist, fmtMag, magVar, debounce, uid } = SG.util;
  const store = SG.store;

  // ---- Config -------------------------------------------------------------
  const params = new URLSearchParams(location.search);
  const QUAKE_REFRESH_S = Math.max(5, parseInt(params.get('refresh'), 10) || 60); // USGS feeds update every minute
  const NWS_REFRESH_S = Math.max(QUAKE_REFRESH_S, 180);
  const LIST_PAGE = 150;

  const SEV_ORDER = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };
  const SEV_VAR = { Extreme: '--sev-extreme', Severe: '--sev-severe', Moderate: '--sev-moderate', Minor: '--sev-minor' };

  // ---- State ---------------------------------------------------------------
  const state = {
    prefs: Object.assign({ window: 'day', minMag: '0', sort: 'newest', units: 'km', theme: 'dark', basemap: null, notify: false, showNws: true }, store.get('prefs', {})),
    home: store.get('home', null),
    areas: store.get('areas', []),
    read: new Set(store.get('read', [])),
    dayQuakes: [],
    windowQuakes: [],
    quakeById: new Map(),
    prevWindowIds: null,
    arrivedIds: new Set(),
    nwsSevere: [],
    nwsLocal: {},
    alerts: [],
    knownKeys: new Set(),
    quakesLoadedOnce: false,
    nwsLoadedOnce: false,
    lastQuakeFetch: 0,
    lastNwsFetch: 0,
    nextQuakeAt: 0,
    nextNwsAt: 0,
    loading: false,
    error: null,
    selectedId: null,
    listLimit: LIST_PAGE,
    pick: null,
    areaDraft: null,
    search: '',
  };

  const savePrefs = () => store.set('prefs', state.prefs);
  const saveHome = () => store.set('home', state.home);
  const saveAreas = () => store.set('areas', state.areas);
  const saveRead = () => store.set('read', Array.from(state.read).slice(-800));

  function places() {
    const list = [];
    if (state.home) list.push(Object.assign({}, state.home, { id: 'home', label: 'Home' }));
    state.areas.forEach((a) => list.push(Object.assign({}, a, { label: a.name })));
    return list;
  }

  // ---- Data loading ------------------------------------------------------------
  let quakeSeq = 0;
  async function loadQuakes({ force = false } = {}) {
    if (state.loading && !force) return;
    const seq = ++quakeSeq;
    state.loading = true;
    setLive('loading');
    $('#refreshBtn').classList.add('spinning');
    try {
      const w = state.prefs.window;
      const dayReq = SG.api.getQuakes('day');
      const winReq = w === 'hour' || w === 'day' ? null : SG.api.getQuakes(w);
      const day = await dayReq;
      const win = winReq ? await winReq : null;
      if (seq !== quakeSeq) return; // a newer request (e.g. window change) superseded this one

      state.dayQuakes = day.quakes;
      const hourAgo = Date.now() - 3.6e6;
      state.windowQuakes = w === 'hour' ? day.quakes.filter((q) => q.time >= hourAgo) : win ? win.quakes : day.quakes;
      state.quakeById = new Map();
      state.dayQuakes.concat(state.windowQuakes).forEach((q) => state.quakeById.set(q.id, q));

      const ids = new Set(state.windowQuakes.map((q) => q.id));
      state.arrivedIds = new Set();
      if (state.prevWindowIds && state.prevWindowKey === w) {
        ids.forEach((id) => { if (!state.prevWindowIds.has(id)) state.arrivedIds.add(id); });
      }
      state.prevWindowIds = ids;
      state.prevWindowKey = w;

      state.lastQuakeFetch = Date.now();
      state.error = null;
      hideError();
      const first = !state.quakesLoadedOnce;
      state.quakesLoadedOnce = true;

      renderQuakeViews();
      updateAlerts({ silentKinds: first ? ['quake'] : [] });
      announceArrivals();
      setLive('live');
    } catch (err) {
      if (seq !== quakeSeq) return;
      console.warn('[SafeGround] earthquake feed failed', err);
      state.error = err;
      showError(state.quakesLoadedOnce ? 'Couldn’t reach the USGS earthquake feed. Showing the last data we have.' : 'Couldn’t reach the USGS earthquake feed. Retrying automatically.');
      setLive('error');
      if (!state.quakesLoadedOnce) renderList();
    } finally {
      if (seq === quakeSeq) {
        state.loading = false;
        state.nextQuakeAt = Date.now() + QUAKE_REFRESH_S * 1000;
        $('#refreshBtn').classList.remove('spinning');
      }
    }
  }
  async function loadNws() {
    state.nextNwsAt = Date.now() + NWS_REFRESH_S * 1000;
    const pl = places();
    const [severe, ...local] = await Promise.allSettled([
      SG.api.getNwsSevere(),
      ...pl.map((p) => SG.api.getNwsAtPoint(p.lat, p.lon)),
    ]);
    if (severe.status === 'fulfilled') state.nwsSevere = severe.value;
    else console.warn('[SafeGround] NWS national alerts failed', severe.reason);
    const nextLocal = {};
    pl.forEach((p, i) => {
      const r = local[i];
      nextLocal[p.id] = r.status === 'fulfilled' ? r.value : state.nwsLocal[p.id] || [];
    });
    state.nwsLocal = nextLocal;
    state.lastNwsFetch = Date.now();
    const first = !state.nwsLoadedOnce;
    state.nwsLoadedOnce = true;
    renderNwsViews();
    updateAlerts({ silentKinds: first ? ['nws'] : [] });
  }

  function refreshAll() {
    loadQuakes();
    loadNws();
  }

  // ---- Alerts engine -------------------------------------------------------------
  function computeAlerts() {
    const pl = places();
    const out = [];
    if (pl.length) {
      for (const q of state.dayQuakes) {
        const hits = [];
        for (const p of pl) {
          const d = distanceKm(p.lat, p.lon, q.lat, q.lon);
          if (d <= p.radiusKm && (q.mag || 0) >= p.minMag) hits.push({ place: p, d });
        }
        if (hits.length) {
          hits.sort((a, b) => a.d - b.d);
          out.push({ key: 'q:' + q.id, kind: 'quake', time: q.time, quake: q, hits });
        }
      }
      const byKey = new Map();
      for (const p of pl) {
        for (const a of state.nwsLocal[p.id] || []) {
          const key = 'w:' + a.id;
          if (byKey.has(key)) { byKey.get(key).labels.push(p.label); continue; }
          const item = { key, kind: 'nws', time: a.sent || a.effective || Date.now(), alert: a, labels: [p.label] };
          byKey.set(key, item);
          out.push(item);
        }
      }
    }
    out.sort((a, b) => b.time - a.time);
    return out;
  }

  function updateAlerts({ silentKinds = [] } = {}) {
    const alerts = computeAlerts();
    const fresh = alerts.filter((a) => !state.knownKeys.has(a.key) && !state.read.has(a.key) && !silentKinds.includes(a.kind));
    alerts.forEach((a) => state.knownKeys.add(a.key));
    state.alerts = alerts;
    fresh.slice(0, 3).forEach(notifyAlert);
    if (fresh.length > 3) toast({ title: `+${fresh.length - 3} more alerts`, body: 'Open the Alerts tab to see them all.', onClick: () => switchTab('alerts') });
    renderAlerts();
  }

  function alertTitle(a) {
    if (a.kind === 'quake') {
      const h = a.hits[0];
      return { title: `M${fmtMag(a.quake.mag)} earthquake near ${h.place.label}`, body: `${a.quake.place} · ${fmtDist(h.d, state.prefs.units)} ${bearing(h.place.lat, h.place.lon, a.quake.lat, a.quake.lon)} of ${h.place.label}`, color: `var(${magVar(a.quake.mag)})` };
    }
    return { title: a.alert.event, body: `${a.labels.join(', ')} · ${a.alert.headline}`, color: `var(${SEV_VAR[a.alert.severity] || '--sev-minor'})` };
  }

  function notifyAlert(a) {
    const t = alertTitle(a);
    toast({ title: t.title, body: t.body, color: t.color, onClick: () => openAlert(a.key) });
    if (state.prefs.notify && 'Notification' in window && Notification.permission === 'granted') {
      try {
        const n = new Notification('SafeGround: ' + t.title, { body: t.body, tag: a.key });
        n.onclick = () => { window.focus(); openAlert(a.key); };
      } catch (e) { /* some browsers need a service worker; toast already shown */ }
    }
  }

  function openAlert(key) {
    const a = state.alerts.find((x) => x.key === key);
    if (!a) return;
    state.read.add(key);
    saveRead();
    if (a.kind === 'quake') {
      selectQuake(a.quake.id, { fly: true });
    } else {
      switchTab('alerts');
      const el = document.querySelector(`#alertList [data-key="${CSS.escape(key)}"]`);
      if (el) { el.classList.add('open'); el.scrollIntoView({ block: 'nearest' }); }
      SG.map.fitGeometry(a.alert.geometry);
    }
    renderAlerts();
  }

  /** Quick toast for large new quakes worldwide, even outside saved places (keeps things feeling live). */
  function announceArrivals() {
    const big = state.windowQuakes.filter((q) => state.arrivedIds.has(q.id) && (q.mag || 0) >= 5.5);
    big.slice(0, 2).forEach((q) => toast({ title: `New M${fmtMag(q.mag)} earthquake`, body: q.place, color: `var(${magVar(q.mag)})`, onClick: () => selectQuake(q.id, { fly: true }) }));
  }

  // ---- Rendering: quakes --------------------------------------------------------------
  function filteredQuakes() {
    const min = parseFloat(state.prefs.minMag) || 0;
    const s = state.search.trim().toLowerCase();
    let list = state.windowQuakes.filter((q) => (q.mag == null ? min === 0 : q.mag >= min) && (!s || q.place.toLowerCase().includes(s)));
    const h = state.home;
    if (state.prefs.sort === 'largest') list.sort((a, b) => (b.mag || 0) - (a.mag || 0) || b.time - a.time);
    else if (state.prefs.sort === 'nearest' && h) list.sort((a, b) => distanceKm(h.lat, h.lon, a.lat, a.lon) - distanceKm(h.lat, h.lon, b.lat, b.lon));
    else list.sort((a, b) => b.time - a.time);
    return list;
  }

  function renderQuakeViews() {
    renderStats();
    renderTimeline();
    renderList();
    renderMapQuakes();
    if (state.selectedId) renderDetail();
  }

  function renderMapQuakes() {
    const list = filteredQuakes();
    const now = Date.now();
    const fresh = new Set(state.arrivedIds);
    // Recent, meaningful quakes pulse too — the map should look alive on first load.
    list.filter((q) => now - q.time < 3.6e6 && (q.mag || 0) >= 2.5).slice(0, 25).forEach((q) => fresh.add(q.id));
    SG.map.renderQuakes(list, { freshIds: fresh, selectedId: state.selectedId });
  }

  function isNearHome(q) {
    const h = state.home;
    return h && distanceKm(h.lat, h.lon, q.lat, q.lon) <= h.radiusKm;
  }

  function quakeItem(q) {
    const h = state.home;
    const d = h ? distanceKm(h.lat, h.lon, q.lat, q.lon) : null;
    const tags = [];
    if (state.arrivedIds.has(q.id)) tags.push('<span class="tag tag-new">new</span>');
    if (q.tsunami) tags.push('<span class="tag tag-tsunami">tsunami info</span>');
    if (isNearHome(q)) tags.push('<span class="tag tag-near">near home</span>');
    return `<li class="quake${q.id === state.selectedId ? ' selected' : ''}${state.arrivedIds.has(q.id) ? ' is-new' : ''}" tabindex="0" data-id="${esc(q.id)}">
      <div class="mag-badge" style="--c:var(${magVar(q.mag)})">${fmtMag(q.mag)}</div>
      <div class="quake-main">
        <div class="quake-place" title="${esc(q.place)}">${esc(q.place)}</div>
        <div class="quake-meta"><span data-ago="${q.time}">${timeAgo(q.time)}</span><span>${q.depth != null ? Math.round(q.depth) + ' km deep' : ''}</span>${q.type !== 'earthquake' ? `<span>${esc(q.type)}</span>` : ''}${tags.join('')}</div>
      </div>
      <div class="quake-side">${d != null ? fmtDist(d, state.prefs.units) + '<br>from home' : ''}</div>
    </li>`;
  }

  function renderList() {
    const ul = $('#quakeList');
    const head = $('#listCount');
    if (!state.quakesLoadedOnce) {
      head.textContent = state.error ? 'Earthquake feed unavailable' : 'Loading earthquakes…';
      ul.innerHTML = state.error
        ? '<li class="empty-state">We couldn’t load the USGS feed. Check your connection — SafeGround will keep retrying.</li>'
        : '';
      return;
    }
    const list = filteredQuakes();
    const label = { hour: 'past hour', day: 'past 24 hours', week: 'past 7 days', month: 'past 30 days' }[state.prefs.window];
    head.textContent = `${list.length.toLocaleString()} earthquake${list.length === 1 ? '' : 's'} · ${label}`;
    if (!list.length) {
      ul.innerHTML = `<li class="empty-state"><svg viewBox="0 0 24 24"><path d="M3 12h4l3-8 4 16 3-8h4" fill="none" stroke="currentColor" stroke-width="2"/></svg><div>No earthquakes match these filters.</div></li>`;
      return;
    }
    const shown = list.slice(0, state.listLimit);
    ul.innerHTML = shown.map(quakeItem).join('') +
      (list.length > shown.length ? `<li><button type="button" class="btn more-btn" id="moreBtn">Show ${Math.min(LIST_PAGE, list.length - shown.length)} more</button></li>` : '');
  }

  function renderStats() {
    const day = state.dayQuakes;
    const now = Date.now();
    setStat('#statCount', day.length.toLocaleString(), `${day.filter((q) => now - q.time < 3.6e6).length} in the past hour`);
    const max = day.reduce((m, q) => ((q.mag || -9) > (m ? m.mag || -9 : -9) ? q : m), null);
    setStat('#statMax', max ? 'M' + fmtMag(max.mag) : '–', max ? max.place : 'No data yet');
    const h = state.home;
    if (h && day.length) {
      let best = null;
      let bestD = Infinity;
      day.forEach((q) => { const d = distanceKm(h.lat, h.lon, q.lat, q.lon); if (d < bestD) { bestD = d; best = q; } });
      setStat('#statNear', fmtDist(bestD, state.prefs.units), `M${fmtMag(best.mag)} · ${best.place}`);
    } else {
      setStat('#statNear', '–', h ? 'No data yet' : 'Tap to set your home');
    }
  }

  function setStat(sel, value, sub) {
    const el = $(sel);
    if (el.textContent !== String(value)) {
      el.textContent = value;
      el.classList.remove('bump');
      void el.offsetWidth; // restart animation
      el.classList.add('bump');
    }
    $(sel + 'Sub').textContent = sub;
  }

  function renderTimeline() {
    const svg = $('#timeline');
    const now = Date.now();
    const bins = Array.from({ length: 24 }, () => ({ n: 0, max: null }));
    state.dayQuakes.forEach((q) => {
      const hAgo = Math.floor((now - q.time) / 3.6e6);
      if (hAgo < 0 || hAgo > 23) return;
      const b = bins[23 - hAgo];
      b.n++;
      if (q.mag != null && (b.max == null || q.mag > b.max)) b.max = q.mag;
    });
    const peak = Math.max(1, ...bins.map((b) => b.n));
    svg.innerHTML = bins.map((b, i) => {
      const h = b.n ? Math.max(3, (b.n / peak) * 46) : 1.5;
      return `<rect x="${i * 10 + 1}" y="${48 - h}" width="8" height="${h}" rx="2" fill="var(${b.n ? magVar(b.max) : '--border'})"><title>${23 - i}h ago: ${b.n} quake${b.n === 1 ? '' : 's'}${b.max != null ? ', max M' + fmtMag(b.max) : ''}</title></rect>`;
    }).join('');
    $('#timelineMeta').textContent = `peak ${peak}/hr`;
  }

  // ---- Rendering: detail -----------------------------------------------------------
  function selectQuake(id, { fly = false } = {}) {
    state.selectedId = id;
    renderDetail();
    renderMapQuakes();
    $$('#quakeList .quake').forEach((li) => li.classList.toggle('selected', li.dataset.id === id));
    if (fly) SG.map.focusQuake(id, 6);
    if (window.matchMedia('(max-width: 760px)').matches) $('.map-wrap').scrollIntoView({ behavior: 'smooth' });
  }

  function renderDetail() {
    const el = $('#detail');
    const q = state.quakeById.get(state.selectedId);
    if (!q) { el.hidden = true; return; }
    const pl = places();
    const nearest = pl.map((p) => ({ p, d: distanceKm(p.lat, p.lon, q.lat, q.lon) })).sort((a, b) => a.d - b.d)[0];
    const pager = q.alert ? `<span class="tag" style="background:${esc(q.alert)};color:#111">PAGER ${esc(q.alert)}</span>` : '—';
    el.innerHTML = `
      <button type="button" class="detail-close" id="detailClose" aria-label="Close details">×</button>
      <div class="detail-head">
        <div class="mag-badge" style="--c:var(${magVar(q.mag)})">${fmtMag(q.mag)}</div>
        <div>
          <div class="detail-title">${esc(q.place)}</div>
          <div class="muted small">${fmtDateTime(q.time)} · <span data-ago="${q.time}">${timeAgo(q.time)}</span></div>
        </div>
      </div>
      <div class="detail-grid">
        <div><span>Magnitude</span>${fmtMag(q.mag)} ${esc(q.magType || '')}</div>
        <div><span>Depth</span>${q.depth != null ? q.depth.toFixed(1) + ' km' : '—'}</div>
        <div><span>Coordinates</span>${q.lat.toFixed(3)}, ${q.lon.toFixed(3)}</div>
        <div><span>${nearest ? 'From ' + esc(nearest.p.label) : 'Distance'}</span>${nearest ? fmtDist(nearest.d, state.prefs.units) + ' ' + bearing(nearest.p.lat, nearest.p.lon, q.lat, q.lon) : 'Set a home location'}</div>
        <div><span>Felt reports</span>${q.felt != null ? q.felt.toLocaleString() : '—'}</div>
        <div><span>Impact alert</span>${pager}</div>
        ${q.tsunami ? '<div style="grid-column:1/-1"><span>Tsunami</span>USGS flagged this event for tsunami information. Check <a href="https://www.tsunami.gov" target="_blank" rel="noopener">tsunami.gov</a>.</div>' : ''}
      </div>
      <div class="detail-actions">
        <button type="button" class="btn btn-sm" id="detailZoom">Zoom to</button>
        ${q.url ? `<a class="btn btn-sm" href="${esc(q.url)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center">USGS event page ↗</a>` : ''}
        <a class="btn btn-sm" href="${esc(q.url ? q.url + '/tellus' : 'https://earthquake.usgs.gov/data/dyfi/')}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center">Did you feel it?</a>
      </div>`;
    el.hidden = false;
  }

  function closeDetail() {
    state.selectedId = null;
    $('#detail').hidden = true;
    $$('#quakeList .quake.selected').forEach((li) => li.classList.remove('selected'));
    renderMapQuakes();
  }

  // ---- Rendering: alerts & NWS --------------------------------------------------------
  function renderAlerts() {
    const ul = $('#alertList');
    const unread = state.alerts.filter((a) => !state.read.has(a.key)).length;
    const badge = $('#alertBadge');
    badge.hidden = unread === 0;
    badge.textContent = unread > 99 ? '99+' : String(unread);
    document.title = (unread ? `(${unread}) ` : '') + 'SafeGround — Live Earthquake & Disaster Tracker';

    if (!places().length) {
      ul.innerHTML = `<li class="empty-state">Set a <b>home location</b> or add a <b>saved area</b> in the Places tab to start getting alerts.<br><br><button type="button" class="btn btn-accent" data-goto="places">Go to Places</button></li>`;
      return;
    }
    if (!state.alerts.length) {
      ul.innerHTML = `<li class="empty-state">All clear. No earthquakes above your thresholds and no active NWS alerts at your places.</li>`;
      return;
    }
    ul.innerHTML = state.alerts.map((a) => {
      const t = alertTitle(a);
      const unreadCls = state.read.has(a.key) ? '' : ' unread';
      const extra = a.kind === 'nws'
        ? `<div class="alert-desc">${esc(a.alert.description)}${a.alert.instruction ? '\n\n' + esc(a.alert.instruction) : ''}\n\n<a href="${esc(a.alert.url)}" target="_blank" rel="noopener">Full alert ↗</a></div>`
        : '';
      const when = a.kind === 'nws' && a.alert.expires ? `Until ${fmtDateTime(a.alert.expires)}` : `<span data-ago="${a.time}">${timeAgo(a.time)}</span>`;
      return `<li class="alert-item${unreadCls}" data-key="${esc(a.key)}" data-kind="${a.kind}" style="--c:${t.color}" tabindex="0">
        <div><div class="alert-title">${esc(t.title)}</div><div class="alert-sub">${esc(t.body)}</div><div class="alert-sub">${when}</div>${extra}</div>
      </li>`;
    }).join('');
  }

  function renderNwsViews() {
    const sev = state.nwsSevere;
    const localCount = new Set(Object.values(state.nwsLocal).flat().map((a) => a.id)).size;
    setStat('#statNws', sev.length.toLocaleString(), places().length ? `${localCount} at your places · ${sev.length} severe US` : 'Severe & extreme · US');
    SG.map.renderNws(sev, state.prefs.showNws);

    const ul = $('#nwsList');
    if (!sev.length) {
      ul.innerHTML = `<li class="empty-state">${state.nwsLoadedOnce ? 'No extreme or severe alerts are active right now.' : 'Loading NWS alerts…'}</li>`;
      return;
    }
    const sorted = sev.slice().sort((a, b) => (SEV_ORDER[a.severity] ?? 5) - (SEV_ORDER[b.severity] ?? 5) || (b.sent || 0) - (a.sent || 0));
    ul.innerHTML = sorted.slice(0, 60).map((a) => `<li class="alert-item" data-nws="${esc(a.id)}" style="--c:var(${SEV_VAR[a.severity] || '--sev-minor'})" tabindex="0">
        <div><div class="alert-title">${esc(a.event)}</div><div class="alert-sub">${esc(a.areaDesc.length > 110 ? a.areaDesc.slice(0, 110) + '…' : a.areaDesc)}</div>
        <div class="alert-desc">${esc(a.headline)}\n\n${esc(a.description.slice(0, 1200))}\n\n<a href="${esc(a.url)}" target="_blank" rel="noopener">Full alert ↗</a></div></div>
      </li>`).join('') + (sorted.length > 60 ? `<li class="muted small">+ ${sorted.length - 60} more on weather.gov</li>` : '');
  }

  // ---- Rendering: places --------------------------------------------------------------
  function renderPlaces() {
    const h = state.home;
    const card = $('#homeCard');
    if (!h) {
      card.innerHTML = `<div class="place-icon"><svg viewBox="0 0 24 24"><path d="M3 11 12 4l9 7v9h-6v-6H9v6H3z" fill="currentColor"/></svg></div>
        <div class="place-body"><div class="place-name">No home set</div><div class="place-sub">Use your location, search, or pick on the map.</div></div>`;
    } else {
      card.innerHTML = `<div class="place-icon"><svg viewBox="0 0 24 24"><path d="M3 11 12 4l9 7v9h-6v-6H9v6H3z" fill="currentColor"/></svg></div>
        <div class="place-body">
          <div class="place-name" id="homeName">${esc(h.name)}</div>
          <div class="place-sub">${h.lat.toFixed(3)}, ${h.lon.toFixed(3)}</div>
          <div class="home-settings">
            <label class="field"><span>Radius: <b id="homeRadiusLabel">${fmtDist(h.radiusKm, state.prefs.units)}</b></span><input type="range" id="homeRadius" min="25" max="1500" step="25" value="${h.radiusKm}"></label>
            <label class="field"><span>Alert at</span><select id="homeMinMag">${[1, 2.5, 3.5, 4.5, 6].map((m) => `<option value="${m}"${m === h.minMag ? ' selected' : ''}>M${m.toFixed(1)}+</option>`).join('')}</select></label>
          </div>
        </div>
        <div class="place-actions"><button type="button" class="btn btn-sm" data-fly="home">View</button><button type="button" class="btn btn-sm btn-danger" id="homeRemove">Remove</button></div>`;
    }

    const ul = $('#areaList');
    if (!state.areas.length) {
      ul.innerHTML = '<li class="muted small">No saved areas yet. Add places you care about — family, work, a trip — and get alerts for them too.</li>';
    } else {
      ul.innerHTML = state.areas.map((a) => {
        const count = state.alerts.filter((x) => (x.kind === 'quake' ? x.hits.some((hh) => hh.place.id === a.id) : x.labels.includes(a.name))).length;
        return `<li class="place-card" data-area="${esc(a.id)}">
          <div class="place-icon" style="color:var(--info);background:color-mix(in srgb,var(--info) 18%,transparent)"><svg viewBox="0 0 24 24"><path d="M12 21s-7-6.3-7-11a7 7 0 0 1 14 0c0 4.7-7 11-7 11Z" fill="currentColor"/></svg></div>
          <div class="place-body"><div class="place-name">${esc(a.name)}</div><div class="place-sub">${fmtDist(a.radiusKm, state.prefs.units)} · M${a.minMag}+ · ${count} active alert${count === 1 ? '' : 's'}</div></div>
          <div class="place-actions">
            <button type="button" class="btn btn-sm" data-fly="${esc(a.id)}">View</button>
            <button type="button" class="btn btn-sm" data-edit="${esc(a.id)}">Edit</button>
            <button type="button" class="btn btn-sm btn-danger" data-delete="${esc(a.id)}" aria-label="Delete ${esc(a.name)}">✕</button>
          </div>
        </li>`;
      }).join('');
    }
    SG.map.renderPlaces(state.home, state.areas);
  }

  function placesChanged() {
    saveHome();
    saveAreas();
    renderPlaces();
    renderStats();
    renderList();
    updateAlerts({ silentKinds: ['quake', 'nws'] });
    renderPlaces(); // refresh per-area alert counts
    renderSetup();
    loadNws().catch(() => {});
  }

  function setHome(lat, lon, name) {
    const prev = state.home || {};
    state.home = { name: name || `${lat.toFixed(3)}, ${lon.toFixed(3)}`, lat, lon, radiusKm: prev.radiusKm || 250, minMag: prev.minMag || 2.5 };
    placesChanged();
    SG.map.fitRadius(lat, lon, state.home.radiusKm);
    toast({ title: 'Home location set', body: state.home.name });
  }

  // ---- Pick-on-map mode -----------------------------------------------------------------
  function startPick(target) {
    state.pick = target;
    $('#pickText').textContent = target === 'home' ? 'Click the map to set your home' : 'Click the map to place this area';
    $('#pickBanner').hidden = false;
    $('.map-wrap').classList.add('picking');
    if (window.matchMedia('(max-width: 760px)').matches) $('.map-wrap').scrollIntoView({ behavior: 'smooth' });
  }
  function endPick() {
    state.pick = null;
    $('#pickBanner').hidden = true;
    $('.map-wrap').classList.remove('picking');
  }
  async function handleMapPick(latlng) {
    if (!state.pick) return;
    const target = state.pick;
    endPick();
    const lat = latlng.lat;
    const lon = ((latlng.lng + 540) % 360) - 180; // wrap longitude
    if (target === 'home') {
      setHome(lat, lon, `${lat.toFixed(3)}, ${lon.toFixed(3)}`);
      const name = await SG.api.reverseGeocode(lat, lon);
      if (state.home && state.home.lat === lat) { state.home.name = name; saveHome(); renderPlaces(); }
    } else {
      setAreaDraft(lat, lon, null);
      switchTab('places');
      const name = await SG.api.reverseGeocode(lat, lon);
      if (state.areaDraft && state.areaDraft.lat === lat) setAreaDraft(lat, lon, name);
    }
  }

  // ---- Area form ---------------------------------------------------------------------
  function openAreaForm(area) {
    const f = $('#areaForm');
    f.hidden = false;
    $('#areaId').value = area ? area.id : '';
    $('#areaName').value = area ? area.name : '';
    $('#areaRadius').value = area ? area.radiusKm : 250;
    $('#areaMinMag').value = String(area ? area.minMag : 2.5);
    $('#areaSearch').value = '';
    $('#areaResults').innerHTML = '';
    state.areaDraft = area ? { lat: area.lat, lon: area.lon, name: area.name } : null;
    updateAreaCoords();
    updateRadiusLabel();
    $('#areaName').focus();
  }
  function closeAreaForm() {
    $('#areaForm').hidden = true;
    state.areaDraft = null;
  }
  function setAreaDraft(lat, lon, name) {
    state.areaDraft = { lat, lon, name };
    if (name && !$('#areaName').value.trim()) $('#areaName').value = name.split(',')[0].slice(0, 40);
    updateAreaCoords();
  }
  function updateAreaCoords() {
    const d = state.areaDraft;
    $('#areaCoords').textContent = d ? `📍 ${d.name ? d.name + ' · ' : ''}${d.lat.toFixed(3)}, ${d.lon.toFixed(3)}` : 'No location chosen yet.';
  }
  function updateRadiusLabel() {
    $('#areaRadiusLabel').textContent = fmtDist(+$('#areaRadius').value, state.prefs.units);
  }

  function renderResults(ul, results, onPick) {
    if (!results.length) { ul.innerHTML = '<li class="empty">No matches found.</li>'; return; }
    ul.innerHTML = results.map((r, i) => `<li><button type="button" data-i="${i}">${esc(r.name)}</button></li>`).join('');
    ul.onclick = (e) => {
      const b = e.target.closest('button[data-i]');
      if (!b) return;
      onPick(results[+b.dataset.i]);
      ul.innerHTML = '';
    };
  }

  async function runSearch(query, ul, onPick) {
    if (!query.trim()) return;
    ul.innerHTML = '<li class="empty">Searching…</li>';
    try {
      renderResults(ul, await SG.api.geocode(query), onPick);
    } catch (e) {
      ul.innerHTML = '<li class="empty">Search is unavailable right now. Try “lat, lon” or pick on the map.</li>';
    }
  }

  // ---- UI helpers --------------------------------------------------------------------------
  function switchTab(name) {
    $$('.tab').forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $$('.tab-panel').forEach((p) => {
      const on = p.id === 'tab-' + name;
      p.hidden = !on;
      p.classList.toggle('active', on);
    });
    if (window.matchMedia('(max-width: 760px)').matches) {
      const tabs = $('.tabs');
      if (tabs.getBoundingClientRect().top < 0 || tabs.getBoundingClientRect().top > window.innerHeight * 0.6) tabs.scrollIntoView({ behavior: 'smooth' });
    }
  }

  function toast({ title, body = '', color, onClick, timeout = 8000 }) {
    const box = $('#toasts');
    while (box.children.length >= 4) box.firstElementChild.remove();
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    if (color) el.style.setProperty('--c', color);
    el.innerHTML = `<b>${esc(title)}</b><span>${esc(body)}</span>`;
    const close = () => { el.classList.add('leaving'); setTimeout(() => el.remove(), 300); };
    el.addEventListener('click', () => { if (onClick) onClick(); close(); });
    box.appendChild(el);
    setTimeout(close, timeout);
  }

  function setLive(s) {
    const el = $('#liveStatus');
    el.dataset.state = s;
    $('#liveLabel').textContent = { live: 'LIVE', loading: 'UPDATING', error: 'OFFLINE', connecting: 'CONNECTING' }[s] || 'LIVE';
    tick();
  }
  function showError(msg) {
    $('#errorText').textContent = msg;
    $('#errorBanner').hidden = false;
  }
  function hideError() {
    $('#errorBanner').hidden = true;
  }

  const RING_C = 2 * Math.PI * 15;
  function tick() {
    const now = Date.now();
    if (state.lastQuakeFetch) {
      $('#updatedAgo').textContent = `Updated ${timeAgo(state.lastQuakeFetch, now)}`;
    }
    const left = state.nextQuakeAt ? Math.max(0, Math.ceil((state.nextQuakeAt - now) / 1000)) : QUAKE_REFRESH_S;
    $('#countdownText').textContent = state.loading ? '…' : String(left);
    $('#refreshLabel').textContent = state.loading ? 'Updating now…' : `Next update in ${left}s`;
    const ring = $('#countdownRing');
    ring.style.strokeDasharray = RING_C.toFixed(2);
    ring.style.strokeDashoffset = (RING_C * (1 - left / QUAKE_REFRESH_S)).toFixed(2);
  }

  function heartbeat() {
    tick();
    const now = Date.now();
    if (document.hidden) return; // save bandwidth in background tabs; catch up on return
    if (state.nextQuakeAt && now >= state.nextQuakeAt && !state.loading) loadQuakes();
    if (state.nextNwsAt && now >= state.nextNwsAt) loadNws().catch(() => {});
  }

  function refreshAgoLabels() {
    const now = Date.now();
    $$('[data-ago]').forEach((el) => { el.textContent = timeAgo(+el.dataset.ago, now); });
  }

  function applyTheme() {
    document.documentElement.dataset.theme = state.prefs.theme;
    document.querySelector('meta[name="theme-color"]').setAttribute('content', state.prefs.theme === 'light' ? '#ffffff' : '#0b0f17');
    const bm = state.prefs.basemap;
    if (!bm || bm === 'dark' || bm === 'light') setBasemap(state.prefs.theme === 'light' ? 'light' : 'dark', !!bm);
  }

  function setBasemap(key, remember = true) {
    SG.map.setBasemap(key);
    if (remember) { state.prefs.basemap = key; savePrefs(); }
    $$('#basemapSwitch button').forEach((b) => b.setAttribute('aria-checked', b.dataset.basemap === key ? 'true' : 'false'));
  }

  // ---- Guidance: welcome guide & getting-started steps ---------------------------------
  let lastFocus = null;
  function openWelcome() {
    lastFocus = document.activeElement;
    $('#welcome').hidden = false;
    $('#welcomeSetHome').focus();
  }
  function closeWelcome() {
    if ($('#welcome').hidden) return;
    $('#welcome').hidden = true;
    store.set('onboarded', true);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function goToSection(tab, sectionId) {
    switchTab(tab);
    const sec = document.getElementById(sectionId);
    if (!sec) return;
    sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    sec.classList.remove('highlight');
    void sec.offsetWidth;
    sec.classList.add('highlight');
    setTimeout(() => sec.classList.remove('highlight'), 3000);
  }

  function renderSetup() {
    const card = $('#setupCard');
    const prog = SG.checklist && SG.checklist.progress ? SG.checklist.progress() : { done: 0 };
    const steps = [
      { id: 'home', text: 'Set your home location', done: !!state.home, action: 'Set home' },
      { id: 'area', text: 'Add a place you care about (optional)', done: state.areas.length > 0, action: 'Add area' },
      { id: 'prep', text: 'Start your preparedness checklist', done: prog.done > 0, action: 'Open' },
    ];
    const done = steps.filter((x) => x.done).length;
    if (store.get('setupDismissed', false) || done === steps.length) { card.hidden = true; return; }
    card.hidden = false;
    $('#setupProgress').textContent = `${done} of ${steps.length} done`;
    $('#setupSteps').innerHTML = steps.map((st, i) => `<li class="${st.done ? 'done' : ''}">
        <span class="dot">${st.done ? '✓' : i + 1}</span>
        <span class="step-text">${esc(st.text)}</span>
        ${st.done ? '' : `<button type="button" class="btn" data-setup="${st.id}">${esc(st.action)}</button>`}
      </li>`).join('');
  }

  function rerenderAll() {
    renderQuakeViews();
    renderNwsViews();
    renderPlaces();
    renderAlerts();
  }

  // ---- Wiring ---------------------------------------------------------------------------
  function bind() {
    $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

    // Welcome guide
    $('#helpBtn').addEventListener('click', openWelcome);
    $('#welcomeClose').addEventListener('click', closeWelcome);
    $('#welcomeExplore').addEventListener('click', closeWelcome);
    $('#welcomeSetHome').addEventListener('click', () => { closeWelcome(); goToSection('places', 'homeSection'); });
    $('#welcome').addEventListener('click', (e) => { if (e.target.id === 'welcome') closeWelcome(); });

    // Getting-started steps
    $('#setupDismiss').addEventListener('click', () => { store.set('setupDismissed', true); renderSetup(); });
    $('#setupSteps').addEventListener('click', (e) => {
      const b = e.target.closest('[data-setup]');
      if (!b) return;
      if (b.dataset.setup === 'home') goToSection('places', 'homeSection');
      else if (b.dataset.setup === 'area') { goToSection('places', 'areasSection'); openAreaForm(null); }
      else switchTab('prepare');
    });

    // Summary cards on the map are shortcuts
    $('#statCountBtn').addEventListener('click', () => { switchTab('live'); $('#quakeList').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
    $('#statMaxBtn').addEventListener('click', () => {
      const max = state.dayQuakes.reduce((m, q) => ((q.mag || -9) > (m ? m.mag || -9 : -9) ? q : m), null);
      if (max) { state.quakeById.set(max.id, max); selectQuake(max.id, { fly: true }); }
    });
    $('#statNearBtn').addEventListener('click', () => {
      const h = state.home;
      if (!h) { goToSection('places', 'homeSection'); return; }
      let best = null; let bestD = Infinity;
      state.dayQuakes.forEach((q) => { const d = distanceKm(h.lat, h.lon, q.lat, q.lon); if (d < bestD) { bestD = d; best = q; } });
      if (best) selectQuake(best.id, { fly: true });
    });
    $('#statNwsBtn').addEventListener('click', () => switchTab('alerts'));

    // Map style
    $('#basemapSwitch').addEventListener('click', (e) => {
      const b = e.target.closest('[data-basemap]');
      if (b) setBasemap(b.dataset.basemap);
    });
    if (window.matchMedia('(max-width: 760px)').matches) $('#legend').open = false;
    document.addEventListener('click', (e) => {
      const g = e.target.closest('[data-goto]');
      if (g) switchTab(g.dataset.goto);
    });

    $('#refreshBtn').addEventListener('click', refreshAll);
    $('#errorRetry').addEventListener('click', refreshAll);

    $('#unitsBtn').textContent = state.prefs.units;
    $('#unitsBtn').addEventListener('click', () => {
      state.prefs.units = state.prefs.units === 'km' ? 'mi' : 'km';
      $('#unitsBtn').textContent = state.prefs.units;
      savePrefs();
      rerenderAll();
      if (!$('#areaForm').hidden) updateRadiusLabel();
    });
    $('#themeBtn').addEventListener('click', () => {
      state.prefs.theme = state.prefs.theme === 'dark' ? 'light' : 'dark';
      savePrefs();
      applyTheme();
      rerenderAll();
    });

    // Live tab filters
    $('#windowSelect').value = state.prefs.window;
    $('#magSelect').value = state.prefs.minMag;
    $('#sortSelect').value = state.prefs.sort;
    $('#windowSelect').addEventListener('change', (e) => {
      state.prefs.window = e.target.value;
      state.listLimit = LIST_PAGE;
      savePrefs();
      loadQuakes({ force: true });
    });
    $('#magSelect').addEventListener('change', (e) => { state.prefs.minMag = e.target.value; state.listLimit = LIST_PAGE; savePrefs(); renderList(); renderMapQuakes(); });
    $('#sortSelect').addEventListener('change', (e) => {
      state.prefs.sort = e.target.value;
      if (e.target.value === 'nearest' && !state.home) toast({ title: 'No home location yet', body: 'Set one in Places to sort by distance.', onClick: () => switchTab('places') });
      savePrefs();
      renderList();
    });
    $('#searchInput').addEventListener('input', debounce((e) => { state.search = e.target.value; state.listLimit = LIST_PAGE; renderList(); renderMapQuakes(); }, 200));

    const list = $('#quakeList');
    list.addEventListener('click', (e) => {
      if (e.target.id === 'moreBtn') { state.listLimit += LIST_PAGE; renderList(); return; }
      const li = e.target.closest('.quake');
      if (li) selectQuake(li.dataset.id, { fly: true });
    });
    list.addEventListener('keydown', (e) => {
      const li = e.target.closest('.quake');
      if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectQuake(li.dataset.id, { fly: true }); }
    });

    $('#detail').addEventListener('click', (e) => {
      if (e.target.id === 'detailClose') closeDetail();
      if (e.target.id === 'detailZoom' && state.selectedId) SG.map.focusQuake(state.selectedId, 8);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('#welcome').hidden) closeWelcome();
        else if (state.pick) endPick();
        else if (state.selectedId) closeDetail();
      }
    });

    $('#toggleNws').checked = state.prefs.showNws;
    $('#toggleNws').addEventListener('change', (e) => { state.prefs.showNws = e.target.checked; savePrefs(); SG.map.renderNws(state.nwsSevere, state.prefs.showNws); });

    // Alerts tab
    $('#markReadBtn').addEventListener('click', () => { state.alerts.forEach((a) => state.read.add(a.key)); saveRead(); renderAlerts(); });
    const onAlertActivate = (e) => {
      const li = e.target.closest('.alert-item');
      if (!li || e.target.closest('a')) return;
      if (li.dataset.key) {
        const a = state.alerts.find((x) => x.key === li.dataset.key);
        state.read.add(li.dataset.key);
        saveRead();
        if (a && a.kind === 'quake') { selectQuake(a.quake.id, { fly: true }); renderAlerts(); return; }
        const wasOpen = li.classList.contains('open');
        renderAlerts();
        const again = document.querySelector(`#alertList [data-key="${CSS.escape(li.dataset.key)}"]`);
        if (again && !wasOpen) again.classList.add('open');
        if (a && !wasOpen) SG.map.fitGeometry(a.alert.geometry);
      } else if (li.dataset.nws) {
        li.classList.toggle('open');
        const a = state.nwsSevere.find((x) => x.id === li.dataset.nws);
        if (a && li.classList.contains('open')) SG.map.fitGeometry(a.geometry);
      }
    };
    $('#alertList').addEventListener('click', onAlertActivate);
    $('#nwsList').addEventListener('click', onAlertActivate);

    const nt = $('#notifyToggle');
    nt.checked = state.prefs.notify && 'Notification' in window && Notification.permission === 'granted';
    nt.addEventListener('change', async () => {
      if (!nt.checked) { state.prefs.notify = false; savePrefs(); return; }
      if (!('Notification' in window)) { nt.checked = false; $('#notifyStatus').textContent = 'This browser doesn’t support notifications.'; return; }
      let perm = Notification.permission;
      if (perm === 'default') perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        nt.checked = false;
        $('#notifyStatus').textContent = 'Notifications are blocked for this page. Enable them in your browser’s site settings.';
        return;
      }
      state.prefs.notify = true;
      savePrefs();
      $('#notifyStatus').textContent = 'On — you’ll get a pop-up for new alerts while SafeGround is open.';
    });

    // Places tab: home
    $('#homeGeoBtn').addEventListener('click', () => {
      if (!navigator.geolocation) { toast({ title: 'Location unavailable', body: 'Your browser doesn’t support geolocation. Search or pick on the map instead.' }); return; }
      $('#homeGeoBtn').textContent = 'Locating…';
      navigator.geolocation.getCurrentPosition(async (pos) => {
        $('#homeGeoBtn').textContent = 'Use my location';
        const { latitude: lat, longitude: lon } = pos.coords;
        setHome(lat, lon, 'My location');
        const name = await SG.api.reverseGeocode(lat, lon);
        if (state.home && state.home.lat === lat) { state.home.name = name; saveHome(); renderPlaces(); }
      }, (err) => {
        $('#homeGeoBtn').textContent = 'Use my location';
        toast({ title: 'Couldn’t get your location', body: err && err.code === 1 ? 'Permission was denied. Search or pick on the map instead.' : 'Try searching or picking on the map.' });
      }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 600000 });
    });
    $('#homePickBtn').addEventListener('click', () => startPick('home'));
    $('#homeSearchForm').addEventListener('submit', (e) => {
      e.preventDefault();
      runSearch($('#homeSearch').value, $('#homeResults'), (r) => { $('#homeSearch').value = ''; setHome(r.lat, r.lon, r.name.split(',').slice(0, 3).join(',')); });
    });
    $('#homeCard').addEventListener('input', (e) => {
      if (e.target.id === 'homeRadius') $('#homeRadiusLabel').textContent = fmtDist(+e.target.value, state.prefs.units);
    });
    $('#homeCard').addEventListener('change', (e) => {
      if (!state.home) return;
      if (e.target.id === 'homeRadius') state.home.radiusKm = +e.target.value;
      else if (e.target.id === 'homeMinMag') state.home.minMag = +e.target.value;
      else return;
      placesChanged();
    });
    $('#homeCard').addEventListener('click', (e) => {
      if (e.target.id === 'homeRemove') { state.home = null; placesChanged(); }
      if (e.target.dataset.fly === 'home' && state.home) SG.map.fitRadius(state.home.lat, state.home.lon, state.home.radiusKm);
    });

    // Places tab: areas
    $('#addAreaBtn').addEventListener('click', () => openAreaForm(null));
    $('#areaCancel').addEventListener('click', closeAreaForm);
    $('#areaPickBtn').addEventListener('click', () => startPick('area'));
    $('#areaRadius').addEventListener('input', updateRadiusLabel);
    const areaSearch = () => runSearch($('#areaSearch').value, $('#areaResults'), (r) => setAreaDraft(r.lat, r.lon, r.name));
    $('#areaSearchBtn').addEventListener('click', areaSearch);
    $('#areaSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); areaSearch(); } });
    $('#areaForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('#areaName').value.trim();
      const d = state.areaDraft;
      if (!name) { $('#areaName').focus(); return; }
      if (!d) { $('#areaCoords').textContent = '⚠ Choose a location: search, or pick on the map.'; return; }
      const id = $('#areaId').value;
      const data = { name, lat: d.lat, lon: d.lon, radiusKm: +$('#areaRadius').value, minMag: +$('#areaMinMag').value };
      if (id) {
        const a = state.areas.find((x) => x.id === id);
        if (a) Object.assign(a, data);
      } else {
        state.areas.push(Object.assign({ id: 'a-' + uid() }, data));
      }
      closeAreaForm();
      placesChanged();
      SG.map.fitRadius(data.lat, data.lon, data.radiusKm);
      toast({ title: id ? 'Area updated' : 'Area saved', body: `${name} · alerts for M${data.minMag}+ within ${fmtDist(data.radiusKm, state.prefs.units)}` });
    });
    $('#areaList').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.fly) {
        const a = state.areas.find((x) => x.id === b.dataset.fly);
        if (a) SG.map.fitRadius(a.lat, a.lon, a.radiusKm);
      } else if (b.dataset.edit) {
        openAreaForm(state.areas.find((x) => x.id === b.dataset.edit));
      } else if (b.dataset.delete) {
        state.areas = state.areas.filter((x) => x.id !== b.dataset.delete);
        placesChanged();
      }
    });

    $('#pickCancel').addEventListener('click', endPick);
    SG.map.onPick(handleMapPick);

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) heartbeat();
    });
    window.addEventListener('resize', debounce(() => SG.map.invalidate(), 150));
  }

  // ---- Boot ----------------------------------------------------------------------------------
  function boot() {
    document.documentElement.dataset.theme = state.prefs.theme;
    SG.map.init($('#map'), {
      theme: state.prefs.theme,
      basemap: state.prefs.basemap || (state.prefs.theme === 'light' ? 'light' : 'dark'),
      onFallback: () => toast({ title: 'Switched map provider', body: 'The default map tiles didn’t load, so SafeGround is using OpenStreetMap instead.' }),
      onQuakeClick: (id) => selectQuake(id),
      onAlertClick: (id) => {
        switchTab('alerts');
        const li = document.querySelector(`#nwsList [data-nws="${CSS.escape(id)}"]`);
        if (li) { li.classList.add('open'); li.scrollIntoView({ block: 'nearest' }); }
      },
    });
    applyTheme();
    if (state.prefs.basemap) setBasemap(state.prefs.basemap, false);
    bind();
    SG.checklist.init({ onChange: () => renderSetup() });
    renderSetup();
    if (!store.get('onboarded', false)) openWelcome();
    renderPlaces();
    renderAlerts();
    renderNwsViews();
    if (state.home) SG.map.flyTo(state.home.lat, state.home.lon, 4);

    refreshAll();
    setInterval(heartbeat, 1000);
    setInterval(refreshAgoLabels, 15000);
  }

  // Small public surface for debugging and automated tests.
  window.SafeGround = {
    state,
    refresh: refreshAll,
    config: { QUAKE_REFRESH_S, NWS_REFRESH_S },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
