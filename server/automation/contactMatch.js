// =============================================================================
// CONTACT SEARCH VERIFICATION — pure decision rules.
//
// Implements the required search/verification logic for the Level 10 campaign:
//
//   phone (normalized, 10 digits) is the PRIMARY and ONLY search key
//     -> 0 results  : NO_CONTACT_FOUND_BY_PHONE, skip the row (never create)
//     -> 1 result   : phone must match AND name must match -> CONTACT_VERIFIED
//     -> many       : identify exactly one by name (+ address when available),
//                     otherwise MULTIPLE_CONTACTS_MANUAL_REVIEW
//
// Nothing here touches a browser or the network: candidates in -> status out, so
// every branch is unit-testable without REI. The adapter GATHERS candidates; this
// module DECIDES. Uncertainty always resolves to a manual-review status — never
// to a send.
// =============================================================================
import { L10_STATUS } from './constants.js';
import { normalizePhone } from './sop.js';
import { normalizeAddress } from './profitdial.js';

// -----------------------------------------------------------------------------
// NAME NORMALIZATION
//
// Ownership/vesting words carry no identity: a sheet that says
// "SMITH JOHN LIVING TRUST" is the same person REI calls "John Smith".
// -----------------------------------------------------------------------------
const OWNERSHIP_WORDS = new Set([
  'TRUST',
  'TRUSTEE',
  'TRUSTEES',
  'TR',
  'LIVING',
  'REVOCABLE',
  'IRREVOCABLE',
  'FAMILY',
  'ESTATE',
  'ET',
  'AL',
  'ETAL',
  'LLC',
  'INC',
  'CORP',
  'COMPANY',
  'CO',
  'LP',
  'LLP',
]);

// Titles and generational suffixes — noise for identity purposes.
const TITLE_WORDS = new Set(['MR', 'MRS', 'MS', 'MISS', 'DR', 'JR', 'SR', 'II', 'III', 'IV', 'V']);

// Placeholders REI uses when a name is not known. These must never satisfy a
// name check — an "Unknown" contact is exactly the case that needs a human.
const PLACEHOLDER_WORDS = new Set(['UNKNOWN', 'OWNER', 'OCCUPANT', 'RESIDENT', 'CURRENT', 'NA', 'NONE', 'TBD']);

/** Multiple owners on one record ("A & B", "A AND B") — never auto-approved. */
export function hasMultipleOwners(raw) {
  const s = String(raw ?? '').toUpperCase();
  return /&|\bAND\b|\+/.test(s);
}

/**
 * Identity-bearing tokens of a name: uppercase, punctuation removed, ownership
 * words / titles / placeholders dropped, single letters (middle initials) dropped.
 */
export function nameTokens(raw) {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(
      (t) =>
        t.length > 1 && // drops middle initials
        !OWNERSHIP_WORDS.has(t) &&
        !TITLE_WORDS.has(t) &&
        !PLACEHOLDER_WORDS.has(t)
    );
}

export const NAME_RESULT = Object.freeze({
  MATCH: 'MATCH',
  NO_MATCH: 'NO_MATCH',
  POSSIBLE: 'POSSIBLE_MATCH_MANUAL_REVIEW',
});

/** Single letters in a name are middle initials, kept separately from the core. */
export function nameInitials(raw) {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length === 1);
}

/** Did this name carry trust/vesting wording? Such records get a stricter bar. */
export function isTrustName(raw) {
  return String(raw ?? '')
    .toUpperCase()
    .split(/[^A-Z]+/)
    .some((t) => OWNERSHIP_WORDS.has(t));
}

const setsEqual = (a, b) => a.size === b.size && [...a].every((t) => b.has(t));

