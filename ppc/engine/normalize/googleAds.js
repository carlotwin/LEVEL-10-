// Google Ads data -> the dashboard's normalized shape.
//
// Two inputs produce the same output:
//   * CSV exports from the Google Ads UI (keyword, search term, location and
//     click reports) — the backup path when API access is not available;
//   * Google Ads API (GAQL) result rows, fetched by the sync agent.
//
// Keyword x city spend. The API cannot segment keyword_view by city
// (segments.geo_target_city is selectable only with geographic_view). Exact
// ad group x city x day spend comes from geographic_view; it is split among
// that ad group's keywords by each keyword's clicks in that city (click_view),
// or by the keywords' spend share when no click locations exist. Totals stay
// exact; only the split is estimated, and rows carry est:'allocated'.
import { findHeaderRow, mapColumns, parseCsv, rowsToObjects, headerKey } from '../csv.js';
import { parseLocation } from '../geo.js';
import { groupBy, normText, stableId, toDate, toInt, toNumber } from '../util.js';

const ALIASES = {
  day: ['Day', 'Date'],
  campaign: ['Campaign', 'Campaign name'],
  campaignId: ['Campaign ID'],
  campaignStatus: ['Campaign status', 'Campaign state'],
  adGroup: ['Ad group', 'Ad group name'],
  adGroupId: ['Ad group ID'],
  keyword: ['Keyword', 'Search keyword', 'Keyword text', 'Criterion'],
  keywordId: ['Keyword ID', 'Criterion ID'],
  matchType: ['Match type', 'Search keyword match type', 'Keyword match type'],
  keywordStatus: ['Keyword status', 'Status'],
  searchTerm: ['Search term', 'Search terms', 'Query'],
  city: ['City (User location)', 'City (Matched location)', 'City (Location of presence)', 'City', 'Matched location',
    'User location', 'Location', 'Location (User location)', 'Target location'],
  region: ['Region (User location)', 'Region (Matched location)', 'Region', 'State'],
  device: ['Device'],
  impressions: ['Impr.', 'Impressions'],
  clicks: ['Clicks'],
  cost: ['Cost', 'Spend', 'Cost (USD)', 'Amount spent'],
  conversions: ['Conversions', 'Conv.'],
  convValue: ['Conv. value', 'Conversion value', 'Total conv. value'],
  finalUrl: ['Final URL', 'Final URLs', 'Landing page'],
  gclid: ['GCLID', 'Google Click ID', 'Google click ID'],
};

const HEADER_HINTS = Object.values(ALIASES).flat();

export const MATCH_TYPES = { EXACT: 'EXACT', PHRASE: 'PHRASE', BROAD: 'BROAD' };

export function normalizeMatchType(value) {
  const s = normText(value);
  if (!s) return '';
  if (s.startsWith('exact')) return 'EXACT';
  if (s.startsWith('phrase')) return 'PHRASE';
  if (s.startsWith('broad')) return 'BROAD';
  return s.toUpperCase();
}

/** "[sell my house]" -> exact, '"sell my house"' -> phrase, "+sell +house" -> broad. */
export function parseKeywordText(raw, matchType) {
  let text = String(raw ?? '').trim();
  let inferred = '';
  if (/^\[.*\]$/.test(text)) {
    inferred = 'EXACT';
    text = text.slice(1, -1);
  } else if (/^".*"$/.test(text)) {
    inferred = 'PHRASE';
    text = text.slice(1, -1);
  } else if (/(^|\s)\+\S/.test(text)) {
    inferred = 'BROAD';
    text = text.replace(/(^|\s)\+/g, '$1');
  }
  return { text: text.replace(/\s+/g, ' ').trim(), matchType: normalizeMatchType(matchType) || inferred || 'BROAD' };
}

export function normalizeDevice(value) {
  const s = normText(value);
  if (!s) return 'all';
  if (s.includes('mobile') || s === 'phone') return 'mobile';
  if (s.includes('computer') || s.includes('desktop')) return 'desktop';
  if (s.includes('tablet')) return 'tablet';
  if (s.includes('tv')) return 'tv';
  return 'other';
}

/** Which report is this CSV? Decided from the columns present. */
export function detectReportType(mapping) {
  if (mapping.gclid) return 'clicks';
  if (mapping.searchTerm) return 'search_terms';
  if (mapping.keyword && mapping.city) return 'keyword_city';
  if (mapping.keyword) return 'keywords';
  if (mapping.city) return 'locations';
  return 'unknown';
}

