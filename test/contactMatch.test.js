// =============================================================================
// The required test cases for the phone-first contact search + verification.
// Pure rules only — no browser, no REI account needed.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseContact,
  compareNames,
  compareAddresses,
  phonesMatch,
  nameTokens,
  hasMultipleOwners,
  searchResultStatus,
  isTrustName,
  verifyOpenedContact,
  NAME_RESULT,
  ADDRESS_RESULT,
} from '../server/automation/contactMatch.js';
import { L10_STATUS } from '../server/automation/constants.js';

const SHEET = {
  phone: '916-607-2808',
  name: 'TONY LAM',
  address: '2700 Humboldt Ave, Oakland, CA 94602',
};

// ---------------------------------------------------------------------------
// The three worked examples from the specification
// ---------------------------------------------------------------------------
test('spec example 1: trust name vs individual => MATCH', () => {
  assert.equal(compareNames('SMITH JOHN LIVING TRUST', 'John Smith').result, NAME_RESULT.MATCH);
});

test('spec example 2: different first name => NO MATCH', () => {
  assert.equal(compareNames('JOHN SMITH', 'Michael Smith').result, NAME_RESULT.NO_MATCH);
});

test('spec example 3: multiple owners with TR => POSSIBLE MATCH, manual review', () => {
  const r = compareNames('BANK DAVID M TR & CHAVEZ CESAR D TR', 'David Bank');
  assert.equal(r.result, NAME_RESULT.POSSIBLE);
  assert.match(r.reason, /multiple owners/i);
});

// ---------------------------------------------------------------------------
// Required case 1 — exact phone and name match
// ---------------------------------------------------------------------------
test('case 1: exact phone and name match => CONTACT_VERIFIED', () => {
  const r = chooseContact({
    sheet: SHEET,
    candidates: [{ name: 'Tony Lam', phone: '(916) 607-2808', address: '2700 Humboldt Ave', ref: 0 }],
  });
  assert.equal(r.status, L10_STATUS.CONTACT_VERIFIED);
  assert.equal(r.chosen.ref, 0);
});

// ---------------------------------------------------------------------------
// Required case 2 — phone found but name mismatch
// ---------------------------------------------------------------------------
test('case 2: phone matches, name clearly different => PHONE_MATCH_NAME_MISMATCH, no send', () => {
  const r = chooseContact({
    sheet: SHEET,
    candidates: [{ name: 'Linda Hunt', phone: '916-607-2808', address: '', ref: 0 }],
  });
  assert.equal(r.status, L10_STATUS.PHONE_MATCH_NAME_MISMATCH);
  assert.equal(r.chosen, null);
});

// ---------------------------------------------------------------------------
// Required case 3 — no phone result
// ---------------------------------------------------------------------------
test('case 3: no contact found by phone => NO_CONTACT_FOUND_BY_PHONE, skip row', () => {
  const r = chooseContact({ sheet: SHEET, candidates: [] });
  assert.equal(r.status, L10_STATUS.NO_CONTACT_FOUND_BY_PHONE);
  assert.equal(r.chosen, null);
  assert.match(r.reason, /not creating a contact/i);
});

// ---------------------------------------------------------------------------
// Required case 4 — multiple contacts, one clear match
// ---------------------------------------------------------------------------
test('case 4: several contacts on one phone, exactly one confirmed => CONTACT_VERIFIED', () => {
  const r = chooseContact({
    sheet: SHEET,
    candidates: [
      { name: 'Maria Gonzalez', phone: '916-607-2808', address: '55 Other St', ref: 0 },
      { name: 'Tony Lam', phone: '916-607-2808', address: '2700 Humboldt Ave', ref: 1 },
    ],
  });
  assert.equal(r.status, L10_STATUS.CONTACT_VERIFIED);
  assert.equal(r.chosen.ref, 1, 'picked the confirmed one, not the first row');
});

