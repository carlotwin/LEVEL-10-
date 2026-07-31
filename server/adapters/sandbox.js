// =============================================================================
// SANDBOX adapter — a full in-memory simulation of REI BlackBook.
//
// Implements the shared adapter interface. Contacts nobody real; sends reach no
// carrier. Behavior per contact is driven by the seed's `behavior` block so we
// can exercise every scenario in requirement #8.
//
// This adapter is the ONLY adapter that runs when SANDBOX=true. It is incapable
// of contacting a carrier — there is no network code here at all.
// =============================================================================
import { Adapter } from './adapter-interface.js';
import { CONTACTS, POOL_A, POOL_B } from '../../config/sandbox/seed.js';
import { digitsOnly, normalizePhone } from '../automation/sop.js';
import { searchResultStatus } from '../automation/contactMatch.js';
import { L10_STATUS } from '../automation/constants.js';

export class SandboxAdapter extends Adapter {
  constructor({ contacts = CONTACTS } = {}) {
    super();
    this.contacts = new Map(contacts.map((c) => [c.contactId, structuredClone(c)]));
    this._entered = new Map(); // contactId -> entered text
    this._sent = new Set(); // contactId -> sent flag
  }

  get name() {
    return 'sandbox';
  }
  get isSandbox() {
    return true;
  }

  _get(contactId) {
    return this.contacts.get(contactId) || null;
  }

  async listContacts() {
    return [...this.contacts.keys()];
  }

  /**
   * Simulated Smart Contacts phone search. Mirrors the live adapter's contract:
   * gather EVERY candidate whose phone matches, decide nothing. Scenario contacts
   * flagged `found: false` are treated as absent from REI.
   */
  async findContact(query) {
    const wantTen = normalizePhone(query?.phone);
    if (!wantTen || wantTen.length !== 10) {
      return {
        status: L10_STATUS.MANUAL_REVIEW_REQUIRED,
        candidates: [],
        searched: [],
        stage: `spreadsheet phone "${query?.phone ?? ''}" is not a usable 10-digit number`,
      };
    }

    const candidates = [];
    for (const c of this.contacts.values()) {
      if (c.found === false) continue; // scenario: not in REI at all
      if ((c.phones || []).some((p) => normalizePhone(p) === wantTen)) {
        // Same candidate contract as the live adapter.
        candidates.push({
          contactId: c.contactId,
          name: c.name || [c.firstName, c.lastName].filter(Boolean).join(' '),
          phone: (c.phones || [])[0] || '',
          address: c.address || '',
          rowReference: candidates.length,
        });
      }
    }

    return {
      status: searchResultStatus(candidates.length),
      candidates,
      searched: [`phone:"${wantTen}"→${candidates.length} row(s)`],
    };
  }

  /** Open a candidate the decision layer selected. */
  async openContact(candidate) {
    const c = candidate?.contactId ? this._get(candidate.contactId) : null;
    if (!c) return { opened: false, reason: `sandbox has no contact ${candidate?.contactId}` };
    return { opened: true, contactId: c.contactId };
  }

  async readContactFacts(contactId) {
    const c = this._get(contactId);
    if (!c || c.found === false) return { found: false, contactId };
    return {
      found: true,
      contactId: c.contactId,
      firstName: c.firstName,
      lastName: c.lastName,
      name: c.name,
      address: c.address,
      state: c.state,
      tags: c.tags,
      notes: c.notes,
      chatHistory: c.chatHistory,
      phones: c.phones,
      optOut: c.optOut,
    };
  }

  /** Sandbox always has an Opt In control unless a scenario says otherwise. */
  async optInAvailable(contactId) {
    const c = this._get(contactId);
    return c?.behavior?.optIn !== 'unavailable';
  }

  /** Sandbox always has a sender selector unless a scenario says otherwise. */
  async profitDialSelectorAvailable(contactId) {
    const c = this._get(contactId);
    return c?.behavior?.profitDialSelector !== 'unavailable';
  }

  async getSmsStatus(contactId) {
    const c = this._get(contactId);
    return { smsEnabled: Boolean(c?.optedIn), optedIn: Boolean(c?.optedIn) };
  }

  async optInPhone(contactId) {
    const c = this._get(contactId);
    if (!c) return { status: 'failed', smsEnabled: false, reason: 'no such contact' };
    if (c.behavior.optIn === 'fail') {
      return { status: 'failed', smsEnabled: false, reason: 'Carrier rejected opt-in (simulated)' };
    }
    c.optedIn = true;
    return { status: 'opted_in', smsEnabled: true };
  }

  async getProfitDialNumbers(contactId) {
    const c = this._get(contactId);
    // Per-scenario availability; defaults to both pool numbers.
    return c?.behavior?.availableProfitDial ?? [POOL_A, POOL_B];
  }

  async selectProfitDial(contactId, number) {
    const c = this._get(contactId);
    if (!c) return { selected: false, readback: '', reason: 'no such contact' };
    const avail = (c.behavior.availableProfitDial ?? [POOL_A, POOL_B]).map(digitsOnly);
    const want = digitsOnly(number);
    if (!avail.includes(want)) {
      return { selected: false, readback: '', reason: 'number not available in selector' };
    }
    // Simulate a UI glitch where a different number ends up selected.
    if (c.behavior.readback === 'wrong') {
      const other = avail.find((n) => n !== want) || want;
      return { selected: true, readback: other };
    }
    return { selected: true, readback: want };
  }

  async enterMessage(contactId, text) {
    this._entered.set(contactId, text);
    return { entered: true };
  }

  async sendMessage(contactId) {
    const c = this._get(contactId);
    if (!c) return { sent: false, reason: 'no such contact' };
    if (c.behavior.send === 'fail') return { sent: false, reason: 'send action failed (simulated)' };
    this._sent.add(contactId);
    return { sent: true };
  }

  async verifyMessageSent(contactId, text) {
    const c = this._get(contactId);
    if (!c) return { verified: false, reason: 'no such contact' };
    if (c.behavior.verify === 'fail') return { verified: false, reason: 'message not found in thread (simulated)' };
    const entered = this._entered.get(contactId);
    if (!this._sent.has(contactId)) return { verified: false, reason: 'send was not performed' };
    if (text && entered && entered !== text) return { verified: false, reason: 'thread text does not match' };
    return { verified: true };
  }

  async readDeliveryStatus(contactId) {
    const c = this._get(contactId);
    return { delivery: c?.behavior?.delivery ?? 'pending' };
  }

  async readReplies(contactId) {
    const c = this._get(contactId);
    return { text: c?.behavior?.reply ?? '' };
  }
}
