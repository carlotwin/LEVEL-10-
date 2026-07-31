// =============================================================================
// STAGE: READ-ONLY LIVE VERIFICATION against REI BlackBook.
//
//   npm run verify:live
//
// Walks the first FIVE spreadsheet rows and reports, per row, exactly what could
// and could not be read from the live account:
//
//   1. phone search by the normalized 10-digit number   -> rows returned?
//   2. search-result parsing                            -> name/address/phone?
//   3. opening the contact                              -> did it open?
//   4. detail-page reads                                -> phone, name, address, tag
//   5. the Opt In action + its success status            -> present?
//   6. the ProfitDial sender selector                   -> present?
//   7. the chosen sender number read back               -> NOT attempted (would
//                                                          modify the record)
//
// NO homeowner message is sent, no opt-in is performed, no number is selected and
// no tag is written. ALLOW_LIVE_SEND is forced false before the app boots, and
// loadenv.js never overwrites an existing variable, so this entry point cannot
// send regardless of what .env says.
// =============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SANDBOX = 'false';
process.env.WATCH_ONLY = 'true';
process.env.ALLOW_LIVE_SEND = 'false';
process.env.HEADLESS = 'false';
if (!process.env.SLOWMO_MS || process.env.SLOWMO_MS === '0') process.env.SLOWMO_MS = '400';

const { loadEnv } = await import('../server/loadenv.js');
loadEnv();

const missing = ['REIBB_LOGIN_URL', 'REIBB_EMAIL', 'REIBB_PASSWORD'].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`\n  Missing in .env: ${missing.join(', ')}\n`);
  process.exit(1);
}

const { env } = await import('../server/config/env.js');
const { ReiBlackBookAdapter } = await import('../server/adapters/reibb.js');
const { runReadOnlyVerification, summarize } = await import('../server/automation/verifyLive.js');
const { loadLevel10File, detectColumnsForRows } = await import('../server/data/spreadsheet.js');

// ---------------------------------------------------------------------------
// Locate the spreadsheet. A wrong path is the most common way this run dies, so
// an explicit path is validated and, failing that, the usual folders are searched
// for a Level 10 workbook. Never guesses between several matches.
// ---------------------------------------------------------------------------
function findSpreadsheet(explicit) {
  // cmd keeps stray quotes when a drag-and-drop is mixed with typing.
  const given = String(explicit ?? '').replace(/^["']+|["']+$/g, '').trim();
  if (given && fs.existsSync(given)) return { file: given, from: 'the path you gave' };

  const home = os.homedir();
  const dirs = [
    process.cwd(),
    path.join(process.cwd(), 'data'),
    path.join(home, 'Downloads'),
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
    path.join(home, 'OneDrive', 'Desktop'),
    path.join(home, 'OneDrive', 'Documents'),
    home,
  ];
  const hits = [];
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!/\.(xlsx|xlsm|xls|csv)$/i.test(n)) continue;
      if (!/level\s*-?\s*10|with\s*contacts/i.test(n)) continue;
      const full = path.join(dir, n);
      if (!hits.includes(full)) hits.push(full);
    }
  }
  return { file: null, hits, given };
}

const found = findSpreadsheet(process.argv[2]);
let file = found.file;
if (!file) {
  if (found.given) {
    console.error(`\n  That file does not exist:\n    ${found.given}\n`);
  }
  if (found.hits.length === 1) {
    file = found.hits[0];
    console.log(`\n  Using the Level 10 workbook found on this machine:\n    ${file}\n`);
  } else if (found.hits.length > 1) {
    console.error('  Several Level 10 workbooks found — pass the one you want:\n');
    for (const h of found.hits) console.error(`    npm run verify:live -- "${h}"`);
    console.error('');
    process.exit(1);
  } else {
    console.error('  No Level 10 workbook found in this folder, Downloads, Desktop or Documents.');
    console.error('  Pass the path explicitly — tip: type the command, then DRAG the .xlsx');
    console.error('  from File Explorer into this window to paste its full path:\n');
    console.error('    npm run verify:live -- "C:\\Users\\You\\Downloads\\Level 10 Properties with Contacts.xlsx"\n');
    process.exit(1);
  }
} else if (found.from) {
  console.log(`\n  Spreadsheet: ${file}\n`);
}

const sheet = loadLevel10File(file, {
  preferredTab: env.PD_SHEET_TAB,
  preferredCols: {
    profitDial: env.PD_COL_PROFITDIAL,
    address: env.PD_COL_ADDRESS,
    phone: env.PD_COL_PHONE,
    name: env.PD_COL_NAME,
    contactId: env.PD_COL_CONTACT_ID,
  },
});
const cols = sheet.cols;
const rows = sheet.rows.slice(0, 5);

console.log(`\n  READ-ONLY LIVE VERIFICATION — ${rows.length} record(s), nothing will be sent or changed.`);
console.log(`  Sheet: tab "${sheet.tab}", headers row ${sheet.headerRow}`);
console.log(`  Columns: name="${cols.name}" phone="${cols.phone}" address="${cols.address}" profitDial="${cols.profitDial}"\n`);

