// ---------------------------------------------------------------------------
// Views: Overview, Keyword + City, row detail, Search Terms, Landing Pages,
// Retargeting.
// ---------------------------------------------------------------------------
const whereText = (r) => [r.city || 'City unknown', r.campaignName].filter(Boolean).join(' · ');

// ---------------------------------------------------------------- Overview
function viewOverview(root, a) {
  const m = a.overview.metrics;
  const o = a.overview;
  const wasting = o.wasting.slice(0, 5);
  const making = o.making.slice(0, 5);

  // The answer: what is wasting money, what is making money.
  const heroCard = h('div', { class: 'hero' },
    h('div', { class: 'card-kicker' }, 'Money at risk'),
    h('div', { class: 'hero-figure' }, fmt.money(o.wasteSpend)),
    h('p', { class: 'hero-caption' },
      `spent on keyword + city rows marked PAUSE or REDUCE: ${fmt.pct(m.spend ? o.wasteSpend / m.spend : 0)} of ${fmt.money(m.spend)} total ad spend in this period.`),
    h('div', { class: 'hero-split' },
      h('span', {}, 'PAUSE ', h('b', {}, fmt.money(o.recSpend.PAUSE)), ` · ${fmt.plural(o.recCounts.PAUSE, 'row')}`),
      h('span', {}, 'REDUCE ', h('b', {}, fmt.money(o.recSpend.REDUCE)), ` · ${fmt.plural(o.recCounts.REDUCE, 'row')}`),
      h('span', {}, 'SCALE ', h('b', {}, fmt.money(o.recSpend.SCALE)), ` · ${fmt.plural(o.recCounts.SCALE, 'row')}`)),
    button('Review the actions', () => go('actions'), { kind: 'primary' }));

  const verdictList = (rows, emptyText) => (rows.length
    ? h('div', { class: 'verdict-list' }, rows.map((r) => h('div', {
      class: 'verdict-row', tabindex: '0', role: 'button', onclick: () => openRow(r, a),
      onkeydown: (e) => { if (e.key === 'Enter') openRow(r, a); },
    },
    stamp(r.decision.rec),
    h('div', {}, h('div', { class: 'verdict-name' }, r.keyword), h('div', { class: 'verdict-where' }, whereText(r))),
    h('div', { class: 'verdict-money' }, fmt.money(r.metrics.spend)),
    h('div', { class: 'verdict-why' }, r.decision.reason))))
    : emptyState('Nothing here yet', emptyText));

  root.append(h('div', { class: 'answer' },
    heroCard,
    card({ kicker: 'Wasting money', title: 'Stop or cut these first', sub: 'Biggest spend among rows marked PAUSE or REDUCE.', body: verdictList(wasting, 'No keyword + city row is marked PAUSE or REDUCE for these filters.') }),
    card({ kicker: 'Making money', title: 'Give these more room', sub: 'Rows marked SCALE, best results first.', body: verdictList(making, 'No row has earned SCALE yet. Rows need qualified leads, contracts or recorded profit within your targets.') })));

  // KPI groups in priority order: Money, Lead quality, Deals, Recommendations.
  const profitNote = m.deals ? (m.profitKnown ? `all ${m.deals} closed deals recorded` : `${m.dealsWithProfit} of ${m.deals} closed deals have profit recorded`) : 'no closed deals yet';
  const revenueNote = m.deals ? (m.revenueKnown ? `all ${m.deals} deals recorded` : `${m.dealsWithRevenue} of ${m.deals} deals recorded`) : 'no closed deals yet';
  const money = card({
    kicker: '1 · Money', title: 'Spend and return', comment: false,
    body: h('div', { class: 'tiles' },
      tile('Ad spend', fmt.money(m.spend), `${fmt.int(m.clicks)} clicks`),
      tile('Cost per click', fmt.money(m.cpc)),
      tile('Revenue (recorded)', m.dealsWithRevenue ? fmt.money(m.revenue) : '—', revenueNote),
      tile('Profit (recorded)', m.dealsWithProfit ? fmt.money(m.profit) : '—', profitNote),
      tile('Profit per $1 of ads', m.profitKnown ? fmt.ratio(m.profitPerDollar) : '—', m.profitKnown ? 'from recorded profit' : 'shown only when every deal has profit', { wide: true })),
  });
  const quality = card({
    kicker: '2 · Lead quality', title: 'Leads that count', comment: false,
    body: h('div', { class: 'tiles' },
      tile('Leads', fmt.int(m.leads), a.overview.duplicates ? `${fmt.int(a.overview.duplicates)} duplicates left out` : 'duplicates left out'),
      tile('Qualified leads', fmt.int(m.qualified), m.leads ? `${fmt.pct(m.qualifiedRate)} of leads` : ''),
      tile('Cost per lead', fmt.money(m.costPerLead)),
      tile('Cost per qualified lead', fmt.money(m.costPerQualified)),
      tile('Junk leads', fmt.int(m.junk), 'spam, wrong numbers, agents, out of area', { wide: true })),
  });
  const deals = card({
    kicker: '3 · Deals', title: 'From appointment to closed', comment: false,
    body: h('div', { class: 'tiles' },
      tile('Appointments', fmt.int(m.appointments), `${fmt.money(m.costPerAppointment)} each`),
      tile('Offers', fmt.int(m.offers)),
      tile('Contracts', fmt.int(m.contracts), `${fmt.money(m.costPerContract)} each`),
      tile('Closed deals', fmt.int(m.deals), `${fmt.money(m.costPerDeal)} each`)),
  });
  const recParts = ['SCALE', 'WATCH', 'REDUCE', 'PAUSE'].map((k) => ({
    label: k, value: o.recSpend[k], color: cssVar({ SCALE: '--good', WATCH: '--watch', REDUCE: '--serious', PAUSE: '--critical' }[k]),
  }));
  const recs = card({
    kicker: '4 · Recommendations', title: 'Where the spend sits', comment: false,
    body: [
      chartFigure({
        title: 'Ad spend by recommendation', draw: stackBar({ parts: recParts }),
        table: () => simpleTable([{ label: 'Recommendation' }, { label: 'Rows', n: true }, { label: 'Spend', n: true }],
          recParts.map((p) => [p.label, fmt.int(o.recCounts[p.label]), fmt.money(p.value)])),
      }),
      h('div', { class: 'list' }, ['SCALE', 'WATCH', 'REDUCE', 'PAUSE'].map((k) => h('div', { class: 'rec-row' },
        stamp(k), h('span', { class: 'rec-row-money num' }, h('b', {}, fmt.money(o.recSpend[k])), h('span', { class: 'muted small' }, ` · ${fmt.plural(o.recCounts[k], 'row')}`)),
        h('span', { class: 'rec-row-hint small ink-2' }, REC_META[k].hint)))),
    ],
  });
  root.append(h('div', { class: 'kpi-groups' }, money, quality, deals, recs));

  // Funnel.
  const stagesRaw = [
    ['Leads', m.leads, m.costPerLead], ['Qualified leads', m.qualified, m.costPerQualified], ['Appointments', m.appointments, m.costPerAppointment],
    ['Offers', m.offers, m.costPerOffer], ['Contracts', m.contracts, m.costPerContract], ['Closed deals', m.deals, m.costPerDeal],
  ];
  const stages = stagesRaw.map(([label, count, cost], i) => ({
    label, count, cost, rate: i === 0 ? PPC.safeDiv(count, m.clicks) : PPC.safeDiv(count, stagesRaw[i - 1][1]), rateOf: i === 0 ? 'of clicks' : 'of the step before',
  }));
  const funnel = card({
    kicker: 'The funnel', title: 'From ad spend to profit',
    sub: `${fmt.money(m.spend)} spend → ${fmt.int(m.leads)} leads → ${fmt.int(m.deals)} closed deals → ${m.dealsWithProfit ? `${fmt.money(m.profit)} profit recorded` : 'profit not recorded yet'}.`,
    body: chartFigure({
      title: 'Google Ads leads at each step', sub: 'Each step as a share of the step before; leads as a share of clicks.', draw: funnelChart({ stages }),
      table: () => simpleTable([{ label: 'Step' }, { label: 'Count', n: true }, { label: 'Rate', n: true }, { label: 'Ad spend per one', n: true }],
        stages.map((st) => [st.label, fmt.int(st.count), `${fmt.pct(st.rate)} ${st.rateOf}`, fmt.money(st.cost)])),
    }),
  });

  // Weekly trend: two charts, one axis each (never a dual axis).
  const weeks = a.trend.map((w) => ({ x: w.week, spend: w.spend, leads: w.leads, qualified: w.qualified, contracts: w.contracts }));
  const trend = card({
    kicker: 'Week by week', title: 'Spend and leads',
    sub: a.leadOnlyFilters ? 'Spend is all ad spend: it cannot be split by seller situation or lead quality.' : 'Weeks start on Monday.',
    body: weeks.length ? h('div', { class: 'grid-2' },
      chartFigure({
        title: 'Ad spend per week', draw: columnChart({ data: weeks.map((w) => ({ x: w.x, y: w.spend, label: `Week of ${fmt.date(w.x)}` })), money: true, valueLabel: 'ad spend' }),
        table: () => simpleTable([{ label: 'Week of' }, { label: 'Spend', n: true }], weeks.map((w) => [fmt.date(w.x), fmt.money(w.spend)])),
      }),
      chartFigure({
        title: 'Leads per week',
        legend: [{ label: 'Leads', color: cssVar('--series-1'), type: 'line' }, { label: 'Qualified leads', color: cssVar('--series-2'), type: 'line' }],
        draw: lineChart({ data: weeks, series: [{ key: 'leads', label: 'Leads', color: cssVar('--series-1') }, { key: 'qualified', label: 'Qualified', color: cssVar('--series-2') }] }),
        table: () => simpleTable([{ label: 'Week of' }, { label: 'Leads', n: true }, { label: 'Qualified', n: true }, { label: 'Contracts', n: true }],
          weeks.map((w) => [fmt.date(w.x), fmt.int(w.leads), fmt.int(w.qualified), fmt.int(w.contracts)])),
      })) : emptyState('No weeks in this range', 'Pick a wider date range.'),
  });
  root.append(h('div', { class: 'grid-2' }, funnel, trend));

  // Alerts, next actions, lead sources.
  const alertsCard = card({
    kicker: 'Needs attention', title: 'Alerts',
    body: alertList(a.alerts.filter((x) => !state.acks[ackId(x)]).slice(0, 6), a),
    tools: [button('All alerts', () => go('health'), { kind: 'ghost', small: true })],
  });
  const waiting = PPC.mergeActionState(a.actions, state.decisions).filter((x) => x.status === 'proposed' && x.stillRecommended).slice(0, 5);
  const nextCard = card({
    kicker: 'Next actions', title: 'Waiting for approval',
    body: waiting.length ? h('div', { class: 'list' }, waiting.map((x) => h('div', { class: 'list-row' },
      stamp(x.rec), h('div', { class: 'list-main' }, h('span', { class: 'list-title' }, x.summary), h('span', { class: 'small ink-2' }, x.reason)),
      h('span', { class: 'num nowrap' }, fmt.money(x.spend))))) : emptyState('Nothing waiting', 'Every proposed action has been approved or rejected.'),
    tools: [button('Open the Action Queue', () => go('actions'), { kind: 'ghost', small: true })],
  });
  const ch = a.overview.channels;
  const methods = a.overview.methods;
  const sourcesCard = card({
    kicker: 'Attribution', title: 'Where leads came from',
    sub: 'Only evidence counts: a lead is tied to a keyword only by GCLID, UTM tags or call tracking.',
    body: [
      facts([
        { label: 'Google Ads', value: fmt.int(ch.ppc || 0) }, { label: 'Other channels', value: fmt.int(ch.other || 0) },
        { label: 'Unknown / Unmatched', value: fmt.int(ch.unknown || 0) }, { label: 'Duplicates left out', value: fmt.int(a.overview.duplicates) },
      ]),
      h('div', { class: 'list' }, Object.entries(methods).sort((x, y) => y[1] - x[1]).map(([k, v]) => h('div', { class: 'list-row' },
        chip(PPC.METHOD_LABELS[k] || k, k === 'gclid' || k === 'call_gclid' ? 'good' : k === 'source_label' ? 'serious' : 'warn'),
        h('div', { class: 'list-main' }, h('span', { class: 'small ink-2' }, METHOD_HELP[k] || '')), h('b', { class: 'num' }, fmt.int(v))))),
    ],
  });
  root.append(h('div', { class: 'grid-3' }, alertsCard, nextCard, sourcesCard));
}
const METHOD_HELP = {
  gclid: 'Keyword and city known exactly.',
  call_gclid: 'Call carried the click id: keyword and city known.',
  call_tracking: 'Call from a Google Ads tracking number; keyword only when the call log names it.',
  utm: 'UTM tags on the form; city unknown.',
  gclid_unmatched: 'Click id present but the click is not in the loaded data.',
  source_label: 'Only the REI lead source says Google Ads: keyword and city unknown.',
};

