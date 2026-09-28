// The Action Queue: the system proposes, a person approves or rejects.
// Version 1 never changes Google Ads. Each proposal carries the Google Ads API
// operation it would become (`operation`), so a later version can apply
// approved actions through the API without changing how decisions are made.
import { normText, stableId } from './util.js';

export const DEFAULT_ACTION_SETTINGS = Object.freeze({
  windowDays: 90,       // decisions for the queue use the last N days of data
  lowerBidPct: 20,      // REDUCE keyword -> lower its max CPC by this %
  raiseBidPct: 15,      // SCALE keyword -> raise max CPC / budget by this %
  cityPausePct: 50,     // PAUSE city inside the buy box -> lower bids this much
  cityBidDownPct: 30,   // REDUCE city -> location bid adjustment
  cityBidUpPct: 20,     // SCALE city -> location bid adjustment
  minSpendForAction: 150,
});

export const ACTION_TYPES = Object.freeze({
  pause_keyword: { label: 'Pause keyword', verb: 'PAUSE' },
  lower_bid: { label: 'Lower keyword bid', verb: 'REDUCE' },
  raise_bid: { label: 'Raise keyword bid or budget', verb: 'SCALE' },
  exclude_location: { label: 'Exclude city from campaign', verb: 'PAUSE' },
  location_bid: { label: 'Change city bid adjustment', verb: 'ADJUST' },
  add_negative: { label: 'Add negative keyword', verb: 'NEGATIVE' },
  change_landing_page: { label: 'Change landing page', verb: 'FIX' },
  fix_landing_page: { label: 'Build or fix a landing page', verb: 'FIX' },
});

export const ACTION_STATUSES = Object.freeze({
  proposed: 'Waiting for approval',
  approved: 'Approved',
  rejected: 'Rejected',
  done: 'Done in Google Ads',
});

const CUSTOMER = 'customers/{customerId}';

/** Real Google Ads criterion id, or null when the keyword came from a CSV (no id). */
function criterionOf(keyword) {
  const m = /^(\d+)~(\d+)$/.exec(String(keyword?.id || ''));
  return m ? { adGroupId: m[1], criterionId: m[2] } : null;
}
const isNumericId = (id) => /^\d+$/.test(String(id || ''));

function geoIdFor(model, city, st) {
  const want = normText(city);
  for (const [id, g] of Object.entries(model.dataset.ads?.geoConstants || {})) {
    if (normText(g.name) === want && (!st || !g.canonicalName || /california/i.test(g.canonicalName) === (st === 'CA'))) return id;
  }
  return null;
}

function keywordOperations(keywords, change) {
  const ops = [];
  for (const k of keywords) {
    const c = criterionOf(k);
    if (!c) return null;
    const resourceName = `${CUSTOMER}/adGroupCriteria/${c.adGroupId}~${c.criterionId}`;
    if (change.kind === 'status') ops.push({ service: 'AdGroupCriterionService', update: { resourceName, status: change.value }, updateMask: 'status' });
    else if (change.kind === 'bid_pct') ops.push({ service: 'AdGroupCriterionService', update: { resourceName, cpcBidMicros: `current × ${1 + change.value / 100}` }, updateMask: 'cpc_bid_micros', needsCurrentValue: true });
    else if (change.kind === 'final_url') ops.push({ service: 'AdGroupCriterionService', update: { resourceName, finalUrls: [change.value] }, updateMask: 'final_urls' });
  }
  return ops;
}

/**
 * Build proposals from the decision-window rows.
 * @param model
 * @param p { keywordRows, campaignCityRows, searchTerms, landing, window: {start, end}, settings }
 */
