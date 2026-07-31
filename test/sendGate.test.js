// =============================================================================
// PRODUCTION SAFETY GATE tests.
//
// Two layers are proven here:
//   1. checkSendGates() — the pure rule: every gate must be exactly `true`.
//   2. The ENGINE — with a spy adapter that records every call, so we can assert
//      that enterMessage/sendMessage are NEVER reached when a gate is false.
//      A rule that is correct but not wired to the send path proves nothing.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSendGates, SEND_GATES } from '../server/automation/contactMatch.js';
import { L10_STATUS } from '../server/automation/constants.js';

const ALL_TRUE = () => ({
  contactVerified: true,
  fullContactVerified: true,
  level10TagVerified: true,
  safetyReviewPassed: true,
  smsOptInVerified: true,
  profitDialVerified: true,
  approvedTemplateVerified: true,
  duplicateCheckPassed: true,
  liveSendingEnabled: true,
});

test('all nine gates true => send allowed', () => {
  const r = checkSendGates(ALL_TRUE());
  assert.equal(r.allowed, true);
  assert.deepEqual(r.failed, []);
});

test('each of the nine gates set false in turn blocks the send', () => {
  for (const gate of SEND_GATES) {
    const gates = { ...ALL_TRUE(), [gate]: false };
    const r = checkSendGates(gates);
    assert.equal(r.allowed, false, `${gate}=false must block`);
    assert.deepEqual(r.failed, [gate]);
    assert.match(r.reason, new RegExp(gate));
  }
});

test('a gate that is missing, undefined, null or merely truthy blocks the send', () => {
  for (const gate of SEND_GATES) {
    for (const bad of [undefined, null, 0, '', 'true', 1, {}, 'yes']) {
      const gates = { ...ALL_TRUE(), [gate]: bad };
      assert.equal(
        checkSendGates(gates).allowed,
        false,
        `${gate}=${JSON.stringify(bad)} must block — only the boolean true passes`
      );
    }
    const missing = ALL_TRUE();
    delete missing[gate];
    assert.equal(checkSendGates(missing).allowed, false, `${gate} missing must block`);
  }
});

test('an empty or absent gate object blocks the send', () => {
  assert.equal(checkSendGates({}).allowed, false);
  assert.equal(checkSendGates(undefined).allowed, false);
  assert.equal(checkSendGates(null).allowed, false);
  assert.equal(checkSendGates({}).failed.length, SEND_GATES.length);
});

// ---------------------------------------------------------------------------
// End-to-end through the engine with a spy adapter.
// ---------------------------------------------------------------------------

const SHEET_ROW = {
  contactId: 'L10-1',
  syntheticId: true,
  name: 'TONY LAM',
  firstName: 'TONY',
  address: '2700 Humboldt Ave, Oakland, CA 94602',
  phones: ['916-607-2808'],
};

const PD_ROWS = [
  {
    'Primary Name': 'TONY LAM',
    'Full Address': '2700 Humboldt Ave, Oakland, CA 94602',
    'Primary Phone': '916-607-2808',
    'Profit Dial': '(510) 916-3995',
  },
];
const PD_COLS = { name: 'Primary Name', address: 'Full Address', phone: 'Primary Phone', profitDial: 'Profit Dial', contactId: '' };

/**
 * A fully cooperative adapter that records every call. `break_` names the single
 * step that should fail, which is how each gate is driven false in turn.
 */
