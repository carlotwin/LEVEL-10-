// =============================================================================
// PURE SOP RULES ENGINE.
//
// No browser, no network, no env reads. Facts in -> decision out. Every
// function here is deterministic and unit-testable. The engine (engine.js)
// gathers facts via an adapter and calls these predicates in SOP order,
// performing the (side-effecting) actions between gates.
//
// Design rule (from Revival AI): each check can only ADD a block. A check
// returns { ok: true } to allow continuing, or { ok: false, disposition,
// reason } to stop. Uncertainty always resolves to a block — fail closed.
// =============================================================================
import {
  DISPOSITION,
  REPLY_CLASS,
  OPT_OUT_REGEX,
  BLOCKING_PHRASES,
  POSITIVE_WORDS,
  NEGATIVE_WORDS,
} from './constants.js';

const pass = () => ({ ok: true });
const block = (disposition, reason) => ({ ok: false, disposition, reason });

// -----------------------------------------------------------------------------
// Normalization helpers (shared with the ProfitDial matcher).
// -----------------------------------------------------------------------------
export function normalizePhone(raw) {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : d;
}

export function digitsOnly(raw) {
  return String(raw ?? '').replace(/\D/g, '');
}

// -----------------------------------------------------------------------------
// GATE 1 — Located + tagged + in-state + contactable (no side effects needed).
// Runs before ANY action (we never opt-in a do-not-contact lead).
// -----------------------------------------------------------------------------
export function checkEligibility(facts, config) {
  // 3a. Located in REI?
  if (!facts.found) return block(DISPOSITION.LEAD_NOT_FOUND, 'Contact not found in REI BlackBook');

  // 3b. Level 10 tag present? Derive from the tags array; `hasLevel10Tag` may be
  //     passed explicitly (tests) and takes precedence when defined.
  const wantTag = String(config.level10Tag || '').toLowerCase();
  const derivedTag = (facts.tags || []).some((t) => String(t).toLowerCase() === wantTag);
  const hasTag = facts.hasLevel10Tag ?? derivedTag;
  if (!hasTag) return block(DISPOSITION.MISSING_TAG, `Contact is missing the "${config.level10Tag}" tag`);

  // 3c. Geographic filter.
  const st = String(facts.state ?? '').trim().toUpperCase();
  if (st && config.textStates.length && !config.textStates.includes(st)) {
    return block(DISPOSITION.OUT_OF_STATE, `Property state ${st} is outside allowed states`);
  }

  // 3d. Suppression scan over tags + notes + chat history + Activities tab
  // (fail-closed). Activities is where REI records manual STOP/DNC/complaint
  // history that may not show up anywhere else.
  const haystack = [
    ...(facts.tags || []),
    facts.notes || '',
    ...(facts.chatHistory || []),
    ...(facts.activityLog || []),
  ]
    .join(' \n ')
    .toLowerCase();

  if (facts.optOut || OPT_OUT_REGEX.test(haystack)) {
    return block(DISPOSITION.OPTED_OUT, 'Contact previously opted out / STOP found in history');
  }
  const hit = BLOCKING_PHRASES.find((p) => haystack.includes(p));
  if (hit) {
    // "sold"/"listed" and DNC-style phrases are all hard blocks here.
    if (['do not contact', 'do not text', 'do not call', 'do not automate', 'dnc', 'close my file', 'remove me', 'remove from list', 'remove from the list', 'attorney', 'lawsuit', 'harass'].includes(hit)) {
      return block(DISPOSITION.DO_NOT_CONTACT, `Blocking note found: "${hit}"`);
    }
    return block(DISPOSITION.NEEDS_REVIEW, `Blocking phrase found: "${hit}"`);
  }

  // 3e. Phone validity + single number (SOP requires one clear number).
  const phones = (facts.phones || []).map(normalizePhone).filter(Boolean);
  const uniquePhones = [...new Set(phones)];
  if (uniquePhones.length === 0) return block(DISPOSITION.INVALID_PHONE, 'No usable phone number on contact');
  if (uniquePhones.some((p) => p.length !== 10)) {
    return block(DISPOSITION.INVALID_PHONE, 'Phone number is not a valid 10-digit US number');
  }
  if (uniquePhones.length > 1) {
    return block(DISPOSITION.MULTIPLE_PHONES, `Contact has ${uniquePhones.length} distinct phone numbers — needs review`);
  }

  return pass();
}

// -----------------------------------------------------------------------------
// GATE 1b — Owner-name safety.
//
// Preserve the FULL original owner/homeowner name for verification, display,
// and export. For the SMS merge field, use only the first-listed individual's
// first name — do not combine two names, do not use a last name or company
// name as the first name, and never override a separate safety/opt-in/
// duplicate/property-mismatch block. When the first-listed individual can't
// be confidently identified (pure company/trust name, unreadable, etc.),
// route to manual review rather than guess.
// -----------------------------------------------------------------------------
const NAME_TOP_LEVEL_SEPARATOR_RE = /\s*&\s*|\s+and\s+|\s*\/\s*/i;
const MIDDLE_INITIAL_RE = /^[A-Za-z]\.?$/;
const NAME_BLOCK_TOKENS = new Set(['trust', 'trustee', 'tr', 'llc', 'estate', 'owner', 'unknown', 'inc', 'co']);
const COMPANY_ONLY_HINTS = ['llc', 'l l c', 'inc', 'incorporated', 'corp', 'corporation', 'company', 'properties', 'holdings', 'group', 'partners', 'llp', 'trust'];

