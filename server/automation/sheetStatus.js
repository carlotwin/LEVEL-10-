// =============================================================================
// PRE-EXISTING SEND HISTORY, READ FROM THE SPREADSHEET ITSELF.
//
// Why this module exists: the Level 10 sheet's own "Send Status" / "Notes"
// columns are the ONLY record of work already done by hand (Jonathan, Thea) or
// by earlier runs. The duplicate ledger cannot cover them — it only knows about
// sends this app performed, in this campaign batch, on this machine. Processing
// the whole file without reading this column would re-text homeowners who were
// already texted, and would text at least one who replied STOP.
//
// Pure and deterministic: a string in, a decision out. No browser, no env.
//
// FAIL CLOSED: a status that is non-empty but not recognised is NOT treated as
// "fine to send". It goes to manual review. Only a genuinely EMPTY status means
// "not yet worked".
// =============================================================================
import { DISPOSITION, L10_STATUS } from './constants.js';

/** This row has never been worked — the pipeline may proceed. */
const PROCEED = Object.freeze({ process: true, disposition: '', status: '', reason: '' });

const skip = (disposition, status, reason) => Object.freeze({ process: false, disposition, status, reason });

// Recognised wordings, in priority order. The sheet is hand-typed, so these are
// matched loosely (case-insensitive substrings / patterns) and typos seen in the
// real file are included verbatim: "sentby", "semt", "Templat".
//
// ORDER MATTERS. An opt-out beats a send; a send beats a landline note.
const RULES = [
  // ---- Hard stops: this person must never be texted again -------------------
  {
    test: /\bstop\b|opt(?:ed)?\s*-?\s*out|unsubscribe/i,
    ...skip(
      DISPOSITION.OPTED_OUT,
      L10_STATUS.MANUAL_REVIEW_REQUIRED,
      'Sheet records an opt-out / STOP reply — never text again'
    ),
  },
  {
    test: /do\s*not\s*send|do\s*not\s*contact|not\s*interested|\bdnc\b/i,
    ...skip(
      DISPOSITION.DO_NOT_CONTACT,
      L10_STATUS.MANUAL_REVIEW_REQUIRED,
      'Sheet marks this row do-not-send / not interested'
    ),
  },

  // ---- Already sent. Includes UNDELIVERED: the message left our side, and a
  //      carrier failure is not a reason to fire another one at the same number.
  {
    test: /undelivered|not\s*delivered|delivery\s*failed/i,
    ...skip(
      DISPOSITION.UNDELIVERED,
      L10_STATUS.ALREADY_PROCESSED,
      'Already attempted — sheet records the carrier reported it undelivered'
    ),
  },
  {
    test: /sms\s*sent|text\s*(?:was\s*)?sent|\bsent\s*by\b|\bsentby\b|\bsemt\b|was\s*sent|already\s*sent|\bdelivered\b|\breplied\b|\bresponded\b/i,
    ...skip(
      DISPOSITION.ALREADY_PROCESSED,
      L10_STATUS.ALREADY_PROCESSED,
      'Sheet already records a sent text for this row'
    ),
  },

  // ---- Unusable number -----------------------------------------------------
  {
    test: /landline|no\s*longer\s*in\s*service|disconnected|invalid\s*number|wrong\s*number/i,
    ...skip(
      DISPOSITION.INVALID_PHONE,
      L10_STATUS.MANUAL_REVIEW_REQUIRED,
      'Sheet records the number as a landline / out of service — SMS cannot reach it'
    ),
  },

  // ---- Previously stopped by a check ---------------------------------------
  {
    test: /safety\s*review/i,
    ...skip(
      DISPOSITION.NEEDS_REVIEW,
      L10_STATUS.SAFETY_REVIEW_FAILED,
      'Sheet records a failed safety review — needs a human before any send'
    ),
  },
  {
    test: /processing|in\s*progress|pending/i,
    ...skip(
      DISPOSITION.NEEDS_REVIEW,
      L10_STATUS.MANUAL_REVIEW_REQUIRED,
      'Sheet says this row was mid-process — a human must confirm whether it sent'
    ),
  },
];

/**
 * Decide whether a spreadsheet row is still open work.
 *
 * @param {string} sendStatus  the row's "Send Status" cell
 * @param {string} notes       the row's "Notes" cell (searched too — the STOP
 *                             reply on at least one row is recorded only there)
 * @returns {{process: boolean, disposition: string, status: string, reason: string}}
 */
export function classifySheetStatus(sendStatus, notes = '') {
  const status = String(sendStatus ?? '').trim();
  const note = String(notes ?? '').trim();

  // Notes are scanned for hard stops even when Send Status is blank: a
  // "DO NOT SEND" written only in Notes must still stop the send.
  const haystack = `${status} ${note}`;

  for (const rule of RULES) {
    // A blank Send Status only ever matches the two HARD-STOP rules (index 0/1)
    // via Notes. Everything else describes an outcome and requires the status
    // cell to say so — otherwise a note like "Template 3 used" left on an
    // unworked row would skip it.
    const subject = status ? haystack : note;
    if (rule.test.test(subject)) {
      const isHardStop = rule.disposition === DISPOSITION.OPTED_OUT || rule.disposition === DISPOSITION.DO_NOT_CONTACT;
      if (status || isHardStop) {
        return { process: false, disposition: rule.disposition, status: rule.status, reason: rule.reason };
      }
    }
  }

  if (!status) return { ...PROCEED };

  // Non-empty and unrecognised: never assume it is safe to send.
  return {
    process: false,
    disposition: DISPOSITION.NEEDS_REVIEW,
    status: L10_STATUS.MANUAL_REVIEW_REQUIRED,
    reason: `Send Status "${status.slice(0, 80)}" is not a recognised wording — a human must decide`,
  };
}

/** Count how a whole sheet breaks down, for the dashboard/boot summary. */
export function summarizeSheetStatus(rows, { statusCol = 'Send Status', notesCol = 'Notes' } = {}) {
  const out = { total: 0, open: 0, skipped: 0, byDisposition: {} };
  for (const r of rows || []) {
    out.total += 1;
    const d = classifySheetStatus(r?.[statusCol], r?.[notesCol]);
    if (d.process) {
      out.open += 1;
    } else {
      out.skipped += 1;
      out.byDisposition[d.disposition] = (out.byDisposition[d.disposition] || 0) + 1;
    }
  }
  return out;
}