function ackId(alert) { return `al_${PPC.fnv1a(alert.id)}`; }
function alertList(alerts) {
  if (!alerts.length) return emptyState('No alerts', 'Spend, leads and syncs look normal for the latest data.');
  return h('div', { class: 'list' }, alerts.map((x) => h('div', { class: 'list-row' },
    severityChip(x.severity),
    h('div', { class: 'list-main' }, h('span', { class: 'list-title' }, x.title), h('span', { class: 'small ink-2' }, x.detail)),
    can.approve() ? button('Seen', () => dbWrite(() => rt.db.doc(`alerts/${ackId(x)}`).set({ at: new Date().toISOString(), by: me.id || '' }), 'mark the alert as seen'), { kind: 'ghost', small: true }) : null)));
}

// ---------------------------------------------------------------- Keyword + City table
const GROUPS = [['keyword_city', 'Keyword + city'], ['keyword', 'Keyword'], ['city', 'City'], ['campaign', 'Campaign']];
function tableRowsFor(a) {
  switch (state.group) {
    case 'keyword': return a.keywordRows;
    case 'city': return a.cityRows;
    case 'campaign': return a.campaignRows;
    default: return a.rows;
  }
}
function moneyCell(v, r, mixed) {
  const est = mixed && r?.estimatedShare > 0.5;
  return h('span', {}, fmt.money(v), est ? h('span', { class: 'est', title: 'Estimated split: Google reports this spend by ad group and city; it is divided among keywords by where their clicks came from.' }, '≈') : null);
}
function mainColumns(mixed) {
  const g = state.group;
  const cols = [];
  if (g === 'keyword_city' || g === 'keyword') cols.push({ key: 'keyword', label: 'Keyword', sticky: true, cls: 'col-kw', value: (r) => r.keyword, render: (r) => h('span', {}, h('b', {}, r.keyword), r.matchTypes?.length ? h('span', { class: 'sub' }, r.matchTypes.map((x) => x.toLowerCase()).join(', ')) : null) });
  if (g === 'keyword_city') cols.push({ key: 'term', label: 'Top search term', cls: 'col-term', value: (r) => r.topSearchTerm || '', render: (r) => h('span', {}, r.topSearchTerm || '—', r.searchTermCount > 1 ? h('span', { class: 'sub' }, `${r.searchTermCount} search terms`) : null) });
  if (g === 'keyword_city' || g === 'city') cols.push({ key: 'city', label: 'City', sticky: g === 'city', cls: 'col-city', value: (r) => r.city || '(unknown)', render: (r) => h('span', {}, r.city || 'Unknown', h('span', { class: 'sub' }, [r.county ? `${r.county} County` : '', r.inBuyBox === false ? 'outside buy box' : ''].filter(Boolean).join(' · '))) });
  if (g !== 'city') cols.push({ key: 'campaign', label: 'Campaign', sticky: g === 'campaign', cls: 'col-camp', value: (r) => r.campaignName || '' });
  const n = (key, label, get, render) => cols.push({ key, label, n: true, value: get, render: render || ((r) => fmt.int(get(r))) });
  n('spend', 'Spend', (r) => r.metrics.spend, (r) => moneyCell(r.metrics.spend, r, mixed));
  n('clicks', 'Clicks', (r) => r.metrics.clicks);
  n('cpc', 'CPC', (r) => r.metrics.cpc, (r) => fmt.money(r.metrics.cpc));
  n('leads', 'Leads', (r) => r.metrics.leads);
  n('qualified', 'Qualified leads', (r) => r.metrics.qualified);
  n('appointments', 'Appointments', (r) => r.metrics.appointments);
  n('offers', 'Offers', (r) => r.metrics.offers);
  n('contracts', 'Contracts', (r) => r.metrics.contracts);
  n('deals', 'Closed deals', (r) => r.metrics.deals);
  n('revenue', 'Revenue', (r) => (r.metrics.dealsWithRevenue ? r.metrics.revenue : null), (r) => (r.metrics.dealsWithRevenue ? fmt.money(r.metrics.revenue) : r.metrics.deals ? 'not recorded' : '—'));
  n('profit', 'Profit', (r) => (r.metrics.dealsWithProfit ? r.metrics.profit : null), (r) => (r.metrics.dealsWithProfit ? fmt.money(r.metrics.profit) : r.metrics.deals ? 'not recorded' : '—'));
  n('cpq', 'Cost per qualified lead', (r) => r.metrics.costPerQualified, (r) => fmt.money(r.metrics.costPerQualified));
  n('cpcontract', 'Cost per contract', (r) => r.metrics.costPerContract, (r) => fmt.money(r.metrics.costPerContract));
  n('cpdeal', 'Cost per deal', (r) => r.metrics.costPerDeal, (r) => fmt.money(r.metrics.costPerDeal));
  cols.push({ key: 'rec', label: 'Recommendation', value: (r) => PPC.REC_ORDER[r.decision.rec], render: (r) => stamp(r.decision.rec) });
  cols.push({ key: 'reason', label: 'Reason', cls: 'reason', sort: false, value: (r) => r.decision.reason });
  return cols;
}
function viewTable(root, a) {
  const rows = tableRowsFor(a).filter((r) => !state.filters.recommendations?.length || state.filters.recommendations.includes(r.decision.rec));
  const withSpend = rows.filter((r) => r.metrics.spend > 0);
  const allEstimated = withSpend.length > 0 && withSpend.every((r) => r.estimatedShare > 0.5);
  const mixed = !allEstimated && withSpend.some((r) => r.estimatedShare > 0.5);
  const cols = mainColumns(mixed);
  const sorted = sortRows(rows, cols, state.sort);
  const counts = { SCALE: 0, WATCH: 0, REDUCE: 0, PAUSE: 0 };
  tableRowsFor(a).forEach((r) => { counts[r.decision.rec] += 1; });
  const limit = state.showAllRows ? sorted.length : 150;
  const unmatchedRow = state.group === 'keyword_city' && a.unmatched ? {
    keyword: 'Google Ads leads, keyword unknown', topSearchTerm: '', city: '', county: '', campaignName: '', matchTypes: [], estimatedShare: 0,
    metrics: a.unmatched.metrics, decision: a.unmatched.decision, leadIds: a.unmatched.leadIds, keywordIds: [], unmatched: true,
  } : null;

  root.append(h('div', { class: 'page-head' },
    h('div', {}, h('h2', { class: 'page-title' }, 'Keyword + city'), h('p', { class: 'page-sub' }, 'Every keyword in every city it spent in: the money, the leads, the deals, and one recommendation with the reason.')),
    h('div', { class: 'btn-row' },
      button('Download CSV', () => offerDownload(`keyword-city-${state.filters.start || 'all'}-${state.filters.end || 'all'}.csv`, PPC.keywordCityCsv(sorted)), { small: true }))));
  if (a.leadOnlyFilters) root.append(note('Seller situation and lead quality filters count matching leads only. Ad spend cannot be split by them, so spend and the recommendation still use all of each row’s leads. Rows without a matching lead are hidden.', 'info'));

  root.append(h('div', { class: 'table-tools' },
    segmented(GROUPS, state.group, (v) => { state.group = v; saveLocal(); renderView(); }, 'Group rows by'),
    h('div', { class: 'btn-row' }, ['SCALE', 'WATCH', 'REDUCE', 'PAUSE'].map((k) => {
      const on = state.filters.recommendations?.includes(k);
      return h('button', {
        class: `btn btn-sm${on ? ' btn-primary' : ''}`, type: 'button', 'aria-pressed': String(!!on),
        onclick: () => {
          const set = new Set(state.filters.recommendations || []);
          if (set.has(k)) set.delete(k); else set.add(k);
          state.filters.recommendations = [...set];
          saveLocal(); renderAll();
        },
      }, `${k} ${counts[k]}`);
    }))));

  root.append(dataTable(cols, sorted.slice(0, limit), {
    sort: state.sort,
    onSort: (key) => { state.sort = { key, dir: state.sort.key === key && state.sort.dir === 'desc' ? 'asc' : 'desc' }; saveLocal(); renderView(); },
    onRow: (r) => openRow(r, a),
    pinned: unmatchedRow ? [unmatchedRow] : [],
    caption: 'Keyword and city results',
    empty: emptyState('No rows for these filters', 'Widen the date range or clear a filter.', button('Clear filters', () => { resetFilters(); }, { small: true })),
  }));
  if (sorted.length > limit) root.append(h('div', { class: 'btn-row' }, h('span', { class: 'muted small' }, `Showing the top ${limit} of ${sorted.length} rows by the current sort.`), button('Show all rows', () => { state.showAllRows = true; renderView(); }, { small: true })));
  if (state.group === 'keyword_city' && (allEstimated || mixed)) {
    root.append(h('p', { class: 'muted small' }, allEstimated
      ? 'Keyword + city spend is an estimated split: Google reports spend by keyword, and by ad group + city, but never by keyword + city. It is divided by where each keyword’s clicks came from. Keyword totals and city totals are exact.'
      : '≈ marks spend that is an estimated split (Google reports spend by keyword, and by ad group + city, but never by keyword + city). Totals are exact.'));
  }
}

