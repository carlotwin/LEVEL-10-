// Minimal .env loader (no dependency). Loads KEY=VALUE lines from a .env file
// in the project root into process.env, without overwriting existing vars.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export function loadEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

export const PROJECT_ROOT = ROOT;

// Load app settings (JSON) written by the in-app Settings panel, into
// process.env WITHOUT overwriting existing values (real env / .env win). This
// lets the packaged desktop app change mode/config without editing files or
// using a terminal. Location: <data dir>/settings.json.
export function loadSettings(dataDirPath) {
  try {
    const file = path.join(dataDirPath, 'settings.json');
    if (!fs.existsSync(file)) return;
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined) continue;
      if (!(k in process.env)) process.env[k] = String(v);
    }
  } catch {
    /* ignore malformed settings */
  }
}
