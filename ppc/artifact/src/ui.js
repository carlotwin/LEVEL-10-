// ---------------------------------------------------------------------------
// DOM helpers. Data is always inserted as text (textContent / text nodes),
// never as HTML: lead sources, keywords and file names are untrusted input.
// ---------------------------------------------------------------------------
const SVG_NS = 'http://www.w3.org/2000/svg';

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  setProps(el, props);
  appendKids(el, children);
  return el;
}
function s(tag, props, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, String(v));
  }
  appendKids(el, children);
  return el;
}
function setProps(el, props) {
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden' || k === 'open') el[k] = !!v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
}
function appendKids(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === true) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- formatting
const fmt = {
  money: (v) => PPC.formatMoney(v),
  moneyCompact(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e6) return `${v < 0 ? '−' : ''}$${(a / 1e6).toFixed(1)}M`;
    if (a >= 1e5) return `${v < 0 ? '−' : ''}$${Math.round(a / 1e3)}K`;
    return PPC.formatMoney(v);
  },
  int: (v) => (v == null ? '—' : PPC.formatInt(Math.round(v))),
  pct: (v) => (v == null ? '—' : PPC.formatPct(v)),
  ratio: (v) => (v == null ? '—' : `$${PPC.round(v, 2)}`),
  date(d) {
    if (!d) return '—';
    const t = Date.parse(`${String(d).slice(0, 10)}T12:00:00Z`);
    return Number.isNaN(t) ? String(d) : new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  },
  dateShort(d) {
    if (!d) return '—';
    const t = Date.parse(`${String(d).slice(0, 10)}T12:00:00Z`);
    return Number.isNaN(t) ? String(d) : new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  },
  dateTime(iso) {
    if (!iso) return '—';
    const t = Date.parse(iso);
    return Number.isNaN(t) ? String(iso) : new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  },
  ago(iso) {
    if (!iso) return 'never';
    const mins = (Date.now() - Date.parse(iso)) / 60000;
    if (Number.isNaN(mins)) return String(iso);
    if (mins < 2) return 'just now';
    if (mins < 60) return `${Math.round(mins)} min ago`;
    if (mins < 60 * 36) return `${Math.round(mins / 60)} h ago`;
    return `${Math.round(mins / 1440)} days ago`;
  },
  plural: (n, one, many = `${one}s`) => `${PPC.formatInt(n)} ${n === 1 ? one : many}`,
};

// ---------------------------------------------------------------- verdicts & chips
const REC_META = {
  SCALE: { icon: '▲', cls: 'rec-scale', tone: 'good', hint: 'Good results at an acceptable cost. Consider more budget or higher bids.' },
  WATCH: { icon: '●', cls: 'rec-watch', tone: 'neutral', hint: 'Not enough data yet, or mixed results. Keep it running and check again.' },
  REDUCE: { icon: '▼', cls: 'rec-reduce', tone: 'serious', hint: 'Weak results or cost well above target. Lower bids or budget.' },
  PAUSE: { icon: '■', cls: 'rec-pause', tone: 'bad', hint: 'Spend with nothing to show for it. Stop this spend.' },
};
function stamp(rec, big = false) {
  const m = REC_META[rec] || REC_META.WATCH;
  return h('span', { class: `stamp ${m.cls}${big ? ' stamp-lg' : ''}`, title: m.hint }, h('span', { class: 'stamp-icon', 'aria-hidden': 'true' }, m.icon), rec);
}
function chip(text, tone = 'neutral', title) {
  return h('span', { class: `chip chip-${tone}`, title }, text);
}
const SEVERITY_TONE = { error: 'bad', high: 'bad', warn: 'warn', medium: 'warn', serious: 'serious', info: 'info', low: 'neutral', ok: 'good', demo: 'demo' };
const SEVERITY_LABEL = { error: 'Problem', warn: 'Check', info: 'Info', ok: 'OK', high: 'High', medium: 'Medium', low: 'Low', demo: 'Demo' };
function severityChip(sev) {
  return chip(SEVERITY_LABEL[sev] || sev, SEVERITY_TONE[sev] || 'neutral');
}
const MATCH_TONE = { good: 'good', partial: 'warn', poor: 'bad', unknown: 'neutral' };
const MATCH_LABEL = { good: 'Good match', partial: 'Partial match', poor: 'Poor match', unknown: 'Not checked' };
const CONF_TONE = { high: 'good', medium: 'warn', low: 'serious', none: 'neutral' };

