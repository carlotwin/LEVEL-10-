// Writes build-info.json at build time so the packaged app can show exactly
// which code it was built from (the packaged app has no .git to read live).
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const info = {
  version: pkg.version || '',
  commit: git('rev-parse --short HEAD') || 'unknown',
  builtAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(root, 'build-info.json'), JSON.stringify(info, null, 2));
console.log(`build-info.json written: ${info.commit}`);
