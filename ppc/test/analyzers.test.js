import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeLandingPages, analyzeRetargeting, analyzeSearchTerms, buildAlerts, buildModel, dataHealth, decisionRecord,
  editorCsv, irrelevantTheme, keywordCityCsv, keywordCityTable, mergeActionState, parseCsv, proposeActions, recordSync, rollUp,
} from '../engine/index.js';
import { miniDataset } from './helpers.js';

// ---------------------------------------------------------------- search term waste

test('irrelevant search themes, without flagging real seller searches', () => {
  assert.equal(irrelevantTheme('real estate jobs san jose').theme.code, 'jobs');
  assert.equal(irrelevantTheme('houses for rent oakland').theme.code, 'renters');
  assert.equal(irrelevantTheme('how to wholesale houses').theme.code, 'education');
  assert.equal(irrelevantTheme('sell rental property fast'), null, 'a landlord selling is a seller');
  assert.equal(irrelevantTheme('we buy houses stockton', { outOfArea: ['stockton'] }).theme.code, 'out_of_area');
  assert.equal(irrelevantTheme('sell my house fast san jose'), null);
});

test('search term waste: irrelevant and high-spend terms become negative keyword suggestions', async () => {
  const model = buildModel(await miniDataset());
  const kw = rollUp(model, keywordCityTable(model, {}).rows, 'keyword');
  const { findings, wasteSpend } = analyzeSearchTerms(model, {}, kw);
  const stockton = findings.find((f) => f.term === 'we buy houses stockton');
  assert.equal(stockton.severity, 'high');
  assert.equal(stockton.suggestion.action, 'add_negative');
  assert.equal(stockton.suggestion.negative, 'stockton');
  const jobs = findings.find((f) => f.term === 'we buy houses jobs');
  assert.equal(jobs.flags[0].code, 'jobs');
  assert.ok(!findings.some((f) => f.term === 'sell inherited house sf'), 'good terms are not flagged');
  assert.equal(wasteSpend, 1020);
});

// ---------------------------------------------------------------- landing pages

test('landing pages: inherited San Francisco search on a generic California page is a poor match', async () => {
  const ds = await miniDataset();
  ds.web.pages = [
    { path: '/', h1: 'We Buy Houses California', title: 'Twin Home Buyer', cta: 'Get my cash offer' },
    { path: '/sell-inherited-house-san-francisco', h1: 'Sell an Inherited House in San Francisco', cta: 'Get my cash offer' },
  ];
  const model = buildModel(ds);
  const kw = rollUp(model, keywordCityTable(model, {}).rows, 'keyword');
  kw.find((k) => k.keyword === 'sell inherited house').keyword = 'sell inherited house san francisco';
  const results = analyzeLandingPages(model, kw);
  const r = results.find((x) => x.keyword === 'sell inherited house san francisco');
  assert.equal(r.match, 'poor');
  assert.match(r.issues.join(' '), /Inherited \/ Probate/);
  assert.equal(r.betterPage, '/sell-inherited-house-san-francisco');
  const generic = results.find((x) => x.keyword === 'we buy houses');
  assert.equal(generic.match, 'good');
});

test('landing pages: missing page data is "unknown", never guessed', async () => {
  const model = buildModel(await miniDataset());
  const kw = rollUp(model, keywordCityTable(model, {}).rows, 'keyword');
  assert.ok(analyzeLandingPages(model, kw).every((r) => r.match === 'unknown'));
});

// ---------------------------------------------------------------- retargeting

test('retargeting: audience sizes from page totals, consent applied, list-size rules', () => {
  const ds = { web: { pagePaths: [
    { path: '/sell-inherited-house', users: 1500, returningUsers: 300, ppcUsers: 900, keyEvents: 50, formStarts: 200, formSubmits: 60 },
    { path: '/sell-house-as-is', users: 400, returningUsers: 80, ppcUsers: 200, keyEvents: 10, formStarts: 50, formSubmits: 12 },
    { path: '/blog/market-update', users: 900, returningUsers: 100, ppcUsers: 0, keyEvents: 0 },
  ] } };
  const r = analyzeRetargeting(ds, { consentRate: 0.5 });
  const seg = Object.fromEntries(r.segments.map((s) => [s.code, s]));
  assert.equal(seg.high_intent.estimate, Math.round((1900 - 60) * 0.5));
  assert.equal(seg.inherited.estimate, Math.round((1500 - 50) * 0.5));
  assert.equal(seg.abandoned_form.estimate, Math.round((250 - 72) * 0.5));
  assert.equal(seg.high_intent.eligibility.level, 'display');
  assert.equal(seg.abandoned_form.eligibility.level, 'too_small');
  assert.match(r.consentNote, /50%/);
  assert.match(r.basis, /No individual visitor data/);
});

