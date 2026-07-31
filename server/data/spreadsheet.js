// =============================================================================
// Forgiving spreadsheet import/export (CSV/XLSX) via the `xlsx` package.
//   - Import a named tab as an array of header->value maps (values as strings).
//   - Map many column-name variants to internal contact fields.
//   - Export results back into the user's own columns + appended L10_* columns.
// =============================================================================
import XLSX from 'xlsx';
import { EXPORT_COLUMNS } from '../automation/constants.js';

/** Read a workbook from a file path. Returns the XLSX workbook object. */
export function readWorkbook(filePath) {
  return XLSX.readFile(filePath, { cellDates: false });
}

/** List visible + hidden sheet names. */
export function sheetNames(wb) {
  return wb.SheetNames.slice();
}

/**
 * Read a specific tab (by exact name, else first sheet) into rows of
 * header->string maps. Trailing fully-empty rows are dropped.
 */
export function readTab(wb, tabName) {
  const name = tabName && wb.Sheets[tabName] ? tabName : wb.SheetNames[0];
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