function spyAdapter(break_ = null) {
  const calls = [];
  const log = (name) => calls.push(name);
  return {
    calls,
    get name() {
      return 'spy';
    },
    get isSandbox() {
      return true;
    },
    async init() {},
    async close() {},
    async findContact() {
      log('findContact');
      if (break_ === 'contactVerified') return { status: L10_STATUS.NO_CONTACT_FOUND_BY_PHONE, candidates: [], searched: [] };
      return {
        status: L10_STATUS.ONE_CONTACT_FOUND,
        candidates: [
          { ref: 0, contactId: 'rei-1', name: 'Tony Lam', address: '2700 Humboldt Ave', phone: '916-607-2808' },
        ],
        searched: ['phone:"9166072808"→1 row(s)'],
      };
    },
    async openContact() {
      log('openContact');
      return { opened: true, contactId: 'rei-1' };
    },
    async readContactFacts() {
      log('readContactFacts');
      return {
        found: true,
        contactId: 'rei-1',
        name: 'Tony Lam',
        firstName: 'Tony',
        address: '2700 Humboldt Ave, Oakland, CA 94602',
        state: 'CA',
        phones: ['916-607-2808'],
        // level10TagVerified is driven by whether the tag is on the record.
        tags: break_ === 'level10TagVerified' ? ['Some Other Tag'] : ['Level 10 Properties'],
        // safetyReviewPassed is driven by the suppression scan.
        notes: break_ === 'safetyReviewPassed' ? 'do not contact' : '',
        chatHistory: [],
        optOut: false,
      };
    },
    async getSmsStatus() {
      log('getSmsStatus');
      return { smsEnabled: break_ !== 'smsOptInVerified', optedIn: break_ !== 'smsOptInVerified' };
    },
    async optInAvailable() {
      log('optInAvailable');
      return break_ !== 'smsOptInVerified';
    },
    async optInPhone() {
      log('optInPhone');
      return { status: 'opted_in', smsEnabled: true };
    },
    async profitDialSelectorAvailable() {
      log('profitDialSelectorAvailable');
      return break_ !== 'profitDialVerified';
    },
    async getProfitDialNumbers() {
      log('getProfitDialNumbers');
      return ['(510) 916-3995'];
    },
    async selectProfitDial(_id, number) {
      log('selectProfitDial');
      return { selected: true, readback: number };
    },
    async enterMessage() {
      log('enterMessage'); // MUST NOT happen when a gate is false
      return { entered: true };
    },
    async sendMessage() {
      log('sendMessage'); // MUST NOT happen when a gate is false
      return { sent: true };
    },
    async verifyMessageSent() {
      log('verifyMessageSent');
      return { verified: true };
    },
    async readDeliveryStatus() {
      return { delivery: 'delivered' };
    },
    async readReplies() {
      return { text: '' };
    },
    async listContacts() {
      return ['rei-1'];
    },
  };
}

/** Run one contact through a real Engine using the spy adapter. */
async function runWithSpy(break_) {
  const { Engine } = await import('../server/automation/engine.js');
  const engine = new Engine();
  const adapter = spyAdapter(break_);
  engine.config.campaignBatch = `gate-test-${break_ || 'none'}-${process.hrtime.bigint()}`;
  engine.loadJob({
    contacts: [SHEET_ROW],
    profitDialRows: PD_ROWS,
    profitDialCols: PD_COLS,
    source: 'gate-test',
    tab: 'With Contacts',
  });
  engine.adapter = adapter;
  engine.pdIndex = engine.pdIndex; // built by loadJob
  const result = await engine._processContact(SHEET_ROW);
  return { result, calls: adapter.calls };
}

test('engine: with every gate satisfied the send path IS reached', async () => {
  const { result, calls } = await runWithSpy(null);
  assert.ok(calls.includes('enterMessage'), `expected a send; got ${result.L10_Status}: ${result.L10_Reason}`);
  assert.ok(calls.includes('sendMessage'));
  assert.equal(result.L10_Status, L10_STATUS.SMS_SENT);
});

test('engine: each failing gate prevents enterMessage AND sendMessage', async () => {
  const cases = [
    ['contactVerified', L10_STATUS.NO_CONTACT_FOUND_BY_PHONE],
    ['level10TagVerified', L10_STATUS.LEVEL_10_TAG_MISSING],
    ['safetyReviewPassed', L10_STATUS.SAFETY_REVIEW_FAILED],
    ['smsOptInVerified', L10_STATUS.OPT_IN_REQUIRED],
    ['profitDialVerified', L10_STATUS.PROFITDIAL_NOT_VERIFIED],
  ];
  for (const [gate, expectedStatus] of cases) {
    const { result, calls } = await runWithSpy(gate);
    assert.equal(
      calls.includes('enterMessage'),
      false,
      `${gate}=false: enterMessage was called — a message was typed into REI`
    );
    assert.equal(
      calls.includes('sendMessage'),
      false,
      `${gate}=false: sendMessage was called — AN SMS WOULD HAVE BEEN SENT`
    );
    assert.equal(result.L10_Status, expectedStatus, `${gate}=false should report ${expectedStatus}`);
    assert.equal(result.L10_SendVerified, false);
  }
});

test('engine: a lead whose phone is not in REI never reaches the send path', async () => {
  const { result, calls } = await runWithSpy('contactVerified');
  assert.equal(calls.includes('sendMessage'), false);
  assert.equal(calls.includes('openContact'), false, 'nothing is opened when the phone finds nobody');
  assert.equal(result.L10_Status, L10_STATUS.NO_CONTACT_FOUND_BY_PHONE);
});