/**
 * Compare a spreadsheet name with a REI contact name.
 *
 * Automatic approval requires the SAME PERSON, not merely a family resemblance:
 * the core name tokens (everything except middle initials) must be identical as
 * sets. Order is irrelevant — "SMITH JOHN" is "John Smith" — and vesting words,
 * titles and suffixes are stripped first.
 *
 *   MATCH     core tokens identical, single owner, and any middle initial is
 *             consistent with the other side's full middle name
 *   POSSIBLE  first and last agree but a middle name differs or is extra
 *             ("JOHN ALLEN SMITH" vs "John Andrew Smith", "ROBERT JOHN SMITH"
 *             vs "John Smith"), or the record has multiple owners
 *   NO_MATCH  fewer than two tokens agree, or either side is unusable
 *
 * Two shared tokens are NEVER enough on their own — that is what could approve
 * the wrong family member.
 *
 * @returns {{result: string, reason: string, trust: boolean}}
 */
export function compareNames(sheetName, reiName) {
  const s = nameTokens(sheetName);
  const r = nameTokens(reiName);
  const trust = isTrustName(sheetName) || isTrustName(reiName);

  if (s.length === 0 || r.length === 0) {
    return {
      result: NAME_RESULT.NO_MATCH,
      reason: `no usable name tokens (sheet "${sheetName ?? ''}" / REI "${reiName ?? ''}")`,
      trust,
    };
  }

  const S = new Set(s);
  const R = new Set(r);
  const overlap = [...S].filter((t) => R.has(t));
  const multiOwner = hasMultipleOwners(sheetName) || hasMultipleOwners(reiName);

  if (multiOwner) {
    return {
      result: NAME_RESULT.POSSIBLE,
      reason: `multiple owners on the record — "${sheetName}" vs "${reiName}" needs a human`,
      trust,
    };
  }

  // Identical core names: the same person.
  if (setsEqual(S, R)) {
    return { result: NAME_RESULT.MATCH, reason: `names identical after normalization (${overlap.join(', ')})`, trust };
  }

  // One side carries extra full name tokens the other does not. This is only the
  // same person when every extra token is explained by a matching middle INITIAL
  // on the shorter side ("JOHN A SMITH" vs "John Andrew Smith"). An unexplained
  // extra name ("ROBERT JOHN SMITH" vs "John Smith") is not auto-approved.
  const [small, big, smallRaw] = S.size <= R.size ? [S, R, sheetName] : [R, S, reiName];
  const smallInitials = new Set(nameInitials(S.size <= R.size ? sheetName : reiName));
  if ([...small].every((t) => big.has(t))) {
    const extra = [...big].filter((t) => !small.has(t));
    const explained = extra.every((t) => smallInitials.has(t[0]));
    if (explained && extra.length > 0) {
      return {
        result: NAME_RESULT.MATCH,
        reason: `names agree; middle name ${extra.join(', ')} matches the initial in "${smallRaw}"`,
        trust,
      };
    }
    return {
      result: NAME_RESULT.POSSIBLE,
      reason: `"${sheetName}" vs "${reiName}" differ by ${extra.join(', ')} — could be a different family member`,
      trust,
    };
  }

  // Both sides hold tokens the other lacks. Two agreeing tokens (typically first
  // and last) with conflicting middle names is a manual review; anything less is
  // a different person.
  if (overlap.length >= 2) {
    const sheetOnly = [...S].filter((t) => !R.has(t));
    const reiOnly = [...R].filter((t) => !S.has(t));
    return {
      result: NAME_RESULT.POSSIBLE,
      reason: `"${sheetName}" and REI "${reiName}" agree on ${overlap.join(', ')} but conflict: ${sheetOnly.join(', ')} vs ${reiOnly.join(', ')}`,
      trust,
    };
  }

  return {
    result: NAME_RESULT.NO_MATCH,
    reason: overlap.length
      ? `only "${overlap[0]}" agrees — "${sheetName}" vs "${reiName}"`
      : `no shared name tokens — "${sheetName}" vs "${reiName}"`,
    trust,
  };
}

// -----------------------------------------------------------------------------
// ADDRESS COMPARISON (additional verification field, used when available)
// -----------------------------------------------------------------------------
export const ADDRESS_RESULT = Object.freeze({ MATCH: 'MATCH', CONFLICT: 'CONFLICT', UNKNOWN: 'UNKNOWN' });