/** Date range from Google Ads' title lines: "September 1, 2026 - September 27, 2026". */
function periodFromTitle(rows, headerIndex) {
  for (let i = 0; i < headerIndex; i += 1) {
    const line = rows[i].join(' ');
    const m = /([A-Za-z]+\.? \d{1,2}, \d{4})\s*[-–—]\s*([A-Za-z]+\.? \d{1,2}, \d{4})/.exec(line);
    if (m) return { start: toDate(m[1]), end: toDate(m[2]) };
  }
  return null;
}

export function emptyAds() {
  return { campaigns: [], adGroups: [], keywords: [], keywordDaily: [], keywordCityDaily: [], searchTermsDaily: [], geoDaily: [], clicks: [], geoConstants: {} };
}

/**
 * Parse one Google Ads UI CSV export.
 * @returns {{reportType, ads, period, warnings, rowCount}}
 */
export function parseGoogleAdsCsv(text, { reportType: forcedType, fallbackDate } = {}) {
  const rows = parseCsv(text);
  const warnings = [];
  const headerIndex = findHeaderRow(rows, HEADER_HINTS, 3);
  if (headerIndex < 0) {
    return { reportType: 'unknown', ads: emptyAds(), period: null, rowCount: 0, warnings: ['No Google Ads header row found (expected columns like Campaign, Keyword, Clicks, Cost).'] };
  }
  const objects = rowsToObjects(rows, headerIndex);
  const headers = rows[headerIndex].map((h) => String(h).trim());
  const { mapping } = mapColumns(headers, ALIASES);
  const reportType = forcedType || detectReportType(mapping);
  const period = periodFromTitle(rows, headerIndex);
  if (!mapping.day) {
    const d = period?.end || fallbackDate || null;
    warnings.push(d
      ? `No "Day" column: every row is stored as one total dated ${d}. Add the Day segment in Google Ads for daily trends.`
      : 'No "Day" column and no date range in the file: rows could not be dated.');
  }
  const ads = emptyAds();
  const reg = registry(ads);
  let skipped = 0;
  for (const o of objects) {
    const first = String(Object.values(o)[0] || '');
    if (/^total/i.test(first) || /^total:/i.test(String(o[mapping.campaign] || ''))) {
      skipped += 1;
      continue;
    }
    const d = mapping.day ? toDate(o[mapping.day]) : period?.end || fallbackDate || null;
    if (!d) {
      skipped += 1;
      continue;
    }
    const metrics = {
      imp: toInt(o[mapping.impressions]) || 0,
      clk: toInt(o[mapping.clicks]) || 0,
      cost: toNumber(o[mapping.cost]) || 0,
      conv: toNumber(o[mapping.conversions]) || 0,
      cv: toNumber(o[mapping.convValue]) || 0,
    };
    const campaign = reg.campaign(o[mapping.campaignId], o[mapping.campaign], o[mapping.campaignStatus]);
    const adGroup = mapping.adGroup || mapping.adGroupId ? reg.adGroup(campaign, o[mapping.adGroupId], o[mapping.adGroup]) : null;
    const loc = mapping.city ? parseLocation(o[mapping.city], mapping.region ? '' : 'CA') : { city: '', state: '' };
    if (mapping.region && loc.city && !loc.state) loc.state = parseLocation(`x, ${o[mapping.region]}`).state;

    if (reportType === 'keywords' || reportType === 'keyword_city') {
      const kw = reg.keyword(campaign, adGroup, o[mapping.keywordId], o[mapping.keyword], o[mapping.matchType], o[mapping.keywordStatus], o[mapping.finalUrl]);
      if (!kw) { skipped += 1; continue; }
      if (reportType === 'keyword_city') {
        ads.keywordCityDaily.push({ d, k: kw.id, city: loc.city, st: loc.state, ...metrics, est: 'exact' });
      } else {
        ads.keywordDaily.push({ d, k: kw.id, dev: normalizeDevice(o[mapping.device]), ...metrics });
      }
    } else if (reportType === 'search_terms') {
      const kw = mapping.keyword ? reg.keyword(campaign, adGroup, o[mapping.keywordId], o[mapping.keyword], o[mapping.matchType], '', '') : null;
      const term = String(o[mapping.searchTerm] || '').trim();
      if (!term) { skipped += 1; continue; }
      ads.searchTermsDaily.push({ d, term, k: kw?.id || '', c: campaign?.id || '', g: adGroup?.id || '', ...metrics });
    } else if (reportType === 'locations') {
      ads.geoDaily.push({ d, c: campaign?.id || '', g: adGroup?.id || '', city: loc.city, st: loc.state, ...metrics });
    } else if (reportType === 'clicks') {
      const gclid = String(o[mapping.gclid] || '').trim();
      if (!gclid) { skipped += 1; continue; }
      const kw = mapping.keyword ? reg.keyword(campaign, adGroup, o[mapping.keywordId], o[mapping.keyword], o[mapping.matchType], '', '') : null;
      ads.clicks.push({ gclid, d, k: kw?.id || '', c: campaign?.id || '', g: adGroup?.id || '', city: loc.city, st: loc.state, dev: normalizeDevice(o[mapping.device]) });
    } else {
      skipped += 1;
    }
  }
  if (reportType === 'unknown') warnings.push('Could not tell which Google Ads report this is. Expected a keyword, search term, location or click report.');
  if (skipped) warnings.push(`${skipped} row(s) skipped (totals, blank dates or missing keyword/term).`);
  return { reportType, ads, period, rowCount: objects.length, warnings };
}

