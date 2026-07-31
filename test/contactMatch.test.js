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
