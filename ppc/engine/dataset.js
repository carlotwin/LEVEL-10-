// The dataset is the one JSON document everything reads: Google Ads rows,
// REI leads (already stripped of personal details), GA4 rows, calls, landing
// pages and sync history. The dashboard stores it as one asset; the sync agent
// writes it to a file. Imports merge into it incrementally and idempotently:
// re-importing the same day for the same keyword replaces that day.
import { emptyAds } from './normalize/googleAds.js';
import { markDuplicates } from './normalize/rei.js';
import { cleanPath } from './normalize/ga4.js';
import { normText, todayUtc } from './util.js';

export const DATASET_SCHEMA = 'twin-ppc-dataset/1';

export const SOURCES = Object.freeze({
  google_ads: 'Google Ads',
  rei: 'REI BlackBook',
  ga4: 'Website (GA4)',
  calls: 'Call tracking',
  pages: 'Landing pages',
});

export function emptyDataset({ isDemo = false, label = '' } = {}) {
  return {
    schema: DATASET_SCHEMA,
    generatedAt: new Date().toISOString(),
    isDemo,
    label,
    ads: emptyAds(),
    rei: { leads: [], unmappedStatuses: {} },
    web: { landingDaily: [], pagePaths: [], pages: [], consent: null },
    calls: [],
    sync: { sources: {}, history: [] },
  };
}

// Lead fields allowed in a shared dataset. Anything else is dropped before
// the dataset leaves the browser or the agent (defense in depth: the REI
// normalizer already never copies names, phones, emails or addresses).
const LEAD_FIELDS = new Set([
  'id', 'sourceSystem', 'createdAt', 'createdDate', 'updatedAt', 'city', 'st', 'zip', 'source', 'sourceCampaign', 'gclid', 'utm',
  'landingPage', 'situationRaw', 'situation', 'situationOverride', 'statusRaw', 'stage', 'qualified', 'appointment', 'offer', 'contract',
  'closed', 'lost', 'junk', 'lostReason', 'appointmentAt', 'offerAt', 'contractAt', 'closedAt', 'score', 'revenue', 'profit',
  'offerAmount', 'phoneHash', 'emailHash', 'addressHash', 'duplicateOf',
]);
const PII_FIELDS = ['name', 'firstName', 'lastName', 'fullName', 'phone', 'phoneMobile', 'email', 'address', 'propertyAddress', 'mailingAddress', 'notes'];

