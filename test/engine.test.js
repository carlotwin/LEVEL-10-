// Engine-level integration test using the sandbox adapter (no browser, no
// network). Isolated from the real data/ directory via LEVEL10_DATA_DIR so it
// never touches real job state or the campaign ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Pin EVERY env var this test's logic depends on -- never rely on whatever a
// real .env file OR an inherited shell environment happens to contain. In
// particular: WATCH-REI.bat runs `set WATCH_ONLY=true` etc. directly in the
// current cmd.exe window (no setlocal/subprocess isolation), so those values
// persist for the rest of that terminal session and get inherited by any
// later `npm test` run in the same window. Explicitly pinning every relevant
// flag here means this test's outcome can never depend on terminal history.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'l10-engine-test-'));
process.env.LEVEL10_DATA_DIR = tmp;
process.env.SANDBOX = 'true';
process.env.WATCH_ONLY = 'false';
process.env.ALLOW_LIVE_SEND = 'false';
process.env.HEADLESS = 'true';
process.env.PILOT_BATCH_LIMIT = '3';
process.env.MAX_SENDS_PER_RUN = '0';
process.env.CAMPAIGN_BATCH = 'engine-test-batch';
process.env.LEVEL10_TAG = 'Level 10 Properties';
process.env.TEXT_STATES = 'CA,California';
process.env.REQUIRE_OPTIN = 'true';
process.env.REQUIRE_PROFITDIAL = 'true';

const { Engine } = await import('../server/automation/engine.js');

const POOL_A = '(510) 916-3995';

function makeContact(i) {
  return {
    contactId: `pilot-${i}`,
    found: true,
    firstName: 'Pat',
    lastName: 'Sample',
    name: 'Pat Sample',
    reiUrl: `https://app.reiblackbook.com/contacts/pilot-${i}`,
    address: `${i} Pilot St, Oakland, CA 94601`,
    state: 'CA',
    tags: ['Level 10 Properties'],
    notes: '',
    chatHistory: [],
    phones: [`510-555-9${String(i).padStart(3, '0')}`],
    optedIn: false,
    optOut: false,
    preRecorded: false,
    behavior: { optIn: 'success', availableProfitDial: [POOL_A], readback: 'match', send: 'ok', verify: 'ok', delivery: 'delivered', reply: '' },
  };
}
function makePdRow(i) {
  const c = makeContact(i);
  return { 'Full Address': c.address, 'Primary Phone': c.phones[0], 'Primary Name': c.name, 'Profit Dial': POOL_A };
}

test('pilot batch cap pauses after N ATTEMPTED leads (not just N sends), and Resume unlocks the next batch', async () => {
  const contacts = Array.from({ length: 6 }, (_, i) => makeContact(i + 1));
  const profitDialRows = contacts.map((_, i) => makePdRow(i + 1));
  const cols = { profitDial: 'Profit Dial', address: 'Full Address', phone: 'Primary Phone', name: 'Primary Name', contactId: '' };

  const engine = new Engine();
  engine.loadJob({ contacts, profitDialRows, profitDialCols: cols, source: 'test', tab: 'test' });
  await engine.start();
  await engine._loop;

  const first = engine.snapshot();
  assert.equal(first.status, 'paused');
  assert.equal(first.cursor, 3);
  assert.equal(first.attemptsThisRun, 3);
  const sentCount = first.results.filter((r) => r.L10_Disposition === 'Simulated Sent').length;
  if (sentCount !== 3) {
    console.error('DEBUG non-sent results:', JSON.stringify(first.results.map((r) => ({ id: r.contactId, disposition: r.L10_Disposition, reason: r.L10_Reason })), null, 2));
  }
  assert.equal(sentCount, 3);

  await engine.resume();
  await engine._loop;

  const second = engine.snapshot();
  assert.equal(second.status, 'done');
  assert.equal(second.cursor, 6);
  assert.equal(second.results.filter((r) => r.L10_Disposition === 'Simulated Sent').length, 6);
});
