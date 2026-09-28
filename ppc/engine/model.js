// The model joins Google Ads spend, REI leads and attribution into the rows the
// dashboard shows: keyword + city (the main table), keyword, city, campaign,
// plus overall KPIs and weekly trends. Everything is recomputed from the
// dataset on every filter change, so recommendations are always current.
import { attributeLeads } from './attribution.js';
import { addTotals, computeMetrics, decide, emptyTotals, REC_ORDER } from './decisions.js';
import { cityKey, DEFAULT_GEO, geoIndex } from './geo.js';
import { deriveKeywordCityDaily } from './normalize/googleAds.js';
import { classifySituation, DEFAULT_SITUATIONS } from './situations.js';
import { inRange, normText, weekStart } from './util.js';

export const UNKNOWN_KEYWORD = '(keyword unknown)';

/** Default settings bundle (decision + attribution + geo + situations). */
export function mergeSettings(settings = {}) {
  return {
    decision: { ...(settings.decision || {}) },
    attribution: { ...(settings.attribution || {}) },
    geo: settings.geo?.length ? settings.geo : DEFAULT_GEO,
    situations: settings.situations?.length ? settings.situations : DEFAULT_SITUATIONS,
    waste: { ...(settings.waste || {}) },
    alerts: { ...(settings.alerts || {}) },
    actions: { ...(settings.actions || {}) },
    health: { ...(settings.health || {}) },
    retargeting: { ...(settings.retargeting || {}) },
  };
}

export function datasetDateBounds(dataset) {
  let min = null;
  let max = null;
  const see = (d) => {
    if (!d) return;
    if (!min || d < min) min = d;
    if (!max || d > max) max = d;
  };
  for (const r of dataset.ads?.keywordCityDaily || []) see(r.d);
  for (const r of dataset.ads?.keywordDaily || []) see(r.d);
  for (const l of dataset.rei?.leads || []) see(l.createdDate);
  return { min, max };
}

export function buildModel(dataset, rawSettings = {}) {
  const settings = mergeSettings(rawSettings);
  const ads = dataset.ads || {};
  const geo = geoIndex(settings.geo);
  const keywordsById = new Map((ads.keywords || []).map((k) => [k.id, k]));
  const campaignsById = new Map((ads.campaigns || []).map((c) => [String(c.id), c]));
  const adGroupsById = new Map((ads.adGroups || []).map((g) => [String(g.id), g]));

  const spendRows = ads.keywordCityDaily?.length
    ? ads.keywordCityDaily
    : deriveKeywordCityDaily({ keywords: ads.keywords, keywordDaily: ads.keywordDaily, geoDaily: ads.geoDaily, clicks: ads.clicks });

  // Seller situation: an admin's per-lead override wins; custom situation
  // rules re-classify the stored motivation text (keeping the import-time
  // result when the short stored text is not enough to decide).
  const overrides = rawSettings.situationOverrides || {};
  const customSituations = !!rawSettings.situations?.length;
  const leadsAll = (dataset.rei?.leads || []).map((lead) => {
    const override = overrides[lead.id];
    if (override) return { ...lead, situation: override, situationSource: 'override' };
    if (customSituations && lead.situationRaw) {
      const again = classifySituation(lead.situationRaw, settings.situations);
      if (again !== 'unknown' && again !== 'other') return { ...lead, situation: again };
    }
    return lead;
  });
  const attribution = attributeLeads({ leads: leadsAll, ads, calls: dataset.calls || [], settings: settings.attribution });
  const leads = leadsAll.map((lead) => {
    const attr = attribution.get(lead.id);
    const kw = attr?.keywordId ? keywordsById.get(attr.keywordId) : null;
    const text = kw ? normText(kw.text) : attr?.keywordText || null;
    return {
      ...lead,
      attr: {
        ...attr,
        keywordText: text,
        campaignId: attr?.campaignId || kw?.campaignId || null,
        county: attr?.city ? geo.county(attr.city, attr.st || 'CA') : '',
      },
    };
  });

  return {
    dataset, settings, geo, keywordsById, campaignsById, adGroupsById, spendRows, leads,
    bounds: datasetDateBounds(dataset),
    isDemo: !!dataset.isDemo,
  };
}