export function stripLead(lead) {
  const out = {};
  for (const [k, v] of Object.entries(lead)) if (LEAD_FIELDS.has(k)) out[k] = v;
  return out;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE = /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;

/** Structural and privacy checks. Errors block an import; warnings are shown. */
export function validateDataset(ds) {
  const errors = [];
  const warnings = [];
  if (!ds || typeof ds !== 'object') return { ok: false, errors: ['Not a dataset (expected a JSON object).'], warnings };
  if (ds.schema !== DATASET_SCHEMA) errors.push(`Unknown dataset format "${ds.schema || 'none'}" (expected ${DATASET_SCHEMA}).`);
  const arrays = [
    ['ads.campaigns', ds.ads?.campaigns], ['ads.keywords', ds.ads?.keywords], ['ads.keywordDaily', ds.ads?.keywordDaily],
    ['ads.geoDaily', ds.ads?.geoDaily], ['ads.clicks', ds.ads?.clicks], ['ads.searchTermsDaily', ds.ads?.searchTermsDaily],
    ['rei.leads', ds.rei?.leads], ['calls', ds.calls],
  ];
  for (const [name, value] of arrays) if (value != null && !Array.isArray(value)) errors.push(`${name} must be a list.`);
  const leads = Array.isArray(ds.rei?.leads) ? ds.rei.leads : [];
  let piiHits = 0;
  for (const lead of leads) {
    if (PII_FIELDS.some((f) => lead[f] != null && lead[f] !== '')) piiHits += 1;
    else if ([lead.situationRaw, lead.lostReason, lead.statusRaw].some((t) => t && (EMAIL.test(t) || PHONE.test(t)))) piiHits += 1;
  }
  if (piiHits) errors.push(`${piiHits} lead(s) contain personal details (name, phone, email or address). Re-import through the REI importer, which removes them.`);
  const badDates = [...(ds.ads?.keywordDaily || []), ...(ds.ads?.geoDaily || [])].filter((r) => !DATE.test(String(r.d))).length;
  if (badDates) errors.push(`${badDates} Google Ads row(s) have an invalid date.`);
  const kwIds = new Set((ds.ads?.keywords || []).map((k) => k.id));
  const orphan = (ds.ads?.keywordDaily || []).filter((r) => !kwIds.has(r.k)).length;
  if (orphan) warnings.push(`${orphan} keyword row(s) point to a keyword that is not in the keyword list; they are ignored.`);
  const noDate = leads.filter((l) => !l.createdDate).length;
  if (noDate) warnings.push(`${noDate} lead(s) have no created date and cannot be placed in a date range.`);
  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/**
 * Rewrite incoming campaign / ad group / keyword ids to the ids already in the
 * base dataset when they are the same entity by name. A CSV export has no ids
 * (ids are made from names), while the API has real ids: without this, the
 * same keyword imported both ways would be counted twice.
 */
export function reconcileIds(base, incoming) {
  const campaignByName = new Map(base.campaigns.map((c) => [normText(c.name), c.id]));
  const campaignMap = new Map();
  for (const c of incoming.campaigns) {
    const existing = base.campaigns.find((b) => b.id === c.id) ? c.id : campaignByName.get(normText(c.name));
    if (existing && existing !== c.id) campaignMap.set(c.id, existing);
  }
  const cid = (id) => campaignMap.get(id) || id;
  const groupByName = new Map(base.adGroups.map((g) => [`${g.campaignId}|${normText(g.name)}`, g.id]));
  const groupMap = new Map();
  for (const g of incoming.adGroups) {
    if (base.adGroups.some((b) => b.id === g.id)) continue;
    const existing = groupByName.get(`${cid(g.campaignId)}|${normText(g.name)}`);
    if (existing && existing !== g.id) groupMap.set(g.id, existing);
  }
  const gid = (id) => groupMap.get(id) || id;
  const kwByNatural = new Map(base.keywords.map((k) => [`${k.adGroupId}|${normText(k.text)}|${k.matchType}`, k.id]));
  const kwMap = new Map();
  for (const k of incoming.keywords) {
    if (base.keywords.some((b) => b.id === k.id)) continue;
    const existing = kwByNatural.get(`${gid(k.adGroupId)}|${normText(k.text)}|${k.matchType}`);
    if (existing && existing !== k.id) kwMap.set(k.id, existing);
  }
  const kid = (id) => kwMap.get(id) || id;
  if (!campaignMap.size && !groupMap.size && !kwMap.size) return incoming;
  const fix = (r) => ({
    ...r,
    ...(r.c != null ? { c: cid(r.c) } : {}),
    ...(r.g != null ? { g: gid(r.g) } : {}),
    ...(r.k != null ? { k: kid(r.k) } : {}),
  });
  return {
    ...incoming,
    campaigns: incoming.campaigns.map((c) => ({ ...c, id: cid(c.id) })),
    adGroups: incoming.adGroups.map((g) => ({ ...g, id: gid(g.id), campaignId: cid(g.campaignId) })),
    keywords: incoming.keywords.map((k) => ({ ...k, id: kid(k.id), campaignId: cid(k.campaignId), adGroupId: gid(k.adGroupId) })),
    keywordDaily: incoming.keywordDaily.map(fix),
    keywordCityDaily: incoming.keywordCityDaily.map(fix),
    searchTermsDaily: incoming.searchTermsDaily.map(fix),
    geoDaily: incoming.geoDaily.map(fix),
    clicks: incoming.clicks.map(fix),
  };
}

function upsert(baseList, incomingList, keyOf, combine = (a, b) => ({ ...a, ...b })) {
  const map = new Map(baseList.map((x) => [keyOf(x), x]));
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  for (const item of incomingList) {
    const key = keyOf(item);
    const prev = map.get(key);
    if (!prev) {
      map.set(key, item);
      created += 1;
      continue;
    }
    const next = combine(prev, item);
    if (JSON.stringify(next) === JSON.stringify(prev)) unchanged += 1;
    else updated += 1;
    map.set(key, next);
  }
  return { list: [...map.values()], created, updated, unchanged };
}

/** Replace base rows for the (day, scope) pairs the incoming rows cover. */
function replaceDaily(baseRows, incomingRows, scopeOf) {
  if (!incomingRows.length) return { list: baseRows, replaced: 0, added: 0 };
  const covered = new Set(incomingRows.map((r) => `${r.d}|${scopeOf(r)}`));
  const kept = baseRows.filter((r) => !covered.has(`${r.d}|${scopeOf(r)}`));
  return { list: [...kept, ...incomingRows], replaced: baseRows.length - kept.length, added: incomingRows.length };
}

const keepFilled = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) if (v !== '' && v != null && !(k === 'status' && v === 'UNKNOWN' && a.status)) out[k] = v;
  return out;
};

