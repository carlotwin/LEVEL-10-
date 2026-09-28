import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectFileKind, emptyDataset, importFile, mergeDataset, GADS_SCRIPT_KIND, DATASET_SCHEMA } from '../engine/index.js';

const demo = (name) => readFileSync(new URL(`../demo/csv/${name}`, import.meta.url), 'utf8');

test('detectFileKind recognizes every supported file', () => {
  assert.equal(detectFileKind('k.csv', demo('google-ads-keywords-DEMO.csv')), 'google_ads');
  assert.equal(detectFileKind('l.csv', demo('google-ads-locations-DEMO.csv')), 'google_ads');
  assert.equal(detectFileKind('c.csv', demo('google-ads-clicks-DEMO.csv')), 'google_ads');
  assert.equal(detectFileKind('s.csv', demo('google-ads-search-terms-DEMO.csv')), 'google_ads');
  assert.equal(detectFileKind('rei.csv', demo('rei-export-DEMO.csv')), 'rei', 'an REI export with a GCLID column is still REI');
  assert.equal(detectFileKind('calls.csv', demo('call-log-DEMO.csv')), 'calls');
  assert.equal(detectFileKind('pages.csv', demo('landing-pages-DEMO.csv')), 'pages');
  assert.equal(detectFileKind('ga4.csv', '# GA4\nDate,Landing page + query string,Session source / medium,Sessions\n20260901,/,google / cpc,3\n'), 'ga4');
  assert.equal(detectFileKind('x.json', JSON.stringify({ schema: DATASET_SCHEMA })), 'dataset');
  assert.equal(detectFileKind('x.json', JSON.stringify({ kind: GADS_SCRIPT_KIND, results: {} })), 'gads_script');
  assert.equal(detectFileKind('x.csv', 'name,color\nx,red\n'), 'unknown');
  assert.equal(detectFileKind('x.json', '{not json'), 'unknown');
});

test('importFile: REI export -> leads without personal details, sync recorded', async () => {
  const r = await importFile({ name: 'rei.csv', text: demo('rei-export-DEMO.csv') }, { by: 'u_1' });
  assert.equal(r.kind, 'rei');
  assert.ok(r.part.rei.leads.length > 100);
  assert.ok(!/Demo Seller|555-01|example\.com/.test(JSON.stringify(r.part)));
  assert.equal(r.part.sync.history[0].source, 'rei');
  assert.equal(r.part.sync.history[0].by, 'u_1');
  assert.equal(r.errors.length, 0);
});

test('importFile: custom REI status names from Settings are honoured', async () => {
  const text = 'Lead ID,Created Date,Lead Status,Lead Source\nA,2026-09-01,Pending Review,Google Ads\n';
  const plain = await importFile({ name: 'r.csv', text });
  assert.deepEqual(plain.unmappedStatuses, { 'Pending Review': 1 });
  const mapped = await importFile({ name: 'r.csv', text }, { settings: { rei: { statusMap: { 'Pending Review': 'qualified' } } } });
  assert.deepEqual(mapped.unmappedStatuses, {});
  assert.equal(mapped.part.rei.leads[0].qualified, true);
});

test('importFile: Google Ads Script JSON goes through the API normalizer', async () => {
  const text = JSON.stringify({
    kind: GADS_SCRIPT_KIND, generatedAt: '2026-09-28T06:00:00Z',
    results: {
      campaigns: [{ campaign: { id: '1', name: 'C', status: 'ENABLED' } }],
      keywordView: [{ campaign: { id: '1' }, adGroup: { id: '2' }, adGroupCriterion: { criterionId: '3', keyword: { text: 'sell house', matchType: 'PHRASE' } }, segments: { date: '2026-09-27', device: 'MOBILE' }, metrics: { clicks: '2', costMicros: '90000000' } }],
    },
  });
  const r = await importFile({ name: 'gads.json', text });
  assert.equal(r.kind, 'gads_script');
  assert.equal(r.part.ads.keywords[0].id, '2~3');
  assert.equal(r.part.ads.keywordDaily[0].cost, 90);
  assert.equal(r.part.sync.sources.google_ads.status, 'ok');
});

test('importFile: all demo CSVs merge into one working dataset', async () => {
  let ds = emptyDataset();
  for (const f of ['google-ads-keywords-DEMO.csv', 'google-ads-locations-DEMO.csv', 'google-ads-clicks-DEMO.csv', 'google-ads-search-terms-DEMO.csv', 'rei-export-DEMO.csv', 'call-log-DEMO.csv', 'landing-pages-DEMO.csv']) {
    const r = await importFile({ name: f, text: demo(f) });
    assert.equal(r.errors.length, 0, `${f}: ${r.errors.join(' ')}`);
    ds = mergeDataset(ds, r.part).dataset;
  }
  assert.ok(ds.ads.keywords.length > 20);
  assert.ok(ds.rei.leads.length > 100);
  assert.equal(ds.web.pages.length, 8);
  assert.equal(ds.sync.history.length, 7);
});

test('importFile: unknown file and a dataset with personal details are refused', async () => {
  const u = await importFile({ name: 'x.csv', text: 'a,b\n1,2\n' });
  assert.equal(u.part, null);
  assert.match(u.errors[0], /Could not tell/);
  const bad = { ...emptyDataset(), rei: { leads: [{ id: 'x', phone: '4155550100', createdDate: '2026-09-01' }] } };
  const d = await importFile({ name: 'd.json', text: JSON.stringify(bad) });
  assert.equal(d.part, null);
  assert.match(d.errors[0], /personal details/);
});

test('importFile: missing settings (null) fall back to defaults', async () => {
  const r = await importFile({ name: 'r.csv', text: 'Lead ID,Created Date,Lead Status\nA,2026-09-01,Qualified\n' }, { settings: null });
  assert.equal(r.errors.length, 0);
  assert.equal(r.part.rei.leads[0].qualified, true);
});
