// =============================================================================
// Selector classification report.
//
//   npm run selectors:status
//
// VERIFIED    listed in `_verifiedLive` — observed WORKING in the real REI account
// UNVERIFIED  a selector exists but has never been proven against the real account
// MISSING     blank; never captured
//
// A sandbox run can never promote a selector to VERIFIED. Only a real live run,
// recorded in config/reibb.selectors.json under `_verifiedLive`, can.
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sel = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'reibb.selectors.json'), 'utf8'));
const verified = new Set(sel._verifiedLive || []);

// Every selector the pipeline depends on, in the order it is used.
const REQUIRED = [
  'contacts.pageMarker',
  'contacts.searchInput',
  'contacts.resultRow',
  'contacts.resultName',
  'contacts.resultPhone',
  'contacts.resultAddress',
  'contacts.openContact',
  'contact.pageMarker',
  'contact.nameField',
  'contact.phoneRows',
  'contact.addressField',
  'contact.stateField',
  'contact.notesField',
  'contact.tagChips',
  'contact.optInStatus',
  'contact.optInButton',
  'contact.optInConfirm',
  'contact.optInSuccessMarker',
  'contact.chatTab',
  'chat.profitDialSelect',
  'chat.profitDialOptions',
  'chat.profitDialSelectedValue',
  'chat.messageInput',
  'chat.sendButton',
  'chat.messageThread',
  'chat.outgoingMessage',
];

const get = (key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), sel);

const rows = REQUIRED.map((key) => {
  const value = get(key);
  const present = typeof value === 'string' && value.trim() !== '';
  const status = verified.has(key) ? 'VERIFIED' : present ? 'UNVERIFIED' : 'MISSING';
  return { key, status, value: present ? value : '' };
});

const counts = rows.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {});
console.log('\n  REI SELECTOR STATUS\n');
for (const r of rows) {
  console.log(`  ${r.status.padEnd(11)} ${r.key}`);
}
console.log(
  `\n  VERIFIED ${counts.VERIFIED || 0} · UNVERIFIED ${counts.UNVERIFIED || 0} · MISSING ${counts.MISSING || 0}`
);
if (!counts.VERIFIED) {
  console.log('  No selector has been proven against the real REI account yet.');
}
console.log('');