// ---------------------------------------------------------------- building blocks
function card({ title, kicker, sub, tools = [], body = [], id, comment = true, cls = '' }) {
  const el = h('section', { class: `card ${cls}`, id, 'aria-label': title });
  const head = h('div', { class: 'card-head' },
    h('div', { class: 'card-heading' },
      kicker ? h('div', { class: 'card-kicker' }, kicker) : null,
      h('h3', { class: 'card-title' }, title),
      sub ? h('p', { class: 'card-sub' }, sub) : null),
    h('div', { class: 'card-tools' }, ...tools, comment ? commentButton(() => el) : null));
  el.append(head);
  appendKids(el, [body]);
  return el;
}
function tile(label, value, note, { wide = false, title } = {}) {
  return h('div', { class: `tile${wide ? ' tile-wide' : ''}`, title },
    h('span', { class: 'tile-label' }, label),
    h('span', { class: 'tile-value' }, value),
    note ? h('span', { class: 'tile-note' }, note) : null);
}
function facts(list) {
  return h('div', { class: 'facts' }, list.map((f) => h('div', { class: 'fact' }, h('span', { class: 'fact-label' }, f.label), h('span', { class: 'fact-value' }, f.value))));
}
function kv(pairs) {
  const dl = h('dl', { class: 'kv' });
  for (const [k, v] of pairs) {
    if (v == null || v === '') continue;
    dl.append(h('dt', {}, k), h('dd', {}, v));
  }
  return dl;
}
function note(text, tone = '') {
  return h('p', { class: `note${tone ? ` note-${tone}` : ''}` }, text);
}
function emptyState(title, text, action) {
  return h('div', { class: 'empty' }, h('strong', {}, title), text ? h('span', {}, text) : null, action || null);
}
function button(label, onclick, { kind = '', small = false, disabled = false, title, type = 'button', id } = {}) {
  return h('button', { class: `btn${kind ? ` btn-${kind}` : ''}${small ? ' btn-sm' : ''}`, type, onclick, disabled, title, id }, label);
}
function segmented(options, value, onChange, label) {
  return h('div', { class: 'seg', role: 'group', 'aria-label': label },
    options.map(([v, text]) => h('button', { type: 'button', 'aria-pressed': String(v === value), onclick: () => onChange(v) }, text)));
}

