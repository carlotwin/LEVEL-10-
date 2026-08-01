import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sop from '../server/automation/sop.js';
import { DISPOSITION, REPLY_CLASS } from '../server/automation/constants.js';

const config = { level10Tag: 'Level 10 Properties', textStates: ['CA', 'CALIFORNIA'] };
const okFacts = () => ({
  found: true,
  hasLevel10Tag: true,
  state: 'CA',
  tags: ['Level 10 Properties'],
  notes: '',
  chatHistory: [],
  phones: ['510-555-0101'],
  optOut: false,
});

test('normalizePhone keeps last 10 digits', () => {
  assert.equal(sop.normalizePhone('+1 (510) 555-0101'), '5105550101');
  assert.equal(sop.normalizePhone('12345'), '12345');
});

test('eligibility passes a clean contact', () => {
  assert.deepEqual(sop.checkEligibility(okFacts(), config), { ok: true });
});

test('eligibility blocks: not found', () => {
  const r = sop.checkEligibility({ ...okFacts(), found: false }, config);
  assert.equal(r.disposition, DISPOSITION.LEAD_NOT_FOUND);
});

test('eligibility blocks: missing tag', () => {
  const r = sop.checkEligibility({ ...okFacts(), hasLevel10Tag: false }, config);
  assert.equal(r.disposition, DISPOSITION.MISSING_TAG);
});

test('eligibility blocks: out of state', () => {
  const r = sop.checkEligibility({ ...okFacts(), state: 'TX' }, config);
  assert.equal(r.disposition, DISPOSITION.OUT_OF_STATE);
});

test('eligibility blocks: opt-out flag and STOP in history', () => {
  assert.equal(sop.checkEligibility({ ...okFacts(), optOut: true }, config).disposition, DISPOSITION.OPTED_OUT);
  assert.equal(sop.checkEligibility({ ...okFacts(), chatHistory: ['Homeowner: STOP'] }, config).disposition, DISPOSITION.OPTED_OUT);
});

test('eligibility blocks: do-not-contact note', () => {
  const r = sop.checkEligibility({ ...okFacts(), notes: 'do not contact' }, config);
  assert.equal(r.disposition, DISPOSITION.DO_NOT_CONTACT);
});

test('eligibility blocks: invalid + multiple phones', () => {
  assert.equal(sop.checkEligibility({ ...okFacts(), phones: ['12345'] }, config).disposition, DISPOSITION.INVALID_PHONE);
  assert.equal(sop.checkEligibility({ ...okFacts(), phones: ['5105550101', '5105557777'] }, config).disposition, DISPOSITION.MULTIPLE_PHONES);
});

test('name safety: pure company/trust entities with no individual owner still block', () => {
  assert.equal(sop.checkNameSafety({ name: 'Smith Family Trust' }).disposition, DISPOSITION.NEEDS_REVIEW);
  assert.equal(sop.checkNameSafety({ name: 'Acme LLC' }).disposition, DISPOSITION.NEEDS_REVIEW);
  assert.equal(sop.checkNameSafety({ name: '', firstName: '' }).disposition, DISPOSITION.NEEDS_REVIEW);
  assert.deepEqual(sop.checkNameSafety({ name: 'Maria Lopez', firstName: 'Maria' }), { ok: true });
});

test('name safety: joint owners and personal trusts pass using only the first-listed individual', () => {
  assert.deepEqual(sop.checkNameSafety({ name: 'Tony & Sukien Lam' }), { ok: true });
  assert.deepEqual(sop.checkNameSafety({ name: 'ALMODOVAR, SERGIO E & ELIZABETH V' }), { ok: true });
  assert.deepEqual(sop.checkNameSafety({ name: 'BANK, DAVID M TR & CHAVEZ, CESAR D TR' }), { ok: true });
});

test('deriveFirstName: only the first-listed individual, never a last name or company', () => {
  assert.equal(sop.deriveFirstName('Tony & Sukien Lam').firstName, 'Tony');
  assert.equal(sop.deriveFirstName('Tony and Sukien').firstName, 'Tony');
  assert.equal(sop.deriveFirstName('John / Mary Smith').firstName, 'John');
  assert.equal(sop.deriveFirstName('ALMODOVAR, SERGIO E & ELIZABETH V').firstName, 'Sergio');
  assert.equal(sop.deriveFirstName('BANK, DAVID M TR & CHAVEZ, CESAR D TR').firstName, 'David');
  assert.equal(sop.deriveFirstName('LEE,ROBERT W').firstName, 'Robert');
  assert.equal(sop.deriveFirstName('Smith Family Trust').ok, false);
  assert.equal(sop.deriveFirstName('Acme LLC').ok, false);
  assert.equal(sop.deriveFirstName('').ok, false);
});

test('already-processed ledger hit blocks', () => {
  assert.equal(sop.checkAlreadyProcessed(true).disposition, DISPOSITION.ALREADY_PROCESSED);
  assert.deepEqual(sop.checkAlreadyProcessed(false), { ok: true });
});

