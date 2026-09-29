// End-to-end: the REI crawler in Chromium against a mock REI BlackBook site.
//   npm run ppc:e2e
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { crawlRei, loadSelectors } from '../../agent/connectors/reiCrawler.js';
import { normalizeReiRows } from '../../engine/index.js';
import { createMockReiSite } from '../fixtures/mock-rei-site.mjs';

const SELECTORS = loadSelectors(new URL('../../config/rei-crawler.selectors.json', import.meta.url));
const KEY = 'c'.repeat(64);
let exe;
const launch = async ({ headless }) => {
  try {
    return await chromium.launch({ headless, ...(exe ? { executablePath: exe } : {}) });
  } catch (e) {
    exe = [process.env.PPC_CHROMIUM, '/opt/pw-browsers/chromium'].filter(Boolean).find((p) => existsSync(p));
    if (!exe) throw e;
    return chromium.launch({ headless, executablePath: exe });
  }
};
async function site(opts) {
  const s = createMockReiSite(opts);
  await new Promise((r) => s.server.listen(0, r));
  const base = `http://localhost:${s.server.address().port}`;
  return { ...s, base, close: () => s.server.close() };
}
const cfgFor = (base, extra = {}) => ({
  loginUrl: `${base}/services/account/login`, email: 'team@example.com', password: 'right-password', headless: true, persistSession: false,
  delayMs: 250, maxPages: 10, maxContacts: 50, recrawlHours: 24, tag: '', timeoutMs: 5000, ...extra,
});

test('crawls the contacts list across pages and reads each contact by label, slowly', async () => {
  const s = await site({ contacts: 5, perPage: 3 });
  try {
    const state = {};
    const out = await crawlRei(cfgFor(s.base), { selectors: SELECTORS, state, launch });
    assert.equal(out.status, 'ok');
    assert.equal(out.stats.pages, 2);
    assert.equal(out.stats.listed, 5);
    assert.equal(out.rows.length, 5);
    const r = out.rows.find((x) => x['Lead ID'] === '1001');
    assert.equal(r['Lead Status'], 'Qualified');
    assert.equal(r['Lead Source'], 'Google Ads');
    assert.equal(r.City, 'San Jose');
    assert.equal(r.GCLID, 'GC0');
    // Rate limit: contact pages are at least the configured delay apart.
    const detail = s.hits.filter((h) => /^\/contacts\/\d+$/.test(h.path)).map((h) => h.at);
    for (let i = 1; i < detail.length; i += 1) assert.ok(detail[i] - detail[i - 1] >= 240, `gap ${detail[i] - detail[i - 1]}ms`);
    // Personal details are hashed by the importer, never kept.
    const { leads } = await normalizeReiRows(out.rows, { sourceSystem: 'rei_crawler' });
    assert.ok(!JSON.stringify(leads).match(/Demo Seller|555-01|example\.com|Demo Street/));
    assert.equal(leads.find((l) => l.id === '1003').contract, true);
    // Incremental: nothing is due again within REI_RECRAWL_HOURS.
    const again = await crawlRei(cfgFor(s.base), { selectors: SELECTORS, state, launch });
    assert.equal(again.stats.read, 0);
    assert.equal(again.stats.skipped, 5);
  } finally { s.close(); }
});

test('a renamed field stops that field and names the label that failed', async () => {
  const s = await site({ contacts: 2, broken: true });
  try {
    await assert.rejects(() => crawlRei(cfgFor(s.base), { selectors: SELECTORS, state: {}, launch }), (e) => {
      assert.equal(e.step, 'contact.detail');
      assert.match(e.errors[0].selector, /Lead Status/);
      assert.match(e.errors[0].message, /rei-crawler\.selectors\.json/);
      return true;
    });
  } finally { s.close(); }
});

test('MFA: the crawler stops and asks for a person; it never bypasses it', async () => {
  const s = await site({ mfa: true });
  try {
    await assert.rejects(() => crawlRei(cfgFor(s.base), { selectors: SELECTORS, launch }), (e) => e.code === 'MANUAL_LOGIN_REQUIRED' && e.step === 'login.mfa' && /ppc:rei-login/.test(e.message));
  } finally { s.close(); }
});

test('CAPTCHA: the crawler stops before touching the form', async () => {
  const s = await site({ captcha: true });
  try {
    await assert.rejects(() => crawlRei(cfgFor(s.base), { selectors: SELECTORS, launch }), (e) => e.code === 'MANUAL_LOGIN_REQUIRED' && e.step === 'login.captcha');
    assert.ok(!s.hits.some((h) => h.path === '/services/account/login' && h.method === 'POST'));
  } finally { s.close(); }
});

test('wrong password and missing credentials are reported plainly', async () => {
  const s = await site({});
  try {
    await assert.rejects(() => crawlRei(cfgFor(s.base, { password: 'wrong' }), { selectors: SELECTORS, launch }), (e) => e.code === 'BAD_CREDENTIALS' && e.step === 'login.rejected');
    await assert.rejects(() => crawlRei(cfgFor(s.base, { email: '', password: '' }), { selectors: SELECTORS, launch }), (e) => e.step === 'login.credentials');
  } finally { s.close(); }
});

test('session is kept only encrypted, and reused without the password', async () => {
  const s = await site({ contacts: 1 });
  const dir = mkdtempSync(path.join(tmpdir(), 'ppc-rei-'));
  const sessionFile = path.join(dir, 'rei-session.enc');
  try {
    await crawlRei(cfgFor(s.base, { persistSession: true }), { selectors: SELECTORS, launch, sessionFile, secretKey: KEY, loginOnly: true });
    const saved = readFileSync(sessionFile, 'utf8');
    assert.ok(!saved.includes('valid'), 'cookie value is not readable in the file');
    const out = await crawlRei(cfgFor(s.base, { persistSession: true, email: '', password: '' }), { selectors: SELECTORS, state: {}, launch, sessionFile, secretKey: KEY });
    assert.equal(out.rows.length, 1);
  } finally { s.close(); }
});
