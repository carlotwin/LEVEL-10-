import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveKeywordCityDaily, markDuplicates, normalizeGaql, normalizeReiRows, parseCallsCsv, parseGa4Csv, parseGoogleAdsCsv,
  parseKeywordText, stageFromStatus,
} from '../engine/index.js';
import { CLICKS_CSV, KEYWORDS_CSV, LOCATIONS_CSV, REI_ROWS, SEARCH_TERMS_CSV } from './helpers.js';

// ---------------------------------------------------------------- Google Ads CSV

test('Google Ads CSV: detects report types and skips total rows', () => {
  const k = parseGoogleAdsCsv(KEYWORDS_CSV);
  assert.equal(k.reportType, 'keywords');
  assert.equal(k.ads.keywordDaily.length, 3);
  assert.equal(k.ads.keywords.length, 2);
  assert.equal(k.ads.keywordDaily.reduce((a, r) => a + r.cost, 0), 2370);
  assert.ok(k.warnings.some((w) => /skipped/.test(w)));
  assert.equal(parseGoogleAdsCsv(LOCATIONS_CSV).reportType, 'locations');
  assert.equal(parseGoogleAdsCsv(CLICKS_CSV).reportType, 'clicks');
  assert.equal(parseGoogleAdsCsv(SEARCH_TERMS_CSV).reportType, 'search_terms');
});

test('Google Ads CSV: the same keyword gets the same id in every report', () => {
  const kw = parseGoogleAdsCsv(KEYWORDS_CSV).ads.keywords;
  const clicks = parseGoogleAdsCsv(CLICKS_CSV).ads.clicks;
  const inherited = kw.find((k) => k.text === 'sell inherited house');
  assert.equal(inherited.matchType, 'EXACT');
  assert.equal(clicks.find((c) => c.gclid === 'G1').k, inherited.id);
});

test('Google Ads CSV: keyword syntax and match types', () => {
  assert.deepEqual(parseKeywordText('[sell my house]'), { text: 'sell my house', matchType: 'EXACT' });
  assert.deepEqual(parseKeywordText('"we buy houses"'), { text: 'we buy houses', matchType: 'PHRASE' });
  assert.deepEqual(parseKeywordText('+cash +offer'), { text: 'cash offer', matchType: 'BROAD' });
  assert.deepEqual(parseKeywordText('sell house', 'Phrase match'), { text: 'sell house', matchType: 'PHRASE' });
});

test('Google Ads CSV: without a Day column rows are dated at the end of the report period', () => {
  const csv = `Keyword report\n"September 1, 2026 - September 27, 2026"\nCampaign,Ad group,Keyword,Clicks,Cost\nA,G,sell house,3,90\n`;
  const r = parseGoogleAdsCsv(csv);
  assert.equal(r.ads.keywordDaily[0].d, '2026-09-27');
  assert.ok(r.warnings.some((w) => /No "Day" column/.test(w)));
});

test('Google Ads CSV: an unrelated file is rejected with a clear message', () => {
  const r = parseGoogleAdsCsv('name,color\nx,red\n');
  assert.equal(r.reportType, 'unknown');
  assert.match(r.warnings[0], /No Google Ads header row/);
});

// ---------------------------------------------------------------- Google Ads API

test('Google Ads API rows (GAQL REST JSON) normalize to the same shape', () => {
  const ads = normalizeGaql({
    campaigns: [{ campaign: { id: '11', name: 'Search - Bay Area', status: 'ENABLED' } }],
    adGroups: [{ adGroup: { id: '22', name: 'Inherited', status: 'ENABLED' }, campaign: { id: '11' } }],
    keywordView: [{
      campaign: { id: '11' }, adGroup: { id: '22' },
      adGroupCriterion: { criterionId: '33', keyword: { text: 'sell inherited house', matchType: 'EXACT' }, status: 'ENABLED', finalUrls: ['https://x.com/inherited'] },
      segments: { date: '2026-09-01', device: 'MOBILE' }, metrics: { impressions: '100', clicks: '8', costMicros: '420000000', conversions: 2 },
    }],
    geographicView: [
      { geographicView: { locationType: 'LOCATION_OF_PRESENCE' }, campaign: { id: '11' }, adGroup: { id: '22' }, segments: { date: '2026-09-01', geoTargetCity: 'geoTargetConstants/1014221' }, metrics: { clicks: '8', costMicros: '420000000' } },
      { geographicView: { locationType: 'AREA_OF_INTEREST' }, campaign: { id: '11' }, adGroup: { id: '22' }, segments: { date: '2026-09-01', geoTargetCity: 'geoTargetConstants/1014221' }, metrics: { clicks: '8', costMicros: '420000000' } },
    ],
    clickView: [{ clickView: { gclid: 'GX', keyword: 'customers/1/adGroupCriteria/22~33', locationOfPresence: { city: 'geoTargetConstants/1014221' } }, campaign: { id: '11' }, adGroup: { id: '22' }, segments: { date: '2026-09-01', device: 'MOBILE' } }],
    geoConstants: [{ geoTargetConstant: { id: '1014221', name: 'San Francisco', canonicalName: 'San Francisco,California,United States' } }],
  });
  assert.equal(ads.keywords[0].id, '22~33');
  assert.equal(ads.keywords[0].finalUrl, 'https://x.com/inherited');
  assert.equal(ads.keywordDaily[0].cost, 420);
  assert.equal(ads.keywordDaily[0].dev, 'mobile');
  assert.equal(ads.geoDaily.length, 1, 'area-of-interest rows are ignored');
  assert.equal(ads.geoDaily[0].city, 'San Francisco');
  assert.equal(ads.clicks[0].k, '22~33');
  assert.equal(ads.clicks[0].city, 'San Francisco');
});

