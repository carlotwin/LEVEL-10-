// =============================================================================
// Campaign duplicate ledger (requirement #6).
//
// Keyed on: campaignBatch + REIContactID + normalizedPhone.
// This is NOT a monthly reset. Once a contact is worked for a campaign batch it
// stays recorded across restarts, re-uploads, and browser crashes, so the same
// Level 10 contact never receives the same campaign message twice.
//
// Stored per entry:
//   campaignBatch, reiContactId, phone, profitDial, templateId,
//   dateTime, sendVerified, disposition
//
// Persisted as JSON on disk; loaded once and written after each record.
// =============================================================================
import fs from 'node:fs';
import { ledgerPath } from './paths.js';
import { normalizePhone } from '../automation/sop.js';

function makeKey(campaignBatch, reiContactId, phone) {
  return [
    String(campaignBatch || '').trim(),
    String(reiContactId || '').trim(),
    normalizePhone(phone),
  ].join('|');
}

export class SentLedger {
  constructor(file = ledgerPath()) {
    this.file = file;
    this.map = new Map();
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const e of raw.entries || []) this.map.set(e.key, e);
    } catch {
      /* no ledger yet */
    }
  }

  _save() {
    const payload = { version: 1, entries: [...this.map.values()] };
    fs.writeFileSync(this.file, JSON.stringify(payload, null, 2));
  }

  /** Has this contact already been worked for this campaign batch? */
  has(campaignBatch, reiContactId, phone) {
    return this.map.has(makeKey(campaignBatch, reiContactId, phone));
  }

  get(campaignBatch, reiContactId, phone) {
    return this.map.get(makeKey(campaignBatch, reiContactId, phone)) || null;
  }

  /**
   * Record a processed contact. Idempotent on the key (last write wins, but the
   * key never changes so a re-run is a no-op update, not a second text).
   */
  record({
    campaignBatch,
    reiContactId,
    phone,
    profitDial = '',
    templateId = '',
    sendVerified = false,
    disposition = '',
    // 'pending'   written BEFORE the send, so a crash mid-send is not retried
    // 'sent'      the outgoing message was confirmed in the REI thread
    // 'uncertain' the send was clicked but confirmation failed — never auto-retry
    // 'blocked'   stopped before any send attempt; a clean retry is safe
    state = sendVerified ? 'sent' : 'blocked',
    dateTime = new Date().toISOString(),
  }) {
    const key = makeKey(campaignBatch, reiContactId, phone);
    const entry = {
      key,
      campaignBatch,
      reiContactId,
      phone: normalizePhone(phone),
      profitDial,
      templateId,
      dateTime,
      sendVerified,
      disposition,
      state,
    };
    this.map.set(key, entry);
    this._save();
    return entry;
  }

  /**
   * Template counts for balanced rotation — CONFIRMED sends only. A blocked,
   * failed, pending, uncertain or read-only record must not consume a template,
   * otherwise rotation drifts on rows that never reached a homeowner.
   */
  templateUsage(campaignBatch) {
    const counts = {};
    for (const e of this.map.values()) {
      if (e.campaignBatch !== campaignBatch) continue;
      if (!e.templateId) continue;
      if (e.sendVerified !== true || e.state !== 'sent') continue;
      counts[e.templateId] = (counts[e.templateId] || 0) + 1;
    }
    return counts;
  }

  /**
   * Has this lead already been sent to, or is it mid-send / uncertain? Any of
   * those means DO NOT SEND AGAIN. Only a clean pre-send 'blocked' record may be
   * retried, which is why this is narrower than has().
   */
  isSendBlocked(campaignBatch, reiContactId, phone) {
    return this._blockedBy(this.get(campaignBatch, reiContactId, phone));
  }

  /**
   * Same question keyed on the PHONE alone, within the campaign.
   *
   * The homeowner is the phone. Two spreadsheet rows, or one row plus the REI
   * contact id, produce different ledger keys for the same person — so an id-only
   * check let a second row text somebody who had already been contacted.
   */
  isSendBlockedByPhone(campaignBatch, phone) {
    const want = normalizePhone(phone);
    if (!want) return null;
    for (const e of this.map.values()) {
      if (e.campaignBatch !== campaignBatch || e.phone !== want) continue;
      const blocked = this._blockedBy(e);
      if (blocked) return blocked;
    }
    return null;
  }

  _blockedBy(e) {
    if (!e) return null;
    if (e.sendVerified === true || e.state === 'sent') return { reason: 'already sent and confirmed', entry: e };
    if (e.state === 'pending') return { reason: 'a send was started and never confirmed', entry: e };
    if (e.state === 'uncertain') return { reason: 'a previous send could not be confirmed — needs a human', entry: e };
    return null;
  }

  /** The most recently CONFIRMED templateId for a campaign batch. */
  lastTemplateId(campaignBatch) {
    let latest = null;
    for (const e of this.map.values()) {
      if (e.campaignBatch !== campaignBatch || !e.templateId) continue;
      if (e.sendVerified !== true || e.state !== 'sent') continue;
      if (!latest || e.dateTime > latest.dateTime) latest = e;
    }
    return latest ? latest.templateId : null;
  }

  all(campaignBatch) {
    return [...this.map.values()].filter((e) => !campaignBatch || e.campaignBatch === campaignBatch);
  }
}