/** Compare property addresses. Absent on either side => UNKNOWN, never CONFLICT. */
export function compareAddresses(sheetAddress, reiAddress) {
  const a = normalizeAddress(sheetAddress);
  const b = normalizeAddress(reiAddress);
  if (!a || !b) return ADDRESS_RESULT.UNKNOWN;
  if (a === b || a.includes(b) || b.includes(a)) return ADDRESS_RESULT.MATCH;
  // Compare the street portion (number + name) before declaring a conflict:
  // "123 OAK ST FRESNO CA 93701" vs "123 OAK ST" is not a conflict.
  const streetOf = (x) => x.split(' ').slice(0, 3).join(' ');
  if (streetOf(a) === streetOf(b)) return ADDRESS_RESULT.MATCH;
  return ADDRESS_RESULT.CONFLICT;
}

/** Do two phone values refer to the same US number? Blank on either side = false. */
export function phonesMatch(a, b) {
  const x = normalizePhone(a);
  const y = normalizePhone(b);
  return Boolean(x) && x.length === 10 && x === y;
}

// -----------------------------------------------------------------------------
// THE DECISION
// -----------------------------------------------------------------------------

/**
 * Decide which REI contact (if any) is the homeowner from this spreadsheet row.
 *
 * @param {object} p
 * @param {object} p.sheet       { phone, name, address } from the spreadsheet row
 * @param {Array<object>} p.candidates  contacts REI returned for the phone search,
 *                                      each { name, phone, address, ref }
 * @returns {{status: string, chosen: object|null, reason: string, nameResult?: string}}
 */
