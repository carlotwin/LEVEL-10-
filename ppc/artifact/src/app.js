// ---------------------------------------------------------------------------
// App shell: state, filters, pages, recompute and boot.
// ---------------------------------------------------------------------------
const state = {
  dataset: null, datasetSource: 'loading', datasetVersion: 0, loadedAssetId: null, loadingShared: false, demo: null,
  pointer: undefined, settings: null, overrides: null, decisions: {}, acks: {}, imports: [], profiles: {},
  view: 'overview', group: 'keyword_city', sort: { key: 'spend', dir: 'desc' }, termSort: { key: 'spend', dir: 'desc' },
  queueTab: 'proposed', showAllRows: false,
  filters: { preset: '90', start: '', end: '', cities: [], counties: [], campaigns: [], keywordSearch: '', situations: [], quality: 'all', recommendations: [] },
  model: null, queue: null, modelKey: '', analysis: null, error: null,
};

const VIEWS = [
  { id: 'overview', label: 'Overview', render: viewOverview, filters: true },
  { id: 'table', label: 'Keyword + city', render: viewTable, filters: true },
  { id: 'terms', label: 'Search terms', render: viewTerms, filters: true },
  { id: 'landing', label: 'Landing pages', render: viewLanding, filters: true },
  { id: 'retargeting', label: 'Retargeting', render: viewRetargeting, filters: false },
  { id: 'actions', label: 'Action Queue', render: viewActions, filters: false },
  { id: 'health', label: 'Data health', render: viewHealth, filters: true },
  { id: 'sources', label: 'Data sources', render: viewSources, filters: false },
  { id: 'settings', label: 'Settings', render: viewSettings, filters: false },
];
const viewById = (id) => VIEWS.find((v) => v.id === id) || VIEWS[0];

// ---------------------------------------------------------------- per-viewer conveniences
const PREFS_KEY = 'twin-ppc-prefs-v1';
function saveLocal() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ view: state.view, group: state.group, sort: state.sort, filters: state.filters }));
  } catch { /* storage unavailable: fine */ }
}
function loadLocal() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
    if (!p) return;
    if (p.view && VIEWS.some((v) => v.id === p.view)) state.view = p.view;
    if (p.group) state.group = p.group;
    if (p.sort?.key) state.sort = p.sort;
    if (p.filters) state.filters = { ...state.filters, ...p.filters };
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- compute
function engineSettings() {
  return { ...(state.settings || {}), situationOverrides: state.overrides?.situations || {} };
}
function effectiveFilters() {
  const f = state.filters;
  const max = state.model?.bounds.max;
  let start = null;
  let end = null;
  if (f.preset === 'custom') {
    start = f.start || null;
    end = f.end || null;
  } else if (f.preset !== 'all' && max) {
    end = max;
    start = PPC.addDays(max, -(Number(f.preset) - 1));
  }
  return {
    start, end, cities: f.cities, counties: f.counties, campaigns: f.campaigns, keywordSearch: f.keywordSearch,
    situations: f.situations, quality: f.quality === 'all' ? null : f.quality, recommendations: [],
  };
}
function recompute() {
  if (!state.dataset) return;
  const key = `${state.datasetVersion}|${JSON.stringify(state.settings || {})}|${JSON.stringify(state.overrides || {})}`;
  const raw = engineSettings();
  if (!state.model || key !== state.modelKey) {
    state.model = PPC.buildModel(state.dataset, raw);
    state.queue = PPC.decisionQueue(state.model, raw);
    state.modelKey = key;
  }
  state.analysis = PPC.analyze(state.dataset, raw, effectiveFilters(), { model: state.model, queue: state.queue });
}
async function setDataset(ds, source) {
  state.dataset = ds;
  state.datasetSource = source;
  state.datasetVersion += 1;
  state.showAllRows = false;
  try {
    recompute();
    state.error = null;
  } catch (e) {
    console.error(e);
    state.error = `The data could not be analysed: ${e?.message || e}`;
  }
  renderAll();
}

// ---------------------------------------------------------------- navigation
function go(view) {
  if (!VIEWS.some((v) => v.id === view)) return;
  state.view = view;
  if (location.hash !== `#${view}`) {
    try { history.replaceState(null, '', `#${view}`); } catch { location.hash = view; }
  }
  saveLocal();
  closePopovers();
  renderAll();
  $('view').focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
}