/** Keeps campaign / ad group / keyword entities unique while parsing. */
function registry(ads) {
  const campaigns = new Map();
  const adGroups = new Map();
  const keywords = new Map();
  return {
    campaign(id, name, status) {
      const cleanName = String(name || '').trim();
      const cid = String(id || '').trim() || (cleanName ? stableId('cmp', cleanName) : 'cmp_unknown');
      if (!campaigns.has(cid)) {
        const c = { id: cid, name: cleanName || cid, status: String(status || '').toUpperCase() || 'UNKNOWN' };
        campaigns.set(cid, c);
        ads.campaigns.push(c);
      }
      return campaigns.get(cid);
    },
    adGroup(campaign, id, name) {
      const cleanName = String(name || '').trim();
      const gid = String(id || '').trim() || stableId('adg', campaign?.id || '', cleanName || 'default');
      if (!adGroups.has(gid)) {
        const g = { id: gid, campaignId: campaign?.id || '', name: cleanName || gid, status: 'UNKNOWN' };
        adGroups.set(gid, g);
        ads.adGroups.push(g);
      }
      return adGroups.get(gid);
    },
    keyword(campaign, adGroup, id, rawText, rawMatch, status, finalUrl) {
      if (!rawText) return null;
      const { text, matchType } = parseKeywordText(rawText, rawMatch);
      if (!text) return null;
      const kid = String(id || '').trim()
        ? `${adGroup?.id || 'adg'}~${String(id).trim()}`
        : stableId('kw', campaign?.id || '', adGroup?.id || '', text, matchType);
      if (!keywords.has(kid)) {
        const k = {
          id: kid, campaignId: campaign?.id || '', adGroupId: adGroup?.id || '', text, matchType,
          status: String(status || '').toUpperCase() || 'UNKNOWN', finalUrl: String(finalUrl || '').split(/\s*[,\n]\s*/)[0] || '',
        };
        keywords.set(kid, k);
        ads.keywords.push(k);
      }
      return keywords.get(kid);
    },
  };
}

// ----------------------------------------------------------------------------
// Google Ads API (GAQL REST) rows -> normalized. The sync agent fetches these.
// ----------------------------------------------------------------------------

const micros = (v) => (v == null ? 0 : Number(v) / 1e6);
const num = (v) => (v == null ? 0 : Number(v) || 0);

/** "customers/1/adGroupCriteria/222~333" -> "222~333" */
export function criterionKeyFromResource(resourceName) {
  const m = /adGroupCriteria\/(\d+~\d+)/.exec(String(resourceName || ''));
  return m ? m[1] : '';
}

/** geoTargetConstants/1014226 -> "1014226" */
export function geoIdFromResource(resourceName) {
  const m = /geoTargetConstants\/(\d+)/.exec(String(resourceName || ''));
  return m ? m[1] : '';
}

function geoCity(geoConstants, resourceName) {
  const id = geoIdFromResource(resourceName);
  const g = id ? geoConstants[id] : null;
  if (!g) return { city: '', state: '', geoId: id };
  const loc = parseLocation(g.canonicalName || g.name);
  return { city: loc.city || g.name || '', state: loc.state || '', geoId: id };
}

/**
 * @param {object} results {campaigns, adGroups, keywordView, searchTermView, geographicView, clickView, geoConstants}
 *   each an array of GAQL REST rows (camelCase JSON as the API returns them).
 */