// ---------------------------------------------------------------- row detail drawer
function openRow(r, a) {
  const d = r.decision;
  const model = a.model;
  const leadIds = r.leadIds || [];
  const leads = leadIds.map((id) => model.leads.find((l) => l.id === id)).filter(Boolean);
  const title = r.unmatched ? r.keyword : [r.keyword || r.campaignName || r.city, r.keyword ? r.city || 'City unknown' : ''].filter(Boolean).join(' · ');
  const terms = new Map();
  for (const t of model.dataset.ads?.searchTermsDaily || []) {
    if (!(r.keywordIds || []).includes(t.k) || !PPC.inRange(t.d, state.filters.start, state.filters.end)) continue;
    const cur = terms.get(t.term) || { term: t.term, spend: 0, clicks: 0, conv: 0 };
    cur.spend += t.cost || 0; cur.clicks += t.clk || 0; cur.conv += t.conv || 0;
    terms.set(t.term, cur);
  }
  const termList = [...terms.values()].sort((x, y) => y.spend - x.spend).slice(0, 8);
  const body = [
    h('div', { class: 'btn-row' }, stamp(d.rec, true), chip(`Based on: ${d.basisLabel}`, 'info'), chip(`Confidence: ${d.confidence}`, CONF_TONE[d.confidence] || 'neutral')),
    h('p', {}, d.reason),
    facts(d.facts),
    r.estimatedShare > 0.5 ? note('This row’s spend is an estimated split of the ad group’s spend in this city, by where each keyword’s clicks came from. Keyword and city totals are exact.') : null,
    r.inBuyBox === false ? note(`${r.city} is marked outside your buy box in Settings.`, 'warn') : null,
    h('div', { class: 'card' }, h('h4', { class: 'card-title' }, 'Cost at each step'), facts([
      { label: 'CPC', value: fmt.money(r.metrics.cpc) }, { label: 'Cost per lead', value: fmt.money(r.metrics.costPerLead) },
      { label: 'Cost per qualified', value: fmt.money(r.metrics.costPerQualified) }, { label: 'Cost per appointment', value: fmt.money(r.metrics.costPerAppointment) },
      { label: 'Cost per contract', value: fmt.money(r.metrics.costPerContract) }, { label: 'Cost per deal', value: fmt.money(r.metrics.costPerDeal) },
      { label: 'Qualified rate', value: fmt.pct(r.metrics.qualifiedRate) }, { label: 'Leads per click', value: fmt.pct(r.metrics.leadRate) },
    ])),
    termList.length ? h('div', { class: 'card' }, h('h4', { class: 'card-title' }, 'Search terms behind this keyword'), h('p', { class: 'card-sub' }, 'All cities: Google reports search terms without a city.'),
      simpleTable([{ label: 'Search term' }, { label: 'Spend', n: true }, { label: 'Clicks', n: true }, { label: 'Google conv.', n: true }],
        termList.map((t) => [t.term, fmt.money(t.spend), fmt.int(t.clicks), fmt.int(t.conv)]))) : null,
    h('div', { class: 'card' },
      h('h4', { class: 'card-title' }, `Leads (${leads.length})`),
      h('p', { class: 'card-sub' }, 'Lead ids only. Names, phone numbers and addresses stay in REI BlackBook.'),
      leads.length ? simpleTable([{ label: 'Lead' }, { label: 'Created' }, { label: 'Stage' }, { label: 'Seller situation' }, { label: 'Matched by' }],
        leads.slice(0, 60).map((l) => [l.id, fmt.date(l.createdDate), l.stage + (l.junk ? ` (${l.junk.replace('_', ' ')})` : ''), situationCell(l), `${PPC.METHOD_LABELS[l.attr?.method] || '—'} · ${l.attr?.confidence || 'none'}`]))
        : h('p', { class: 'muted small' }, 'No leads in this period.')),
  ];
  openDrawer(title, body);
}
function situationCell(l) {
  const label = PPC.situationLabel(l.situation || 'unknown', state.analysis.model.settings.situations);
  if (!can.admin()) return label;
  const sel = h('select', {
    class: 'select', 'aria-label': `Seller situation for lead ${l.id}`,
    onchange: async (e) => {
      const next = { ...(state.overrides?.situations || {}) };
      if (e.target.value === '__auto') delete next[l.id]; else next[l.id] = e.target.value;
      const ok = await dbWrite(() => rt.db.doc('config/overrides').set({ situations: next, updatedAt: new Date().toISOString(), updatedBy: me.id || '' }), 'change the seller situation');
      if (ok) toast(`Lead ${l.id}: seller situation saved.`);
    },
  },
  h('option', { value: '__auto' }, `Automatic (${label})`),
  state.analysis.model.settings.situations.map((sit) => h('option', { value: sit.code, selected: state.overrides?.situations?.[l.id] === sit.code }, sit.label)));
  return sel;
}

