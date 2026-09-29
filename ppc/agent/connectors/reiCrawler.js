// REI BlackBook crawler (read only) for the team's own authorized account.
//
// What it does: signs in (with REIBB_EMAIL/REIBB_PASSWORD, or a person signs
// in by hand), lists contacts, opens the ones that are new or due for a
// re-check, reads the fields by their visible labels, and hands the rows to
// the same REI importer the CSV path uses (names, phones, emails and
// addresses are hashed there and never stored).
//
// What it never does: bypass a CAPTCHA, MFA or any other security control,
// evade bot protection, or go faster than REI_CRAWL_DELAY_MS between pages.
// When REI asks for a verification code or shows a CAPTCHA, the run stops
// and says to run `npm run ppc:rei-login`, where the person completes it.
//
// When a selector stops matching (REI changed its layout), the run reports
// the exact step and selector, keeps the last good data, and the agent falls
// back to REI CSV exports after repeated failures.
import { readFileSync } from 'node:fs';
import { loadSession, saveSession } from '../secure.js';

export class CrawlerError extends Error {
  constructor(message, { step = '', selector = '', code = 'CRAWLER_ERROR' } = {}) {
    super(message);
    this.step = step;
    this.selector = selector;
    this.code = code;
    this.errors = [{ step, selector, message }];
  }
}

