// End-to-end: the real dashboard page in Chromium, against the local stand-in
// for the claude.ai runtime (shared store, assets, downloads, Google Drive).
//   npm run ppc:e2e
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createDashboardServer } from '../../scripts/serve-dashboard.mjs';

const PORT = 4199;
const BASE = `http://localhost:${PORT}`;
const CSV_DIR = new URL('../../demo/csv/', import.meta.url);

let server;
let browser;
const errors = [];

async function launch() {
  const candidates = [process.env.PPC_CHROMIUM, '/opt/pw-browsers/chromium'].filter(Boolean);
  try {
    return await chromium.launch();
  } catch (e) {
    const exe = candidates.find((p) => existsSync(p));
    if (!exe) throw e;
    return chromium.launch({ executablePath: exe });
  }
}
async function open(role = 'admin', { hash = 'overview', query = '', viewport = { width: 1360, height: 900 } } = {}) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${role}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/ERR_CERT|ERR_NAME|ERR_CONNECTION|Failed to load resource/.test(m.text())) errors.push(`${role}: ${m.text()}`);
  });
  await page.goto(`${BASE}/?role=${role}${query}#${hash}`);
  await page.waitForSelector('.hero-figure, .page-title', { timeout: 20000 });
  return page;
}
const tab = (page, label) => page.click(`button.tab:has-text("${label}")`);

test.before(async () => {
  server = createDashboardServer();
  await new Promise((r) => server.listen(PORT, r));
  browser = await launch();
});
test.after(async () => {
  await browser?.close();
  server?.close();
});

test('viewer: demo data is labelled, and the page is read only', async () => {
  const page = await open('viewer');
  await page.waitForSelector('#demo-banner:not([hidden])');
  assert.match(await page.textContent('#demo-banner'), /DEMO DATA/);
  assert.match(await page.textContent('.topbar-status'), /You: Viewer/);
  assert.match(await page.textContent('.hero-figure'), /^\$[\d,]+$/);
  assert.ok(await page.locator('.filters-toggle').isHidden(), 'the phone-only filter button is hidden on desktop');
  await tab(page, 'Action Queue');
  await page.waitForSelector('.action-card');
  assert.equal(await page.locator('button.btn-approve').count(), 0, 'no approve buttons for a viewer');
  await tab(page, 'Settings');
  assert.equal(await page.locator('#save-settings').count(), 0);
  assert.ok(await page.locator('#s-decision-targetCpl').isDisabled());
  await tab(page, 'Data sources');
  assert.equal(await page.locator('#import-files').count(), 0, 'no import for a viewer');
  await page.context().close();
});

test('main table: every required column, reasons, filters and CSV download', async () => {
  const page = await open('admin', { hash: 'table' });
  const headers = await page.locator('table.data thead th').allTextContents();
  for (const col of ['Keyword', 'Top search term', 'City', 'Campaign', 'Spend', 'Clicks', 'CPC', 'Leads', 'Qualified leads', 'Appointments', 'Offers', 'Contracts', 'Closed deals', 'Revenue', 'Profit', 'Cost per qualified lead', 'Cost per contract', 'Cost per deal', 'Recommendation', 'Reason']) {
    assert.ok(headers.some((x) => x.replace(/[↑↓]/g, '').trim() === col), `column ${col}`);
  }
  const firstReason = await page.locator('table.data tbody tr >> nth=0 >> td.reason').textContent();
  assert.match(firstReason, /spent/);
  const allRows = await page.locator('table.data tbody tr').count();
  // City filter.
  await page.click('details.filter:has-text("City") > summary');
  await page.click('details.filter[open] label.check-row:has-text("Stockton")');
  await page.waitForTimeout(500);
  const cities = await page.locator('table.data tbody tr:not(.pinned) td:nth-child(3)').allTextContents();
  assert.ok(cities.length > 0 && cities.length < allRows);
  assert.ok(cities.every((c) => c.startsWith('Stockton')), cities.join('|'));
  // Recommendation chips.
  await page.click('.table-tools button:has-text("PAUSE")');
  await page.waitForTimeout(300);
  const recs = await page.locator('table.data tbody tr:not(.pinned) .stamp').allTextContents();
  assert.ok(recs.length && recs.every((r) => r.includes('PAUSE')));
  // Date range: last 7 days has fewer rows than 90.
  await page.click('button:has-text("Reset filters")');
  await page.waitForTimeout(300);
  await page.selectOption('#f-date', '7');
  await page.waitForTimeout(500);
  assert.ok(await page.locator('table.data tbody tr').count() < allRows);
  await page.selectOption('#f-date', '90');
  await page.waitForTimeout(400);
  // Download.
  await page.click('button:has-text("Download CSV")');
  await page.waitForFunction(() => window.__mockDownloads?.length > 0);
  const dl = await page.evaluate(() => window.__mockDownloads[0]);
  assert.match(dl.filename, /^keyword-city-.*\.csv$/);
  assert.match(dl.text.split('\n')[0], /^Keyword,Top search term,City,County,Campaign,Spend/);
  // Row detail with lead ids only.
  await page.click('table.data tbody tr >> nth=0');
  await page.waitForSelector('#drawer:not([hidden])');
  const drawer = await page.textContent('#drawer-body');
  assert.match(drawer, /Lead ids only/);
  assert.doesNotMatch(drawer, /555-01|example\.com|Demo Street/);
  await page.context().close();
});

