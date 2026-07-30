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
import { digitsOnly } from '../automation/sop.js';

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

  async findContact(query) {
    // Accept {contactId} directly, else match by phone/address.
    if (query?.contactId) {
      const c = this._get(query.contactId);
      return c ? { found: c.found !== false, contactId: c.contactId } : { found: false };
    }
    for (const c of this.contacts.values()) {
      if (query?.phone && c.phones.some((p) => digitsOnly(p) === digitsOnly(query.phone))) {
        return { found: c.found !== false, contactId: c.contactId };
      }
    }
    return { found: false };
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
