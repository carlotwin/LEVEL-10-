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

import { env } from './config/env.js';
import { Engine } from './automation/engine.js';
import { buildKpi } from './data/kpi.js';
import { templatePoolSummary, anyPlaceholderEnabled, EXPECTED_CHECKSUM } from './automation/message.js';
import { analyzeSheet } from './automation/profitdial.js';
import { importContacts, readTabFromFile, exportResults } from './data/spreadsheet.js';
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
    allowLiveSend: env.ALLOW_LIVE_SEND,
    maxSendsPerRun: env.MAX_SENDS_PER_RUN,
    campaignBatch: env.CAMPAIGN_BATCH,
    level10Tag: env.LEVEL10_TAG,
    textStates: env.TEXT_STATES,
    placeholderEnabled: anyPlaceholderEnabled(),
    checksum: EXPECTED_CHECKSUM.slice(0, 16),
    templates: templatePoolSummary(),
    liveReady: !env.SANDBOX ? false : null,
  });
});

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

// ---- Upload a real ProfitDial spreadsheet (optional) ----
app.post('/api/upload/profitdial', upload.single('file'), (req, res) => {
  try {
    const { rows } = readTabFromFile(req.file.path, env.PD_SHEET_TAB);
    const cols = {
      profitDial: env.PD_COL_PROFITDIAL,
      address: env.PD_COL_ADDRESS,
      phone: env.PD_COL_PHONE,
      name: env.PD_COL_NAME,
      contactId: env.PD_COL_CONTACT_ID,
    };
    const analysis = analyzeSheet(rows, cols);
    // Stash for a subsequent contact upload / job load.
    engine._uploadedPd = { rows, cols };
    res.json({ ok: true, tab: env.PD_SHEET_TAB, analysis });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  } finally {
    if (req.file) fs.unlink(req.file.path, () => {});
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
  logger.info('server_start', { port: PORT, mode });
  // eslint-disable-next-line no-console
  console.log(`\n  Level 10 SMS Outreach — ${mode}`);
  console.log(`  Dashboard: http://localhost:${PORT}`);
  console.log(`  ALLOW_LIVE_SEND=${env.ALLOW_LIVE_SEND} | MAX_SENDS_PER_RUN=${env.MAX_SENDS_PER_RUN}\n`);
});

export { app };
