// =============================================================================
// The spreadsheet's own Send Status column is the only record of texts already
// sent by hand (Jonathan, Thea) or by earlier runs — the duplicate ledger knows
// nothing about them. Every wording below is taken VERBATIM from the real
// Level 10 sheet (345 rows), typos included. If this file goes red, processing
// the whole sheet would re-text somebody who was already texted.
// =============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySheetStatus, summarizeSheetStatus } from '../server/automation/sheetStatus.js';
import { DISPOSITION, L10_STATUS } from '../server/automation/constants.js';

// The exact strings found in the uploaded file, with how many rows carried them.
const REAL_STATUSES = [
  ['SMS SENT AND CONFIRMED', DISPOSITION.ALREADY_PROCESSED],
  ['Text was sent 7.31.26 by Jonathan', DISPOSITION.ALREADY_PROCESSED],
  ['Text was sent by Thea - 8.1.26', DISPOSITION.ALREADY_PROCESSED],
  ['Text was sentby Thea - 8.1.26', DISPOSITION.ALREADY_PROCESSED], // typo in sheet
  ['Text was sent by Thea', DISPOSITION.ALREADY_PROCESSED],
  ['UNDELIVERED', DISPOSITION.UNDELIVERED],
  ['UNDELIVERED\tTemplate 2 used—carrier reported undelivered.', DISPOSITION.UNDELIVERED],
  ["Lead's number is a landline - cannot send message", DISPOSITION.INVALID_PHONE],
  ["Lead's number is a landline", DISPOSITION.INVALID_PHONE],
  ['No longer in service', DISPOSITION.INVALID_PHONE],
  ['Replied STOP and Opted out', DISPOSITION.OPTED_OUT],
  ['SAFETY REVIEW FAILED', DISPOSITION.NEEDS_REVIEW],
  ['Processing', DISPOSITION.NEEDS_REVIEW],
];

test('every Send Status wording in the real sheet stops the row', () => {
  for (const [status, expected] of REAL_STATUSES) {
    const d = classifySheetStatus(status, '');
    assert.equal(d.process, false, `"${status}" must not be processed`);
    assert.equal(d.disposition, expected, `"${status}" -> ${expected}`);
    assert.ok(d.reason, 'a skipped row must say why');
  }
});

test('a blank Send Status is open work', () => {
  for (const blank of ['', '   ', null, undefined]) {
    assert.equal(classifySheetStatus(blank, '').process, true);
  }
});

test('an opt-out beats every other wording on the same row', () => {
  // A row that was texted AND replied STOP must read as opted out, not "sent".
  const d = classifySheetStatus('Text was sent by Thea', 'Template 3 used. Seller responded "stop" (510)');
  assert.equal(d.process, false);
  assert.equal(d.disposition, DISPOSITION.OPTED_OUT);
});

test('DO NOT SEND in Notes stops the row even when Send Status is blank', () => {
  const d = classifySheetStatus('', 'DO NOT SEND—REI contact tagged "Not Interested"');
  assert.equal(d.process, false);
  assert.equal(d.disposition, DISPOSITION.DO_NOT_CONTACT);
});

test('an ordinary note on an unworked row does NOT skip it', () => {
  // Notes only carry hard stops. "Template 3 used" with no status is not proof
  // of a send — skipping on it would silently shrink the worklist.
  assert.equal(classifySheetStatus('', 'Template 3 used.').process, true);
  assert.equal(classifySheetStatus('', 'Owner prefers mornings').process, true);
});

test('an undelivered send is never retried', () => {
  // Same rule as the ledger: the message left our side. A carrier failure is not
  // permission to fire another one at the same number.
  const d = classifySheetStatus('UNDELIVERED', 'Template 5 used—carrier reported undelivered.');
  assert.equal(d.process, false);
  assert.equal(d.status, L10_STATUS.ALREADY_PROCESSED);
});

test('FAIL CLOSED: an unrecognised status is manual review, not a send', () => {
  for (const weird of ['???', 'Jonathan will handle', 'follow up next week', 'xyz']) {
    const d = classifySheetStatus(weird, '');
    assert.equal(d.process, false, `"${weird}" must not be sendable`);
    assert.equal(d.disposition, DISPOSITION.NEEDS_REVIEW);
    assert.equal(d.status, L10_STATUS.MANUAL_REVIEW_REQUIRED);
    assert.match(d.reason, /not a recognised wording/i);
  }
});

