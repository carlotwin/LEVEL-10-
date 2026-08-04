// =============================================================================
// Forgiving spreadsheet import/export (CSV/XLSX) via the `xlsx` package.
//   - Import a named tab as an array of header->value maps (values as strings).
//   - Map many column-name variants to internal contact fields.
//   - Export results back into the user's own columns + appended L10_* columns.
// =============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { EXPORT_COLUMNS } from '../automation/constants.js';

/**
 * Read a workbook from a file path. Returns the XLSX workbook object.
 *
 * Reads the bytes ourselves and parses a buffer rather than calling
 * XLSX.readFile: the ESM entry point of xlsx@0.18 does not export readFile (it
 * has no fs bound), so `XLSX.readFile` is undefined here and every upload threw
 * "XLSX.readFile is not a function". XLSX.read on a buffer exists in both the
 * ESM and CJS builds.
 */
export function readWorkbook(filePath) {
  return XLSX.read(fs.readFileSync(filePath), { type: 'buffer', cellDates: false });
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
// TOLERANT LOADING — "just upload the file and read it".
//
// A real export off the Master Spreadsheet does not always arrive with the exact
// headers on the exact tab on row 1: tabs get renamed or suffixed ("(1)"), a
// title/filter row sits above the headers, and column names drift ("ProfitDial",
// "Phone", "Property Address"). Failing on any of that just hides the sheet from
// the operator. So: find the right tab, find the header row, and map the columns
// by alias — then REPORT exactly what was detected so nothing is silently
// guessed. What is NOT relaxed: matching and sending still require a single
// unambiguous ProfitDial per lead (see profitdial.js).
// -----------------------------------------------------------------------------

/** Normalize a header for comparison: case, spacing, underscores, trailing punctuation. */
export function normHeader(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\s_]+/g, ' ')
    .replace(/[:.*]+$/, '')
    .trim();
}

// Ordered by preference — the earliest alias that appears in the sheet wins.
export const PD_COLUMN_ALIASES = Object.freeze({
  profitDial: [
    'profit dial', 'profitdial', 'profit dial number', 'profit dial #', 'pd',
    'assigned number', 'from number', 'dial number', 'sending number',
  ],
  address: ['full address', 'property address', 'situs address', 'street address', 'address'],
  phone: [
    'primary phone', 'phone', 'phone number', 'mobile', 'mobile phone', 'cell',
    'cell phone', 'primary phone1', 'phone 1', 'phone1',
  ],
  name: ['primary name', 'owner', 'owner name', 'full name', 'name'],
  firstName: ['first name', 'firstname', 'first', 'fname'],
  contactId: ['contact id', 'contactid', 'rei id', 'reiid', 'rei contact id'],
});

// A tab needs at least a phone or an address to be a plausible lead sheet.
const SCORING_FIELDS = ['profitDial', 'address', 'phone', 'name'];

/**
 * Find the row index (0-based) holding the real headers. Handles a title row,
 * a blank row, or an export banner sitting above them.
 */
function findHeaderRow(matrix) {
  const limit = Math.min(matrix.length, 15);
  let best = { idx: 0, score: 0 };
  const allAliases = Object.values(PD_COLUMN_ALIASES).flat();
  for (let i = 0; i < limit; i++) {
    const cells = (matrix[i] || []).map(normHeader).filter(Boolean);
    if (cells.length < 2) continue;
    const score = cells.filter((c) => allAliases.includes(c)).length;
    if (score > best.score) best = { idx: i, score };
  }
  return best.score >= 2 ? best.idx : 0;
}

/** Map sheet headers -> our fields. `preferred` (from .env) wins when present. */
export function detectColumns(headers, preferred = {}) {
  const present = new Map(headers.map((h) => [normHeader(h), h]));
  const cols = {};
  const how = {};
  for (const [field, aliases] of Object.entries(PD_COLUMN_ALIASES)) {
    const want = preferred[field];
    if (want && present.has(normHeader(want))) {
      cols[field] = present.get(normHeader(want));
      how[field] = 'configured';
      continue;
    }
    const hit = aliases.map((a) => present.get(a)).find(Boolean);
    if (hit) {
      cols[field] = hit;
      how[field] = 'detected';
    } else {
      cols[field] = '';
      how[field] = 'missing';
    }
  }
  return { cols, how };
}

/** Rows of a worksheet, starting at the detected header row, values as strings. */
function rowsFromSheet(ws) {
  // blankrows:true is required — the index this returns is fed to `range`, which
  // counts real sheet rows. Dropping blank rows here shifts every index below the
  // first blank row (a blank line above the headers is common in exports).
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: true });
  const headerRow = findHeaderRow(matrix);
  const json = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false, range: headerRow });
  const rows = json
    .map((r) => {
      const out = {};
      for (const [k, v] of Object.entries(r)) out[String(k).trim()] = v == null ? '' : String(v).trim();
      return out;
    })
    .filter((r) => Object.values(r).some((v) => v !== ''));
  return { rows, headerRow: headerRow + 1 };
}