export function normalizeGaql(results) {
  const ads = emptyAds();
  const geoConstants = {};
  for (const r of results.geoConstants || []) {
    const g = r.geoTargetConstant || r;
    const id = String(g.id || geoIdFromResource(g.resourceName));
    if (id) geoConstants[id] = { name: g.name || '', canonicalName: g.canonicalName || '', targetType: g.targetType || '' };
  }
  ads.geoConstants = geoConstants;

  const campaignSeen = new Map();
  const addCampaign = (c) => {
    if (!c?.id || campaignSeen.has(String(c.id))) return;
    const row = { id: String(c.id), name: c.name || String(c.id), status: c.status || 'UNKNOWN', channel: c.advertisingChannelType || '' };
    campaignSeen.set(row.id, row);
    ads.campaigns.push(row);
  };
  for (const r of results.campaigns || []) addCampaign(r.campaign);

  const adGroupSeen = new Map();
  const addAdGroup = (g, campaignId) => {
    if (!g?.id || adGroupSeen.has(String(g.id))) return;
    const row = { id: String(g.id), campaignId: String(campaignId || ''), name: g.name || String(g.id), status: g.status || 'UNKNOWN' };
    adGroupSeen.set(row.id, row);
    ads.adGroups.push(row);
  };
  for (const r of results.adGroups || []) addAdGroup(r.adGroup, r.campaign?.id);

  const keywordSeen = new Map();
  for (const r of results.keywordView || []) {
    const agc = r.adGroupCriterion || {};
    const gid = String(r.adGroup?.id || '');
    const kid = `${gid}~${agc.criterionId}`;
    addCampaign(r.campaign);
    addAdGroup(r.adGroup, r.campaign?.id);
    if (!keywordSeen.has(kid)) {
      const k = {
        id: kid, campaignId: String(r.campaign?.id || ''), adGroupId: gid, text: agc.keyword?.text || '',
        matchType: agc.keyword?.matchType || 'UNKNOWN', status: agc.status || 'UNKNOWN', finalUrl: (agc.finalUrls || [])[0] || '',
      };
      keywordSeen.set(kid, k);
      ads.keywords.push(k);
    }
    const m = r.metrics || {};
    ads.keywordDaily.push({
      d: r.segments?.date, k: kid, dev: normalizeDevice(r.segments?.device),
      imp: num(m.impressions), clk: num(m.clicks), cost: micros(m.costMicros), conv: num(m.conversions), cv: num(m.conversionsValue),
    });
  }

  for (const r of results.searchTermView || []) {
    const m = r.metrics || {};
    ads.searchTermsDaily.push({
      d: r.segments?.date, term: r.searchTermView?.searchTerm || '',
      k: criterionKeyFromResource(r.segments?.keyword?.adGroupCriterion), c: String(r.campaign?.id || ''), g: String(r.adGroup?.id || ''),
      imp: num(m.impressions), clk: num(m.clicks), cost: micros(m.costMicros), conv: num(m.conversions), cv: num(m.conversionsValue),
    });
  }

  for (const r of results.geographicView || []) {
    if (r.geographicView?.locationType && r.geographicView.locationType !== 'LOCATION_OF_PRESENCE') continue;
    const m = r.metrics || {};
    const loc = geoCity(geoConstants, r.segments?.geoTargetCity);
    ads.geoDaily.push({
      d: r.segments?.date, c: String(r.campaign?.id || ''), g: String(r.adGroup?.id || ''), city: loc.city, st: loc.state,
      imp: num(m.impressions), clk: num(m.clicks), cost: micros(m.costMicros), conv: num(m.conversions), cv: num(m.conversionsValue),
    });
  }

  for (const r of results.clickView || []) {
    const cv = r.clickView || {};
    const loc = geoCity(geoConstants, cv.locationOfPresence?.city || cv.locationOfPresence?.mostSpecific);
    ads.clicks.push({
      gclid: cv.gclid, d: r.segments?.date, k: criterionKeyFromResource(cv.keyword), c: String(r.campaign?.id || ''),
      g: String(r.adGroup?.id || ''), city: loc.city, st: loc.state, dev: normalizeDevice(r.segments?.device),
    });
  }
  return ads;
}

// ----------------------------------------------------------------------------
// Keyword x city allocation
// ----------------------------------------------------------------------------

/**
 * Build keyword x city x day rows from keyword/day totals, ad group (or
 * campaign) x city x day geo rows, and click locations.
 *
 * - Where exact keyword x city rows already exist for a day they are kept.
 * - Otherwise each geo row's metrics are split across the keywords of its ad
 *   group (or campaign) by that keyword's clicks in that city that day; with no
 *   click locations, by the keywords' spend share that day.
 * - Keyword spend that no geo row covers stays with city '' (unknown city).
 */
