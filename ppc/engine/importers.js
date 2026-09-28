// One entry point for every file a person (or the sync agent) brings in:
// tells what the file is, runs the right importer, and returns a partial
// dataset ready to merge. Used by the dashboard's Data Sources page and by
// the agent's CSV fallback, so both treat files exactly the same way.
import { findHeaderRow, mapColumns, parseCsv, rowsToObjects } from './csv.js';
import { emptyDataset, DATASET_SCHEMA, normalizeShape, recordSync, validateDataset } from './dataset.js';
import { parseCallsCsv } from './normalize/calls.js';
import { cleanPath, parseGa4Csv } from './normalize/ga4.js';
import { normalizeGaql, parseGoogleAdsCsv } from './normalize/googleAds.js';
import { DEFAULT_STATUS_RULES, normalizeReiRows, REI_COLUMNS, STAGE_ORDER } from './normalize/rei.js';
import { normText } from './util.js';

export const GADS_SCRIPT_KIND = 'twin-ppc-gads/1';

export const FILE_KINDS = Object.freeze({
  google_ads: 'Google Ads report',
  rei: 'REI BlackBook export',
  ga4: 'Website (GA4) report',
  calls: 'Call log',
  pages: 'Landing page list',
  dataset: 'Dashboard dataset (sync file)',
  gads_script: 'Google Ads Script export',
  unknown: 'Unknown file',
});

const PAGE_COLUMNS = {
  url: ['URL', 'Page URL', 'Landing page', 'Page', 'Path', 'Final URL'],
  h1: ['H1', 'Headline', 'Heading', 'Page headline'],
  title: ['Title', 'Page title', 'Meta title'],
  cta: ['CTA', 'Call to action', 'Button', 'Button text'],
  situation: ['Situation', 'Seller situation', 'Intent'],
};
const CALL_HINTS = ['Caller Number', 'Caller', 'Caller ID', 'Tracking Number', 'Number Dialed', 'Call Duration', 'Duration', 'Call ID', 'Talk Time'];
const GA4_HINTS = ['Sessions', 'Engaged sessions', 'Active users', 'Returning users', 'Session source / medium', 'Landing page + query string', 'Page path and screen class'];
// Fields only a CRM export has (never a Google Ads or GA4 report).
const REI_ONLY = ['id', 'name', 'firstName', 'lastName', 'phone', 'email', 'address', 'status', 'leadSource', 'qualified', 'appointmentAt', 'offerAt', 'contractAt', 'closedAt', 'lostReason', 'profit', 'createdAt'];

const stripHashComments = (text) => String(text ?? '').split(/\r?\n/).filter((l) => !l.startsWith('#')).join('\n');

function headerFor(rows, spec) {
  const flat = Array.isArray(spec) ? spec : Object.values(spec).flat();
  const i = findHeaderRow(rows, flat, 2);
  return i < 0 ? null : { index: i, headers: rows[i].map((h) => String(h).trim()) };
}

function countHits(headers, names) {
  const keys = new Set(headers.map((h) => normText(h)));
  return names.filter((n) => keys.has(normText(n))).length;
}

/** What is this file? Returns one of FILE_KINDS' keys. */
export function detectFileKind(name, text) {
  const body = String(text ?? '');
  const trimmed = body.trimStart();
  if (trimmed.startsWith('{')) {
    try {
      const json = JSON.parse(trimmed);
      if (json.schema === DATASET_SCHEMA) return 'dataset';
      if (json.kind === GADS_SCRIPT_KIND) return 'gads_script';
    } catch { /* not JSON after all */ }
    return 'unknown';
  }
  const rows = parseCsv(stripHashComments(body));
  if (!rows.length) return 'unknown';
  const pages = headerFor(rows, PAGE_COLUMNS);
  if (pages) {
    const { mapping } = mapColumns(pages.headers, PAGE_COLUMNS);
    if (mapping.url && (mapping.h1 || mapping.cta)) return 'pages';
  }
  const rei = headerFor(rows, REI_COLUMNS);
  if (rei) {
    const { mapping } = mapColumns(rei.headers, REI_COLUMNS);
    const hits = REI_ONLY.filter((f) => mapping[f]).length;
    if (hits >= 3 && (mapping.status || mapping.leadSource || mapping.qualified)) return 'rei';
  }
  const calls = headerFor(rows, CALL_HINTS);
  if (calls && countHits(calls.headers, CALL_HINTS) >= 2 && countHits(calls.headers, ['Caller Number', 'Caller', 'Caller ID', 'Customer Phone']) >= 1) return 'calls';
  const ga4 = headerFor(rows, GA4_HINTS);
  if (ga4 && countHits(ga4.headers, ['Sessions', 'Active users', 'Total users', 'Users']) >= 1 && parseGa4Csv(body).kind !== 'unknown') return 'ga4';
  if (parseGoogleAdsCsv(body).reportType !== 'unknown') return 'google_ads';
  return 'unknown';
}

/** Status rules with the team's own status names (Settings) checked first. */
export function statusRulesFrom(statusMap = {}) {
  const custom = Object.entries(statusMap || {})
    .filter(([status, stage]) => status && (STAGE_ORDER.includes(stage) || stage === 'lost'))
    .map(([status, stage]) => ({ stage, words: [status] }));
  return [...custom, ...DEFAULT_STATUS_RULES];
}

const SOURCE_OF_KIND = { google_ads: 'google_ads', gads_script: 'google_ads', rei: 'rei', ga4: 'ga4', calls: 'calls', pages: 'pages' };

