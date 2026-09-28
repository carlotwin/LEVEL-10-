// RFC 4180 CSV reading and writing, plus header detection for exports that put
// title lines above the real header (Google Ads, GA4) and totals below it.

/** Guess the delimiter from the first non-empty lines. */
export function detectDelimiter(text) {
  const sample = String(text).split(/\r?\n/).filter((l) => l.trim()).slice(0, 12).join('\n');
  const counts = { ',': 0, '\t': 0, ';': 0 };
  let inQuotes = false;
  for (const ch of sample) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch] += 1;
  }
  const [best, hits] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return hits > 0 ? best : ',';
}

/**
 * Parse CSV text into an array of rows (arrays of strings). Handles quoted
 * fields, escaped quotes, embedded newlines, CRLF, a UTF-8 BOM and UTF-16 BOM
 * text that was already decoded.
 */
export function parseCsv(text, delimiter) {
  let s = String(text ?? '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const delim = delimiter || detectDelimiter(s);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/** Lowercased, punctuation-light header key: "Conv. value" -> "conv value". */
export function headerKey(h) {
  return String(h ?? '')
    .toLowerCase()
    .replace(/[‘’'"]/g, '')
    .replace(/[._/\\()\[\]#:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find the header row: the first row (within the first 15) that contains at
 * least `minHits` of the expected header keys. Returns -1 when none matches.
 */
export function findHeaderRow(rows, expectedKeys, minHits = 2) {
  const expected = new Set(expectedKeys.map(headerKey));
  const limit = Math.min(rows.length, 15);
  for (let i = 0; i < limit; i += 1) {
    const hits = rows[i].filter((c) => expected.has(headerKey(c))).length;
    if (hits >= minHits) return i;
  }
  return -1;
}

/** Rows (array of arrays) after a header row -> array of {header: value}. */
export function rowsToObjects(rows, headerIndex = 0) {
  if (!rows.length || headerIndex < 0) return [];
  const headers = rows[headerIndex].map((h) => String(h).trim());
  const out = [];
  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const r = rows[i];
    const obj = {};
    let any = false;
    headers.forEach((h, j) => {
      if (!h) return;
      const v = r[j] == null ? '' : String(r[j]).trim();
      obj[h] = v;
      if (v !== '') any = true;
    });
    if (any) out.push(obj);
  }
  return out;
}

/**
 * Map real headers to canonical fields using alias lists.
 * spec: { field: ['alias one', 'alias two', ...] }
 * Returns { mapping: {field: header}, missing: [field], unused: [header] }.
 */
export function mapColumns(headers, spec, overrides = {}) {
  const byKey = new Map(headers.map((h) => [headerKey(h), h]));
  const mapping = {};
  const used = new Set();
  for (const [field, aliases] of Object.entries(spec)) {
    const forced = overrides[field];
    if (forced && headers.includes(forced)) {
      mapping[field] = forced;
      used.add(forced);
      continue;
    }
    if (forced === '') continue; // explicitly unmapped by the user
    for (const alias of aliases) {
      const h = byKey.get(headerKey(alias));
      if (h && !used.has(h)) {
        mapping[field] = h;
        used.add(h);
        break;
      }
    }
  }
  const missing = Object.keys(spec).filter((f) => !mapping[f]);
  const unused = headers.filter((h) => !used.has(h));
  return { mapping, missing, unused };
}

function escapeCell(value) {
  if (value == null) return '';
  const s = String(value);
  // Neutralize spreadsheet formula injection in exported files.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^[-+]?\d/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Array of objects -> CSV text with the given columns [{key, label}]. */
export function toCsv(rows, columns) {
  const cols = columns || Object.keys(rows[0] || {}).map((k) => ({ key: k, label: k }));
  const lines = [cols.map((c) => escapeCell(c.label ?? c.key)).join(',')];
  for (const r of rows) lines.push(cols.map((c) => escapeCell(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
