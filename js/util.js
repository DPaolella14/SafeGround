/* SafeGround — shared helpers (plain script, no build step, works from file://) */
(function () {
  'use strict';
  const SG = (window.SG = window.SG || {});

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);

  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;

  /** Great-circle distance in km. */
  function distanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371.0088;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** Compass direction (N, NE, …) from point 1 to point 2. */
  function bearing(lat1, lon1, lat2, lon2) {
    const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
    const deg = (toDeg(Math.atan2(y, x)) + 360) % 360;
    return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
  }

  function timeAgo(ms, now = Date.now()) {
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 45) return s <= 5 ? 'just now' : `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 36) return `${h} hr${h === 1 ? '' : 's'} ago`;
    const d = Math.round(h / 24);
    return `${d} day${d === 1 ? '' : 's'} ago`;
  }

  function fmtDateTime(ms) {
    try {
      return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    } catch (e) {
      return new Date(ms).toString();
    }
  }

  function fmtDist(km, units) {
    if (km == null || !isFinite(km)) return '–';
    const v = units === 'mi' ? km * 0.621371 : km;
    const u = units === 'mi' ? 'mi' : 'km';
    return `${v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString()} ${u}`;
  }

  function fmtMag(m) {
    return m == null || !isFinite(m) ? '?' : Number(m).toFixed(1);
  }

  /** Magnitude → CSS custom property name for its color. */
  function magVar(m) {
    if (m == null || m < 2) return '--m1';
    if (m < 3) return '--m2';
    if (m < 4) return '--m3';
    if (m < 5) return '--m4';
    if (m < 6) return '--m5';
    return '--m6';
  }
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#4fd1c5';
  }
  const magColor = (m) => cssVar(magVar(m));

  /** Marker radius in px (roughly proportional to energy, but capped for legibility). */
  function magRadius(m) {
    const mm = Math.max(0, m == null ? 0 : m);
    return Math.max(3, Math.min(34, 2.5 + Math.pow(mm, 1.75) * 1.1));
  }

  function debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

  /** localStorage wrapper that never throws (private mode, file://, quotas…). */
  const PREFIX = 'safeground:';
  const memory = {};
  const store = {
    get(key, fallback) {
      try {
        const raw = window.localStorage.getItem(PREFIX + key);
        return raw == null ? (key in memory ? memory[key] : fallback) : JSON.parse(raw);
      } catch (e) {
        return key in memory ? memory[key] : fallback;
      }
    },
    set(key, value) {
      memory[key] = value;
      try {
        window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
      } catch (e) { /* ignore */ }
    },
    remove(key) {
      delete memory[key];
      try { window.localStorage.removeItem(PREFIX + key); } catch (e) { /* ignore */ }
    },
  };

  SG.util = { $, $$, esc, distanceKm, bearing, timeAgo, fmtDateTime, fmtDist, fmtMag, magVar, magColor, cssVar, magRadius, debounce, uid };
  SG.store = store;
})();
