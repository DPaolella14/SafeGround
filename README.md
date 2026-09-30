# SafeGround

**Live earthquake & disaster tracker.** Real-time earthquakes from the USGS, weather and hazard alerts from NOAA's National Weather Service, your home and saved areas on a live map, personal alerts, and a preparedness checklist.

It's a plain static website: no build step, no API keys, no backend.

## Open it

- **Quickest:** double-click `index.html`.
- **Local server (optional):** `npm start`, then open <http://localhost:4173>.
- **Host it:** upload the folder to GitHub Pages, Netlify or any static host. For GitHub Pages, go to *Settings → Pages → Deploy from branch → `main` / root*.

## Features

| | |
|---|---|
| **Live map** | Earthquakes sized and colored by magnitude. Recent and newly arrived quakes pulse. Severe/Extreme NWS alert areas are drawn as polygons. Five map styles (Dark, Light, Streets, Satellite, Terrain), none of which needs an API key. A map key explains every symbol. |
| **Guidance** | A welcome guide on first visit (reopen it any time with **Help**), a "Get set up" checklist, a short explanation at the top of every tab, and clickable summary cards on the map. |
| **Auto-refresh** | USGS data refreshes every 60 s (the countdown ring is in the header) and NWS every 3 min. Background tabs pause and catch up when you come back. New quakes flash and get a **NEW** tag, and a toast appears for M5.5+ quakes worldwide. |
| **Live tab** | Time window (hour / 24 h / 7 days / 30 days), magnitude filter, sort (newest / largest / nearest to home), place search, and a 24-hour activity chart. Click any quake for depth, felt reports, PAGER level, tsunami flag, distance from your places, and a link to the USGS event page. |
| **Places** | Set your home by device location, search, or clicking the map. Add saved areas (family, work, trips), each with its own alert radius and magnitude threshold. |
| **Alerts** | Quakes inside your radii plus active NWS alerts at each place (US only). Includes an unread badge, toasts, and optional browser notifications. |
| **Prepare** | A 22-item checklist based on Ready.gov and USGS guidance, with a progress ring and your own custom items. It can be printed. |
| **Preferences** | Theme, km/mi, and filters are remembered. All your data stays in your browser (localStorage). |

## Data sources (free, no key)

- USGS Earthquake Hazards Program GeoJSON feeds: `earthquake.usgs.gov/earthquakes/feed/v1.0/summary/`
- NOAA / National Weather Service alerts API: `api.weather.gov/alerts/active`
- OpenStreetMap Nominatim for place search. You can also type `lat, lon` directly.
- Map: Leaflet 1.9.4 (bundled in `vendor/leaflet`) with Esri ArcGIS Online basemap tiles, which need no key. If those can't load, SafeGround switches to OpenStreetMap tiles automatically.

> SafeGround is not an official warning system. Always follow local authorities and official alerts.

## Testing with Playwright

```bash
npm install                 # installs @playwright/test
npx playwright install      # downloads the browsers (first time only)
npm test                    # full suite: desktop Chromium + mobile (Pixel 7)
npm run test:live           # smoke test against the REAL USGS + NWS APIs (needs internet)
npm run test:report         # open the HTML report from the last run
```

- `npm test` mocks USGS, NWS, geocoding and map tiles with realistic fixtures (`tests/helpers.js`), so results don't depend on today's earthquakes. The tests cover loading, live refresh, auto-refresh, the offline/error state, filters, sorting, time windows, quake details, home by search, geolocation and map pick, saved areas, alerts and badges, NWS alerts, the checklist, theme and units persistence, opening from `file://`, and mobile layout.
- `npm run test:live` checks that the real feeds load and render.
- Add `?refresh=10` to the URL to shorten the refresh interval, which is handy for demos and tests.

## Project layout

```
index.html            page shell
css/styles.css        all styling (dark/light, responsive, print)
js/util.js            helpers: distance, formatting, colors, safe localStorage
js/api.js             USGS / NWS / Nominatim clients
js/map.js             Leaflet layers (basemaps, quakes, pulses, NWS polygons, places)
js/checklist.js       preparedness checklist
js/app.js             state, refresh loop, alerts engine, UI
vendor/leaflet/       Leaflet 1.9.4 (BSD-2-Clause)
scripts/serve.js      zero-dependency local server
tests/                Playwright specs + fixtures
```
