/* SafeGround — preparedness checklist (Ready.gov / USGS "Seven Steps to Earthquake Safety") */
(function () {
  'use strict';
  const SG = (window.SG = window.SG || {});
  const { $, esc, uid } = SG.util;

  const DEFAULTS = [
    ['Water & food', [
      ['water', 'Water: 1 gallon per person per day, for at least 3 days'],
      ['food', '3-day supply of non-perishable food'],
      ['opener', 'Manual can opener & utensils'],
      ['pets', 'Pet food, water and supplies'],
    ]],
    ['Emergency kit', [
      ['firstaid', 'First aid kit'],
      ['meds', '7-day supply of prescription medications'],
      ['flashlight', 'Flashlight & extra batteries'],
      ['radio', 'Battery or hand-crank NOAA Weather Radio'],
      ['power', 'Phone chargers & a charged power bank'],
      ['whistle', 'Whistle to signal for help'],
      ['mask', 'Dust masks, work gloves & sturdy shoes by the bed'],
      ['cash', 'Cash in small bills'],
    ]],
    ['Documents & plan', [
      ['docs', 'Copies of IDs, insurance & medical info (waterproof bag)'],
      ['contacts', 'Printed emergency contact list'],
      ['meet', 'Family meeting place & out-of-area contact agreed'],
      ['alerts', 'Local emergency alerts (WEA / county alerts) enabled'],
      ['maps', 'Paper map of your area with evacuation routes'],
    ]],
    ['Home safety', [
      ['secure', 'Heavy furniture & water heater strapped to walls'],
      ['utilities', 'Know how to shut off gas, water & electricity'],
      ['extinguisher', 'Fire extinguisher, checked & accessible'],
      ['smoke', 'Smoke & CO detectors tested'],
      ['drill', 'Practised Drop, Cover, and Hold On this year'],
    ]],
  ];

  function defaultItems() {
    const items = [];
    DEFAULTS.forEach(([cat, list]) => list.forEach(([id, text]) => items.push({ id, text, cat, done: false, custom: false })));
    return items;
  }

  let items = [];
  let onChange = () => {};

  function load() {
    const saved = SG.store.get('checklist', null);
    if (!Array.isArray(saved)) {
      items = defaultItems();
      return;
    }
    // Merge: keep saved state, add any new default items shipped in later versions.
    const byId = new Map(saved.map((i) => [i.id, i]));
    items = saved.slice();
    defaultItems().forEach((d) => { if (!byId.has(d.id)) items.push(d); });
  }

  function save() {
    SG.store.set('checklist', items);
    onChange(progress());
  }

  function progress() {
    const total = items.length;
    const done = items.filter((i) => i.done).length;
    return { total, done, pct: total ? Math.round((done / total) * 100) : 0 };
  }

  function render() {
    const root = $('#checklist');
    const cats = [];
    items.forEach((i) => { if (!cats.includes(i.cat)) cats.push(i.cat); });
    root.innerHTML = cats.map((cat) => {
      const list = items.filter((i) => i.cat === cat);
      const done = list.filter((i) => i.done).length;
      return `<div class="check-group">
        <h4><span>${esc(cat)}</span><span>${done}/${list.length}</span></h4>
        ${list.map((i) => `
          <label class="check-item${i.done ? ' done' : ''}" data-id="${esc(i.id)}">
            <input type="checkbox" ${i.done ? 'checked' : ''} data-check="${esc(i.id)}">
            <span>${esc(i.text)}</span>
            ${i.custom ? `<button type="button" class="remove" data-remove="${esc(i.id)}" aria-label="Remove ${esc(i.text)}">×</button>` : ''}
          </label>`).join('')}
      </div>`;
    }).join('');

    const p = progress();
    const ring = $('#prepRing');
    const C = 2 * Math.PI * 34;
    ring.style.strokeDasharray = C.toFixed(1);
    ring.style.strokeDashoffset = (C * (1 - p.pct / 100)).toFixed(1);
    $('#prepPct').textContent = `${p.pct}%`;
    $('#prepCount').textContent = `${p.done} of ${p.total} ready`;
  }

  function init(opts = {}) {
    onChange = opts.onChange || onChange;
    load();
    render();

    $('#checklist').addEventListener('change', (e) => {
      const id = e.target.getAttribute('data-check');
      if (!id) return;
      const it = items.find((i) => i.id === id);
      if (it) it.done = e.target.checked;
      save();
      render();
    });
    $('#checklist').addEventListener('click', (e) => {
      const id = e.target.getAttribute && e.target.getAttribute('data-remove');
      if (!id) return;
      e.preventDefault();
      items = items.filter((i) => i.id !== id);
      save();
      render();
    });
    $('#customItemForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#customItem');
      const text = input.value.trim();
      if (!text) return;
      items.push({ id: 'c-' + uid(), text, cat: 'My items', done: false, custom: true });
      input.value = '';
      save();
      render();
    });
    $('#resetChecklist').addEventListener('click', () => {
      if (!window.confirm('Reset the checklist? Custom items and checkmarks will be cleared.')) return;
      items = defaultItems();
      save();
      render();
    });
    $('#printChecklist').addEventListener('click', () => window.print());
    onChange(progress());
  }

  SG.checklist = { init, progress, get items() { return items.slice(); } };
})();