// ---------------------------------------------------------------- data health

test('data health: sources, missing GCLIDs, duplicates, crawler errors with the failing selector', async () => {
  const ds = await miniDataset();
  const now = Date.parse('2026-09-05T12:00:00Z');
  recordSync(ds, { source: 'google_ads', mode: 'csv', status: 'ok', finishedAt: '2026-09-05T08:00:00Z' });
  recordSync(ds, { source: 'rei', mode: 'crawler', status: 'failed', finishedAt: '2026-09-05T09:00:00Z', message: 'Contacts table not found',
    errors: [{ step: 'contacts.list', selector: 'table.contacts tbody tr', message: 'Timeout 15000ms' }] });
  const h = dataHealth(buildModel(ds), { now });
  const src = Object.fromEntries(h.sources.map((s) => [s.key, s.status]));
  assert.equal(src.google_ads, 'ok');
  assert.equal(src.rei, 'failed');
  assert.equal(src.ga4, 'missing');
  const check = Object.fromEntries(h.checks.map((c) => [c.code, c]));
  assert.equal(check.missing_gclid.value, 1);
  assert.equal(check.duplicates.value, 1);
  assert.equal(check.crawler_errors.severity, 'error');
  assert.match(check.crawler_errors.detail, /table\.contacts tbody tr/);
  assert.equal(h.summary.status, 'error');
});

test('data health: stale source and demo labelling', async () => {
  const ds = await miniDataset();
  recordSync(ds, { source: 'google_ads', mode: 'api', status: 'ok', finishedAt: '2026-09-01T00:00:00Z' });
  const h = dataHealth(buildModel(ds), { now: Date.parse('2026-09-05T00:00:00Z') });
  assert.equal(h.sources.find((s) => s.key === 'google_ads').status, 'stale');
  ds.isDemo = true;
  const demo = dataHealth(buildModel(ds));
  assert.ok(demo.sources.every((s) => s.status === 'demo'));
  assert.ok(demo.checks.some((c) => c.code === 'demo'));
});

// ---------------------------------------------------------------- alerts

test('alerts: keyword spending without leads, crawler and Google Ads sync failures, new contracts', async () => {
  const ds = await miniDataset();
  recordSync(ds, { id: 'r1', source: 'rei', mode: 'crawler', status: 'failed', message: 'Login page did not load', errors: [{ step: 'login', selector: 'input[name=email]' }] });
  recordSync(ds, { id: 'g1', source: 'google_ads', mode: 'api', status: 'failed', message: 'OAuth token expired (401)' });
  ds.rei.leads.find((l) => l.id === 'L1').contractAt = '2026-09-03';
  const alerts = buildAlerts(buildModel(ds), { settings: { keywordNoLeadSpend: 100 } });
  const types = alerts.map((a) => a.type);
  assert.ok(types.includes('crawler_failed'));
  assert.ok(types.includes('ads_sync_failed'));
  assert.ok(types.includes('new_contract'));
  assert.match(alerts.find((a) => a.type === 'crawler_failed').detail, /input\[name=email\]/);
  assert.equal(new Set(alerts.map((a) => a.id)).size, alerts.length, 'ids are unique');
});

test('alerts: unusually high spend day', () => {
  const kw = { id: 'k', campaignId: 'c', adGroupId: 'g', text: 'sell house' };
  const rows = [];
  for (let i = 1; i <= 8; i++) rows.push({ d: `2026-09-0${i}`, k: 'k', city: 'Oakland', st: 'CA', imp: 10, clk: 2, cost: i === 8 ? 600 : 100, est: 'exact' });
  const model = buildModel({ ads: { campaigns: [{ id: 'c', name: 'C' }], keywords: [kw], keywordCityDaily: rows }, rei: { leads: [] } });
  const spike = buildAlerts(model).find((a) => a.type === 'spend_spike');
  assert.ok(spike);
  assert.match(spike.detail, /\$600/);
});

// ---------------------------------------------------------------- action queue