/**
 * Extract the first-listed individual's first name from an owner/homeowner
 * name that may contain joint owners ("Tony & Sukien Lam"), recorder-style
 * "Last,First Middle" formatting ("LEE,ROBERT W"), or a personal trust
 * ("BANK, DAVID M TR & CHAVEZ, CESAR D TR" -> "David"). Never combines two
 * names, never uses a last name, and never uses a bare company name.
 * Returns { firstName, ok, reason }. ok:false means "can't confidently tell" —
 * callers must route to manual review rather than guess.
 */
export function deriveFirstName(rawName) {
  const full = String(rawName ?? '').trim();
  if (!full) return { firstName: '', ok: false, reason: 'No owner name to personalize the message' };

  // Keep only the FIRST-listed owner (before &, "and", or /).
  const firstSegment = full.split(NAME_TOP_LEVEL_SEPARATOR_RE)[0].trim();
  const commaIdx = firstSegment.indexOf(',');

  if (commaIdx < 0) {
    // No "Last, First" structure — a bare company/entity name has no comma
    // either, so guard against reading its first word as a person's name.
    const lowSeg = firstSegment.toLowerCase();
    if (COMPANY_ONLY_HINTS.some((h) => lowSeg.includes(h))) {
      return { firstName: '', ok: false, reason: `"${full}" looks like a company/entity name, not an individual` };
    }
  }

  // "Last, First Middle [suffix]" -> take the part after the comma; else
  // assume "First [Middle] Last" and take the leading token.
  const namePart = commaIdx >= 0 ? firstSegment.slice(commaIdx + 1).trim() : firstSegment;

  const tokens = namePart
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => {
      const low = t.toLowerCase().replace(/\.$/, '');
      if (MIDDLE_INITIAL_RE.test(t)) return false; // drop middle initials
      if (NAME_BLOCK_TOKENS.has(low)) return false; // drop trust/company suffix words
      return true;
    });

  const candidate = tokens[0] || '';
  if (!candidate || candidate.length < 2) {
    return { firstName: '', ok: false, reason: `Could not confidently identify the first-listed individual's first name in "${full}"` };
  }
  const firstName = candidate[0].toUpperCase() + candidate.slice(1).toLowerCase();
  return { firstName, ok: true };
}

export function checkNameSafety(facts) {
  const name = String(facts.name || `${facts.firstName || ''} ${facts.lastName || ''}`).trim();
  if (!name) return block(DISPOSITION.NEEDS_REVIEW, 'No owner name to personalize the message');
  const derived = deriveFirstName(name);
  if (!derived.ok) return block(DISPOSITION.NEEDS_REVIEW, derived.reason);
  return pass();
}

// -----------------------------------------------------------------------------
// GATE 0 — Required fields from the UPLOADED FILE ITSELF, checked before ever
// spending a live REI search on this row. A lead ready for processing must
// have a name, phone, and property address in the uploaded row; anything
// missing routes to manual review without touching REI at all.
// -----------------------------------------------------------------------------
export function checkRequiredFields(lead) {
  const missing = [];
  if (!String(lead?.name || '').trim()) missing.push('owner/homeowner name');
  if (!(lead?.phones && lead.phones[0])) missing.push('phone');
  if (!String(lead?.address || '').trim()) missing.push('property address');
  if (missing.length) {
    return block(
      DISPOSITION.NEEDS_REVIEW,
      `MANUAL REVIEW REQUIRED — missing required field(s) in uploaded file: ${missing.join(', ')} (not searched, not sent)`
    );
  }
  return pass();
}

// -----------------------------------------------------------------------------
// GATE 2 — Ledger (already processed for THIS campaign batch).
// -----------------------------------------------------------------------------
export function checkAlreadyProcessed(ledgerHit) {
  if (ledgerHit) return block(DISPOSITION.ALREADY_PROCESSED, 'Already processed for this campaign batch (ledger hit)');
  return pass();
}

// -----------------------------------------------------------------------------
// GATE 3 — Opt-in result (SOP Step 4 — Opt In the Phone Number).
// -----------------------------------------------------------------------------
export function checkOptIn(optInResult) {
  if (!optInResult) return block(DISPOSITION.OPT_IN_FAILED, 'No opt-in result returned');
  if (optInResult.status === 'opted_in' && optInResult.smsEnabled === true) return pass();
  // REI BlackBook's "Phone Opted-Out" state is a permanent, explicit opt-out —
  // distinct from "not yet asked" — and must never be treated as a retryable
  // failure.
  if (optInResult.status === 'opted_out') {
    return block(DISPOSITION.OPTED_OUT, optInResult.reason || 'Phone previously opted out in REI BlackBook (permanent)');
  }
  return block(DISPOSITION.OPT_IN_FAILED, optInResult.reason || 'Phone could not be opted in / not SMS-enabled');
}

