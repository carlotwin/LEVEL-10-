// =============================================================================
// DUPLICATE PREVENTION and READ-ONLY MODE.
//
// Both are proven against a real Engine with a spy adapter that records every
// call, because the only claim worth making is "the write method was never
// called", and that cannot be shown by testing a pure function.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { L10_STATUS } from '../server/automation/constants.js';

// Isolate the persistent ledger per test file so runs never collide.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'l10-ledger-'));

const SHEET_ROW = {
  contactId: 'ROW-1',
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

/** Records every adapter call; `opts.confirm=false` simulates an unconfirmed send. */
function spyAdapter(opts = {}) {
  const { confirm = true, sendOk = true, chatHistory = [] } = opts;
  const calls = [];
  const log = (n) => calls.push(n);
  return {
    calls,
    count: (n) => calls.filter((c) => c === n).length,
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
      return {
        status: L10_STATUS.ONE_CONTACT_FOUND,
        candidates: [
          { contactId: 'rei-1', name: 'Tony Lam', phone: '916-607-2808', address: '2700 Humboldt Ave', rowReference: 0 },
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
        tags: ['Level 10 Properties'],
        notes: '',
        chatHistory,
        optOut: false,
      };
    },
    async getSmsStatus() {
      log('getSmsStatus');
      return { smsEnabled: true, optedIn: true };
    },
    async optInAvailable() {
      log('optInAvailable');
      return true;
    },
    async optInPhone() {
      log('optInPhone'); // WRITE
      return { status: 'opted_in', smsEnabled: true };
    },
    async profitDialSelectorAvailable() {
      log('profitDialSelectorAvailable');
      return true;
    },
    async getProfitDialNumbers() {
      log('getProfitDialNumbers');
      return ['(510) 916-3995'];
    },
    async selectProfitDial(_id, number) {
      log('selectProfitDial'); // WRITE
      return { selected: true, readback: number };
    },
    async enterMessage() {
      log('enterMessage'); // WRITE
      return { entered: true };
    },
    async sendMessage() {
      log('sendMessage'); // WRITE — irreversible
      return { sent: sendOk, reason: sendOk ? '' : 'send button did nothing' };
    },
    async verifyMessageSent() {
      log('verifyMessageSent');
      return { verified: confirm, reason: confirm ? '' : 'message not found in thread' };
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

const WRITE_METHODS = ['optInPhone', 'selectProfitDial', 'enterMessage', 'sendMessage'];

/** Fresh Engine per run; `batch` shared between runs proves persistence. */
async function run({ batch, adapterOpts = {}, row = SHEET_ROW, freshEngine = true } = {}) {
  const { Engine } = await import('../server/automation/engine.js');
  const engine = new Engine();
  engine.config.campaignBatch = batch;
  const adapter = spyAdapter(adapterOpts);
  engine.loadJob({ contacts: [row], profitDialRows: PD_ROWS, profitDialCols: PD_COLS, source: 't', tab: 'With Contacts' });
  engine.adapter = adapter;
  const result = await engine._processContact(row);
  return { result, adapter, engine };
}

// ---------------------------------------------------------------------------
// 49–55: duplicate protection
// ---------------------------------------------------------------------------
test('49/50: the same row run twice sends once — and a restart does not re-send', async () => {
  const batch = `dup-${process.hrtime.bigint()}`;
  const first = await run({ batch });
  assert.equal(first.result.L10_Status, L10_STATUS.SMS_SENT, first.result.L10_Reason);
  assert.equal(first.adapter.count('sendMessage'), 1);

  // A brand-new Engine reads the persisted ledger — this is the restart case.
  const second = await run({ batch });
  assert.equal(second.adapter.count('sendMessage'), 0, 'A SECOND SMS WAS SENT');
  assert.equal(second.adapter.count('enterMessage'), 0);
  assert.equal(second.result.L10_Status, L10_STATUS.ALREADY_PROCESSED);
  assert.equal(second.result.L10_Disposition, 'Already Processed');
});

test('51: a second spreadsheet row resolving to the same phone does not send again', async () => {
  const batch = `dup-phone-${process.hrtime.bigint()}`;
  await run({ batch });
  // Different row id, same homeowner phone -> same REI contact.
  const other = { ...SHEET_ROW, contactId: 'ROW-2' };
  const second = await run({ batch, row: other });
  assert.equal(second.adapter.count('sendMessage'), 0, 'duplicate phone was texted twice');
  assert.equal(second.result.L10_Status, L10_STATUS.ALREADY_PROCESSED);
});

test('48/52: a prior Level 10 message in the REI thread blocks another template', async () => {
  const batch = `dup-thread-${process.hrtime.bigint()}`;
  const r = await run({
    batch,
    adapterOpts: {
      chatHistory: ["Hi Tony, it's Juan with Twin Home Buyer. We sent a few postcards about 2700 Humboldt Ave..."],
    },
  });
  assert.equal(r.adapter.count('sendMessage'), 0);
  assert.equal(r.result.L10_Status, L10_STATUS.ALREADY_PROCESSED);
});

test('53: a send that could not be confirmed is never retried automatically', async () => {
  const batch = `uncertain-${process.hrtime.bigint()}`;
  const first = await run({ batch, adapterOpts: { confirm: false } });
  assert.equal(first.adapter.count('sendMessage'), 1);
  assert.equal(first.result.L10_Status, L10_STATUS.SMS_SEND_FAILED);
  assert.match(first.result.L10_Reason, /UNCERTAIN/);

  const second = await run({ batch });
  assert.equal(second.adapter.count('sendMessage'), 0, 'an unconfirmed send was retried — possible double text');
  assert.equal(second.result.L10_Status, L10_STATUS.ALREADY_PROCESSED);
});

test('54: a clean failure BEFORE delivery may be retried safely', async () => {
  const batch = `clean-fail-${process.hrtime.bigint()}`;
  const first = await run({ batch, adapterOpts: { sendOk: false } });
  assert.equal(first.result.L10_Status, L10_STATUS.SMS_SEND_FAILED);

  const second = await run({ batch });
  assert.equal(second.adapter.count('sendMessage'), 1, 'a clean pre-send failure must be retryable');
  assert.equal(second.result.L10_Status, L10_STATUS.SMS_SENT);
});

test('46/47: only a CONFIRMED send consumes a template', async () => {
  const { SentLedger } = await import('../server/data/sentLedger.js');
  const ledger = new SentLedger();
  const batch = `counts-${process.hrtime.bigint()}`;
  const base = { campaignBatch: batch, phone: '916-607-2808', templateId: 'LEVEL10_TEMPLATE_1' };
  ledger.record({ ...base, reiContactId: 'a', state: 'blocked', sendVerified: false });
  ledger.record({ ...base, reiContactId: 'b', state: 'pending', sendVerified: false });
  ledger.record({ ...base, reiContactId: 'c', state: 'uncertain', sendVerified: false });
  assert.deepEqual(ledger.templateUsage(batch), {}, 'unconfirmed records must not consume a template');

  ledger.record({ ...base, reiContactId: 'd', state: 'sent', sendVerified: true });
  assert.deepEqual(ledger.templateUsage(batch), { LEVEL10_TEMPLATE_1: 1 });
});

// ---------------------------------------------------------------------------
// 72–79: read-only mode
// ---------------------------------------------------------------------------
test('72–78: read-only mode performs NO write action of any kind', async () => {
  {
    const { Engine } = await import('../server/automation/engine.js');
    const engine = new Engine();
    engine.config.readOnly = true; // WATCH_ONLY / READ_ONLY_MODE
    engine.config.campaignBatch = `readonly-${process.hrtime.bigint()}`;
    const adapter = spyAdapter();
    engine.loadJob({
      contacts: [SHEET_ROW],
      profitDialRows: PD_ROWS,
      profitDialCols: PD_COLS,
      source: 't',
      tab: 'With Contacts',
    });
    engine.adapter = adapter;
    const result = await engine._processContact(SHEET_ROW);

    for (const m of WRITE_METHODS) {
      assert.equal(adapter.count(m), 0, `read-only mode called the write method ${m}`);
    }
    // Reads are expected and fine.
    assert.ok(adapter.count('findContact') > 0);
    assert.ok(adapter.count('readContactFacts') > 0);
    assert.notEqual(result.L10_Status, L10_STATUS.SMS_SENT);
  }
});

test('read-only mode writes no successful ledger entry and consumes no template', async () => {
  const batch = `readonly-ledger-${process.hrtime.bigint()}`;
  {
    const { Engine } = await import('../server/automation/engine.js');
    const engine = new Engine();
    engine.config.readOnly = true;
    engine.config.campaignBatch = batch;
    engine.loadJob({ contacts: [SHEET_ROW], profitDialRows: PD_ROWS, profitDialCols: PD_COLS, source: 't', tab: 'With Contacts' });
    engine.adapter = spyAdapter();
    await engine._processContact(SHEET_ROW);
    assert.deepEqual(engine.ledger.templateUsage(batch), {}, 'a read-only run consumed a template');
    assert.equal(engine.ledger.isSendBlocked(batch, SHEET_ROW.contactId, SHEET_ROW.phones[0]), null);
  }
});

// 79. Live sending disabled by default
test('79: live sending is disabled by default', async () => {
  const { env } = await import('../server/config/env.js');
  // With no env set, the defaults must be safe.
  assert.equal(env.ALLOW_LIVE_SEND, false, 'ALLOW_LIVE_SEND must default to false');
  assert.equal(env.SANDBOX, true, 'SANDBOX must default to true');
  // And the mandatory verifications are not configurable.
  assert.equal(env.REQUIRE_OPTIN, true);
  assert.equal(env.REQUIRE_PROFITDIAL, true);
  assert.equal(env.REQUIRE_LEVEL10_TAG, true);
});

// ---------------------------------------------------------------------------
// UNDELIVERED — the pilot saw 2 of 3 real sends come back Undelivered, and REI
// resolves that asynchronously. It must block a resend but not consume a template.
// ---------------------------------------------------------------------------
test('an undelivered send blocks a resend but does not consume a template', async () => {
  const { SentLedger } = await import('../server/data/sentLedger.js');
  const ledger = new SentLedger();
  const batch = `undelivered-${process.hrtime.bigint()}`;
  ledger.record({
    campaignBatch: batch,
    reiContactId: 'rei-9',
    phone: '510-206-1922',
    templateId: 'LEVEL10_TEMPLATE_2',
    sendVerified: true,
    state: 'sent',
    delivery: 'undelivered',
  });
  // Not a template use...
  assert.deepEqual(ledger.templateUsage(batch), {}, 'undelivered must not count toward rotation');
  assert.equal(ledger.lastTemplateId(batch), null);
  // ...but the message left our side, so never send again.
  const blocked = ledger.isSendBlockedByPhone(batch, '(510) 206-1922');
  assert.ok(blocked, 'an undelivered send must still block a resend');
  assert.match(blocked.reason, /already sent/i);
});

test('a delivered send does consume a template', async () => {
  const { SentLedger } = await import('../server/data/sentLedger.js');
  const ledger = new SentLedger();
  const batch = `delivered-${process.hrtime.bigint()}`;
  ledger.record({
    campaignBatch: batch,
    reiContactId: 'rei-10',
    phone: '510-332-9764',
    templateId: 'LEVEL10_TEMPLATE_4',
    sendVerified: true,
    state: 'sent',
    delivery: 'delivered',
  });
  assert.deepEqual(ledger.templateUsage(batch), { LEVEL10_TEMPLATE_4: 1 });
});