// ---------------------------------------------------------------- rendering
let renderQueued = false;
function renderAll() {
  renderTopbar();
  renderTabs();
  renderFilters();
  renderView();
  renderFooter();
}
function scheduleRecompute() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    $('view').classList.add('busy');
    requestAnimationFrame(() => {
      try { recompute(); } catch (e) { state.error = String(e?.message || e); }
      $('view').classList.remove('busy');
      renderTopbar();
      renderTabs();
      renderView();
      renderFooter();
    });
  }, 120);
}

function renderTopbar() {
  const el = clear($('topbar-status'));
  const ds = state.dataset;
  if (state.loadingShared) el.append(chip('Loading your team’s data…', 'info'));
  if (ds) {
    if (ds.isDemo) el.append(chip('Demo data', 'demo'));
    else {
      const last = ds.sync?.sources?.google_ads?.lastSuccessAt || state.pointer?.uploadedAt;
      el.append(chip(`Live data · updated ${fmt.ago(last)}`, 'good'));
    }
  }
  const a = state.analysis;
  if (a) {
    const problems = a.health.summary.problems;
    const hc = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => go('health') }, chip(problems ? `${problems} data ${problems === 1 ? 'issue' : 'issues'}` : 'Data looks healthy', problems ? (a.health.summary.status === 'error' ? 'bad' : 'warn') : 'good'));
    el.append(hc);
  }
  el.append(chip(`You: ${ROLE_LABEL[me.role]}`, me.role === 'admin' ? 'info' : 'neutral', ROLE_HINT[me.role]));
  const banner = $('demo-banner');
  banner.hidden = !ds?.isDemo;
  $('demo-banner-text').textContent = ds?.isDemo
    ? (state.pointer === undefined && rt.db ? 'Made-up numbers for illustration. Checking for your team’s data…' : 'Made-up numbers for illustration. No real leads, spend or people. Import or sync real data on the Data sources page.')
    : '';
}

function renderTabs() {
  const el = clear($('tabs'));
  const a = state.analysis;
  const waiting = a ? PPC.mergeActionState(a.actions, state.decisions).filter((x) => x.status === 'proposed').length : 0;
  const problems = a ? a.health.summary.problems : 0;
  for (const v of VIEWS) {
    const count = v.id === 'actions' && waiting ? h('span', { class: 'tab-count' }, fmt.int(waiting))
      : v.id === 'health' && problems ? h('span', { class: 'tab-count alert' }, fmt.int(problems)) : null;
    el.append(h('button', { class: 'tab', type: 'button', 'aria-current': state.view === v.id ? 'page' : null, onclick: () => go(v.id) }, v.label, count));
  }
}

function closePopovers(except) {
  document.querySelectorAll('details.filter[open]').forEach((d) => { if (d !== except) d.open = false; });
}

function multiFilter(label, key, options) {
  const selected = new Set(state.filters[key] || []);
  const labelOf = (v) => options.find((o) => o.value === v)?.label || v;
  const valueEl = h('span', { class: 'filter-value' });
  const det = h('details', { class: 'filter' });
  const refresh = () => {
    valueEl.textContent = selected.size ? (selected.size === 1 ? labelOf([...selected][0]) : `${selected.size} selected`) : 'All';
    det.classList.toggle('active', selected.size > 0);
  };
  const apply = () => {
    state.filters[key] = [...selected];
    refresh();
    saveLocal();
    scheduleRecompute();
  };
  const rows = options.map((o) => h('label', { class: 'check-row', dataset: { text: o.label.toLowerCase() } },
    h('input', { type: 'checkbox', checked: selected.has(o.value), onchange: (e) => { if (e.target.checked) selected.add(o.value); else selected.delete(o.value); apply(); } }),
    h('span', {}, o.label)));
  const list = h('div', { class: 'filter-options' }, rows);
  const search = options.length > 8 ? h('input', {
    class: 'input', type: 'search', placeholder: `Find ${label.toLowerCase()}`, 'aria-label': `Find ${label.toLowerCase()}`,
    oninput: (e) => { const q = e.target.value.toLowerCase(); rows.forEach((r) => { r.hidden = !!q && !r.dataset.text.includes(q); }); },
  }) : null;
  appendKids(det, [
    h('summary', {}, h('span', { class: 'filter-name' }, label), valueEl),
    h('div', { class: 'filter-pop' }, search, options.length ? list : h('p', { class: 'small muted' }, 'Nothing to choose in this data.'),
      h('div', { class: 'filter-actions' },
        button('Clear', () => { selected.clear(); rows.forEach((r) => { r.querySelector('input').checked = false; }); apply(); }, { kind: 'ghost', small: true }),
        button('Done', () => { det.open = false; }, { small: true })))]);
  det.addEventListener('toggle', () => { if (det.open) closePopovers(det); });
  refresh();
  return det;
}

