// Local files the agent keeps under data/ppc (git-ignored):
//   dataset.json   the merged dataset (no names, phones, emails or addresses)
//   state.json     sync cursors, crawler bookkeeping, alerts already sent
//   settings.json  optional: the dashboard's settings (Settings → Download)
//   rei-session.enc  the encrypted REI sign-in, only if REI_PERSIST_SESSION=true
// and writes the dashboard's sync file (twin-ppc-bundle.json) to PPC_BUNDLE_DIR.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { emptyDataset, normalizeShape, validateDataset } from '../engine/index.js';

function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}
function readJson(file, fallback) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
}

export function createStore(cfg) {
  const files = {
    dataset: path.join(cfg.dataDir, 'dataset.json'),
    state: path.join(cfg.dataDir, 'state.json'),
    session: path.join(cfg.dataDir, 'rei-session.enc'),
    bundle: path.join(cfg.bundleDir, cfg.bundleName),
  };
  return {
    files,
    loadDataset() {
      const ds = readJson(files.dataset, null);
      return ds ? normalizeShape(ds) : emptyDataset({ isDemo: false });
    },
    /** Saves only a dataset that passes the privacy check. */
    saveDataset(ds) {
      const v = validateDataset(ds);
      if (!v.ok) throw Object.assign(new Error(`Dataset not saved: ${v.errors.join(' ')}`), { code: 'DATASET_INVALID' });
      writeAtomic(files.dataset, JSON.stringify(ds));
      return files.dataset;
    },
    writeBundle(ds) {
      const v = validateDataset(ds);
      if (!v.ok) throw Object.assign(new Error(`Sync file not written: ${v.errors.join(' ')}`), { code: 'DATASET_INVALID' });
      writeAtomic(files.bundle, JSON.stringify({ ...ds, generatedAt: new Date().toISOString(), isDemo: false }));
      return files.bundle;
    },
    loadState() {
      const st = readJson(files.state, {});
      return {
        ads: { lastSyncedThrough: null, ...(st.ads || {}) },
        ga4: { lastSyncedThrough: null, ...(st.ga4 || {}) },
        rei: { lastExportFile: null, lastExportMtime: 0, consecutiveFailures: 0, mode: 'auto', crawl: {}, ...(st.rei || {}) },
        pages: { lastScanAt: null, ...(st.pages || {}) },
        alerts: { sent: {}, ...(st.alerts || {}) },
      };
    },
    saveState(state) {
      writeAtomic(files.state, JSON.stringify(state, null, 2));
    },
    loadSettings() {
      return readJson(cfg.settingsFile, {}) || {};
    },
  };
}