test('case 4b: two same-name contacts are separated by the property address', () => {
  const r = chooseContact({
    sheet: SHEET,
    candidates: [
      { name: 'Tony Lam', phone: '916-607-2808', address: '9 Elsewhere Rd, Fresno, CA', ref: 0 },
      { name: 'Tony Lam', phone: '916-607-2808', address: '2700 Humboldt Ave, Oakland, CA 94602', ref: 1 },
    ],
  });
  assert.equal(r.status, L10_STATUS.CONTACT_VERIFIED);
  assert.equal(r.chosen.ref, 1);
});

// ---------------------------------------------------------------------------
// Required case 5 — multiple contacts, no clear match
// ---------------------------------------------------------------------------
test('case 5: several contacts, none confirmed => MULTIPLE_CONTACTS_MANUAL_REVIEW', () => {
  const r = chooseContact({
    sheet: SHEET,
    candidates: [
      { name: 'Maria Gonzalez', phone: '916-607-2808', address: '', ref: 0 },
      { name: 'Unknown', phone: '916-607-2808', address: '', ref: 1 },
    ],
  });
  assert.equal(r.status, L10_STATUS.MULTIPLE_CONTACTS_MANUAL_REVIEW);
  assert.equal(r.chosen, null);
});

test('case 5b: two identical-name contacts with no address to separate them => manual review', () => {
  const r = chooseContact({
    sheet: { ...SHEET, address: '' },
    candidates: [
      { name: 'Tony Lam', phone: '916-607-2808', address: '', ref: 0 },
      { name: 'Tony Lam', phone: '916-607-2808', address: '', ref: 1 },
    ],
  });
  assert.equal(r.status, L10_STATUS.MULTIPLE_CONTACTS_MANUAL_REVIEW);
  assert.equal(r.chosen, null, 'never picks the first result');
});

// ---------------------------------------------------------------------------
// Required case 6 — trust name compared with an individual name
// ---------------------------------------------------------------------------
test('case 6: single-owner trust name verifies against the individual', () => {
  const r = chooseContact({
    sheet: { phone: '559-555-0101', name: 'SMITH JOHN LIVING TRUST', address: '12 Elm St, Fresno, CA' },
    candidates: [{ name: 'John Smith', phone: '5595550101', address: '12 Elm St', ref: 0 }],
  });
  assert.equal(r.status, L10_STATUS.CONTACT_VERIFIED);
});

test('case 6b: multi-owner trust name is held for a human', () => {
  const r = chooseContact({
    sheet: { phone: '559-555-0102', name: 'BANK DAVID M TR & CHAVEZ CESAR D TR', address: '13 Elm St' },
    candidates: [{ name: 'David Bank', phone: '5595550102', address: '13 Elm St', ref: 0 }],
  });
  assert.equal(r.status, L10_STATUS.MANUAL_REVIEW_REQUIRED);
  assert.equal(r.chosen, null);
});

// ---------------------------------------------------------------------------
// Required case 7 — malformed or missing phone number
// ---------------------------------------------------------------------------
test('case 7: malformed or missing sheet phone => MANUAL_REVIEW_REQUIRED, no search', () => {
  for (const bad of ['', '   ', '555', '916-607', 'n/a', null, undefined]) {
    const r = chooseContact({ sheet: { ...SHEET, phone: bad }, candidates: [] });
    assert.equal(r.status, L10_STATUS.MANUAL_REVIEW_REQUIRED, `phone ${JSON.stringify(bad)}`);
    assert.match(r.reason, /not a valid 10-digit/i);
  }
});

test('case 7b: an 11-digit +1 number normalizes and verifies', () => {
  const r = chooseContact({
    sheet: { ...SHEET, phone: '+1 (916) 607-2808' },
    candidates: [{ name: 'Tony Lam', phone: '916.607.2808', address: '2700 Humboldt Ave', ref: 0 }],
  });
  assert.equal(r.status, L10_STATUS.CONTACT_VERIFIED);
});