export function deriveKeywordCityDaily({ keywords = [], keywordDaily = [], geoDaily = [], clicks = [], exact = [] }) {
  const out = [...exact];
  const exactDays = new Set(exact.map((r) => `${r.d}|${r.k}`));
  const kwById = new Map(keywords.map((k) => [k.id, k]));

  // keyword/day totals (devices summed)
  const kwDay = new Map();
  for (const r of keywordDaily) {
    if (exactDays.has(`${r.d}|${r.k}`)) continue;
    const key = `${r.d}|${r.k}`;
    const cur = kwDay.get(key) || { d: r.d, k: r.k, imp: 0, clk: 0, cost: 0, conv: 0, cv: 0 };
    cur.imp += r.imp || 0; cur.clk += r.clk || 0; cur.cost += r.cost || 0; cur.conv += r.conv || 0; cur.cv += r.cv || 0;
    kwDay.set(key, cur);
  }
  // click counts per day/keyword/city
  const clickCount = new Map();
  for (const c of clicks) {
    if (!c.k || !c.city) continue;
    const key = `${c.d}|${c.k}|${c.city}|${c.st || ''}`;
    clickCount.set(key, (clickCount.get(key) || 0) + 1);
  }
  const allocated = new Map(); // `${d}|${k}` -> allocated metrics
  const add = (row) => {
    const key = `${row.d}|${row.k}|${row.city}|${row.st}`;
    const prev = allocated.get(key);
    if (prev) {
      prev.imp += row.imp; prev.clk += row.clk; prev.cost += row.cost; prev.conv += row.conv; prev.cv += row.cv;
    } else allocated.set(key, { ...row });
  };
  // keywords per (day, ad group) and (day, campaign) that had activity
  const byDayGroup = groupBy([...kwDay.values()], (r) => `${r.d}|${kwById.get(r.k)?.adGroupId || ''}`);
  const byDayCampaign = groupBy([...kwDay.values()], (r) => `${r.d}|${kwById.get(r.k)?.campaignId || ''}`);
  const usedCost = new Map(); // `${d}|${k}` -> cost allocated to known cities
  // When ad-group-level city rows exist for a campaign/day, campaign-level rows
  // for the same campaign/day would count the same spend twice: skip them.
  const hasGroupLevel = new Set(geoDaily.filter((g) => g.g).map((g) => `${g.d}|${g.c}`));

  for (const g of geoDaily) {
    if (!g.city) continue;
    if (!g.g && hasGroupLevel.has(`${g.d}|${g.c}`)) continue;
    const group = g.g ? byDayGroup.get(`${g.d}|${g.g}`) : byDayCampaign.get(`${g.d}|${g.c}`);
    if (!group || !group.length) continue;
    const weights = group.map((r) => clickCount.get(`${g.d}|${r.k}|${g.city}|${g.st || ''}`) || 0);
    let total = weights.reduce((a, b) => a + b, 0);
    let w = weights;
    if (!total) {
      w = group.map((r) => r.cost || r.clk || 0);
      total = w.reduce((a, b) => a + b, 0);
    }
    if (!total) continue;
    group.forEach((r, i) => {
      const share = w[i] / total;
      if (!share) return;
      const row = {
        d: g.d, k: r.k, city: g.city, st: g.st || '',
        imp: (g.imp || 0) * share, clk: (g.clk || 0) * share, cost: (g.cost || 0) * share,
        conv: (g.conv || 0) * share, cv: (g.cv || 0) * share, est: 'allocated',
      };
      add(row);
      usedCost.set(`${g.d}|${r.k}`, (usedCost.get(`${g.d}|${r.k}`) || 0) + row.cost);
    });
  }
  for (const r of allocated.values()) {
    out.push({ ...r, imp: Math.round(r.imp), clk: Math.round(r.clk * 100) / 100, cost: Math.round(r.cost * 100) / 100, conv: Math.round(r.conv * 100) / 100, cv: Math.round(r.cv * 100) / 100 });
  }
  // Remainder of keyword spend not covered by any city row -> unknown city.
  for (const r of kwDay.values()) {
    const covered = usedCost.get(`${r.d}|${r.k}`) || 0;
    const rest = r.cost - covered;
    if (covered === 0) {
      out.push({ d: r.d, k: r.k, city: '', st: '', imp: r.imp, clk: r.clk, cost: Math.round(r.cost * 100) / 100, conv: r.conv, cv: r.cv, est: 'no_city' });
    } else if (rest > 0.5) {
      const f = rest / r.cost;
      out.push({ d: r.d, k: r.k, city: '', st: '', imp: Math.round(r.imp * f), clk: Math.round(r.clk * f * 100) / 100, cost: Math.round(rest * 100) / 100, conv: Math.round(r.conv * f * 100) / 100, cv: Math.round(r.cv * f * 100) / 100, est: 'no_city' });
    }
  }
  return out;
}

export { headerKey as _headerKey };
