// =============================================================================
// LIVE REI BlackBook adapter (Playwright).
//
// Implements the shared adapter interface by driving the real REI BlackBook web
// app (the CRM has no public API). It ONLY gathers facts and performs actions —
// every decision lives in sop.js. It is fail-closed: any required element that
// cannot be found/read throws, so the engine routes that contact to Needs
// Review and never mis-sends.
//
// ⚠️ TEXTING SAFETY: This adapter can *technically* send a text, but the engine
// only calls sendMessage() after env.liveSendGate() allows it, which requires
// SANDBOX=false AND ALLOW_LIVE_SEND=true AND no placeholder templates. All three
// default OFF. Building this adapter does NOT enable texting.
//
// Selectors are externalized to config/reibb.selectors.json and MUST be verified
// against your account with HEADLESS=false before any live run.
//
// Playwright is imported lazily so sandbox mode and the unit tests never require
// it to be installed.
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Adapter } from './adapter-interface.js';
import { digitsOnly, normalizePhone } from '../automation/sop.js';
import { searchResultStatus, compareNames, NAME_RESULT } from '../automation/contactMatch.js';
import { L10_STATUS } from '../automation/constants.js';
import { env } from '../config/env.js';
import { dataDir } from '../data/paths.js';
import { logger } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

function loadSelectors() {
  const file = path.join(ROOT, 'config', 'reibb.selectors.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const SLOWMO_MS = Number.parseInt(process.env.SLOWMO_MS ?? '0', 10) || 0;

// Paths to try for the Contacts list when no REIBB_CONTACTS_URL is configured.
// Each is verified by the search box appearing, so a wrong guess costs a page
// load and nothing else. Set REIBB_CONTACTS_URL to skip probing entirely.
const CONTACTS_PATH_CANDIDATES = Object.freeze([
  '/contacts',
  '/smart-contacts',
  '/smartcontacts',
  '/services/contacts',
  '/services/smartcontacts',
  '/crm/contacts',
  '/contacts/list',
  '/app/contacts',
]);

/**
 * Does the REI name refer to the same person as the sheet? Thin wrapper over the
 * pure rule in automation/contactMatch.js — one implementation, one behaviour.
 * Kept because it reads well at call sites and in tests.
 */
export function namesMatch(reiName, sheetName) {
  return compareNames(sheetName, reiName).result === NAME_RESULT.MATCH;
}

export class ReiBlackBookAdapter extends Adapter {
  constructor(opts = {}) {
    super();
    this.sel = loadSelectors();
    this.timeout = env.ACTION_TIMEOUT_MS;
    this.context = null;
    this.page = null;
    this._chromium = null;
    this._opts = opts;
  }

  get name() {
    return 'reibb-live';
  }
  get isSandbox() {
    return false;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------
  async init() {
    if (!env.REIBB_LOGIN_URL) {
      const e = new Error('REIBB_LOGIN_URL is not configured. Set REIBB_* in .env before live use.');
      e.code = 'LIVE_NOT_CONFIGURED';
      throw e;
    }
    // Lazy import so sandbox/tests don't need Playwright.
    const { chromium } = await import('playwright');
    this._chromium = chromium;

    // Persistent context keeps the login session between runs (SOP first-run
    // manual login is remembered), and stores writable profile in the data dir.
    const profileDir = path.join(dataDir(), 'browser-profile');
    // REIBB_BROWSER_PATH overrides the bundled Chromium. Needed when the
    // installed browser revision does not match this Playwright version — the
    // launch fails with "Executable doesn't exist" and no amount of retrying helps.
    const launch = {
      headless: env.HEADLESS,
      slowMo: SLOWMO_MS,
      viewport: { width: 1400, height: 900 },
    };
    if (process.env.REIBB_BROWSER_PATH) launch.executablePath = process.env.REIBB_BROWSER_PATH;
    this.context = await chromium.launchPersistentContext(profileDir, launch);
    this.page = this.context.pages()[0] || (await this.context.newPage());
    this.page.setDefaultTimeout(this.timeout);

    await this.page.goto(env.REIBB_LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await this._ensureLoggedIn();
    logger.info('reibb_init', { headless: env.HEADLESS });
  }

  async close() {
    try {
      await this.context?.close();
    } catch {
      /* ignore */
    }
    this.context = null;
    this.page = null;
  }

  async _ensureLoggedIn() {
    const { login } = this.sel;
    // Already logged in?
    if (await this._present(login.loggedInMarker, 3000)) return;

    // Try automated login if credentials are present.
    const email = process.env.REIBB_EMAIL;
    const password = process.env.REIBB_PASSWORD;
    if (email && password && (await this._present(login.emailInput, 3000))) {
      await this.page.fill(login.emailInput, email);
      await this.page.fill(login.passwordInput, password);
      await this.page.click(login.submitButton);
    }
    // Wait for the logged-in marker (covers manual login when HEADLESS=false).
    await this.page.waitForSelector(login.loggedInMarker, { timeout: Math.max(this.timeout, 120000) });
  }

  // ---------------------------------------------------------------------------
  // Low-level helpers (fail-closed)
  // ---------------------------------------------------------------------------
  async _present(selector, timeout = this.timeout) {
    try {
      await this.page.waitForSelector(selector, { timeout, state: 'visible' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Return the page-or-frame where `selector` is visible, else null.
   *
   * REI is a single-page app: a control can be seconds late, and parts of it
   * render inside an iframe, where a page-level selector never matches no matter
   * how long it waits. Checking the main page AND every frame is what makes the
   * difference between "not found" and found.
   */
  async _frameFor(selector, timeout = this.timeout) {
    const deadline = Date.now() + timeout;
    // Main document first — the common case, and cheapest.
    if (await this._present(selector, Math.min(timeout, 3000))) return this.page;
    while (Date.now() < deadline) {
      for (const frame of this.page.frames()) {
        if (frame === this.page.mainFrame()) continue;
        try {
          await frame.waitForSelector(selector, { timeout: 500, state: 'visible' });
          logger.info('selector_found_in_frame', { selector: selector.slice(0, 40), url: frame.url().slice(0, 80) });
          return frame;
        } catch {
          /* try the next frame */
        }
      }
    }
    return null;
  }

  /**
   * Describe every text input on screen (main document + frames) as
   * `placeholder|name|aria-label`. Used only when a selector could not be found,
   * so the correct one can be written from the failure report itself.
   */
  async _describeInputs() {
    const out = [];
    for (const frame of this.page.frames()) {
      try {
        const found = await frame.$$eval(
          "input:not([type='hidden']):not([type='password']), textarea",
          (els) =>
            els
              .map((e) =>
                [e.getAttribute('placeholder'), e.getAttribute('name'), e.getAttribute('aria-label'), e.getAttribute('type')]
                  .filter(Boolean)
                  .join('|')
              )
              .filter(Boolean)
        );
        out.push(...found);
      } catch {
        /* frame detached or cross-origin */
      }
    }
    return [...new Set(out)].slice(0, 12);
  }

  /**
   * Are we actually on the Contacts (Smart Contacts) list?
   *
   * Two independent signals, either is enough:
   *   - the URL mentions contacts, or
   *   - a Contacts-specific marker is on screen (the "Search By Name, Phone..."
   *     placeholder, which Deals and the other list views do not have).
   * Without this check, any page with a search box looks like Contacts.
   */
  async _onContactsPage() {
    if (/contact/i.test(this.page.url() || '')) return true;
    const marker = this.sel.contacts.pageMarker;
    return marker ? this._present(marker, 1500) : false;
  }

  /**
   * Read-only probe of the OPEN contact record, for selector capture.
   *
   * Reports what is actually on the page — visible headings, every element whose
   * text looks like a phone number, and anything that looks like a tag chip —
   * each with the attributes needed to write a selector (tag, id, class, role,
   * aria-label, data-testid, href). Also saves the page HTML.
   *
   * This exists so detail-page selectors are captured from evidence instead of
   * guessed. It changes nothing on the page.
   */
  async probeContactPage(label = 'contact', expect = {}) {
    const describe = (el, text) => {
      const attr = (n) => el.getAttribute(n) || '';
      const cls = String(attr('class') || '').split(/\s+/).filter(Boolean).slice(0, 3).join('.');
      return {
        tag: el.tagName.toLowerCase(),
        id: attr('id'),
        cls,
        role: attr('role'),
        aria: attr('aria-label'),
        testid: attr('data-testid'),
        href: attr('href'),
        text: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      };
    };

    const out = { url: this.page.url(), headings: [], phones: [], tags: [], html: '' };
    try {
      const probe = await this.page.evaluate((EXPECT) => {
        const vis = (el) => {
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
        };
        const desc = (el) => {
          const a = (n) => el.getAttribute(n) || '';
          return {
            tag: el.tagName.toLowerCase(),
            id: a('id'),
            cls: (a('class') || '').split(/\s+/).filter(Boolean).slice(0, 3).join('.'),
            role: a('role'),
            aria: a('aria-label'),
            testid: a('data-testid'),
            href: a('href'),
            text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
          };
        };

        const headings = [...document.querySelectorAll('h1,h2,h3,[role="heading"]')]
          .filter(vis)
          .map(desc)
          .filter((d) => d.text)
          .slice(0, 8);

        // Leaf elements whose own text looks like a US phone number.
        const PHONE = /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
        const phones = [...document.querySelectorAll('body *')]
          .filter((el) => el.children.length === 0 && vis(el) && PHONE.test(el.textContent || ''))
          .map(desc)
          .slice(0, 10);

        // Small visible elements that look like chips/badges/tags.
        const tags = [...document.querySelectorAll('[class*="tag" i],[class*="chip" i],[class*="badge" i],[class*="pill" i],[class*="label" i]')]
          .filter(vis)
          .map(desc)
          .filter((d) => d.text && d.text.length < 40)
          .slice(0, 12);

        // TARGETED HUNT: we already know what the name and address should say, so
        // find the elements that contain those exact values and report how to
        // select them. Far more reliable than guessing which container holds the
        // name — this page has no visible heading at all.
        const hunt = (needle) => {
          const want = String(needle || '').trim().toLowerCase();
          if (want.length < 3) return [];
          return [...document.querySelectorAll('body *')]
            .filter((el) => {
              if (el.children.length > 0) return false; // leaf nodes only
              if (!vis(el)) return false;
              const t = (el.innerText || el.textContent || '').trim().toLowerCase();
              return t && (t === want || t.includes(want) || want.includes(t));
            })
            .map(desc)
            .slice(0, 6);
        };

        return {
          headings,
          phones,
          tags,
          title: document.title,
          nameHits: hunt(EXPECT.name),
          addressHits: hunt(EXPECT.address),
          // Largest visible text on the page — the name is usually the biggest thing.
          biggest: [...document.querySelectorAll('body *')]
            .filter((el) => el.children.length === 0 && vis(el) && (el.innerText || '').trim())
            .map((el) => ({ ...desc(el), size: parseFloat(getComputedStyle(el).fontSize) || 0 }))
            .sort((a, b) => b.size - a.size)
            .slice(0, 6),
        };
      }, { name: expect.name || '', address: expect.address || '' });
      Object.assign(out, probe);
    } catch (e) {
      out.error = e.message;
    }

    try {
      const dir = path.join(dataDir(), 'diagnostics');
      fs.mkdirSync(dir, { recursive: true });
      const safe = String(label).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60);
      const file = path.join(dir, `contact-${safe}.html`);
      fs.writeFileSync(file, await this.page.content(), 'utf8');
      out.html = file;
    } catch {
      /* artifact is best-effort */
    }
    return out;
  }

  /**
   * Get to the Contacts list and return the frame holding its search box.
   *
   * Clicking `text=Contacts` is not reliable: it can match a heading, a stat
   * card or a menu label, so the bot ended up on a date-filtered view with no
   * search box and searched nothing at all. Order of attempts:
   *   1. REIBB_CONTACTS_URL, if configured — deterministic, no guessing.
   *   2. A remembered URL that worked earlier in this run.
   *   3. A real nav LINK (anchor with an href), not any text on the page.
   *   4. Candidate paths on the same origin, each verified by the search box
   *      actually appearing. Navigation is read-only, so probing is safe.
   * Whatever works is remembered for the remaining leads.
   */
  async _openContactsSearch() {
    const { contacts } = this.sel;

    // A search box is NOT proof of the right page: this account lands on Deals
    // after login, Deals has its own "Search" box, and typing a phone into it
    // returns "No Result Found" from a deal search. So the page identity is
    // checked first, and only then is a search box accepted.
    const check = async (timeout) => {
      if (!(await this._onContactsPage())) return null;
      return this._frameFor(contacts.searchInput, timeout);
    };

    // Already on Contacts — cheapest case.
    let frame = await check(2500);
    if (frame) return frame;

    const tryUrl = async (url) => {
      if (!url) return null;
      try {
        await this.page.goto(url, { waitUntil: 'domcontentloaded' });
      } catch {
        return null;
      }
      const f = await check(this.timeout);
      if (f) {
        this._contactsUrl = url;
        logger.info('contacts_url_ok', { url });
      }
      return f;
    };

    for (const url of [env.REIBB_CONTACTS_URL, this._contactsUrl]) {
      frame = await tryUrl(url);
      if (frame) return frame;
    }

    // A genuine navigation link, then wait for the SPA to render.
    if (await this._present(contacts.navContacts, 4000)) {
      await this.page.click(contacts.navContacts).catch(() => {});
      await this.page.waitForLoadState('domcontentloaded').catch(() => {});
      frame = await check(this.timeout);
      if (frame) return frame;
    }

    // Candidate paths on this account's origin.
    let origin = '';
    try {
      origin = new URL(this.page.url() || env.REIBB_LOGIN_URL).origin;
    } catch {
      origin = '';
    }
    if (origin) {
      for (const p of CONTACTS_PATH_CANDIDATES) {
        frame = await tryUrl(origin + p);
        if (frame) return frame;
      }
    }
    return null;
  }

  /**
   * Text of the first VISIBLE, non-empty match.
   *
   * page.$ returns the first element in DOM order regardless of visibility, which
   * is how "h1, h2" produced "Logging Out..." from a hidden overlay instead of the
   * contact's name. Walking the matches and skipping invisible/empty ones is the
   * difference between reading the record and reading furniture.
   */
  async _text(selector, { frame = this.page } = {}) {
    if (!selector) return '';
    try {
      const els = await frame.$$(selector);
      for (const el of els.slice(0, 20)) {
        let visible = false;
        try {
          visible = await el.isVisible();
        } catch {
          visible = false;
        }
        if (!visible) continue;
        const txt = (await el.innerText()).trim();
        if (txt) return txt;
      }
      return '';
    } catch {
      return '';
    }
  }

  async _allText(selector) {
    try {
      return (await this.page.$$eval(selector, (els) => els.map((e) => e.innerText.trim()).filter(Boolean)));
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Interface: locate / read
  // ---------------------------------------------------------------------------
  async applyLevel10Filter() {
    // SOP Step 2 — Tags filter: open "Tags", search the tag, check it, Apply.
    const { contacts } = this.sel;
    if (!(await this._present(contacts.tagFilterOpen, 5000))) return false;
    await this.page.click(contacts.tagFilterOpen);
    if (await this._present(contacts.tagSearchInput, 3000)) {
      await this.page.fill(contacts.tagSearchInput, env.LEVEL10_TAG);
      await this.page.waitForTimeout(400);
    }
    const opt = contacts.tagFilterOption.replace('%TAG%', env.LEVEL10_TAG);
    if (await this._present(opt, 3000)) await this.page.click(opt);
    if (await this._present(contacts.tagApply, 3000)) await this.page.click(contacts.tagApply);
    await this.page.waitForTimeout(800);
    return true;
  }

  async listContacts() {
    // The engine iterates the uploaded Level 10 sheet as the worklist, so this
    // just applies the tag filter as a verification step (SOP Step 2).
    await this.applyLevel10Filter();
    const rows = await this._allText(this.sel.contacts.resultRow);
    return rows;
  }

  /**
   * PHONE ONLY, and nothing else. The specification makes the phone the primary
   * and sole search key: name is never searched, because a name search can surface
   * a different homeowner, and address is never searched either.
   *
   * The normalized 10-digit number goes first. The remaining entries are the SAME
   * number in the renderings REI's box may require — still a phone search, not a
   * fallback to another key. If none of them return a row, that is a genuine
   * NO_CONTACT_FOUND_BY_PHONE and the row is skipped.
   */
  _searchTerms(query) {
    const terms = [];
    const push = (value) => {
      const v = String(value ?? '').trim();
      if (v && !terms.some((t) => t.value === v)) terms.push({ label: 'phone', value: v });
    };

    const digits = digitsOnly(query.phone);
    const ten = digits.length >= 10 ? digits.slice(-10) : '';
    if (!ten) return terms; // no usable phone -> nothing to search

    // Order is from live evidence: "(916) 607-2808" returned a row on every record
    // that reached it, while the bare 10 digits returned nothing on 2 of 5.
    push(`(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`);
    push(ten); // 9166072808 — the normalized form
    push(`${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}`);
    push(`${ten.slice(0, 3)}.${ten.slice(3, 6)}.${ten.slice(6)}`);
    return terms;
  }

  /**
   * Read every result row of the Contacts list as a candidate.
   *
   * The list itself shows Name / Property Address / Phone, so all candidates can
   * be compared WITHOUT opening anyone — which is what makes "never automatically
   * choose the first result" possible.
   */
  async _readCandidates(frame) {
    const { contacts } = this.sel;
    try {
      const rows = await frame.$$eval(contacts.resultRow, (els) => {
        // REI renders an avatar badge inside the Name cell, so its text arrives as
        // "JP\n\nJames Potts". Left alone, "JP" becomes a name token and
        // "JAMES POTTS" vs "JP JAMES POTTS" reads as a different family member.
        // Drop lines that are only 1-3 capitals (avatar initials) and join the rest.
        const cleanCell = (raw) => {
          const lines = String(raw || '')
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean);
          // The avatar badge is usually its own line ("JP\n\nJames Potts")...
          const kept = lines.filter((l) => !/^[A-Z]{1,3}$/.test(l));
          // ...but if the layout puts it inline it arrives as "JP James Potts",
          // so also drop a leading 1-3 letter token that is exactly the initials
          // of the words that follow. Relying on the newline alone was luck.
          let text = (kept.length ? kept : lines).join(' ').replace(/\s+/g, ' ').trim();
          const parts = text.split(' ');
          if (parts.length > 2 && /^[A-Z]{1,3}$/.test(parts[0])) {
            const rest = parts.slice(1);
            const acronym = rest.map((w) => w[0]).join('').toUpperCase();
            // "JP James Potts" -> initials of "James Potts" is "JP" -> drop it.
            if (acronym.startsWith(parts[0]) || parts[0] === acronym.slice(0, parts[0].length)) {
              text = rest.join(' ');
            }
          }
          return text;
        };
        return els
          .map((el, index) => {
            const cells = [...el.querySelectorAll('td, [role="cell"]')].map((c) => cleanCell(c.innerText));
            const link = el.querySelector('a');
            return {
              index,
              cells,
              href: link ? link.getAttribute('href') : '',
              text: el.innerText.replace(/\s+/g, ' ').trim(),
            };
          })
          .filter((r) => r.text && r.cells.length);
      });

      return rows
        .map((r) => {
          // Columns on this account: Name | Property Address | Phone | Email | Tags.
          // Identify by content rather than fixed position, so a reordered or
          // hidden column cannot silently shift the phone into the name slot.
          const phoneCell = r.cells.find((c) => digitsOnly(c).length >= 10) || '';
          const nonPhone = r.cells.filter((c) => c && c !== phoneCell);
          // The one candidate contract, shared with the sandbox adapter:
          // { contactId, name, phone, address, rowReference }
          const idFromHref = r.href ? r.href.split('/').filter(Boolean).pop() : '';
          return {
            contactId: idFromHref || '',
            name: nonPhone[0] || '',
            phone: phoneCell,
            address: nonPhone[1] || '',
            rowReference: r.index,
            href: r.href || '',
            rowText: r.text,
          };
        })
        .filter((c) => c.name || c.phone);
    } catch {
      return [];
    }
  }

  /**
   * Phones on the currently open contact, normalized to last-10.
   *
   * This account has no `tel:` links — numbers render as plain <p class="chakra-text">
   * (confirmed by the live DOM probe). That selector also matches ordinary prose, so
   * only phone-SHAPED text is kept; anything else would pollute the verification.
   */
  async _openContactPhones() {
    const raw = await this._allText(this.sel.contact.phoneRows);
    const hrefs = await this.page
      .$$eval("a[href^='tel:']", (els) => els.map((e) => e.getAttribute('href') || ''))
      .catch(() => []);
    const PHONE_SHAPED = /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
    return [...raw, ...hrefs]
      .filter((t) => PHONE_SHAPED.test(String(t)))
      .map((t) => normalizePhone(t))
      .filter((d) => d.length === 10);
  }

  /**
   * Save a screenshot of the current page for diagnosis. A lookup that fails
   * without saying why is unfixable; a picture of the screen the bot was looking
   * at usually settles it in seconds (wrong page, a modal, a changed layout).
   */
  async _diagnosticShot(label) {
    try {
      const dir = path.join(dataDir(), 'diagnostics');
      fs.mkdirSync(dir, { recursive: true });
      const safe = String(label).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60);
      const file = path.join(dir, `${safe}.png`);
      await this.page.screenshot({ path: file, fullPage: false });
      return file;
    } catch {
      return '';
    }
  }

  /**
   * Search Smart Contacts BY PHONE and return every candidate row.
   *
   * This method only GATHERS facts: it does not pick a contact and does not open
   * one. `chooseContact()` in automation/contactMatch.js makes that decision from
   * the candidates, which is what keeps "never automatically choose the first
   * result" true and unit-testable.
   *
   * @returns {{status, candidates, searched, stage?, screenshot?}}
   */
  async findContact(query) {
    const { contacts } = this.sel;
    const searched = [];
    let searchBoxSeen = false;

    const terms = this._searchTerms(query);
    if (terms.length === 0) {
      return {
        status: L10_STATUS.MANUAL_REVIEW_REQUIRED,
        candidates: [],
        searched: [],
        stage: `spreadsheet phone "${query.phone ?? ''}" is not a usable 10-digit number — no phone search possible`,
      };
    }

    for (const term of terms) {
      const frame = await this._openContactsSearch();
      if (!frame) continue;
      searchBoxSeen = true;

      await frame.fill(contacts.searchInput, '').catch(() => {});
      await frame.fill(contacts.searchInput, term.value);
      await frame.press(contacts.searchInput, 'Enter').catch(() => {});
      await this.page.waitForTimeout(1500);

      // REI's explicit empty state: this format found nobody. Try the next
      // rendering of the SAME number before concluding anything.
      if (contacts.noResults && (await this._present(contacts.noResults, 1200))) {
        searched.push(`phone:"${term.value}"→No Result Found`);
        continue;
      }

      const candidates = await this._readCandidates(frame);
      if (candidates.length === 0) {
        searched.push(`phone:"${term.value}"→no rows read`);
        continue;
      }

      searched.push(`phone:"${term.value}"→${candidates.length} row(s)`);
      logger.info('contact_search', {
        phone: term.value,
        count: candidates.length,
        candidates: candidates.map((c) => ({ name: c.name, phone: c.phone, address: c.address })),
      });
      return { status: searchResultStatus(candidates.length), candidates, searched, matchedFormat: term.value };
    }

    // Nothing found by any rendering of the number. Distinguish "REI has nobody"
    // from "the automation could not drive the page" — different problems.
    let stage = '';
    if (!searchBoxSeen) {
      const inputs = await this._describeInputs();
      stage =
        "could not reach REI's Contacts list (no search box). " +
        `Page was: ${this.page.url()}. ` +
        `Text inputs on screen: ${inputs.length ? inputs.join(' | ') : 'none'}. ` +
        'If this is not the Contacts list, set REIBB_CONTACTS_URL in .env to its exact URL.';
    }
    const shot = await this._diagnosticShot(`nocontact-${normalizePhone(query.phone) || 'lead'}`);
    logger.warn('no_contact_found_by_phone', { phone: normalizePhone(query.phone), searched, stage, screenshot: shot });
    return {
      // A page the automation could not drive is NOT evidence that REI lacks the
      // contact, so it must not be recorded as NO_CONTACT_FOUND_BY_PHONE.
      status: searchBoxSeen ? L10_STATUS.NO_CONTACT_FOUND_BY_PHONE : L10_STATUS.MANUAL_REVIEW_REQUIRED,
      candidates: [],
      searched,
      stage,
      screenshot: shot,
      searchBoxSeen,
    };
  }

  /**
   * Open one specific candidate returned by findContact. Called only after
   * chooseContact() has confirmed WHICH contact is the right homeowner.
   */
  async openContact(candidate) {
    const { contacts } = this.sel;
    if (candidate?.href) {
      try {
        const url = new URL(candidate.href, this.page.url()).toString();
        await this.page.goto(url, { waitUntil: 'domcontentloaded' });
        await this.page.waitForTimeout(800);
        return { opened: true, contactId: candidate.href.split('/').filter(Boolean).pop() || candidate.name };
      } catch {
        /* fall through to clicking the row */
      }
    }
    const frame = await this._frameFor(contacts.resultRow, 4000);
    if (!frame) return { opened: false, reason: 'result rows are no longer on screen' };
    const rows = await frame.$$(contacts.resultRow);
    const row = rows[candidate?.rowReference ?? 0];
    if (!row) return { opened: false, reason: `candidate row ${candidate?.rowReference} not found` };
    const link = (await row.$('a')) || row;
    await link.click().catch(() => {});
    await this.page.waitForTimeout(900);
    return { opened: true, contactId: candidate?.name || String(candidate?.ref ?? '') };
  }

  /**
   * Read a labelled field from the About panel ("Name", "Phone (Mobile)",
   * "Property Address", "Mailing Address").
   *
   * The panel renders label/value pairs with no headings and no stable classes —
   * the live probe found NO h1/h2/h3 at all, which is why a class-based selector
   * kept coming back blank. Anchoring on the visible LABEL text and taking the
   * adjacent value survives Chakra's generated class names.
   */
  async _readLabeledField(label) {
    try {
      return await this.page.evaluate((LABEL) => {
        const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
        const wanted = LABEL.toLowerCase();
        const vis = (el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const leaves = [...document.querySelectorAll('body *')].filter(
          (el) => el.children.length === 0 && norm(el.textContent) && vis(el)
        );
        for (const el of leaves) {
          const own = norm(el.textContent).toLowerCase().replace(/:$/, '');
          if (own !== wanted) continue;
          const out = [];
          // Value usually sits immediately after the label, or after its wrapper.
          let n = el.nextElementSibling;
          while (n && out.length < 3) {
            out.push(norm(n.innerText || n.textContent));
            n = n.nextElementSibling;
          }
          const p = el.parentElement;
          if (p) {
            let q = p.nextElementSibling;
            while (q && out.length < 6) {
              out.push(norm(q.innerText || q.textContent));
              q = q.nextElementSibling;
            }
          }
          const value = out.find((v) => v && v.toLowerCase() !== wanted && v.length < 200);
          if (value) return value;
        }
        return '';
      }, label);
    } catch {
      return '';
    }
  }

  /** The stable REI contact id, taken from /contacts/<id> in the URL. */
  _contactIdFromUrl() {
    const m = /\/contacts?\/(\d+)/i.exec(this.page.url() || '');
    return m ? m[1] : '';
  }

  /** Name / address / state for the open record, read by label then by selector. */
  async _readIdentity(c) {
    const name = (await this._readLabeledField('Name')) || (await this._text(c.nameField));
    const address =
      (await this._readLabeledField('Property Address')) ||
      (c.addressField ? await this._text(c.addressField) : '');
    // State is not its own field on this account — take it from the address
    // ("..., Oakland, CA 94602"), which is what the geographic filter needs.
    const fromAddress = /,\s*([A-Z]{2})\s*\d{5}(?:-\d{4})?\s*$/.exec(String(address || ''));
    const state = (c.stateField ? await this._text(c.stateField) : '') || (fromAddress ? fromAddress[1] : '');
    const parts = String(name || '').split(/\s+/).filter(Boolean);
    return {
      name,
      firstName: parts[0] || '',
      lastName: parts.slice(1).join(' '),
      address,
      state,
    };
  }

  async readContactFacts(contactId) {
    const c = this.sel.contact;
    return {
      found: true,
      // Prefer REI's own id from the URL over anything scraped from the page.
      contactId: this._contactIdFromUrl() || contactId,
      reiUrl: this.page.url(), // direct link to this contact for the dashboard
      ...(await this._readIdentity(c)),
      phones: await this._openContactPhones(),
      tags: await this._allText(c.tagChips),
      notes: await this._text(c.notesField),
      chatHistory: await this._allText(c.chatMessages),
      optOut: false, // derived by sop.js from tags/notes/history
    };
  }

  /**
   * Is the Opt In control actually present? A blank selector in
   * reibb.selectors.json means it was never captured for this account, so the
   * answer is a definite NO — the engine then records OPT_IN_REQUIRED rather than
   * pretending an opt-in happened.
   */
  async optInAvailable() {
    const { sms } = this.sel;
    if (!sms.optInButton) return false;
    return this._present(sms.optInButton, 4000);
  }

  /**
   * Is the ProfitDial sender selector present? Blank selector = not captured =
   * unavailable, which blocks the send with PROFITDIAL_NOT_VERIFIED.
   */
  async profitDialSelectorAvailable() {
    const { chat } = this.sel;
    if (!chat.profitDialSelect) return false;
    return this._present(chat.profitDialSelect, 4000);
  }

  /** Navigate straight to a contact tab — tabs are query-string based. */
  async openContactTab(tab) {
    const id = this._contactIdFromUrl();
    if (!id) return false;
    const base = new URL(this.page.url());
    const target = `${base.origin}/contacts/${id}?activeTab=${tab}`;
    try {
      await this.page.goto(target, { waitUntil: 'domcontentloaded' });
      await this.page.waitForTimeout(900);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read the opt-in state for the contact's primary phone.
   *
   * The state lives in the "Edit Contact Information" modal (pencil icon by the
   * avatar), not on the page — which is why an on-page marker always read false.
   * Opening the modal changes nothing; it is closed again with Escape and never
   * saved, so this is safe in read-only mode.
   */
  async getSmsStatus() {
    const c = this.sel.contact;
    if (!(await this._openEditModal())) return { smsEnabled: false, optedIn: false, reason: 'edit modal not found' };
    const text = await this._text(c.optInControl);
    await this.page.keyboard.press('Escape').catch(() => {});
    await this.page.waitForTimeout(300);
    // "Opt - In" means enabled; "Opt - Out" (or blank) does not.
    const enabled = /opt\s*-?\s*in/i.test(text) && !/opt\s*-?\s*out/i.test(text);
    return { smsEnabled: enabled, optedIn: enabled, raw: text };
  }

  /** Open the Edit Contact Information modal. Retries: the icon can need a nudge. */
  async _openEditModal() {
    const c = this.sel.contact;
    if (await this._present(c.editModal, 1200)) return true;
    if (!c.editButton) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!(await this._present(c.editButton, 3000))) return false;
      await this.page.click(c.editButton).catch(() => {});
      await this.page.waitForTimeout(700);
      if (await this._present(c.editModal, 2500)) return true;
    }
    return false;
  }

  async optInAvailable() {
    const c = this.sel.contact;
    if (!c.editButton || !c.optInControl) return false;
    if (!(await this._openEditModal())) return false;
    const present = await this._present(c.optInControl, 2500);
    await this.page.keyboard.press('Escape').catch(() => {});
    return present;
  }

  async profitDialSelectorAvailable() {
    const { chat } = this.sel;
    if (!chat.profitDialSelect) return false;
    await this.openContactTab('chat');
    return this._present(chat.profitDialSelect, 4000);
  }

  // Open the contact's Chat tab (this app texts from the contact record -> Chat).
  async openChatTab() {
    if (await this.openContactTab('chat')) return true;
    const { chat } = this.sel;
    if (chat.chatTab && (await this._present(chat.chatTab, 4000))) {
      await this.page.click(chat.chatTab);
      await this.page.waitForTimeout(600);
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Interface: actions
  // ---------------------------------------------------------------------------

  /**
   * Set the primary phone to Opt-In via the Edit Contact Information modal.
   *
   * The Opt-In control is a custom combobox, not a native <select>, and the pilot
   * found the first click often only refocuses it — hence the expand retries. The
   * click is never treated as proof: the modal is REOPENED afterwards and the
   * value re-read, which is what the engine gates on.
   */
  async optInPhone() {
    const c = this.sel.contact;
    if (!c.editButton || !c.optInControl) {
      return { status: 'failed', smsEnabled: false, reason: 'No Opt-In control configured' };
    }
    if (!(await this._openEditModal())) {
      return { status: 'failed', smsEnabled: false, reason: 'Edit Contact Information modal did not open' };
    }

    let expanded = false;
    for (let attempt = 0; attempt < 3 && !expanded; attempt++) {
      await this.page.click(c.optInControl).catch(() => {});
      await this.page.waitForTimeout(500);
      expanded = await this._present(c.optInOptionIn, 1500);
    }
    if (!expanded) {
      await this.page.keyboard.press('Escape').catch(() => {});
      return { status: 'failed', smsEnabled: false, reason: 'Opt-In dropdown would not expand' };
    }

    // Choose the option that says Opt-In and not Opt-Out.
    const options = await this.page.$$(c.optInOptionIn);
    let picked = false;
    for (const o of options) {
      const t = ((await o.innerText().catch(() => '')) || '').trim();
      if (/opt\s*-?\s*in/i.test(t) && !/opt\s*-?\s*out/i.test(t)) {
        await o.click().catch(() => {});
        picked = true;
        break;
      }
    }
    if (!picked) {
      await this.page.keyboard.press('Escape').catch(() => {});
      return { status: 'failed', smsEnabled: false, reason: 'No "Opt - In" option in the dropdown' };
    }

    if (c.optInSave && (await this._present(c.optInSave, 3000))) {
      await this.page.click(c.optInSave).catch(() => {});
      await this.page.waitForTimeout(1500);
    } else {
      await this.page.keyboard.press('Escape').catch(() => {});
      return { status: 'failed', smsEnabled: false, reason: 'Update Info button not found' };
    }

    // RE-READ from a freshly reopened modal. A closed modal is not evidence.
    const after = await this.getSmsStatus();
    return after.smsEnabled
      ? { status: 'opted_in', smsEnabled: true }
      : { status: 'failed', smsEnabled: false, reason: `opt-in did not stick (control reads "${after.raw || ''}")` };
  }

  /**
   * The sender numbers offered by the compose bar's "From:" control.
   * Labels look like "Postcard Ugly Houses - East Bay (510) (510) 916-3995", so the
   * TRAILING 10 digits are the number; the campaign label is ignored.
   */
  async getProfitDialNumbers() {
    const { chat } = this.sel;
    await this.openChatTab();
    if (!chat.profitDialSelect || !(await this._present(chat.profitDialSelect, 3000))) return [];
    await this.page.click(chat.profitDialSelect).catch(() => {});
    await this.page.waitForTimeout(700);
    const labels = await this._allText(chat.profitDialOptions);
    await this.page.keyboard.press('Escape').catch(() => {});
    return labels
      .map((l) => {
        const digits = String(l).replace(/\D/g, '');
        return digits.length >= 10 ? digits.slice(-10) : '';
      })
      .filter(Boolean);
  }

  /** Select the assigned sender, matching on the trailing number, then read it back. */
  async selectProfitDial(contactId, number) {
    const { chat } = this.sel;
    const want = normalizePhone(number);
    if (!want) return { selected: false, readback: '', reason: 'no assigned ProfitDial to select' };
    await this.openChatTab();
    if (!chat.profitDialSelect || !(await this._present(chat.profitDialSelect, 3000))) {
      return { selected: false, readback: '', reason: 'the From: sender control was not found' };
    }
    await this.page.click(chat.profitDialSelect).catch(() => {});
    await this.page.waitForTimeout(700);

    const options = await this.page.$$(chat.profitDialOptions);
    let clicked = false;
    for (const o of options) {
      const t = ((await o.innerText().catch(() => '')) || '');
      const digits = t.replace(/\D/g, '');
      if (digits.length >= 10 && digits.slice(-10) === want) {
        await o.click().catch(() => {});
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      await this.page.keyboard.press('Escape').catch(() => {});
      return { selected: false, readback: '', reason: `${number} is not among the sender numbers offered` };
    }
    await this.page.waitForTimeout(800);

    // Read the From: line back — digit-for-digit is checked by the engine, and an
    // empty readback is treated as a failure, so this must actually work.
    const shown = (await this._readFromLine()) || (await this._text(chat.profitDialSelectedValue));
    const readDigits = String(shown).replace(/\D/g, '');
    return {
      selected: true,
      readback: readDigits.length >= 10 ? readDigits.slice(-10) : shown,
      readbackText: shown,
    };
  }

  /**
   * The compose bar's "From: <label> (<number>)" text.
   *
   * Found by scanning for the visible element that starts with "From:" rather than
   * by selector. The configured selector mixed Playwright's text=/regex/ engine
   * with CSS in one comma list, which is not valid — it matched nothing, so the
   * readback came back empty and the engine failed every lead with
   * PROFITDIAL_NOT_VERIFIED even though the sender had been selected correctly.
   */
  async _readFromLine() {
    try {
      return await this.page.evaluate(() => {
        const vis = (el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const els = [...document.querySelectorAll('body *')].filter(
          (el) => el.children.length === 0 && vis(el)
        );
        for (const el of els) {
          const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          if (/^From:/i.test(t) && /\d{3}/.test(t)) return t;
        }
        // Fall back to a parent that holds the From: text with a nested number.
        for (const el of document.querySelectorAll('body *')) {
          if (!vis(el)) continue;
          const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
          if (/^From:/i.test(t) && t.length < 120 && /\d{3}/.test(t)) return t;
        }
        return '';
      });
    } catch {
      return '';
    }
  }

  async enterMessage(contactId, text) {
    const { chat } = this.sel;
    await this.openChatTab();
    // The reply box is TinyMCE, usually inside an iframe. Type real keystrokes
    // (pressSequentially) or the Send button won't enable.
    if (chat.editorFrame) {
      for (const fsel of chat.editorFrame.split(',').map((s) => s.trim()).filter(Boolean)) {
        if (await this._present(fsel, 1500)) {
          const body = this.page.frameLocator(fsel).locator('body');
          await body.click();
          await body.pressSequentially(text, { delay: 15 });
          return { entered: true };
        }
      }
    }
    // Fallback: contenteditable / textarea directly on the page.
    if (await this._present(chat.messageInput, 3000)) {
      const el = this.page.locator(chat.messageInput).first();
      await el.click();
      await el.pressSequentially(text, { delay: 15 });
      return { entered: true };
    }
    return { entered: false };
  }

  async sendMessage() {
    // Reaching here means env.liveSendGate already allowed it.
    const { chat } = this.sel;
    if (!(await this._present(chat.sendButton, 3000))) return { sent: false, reason: 'Send button not found' };
    await this.page.click(chat.sendButton);
    await this.page.waitForTimeout(1500);
    return { sent: true };
  }

  /**
   * Confirm exactly one new outgoing message carrying the exact text.
   * A sent bubble is marked "PD #: (xxx) xxx-xxxx  Sent to: (xxx) xxx-xxxx <time>".
   */
  async verifyMessageSent(contactId, text) {
    const { chat } = this.sel;
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const hay = norm((await this._allText(chat.threadArea)).join(' '));
    if (!hay) return { verified: false, reason: 'Could not read the conversation thread' };
    if (text && !hay.includes(norm(text))) {
      return { verified: false, reason: 'Sent text not found in the thread after sending' };
    }
    const bubbles = chat.outgoingMessage ? await this._allText(chat.outgoingMessage) : [];
    const matching = bubbles.filter((b) => !text || norm(b).includes(norm(text).slice(0, 40)));
    if (matching.length > 1) {
      return { verified: false, reason: `${matching.length} outgoing copies of this message found — possible double send` };
    }
    return { verified: true, marker: matching[0] || '' };
  }

  /**
   * Delivery outcome. REI marks failures "Undelivered" in the thread and updates
   * ASYNCHRONOUSLY, so 'pending' here is a real state, not an error — the pilot
   * saw 2 of 3 sends flip to Undelivered after the fact.
   */
  async readDeliveryStatus() {
    const { chat } = this.sel;
    if (chat.undeliveredMarker && (await this._present(chat.undeliveredMarker, 1500))) {
      return { delivery: 'undelivered' };
    }
    const thread = (await this._allText(chat.threadArea)).join(' ').toLowerCase();
    if (thread.includes('undelivered')) return { delivery: 'undelivered' };
    if (chat.outgoingMessage && (await this._present(chat.outgoingMessage, 1500))) {
      // A bubble exists with no failure marker yet — REI has not resolved it.
      return { delivery: 'pending' };
    }
    return { delivery: 'pending' };
  }

  async readReplies() {
    return { text: await this._text(this.sel.chat.lastInboundMessage) };
  }
}