// ---------------------------------------------------------------------------
// Safety rules that must hold regardless
// ---------------------------------------------------------------------------
test('a REI phone that does not match the sheet is never accepted', () => {
  const r = chooseContact({
    sheet: SHEET,
    candidates: [{ name: 'Tony Lam', phone: '510-000-1111', address: '2700 Humboldt Ave', ref: 0 }],
  });
  assert.equal(r.status, L10_STATUS.MANUAL_REVIEW_REQUIRED);
  assert.equal(r.chosen, null);
});

test('an unreadable REI phone is never assumed to match', () => {
  const r = chooseContact({
    sheet: SHEET,
    candidates: [{ name: 'Tony Lam', phone: '', address: '2700 Humboldt Ave', ref: 0 }],
  });
  assert.equal(r.status, L10_STATUS.MANUAL_REVIEW_REQUIRED);
});

test('phone and name agree but the property address conflicts => manual review', () => {
  const r = chooseContact({
    sheet: SHEET,
    candidates: [{ name: 'Tony Lam', phone: '916-607-2808', address: '77 Totally Different Blvd, Fresno, CA', ref: 0 }],
  });
  assert.equal(r.status, L10_STATUS.MANUAL_REVIEW_REQUIRED);
  assert.match(r.reason, /address conflicts/i);
});