let searchTimer = null;
function renderFilters() {
  const el = clear($('filters'));
  const v = viewById(state.view);
  const a = state.analysis;
  el.hidden = !v.filters || !a;
  if (el.hidden) return;
  const f = state.filters;
  const opts = a.options;
  const max = a.model.bounds.max;
  const presets = [['7', 'Last 7 days'], ['14', 'Last 14 days'], ['30', 'Last 30 days'], ['60', 'Last 60 days'], ['90', 'Last 90 days'], ['all', 'All data'], ['custom', 'Custom dates']];
  const preset = h('select', {
    class: 'select', id: 'f-date', 'aria-label': 'Date range',
    onchange: (e) => {
      f.preset = e.target.value;
      if (f.preset === 'custom' && !f.start) { f.start = a.model.bounds.min || ''; f.end = max || ''; }
      saveLocal(); recompute(); renderAll();
    },
  }, presets.map(([val, text]) => h('option', { value: val, selected: f.preset === val }, text)));
  const range = h('span', { class: 'date-range' }, preset);
  if (f.preset === 'custom') {
    const dateInput = (key, label) => h('input', {
      class: 'input', type: 'date', value: f[key] || '', 'aria-label': label, min: a.model.bounds.min || null, max: max || null,
      onchange: (e) => { f[key] = e.target.value; saveLocal(); scheduleRecompute(); },
    });
    range.append(dateInput('start', 'From'), h('span', { class: 'muted' }, 'to'), dateInput('end', 'To'));
  } else if (max) {
    range.append(h('span', { class: 'small muted' }, `to ${fmt.date(max)}`));
  }
  const cityOpts = opts.cities.map((c) => ({ value: c, label: c === '(unknown)' ? 'Unknown city' : c }));
  const countyOpts = opts.counties.map((c) => ({ value: c, label: `${c} County` }));
  const campOpts = opts.campaigns.map((c) => ({ value: c.id, label: c.name }));
  const sitOpts = opts.situations.map((s2) => ({ value: s2.code, label: s2.label }));
  const kw = h('input', {
    class: 'input', type: 'search', id: 'f-keyword', placeholder: 'Keyword contains…', value: f.keywordSearch || '', 'aria-label': 'Keyword contains',
    oninput: (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { f.keywordSearch = e.target.value.trim(); saveLocal(); scheduleRecompute(); }, 250); },
  });
  const quality = h('select', {
    class: 'select', id: 'f-quality', 'aria-label': 'Lead quality',
    onchange: (e) => { f.quality = e.target.value; saveLocal(); scheduleRecompute(); },
  }, [['all', 'All leads'], ['qualified', 'Qualified leads'], ['unqualified', 'Unqualified leads'], ['junk', 'Junk leads'], ['hot', 'Hot leads (score 9+)']].map(([val, text]) => h('option', { value: val, selected: f.quality === val }, text)));
  const activeCount = [f.cities.length, f.counties.length, f.campaigns.length, f.situations.length, f.keywordSearch, f.quality !== 'all'].filter(Boolean).length;
  const active = !!(activeCount || f.preset !== '90');
  // On a phone the filters fold behind one button; the date range stays visible.
  const toggle = h('button', {
    class: 'btn btn-sm filters-toggle', type: 'button', 'aria-expanded': String(!!state.filtersOpen), 'aria-controls': 'filter-items',
    onclick: () => { state.filtersOpen = !state.filtersOpen; renderFilters(); },
  }, activeCount ? `Filters (${activeCount})` : 'Filters');
  const items = h('div', { class: `filter-items${state.filtersOpen ? ' open' : ''}`, id: 'filter-items' });
  appendKids(items, [multiFilter('City', 'cities', cityOpts), multiFilter('County', 'counties', countyOpts), multiFilter('Campaign', 'campaigns', campOpts), kw,
    multiFilter('Seller situation', 'situations', sitOpts), quality,
    active ? button('Reset filters', resetFilters, { kind: 'ghost', small: true }) : null]);
  appendKids(el, [range, toggle, items]);
}
function resetFilters() {
  state.filters = { ...state.filters, preset: '90', start: '', end: '', cities: [], counties: [], campaigns: [], keywordSearch: '', situations: [], quality: 'all', recommendations: [] };
  saveLocal();
  recompute();
  renderAll();
}

