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
const { chooseContact, verifyOpenedContact } = await import('../server/automation/contactMatch.js');
const { loadLevel10File, detectColumnsForRows } = await import('../server/data/spreadsheet.js');

const file = process.argv[2];
if (!file) {
  console.error('\n  Usage: npm run verify:live -- "C:\\path\\to\\Level 10 Properties with Contacts.xlsx"\n');
  process.exit(1);
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
const findings = [];
try {
  await adapter.init();

  for (const [i, row] of rows.entries()) {
    const sheetRow = {
      name: String(row[cols.name] ?? '').trim(),
      phone: String(row[cols.phone] ?? '').trim(),
      address: String(row[cols.address] ?? '').trim(),
    };
    const f = { row: i + 1, sheet: sheetRow };
    console.log(`\n  ─── ${i + 1}/${rows.length}  ${sheetRow.name} · ${sheetRow.phone}`);

    // 1 + 2. Phone search and result parsing.
    const search = await adapter.findContact(sheetRow);
    f.searchStatus = search.status;
    f.candidateCount = (search.candidates || []).length;
    f.searchTrail = (search.searched || []).join(' → ');
    f.parsedCandidates = (search.candidates || []).map((c) => ({ name: c.name, phone: c.phone, address: c.address }));
    console.log(`      1. phone search : ${f.searchStatus} (${f.searchTrail || 'no attempts'})`);
    console.log(`      2. row parsing  : ${f.candidateCount} candidate(s) ${JSON.stringify(f.parsedCandidates)}`);
    if (search.stage) console.log(`         stage        : ${search.stage}`);
    if (search.screenshot) console.log(`         screenshot   : ${search.screenshot}`);

    const decision = chooseContact({ sheet: sheetRow, candidates: search.candidates || [] });
    f.decision = decision.status;
    f.decisionReason = decision.reason;
    console.log(`         decision     : ${decision.status} — ${decision.reason}`);
    if (!decision.chosen) {
      findings.push(f);
      continue;
    }

    // 3. Open the contact.
    const opened = await adapter.openContact(decision.chosen);
    f.opened = Boolean(opened.opened);
    console.log(`      3. open contact : ${f.opened ? 'opened' : `FAILED — ${opened.reason}`}`);
    if (!opened.opened) {
      findings.push(f);
      continue;
    }

    // 4. Detail-page reads.
    const detail = await adapter.readContactFacts(opened.contactId);
    f.detail = {
      name: detail.name || '(blank)',
      phones: detail.phones || [],
      address: detail.address || '(blank)',
      tags: detail.tags || [],
      url: detail.reiUrl || '',
    };
    const recheck = verifyOpenedContact({ sheet: sheetRow, detail, level10Tag: env.LEVEL10_TAG });
    f.reverify = recheck.status;
    f.reverifyFlags = recheck.flags;
    console.log(`      4. detail reads : name="${f.detail.name}" phones=${JSON.stringify(f.detail.phones)}`);
    console.log(`                        address="${f.detail.address}" tags=${JSON.stringify(f.detail.tags)}`);
    console.log(`         re-verify    : ${recheck.status} ${JSON.stringify(recheck.flags)}`);

    // 5. Opt In control — located only, never clicked.
    f.optInAvailable = await adapter.optInAvailable(opened.contactId);
    const sms = await adapter.getSmsStatus(opened.contactId);
    f.smsEnabled = sms?.smsEnabled === true;
    console.log(`      5. opt-in       : control ${f.optInAvailable ? 'FOUND' : 'not found'}, status reads smsEnabled=${f.smsEnabled}`);

    // 6. ProfitDial sender selector — located only, never selected.
    await adapter.openChatTab?.();
    f.senderSelectorAvailable = await adapter.profitDialSelectorAvailable(opened.contactId);
    f.sendersVisible = await adapter.getProfitDialNumbers(opened.contactId).catch(() => []);
    console.log(`      6. sender select: ${f.senderSelectorAvailable ? 'FOUND' : 'not found'}, numbers read: ${JSON.stringify(f.sendersVisible)}`);

    // 7. Read-back requires selecting a number, which modifies the record.
    console.log('      7. read-back    : SKIPPED — selecting a sender changes the record; not done in a read-only run');

    findings.push(f);
  }
} finally {
  await adapter.close();
}

// ---- summary ---------------------------------------------------------------
const yes = (b) => (b ? 'yes' : 'NO');
console.log('\n\n  ══ SUMMARY ══');
console.log('  row  search                       candidates  opened  re-verify                  optIn  sender');
for (const f of findings) {
  console.log(
    `  ${String(f.row).padEnd(4)} ${String(f.searchStatus).padEnd(28)} ${String(f.candidateCount ?? 0).padEnd(11)} ` +
      `${yes(f.opened).padEnd(7)} ${String(f.reverify || '—').padEnd(26)} ${yes(f.optInAvailable).padEnd(6)} ${yes(f.senderSelectorAvailable)}`
  );
}
const searched = findings.filter((f) => f.candidateCount > 0).length;
console.log(`\n  Phone search returned rows for ${searched}/${findings.length} record(s).`);
console.log('  No message was sent. No opt-in performed. No sender selected. No tag written.\n');