/** Sortable data table. columns: [{key, label, n (numeric), value(row), render(row), sort(row), sticky, cls, title}] */
function dataTable(columns, rows, { sort, onSort, onRow, rowClass, empty, caption, pinned = [] } = {}) {
  const wrap = h('div', { class: 'table-wrap tall' });
  if (!rows.length && !pinned.length) {
    wrap.append(empty || emptyState('Nothing to show', 'No rows match the current filters.'));
    return wrap;
  }
  const table = h('table', { class: 'data' });
  if (caption) table.append(h('caption', { class: 'sr-only' }, caption));
  const thead = h('thead');
  const tr = h('tr');
  for (const c of columns) {
    const sortable = !!onSort && c.sort !== false;
    const th = h('th', {
      class: [c.n ? 'n' : '', c.sticky ? 'sticky' : '', sortable ? 'sortable' : ''].filter(Boolean).join(' '), scope: 'col', title: c.title,
      'aria-sort': sort && sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : null,
      tabindex: sortable ? '0' : null,
    }, c.label);
    if (sortable) {
      const go = () => onSort(c.key);
      th.addEventListener('click', go);
      th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    }
    tr.append(th);
  }
  thead.append(tr);
  const tbody = h('tbody');
  const addRow = (r, extraCls = '') => {
    const row = h('tr', { class: [onRow ? 'clickable' : '', rowClass ? rowClass(r) : '', extraCls].filter(Boolean).join(' ') || null, tabindex: onRow ? '0' : null });
    for (const c of columns) {
      const content = c.render ? c.render(r) : c.value ? c.value(r) : r[c.key];
      row.append(h('td', { class: [c.n ? 'n' : '', c.sticky ? 'sticky' : '', c.cls || ''].filter(Boolean).join(' ') || null }, content));
    }
    if (onRow) {
      row.addEventListener('click', () => onRow(r));
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') onRow(r); });
    }
    tbody.append(row);
  };
  rows.forEach((r) => addRow(r));
  pinned.forEach((r) => addRow(r, 'pinned'));
  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}
function sortRows(rows, columns, sort) {
  if (!sort) return rows;
  const col = columns.find((c) => c.key === sort.key);
  if (!col) return rows;
  const get = col.sort || col.value || ((r) => r[col.key]);
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
  });
}

// ---------------------------------------------------------------- drawer & toasts
let drawerReturnFocus = null;
function openDrawer(title, content) {
  drawerReturnFocus = document.activeElement;
  $('drawer-title').textContent = title;
  clear($('drawer-body'));
  appendKids($('drawer-body'), [content]);
  $('drawer').hidden = false;
  $('drawer-close').focus();
}
function closeDrawer() {
  $('drawer').hidden = true;
  if (drawerReturnFocus && drawerReturnFocus.focus) drawerReturnFocus.focus();
}
function toast(text, tone = '') {
  const t = h('div', { class: `toast${tone ? ` ${tone}` : ''}`, role: 'status' }, text);
  $('toasts').append(t);
  setTimeout(() => t.remove(), tone === 'bad' ? 7000 : 4000);
}

// ---------------------------------------------------------------- tooltip
function showTooltip(evt, title, rows) {
  const tip = $('tooltip');
  clear(tip);
  if (title) tip.append(h('div', { class: 'tt-title' }, title));
  for (const r of rows) {
    tip.append(h('div', { class: 'tt-row' },
      r.color ? h('span', { class: 'key-line', style: { background: r.color } }) : null,
      h('span', { class: 'tt-value' }, r.value),
      r.label ? h('span', { class: 'tt-label' }, r.label) : null));
  }
  tip.hidden = false;
  let x;
  let y;
  if (evt && 'clientX' in evt && evt.clientX) {
    x = evt.clientX; y = evt.clientY;
  } else {
    const box = evt.target.getBoundingClientRect();
    x = box.left + box.width / 2; y = box.top;
  }
  const w = tip.offsetWidth;
  const hgt = tip.offsetHeight;
  tip.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, x + 14))}px`;
  tip.style.top = `${Math.max(8, Math.min(window.innerHeight - hgt - 8, y - hgt - 12 < 8 ? y + 16 : y - hgt - 12))}px`;
}
function hideTooltip() { $('tooltip').hidden = true; }

// ---------------------------------------------------------------- comments (composer-only)
function commentButton(targetFn) {
  if (!rt.comments) return null;
  return h('button', {
    class: 'btn btn-ghost btn-sm', type: 'button', title: 'Comment on this section',
    onclick: async () => {
      try {
        const res = await rt.comments.openComposer({ element: targetFn() });
        if (res && res.opened === false) toast('Click the page once, then try commenting again.');
      } catch (e) {
        toast(e?.code === 'forbidden' ? 'Commenting is not available to you on this page.' : 'Could not open the comment box here.', 'bad');
      }
    },
  }, 'Comment');
}
