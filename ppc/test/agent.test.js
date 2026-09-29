// Sync agent: configuration, safe logging, session encryption, scheduling,
// notifications, the Google Ads / GA4 connectors against mocked APIs, REI
// file imports, the page scan and the sync orchestration. No network, no
// browser (the crawler is tested in e2e/crawler.e2e.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { missingSetup, readConfig, sourceConfigured } from '../agent/config.js';
import { redact, createLogger } from '../agent/log.js';
import { decryptJson, encryptJson, parseKey } from '../agent/secure.js';
import { cronMatches, nextRun, parseCron } from '../agent/scheduler.js';
import { sendAlerts } from '../agent/notify.js';
import { adsWindow, createGoogleAdsClient, explainGoogleAdsError, syncGoogleAds } from '../agent/connectors/googleAds.js';
import { serviceAccountJwt, syncGa4 } from '../agent/connectors/ga4.js';
import { importReiExportFolder, importReiSheet } from '../agent/connectors/reiFiles.js';
import { allowedUrl, parsePage, scanPages } from '../agent/connectors/site.js';
import { CrawlerError, parseUsAddress } from '../agent/connectors/reiCrawler.js';
import { runSync } from '../agent/sync.js';
import { validateDataset } from '../engine/index.js';

const KEY = 'a'.repeat(64);
const tmp = () => mkdtempSync(path.join(tmpdir(), 'ppc-agent-'));
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
const configFor = (dir, env = {}) => readConfig({ PPC_DATA_DIR: dir, PPC_BUNDLE_DIR: path.join(dir, 'drive'), ...env }, { loadDotEnv: false });

// ---------------------------------------------------------------- config + logging + crypto
test('config: reads env, reports what is missing, never needs secrets in code', () => {
  const cfg = readConfig({ GOOGLE_ADS_CUSTOMER_ID: '123-456-7890', GOOGLE_ADS_LOGIN_CUSTOMER_ID: '111-222-3333', REI_CRAWL_DELAY_MS: '200' }, { loadDotEnv: false });
  assert.equal(cfg.googleAds.customerId, '1234567890');
  assert.equal(cfg.googleAds.loginCustomerId, '1112223333');
  assert.equal(cfg.rei.delayMs, 1000, 'crawler delay never below 1 second');
  assert.equal(cfg.googleAds.backfillDays, 90);
  assert.equal(sourceConfigured.google_ads(cfg), false);
  const missing = missingSetup(cfg).filter((m) => !m.ok).map((m) => m.what);
  assert.ok(missing.includes('GOOGLE_ADS_DEVELOPER_TOKEN'));
  assert.ok(missing.includes('PPC_BUNDLE_DIR'));
});

test('logs redact tokens, keys, passwords, emails and phone numbers', () => {
  // Built at runtime so secret scanners do not mistake the fake key for a real one.
  const pem = (label) => `-----BEGIN ${label}-----\nMIIE\n-----END ${label}-----`;
  const out = redact({
    message: 'Bearer ya29.abc.def failed for pat@example.com (415) 555-0100',
    refresh_token: '1//0abcdefghijklmnopqrstuvwxyz', nested: { password: 'hunter2', note: 'ok' },
    key: pem('PRIVATE KEY'),
  });
  const text = JSON.stringify(out);
  for (const secret of ['ya29.abc', 'pat@example.com', '555-0100', '1//0abc', 'hunter2', 'MIIE']) assert.ok(!text.includes(secret), secret);
  assert.equal(out.nested.note, 'ok');
  const dir = tmp();
  createLogger(dir, { quiet: true }).info('x', { message: 'token Bearer abc.def', password: 'p' });
});

test('REI session encryption: round trip, wrong key rejected, key format checked', () => {
  const box = encryptJson({ cookies: [{ name: 'sid', value: 's3cret' }] }, KEY);
  assert.ok(!box.includes('s3cret'));
  assert.equal(decryptJson(box, KEY).cookies[0].value, 's3cret');
  assert.throws(() => decryptJson(box, 'b'.repeat(64)));
  assert.throws(() => parseKey('short'));
  assert.equal(parseKey(''), null);
});