test('keyword x city spend: matches both Google totals, follows click locations, remainder to unknown city', () => {
  const keywords = [
    { id: 'k1', campaignId: 'c', adGroupId: 'g', text: 'a' },
    { id: 'k2', campaignId: 'c', adGroupId: 'g', text: 'b' },
  ];
  const keywordDaily = [
    { d: '2026-09-01', k: 'k1', imp: 10, clk: 4, cost: 100, conv: 0 },
    { d: '2026-09-01', k: 'k2', imp: 10, clk: 4, cost: 100, conv: 0 },
  ];
  const geoDaily = [
    { d: '2026-09-01', c: 'c', g: 'g', city: 'Oakland', st: 'CA', imp: 10, clk: 4, cost: 120, conv: 0 },
    { d: '2026-09-01', c: 'c', g: '', city: 'Oakland', st: 'CA', imp: 99, clk: 99, cost: 999, conv: 0 }, // campaign-level duplicate: skipped
  ];
  const clicks = [
    { d: '2026-09-01', k: 'k1', city: 'Oakland', st: 'CA' },
    { d: '2026-09-01', k: 'k1', city: 'Oakland', st: 'CA' },
    { d: '2026-09-01', k: 'k1', city: 'Oakland', st: 'CA' },
    { d: '2026-09-01', k: 'k2', city: 'Oakland', st: 'CA' },
  ];
  const rows = deriveKeywordCityDaily({ keywords, keywordDaily, geoDaily, clicks });
  const get = (k, city) => rows.find((r) => r.k === k && r.city === city);
  const sum = (pick) => rows.reduce((a, r) => a + pick(r), 0);
  // Clicks follow the click report exactly: 3 of k1's clicks and 1 of k2's were in Oakland.
  assert.equal(get('k1', 'Oakland').clk, 3);
  assert.equal(get('k2', 'Oakland').clk, 1);
  assert.equal(get('k1', 'Oakland').est, 'allocated');
  // Spend: Oakland total ($120) and each keyword total ($100) both match.
  assert.ok(Math.abs(get('k1', 'Oakland').cost + get('k2', 'Oakland').cost - 120) < 0.02);
  assert.ok(Math.abs(get('k1', 'Oakland').cost + get('k1', '').cost - 100) < 0.02);
  assert.ok(get('k1', 'Oakland').cost > get('k2', 'Oakland').cost, 'k1 had more Oakland clicks');
  assert.equal(get('k2', '').est, 'no_city');
  assert.ok(Math.abs(sum((r) => r.cost) - 200) < 0.02, 'no spend is created or lost');
  assert.ok(Math.abs(sum((r) => r.clk) - 8) < 0.01, 'no clicks are created or lost');

  const noClicks = deriveKeywordCityDaily({ keywords, keywordDaily, geoDaily: [geoDaily[0]], clicks: [] });
  assert.ok(Math.abs(noClicks.find((r) => r.k === 'k1' && r.city === 'Oakland').cost - 60) < 0.02, 'spend share when no click locations');

  const uncovered = deriveKeywordCityDaily({ keywords, keywordDaily, geoDaily: [], clicks: [] });
  assert.equal(uncovered.length, 2);
  assert.ok(uncovered.every((r) => r.city === '' && r.est === 'no_city'));
});

// ---------------------------------------------------------------- REI

