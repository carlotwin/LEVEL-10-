// =============================================================================
// READ-ONLY LIVE VERIFICATION — shared by the dashboard button and the CLI.
//
// Walks spreadsheet rows against the real REI BlackBook account and reports, per
// row, exactly which step succeeded:
//
//   1. phone search            -> did REI return rows?
//   2. candidate parsing       -> name / phone / address readable?
//   3. the decision            -> chooseContact() on those candidates
//   4. open + re-verify        -> the record's own phone, name, address, tag
//   5. opt-in control          -> present? current status?
//   6. ProfitDial sender       -> selector present? numbers readable?
//
// It calls ONLY read methods. optInPhone, selectProfitDial, enterMessage and
// sendMessage are never invoked from here, so no REI record can change: that is
// what makes it safe to expose as a dashboard button.
// =============================================================================
import { chooseContact, verifyOpenedContact } from './contactMatch.js';
import { L10_STATUS } from './constants.js';
import { normalizePhone } from './sop.js';

/** Build the { phone, name, nameCandidates, address, profitDial } view of a row. */
export function sheetRowFor(row, cols) {
  const val = (col) => (col ? String(row[col] ?? '').trim() : '');
  const name = val(cols.name) || String(row['Owner'] ?? '').trim();
  const first = val(cols.firstName) || String(row['First Name'] ?? '').trim();
  const last = String(row['Last Name'] ?? '').trim();
  const owner = String(row['Owner'] ?? '').trim();
  return {
    name,
    // Primary Name is skip-traced and can disagree with the county record.
    nameCandidates: [...new Set([name, owner, [first, last].filter(Boolean).join(' ')].filter(Boolean))],
    phone: val(cols.phone),
    address: val(cols.address),
    profitDial: val(cols.profitDial),
  };
}

/**
 * @param {object} p
 * @param {object} p.adapter       a live REI adapter (already init'd)
 * @param {Array<object>} p.rows   spreadsheet rows
 * @param {object} p.cols          detected column mapping
 * @param {number} p.limit         how many rows to verify
 * @param {string} p.level10Tag    the tag that must be present
 * @param {(f:object)=>void} [p.onRow]  called as each row finishes (for SSE)
 * @returns {Promise<Array<object>>} one finding per row
 */
export async function runReadOnlyVerification({ adapter, rows, cols, limit = 5, level10Tag, onRow }) {
  const findings = [];
  const slice = rows.slice(0, Math.max(1, limit));

  for (const [i, row] of slice.entries()) {
    const sheet = sheetRowFor(row, cols);
    const f = {
      row: i + 1,
      sheet,
      normalizedPhone: normalizePhone(sheet.phone),
      searchStatus: '',
      searchTrail: '',
      candidates: [],
      decision: '',
      decisionReason: '',
      opened: false,
      detail: null,
      reverify: '',
      reverifyFlags: null,
      optInAvailable: false,
      smsEnabled: false,
      senderSelectorAvailable: false,
      sendersVisible: [],
      assignedSenderPresent: null,
      probe: null,
      writeActions: 0, // always 0 — this routine calls no write method
    };

    try {
      // 1 + 2. Phone search and candidate parsing.
      const search = await adapter.findContact(sheet);
      f.searchStatus = search.status || '';
      f.searchTrail = (search.searched || []).join(' → ');
      f.candidates = (search.candidates || []).map((c) => ({
        name: c.name,
        phone: c.phone,
        address: c.address,
        contactId: c.contactId || '',
      }));
      f.stage = search.stage || '';
      f.screenshot = search.screenshot || '';

      // 3. The decision.
      const decision = chooseContact({ sheet, candidates: search.candidates || [] });
      f.decision = decision.status;
      f.decisionReason = decision.reason;

      if (decision.chosen) {
        // 4. Open and re-verify against the record itself.
        const opened = await adapter.openContact(decision.chosen);
        f.opened = Boolean(opened.opened);
        f.openReason = opened.reason || '';
        if (opened.opened) {
          const detail = await adapter.readContactFacts(opened.contactId);
          f.detail = {
            contactId: detail.contactId || '',
            name: detail.name || '',
            phones: detail.phones || [],
            address: detail.address || '',
            state: detail.state || '',
            tags: detail.tags || [],
            url: detail.reiUrl || '',
          };
          const recheck = verifyOpenedContact({ sheet, detail, level10Tag });
          f.reverify = recheck.status;
          f.reverifyFlags = recheck.flags;
          f.reverifyReason = recheck.reason;

          // 5. Opt-in: located and read only. Never clicked.
          f.optInAvailable = Boolean(await adapter.optInAvailable?.(opened.contactId));
          const sms = await adapter.getSmsStatus?.(opened.contactId);
          f.smsEnabled = sms?.smsEnabled === true;
          f.optInRaw = sms?.raw || '';

          // 6. ProfitDial sender: located and listed only. Never selected.
          f.senderSelectorAvailable = Boolean(await adapter.profitDialSelectorAvailable?.(opened.contactId));
          f.sendersVisible = (await adapter.getProfitDialNumbers?.(opened.contactId)) || [];
          const want = normalizePhone(sheet.profitDial);
          f.assignedSenderPresent = want ? f.sendersVisible.some((n) => normalizePhone(n) === want) : null;

          // Probe the page when the record could not be read, so the correct
          // selectors can be written from evidence rather than guessed.
          if (recheck.status !== L10_STATUS.CONTACT_VERIFIED && adapter.probeContactPage) {
            f.probe = await adapter.probeContactPage(`row${i + 1}-${f.normalizedPhone}`, {
              name: search.candidates?.[0]?.name || sheet.name,
              address: search.candidates?.[0]?.address || sheet.address,
            });
          }
        }
      }
    } catch (e) {
      f.error = e.message;
    }

    findings.push(f);
    onRow?.(f);
  }

  return findings;
}

/** Roll the findings up into the counts the report asks for. */
export function summarize(findings) {
  const is = (f, s) => f.searchStatus === s;
  return {
    rows: findings.length,
    searchReturnedRows: findings.filter((f) => (f.candidates || []).length > 0).length,
    noContactFound: findings.filter((f) => is(f, L10_STATUS.NO_CONTACT_FOUND_BY_PHONE)).length,
    multipleContacts: findings.filter((f) => is(f, L10_STATUS.MULTIPLE_CONTACTS_FOUND)).length,
    contactsVerified: findings.filter((f) => f.reverify === L10_STATUS.CONTACT_VERIFIED).length,
    nameMismatches: findings.filter((f) => f.decision === L10_STATUS.PHONE_MATCH_NAME_MISMATCH).length,
    manualReview: findings.filter((f) =>
      [L10_STATUS.MANUAL_REVIEW_REQUIRED, L10_STATUS.MULTIPLE_CONTACTS_MANUAL_REVIEW].includes(f.decision)
    ).length,
    missingTag: findings.filter((f) => f.reverify === L10_STATUS.LEVEL_10_TAG_MISSING).length,
    opened: findings.filter((f) => f.opened).length,
    optInControlFound: findings.filter((f) => f.optInAvailable).length,
    senderSelectorFound: findings.filter((f) => f.senderSelectorAvailable).length,
    assignedSenderPresent: findings.filter((f) => f.assignedSenderPresent === true).length,
    parsingFailures: findings.filter((f) => (f.candidates || []).length > 0 && !f.candidates.some((c) => c.name)).length,
    // Nothing here can write, so this is structurally zero.
    writeActionsAttempted: 0,
  };
}
