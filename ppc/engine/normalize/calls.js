// Call tracking exports (CallRail, ProfitDial reports, Google forwarding
// numbers, etc.) -> normalized calls. The caller's number is hashed; the
// tracking number (the business's own number) is kept so it can be mapped to
// a source in Settings.
import { findHeaderRow, mapColumns, parseCsv, rowsToObjects } from '../csv.js';
import { parseLocation } from '../geo.js';
import { fnv1a, normalizePhone, normText, sha256Hex, toDate, toTimestamp } from '../util.js';

const CALL_ALIASES = {
  id: ['Call ID', 'ID', 'Id'],
  at: ['Start Time', 'Call Start', 'Date/Time', 'Date Time', 'Call Date', 'Date', 'Time'],
  caller: ['Caller Number', 'Caller', 'From', 'Caller ID', 'Customer Phone', 'Phone'],
  trackingNumber: ['Tracking Number', 'To', 'Number Dialed', 'Dialed Number', 'Tracking #', 'Profit Dial', 'ProfitDial Number'],
  duration: ['Duration (sec)', 'Duration', 'Call Duration', 'Talk Time'],
  status: ['Call Status', 'Status', 'Answered', 'Disposition'],
  source: ['Source', 'Traffic Source', 'Channel', 'Marketing Source'],
  campaign: ['Campaign', 'utm_campaign', 'UTM Campaign'],
  keyword: ['Keyword', 'Search Keyword', 'utm_term'],
  gclid: ['GCLID', 'gclid'],
  city: ['Caller City', 'City'],
};

/** "3:25" -> 205, "00:03:25" -> 205, "205" -> 205 */
export function parseDuration(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  const parts = s.split(':').map(Number);
  if (parts.some((p) => Number.isNaN(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export async function parseCallsCsv(text) {
  const rows = parseCsv(text);
  const headerIndex = findHeaderRow(rows, Object.values(CALL_ALIASES).flat(), 2);
  if (headerIndex < 0) return { calls: [], warnings: ['No call log header row found (expected Caller Number, Tracking Number, Date).'] };
  const headers = rows[headerIndex].map((h) => String(h).trim());
  const { mapping } = mapColumns(headers, CALL_ALIASES);
  const calls = [];
  for (const o of rowsToObjects(rows, headerIndex)) {
    const at = toTimestamp(o[mapping.at]);
    const caller = normalizePhone(o[mapping.caller]);
    if (!at && !caller) continue;
    const status = normText(o[mapping.status]);
    const durationSec = parseDuration(o[mapping.duration]);
    const loc = parseLocation(o[mapping.city], 'CA');
    calls.push({
      id: String(o[mapping.id] || '').trim() || `call_${fnv1a(`${at}|${caller}|${o[mapping.trackingNumber] || ''}`)}`,
      at, d: at ? at.slice(0, 10) : toDate(o[mapping.at]),
      phoneHash: caller ? await sha256Hex(caller) : '',
      trackingNumber: normalizePhone(o[mapping.trackingNumber]),
      durationSec,
      answered: status ? !/(missed|no answer|abandon|voicemail|unanswered|busy|false|^no$)/.test(status) : durationSec != null ? durationSec > 0 : null,
      source: String(o[mapping.source] || '').trim(),
      campaign: String(o[mapping.campaign] || '').trim(),
      keyword: String(o[mapping.keyword] || '').trim(),
      gclid: String(o[mapping.gclid] || '').trim(),
      city: loc.city, st: loc.state,
    });
  }
  const warnings = [];
  if (!mapping.caller) warnings.push('No caller number column: calls cannot be matched to leads.');
  if (!mapping.trackingNumber && !mapping.source) warnings.push('No tracking number or source column: calls cannot be tied to Google Ads.');
  return { calls, warnings };
}