// ---------------------------------------------------------------- Search terms
function viewTerms(root, a) {
  const st = a.searchTerms;
  const decisions = PPC.mergeActionState(a.actions, state.decisions);
  const negStatus = (f) => {
    const x = decisions.find((d) => d.type === 'add_negative' && d.target.campaignId === f.campaignId && d.target.negative === f.suggestion.negative);
    return x ? x.status : null;
  };
  root.append(h('div', { class: 'page-head' },
    h('div', {}, h('h2', { class: 'page-title' }, 'Search terms'), h('p', { class: 'page-sub' }, 'What people actually typed. Negative keywords are suggestions only: nothing is added to Google Ads without approval in the Action Queue.')),
    button('Download CSV', () => offerDownload('search-term-findings.csv', PPC.toCsv(st.findings, [
      { label: 'Search term', key: 'term' }, { label: 'Keyword', key: 'keywordText' }, { label: 'Campaign', key: 'campaignName' },
      { label: 'Spend', value: (f) => PPC.round(f.spend, 2) }, { label: 'Clicks', value: (f) => PPC.round(f.clicks, 0) }, { label: 'Google conversions', value: (f) => PPC.round(f.conversions, 1) },
      { label: 'Problem', value: (f) => f.flags.map((x) => x.label).join('; ') }, { label: 'Suggestion', value: (f) => (f.suggestion.action === 'add_negative' ? `Negative ${f.suggestion.matchType.toLowerCase()}: ${f.suggestion.negative}` : 'Review') },
      { label: 'Reason', key: 'reason' },
    ])), { small: true })));
  root.append(h('div', { class: 'grid-3' },
    card({ kicker: 'Clearly not sellers', title: fmt.money(st.wasteSpend), sub: 'Spend on searches like jobs, rentals, courses, loans or cities outside the buy box.', comment: false }),
    card({ kicker: 'Findings', title: fmt.int(st.findings.length), sub: `Out of ${fmt.int(st.termCount)} search term + keyword pairs in this period.`, comment: false }),
    card({ kicker: 'Suggested negatives', title: fmt.int(new Set(st.findings.filter((f) => f.suggestion.action === 'add_negative').map((f) => `${f.campaignId}|${f.suggestion.negative}`)).size), sub: 'Waiting for approval in the Action Queue.', comment: false })));
  const cols = [
    { key: 'term', label: 'Search term', sticky: true, value: (f) => f.term, render: (f) => h('b', {}, f.term) },
    { key: 'keyword', label: 'Keyword', value: (f) => f.keywordText || '—' },
    { key: 'campaign', label: 'Campaign', value: (f) => f.campaignName },
    { key: 'spend', label: 'Spend', n: true, value: (f) => f.spend, render: (f) => fmt.money(f.spend) },
    { key: 'clicks', label: 'Clicks', n: true, value: (f) => f.clicks, render: (f) => fmt.int(f.clicks) },
    { key: 'conv', label: 'Google conv.', n: true, value: (f) => f.conversions, render: (f) => fmt.int(f.conversions) },
    { key: 'problem', label: 'Problem', value: (f) => f.severity, render: (f) => h('span', { class: 'btn-row' }, f.flags.map((x) => chip(x.label, SEVERITY_TONE[x.severity]))) },
    { key: 'suggest', label: 'Suggestion', value: (f) => f.suggestion.negative, render: (f) => (f.suggestion.action === 'add_negative'
      ? h('span', {}, `Add negative ${f.suggestion.matchType.toLowerCase()} “${f.suggestion.negative}”`, negStatus(f) ? h('span', { class: 'sub' }, PPC.ACTION_STATUSES[negStatus(f)]) : null)
      : h('span', { class: 'muted' }, 'Review by hand')) },
    { key: 'reason', label: 'Why', cls: 'reason', sort: false, value: (f) => f.reason },
  ];
  root.append(dataTable(cols, sortRows(st.findings, cols, state.termSort), {
    sort: state.termSort, onSort: (key) => { state.termSort = { key, dir: state.termSort.key === key && state.termSort.dir === 'desc' ? 'asc' : 'desc' }; renderView(); },
    empty: emptyState('No wasteful searches found', 'No search term in this period spent enough on something clearly irrelevant.'),
  }));
}