function rowKey(campaignId, text, city, st) {
  return `${campaignId || ''}|${text || UNKNOWN_KEYWORD}|${cityKey(city, st)}`;
}

function cityMatches(filters, city, county) {
  if (filters.cities?.length && !filters.cities.includes(city || '(unknown)')) return false;
  if (filters.counties?.length && !filters.counties.includes(county || '(unknown)')) return false;
  return true;
}

function keywordMatches(filters, text) {
  if (filters.keywords?.length && !filters.keywords.includes(text)) return false;
  if (filters.keywordSearch && !String(text || '').includes(normText(filters.keywordSearch))) return false;
  return true;
}

export function leadPassesQuality(lead, quality) {
  switch (quality) {
    case 'qualified': return !!lead.qualified;
    case 'unqualified': return !lead.qualified;
    case 'junk': return !!lead.junk;
    case 'hot': return lead.score != null && lead.score >= 9;
    default: return true;
  }
}

/** Is the lead inside the date range? Duplicates never count. */
export function leadInPeriod(lead, filters) {
  if (lead.duplicateOf) return false;
  return inRange(lead.attr?.date || lead.createdDate, filters.start, filters.end);
}

/** Filters that apply to leads only (ad spend cannot be split by them). */
export function hasLeadOnlyFilters(filters = {}) {
  return !!(filters.situations?.length || (filters.quality && filters.quality !== 'all'));
}

export function leadPassesLeadFilters(lead, filters) {
  if (filters.situations?.length && !filters.situations.includes(lead.situation || 'unknown')) return false;
  return leadPassesQuality(lead, filters.quality);
}

/** Does this lead count in the funnel for these filters? */
export function leadInScope(model, lead, filters) {
  return leadInPeriod(lead, filters) && leadPassesLeadFilters(lead, filters);
}

function addLead(t, lead) {
  t.leads += 1;
  if (lead.qualified) t.qualified += 1;
  if (lead.appointment) t.appointments += 1;
  if (lead.offer) t.offers += 1;
  if (lead.contract) t.contracts += 1;
  if (lead.junk) t.junk += 1;
  if (lead.closed) {
    t.deals += 1;
    if (lead.revenue != null) { t.revenue += lead.revenue; t.dealsWithRevenue += 1; }
    if (lead.profit != null) { t.profit += lead.profit; t.dealsWithProfit += 1; }
  }
  const c = lead.attr?.confidence;
  if (c === 'high') t.attrHigh += 1;
  else if (c === 'medium') t.attrMedium += 1;
  else if (c === 'low') t.attrLow += 1;
}

/**
 * The main table: one row per campaign + keyword text + ad city.
 * Spend is filtered by date/city/county/campaign/keyword. Seller situation and
 * lead quality filter the lead counts only: ad spend cannot be split by them,
 * so with those filters on, each row's recommendation is still made from all
 * of its leads (never from a subset against the full spend), rows without a
 * matching lead are hidden, and `leadOnlyFilters` tells the UI to say so.
 */