/**
 * Import one file.
 * @param file     { name, text }  (XLSX is converted to CSV text by the caller)
 * @param options  { settings, kind (force a kind), by (user id), now }
 * @returns {Promise<{kind, label, part, warnings, errors, stats, mapping?, missing?, unmappedStatuses?}>}
 *   `part` is a partial dataset for mergeDataset(), or null when nothing was imported.
 */
export async function importFile({ name = '', text = '' }, { settings: rawSettings, kind: forced, by = '', mode = 'csv' } = {}) {
  const settings = rawSettings || {};
  const kind = forced || detectFileKind(name, text);
  const part = emptyDataset({ isDemo: false });
  const warnings = [];
  const errors = [];
  let stats = {};
  let extra = {};
  switch (kind) {
    case 'google_ads': {
      const r = parseGoogleAdsCsv(text);
      part.ads = r.ads;
      warnings.push(...r.warnings);
      stats = { reportType: r.reportType, rows: r.rowCount, period: r.period };
      break;
    }
    case 'gads_script': {
      const json = JSON.parse(text);
      part.ads = normalizeGaql(json.results || {});
      if (json.adCopy) part.ads.adCopy = json.adCopy;
      stats = { rows: Object.values(json.results || {}).reduce((a, l) => a + (Array.isArray(l) ? l.length : 0), 0), generatedAt: json.generatedAt || '' };
      if (json.warnings?.length) warnings.push(...json.warnings.slice(0, 10));
      break;
    }
    case 'rei': {
      const rows = parseCsv(text);
      const header = findHeaderRow(rows, Object.values(REI_COLUMNS).flat(), 3);
      const objects = rowsToObjects(rows, Math.max(0, header));
      const r = await normalizeReiRows(objects, {
        mapping: settings.rei?.mapping || {}, statusRules: statusRulesFrom(settings.rei?.statusMap), situations: settings.situations?.length ? settings.situations : undefined,
        qualifiedScoreMin: settings.rei?.qualifiedScoreMin ?? 7, sourceSystem: mode === 'crawler' ? 'rei_crawler' : 'rei_csv',
      });
      part.rei = { leads: r.leads, unmappedStatuses: r.unmappedStatuses };
      warnings.push(...r.warnings);
      stats = { rows: objects.length, leads: r.leads.length, skipped: objects.length - r.leads.length };
      extra = { mapping: r.mapping, missing: r.missing, unused: r.unused, unmappedStatuses: r.unmappedStatuses };
      break;
    }
    case 'ga4': {
      const r = parseGa4Csv(text);
      part.web.landingDaily = r.landingDaily;
      part.web.pagePaths = r.pagePaths;
      warnings.push(...r.warnings);
      stats = { report: r.kind, rows: r.landingDaily.length + r.pagePaths.length };
      break;
    }
    case 'calls': {
      const r = await parseCallsCsv(text);
      part.calls = r.calls;
      warnings.push(...r.warnings);
      stats = { rows: r.calls.length };
      break;
    }
    case 'pages': {
      const rows = parseCsv(text);
      const i = findHeaderRow(rows, Object.values(PAGE_COLUMNS).flat(), 2);
      const { mapping } = mapColumns(rows[i].map((h) => String(h).trim()), PAGE_COLUMNS);
      for (const o of rowsToObjects(rows, i)) {
        const url = String(o[mapping.url] || '').trim();
        if (!url) continue;
        part.web.pages.push({
          path: cleanPath(url), url, h1: String(o[mapping.h1] || '').trim(), title: String(o[mapping.title] || '').trim(),
          cta: String(o[mapping.cta] || '').trim(), ...(mapping.situation && o[mapping.situation] ? { situation: String(o[mapping.situation]).trim() } : {}),
        });
      }
      stats = { rows: part.web.pages.length };
      break;
    }
    case 'dataset': {
      const json = JSON.parse(text);
      const v = validateDataset(json);
      errors.push(...v.errors);
      warnings.push(...v.warnings);
      if (v.ok) {
        const ds = normalizeShape(json);
        if (ds.isDemo) warnings.push('This file is demo data. It replaces real data only if you confirm.');
        stats = { leads: ds.rei.leads.length, keywords: ds.ads.keywords.length, generatedAt: ds.generatedAt };
        return { kind, label: FILE_KINDS[kind], part: ds, warnings, errors, stats };
      }
      return { kind, label: FILE_KINDS[kind], part: null, warnings, errors, stats };
    }
    default:
      return {
        kind: 'unknown', label: FILE_KINDS.unknown, part: null, stats, warnings,
        errors: [`Could not tell what "${name || 'this file'}" is. Supported: Google Ads reports (keyword, search term, location, click), REI BlackBook exports, GA4 exports, call logs, a landing page list (URL, H1, CTA), or a dashboard sync file.`],
      };
  }
  const v = validateDataset(part);
  errors.push(...v.errors);
  const source = SOURCE_OF_KIND[kind];
  recordSync(part, {
    source, mode, status: errors.length ? 'failed' : warnings.length ? 'partial' : 'ok', by,
    created: stats.leads ?? stats.rows ?? 0, message: `${FILE_KINDS[kind]}: ${name || 'file'}${warnings.length ? ` (${warnings.length} warning${warnings.length === 1 ? '' : 's'})` : ''}`,
  });
  return { kind, label: FILE_KINDS[kind], part: errors.length ? null : part, warnings, errors, stats, ...extra };
}
