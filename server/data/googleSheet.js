// =============================================================================
// Google Sheet ingestion for the ProfitDial source of truth.
//
// Fetches a specific tab of a Google Sheet as CSV via the public export URL.
// This works when the sheet is shared "Anyone with the link (Viewer)" OR when
// an access token is supplied. For a private sheet with no token, Google returns
// an HTML sign-in page (HTTP 401/302) — we detect that and return a clear,
// actionable error instead of garbage rows. No columns are ever invented.
//
// Alternatives if the sheet must stay private:
//   - Enable the Google Drive connector and download/upload an export, or
//   - Provide an OAuth access token (Authorization: Bearer …) via options.token.
// =============================================================================
import * as XLSX from 'xlsx';

export function csvExportUrl(sheetId, gid) {
  const g = gid != null && gid !== '' ? `&gid=${encodeURIComponent(gid)}` : '';
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/export?format=csv${g}`;
}

/** Parse a sheet URL into { sheetId, gid }. */
export function parseSheetUrl(url) {
  const idM = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(url || '');
  const gidM = /[?#&]gid=(\d+)/.exec(url || '');
  return { sheetId: idM ? idM[1] : '', gid: gidM ? gidM[1] : '' };
}

function looksLikeHtml(text) {
  const head = text.slice(0, 200).toLowerCase();
  return head.includes('<!doctype html') || head.includes('<html') || head.includes('sign in');
}

/**
 * Fetch a tab as rows of header->string maps.
 * @returns {Promise<{rows: Array<object>, sourceUrl: string}>}
 * @throws with .code='SHEET_PRIVATE' | 'SHEET_FETCH_FAILED'
 */
export async function fetchGoogleSheetRows({ sheetId, gid, token } = {}) {
  if (!sheetId) {
    const e = new Error('Missing sheetId');
    e.code = 'SHEET_FETCH_FAILED';
    throw e;
  }
  const url = csvExportUrl(sheetId, gid);
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  let res;
  try {
    res = await fetch(url, { headers, redirect: 'follow' });
  } catch (err) {
    const e = new Error(`Network error fetching Google Sheet: ${err.message}`);
    e.code = 'SHEET_FETCH_FAILED';
    throw e;
  }

  const text = await res.text();
  if (res.status === 401 || res.status === 403 || res.status === 302 || looksLikeHtml(text)) {
    const e = new Error(
      'Google Sheet is private — the CSV export returned a sign-in page. ' +
        'Either share the sheet "Anyone with the link → Viewer", enable the ' +
        'Google Drive connector and upload an export, or pass an OAuth token.'
    );
    e.code = 'SHEET_PRIVATE';
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`Google Sheet fetch failed: HTTP ${res.status}`);
    e.code = 'SHEET_FETCH_FAILED';
    throw e;
  }

  // Parse CSV -> rows of header->string maps (same shape as spreadsheet.readTab).
  const wb = XLSX.read(text, { type: 'string' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const json = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
  const rows = json
    .map((r) => {
      const out = {};
      for (const [k, v] of Object.entries(r)) out[String(k).trim()] = v == null ? '' : String(v).trim();
      return out;
    })
    .filter((r) => Object.values(r).some((v) => v !== ''));
  return { rows, sourceUrl: url };
}
