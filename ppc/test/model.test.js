import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, buildModel, keywordCityTable, overview, rollUp, weeklyTrend } from '../engine/index.js';
import { miniDataset } from './helpers.js';

const find = (rows, keyword, city) => rows.find((r) => r.keyword === keyword && r.city === city);

test('keyword + city table joins Google Ads spend with REI leads', async () => {
  const model = buildModel(await miniDataset());
  const { rows, unmatched } = keywordCityTable(model, {});
  const stockton = find(rows, 'we buy houses', 'Stockton');
  assert.equal(stockton.metrics.spend, 1420);
  assert.equal(stockton.metrics.clicks, 31);
  assert.equal(stockton.metrics.leads, 1);
  assert.equal(stockton.metrics.qualified, 0);
  assert.equal(stockton.decision.rec, 'PAUSE');
  assert.equal(stockton.inBuyBox, false);
  assert.equal(stockton.county, 'San Joaquin');

  const sf = find(rows, 'sell inherited house', 'San Francisco');
  assert.equal(sf.metrics.spend, 950);
  assert.equal(sf.metrics.leads, 2);
  assert.equal(sf.metrics.contracts, 1);
  assert.equal(sf.metrics.appointments, 2);
  assert.equal(sf.decision.rec, 'SCALE');
  assert.equal(sf.topSearchTerm, 'sell inherited house sf');

  // L3 says "Google Ads" in lead source but has no GCLID/UTM: unmatched, not guessed.
  assert.equal(unmatched.metrics.leads, 1);
  assert.equal(unmatched.decision.rec, 'WATCH');
});

test('duplicates never count; totals equal the sum of the rows', async () => {
  const model = buildModel(await miniDataset());
  const o = overview(model, {});
  assert.equal(o.duplicates, 1);
  const sumSpend = o.table.rows.reduce((a, r) => a + r.metrics.spend, 0);
  assert.equal(o.metrics.spend, sumSpend);
  assert.equal(o.metrics.leads, 4); // L1, L2, L3, L5 (L4 is a duplicate, and direct mail)
  assert.equal(o.channels.ppc, 4);
  assert.equal(o.recCounts.PAUSE, 1);
  assert.equal(o.recCounts.SCALE, 1);
  assert.equal(o.wasteSpend, 1420);
});

test('filters: date range, city, county, campaign, keyword, recommendation', async () => {
  const model = buildModel(await miniDataset());
  const day1 = keywordCityTable(model, { start: '2026-09-01', end: '2026-09-01' });
  assert.equal(find(day1.rows, 'sell inherited house', 'San Francisco').metrics.spend, 450);
  assert.equal(find(day1.rows, 'sell inherited house', 'San Francisco').metrics.leads, 1, 'lead date comes from the click date');

  assert.deepEqual(keywordCityTable(model, { cities: ['Stockton'] }).rows.map((r) => r.city), ['Stockton']);
  assert.deepEqual(keywordCityTable(model, { counties: ['San Francisco'] }).rows.map((r) => r.city), ['San Francisco']);
  assert.equal(keywordCityTable(model, { campaigns: ['nope'] }).rows.length, 0);
  assert.deepEqual(keywordCityTable(model, { keywords: ['we buy houses'] }).rows.map((r) => r.keyword), ['we buy houses']);
  assert.deepEqual(keywordCityTable(model, { keywordSearch: 'INHERITED' }).rows.map((r) => r.keyword), ['sell inherited house']);
  assert.deepEqual(keywordCityTable(model, { recommendations: ['PAUSE'] }).rows.map((r) => r.decision.rec), ['PAUSE']);
  assert.equal(keywordCityTable(model, { start: '2027-01-01', end: '2027-01-31' }).rows.length, 0);
});

test('situation and quality filters count matching leads but keep the full-data recommendation', async () => {
  const model = buildModel(await miniDataset());
  const t = keywordCityTable(model, { situations: ['inherited_probate'] });
  assert.equal(t.leadOnlyFilters, true);
  const sf = find(t.rows, 'sell inherited house', 'San Francisco');
  assert.equal(sf.metrics.leads, 2);
  assert.ok(!find(t.rows, 'we buy houses', 'Stockton'), 'rows without a matching lead are hidden');
  const q = keywordCityTable(model, { quality: 'unqualified' });
  const stockton = find(q.rows, 'we buy houses', 'Stockton');
  assert.equal(stockton.metrics.leads, 1);
  const sfq = keywordCityTable(model, { quality: 'qualified' });
  assert.equal(find(sfq.rows, 'sell inherited house', 'San Francisco').decision.rec, 'SCALE');
});

test('roll-ups by keyword, city, campaign and campaign + city', async () => {
  const model = buildModel(await miniDataset());
  const { rows } = keywordCityTable(model, {});
  const byKw = rollUp(model, rows, 'keyword');
  assert.equal(byKw.length, 2);
  assert.equal(rollUp(model, rows, 'city').find((r) => r.city === 'Stockton').metrics.spend, 1420);
  assert.equal(rollUp(model, rows, 'campaign').length, 1);
  assert.equal(rollUp(model, rows, 'campaign_city').length, 2);
  assert.throws(() => rollUp(model, rows, 'nope'));
});

test('weekly trend sums spend and leads by Monday week', async () => {
  const model = buildModel(await miniDataset());
  const weeks = weeklyTrend(model, {});
  assert.equal(weeks.length, 1);
  assert.equal(weeks[0].week, '2026-08-31');
  assert.equal(weeks[0].spend, 2370);
  assert.equal(weeks[0].leads, 4, 'includes the Google Ads lead with no keyword, like the overview');
});

test('analyze() returns every dashboard section, with actions on the fixed decision window', async () => {
  const a = analyze(await miniDataset(), {}, { cities: ['San Francisco'] });
  for (const key of ['overview', 'rows', 'keywordRows', 'cityRows', 'searchTerms', 'landing', 'retargeting', 'health', 'alerts', 'actions', 'trend', 'options']) {
    assert.ok(a[key] != null, key);
  }
  assert.deepEqual(a.rows.map((r) => r.city), ['San Francisco']);
  assert.ok(a.actions.some((x) => x.type === 'pause_keyword' && x.target.keyword === 'we buy houses'), 'city filter does not hide actions');
  assert.equal(a.decisionWindow.end, '2026-09-04');
});

test('custom situations and per-lead overrides', async () => {
  const ds = await miniDataset();
  const overridden = buildModel(ds, { situationOverrides: { L2: 'divorce' } });
  assert.equal(overridden.leads.find((l) => l.id === 'L2').situation, 'divorce');
  const custom = buildModel(ds, { situations: [{ code: 'heirs', label: 'Heirs', patterns: ['heir'] }, { code: 'other', label: 'Other', patterns: [] }, { code: 'unknown', label: 'Unknown', patterns: [] }] });
  assert.equal(custom.leads.find((l) => l.id === 'L5').situation, 'heirs');
});