// -----------------------------------------------------------------------------
// GATE 4 — ProfitDial matching + availability + readback (requirement #5).
// `match` comes from profitdial.js (pure). `availableInRei` and `readback`
// come from the adapter (facts about the live/sandbox screen).
// -----------------------------------------------------------------------------
export function checkProfitDial({ match, availableNumbers, selectedReadback }) {
  if (!match) return block(DISPOSITION.NEEDS_REVIEW, 'No ProfitDial match result');

  switch (match.status) {
    case 'ok':
      break; // continue to availability/readback checks
    case 'not_found':
      return block(DISPOSITION.NEEDS_REVIEW, 'Contact not found in ProfitDial spreadsheet');
    case 'multiple_records':
      return block(DISPOSITION.NEEDS_REVIEW, `Contact matches ${match.recordCount} spreadsheet rows — ambiguous`);
    case 'missing':
      return block(DISPOSITION.MISSING_PROFITDIAL, 'Matched row has no assigned ProfitDial number');
    case 'multiple_assignments':
      return block(DISPOSITION.MULTIPLE_PROFITDIAL, 'Contact has multiple distinct ProfitDial assignments');
    case 'conflict':
      return block(DISPOSITION.SHEET_CONFLICT, match.reason || 'Spreadsheet record conflicts with REI contact');
    default:
      return block(DISPOSITION.NEEDS_REVIEW, `Unknown ProfitDial match status: ${match.status}`);
  }

  const assigned = digitsOnly(match.profitDial);
  if (assigned.length < 10) return block(DISPOSITION.MISSING_PROFITDIAL, 'Assigned ProfitDial is not a valid number');

  // Must be available in REI's selector.
  const avail = (availableNumbers || []).map(digitsOnly);
  if (!avail.includes(assigned)) {
    return block(DISPOSITION.PROFITDIAL_UNAVAILABLE, 'Assigned ProfitDial number is not available in REI BlackBook');
  }

  // Digit-for-digit readback of what is actually selected on screen.
  const readback = digitsOnly(selectedReadback);
  if (!readback) return block(DISPOSITION.PROFITDIAL_MISMATCH, 'Could not read back the selected ProfitDial number');
  if (readback !== assigned) {
    return block(DISPOSITION.PROFITDIAL_MISMATCH, `Readback ${readback} != assigned ${assigned}`);
  }

  return pass();
}

// -----------------------------------------------------------------------------
// GATE 5 — Template / merge fields (rendered body must be valid & non-empty).
// -----------------------------------------------------------------------------
export function checkRenderedMessage(rendered, template) {
  if (!template) return block(DISPOSITION.NEEDS_REVIEW, 'No template allocated');
  if (!rendered || !rendered.trim()) return block(DISPOSITION.INVALID_MERGE_FIELD, 'Rendered message is empty');
  if (/\{\{.*?\}\}/.test(rendered)) return block(DISPOSITION.INVALID_MERGE_FIELD, 'Unfilled merge field remains in message');
  return pass();
}

// -----------------------------------------------------------------------------
// GATE 6 — Send verification (message actually appears in the thread).
// -----------------------------------------------------------------------------
export function checkSendVerification(verifyResult) {
  if (verifyResult && verifyResult.verified === true) return pass();
  return block(DISPOSITION.SEND_VERIFY_FAILED, (verifyResult && verifyResult.reason) || 'Message not verified in thread');
}

// -----------------------------------------------------------------------------
// Reply classification (SOP Step 9 / KPI engagement).
// -----------------------------------------------------------------------------
export function classifyReply(text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return REPLY_CLASS.NONE;
  if (OPT_OUT_REGEX.test(t)) return REPLY_CLASS.OPT_OUT;
  if (NEGATIVE_WORDS.some((w) => t.includes(w))) return REPLY_CLASS.NEGATIVE;
  if (POSITIVE_WORDS.some((w) => t.includes(w))) return REPLY_CLASS.POSITIVE;
  return REPLY_CLASS.UNCLEAR;
}

/**
 * Convenience composition used by tests: walk gates 1–5 in order given a fully
 * populated facts object. Returns the first block, or { ok:true } if all pass.
 * (The engine calls the individual gates so it can perform actions in between,
 * but this proves the ordering is coherent.)
 */
export function evaluateThroughReadback(facts, config) {
  const e = checkEligibility(facts, config);
  if (!e.ok) return e;
  const a = checkAlreadyProcessed(facts.ledgerHit);
  if (!a.ok) return a;
  const o = checkOptIn(facts.optInResult);
  if (!o.ok) return o;
  const p = checkProfitDial({
    match: facts.profitDialMatch,
    availableNumbers: facts.availableNumbers,
    selectedReadback: facts.selectedReadback,
  });
  if (!p.ok) return p;
  const m = checkRenderedMessage(facts.renderedMessage, facts.template);
  if (!m.ok) return m;
  return pass();
}