test('admin imports REI + Google Ads files; another viewer sees the shared data', async () => {
  const admin = await open('admin', { hash: 'sources' });
  const files = ['google-ads-keywords-DEMO.csv', 'google-ads-locations-DEMO.csv', 'google-ads-clicks-DEMO.csv', 'rei-export-DEMO.csv'].map((f) => new URL(f, CSV_DIR).pathname);
  await admin.setInputFiles('#import-files', files);
  await admin.waitForSelector('button:has-text("Add 4 files to the dashboard")', { timeout: 20000 });
  const results = await admin.textContent('.file-result:has-text("rei-export-DEMO.csv")');
  assert.match(results, /REI BlackBook export/);
  await admin.click('button:has-text("Add 4 files to the dashboard")');
  await admin.waitForSelector('.note-good', { timeout: 20000 });
  await admin.waitForSelector('#demo-banner[hidden]', { state: 'attached' });
  assert.match(await admin.textContent('.topbar-status'), /Live data/);
  const state = await (await fetch(`${BASE}/__mock/state`)).json();
  assert.ok(state.docs['config/dataset'].data.assetId, 'dataset pointer saved');
  assert.equal(state.docs['config/dataset'].data.isDemo, false);
  assert.ok(Object.keys(state.docs).some((k) => k.startsWith('imports/')), 'import logged');
  // The uploaded dataset holds no personal details.
  const blob = await (await fetch(`${BASE}/_blob/${state.docs['config/dataset'].data.assetId}`)).text();
  assert.doesNotMatch(blob, /Demo Seller|555-01|example\.com|Demo Street/);
  const viewer = await open('viewer');
  await viewer.waitForFunction(() => /Live data/.test(document.querySelector('.topbar-status')?.textContent || ''), null, { timeout: 15000 });
  assert.ok(await viewer.locator('#demo-banner').isHidden());
  await viewer.context().close();
  // Undo brings the demo back.
  await admin.click('button:has-text("Undo last change")');
  await admin.waitForSelector('#demo-banner:not([hidden])', { timeout: 15000 });
  await admin.context().close();
});

test('manager approves an action; the decision is shared and attributed; settings stay admin-only', async () => {
  const manager = await open('manager', { hash: 'actions' });
  await manager.waitForSelector('.action-card');
  const first = manager.locator('.action-card >> nth=0');
  const summary = await first.locator('.action-summary').textContent();
  await first.locator('input.note-input').fill('Checked with Juan');
  await first.locator('button.btn-approve').click();
  await manager.waitForFunction((s) => ![...document.querySelectorAll('.action-card .action-summary')].some((e) => e.textContent === s), summary, { timeout: 10000 });
  await manager.click('.seg button:has-text("Approved")');
  await manager.waitForSelector(`.action-card:has-text(${JSON.stringify(summary)})`);
  const text = await manager.textContent(`.action-card:has-text(${JSON.stringify(summary)})`);
  assert.match(text, /Approved by you/);
  assert.match(text, /Checked with Juan/);
  // Settings: no save button, and a direct write is refused by the store rules.
  await tab(manager, 'Settings');
  assert.equal(await manager.locator('#save-settings').count(), 0);
  const refused = await manager.evaluate(async () => {
    const db = await window.claude.use('db');
    try { await db.doc('config/settings').set({ decision: { targetCpl: 1 } }); return false; } catch (e) { return e.code; }
  });
  assert.equal(refused, 'invalid_argument');
  await manager.context().close();
  const admin = await open('admin', { hash: 'actions' });
  await admin.click('.seg button:has-text("Approved")');
  await admin.waitForSelector(`.action-card:has-text(${JSON.stringify(summary)})`);
  assert.match(await admin.textContent(`.action-card:has-text(${JSON.stringify(summary)})`), /Approved by Morgan Manager/);
  // Editor export contains the approved change.
  await admin.click('button:has-text("Google Ads Editor file (CSV)")');
  await admin.waitForFunction(() => window.__mockDownloads?.length > 0);
  const editor = await admin.evaluate(() => window.__mockDownloads.at(-1).text);
  assert.match(editor.split('\n')[0], /^Campaign,Ad group,Keyword,Criterion Type,Status,Final URL,Location,Bid adjustment/);
  assert.ok(editor.trim().split('\n').length >= 2, 'approved action exported');
  await admin.context().close();
});