/**
 * Merge `incoming` (a full or partial dataset) into `base`.
 * Demo data and real data are never mixed: real data replaces a demo base.
 * @returns {{dataset, stats}}
 */
export function mergeDataset(base, incoming, { duplicateWindowDays = 60 } = {}) {
  const inc = normalizeShape(incoming);
  let b = normalizeShape(base);
  const replacedDemo = !!(b.isDemo && !inc.isDemo);
  if (b.isDemo !== inc.isDemo) b = emptyDataset({ isDemo: inc.isDemo, label: inc.label });

  const incAds = reconcileIds(b.ads, inc.ads);
  const stats = { replacedDemo };
  const out = emptyDataset({ isDemo: inc.isDemo, label: inc.label || b.label });

  const camp = upsert(b.ads.campaigns, incAds.campaigns, (c) => c.id, keepFilled);
  const groups = upsert(b.ads.adGroups, incAds.adGroups, (g) => g.id, keepFilled);
  const kws = upsert(b.ads.keywords, incAds.keywords, (k) => k.id, keepFilled);
  out.ads.campaigns = camp.list;
  out.ads.adGroups = groups.list;
  out.ads.keywords = kws.list;
  // Replacement scope is as narrow as the rows allow, so a partial export (one
  // keyword, one ad group) only replaces what it contains: keyword rows by
  // (day, keyword); location and search-term rows by (day, campaign, ad group).
  const byKeyword = (r) => r.k || '';
  const byAdGroup = (r) => `${r.c || ''}|${r.g || ''}`;
  const kd = replaceDaily(b.ads.keywordDaily, incAds.keywordDaily, byKeyword);
  const kcd = replaceDaily(b.ads.keywordCityDaily, incAds.keywordCityDaily, byKeyword);
  const st = replaceDaily(b.ads.searchTermsDaily, incAds.searchTermsDaily, byAdGroup);
  const gd = replaceDaily(b.ads.geoDaily, incAds.geoDaily, byAdGroup);
  out.ads.keywordDaily = kd.list;
  out.ads.keywordCityDaily = kcd.list;
  out.ads.searchTermsDaily = st.list;
  out.ads.geoDaily = gd.list;
  const clicks = upsert(b.ads.clicks, incAds.clicks, (c) => c.gclid);
  out.ads.clicks = clicks.list;
  out.ads.geoConstants = { ...b.ads.geoConstants, ...incAds.geoConstants };
  out.ads.adCopy = upsert(b.ads.adCopy || [], incAds.adCopy || [], (a) => `${a.adGroupId}|${a.id || ''}`).list;
  stats.ads = {
    campaigns: camp.created, keywords: kws.created,
    rows: kd.added + kcd.added + st.added + gd.added, replacedRows: kd.replaced + kcd.replaced + st.replaced + gd.replaced,
    clicks: clicks.created,
  };

  // REI is the source of truth for a lead's status, so incoming values win;
  // blanks never erase what an earlier, richer import recorded (for example a
  // GCLID that the CSV export had but the crawler cannot see).
  const leads = upsert(b.rei.leads, inc.rei.leads.map(stripLead), (l) => l.id, (a, c) => {
    const merged = keepFilled(a, c);
    merged.createdAt = a.createdAt || c.createdAt;
    merged.createdDate = a.createdDate || c.createdDate;
    merged.duplicateOf = a.duplicateOf ?? null;
    return merged;
  });
  out.rei.leads = leads.list;
  out.rei.unmappedStatuses = { ...b.rei.unmappedStatuses, ...inc.rei.unmappedStatuses };
  stats.leads = { created: leads.created, updated: leads.updated, unchanged: leads.unchanged };
  stats.duplicates = markDuplicates(out.rei.leads, duplicateWindowDays);

  const landing = replaceDaily(b.web.landingDaily, inc.web.landingDaily, () => '');
  out.web.landingDaily = landing.list;
  out.web.pagePaths = inc.web.pagePaths.length ? inc.web.pagePaths : b.web.pagePaths;
  out.web.pages = upsert(b.web.pages, inc.web.pages, (p) => normText(cleanPath(p.url || p.path)), keepFilled).list;
  out.web.consent = inc.web.consent || b.web.consent;
  stats.web = { rows: landing.added, pages: inc.web.pages.length };

  const calls = upsert(b.calls, inc.calls, (c) => c.id);
  out.calls = calls.list;
  stats.calls = { created: calls.created, updated: calls.updated };

  out.sync.sources = { ...b.sync.sources };
  for (const [k, v] of Object.entries(inc.sync.sources)) out.sync.sources[k] = { ...(out.sync.sources[k] || {}), ...v };
  const history = new Map([...b.sync.history, ...inc.sync.history].map((h) => [h.id, h]));
  out.sync.history = [...history.values()].sort((x, y) => String(y.startedAt).localeCompare(String(x.startedAt))).slice(0, 300);
  out.generatedAt = new Date().toISOString();
  return { dataset: out, stats };
}

