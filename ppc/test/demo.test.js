// The committed demo dataset: valid, clearly labelled, free of personal
// details, and it tells every story the dashboard needs to show.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyze, parseGoogleAdsCsv, normalizeReiRows, parseCsv, rowsToObjects, validateDataset } from '../engine/index.js';

const demoUrl = new URL('../demo/demo-dataset.json', import.meta.url);
const raw = readFileSync(demoUrl, 'utf8');
const ds = JSON.parse(raw);
const a = analyze(ds, {}, {}, { now: Date.parse('2026-09-28T12:00:00Z') });
const row = (keyword, city) => a.rows.find((r) => r.keyword === keyword && r.city === city);

test('demo dataset is valid and labelled as demo', () => {
  assert.equal(validateDataset(ds).ok, true);
  assert.equal(ds.isDemo, true);
  assert.match(ds.label, /DEMO/);
  assert.ok(a.health.sources.every((s) => s.status === 'demo'));
});

test('demo dataset holds no names, phone numbers or emails', () => {
  assert.ok(!/Demo Seller|555-01|example\.com|Demo Street/.test(raw));
});

test('demo tells each recommendation story at keyword + city level', () => {
  assert.equal(row('sell my house fast', 'San Francisco').decision.rec, 'PAUSE');
  assert.equal(row('we buy houses', 'San Francisco').decision.rec, 'REDUCE');
  assert.equal(row('we buy houses stockton', 'Stockton').decision.rec, 'PAUSE');
  assert.equal(row('we buy houses stockton', 'Stockton').decision.basis, 'buy_box');
  const inherited = row('sell inherited house', 'San Jose');
  assert.equal(inherited.decision.rec, 'SCALE');
  assert.equal(inherited.decision.basis, 'profit');
  assert.ok(a.rows.some((r) => r.decision.rec === 'WATCH' && r.decision.basis === 'sample'));
});

test('demo: the deal without recorded profit is never called profitable', () => {
  const k = a.keywordRows.find((r) => r.keyword === 'sell house before foreclosure');
  assert.equal(k.metrics.deals, 1);
  assert.notEqual(k.decision.basis, 'profit');
  assert.match(k.decision.reason, /No profit recorded/);
  assert.equal(a.overview.metrics.profitKnown, false);
});

test('demo: spend and clicks reconcile with Google Ads totals', () => {
  const kwSpend = ds.ads.keywordDaily.reduce((s, r) => s + r.cost, 0);
  assert.ok(Math.abs(a.overview.metrics.spend - kwSpend) < 1);
  const kwClicks = ds.ads.keywordDaily.reduce((s, r) => s + r.clk, 0);
  assert.ok(Math.abs(a.overview.metrics.clicks - kwClicks) < 0.5);
});

test('demo: alerts, data health, search terms, landing pages and actions all have content', () => {
  const types = new Set(a.alerts.map((x) => x.type));
  for (const t of ['crawler_failed', 'spend_spike', 'new_contract']) assert.ok(types.has(t), t);
  const checks = Object.fromEntries(a.health.checks.map((c) => [c.code, c]));
  assert.equal(checks.crawler_errors.severity, 'error');
  assert.match(checks.unmapped_statuses.display, /Pending Review/);
  assert.ok(checks.missing_outcomes.value >= 1);
  assert.ok(a.searchTerms.findings.some((f) => f.flags[0].code === 'jobs'));
  const sf = a.landing.find((l) => l.keyword === 'sell inherited house san francisco');
  assert.equal(sf.match, 'poor');
  assert.equal(sf.betterPage, '/sell-inherited-house');
  assert.ok(a.actions.some((x) => x.type === 'pause_keyword'));
  assert.ok(a.actions.some((x) => x.type === 'add_negative'));
  assert.ok(a.actions.some((x) => x.type === 'exclude_location' && x.target.city === 'Stockton'));
  assert.ok(!a.actions.some((x) => x.type === 'fix_landing_page' && /stockton|fresno|sacramento/.test(x.target.keyword)), 'no pages for out-of-area keywords');
  assert.equal(new Set(a.actions.map((x) => x.id)).size, a.actions.length);
});

test('demo sample CSVs import through the CSV importers', async () => {
  const csv = (name) => readFileSync(new URL(`../demo/csv/${name}`, import.meta.url), 'utf8');
  assert.equal(parseGoogleAdsCsv(csv('google-ads-keywords-DEMO.csv')).reportType, 'keywords');
  assert.equal(parseGoogleAdsCsv(csv('google-ads-locations-DEMO.csv')).reportType, 'locations');
  assert.equal(parseGoogleAdsCsv(csv('google-ads-clicks-DEMO.csv')).reportType, 'clicks');
  assert.equal(parseGoogleAdsCsv(csv('google-ads-search-terms-DEMO.csv')).reportType, 'search_terms');
  const rows = rowsToObjects(parseCsv(csv('rei-export-DEMO.csv')), 0);
  const rei = await normalizeReiRows(rows);
  assert.equal(rei.leads.length, ds.rei.leads.length);
  assert.ok(!rei.warnings.some((w) => /No lead ID|No created-date/.test(w)));
});