// ---------------------------------------------------------------- Landing pages
function viewLanding(root, a) {
  const list = a.landing;
  const count = (m) => list.filter((l) => l.match === m).length;
  root.append(h('div', { class: 'page-head' },
    h('div', {}, h('h2', { class: 'page-title' }, 'Landing pages'), h('p', { class: 'page-sub' }, 'Does the page match the search? Keyword → ad → landing page → headline → seller situation → call to action.'))));
  root.append(h('div', { class: 'btn-row' },
    chip(`${count('poor')} poor`, 'bad'), chip(`${count('partial')} partial`, 'warn'), chip(`${count('good')} good`, 'good'), chip(`${count('unknown')} not checked`, 'neutral'),
    h('span', { class: 'muted small' }, `${(a.model.dataset.web?.pages || []).length} pages known. Add pages with a landing page list (URL, H1, CTA) on Data Sources.`)));
  if (!list.length) {
    root.append(emptyState('No keywords in this period', 'Widen the date range.'));
    return;
  }
  root.append(h('div', { class: 'list card' }, list.map((l) => h('div', { class: 'list-row' },
    chip(MATCH_LABEL[l.match], MATCH_TONE[l.match]),
    h('div', { class: 'list-main' },
      h('span', { class: 'list-title' }, l.keyword, h('span', { class: 'muted small' }, ` · ${l.campaignName || ''} · ${fmt.money(l.spend)} · ${fmt.plural(l.leads, 'lead')}`)),
      h('div', { class: 'flow' },
        h('span', { class: 'flow-step' }, `Search: ${l.keyword}`), h('span', { class: 'flow-arrow' }, '→'),
        h('span', { class: 'flow-step' }, `Ad: ${l.adHeadlines?.[0] || 'not synced'}`), h('span', { class: 'flow-arrow' }, '→'),
        h('span', { class: 'flow-step' }, `Page: ${l.path || 'no URL'}`), h('span', { class: 'flow-arrow' }, '→'),
        h('span', { class: 'flow-step' }, `Headline: ${l.page?.h1 || '—'}`), h('span', { class: 'flow-arrow' }, '→'),
        h('span', { class: 'flow-step' }, `Situation: ${l.pageIntent ? PPC.situationLabel(l.pageIntent, a.model.settings.situations) : '—'}`), h('span', { class: 'flow-arrow' }, '→'),
        h('span', { class: 'flow-step' }, `Button: ${l.page?.cta || 'none found'}`)),
      l.issues.length ? h('ul', { class: 'plain small ink-2' }, l.issues.map((x) => h('li', {}, x))) : null,
      h('span', { class: 'small' }, h('b', {}, 'Do this: '), l.recommendation))))));
}