// ---------------------------------------------------------------- scheduling + notifications
test('cron: parse, match in the team time zone, next run', () => {
  const c = parseCron('15 5 * * 1-5');
  assert.ok(c.minute.has(15) && c.hour.has(5) && c.dow.has(1) && !c.dow.has(0));
  // 05:15 in Los Angeles on Mon 2026-09-28 is 12:15 UTC (PDT).
  assert.equal(cronMatches(c, new Date('2026-09-28T12:15:00Z'), 'America/Los_Angeles'), true);
  assert.equal(cronMatches(c, new Date('2026-09-28T05:15:00Z'), 'America/Los_Angeles'), false);
  assert.equal(cronMatches('*/15 * * * *', new Date('2026-09-28T10:30:00Z')), true);
  assert.equal(cronMatches('5 */4 * * *', new Date('2026-09-28T08:05:00Z')), true);
  assert.equal(nextRun('0 6 * * *', new Date('2026-09-28T05:59:00Z')).toISOString(), '2026-09-28T06:00:00.000Z');
  assert.throws(() => parseCron('61 * * * *'));
  assert.throws(() => parseCron('* * *'));
});

test('alerts go to the webhook once each; failures are retried next time', async () => {
  const calls = [];
  let fail = false;
  const fetchImpl = async (url, opts) => { calls.push(JSON.parse(opts.body)); return { ok: !fail, status: fail ? 500 : 200 }; };
  const cfg = { alertWebhook: 'https://chat.example/hook' };
  const state = { alerts: { sent: {} } };
  const alerts = [{ id: 'a1', severity: 'high', title: 'REI crawler failed', detail: 'step login' }, { id: 'a2', severity: 'low', title: 'New contract', detail: 'Lead 1' }];
  assert.equal((await sendAlerts(cfg, alerts, state, { fetchImpl })).sent, 2);
  assert.match(calls[0].text, /REI crawler failed/);
  assert.equal((await sendAlerts(cfg, alerts, state, { fetchImpl })).sent, 0, 'not sent twice');
  fail = true;
  const r = await sendAlerts(cfg, [{ id: 'a3', severity: 'medium', title: 't', detail: 'd' }], state, { fetchImpl });
  assert.equal(r.failed, 1);
  assert.ok(!state.alerts.sent.a3, 'a failed send is not marked as sent');
});

// ---------------------------------------------------------------- Google Ads API (mocked)
function fakeGoogleAds({ failFirst = null } = {}) {
  const seen = [];
  let failed = false;
  const fetchImpl = async (url, opts) => {
    if (url.includes('oauth2.googleapis.com/token')) return json({ access_token: 'ya29.test-token', expires_in: 3600 });
    const { query } = JSON.parse(opts.body);
    seen.push({ url, query, headers: opts.headers });
    if (failFirst && !failed) { failed = true; return json(failFirst.body, failFirst.status); }
    const d = /segments\.date = '([\d-]+)'/.exec(query)?.[1] || '2026-09-27';
    if (query.includes('FROM campaign ')) return json([{ results: [{ campaign: { id: '11', name: 'Search - Bay Area', status: 'ENABLED' } }] }]);
    if (query.includes('FROM ad_group ')) return json([{ results: [{ campaign: { id: '11' }, adGroup: { id: '22', name: 'Inherited', status: 'ENABLED' } }] }]);
    if (query.includes('FROM keyword_view')) return json([{ results: [{ campaign: { id: '11' }, adGroup: { id: '22' }, adGroupCriterion: { criterionId: '33', keyword: { text: 'sell inherited house', matchType: 'PHRASE' }, status: 'ENABLED', finalUrls: ['https://twinhomebuyer.com/sell-inherited-house'] }, segments: { date: '2026-09-27', device: 'MOBILE' }, metrics: { impressions: '50', clicks: '2', costMicros: '90000000', conversions: 1 } }] }]);
    if (query.includes('FROM search_term_view')) return json([{ results: [{ searchTermView: { searchTerm: 'sell inherited house san jose' }, campaign: { id: '11' }, adGroup: { id: '22' }, segments: { date: '2026-09-27', keyword: { adGroupCriterion: 'customers/1/adGroupCriteria/22~33' } }, metrics: { clicks: '2', costMicros: '90000000' } }] }]);
    if (query.includes('FROM geographic_view')) return json([{ results: [{ geographicView: { locationType: 'LOCATION_OF_PRESENCE' }, campaign: { id: '11' }, adGroup: { id: '22' }, segments: { date: '2026-09-27', geoTargetCity: 'geoTargetConstants/1014226' }, metrics: { clicks: '2', costMicros: '90000000' } }] }]);
    if (query.includes('FROM click_view')) return json(d === '2026-09-27' ? [{ results: [{ clickView: { gclid: 'GC1', keyword: 'customers/1/adGroupCriteria/22~33', locationOfPresence: { city: 'geoTargetConstants/1014226' } }, campaign: { id: '11' }, adGroup: { id: '22' }, segments: { date: d, device: 'MOBILE' } }] }] : [{ results: [] }]);
    if (query.includes('FROM geo_target_constant')) return json([{ results: [{ geoTargetConstant: { id: '1014226', name: 'San Jose', canonicalName: 'San Jose,California,United States', targetType: 'City' } }] }]);
    if (query.includes('FROM ad_group_ad')) return json([{ results: [{ adGroup: { id: '22' }, adGroupAd: { ad: { id: '44', responsiveSearchAd: { headlines: [{ text: 'We Buy Inherited Houses' }] }, finalUrls: ['https://twinhomebuyer.com/sell-inherited-house'] } } }] }]);
    return json([{ results: [] }]);
  };
  return { fetchImpl, seen };
}
const adsCfg = { developerToken: 'dev-token', clientId: 'cid', clientSecret: 'csecret', refreshToken: '1//refresh', customerId: '1234567890', loginCustomerId: '9998887777', apiVersion: 'v25', backfillDays: 90, lookbackDays: 3, endpoint: 'https://googleads.googleapis.com' };