export function keywordCityTable(model, filters = {}) {
  const rows = new Map();
  const ensure = (campaignId, text, city, st) => {
    const key = rowKey(campaignId, text, city, st);
    let row = rows.get(key);
    if (!row) {
      row = {
        key, campaignId: campaignId || '', keyword: text || UNKNOWN_KEYWORD, city: city || '', st: st || '',
        county: city ? model.geo.county(city, st || 'CA') : '', inBuyBox: city ? model.geo.inBuyBox(city, st || 'CA') : null,
        keywordIds: new Set(), matchTypes: new Set(), totals: emptyTotals(), allTotals: emptyTotals(), leadIds: [], matched: 0,
      };
      rows.set(key, row);
    }
    return row;
  };

  for (const r of model.spendRows) {
    if (!inRange(r.d, filters.start, filters.end)) continue;
    const kw = model.keywordsById.get(r.k);
    if (!kw) continue;
    const text = normText(kw.text);
    if (filters.campaigns?.length && !filters.campaigns.includes(kw.campaignId)) continue;
    if (!keywordMatches(filters, text)) continue;
    const county = r.city ? model.geo.county(r.city, r.st || 'CA') : '';
    if (!cityMatches(filters, r.city, county)) continue;
    const row = ensure(kw.campaignId, text, r.city, r.st);
    row.keywordIds.add(kw.id);
    if (kw.matchType) row.matchTypes.add(kw.matchType);
    for (const t of [row.totals, row.allTotals]) {
      t.impressions += r.imp || 0;
      t.clicks += r.clk || 0;
      t.spend += r.cost || 0;
      t.googleConversions += r.conv || 0;
      if (r.est && r.est !== 'exact') t.estimatedSpend += r.cost || 0;
      if (row.inBuyBox === false) t.outOfAreaSpend += r.cost || 0;
    }
  }

  const leadOnly = hasLeadOnlyFilters(filters);
  const unmatched = { totals: emptyTotals(), allTotals: emptyTotals(), leadIds: [] };
  for (const lead of model.leads) {
    if (lead.attr?.channel !== 'ppc') continue;
    if (!leadInPeriod(lead, filters)) continue;
    const a = lead.attr;
    if (filters.campaigns?.length && !filters.campaigns.includes(a.campaignId || '')) continue;
    const passes = leadPassesLeadFilters(lead, filters);
    if (!a.keywordText) {
      if (filters.keywords?.length || filters.keywordSearch) continue;
      if (!cityMatches(filters, a.city, a.county)) continue;
      addLead(unmatched.allTotals, lead);
      if (passes) {
        addLead(unmatched.totals, lead);
        unmatched.leadIds.push(lead.id);
      }
      continue;
    }
    if (!keywordMatches(filters, a.keywordText)) continue;
    if (!cityMatches(filters, a.city, a.county)) continue;
    const row = ensure(a.campaignId, a.keywordText, a.city, a.st);
    if (a.keywordId) row.keywordIds.add(a.keywordId);
    addLead(row.allTotals, lead);
    if (passes) {
      addLead(row.totals, lead);
      row.leadIds.push(lead.id);
      row.matched += 1;
    }
  }

  const topTerms = topSearchTerms(model, filters);
  const out = [];
  for (const row of rows.values()) {
    if (leadOnly && !row.matched) continue;
    const m = computeMetrics(row.totals);
    const basis = computeMetrics(leadOnly ? row.allTotals : row.totals);
    const decision = decide({ ...basis, unknownCity: !row.city }, model.settings.decision);
    const terms = [...row.keywordIds].flatMap((id) => topTerms.get(id) || []);
    terms.sort((a, b) => b.cost - a.cost);
    out.push({
      ...row,
      keywordIds: [...row.keywordIds],
      matchTypes: [...row.matchTypes],
      campaignName: model.campaignsById.get(row.campaignId)?.name || (row.campaignId ? row.campaignId : 'Campaign unknown'),
      metrics: m,
      decision,
      estimatedShare: m.spend ? row.totals.estimatedSpend / m.spend : 0,
      topSearchTerm: terms[0]?.term || '',
      searchTermCount: new Set(terms.map((t) => t.term)).size,
    });
  }
  const filtered = filters.recommendations?.length ? out.filter((r) => filters.recommendations.includes(r.decision.rec)) : out;
  filtered.sort((a, b) => b.metrics.spend - a.metrics.spend || b.metrics.leads - a.metrics.leads);

  const unmatchedMetrics = computeMetrics(unmatched.totals);
  return {
    rows: filtered,
    leadOnlyFilters: leadOnly,
    unmatched: unmatched.totals.leads
      ? { ...unmatched, metrics: unmatchedMetrics, decision: decide({ ...unmatchedMetrics, unattributed: true }, model.settings.decision) }
      : null,
  };
}