export function chooseContact({ sheet, candidates }) {
  const list = Array.isArray(candidates) ? candidates : [];
  const sheetPhone = normalizePhone(sheet?.phone);

  // A row with no usable phone can never be searched by phone — the required
  // primary key is missing, so there is nothing to verify against.
  if (!sheetPhone || sheetPhone.length !== 10) {
    return {
      status: L10_STATUS.MANUAL_REVIEW_REQUIRED,
      chosen: null,
      reason: `spreadsheet phone "${sheet?.phone ?? ''}" is not a valid 10-digit US number — cannot search by phone`,
    };
  }

  if (list.length === 0) {
    return {
      status: L10_STATUS.NO_CONTACT_FOUND_BY_PHONE,
      chosen: null,
      reason: `no REI contact matched phone ${sheetPhone} — not creating a contact, not sending`,
    };
  }

  // --- exactly one candidate -------------------------------------------------
  if (list.length === 1) {
    const c = list[0];
    if (!phonesMatch(sheetPhone, c.phone)) {
      return {
        status: L10_STATUS.MANUAL_REVIEW_REQUIRED,
        chosen: null,
        reason: `REI phone "${c.phone ?? '(unreadable)'}" does not match sheet phone ${sheetPhone}`,
      };
    }
    const name = compareNames(sheet?.name, c.name);
    if (name.result === NAME_RESULT.MATCH) {
      const addr = compareAddresses(sheet?.address, c.address);
      if (addr === ADDRESS_RESULT.CONFLICT) {
        return {
          status: L10_STATUS.MANUAL_REVIEW_REQUIRED,
          chosen: null,
          reason: `phone and name match but the property address conflicts (sheet "${sheet?.address}" vs REI "${c.address}")`,
          nameResult: name.result,
        };
      }
      // A trust name matched to an individual needs MORE than the name: the phone
      // must match exactly (already true here) AND the property address must
      // positively agree. An unknown address is not good enough for a trust.
      if (name.trust && addr !== ADDRESS_RESULT.MATCH) {
        return {
          status: L10_STATUS.MANUAL_REVIEW_REQUIRED,
          chosen: null,
          reason:
            `trust/vested name "${sheet?.name}" matched individual "${c.name}", but a trust also requires the ` +
            `property address to agree and it could not be confirmed (sheet "${sheet?.address || '(blank)'}" vs REI "${c.address || '(blank)'}")`,
          nameResult: name.result,
        };
      }
      return {
        status: L10_STATUS.CONTACT_VERIFIED,
        chosen: c,
        reason: `phone ${sheetPhone} and name confirmed (${name.reason})`,
        nameResult: name.result,
      };
    }
    if (name.result === NAME_RESULT.POSSIBLE) {
      return {
        status: L10_STATUS.MANUAL_REVIEW_REQUIRED,
        chosen: null,
        reason: `name needs a human: ${name.reason}`,
        nameResult: name.result,
      };
    }
    return {
      status: L10_STATUS.PHONE_MATCH_NAME_MISMATCH,
      chosen: null,
      reason: `phone matched but ${name.reason}`,
      nameResult: name.result,
    };
  }

  // --- several candidates on the same phone ---------------------------------
  // Never take the first result. Confirm by name, then by address when present.
  const scored = list.map((c) => ({
    c,
    phoneOk: phonesMatch(sheetPhone, c.phone),
    name: compareNames(sheet?.name, c.name),
    addr: compareAddresses(sheet?.address, c.address),
  }));

  const confident = scored.filter(
    (x) =>
      x.phoneOk &&
      x.name.result === NAME_RESULT.MATCH &&
      x.addr !== ADDRESS_RESULT.CONFLICT &&
      // Same stricter bar for trust names among several candidates.
      (!x.name.trust || x.addr === ADDRESS_RESULT.MATCH)
  );

  if (confident.length === 1) {
    const win = confident[0];
    return {
      status: L10_STATUS.CONTACT_VERIFIED,
      chosen: win.c,
      reason: `${list.length} contacts on phone ${sheetPhone}; exactly one confirmed (${win.name.reason}${
        win.addr === ADDRESS_RESULT.MATCH ? ', address agrees' : ''
      })`,
      nameResult: win.name.result,
    };
  }

  // Address can break a tie between same-name candidates.
  if (confident.length > 1) {
    const byAddress = confident.filter((x) => x.addr === ADDRESS_RESULT.MATCH);
    if (byAddress.length === 1) {
      return {
        status: L10_STATUS.CONTACT_VERIFIED,
        chosen: byAddress[0].c,
        reason: `${list.length} contacts on phone ${sheetPhone}; ${confident.length} matched by name, one by property address`,
        nameResult: byAddress[0].name.result,
      };
    }
  }

  return {
    status: L10_STATUS.MULTIPLE_CONTACTS_MANUAL_REVIEW,
    chosen: null,
    reason:
      `${list.length} contacts on phone ${sheetPhone}, ${confident.length} confidently identified — ` +
      `not guessing. Candidates: ${list.map((c) => `"${c.name || '(no name)'}"`).join(', ')}`,
  };
}

/** The status describing the raw search result, for logging/tracking. */
export function searchResultStatus(count) {
  if (!count) return L10_STATUS.NO_CONTACT_FOUND_BY_PHONE;
  return count === 1 ? L10_STATUS.ONE_CONTACT_FOUND : L10_STATUS.MULTIPLE_CONTACTS_FOUND;
}

// -----------------------------------------------------------------------------
// RE-VERIFICATION ON THE FULL CONTACT RECORD
//
// The Smart Contacts result row is a summary: columns can be truncated, stale, or
// show a different phone than the record holds. So the row is only ever a
// CANDIDATE — CONTACT_VERIFIED is set from the opened contact's own detail page.
// If the detail cannot be read confidently, that is MANUAL_REVIEW_REQUIRED, not
// a pass.
// -----------------------------------------------------------------------------

/**
 * Final verification against the opened contact record.
 *
 * @param {object} p
 * @param {object} p.sheet   { phone, name, address } from the spreadsheet row
 * @param {object} p.detail  { phones[], name, address, tags[] } read from the record
 * @param {string} p.level10Tag  the tag that must be present
 * @returns {{status, reason, flags:{phoneVerified,nameVerified,addressOk,level10TagVerified}}}
 */
