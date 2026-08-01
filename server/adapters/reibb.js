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
import { env } from '../config/env.js';
import { dataDir } from '../data/paths.js';
import { logger } from '../logger.js';
import { deriveFirstName, extractUsPhones } from '../automation/sop.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

function loadSelectors() {
  const file = path.join(ROOT, 'config', 'reibb.selectors.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const SLOWMO_MS = Number.parseInt(process.env.SLOWMO_MS ?? '0', 10) || 0;

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

  async _text(selector) {
    try {
      const el = await this.page.$(selector);
      return el ? (await el.innerText()).trim() : '';
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

  // A selector value in config may be a single string OR an array of candidate
  // selectors tried in order (first one that yields a result wins). Arrays are
  // required for candidates that mix Playwright engines: a comma-joined string
  // like "text=/From:/i, button:has-text('From')" is NOT a selector union in
  // Playwright -- the text engine swallows the rest of the string -- so those
  // never matched anything. Pure-CSS unions (commas inside one css selector)
  // are still fine as a single string.
  _cands(sel) {
    return (Array.isArray(sel) ? sel : [sel]).filter(Boolean);
  }

  /** First candidate selector that is present; returns the selector or null. */
  async _presentAny(sel, timeout = this.timeout) {
    for (const s of this._cands(sel)) {
      if (await this._present(s, timeout)) return s;
    }
    return null;
  }

  async _textAny(sel) {
    for (const s of this._cands(sel)) {
      const t = await this._text(s);
      if (t) return t;
    }
    return '';
  }

  async _allTextAny(sel) {
    for (const s of this._cands(sel)) {
      const arr = await this._allText(s);
      if (arr.length) return arr;
    }
    return [];
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

  _contactsUrl() {
    // Derive the Contacts URL from the login URL origin (e.g. my.reiblackbook.com).
    try {
      return new URL(env.REIBB_LOGIN_URL).origin + '/contacts';
    } catch {
      return 'https://my.reiblackbook.com/contacts';
    }
  }

  // Try the phone in every format REI's search box might expect. Returns a
  // deduped, non-empty list; the raw-as-written value is always tried first.
  _phoneFormats(raw) {
    const asWritten = String(raw ?? '').trim();
    const d = asWritten.replace(/\D/g, '');
    const ten = d.length > 10 ? d.slice(-10) : d;
    if (ten.length !== 10) return [asWritten].filter(Boolean);
    const a = ten.slice(0, 3);
    const b = ten.slice(3, 6);
    const c = ten.slice(6);
    const formats = [asWritten, ten, `${a}-${b}-${c}`, `(${a}) ${b}-${c}`, `${a}.${b}.${c}`];
    return formats.filter((v, i, arr) => v && arr.indexOf(v) === i);
  }

  // Click the search box, clear it, type the term, press Enter. Confirmed
  // real-world bug: on a freshly loaded Contacts page the first attempt often
  // doesn't register (box stays empty). Callers retry once on failure.
  async _searchContactsOnce(term) {
    const { contacts } = this.sel;
    if (!(await this._present(contacts.searchInput, 4000))) return false;
    const input = this.page.locator(contacts.searchInput).first();
    await input.click().catch(() => {});
    await input.fill('').catch(() => {});
    await input.fill(String(term)).catch(() => {});
    await input.press('Enter').catch(() => {});
    await this.page.waitForTimeout(1300);
    const val = await input.inputValue().catch(() => '');
    return val === String(term);
  }

  async _searchContacts(term) {
    let ok = await this._searchContactsOnce(term);
    if (!ok) ok = await this._searchContactsOnce(term); // known-bug retry
    return ok;
  }

  // Confirmed flow: go to /contacts, search by PHONE ONLY — try every format
  // REI's search box might expect (as written, digits-only, dashed,
  // parenthesized, dotted). Never fall back to name/address search: if the
  // phone doesn't match in any format, this contact is "NO RESULT BY PHONE"
  // and must go to manual review, not a name-based guess. Opens the first
  // result by CLICKING it, with a direct-URL fallback if the click didn't
  // navigate.
  async findContact(query) {
    const { contacts } = this.sel;
    const terms = this._phoneFormats(query.phone);
    if (!terms.length) return { found: false, reason: 'No phone number to search REI BlackBook with' };

    await this.page.goto(this._contactsUrl(), { waitUntil: 'domcontentloaded' }).catch(() => {});
    await this.page.waitForTimeout(1200);

    for (const term of terms) {
      if (!(await this._searchContacts(term))) continue;

      if (await this._presentAny(contacts.noResultsMarker, 800)) continue;

      // Open the first contact result by CLICKING it, same as every tab
      // switch — this SPA does not reliably deep-link via a fresh page.goto()
      // to a /contacts/<id> URL; a hard reload can land on whatever contact
      // it last had loaded instead of the one in the URL. Only fall back to
      // goto(href) if the click genuinely fails to find/hit the link.
      if (!/\/contacts\/\d+/i.test(this.page.url())) {
        const clicked = await this.page
          .locator(contacts.resultRowLink)
          .first()
          .click({ timeout: 4000 })
          .then(() => true)
          .catch(() => false);
        if (!clicked) {
          const href = await this.page
            .evaluate(() =>
              Array.from(document.querySelectorAll("a[href*='/contacts/']"))
                .map((a) => a.href)
                .find((h) => /\/contacts\/\d+/i.test(h)) || ''
            )
            .catch(() => '');
          if (href) await this.page.goto(href, { waitUntil: 'domcontentloaded' }).catch(() => {});
        }
      }
      await this.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await this.page.waitForTimeout(1000);

      if (/\/contacts\/\d+/i.test(this.page.url())) {
        const id = this.page.url().match(/\/contacts\/(\d+)/i)?.[1] || query.contactId || String(term);
        this._cid = id; // remember for direct tab navigation
        this._curUrl = this.page.url().split('?')[0];
        return { found: true, contactId: id, matchedBy: term, reiUrl: this.page.url() };
      }
    }
    return { found: false, reason: 'NO RESULT BY PHONE — no REI BlackBook contact matched this phone number in any format' };
  }

  _contactTabUrl(tab) {
    const base = this._curUrl || (this._cid ? `${this._contactsUrl()}/${this._cid}` : null);
    return base ? `${base}?activeTab=${tab}` : null;
  }

  // This is a client-rendered app: switching tabs must be a CLICK on the tab
  // element, never a fresh page.goto(). A hard reload forces the whole SPA to
  // re-bootstrap and can race or fall back to a stale/default contact instead
  // of the one we just opened — this was the cause of facts being read for
  // the wrong person. Only the very first open of a contact (from the search
  // results) is a real navigation; every tab switch after that is a click.
  async _clickTab(tabSelector) {
    const found = await this._presentAny(tabSelector, 3000);
    if (!found) return false;
    await this.page.click(found).catch(() => {});
    await this.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await this.page.waitForTimeout(500);
    return true;
  }

  async _gotoTab(tab) {
    const c = this.sel.contact;
    const tabSelector = { about: c.aboutTab, activities: c.activitiesTab, notes: c.notesTab, chat: this.sel.chat.chatTab }[tab];
    await this._clickTab(tabSelector);
  }

  // Activities tab: STOP/DNC/complaint history must be checked before doing
  // anything else with this contact (per the real SOP — this was previously
  // never read, silently disabling that safety check in live mode).
  async _readActivities() {
    await this._gotoTab('activities');
    return this._allTextAny(this.sel.contact.activitiesList);
  }

  // Notes tab: free-text manual notes may say not to contact this lead.
  async _readNotes() {
    await this._gotoTab('notes');
    if (await this._presentAny(this.sel.contact.notesEmptyMarker, 1500)) return '';
    return (await this._allTextAny(this.sel.contact.notesList)).join(' \n ');
  }

  // Chat tab: prior thread may contain a STOP reply that never made it into
  // Activities.
  async _readChatHistory() {
    await this.openChatTab();
    return this._allTextAny(this.sel.chat.threadArea);
  }

  // Read the contact's phone number(s). Label-anchored selectors first; if none
  // of them resolve (REI's labels/DOM vary between accounts and versions),
  // fall back to scanning a scoped region of the page for phone-shaped text.
  // Without this fallback an unmatched selector silently yields NO phone, which
  // the SOP then reports as "Invalid Phone" on a contact that plainly shows one.
  async _readPhones() {
    const c = this.sel.contact;
    const direct = await this._allTextAny(c.phoneRows);
    if (direct.length) return direct;
    for (const s of this._cands(c.phoneScanScope)) {
      const found = extractUsPhones((await this._allText(s)).join(' \n '));
      if (found.length) {
        logger.warn('phone_read_via_scan', { scope: s, count: found.length });
        return found;
      }
    }
    return [];
  }

  async readContactFacts(contactId) {
    const c = this.sel.contact;
    // We land on About by default right after opening the contact.
    const name = await this._textAny(c.nameField);
    const address = await this._textAny(c.addressField);
    const phones = await this._readPhones();
    const tags = await this._allTextAny(c.tagChips);

    const activityLog = await this._readActivities();
    const notes = await this._readNotes();
    const chatHistory = await this._readChatHistory();
    await this._gotoTab('about'); // leave the contact on About for optInPhone()

    // Only the first-listed individual's first name goes in the SMS merge
    // field (e.g. "Tony & Sukien Lam" -> "Tony"); the full name above is kept
    // for verification/display/export. checkNameSafety (sop.js) blocks the
    // contact to manual review if this can't be confidently derived.
    const derivedFirst = deriveFirstName(name);

    return {
      found: true,
      contactId,
      reiUrl: this.page.url(), // direct link to this contact for the dashboard
      name,
      firstName: derivedFirst.ok ? derivedFirst.firstName : '',
      lastName: name.split(/\s+/).slice(1).join(' '),
      address,
      state: '',
      phones,
      tags,
      notes,
      chatHistory,
      activityLog,
      optOut: false, // derived by sop.js from tags/notes/chatHistory/activityLog
    };
  }

  async getSmsStatus() {
    // Not used by the engine; opt-in is confirmed inside optInPhone().
    return { smsEnabled: false, optedIn: false };
  }

  // Open the contact's Chat tab by clicking it (see _clickTab — never reload
  // the page to switch tabs on this SPA).
  async openChatTab() {
    await this._clickTab(this.sel.chat.chatTab);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Interface: actions
  // ---------------------------------------------------------------------------
  async optInPhone() {
    // Real flow: the phone icon next to the phone number on the About tab
    // (left sidebar, Primary Details). Three states, all distinct:
    //   - ALREADY opted in -> a green phone-with-check icon. Detected WITHOUT
    //     clicking (read-only), so we never re-open a modal on a phone that is
    //     already good to go.
    //   - "Phone Opted-Out" tooltip -> permanent opt-out, hard stop.
    //   - "Opt-In Contact" modal    -> not yet asked; confirm to opt in.
    const c = this.sel.contact;

    // Already opted in? Only an EXPLICIT affirmative marker counts here
    // (title/aria-label/text saying opted-in) -- deliberately not loose class
    // matching, because a false positive would let a non-opted-in number reach
    // the send step, which the SOP forbids.
    if (await this._presentAny(c.phoneOptedInMarker, 1500)) {
      return { status: 'opted_in', smsEnabled: true, reason: 'Phone was already opted in (no change made)' };
    }

    const icon = await this._presentAny(c.phoneOptInIcon, 4000);
    if (!icon) {
      return { status: 'failed', smsEnabled: false, reason: 'Could not find the phone opt-in icon next to the phone number' };
    }
    await this.page.click(icon).catch(() => {});
    await this.page.waitForTimeout(600);

    if (await this._presentAny(c.phoneOptedOutTooltip, 2000)) {
      await this.page.keyboard.press('Escape').catch(() => {});
      return {
        status: 'opted_out',
        smsEnabled: false,
        reason: 'Phone shows "Phone Opted-Out" in REI BlackBook — permanent, never send',
      };
    }

    if (await this._presentAny(c.optInModalMarker, 2000)) {
      const confirm = await this._presentAny(c.optInModalConfirmButton, 2000);
      if (confirm) {
        await this.page.click(confirm).catch(() => {});
        await this.page.waitForTimeout(1200);
        // Never trust the click alone -- require a visible opted-in marker.
        if (await this._presentAny(c.phoneOptedInMarker, 3000)) {
          return { status: 'opted_in', smsEnabled: true };
        }
        return {
          status: 'failed',
          smsEnabled: false,
          reason: 'Clicked opt-in but REI did not visibly confirm the phone is opted in',
        };
      }
      const cancel = await this._presentAny(c.optInModalCancelButton, 1000);
      if (cancel) await this.page.click(cancel).catch(() => {});
      return {
        status: 'failed',
        smsEnabled: false,
        reason: 'Opt-In Contact modal opened but its confirm button was not found — verify contact.optInModalConfirmButton in config/reibb.selectors.json',
      };
    }

    return {
      status: 'failed',
      smsEnabled: false,
      reason: 'Clicking the phone icon showed neither the "Opted-Out" tooltip nor the "Opt-In Contact" modal — verify contact.phoneOptInIcon in config/reibb.selectors.json',
    };
  }

  // Extract 10-digit numbers from a list of ProfitDial option labels.
  _digits10(s) {
    const d = String(s || '').replace(/\D/g, '');
    return d.length >= 10 ? d.slice(-10) : d;
  }

  // The "From:" list is VIRTUALIZED (100+ entries, no search box) — only the
  // options currently scrolled into view exist in the DOM. Scroll in chunks,
  // accumulating unique labels by trailing phone number, until either the
  // wanted number is found or two consecutive scrolls surface nothing new
  // (reached the end of the list). ~8-10 scroll/read cycles is normal.
  // Open the compose surface. Confirmed from a real screenshot: sending is done
  // through a "Send Text" MODAL (title "Send Text", a "From" dropdown, a "Write
  // Message"/"Add Text Here..." box, and Cancel / "Send Text" buttons). The
  // inline "Write Your Reply..." bar at the bottom of the Chat tab also exists.
  // Prefer the modal when it is present/openable, since that is the flow the
  // From-number picker belongs to.
  async _openComposer() {
    const { chat } = this.sel;
    await this.openChatTab();
    if (await this._presentAny(chat.sendTextModalMarker, 1200)) return 'modal';
    const opener = await this._presentAny(chat.sendTextModalOpen, 2000);
    if (opener) {
      await this.page.click(opener).catch(() => {});
      await this.page.waitForTimeout(800);
      if (await this._presentAny(chat.sendTextModalMarker, 2500)) return 'modal';
    }
    return 'inline';
  }

  async _scrollFromList(wantDigits = null, maxIterations = 20) {
    const { chat } = this.sel;
    const seen = new Map(); // digits10 -> label text
    let stableRounds = 0;
    let lastSize = -1;
    for (let i = 0; i < maxIterations; i++) {
      const labels = await this._allTextAny(chat.fromOptions);
      for (const l of labels) {
        const d = this._digits10(l);
        if (d.length === 10) seen.set(d, l);
      }
      if (wantDigits && seen.has(wantDigits)) break;
      if (seen.size === lastSize) {
        stableRounds += 1;
        if (stableRounds >= 2) break;
      } else {
        stableRounds = 0;
      }
      lastSize = seen.size;
      await this.page.mouse.wheel(0, 300).catch(() => {});
      await this.page.waitForTimeout(250);
    }
    return seen;
  }

  async getProfitDialNumbers() {
    // Compose surface "From" control -> long virtualized list of sender numbers.
    const { chat } = this.sel;
    await this._openComposer();
    const from = await this._presentAny(chat.fromControl, 4000);
    if (!from) return [];
    await this.page.click(from).catch(() => {});
    await this.page.waitForTimeout(600);
    const seen = await this._scrollFromList();
    await this.page.keyboard.press('Escape').catch(() => {});
    return [...seen.values()];
  }

  async selectProfitDial(contactId, number) {
    // Match by TRAILING phone number, not the campaign label (e.g. "Postcard
    // Ugly Houses - East Bay (510) 916-3995" — the source spreadsheet only
    // gives the number). NOTE: the compose surface defaults to some other
    // sender (e.g. "Realtor (510) 800-1607"), so this selection is mandatory
    // and is verified by digit-for-digit readback in sop.checkProfitDial.
    const { chat } = this.sel;
    await this._openComposer();
    const from = await this._presentAny(chat.fromControl, 4000);
    if (!from) {
      return { selected: false, readback: '', reason: 'ProfitDial "From" control not found on the compose surface' };
    }
    const want = this._digits10(number);
    await this.page.click(from).catch(() => {});
    await this.page.waitForTimeout(600);

    const seen = await this._scrollFromList(want);
    if (!seen.has(want)) {
      await this.page.keyboard.press('Escape').catch(() => {});
      return { selected: false, readback: '', reason: 'Assigned ProfitDial number not found after scrolling the full From list' };
    }
    const label = seen.get(want);
    let clicked = false;
    for (const s of this._cands(chat.fromOptions)) {
      const opt = this.page.locator(s).filter({ hasText: label }).first();
      if (await opt.click({ timeout: 2500 }).then(() => true).catch(() => false)) {
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      return { selected: false, readback: '', reason: 'Found the assigned ProfitDial in the list but could not click it' };
    }
    await this.page.waitForTimeout(500);
    const readback = await this._textAny(chat.fromSelectedText);
    return { selected: true, readback };
  }

  async enterMessage(contactId, text) {
    const { chat } = this.sel;
    await this._openComposer();
    // The message box may be a plain textarea ("Add Text Here..." in the Send
    // Text modal) or TinyMCE inside an iframe (the inline reply bar). Type real
    // keystrokes (pressSequentially) either way, or the Send button won't enable.
    for (const fsel of this._cands(chat.editorFrame)) {
      if (await this._present(fsel, 1500)) {
        const body = this.page.frameLocator(fsel).locator('body');
        if (await body.click({ timeout: 2500 }).then(() => true).catch(() => false)) {
          await body.pressSequentially(text, { delay: 15 });
          return { entered: true };
        }
      }
    }
    for (const s of this._cands(chat.messageInput)) {
      if (!(await this._present(s, 2000))) continue;
      const el = this.page.locator(s).first();
      if (await el.click({ timeout: 2500 }).then(() => true).catch(() => false)) {
        await el.pressSequentially(text, { delay: 15 });
        return { entered: true };
      }
    }
    return { entered: false, reason: 'Could not find the message box on the compose surface' };
  }

  async sendMessage() {
    // Reaching here means env.liveSendGate already allowed it.
    const { chat } = this.sel;
    const btn = await this._presentAny(chat.sendButton, 3000);
    if (!btn) return { sent: false, reason: 'Send button not found' };
    await this.page.click(btn);
    await this.page.waitForTimeout(1500);
    return { sent: true };
  }

  async verifyMessageSent(contactId, text) {
    // This app confirms by re-reading the thread for the exact text just sent.
    const { chat } = this.sel;
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const hay = norm((await this._allTextAny(chat.threadArea)).join(' '));
    if (!hay) return { verified: false, reason: 'Could not read the conversation thread' };
    if (text && !hay.includes(norm(text))) {
      return { verified: false, reason: 'Sent text not found in the thread after sending' };
    }
    return { verified: true };
  }

  async readDeliveryStatus() {
    // Status updates asynchronously. Red "Undelivered" = failed; a plain sent
    // bubble = delivered. Poll a few times for the Undelivered flag.
    const { chat } = this.sel;
    for (let i = 0; i < 5; i++) {
      if (await this._presentAny(chat.deliveryUndelivered, 1500)) {
        return { delivery: 'failed' };
      }
      await this.page.waitForTimeout(2000);
    }
    return { delivery: 'delivered' };
  }

  async readReplies() {
    return { text: await this._textAny(this.sel.chat.lastInboundMessage) };
  }
}
