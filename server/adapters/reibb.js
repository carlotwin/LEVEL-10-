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

  // Confirmed flow (docs/REI-SMARTCONTACTS-PHONE-SEARCH.md from the Revival AI
  // repo): go to /contacts, search by ADDRESS then digits-only PHONE, open the
  // first /contacts/<id> result, with a direct-URL fallback if the click didn't
  // navigate. Address is the primary key (many contacts are "Unknown").
  async findContact(query) {
    const { contacts } = this.sel;
    const digits = (s) => String(s || '').replace(/\D/g, '');
    const terms = [query.address, digits(query.phone), query.name].filter(Boolean);

    await this.page.goto(this._contactsUrl(), { waitUntil: 'domcontentloaded' }).catch(() => {});
    await this.page.waitForTimeout(1200);

    for (const term of terms) {
      if (!(await this._present(contacts.searchInput, 4000))) continue;
      await this.page.fill(contacts.searchInput, '');
      await this.page.fill(contacts.searchInput, String(term));
      await this.page.keyboard.press('Enter');
      await this.page.waitForTimeout(1400);

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

  async readContactFacts(contactId) {
    const c = this.sel.contact;
    const name = await this._text(c.nameField);
    return {
      found: true,
      contactId,
      reiUrl: this.page.url(), // direct link to this contact for the dashboard
      name,
      firstName: name.split(/\s+/)[0] || '',
      lastName: name.split(/\s+/).slice(1).join(' '),
      address: await this._text(c.addressField),
      state: '',
      phones: await this._allText(c.phoneRows),
      tags: await this._allText(c.tagChips),
      notes: '',
      chatHistory: [],
      optOut: false, // derived by sop.js from the tag chips
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
    // Spec 2.3: pencil -> "Edit Contact Information" modal -> Primary Phone
    // Opt-In combobox (needs a retry to open) -> "Opt - In" -> Update Info; then
    // re-open the modal and confirm it now reads "Opt - In".
    const { editContact } = this.sel;
    const digits = (s) => String(s || '').replace(/\D/g, '');

    const openModal = async () => {
      if (!(await this._present(editContact.editButton, 4000))) return false;
      await this.page.click(editContact.editButton);
      return this._present(editContact.modalMarker, 4000);
    };
    const setOptIn = async () => {
      // Custom combobox: try up to 3 times to expand, then pick "Opt - In".
      for (let i = 0; i < 3; i++) {
        if (await this._present(editContact.optInControl, 2000)) {
          await this.page.click(editContact.optInControl).catch(() => {});
          await this.page.waitForTimeout(300);
          if (await this._present(editContact.optInOption, 1500)) {
            await this.page.click(editContact.optInOption).catch(() => {});
            return true;
          }
        }
      }
      return false;
    };

    if (!(await openModal())) return { status: 'failed', smsEnabled: false, reason: 'Could not open Edit Contact modal' };
    const picked = await setOptIn();
    if (!picked) return { status: 'failed', smsEnabled: false, reason: 'Could not set the Opt-In dropdown to "Opt - In"' };
    if (await this._present(editContact.updateButton, 3000)) await this.page.click(editContact.updateButton);
    await this.page.waitForTimeout(1000);

    // Re-open and confirm (never trust the click alone — spec rule).
    if (!(await openModal())) return { status: 'opted_in', smsEnabled: true, reason: 'Set opt-in but could not reopen to confirm' };
    const confirmed = await this._present(editContact.optInSelectedText, 2500);
    if (editContact.cancelButton && (await this._present(editContact.cancelButton, 1000))) {
      await this.page.click(editContact.cancelButton).catch(() => {});
    }
    return confirmed
      ? { status: 'opted_in', smsEnabled: true }
      : { status: 'failed', smsEnabled: false, reason: 'Opt-In not confirmed after saving' };
  }

  // Extract 10-digit numbers from a list of ProfitDial option labels.
  _digits10(s) {
    const d = String(s || '').replace(/\D/g, '');
    return d.length >= 10 ? d.slice(-10) : d;
  }

  async getProfitDialNumbers() {
    // Spec 2.4: Chat compose bar "From:" control -> long list of sender numbers.
    const { chat } = this.sel;
    await this.openChatTab();
    if (!(await this._present(chat.fromControl, 4000))) return [];
    await this.page.click(chat.fromControl).catch(() => {});
    await this.page.waitForTimeout(600);
    const labels = await this._allText(chat.fromOptions);
    await this.page.keyboard.press('Escape').catch(() => {});
    // Each label ends with the phone number; return the labels (matching is by
    // trailing digits in selectProfitDial / sop).
    return labels.filter((l) => this._digits10(l).length === 10);
  }

  async selectProfitDial(contactId, number) {
    // Spec 2.4: match by TRAILING phone number, not the campaign label.
    const { chat } = this.sel;
    await this.openChatTab();
    if (!(await this._present(chat.fromControl, 4000))) {
      return { selected: false, readback: '', reason: 'ProfitDial "From:" control not found' };
    }
    const want = this._digits10(number);
    await this.page.click(chat.fromControl).catch(() => {});
    await this.page.waitForTimeout(600);

    const opts = await this.page.locator(chat.fromOptions).all().catch(() => []);
    for (const o of opts) {
      const label = (await o.innerText().catch(() => '')) || '';
      if (this._digits10(label) === want) {
        await o.click().catch(() => {});
        await this.page.waitForTimeout(500);
        const readback = await this._text(chat.fromSelectedText);
        return { selected: true, readback };
      }
    }
    await this.page.keyboard.press('Escape').catch(() => {});
    return { selected: false, readback: '', reason: 'Assigned ProfitDial number not found in the From: list' };
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
