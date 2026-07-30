import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProfitDialIndex, matchProfitDial, normalizeAddress } from '../server/automation/profitdial.js';
import { PROFITDIAL_ROWS, PD_COLS, POOL_A, POOL_B } from '../config/sandbox/seed.js';

const idx = buildProfitDialIndex(PROFITDIAL_ROWS, PD_COLS);

test('address normalization strips punctuation and Excel zip suffix', () => {
  assert.equal(normalizeAddress('100 Alpha St., Oakland, CA 94601.0'), '100 ALPHA ST OAKLAND CA 94601');
});

test('exact valid match resolves the single ProfitDial', () => {
  const r = matchProfitDial({ address: '100 Alpha St, Oakland, CA 94601', phone: '510-555-0101' }, idx);
  assert.equal(r.status, 'ok');
  assert.equal(r.profitDial, POOL_A);
  assert.equal(r.matchedBy, 'address');
});

test('not in sheet -> not_found', () => {
  const r = matchProfitDial({ address: '104 Delta St, Oakland, CA 94601', phone: '510-555-0104' }, idx);
  assert.equal(r.status, 'not_found');
});

test('duplicate rows -> multiple_records (never choose one)', () => {
  const r = matchProfitDial({ address: '105 Epsilon St, Oakland, CA 94601', phone: '510-555-0105' }, idx);
  assert.equal(r.status, 'multiple_records');
  assert.equal(r.recordCount, 2);
});

test('blank ProfitDial -> missing', () => {
  const r = matchProfitDial({ address: '113 Mu St, Oakland, CA 94601', phone: '510-555-0113' }, idx);
  assert.equal(r.status, 'missing');
});

test('two distinct assignments across keys -> multiple_assignments', () => {
  // address -> POOL_A row; phone -> different row with POOL_B
  const r = matchProfitDial({ address: '114 Nu St, Oakland, CA 94601', phone: '510-555-0114' }, idx);
  assert.equal(r.status, 'multiple_assignments');
});

test('never returns a default/first number on ambiguity', () => {
  const r = matchProfitDial({ address: '114 Nu St, Oakland, CA 94601', phone: '510-555-0114' }, idx);
  assert.equal(r.profitDial, undefined);
});

test('contact id matching disabled when no id column', () => {
  assert.equal(idx.cols.contactId, '');
  const r = matchProfitDial({ contactId: 'anything', address: '100 Alpha St, Oakland, CA 94601', phone: '510-555-0101' }, idx);
  assert.equal(r.matchedBy, 'address');
});
