// Search term waste detector. Recommendations only: nothing here changes
// Google Ads. Each finding says what looks wrong, why, and which negative
// keyword (if any) to consider, for a person to approve in the Action Queue.
import { geoIndex } from './geo.js';
import { inRange, normText, safeDiv, stableId } from './util.js';

export const DEFAULT_WASTE_SETTINGS = Object.freeze({
  minSpend: 50,            // ignore search terms below this spend in the period
  highSpendNoLead: 250,    // spend with zero Google-reported conversions -> flag
  expensiveTerm: 400,      // spend that should show results further down the funnel
  lowQualityRate: 0.2,     // keyword qualified-lead rate below this is "low quality"
  minLeadsForQuality: 3,   // ...once the keyword has at least this many leads
});

// Words that show a seller searching (keep these even if a theme word appears:
// "sell rental property fast" is a tired landlord, not a renter).
const SELLER_INTENT = ['sell', 'selling', 'sold', 'we buy', 'buy my', 'buys houses', 'buy houses', 'home buyer', 'house buyer',
  'cash for', 'cash offer', 'cash buyer', 'offer on my', 'get rid of', 'unload'];

export const WASTE_THEMES = Object.freeze([
  { code: 'jobs', label: 'Job seekers', severity: 'high', words: ['job', 'jobs', 'career', 'careers', 'hiring', 'salary', 'employment', 'internship'] },
  { code: 'renters', label: 'Renters', severity: 'high', words: ['for rent', 'rent', 'rentals', 'apartment', 'apartments', 'lease', 'renting', 'room for rent'] },
  { code: 'home_shoppers', label: 'Home buyers (not sellers)', severity: 'high',
    words: ['homes for sale', 'house for sale', 'houses for sale', 'buy a house', 'buy a home', 'buying a house', 'zillow', 'redfin', 'trulia', 'realtor com', 'mls', 'open house', 'first time home buyer', 'foreclosed homes for sale'] },
  { code: 'education', label: 'Investor courses / licenses', severity: 'high',
    words: ['real estate license', 'license', 'course', 'courses', 'class', 'classes', 'training', 'school', 'how to wholesale', 'wholesaling', 'flip houses', 'house flipping', 'become a realtor', 'seminar', 'mentor'] },
  { code: 'diy', label: 'Research / do-it-yourself', severity: 'medium', words: ['how to', 'diy', 'what is', 'meaning', 'definition', 'template', 'pdf', 'reddit', 'youtube', 'calculator'] },
  { code: 'finance', label: 'Loans / mortgages', severity: 'high', words: ['mortgage', 'refinance', 'refi', 'heloc', 'loan', 'loans', 'interest rate', 'rates today'] },
  { code: 'free', label: '"Free" searches', severity: 'medium', words: ['free'] },
  { code: 'price_check', label: 'Price checkers', severity: 'low', words: ['what is my house worth', 'home value', 'house value', 'zestimate', 'appraisal', 'estimate my home'] },
]);

function wordMatch(term, word) {
  return new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(term);
}

/** Which theme (if any) makes this term irrelevant? Returns {theme, word} or null. */
export function irrelevantTheme(term, { outOfArea = [] } = {}) {
  const t = normText(term);
  const seller = SELLER_INTENT.some((w) => t.includes(w));
  for (const city of outOfArea) {
    if (city && wordMatch(t, city)) return { theme: { code: 'out_of_area', label: 'Outside the buy box', severity: 'high' }, word: city };
  }
  for (const theme of WASTE_THEMES) {
    const word = theme.words.find((w) => wordMatch(t, w));
    if (!word) continue;
    if (seller && theme.code !== 'education' && theme.code !== 'jobs') continue;
    return { theme, word };
  }
  return null;
}

/**
 * @param model   from buildModel
 * @param filters date range etc. (campaign filter applies)
 * @param keywordRows rollUp(model, table.rows, 'keyword') — for downstream quality
 */