const adapter = new ReiBlackBookAdapter();
try {
  try {
    await adapter.init();
  } catch (e) {
    // A failed login or browser launch is a setup problem, not a finding.
    console.error(`\n  Could not open REI BlackBook: ${e.message}`);
    console.error('  Check REIBB_LOGIN_URL / REIBB_EMAIL / REIBB_PASSWORD in .env.');
    console.error('  If Chromium is missing, run: npx playwright install chromium\n');
    process.exit(1);
  }

  const line = (d) =>
    `           <${d.tag}${d.id ? ' id=' + d.id : ''}${d.cls ? ' class=' + d.cls : ''}` +
    `${d.role ? ' role=' + d.role : ''}${d.aria ? ' aria-label="' + d.aria + '"' : ''}` +
    `${d.testid ? ' data-testid=' + d.testid : ''}${d.href ? ' href="' + d.href + '"' : ''}> ${d.text}`;

  const findings = await runReadOnlyVerification({
    adapter,
    rows: sheet.rows,
    cols,
    limit: 5,
    level10Tag: env.LEVEL10_TAG,
    onRow: (f) => {
      console.log(`\n  ─── ${f.row}  ${f.sheet.name} · ${f.sheet.phone}`);
      console.log(`      1. phone search : ${f.searchStatus} (${f.searchTrail || 'no attempts'})`);
      console.log(`      2. row parsing  : ${f.candidates.length} candidate(s) ${JSON.stringify(f.candidates)}`);
      if (f.stage) console.log(`         stage        : ${f.stage}`);
      console.log(`         decision     : ${f.decision} — ${f.decisionReason}`);
      if (f.opened) {
        console.log(`      3. open contact : opened (REI id ${f.detail?.contactId || '?'})`);
        console.log(`      4. detail reads : name="${f.detail?.name || '(blank)'}" phones=${JSON.stringify(f.detail?.phones || [])}`);
        console.log(`                        address="${f.detail?.address || '(blank)'}" tags=${JSON.stringify(f.detail?.tags || [])}`);
        console.log(`         re-verify    : ${f.reverify} ${JSON.stringify(f.reverifyFlags || {})}`);
        console.log(`      5. opt-in       : control ${f.optInAvailable ? 'FOUND' : 'not found'}, smsEnabled=${f.smsEnabled}${f.optInRaw ? ` ("${f.optInRaw}")` : ''}`);
        console.log(`      6. sender select: ${f.senderSelectorAvailable ? 'FOUND' : 'not found'}, ${f.sendersVisible.length} number(s), assigned ${f.sheet.profitDial} present: ${f.assignedSenderPresent}`);
        console.log('      7. read-back    : SKIPPED — selecting a sender changes the record');
      } else if (f.decision === 'CONTACT_VERIFIED') {
        console.log(`      3. open contact : FAILED — ${f.openReason || 'unknown'}`);
      }
      if (f.probe) {
        console.log('\n         ── DETAIL PAGE PROBE (read-only) ──');
        console.log(`         url: ${f.probe.url}`);
        console.log(`         title: ${f.probe.title || '(none)'}`);
        console.log('         headings:');
        (f.probe.headings || []).forEach((d) => console.log(line(d)));
        console.log('         elements containing the expected NAME:');
        (f.probe.nameHits || []).forEach((d) => console.log(line(d)));
        console.log('         elements containing the expected ADDRESS:');
        (f.probe.addressHits || []).forEach((d) => console.log(line(d)));
        console.log('         largest visible text:');
        (f.probe.biggest || []).forEach((d) => console.log(`${line(d)}   [${d.size}px]`));
        if (f.probe.html) console.log(`         page saved: ${f.probe.html}`);
      }
      if (f.error) console.log(`         ERROR: ${f.error}`);
    },
  });

  const s = summarize(findings);
  console.log('\n\n  ══ SUMMARY ══');
  console.log('  row  search                       cands  opened  re-verify                  optIn  sender');
  for (const f of findings) {
    console.log(
      `  ${String(f.row).padEnd(4)} ${String(f.searchStatus || '—').padEnd(28)} ${String(f.candidates.length).padEnd(6)} ` +
        `${(f.opened ? 'yes' : 'NO').padEnd(7)} ${String(f.reverify || '—').padEnd(26)} ` +
        `${(f.optInAvailable ? 'yes' : 'NO').padEnd(6)} ${f.senderSelectorAvailable ? 'yes' : 'NO'}`
    );
  }
  console.log(`\n  search returned rows : ${s.searchReturnedRows}/${s.rows}`);
  console.log(`  contacts verified    : ${s.contactsVerified}`);
  console.log(`  manual review        : ${s.manualReview}   name mismatches: ${s.nameMismatches}`);
  console.log(`  opt-in control found : ${s.optInControlFound}/${s.opened}`);
  console.log(`  sender selector found: ${s.senderSelectorFound}/${s.opened}   assigned number listed: ${s.assignedSenderPresent}`);
  console.log(`  WRITE ACTIONS        : ${s.writeActionsAttempted}`);
  console.log('  No message was sent. No opt-in performed. No sender selected. No tag written.\n');
} finally {
  await adapter.close();
}
