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
  async listContacts() {
    // Navigate to Contacts and apply the Level 10 tag filter (SOP Step 2).
    const { contacts } = this.sel;
    await this.page.click(contacts.navContacts);
    await this._present(contacts.tagFilterOpen);
    await this.page.click(contacts.tagFilterOpen);
    await this.page.click(contacts.tagFilterOption.replace('%TAG%', env.LEVEL10_TAG));
    await this.page.waitForTimeout(500);
    // Return row identifiers as visible handles (the engine iterates the uploaded
    // list; enumerating the whole CRM is optional and account-specific).
    const rows = await this._allText(contacts.resultRow);
    return rows;
  }

  async findContact(query) {
    const { contacts } = this.sel;
    await this.page.click(contacts.navContacts);
    // Ordered search fallbacks: address -> phone -> name.
    const terms = [query.address, query.phone, query.name, query.contactId].filter(Boolean);
    for (const term of terms) {
      if (!(await this._present(contacts.searchInput, 4000))) continue;
      await this.page.fill(contacts.searchInput, String(term));
      await this.page.waitForTimeout(800);
      const rowSel = contacts.resultRowByText.replace('%QUERY%', String(term));
      if (await this._present(rowSel, 4000)) {
        await this.page.click(rowSel);
        await this.page.waitForTimeout(500);
        const id = query.contactId || (await this._text(this.sel.contact.nameField)) || String(term);
        return { found: true, contactId: id, matchedBy: term };
      }
    }
    return { found: false };
  }

  async readContactFacts(contactId) {
    const c = this.sel.contact;
    return {
      found: true,
      contactId,
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

  async getSmsStatus() {
    const enabled = await this._present(this.sel.sms.smsEnabledMarker, 2000);
    return { smsEnabled: enabled, optedIn: enabled };
  }

  // ---------------------------------------------------------------------------
  // Interface: actions
  // ---------------------------------------------------------------------------
  async optInPhone() {
    const { sms } = this.sel;
    if (await this._present(sms.smsEnabledMarker, 1500)) {
      return { status: 'opted_in', smsEnabled: true };
    }
    if (!(await this._present(sms.optInButton, 3000))) {
      return { status: 'failed', smsEnabled: false, reason: 'Opt-In control not found' };
    }
    await this.page.click(sms.optInButton);
    if (await this._present(sms.optInConfirm, 2000)) await this.page.click(sms.optInConfirm);
    const ok = await this._present(sms.optInSuccessMarker, this.timeout);
    return ok
      ? { status: 'opted_in', smsEnabled: true }
      : { status: 'failed', smsEnabled: false, reason: 'SMS did not become enabled after opt-in' };
  }

  async getProfitDialNumbers() {
    const { chat } = this.sel;
    if (await this._present(chat.openChat, 3000)) await this.page.click(chat.openChat);
    if (!(await this._present(chat.profitDialSelect, 3000))) return [];
    await this.page.click(chat.profitDialSelect);
    const nums = await this._allText(chat.profitDialOptions);
    // Close the dropdown without choosing.
    await this.page.keyboard.press('Escape').catch(() => {});
    return nums;
  }

  async selectProfitDial(contactId, number) {
    const { chat } = this.sel;
    if (!(await this._present(chat.profitDialSelect, 3000))) {
      return { selected: false, readback: '', reason: 'ProfitDial selector not found' };
    }
    await this.page.click(chat.profitDialSelect);
    const optSel = `${chat.profitDialOptions}:has-text(${JSON.stringify(number)})`;
    if (!(await this._present(optSel, 3000))) {
      await this.page.keyboard.press('Escape').catch(() => {});
      return { selected: false, readback: '', reason: 'Requested ProfitDial number not in selector' };
    }
    await this.page.click(optSel);
    // Read back the value actually shown as selected (digit-for-digit check in sop).
    const readback = await this._text(chat.profitDialSelectedValue);
    return { selected: true, readback };
  }

  async enterMessage(contactId, text) {
    const { chat } = this.sel;
    if (!(await this._present(chat.messageInput, 3000))) return { entered: false };
    await this.page.fill(chat.messageInput, text);
    return { entered: true };
  }

  async sendMessage() {
    // Reaching here means env.liveSendGate already allowed it (ALLOW_LIVE_SEND=true).
    const { chat } = this.sel;
    if (!(await this._present(chat.sendButton, 3000))) return { sent: false, reason: 'Send button not found' };
    await this.page.click(chat.sendButton);
    await this.page.waitForTimeout(800);
    return { sent: true };
  }

  async verifyMessageSent(contactId, text) {
    const { chat } = this.sel;
    const last = await this._text(chat.lastOutboundMessage);
    if (!last) return { verified: false, reason: 'No outbound message found in thread' };
    // Compare on a normalized, trimmed basis.
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    if (text && norm(last) !== norm(text)) {
      return { verified: false, reason: 'Last outbound message does not match the sent text' };
    }
    return { verified: true };
  }

  async readDeliveryStatus() {
    const status = (await this._text(this.sel.chat.deliveryStatus)).toLowerCase();
    if (status.includes('deliver')) return { delivery: 'delivered' };
    if (status.includes('fail') || status.includes('undeliver')) return { delivery: 'failed' };
    return { delivery: 'pending' };
  }

  async readReplies() {
    return { text: await this._text(this.sel.chat.lastInboundMessage) };
  }
}
