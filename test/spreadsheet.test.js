import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHeader, resolveLevel10Columns, normalizeHeaderKey } from '../server/data/spreadsheet.js';

test('normalizeHeaderKey trims, lowercases, strips punctuation, collapses spaces', () => {
  assert.equal(normalizeHeaderKey('  Full Address  '), 'full address');
  assert.equal(normalizeHeaderKey('Profit-Dial #'), 'profit dial');
  assert.equal(normalizeHeaderKey('Primary  Phone'), 'primary phone');
});

test('resolveHeader prefers the configured (.env) name when the sheet has it', () => {
  const headers = ['Full Address', 'Owner', 'Profit Dial', 'Primary Phone'];
  assert.equal(resolveHeader(headers, 'Profit Dial', ['profitdial']), 'Profit Dial');
});

test('resolveHeader falls back to an alias when the configured name is absent', () => {
  const headers = ['Property Address', 'Homeowner Name', 'Assigned ProfitDial', 'Mobile'];
  assert.equal(resolveHeader(headers, 'Full Address', ['full address', 'property address', 'address', 'property']), 'Property Address');
  assert.equal(resolveHeader(headers, 'Profit Dial', ['assigned profitdial', 'profitdial', 'profit dial']), 'Assigned ProfitDial');
});

test('resolveHeader returns empty string when nothing matches', () => {
  assert.equal(resolveHeader(['Foo', 'Bar'], 'Profit Dial', ['profitdial', 'profit dial']), '');
});

test('resolveLevel10Columns never confuses ProfitDial with Primary Phone/Mail/Purchase Date', () => {
  const headers = ['Full Address', 'Owner', 'Primary Phone', 'Primary Mail', 'Purchase Date', 'Assigned Number'];
  const cols = resolveLevel10Columns(headers, { profitDial: 'Profit Dial', address: 'Full Address', phone: 'Primary Phone', name: 'Owner' });
  assert.equal(cols.profitDial, 'Assigned Number');
  assert.equal(cols.phone, 'Primary Phone');
  assert.notEqual(cols.profitDial, cols.phone);
});

test('resolveLevel10Columns resolves the full set of documented aliases', () => {
  const headers = ['Seller Name', 'Property', 'Mobile Phone', 'Sender Number'];
  const cols = resolveLevel10Columns(headers, {});
  assert.equal(cols.name, 'Seller Name');
  assert.equal(cols.address, 'Property');
  assert.equal(cols.phone, 'Mobile Phone');
  assert.equal(cols.profitDial, 'Sender Number');
});