/** Fill in any missing sections so older or partial datasets merge cleanly. */
export function normalizeShape(ds) {
  const e = emptyDataset({ isDemo: !!ds?.isDemo, label: ds?.label || '' });
  if (!ds) return e;
  return {
    ...e,
    ...ds,
    schema: DATASET_SCHEMA,
    ads: { ...e.ads, ...(ds.ads || {}) },
    rei: { ...e.rei, ...(ds.rei || {}) },
    web: { ...e.web, ...(ds.web || {}) },
    calls: ds.calls || [],
    sync: { sources: { ...(ds.sync?.sources || {}) }, history: [...(ds.sync?.history || [])] },
  };
}

/** Record one sync/import run in the dataset's history and source status. */
export function recordSync(ds, run) {
  const now = run.finishedAt || new Date().toISOString();
  const entry = {
    id: run.id || `run_${now}_${run.source}`,
    source: run.source, mode: run.mode || '', startedAt: run.startedAt || now, finishedAt: now,
    status: run.status || 'ok', created: run.created || 0, updated: run.updated || 0, failed: run.failed || 0,
    unchanged: run.unchanged || 0, message: run.message || '', errors: (run.errors || []).slice(0, 20), by: run.by || '',
  };
  ds.sync = ds.sync || { sources: {}, history: [] };
  ds.sync.history = [entry, ...(ds.sync.history || [])].slice(0, 300);
  const prev = ds.sync.sources[run.source] || {};
  ds.sync.sources[run.source] = {
    ...prev,
    mode: run.mode || prev.mode || '',
    status: entry.status === 'failed' ? 'failed' : 'ok',
    lastAttemptAt: now,
    lastSuccessAt: entry.status === 'failed' ? prev.lastSuccessAt || null : now,
    lastError: entry.status === 'failed' ? entry.message : entry.status === 'partial' ? entry.message : '',
    ...(run.cursor ? { cursor: run.cursor } : {}),
  };
  return entry;
}

function range(list, pick) {
  let min = null;
  let max = null;
  for (const x of list) {
    const d = pick(x);
    if (!d) continue;
    if (!min || d < min) min = d;
    if (!max || d > max) max = d;
  }
  return { min, max };
}

/** Small summary stored next to the dataset pointer (shown before loading it). */
export function summarizeDataset(ds) {
  const d = normalizeShape(ds);
  const spendRows = d.ads.keywordCityDaily.length ? d.ads.keywordCityDaily : d.ads.keywordDaily;
  return {
    isDemo: !!d.isDemo,
    label: d.label || '',
    generatedAt: d.generatedAt,
    spend: Math.round(spendRows.reduce((a, r) => a + (r.cost || 0), 0)),
    ranges: {
      ads: range(spendRows, (r) => r.d),
      leads: range(d.rei.leads, (l) => l.createdDate),
      web: range(d.web.landingDaily, (r) => r.d),
    },
    counts: {
      campaigns: d.ads.campaigns.length, keywords: d.ads.keywords.length, clicks: d.ads.clicks.length,
      searchTerms: new Set(d.ads.searchTermsDaily.map((r) => r.term)).size, leads: d.rei.leads.length,
      calls: d.calls.length, pages: d.web.pages.length,
    },
    today: todayUtc(),
  };
}