export function proposeActions(model, { keywordRows = [], campaignCityRows = [], searchTerms = null, landing = [], window = {}, settings = {} } = {}) {
  const s = { ...DEFAULT_ACTION_SETTINGS, ...(model.settings.actions || {}), ...settings };
  const actions = [];
  const windowLabel = window.start ? `${window.start} to ${window.end}` : 'all data';
  const add = (a) => actions.push({
    status: 'proposed', window: { ...window, label: windowLabel }, ...a,
    typeLabel: ACTION_TYPES[a.type].label,
    apiReady: !!a.operation,
  });

  // Keyword-level: pause / lower / raise.
  for (const k of keywordRows) {
    if (!k.keyword || k.keyword.startsWith('(')) continue;
    const rec = k.decision.rec;
    if (rec === 'WATCH' || k.metrics.spend < s.minSpendForAction) continue;
    const keywords = k.keywordIds.map((id) => model.keywordsById.get(id)).filter(Boolean);
    const target = {
      campaignId: k.campaignId, campaignName: k.campaignName, keyword: k.keyword,
      criteria: keywords.map((kw) => ({ id: kw.id, adGroupId: kw.adGroupId, adGroupName: model.adGroupsById.get(kw.adGroupId)?.name || '', matchType: kw.matchType })),
    };
    let type;
    let change;
    let summary;
    if (rec === 'PAUSE') {
      type = 'pause_keyword'; change = { kind: 'status', value: 'PAUSED' };
      summary = `Pause "${k.keyword}" in ${k.campaignName}`;
    } else if (rec === 'REDUCE') {
      type = 'lower_bid'; change = { kind: 'bid_pct', value: -s.lowerBidPct };
      summary = `Lower the bid on "${k.keyword}" by ${s.lowerBidPct}% in ${k.campaignName}`;
    } else {
      type = 'raise_bid'; change = { kind: 'bid_pct', value: s.raiseBidPct };
      summary = `Raise the bid (or budget) on "${k.keyword}" by ${s.raiseBidPct}% in ${k.campaignName}`;
    }
    const ops = keywordOperations(keywords, change);
    add({
      id: stableId('act', type, k.campaignId, k.keyword), type, rec, summary, target, change,
      reason: k.decision.reason, headline: k.decision.headline, facts: k.decision.facts, confidence: k.decision.confidence,
      spend: k.metrics.spend, source: 'keyword',
      operation: ops && ops.length ? ops : null,
      manualNote: ops ? '' : 'This keyword came from a CSV import without Google Ads ids; make the change by hand or re-sync through the API.',
    });
  }

  // City-level (per campaign). Cities outside the buy box are excluded;
  // cities inside it get bid adjustments (a full exclusion inside the buy
  // box is a bigger call than the data usually supports).
  for (const c of campaignCityRows) {
    if (!c.city || c.metrics.spend < s.minSpendForAction) continue;
    const rec = c.decision.rec;
    const outside = c.inBuyBox === false;
    if (!outside && rec === 'WATCH') continue;
    const geoId = geoIdFor(model, c.city, c.st);
    const campaignRes = isNumericId(c.campaignId) ? `${CUSTOMER}/campaigns/${c.campaignId}` : null;
    let type;
    let change;
    let summary;
    let op = null;
    if (outside) {
      type = 'exclude_location'; change = { kind: 'exclude', value: true };
      summary = `Stop showing ${c.campaignName} ads in ${c.city} (outside the buy box)`;
      if (campaignRes && geoId) op = [{ service: 'CampaignCriterionService', create: { campaign: campaignRes, negative: true, location: { geoTargetConstant: `geoTargetConstants/${geoId}` } } }];
    } else {
      const pct = rec === 'PAUSE' ? -s.cityPausePct : rec === 'REDUCE' ? -s.cityBidDownPct : s.cityBidUpPct;
      type = 'location_bid'; change = { kind: 'bid_modifier', value: pct };
      summary = `${pct < 0 ? 'Lower' : 'Raise'} bids in ${c.city} by ${Math.abs(pct)}% for ${c.campaignName}`;
      if (campaignRes && geoId) op = [{ service: 'CampaignCriterionService', create: { campaign: campaignRes, location: { geoTargetConstant: `geoTargetConstants/${geoId}` }, bidModifier: 1 + pct / 100 }, note: 'update instead if the city is already targeted' }];
    }
    add({
      id: stableId('act', type, c.campaignId, c.city, c.st), type, rec: outside ? 'PAUSE' : rec, summary,
      target: { campaignId: c.campaignId, campaignName: c.campaignName, city: c.city, st: c.st, geoTargetConstant: geoId },
      change, reason: c.decision.reason, headline: outside ? 'Outside buy box' : c.decision.headline, facts: c.decision.facts, confidence: c.decision.confidence,
      spend: c.metrics.spend, source: 'city', operation: op,
      manualNote: op ? '' : 'City id or campaign id not known yet (needs a Google Ads API sync); make the change by hand.',
    });
  }

  // Search terms -> negative keywords (never added automatically). One action
  // per campaign + negative, however many searches it would block.
  const negatives = new Map();
  for (const f of searchTerms?.findings || []) {
    if (f.suggestion.action !== 'add_negative') continue;
    const key = `${f.campaignId}|${f.suggestion.negative}|${f.suggestion.matchType}`;
    let n = negatives.get(key);
    if (!n) negatives.set(key, (n = { f, terms: [], spend: 0, clicks: 0, high: false }));
    n.terms.push(f.term);
    n.spend += f.spend;
    n.clicks += f.clicks;
    n.high = n.high || f.severity === 'high';
  }
  for (const { f, terms, spend, clicks, high } of negatives.values()) {
    const campaignRes = isNumericId(f.campaignId) ? `${CUSTOMER}/campaigns/${f.campaignId}` : null;
    const shown = terms.slice(0, 3).map((t) => `"${t}"`).join(', ');
    add({
      id: stableId('act', 'add_negative', f.campaignId, f.suggestion.negative, f.suggestion.matchType), type: 'add_negative', rec: 'PAUSE',
      summary: `Add "${f.suggestion.negative}" as a ${f.suggestion.matchType.toLowerCase()} negative keyword in ${f.campaignName || 'the campaign'}`,
      target: { campaignId: f.campaignId, campaignName: f.campaignName, terms, negative: f.suggestion.negative, matchType: f.suggestion.matchType },
      change: { kind: 'negative', value: f.suggestion.negative },
      reason: `$${Math.round(spend)} spent on ${terms.length} search${terms.length === 1 ? '' : 'es'} like ${shown}${terms.length > 3 ? '…' : ''}. ${f.flags[0].label}: ${f.flags[0].detail}`,
      headline: f.flags[0].label,
      facts: [{ label: 'Spent', value: `$${Math.round(spend)}` }, { label: 'Clicks', value: String(Math.round(clicks)) }, { label: 'Searches', value: String(terms.length) }],
      confidence: high ? 'high' : 'medium', spend, source: 'search_term',
      operation: campaignRes ? [{ service: 'CampaignCriterionService', create: { campaign: campaignRes, negative: true, keyword: { text: f.suggestion.negative, matchType: f.suggestion.matchType } } }] : null,
      manualNote: campaignRes ? '' : 'Campaign id not known yet (CSV import); add the negative by hand.',
    });
  }

  // Landing pages.
  for (const l of landing) {
    // Outside the buy box the keyword itself is the problem (see its pause).
    if (l.match !== 'poor' || l.outsideBuyBox || l.spend < s.minSpendForAction) continue;
    const keywords = model.keywordsById ? [...model.keywordsById.values()].filter((k) => normText(k.text) === l.keyword && (!l.key || l.key.startsWith(`${k.campaignId}|`))) : [];
    if (l.betterPage) {
      const ops = keywordOperations(keywords, { kind: 'final_url', value: l.betterPage });
      add({
        id: stableId('act', 'change_landing_page', l.key, l.betterPage), type: 'change_landing_page', rec: 'REDUCE',
        summary: `Send "${l.keyword}" to ${l.betterPage} instead of ${l.path}`,
        target: { campaignId: l.key.split('|')[0], campaignName: l.campaignName, keyword: l.keyword, from: l.path, to: l.betterPage },
        change: { kind: 'final_url', value: l.betterPage }, reason: l.issues.join(' '), headline: 'Poor page match',
        facts: [{ label: 'Spent', value: `$${Math.round(l.spend)}` }, { label: 'Leads', value: String(l.leads) }],
        confidence: 'medium', spend: l.spend, source: 'landing', operation: ops && ops.length ? ops : null,
        manualNote: ops && ops.length ? '' : 'Change the final URL by hand in Google Ads.',
      });
    } else {
      add({
        id: stableId('act', 'fix_landing_page', l.key), type: 'fix_landing_page', rec: 'REDUCE',
        summary: `Build a page for "${l.keyword}": ${l.wantHeadline}`,
        target: { campaignId: l.key.split('|')[0], campaignName: l.campaignName, keyword: l.keyword, from: l.path },
        change: { kind: 'page', value: l.wantHeadline }, reason: l.issues.join(' '), headline: 'Poor page match',
        facts: [{ label: 'Spent', value: `$${Math.round(l.spend)}` }, { label: 'Leads', value: String(l.leads) }],
        confidence: 'medium', spend: l.spend, source: 'landing', operation: null, manualNote: 'Website work: no Google Ads change.',
      });
    }
  }

  const order = { pause_keyword: 0, add_negative: 1, exclude_location: 2, lower_bid: 3, location_bid: 4, change_landing_page: 5, fix_landing_page: 6, raise_bid: 7 };
  actions.sort((a, b) => order[a.type] - order[b.type] || b.spend - a.spend);
  return actions;
}