test('an "Unknown" REI name never satisfies the name check', () => {
  const r = chooseContact({
    sheet: SHEET,
    candidates: [{ name: 'Unknown', phone: '916-607-2808', address: '2700 Humboldt Ave', ref: 0 }],
  });
  assert.equal(r.status, L10_STATUS.PHONE_MATCH_NAME_MISMATCH);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
test('name tokens drop vesting words, titles, initials and placeholders', () => {
  assert.deepEqual(nameTokens('SMITH JOHN LIVING TRUST'), ['SMITH', 'JOHN']);
  assert.deepEqual(nameTokens('Tony R. Lam Jr'), ['TONY', 'LAM']);
  assert.deepEqual(nameTokens('Unknown Owner'), []);
  assert.deepEqual(nameTokens('BANK DAVID M TR'), ['BANK', 'DAVID']);
});

test('multiple-owner detection', () => {
  assert.equal(hasMultipleOwners('A & B'), true);
  assert.equal(hasMultipleOwners('SMITH JOHN AND JANE'), true);
  assert.equal(hasMultipleOwners('TONY LAM'), false);
});

test('phone comparison requires a full 10-digit match', () => {
  assert.equal(phonesMatch('916-607-2808', '(916) 607-2808'), true);
  assert.equal(phonesMatch('1-916-607-2808', '916.607.2808'), true);
  assert.equal(phonesMatch('916-607-2808', '916-607-2809'), false);
  assert.equal(phonesMatch('', '916-607-2808'), false);
  assert.equal(phonesMatch('607-2808', '916-607-2808'), false);
});

test('address comparison treats a missing side as unknown, not a conflict', () => {
  assert.equal(compareAddresses('2700 Humboldt Ave, Oakland, CA', '2700 Humboldt Ave'), ADDRESS_RESULT.MATCH);
  assert.equal(compareAddresses('2700 Humboldt Ave', ''), ADDRESS_RESULT.UNKNOWN);
  assert.equal(compareAddresses('2700 Humboldt Ave', '9 Other Rd'), ADDRESS_RESULT.CONFLICT);
});

test('search result status reflects the raw candidate count', () => {
  assert.equal(searchResultStatus(0), L10_STATUS.NO_CONTACT_FOUND_BY_PHONE);
  assert.equal(searchResultStatus(1), L10_STATUS.ONE_CONTACT_FOUND);
  assert.equal(searchResultStatus(3), L10_STATUS.MULTIPLE_CONTACTS_FOUND);
});

// ---------------------------------------------------------------------------
// TIGHTENED INDIVIDUAL NAME MATCHING — two shared tokens are never enough
// ---------------------------------------------------------------------------
test('middle initial is ignored when it does not conflict', () => {
  assert.equal(compareNames('JOHN A SMITH', 'John Smith').result, NAME_RESULT.MATCH);
  assert.equal(compareNames('John Smith', 'JOHN A SMITH').result, NAME_RESULT.MATCH);
});

test('a middle initial consistent with a full middle name still matches', () => {
  // "A" is consistent with "Andrew" — same person, spelled out on one side.
  assert.equal(compareNames('JOHN A SMITH', 'John Andrew Smith').result, NAME_RESULT.MATCH);
});

test('conflicting FULL middle names are never auto-approved', () => {
  const r = compareNames('JOHN ALLEN SMITH', 'John Andrew Smith');
  assert.notEqual(r.result, NAME_RESULT.MATCH);
  assert.equal(r.result, NAME_RESULT.POSSIBLE);
});

test('a middle initial that conflicts with a full middle name is not a match', () => {
  const r = compareNames('JOHN B SMITH', 'John Andrew Smith');
  assert.notEqual(r.result, NAME_RESULT.MATCH);
});

test('an extra full first name is not auto-matched on two shared tokens', () => {
  // ROBERT JOHN SMITH vs John Smith — could be father and son.
  const r = compareNames('ROBERT JOHN SMITH', 'John Smith');
  assert.notEqual(r.result, NAME_RESULT.MATCH, 'must not auto-match on JOHN + SMITH alone');
  assert.equal(r.result, NAME_RESULT.POSSIBLE);
});

test('different first name with shared surname is still NO MATCH', () => {
  assert.equal(compareNames('JOHN SMITH', 'Michael Smith').result, NAME_RESULT.NO_MATCH);
});

test('the wrong family member cannot be verified end to end', () => {
  const r = chooseContact({
    sheet: { phone: '559-555-0150', name: 'ROBERT JOHN SMITH', address: '40 Pine St, Fresno, CA' },
    candidates: [{ name: 'John Smith', phone: '5595550150', address: '40 Pine St', ref: 0 }],
  });
  assert.equal(r.status, L10_STATUS.MANUAL_REVIEW_REQUIRED);
  assert.equal(r.chosen, null);
});

// ---------------------------------------------------------------------------
// TRUST NAMES need phone AND address, not just the name
// ---------------------------------------------------------------------------
test('a trust verifies only when the property address also agrees', () => {
  const sheet = { phone: '559-555-0160', name: 'SMITH JOHN LIVING TRUST', address: '12 Elm St, Fresno, CA 93701' };
  const ok = chooseContact({
    sheet,
    candidates: [{ name: 'John Smith', phone: '5595550160', address: '12 Elm St', ref: 0 }],
  });
  assert.equal(ok.status, L10_STATUS.CONTACT_VERIFIED, ok.reason);

  // Same name and phone, but the record has no address to confirm against.
  const noAddr = chooseContact({
    sheet,
    candidates: [{ name: 'John Smith', phone: '5595550160', address: '', ref: 0 }],
  });
  assert.equal(noAddr.status, L10_STATUS.MANUAL_REVIEW_REQUIRED);
  assert.match(noAddr.reason, /trust/i);
});

test('isTrustName spots vesting wording', () => {
  assert.equal(isTrustName('SMITH JOHN LIVING TRUST'), true);
  assert.equal(isTrustName('BANK DAVID M TR'), true);
  assert.equal(isTrustName('ACME LLC'), true);
  assert.equal(isTrustName('TONY LAM'), false);
});

// ---------------------------------------------------------------------------
// RE-VERIFICATION on the opened record
// ---------------------------------------------------------------------------
const TAG = 'Level 10 Properties';
const DETAIL_OK = {
  name: 'Tony Lam',
  phones: ['(916) 607-2808'],
  address: '2700 Humboldt Ave, Oakland, CA 94602',
  tags: [TAG],
};

test('re-verification passes when the record confirms phone, name, address and tag', () => {
  const r = verifyOpenedContact({ sheet: SHEET, detail: DETAIL_OK, level10Tag: TAG });
  assert.equal(r.status, L10_STATUS.CONTACT_VERIFIED);
  assert.deepEqual(r.flags, { phoneVerified: true, nameVerified: true, addressOk: true, level10TagVerified: true });
});

test('an unreadable detail page is manual review, never a pass', () => {
  const r = verifyOpenedContact({ sheet: SHEET, detail: { name: '', phones: [], tags: [] }, level10Tag: TAG });
  assert.equal(r.status, L10_STATUS.MANUAL_REVIEW_REQUIRED);
  assert.equal(r.flags.phoneVerified, false);
});

test('the record phone must match even if the search row did', () => {
  const r = verifyOpenedContact({
    sheet: SHEET,
    detail: { ...DETAIL_OK, phones: ['510-000-9999'] },
    level10Tag: TAG,
  });
  assert.equal(r.status, L10_STATUS.MANUAL_REVIEW_REQUIRED);
});

test('the record name must match even if the search row did', () => {
  const r = verifyOpenedContact({ sheet: SHEET, detail: { ...DETAIL_OK, name: 'Linda Hunt' }, level10Tag: TAG });
  assert.equal(r.status, L10_STATUS.PHONE_MATCH_NAME_MISMATCH);
});

test('a missing Level 10 tag blocks verification and is never written', () => {
  const r = verifyOpenedContact({ sheet: SHEET, detail: { ...DETAIL_OK, tags: ['Hot Lead'] }, level10Tag: TAG });
  assert.equal(r.status, L10_STATUS.LEVEL_10_TAG_MISSING);
  assert.equal(r.flags.level10TagVerified, false);
});

test('a conflicting address on the record blocks verification', () => {
  const r = verifyOpenedContact({
    sheet: SHEET,
    detail: { ...DETAIL_OK, address: '999 Nowhere Rd, Bakersfield, CA' },
    level10Tag: TAG,
  });
  assert.equal(r.status, L10_STATUS.MANUAL_REVIEW_REQUIRED);
});

// ---------------------------------------------------------------------------
// REAL records from the live read-only run (5/5 phone searches succeeded).
// These are the actual sheet-vs-REI pairs, with REI's avatar initials stripped
// by the adapter. They lock in the decisions a human reviewed and agreed with.
// ---------------------------------------------------------------------------
const LIVE_ROWS = [
  {
    label: 'two owners on the REI record',
    sheet: { name: 'TONY LAM', phone: '916-607-2808', address: '2700 Humboldt Ave, Oakland, CA 94602' },
    rei: { name: 'Tony & Sukien Lam', phone: '(916) 607-2808', address: '2700 Humboldt Ave, Oakland, CA 94602' },
    expect: L10_STATUS.MANUAL_REVIEW_REQUIRED,
  },
  {
    label: 'same first name, different surname',
    sheet: { name: 'LINDA VANBROCKLIN', phone: '925-937-2580', address: '3451 Rhoda Ave, Oakland, CA 94602' },
    rei: { name: 'Linda Lew', phone: '(925) 937-2580', address: '3451 Rhoda Ave, Oakland, CA 94602' },
    expect: L10_STATUS.PHONE_MATCH_NAME_MISMATCH,
  },
  {
    label: 'exact match',
    sheet: { name: 'JAMES POTTS', phone: '510-206-1922', address: '3951 Whittle Ave, Oakland, CA 94602' },
    rei: { name: 'James Potts', phone: '(510) 206-1922', address: '3951 Whittle Ave, Oakland, CA 94602' },
    expect: L10_STATUS.CONTACT_VERIFIED,
  },
  {
    label: 'exact match',
    sheet: { name: 'JAMES FEHR', phone: '510-482-5020', address: '1959 Wrenn St, Oakland, CA 94602' },
    rei: { name: 'James Fehr', phone: '(510) 482-5020', address: '1959 Wrenn St, Oakland, CA 94602' },
    expect: L10_STATUS.CONTACT_VERIFIED,
  },
  {
    label: 'exact match',
    sheet: { name: 'LINDA HUNT', phone: '510-332-9764', address: '4516 Walnut St, Oakland, CA 94619' },
    rei: { name: 'Linda Hunt', phone: '(510) 332-9764', address: '4516 Walnut St, Oakland, CA 94619' },
    expect: L10_STATUS.CONTACT_VERIFIED,
  },
];

test('the five live records reach the reviewed decisions', () => {
  for (const [i, row] of LIVE_ROWS.entries()) {
    const d = chooseContact({
      sheet: row.sheet,
      candidates: [{ ...row.rei, contactId: `live-${i}`, rowReference: 0 }],
    });
    assert.equal(d.status, row.expect, `row ${i + 1} (${row.label}): got ${d.status} — ${d.reason}`);
  }
});

test("REI's avatar initials must never survive into a name comparison", () => {
  // If the adapter ever stops stripping "JP\n\n", this is what would happen —
  // an exact match downgraded to a possible different family member.
  const withAvatar = chooseContact({
    sheet: { name: 'JAMES POTTS', phone: '510-206-1922', address: '3951 Whittle Ave' },
    candidates: [{ name: 'JP\n\nJames Potts', phone: '(510) 206-1922', address: '3951 Whittle Ave', rowReference: 0 }],
  });
  assert.notEqual(withAvatar.status, L10_STATUS.CONTACT_VERIFIED, 'unstripped avatar text should not verify');

  const stripped = chooseContact({
    sheet: { name: 'JAMES POTTS', phone: '510-206-1922', address: '3951 Whittle Ave' },
    candidates: [{ name: 'James Potts', phone: '(510) 206-1922', address: '3951 Whittle Ave', rowReference: 0 }],
  });
  assert.equal(stripped.status, L10_STATUS.CONTACT_VERIFIED);
});

// ---------------------------------------------------------------------------
// The sheet offers several names per row and "Primary Name" can be wrong.
// Pilot finding: Owner said "Lew", Primary Name said "Vanbrocklin", REI said
// "Linda Lew" — the same person, failed by comparing one column only.
// ---------------------------------------------------------------------------
test('a row verifies when ANY of the sheet name columns matches REI', async () => {
  const { compareAnyName } = await import('../server/automation/contactMatch.js');
  const candidates = ['LINDA VANBROCKLIN', 'Lew, Linda', 'Linda Lew'];
  const r = compareAnyName(candidates, 'Linda Lew');
  assert.equal(r.result, NAME_RESULT.MATCH);
  assert.ok(['Lew, Linda', 'Linda Lew'].includes(r.matchedSheetName));

  const verified = chooseContact({
    sheet: {
      phone: '925-937-2580',
      name: 'LINDA VANBROCKLIN',
      nameCandidates: candidates,
      address: '3451 Rhoda Ave, Oakland, CA 94602',
    },
    candidates: [{ name: 'Linda Lew', phone: '(925) 937-2580', address: '3451 Rhoda Ave, Oakland, CA 94602', rowReference: 0 }],
  });
  assert.equal(verified.status, L10_STATUS.CONTACT_VERIFIED, verified.reason);
});

test('extra name columns never rescue a genuinely different person', async () => {
  const { compareAnyName } = await import('../server/automation/contactMatch.js');
  const r = compareAnyName(['JOHN SMITH', 'Smith, John', 'John Smith'], 'Michael Smith');
  assert.equal(r.result, NAME_RESULT.NO_MATCH);

  const blocked = chooseContact({
    sheet: { phone: '510-000-1111', name: 'JOHN SMITH', nameCandidates: ['JOHN SMITH', 'Smith, John'], address: '1 A St' },
    candidates: [{ name: 'Michael Smith', phone: '510-000-1111', address: '1 A St', rowReference: 0 }],
  });
  assert.equal(blocked.status, L10_STATUS.PHONE_MATCH_NAME_MISMATCH);
});

test('a multi-owner REI record still needs a human even with several sheet names', async () => {
  const { compareAnyName } = await import('../server/automation/contactMatch.js');
  const r = compareAnyName(['TONY LAM', 'Lam, Tony & Sukien'], 'Tony & Sukien Lam');
  assert.notEqual(r.result, NAME_RESULT.MATCH);
});
