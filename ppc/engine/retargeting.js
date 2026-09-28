// Retargeting analyzer. Works from page-level visitor totals (GA4), never
// from individual people: the output is audience definitions, estimated sizes
// and what to do with them. Sizes are estimates from aggregated numbers.
//
// Consent: GA4 audiences only include visitors who allowed tracking under
// Consent Mode, so the audiences recommended here inherit the site's consent
// settings. When a consent rate is known it is applied to the size estimate.
import { intentOf } from './situations.js';
import { normText } from './util.js';

export const MIN_LIST_SIZE = Object.freeze({ search: 1000, display: 100 });

const SELLER_PATH = /(sell|cash|offer|we-?buy|buy-?my|house-?buyer|home-?buyer|get-?offer|inherit|probate|as-?is|repair|divorce|foreclos|landlord|tenant|vacant|relocat|condition|fixer)/i;

/** Classify a page path (and optional title) for audiences. */
export function pageIntent(path, title = '', situations) {
  const text = `${String(path).replace(/[-_/]+/g, ' ')} ${title}`;
  const intent = intentOf(text, situations);
  const seller = SELLER_PATH.test(path) || intent !== 'general';
  return { intent, seller };
}

function eligibility(size) {
  if (size >= MIN_LIST_SIZE.search) return { level: 'search_display', label: 'Big enough for Search and Display' };
  if (size >= MIN_LIST_SIZE.display) return { level: 'display', label: 'Display / YouTube only (Search needs 1,000)' };
  return { level: 'too_small', label: 'Too small to use yet (Display needs 100)' };
}

export function analyzeRetargeting(dataset, { situations, consentRate } = {}) {
  const pages = dataset.web?.pagePaths || [];
  const pageMeta = new Map((dataset.web?.pages || []).map((p) => [normText(p.path), p]));
  const rate = consentRate ?? dataset.web?.consent?.adsRate ?? null;
  const sums = {
    seller: { users: 0, converters: 0, returning: 0, ppc: 0 },
    inherited: { users: 0, converters: 0 },
    asIs: { users: 0, converters: 0 },
    problem: { users: 0, converters: 0 },
    forms: { starts: 0, submits: 0 },
  };
  for (const p of pages) {
    const meta = pageMeta.get(normText(p.path));
    const { intent, seller } = pageIntent(p.path, meta?.title || meta?.h1 || '', situations);
    const converters = Math.min(p.users || 0, Math.round(p.keyEvents || 0));
    if (seller) {
      sums.seller.users += p.users || 0;
      sums.seller.converters += converters;
      sums.seller.returning += p.returningUsers || 0;
      sums.seller.ppc += p.ppcUsers || 0;
    }
    if (intent === 'inherited_probate') { sums.inherited.users += p.users || 0; sums.inherited.converters += converters; }
    if (intent === 'major_repairs') { sums.asIs.users += p.users || 0; sums.asIs.converters += converters; }
    if (['major_repairs', 'code_title', 'vacant'].includes(intent)) { sums.problem.users += p.users || 0; sums.problem.converters += converters; }
    sums.forms.starts += p.formStarts || 0;
    sums.forms.submits += p.formSubmits || 0;
  }
  const adjust = (n) => Math.max(0, Math.round(rate != null ? n * rate : n));
  const sellerNonConv = Math.max(0, sums.seller.users - sums.seller.converters);
  const repeatNonConv = Math.max(0, sums.seller.returning - Math.round(sums.seller.converters * (sums.seller.users ? sums.seller.returning / sums.seller.users : 0)));
  const segments = [
    {
      code: 'high_intent', name: 'High-intent non-converters', estimate: adjust(sellerNonConv),
      who: 'Visited a seller page (sell, cash offer, inherited, as-is, repairs...) and did not submit a form or call.',
      ga4: 'Include: page_view where page_path matches seller pages. Exclude: users with generate_lead / form_submit / call key event. Membership 30 days.',
      use: 'Display and YouTube reminder ads; Search bid boost once the list reaches 1,000.',
      ppcShare: sums.seller.users ? sums.seller.ppc / sums.seller.users : null,
    },
    {
      code: 'abandoned_form', name: 'Started the form, did not finish', estimate: adjust(Math.max(0, sums.forms.starts - sums.forms.submits)),
      who: 'Triggered form_start but no form_submit / generate_lead.',
      ga4: 'Include: event form_start. Exclude: event generate_lead (or form_submit). Membership 14 days.',
      use: 'Highest-value list: short-window reminder ads ("Finish your free offer request").',
    },
    {
      code: 'inherited', name: 'Inherited-property visitors', estimate: adjust(Math.max(0, sums.inherited.users - sums.inherited.converters)),
      who: 'Viewed inherited / probate pages and did not convert.',
      ga4: 'Include: page_path contains inherit OR probate. Exclude: converters. Membership 60 days (probate decisions take longer).',
      use: 'Inherited-house ads that link to the inherited landing page.',
    },
    {
      code: 'as_is', name: 'Sell-as-is visitors', estimate: adjust(Math.max(0, sums.asIs.users - sums.asIs.converters)),
      who: 'Viewed sell-as-is / repairs pages and did not convert.',
      ga4: 'Include: page_path contains as-is OR repair OR fixer. Exclude: converters. Membership 30 days.',
      use: '"No repairs, no cleaning" ads linking to the as-is page.',
    },
    {
      code: 'problem_property', name: 'Repair / problem-property visitors', estimate: adjust(Math.max(0, sums.problem.users - sums.problem.converters)),
      who: 'Viewed repair, code-violation, title-problem or vacant-property pages.',
      ga4: 'Include: page_path matches repair|violation|permit|title|vacant. Exclude: converters. Membership 30 days.',
      use: 'Problem-property ads; pairs well with the as-is list.',
    },
    {
      code: 'repeat', name: 'Repeat visitors, no conversion', estimate: adjust(repeatNonConv),
      who: 'Came back to the site at least twice and still did not convert.',
      ga4: 'Include: session_count ≥ 2 (or "Returning" users) on seller pages. Exclude: converters. Membership 30 days.',
      use: 'Reminder ads with reviews and "how it works"; they are comparing options.',
    },
  ].map((s) => ({ ...s, eligibility: eligibility(s.estimate) }));
  return {
    segments,
    consentRate: rate,
    consentNote: rate != null
      ? `Sizes are reduced to the ${Math.round(rate * 100)}% of visitors who allowed ad tracking.`
      : 'Consent rate unknown. GA4 audiences only include visitors who allowed tracking, so real lists may be smaller.',
    basis: pages.length ? `Estimated from GA4 page totals for ${pages.length} page(s). No individual visitor data is used.` : 'No GA4 page data loaded yet.',
    hasData: pages.length > 0,
  };
}
