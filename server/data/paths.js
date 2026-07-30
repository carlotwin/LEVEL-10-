// Central writable-path resolution. All runtime data (job state, ledger, logs,
// uploads) lives under a single git-ignored directory so real PII never lands
// in the repo.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// Allow override (e.g. Electron user-data dir) via REVIVAL_DATA_DIR-style var.
const BASE = process.env.LEVEL10_DATA_DIR || path.join(ROOT, 'data');

function ensure(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function dataDir() {
  return ensure(BASE);
}
export function uploadsDir() {
  return ensure(path.join(BASE, 'uploads'));
}
export function statePath() {
  return path.join(dataDir(), 'job-state.json');
}
export function ledgerPath() {
  return path.join(dataDir(), 'campaign-ledger.json');
}
export const PROJECT_ROOT = ROOT;
