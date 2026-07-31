// =============================================================================
// Express server: REST API + Server-Sent Events + static dashboard.
// =============================================================================
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './loadenv.js';
loadEnv();

import { env, assertNoDisabledGates } from './config/env.js';
import { Engine } from './automation/engine.js';
import { buildKpi } from './data/kpi.js';
import { templatePoolSummary, anyPlaceholderEnabled, EXPECTED_CHECKSUM } from './automation/message.js';
import { analyzeSheet } from './automation/profitdial.js';
import {
  importContacts,
  readTabFromFile,
  exportResults,
  loadLevel10File,
  detectColumnsForRows,
} from './data/spreadsheet.js';
import { fetchGoogleSheetRows, parseSheetUrl } from './data/googleSheet.js';
import { logger } from './logger.js';
import { uploadsDir } from './data/paths.js';
import { CONTACTS, PROFITDIAL_ROWS, PD_COLS } from '../config/sandbox/seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC));

const upload = multer({ dest: uploadsDir() });
const engine = new Engine();

// Hold the last-loaded original rows for export.
let lastOriginalRows = [];

// ---- SSE ----
const clients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}
for (const ev of ['state', 'row', 'done', 'error', 'batch-cap']) {
  engine.on(ev, (data) => broadcast(ev, data ?? engine.snapshot()));
}

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write(`event: state\ndata: ${JSON.stringify(engine.snapshot())}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// ---- Config / safety banner ----
app.get('/api/config', (req, res) => {
  res.json({
    mode: env.SANDBOX ? 'sandbox' : 'live',
    sandbox: env.SANDBOX,
    watchOnly: env.WATCH_ONLY,
    allowLiveSend: env.ALLOW_LIVE_SEND,
    maxSendsPerRun: env.MAX_SENDS_PER_RUN,
    campaignBatch: env.CAMPAIGN_BATCH,
    level10Tag: env.LEVEL10_TAG,
    textStates: env.TEXT_STATES,
    placeholderEnabled: anyPlaceholderEnabled(),
    checksum: EXPECTED_CHECKSUM.slice(0, 16),
    templates: templatePoolSummary(),
    liveReady: !env.SANDBOX ? false : null,
    build: buildId(),
    gates: {
      requireLevel10Tag: env.REQUIRE_LEVEL10_TAG,
      requireOptIn: env.REQUIRE_OPTIN,
      requireProfitDial: env.REQUIRE_PROFITDIAL,
    },
  });
});

// Which commit is actually running. Printed at boot and served on /api/config so
// "did the pull take effect / did the server restart?" is answerable at a glance
// instead of inferred from behaviour.
function buildId() {
  try {
    const head = fs.readFileSync(path.join(__dirname, '..', '.git', 'HEAD'), 'utf8').trim();
    const ref = head.startsWith('ref:') ? head.slice(4).trim() : '';
    const sha = ref
      ? fs.readFileSync(path.join(__dirname, '..', '.git', ref), 'utf8').trim()
      : head;
    return sha.slice(0, 7);
  } catch {
    return 'unknown';
  }
}

// The confirmed column mapping for the Level 10 "With Contacts" sheet.
function pdColsFromEnv() {
  return {
    profitDial: env.PD_COL_PROFITDIAL,
    address: env.PD_COL_ADDRESS,
    phone: env.PD_COL_PHONE,
    name: env.PD_COL_NAME,
    contactId: env.PD_COL_CONTACT_ID,
  };
}

// Turn ProfitDial spreadsheet rows into the lead worklist. ONE sheet is both the
// list of Level 10 homeowners AND the source of their ProfitDial numbers.
function buildLeadsFromRows(rows, cols) {
  const val = (r, col) => (col ? String(r[col] ?? '').trim() : '');
  return rows.map((r, i) => {
    const name = val(r, cols.name) || String(r['Owner'] ?? '').trim();
    const realId = val(r, cols.contactId);
    // No Contact ID column in the Level 10 sheet, so rows get a synthetic id for
    // the ledger. It is flagged so nobody ever SEARCHES REI for "L10-7".
    const contactId = realId || `L10-${i + 1}`;
    // First name from its own column when the sheet has one, else the first
    // word of the owner/primary name.
    const first = val(r, cols.firstName) || name;
    // Primary Name is skip-traced and can disagree with the county record, so all
    // the names the sheet offers travel with the row (see compareAnyName).
    const firstCol = val(r, cols.firstName);
    const lastCol = String(r['Last Name'] ?? '').trim();
    const ownerCol = String(r['Owner'] ?? '').trim();
    const nameCandidates = [
      ...new Set(
        [name, ownerCol, [firstCol, lastCol].filter(Boolean).join(' ')].map((v) => String(v || '').trim()).filter(Boolean)
      ),
    ];
    return {
      contactId: String(contactId),
      syntheticId: !realId,
      name: String(name),
      nameCandidates,
      firstName: first.split(/\s+/)[0] || '',
      address: val(r, cols.address),
      phones: [val(r, cols.phone)].filter(Boolean),
      reiUrl: '',
      scenario: '',
    };
  });
}

// Load a job from a single Level 10 sheet (leads + ProfitDial together).
// `detected` describes how the sheet was read (tab, header row, column mapping)
// so the dashboard can show it instead of failing silently on a renamed column.
function loadLevel10FromRows(rows, cols, { source, tab, limit, detected = null }) {
  const analysis = analyzeSheet(rows, cols);
  let leads = buildLeadsFromRows(rows, cols);
  let originals = rows;
  if (limit && limit > 0) {
    leads = leads.slice(0, limit);
    originals = rows.slice(0, limit);
  }
  lastOriginalRows = originals;
  const state = engine.loadJob({
    contacts: leads,
    profitDialRows: rows,
    profitDialCols: cols,
    source,
    tab,
  });
  const withPhone = leads.filter((l) => l.phones.length > 0).length;
  const withAddress = leads.filter((l) => l.address).length;
  return {
    state,
    analysis,
    leadCount: leads.length,
    totalRows: rows.length,
    withPhone,
    withAddress,
    detected,
    sample: leads.slice(0, 3).map((l) => ({ name: l.name, address: l.address, phone: l.phones[0] || '' })),
  };
}

// ---- Load sandbox scenarios (built-in synthetic data) ----
app.post('/api/sandbox/load', (req, res) => {
  try {
    const seedLedgerContacts = CONTACTS.filter((c) => c.preRecorded);
    lastOriginalRows = CONTACTS.map((c) => ({
      ContactId: c.contactId,
      Scenario: c.scenario,
      'First Name': c.firstName,
      'Full Address': c.address,
      'Primary Phone': (c.phones || [])[0] || '',
    }));
    const state = engine.loadJob({
      contacts: CONTACTS,
      profitDialRows: PROFITDIAL_ROWS,
      profitDialCols: PD_COLS,
      source: 'sandbox-seed',
      tab: 'With Contacts (synthetic)',
      seedLedgerContacts,
    });
    res.json({ ok: true, state, scenarios: CONTACTS.length });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ---- Load the Level 10 sheet (leads + ProfitDial) from an uploaded file ----
app.post('/api/upload/profitdial', upload.single('file'), (req, res) => {
  try {
    // Tolerant load: finds the tab, the header row, and the columns by alias.
    // Never invents a column — anything it could not find comes back in
    // `detected.missing` so the dashboard can say so plainly.
    const found = loadLevel10File(req.file.path, {
      preferredTab: env.PD_SHEET_TAB,
      preferredCols: pdColsFromEnv(),
    });
    const { rows, tab, cols } = found;
    if (!rows.length) {
      throw new Error(`No data rows found. Tabs in this file: ${found.tabs.join(', ')}`);
    }
    if (!cols.phone && !cols.address) {
      throw new Error(
        `Could not find a phone or address column on tab "${tab}". ` +
          `Columns seen: ${Object.keys(rows[0]).join(', ')}`
      );
    }
    engine._uploadedPd = { rows, cols };
    const limit = parseInt(req.query.limit ?? req.body?.limit ?? '0', 10) || 0;
    const detected = {
      tab,
      tabs: found.tabs,
      headerRow: found.headerRow,
      cols,
      how: found.how,
      missing: found.missing,
    };
    const r = loadLevel10FromRows(rows, cols, { source: req.file.originalname, tab, limit, detected });
    res.json({ ok: true, tab, ...r });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  } finally {
    if (req.file) fs.unlink(req.file.path, () => {});
  }
});

// ---- Load the Level 10 sheet from a Google Sheet link (leads + ProfitDial) ----
app.post('/api/ingest/googlesheet', async (req, res) => {
  try {
    let { sheetId, gid, url, token, limit } = req.body || {};
    if (url && !sheetId) ({ sheetId, gid } = parseSheetUrl(url));
    if (gid == null || gid === '') gid = req.body?.gid ?? '';
    const { rows, sourceUrl } = await fetchGoogleSheetRows({ sheetId, gid, token });
    // Same tolerant column detection as the upload path (the CSV export is
    // already parsed into rows here, so only the columns need mapping).
    const det = detectColumnsForRows(rows, pdColsFromEnv());
    const cols = det.cols;
    engine._uploadedPd = { rows, cols };
    const lim = parseInt(limit ?? '0', 10) || 0;
    const detected = { tab: env.PD_SHEET_TAB, tabs: [], headerRow: 1, cols, how: det.how, missing: det.missing };
    const r = loadLevel10FromRows(rows, cols, { source: sourceUrl, tab: env.PD_SHEET_TAB, limit: lim, detected });
    res.json({ ok: true, sourceUrl, rowCount: rows.length, ...r });
  } catch (e) {
    res.status(e.code === 'SHEET_PRIVATE' ? 403 : 400).json({ ok: false, error: e.message, code: e.code });
  }
});

// ---- Upload a real contact list (uses uploaded or seed ProfitDial sheet) ----
app.post('/api/upload/contacts', upload.single('file'), (req, res) => {
  try {
    const { tab, contacts } = importContacts(req.file.path, req.query.tab);
    const pd = engine._uploadedPd || { rows: PROFITDIAL_ROWS, cols: PD_COLS };
    lastOriginalRows = contacts.map((c) => c._original);
    // Real contacts don't carry sandbox behavior; the sandbox adapter will
    // treat unknown ids as not-found. Real runs require the (unbuilt) live
    // adapter, so in sandbox mode real uploads mainly exercise matching/import.
    const enriched = contacts.map((c, i) => ({
      contactId: c.contactId || `row-${i + 2}`,
      scenario: 'uploaded',
      found: true,
      firstName: c.firstName,
      lastName: c.lastName,
      name: c.name,
      address: c.address,
      state: c.state,
      tags: [env.LEVEL10_TAG],
      notes: '',
      chatHistory: [],
      phones: [c.phone].filter(Boolean),
      optedIn: false,
      optOut: false,
      behavior: { optIn: 'success', availableProfitDial: [], readback: 'match', send: 'ok', verify: 'ok', delivery: 'pending', reply: '' },
    }));
    const state = engine.loadJob({
      contacts: enriched,
      profitDialRows: pd.rows,
      profitDialCols: pd.cols,
      source: req.file.originalname,
      tab,
    });
    res.json({ ok: true, state, count: enriched.length });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  } finally {
    if (req.file) fs.unlink(req.file.path, () => {});
  }
});

// ---- Controls ----
app.post('/api/start', async (req, res) => {
  try {
    await engine.start();
    res.json({ ok: true, state: engine.snapshot() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message, code: e.code });
  }
});
app.post('/api/pause', (req, res) => {
  engine.pause();
  res.json({ ok: true });
});
app.post('/api/resume', async (req, res) => {
  await engine.resume();
  res.json({ ok: true, state: engine.snapshot() });
});
app.post('/api/stop', (req, res) => {
  engine.stop();
  res.json({ ok: true });
});

// ---- State / KPI / logs ----
app.get('/api/state', (req, res) => res.json(engine.snapshot()));
app.get('/api/kpi', (req, res) => {
  const snap = engine.snapshot();
  res.json(buildKpi(snap.results, { assigned: snap.total }));
});
app.get('/api/logs', (req, res) => res.json(logger.read(Number(req.query.limit) || 500)));

// ---- Export ----
app.get('/api/export', (req, res) => {
  const format = req.query.format === 'csv' ? 'csv' : 'xlsx';
  const snap = engine.snapshot();
  const buf = exportResults(lastOriginalRows, snap.results, format);
  const name = `level10-results.${format}`;
  res.set({
    'Content-Type': format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${name}"`,
  });
  res.send(buf);
});

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

const PORT = env.PORT;
app.listen(PORT, () => {
  const mode = env.SANDBOX ? 'SANDBOX (no carrier contacted)' : 'LIVE';
  logger.info('server_start', { port: PORT, mode, build: buildId() });
  // eslint-disable-next-line no-console
  console.log(`\n  Level 10 SMS Outreach — ${mode}`);
  console.log(`  Dashboard: http://localhost:${PORT}`);
  console.log(`  ALLOW_LIVE_SEND=${env.ALLOW_LIVE_SEND} | MAX_SENDS_PER_RUN=${env.MAX_SENDS_PER_RUN}`);
  console.log(
    `  Mandatory gates (not configurable): tag=${env.REQUIRE_LEVEL10_TAG} optIn=${env.REQUIRE_OPTIN} profitDial=${env.REQUIRE_PROFITDIAL}`
  );
  console.log(`  WATCH_ONLY=${env.WATCH_ONLY}`);
  assertNoDisabledGates({ warn: (m) => console.log(m) });
  console.log(`  Build: ${buildId()}\n`);
});

export { app };
