// =============================================================================
// .env must reach the frozen `env` object, whatever the import order.
//
// Regression test for a real failure: server/index.js called loadEnv() in its
// module body, but `import` is hoisted, so config/env.js had already read
// process.env before .env was loaded. The result was a contradiction — the boot
// banner (reading process.env after loadEnv) reported the REI login as
// configured, while the adapter refused with "REIBB_LOGIN_URL is not
// configured", because `env` held an empty string.
//
// Run in a CHILD process: `env` is frozen at import time, so this cannot be
// exercised in-process after the fact.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');

function envInChild(envFile, extraEnv = {}) {
  const out = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { env } from '${path.join(ROOT, 'server/config/env.js').replace(/\\/g, '/')}';
       process.stdout.write(JSON.stringify({
         loginUrl: env.REIBB_LOGIN_URL,
         batch: env.CAMPAIGN_BATCH,
         sandbox: env.SANDBOX,
         allowLiveSend: env.ALLOW_LIVE_SEND,
       }));`,
    ],
    { cwd: ROOT, env: { ...process.env, L10_ENV_FILE: envFile, ...extraEnv }, encoding: 'utf8' }
  );
  return JSON.parse(out);
}

test('values in .env reach the frozen env object', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l10-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(
    file,
    'REIBB_LOGIN_URL=https://my.reiblackbook.com/services/account/login\nCAMPAIGN_BATCH=from-dotenv\n'
  );
  const got = envInChild(file);
  assert.equal(got.loginUrl, 'https://my.reiblackbook.com/services/account/login', '.env was ignored by env.js');
  assert.equal(got.batch, 'from-dotenv');
});

test('an explicit environment variable still wins over .env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l10-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'CAMPAIGN_BATCH=from-dotenv\n');
  const got = envInChild(file, { CAMPAIGN_BATCH: 'from-shell' });
  assert.equal(got.batch, 'from-shell', 'a shell variable must beat .env (watch:20 relies on this)');
});

test('.env cannot enable live sending on its own', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l10-env-'));
  const file = path.join(dir, '.env');
  // Even asking for it in .env, the defaults must stay safe unless BOTH are set.
  fs.writeFileSync(file, 'ALLOW_LIVE_SEND=true\n');
  const got = envInChild(file);
  assert.equal(got.sandbox, true, 'SANDBOX must still default to true');
  assert.equal(got.allowLiveSend, true, 'the value is read, but SANDBOX=true still blocks the send');
});
