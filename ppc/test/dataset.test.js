import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DATASET_SCHEMA, emptyDataset, mergeDataset, normalizeGaql, normalizeReiRows, parseGoogleAdsCsv, recordSync, stripLead,
  summarizeDataset, validateDataset,
} from '../engine/index.js';
import { KEYWORDS_CSV, miniDataset, REI_ROWS } from './helpers.js';

const adsOnly = (ads) => ({ ...emptyDataset(), ads });

test('re-importing the same Google Ads file replaces those days instead of doubling them', () => {
  const once = mergeDataset(emptyDataset(), adsOnly(parseGoogleAdsCsv(KEYWORDS_CSV).ads)).dataset;
  const twice = mergeDataset(once, adsOnly(parseGoogleAdsCsv(KEYWORDS_CSV).ads));
  assert.equal(twice.dataset.ads.keywordDaily.length, 3);
  assert.equal(twice.stats.ads.replacedRows, 3);
  const spend = twice.dataset.ads.keywordDaily.reduce((a, r) => a + r.cost, 0);
  assert.equal(spend, 2370);
});

test('an import for one campaign does not wipe another campaign on the same day', () => {
  const a = parseGoogleAdsCsv('Day,Campaign,Ad group,Keyword,Clicks,Cost\n2026-09-01,A,G,sell house,1,10\n').ads;
  const b = parseGoogleAdsCsv('Day,Campaign,Ad group,Keyword,Clicks,Cost\n2026-09-01,B,G,sell house,1,20\n').ads;
  const ds = mergeDataset(mergeDataset(emptyDataset(), adsOnly(a)).dataset, adsOnly(b)).dataset;
  assert.equal(ds.ads.keywordDaily.length, 2);
});

test('CSV keywords and API keywords for the same entity are reconciled, not double counted', () => {
  const csv = mergeDataset(emptyDataset(), adsOnly(parseGoogleAdsCsv(KEYWORDS_CSV).ads)).dataset;
  const api = normalizeGaql({
    keywordView: [{
      campaign: { id: '9001', name: 'Search - Bay Area' }, adGroup: { id: '9002', name: 'Core' },
      adGroupCriterion: { criterionId: '9003', keyword: { text: 'we buy houses', matchType: 'PHRASE' } },
      segments: { date: '2026-09-01' }, metrics: { clicks: '31', costMicros: '1420000000' },
    }],
  });
  // The API names match the CSV entities, so the API rows land on the existing ids.
  api.campaigns[0].name = 'Search - Bay Area';
  const merged = mergeDataset(csv, adsOnly(api)).dataset;
  assert.equal(merged.ads.keywords.filter((k) => k.text === 'we buy houses').length, 1);
  const day1 = merged.ads.keywordDaily.filter((r) => r.d === '2026-09-01');
  assert.equal(day1.reduce((a, r) => a + r.cost, 0), 1870, 'day replaced, not added');
});

test('leads: created / updated / unchanged, status updates win, blanks do not erase', async () => {
  const first = await normalizeReiRows(REI_ROWS);
  let ds = mergeDataset(emptyDataset(), { ...emptyDataset(), rei: { leads: first.leads } }).dataset;
  const again = mergeDataset(ds, { ...emptyDataset(), rei: { leads: first.leads } });
  assert.equal(again.stats.leads.created, 0);
  assert.equal(again.stats.leads.unchanged, 5);
  const update = await normalizeReiRows([{ 'Lead ID': 'L5', 'Lead Status': 'Closed', City: 'San Francisco' }]);
  const next = mergeDataset(again.dataset, { ...emptyDataset(), rei: { leads: update.leads } });
  assert.equal(next.stats.leads.updated, 1);
  const l5 = next.dataset.rei.leads.find((l) => l.id === 'L5');
  assert.equal(l5.closed, true);
  assert.equal(l5.gclid, 'G5', 'GCLID from the earlier import is kept');
  assert.equal(l5.createdDate, '2026-09-03', 'created date is kept');
  ds = next.dataset;
  assert.equal(ds.rei.leads.find((l) => l.id === 'L4').duplicateOf, 'L1', 'duplicates recomputed after merge');
});

test('demo data is never mixed with real data', async () => {
  const demo = { ...emptyDataset({ isDemo: true }), ads: parseGoogleAdsCsv(KEYWORDS_CSV).ads };
  const real = { ...emptyDataset(), rei: { leads: (await normalizeReiRows(REI_ROWS)).leads } };
  const { dataset, stats } = mergeDataset(demo, real);
  assert.equal(stats.replacedDemo, true);
  assert.equal(dataset.isDemo, false);
  assert.equal(dataset.ads.keywordDaily.length, 0, 'demo spend is gone');
  assert.equal(dataset.rei.leads.length, 5);
});

test('validateDataset blocks personal details and bad structure', async () => {
  const ds = await miniDataset();
  assert.equal(validateDataset(ds).ok, true);
  assert.equal(ds.schema, DATASET_SCHEMA);
  const leaky = structuredClone(ds);
  leaky.rei.leads[0].phone = '4155550100';
  const v = validateDataset(leaky);
  assert.equal(v.ok, false);
  assert.match(v.errors[0], /personal details/);
  const leakyText = structuredClone(ds);
  leakyText.rei.leads[0].situationRaw = 'call me 415-555-0100';
  assert.equal(validateDataset(leakyText).ok, false);
  assert.equal(validateDataset({ schema: 'other' }).ok, false);
  assert.equal(validateDataset(null).ok, false);
  assert.deepEqual(Object.keys(stripLead({ id: 'x', name: 'Pat', phone: '1', situation: 'vacant' })), ['id', 'situation']);
});

test('recordSync keeps history and last success; a failure keeps the previous success time', () => {
  const ds = emptyDataset();
  recordSync(ds, { source: 'rei', mode: 'crawler', status: 'ok', created: 4, updated: 2, finishedAt: '2026-09-01T10:00:00Z' });
  recordSync(ds, { source: 'rei', mode: 'crawler', status: 'failed', message: 'selector missing', finishedAt: '2026-09-02T10:00:00Z' });
  assert.equal(ds.sync.history.length, 2);
  assert.equal(ds.sync.history[0].status, 'failed');
  assert.equal(ds.sync.sources.rei.status, 'failed');
  assert.equal(ds.sync.sources.rei.lastSuccessAt, '2026-09-01T10:00:00Z');
  assert.equal(ds.sync.sources.rei.lastError, 'selector missing');
});

test('summarizeDataset gives counts, ranges and spend', async () => {
  const s = summarizeDataset(await miniDataset());
  assert.equal(s.counts.leads, 5);
  assert.equal(s.counts.keywords, 2);
  assert.equal(s.spend, 2370);
  assert.deepEqual(s.ranges.ads, { min: '2026-09-01', max: '2026-09-02' });
});