/**
 * Join proposals with stored decisions (db docs keyed by action id).
 * A stored decision whose action is no longer proposed stays visible, marked
 * `stillRecommended: false`, so nothing a person approved disappears.
 */
export function mergeActionState(proposals, decisions = {}) {
  const byId = new Map(proposals.map((a) => [a.id, { ...a, stillRecommended: true }]));
  for (const [id, d] of Object.entries(decisions)) {
    if (!d) continue;
    const current = byId.get(id);
    if (current) byId.set(id, { ...current, status: d.status, decidedBy: d.by, decidedAt: d.at, note: d.note || '' });
    else if (d.snapshot) byId.set(id, { ...d.snapshot, id, status: d.status, decidedBy: d.by, decidedAt: d.at, note: d.note || '', stillRecommended: false });
  }
  return [...byId.values()];
}

/** Document stored when a person approves/rejects (snapshot keeps the evidence). */
export function decisionRecord(action, status, userId, note = '') {
  if (!ACTION_STATUSES[status] || status === 'proposed') throw new Error(`Invalid decision status: ${status}`);
  const { stillRecommended, decidedBy, decidedAt, ...snapshot } = action;
  return { status, by: userId || '', at: new Date().toISOString(), note: String(note).slice(0, 500), snapshot: { ...snapshot, status: 'proposed' } };
}