export function analyzeSearchTerms(model, filters = {}, keywordRows = [], settings = {}) {
  const s = { ...DEFAULT_WASTE_SETTINGS, ...(model.settings.waste || {}), ...settings };
  const geo = model.geo || geoIndex();
  const outOfArea = geo.outOfAreaNames();
  const byKeywordText = new Map(keywordRows.map((r) => [`${r.campaignId}|${r.keyword}`, r]));

  // Sum the period per term + keyword.
  const terms = new Map();
  for (const r of model.dataset.ads?.searchTermsDaily || []) {
    if (!inRange(r.d, filters.start, filters.end)) continue;
    const kw = model.keywordsById.get(r.k);
    const campaignId = r.c || kw?.campaignId || '';
    if (filters.campaigns?.length && !filters.campaigns.includes(campaignId)) continue;
    const key = `${normText(r.term)}|${r.k || ''}`;
    let t = terms.get(key);
    if (!t) {
      t = { term: normText(r.term), keywordId: r.k || '', keywordText: kw ? normText(kw.text) : '', campaignId, spend: 0, clicks: 0, impressions: 0, conversions: 0 };
      terms.set(key, t);
    }
    t.spend += r.cost || 0;
    t.clicks += r.clk || 0;
    t.impressions += r.imp || 0;
    t.conversions += r.conv || 0;
  }

  const findings = [];
  for (const t of terms.values()) {
    if (t.spend < s.minSpend) continue;
    const flags = [];
    const hit = irrelevantTheme(t.term, { outOfArea });
    if (hit) flags.push({ code: hit.theme.code, label: hit.theme.label, severity: hit.theme.severity, detail: `Contains "${hit.word}".` });
    if (t.conversions === 0 && t.spend >= s.highSpendNoLead) {
      flags.push({ code: 'spend_no_leads', label: 'High spend, no leads', severity: 'high', detail: `$${Math.round(t.spend)} spent, 0 Google-reported conversions.` });
    }
    const parent = byKeywordText.get(`${t.campaignId}|${t.keywordText}`);
    if (parent) {
      const pm = parent.metrics;
      const rate = safeDiv(pm.qualified, pm.leads);
      if (t.conversions > 0 && pm.leads >= s.minLeadsForQuality && rate != null && rate < s.lowQualityRate) {
        flags.push({ code: 'low_quality', label: 'Leads mostly unqualified', severity: 'medium',
          detail: `Its keyword "${t.keywordText}" has ${pm.qualified} qualified of ${pm.leads} leads (inferred from the keyword, not this exact search).` });
      }
      if (t.spend >= s.expensiveTerm && t.conversions > 0 && pm.qualified === 0 && pm.appointments === 0) {
        flags.push({ code: 'no_downstream', label: 'Expensive, nothing downstream', severity: 'medium',
          detail: `$${Math.round(t.spend)} spent; its keyword has no qualified leads or appointments yet.` });
      }
    }
    if (!flags.length) continue;
    const severityRank = { high: 3, medium: 2, low: 1 };
    flags.sort((a, b) => severityRank[b.severity] - severityRank[a.severity]);
    const top = flags[0];
    let suggestion;
    if (hit && hit.theme.severity !== 'low') {
      suggestion = { action: 'add_negative', negative: hit.word, matchType: 'PHRASE', level: 'campaign' };
    } else if (flags.some((f) => f.code === 'spend_no_leads')) {
      suggestion = { action: 'add_negative', negative: t.term, matchType: 'EXACT', level: 'campaign' };
    } else {
      suggestion = { action: 'review', negative: '', matchType: '', level: '' };
    }
    const campaignName = model.campaignsById.get(t.campaignId)?.name || '';
    findings.push({
      id: stableId('st', t.campaignId, t.term, t.keywordId),
      ...t, campaignName, cpc: safeDiv(t.spend, t.clicks), flags, severity: top.severity, suggestion,
      reason: `${top.label}: ${top.detail}`,
    });
  }
  const rank = { high: 3, medium: 2, low: 1 };
  findings.sort((a, b) => rank[b.severity] - rank[a.severity] || b.spend - a.spend);
  const wasteSpend = findings.filter((f) => f.severity === 'high').reduce((acc, f) => acc + f.spend, 0);
  return { findings, wasteSpend, termCount: terms.size };
}
