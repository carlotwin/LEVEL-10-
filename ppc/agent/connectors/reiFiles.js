// REI BlackBook through files: the safest path, and the crawler's fallback.
//   * an exports folder (PPC_REI_EXPORT_DIR): the newest CSV/XLSX export is
//     imported when it is newer than the last one imported;
//   * a Google Sheet (PPC_REI_SHEET_ID / PPC_REI_SHEET_GID) the team keeps
//     REI leads in, shared "anyone with the link can view".
// Both run through the same importer as the dashboard (personal details are
// hashed and never stored).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { importFile, normalizeReiRows, statusRulesFrom } from '../../engine/index.js';
import { fetchGoogleSheetRows } from '../../../server/data/googleSheet.js';
import { SourceError } from './googleAds.js';

const EXPORT_RE = /\.(csv|xlsx|xls|txt)$/i;

export function fileToText(file) {
  if (/\.xlsx?$/i.test(file)) {
    const wb = XLSX.read(readFileSync(file), { type: 'buffer' });
    return XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]], { blankrows: false });
  }
  return readFileSync(file, 'utf8');
}

/** Newest export file in the folder, or null. */
export function newestExport(dir) {
  let best = null;
  for (const name of readdirSync(dir)) {
    if (!EXPORT_RE.test(name) || name.startsWith('~$')) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { file: full, name, mtimeMs: st.mtimeMs };
  }
  return best;
}

export async function importReiExportFolder(cfg, state, { settings = {} } = {}) {
  let latest;
  try {
    latest = newestExport(cfg.exportDir);
  } catch {
    throw new SourceError(`The REI exports folder cannot be read: ${cfg.exportDir}`, { code: 'NOT_FOUND', step: 'rei.exports' });
  }
  if (!latest) return { part: null, message: 'No REI export file in the folder yet.' };
  if (latest.file === state.lastExportFile && latest.mtimeMs <= state.lastExportMtime) return { part: null, message: `No new REI export (latest: ${latest.name}).` };
  const r = await importFile({ name: latest.name, text: fileToText(latest.file) }, { settings, kind: 'rei', mode: 'csv' });
  if (!r.part) throw new SourceError(`REI export ${latest.name} could not be imported: ${r.errors.join(' ')}`, { code: 'BAD_FILE', step: 'rei.exports' });
  state.lastExportFile = latest.file;
  state.lastExportMtime = latest.mtimeMs;
  return { part: r.part, message: `Imported ${latest.name}: ${r.stats.leads} leads`, warnings: r.warnings, stats: r.stats };
}

export async function importReiSheet(cfg, { settings = {}, fetchRows = fetchGoogleSheetRows } = {}) {
  let rows;
  try {
    ({ rows } = await fetchRows({ sheetId: cfg.sheetId, gid: cfg.sheetGid }));
  } catch (e) {
    throw new SourceError(e.code === 'SHEET_PRIVATE'
      ? 'The REI Google Sheet is private. Share it "Anyone with the link → Viewer", or import it from the dashboard with your Google Drive connection.'
      : `The REI Google Sheet could not be read: ${e.message}`, { code: e.code || 'SHEET_FETCH_FAILED', step: 'rei.sheet' });
  }
  const r = await normalizeReiRows(rows, {
    mapping: settings.rei?.mapping || {}, statusRules: statusRulesFrom(settings.rei?.statusMap), situations: settings.situations?.length ? settings.situations : undefined,
    qualifiedScoreMin: settings.rei?.qualifiedScoreMin ?? 7, sourceSystem: 'rei_sheet',
  });
  return {
    part: { rei: { leads: r.leads, unmappedStatuses: r.unmappedStatuses } },
    message: `Google Sheet: ${r.leads.length} leads`, warnings: r.warnings, stats: { rows: rows.length, leads: r.leads.length },
  };
}
