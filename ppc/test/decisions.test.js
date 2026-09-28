import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeLeads, computeMetrics, decide, DEFAULT_DECISION_SETTINGS, funnelLine } from '../engine/index.js';
import { totals } from './helpers.js';

const run = (t, settings) => decide(computeMetrics(totals(t)), settings);

// ---------------------------------------------------------------- the spec's two examples

test('PAUSE: $1,420 spent, 31 clicks, 5 leads, 0 qualified, 0 contracts', () => {
  const d = run({ spend: 1420, clicks: 31, leads: 5 });
  assert.equal(d.rec, 'PAUSE');
  assert.match(d.reason, /^\$1,420 spent, 31 clicks, 5 leads, 0 qualified leads, 0 contracts\./);
});

test('SCALE: $950 spent, 8 qualified, 3 appointments, 1 contract, estimated acquisition cost within target', () => {
  const d = run({ spend: 950, clicks: 30, leads: 12, qualified: 8, appointments: 3, offers: 2, contracts: 1 });
  assert.equal(d.rec, 'SCALE');
  assert.match(d.reason, /^\$950 spent, 8 qualified leads, 3 appointments, 1 contract\./);
  assert.match(d.reason, /Estimated acquisition cost within target/);
  assert.match(d.reason, /No revenue or profit recorded yet/);
  assert.equal(d.basis, 'contract');
});

// ---------------------------------------------------------------- rules

test('WATCH when there is not enough data yet', () => {
  const d = run({ spend: 120, clicks: 6, leads: 0 });
  assert.equal(d.rec, 'WATCH');
  assert.equal(d.basis, 'sample');
  assert.match(d.reason, /Not enough data yet/);
});

test('a contract is always enough data, even on small spend', () => {
  const d = run({ spend: 450, clicks: 10, leads: 1, qualified: 1, appointments: 1, offers: 1, contracts: 1 });
  assert.equal(d.rec, 'SCALE');
});

test('REDUCE when the deepest funnel cost is far above target', () => {
  const d = run({ spend: 9000, clicks: 200, leads: 10, qualified: 3 }); // $3,000 per qualified vs $1,500
  assert.equal(d.rec, 'REDUCE');
  assert.match(d.reason, /2× the target/);
});

test('WATCH (mixed) when cost is above target but within the reduce multiplier', () => {
  const d = run({ spend: 5400, clicks: 150, leads: 9, qualified: 3 }); // $1,800 vs $1,500
  assert.equal(d.rec, 'WATCH');
  assert.match(d.reason, /Mixed/);
});

test('WATCH (promising) when within target but too few qualified leads', () => {
  const d = run({ spend: 600, clicks: 30, leads: 2, qualified: 1 });
  assert.equal(d.rec, 'WATCH');
  assert.match(d.reason, /Promising/);
});

test('no leads: PAUSE past the pause point, REDUCE past target CPL, else WATCH', () => {
  assert.equal(run({ spend: 850, clicks: 40 }).rec, 'PAUSE');
  assert.equal(run({ spend: 700, clicks: 30 }).rec, 'REDUCE');
  assert.equal(run({ spend: 520, clicks: 30 }).rec, 'WATCH');
});

test('profit: SCALE only when every deal has profit recorded and profit per $ beats the threshold', () => {
  const good = run({ spend: 10000, clicks: 300, leads: 30, qualified: 10, appointments: 5, offers: 3, contracts: 2, deals: 2, profit: 60000, dealsWithProfit: 2, revenue: 900000, dealsWithRevenue: 2 });
  assert.equal(good.rec, 'SCALE');
  assert.equal(good.basis, 'profit');
  assert.match(good.reason, /Profitable/);

  const thin = run({ spend: 10000, clicks: 300, leads: 30, qualified: 10, contracts: 1, deals: 1, profit: 12000, dealsWithProfit: 1 });
  assert.equal(thin.rec, 'WATCH');

  const loss = run({ spend: 10000, clicks: 300, leads: 30, qualified: 10, contracts: 1, deals: 1, profit: 4000, dealsWithProfit: 1 });
  assert.equal(loss.rec, 'REDUCE');
});

test('never "profitable" when profit is missing for any deal: falls back to cost per deal and says so', () => {
  const d = run({ spend: 10000, clicks: 300, leads: 30, qualified: 10, appointments: 5, contracts: 2, deals: 2, profit: 60000, dealsWithProfit: 1 });
  assert.notEqual(d.basis, 'profit');
  assert.ok(!/Profitable/.test(d.reason));
  assert.match(d.reason, /Profit is recorded for only some deals/);
  assert.equal(d.basis, 'deal');
});