function renderView() {
  const root = clear($('view'));
  hideTooltip();
  if (state.error) {
    root.append(note(state.error, 'bad'));
    if (state.demo && state.dataset !== state.demo) root.append(button('Show demo data', () => setDataset(state.demo, 'demo')));
    return;
  }
  if (!state.analysis) {
    root.append(h('div', { class: 'loading' }, h('p', { class: 'loading-title' }, 'Loading the dashboard…'), h('p', { class: 'loading-sub' }, 'Money, lead quality, deals and recommendations appear here in a moment.')));
    return;
  }
  const v = viewById(state.view);
  try {
    v.render(root, state.analysis);
  } catch (e) {
    console.error(e);
    clear(root);
    root.append(note(`This page could not be drawn: ${e?.message || e}. The other pages still work.`, 'bad'));
  }
}

function renderFooter() {
  const el = clear($('footer'));
  const a = state.analysis;
  appendKids(el, [
    h('span', {}, `Engine ${PPC.ENGINE_VERSION}`),
    h('span', {}, state.dataset?.isDemo ? 'Demo data' : 'Team data'),
    a?.model.bounds.max ? h('span', {}, `Latest data: ${fmt.date(a.model.bounds.max)}`) : null,
    a ? h('span', {}, `Action Queue decides on the last ${a.decisionWindow.days} days`) : null,
    h('span', {}, 'Version 1: recommendations only. Nothing here changes Google Ads.')]);
}

// ---------------------------------------------------------------- shared state from the store
async function onShared(kind, value) {
  switch (kind) {
    case 'pointer': {
      state.pointer = value || null;
      if (value?.assetId && value.assetId !== state.loadedAssetId) {
        state.loadingShared = true;
        renderTopbar();
        try {
          const ds = await loadSharedDataset(value);
          state.loadedAssetId = value.assetId;
          state.loadingShared = false;
          await setDataset(ds, 'shared');
        } catch (e) {
          state.loadingShared = false;
          console.error(e);
          toast('Your team’s saved data could not be loaded. Showing demo data; an editor can re-import on Data sources.', 'bad');
          renderAll();
        }
      } else if (!value?.assetId && state.datasetSource !== 'demo' && state.demo) {
        state.loadedAssetId = null;
        await setDataset(state.demo, 'demo');
      } else {
        renderTopbar();
      }
      break;
    }
    case 'settings':
      state.settings = value;
      if (state.dataset) { recompute(); renderAll(); }
      break;
    case 'overrides':
      state.overrides = value;
      if (state.dataset) { recompute(); renderAll(); }
      break;
    case 'decisions':
      state.decisions = value || {};
      renderTabs();
      if (['actions', 'overview', 'terms'].includes(state.view)) renderView();
      break;
    case 'acks':
      state.acks = value || {};
      if (['overview', 'health'].includes(state.view)) renderView();
      break;
    case 'imports':
      state.imports = value || [];
      if (state.view === 'sources') renderView();
      break;
    default:
  }
}

// ---------------------------------------------------------------- boot
function wireStatic() {
  $('drawer-close').addEventListener('click', closeDrawer);
  $('drawer').addEventListener('click', (e) => { if (e.target === $('drawer')) closeDrawer(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('drawer').hidden) closeDrawer();
      closePopovers();
      hideTooltip();
    }
  });
  document.addEventListener('click', (e) => {
    const inFilter = e.target.closest && e.target.closest('details.filter');
    closePopovers(inFilter || undefined);
  });
  window.addEventListener('hashchange', () => {
    const v = location.hash.slice(1);
    if (v && v !== state.view && VIEWS.some((x) => x.id === v)) go(v);
  });
  window.addEventListener('scroll', hideTooltip, { passive: true });
}

async function boot() {
  wireStatic();
  loadLocal();
  const fromHash = location.hash.slice(1);
  if (VIEWS.some((v) => v.id === fromHash)) state.view = fromHash;
  const demoP = loadDemoDataset().catch((e) => { console.error('Demo data did not load', e); return null; });
  const rtP = initRuntime();
  const demo = await demoP;
  state.demo = demo;
  if (demo && !state.dataset) await setDataset(demo, 'demo');
  await rtP;
  renderAll();
  if (rt.db) subscribeShared(onShared);
  else state.pointer = null;
  if (!demo && !state.dataset) {
    state.error = 'The demo data could not be loaded. Reload the page to try again.';
    renderView();
  }
}
boot();