test('Google Ads: first run backfills 90 days; later runs re-pull the last 3 days', () => {
  assert.deepEqual(adsWindow(adsCfg, {}, '2026-09-28'), { start: '2026-07-01', end: '2026-09-28' });
  assert.deepEqual(adsWindow(adsCfg, { lastSyncedThrough: '2026-09-27' }, '2026-09-28'), { start: '2026-09-25', end: '2026-09-28' });
});

test('Google Ads: pulls every report read-only, one click_view query per day, headers set', async () => {
  const { fetchImpl, seen } = fakeGoogleAds();
  const client = createGoogleAdsClient(adsCfg, { fetchImpl, sleep: async () => {} });
  const state = { lastSyncedThrough: '2026-09-26' };
  const r = await syncGoogleAds(adsCfg, state, { client, today: '2026-09-28' });
  assert.equal(r.ads.keywords[0].id, '22~33');
  assert.equal(r.ads.keywordDaily[0].cost, 90);
  assert.equal(r.ads.clicks[0].gclid, 'GC1');
  assert.equal(r.ads.clicks[0].city, 'San Jose');
  assert.equal(r.ads.geoDaily[0].city, 'San Jose');
  assert.deepEqual(r.ads.adCopy[0].headlines, ['We Buy Inherited Houses']);
  const clickQueries = seen.filter((x) => x.query.includes('FROM click_view'));
  assert.equal(clickQueries.length, 5, 'Sep 24-26 re-pulled (3 days) + Sep 27-28 new, one day each');
  assert.ok(clickQueries.every((x) => /segments\.date = '/.test(x.query)));
  assert.ok(seen.every((x) => !/\b(mutate|UPDATE|INSERT|REMOVE)\b/i.test(x.url + x.query.replace(/!= 'REMOVED'/g, ''))), 'read only');
  assert.equal(seen[0].headers['developer-token'], 'dev-token');
  assert.equal(seen[0].headers['login-customer-id'], '9998887777');
  assert.match(seen[0].url, /\/v25\/customers\/1234567890\/googleAds:searchStream$/);
  assert.equal(state.lastSyncedThrough, '2026-09-28');
});

test('Google Ads: failed API responses become plain instructions; quota errors retry', async () => {
  const body = (code) => ({ error: { code: 403, message: 'x', details: [{ errors: [{ errorCode: code, message: 'm' }] }] } });
  assert.match(explainGoogleAdsError(403, body({ authorizationError: 'DEVELOPER_TOKEN_NOT_APPROVED' }), adsCfg).message, /test access/);
  assert.match(explainGoogleAdsError(403, body({ authorizationError: 'USER_PERMISSION_DENIED' }), adsCfg).message, /GOOGLE_ADS_LOGIN_CUSTOMER_ID/);
  assert.match(explainGoogleAdsError(401, {}, adsCfg).message, /ppc:google-auth/);
  assert.equal(explainGoogleAdsError(429, {}, adsCfg).retryable, true);
  const retry = fakeGoogleAds({ failFirst: { status: 429, body: {} } });
  const client = createGoogleAdsClient(adsCfg, { fetchImpl: retry.fetchImpl, sleep: async () => {} });
  const rows = await client.search('SELECT campaign.id FROM campaign ', 'test');
  assert.equal(rows.length, 1, 'succeeds after one retry');
  const denied = fakeGoogleAds({ failFirst: { status: 403, body: body({ authorizationError: 'DEVELOPER_TOKEN_NOT_APPROVED' }) } });
  const c2 = createGoogleAdsClient(adsCfg, { fetchImpl: denied.fetchImpl, sleep: async () => {} });
  await assert.rejects(() => c2.search('SELECT campaign.id FROM campaign ', 'google_ads.campaigns'), (e) => e.code === 'DEV_TOKEN_TEST' && e.step === 'google_ads.campaigns');
  const badToken = createGoogleAdsClient(adsCfg, { fetchImpl: async () => json({ error: 'invalid_grant' }, 400) });
  await assert.rejects(() => badToken.search('x', 's'), /refresh token is no longer valid/);
});

// ---------------------------------------------------------------- GA4 (mocked)
test('GA4: service-account JWT is signed correctly; reports map to landing and page rows', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const jwt = serviceAccountJwt({ client_email: 'ppc@proj.iam.gserviceaccount.com', private_key: privateKey }, 1000);
  const [hdr, claims, sig] = jwt.split('.');
  const v = createVerify('RSA-SHA256');
  v.update(`${hdr}.${claims}`);
  assert.ok(v.verify(publicKey, Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64')));
  assert.equal(JSON.parse(Buffer.from(claims, 'base64').toString()).scope, 'https://www.googleapis.com/auth/analytics.readonly');

  const dir = tmp();
  const keyFile = path.join(dir, 'sa.json');
  writeFileSync(keyFile, JSON.stringify({ client_email: 'ppc@proj.iam.gserviceaccount.com', private_key: privateKey }));
  const report = (dims, mets, rows) => json({ dimensionHeaders: dims.map((name) => ({ name })), metricHeaders: mets.map((name) => ({ name })), rows: rows.map((r) => ({ dimensionValues: r[0].map((value) => ({ value })), metricValues: r[1].map((value) => ({ value: String(value) })) })), rowCount: rows.length });
  const fetchImpl = async (url, opts) => {
    if (url.includes('oauth2')) { assert.match(opts.body, /jwt-bearer/); return json({ access_token: 't' }); }
    const b = JSON.parse(opts.body);
    const dims = b.dimensions.map((d) => d.name);
    if (dims.includes('landingPagePlusQueryString') && !dims.includes('eventName')) return report(dims, ['sessions', 'engagedSessions', 'keyEvents'], [[['20260927', '/sell-inherited-house?gclid=x', 'google', 'cpc', 'Search', 'mobile'], [10, 6, 2]]]);
    if (dims.includes('landingPagePlusQueryString')) return report(dims, ['eventCount'], [[['20260927', '/sell-inherited-house?gclid=x', 'google', 'cpc', 'form_start'], [4]]]);
    if (dims.includes('eventName')) return report(dims, ['eventCount'], [[['/sell-inherited-house', 'form_submit'], [2]]]);
    if (b.dimensionFilter) return report(dims, ['activeUsers'], [[['/sell-inherited-house'], [7]]]);
    return report(dims, ['activeUsers', 'newUsers', 'keyEvents'], [[['/sell-inherited-house'], [12, 9, 2]]]);
  };
  const r = await syncGa4({ propertyId: '123', serviceAccountFile: keyFile, lookbackDays: 30, endpoint: 'https://analyticsdata.googleapis.com' }, {}, { fetchImpl, today: '2026-09-28' });
  assert.deepEqual(r.web.landingDaily[0], { d: '2026-09-27', path: '/sell-inherited-house', source: 'google', medium: 'cpc', paid: true, campaign: 'Search', kw: '', city: '', st: '', dev: 'mobile', sessions: 10, engaged: 6, keyEvents: 2, formStarts: 4, formSubmits: 0 });
  assert.deepEqual(r.web.pagePaths[0], { path: '/sell-inherited-house', users: 12, returningUsers: 3, ppcUsers: 7, keyEvents: 2, formStarts: 0, formSubmits: 2 });
  await assert.rejects(() => syncGa4({ propertyId: '1', serviceAccountFile: keyFile, lookbackDays: 3, endpoint: 'x' }, {}, { fetchImpl: async (url) => (url.includes('oauth2') ? json({ access_token: 't' }) : json({}, 403)) }), /Property access/);
});

// ---------------------------------------------------------------- REI files + page scan
test('REI exports folder: newest file imported once; Google Sheet path', async () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'old.csv'), 'Lead ID,Created Date,Lead Status\nA,2026-09-01,New\n');
  utimesSync(path.join(dir, 'old.csv'), new Date('2026-09-01'), new Date('2026-09-01'));
  writeFileSync(path.join(dir, 'rei-export-sep28.csv'), 'Lead ID,Created Date,Lead Status,Phone,Name\nB,2026-09-27,Qualified,(415) 555-0100,Pat Doe\n');
  const state = {};
  const r = await importReiExportFolder({ exportDir: dir }, state, {});
  assert.equal(r.part.rei.leads.length, 1);
  assert.equal(r.part.rei.leads[0].id, 'B');
  assert.ok(!JSON.stringify(r.part).includes('Pat Doe'));
  assert.equal((await importReiExportFolder({ exportDir: dir }, state, {})).part, null, 'the same file is not imported twice');
  const s = await importReiSheet({ sheetId: 'x' }, { fetchRows: async () => ({ rows: [{ 'Lead ID': 'S1', 'Lead Status': 'Under Contract', 'Created Date': '2026-09-20' }] }) });
  assert.equal(s.part.rei.leads[0].contract, true);
  await assert.rejects(() => importReiSheet({ sheetId: 'x' }, { fetchRows: async () => { throw Object.assign(new Error('private'), { code: 'SHEET_PRIVATE' }); } }), /Anyone with the link/);
});