test('action queue: proposals carry the reason; API-ready only with real Google Ads ids', async () => {
  const model = buildModel(await miniDataset());
  const rows = keywordCityTable(model, {}).rows;
  const kw = rollUp(model, rows, 'keyword');
  const actions = proposeActions(model, { keywordRows: kw, campaignCityRows: rollUp(model, rows, 'campaign_city'), searchTerms: analyzeSearchTerms(model, {}, kw) });
  const pause = actions.find((a) => a.type === 'pause_keyword');
  assert.equal(pause.target.keyword, 'we buy houses');
  assert.match(pause.reason, /\$1,420 spent/);
  assert.equal(pause.status, 'proposed');
  assert.equal(pause.apiReady, false, 'CSV keywords have no criterion id');
  assert.match(pause.manualNote, /by hand/);
  assert.ok(actions.some((a) => a.type === 'add_negative' && a.target.negative === 'stockton'));
  assert.ok(actions.some((a) => a.type === 'exclude_location' && a.target.city === 'Stockton'));
  assert.equal(new Set(actions.map((a) => a.id)).size, actions.length);

  // Real ids -> an operation is prepared (still not sent in v1).
  const apiModel = buildModel(await miniDataset());
  for (const k of apiModel.dataset.ads.keywords) k.id = k.text === 'we buy houses' ? '222~333' : k.id;
  const apiKw = { ...kw.find((k) => k.keyword === 'we buy houses'), keywordIds: ['222~333'] };
  apiModel.keywordsById.set('222~333', { id: '222~333', text: 'we buy houses', matchType: 'PHRASE', adGroupId: '222' });
  const [apiAction] = proposeActions(apiModel, { keywordRows: [apiKw] });
  assert.equal(apiAction.apiReady, true);
  assert.equal(apiAction.operation[0].update.status, 'PAUSED');
  assert.equal(apiAction.operation[0].update.resourceName, 'customers/{customerId}/adGroupCriteria/222~333');
});

test('action queue: approvals persist even when the recommendation changes', () => {
  const action = { id: 'act_1', type: 'pause_keyword', typeLabel: 'Pause keyword', status: 'proposed', summary: 'Pause x', target: { keyword: 'x' }, reason: 'r' };
  const rec = decisionRecord(action, 'approved', 'user_1', 'ok');
  assert.equal(rec.status, 'approved');
  assert.equal(rec.snapshot.summary, 'Pause x');
  assert.throws(() => decisionRecord(action, 'proposed', 'u'));
  assert.throws(() => decisionRecord(action, 'maybe', 'u'));
  const merged = mergeActionState([action], { act_1: rec });
  assert.equal(merged[0].status, 'approved');
  assert.equal(merged[0].decidedBy, 'user_1');
  const gone = mergeActionState([], { act_1: rec });
  assert.equal(gone[0].stillRecommended, false);
  assert.equal(gone[0].status, 'approved');
});

// ---------------------------------------------------------------- exports

test('exports: main table CSV and Google Ads Editor CSV for approved actions', async () => {
  const model = buildModel(await miniDataset());
  const rows = keywordCityTable(model, {}).rows;
  const csv = parseCsv(keywordCityCsv(rows));
  assert.equal(csv[0][0], 'Keyword');
  assert.ok(csv[0].includes('Cost per contract') && csv[0].includes('Recommendation') && csv[0].includes('Reason'));
  assert.equal(csv.length, rows.length + 1);
  const editor = parseCsv(editorCsv([
    { status: 'approved', type: 'add_negative', target: { campaignName: 'Search - Bay Area', negative: 'jobs', matchType: 'PHRASE' } },
    { status: 'approved', type: 'pause_keyword', target: { campaignName: 'Search - Bay Area', keyword: 'we buy houses', criteria: [{ adGroupName: 'Core', matchType: 'PHRASE' }] } },
    { status: 'approved', type: 'location_bid', change: { value: -30 }, target: { campaignName: 'Search - Bay Area', city: 'Fremont', st: 'CA' } },
    { status: 'rejected', type: 'add_negative', target: { campaignName: 'X', negative: 'nope', matchType: 'EXACT' } },
  ]));
  assert.deepEqual(editor[0], ['Campaign', 'Ad group', 'Keyword', 'Criterion Type', 'Status', 'Final URL', 'Location', 'Bid adjustment']);
  assert.deepEqual(editor[1].slice(0, 4), ['Search - Bay Area', '', '"jobs"', 'Campaign negative']);
  assert.equal(editor[2][4], 'Paused');
  assert.equal(editor[3][7], '-30%');
  assert.equal(editor.length, 4, 'rejected actions are not exported');
});
