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

test('already-processed ledger hit blocks', () => {
  assert.equal(sop.checkAlreadyProcessed(true).disposition, DISPOSITION.ALREADY_PROCESSED);
  assert.deepEqual(sop.checkAlreadyProcessed(false), { ok: true });
});

test('opt-in gate', () => {
  assert.deepEqual(sop.checkOptIn({ status: 'opted_in', smsEnabled: true }), { ok: true });
  assert.equal(sop.checkOptIn({ status: 'failed', smsEnabled: false }).disposition, DISPOSITION.OPT_IN_FAILED);
});

test('profitdial gate: fail-closed on every non-ok status', () => {
  const base = { availableNumbers: ['(510) 916-3995'], selectedReadback: '5109163995' };
  assert.equal(sop.checkProfitDial({ ...base, match: { status: 'not_found' } }).disposition, DISPOSITION.NEEDS_REVIEW);
  assert.equal(sop.checkProfitDial({ ...base, match: { status: 'multiple_records', recordCount: 2 } }).disposition, DISPOSITION.NEEDS_REVIEW);
  assert.equal(sop.checkProfitDial({ ...base, match: { status: 'missing' } }).disposition, DISPOSITION.MISSING_PROFITDIAL);
  assert.equal(sop.checkProfitDial({ ...base, match: { status: 'multiple_assignments' } }).disposition, DISPOSITION.MULTIPLE_PROFITDIAL);
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

// --- outbound opt-out instruction must not suppress the contact ------------
test('our own "Reply STOP to opt out." in the thread does not mark the contact opted out', () => {
  const facts = {
    found: true,
    tags: ['Level 10 Properties'],
    state: 'CA',
    notes: '',
    chatHistory: [
      "Hi Maria, it's Juan with Twin Home Buyer. We sent a few postcards about 100 Alpha St, Oakland, CA 94601 but never connected. Should I keep following up, or have your plans changed? Reply STOP to opt out.",
    ],
    phones: ['510-555-0100'],
  };
  const r = sop.checkEligibility(facts, { level10Tag: 'Level 10 Properties', textStates: ['CA'] });
  assert.equal(r.ok, true, r.reason);
});

test('a real STOP reply still blocks, even alongside our instruction line', () => {
  const base = {
    found: true,
    tags: ['Level 10 Properties'],
    state: 'CA',
    notes: '',
    phones: ['510-555-0100'],
  };
  const cfg = { level10Tag: 'Level 10 Properties', textStates: ['CA'] };

  const bare = sop.checkEligibility({ ...base, chatHistory: ['STOP'] }, cfg);
  assert.equal(bare.ok, false);
  assert.equal(bare.disposition, DISPOSITION.OPTED_OUT);

  const both = sop.checkEligibility(
    { ...base, chatHistory: ['... Reply STOP to opt out.', 'stop texting me'] },
    cfg
  );
  assert.equal(both.ok, false);
  assert.equal(both.disposition, DISPOSITION.OPTED_OUT);

  const unsub = sop.checkEligibility({ ...base, chatHistory: ['Reply STOP to opt out.', 'unsubscribe'] }, cfg);
  assert.equal(unsub.ok, false);
  assert.equal(unsub.disposition, DISPOSITION.OPTED_OUT);
});

// --- the sheet as the Level 10 list ---------------------------------------
test('requireLevel10Tag:false trusts the sheet when REI shows no tag chips', () => {
  const facts = { ...okFacts(), hasLevel10Tag: false, tags: [] };
  // Default (required) still blocks — the tag is the SOP gate.
  const strict = sop.checkEligibility(facts, config);
  assert.equal(strict.ok, false);
  assert.equal(strict.disposition, DISPOSITION.MISSING_TAG);
  // Off: the uploaded sheet IS the tag-filtered list, so the lead continues.
  const relaxed = sop.checkEligibility(facts, { ...config, requireLevel10Tag: false });
  assert.equal(relaxed.ok, true, relaxed.reason);
});

test('turning the tag check off does not weaken any other gate', () => {
  const cfg = { ...config, requireLevel10Tag: false };
  const optedOut = sop.checkEligibility({ ...okFacts(), tags: [], chatHistory: ['STOP'] }, cfg);
  assert.equal(optedOut.disposition, DISPOSITION.OPTED_OUT);
  const dnc = sop.checkEligibility({ ...okFacts(), tags: [], notes: 'do not contact' }, cfg);
  assert.equal(dnc.disposition, DISPOSITION.DO_NOT_CONTACT);
  const badPhone = sop.checkEligibility({ ...okFacts(), tags: [], phones: ['555'] }, cfg);
  assert.equal(badPhone.disposition, DISPOSITION.INVALID_PHONE);
  const outState = sop.checkEligibility({ ...okFacts(), tags: [], state: 'TX' }, cfg);
  assert.equal(outState.disposition, DISPOSITION.OUT_OF_STATE);
});