test('opt-in gate', () => {
  assert.deepEqual(sop.checkOptIn({ status: 'opted_in', smsEnabled: true }), { ok: true });
  assert.equal(sop.checkOptIn({ status: 'failed', smsEnabled: false }).disposition, DISPOSITION.OPT_IN_FAILED);
});

test('opt-in gate: REI "Phone Opted-Out" is a permanent stop, not a retryable failure', () => {
  const r = sop.checkOptIn({ status: 'opted_out', smsEnabled: false, reason: 'Phone shows "Phone Opted-Out"' });
  assert.equal(r.disposition, DISPOSITION.OPTED_OUT);
});

test('eligibility blocks: STOP found only in the REI Activities tab history', () => {
  const r = sop.checkEligibility({ ...okFacts(), activityLog: ['Homeowner replied STOP via SMS'] }, config);
  assert.equal(r.disposition, DISPOSITION.OPTED_OUT);
});

test('profitdial gate: fail-closed on every non-ok status', () => {
  const base = { availableNumbers: ['(510) 916-3995'], selectedReadback: '5109163995' };
  assert.equal(sop.checkProfitDial({ ...base, match: { status: 'not_found' } }).disposition, DISPOSITION.NEEDS_REVIEW);
  assert.equal(sop.checkProfitDial({ ...base, match: { status: 'multiple_records', recordCount: 2 } }).disposition, DISPOSITION.NEEDS_REVIEW);
  assert.equal(sop.checkProfitDial({ ...base, match: { status: 'missing' } }).disposition, DISPOSITION.MISSING_PROFITDIAL);
  assert.equal(sop.checkProfitDial({ ...base, match: { status: 'multiple_assignments' } }).disposition, DISPOSITION.MULTIPLE_PROFITDIAL);
});

test('profitDialMatchBlock reports the REAL reason per status, not a generic catch-all', () => {
  // Regression test: the engine's pre-flight (file-only) check used to always
  // report DISPOSITION.MISSING_PROFITDIAL regardless of the actual match
  // status, which hid duplicate-row/multiple-assignment problems behind a
  // misleading "No ProfitDial assigned" label.
  const dup = sop.profitDialMatchBlock({ status: 'multiple_records', recordCount: 2 });
  assert.equal(dup.disposition, DISPOSITION.NEEDS_REVIEW);
  assert.match(dup.reason, /duplicate rows/i);

  assert.equal(sop.profitDialMatchBlock({ status: 'missing' }).disposition, DISPOSITION.MISSING_PROFITDIAL);
  assert.equal(sop.profitDialMatchBlock({ status: 'multiple_assignments' }).disposition, DISPOSITION.MULTIPLE_PROFITDIAL);
  assert.equal(sop.profitDialMatchBlock({ status: 'not_found' }).disposition, DISPOSITION.NEEDS_REVIEW);
  assert.equal(sop.profitDialMatchBlock({ status: 'conflict', reason: 'address mismatch' }).disposition, DISPOSITION.SHEET_CONFLICT);
});

test('profitdial gate: unavailable in REI', () => {
  const r = sop.checkProfitDial({
    match: { status: 'ok', profitDial: '(925) 515-2335' },
    availableNumbers: ['(510) 916-3995'],
    selectedReadback: '9255152335',
  });
  assert.equal(r.disposition, DISPOSITION.PROFITDIAL_UNAVAILABLE);
});

test('profitdial gate: readback must match digit-for-digit', () => {
  const r = sop.checkProfitDial({
    match: { status: 'ok', profitDial: '(510) 916-3995' },
    availableNumbers: ['(510) 916-3995'],
    selectedReadback: '9255152335',
  });
  assert.equal(r.disposition, DISPOSITION.PROFITDIAL_MISMATCH);
});

test('profitdial gate: passes only on exact match + readback', () => {
  const r = sop.checkProfitDial({
    match: { status: 'ok', profitDial: '(510) 916-3995' },
    availableNumbers: ['(510) 916-3995', '(925) 515-2335'],
    selectedReadback: '(510) 916-3995',
  });
  assert.deepEqual(r, { ok: true });
});

test('rendered-message gate rejects unfilled merge field', () => {
  assert.equal(sop.checkRenderedMessage('Hi {{first_name}}', { id: 'X' }).disposition, DISPOSITION.INVALID_MERGE_FIELD);
  assert.deepEqual(sop.checkRenderedMessage('Hi Maria', { id: 'X' }), { ok: true });
});

test('send verification gate', () => {
  assert.deepEqual(sop.checkSendVerification({ verified: true }), { ok: true });
  assert.equal(sop.checkSendVerification({ verified: false }).disposition, DISPOSITION.SEND_VERIFY_FAILED);
});

test('reply classification', () => {
  assert.equal(sop.classifyReply('Yes how much?'), REPLY_CLASS.POSITIVE);
  assert.equal(sop.classifyReply('No, not interested.'), REPLY_CLASS.NEGATIVE);
  assert.equal(sop.classifyReply('Who is this?'), REPLY_CLASS.UNCLEAR);
  assert.equal(sop.classifyReply('STOP'), REPLY_CLASS.OPT_OUT);
  assert.equal(sop.classifyReply(''), REPLY_CLASS.NONE);
});
