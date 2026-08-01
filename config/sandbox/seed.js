// =============================================================================
// SANDBOX SEED — synthetic contacts + synthetic ProfitDial source-of-truth.
//
// 100% FAKE data (no real PII). Engineered so the sandbox adapter exercises
// every scenario required by #8. The synthetic ProfitDial rows use the SAME
// header names as the real "With Contacts" tab so the real matcher runs
// unchanged.
//
// Two pool numbers mirror the real sheet's structure:
//   POOL_A = (510) 916-3995   POOL_B = (925) 515-2335
// =============================================================================
export const POOL_A = '(510) 916-3995';
export const POOL_B = '(925) 515-2335';

export const PD_COLS = Object.freeze({
  profitDial: 'Profit Dial',
  address: 'Full Address',
  phone: 'Primary Phone',
  name: 'Primary Name',
  contactId: '', // no Contact ID column (mirrors real sheet)
});

const L10 = 'Level 10 Properties';

// Helper to keep scenario definitions terse.
function c(contactId, scenario, over = {}) {
  return {
    contactId,
    scenario,
    found: over.found ?? true,
    firstName: over.firstName ?? 'Pat',
    lastName: over.lastName ?? 'Sample',
    name: over.name ?? `${over.firstName ?? 'Pat'} ${over.lastName ?? 'Sample'}`,
    // Demo link (test mode). In Live, the real per-contact URL is captured from REI.
    reiUrl: over.reiUrl ?? `https://app.reiblackbook.com/contacts/${contactId}`,
    address: over.address ?? `${contactId} Test St, Oakland, CA 94601`,
    state: over.state ?? 'CA',
    tags: over.tags ?? [L10],
    notes: over.notes ?? '',
    chatHistory: over.chatHistory ?? [],
    phones: over.phones ?? [`510-555-${(1000 + hash(contactId)) % 10000}`.padStart(12, '0')],
    optedIn: over.optedIn ?? false,
    optOut: over.optOut ?? false,
    preRecorded: over.preRecorded ?? false,
    behavior: {
      optIn: 'success',
      availableProfitDial: [POOL_A, POOL_B],
      readback: 'match',
      send: 'ok',
      verify: 'ok',
      delivery: 'delivered',
      reply: '',
      ...(over.behavior || {}),
    },
  };
}
function hash(s) {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

// -----------------------------------------------------------------------------
// Scenario contacts (working set for SOP Step 2 / listContacts()).
// -----------------------------------------------------------------------------
export const CONTACTS = [
  // 1 + 11 + 21 + 23: exact valid, opt-in success, delivered, positive reply
  c('valid-1', 'Exact valid contact / opt-in success / delivered / positive reply', {
    firstName: 'Maria', address: '100 Alpha St, Oakland, CA 94601', phones: ['510-555-0101'],
    behavior: { delivery: 'delivered', reply: 'Yes, how much are you offering?' },
  }),
  // 2: contact not found
  c('notfound-1', 'Contact not found', {
    found: false,
    address: '102 Beta St, Oakland, CA 94601',
    phones: ['510-555-0102'],
  }),
  // 3: missing Level 10 tag
  c('notag-1', 'Missing Level 10 tag', { address: '103 Gamma St, Oakland, CA 94601', tags: ['Some Other Tag'] }),
  // 4: spreadsheet mismatch (valid contact, absent from ProfitDial sheet)
  c('mismatch-1', 'Spreadsheet mismatch (not in ProfitDial sheet)', { address: '104 Delta St, Oakland, CA 94601', phones: ['510-555-0104'] }),
  // 5: duplicate contact (two identical rows in sheet)
  c('dup-1', 'Duplicate contact in spreadsheet', { address: '105 Epsilon St, Oakland, CA 94601', phones: ['510-555-0105'] }),
  // 6: invalid phone
  c('invalidphone-1', 'Invalid phone', { address: '106 Zeta St, Oakland, CA 94601', phones: ['12345'] }),
  // 7: multiple phone numbers
  c('multiphone-1', 'Multiple phone numbers', { address: '107 Eta St, Oakland, CA 94601', phones: ['510-555-0107', '510-555-7777'] }),
  // 8: previous opt-out (tag/flag)
  c('optout-1', 'Previous opt-out', { address: '108 Theta St, Oakland, CA 94601', phones: ['510-555-0108'], optOut: true, tags: [L10, 'Opted Out'] }),
  // 9: STOP reply in history
  c('stopreply-1', 'STOP reply in history', { address: '109 Iota St, Oakland, CA 94601', phones: ['510-555-0109'], chatHistory: ['Homeowner: STOP'] }),
  // 10: do-not-contact note
  c('dnc-1', 'Do-not-contact note', { address: '110 Kappa St, Oakland, CA 94601', phones: ['510-555-0110'], notes: 'Do not contact — per homeowner request' }),
  // 12: opt-in failure
  c('optinfail-1', 'Opt-in failure', { address: '112 Lambda St, Oakland, CA 94601', phones: ['510-555-0112'], behavior: { optIn: 'fail' } }),
  // 13: missing ProfitDial (row exists, blank Profit Dial)
  c('missingpd-1', 'Missing ProfitDial assignment', { address: '113 Mu St, Oakland, CA 94601', phones: ['510-555-0113'] }),
  // 14: multiple ProfitDial assignments (address->A, phone->B)
  c('multipd-1', 'Multiple ProfitDial assignments', { address: '114 Nu St, Oakland, CA 94601', phones: ['510-555-0114'] }),
  // 15: ProfitDial unavailable in REI (assigned B, but REI only offers A)
  c('pdunavail-1', 'ProfitDial unavailable in REI', { address: '115 Xi St, Oakland, CA 94601', phones: ['510-555-0115'], behavior: { availableProfitDial: [POOL_A] } }),
  // 16: ProfitDial readback mismatch
  c('pdmismatch-1', 'ProfitDial readback mismatch', { address: '116 Omicron St, Oakland, CA 94601', phones: ['510-555-0116'], behavior: { readback: 'wrong' } }),
  // 17: missing property address in the uploaded row -- caught by the GATE 0
  // pre-flight check now (before ever searching REI), not the later merge-
  // field gate. The blank-address INVALID_MERGE_FIELD path itself is still
  // covered directly by a pure unit test in test/message.test.js.
  c('mergebad-1', 'Missing property address (manual review, not searched)', { firstName: 'Chris', name: 'Chris Sample', address: '', phones: ['510-555-0117'] }),
  // 17b: joint owners -> uses only the first-listed individual's first name
  c('jointowner-1', 'Joint owners (uses first-listed first name: Tony)', { firstName: 'Tony', name: 'Tony & Sukien Lam', address: '130 Joint St, Oakland, CA 94601', phones: ['510-555-0130'] }),
  // 18: placeholder template blocked from live mode (valid in sandbox)
  c('placeholder-live-1', 'Placeholder template blocked in live mode', { address: '118 Rho St, Oakland, CA 94601', phones: ['510-555-0118'] }),
  // 19: already processed (pre-seeded into ledger for this batch)
  c('already-1', 'Already processed (ledger hit)', { address: '119 Sigma St, Oakland, CA 94601', phones: ['510-555-0119'], preRecorded: true }),
  // 20: send verification failure
  c('verifyfail-1', 'Send verification failure', { address: '120 Tau St, Oakland, CA 94601', phones: ['510-555-0120'], behavior: { verify: 'fail' } }),
  // 22: failed/undelivered message
  c('delivfail-1', 'Failed / undelivered message', { address: '122 Upsilon St, Oakland, CA 94601', phones: ['510-555-0122'], behavior: { delivery: 'failed' } }),
  // 24: negative reply
  c('negreply-1', 'Negative reply', { address: '124 Phi St, Oakland, CA 94601', phones: ['510-555-0124'], behavior: { reply: 'No, not interested.' } }),
  // 25: unclear reply
  c('unclearreply-1', 'Unclear reply', { address: '125 Chi St, Oakland, CA 94601', phones: ['510-555-0125'], behavior: { reply: 'Who is this?' } }),
  // 26: opt-out reply (post-send STOP)
  c('optoutreply-1', 'Opt-out reply (STOP after send)', { address: '126 Psi St, Oakland, CA 94601', phones: ['510-555-0126'], behavior: { reply: 'STOP' } }),
  // extra clean send with no reply (delivered) to enrich KPIs
  c('valid-2', 'Valid contact, delivered, no reply', { firstName: 'Sam', address: '127 Omega St, Oakland, CA 94601', phones: ['510-555-0127'] }),
];

// -----------------------------------------------------------------------------
// Synthetic ProfitDial "With Contacts" rows. Header names match the real sheet.
// -----------------------------------------------------------------------------
function pdRow(address, phone, name, profitDial) {
  return { 'Full Address': address, 'Primary Phone': phone, 'Primary Name': name, 'Profit Dial': profitDial };
}

export const PROFITDIAL_ROWS = [
  pdRow('100 Alpha St, Oakland, CA 94601', '510-555-0101', 'Maria Sample', POOL_A),
  // notfound-1: a valid, complete spreadsheet row -- the file itself is fine,
  // REI just doesn't have this contact (tests the live-search "not found" path,
  // not the pre-flight required-fields/ProfitDial gate).
  pdRow('102 Beta St, Oakland, CA 94601', '510-555-0102', 'Pat Sample', POOL_A),
  pdRow('103 Gamma St, Oakland, CA 94601', '510-555-0103', 'Pat Sample', POOL_A),
  // mismatch-1 intentionally ABSENT
  // dup-1: two identical rows (duplicate contact), same PD
  pdRow('105 Epsilon St, Oakland, CA 94601', '510-555-0105', 'Pat Sample', POOL_A),
  pdRow('105 Epsilon St, Oakland, CA 94601', '510-555-0105', 'Pat Sample', POOL_A),
  pdRow('106 Zeta St, Oakland, CA 94601', '510-555-0106', 'Pat Sample', POOL_A),
  pdRow('107 Eta St, Oakland, CA 94601', '510-555-0107', 'Pat Sample', POOL_A),
  pdRow('108 Theta St, Oakland, CA 94601', '510-555-0108', 'Pat Sample', POOL_A),
  pdRow('109 Iota St, Oakland, CA 94601', '510-555-0109', 'Pat Sample', POOL_A),
  pdRow('110 Kappa St, Oakland, CA 94601', '510-555-0110', 'Pat Sample', POOL_A),
  pdRow('112 Lambda St, Oakland, CA 94601', '510-555-0112', 'Pat Sample', POOL_A),
  // missingpd-1: row exists, blank Profit Dial
  pdRow('113 Mu St, Oakland, CA 94601', '510-555-0113', 'Pat Sample', ''),
  // multipd-1: address -> POOL_A ; phone -> a DIFFERENT row with POOL_B
  pdRow('114 Nu St, Oakland, CA 94601', '510-555-9999', 'Pat Sample', POOL_A),
  pdRow('999 Elsewhere Ave, Oakland, CA 94601', '510-555-0114', 'Pat Sample', POOL_B),
  // pdunavail-1: assigned POOL_B but REI only offers POOL_A (adapter override)
  pdRow('115 Xi St, Oakland, CA 94601', '510-555-0115', 'Pat Sample', POOL_B),
  pdRow('116 Omicron St, Oakland, CA 94601', '510-555-0116', 'Pat Sample', POOL_A),
  pdRow('117 Pi St, Oakland, CA 94601', '510-555-0117', 'Chris Sample', POOL_A),
  pdRow('130 Joint St, Oakland, CA 94601', '510-555-0130', 'Tony & Sukien Lam', POOL_A),
  pdRow('118 Rho St, Oakland, CA 94601', '510-555-0118', 'Pat Sample', POOL_A),
  pdRow('119 Sigma St, Oakland, CA 94601', '510-555-0119', 'Pat Sample', POOL_A),
  pdRow('120 Tau St, Oakland, CA 94601', '510-555-0120', 'Pat Sample', POOL_A),
  pdRow('122 Upsilon St, Oakland, CA 94601', '510-555-0122', 'Pat Sample', POOL_A),
  pdRow('124 Phi St, Oakland, CA 94601', '510-555-0124', 'Pat Sample', POOL_A),
  pdRow('125 Chi St, Oakland, CA 94601', '510-555-0125', 'Pat Sample', POOL_A),
  pdRow('126 Psi St, Oakland, CA 94601', '510-555-0126', 'Pat Sample', POOL_A),
  pdRow('127 Omega St, Oakland, CA 94601', '510-555-0127', 'Sam Sample', POOL_B),
];
