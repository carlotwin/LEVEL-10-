// =============================================================================
// ProfitDial source-of-truth matcher (PURE, fail-closed — requirement #5).
//
// Source of truth: the "With Contacts" tab of the Level 10 Master Spreadsheet.
// Confirmed real headers (see confirmation report):
//   FIrst Name | Last Name | Owner | Full Address | Address | City | State |
//   ZIP | Primary Name | Primary Phone | Profit Dial
//
// There is NO Contact ID column, so ID matching is disabled unless configured.
// Best unique key = Full Address (100% unique). Phone is near-unique (one owner
// has two properties on one phone), so phone-only can return >1 row -> block.
//
// Matching hierarchy (first tier returning EXACTLY ONE row wins):
//   1. Contact ID  (only if the sheet has one AND the contact provides one)
//   2. Full Address (normalized)
//   3. Primary Phone (normalized, last 10)
//
// After a single row is found, ALL of these must hold or status != 'ok':
//   - exactly one non-blank Profit Dial value on the matched row
//   - (multiple distinct assignments across matched rows -> 'multiple_assignments')
//
// The engine then verifies availability-in-REI and digit-for-digit readback
// (those are facts about the screen, handled in sop.checkProfitDial).
//
// This module NEVER: picks the first number, uses a default, approximates,
// chooses among multiple, or proceeds on conflict. Anything uncertain returns a
// non-'ok' status that the SOP maps to Needs Review.
// =============================================================================
import { normalizePhone, digitsOnly } from './sop.js';

export function normalizeAddress(raw) {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/\.0\b/g, '') // strip Excel numeric ZIP suffix like 94602.0
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build an indexed view of the spreadsheet rows for fast, exact matching.
 * @param {Array<object>} rows  each row is a header->value map
 * @param {object} cols  { profitDial, address, phone, name, contactId }
 */
export function buildProfitDialIndex(rows, cols) {
  const byId = new Map();
  const byAddress = new Map();
  const byPhone = new Map();

  const push = (map, key, row) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  };

  const norm = rows.map((r, i) => {
    const rec = {
      _row: i + 2, // 1-based + header
      raw: r,
      contactId: cols.contactId ? String(r[cols.contactId] ?? '').trim() : '',
      address: normalizeAddress(r[cols.address]),
      phone: normalizePhone(r[cols.phone]),
      name: String(r[cols.name] ?? '').trim(),
      profitDial: String(r[cols.profitDial] ?? '').trim(),
    };
    push(byId, rec.contactId, rec);
    push(byAddress, rec.address, rec);
    push(byPhone, rec.phone, rec);
    return rec;
  });

  return { records: norm, byId, byAddress, byPhone, cols };
}

/**
 * Match a REI contact to exactly one spreadsheet row and resolve its ProfitDial.
 *
 * @param {object} contact  { contactId?, address?, phone? }
 * @param {object} index    from buildProfitDialIndex
 * @returns {{status, profitDial?, matchedBy?, recordCount?, reason?, record?}}
 *   status ∈ ok | not_found | multiple_records | missing |
 *            multiple_assignments | conflict
 */
export function matchProfitDial(contact, index) {
  const cId = index.cols.contactId ? String(contact.contactId ?? '').trim() : '';
  const cAddr = normalizeAddress(contact.address);
  const cPhone = normalizePhone(contact.phone);

  // Ordered tiers. First tier with >=1 row is authoritative.
  const tiers = [];
  if (cId) tiers.push({ by: 'contactId', rows: index.byId.get(cId) || [] });
  if (cAddr) tiers.push({ by: 'address', rows: index.byAddress.get(cAddr) || [] });
  if (cPhone) tiers.push({ by: 'phone', rows: index.byPhone.get(cPhone) || [] });

  let chosen = null;
  for (const tier of tiers) {
    if (tier.rows.length === 0) continue;
    chosen = tier;
    break;
  }
  if (!chosen) return { status: 'not_found', reason: 'No spreadsheet row matched by id/address/phone' };

  // Union of ALL rows matched by ANY key (dedup by _row) — used to detect a
  // contact that resolves to more than one DISTINCT ProfitDial number.
  const allRows = unionRows({ cId, cAddr, cPhone }, index);
  const distinctPD = new Set(allRows.map((r) => digitsOnly(r.profitDial)).filter((d) => d.length >= 10));

  // Rule #5: never choose between multiple ProfitDial assignments.
  if (distinctPD.size > 1) {
    return {
      status: 'multiple_assignments',
      matchedBy: chosen.by,
      reason: `Contact resolves to ${distinctPD.size} distinct ProfitDial numbers across matched rows`,
    };
  }

  // Duplicate contact rows (same authoritative key -> >1 row, same PD).
  if (chosen.rows.length > 1) {
    return {
      status: 'multiple_records',
      matchedBy: chosen.by,
      recordCount: chosen.rows.length,
      reason: `Matched ${chosen.rows.length} spreadsheet rows by ${chosen.by} (duplicate contact)`,
    };
  }

  const record = chosen.rows[0];
  const pd = digitsOnly(record.profitDial);
  if (!record.profitDial || pd.length < 10) {
    return { status: 'missing', matchedBy: chosen.by, reason: 'Matched row has blank/invalid ProfitDial', record };
  }

  return { status: 'ok', profitDial: record.profitDial, matchedBy: chosen.by, record };
}

function unionRows({ cId, cAddr, cPhone }, index) {
  const seen = new Map();
  const add = (rows) => rows && rows.forEach((r) => seen.set(r._row, r));
  if (cId) add(index.byId.get(cId));
  if (cAddr) add(index.byAddress.get(cAddr));
  if (cPhone) add(index.byPhone.get(cPhone));
  return [...seen.values()];
}

function distinctProfitDialsForContact({ cId, cAddr, cPhone }, index) {
  return new Set(
    unionRows({ cId, cAddr, cPhone }, index)
      .map((r) => digitsOnly(r.profitDial))
      .filter((d) => d.length >= 10)
  );
}

/** Diagnostics for the confirmation panel in the dashboard. */
export function analyzeSheet(rows, cols) {
  const idx = buildProfitDialIndex(rows, cols);
  const blank = idx.records.filter((r) => !r.profitDial || digitsOnly(r.profitDial).length < 10).length;
  const distinctPD = new Set(idx.records.map((r) => digitsOnly(r.profitDial)).filter(Boolean));
  const dupPhones = [...idx.byPhone.entries()].filter(([k, v]) => k && v.length > 1).length;
  const dupAddr = [...idx.byAddress.entries()].filter(([k, v]) => k && v.length > 1).length;
  const multiAssign = idx.records.filter((r) => {
    const s = distinctProfitDialsForContact({ cAddr: r.address, cPhone: r.phone }, idx);
    return s.size > 1;
  }).length;
  return {
    totalRows: idx.records.length,
    blankProfitDial: blank,
    distinctProfitDialNumbers: distinctPD.size,
    duplicatePhones: dupPhones,
    duplicateAddresses: dupAddr,
    contactsWithMultipleAssignments: multiAssign,
    contactIdAvailable: Boolean(cols.contactId),
  };
}
