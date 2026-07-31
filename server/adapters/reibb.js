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
    this.context = await chromium.launchPersistentContext(profileDir, {
      headless: env.HEADLESS,
      slowMo: SLOWMO_MS,
      viewport: { width: 1400, height: 900 },
    });
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
  async probeContactPage(label = 'contact') {
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
      const probe = await this.page.evaluate(() => {
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

        return { headings, phones, tags };
      });
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
          const kept = lines.filter((l) => !/^[A-Z]{1,3}$/.test(l));
          // If a contact really is called "JP", keeping nothing would be worse.
          return (kept.length ? kept : lines).join(' ');
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

  /** Phones on the currently open contact, normalized to last-10. */
  async _openContactPhones() {
    const raw = await this._allText(this.sel.contact.phoneRows);
    const hrefs = await this.page
      .$$eval("a[href^='tel:']", (els) => els.map((e) => e.getAttribute('href') || ''))
      .catch(() => []);
    return [...raw, ...hrefs].map((p) => normalizePhone(p)).filter(Boolean);
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

  async readContactFacts(contactId) {
    const c = this.sel.contact;
    return {
      found: true,
      contactId,
      reiUrl: this.page.url(), // direct link to this contact for the dashboard
      name: await this._text(c.nameField),
      firstName: (await this._text(c.nameField)).split(/\s+/)[0] || '',
      lastName: (await this._text(c.nameField)).split(/\s+/).slice(1).join(' '),
      address: await this._text(c.addressField),
      state: await this._text(c.stateField),
      phones: await this._allText(c.phoneRows),
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

  async getSmsStatus() {
    const marker = this.sel.sms.optInSuccessMarker;
    const enabled = marker ? await this._present(marker, 1500) : false;
    return { smsEnabled: enabled, optedIn: enabled };
  }

  // Open the contact's Chat tab (this app texts from the contact record -> Chat).
  async openChatTab() {
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
  async optInPhone() {
    // Only used when REQUIRE_OPTIN=true. This account's app has no native opt-in
    // step, so selectors are blank until captured — fail closed if so.
    const { sms } = this.sel;
    if (!sms.optInButton) {
      return { status: 'failed', smsEnabled: false, reason: 'No Opt-In control configured (capture via codegen or set REQUIRE_OPTIN=false)' };
    }
    if (sms.optInSuccessMarker && (await this._present(sms.optInSuccessMarker, 1500))) {
      return { status: 'opted_in', smsEnabled: true };
    }
    if (!(await this._present(sms.optInButton, 3000))) {
      return { status: 'failed', smsEnabled: false, reason: 'Opt-In control not found on screen' };
    }
    await this.page.click(sms.optInButton);
    if (sms.optInConfirm && (await this._present(sms.optInConfirm, 2000))) await this.page.click(sms.optInConfirm);
    const ok = sms.optInSuccessMarker ? await this._present(sms.optInSuccessMarker, this.timeout) : true;
    return ok
      ? { status: 'opted_in', smsEnabled: true }
      : { status: 'failed', smsEnabled: false, reason: 'SMS did not become enabled after opt-in' };
  }

  async getProfitDialNumbers() {
    // Only used when REQUIRE_PROFITDIAL=true. Blank until captured via codegen.
    const { chat } = this.sel;
    await this.openChatTab();
    if (!chat.profitDialSelect || !(await this._present(chat.profitDialSelect, 3000))) return [];
    await this.page.click(chat.profitDialSelect);
    const nums = await this._allText(chat.profitDialOptions);
    await this.page.keyboard.press('Escape').catch(() => {});
    return nums;
  }

  async selectProfitDial(contactId, number) {
    const { chat } = this.sel;
    if (!chat.profitDialSelect || !(await this._present(chat.profitDialSelect, 3000))) {
      return { selected: false, readback: '', reason: 'No ProfitDial from-number selector configured' };
    }
    await this.page.click(chat.profitDialSelect);
    const optSel = `${chat.profitDialOptions}:has-text(${JSON.stringify(number)})`;
    if (!(await this._present(optSel, 3000))) {
      await this.page.keyboard.press('Escape').catch(() => {});
      return { selected: false, readback: '', reason: 'Requested ProfitDial number not in selector' };
    }
    await this.page.click(optSel);
    const readback = chat.profitDialSelectedValue ? await this._text(chat.profitDialSelectedValue) : '';
    return { selected: true, readback };
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
    await this.page.waitForTimeout(1000);
    return { sent: true };
  }

  async verifyMessageSent(contactId, text) {
    // This app confirms by re-reading the thread for the exact text just sent.
    const { chat } = this.sel;
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const hay = norm((await this._allText(chat.threadArea)).join(' '));
    if (!hay) return { verified: false, reason: 'Could not read the conversation thread' };
    if (text && !hay.includes(norm(text))) {
      return { verified: false, reason: 'Sent text not found in the thread after sending' };
    }
    return { verified: true };
  }

  async readDeliveryStatus() {
    // This app does not expose a delivery-status element; report pending.
    if (!this.sel.chat.deliveryStatus) return { delivery: 'pending' };
    const status = (await this._text(this.sel.chat.deliveryStatus)).toLowerCase();
    if (status.includes('deliver')) return { delivery: 'delivered' };
    if (status.includes('fail') || status.includes('undeliver')) return { delivery: 'failed' };
    return { delivery: 'pending' };
  }

  async readReplies() {
    return { text: await this._text(this.sel.chat.lastInboundMessage) };
  }
}
