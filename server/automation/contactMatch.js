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

/**
 * Compare a spreadsheet name with a REI contact name.
 *
 * Order-insensitive ("SMITH JOHN" == "John Smith") and tolerant of vesting words
 * and middle initials, but strict about identity:
 *
 *   MATCH     one token set contains the other, >= 2 tokens agree, single owner
 *   POSSIBLE  multiple owners, or only one token agrees, or both sides carry
 *             tokens the other lacks while still overlapping
 *   NO_MATCH  no meaningful overlap, or either side has no usable tokens
 *
 * @returns {{result: string, reason: string}}
 */
export function compareNames(sheetName, reiName) {
  const s = nameTokens(sheetName);
  const r = nameTokens(reiName);

  if (s.length === 0 || r.length === 0) {
    return {
      result: NAME_RESULT.NO_MATCH,
      reason: `no usable name tokens (sheet "${sheetName ?? ''}" / REI "${reiName ?? ''}")`,
    };
  }

  const S = new Set(s);
  const R = new Set(r);
  const overlap = [...S].filter((t) => R.has(t));
  const subset = overlap.length === S.size || overlap.length === R.size;
  const multiOwner = hasMultipleOwners(sheetName) || hasMultipleOwners(reiName);

  // Each side carrying a token the other lacks means two different people —
  // "JOHN SMITH" vs "Michael Smith" is a mismatch, not an ambiguity. Only when
  // one name is contained in the other (extra vesting words, a second owner, a
  // middle name) can this be the same person.
  if (!subset) {
    const sheetOnly = [...S].filter((t) => !R.has(t));
    const reiOnly = [...R].filter((t) => !S.has(t));
    return {
      result: NAME_RESULT.NO_MATCH,
      reason: overlap.length
        ? `names conflict — "${sheetName}" has ${sheetOnly.join(', ')}, REI "${reiName}" has ${reiOnly.join(', ')}`
        : `no shared name tokens — "${sheetName}" vs "${reiName}"`,
    };
  }

  if (multiOwner) {
    return {
      result: NAME_RESULT.POSSIBLE,
      reason: `multiple owners on the record — "${sheetName}" vs "${reiName}" needs a human`,
    };
  }

  if (overlap.length >= 2) {
    return { result: NAME_RESULT.MATCH, reason: `names agree on ${overlap.join(', ')}` };
  }

  // A single shared token (usually just a surname) is not enough to act on.
  return {
    result: NAME_RESULT.POSSIBLE,
    reason: `only "${overlap[0]}" agrees — "${sheetName}" vs "${reiName}"`,
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
    (x) => x.phoneOk && x.name.result === NAME_RESULT.MATCH && x.addr !== ADDRESS_RESULT.CONFLICT
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
