// =============================================================================
// FIRST LIVE CHECK — watch the bot read 20 real leads. It cannot text.
//
//   npm run watch:20
//
// What this does: logs into REI BlackBook with your .env credentials, filters
// the Level 10 tag, opens each contact, reads the name/phone/tags, and matches
// the assigned ProfitDial number from your uploaded sheet. Then it stops and
// reports. It never opts a number in, never picks a from-number, never sends.
//
// Why a script instead of editing .env: these values are forced into
// process.env BEFORE the app boots, and server/loadenv.js never overwrites an
// existing variable. So ALLOW_LIVE_SEND=false here WINS even if your .env says
// true. You cannot accidentally send from this entry point.
//
// When the watch run looks right, THEN go live deliberately (see README).
// =============================================================================

// Live browser, but read-only.
process.env.SANDBOX = 'false'; // use the real REI adapter
process.env.WATCH_ONLY = 'true'; // navigate + read + match only
process.env.ALLOW_LIVE_SEND = 'false'; // hard block on the irreversible action

// Watch it work: visible browser, slowed down enough to follow.
process.env.HEADLESS = 'false';
if (!process.env.SLOWMO_MS || process.env.SLOWMO_MS === '0') process.env.SLOWMO_MS = '500';

// First 20 leads only.
process.env.MAX_SENDS_PER_RUN = '20';

const { loadEnv } = await import('../server/loadenv.js');
loadEnv(); // credentials + campaign settings from .env (never overrides the above)

const missing = ['REIBB_LOGIN_URL', 'REIBB_EMAIL', 'REIBB_PASSWORD'].filter((k) => !process.env[k]);
if (missing.length) {
  console.error('\n  Cannot start the watch run — missing in .env: ' + missing.join(', '));
  console.error('  Copy .env.example to .env and fill in your REI BlackBook login.\n');
  process.exit(1);
}

console.log('\n  WATCH-ONLY run — live REI BlackBook, nothing can be sent.');
console.log('  Reads and matches the first 20 leads. No opt-in, no send.');
console.log('  Upload your sheet in the dashboard with the limit set to 20, then press Start.\n');

await import('../server/index.js');