test('page scan: reads H1, title and call to action on our own domains only', async () => {
  const p = parsePage('<html><head><title>Sell Inherited | Twin</title></head><body><h1>Sell an <b>Inherited</b> House</h1><a href="/x">Blog</a><button>Get My Cash Offer</button></body></html>');
  assert.deepEqual(p, { title: 'Sell Inherited | Twin', h1: 'Sell an Inherited House', cta: 'Get My Cash Offer' });
  assert.ok(allowedUrl('https://www.twinhomebuyer.com/a', ['twinhomebuyer.com']));
  assert.ok(!allowedUrl('https://evil.example/a', ['twinhomebuyer.com']));
  const fetched = [];
  const out = await scanPages({ site: { domains: ['twinhomebuyer.com'], extraUrls: ['https://other.com/x'], delayMs: 0 } },
    { ads: { keywords: [{ finalUrl: 'https://www.twinhomebuyer.com/sell-inherited-house' }, { finalUrl: 'https://www.twinhomebuyer.com/sell-inherited-house?utm=1' }] } },
    { fetchImpl: async (url) => { fetched.push(url); return { ok: true, text: async () => '<h1>Sell an Inherited House</h1><a>Get my cash offer</a>' }; }, sleep: async () => {} });
  assert.deepEqual(fetched, ['https://www.twinhomebuyer.com/sell-inherited-house']);
  assert.equal(out.web.pages[0].cta, 'Get my cash offer');
});