test('REI rows: statuses map to a cumulative funnel; lost and junk handled', async () => {
  const { leads, warnings } = await normalizeReiRows(REI_ROWS);
  const by = Object.fromEntries(leads.map((l) => [l.id, l]));
  assert.equal(by.L1.stage, 'contract');
  assert.ok(by.L1.qualified && by.L1.appointment && by.L1.offer && by.L1.contract && !by.L1.closed);
  assert.equal(by.L2.lost, true);
  assert.equal(by.L2.qualified, false, '"Not Interested" is not qualified');
  assert.equal(by.L3.qualified, false, '"Unqualified" is not qualified');
  assert.equal(by.L5.stage, 'appointment');
  assert.equal(by.L1.situation, 'inherited_probate');
  assert.ok(!warnings.some((w) => /No lead ID/.test(w)));
  assert.equal(stageFromStatus('Closed - Won'), 'closed');
  assert.equal(stageFromStatus('Contract Cancelled'), 'lost');
  assert.equal(stageFromStatus('Wrong number'), 'lost');
});

test('REI rows: personal details are never stored, only salted hashes', async () => {
  const { leads } = await normalizeReiRows([{ 'Lead ID': 'X', Name: 'Pat Doe', Email: 'Pat@Example.com', Phone: '(415) 555-0100', 'Property Address': '12 Oak St', City: 'Oakland', Notes: 'Call Pat at 415-555-0100, inherited' }]);
  const json = JSON.stringify(leads[0]);
  assert.ok(!/Pat|example|555-0100|Oak St/i.test(json), json);
  assert.match(leads[0].phoneHash, /^[0-9a-f]{64}$/);
  assert.match(leads[0].emailHash, /^[0-9a-f]{64}$/);
  assert.equal(leads[0].situation, 'inherited_probate', 'notes still classify the situation');
});

test('REI rows: junk leads are never qualified; score threshold qualifies', async () => {
  const { leads } = await normalizeReiRows([
    { 'Lead ID': 'J', 'Lead Status': 'Dead', 'Lost Reason': 'Wholesaler, not a seller', Score: '9' },
    { 'Lead ID': 'S', 'Lead Status': 'Working', Score: '8' },
  ]);
  const by = Object.fromEntries(leads.map((l) => [l.id, l]));
  assert.equal(by.J.junk, 'wholesaler');
  assert.equal(by.J.qualified, false);
  assert.equal(by.S.qualified, true);
});

test('REI rows: missing columns produce warnings, unknown statuses are reported', async () => {
  const r = await normalizeReiRows([{ Phone: '4155550100', Status: 'Pending Review' }]);
  assert.equal(r.leads.length, 1);
  assert.ok(r.warnings.some((w) => /No lead ID/.test(w)));
  assert.ok(r.warnings.some((w) => /No created-date/.test(w)));
  assert.ok(r.warnings.some((w) => /No GCLID or UTM/.test(w)));
  assert.deepEqual(r.unmappedStatuses, { 'Pending Review': 1 });
});

test('REI duplicates: same phone within 60 days is a duplicate of the first lead', async () => {
  const { leads } = await normalizeReiRows(REI_ROWS);
  assert.equal(markDuplicates(leads), 1);
  assert.equal(leads.find((l) => l.id === 'L4').duplicateOf, 'L1');
  const again = await normalizeReiRows([
    { 'Lead ID': 'A', 'Created Date': '2026-01-01', Phone: '4155550111' },
    { 'Lead ID': 'B', 'Created Date': '2026-06-01', Phone: '4155550111' },
  ]);
  assert.equal(markDuplicates(again.leads), 0, 'more than 60 days apart is a new inquiry');
});

// ---------------------------------------------------------------- GA4 + calls

test('GA4 CSV: comment lines dropped, paid traffic flagged, paths cleaned', () => {
  const csv = `# GA4 export\n# Start date: 20260901\nDate,Landing page + query string,Session source / medium,Sessions,Key events\n20260901,/sell-inherited-house?gclid=1,google / cpc,10,2\n20260901,/,google / organic,5,0\n`;
  const r = parseGa4Csv(csv);
  assert.equal(r.kind, 'landing');
  assert.equal(r.landingDaily[0].path, '/sell-inherited-house');
  assert.equal(r.landingDaily[0].paid, true);
  assert.equal(r.landingDaily[1].paid, false);
});

test('Call log CSV: caller hashed, tracking number kept, duration parsed', async () => {
  const r = await parseCallsCsv('Call ID,Start Time,Caller Number,Tracking Number,Duration,Source\nc1,2026-09-02 10:00,(415) 555-0100,(415) 555-9999,3:25,Google Ads\n');
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].durationSec, 205);
  assert.equal(r.calls[0].trackingNumber, '4155559999');
  assert.ok(!JSON.stringify(r.calls[0]).includes('5550100'));
});
