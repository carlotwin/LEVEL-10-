// =============================================================================
// Forgiving spreadsheet import/export (CSV/XLSX) via the `xlsx` package.
//   - Import a named tab as an array of header->value maps (values as strings).
//   - Map many column-name variants to internal contact fields.
//   - Export results back into the user's own columns + appended L10_* columns.
// =============================================================================
import XLSX from 'xlsx';
import { EXPORT_COLUMNS } from '../automation/constants.js';

// -----------------------------------------------------------------------------
// Header normalization + alias matching for the Level 10 sheet (leads +
// ProfitDial in one file). Configured PD_COL_* names are tried first (exact,
// then normalized); if the sheet's real header doesn't match, fall back to
// a likely alias. Never confuses ProfitDial with Primary Phone/Mail/Purchase
// Date -- those terms don't appear in the ProfitDial alias list.
// -----------------------------------------------------------------------------
export const LEVEL10_HEADER_ALIASES = Object.freeze({
  name: ['owner', 'owner name', 'homeowner', 'homeowner name', 'seller name', 'first name'],
  address: ['full address', 'property address', 'address', 'property'],
  phone: ['phone', 'phone number', 'primary phone', 'mobile', 'mobile phone'],
  profitDial: [
    'assigned profitdial',
    'profitdial',
    'profit dial',
    'primary profitdial',
    'primary profit dial',
    'assigned number',
    'sender number',
  ],
});

export function normalizeHeaderKey(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find the real header in `headers` for one logical field. Tries the
 * configured name (exact, then normalized), then each alias (normalized).
 * Returns '' if nothing matches -- callers treat that field as missing.
 */
export function resolveHeader(headers, configuredName, aliases = []) {
  const candidates = (headers || []).map((h) => ({ raw: h, norm: normalizeHeaderKey(h) }));
  if (configuredName) {
    const exact = candidates.find((c) => c.raw === configuredName);
    if (exact) return exact.raw;
    const normConfigured = normalizeHeaderKey(configuredName);
    const normMatch = candidates.find((c) => c.norm === normConfigured);
    if (normMatch) return normMatch.raw;
  }
  for (const alias of aliases) {
    const match = candidates.find((c) => c.norm === alias);
    if (match) return match.raw;
  }
  return '';
}

/**
 * Resolve the Level 10 sheet's real column names for name/address/phone/
 * ProfitDial, given the actual headers present and the configured (.env)
 * names. contactId is only used if the configured column is actually present
 * (there is no alias list for it -- most Level 10 sheets have no ID column).
 */
export function resolveLevel10Columns(headers, envCols = {}) {
  return {
    name: resolveHeader(headers, envCols.name, LEVEL10_HEADER_ALIASES.name),
    address: resolveHeader(headers, envCols.address, LEVEL10_HEADER_ALIASES.address),
    phone: resolveHeader(headers, envCols.phone, LEVEL10_HEADER_ALIASES.phone),
    profitDial: resolveHeader(headers, envCols.profitDial, LEVEL10_HEADER_ALIASES.profitDial),
    contactId: envCols.contactId && (headers || []).includes(envCols.contactId) ? envCols.contactId : '',
  };
}

/** Read a workbook from a file path. Returns the XLSX workbook object. */
export function readWorkbook(filePath) {
  return XLSX.readFile(filePath, { cellDates: false });
}

/** List visible + hidden sheet names. */
export function sheetNames(wb) {
  return wb.SheetNames.slice();
}

/**
 * Read a specific tab into rows of header->string maps. Trailing fully-empty
 * rows are dropped.
 *
 * Sheet selection is NEVER silent when it matters: if the requested tab name
 * isn't present, a single-sheet workbook is used as-is, but a multi-sheet
 * workbook throws SHEET_AMBIGUOUS (with the real sheet names) rather than
 * guessing at the first sheet, which could quietly load the wrong data.
 */
export function readTab(wb, tabName) {
  const names = wb.SheetNames;
  let name;
  if (tabName && wb.Sheets[tabName]) {
    name = tabName;
  } else if (names.length === 1) {
    name = names[0];
  } else {
    const err = new Error(
      `Worksheet "${tabName || ''}" was not found. This file has multiple sheets (${names.join(', ')}) — specify which one to use.`
    );
    err.code = 'SHEET_AMBIGUOUS';
    err.sheetNames = names;
    throw err;
  }
  const ws = wb.Sheets[name];
  const json = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
  const rows = json
    .map((r) => {
      const out = {};
      for (const [k, v] of Object.entries(r)) out[String(k).trim()] = v == null ? '' : String(v).trim();
      return out;
    })
    .filter((r) => Object.values(r).some((v) => v !== ''));
  return { tab: name, rows };
}

/** Convenience: read a tab straight from a path. */
export function readTabFromFile(filePath, tabName) {
  return readTab(readWorkbook(filePath), tabName);
}

// -----------------------------------------------------------------------------
// Contact-list import (the leads to process). Forgiving header mapping.
// -----------------------------------------------------------------------------
const FIELD_ALIASES = {
  contactId: ['contact id', 'contactid', 'rei id', 'reiid', 'id'],
  firstName: ['first name', 'firstname', 'first', 'fname'],
  lastName: ['last name', 'lastname', 'last', 'lname'],
  name: ['primary name', 'owner', 'full name', 'name'],
  address: ['full address', 'address', 'property address', 'street address'],
  city: ['city'],
  state: ['state', 'st'],
  zip: ['zip', 'zipcode', 'postal code'],
  phone: ['primary phone', 'phone', 'phone number', 'mobile', 'cell', 'primary phone1'],
};

export function mapContactRow(row) {
  const lower = {};
  for (const [k, v] of Object.entries(row)) lower[k.toLowerCase().trim()] = v;
  const pick = (aliases) => {
    for (const a of aliases) if (lower[a] != null && lower[a] !== '') return lower[a];
    return '';
  };
  const out = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) out[field] = pick(aliases);
  if (!out.address && (out.city || out.state)) {
    out.address = [row['Address'] || '', out.city, out.state, out.zip].filter(Boolean).join(', ');
  }
  out._original = row;
  return out;
}

export function importContacts(filePath, tabName) {
  const { tab, rows } = readTabFromFile(filePath, tabName);
  return { tab, contacts: rows.map(mapContactRow) };
}

// -----------------------------------------------------------------------------
// Export results.
// -----------------------------------------------------------------------------
/**
 * @param {Array<object>} originalRows  the user's original rows (or contact._original)
 * @param {Array<object>} results       aligned array of L10_* result objects
 * @param {'xlsx'|'csv'} format
 * @returns {Buffer}
 */
export function exportResults(originalRows, results, format = 'xlsx') {
  const merged = originalRows.map((orig, i) => {
    const res = results[i] || {};
    const row = { ...orig };
    for (const col of EXPORT_COLUMNS) row[col] = res[col] ?? '';
    return row;
  });
  const ws = XLSX.utils.json_to_sheet(merged);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Results');
  if (format === 'csv') {
    return Buffer.from(XLSX.utils.sheet_to_csv(ws), 'utf8');
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