export function loadSelectors(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** "123 Main St, San Jose, CA 95123" -> {city, state, zip} */
export function parseUsAddress(address) {
  const m = /,\s*([^,]+?),\s*([A-Z]{2})\s*(\d{5})?(?:-\d{4})?\s*$/.exec(String(address || '').trim());
  return m ? { city: m[1].trim(), state: m[2], zip: m[3] || '' } : { city: '', state: '', zip: '' };
}

/** Browser-side: read values by their visible label text (runs in the page). */
function readLabelsInPage(labels) {
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const leaves = [...document.querySelectorAll('body *')].filter((el) => el.children.length === 0 && norm(el.textContent) && vis(el));
  const out = {};
  for (const [field, label] of Object.entries(labels)) {
    const wanted = String(label).toLowerCase();
    for (const el of leaves) {
      const own = norm(el.textContent).toLowerCase().replace(/:$/, '');
      if (own !== wanted) continue;
      const cands = [];
      let n = el.nextElementSibling;
      while (n && cands.length < 3) { cands.push(norm(n.innerText || n.textContent)); n = n.nextElementSibling; }
      const p = el.parentElement;
      if (p) {
        let q = p.nextElementSibling;
        while (q && cands.length < 6) { cands.push(norm(q.innerText || q.textContent)); q = q.nextElementSibling; }
      }
      const value = cands.find((v) => v && v.toLowerCase() !== wanted && v.length < 300);
      if (value != null) { out[field] = value; break; }
    }
  }
  return out;
}

async function visible(page, selector, timeout) {
  if (!selector) return false;
  try {
    await page.waitForSelector(selector, { timeout, state: 'visible' });
    return true;
  } catch {
    return false;
  }
}

async function detectBlocker(page, blockers) {
  for (const kind of ['captcha', 'mfa']) {
    if (blockers?.[kind] && (await visible(page, blockers[kind], 300))) return kind;
  }
  return null;
}

/** Sign in, or confirm the saved session still works. */
async function signIn(page, cfg, sel, { interactive, log }) {
  const L = sel.login;
  if (await visible(page, L.loggedInMarker, 3000)) return 'session';
  if (!page.url().includes('login')) await page.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded' });
  const blockerFirst = await detectBlocker(page, sel.blockers);
  if (blockerFirst === 'captcha' && !interactive) {
    throw new CrawlerError('REI showed a CAPTCHA before sign-in. Run "npm run ppc:rei-login" and solve it yourself; the crawler never bypasses CAPTCHAs.', { step: 'login.captcha', selector: sel.blockers.captcha, code: 'MANUAL_LOGIN_REQUIRED' });
  }
  if (cfg.email && cfg.password) {
    if (!(await visible(page, L.emailInput, 8000))) throw new CrawlerError('The REI sign-in form did not appear.', { step: 'login.email', selector: L.emailInput });
    await page.fill(L.emailInput, cfg.email);
    if (!(await visible(page, L.passwordInput, 3000))) throw new CrawlerError('The REI password box did not appear.', { step: 'login.password', selector: L.passwordInput });
    await page.fill(L.passwordInput, cfg.password);
    try {
      await page.click(L.submitButton, { timeout: 5000 });
    } catch {
      throw new CrawlerError('The REI sign-in button was not found.', { step: 'login.submit', selector: L.submitButton });
    }
  } else if (!interactive) {
    throw new CrawlerError('REI needs a sign-in and REIBB_EMAIL / REIBB_PASSWORD are not set. Run "npm run ppc:rei-login" to sign in yourself.', { step: 'login.credentials', code: 'MANUAL_LOGIN_REQUIRED' });
  } else {
    log?.info('rei_login_manual', { message: 'Sign in to REI BlackBook in the browser window (complete any code or CAPTCHA yourself).' });
  }
  const deadline = Date.now() + (interactive ? 5 * 60000 : 25000);
  while (Date.now() < deadline) {
    if (await visible(page, L.loggedInMarker, 800)) return 'login';
    const blocker = await detectBlocker(page, sel.blockers);
    if (blocker && !interactive) {
      throw new CrawlerError(blocker === 'mfa'
        ? 'REI asked for a verification code (MFA). Run "npm run ppc:rei-login" and enter the code yourself; the crawler never bypasses MFA.'
        : 'REI showed a CAPTCHA. Run "npm run ppc:rei-login" and solve it yourself; the crawler never bypasses CAPTCHAs.', { step: `login.${blocker}`, selector: sel.blockers[blocker], code: 'MANUAL_LOGIN_REQUIRED' });
    }
    if (L.errorMessage && (await visible(page, L.errorMessage, 200))) throw new CrawlerError('REI did not accept the email or password in .env.', { step: 'login.rejected', selector: L.errorMessage, code: 'BAD_CREDENTIALS' });
  }
  throw new CrawlerError('The signed-in REI page did not appear.', { step: 'login.loggedInMarker', selector: L.loggedInMarker });
}

/**
 * Crawl. Returns { rows, stats, errors, status } where rows use REI export
 * column names, ready for normalizeReiRows. Throws CrawlerError when the run
 * cannot continue (sign-in, list page); per-contact problems are collected.
 * @param options { state (crawl bookkeeping, updated in place), launch, log,
 *                  interactive (a person is at the keyboard), sessionFile, secretKey, now }
 */
export async function crawlRei(cfg, { selectors, state = {}, launch, log, interactive = false, sessionFile, secretKey, now = Date.now(), loginOnly = false } = {}) {
  const sel = selectors || loadSelectors(cfg.selectorsFile);
  let browser;
  if (launch) browser = await launch({ headless: interactive ? false : cfg.headless });
  else {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: interactive ? false : cfg.headless, ...(cfg.executablePath ? { executablePath: cfg.executablePath } : {}) });
  }
  const saved = cfg.persistSession && secretKey ? loadSession(sessionFile, secretKey) : null;
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, ...(saved ? { storageState: saved } : {}) });
  const page = await context.newPage();
  page.setDefaultTimeout(cfg.timeoutMs);
  const origin = new URL(cfg.loginUrl).origin;
  const pause = () => page.waitForTimeout(cfg.delayMs + Math.floor(Math.random() * cfg.delayMs * 0.4));
  const stats = { pages: 0, listed: 0, opened: 0, read: 0, failed: 0, skipped: 0 };
  const errors = [];
  const rows = [];
  try {
    await page.goto(origin + sel.list.url, { waitUntil: 'domcontentloaded' });
    if (!(await visible(page, sel.list.pageMarker, 5000))) {
      const how = await signIn(page, cfg, sel, { interactive, log });
      log?.info('rei_signed_in', { message: how === 'session' ? 'saved session still valid' : 'signed in' });
      await page.goto(origin + sel.list.url, { waitUntil: 'domcontentloaded' });
    }
    if (cfg.persistSession && secretKey && sessionFile) saveSession(sessionFile, await context.storageState(), secretKey);
    if (loginOnly) return { rows, stats, errors, status: 'ok' };
    if (!(await visible(page, sel.list.pageMarker, 15000))) {
      throw new CrawlerError('The REI contacts list did not load (search box not found).', { step: 'list.open', selector: sel.list.pageMarker });
    }
    if (cfg.tag) {
      const tf = sel.list.tagFilter;
      try {
        await page.click(tf.open, { timeout: 5000 });
        await page.fill(tf.search, cfg.tag);
        await page.click(tf.option.replace('%TAG%', cfg.tag), { timeout: 5000 });
        await page.click(tf.apply, { timeout: 5000 });
        await pause();
      } catch {
        throw new CrawlerError(`Could not filter REI contacts by the tag "${cfg.tag}".`, { step: 'list.tagFilter', selector: `${tf.open} → ${tf.option}` });
      }
    }
    // 1) The contacts list, page by page.
    const listed = new Map();
    for (let p = 1; p <= cfg.maxPages; p += 1) {
      const present = await visible(page, sel.list.row, 10000);
      if (!present) {
        if (p === 1) throw new CrawlerError('No contact rows found on the REI contacts list.', { step: 'list.rows', selector: sel.list.row });
        break;
      }
      const pageRows = await page.$$eval(sel.list.row, (trs, linkSel) => trs.map((tr) => {
        const a = tr.querySelector(linkSel);
        return { href: a ? a.getAttribute('href') : '', cells: [...tr.querySelectorAll('td')].map((td) => (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim()) };
      }), sel.list.link);
      stats.pages += 1;
      for (const r of pageRows) {
        const id = /\/contacts?\/([A-Za-z0-9_-]+)/.exec(r.href || '')?.[1];
        if (!id || listed.has(id)) continue;
        const col = sel.list.columns || {};
        listed.set(id, {
          id, name: r.cells[col.name] || '', address: r.cells[col.propertyAddress] || '', phone: r.cells[col.phone] || '',
          email: r.cells[col.email] || '', tags: r.cells[col.tags] || '',
        });
      }
      const next = sel.list.nextPage ? await page.$(sel.list.nextPage) : null;
      if (!next || p === cfg.maxPages) break;
      const disabled = await next.evaluate((el) => el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('disabled'));
      if (disabled) break;
      await pause();
      await next.click();
      await page.waitForLoadState('domcontentloaded');
    }
    stats.listed = listed.size;

    // 2) Open contacts that are new, or due for a re-check.
    const crawl = state.crawl || (state.crawl = {});
    const due = [...listed.values()].filter((c) => {
      const s = crawl[c.id];
      if (!s) return true;
      const ageH = (now - Date.parse(s.at)) / 3600000;
      return ageH >= (s.done ? 24 * 7 : cfg.recrawlHours);
    });
    stats.skipped = listed.size - Math.min(due.length, cfg.maxContacts);
    const L = sel.detail.labels;
    const required = sel.detail.required || [];
    const missingCount = new Map();
    for (const c of due.slice(0, cfg.maxContacts)) {
      await pause();
      try {
        await page.goto(origin + sel.detail.url.replace('%ID%', c.id), { waitUntil: 'domcontentloaded' });
      } catch (e) {
        stats.failed += 1;
        errors.push({ step: 'contact.open', selector: sel.detail.url, message: `Contact ${c.id}: ${e.message.split('\n')[0]}` });
        continue;
      }
      stats.opened += 1;
      if (sel.detail.pageMarker && !(await visible(page, sel.detail.pageMarker, cfg.timeoutMs))) {
        stats.failed += 1;
        errors.push({ step: 'contact.detail', selector: sel.detail.pageMarker, message: `Contact ${c.id}: the contact page did not load` });
        continue;
      }
      const v = await page.evaluate(readLabelsInPage, L);
      const lacking = required.filter((f) => !v[f]);
      if (lacking.length) {
        stats.failed += 1;
        for (const f of lacking) missingCount.set(f, (missingCount.get(f) || 0) + 1);
        continue;
      }
      let chips = '';
      if (sel.detail.tagChips) {
        try { chips = (await page.$$eval(sel.detail.tagChips, (els) => els.map((e) => e.textContent.trim()).filter(Boolean))).join(', '); } catch { /* optional */ }
      }
      const address = v.address || c.address;
      const place = parseUsAddress(address);
      rows.push({
        'Lead ID': c.id, Name: v.name || c.name, Phone: v.phone || c.phone, Email: v.email || c.email, 'Property Address': address,
        City: place.city, State: place.state, Zip: place.zip, 'Lead Status': v.status || '', 'Lead Source': v.leadSource || '',
        Tags: chips || c.tags, Motivation: v.motivation || '', 'Created Date': v.createdAt || '', 'Last Updated': v.updatedAt || '',
        'Appointment Date': v.appointmentAt || '', 'Offer Date': v.offerAt || '', 'Offer Amount': v.offerAmount || '',
        'Contract Date': v.contractAt || '', 'Closed Date': v.closedAt || '', 'Lost Reason': v.lostReason || '',
        Revenue: v.revenue || '', Profit: v.profit || '', GCLID: v.gclid || '', 'UTM Source': v.utmSource || '', 'UTM Medium': v.utmMedium || '',
        'UTM Campaign': v.utmCampaign || '', 'UTM Term': v.utmTerm || '',
      });
      stats.read += 1;
      crawl[c.id] = { at: new Date(now).toISOString(), done: /closed|dead|lost|not interested/i.test(v.status || '') };
    }
    for (const [f, count] of missingCount) {
      errors.push({ step: 'contact.detail', selector: `label "${L[f]}"`, message: `Field "${L[f]}" not found on ${count} contact page(s); REI may have renamed it. Update ppc/config/rei-crawler.selectors.json.` });
    }
    const status = stats.opened && stats.read === 0 ? 'failed' : errors.length ? 'partial' : 'ok';
    if (status === 'failed') {
      const e = new CrawlerError(errors[0]?.message || 'No contact could be read.', { step: errors[0]?.step || 'contact.detail', selector: errors[0]?.selector || '' });
      e.errors = errors.slice(0, 20);
      e.stats = stats;
      throw e;
    }
    return { rows, stats, errors, status };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