export function verifyOpenedContact({ sheet, detail, level10Tag }) {
  const flags = {
    phoneVerified: false,
    nameVerified: false,
    addressOk: false,
    level10TagVerified: false,
  };

  const detailPhones = (detail?.phones || []).map((p) => normalizePhone(p)).filter(Boolean);
  const detailName = String(detail?.name ?? '').trim();
  const sheetPhone = normalizePhone(sheet?.phone);

  // Could we read the record at all? An unreadable detail page must never pass.
  if (detailPhones.length === 0 && !detailName) {
    return {
      status: L10_STATUS.MANUAL_REVIEW_REQUIRED,
      reason: 'the contact record could not be read (no phone and no name on the detail page)',
      flags,
    };
  }

  // 1. Phone on the record must match the spreadsheet.
  if (!detailPhones.includes(sheetPhone)) {
    return {
      status: L10_STATUS.MANUAL_REVIEW_REQUIRED,
      reason: `contact record phone ${detailPhones.join('/') || '(unreadable)'} does not match spreadsheet ${sheetPhone}`,
      flags,
    };
  }
  flags.phoneVerified = true;

  // 2. Name on the record must match the spreadsheet.
  const name = compareNames(sheet?.name, detailName);
  if (name.result !== NAME_RESULT.MATCH) {
    return {
      status:
        name.result === NAME_RESULT.NO_MATCH
          ? L10_STATUS.PHONE_MATCH_NAME_MISMATCH
          : L10_STATUS.MANUAL_REVIEW_REQUIRED,
      reason: `contact record name: ${name.reason}`,
      flags,
    };
  }
  flags.nameVerified = true;

  // 3. No conflicting property address.
  const addr = compareAddresses(sheet?.address, detail?.address);
  if (addr === ADDRESS_RESULT.CONFLICT) {
    return {
      status: L10_STATUS.MANUAL_REVIEW_REQUIRED,
      reason: `contact record property address conflicts (sheet "${sheet?.address}" vs record "${detail?.address}")`,
      flags,
    };
  }
  // A trust matched to an individual needs the address to positively agree.
  if (name.trust && addr !== ADDRESS_RESULT.MATCH) {
    return {
      status: L10_STATUS.MANUAL_REVIEW_REQUIRED,
      reason: `trust/vested name requires a confirmed property address on the record (got "${detail?.address || '(blank)'}")`,
      flags,
    };
  }
  flags.addressOk = true;

  // 4. Level 10 tag must be present on the record. Read only — never written.
  const want = String(level10Tag ?? '').trim().toLowerCase();
  const tags = (detail?.tags || []).map((t) => String(t).trim().toLowerCase());
  if (!want || !tags.includes(want)) {
    return {
      status: L10_STATUS.LEVEL_10_TAG_MISSING,
      reason: `the "${level10Tag}" tag is not on this contact (tags read: ${(detail?.tags || []).join(', ') || 'none'})`,
      flags,
    };
  }
  flags.level10TagVerified = true;

  return {
    status: L10_STATUS.CONTACT_VERIFIED,
    reason: `verified on the contact record: phone ${sheetPhone}, ${name.reason}, "${level10Tag}" tag present`,
    flags,
  };
}

// -----------------------------------------------------------------------------
// PRODUCTION SEND GATE
//
// The last thing standing between the pipeline and an irreversible SMS. Every
// gate must be the boolean `true`. Anything false, missing, undefined, or merely
// truthy ("yes", 1) fails — an unknown gate is a closed gate.
// -----------------------------------------------------------------------------
export const SEND_GATES = Object.freeze([
  'contactVerified',
  'level10TagVerified',
  'safetyReviewPassed',
  'smsOptInVerified',
  'profitDialVerified',
  'approvedTemplateVerified',
]);

/**
 * @returns {{allowed: boolean, failed: string[], reason: string}}
 */
export function checkSendGates(gates) {
  const g = gates || {};
  const failed = SEND_GATES.filter((k) => g[k] !== true);
  return {
    allowed: failed.length === 0,
    failed,
    reason: failed.length
      ? `send blocked — these safety gates are not verified: ${failed.join(', ')}`
      : 'all six safety gates verified',
  };
}
