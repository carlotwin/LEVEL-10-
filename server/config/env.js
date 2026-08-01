// =============================================================================
// Hard environment guards.
//
// This module is the single authority on "are we allowed to do the irreversible
// thing?". It encodes requirement #9:
//
//   - SANDBOX=true  must NEVER call a real REI adapter.
//   - SANDBOX=false must NOT run until the live adapter is implemented.
//   - ALLOW_LIVE_SEND=false must prevent the irreversible send action.
//   - Changing only ONE environment variable must never accidentally activate
//     real texting.
//
// The gates are INDEPENDENT and compose by AND. No single flag turns on real
// texting. Every gate defaults to the safe value.
// =============================================================================

// Bootstrap config BEFORE reading any values, so .env and the app's
// settings.json take effect regardless of module import order. Real environment
// variables win, then .env, then settings.json.
import { loadEnv, loadSettings } from '../loadenv.js';
import { dataDir } from '../data/paths.js';
loadEnv();
loadSettings(dataDir());

function readBool(name, def = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  // Intentionally strict: only the exact string "true" is truthy.
  return String(raw).trim() === 'true';
}

function readInt(name, def) {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : def;
}

export const env = Object.freeze({
  // --- mode ---
  SANDBOX: readBool('SANDBOX', true), // defaults to sandbox
  ALLOW_LIVE_SEND: readBool('ALLOW_LIVE_SEND', false), // defaults off
  WATCH_ONLY: readBool('WATCH_ONLY', false), // navigate + read + match, never send
  REQUIRE_OPTIN: readBool('REQUIRE_OPTIN', true), // SOP Step 4; off = REI app skips it
  REQUIRE_PROFITDIAL: readBool('REQUIRE_PROFITDIAL', true), // SOP Step 5/6; off = REI sends from default number
  HEADLESS: readBool('HEADLESS', false),
  MAX_SENDS_PER_RUN: readInt('MAX_SENDS_PER_RUN', 10),
  // First-production-test pilot cap: pause after this many leads are
  // ATTEMPTED (any outcome, not just sends) so a new upload can be verified a
  // handful of contacts at a time before running the whole file. 0 = off.
  PILOT_BATCH_LIMIT: readInt('PILOT_BATCH_LIMIT', 0),
  PORT: readInt('PORT', 3000),

  // --- campaign ---
  CAMPAIGN_BATCH: process.env.CAMPAIGN_BATCH || 'level-10-default',
  LEVEL10_TAG: process.env.LEVEL10_TAG || 'Level 10 Properties',
  TEXT_STATES: (process.env.TEXT_STATES || 'CA,California')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),

  // --- ProfitDial sheet header mapping (confirmed real headers) ---
  PD_SHEET_TAB: process.env.PD_SHEET_TAB || 'With Contacts',
  PD_COL_PROFITDIAL: process.env.PD_COL_PROFITDIAL || 'Profit Dial',
  PD_COL_ADDRESS: process.env.PD_COL_ADDRESS || 'Full Address',
  PD_COL_PHONE: process.env.PD_COL_PHONE || 'Primary Phone',
  PD_COL_NAME: process.env.PD_COL_NAME || 'Primary Name',
  PD_COL_CONTACT_ID: process.env.PD_COL_CONTACT_ID || '', // empty = disabled

  // --- live adapter (unused in sandbox) ---
  REIBB_LOGIN_URL: process.env.REIBB_LOGIN_URL || '',
  ACTION_TIMEOUT_MS: readInt('ACTION_TIMEOUT_MS', 15000),
});

/**
 * Which adapter mode we run in. This is derived ONLY from SANDBOX and is the
 * single place the engine/server asks "sandbox or live?".
 */
export function adapterMode() {
  return env.SANDBOX ? 'sandbox' : 'live';
}

/**
 * Gate 1 (mode): may we even start a run in the requested mode?
 * - Sandbox always allowed.
 * - Live requires the live adapter to exist (it does not in this build), so
 *   this returns a blocking reason. The engine calls assertRunnable() at boot.
 */
export function runnableReason() {
  if (env.SANDBOX) return null; // sandbox is always runnable
  // SANDBOX=false: live mode. The Playwright adapter exists, but it needs REI
  // BlackBook credentials/URL configured before it can log in. Until then, live
  // mode is refused. (Note: running live still cannot SEND unless the separate
  // liveSendGate passes — ALLOW_LIVE_SEND=true and no placeholder templates.)
  if (!env.REIBB_LOGIN_URL) {
    return (
      'SANDBOX=false but REIBB_LOGIN_URL (and REIBB_EMAIL/REIBB_PASSWORD) are not ' +
      'configured. Set them in .env, verify config/reibb.selectors.json against ' +
      'your account, then retry. Keep SANDBOX=true until you are ready.'
    );
  }
  return null;
}

export function assertRunnable() {
  const reason = runnableReason();
  if (reason) {
    const err = new Error(reason);
    err.code = 'RUN_MODE_BLOCKED';
    throw err;
  }
}

/**
 * Gate 4 (irreversible send): the FINAL check performed at the moment of a send.
 * Returns { allowed, reason }. Never throws — callers decide what to do.
 *
 * The four independent conditions:
 *   (a) ALLOW_LIVE_SEND must be exactly "true".
 *   (b) In live mode (SANDBOX=false) a working live adapter must exist.
 *   (c) In live mode, no placeholder/test template may be enabled (checked by
 *       the caller passing `placeholderEnabled`), per requirement #3.
 *   (d) Sandbox sends are always simulated — never irreversible — so a sandbox
 *       "send" is allowed regardless of ALLOW_LIVE_SEND (it texts nobody).
 *
 * NOTE ON (d): We DO gate the *simulated* send behind a separate check in the
 * engine so the UI can show "would not have sent" states, but a sandbox send is
 * physically incapable of reaching a carrier.
 */
export function liveSendGate({ placeholderEnabled } = {}) {
  // Sandbox: no carrier is ever contacted. Simulated send is safe by construction.
  if (env.SANDBOX) {
    return { allowed: true, simulated: true, reason: 'Passed all checks — not sent (Test Mode)' };
  }

  // Live mode from here down. ALL must pass.
  if (!env.ALLOW_LIVE_SEND) {
    return { allowed: false, simulated: false, reason: 'ALLOW_LIVE_SEND is not "true" — irreversible send blocked' };
  }
  // Live mode must be runnable (credentials configured).
  const runBlock = runnableReason();
  if (runBlock) {
    return { allowed: false, simulated: false, reason: runBlock };
  }
  if (placeholderEnabled) {
    return {
      allowed: false,
      simulated: false,
      reason:
        'A placeholder/test template is still enabled. Live sending is refused ' +
        "until Cherry's approved templates are installed and checksums regenerated.",
    };
  }
  return { allowed: true, simulated: false, reason: 'live send permitted' };
}