test('summarizeSheetStatus counts open vs already handled', () => {
  const rows = [
    { 'Send Status': '', Notes: '' },
    { 'Send Status': '', Notes: '' },
    { 'Send Status': 'SMS SENT AND CONFIRMED', Notes: '' },
    { 'Send Status': 'UNDELIVERED', Notes: '' },
    { 'Send Status': "Lead's number is a landline", Notes: '' },
    { 'Send Status': 'Replied STOP and Opted out', Notes: '' },
  ];
  const s = summarizeSheetStatus(rows);
  assert.equal(s.total, 6);
  assert.equal(s.open, 2);
  assert.equal(s.skipped, 4);
  assert.equal(s.byDisposition[DISPOSITION.ALREADY_PROCESSED], 1);
  assert.equal(s.byDisposition[DISPOSITION.UNDELIVERED], 1);
  assert.equal(s.byDisposition[DISPOSITION.INVALID_PHONE], 1);
  assert.equal(s.byDisposition[DISPOSITION.OPTED_OUT], 1);
});

// ---------------------------------------------------------------------------
// The engine must honour the decision BEFORE it touches REI.
// ---------------------------------------------------------------------------
test('the engine skips a pre-worked row without opening REI', async () => {
  const { Engine } = await import('../server/automation/engine.js');
  const engine = new Engine();
  let searched = 0;
  engine.adapter = {
    init: async () => {},
    findContact: async () => {
      searched += 1;
      return { status: 'not_found', candidates: [], searched: [] };
    },
  };
  const result = await engine._processContact({
    contactId: 'L10-1',
    name: 'Already Texted',
    phones: ['5105551234'],
    sheetSendStatus: 'SMS SENT AND CONFIRMED',
    sheetHistory: classifySheetStatus('SMS SENT AND CONFIRMED', ''),
  });
  assert.equal(searched, 0, 'a pre-worked row must never be searched in REI');
  assert.equal(result.L10_Disposition, DISPOSITION.ALREADY_PROCESSED);
  assert.equal(result.L10_Status, L10_STATUS.ALREADY_PROCESSED);
  assert.equal(result.L10_SendVerified, false);
});

test('a row with no sheet history still runs the normal pipeline', async () => {
  const { Engine } = await import('../server/automation/engine.js');
  const engine = new Engine();
  let searched = 0;
  engine.adapter = {
    init: async () => {},
    findContact: async () => {
      searched += 1;
      return { status: 'not_found', candidates: [], searched: ['(510) 555-1234'] };
    },
  };
  // Sandbox/seed contacts carry no sheetHistory — they must not be skipped.
  await engine._processContact({ contactId: 'L10-2', name: 'Open Row', phones: ['5105551234'] });
  assert.equal(searched, 1, 'an open row must still be searched');
});

// ---------------------------------------------------------------------------
// The read-only REI check must skip pre-worked rows too — opening 139 records
// that the sheet already accounts for costs minutes each and proves nothing.
// ---------------------------------------------------------------------------
test('the read-only check reports pre-worked rows from the sheet, without opening REI', async () => {
  const { runReadOnlyVerification, summarize } = await import('../server/automation/verifyLive.js');
  let searched = 0;
  const adapter = {
    findContact: async () => {
      searched += 1;
      return { status: 'not_found', candidates: [], searched: [] };
    },
  };
  const cols = { name: 'Primary Name', phone: 'Primary Phone', address: 'Full Address', profitDial: 'Profit Dial' };
  const rows = [
    { 'Primary Name': 'Open One', 'Primary Phone': '5105551111', 'Send Status': '', Notes: '' },
    { 'Primary Name': 'Texted', 'Primary Phone': '5105552222', 'Send Status': 'SMS SENT AND CONFIRMED', Notes: '' },
    { 'Primary Name': 'Landline', 'Primary Phone': '5105553333', 'Send Status': "Lead's number is a landline", Notes: '' },
  ];
  const findings = await runReadOnlyVerification({ adapter, rows, cols, limit: 3, level10Tag: 'Level 10 Properties' });
  assert.equal(searched, 1, 'only the open row may be searched in REI');
  assert.equal(findings.length, 3, 'every row is still reported');
  assert.equal(findings[1].sheetSkipped, true);
  assert.equal(findings[2].sheetSkipped, true);
  const s = summarize(findings);
  assert.equal(s.rows, 3);
  assert.equal(s.checked, 1);
  assert.equal(s.sheetSkipped, 2);
  assert.equal(s.writeActionsAttempted, 0);
});
