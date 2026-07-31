// =============================================================================
// ENGINE — the orchestrator. Runs the SOP pipeline for each contact, in order,
// performing actions via the adapter and decisions via the pure sop.js gates.
//
// Control model: Start / Pause / Resume / Stop.
//   - Pause halts BETWEEN contacts; a contact already in flight always finishes,
//     so a send is never left half-done.
//   - State is persisted after EVERY contact (resume-safe, no double-sends).
//   - Batch cap (MAX_SENDS_PER_RUN) protects the sending numbers.
//
// The engine NEVER decides eligibility itself — it asks sop.js. It NEVER sends
// unless the env.liveSendGate allows it (sandbox = simulated).
// =============================================================================
import { EventEmitter } from 'node:events';
import { env, assertRunnable, liveSendGate } from '../config/env.js';
import { createAdapter } from '../adapters/factory.js';
import * as sop from './sop.js';
import {
  assertMessageIntegrity,
  anyPlaceholderEnabled,
  allocateTemplate,
  renderTemplate,
} from './message.js';
import { buildProfitDialIndex, matchProfitDial } from './profitdial.js';
import { DISPOSITION, SENT_DISPOSITIONS, L10_STATUS, STATUS_TO_DISPOSITION } from './constants.js';
import { chooseContact } from './contactMatch.js';
import { Store } from '../data/store.js';
import { SentLedger } from '../data/sentLedger.js';
import { logger } from '../logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Engine extends EventEmitter {
  constructor() {
    super();
    this.store = new Store();
    this.ledger = new SentLedger();
    this.adapter = null;
    this.contacts = [];
    this.pdIndex = null;
    this._loop = null;
    this._pauseRequested = false;
    this._stopRequested = false;
    this._sendsThisRun = 0;
    this.config = {
      level10Tag: env.LEVEL10_TAG,
      textStates: env.TEXT_STATES,
      campaignBatch: env.CAMPAIGN_BATCH,
      maxSends: env.MAX_SENDS_PER_RUN,
      requireOptIn: env.REQUIRE_OPTIN,
      requireProfitDial: env.REQUIRE_PROFITDIAL,
      requireLevel10Tag: env.REQUIRE_LEVEL10_TAG,
    };
  }

  // ---------------------------------------------------------------------------
  // Load a job: contacts to process + ProfitDial source-of-truth rows.
  // ---------------------------------------------------------------------------
  loadJob({ contacts, profitDialRows, profitDialCols, source, tab, seedLedgerContacts = [] }) {
    assertRunnable(); // refuses live mode (no live adapter)
    assertMessageIntegrity();

    this.contacts = contacts;
    this.pdIndex = buildProfitDialIndex(profitDialRows, profitDialCols);

    // Pre-seed the campaign ledger for any "already processed" scenario contacts.
    for (const c of seedLedgerContacts) {
      this.ledger.record({
        campaignBatch: this.config.campaignBatch,
        reiContactId: c.contactId,
        phone: (c.phones && c.phones[0]) || '',
        templateId: 'PRE-SEED',
        disposition: DISPOSITION.TEXT_SENT,
        sendVerified: true,
      });
    }

    this.store.init({
      jobId: `job-${this.config.campaignBatch}`,
      campaignBatch: this.config.campaignBatch,
      count: contacts.length,
      tab,
      source,
    });
    this.store.setStatus('idle');
    logger.info('job_loaded', { count: contacts.length, source, tab, mode: this.adapterModeLabel() });
    this.emitState();
    return this.store.get();
  }

  adapterModeLabel() {
    return env.SANDBOX ? 'sandbox' : 'live';
  }

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------
  async start() {
    if (this.store.get().status === 'running') return;
    assertRunnable();
    this.adapter = createAdapter({ contacts: this.contacts });
    await this.adapter.init?.();
    this._pauseRequested = false;
    this._stopRequested = false;
    this._sendsThisRun = 0;
    this.store.setStatus('running');
    this.emitState();
    this._loop = this._run().catch((e) => {
      logger.error('engine_crash', { message: e.message });
      this.store.setStatus('stopped');
      this.emit('error', e);
      this.emitState();
    });
  }

  pause() {
    if (this.store.get().status === 'running') {
      this._pauseRequested = true;
      logger.info('pause_requested');
    }
  }

  async resume() {
    if (this.store.get().status !== 'paused') return;
    await this.start();
  }

  stop() {
    this._stopRequested = true;
    logger.info('stop_requested');
  }

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------
  async _run() {
    const st = this.store.get();
    for (let i = st.cursor; i < this.contacts.length; i++) {
      if (this._stopRequested) {
        this.store.setStatus('stopped');
        this.emitState();
        return;
      }
      if (this._pauseRequested) {
        this.store.setStatus('paused');
        this.emitState();
        return;
      }
      if (this.config.maxSends > 0 && this._sendsThisRun >= this.config.maxSends) {
        logger.warn('batch_cap_reached', { cap: this.config.maxSends });
        // Mark remaining unprocessed contact at cursor with a note but pause.
        this.store.setStatus('paused');
        this.emit('batch-cap', { cap: this.config.maxSends });
        this.emitState();
        return;
      }

      const contact = this.contacts[i];
      const result = await this._processContact(contact);
      this.store.recordResult(i, result);
      if (SENT_DISPOSITIONS.includes(result.L10_Disposition)) this._sendsThisRun += 1;
      logger.row(contact.contactId, result.L10_Disposition, { reason: result.L10_Reason });
      this.emit('row', { index: i, result });
      this.emitState();
    }

    this.store.setStatus('done');
    await this.adapter.close?.();
    this.emit('done');
    this.emitState();
  }

  // ---------------------------------------------------------------------------
  // Per-contact SOP pipeline (mirrors the SOP steps, fail-closed throughout).
  // ---------------------------------------------------------------------------
  async _processContact(contact) {
    const base = {
      contactId: contact.contactId,
      scenario: contact.scenario || '',
      name: contact.name || '',
      reiUrl: contact.reiUrl || '',
      phone: (contact.phones || [])[0] || '',
      message: '',
      L10_Disposition: DISPOSITION.ERROR,
      L10_Reason: '',
      L10_TemplateId: '',
      L10_ProfitDial: '',
      L10_OptInStatus: '',
      L10_SendVerified: false,
      L10_ReplyClass: 'none',
      L10_Status: L10_STATUS.PENDING,
      L10_ProcessedAt: new Date().toISOString(),
      delivery: '',
    };

    try {
      // Integrity re-check before doing anything irreversible.
      assertMessageIntegrity();

      // STEP 3 — Search Smart Contacts BY PHONE. The phone is the primary and only
      // search key; name is never searched (it can surface a different homeowner).
      // The adapter gathers every candidate row and decides nothing.
      const sheetRow = {
        phone: (contact.phones || [])[0] || '',
        name: contact.name || '',
        address: contact.address || '',
      };
      base.L10_Status = L10_STATUS.SEARCHING_BY_PHONE;
      logger.info('searching_by_phone', {
        row: contact.contactId,
        phone: sop.normalizePhone(sheetRow.phone),
        name: sheetRow.name,
      });

      const search = await this.adapter.findContact({ ...sheetRow, contactId: contact.contactId });
      const searchStatus = search.status || L10_STATUS.NO_CONTACT_FOUND_BY_PHONE;
      const candidates = search.candidates || [];
      const trail = (search.searched || []).join(' → ');
      logger.info('phone_search_result', { row: contact.contactId, status: searchStatus, count: candidates.length });

      // STEP 4/5 — Decide WHICH contact (if any) is this homeowner. Pure rule:
      // phone must match, name must match, no conflicting address. Anything
      // uncertain becomes a manual-review status and is never texted.
      const decision = chooseContact({ sheet: sheetRow, candidates });
      base.L10_Status = decision.status;
      logger.info('contact_decision', {
        row: contact.contactId,
        searchStatus,
        status: decision.status,
        reason: decision.reason,
        chosen: decision.chosen ? { name: decision.chosen.name, phone: decision.chosen.phone } : null,
      });

      if (decision.status !== L10_STATUS.CONTACT_VERIFIED) {
        const parts = [decision.reason];
        if (search.stage) parts.push(`Stage: ${search.stage}`);
        if (trail) parts.push(`Searched: ${trail}`);
        if (search.screenshot) parts.push(`Screenshot: ${search.screenshot}`);
        if (env.SANDBOX && contact.syntheticId && searchStatus === L10_STATUS.NO_CONTACT_FOUND_BY_PHONE) {
          parts.push('(Test mode: this lead is from your real sheet, so it is not in the sandbox data — run npm run watch:20 to search REI)');
        }
        return this._finish(
          base,
          STATUS_TO_DISPOSITION[decision.status] || DISPOSITION.NEEDS_REVIEW,
          `${decision.status} — ${parts.join(' · ')}`,
          contact
        );
      }

      // Verified: open that specific contact (never "the first result").
      const opened = await this.adapter.openContact(decision.chosen);
      if (!opened.opened) {
        return this._finish(
          base,
          DISPOSITION.NEEDS_REVIEW,
          `${L10_STATUS.MANUAL_REVIEW_REQUIRED} — verified the contact but could not open it: ${opened.reason || 'unknown'}`,
          contact
        );
      }

      // Gather facts from the opened contact (tags, phones, notes, chat history).
      const facts = await this.adapter.readContactFacts(opened.contactId);
      base.L10_Reason = decision.reason;
      if (facts.name) base.name = facts.name;
      if (facts.reiUrl) base.reiUrl = facts.reiUrl; // clickable link to the REI contact

      // GATE 1 — Eligibility (tag, state, suppression, phone). The tag failure and
      // the safety/history failures are distinct tracking statuses.
      const elig = sop.checkEligibility(facts, this.config);
      if (!elig.ok) {
        base.L10_Status =
          elig.disposition === DISPOSITION.MISSING_TAG
            ? L10_STATUS.LEVEL_10_TAG_MISSING
            : L10_STATUS.SAFETY_REVIEW_FAILED;
        logger.info('eligibility_blocked', { row: contact.contactId, status: base.L10_Status, reason: elig.reason });
        return this._finish(base, elig.disposition, elig.reason, contact);
      }

      // GATE 2 — Campaign duplicate ledger. Keyed on the SHEET's contact id, which
      // is what _finish() records — the id scraped off the screen can differ run
      // to run, which would let the same lead through twice.
      const phone = (facts.phones || [])[0] || '';
      const ledgerHit = this.ledger.has(this.config.campaignBatch, contact.contactId, phone);
      const dup = sop.checkAlreadyProcessed(ledgerHit);
      if (!dup.ok) return this._finish(base, dup.disposition, dup.reason, contact);

      // WATCH-ONLY: verify the bot navigates + reads + matches correctly WITHOUT
      // changing anything (no opt-in, no ProfitDial selection, no send). Safe
      // first live check. Reads the assigned number from the sheet and whether
      // it is available in REI, then reports and stops.
      if (env.WATCH_ONLY) {
        const wMatch = matchProfitDial({ contactId: facts.contactId, address: facts.address, phone }, this.pdIndex);
        const wAvail = await this.adapter.getProfitDialNumbers(facts.contactId);
        base.L10_ProfitDial = wMatch.profitDial || '';
        const availTxt = wMatch.profitDial
          ? (wAvail.map((n) => n.replace(/\D/g, '')).includes(String(wMatch.profitDial).replace(/\D/g, '')) ? 'available in REI' : 'NOT in REI')
          : `no single match (${wMatch.status})`;
        base.L10_Status = L10_STATUS.CONTACT_VERIFIED;
        return this._finish(base, DISPOSITION.NEEDS_REVIEW,
          `CONTACT_VERIFIED (${base.L10_Reason}). Watch-only: assigned ProfitDial ${wMatch.profitDial || '—'} (${availTxt}). No changes made, nothing sent.`, contact);
      }

      // STEP 4 — Opt in the phone (SOP). Can be turned off (REQUIRE_OPTIN=false)
      // to match apps/accounts where numbers are already opt-in / auto-handled.
      if (this.config.requireOptIn) {
        const optIn = await this.adapter.optInPhone(facts.contactId);
        base.L10_OptInStatus = optIn.status;
        const optCheck = sop.checkOptIn(optIn);
        if (!optCheck.ok) {
          base.L10_Status = L10_STATUS.OPT_IN_FAILED;
          logger.info('opt_in_failed', { row: contact.contactId, reason: optCheck.reason });
          return this._finish(base, optCheck.disposition, optCheck.reason, contact);
        }
      } else {
        base.L10_OptInStatus = 'skipped';
      }

      // STEP 5/6 — ProfitDial: match source-of-truth, verify availability + readback.
      // Can be turned off (REQUIRE_PROFITDIAL=false) when REI sends from a fixed
      // number and no from-number pick exists. Default ON per SOP requirement #5.
      if (this.config.requireProfitDial) {
        const match = matchProfitDial({ contactId: facts.contactId, address: facts.address, phone }, this.pdIndex);
        const availableNumbers = await this.adapter.getProfitDialNumbers(facts.contactId);
        let selectedReadback = '';
        if (match.status === 'ok') {
          const sel = await this.adapter.selectProfitDial(facts.contactId, match.profitDial);
          selectedReadback = sel.readback || '';
          base.L10_ProfitDial = match.profitDial;
        }
        const pdCheck = sop.checkProfitDial({ match, availableNumbers, selectedReadback });
        if (!pdCheck.ok) {
          base.L10_Status = L10_STATUS.PROFITDIAL_NOT_VERIFIED;
          logger.info('profitdial_not_verified', { row: contact.contactId, reason: pdCheck.reason });
          return this._finish(base, pdCheck.disposition, pdCheck.reason, contact);
        }
      } else {
        base.L10_ProfitDial = '(REI default number)';
      }

      // STEP 7 — Select the approved template (controlled balanced allocation).
      const usage = this.ledger.templateUsage(this.config.campaignBatch);
      const lastId = this.ledger.lastTemplateId(this.config.campaignBatch);
      const { template } = allocateTemplate({
        sandbox: env.SANDBOX,
        usageCounts: usage,
        lastTemplateId: lastId,
        seed: facts.contactId + phone,
      });
      base.L10_TemplateId = template.id;

      // Requirement #3 — placeholder can never be used in live mode. In sandbox
      // it is allowed but flagged. The final send gate enforces the live block.
      // Merge values: the SHEET is the source of truth for the property address
      // ("Full Address"), because this account's REI contact screen has no
      // mapped address field. The scraped value is only a fallback. Same for the
      // first name. A blank on either side fails closed below — we never send a
      // text with an empty merge field.
      const mergeFacts = {
        ...facts,
        firstName: facts.firstName || contact.firstName || '',
        propertyAddress: contact.address || facts.address || '',
      };

      let rendered;
      try {
        rendered = renderTemplate(template, mergeFacts);
      } catch (e) {
        if (e.code === 'INVALID_MERGE_FIELD') return this._finish(base, DISPOSITION.INVALID_MERGE_FIELD, e.message, contact);
        throw e;
      }
      const msgCheck = sop.checkRenderedMessage(rendered, template);
      if (!msgCheck.ok) return this._finish(base, msgCheck.disposition, msgCheck.reason, contact);
      base.message = rendered; // the exact text that was sent / prepared
      base.L10_Status = L10_STATUS.READY_TO_SEND;
      logger.info('ready_to_send', { row: contact.contactId, template: template.id, profitDial: base.L10_ProfitDial });

      // GATE — irreversible-send gate (env). Sandbox = simulated; live blocked.
      const gate = liveSendGate({ placeholderEnabled: anyPlaceholderEnabled() });
      if (!gate.allowed) {
        // In live mode a placeholder still enabled -> TEMPLATE_BLOCKED.
        const disp = anyPlaceholderEnabled() && !env.SANDBOX ? DISPOSITION.TEMPLATE_BLOCKED : DISPOSITION.NEEDS_REVIEW;
        return this._finish(base, disp, gate.reason, contact);
      }

      // STEP 8 — Enter + send + verify.
      await this.adapter.enterMessage(facts.contactId, rendered);
      const sent = await this.adapter.sendMessage(facts.contactId);
      if (!sent.sent) {
        base.L10_Status = L10_STATUS.SMS_SEND_FAILED;
        return this._finish(base, DISPOSITION.SEND_VERIFY_FAILED, sent.reason || 'Send action failed', contact);
      }

      const verify = await this.adapter.verifyMessageSent(facts.contactId, rendered);
      const vCheck = sop.checkSendVerification(verify);
      base.L10_SendVerified = Boolean(verify.verified);
      if (!vCheck.ok) {
        base.L10_Status = L10_STATUS.SMS_SEND_FAILED;
        return this._finish(base, vCheck.disposition, vCheck.reason, contact);
      }
      base.L10_Status = L10_STATUS.SMS_SENT;

      // STEP 9 — Monitor: delivery + replies.
      const delivery = await this.adapter.readDeliveryStatus(facts.contactId);
      base.delivery = delivery.delivery;
      const reply = await this.adapter.readReplies(facts.contactId);
      base.L10_ReplyClass = sop.classifyReply(reply.text);

      const disposition = gate.simulated ? DISPOSITION.SIMULATED_SENT : DISPOSITION.TEXT_SENT;
      return this._finish(base, disposition, gate.reason, contact, { template });
    } catch (e) {
      logger.error('contact_error', { contactId: contact.contactId, message: e.message, code: e.code });
      return this._finish(base, DISPOSITION.ERROR, `${e.code || 'ERROR'}: ${e.message}`, contact);
    }
  }

  _finish(base, disposition, reason, contact, extra = {}) {
    const result = {
      ...base,
      L10_Disposition: disposition,
      L10_Reason: reason,
      // Exported columns mirror the fields the dashboard uses, set in one place
      // so the export can never drift from what was shown on screen.
      L10_ReiUrl: base.reiUrl || '',
      L10_Message: base.message || '',
      L10_Status: base.L10_Status || L10_STATUS.PENDING,
    };

    // Record to the campaign ledger for any contact that reached a send attempt
    // OR was blocked after opt-in, so re-runs never re-text. We ALWAYS record
    // sends; for non-sends we record so the same contact isn't reworked blindly.
    const isSend = SENT_DISPOSITIONS.includes(disposition);
    if (isSend || disposition === DISPOSITION.SEND_VERIFY_FAILED) {
      const phone = (contact.phones || [])[0] || '';
      this.ledger.record({
        campaignBatch: this.config.campaignBatch,
        reiContactId: contact.contactId,
        phone,
        profitDial: result.L10_ProfitDial,
        templateId: result.L10_TemplateId,
        sendVerified: result.L10_SendVerified,
        disposition,
      });
    }
    return result;
  }

  emitState() {
    this.emit('state', this.snapshot());
  }

  snapshot() {
    const st = this.store.get();
    return {
      mode: this.adapterModeLabel(),
      allowLiveSend: env.ALLOW_LIVE_SEND,
      campaignBatch: this.config.campaignBatch,
      status: st.status,
      cursor: st.cursor,
      total: st.contactsMeta.count,
      sendsThisRun: this._sendsThisRun,
      maxSends: this.config.maxSends,
      results: st.results.filter(Boolean),
    };
  }
}