// ---------------------------------------------------------------- Retargeting
function viewRetargeting(root, a) {
  const r = a.retargeting;
  root.append(h('div', { class: 'page-head' },
    h('div', {}, h('h2', { class: 'page-title' }, 'Retargeting'), h('p', { class: 'page-sub' }, 'Audiences to build in GA4 and use in Google Ads. Sizes come from page totals, never from individual visitors.'))));
  root.append(note(`${r.basis} ${r.consentNote}`, 'info'));
  if (!r.hasData) {
    root.append(emptyState('No website data yet', 'Import a GA4 page report (page path + active users) or connect GA4 through the sync agent.'));
    return;
  }
  root.append(h('div', { class: 'segments' }, r.segments.map((sg) => h('article', { class: 'segment' },
    h('div', { class: 'card-kicker' }, sg.name),
    h('div', { class: 'segment-size' }, `~${fmt.int(sg.estimate)}`),
    chip(sg.eligibility.label, sg.eligibility.level === 'search_display' ? 'good' : sg.eligibility.level === 'display' ? 'warn' : 'neutral'),
    h('p', { class: 'small' }, sg.who),
    h('div', { class: 'code' }, sg.ga4),
    h('p', { class: 'small ink-2' }, h('b', {}, 'Use it: '), sg.use)))));
  const pages = [...(a.model.dataset.web?.pagePaths || [])].sort((x, y) => y.users - x.users);
  root.append(card({
    kicker: 'Website', title: 'Pages behind these audiences',
    body: simpleTable([{ label: 'Page' }, { label: 'Visitors', n: true }, { label: 'Returning', n: true }, { label: 'From Google Ads', n: true }, { label: 'Form starts', n: true }, { label: 'Form sends', n: true }],
      pages.map((p) => [p.path, fmt.int(p.users), fmt.int(p.returningUsers), fmt.int(p.ppcUsers), fmt.int(p.formStarts), fmt.int(p.formSubmits)])),
  }));
}