test('every threshold comes from settings', () => {
  const t = { spend: 1420, clicks: 31, leads: 5 };
  assert.equal(run(t).rec, 'PAUSE');
  assert.equal(run(t, { pauseSpendNoQualified: 5000 }).rec, 'REDUCE');
  assert.equal(run({ spend: 300, clicks: 10 }, { minSpend: 100, minClicks: 5, targetCpl: 250 }).rec, 'REDUCE');
  assert.equal(DEFAULT_DECISION_SETTINGS.targetCpl, 650);
});

test('facts list and funnel line', () => {
  const m = computeMetrics(totals({ spend: 900, clicks: 40 }));
  assert.equal(funnelLine(m), '$900 spent, 40 clicks, 0 leads');
  const d = decide(m);
  assert.deepEqual(d.facts.slice(0, 3).map((f) => f.label), ['Spent', 'Clicks', 'Leads']);
});

test('unattributed leads are WATCH with a tracking message', () => {
  const d = decide({ ...computeMetrics(totals({ leads: 3 })), unattributed: true });
  assert.equal(d.rec, 'WATCH');
  assert.match(d.reason, /could not be tied to a keyword/);
});

// ---------------------------------------------------------------- attribution

const ads = {
  campaigns: [{ id: 'c1', name: 'Search - Bay Area' }],
  keywords: [
    { id: 'k1', campaignId: 'c1', adGroupId: 'g1', text: 'sell inherited house' },
    { id: 'k2', campaignId: 'c1', adGroupId: 'g2', text: 'we buy houses' },
    { id: 'k3', campaignId: 'c1', adGroupId: 'g3', text: 'we buy houses' },
  ],
  clicks: [{ gclid: 'G1', d: '2026-09-01', k: 'k1', c: 'c1', g: 'g1', city: 'San Francisco', st: 'CA' }],
};
const lead = (o) => ({ id: o.id, createdAt: '2026-09-02T10:00:00Z', createdDate: '2026-09-02', utm: {}, source: '', gclid: '', phoneHash: '', ...o });

test('attribution: GCLID that matches a click is high confidence with keyword and city', () => {
  const a = attributeLeads({ leads: [lead({ id: 'a', gclid: 'G1' })], ads }).get('a');
  assert.equal(a.channel, 'ppc');
  assert.equal(a.confidence, 'high');
  assert.equal(a.keywordId, 'k1');
  assert.equal(a.city, 'San Francisco');
});

test('attribution: GCLID with no click is Google Ads but keyword and city stay unknown', () => {
  const a = attributeLeads({ leads: [lead({ id: 'b', gclid: 'OLD' })], ads }).get('b');
  assert.equal(a.method, 'gclid_unmatched');
  assert.equal(a.keywordId, null);
  assert.equal(a.city, '');
});

test('attribution: an ambiguous UTM keyword is not assigned to a keyword id', () => {
  const a = attributeLeads({ leads: [lead({ id: 'c', utm: { source: 'google', medium: 'cpc', term: 'we buy houses' } })], ads }).get('c');
  assert.equal(a.method, 'utm');
  assert.equal(a.confidence, 'medium');
  assert.equal(a.keywordId, null, 'two keywords share the text: no guess');
  assert.equal(a.city, '', 'no location in UTM: city unknown');
  const b = attributeLeads({ leads: [lead({ id: 'd', utm: { source: 'google', medium: 'cpc', term: 'sell inherited house' } })], ads }).get('d');
  assert.equal(b.keywordId, 'k1');
});

test('attribution: call tracking by phone within the window', () => {
  const calls = [{ id: 'x', at: '2026-09-01T09:00:00Z', d: '2026-09-01', phoneHash: 'h1', trackingNumber: '4155559999', source: '' }];
  const settings = { trackingNumbers: [{ number: '(415) 555-9999', channel: 'google_ads', label: 'Google Ads number' }] };
  const a = attributeLeads({ leads: [lead({ id: 'e', phoneHash: 'h1' })], ads, calls, settings }).get('e');
  assert.equal(a.method, 'call_tracking');
  assert.equal(a.confidence, 'medium');
  const far = [{ ...calls[0], at: '2026-08-01T09:00:00Z' }];
  assert.equal(attributeLeads({ leads: [lead({ id: 'f', phoneHash: 'h1' })], ads, calls: far, settings }).get('f').channel, 'unknown');
});

test('attribution: source text only is low confidence; other channels and no evidence are labelled', () => {
  const r = attributeLeads({ leads: [lead({ id: 'g', source: 'Google Ads' }), lead({ id: 'h', source: 'Direct Mail' }), lead({ id: 'i' })], ads });
  assert.equal(r.get('g').confidence, 'low');
  assert.equal(r.get('g').keywordId, null);
  assert.equal(r.get('h').channel, 'other');
  assert.equal(r.get('i').channel, 'unknown');
  assert.equal(r.get('i').method, 'none');
});
