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
  validateRenderedMessage,
  isUsableFirstName,
} from './message.js';
import { buildProfitDialIndex, matchProfitDial } from './profitdial.js';
import { DISPOSITION, SENT_DISPOSITIONS, L10_STATUS, STATUS_TO_DISPOSITION } from './constants.js';
import { chooseContact, verifyOpenedContact, checkSendGates } from './contactMatch.js';
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
      readOnly: env.WATCH_ONLY,
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
        // Every name the sheet offers for this row (Primary Name, Owner,
        // First+Last) — Primary Name alone can disagree with the county record.
        nameCandidates: contact.nameCandidates && contact.nameCandidates.length ? contact.nameCandidates : [contact.name || ''],
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
      if (facts.name) base.name = facts.name;
      if (facts.reiUrl) base.reiUrl = facts.reiUrl; // clickable link to the REI contact

      // RE-VERIFY on the full record. The search row was only a candidate: its
      // columns can be truncated or stale. CONTACT_VERIFIED is set here, from the
      // contact's own detail page, or not at all.
      const recheck = verifyOpenedContact({ sheet: sheetRow, detail: facts, level10Tag: this.config.level10Tag });
      base.L10_Status = recheck.status;
      base.L10_Reason = recheck.reason;
      logger.info('contact_reverified', {
        row: contact.contactId,
        status: recheck.status,
        flags: recheck.flags,
        reason: recheck.reason,
      });
      if (recheck.status !== L10_STATUS.CONTACT_VERIFIED) {
        return this._finish(
          base,
          STATUS_TO_DISPOSITION[recheck.status] || DISPOSITION.NEEDS_REVIEW,
          `${recheck.status} — ${recheck.reason} (search row said: ${decision.reason})`,
          contact
        );
      }
      // Gates start closed and are only set by the checks that prove them.
      const gates = {
        contactVerified: true,
        // Set by the SAME re-verification of the opened record, so the gate cannot
        // be true on the strength of the search row alone.
        fullContactVerified: recheck.flags.phoneVerified === true && recheck.flags.nameVerified === true && recheck.flags.addressOk === true,
        level10TagVerified: recheck.flags.level10TagVerified === true,
        safetyReviewPassed: false,
        smsOptInVerified: false,
        profitDialVerified: false,
        approvedTemplateVerified: false,
        duplicateCheckPassed: false,
        // Production switch. Sandbox simulates a send, so it satisfies this gate
        // for the pipeline test; a LIVE send additionally needs liveSendGate().
        liveSendingEnabled: env.SANDBOX === true || env.ALLOW_LIVE_SEND === true,
      };

      // GATE 1 — Safety review: state, suppression scan, phone validity (and the
      // tag, which verifyOpenedContact has already confirmed).
      const elig = sop.checkEligibility(facts, this.config);
      if (!elig.ok) {
        base.L10_Status =
          elig.disposition === DISPOSITION.MISSING_TAG
            ? L10_STATUS.LEVEL_10_TAG_MISSING
            : L10_STATUS.SAFETY_REVIEW_FAILED;
        logger.info('eligibility_blocked', { row: contact.contactId, status: base.L10_Status, reason: elig.reason });
        // In Test Mode a lead from a real sheet has no tags, notes or history —
        // there is nothing to read, because REI was never contacted. Saying
        // "Not Level 10" without that context reads as a finding about the
        // homeowner, which it is not.
        const reason =
          env.SANDBOX && contact.syntheticId
            ? `${elig.reason} — but this is TEST MODE: REI was never opened, so there are no tags to read. ` +
              'Use "Check against REI" to test the real account.'
            : elig.reason;
        return this._finish(base, elig.disposition, reason, contact);
      }
      gates.safetyReviewPassed = true;

      // GATE 2 — Duplicate prevention. Checked on BOTH keys: the spreadsheet row
      // (stable across re-uploads) and the REI contact id (catches two rows that
      // resolve to the same contact). A confirmed, pending or uncertain send all
      // block; only a clean pre-send 'blocked' record may be retried.
      const phone = (facts.phones || [])[0] || '';
      const dupHit =
        this.ledger.isSendBlocked(this.config.campaignBatch, contact.contactId, phone) ||
        this.ledger.isSendBlocked(this.config.campaignBatch, facts.contactId, phone) ||
        // The homeowner IS the phone: a different spreadsheet row that resolves to
        // the same number must not produce a second text.
        this.ledger.isSendBlockedByPhone(this.config.campaignBatch, phone);
      if (dupHit) {
        base.L10_Status = L10_STATUS.ALREADY_PROCESSED;
        logger.info('duplicate_blocked', { row: contact.contactId, reason: dupHit.reason });
        return this._finish(
          base,
          DISPOSITION.ALREADY_PROCESSED,
          `${L10_STATUS.ALREADY_PROCESSED} — ${dupHit.reason} (template ${dupHit.entry.templateId || 'n/a'} on ${dupHit.entry.dateTime}). Not sending again.`,
          contact
        );
      }
      // A Level 10 initial SMS already in the conversation is the same thing seen
      // from REI's side rather than from our ledger.
      const priorInitial = (facts.chatHistory || []).some((m) =>
        /it's Juan with Twin Home Buyer/i.test(String(m))
      );
      if (priorInitial) {
        base.L10_Status = L10_STATUS.ALREADY_PROCESSED;
        logger.info('duplicate_blocked', { row: contact.contactId, reason: 'prior Level 10 message found in the REI thread' });
        return this._finish(
          base,
          DISPOSITION.ALREADY_PROCESSED,
          `${L10_STATUS.ALREADY_PROCESSED} — a Level 10 message from Juan is already in this conversation. Not sending another.`,
          contact
        );
      }
      gates.duplicateCheckPassed = true;

      // WATCH-ONLY: verify the bot navigates + reads + matches correctly WITHOUT
      // changing anything (no opt-in, no ProfitDial selection, no send). Safe
      // first live check. Reads the assigned number from the sheet and whether
      // it is available in REI, then reports and stops.
      if (this.config.readOnly) {
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

      // STEP 4 — SMS opt-in. MANDATORY, no bypass. Clicking the button is not
      // proof: the status is re-read from the screen afterwards and must visibly
      // show SMS-enabled. An unavailable or uncertain control is OPT_IN_REQUIRED.
      const optStatus = await this.adapter.getSmsStatus(facts.contactId);
      if (optStatus?.smsEnabled === true) {
        base.L10_OptInStatus = 'already opted in';
        gates.smsOptInVerified = true;
      } else {
        const available = (await this.adapter.optInAvailable?.(facts.contactId)) ?? true;
        if (!available) {
          base.L10_Status = L10_STATUS.OPT_IN_REQUIRED;
          base.L10_OptInStatus = 'control unavailable';
          logger.info('opt_in_required', { row: contact.contactId, reason: 'no Opt In control could be located' });
          return this._finish(
            base,
            DISPOSITION.OPT_IN_FAILED,
            `${L10_STATUS.OPT_IN_REQUIRED} — the phone is not SMS opted in and no Opt In control could be located. Not sending.`,
            contact
          );
        }

        const optIn = await this.adapter.optInPhone(facts.contactId);
        // Re-READ the status rather than trusting the click's own return value.
        const after = await this.adapter.getSmsStatus(facts.contactId);
        base.L10_OptInStatus = after?.smsEnabled === true ? 'opted in (verified)' : optIn?.status || 'unknown';
        logger.info('opt_in_attempt', {
          row: contact.contactId,
          clickResult: optIn?.status,
          reReadSmsEnabled: after?.smsEnabled,
        });
        if (after?.smsEnabled !== true) {
          base.L10_Status = L10_STATUS.OPT_IN_FAILED;
          return this._finish(
            base,
            DISPOSITION.OPT_IN_FAILED,
            `${L10_STATUS.OPT_IN_FAILED} — opt-in did not verify on re-read (${optIn?.reason || 'status still not SMS-enabled'}). Not sending.`,
            contact
          );
        }
        gates.smsOptInVerified = true;
      }

      // STEP 5/6 — ProfitDial sender. MANDATORY, no bypass: the bot must never send
      // from REI's default sender. Every one of these is PROFITDIAL_NOT_VERIFIED
      // and stops the row: no assigned number, no sender selector, cannot select
      // it, or cannot read the selection back digit-for-digit.
      const pdFail = (why) => {
        base.L10_Status = L10_STATUS.PROFITDIAL_NOT_VERIFIED;
        logger.info('profitdial_not_verified', { row: contact.contactId, reason: why });
        return this._finish(
          base,
          DISPOSITION.MISSING_PROFITDIAL,
          `${L10_STATUS.PROFITDIAL_NOT_VERIFIED} — ${why}. Not sending.`,
          contact
        );
      };

      const match = matchProfitDial({ contactId: facts.contactId, address: facts.address, phone }, this.pdIndex);
      if (match.status !== 'ok' || !match.profitDial) {
        return pdFail(`no single assigned ProfitDial in the sheet for this homeowner (${match.status})`);
      }
      base.L10_ProfitDial = match.profitDial;

      const senderAvailable = (await this.adapter.profitDialSelectorAvailable?.(facts.contactId)) ?? true;
      if (!senderAvailable) {
        return pdFail('the ProfitDial sender selector could not be located in REI');
      }

      const availableNumbers = await this.adapter.getProfitDialNumbers(facts.contactId);
      const sel = await this.adapter.selectProfitDial(facts.contactId, match.profitDial);
      if (!sel?.selected) {
        return pdFail(`the assigned number ${match.profitDial} could not be selected (${sel?.reason || 'no reason given'})`);
      }
      const selectedReadback = sel.readback || '';
      if (!selectedReadback) {
        return pdFail(`the selected sender number could not be read back for confirmation`);
      }
      const pdCheck = sop.checkProfitDial({ match, availableNumbers, selectedReadback });
      if (!pdCheck.ok) return pdFail(pdCheck.reason);
      gates.profitDialVerified = true;
      logger.info('profitdial_verified', { row: contact.contactId, number: match.profitDial, readback: selectedReadback });

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
      // Merge values. The SHEET is the source of truth for the property address
      // ("Full Address"); the REI screen value is only a fallback. The first name
      // must be a real personal name — a record called "TRUST" or "UNKNOWN"
      // produces no first name and is held for review rather than texted.
      const candidateFirst = [facts.firstName, contact.firstName, String(facts.name ?? '').split(/\s+/)[0]]
        .map((v) => String(v ?? '').trim())
        .find((v) => isUsableFirstName(v)) || '';
      const mergeFacts = {
        ...facts,
        firstName: candidateFirst,
        propertyAddress: contact.address || facts.address || '',
      };
      if (!candidateFirst) {
        base.L10_Status = L10_STATUS.MANUAL_REVIEW_REQUIRED;
        logger.info('first_name_unsafe', { row: contact.contactId, reiName: facts.name, sheetName: contact.name });
        return this._finish(
          base,
          DISPOSITION.INVALID_MERGE_FIELD,
          `${L10_STATUS.MANUAL_REVIEW_REQUIRED} — no safe personal first name could be determined (REI "${facts.name || ''}" / sheet "${contact.name || ''}"). Not sending.`,
          contact
        );
      }

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

      // The template is verified when it is an APPROVED (non-placeholder) template
      // whose wording passed the integrity checksum and rendered with no holes.
      // Exact-template proof: an approved id, ending in the STOP sentence, with no
      // forbidden tokens, and byte-identical to the approved body with only the two
      // merge values substituted.
      const exact = validateRenderedMessage({
        templateId: template.id,
        rendered,
        firstName: mergeFacts.firstName,
        propertyAddress: mergeFacts.propertyAddress,
      });
      gates.approvedTemplateVerified = exact.ok && template.placeholder !== true;
      if (!gates.approvedTemplateVerified) {
        base.L10_Status = L10_STATUS.MANUAL_REVIEW_REQUIRED;
        logger.info('template_not_exact', { row: contact.contactId, template: template.id, reason: exact.reason });
        return this._finish(
          base,
          DISPOSITION.INVALID_MERGE_FIELD,
          `${L10_STATUS.MANUAL_REVIEW_REQUIRED} — ${exact.reason}. Not sending.`,
          contact
        );
      }
      base.L10_Status = L10_STATUS.READY_TO_SEND;
      logger.info('ready_to_send', { row: contact.contactId, template: template.id, profitDial: base.L10_ProfitDial });

      // GATE — irreversible-send gate (env). Sandbox = simulated; live blocked.
      const gate = liveSendGate({ placeholderEnabled: anyPlaceholderEnabled() });
      if (!gate.allowed) {
        // In live mode a placeholder still enabled -> TEMPLATE_BLOCKED.
        const disp = anyPlaceholderEnabled() && !env.SANDBOX ? DISPOSITION.TEMPLATE_BLOCKED : DISPOSITION.NEEDS_REVIEW;
        return this._finish(base, disp, gate.reason, contact);
      }

      // ---------------------------------------------------------------------
      // PRODUCTION SAFETY GATE — the last thing before an irreversible send.
      // All six must be exactly `true`. Anything false/unknown blocks the send,
      // and the adapter's enterMessage/sendMessage are never reached.
      // ---------------------------------------------------------------------
      const sendGate = checkSendGates(gates);
      logger.info('send_gates', { row: contact.contactId, gates, allowed: sendGate.allowed, failed: sendGate.failed });
      if (!sendGate.allowed) {
        base.L10_Status = L10_STATUS.MANUAL_REVIEW_REQUIRED;
        return this._finish(base, DISPOSITION.NEEDS_REVIEW, `${L10_STATUS.MANUAL_REVIEW_REQUIRED} — ${sendGate.reason}`, contact);
      }

      // STEP 8 — Enter + send + confirm.
      await this.adapter.enterMessage(facts.contactId, rendered);

      // Write a PENDING ledger entry BEFORE the irreversible action. If the
      // process dies between send and confirmation, the restart sees 'pending'
      // and refuses to send again instead of double-texting the homeowner.
      this.ledger.record({
        campaignBatch: this.config.campaignBatch,
        reiContactId: contact.contactId,
        phone,
        profitDial: base.L10_ProfitDial,
        templateId: template.id,
        sendVerified: false,
        state: 'pending',
        disposition: 'send in progress',
      });

      const sent = await this.adapter.sendMessage(facts.contactId);
      if (!sent.sent) {
        // The click itself failed, so nothing left our side: a clean retry is safe.
        this.ledger.record({
          campaignBatch: this.config.campaignBatch,
          reiContactId: contact.contactId,
          phone,
          templateId: '',
          sendVerified: false,
          state: 'blocked',
          disposition: 'send action failed before delivery',
        });
        base.L10_Status = L10_STATUS.SMS_SEND_FAILED;
        return this._finish(base, DISPOSITION.SEND_VERIFY_FAILED, sent.reason || 'Send action failed', contact);
      }

      const verify = await this.adapter.verifyMessageSent(facts.contactId, rendered);
      const vCheck = sop.checkSendVerification(verify);
      base.L10_SendVerified = Boolean(verify.verified);
      if (!vCheck.ok) {
        // Clicked but unconfirmed: it may or may not have gone out. Mark it
        // UNCERTAIN so no automatic retry can ever double-send; a human decides.
        this.ledger.record({
          campaignBatch: this.config.campaignBatch,
          reiContactId: contact.contactId,
          phone,
          profitDial: base.L10_ProfitDial,
          templateId: template.id,
          sendVerified: false,
          state: 'uncertain',
          disposition: 'sent but not confirmed',
        });
        base.L10_Status = L10_STATUS.SMS_SEND_FAILED;
        return this._finish(
          base,
          vCheck.disposition,
          `${vCheck.reason} — recorded as UNCERTAIN; this lead will not be retried automatically.`,
          contact
        );
      }
      base.L10_Status = L10_STATUS.SMS_SENT;

      // STEP 9 — Monitor: delivery + replies. REI resolves delivery ASYNCHRONOUSLY
      // and marks failures "Undelivered" — the pilot saw that on 2 of 3 real sends.
      // An undelivered message still blocks a resend (it left our side) but must
      // not count as a successful use of that template.
      // REI resolves delivery ASYNCHRONOUSLY — the pilot noted "Undelivered" was
      // not visible at the moment of sending, only after the thread reloaded a few
      // seconds later. Reading once here would report 'pending' and miss it, which
      // would let a failed send be recorded as a success. So: re-check with a
      // short backoff until it resolves, then give up and leave it 'pending'.
      const delivery = await this._readDeliveryWithRecheck(facts.contactId);
      base.delivery = delivery.delivery;
      this.ledger.record({
        campaignBatch: this.config.campaignBatch,
        reiContactId: contact.contactId,
        phone,
        profitDial: base.L10_ProfitDial,
        templateId: template.id,
        sendVerified: true,
        state: 'sent',
        delivery: delivery.delivery,
        disposition: delivery.delivery === 'undelivered' ? DISPOSITION.UNDELIVERED : DISPOSITION.TEXT_SENT,
      });
      if (delivery.delivery === 'undelivered') {
        const reply0 = await this.adapter.readReplies(facts.contactId);
        base.L10_ReplyClass = sop.classifyReply(reply0.text);
        logger.warn('undelivered', { row: contact.contactId, profitDial: base.L10_ProfitDial, template: template.id });
        return this._finish(
          base,
          DISPOSITION.UNDELIVERED,
          `${L10_STATUS.SMS_SENT} but REI reports UNDELIVERED from ${base.L10_ProfitDial}. ` +
            'The message left our side, so it will not be resent, and it does not count as a template use. ' +
            'Investigate the sender number with the carrier before sending more.',
          contact
        );
      }
      const reply = await this.adapter.readReplies(facts.contactId);
      base.L10_ReplyClass = sop.classifyReply(reply.text);

      const disposition = gate.simulated ? DISPOSITION.SIMULATED_SENT : DISPOSITION.TEXT_SENT;
      return this._finish(base, disposition, gate.reason, contact, { template });
    } catch (e) {
      logger.error('contact_error', { contactId: contact.contactId, message: e.message, code: e.code });
      return this._finish(base, DISPOSITION.ERROR, `${e.code || 'ERROR'}: ${e.message}`, contact);
    }
  }

  /**
   * Delivery status, re-checked until REI resolves it.
   *
   * Sandbox answers immediately, so no waiting happens in tests. Live runs wait
   * up to ~16s in total; a still-unresolved status stays 'pending' rather than
   * being guessed either way.
   */
  async _readDeliveryWithRecheck(contactId) {
    let d = await this.adapter.readDeliveryStatus(contactId);
    if (env.SANDBOX) return d;
    for (const waitMs of [3000, 5000, 8000]) {
      if (d?.delivery && d.delivery !== 'pending') break;
      await sleep(waitMs);
      d = await this.adapter.readDeliveryStatus(contactId);
      logger.info('delivery_recheck', { row: contactId, delivery: d?.delivery });
    }
    return d;
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
    // Only a CONFIRMED send is recorded here. The send path itself already wrote
    // the precise 'pending' / 'uncertain' / 'blocked' state, and re-recording from
    // this generic place would overwrite it — which previously downgraded an
    // unconfirmed send to 'blocked' and made it look safe to retry.
    const isSend = SENT_DISPOSITIONS.includes(disposition);
    if (isSend) {
      const phone = (contact.phones || [])[0] || '';
      this.ledger.record({
        campaignBatch: this.config.campaignBatch,
        reiContactId: contact.contactId,
        phone,
        profitDial: result.L10_ProfitDial,
        templateId: result.L10_TemplateId,
        sendVerified: true,
        state: 'sent',
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