/** keywordId -> [{term, cost}] within the date range. */
function topSearchTerms(model, filters) {
  const map = new Map();
  for (const r of model.dataset.ads?.searchTermsDaily || []) {
    if (!r.k || !inRange(r.d, filters.start, filters.end)) continue;
    let list = map.get(r.k);
    if (!list) map.set(r.k, (list = new Map()));
    list.set(r.term, (list.get(r.term) || 0) + (r.cost || 0));
  }
  const out = new Map();
  for (const [k, terms] of map) out.set(k, [...terms].map(([term, cost]) => ({ term, cost })));
  return out;
}

const ROLLUP_KEYS = {
  keyword: (r) => `${r.campaignId}|${r.keyword}`,
  city: (r) => cityKey(r.city, r.st),
  campaign: (r) => r.campaignId,
  campaign_city: (r) => `${r.campaignId}|${cityKey(r.city, r.st)}`,
};

/** Roll table rows up by 'keyword' (campaign + text), 'city', 'campaign' or 'campaign_city'. */
export function rollUp(model, rows, by) {
  const keyOf = ROLLUP_KEYS[by];
  if (!keyOf) throw new Error(`Unknown roll-up: ${by}`);
  const withCampaign = by !== 'city';
  const withCity = by === 'city' || by === 'campaign_city';
  const groups = new Map();
  for (const r of rows) {
    const key = keyOf(r);
    let g = groups.get(key);
    if (!g) {
      g = {
        key, by, campaignId: withCampaign ? r.campaignId : '', campaignName: withCampaign ? r.campaignName : '',
        keyword: by === 'keyword' ? r.keyword : '', city: withCity ? r.city : '', st: withCity ? r.st : '',
        county: withCity ? r.county : '', inBuyBox: withCity ? r.inBuyBox : null,
        keywordIds: new Set(), totals: emptyTotals(), allTotals: emptyTotals(), rows: 0, cities: new Set(), keywords: new Set(),
      };
      groups.set(key, g);
    }
    addTotals(g.totals, r.totals);
    addTotals(g.allTotals, r.allTotals || r.totals);
    r.keywordIds.forEach((id) => g.keywordIds.add(id));
    g.cities.add(r.city || '(unknown)');
    g.keywords.add(r.keyword);
    g.rows += 1;
  }
  return [...groups.values()].map((g) => {
    const m = computeMetrics(g.totals);
    return {
      ...g, keywordIds: [...g.keywordIds], cities: [...g.cities], keywords: [...g.keywords], metrics: m,
      decision: decide({ ...computeMetrics(g.allTotals), unknownCity: withCity && !g.city }, model.settings.decision),
    };
  }).sort((a, b) => b.metrics.spend - a.metrics.spend);
}

