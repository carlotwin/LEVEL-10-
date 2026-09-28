// ---------------------------------------------------------------------------
// Charts: hand-built SVG, redrawn at the container's real width so text stays
// readable on a phone. Marks follow one spec: bars at most 24px thick with a
// 4px rounded data end (square at the baseline), 2px lines, end dots r=4 with
// a 2px surface ring, hairline solid grid, a hover/focus tooltip on every
// mark, and a table view for every chart.
// ---------------------------------------------------------------------------
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  const ticks = [];
  for (let v = 0; v <= max + step * 0.999; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}
const tickLabel = (v, money) => (money ? (v >= 1000 ? `$${PPC.formatInt(v / 1000)}K` : `$${PPC.formatInt(v)}`) : v >= 1000 ? `${PPC.round(v / 1000, 1)}K` : PPC.formatInt(v));

/** Top-rounded column path (square at the baseline). */
function colPath(x, y, w, hgt, r = 4) {
  const rr = Math.min(r, w / 2, hgt);
  if (hgt <= 0) return '';
  return `M${x},${y + hgt}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + hgt}Z`;
}
/** Right-rounded bar path (square at the left baseline). */
function barPath(x, y, w, hgt, r = 4) {
  const rr = Math.min(r, hgt / 2, w);
  if (w <= 0) return '';
  return `M${x},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + hgt - rr}Q${x + w},${y + hgt} ${x + w - rr},${y + hgt}H${x}Z`;
}

const resizeObservers = new WeakMap();
function responsive(holder, draw) {
  let lastW = 0;
  const run = () => {
    const w = Math.round(holder.clientWidth || holder.getBoundingClientRect().width || 600);
    if (w && Math.abs(w - lastW) < 2) return;
    lastW = w;
    clear(holder);
    holder.append(draw(Math.max(260, w)));
  };
  requestAnimationFrame(run);
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(() => run());
    ro.observe(holder);
    resizeObservers.set(holder, ro);
  }
}

/** Chart container: title, legend, the SVG holder and a table-view toggle. */
function chartFigure({ title, sub, legend = [], draw, table, id }) {
  const holder = h('div', { class: 'chart-holder' });
  const tableBox = h('div', { class: 'chart-table', hidden: true });
  let tableShown = false;
  const toggle = button('Table view', () => {
    tableShown = !tableShown;
    tableBox.hidden = !tableShown;
    if (tableShown && !tableBox.firstChild) tableBox.append(table());
    toggle.textContent = tableShown ? 'Chart only' : 'Table view';
  }, { kind: 'ghost', small: true });
  const fig = h('figure', { class: 'chart', id },
    h('div', { class: 'card-head' },
      h('div', {}, h('h4', { class: 'card-title' }, title), sub ? h('p', { class: 'card-sub' }, sub) : null),
      h('div', { class: 'card-tools' }, toggle)),
    legend.length ? h('div', { class: 'chart-legend' }, legend.map((l) => h('span', { class: 'legend-item' },
      h('span', { class: l.type === 'line' ? 'key-line' : 'key-rect', style: { background: l.color } }), l.label))) : null,
    holder, tableBox);
  responsive(holder, draw);
  return fig;
}

function attachTip(el, title, rows) {
  el.setAttribute('tabindex', '0');
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', `${title}: ${rows.map((r) => `${r.label ? `${r.label} ` : ''}${r.value}`).join(', ')}`);
  el.addEventListener('pointermove', (e) => showTooltip(e, title, rows));
  el.addEventListener('pointerleave', hideTooltip);
  el.addEventListener('focus', (e) => showTooltip(e, title, rows));
  el.addEventListener('blur', hideTooltip);
}

/** Weekly columns (one series). data: [{x, y, label}] */
function columnChart({ data, money = false, color = cssVar('--series-1'), height = 200, valueLabel }) {
  return (width) => {
    const pad = { t: 14, r: 8, b: 26, l: money ? 46 : 34 };
    const iw = width - pad.l - pad.r;
    const ih = height - pad.t - pad.b;
    const max = Math.max(0, ...data.map((d) => d.y));
    const ticks = niceTicks(max);
    const top = ticks[ticks.length - 1] || 1;
    const band = iw / Math.max(1, data.length);
    const bw = Math.min(24, Math.max(4, band - 6));
    const svg = s('svg', { class: 'chart-svg', width, height, viewBox: `0 0 ${width} ${height}`, role: 'group' });
    for (const t of ticks) {
      const y = pad.t + ih - (t / top) * ih;
      svg.append(s('line', { class: t === 0 ? 'baseline' : 'grid', x1: pad.l, x2: width - pad.r, y1: y, y2: y }));
      svg.append(s('text', { x: pad.l - 6, y: y + 3.5, 'text-anchor': 'end', text: tickLabel(t, money) }));
    }
    const every = Math.ceil(data.length / Math.max(1, Math.floor(iw / 52)));
    data.forEach((d, i) => {
      const cx = pad.l + band * i + band / 2;
      const hgt = (d.y / top) * ih;
      const g = s('g');
      const hit = s('rect', { class: 'hit', x: pad.l + band * i, y: pad.t, width: band, height: ih + 4 });
      const mark = s('path', { class: 'mark', d: colPath(cx - bw / 2, pad.t + ih - hgt, bw, hgt), fill: color });
      g.append(hit, mark);
      attachTip(hit, d.label || d.x, [{ value: money ? fmt.money(d.y) : fmt.int(d.y), label: valueLabel }]);
      svg.append(g);
      if (i % every === 0) svg.append(s('text', { x: cx, y: height - 8, 'text-anchor': 'middle', text: fmt.dateShort(d.x) }));
    });
    return svg;
  };
}

