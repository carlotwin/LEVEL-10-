#!/usr/bin/env node
// Generates the DEMO dataset: 90 days of made-up but realistic Google Ads,
// REI BlackBook, GA4 and call-tracking data for a Bay Area cash home buyer.
//
// Everything here is fictional: seller names are "Demo Seller ####", phone
// numbers are in the 555-01XX range reserved for fiction, emails use
// example.com, GCLIDs start with "DEMO". The data goes through the same
// importers real data uses (GAQL rows -> normalizeGaql, REI export rows ->
// normalizeReiRows, call log CSV -> parseCallsCsv), so the demo exercises the
// real code paths.
//
//   node ppc/scripts/generate-demo.mjs            writes ppc/demo/*
//   node ppc/scripts/generate-demo.mjs --check    prints the story, writes nothing
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addDays, daysBetween, emptyDataset, markDuplicates, normalizeGaql, normalizeReiRows, parseCallsCsv, recordSync, round, summarizeDataset, toCsv,
  validateDataset,
} from '../engine/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../demo');
const CHECK = process.argv.includes('--check');

// ---------------------------------------------------------------- seeded random
let seed = 20260928;
function rand() {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const chance = (p) => rand() < p;
const pick = (list) => list[Math.floor(rand() * list.length)];
const between = (lo, hi) => lo + (hi - lo) * rand();
function poisson(lambda) {
  let L = Math.exp(-lambda); let k = 0; let p = 1;
  do { k += 1; p *= rand(); } while (p > L);
  return k - 1;
}
function weighted(entries) {
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let r = rand() * total;
  for (const [v, w] of entries) { r -= w; if (r <= 0) return v; }
  return entries[entries.length - 1][0];
}

// ---------------------------------------------------------------- calendar
const END = '2026-09-27';
const DAYS = 90;
const START = addDays(END, -(DAYS - 1));
const dates = [...Array(DAYS)].map((_, i) => addDays(START, i));
const weekday = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();

// ---------------------------------------------------------------- geography
// Demo geo target ids (NOT real Google ids).
const CITIES = {
  'San Jose': { id: '9100001', area: '408', w: 26 }, 'San Francisco': { id: '9100002', area: '415', w: 18 },
  Oakland: { id: '9100003', area: '510', w: 16 }, Fremont: { id: '9100004', area: '510', w: 7 },
  Hayward: { id: '9100005', area: '510', w: 6 }, Concord: { id: '9100006', area: '925', w: 4 },
  Richmond: { id: '9100007', area: '510', w: 4 }, Vallejo: { id: '9100008', area: '707', w: 4 },
  'Santa Rosa': { id: '9100009', area: '707', w: 3 }, 'San Mateo': { id: '9100010', area: '650', w: 3 },
  Antioch: { id: '9100011', area: '925', w: 4 }, Sunnyvale: { id: '9100012', area: '408', w: 3 },
  Stockton: { id: '9100013', area: '209', w: 0 }, Sacramento: { id: '9100014', area: '916', w: 0 },
  Fresno: { id: '9100015', area: '559', w: 0 }, Modesto: { id: '9100016', area: '209', w: 0 },
};
const OUT_OF_AREA = new Set(['Stockton', 'Sacramento', 'Fresno', 'Modesto']);
const BAY_WEIGHTS = Object.entries(CITIES).filter(([c]) => !OUT_OF_AREA.has(c)).map(([c, v]) => [c, v.w]);
// Bay Area campaigns also get some clicks from people in the Central Valley.
const BAY_WITH_SPILL = [...BAY_WEIGHTS, ['Stockton', 3], ['Sacramento', 2]];
const VALLEY = [['Stockton', 45], ['Sacramento', 30], ['Fresno', 15], ['Modesto', 10]];
const ZIPS = { 'San Jose': '95123', 'San Francisco': '94112', Oakland: '94605', Fremont: '94538', Hayward: '94544', Concord: '94520', Richmond: '94804', Vallejo: '94591', 'Santa Rosa': '95407', 'San Mateo': '94403', Antioch: '94509', Sunnyvale: '94087', Stockton: '95206', Sacramento: '95823', Fresno: '93702', Modesto: '95351' };

// ---------------------------------------------------------------- account
const SITE = 'https://www.twinhomebuyer.com';
const CAMPAIGNS = [
  { id: '21000001', name: 'Search - Bay Area - Sell Fast', geo: BAY_WITH_SPILL },
  { id: '21000002', name: 'Search - Bay Area - Seller Situations', geo: BAY_WITH_SPILL },
  { id: '21000003', name: 'Search - Central Valley (test)', geo: VALLEY },
];
// q = chance a lead qualifies (before city effects); lr = lead rate per click.
const AD_GROUPS = [
  { id: '31000001', c: 0, name: 'We Buy Houses', url: '/', q: 0.28, lr: 0.085,
    kws: [['we buy houses', 'PHRASE', 64, 1.1], ['we buy houses near me', 'PHRASE', 52, 0.3], ['cash home buyers', 'PHRASE', 48, 0.35], ['sell my house fast', 'PHRASE', 58, 0.9], ['sell house fast for cash', 'EXACT', 55, 0.2]],
    terms: ['we buy houses jobs', 'houses for rent oakland', 'how to wholesale houses bay area', 'real estate license san jose'] },
  { id: '31000002', c: 0, name: 'Sell As-Is / Repairs', url: '/sell-house-as-is', q: 0.42, lr: 0.11,
    kws: [['sell house as is', 'PHRASE', 42, 0.5], ['sell house that needs repairs', 'PHRASE', 38, 0.3], ['sell fixer upper house', 'PHRASE', 35, 0.15]],
    terms: ['diy home repair costs', 'fixer upper homes for sale'] },
  { id: '31000003', c: 0, name: 'Cash Offer', url: '/', q: 0.3, lr: 0.09,
    kws: [['cash offer for my house', 'PHRASE', 50, 0.45], ['get a cash offer on my house', 'EXACT', 47, 0.15]],
    terms: ['free home value estimate'] },
  { id: '31000004', c: 1, name: 'Inherited / Probate', url: '/sell-inherited-house', q: 0.55, lr: 0.14,
    kws: [['sell inherited house', 'PHRASE', 36, 0.6], ['sell inherited house san francisco', 'EXACT', 44, 0.25], ['probate house buyers', 'PHRASE', 33, 0.15], ['sell house in probate', 'PHRASE', 34, 0.2]],
    terms: ['probate attorney near me', 'inheritance tax california'] },
  { id: '31000005', c: 1, name: 'Tired Landlord', url: '/sell-rental-property', q: 0.45, lr: 0.1,
    kws: [['sell rental property with tenants', 'PHRASE', 31, 0.25], ['tired landlord sell house', 'PHRASE', 29, 0.15]],
    terms: ['rentals near me'] },
  { id: '31000006', c: 1, name: 'Foreclosure', url: '/stop-foreclosure', q: 0.35, lr: 0.12,
    kws: [['sell house before foreclosure', 'PHRASE', 39, 0.3], ['behind on mortgage sell house', 'PHRASE', 36, 0.2]],
    terms: ['mortgage relief programs', 'refinance behind on payments'] },
  { id: '31000007', c: 1, name: 'Divorce', url: '/sell-house-divorce', q: 0.4, lr: 0.1,
    kws: [['sell house during divorce', 'PHRASE', 37, 0.18]], terms: [] },
  { id: '31000008', c: 2, name: 'We Buy Houses - Valley', url: '/', q: 0.0, lr: 0.12,
    kws: [['we buy houses stockton', 'PHRASE', 46, 0.4], ['sell my house fast sacramento', 'PHRASE', 41, 0.25], ['cash home buyers fresno', 'PHRASE', 38, 0.3]],
    terms: ['stockton jobs hiring', 'houses for rent stockton'] },
];
// Seller situation implied by an ad group (used for lead motivation text).
const GROUP_SITUATION = {
  '31000002': ['Needs a new roof and foundation work, wants to sell as is', 'Fire damage in kitchen, needs repairs'],
  '31000004': ['Inherited from father, probate almost done', 'Heirs want to sell, house passed away mom', 'Executor of estate, siblings want cash'],
  '31000005': ['Tenant not paying, tired landlord', 'Rental property, tenants moving out'],
  '31000006': ['Behind on payments, notice of default received', 'Foreclosure auction date set'],
  '31000007': ['Going through divorce, need to split proceeds'],
};
const GENERIC_MOTIVATION = ['Wants to sell fast, relocating for work', 'Vacant house, moved out last year', 'Needs repairs, older owner downsizing', 'Just curious about an offer', '', 'Moving to Texas, need quick sale', 'Code violation from city, unpermitted garage'];

// Stories the demo should tell at keyword + city level. For these rows the
// leads are scripted (one outcome per lead) instead of random, so the demo
// always shows each kind of recommendation:
//   PAUSE   expensive San Francisco "sell my house fast": leads never qualify
//   REDUCE  "we buy houses" in San Francisco: one qualified lead, very pricey
//   SCALE   inherited-house searches in San Jose and SF (closed deals with
//           profit) and "sell house as is" in Oakland (contract this week)
//   PAUSE   (keyword) "cash offer for my house": clicks, no leads at all
//   profit missing on one closed deal (engine must not call it profitable)
const FORCED = {
  'sell inherited house|San Jose': ['closed:52000:38500', 'appointment', 'qualified', 'lost'],
  'sell inherited house san francisco|San Francisco': ['closed:61000:44000', 'qualified', 'lost'],
  'sell house as is|Oakland': ['contract-recent', 'appointment', 'qualified', 'lost'],
  'sell my house fast|San Francisco': ['lost', 'lost', 'lost', 'lost'],
  'we buy houses|San Francisco': ['qualified', 'lost', 'lost', 'lost'],
  'we buy houses|San Jose': ['appointment', 'qualified', 'lost'],
  'sell house before foreclosure|San Jose': ['closed-noprofit:48000', 'lost'],
  'cash offer for my house|*': [],
};
const forcedKey = (text, city) => (FORCED[`${text}|${city}`] ? `${text}|${city}` : FORCED[`${text}|*`] ? `${text}|*` : null);
// Some keywords draw more of their clicks from San Francisco (pricier clicks).
const SF_PULL = { 'we buy houses': 0.3, 'sell my house fast': 0.15 };

// Final URLs. The SF inherited keyword deliberately points at the generic
// home page: the landing analyzer should flag it.
const FINAL_URL = (g, text) => `${SITE}${text === 'sell inherited house san francisco' ? '/' : g.url}`;

const keywords = [];
let kwSeq = 41000001;
for (const g of AD_GROUPS) {
  for (const [text, matchType, cpc, daily] of g.kws) {
    keywords.push({ id: String(kwSeq++), text, matchType, cpc, daily, group: g, campaign: CAMPAIGNS[g.c] });
  }
}

// ---------------------------------------------------------------- clicks
const clicks = [];
let clickSeq = 1;
for (const d of dates) {
  const dayFactor = [0.7, 1.1, 1.1, 1.05, 1.0, 0.95, 0.75][weekday(d)];
  const trend = 0.85 + 0.3 * (dates.indexOf(d) / DAYS); // spend grows a little over the quarter
  // The last day: someone raised the Sell Fast budget (the spend alert should catch it).
  const spike = (kw) => (d === END && kw.campaign.id === '21000001' ? 2.6 : 1);
  for (const kw of keywords) {
    const n = poisson(kw.daily * dayFactor * trend * spike(kw));
    for (let i = 0; i < n; i++) {
      let city = weighted(kw.campaign.geo);
      // SF keyword mostly from SF.
      if (kw.text.endsWith('san francisco') && chance(0.75)) city = 'San Francisco';
      if (SF_PULL[kw.text] && chance(SF_PULL[kw.text])) city = 'San Francisco';
      if (kw.text.endsWith('stockton') && chance(0.8)) city = 'Stockton';
      if (kw.text.endsWith('sacramento') && chance(0.8)) city = 'Sacramento';
      if (kw.text.endsWith('fresno') && chance(0.85)) city = 'Fresno';
      const sfPremium = city === 'San Francisco' ? 1.25 : city === 'San Mateo' ? 1.15 : 1;
      const cost = round(kw.cpc * sfPremium * Math.exp((rand() - 0.5) * 0.6), 2);
      const waste = kw.group.terms.length && chance(kw.group.id === '31000001' ? 0.12 : 0.08);
      const term = waste ? pick(kw.group.terms) : chance(0.55) ? kw.text : `${kw.text} ${pick([city.toLowerCase(), 'near me', 'fast', 'bay area', 'for cash', city.toLowerCase()])}`;
      clicks.push({
        gclid: `DEMO${String(clickSeq++).padStart(7, '0')}`, d, kw, city, cost, term, waste,
        dev: weighted([['MOBILE', 64], ['DESKTOP', 31], ['TABLET', 5]]),
        hour: Math.floor(between(7, 22)),
      });
    }
  }
}

// ---------------------------------------------------------------- leads from clicks
// City quality: some Bay Area cities qualify better; the Central Valley never
// qualifies (outside the buy box).
const CITY_Q = { 'San Jose': 1.15, Oakland: 1.1, Richmond: 1.2, Vallejo: 1.2, Antioch: 1.15, Hayward: 1.05, Fremont: 0.9, 'San Francisco': 0.9, 'San Mateo': 0.7, Sunnyvale: 0.7, Concord: 1.0, 'Santa Rosa': 1.0 };
const reiRows = [];
const callRows = [];
let leadSeq = 1001;
let phoneSeq = 0;
const AREA_CODES = ['408', '415', '510', '650', '925', '707', '209', '916', '559'];
const phoneFor = (city) => {
  const n = phoneSeq++;
  const area = CITIES[city]?.area || AREA_CODES[n % AREA_CODES.length];
  return `(${area}) 555-01${String(n % 100).padStart(2, '0')}`;
};
const usedPhones = new Set();
const uniquePhone = (city) => {
  for (;;) {
    const p = phoneFor(city);
    if (!usedPhones.has(p)) { usedPhones.add(p); return p; }
  }
};
const fmtUs = (iso) => { const [y, m, dd] = iso.split('-'); return `${Number(m)}/${Number(dd)}/${y}`; };
const endMs = Date.parse(`${END}T23:59:59Z`);
const onOrBefore = (d) => Date.parse(`${d}T12:00:00Z`) <= endMs;
const stats = { ppcLeads: 0, qualified: 0, appointments: 0, offers: 0, contracts: 0, closed: 0 };
const googleConvByClick = new Map();

/** Scripted outcome for a story lead (see FORCED). */
function forcedFunnel(outcome, created) {
  const [kind, rev, profit] = outcome.split(':');
  const f = { status: 'Contacted', qualified: false };
  if (kind === 'lost') {
    f.status = pick(['Not Interested', 'Dead']);
    f.lost = true;
    f.lostReason = pick(['Just wanted a price check', 'Wants retail price', 'Not ready to sell', 'Listed with an agent']);
    return f;
  }
  f.qualified = true;
  f.status = 'Qualified';
  if (kind === 'qualified') return f;
  f.appointmentAt = addDays(created, 2);
  f.status = 'Appointment Set';
  if (kind === 'appointment') return f;
  if (kind === 'contract-recent') {
    f.appointmentAt = addDays(END, -15);
    f.offerAt = addDays(END, -6);
    f.offerAmount = 845000;
    f.contractAt = addDays(END, -3);
    f.status = 'Under Contract';
    return f;
  }
  // closed
  f.offerAt = addDays(created, 6);
  f.offerAmount = Math.round(between(620, 1100)) * 1000;
  f.contractAt = addDays(created, 10);
  f.closedAt = addDays(created, 38);
  f.status = 'Closed';
  f.revenue = Number(rev);
  if (kind === 'closed') f.profit = Number(profit);
  return f;
}

function funnel(qualifyChance, created, strong = false) {
  const out = { status: 'New Lead', qualified: false };
  const ageDays = (Date.parse(`${END}T12:00:00Z`) - Date.parse(`${created}T12:00:00Z`)) / 86400000;
  if (ageDays < 2) return out;
  out.status = 'Contacted';
  if (!chance(qualifyChance)) {
    out.status = pick(['Dead', 'Not Interested', 'Not Interested', 'Unqualified', 'Nurture - 6 months']);
    out.lost = out.status !== 'Nurture - 6 months';
    return out;
  }
  out.qualified = true;
  out.status = 'Qualified';
  if (ageDays < 5 || !chance(strong ? 0.8 : 0.6)) return out;
  out.appointmentAt = addDays(created, Math.floor(between(1, 5)));
  out.status = 'Appointment Set';
  if (ageDays < 9 || !chance(strong ? 0.85 : 0.72)) { if (chance(0.4)) { out.status = 'Dead'; out.lost = true; out.lostReason = pick(['Wants retail price', 'Listed with an agent', 'Went with another buyer']); } return out; }
  out.offerAt = addDays(out.appointmentAt, Math.floor(between(1, 4)));
  out.offerAmount = Math.round(between(520, 1350)) * 1000;
  out.status = 'Offer Made';
  if (ageDays < 14 || !chance(strong ? 0.55 : 0.42)) { if (chance(0.5)) { out.status = 'Dead'; out.lost = true; out.lostReason = pick(['Offer too low', 'Chose to list', 'Family decided to keep it']); } return out; }
  out.contractAt = addDays(out.offerAt, Math.floor(between(2, 9)));
  if (!onOrBefore(out.contractAt)) { delete out.contractAt; return out; }
  out.status = 'Under Contract';
  const closeOn = addDays(out.contractAt, Math.floor(between(18, 35)));
  if (onOrBefore(closeOn) && chance(0.8)) {
    out.closedAt = closeOn;
    out.status = 'Closed';
    out.revenue = Math.round(between(28, 72)) * 1000;
    out.profit = Math.round(out.revenue * between(0.62, 0.8) / 100) * 100;
  }
  return out;
}

// Pin each scripted outcome to one of the row's clicks: closed deals early
// enough to have closed, the recent contract about three weeks back.
const forcedByGclid = new Map();
for (const [key, outcomes] of Object.entries(FORCED)) {
  const [text, city] = key.split('|');
  const rowClicks = clicks.filter((c) => c.kw.text === text && (city === '*' || c.city === city) && !c.waste);
  outcomes.forEach((o, idx) => {
    const free = (list) => list.filter((c) => !forcedByGclid.has(c.gclid));
    let click;
    if (o.startsWith('closed')) click = free(rowClicks.filter((c) => c.d <= addDays(END, -45)))[idx] || null;
    else if (o === 'contract-recent') click = free([...rowClicks].sort((x, y) => Math.abs(daysBetween(x.d, addDays(END, -20))) - Math.abs(daysBetween(y.d, addDays(END, -20)))))[0];
    else {
      const pool = free(rowClicks.filter((c) => c.d <= addDays(END, -7)));
      click = pool[Math.floor(((idx + 0.5) * pool.length) / outcomes.length)];
    }
    if (click) forcedByGclid.set(click.gclid, o);
  });
}

for (const c of clicks) {
  const g = c.kw.group;
  const scripted = forcedKey(c.kw.text, c.city);
  if (scripted && !forcedByGclid.has(c.gclid)) continue;
  const leadChance = c.waste ? 0.01 : g.lr * (OUT_OF_AREA.has(c.city) && g.c !== 2 ? 0.9 : 1);
  if (!scripted && !chance(leadChance)) continue;
  const created = scripted ? c.d : chance(0.8) ? c.d : addDays(c.d, 1);
  if (!onOrBefore(created)) continue;
  const inArea = !OUT_OF_AREA.has(c.city);
  const q = inArea ? Math.min(0.92, g.q * (CITY_Q[c.city] || 1)) : 0;
  const f = scripted ? forcedFunnel(forcedByGclid.get(c.gclid), created) : funnel(q, created);
  if (!inArea && f.status !== 'New Lead') { f.status = 'Dead'; f.lost = true; f.lostReason = 'Out of area'; }
  const id = `DEMO-${leadSeq++}`;
  // How the lead reached REI decides what attribution evidence exists.
  const via = scripted ? 'form_gclid' : weighted([['form_gclid', 66], ['form_utm', 10], ['call', 16], ['label_only', 6], ['nothing', 2]]);
  const propertyCity = scripted || chance(0.88) ? c.city : pick(Object.keys(CITIES).filter((x) => !OUT_OF_AREA.has(x)));
  const phone = uniquePhone(propertyCity);
  const motivations = GROUP_SITUATION[g.id] && (scripted || chance(0.75)) ? GROUP_SITUATION[g.id] : GENERIC_MOTIVATION;
  const row = {
    'Lead ID': id, 'First Name': 'Demo', 'Last Name': `Seller ${id.slice(5)}`, Phone: phone, Email: `demo.seller${id.slice(5)}@example.com`,
    'Property Address': `${100 + (leadSeq % 800)} Demo Street`, City: chance(0.95) ? propertyCity : '', State: 'CA', Zip: ZIPS[propertyCity] || '',
    'Lead Source': via === 'nothing' ? '' : via === 'call' ? 'Phone Call' : 'Google Ads',
    GCLID: via === 'form_gclid' ? c.gclid : '',
    'UTM Source': via === 'form_utm' ? 'google' : '', 'UTM Medium': via === 'form_utm' ? 'cpc' : '',
    'UTM Campaign': via === 'form_utm' ? c.kw.campaign.name : '', 'UTM Term': via === 'form_utm' ? c.kw.text : '',
    'Landing Page': via.startsWith('form') ? FINAL_URL(g, c.kw.text) : '',
    Motivation: pick(motivations), Tags: '', 'Lead Status': f.status, Qualified: f.qualified ? 'Yes' : 'No',
    'Appointment Date': f.appointmentAt ? fmtUs(f.appointmentAt) : '', 'Offer Date': f.offerAt ? fmtUs(f.offerAt) : '',
    'Offer Amount': f.offerAmount ? `$${f.offerAmount.toLocaleString('en-US')}` : '', 'Contract Date': f.contractAt ? fmtUs(f.contractAt) : '',
    'Closed Date': f.closedAt ? fmtUs(f.closedAt) : '', 'Lost Reason': f.lostReason || '',
    Revenue: f.revenue ? `$${f.revenue.toLocaleString('en-US')}` : '', Profit: f.profit ? `$${f.profit.toLocaleString('en-US')}` : '',
    'Created Date': `${fmtUs(created)} ${String(c.hour).padStart(2, '0')}:${String(Math.floor(rand() * 60)).padStart(2, '0')}`,
    'Last Updated': fmtUs(f.closedAt || f.contractAt || f.offerAt || f.appointmentAt || created),
  };
  reiRows.push(row);
  if (via === 'call') {
    callRows.push({
      'Call ID': `DEMO-CALL-${callRows.length + 1}`, 'Start Time': `${created} ${String(c.hour).padStart(2, '0')}:10`, 'Caller Number': phone,
      'Tracking Number': '(415) 555-0142', Duration: `${Math.floor(between(1, 9))}:${String(Math.floor(rand() * 60)).padStart(2, '0')}`,
      Status: 'Answered', Source: 'Google Ads', Campaign: c.kw.campaign.name, Keyword: chance(0.6) ? c.kw.text : '', City: c.city,
    });
  }
  // Google counts the conversion when the form or call tracking fired.
  if (via !== 'nothing' && via !== 'label_only') googleConvByClick.set(c.gclid, (googleConvByClick.get(c.gclid) || 0) + 1);
  stats.ppcLeads += 1;
  if (f.qualified) stats.qualified += 1;
  if (f.appointmentAt) stats.appointments += 1;
  if (f.offerAt) stats.offers += 1;
  if (f.contractAt) stats.contracts += 1;
  if (f.closedAt) stats.closed += 1;
}
// Google also counts some spam form fills as conversions (they never reach REI).
for (const c of clicks) if (!googleConvByClick.has(c.gclid) && chance(0.012)) googleConvByClick.set(c.gclid, 1);

// A custom REI status nobody mapped yet (Data Health should point it out).
// ---------------------------------------------------------------- non-PPC leads
const OTHER_SOURCES = [['Direct Mail', 38], ['SMS - Level 10', 30], ['Referral', 8], ['Organic Website', 10], ['Cold Call', 12], ['', 5]];
const nonPpc = 110;
for (let i = 0; i < nonPpc; i++) {
  const d = pick(dates);
  const city = weighted(BAY_WEIGHTS);
  const source = weighted(OTHER_SOURCES);
  const f = funnel(source === 'Referral' ? 0.6 : 0.3, d);
  const id = `DEMO-${leadSeq++}`;
  reiRows.push({
    'Lead ID': id, 'First Name': 'Demo', 'Last Name': `Seller ${id.slice(5)}`, Phone: uniquePhone(city), Email: '',
    'Property Address': `${100 + (leadSeq % 800)} Demo Street`, City: city, State: 'CA', Zip: ZIPS[city],
    'Lead Source': source, GCLID: '', 'UTM Source': '', 'UTM Medium': '', 'UTM Campaign': '', 'UTM Term': '', 'Landing Page': '',
    Motivation: pick(GENERIC_MOTIVATION), Tags: '', 'Lead Status': f.status, Qualified: f.qualified ? 'Yes' : 'No',
    'Appointment Date': f.appointmentAt ? fmtUs(f.appointmentAt) : '', 'Offer Date': f.offerAt ? fmtUs(f.offerAt) : '',
    'Offer Amount': f.offerAmount ? `$${f.offerAmount.toLocaleString('en-US')}` : '', 'Contract Date': f.contractAt ? fmtUs(f.contractAt) : '',
    'Closed Date': f.closedAt ? fmtUs(f.closedAt) : '', 'Lost Reason': f.lostReason || '',
    Revenue: f.revenue ? `$${f.revenue.toLocaleString('en-US')}` : '', Profit: f.profit ? `$${f.profit.toLocaleString('en-US')}` : '',
    'Created Date': `${fmtUs(d)} ${String(Math.floor(between(8, 20))).padStart(2, '0')}:00`, 'Last Updated': fmtUs(d),
  });
}
// Duplicates: the same seller comes back through another channel.
const ppcRows = reiRows.filter((r) => r['Lead Source'] === 'Google Ads' && r.GCLID);
for (let i = 0; i < 6 && ppcRows.length; i++) {
  const orig = ppcRows[Math.floor(rand() * ppcRows.length)];
  const [m, dd, y] = orig['Created Date'].split(' ')[0].split('/');
  const origDate = `${y}-${m.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  const later = addDays(origDate, Math.floor(between(3, 25)));
  if (!onOrBefore(later)) continue;
  const id = `DEMO-${leadSeq++}`;
  reiRows.push({ ...orig, 'Lead ID': id, 'Last Name': `Seller ${id.slice(5)}`, 'Lead Source': pick(['Direct Mail', 'SMS - Level 10']), GCLID: '', 'Lead Status': 'New Lead', Qualified: 'No',
    'Appointment Date': '', 'Offer Date': '', 'Offer Amount': '', 'Contract Date': '', 'Closed Date': '', Revenue: '', Profit: '', 'Lost Reason': '',
    'Created Date': `${fmtUs(later)} 10:00`, 'Last Updated': fmtUs(later) });
}

// A custom REI status nobody mapped yet (Data Health should point it out).
reiRows.filter((r) => r['Lead Status'] === 'Dead' && r['Lead Source'] !== 'Google Ads').slice(0, 3).forEach((r) => { r['Lead Status'] = 'Pending Review'; });

// ---------------------------------------------------------------- Google Ads (API-shaped rows)
const micros = (usd) => String(Math.round(usd * 1e6));
const results = {
  campaigns: CAMPAIGNS.map((c) => ({ campaign: { id: c.id, name: c.name, status: 'ENABLED', advertisingChannelType: 'SEARCH' } })),
  adGroups: AD_GROUPS.map((g) => ({ adGroup: { id: g.id, name: g.name, status: 'ENABLED' }, campaign: { id: CAMPAIGNS[g.c].id } })),
  keywordView: [], searchTermView: [], geographicView: [], clickView: [],
  geoConstants: Object.entries(CITIES).map(([name, v]) => ({ geoTargetConstant: { id: v.id, name, canonicalName: `${name},California,United States`, targetType: 'City' } })),
};
const agg = (map, key, init) => { if (!map.has(key)) map.set(key, init()); return map.get(key); };
const kwDay = new Map();
const termDay = new Map();
const geoDay = new Map();
for (const c of clicks) {
  const conv = googleConvByClick.get(c.gclid) || 0;
  const k = agg(kwDay, `${c.d}|${c.kw.id}|${c.dev}`, () => ({ c, clicks: 0, cost: 0, conv: 0 }));
  k.clicks += 1; k.cost += c.cost; k.conv += conv;
  const t = agg(termDay, `${c.d}|${c.kw.id}|${c.term}`, () => ({ c, clicks: 0, cost: 0, conv: 0 }));
  t.clicks += 1; t.cost += c.cost; t.conv += conv;
  const g = agg(geoDay, `${c.d}|${c.kw.group.id}|${c.city}`, () => ({ c, clicks: 0, cost: 0, conv: 0 }));
  g.clicks += 1; g.cost += c.cost; g.conv += conv;
  results.clickView.push({
    clickView: { gclid: c.gclid, keyword: `customers/1234567890/adGroupCriteria/${c.kw.group.id}~${c.kw.id}`, locationOfPresence: { city: `geoTargetConstants/${CITIES[c.city].id}` } },
    campaign: { id: c.kw.campaign.id }, adGroup: { id: c.kw.group.id }, segments: { date: c.d, device: c.dev },
  });
}
const ctr = () => between(0.045, 0.095);
for (const [key, v] of kwDay) {
  const [d, , dev] = key.split('|');
  const kw = v.c.kw;
  results.keywordView.push({
    campaign: { id: kw.campaign.id }, adGroup: { id: kw.group.id },
    adGroupCriterion: { criterionId: kw.id, keyword: { text: kw.text, matchType: kw.matchType }, status: 'ENABLED', finalUrls: [FINAL_URL(kw.group, kw.text)] },
    segments: { date: d, device: dev },
    metrics: { impressions: String(Math.round(v.clicks / ctr())), clicks: String(v.clicks), costMicros: micros(v.cost), conversions: v.conv, conversionsValue: 0 },
  });
}
for (const [key, v] of termDay) {
  const [d, , term] = key.split('|');
  const kw = v.c.kw;
  results.searchTermView.push({
    searchTermView: { searchTerm: term }, campaign: { id: kw.campaign.id }, adGroup: { id: kw.group.id },
    segments: { date: d, keyword: { adGroupCriterion: `customers/1234567890/adGroupCriteria/${kw.group.id}~${kw.id}`, info: { text: kw.text, matchType: kw.matchType } } },
    metrics: { impressions: String(Math.round(v.clicks / ctr())), clicks: String(v.clicks), costMicros: micros(v.cost), conversions: v.conv },
  });
}
for (const [key, v] of geoDay) {
  const [d, , city] = key.split('|');
  const kw = v.c.kw;
  results.geographicView.push({
    geographicView: { locationType: 'LOCATION_OF_PRESENCE', countryCriterionId: '2840' }, campaign: { id: kw.campaign.id }, adGroup: { id: kw.group.id },
    segments: { date: d, geoTargetCity: `geoTargetConstants/${CITIES[city].id}` },
    metrics: { impressions: String(Math.round(v.clicks / ctr())), clicks: String(v.clicks), costMicros: micros(v.cost), conversions: v.conv },
  });
}
const ads = normalizeGaql(results);
ads.adCopy = AD_GROUPS.map((g) => ({
  id: `ad_${g.id}`, adGroupId: g.id,
  headlines: g.id === '31000004' ? ['We Buy Inherited Houses', 'Probate? We Can Help', 'Cash Offer in 24 Hours']
    : g.id === '31000002' ? ['Sell Your House As-Is', 'No Repairs, No Cleaning', 'Cash Offer in 24 Hours']
      : g.id === '31000008' ? ['We Buy Houses in California', 'Cash Offer in 24 Hours', 'Close on Your Timeline']
        : ['We Buy Houses for Cash', 'Sell Your House Fast', 'Cash Offer in 24 Hours'],
  finalUrl: `${SITE}${g.url}`,
}));

// ---------------------------------------------------------------- REI -> leads
const rei = await normalizeReiRows(reiRows);
markDuplicates(rei.leads);

// ---------------------------------------------------------------- calls
const callsCsv = toCsv(callRows, Object.keys(callRows[0] || { 'Call ID': 1 }).map((k) => ({ key: k, label: k })));
const calls = (await parseCallsCsv(callsCsv)).calls;

// ---------------------------------------------------------------- website (GA4)
const PAGES = [
  { path: '/', h1: 'We Buy Houses in California', title: 'Sell Your House Fast for Cash | Twin Home Buyer', cta: 'Get My Cash Offer' },
  { path: '/sell-inherited-house', h1: 'Sell an Inherited House in the Bay Area', title: 'Sell an Inherited or Probate House', cta: 'Get My Cash Offer' },
  { path: '/sell-house-as-is', h1: 'Sell Your House As-Is, No Repairs', title: 'Sell As-Is for Cash', cta: 'Get My Cash Offer' },
  { path: '/stop-foreclosure', h1: 'Behind on Payments? Sell Before Foreclosure', title: 'Avoid Foreclosure', cta: 'Talk to Us Today' },
  { path: '/sell-rental-property', h1: 'Sell Your Rental Property, Tenants and All', title: 'Sell a Rental Property', cta: 'Get My Cash Offer' },
  { path: '/sell-house-divorce', h1: 'Selling a House During Divorce', title: 'Divorce Home Sale', cta: '' },
  { path: '/san-francisco', h1: 'We Buy Houses in San Francisco', title: 'Sell Your San Francisco House for Cash', cta: 'Get My Cash Offer' },
  { path: '/blog/bay-area-market-update', h1: 'Bay Area Housing Market Update', title: 'Market Update', cta: '' },
];
const landingDaily = [];
const pageTotals = new Map(PAGES.map((p) => [p.path, { path: p.path, users: 0, returningUsers: 0, ppcUsers: 0, keyEvents: 0, formStarts: 0, formSubmits: 0 }]));
const ppcByDayPath = new Map();
for (const c of clicks) {
  const p = FINAL_URL(c.kw.group, c.kw.text).replace(SITE, '');
  const k = `${c.d}|${p}`;
  ppcByDayPath.set(k, (ppcByDayPath.get(k) || 0) + 1);
}
const leadsByDayPath = new Map();
for (const r of reiRows) {
  if (!r['Landing Page']) continue;
  const [m, dd, y] = r['Created Date'].split(' ')[0].split('/');
  const k = `${y}-${m.padStart(2, '0')}-${dd.padStart(2, '0')}|${r['Landing Page'].replace(SITE, '')}`;
  leadsByDayPath.set(k, (leadsByDayPath.get(k) || 0) + 1);
}
for (const d of dates) {
  for (const p of PAGES) {
    const paid = Math.round((ppcByDayPath.get(`${d}|${p.path}`) || 0) * between(0.85, 1.0));
    const organic = poisson(p.path === '/' ? 9 : p.path.startsWith('/blog') ? 6 : 1.6);
    const direct = poisson(p.path === '/' ? 3 : 0.4);
    const submits = leadsByDayPath.get(`${d}|${p.path}`) || 0;
    const starts = submits + poisson((paid + organic) * 0.06);
    for (const [src, med, sessions, isPaid] of [['google', 'cpc', paid, true], ['google', 'organic', organic, false], ['(direct)', '(none)', direct, false]]) {
      if (!sessions) continue;
      const share = isPaid ? 1 : 0;
      landingDaily.push({
        d, path: p.path, source: src, medium: med, paid: isPaid, campaign: '', kw: '', city: '', st: '', dev: '',
        sessions, engaged: Math.round(sessions * between(0.45, 0.7)), keyEvents: isPaid ? submits : Math.round(organic * 0.01),
        formStarts: isPaid ? starts : 0, formSubmits: isPaid ? submits * share : 0,
      });
    }
    const t = pageTotals.get(p.path);
    const users = Math.round((paid + organic + direct) * 0.82);
    t.users += users;
    t.returningUsers += Math.round(users * between(0.14, 0.24));
    t.ppcUsers += Math.round(paid * 0.85);
    t.keyEvents += submits;
    t.formStarts += starts;
    t.formSubmits += submits;
  }
}

// ---------------------------------------------------------------- assemble
const ds = emptyDataset({ isDemo: true, label: 'DEMO DATA: made up for illustration. Not real leads, spend or people.' });
ds.generatedAt = '2026-09-28T06:00:00.000Z';
ds.ads = ads;
ds.rei = { leads: rei.leads, unmappedStatuses: rei.unmappedStatuses };
ds.calls = calls;
ds.web = { landingDaily, pagePaths: [...pageTotals.values()], pages: PAGES, consent: { adsRate: 0.72, note: 'Demo: 72% of visitors accepted ad cookies.' } };

// Sync history, including one failed crawler run with the selector that broke.
const at = (d, h) => `${d}T${String(h).padStart(2, '0')}:00:00.000Z`;
for (let i = 13; i >= 0; i--) {
  const d = addDays('2026-09-28', -i);
  recordSync(ds, { id: `demo_gads_${d}`, source: 'google_ads', mode: 'api', status: 'ok', startedAt: at(d, 5), finishedAt: at(d, 5), created: 40 + (i % 7), updated: 12, message: 'Demo: Google Ads API sync (yesterday and the last 3 days re-pulled).' });
  const crawlerFailed = i === 0;
  recordSync(ds, crawlerFailed
    ? { id: `demo_rei_${d}`, source: 'rei', mode: 'crawler', status: 'failed', startedAt: at(d, 6), finishedAt: at(d, 6), failed: 1, message: 'Demo: contact detail page layout changed; field "Lead Status" not found. Using the last good data; CSV import still works.',
      errors: [{ step: 'contact.detail', selector: 'label:has-text("Lead Status") + *', message: 'Demo: timeout 15000 ms waiting for selector' }] }
    : { id: `demo_rei_${d}`, source: 'rei', mode: 'crawler', status: 'ok', startedAt: at(d, 6), finishedAt: at(d, 6), created: 2 + (i % 3), updated: 5 + (i % 4), message: 'Demo: REI crawler sync.' });
  recordSync(ds, { id: `demo_ga4_${d}`, source: 'ga4', mode: 'api', status: 'ok', startedAt: at(d, 5), finishedAt: at(d, 5), created: 30, message: 'Demo: GA4 Data API sync.' });
}
recordSync(ds, { id: 'demo_calls_1', source: 'calls', mode: 'csv', status: 'ok', startedAt: at('2026-09-26', 17), finishedAt: at('2026-09-26', 17), created: calls.length, message: 'Demo: call log CSV import.' });
recordSync(ds, { id: 'demo_pages_1', source: 'pages', mode: 'scan', status: 'ok', startedAt: at('2026-09-25', 4), finishedAt: at('2026-09-25', 4), created: PAGES.length, message: 'Demo: landing page scan.' });

const check = validateDataset(ds);
if (!check.ok) {
  console.error('Demo dataset failed validation:', check.errors);
  process.exit(1);
}
const summary = summarizeDataset(ds);
console.log('Demo story:', JSON.stringify({ ...stats, clicks: clicks.length, spend: summary.spend, reiRows: reiRows.length, calls: calls.length }));

if (!CHECK) {
  mkdirSync(path.join(OUT, 'csv'), { recursive: true });
  writeFileSync(path.join(OUT, 'demo-dataset.json'), JSON.stringify(ds));
  // Sample import files (same fictional data) for trying the CSV importers.
  const headerOf = (rows) => Object.keys(rows[0]).map((k) => ({ key: k, label: k }));
  writeFileSync(path.join(OUT, 'csv', 'rei-export-DEMO.csv'), toCsv(reiRows, headerOf(reiRows)));
  writeFileSync(path.join(OUT, 'csv', 'call-log-DEMO.csv'), callsCsv);
  const gname = new Map(AD_GROUPS.map((g) => [g.id, g.name]));
  const kwRows = [...kwDay.entries()].map(([key, v]) => {
    const [d] = key.split('|');
    return { Day: d, Campaign: v.c.kw.campaign.name, 'Ad group': gname.get(v.c.kw.group.id), Keyword: v.c.kw.text, 'Match type': v.c.kw.matchType === 'EXACT' ? 'Exact match' : 'Phrase match', 'Final URL': FINAL_URL(v.c.kw.group, v.c.kw.text), Clicks: v.clicks, Cost: round(v.cost, 2), Conversions: v.conv };
  });
  const title = `Keyword report\n"${START} - ${END}"\n`;
  writeFileSync(path.join(OUT, 'csv', 'google-ads-keywords-DEMO.csv'), title + toCsv(kwRows, headerOf(kwRows)));
  const geoRows = [...geoDay.entries()].map(([key, v]) => {
    const [d, , city] = key.split('|');
    return { Day: d, Campaign: v.c.kw.campaign.name, 'Ad group': gname.get(v.c.kw.group.id), 'City (User location)': `${city}, California, United States`, Clicks: v.clicks, Cost: round(v.cost, 2), Conversions: v.conv };
  });
  writeFileSync(path.join(OUT, 'csv', 'google-ads-locations-DEMO.csv'), toCsv(geoRows, headerOf(geoRows)));
  const clickRows = clicks.map((c) => ({ Day: c.d, Campaign: c.kw.campaign.name, 'Ad group': gname.get(c.kw.group.id), Keyword: c.kw.text, 'Match type': c.kw.matchType === 'EXACT' ? 'Exact' : 'Phrase', GCLID: c.gclid, 'City (User location)': `${c.city}, California, United States`, Device: c.dev.toLowerCase() }));
  writeFileSync(path.join(OUT, 'csv', 'google-ads-clicks-DEMO.csv'), toCsv(clickRows, headerOf(clickRows)));
  const termRows = [...termDay.entries()].map(([key, v]) => {
    const [d, , term] = key.split('|');
    return { Day: d, 'Search term': term, Campaign: v.c.kw.campaign.name, 'Ad group': gname.get(v.c.kw.group.id), Keyword: v.c.kw.text, 'Match type': v.c.kw.matchType === 'EXACT' ? 'Exact' : 'Phrase', Clicks: v.clicks, Cost: round(v.cost, 2), Conversions: v.conv };
  });
  writeFileSync(path.join(OUT, 'csv', 'google-ads-search-terms-DEMO.csv'), toCsv(termRows, headerOf(termRows)));
  const pagesRows = PAGES.map((p) => ({ URL: `${SITE}${p.path}`, H1: p.h1, Title: p.title, CTA: p.cta }));
  writeFileSync(path.join(OUT, 'csv', 'landing-pages-DEMO.csv'), toCsv(pagesRows, headerOf(pagesRows)));
  console.log(`Wrote ${path.relative(process.cwd(), OUT)}/demo-dataset.json (${Math.round(JSON.stringify(ds).length / 1024)} KB) and sample CSVs.`);
}
