import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, detectDelimiter, findHeaderRow, formatMoney, inRange, mapColumns, parseCsv, rowsToObjects, scrubText,
  sha256Hex, toCsv, toDate, toNumber, toTimestamp, weekStart, classifySituation, intentOf, geoIndex, parseLocation,
} from '../engine/index.js';

test('toNumber reads money, thousands, dashes and accounting negatives', () => {
  assert.equal(toNumber('$1,234.56'), 1234.56);
  assert.equal(toNumber('1,420.00'), 1420);
  assert.equal(toNumber('(12.50)'), -12.5);
  assert.equal(toNumber('--'), null);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber('12%'), 12);
});

test('toDate understands the formats Google Ads, GA4 and REI export', () => {
  for (const v of ['2026-09-01', 'Sep 1, 2026', 'Tue, Sep 1, 2026', '9/1/2026', '09/01/2026', '20260901', 'September 1, 2026']) {
    assert.equal(toDate(v), '2026-09-01', v);
  }
  assert.equal(toDate('June 3, 2026'), '2026-06-03');
  assert.equal(toDate(''), null);
  assert.equal(toDate('not a date'), null);
  assert.match(toTimestamp('2026-09-01 14:05'), /^2026-09-01T14:05/);
});

test('date helpers', () => {
  assert.equal(addDays('2026-09-01', -1), '2026-08-31');
  assert.equal(weekStart('2026-09-03'), '2026-08-31'); // Monday
  assert.ok(inRange('2026-09-02', '2026-09-01', '2026-09-02'));
  assert.ok(!inRange('2026-09-03', '2026-09-01', '2026-09-02'));
  assert.ok(inRange('2026-09-03', null, null));
});

test('parseCsv handles quotes, embedded commas/newlines, CRLF and BOM', () => {
  const rows = parseCsv('﻿a,b\r\n"x, y","line1\nline2"\r\n"say ""hi""",3\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'line1\nline2'], ['say "hi"', '3']]);
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(detectDelimiter('a\tb\n1\t2'), '\t');
});

test('findHeaderRow skips report titles; mapColumns maps aliases and reports gaps', () => {
  const rows = parseCsv('Keyword report\nAll time\nCampaign,Keyword,Clicks,Cost\nA,k,1,2\n');
  const i = findHeaderRow(rows, ['Campaign', 'Keyword', 'Clicks'], 2);
  assert.equal(i, 2);
  const objs = rowsToObjects(rows, i);
  assert.equal(objs[0].Keyword, 'k');
  const { mapping, missing } = mapColumns(rows[i], { campaign: ['Campaign'], spend: ['Cost', 'Spend'], gclid: ['GCLID'] });
  assert.equal(mapping.spend, 'Cost');
  assert.deepEqual(missing, ['gclid']);
});

test('toCsv neutralizes spreadsheet formulas but keeps numbers and +N% values', () => {
  const csv = toCsv([{ a: '=HYPERLINK("x")', b: '-30', c: '+20%', d: '@cmd' }]);
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /,-30,/);
  assert.match(csv, /,\+20%,/);
  assert.match(csv, /'@cmd/);
});

test('scrubText removes phones, emails and street addresses', () => {
  const t = scrubText('Call 415-555-0100 or pat@example.com; house at 1234 Oak Street needs a roof');
  assert.ok(!/555|example|1234 Oak/.test(t), t);
  assert.match(t, /needs a roof/);
});

test('sha256Hex is deterministic and salted', async () => {
  const a = await sha256Hex('4155550100');
  assert.equal(a, await sha256Hex('4155550100'));
  assert.notEqual(a, await sha256Hex('4155550100', 'other-salt'));
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('formatMoney: whole dollars at 100+, cents below, dash for missing', () => {
  assert.equal(formatMoney(1420), '$1,420');
  assert.equal(formatMoney(12.5), '$12.50');
  assert.equal(formatMoney(null), '—');
});

test('seller situation classification avoids everyday false positives', () => {
  assert.equal(classifySituation('Inherited from mom, probate done'), 'inherited_probate');
  assert.equal(classifySituation('works in real estate'), 'other');
  assert.equal(classifySituation('their house has issues'), 'other');
  assert.equal(classifySituation('Tenant not paying, tired of being a landlord'), 'tired_landlord');
  assert.equal(classifySituation('Behind on payments, notice of default'), 'financial_pressure');
  assert.equal(classifySituation('needs a new roof, sell as is'), 'major_repairs');
  assert.equal(classifySituation(''), 'unknown');
  assert.equal(intentOf('sell inherited house san francisco'), 'inherited_probate');
  assert.equal(intentOf('we buy houses'), 'general');
});

test('geo: parse Google locations, counties and buy box', () => {
  assert.deepEqual(parseLocation('San Jose, California, United States'), { city: 'San Jose', state: 'CA' });
  assert.deepEqual(parseLocation('oakland ca'), { city: 'Oakland', state: 'CA' });
  assert.deepEqual(parseLocation('(not set)'), { city: '', state: '' });
  const geo = geoIndex();
  assert.equal(geo.county('Fremont', 'CA'), 'Alameda');
  assert.equal(geo.inBuyBox('Stockton', 'CA'), false);
  assert.equal(geo.inBuyBox('Nowhere', 'CA'), null);
});
