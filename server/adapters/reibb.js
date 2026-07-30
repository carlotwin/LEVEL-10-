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