test('address parsing for crawled contacts', () => {
  assert.deepEqual(parseUsAddress('123 Main St, San Jose, CA 95123'), { city: 'San Jose', state: 'CA', zip: '95123' });
  assert.deepEqual(parseUsAddress('no commas'), { city: '', state: '', zip: '' });
});

// ---------------------------------------------------------------- orchestration
test('sync: sources merge, failures are recorded with the failing step, the sync file is private', async () => {
  const dir = tmp();
  const cfg = configFor(dir, {
    GOOGLE_ADS_DEVELOPER_TOKEN: 'd', GOOGLE_ADS_CLIENT_ID: 'c', GOOGLE_ADS_CLIENT_SECRET: 's', GOOGLE_ADS_REFRESH_TOKEN: 'r', GOOGLE_ADS_CUSTOMER_ID: '1234567890',
    REI_CRAWLER_ENABLED: 'true', REIBB_EMAIL: 'x@y.z', REIBB_PASSWORD: 'p', REI_FALLBACK_AFTER_FAILURES: '2', PPC_ALERT_WEBHOOK_URL: 'https://hook.example',
  });
  const { fetchImpl } = fakeGoogleAds();
  const posted = [];
  const fetchAll = async (url, opts) => (url === 'https://hook.example' ? (posted.push(opts.body), { ok: true, status: 200 }) : fetchImpl(url, opts));
  const crawlerBroken = async () => { throw new CrawlerError('The REI contacts list did not load (search box not found).', { step: 'list.open', selector: "input[placeholder*='Search' i]" }); };
  const googleAds = (c, state, o) => syncGoogleAds(c, state, { ...o, client: createGoogleAdsClient(c, { fetchImpl, sleep: async () => {} }) });
  const now = Date.parse('2026-09-28T13:00:00Z');
  const r1 = await runSync(cfg, { fetchImpl: fetchAll, now, connectors: { googleAds, reiCrawler: crawlerBroken, pages: async () => ({ web: { pages: [] }, stats: { rows: 0 } }) } });
  const byKey = Object.fromEntries(r1.summary.map((s) => [`${s.source}:${s.mode || ''}`, s.status]));
  assert.equal(byKey['google_ads:api'], 'ok');
  assert.equal(byKey['rei:crawler'], 'failed');
  const failedRun = r1.dataset.sync.history.find((h) => h.source === 'rei' && h.status === 'failed');
  assert.equal(failedRun.errors[0].step, 'list.open');
  assert.match(failedRun.errors[0].selector, /Search/);
  assert.ok(r1.alerts.some((a) => a.type === 'crawler_failed'));
  assert.ok(posted.some((b) => /REI crawler failed/.test(b)), 'crawler failure notified');
  const bundle = JSON.parse(readFileSync(r1.files.bundle, 'utf8'));
  assert.equal(validateDataset(bundle).ok, true);
  assert.equal(bundle.isDemo, false);
  assert.ok(existsSync(path.join(dir, 'dataset.json')));
  // Second failure -> crawler paused, CSV import is the fallback.
  const r2 = await runSync(cfg, { fetchImpl: fetchAll, now: now + 3600000, connectors: { googleAds, reiCrawler: crawlerBroken, pages: async () => ({ web: { pages: [] }, stats: { rows: 0 } }) } });
  assert.equal(r2.state.rei.mode, 'csv-fallback');
  const r3 = await runSync(cfg, { fetchImpl: fetchAll, now: now + 7200000, only: ['rei'], connectors: { reiCrawler: async () => { throw new Error('must not run while paused'); } } });
  assert.equal(r3.summary.find((s) => s.source === 'rei').status, 'paused');
  assert.equal(r3.dataset.ads.keywords.length, 1, 'last good Google Ads data kept');
  // A forced run that works resumes the crawler.
  const good = async () => ({ rows: [{ 'Lead ID': '9', Name: 'Pat Doe', Phone: '(415) 555-0100', 'Lead Status': 'Qualified', 'Created Date': '2026-09-27' }], stats: { listed: 1, read: 1, failed: 0, skipped: 0, opened: 1 }, errors: [], status: 'ok' });
  const r4 = await runSync(cfg, { fetchImpl: fetchAll, now: now + 9000000, only: ['rei'], forceCrawler: true, connectors: { reiCrawler: good } });
  assert.equal(r4.state.rei.mode, 'auto');
  assert.equal(r4.dataset.rei.leads.find((l) => l.id === '9').qualified, true);
  assert.ok(!readFileSync(r4.files.bundle, 'utf8').includes('Pat Doe'));
});
