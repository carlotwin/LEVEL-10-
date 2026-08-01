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

  // Format a phone number the way REI's search box expects: dashed, no
  // parens (e.g. "510-653-9161"). Returns '' if we don't have 10 digits.
  _dashedPhone(raw) {
    const d = String(raw || '').replace(/\D/g, '');
    const ten = d.length > 10 ? d.slice(-10) : d;
    return ten.length === 10 ? `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}` : '';
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

  // Confirmed flow: go to /contacts, search by PHONE first (dashed format —
  // this is the CRM's primary lookup key per the real navigation spec), fall
  // back to address/name if the phone doesn't match. Open the first
  // /contacts/<id> result, with a direct-URL fallback if the click didn't
  // navigate.
  async findContact(query) {
    const { contacts } = this.sel;
    const terms = [this._dashedPhone(query.phone), query.address, query.name].filter(Boolean);

    await this.page.goto(this._contactsUrl(), { waitUntil: 'domcontentloaded' }).catch(() => {});
    await this.page.waitForTimeout(1200);

    for (const term of terms) {
      if (!(await this._searchContacts(term))) continue;

      if (contacts.noResultsMarker && (await this._present(contacts.noResultsMarker, 800))) continue;

      // Open the first contact result; fall back to a direct /contacts/<id> goto.
      if (!/\/contacts\/\d+/i.test(this.page.url())) {
        const href = await this.page
          .evaluate(() =>
            Array.from(document.querySelectorAll("a[href*='/contacts/']"))
              .map((a) => a.href)
              .find((h) => /\/contacts\/\d+/i.test(h)) || ''
          )
          .catch(() => '');
        if (href) await this.page.goto(href, { waitUntil: 'domcontentloaded' }).catch(() => {});
        else await this.page.locator(contacts.resultRowLink).first().click().catch(() => {});
      }
      await this.page.waitForTimeout(1000);

      if (/\/contacts\/\d+/i.test(this.page.url())) {
        const id = this.page.url().match(/\/contacts\/(\d+)/i)?.[1] || query.contactId || String(term);
        this._cid = id; // remember for direct tab navigation
        this._curUrl = this.page.url().split('?')[0];
        return { found: true, contactId: id, matchedBy: term, reiUrl: this.page.url() };
      }
    }
    return { found: false };
  }

  _contactTabUrl(tab) {
    const base = this._curUrl || (this._cid ? `${this._contactsUrl()}/${this._cid}` : null);
    return base ? `${base}?activeTab=${tab}` : null;
  }

  async _gotoTab(tab) {
    const url = this._contactTabUrl(tab);
    if (!url) return;
    await this.page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await this.page.waitForTimeout(600);
  }

  // Activities tab: STOP/DNC/complaint history must be checked before doing
  // anything else with this contact (per the real SOP — this was previously
  // never read, silently disabling that safety check in live mode).
  async _readActivities() {
    await this._gotoTab('activities');
    return this._allText(this.sel.contact.activitiesList);
  }

  // Notes tab: free-text manual notes may say not to contact this lead.
  async _readNotes() {
    await this._gotoTab('notes');
    if (await this._present(this.sel.contact.notesEmptyMarker, 1500)) return '';
    return (await this._allText(this.sel.contact.notesList)).join(' \n ');
  }

  // Chat tab: prior thread may contain a STOP reply that never made it into
  // Activities.
  async _readChatHistory() {
    await this.openChatTab();
    return this._allText(this.sel.chat.threadArea);
  }

  async readContactFacts(contactId) {
    const c = this.sel.contact;
    // We land on About by default right after opening the contact.
    const name = await this._text(c.nameField);
    const address = await this._text(c.addressField);
    const phones = await this._allText(c.phoneRows);
    const tags = await this._allText(c.tagChips);

    const activityLog = await this._readActivities();
    const notes = await this._readNotes();
    const chatHistory = await this._readChatHistory();
    await this._gotoTab('about'); // leave the contact on About for optInPhone()

    return {
      found: true,
      contactId,
      reiUrl: this.page.url(), // direct link to this contact for the dashboard
      name,
      firstName: name.split(/\s+/)[0] || '',
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

  // Open the contact's Chat tab. Prefer direct URL (?activeTab=chat) which is
  // more reliable than clicking; fall back to the Chat tab element.
  async openChatTab() {
    const url = this._contactTabUrl('chat');
    if (url && !/[?&]activeTab=chat/i.test(this.page.url())) {
      await this.page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await this.page.waitForTimeout(800);
    }
    const { chat } = this.sel;
    if (chat.chatTab && (await this._present(chat.chatTab, 3000))) {
      await this.page.click(chat.chatTab).catch(() => {});
      await this.page.waitForTimeout(400);
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Interface: actions
  // ---------------------------------------------------------------------------
  async optInPhone() {
    // Real flow: click the phone icon next to the phone number on the About
    // tab (left sidebar, Primary Details). Exactly two outcomes, and they are
    // NOT interchangeable:
    //   - "Phone Opted-Out" tooltip  -> permanent opt-out, hard stop.
    //   - "Opt-In Contact" modal     -> not yet asked; confirm to opt in.
    // There is no third state and no label until you click.
    const c = this.sel.contact;

    if (!(await this._present(c.phoneOptInIcon, 4000))) {
      return { status: 'failed', smsEnabled: false, reason: 'Could not find the phone opt-in icon next to the phone number' };
    }
    await this.page.click(c.phoneOptInIcon).catch(() => {});
    await this.page.waitForTimeout(600);

    if (await this._present(c.phoneOptedOutTooltip, 2000)) {
      await this.page.keyboard.press('Escape').catch(() => {});
      return {
        status: 'opted_out',
        smsEnabled: false,
        reason: 'Phone shows "Phone Opted-Out" in REI BlackBook — permanent, never send',
      };
    }

    if (await this._present(c.optInModalMarker, 2000)) {
      if (await this._present(c.optInModalConfirmButton, 2000)) {
        await this.page.click(c.optInModalConfirmButton).catch(() => {});
        await this.page.waitForTimeout(800);
        return { status: 'opted_in', smsEnabled: true };
      }
      if (await this._present(c.optInModalCancelButton, 1000)) {
        await this.page.click(c.optInModalCancelButton).catch(() => {});
      }
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
  async _scrollFromList(wantDigits = null, maxIterations = 20) {
    const { chat } = this.sel;
    const seen = new Map(); // digits10 -> label text
    let stableRounds = 0;
    let lastSize = -1;
    for (let i = 0; i < maxIterations; i++) {
      const labels = await this._allText(chat.fromOptions);
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
    // Chat compose bar "From:" control -> long virtualized list of sender numbers.
    const { chat } = this.sel;
    await this.openChatTab();
    if (!(await this._present(chat.fromControl, 4000))) return [];
    await this.page.click(chat.fromControl).catch(() => {});
    await this.page.waitForTimeout(600);
    const seen = await this._scrollFromList();
    await this.page.keyboard.press('Escape').catch(() => {});
    return [...seen.values()];
  }

  async selectProfitDial(contactId, number) {
    // Match by TRAILING phone number, not the campaign label (e.g. "Postcard
    // Ugly Houses - East Bay (510) 916-3995" — the source spreadsheet only
    // gives the number).
    const { chat } = this.sel;
    await this.openChatTab();
    if (!(await this._present(chat.fromControl, 4000))) {
      return { selected: false, readback: '', reason: 'ProfitDial "From:" control not found' };
    }
    const want = this._digits10(number);
    await this.page.click(chat.fromControl).catch(() => {});
    await this.page.waitForTimeout(600);

    const seen = await this._scrollFromList(want);
    if (!seen.has(want)) {
      await this.page.keyboard.press('Escape').catch(() => {});
      return { selected: false, readback: '', reason: 'Assigned ProfitDial number not found after scrolling the full From: list' };
    }
    const label = seen.get(want);
    const opt = this.page.locator(chat.fromOptions).filter({ hasText: label }).first();
    await opt.click().catch(() => {});
    await this.page.waitForTimeout(500);
    const readback = await this._text(chat.fromSelectedText);
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
    // Spec 2.5: status updates asynchronously. Red "Undelivered" = failed; a
    // plain sent bubble = delivered. Poll a few times for the Undelivered flag.
    const { chat } = this.sel;
    for (let i = 0; i < 5; i++) {
      if (chat.deliveryUndelivered && (await this._present(chat.deliveryUndelivered, 1500))) {
        return { delivery: 'failed' };
      }
      await this.page.waitForTimeout(2000);
    }
    return { delivery: 'delivered' };
  }

  async readReplies() {
    return { text: await this._text(this.sel.chat.lastInboundMessage) };
  }
}