/** Headline numbers for the filters: all spend and all Google Ads leads. */
export function overview(model, filters = {}) {
  const table = keywordCityTable(model, { ...filters, recommendations: [] });
  const totals = emptyTotals();
  for (const r of table.rows) addTotals(totals, r.totals);
  if (table.unmatched) addTotals(totals, table.unmatched.totals);
  const m = computeMetrics(totals);

  const channels = { ppc: 0, other: 0, unknown: 0 };
  const methods = {};
  let duplicates = 0;
  for (const lead of model.leads) {
    if (!inRange(lead.attr?.date || lead.createdDate, filters.start, filters.end)) continue;
    if (lead.duplicateOf) { duplicates += 1; continue; }
    channels[lead.attr?.channel || 'unknown'] = (channels[lead.attr?.channel || 'unknown'] || 0) + 1;
    if (lead.attr?.channel === 'ppc') methods[lead.attr.method] = (methods[lead.attr.method] || 0) + 1;
  }

  const recCounts = { SCALE: 0, WATCH: 0, REDUCE: 0, PAUSE: 0 };
  const recSpend = { SCALE: 0, WATCH: 0, REDUCE: 0, PAUSE: 0 };
  for (const r of table.rows) {
    recCounts[r.decision.rec] += 1;
    recSpend[r.decision.rec] += r.metrics.spend;
  }
  const making = table.rows.filter((r) => r.decision.rec === 'SCALE')
    .sort((a, b) => (b.metrics.profit || 0) - (a.metrics.profit || 0) || b.metrics.contracts - a.metrics.contracts || b.metrics.qualified - a.metrics.qualified);
  const wasting = table.rows.filter((r) => r.decision.rec === 'PAUSE' || r.decision.rec === 'REDUCE')
    .sort((a, b) => REC_ORDER[a.decision.rec] - REC_ORDER[b.decision.rec] || b.metrics.spend - a.metrics.spend);
  const wasteSpend = wasting.reduce((acc, r) => acc + r.metrics.spend, 0);
  return { metrics: m, table, channels, methods, duplicates, recCounts, recSpend, making, wasting, wasteSpend };
}

/** Weekly series for spend, leads, qualified leads, contracts and deals. */
export function weeklyTrend(model, filters = {}) {
  const weeks = new Map();
  const bucket = (d) => {
    const w = weekStart(d);
    let b = weeks.get(w);
    if (!b) weeks.set(w, (b = { week: w, spend: 0, clicks: 0, leads: 0, qualified: 0, contracts: 0, deals: 0 }));
    return b;
  };
  for (const r of model.spendRows) {
    if (!inRange(r.d, filters.start, filters.end)) continue;
    const kw = model.keywordsById.get(r.k);
    if (!kw) continue;
    if (filters.campaigns?.length && !filters.campaigns.includes(kw.campaignId)) continue;
    if (!keywordMatches(filters, normText(kw.text))) continue;
    if (!cityMatches(filters, r.city, r.city ? model.geo.county(r.city, r.st || 'CA') : '')) continue;
    const b = bucket(r.d);
    b.spend += r.cost || 0;
    b.clicks += r.clk || 0;
  }
  for (const lead of model.leads) {
    if (lead.attr?.channel !== 'ppc' || !leadInScope(model, lead, filters)) continue;
    const a = lead.attr;
    if (filters.campaigns?.length && !filters.campaigns.includes(a.campaignId || '')) continue;
    if ((filters.keywords?.length || filters.keywordSearch) && !(a.keywordText && keywordMatches(filters, a.keywordText))) continue;
    if (!cityMatches(filters, a.city, a.county)) continue;
    const b = bucket(a.date || lead.createdDate);
    b.leads += 1;
    if (lead.qualified) b.qualified += 1;
    if (lead.contract) b.contracts += 1;
    if (lead.closed) b.deals += 1;
  }
  return [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week));
}

/** Distinct values for filter menus. */
export function filterOptions(model) {
  const cities = new Set();
  const counties = new Set();
  const keywords = new Set();
  for (const r of model.spendRows) {
    cities.add(r.city || '(unknown)');
    if (r.city) counties.add(model.geo.county(r.city, r.st || 'CA') || '(unknown)');
    const kw = model.keywordsById.get(r.k);
    if (kw) keywords.add(normText(kw.text));
  }
  for (const l of model.leads) {
    if (l.attr?.channel === 'ppc') {
      cities.add(l.attr.city || '(unknown)');
      if (l.attr.keywordText) keywords.add(l.attr.keywordText);
    }
  }
  return {
    cities: [...cities].sort(),
    counties: [...counties].filter(Boolean).sort(),
    campaigns: [...model.campaignsById.values()].map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)),
    keywords: [...keywords].sort(),
    situations: model.settings.situations.map((s) => ({ code: s.code, label: s.label })),
  };
}
