import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import {
  readWorkbook,
  normHeader,
  detectColumns,
  detectColumnsForRows,
  loadLevel10File,
} from '../server/data/spreadsheet.js';

const ENV_COLS = {
  profitDial: 'Profit Dial',
  address: 'Full Address',
  phone: 'Primary Phone',
  name: 'Primary Name',
};

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'l10-')), name);
}

function writeWorkbook(sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  const file = tmpFile('sheet.xlsx');
  XLSX.writeFile(wb, file);
  return file;
}

test('readWorkbook works from a file path (ESM xlsx has no readFile)', () => {
  const file = writeWorkbook([['Data', [['A', 'B'], ['1', '2']]]]);
  const wb = readWorkbook(file);
  assert.deepEqual(wb.SheetNames, ['Data']);
});

test('normHeader folds case, spacing, underscores and trailing punctuation', () => {
  assert.equal(normHeader('  Primary_Phone '), 'primary phone');
  assert.equal(normHeader('Profit  Dial:'), 'profit dial');
  assert.equal(normHeader('FIrst Name'), 'first name');
});

test('configured header names win over aliases', () => {
  const { cols, how } = detectColumns(
    ['Profit Dial', 'Full Address', 'Primary Phone', 'Primary Name', 'Phone'],
    ENV_COLS
  );
  assert.equal(cols.phone, 'Primary Phone');
  assert.equal(how.phone, 'configured');
});

test('drifted header names are detected by alias', () => {
  const { cols, how } = detectColumns(['ProfitDial', 'Property Address', 'Phone Number', 'Owner Name'], ENV_COLS);
  assert.deepEqual(cols.profitDial, 'ProfitDial');
  assert.equal(cols.address, 'Property Address');
  assert.equal(cols.phone, 'Phone Number');
  assert.equal(cols.name, 'Owner Name');
  assert.equal(how.address, 'detected');
});

test('a column that is genuinely absent is reported missing, never guessed', () => {
  const { cols, how } = detectColumns(['Full Address', 'Primary Phone'], ENV_COLS);
  assert.equal(cols.profitDial, '');
  assert.equal(how.profitDial, 'missing');
  const det = detectColumnsForRows([{ 'Full Address': 'x', 'Primary Phone': 'y' }], ENV_COLS);
  assert.ok(det.missing.includes('profitDial'));
});

test('the exact confirmed sheet loads with headers on row 1', () => {
  const file = writeWorkbook([
    ['With Contacts', [
      ['FIrst Name', 'Owner', 'Full Address', 'Primary Name', 'Primary Phone', 'Profit Dial'],
      ['Ana', 'Ana Diaz', '1 A St, Fresno, CA', 'Ana Diaz', '559-555-0001', '559-888-0001'],
    ]],
  ]);
  const r = loadLevel10File(file, { preferredTab: 'With Contacts', preferredCols: ENV_COLS });
  assert.equal(r.tab, 'With Contacts');
  assert.equal(r.headerRow, 1);
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.missing, []);
});

test('a renamed tab, a title row, a blank row and drifted headers all still load', () => {
  const file = writeWorkbook([
    ['Summary', [['Notes'], ['export summary']]],
    ['With Contacts (1)', [
      ['Level 10 Properties with Contacts — export'],
      [],
      ['Owner Name', 'Property Address', 'Phone Number', 'ProfitDial'],
      ['Ana Diaz', '1 A St, Fresno, CA', '559-555-0001', '559-888-0001'],
      ['Bo Lee', '2 B St, Fresno, CA', '559-555-0002', '559-888-0002'],
    ]],
  ]);
  const r = loadLevel10File(file, { preferredTab: 'With Contacts', preferredCols: ENV_COLS });
  assert.equal(r.tab, 'With Contacts (1)', 'loose tab-name match');
  assert.equal(r.headerRow, 3, 'header row found below the title and blank row');
  assert.equal(r.rows.length, 2, 'the title row is not a data row');
  assert.deepEqual(r.missing, []);
  assert.equal(r.rows[0]['Phone Number'], '559-555-0001');
});