/** Multi-series lines with a crosshair. data: [{x, ...values}], series: [{key, label, color}] */
function lineChart({ data, series, height = 200, money = false }) {
  return (width) => {
    const pad = { t: 14, r: 92, b: 26, l: 34 };
    const iw = width - pad.l - pad.r;
    const ih = height - pad.t - pad.b;
    const max = Math.max(0, ...data.flatMap((d) => series.map((sr) => d[sr.key] || 0)));
    const ticks = niceTicks(max);
    const top = ticks[ticks.length - 1] || 1;
    const X = (i) => pad.l + (data.length <= 1 ? iw / 2 : (i / (data.length - 1)) * iw);
    const Y = (v) => pad.t + ih - ((v || 0) / top) * ih;
    const svg = s('svg', { class: 'chart-svg', width, height, viewBox: `0 0 ${width} ${height}`, role: 'group' });
    for (const t of ticks) {
      svg.append(s('line', { class: t === 0 ? 'baseline' : 'grid', x1: pad.l, x2: pad.l + iw, y1: Y(t), y2: Y(t) }));
      svg.append(s('text', { x: pad.l - 6, y: Y(t) + 3.5, 'text-anchor': 'end', text: tickLabel(t, money) }));
    }
    const every = Math.ceil(data.length / Math.max(1, Math.floor(iw / 52)));
    data.forEach((d, i) => { if (i % every === 0) svg.append(s('text', { x: X(i), y: height - 8, 'text-anchor': 'middle', text: fmt.dateShort(d.x) })); });
    const surface = cssVar('--surface');
    const ends = [];
    for (const sr of series) {
      const pts = data.map((d, i) => `${X(i)},${Y(d[sr.key])}`).join(' ');
      svg.append(s('polyline', { points: pts, fill: 'none', stroke: sr.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      const last = data.length - 1;
      if (last >= 0) {
        svg.append(s('circle', { cx: X(last), cy: Y(data[last][sr.key]), r: 4, fill: sr.color, stroke: surface, 'stroke-width': 2 }));
        ends.push({ y: Y(data[last][sr.key]), text: `${sr.label} ${fmt.int(data[last][sr.key])}`, color: sr.color });
      }
    }
    // Direct end labels only when they do not collide (the legend covers the rest).
    ends.sort((a, b) => a.y - b.y);
    const collide = ends.some((e, i) => i && e.y - ends[i - 1].y < 13);
    if (!collide) for (const e of ends) svg.append(s('text', { class: 'label-ink2', x: pad.l + iw + 8, y: e.y + 4, text: e.text }));
    // Crosshair + one tooltip for every series at that week.
    const cross = s('line', { class: 'crosshair', y1: pad.t, y2: pad.t + ih, x1: -10, x2: -10 });
    svg.append(cross);
    const hit = s('rect', { class: 'hit', x: pad.l, y: pad.t, width: iw, height: ih, tabindex: '0', role: 'img', 'aria-label': 'Weekly values; use the table view for every number' });
    const at = (i, evt) => {
      const d = data[i];
      cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i));
      showTooltip(evt, `Week of ${fmt.date(d.x)}`, series.map((sr) => ({ color: sr.color, value: money ? fmt.money(d[sr.key]) : fmt.int(d[sr.key]), label: sr.label })));
    };
    hit.addEventListener('pointermove', (e) => {
      const box = svg.getBoundingClientRect();
      const px = ((e.clientX - box.left) / box.width) * width;
      const i = Math.max(0, Math.min(data.length - 1, Math.round(((px - pad.l) / iw) * (data.length - 1))));
      at(i, e);
    });
    let focusIdx = data.length - 1;
    hit.addEventListener('focus', (e) => at(focusIdx, e));
    hit.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        focusIdx = Math.max(0, Math.min(data.length - 1, focusIdx + (e.key === 'ArrowLeft' ? -1 : 1)));
        at(focusIdx, e);
        e.preventDefault();
      }
    });
    const leave = () => { cross.setAttribute('x1', -10); cross.setAttribute('x2', -10); hideTooltip(); };
    hit.addEventListener('pointerleave', leave);
    hit.addEventListener('blur', leave);
    svg.append(hit);
    return svg;
  };
}