test('admin changes a target in Settings and the recommendations follow', async () => {
  const admin = await open('admin', { hash: 'table' });
  const before = await admin.locator('table.data tbody .stamp:has-text("PAUSE")').count();
  await tab(admin, 'Settings');
  await admin.fill('#s-decision-pauseSpendNoQualified', '100000');
  await admin.fill('#s-decision-pauseSpendNoLeads', '100000');
  await admin.fill('#s-decision-outsideBuyBoxShare', '100');
  await admin.fill('#s-decision-minSpendOutsideBuyBox', '100000');
  await admin.click('#save-settings');
  await admin.waitForTimeout(1200);
  await tab(admin, 'Keyword + city');
  await admin.waitForTimeout(500);
  const after = await admin.locator('table.data tbody .stamp:has-text("PAUSE")').count();
  assert.ok(before > 0 && after < before, `PAUSE rows ${before} -> ${after}`);
  await tab(admin, 'Settings');
  await admin.click('button:has-text("Back to defaults")');
  await admin.waitForTimeout(1200);
  await admin.context().close();
});

test('Google Drive: find sync files and import one; connector errors explain the fix', async () => {
  const admin = await open('admin', { hash: 'sources' });
  await admin.fill('#drive-search', 'landing-pages');
  await admin.click('#drive-search-go');
  await admin.waitForSelector('.list-row:has-text("landing-pages-DEMO.csv") button:has-text("Import")');
  await admin.click('.list-row:has-text("landing-pages-DEMO.csv") button:has-text("Import")');
  await admin.waitForSelector('.file-result:has-text("Landing page list")', { timeout: 15000 });
  await admin.context().close();
  const broken = await open('admin', { hash: 'sources', query: '&drive=reauth' });
  await broken.click('button:has-text("Find sync files")');
  await broken.waitForFunction(() => /Reconnect Google Drive/.test(document.body.textContent));
  await broken.context().close();
});

test('without the claude.ai runtime the page still works, read only, on demo data', async () => {
  const page = await open('viewer', { query: '&mock=0' });
  assert.match(await page.textContent('#demo-banner'), /DEMO DATA/);
  assert.match(await page.textContent('.topbar-status'), /You: Viewer/);
  await tab(page, 'Data sources');
  assert.match(await page.textContent('.view'), /cannot save shared data/);
  await page.context().close();
});

test('phone width: no sideways scrolling, filters fold behind one button', async () => {
  const page = await open('viewer', { viewport: { width: 390, height: 844 } });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `overflow ${overflow}px`);
  assert.ok(await page.locator('.filters-toggle').isVisible());
  assert.ok(await page.locator('#filter-items').isHidden());
  await page.click('.filters-toggle');
  assert.ok(await page.locator('#filter-items').isVisible());
  await page.context().close();
});

test('no page errors in any view', async () => {
  const page = await open('admin');
  for (const label of ['Keyword + city', 'Search terms', 'Landing pages', 'Retargeting', 'Action Queue', 'Data health', 'Data sources', 'Settings', 'Overview']) {
    await tab(page, label);
    await page.waitForTimeout(250);
    assert.equal(await page.locator('.note-bad:has-text("could not be drawn")').count(), 0, label);
  }
  await page.context().close();
  assert.deepEqual(errors, []);
});

// Keep the demo dataset byte-identical: the tests must not depend on local edits.
test('demo dataset served is the committed one', async () => {
  const served = await (await fetch(`${BASE}/demo-dataset.json`)).text();
  assert.equal(served, readFileSync(new URL('../../demo/demo-dataset.json', import.meta.url), 'utf8'));
});