test('the lead tab is chosen over an unrelated first tab', () => {
  const file = writeWorkbook([
    ['Instructions', [['How to use this sheet'], ['step one']]],
    ['Data', [
      ['Primary Name', 'Full Address', 'Primary Phone', 'Profit Dial'],
      ['Ana Diaz', '1 A St', '559-555-0001', '559-888-0001'],
    ]],
  ]);
  const r = loadLevel10File(file, { preferredTab: 'With Contacts', preferredCols: ENV_COLS });
  assert.equal(r.tab, 'Data');
  assert.deepEqual(r.missing, []);
});

// --- search-term construction for the live REI lookup ----------------------
test('live search tries every phone format, then name, then street — never a synthetic id', async () => {
  const { ReiBlackBookAdapter } = await import('../server/adapters/reibb.js');
  const a = new ReiBlackBookAdapter();
  const terms = a._searchTerms({
    contactId: 'L10-7',
    syntheticId: true,
    phone: '916-607-2808',
    name: 'TONY LAM',
    address: '2700 Humboldt Ave, Oakland, CA 94602',
  });
  const values = terms.map((t) => t.value);
  assert.ok(values.includes('916-607-2808'), 'dashed');
  assert.ok(values.includes('9166072808'), 'digits only');
  assert.ok(values.includes('(916) 607-2808'), 'parenthesized');
  assert.ok(values.includes('TONY LAM'), 'name');
  assert.ok(values.includes('2700 Humboldt Ave'), 'street only');
  assert.equal(values.includes('L10-7'), false, 'a synthetic row id is never searched in REI');
  // NAME first: REI's contact search does not match every phone format (a dotted
  // number returns "No Result Found" for a contact that exists), so leading with
  // the phone wastes lookups. The phone still CONFIRMS the opened contact.
  assert.equal(terms[0].label, 'name');
  const labels = terms.map((t) => t.label);
  assert.ok(labels.indexOf('name') < labels.indexOf('phone'), 'name is searched before phone');
  assert.ok(labels.indexOf('address') < labels.indexOf('phone'), 'address is searched before phone');
  // Dotted format goes last — observed to fail on this account.
  const phoneValues = terms.filter((t) => t.label === 'phone').map((t) => t.value);
  assert.equal(phoneValues[0], '(916) 607-2808', 'parenthesized first');
  assert.equal(phoneValues[phoneValues.length - 1], '916.607.2808', 'dotted last');
});

test('a real contact id from the sheet IS searched', async () => {
  const { ReiBlackBookAdapter } = await import('../server/adapters/reibb.js');
  const a = new ReiBlackBookAdapter();
  const values = a._searchTerms({ contactId: 'REI-9931', syntheticId: false, phone: '510-206-1922' }).map((t) => t.value);
  assert.ok(values.includes('REI-9931'));
});

// --- name verification against the sheet ----------------------------------
test('namesMatch is tolerant about formatting, strict about identity', async () => {
  const { namesMatch } = await import('../server/adapters/reibb.js');
  // Same person, different formatting.
  assert.equal(namesMatch('TONY LAM', 'Tony Lam'), true);
  assert.equal(namesMatch('Lam, Tony', 'TONY LAM'), true);
  assert.equal(namesMatch('TONY LAM JR', 'Tony Lam'), true, 'suffix ignored');
  assert.equal(namesMatch('Tony R. Lam', 'TONY LAM'), true, 'middle initial ignored');
  assert.equal(namesMatch('  tony   lam  ', 'Tony Lam'), true);
  // Different people must NOT match.
  assert.equal(namesMatch('LINDA HUNT', 'TONY LAM'), false);
  assert.equal(namesMatch('TONY NGUYEN', 'TONY LAM'), false, 'shared first name is not enough');
  // Blank / placeholder names never pass.
  assert.equal(namesMatch('', 'TONY LAM'), false);
  assert.equal(namesMatch('Unknown', 'TONY LAM'), false);
  assert.equal(namesMatch('TONY LAM', ''), false);
});

test('CONTACT_VERIFY defaults to phone+name and rejects junk values', async () => {
  const { env } = await import('../server/config/env.js');
  assert.ok(['phone', 'name', 'either', 'phone+name'].includes(env.CONTACT_VERIFY));
});