/** The funnel: horizontal bars, one hue; stage rate and cost per stage beside each bar. */
function funnelChart({ stages, color = cssVar('--series-1') }) {
  return (width) => {
    const rowH = 34;
    const labelW = Math.min(150, Math.max(96, width * 0.24));
    const statW = width < 520 ? 0 : 190;
    const iw = width - labelW - statW - 56;
    const height = stages.length * rowH + 8;
    const max = Math.max(1, ...stages.map((st) => st.count));
    const svg = s('svg', { class: 'chart-svg', width, height, viewBox: `0 0 ${width} ${height}`, role: 'group' });
    svg.append(s('line', { class: 'baseline', x1: labelW, x2: labelW, y1: 2, y2: height - 4 }));
    stages.forEach((st, i) => {
      const y = 6 + i * rowH;
      const bh = Math.min(24, rowH - 10);
      const w = Math.max(st.count ? 3 : 0, (st.count / max) * iw);
      svg.append(s('text', { class: 'label-ink2', x: labelW - 10, y: y + bh / 2 + 4, 'text-anchor': 'end', text: st.label }));
      const hit = s('rect', { class: 'hit', x: 0, y: y - 3, width, height: rowH });
      svg.append(hit, s('path', { class: 'mark', d: barPath(labelW + 1, y, w, bh), fill: color }));
      svg.append(s('text', { class: 'label-strong', x: labelW + 1 + w + 8, y: y + bh / 2 + 4, text: fmt.int(st.count) }));
      if (statW) {
        const rate = st.rate == null ? '' : `${fmt.pct(st.rate)} ${st.rateOf || 'of the step before'}`;
        const cost = st.cost == null ? '' : `${fmt.money(st.cost)} each`;
        svg.append(s('text', { x: width - statW, y: y + bh / 2 - 2, text: rate }));
        svg.append(s('text', { class: 'label-ink2', x: width - statW, y: y + bh / 2 + 11, text: cost }));
      }
      attachTip(hit, st.label, [
        { value: fmt.int(st.count), label: st.label.toLowerCase() },
        ...(st.rate == null ? [] : [{ value: fmt.pct(st.rate), label: st.rateOf || 'of the step before' }]),
        ...(st.cost == null ? [] : [{ value: fmt.money(st.cost), label: 'ad spend per one' }]),
      ]);
    });
    return svg;
  };
}

/** One 100% bar split into parts with 2px surface gaps. parts: [{label, value, color, icon}] */
function stackBar({ parts, money = true, height = 34 }) {
  return (width) => {
    const total = parts.reduce((a, p) => a + (p.value || 0), 0) || 1;
    const svg = s('svg', { class: 'chart-svg', width, height, viewBox: `0 0 ${width} ${height}`, role: 'group' });
    let x = 0;
    const gap = 2;
    const live = parts.filter((p) => p.value > 0);
    live.forEach((p, i) => {
      const w = (p.value / total) * width - (i < live.length - 1 ? gap : 0);
      const first = i === 0;
      const lastPart = i === live.length - 1;
      const r = 4;
      const d = `M${x + (first ? r : 0)},6H${x + w - (lastPart ? r : 0)}${lastPart ? `Q${x + w},6 ${x + w},${6 + r}V${height - 6 - r}Q${x + w},${height - 6} ${x + w - r},${height - 6}` : `V${height - 6}`}H${x + (first ? r : 0)}${first ? `Q${x},${height - 6} ${x},${height - 6 - r}V${6 + r}Q${x},6 ${x + r},6` : `V6`}Z`;
      const hit = s('rect', { class: 'hit', x, y: 0, width: Math.max(w, 1), height });
      svg.append(hit, s('path', { class: 'mark', d, fill: p.color }));
      attachTip(hit, p.label, [{ value: money ? fmt.money(p.value) : fmt.int(p.value), label: `${fmt.pct(p.value / total)} of spend` }]);
      x += w + gap;
    });
    return svg;
  };
}

function simpleTable(headers, rows) {
  return h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, headers.map((x) => h('th', { class: x.n ? 'n' : '' }, x.label)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, r.map((v, i) => h('td', { class: headers[i].n ? 'n' : '' }, v))))));
}