/**
 * Load the Level 10 sheet from a workbook without requiring an exact tab name,
 * header row, or header spelling.
 *
 * @returns {{tab, tabs, rows, headerRow, cols, how, missing, tabScores}}
 */
export function loadLevel10Workbook(wb, { preferredTab, preferredCols = {} } = {}) {
  const candidates = wb.SheetNames.map((name) => {
    const { rows, headerRow } = rowsFromSheet(wb.Sheets[name]);
    const headers = rows.length ? Object.keys(rows[0]) : [];
    const { cols, how } = detectColumns(headers, preferredCols);
    const score = SCORING_FIELDS.filter((f) => cols[f]).length;
    return { name, rows, headerRow, cols, how, score };
  });

  // Prefer the configured tab when it is usable; otherwise the best-scoring tab.
  // A tab name may have been suffixed on export ("With Contacts (1)"), so match
  // loosely before falling back.
  const wantedName = normHeader(preferredTab || '');
  const exact = candidates.find((c) => normHeader(c.name) === wantedName);
  const loose = candidates.find((c) => wantedName && normHeader(c.name).startsWith(wantedName));
  const best = candidates.slice().sort((a, b) => b.score - a.score || b.rows.length - a.rows.length)[0];

  let chosen = null;
  for (const c of [exact, loose]) {
    if (c && c.score >= 2) { chosen = c; break; }
  }
  if (!chosen) chosen = best;

  const missing = SCORING_FIELDS.filter((f) => !chosen.cols[f]);
  return {
    tab: chosen.name,
    tabs: wb.SheetNames.slice(),
    rows: chosen.rows,
    headerRow: chosen.headerRow,
    cols: chosen.cols,
    how: chosen.how,
    missing,
    tabScores: candidates.map((c) => ({ tab: c.name, rows: c.rows.length, matched: c.score })),
  };
}

/** Same, straight from a file path. */
export function loadLevel10File(filePath, opts) {
  return loadLevel10Workbook(readWorkbook(filePath), opts);
}

/** Detect columns for rows that were already parsed (e.g. Google Sheet CSV). */
export function detectColumnsForRows(rows, preferredCols = {}) {
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const { cols, how } = detectColumns(headers, preferredCols);
  return { cols, how, missing: SCORING_FIELDS.filter((f) => !cols[f]) };
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

// -----------------------------------------------------------------------------
// FINDING THE WORKBOOK
//
// Used by the server at boot and by the CLI. Looks where the file actually tends
// to be, and never guesses between several matches.
// -----------------------------------------------------------------------------
export function findLevel10Workbook(explicit, { home = os.homedir(), cwd = process.cwd() } = {}) {
  // cmd keeps stray quotes when a drag-and-drop is mixed with typing.
  const given = String(explicit ?? '').replace(/^["']+|["']+$/g, '').trim();
  if (given && fs.existsSync(given)) return { file: given, hits: [given], given };

  const dirs = [
    cwd,
    path.join(cwd, 'data'),
    path.join(home, 'Downloads'),
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
    path.join(home, 'OneDrive', 'Desktop'),
    path.join(home, 'OneDrive', 'Documents'),
    home,
  ];
  const hits = [];
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!/\.(xlsx|xlsm|xls|csv)$/i.test(n)) continue;
      // Separators vary by how the file arrived: "Level 10 Properties.xlsx" from
      // a browser download, "Level_10_Properties_with_Contacts.xlsx" from a
      // Sheets export. \s does NOT match "_", so the underscore form — the one
      // the export actually produces — was invisible to this scan.
      if (!/level[\s_.-]*-?[\s_.-]*10|with[\s_.-]*contacts/i.test(n)) continue;
      const full = path.join(dir, n);
      if (!hits.includes(full)) hits.push(full);
    }
  }
  // Newest first — a re-downloaded sheet is usually the one wanted.
  hits.sort((a, b) => {
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });

  // The app's own data/ folder outranks a stray copy in Downloads. Putting the
  // file there is a deliberate act; a months-old download sitting in Downloads
  // is not, and quietly texting off the stale list is the worst outcome here.
  // Only ONE file in data/ counts as unambiguous — two still means "you pick".
  const dataDir = path.join(cwd, 'data');
  const inData = hits.filter((h) => path.dirname(h) === dataDir);
  if (inData.length === 1) return { file: inData[0], hits, given, chosenFrom: 'data' };
  if (inData.length > 1) return { file: null, hits: inData, given, chosenFrom: 'data' };

  return { file: hits.length === 1 ? hits[0] : null, hits, given };
}
