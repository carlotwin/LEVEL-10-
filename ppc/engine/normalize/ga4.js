// GA4 (website) data -> normalized rows.
//
// Two row kinds are used:
//   landingDaily  one row per date x landing page x source/medium x keyword x city x device
//                 (sessions, engaged sessions, key events, form starts/submits)
//   pagePaths     page-level visitor totals for the retargeting analyzer
//                 (users, returning users, users from Google Ads, key events)
// Both come from the sync agent (GA4 Data API) or from a GA4 CSV download.
import { findHeaderRow, mapColumns, parseCsv, rowsToObjects } from '../csv.js';
import { parseLocation } from '../geo.js';
import { toDate, toInt, toNumber } from '../util.js';

const GA4_ALIASES = {
  date: ['Date'],
  path: ['Landing page + query string', 'Landing page', 'Page path + query string', 'Page path and screen class', 'Page path', 'Page location'],
  sourceMedium: ['Session source / medium', 'Source / medium', 'First user source / medium'],
  source: ['Session source', 'Source'],
  medium: ['Session medium', 'Medium'],
  campaign: ['Session campaign', 'Session campaign name', 'Campaign'],
  kw: ['Session Google Ads keyword text', 'Session Google Ads keyword', 'Google Ads keyword text', 'Session manual term'],
  city: ['City'],
  dev: ['Device category'],
  sessions: ['Sessions'],
  engaged: ['Engaged sessions'],
  users: ['Active users', 'Total users', 'Users'],
  returningUsers: ['Returning users'],
  ppcUsers: ['Users from Google Ads', 'Google Ads users'],
  keyEvents: ['Key events', 'Conversions'],
  formStarts: ['form_start', 'Form starts'],
  formSubmits: ['form_submit', 'generate_lead', 'Form submits', 'Leads'],
};

export function isPaidMedium(sourceMedium, medium) {
  const s = `${sourceMedium || ''} ${medium || ''}`.toLowerCase();
  return /(^|[\s/])(cpc|ppc|paid|paidsearch)(\s|$)/.test(s) || s.includes('google / cpc');
}

/** Strip query string and host: "https://site.com/sell-inherited?x=1" -> "/sell-inherited" */
export function cleanPath(value) {
  let s = String(value ?? '').trim();
  if (!s) return '';
  s = s.replace(/^https?:\/\/[^/]+/i, '');
  s = s.split(/[?#]/)[0] || '/';
  if (!s.startsWith('/')) s = `/${s}`;
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

export function parseGa4Csv(text) {
  // GA4 downloads start with "#" comment lines; drop them before parsing.
  const body = String(text ?? '').split(/\r?\n/).filter((l) => !l.startsWith('#')).join('\n');
  const rows = parseCsv(body);
  const headerIndex = findHeaderRow(rows, Object.values(GA4_ALIASES).flat(), 2);
  if (headerIndex < 0) return { kind: 'unknown', landingDaily: [], pagePaths: [], warnings: ['No GA4 header row found (expected Landing page / Page path and Sessions).'] };
  const headers = rows[headerIndex].map((h) => String(h).trim());
  const { mapping } = mapColumns(headers, GA4_ALIASES);
  const objects = rowsToObjects(rows, headerIndex).filter((o) => !/grand total|^total/i.test(String(Object.values(o)[0] || '')));
  const warnings = [];
  const landingDaily = [];
  const pagePaths = [];
  const kind = mapping.path && mapping.users && !mapping.sessions ? 'pages' : mapping.path ? 'landing' : 'unknown';
  for (const o of objects) {
    const path = cleanPath(o[mapping.path]);
    if (!path) continue;
    let source = String(o[mapping.source] || '').trim();
    let medium = String(o[mapping.medium] || '').trim();
    if (mapping.sourceMedium && (!source || !medium)) {
      const [s, m] = String(o[mapping.sourceMedium] || '').split('/').map((x) => x.trim());
      source = source || s || '';
      medium = medium || m || '';
    }
    if (kind === 'pages') {
      pagePaths.push({
        path, users: toInt(o[mapping.users]) || 0, returningUsers: toInt(o[mapping.returningUsers]) || 0,
        ppcUsers: toInt(o[mapping.ppcUsers]) || 0, keyEvents: toNumber(o[mapping.keyEvents]) || 0,
        formStarts: toInt(o[mapping.formStarts]) || 0, formSubmits: toInt(o[mapping.formSubmits]) || 0,
      });
      continue;
    }
    const d = mapping.date ? toDate(o[mapping.date]) : null;
    const loc = parseLocation(o[mapping.city], 'CA');
    landingDaily.push({
      d, path, source, medium, paid: isPaidMedium(`${source} / ${medium}`, medium), campaign: String(o[mapping.campaign] || '').trim(),
      kw: String(o[mapping.kw] || '').replace(/^\(not set\)$/i, '').trim(), city: loc.city, st: loc.state,
      dev: String(o[mapping.dev] || '').toLowerCase(), sessions: toInt(o[mapping.sessions]) || 0, engaged: toInt(o[mapping.engaged]) || 0,
      keyEvents: toNumber(o[mapping.keyEvents]) || 0, formStarts: toInt(o[mapping.formStarts]) || 0, formSubmits: toInt(o[mapping.formSubmits]) || 0,
    });
  }
  if (kind === 'landing' && !mapping.date) warnings.push('No Date column in the GA4 file: rows are kept without dates and ignore the date filter.');
  if (kind === 'unknown') warnings.push('Could not tell which GA4 report this is. Export a landing page report (with Sessions) or a page path report (with Active users).');
  return { kind, landingDaily, pagePaths, warnings };
}
