// ---------------------------------------------------------------------------
// Views: Action Queue, Data Health, Data Sources, Settings.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------- Action Queue
const QUEUE_TABS = [['proposed', 'Waiting'], ['approved', 'Approved'], ['done', 'Done'], ['rejected', 'Rejected']];
function queueItems(a) {
  return PPC.mergeActionState(a.actions, state.decisions);
}
function viewActions(root, a) {
  const all = queueItems(a);
  const counts = Object.fromEntries(QUEUE_TABS.map(([k]) => [k, 0]));
  for (const x of all) counts[x.status] = (counts[x.status] || 0) + 1;
  const ids = [...new Set(all.map((x) => x.decidedBy).filter(Boolean))];
  root.append(h('div', { class: 'page-head' },
    h('div', {}, h('h2', { class: 'page-title' }, 'Action Queue'),
      h('p', { class: 'page-sub' }, `The system recommends, a person approves. Decided on ${a.decisionWindow.start ? `${fmt.date(a.decisionWindow.start)} to ${fmt.date(a.decisionWindow.end)}` : 'all data'} (${a.decisionWindow.days} days), whatever the filters above.`)),
    h('div', { class: 'btn-row' },
      button('Checklist (CSV)', () => offerDownload('approved-actions-checklist.csv', PPC.actionsChecklistCsv(all.filter((x) => x.status === 'approved' || x.status === 'done').map((x) => ({ ...x, decidedByName: nameOf(x.decidedBy) })))), { small: true }),
      button('Google Ads Editor file (CSV)', () => offerDownload('google-ads-editor-approved.csv', PPC.editorCsv(all)), { small: true, title: 'Approved keyword pauses, negatives, URL changes and location changes, for Google Ads Editor → Import' }))));
  root.append(note('Version 1 never changes Google Ads. Approving records the decision and who made it. Make the change in Google Ads, or import the Editor file, then mark it done. Each action already carries the Google Ads API change for a later version.', 'info'));
  if (!can.approve()) root.append(note(ROLE_HINT.viewer, 'warn'));
  root.append(h('div', { class: 'table-tools' }, segmented(QUEUE_TABS.map(([k, l]) => [k, `${l} ${counts[k] || 0}`]), state.queueTab, (v) => { state.queueTab = v; renderView(); }, 'Show actions')));
  // Waiting: the engine's priority order (stop waste first). Decided: newest first.
  const list = all.filter((x) => x.status === state.queueTab);
  if (state.queueTab !== 'proposed') list.sort((x, y) => String(y.decidedAt || '').localeCompare(String(x.decidedAt || '')));
  if (!list.length) {
    root.append(emptyState('Nothing here', state.queueTab === 'proposed' ? 'Every recommendation has been decided.' : 'No actions in this group yet.'));
    return;
  }
  if (rt.user && ids.length && ids.some((id) => !state.profiles?.[id])) {
    rt.user.profiles(ids).then((ps) => { state.profiles = { ...state.profiles, ...ps }; renderView(); });
  }
  root.append(h('div', { class: 'list' }, list.map((x) => actionCard(x))));
}
function nameOf(id) {
  if (!id) return '';
  if (id === me.id) return 'you';
  return state.profiles?.[id]?.name || 'a teammate';
}
function actionCard(x) {
  const noteInput = h('input', { class: 'input note-input', type: 'text', id: `note-${x.id}`, placeholder: 'Note (optional)', maxlength: '300', 'aria-label': 'Note' });
  const decide = async (status) => {
    const rec = PPC.decisionRecord(x, status, me.id, noteInput.value);
    const ok = await dbWrite(() => rt.db.doc(`actions/${x.id}`).set(rec), 'record this decision');
    if (ok) toast(status === 'approved' ? 'Approved. Make the change in Google Ads, then mark it done.' : status === 'done' ? 'Marked done.' : 'Rejected.');
  };
  const undo = () => dbWrite(() => rt.db.doc(`actions/${x.id}`).delete(), 'undo this decision');
  const buttons = [];
  if (can.approve()) {
    if (x.status === 'proposed') buttons.push(button('Approve', () => decide('approved'), { kind: 'approve', small: true }), button('Reject', () => decide('rejected'), { kind: 'reject', small: true }));
    if (x.status === 'approved') buttons.push(button('Mark done in Google Ads', () => decide('done'), { kind: 'primary', small: true }), button('Undo', undo, { kind: 'ghost', small: true }));
    if (x.status === 'rejected' || x.status === 'done') buttons.push(button('Undo', undo, { kind: 'ghost', small: true }));
  }
  const opText = x.operation ? JSON.stringify(x.operation, null, 2) : '';
  return h('article', { class: 'action-card', id: `action-${x.id}` },
    h('div', { class: 'action-top' }, stamp(x.rec), chip(x.typeLabel, 'info'),
      x.status !== 'proposed' ? chip(PPC.ACTION_STATUSES[x.status], x.status === 'rejected' ? 'neutral' : 'good') : null,
      !x.stillRecommended ? chip('No longer recommended', 'warn', 'The latest data no longer produces this recommendation.') : null,
      chip(x.apiReady ? 'API ready' : 'Manual change', x.apiReady ? 'good' : 'neutral', x.apiReady ? 'Carries the exact Google Ads API change for a later version.' : x.manualNote)),
    h('div', { class: 'action-summary' }, x.summary),
    h('p', { class: 'action-reason' }, x.reason),
    h('div', { class: 'action-meta' },
      h('span', {}, `Spend at stake ${fmt.money(x.spend)}`), h('span', {}, `Confidence ${x.confidence}`),
      x.target?.terms?.length ? h('span', {}, `Searches: ${x.target.terms.slice(0, 4).join(', ')}${x.target.terms.length > 4 ? '…' : ''}`) : null,
      x.decidedAt ? h('span', {}, `${PPC.ACTION_STATUSES[x.status]} by ${nameOf(x.decidedBy)} · ${fmt.dateTime(x.decidedAt)}`) : null,
      x.note ? h('span', {}, `Note: ${x.note}`) : null),
    opText ? h('details', {}, h('summary', { class: 'small muted' }, 'Google Ads API change (not sent in version 1)'), h('pre', { class: 'code' }, opText)) : null,
    buttons.length ? h('div', { class: 'action-foot' }, x.status === 'proposed' ? noteInput : h('span'), h('div', { class: 'btn-row' }, buttons)) : null);
}

// ---------------------------------------------------------------- Data Health
const SOURCE_TONE = { ok: 'good', stale: 'warn', failed: 'bad', missing: 'neutral', unknown: 'neutral', demo: 'demo' };
const MODE_LABEL = { api: 'API', csv: 'CSV import', crawler: 'REI crawler', script: 'Google Ads Script', sheet: 'Google Sheet', scan: 'Page scan', drive: 'Drive sync' };
function viewHealth(root, a) {
  const hl = a.health;
  root.append(h('div', { class: 'page-head' },
    h('div', {}, h('h2', { class: 'page-title' }, 'Data health'), h('p', { class: 'page-sub' }, 'Can the recommendations be trusted? What is missing, stale or broken, and how to fix it.')),
    chip(hl.summary.status === 'ok' ? 'All good' : `${hl.summary.problems} to check`, hl.summary.status === 'ok' ? 'good' : hl.summary.status === 'error' ? 'bad' : 'warn')));
  root.append(card({
    kicker: 'Sources', title: 'Connections and last sync',
    body: simpleTable([{ label: 'Source' }, { label: 'Status' }, { label: 'How' }, { label: 'Last sync' }, { label: 'Last success' }, { label: 'Note' }],
      hl.sources.map((src) => [src.label, chip(src.text, SOURCE_TONE[src.status]), MODE_LABEL[src.mode] || src.mode || '—', fmt.dateTime(src.lastAttemptAt), fmt.dateTime(src.lastSuccessAt), src.detail || '']))
  }));
  root.append(card({
    kicker: 'Checks', title: 'What could make a recommendation wrong',
    body: h('div', { class: 'list' }, hl.checks.map((c) => h('div', { class: 'list-row' },
      severityChip(c.severity),
      h('div', { class: 'list-main' },
        h('span', { class: 'list-title' }, c.label, h('span', { class: 'muted small' }, ` · ${c.display}`)),
        h('span', { class: 'small ink-2' }, c.detail),
        c.fix && c.severity !== 'ok' ? h('span', { class: 'small' }, h('b', {}, 'Fix: '), c.fix) : null,
        c.errors?.length ? h('ul', { class: 'plain small mono' }, c.errors.slice(0, 4).map((e) => h('li', {}, `${e.step || 'step'} · ${e.selector || ''} · ${e.message || ''}`))) : null)))),
  }));
  root.append(card({ kicker: 'Alerts', title: 'Notifications', body: alertList(a.alerts) }));
  const history = (a.model.dataset.sync?.history || []).slice(0, 40);
  root.append(card({
    kicker: 'History', title: 'Sync and import runs',
    body: history.length ? h('div', { class: 'table-wrap' }, simpleTable([{ label: 'Finished' }, { label: 'Source' }, { label: 'How' }, { label: 'Result' }, { label: 'Added', n: true }, { label: 'Updated', n: true }, { label: 'Failed', n: true }, { label: 'Message' }],
      history.map((x) => [fmt.dateTime(x.finishedAt), PPC.SOURCES[x.source] || x.source, MODE_LABEL[x.mode] || x.mode || '—', chip(x.status, x.status === 'ok' ? 'good' : x.status === 'failed' ? 'bad' : 'warn'),
        fmt.int(x.created), fmt.int(x.updated), fmt.int(x.failed), [x.message, x.errors?.[0]?.selector ? `[${x.errors[0].step}: ${x.errors[0].selector}]` : ''].filter(Boolean).join(' ')])))
      : emptyState('No sync runs yet', 'Imports and agent syncs are listed here.'),
  }));
}

// ---------------------------------------------------------------- Data Sources
function viewSources(root, a) {
  const ds = a.model.dataset;
  const sum = PPC.summarizeDataset(ds);
  const pointer = state.pointer;
  root.append(h('div', { class: 'page-head' },
    h('div', {}, h('h2', { class: 'page-title' }, 'Data sources'), h('p', { class: 'page-sub' }, 'Bring in Google Ads, REI BlackBook, GA4 and call data. Files are read in your browser; names, phone numbers, emails and addresses never leave it.')),
    h('div', { class: 'btn-row' }, button('Download dataset (JSON)', () => offerDownload(`twin-ppc-dataset-${sum.today}.json`, JSON.stringify(ds)), { small: true }))));

  root.append(card({
    kicker: 'Now showing', title: ds.isDemo ? 'Demo data' : 'Your team’s data',
    sub: ds.isDemo ? 'Made up for illustration. Import or sync real data below; it replaces the demo completely.' : `Saved ${fmt.dateTime(pointer?.uploadedAt)}${pointer?.uploadedBy ? ` by ${nameOf(pointer.uploadedBy)}` : ''}${pointer?.note ? ` · ${pointer.note}` : ''}.`,
    body: [
      facts([
        { label: 'Ad spend', value: fmt.money(sum.spend) }, { label: 'Google Ads dates', value: sum.ranges.ads.min ? `${fmt.dateShort(sum.ranges.ads.min)} – ${fmt.dateShort(sum.ranges.ads.max)}` : '—' },
        { label: 'Leads', value: fmt.int(sum.counts.leads) }, { label: 'Lead dates', value: sum.ranges.leads.min ? `${fmt.dateShort(sum.ranges.leads.min)} – ${fmt.dateShort(sum.ranges.leads.max)}` : '—' },
        { label: 'Keywords', value: fmt.int(sum.counts.keywords) }, { label: 'Clicks with GCLID', value: fmt.int(sum.counts.clicks) },
        { label: 'Calls', value: fmt.int(sum.counts.calls) }, { label: 'Landing pages', value: fmt.int(sum.counts.pages) },
      ]),
      can.admin() && rt.db ? h('div', { class: 'btn-row' },
        canUndo(pointer) ? button('Undo last change', async () => { if (await undoDataset(pointer)) toast('Restored the previous version.'); }, { small: true }) : null,
        !ds.isDemo ? button('Show demo data instead', async () => { if (await useDemoData(pointer)) toast('Showing demo data. Undo brings your data back.'); }, { small: true, kind: 'ghost' }) : null) : null,
    ],
  }));

  // File import.
  if (!can.import()) {
    root.append(note(rt.db ? 'Importing and syncing need editor access to this dashboard (Editor in the Share menu). You can still read everything here.' : 'This view cannot save shared data, so importing is off. Open the dashboard from claude.ai to import.', 'warn'));
  } else {
    root.append(importCard(a));
    if (rt.mcp) root.append(driveCard(a));
  }
  root.append(card({
    kicker: 'Automatic syncing', title: 'Connect the real sources',
    body: h('div', { class: 'list' }, [
      ['Google Ads', 'The sync agent pulls keyword, search term, location and click data every night through the Google Ads API (read-only), or a Google Ads Script writes the same data to Drive with no developer token. CSV exports from the Google Ads UI always work as a backup.'],
      ['REI BlackBook', 'Best: a scheduled REI export (CSV). Fallback: the sync agent’s crawler, which signs in to your own REI account (you complete any MFA yourself), reads your leads slowly, and stops with the exact failing step if REI changes its layout.'],
      ['Website (GA4)', 'The sync agent reads landing page and page reports through the GA4 Data API with a read-only service account. A GA4 CSV download works too.'],
      ['Call tracking', 'Import your call log (CallRail, ProfitDial or similar). Map tracking numbers to Google Ads in Settings.'],
      ['How the data gets here', 'The agent writes one sync file (twin-ppc-bundle.json) to a Google Drive folder. Click “Find sync files” above to load it. Setup steps are in the repository: ppc/README.md and ppc/SETUP_CHECKLIST.md.'],
    ].map(([t, d]) => h('div', { class: 'list-row' }, h('div', { class: 'list-main' }, h('span', { class: 'list-title' }, t), h('span', { class: 'small ink-2' }, d))))),
  }));
  root.append(card({
    kicker: 'History', title: 'Imports',
    body: state.imports.length ? simpleTable([{ label: 'When' }, { label: 'By' }, { label: 'Files' }, { label: 'Result' }],
      state.imports.map((x) => [fmt.dateTime(x.at), nameOf(x.by), (x.files || []).map((f) => `${f.name} (${f.label})`).join(', '), x.summary || ''])) : emptyState('No imports yet', 'Every import is listed here with who ran it.'),
  }));
}

function importCard(a) {
  const input = h('input', { type: 'file', id: 'import-files', multiple: true, accept: '.csv,.txt,.tsv,.xlsx,.xls,.json', class: 'sr-only' });
  const results = h('div', { class: 'list' });
  const zone = h('label', { class: 'dropzone', for: 'import-files' },
    h('strong', {}, 'Drop files here, or click to choose'),
    h('span', { class: 'small' }, 'Google Ads reports (keyword, search terms, locations, clicks) · REI BlackBook export (CSV or Excel) · GA4 export · call log · landing page list (URL, H1, CTA) · a twin-ppc sync file'),
    input);
  const handle = async (files) => {
    const pending = [];
    for (const f of files) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      pending.push({ name: f.name, bytes });
    }
    await runImport(pending, results, a);
  };
  input.addEventListener('change', () => { if (input.files.length) handle([...input.files]); input.value = ''; });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); if (e.dataTransfer?.files?.length) handle([...e.dataTransfer.files]); });
  if (state.lastImport) results.append(note(`Saved ${fmt.dateTime(state.lastImport.at)}: ${state.lastImport.summary}.`, 'good'));
  return card({ kicker: 'Import', title: 'Add files', sub: 'Each file is recognised automatically, checked, and merged. Importing the same file twice does not double anything.', body: [zone, results] });
}

/** Parse, preview, then merge + save on confirmation. files: [{name, bytes}] */
async function runImport(files, resultsEl, a) {
  clear(resultsEl);
  const parsed = [];
  for (const f of files) {
    const row = h('div', { class: 'file-result' }, h('div', { class: 'file-result-head' }, h('b', {}, f.name), chip('Reading…', 'neutral')));
    resultsEl.append(row);
    try {
      const text = await bytesToText(f.name, f.bytes);
      const r = await PPC.importFile({ name: f.name, text }, { settings: state.settings || {}, by: me.id || '' });
      parsed.push({ ...r, name: f.name });
      clear(row);
      row.append(h('div', { class: 'file-result-head' }, h('b', {}, f.name), chip(r.label, r.part ? 'info' : 'bad'),
        r.stats?.rows != null ? h('span', { class: 'small muted' }, `${fmt.int(r.stats.rows)} rows${r.stats.leads != null ? ` · ${fmt.int(r.stats.leads)} leads` : ''}${r.stats.reportType ? ` · ${r.stats.reportType.replace('_', ' ')} report` : ''}`) : null));
      if (r.errors.length) row.append(h('ul', { class: 'plain small', style: { color: 'var(--critical-ink)' } }, r.errors.map((x) => h('li', {}, x))));
      if (r.warnings.length) row.append(h('ul', { class: 'plain small ink-2' }, r.warnings.slice(0, 6).map((x) => h('li', {}, x))));
      if (r.kind === 'rei' && r.mapping) {
        const mapped = Object.entries(r.mapping).filter(([, v]) => v).map(([k, v]) => `${k} ← “${v}”`);
        row.append(h('details', {}, h('summary', { class: 'small' }, `Columns understood (${mapped.length}); personal columns are read only to hash and never stored`), h('p', { class: 'small mono' }, mapped.join(' · '))));
      }
    } catch (e) {
      clear(row);
      row.append(h('div', { class: 'file-result-head' }, h('b', {}, f.name), chip('Could not read', 'bad')), h('p', { class: 'small' }, String(e?.message || e)));
    }
  }
  const good = parsed.filter((p) => p.part);
  if (!good.length) return;
  const demoIncoming = good.some((p) => p.part.isDemo);
  const confirm = button(`Add ${fmt.plural(good.length, 'file')} to the dashboard`, async () => {
    confirm.disabled = true;
    confirm.textContent = 'Saving…';
    try {
      let base = state.dataset;
      if (base?.isDemo && state.pointer?.previousAssetId) base = await fetchJson(`/_blob/${state.pointer.previousAssetId}`).catch(() => base);
      const stats = [];
      for (const p of good) {
        const r = PPC.mergeDataset(base, p.part);
        base = r.dataset;
        stats.push(r.stats);
      }
      const leadsNew = stats.reduce((x, st) => x + (st.leads?.created || 0), 0);
      const leadsUpd = stats.reduce((x, st) => x + (st.leads?.updated || 0), 0);
      const summary = `${fmt.int(leadsNew)} new and ${fmt.int(leadsUpd)} updated leads, ${fmt.int(stats.reduce((x, st) => x + (st.ads?.rows || 0), 0))} Google Ads rows${stats.some((st) => st.replacedDemo) ? '; demo data replaced' : ''}`;
      const pointer = await saveDataset(base, state.pointer, summary);
      await dbWrite(() => rt.db.collection('imports').add({
        at: new Date().toISOString(), by: me.id || '', summary,
        files: good.map((p) => ({ name: String(p.name).slice(0, 120), kind: p.kind, label: p.label, rows: p.stats?.rows ?? null, warnings: p.warnings.slice(0, 3) })),
      }), 'log the import');
      state.pointer = pointer;
      state.loadedAssetId = pointer.assetId;
      state.lastImport = { summary, at: new Date().toISOString() };
      toast(`Saved: ${summary}.`);
      await setDataset(base, 'shared');
    } catch (e) {
      confirm.disabled = false;
      confirm.textContent = 'Try again';
      toast(`Not saved: ${e?.message || e}`, 'bad');
    }
  }, { kind: 'primary' });
  resultsEl.append(h('div', { class: 'btn-row' }, confirm,
    demoIncoming ? h('span', { class: 'small', style: { color: 'var(--warning-ink)' } }, 'One file is demo data.') : null,
    state.dataset?.isDemo && !demoIncoming ? h('span', { class: 'small muted' }, 'The demo data will be replaced by your data.') : null));
}

function driveCard(a) {
  const results = h('div', { class: 'list' });
  const status = h('p', { class: 'small muted' });
  const search = h('input', { class: 'input', id: 'drive-search', type: 'search', placeholder: 'File name, e.g. REI export', 'aria-label': 'Search Google Drive' });
  const show = (files, what) => {
    clear(results);
    if (!files.length) {
      results.append(emptyState(`No ${what} found`, 'Check the file name, or that the file is shared with you.'));
      return;
    }
    for (const f of files) {
      results.append(h('div', { class: 'list-row' },
        h('div', { class: 'list-main' }, h('span', { class: 'list-title' }, f.title || f.id), h('span', { class: 'small muted' }, `${f.mimeType || ''} · modified ${fmt.dateTime(f.modifiedTime)}${f.fileSize ? ` · ${fmt.int(Number(f.fileSize) / 1024)} KB` : ''}`)),
        button('Import', async (e) => {
          e.target.disabled = true;
          status.textContent = `Downloading ${f.title}…`;
          try {
            const bytes = await driveDownload(f);
            status.textContent = '';
            const name = f.mimeType === 'application/vnd.google-apps.spreadsheet' ? `${f.title}.csv` : f.title;
            await runImport([{ name, bytes }], results, a);
          } catch (err) {
            e.target.disabled = false;
            status.textContent = driveErrorText(err);
          }
        }, { small: true })));
    }
  };
  const find = async (query, what) => {
    status.textContent = 'Searching Google Drive…';
    try {
      const files = await driveSearch(query);
      status.textContent = '';
      show(files, what);
    } catch (e) {
      status.textContent = driveErrorText(e);
    }
  };
  const q = (t) => String(t).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return card({
    kicker: 'Google Drive', title: 'Sync from Drive', sub: 'Uses your own Google Drive connection. Nothing is stored except the cleaned data you import.',
    body: [
      h('div', { class: 'btn-row' },
        button('Find sync files', () => find("title contains 'twin-ppc'", 'sync files'), { kind: 'primary', small: true, title: 'Files the sync agent or the Google Ads Script wrote (twin-ppc-*.json)' }),
        search,
        button('Search', () => search.value.trim() && find(`title contains '${q(search.value.trim())}'`, 'files'), { small: true, id: 'drive-search-go' })),
      status, results,
    ],
  });
}

// ---------------------------------------------------------------- Settings
const DECISION_FIELDS = [
  ['targetCpl', 'Target cost per lead', '$'], ['targetQualifiedCpl', 'Target cost per qualified lead', '$'], ['targetCostPerAppointment', 'Target cost per appointment', '$'],
  ['targetCostPerContract', 'Target cost per contract', '$'], ['targetCostPerDeal', 'Target cost per closed deal', '$'],
  ['minSpend', 'Judge a row after this much spend', '$'], ['minClicks', '…or after this many clicks', '#'], ['minConversions', 'Qualified leads needed before SCALE', '#'],
  ['profitabilityThreshold', 'Profit per $1 of ads needed to SCALE', '×'], ['reduceMultiplier', 'REDUCE when cost is above target by more than', '×'],
  ['pauseSpendNoLeads', 'PAUSE after this spend with no leads', '$'], ['pauseSpendNoQualified', 'PAUSE after this spend with no qualified leads', '$'],
  ['outsideBuyBoxShare', 'PAUSE when this share of spend is outside the buy box', '%'], ['minSpendOutsideBuyBox', '…once this much was spent there', '$'],
];
const ACTION_FIELDS = [
  ['windowDays', 'Action Queue looks at the last', 'days'], ['minSpendForAction', 'Ignore rows below this spend', '$'], ['lowerBidPct', 'REDUCE keyword: lower bid by', '%'],
  ['raiseBidPct', 'SCALE keyword: raise bid or budget by', '%'], ['cityPausePct', 'PAUSE city in buy box: lower bids by', '%'], ['cityBidDownPct', 'REDUCE city: lower bids by', '%'], ['cityBidUpPct', 'SCALE city: raise bids by', '%'],
];
const WASTE_FIELDS = [['minSpend', 'Look at search terms above this spend', '$'], ['highSpendNoLead', 'Flag a search term with no leads after', '$'], ['expensiveTerm', 'Flag expensive searches with nothing downstream after', '$']];
const ALERT_FIELDS = [['dailySpendHigh', 'Alert when one day spends more than (0 = off)', '$'], ['spendSpikeRatio', '…or more than this × the 7-day average', '×'], ['keywordNoLeadSpend', 'Alert: keyword spend in 7 days with 0 leads', '$'], ['keywordNoQualifiedSpend', 'Alert: keyword spend in 14 days with 0 qualified', '$']];
const STAGES = [['new', 'New'], ['contacted', 'Contacted'], ['qualified', 'Qualified'], ['appointment', 'Appointment'], ['offer', 'Offer'], ['contract', 'Contract'], ['closed', 'Closed'], ['lost', 'Lost / dead']];

function viewSettings(root, a) {
  const admin = can.admin();
  const draft = structuredClone(settingsWithDefaults(state.settings));
  const numField = (group, [key, label, unit], defaults) => {
    const pct = unit === '%' && key === 'outsideBuyBoxShare';
    const value = draft[group][key] ?? defaults[key];
    const inp = h('input', {
      class: 'input num', type: 'number', id: `s-${group}-${key}`, step: 'any', min: '0', disabled: !admin,
      value: pct ? PPC.round(value * 100, 0) : value,
      oninput: (e) => { const v = Number(e.target.value); if (Number.isFinite(v)) draft[group][key] = pct ? v / 100 : v; },
    });
    return h('div', { class: 'field' }, h('label', { for: `s-${group}-${key}` }, label), inp, h('span', { class: 'hint' }, `${unit === '$' ? 'dollars' : unit === '#' ? 'count' : unit === '×' ? 'multiple' : unit === '%' ? 'percent' : unit} · default ${pct ? `${defaults[key] * 100}%` : defaults[key]}`));
  };
  root.append(h('div', { class: 'page-head' },
    h('div', {}, h('h2', { class: 'page-title' }, 'Settings'), h('p', { class: 'page-sub' }, 'Every rule the recommendations use. Change a target and every recommendation updates.')),
    admin ? h('div', { class: 'btn-row' },
      button('Save settings', async () => {
        const ok = await dbWrite(() => rt.db.doc('config/settings').set({ ...draft, updatedAt: new Date().toISOString(), updatedBy: me.id || '' }), 'save settings');
        if (ok) toast('Settings saved. Recommendations updated.');
      }, { kind: 'primary', id: 'save-settings' }),
      button('Back to defaults', async () => {
        const ok = await dbWrite(() => rt.db.doc('config/settings').set({ updatedAt: new Date().toISOString(), updatedBy: me.id || '' }), 'reset settings');
        if (ok) toast('Settings reset to defaults.');
      }, { kind: 'ghost' })) : chip('Read only', 'neutral', ROLE_HINT[me.role])));
  if (!admin) root.append(note('Only editors change settings. You can see every rule here.', 'info'));
  root.append(card({ kicker: 'Recommendations', title: 'Targets and thresholds', body: h('div', { class: 'form-grid' }, DECISION_FIELDS.map((f) => numField('decision', f, PPC.DEFAULT_DECISION_SETTINGS))) }));
  root.append(card({ kicker: 'Action Queue', title: 'What actions propose', body: h('div', { class: 'form-grid' }, ACTION_FIELDS.map((f) => numField('actions', f, PPC.DEFAULT_ACTION_SETTINGS))) }));
  root.append(h('div', { class: 'grid-2' },
    card({ kicker: 'Search terms', title: 'Waste detector', body: h('div', { class: 'form-grid' }, WASTE_FIELDS.map((f) => numField('waste', f, PPC.DEFAULT_WASTE_SETTINGS))) }),
    card({ kicker: 'Alerts', title: 'When to notify', body: h('div', { class: 'form-grid' }, ALERT_FIELDS.map((f) => numField('alerts', f, PPC.DEFAULT_ALERT_SETTINGS))) })));

  // Buy box.
  const geoBody = h('tbody');
  const drawGeo = () => {
    clear(geoBody);
    draft.geo.forEach((g, i) => geoBody.append(h('tr', {},
      h('td', {}, h('input', { class: 'input', value: g.city, disabled: !admin, 'aria-label': 'City', oninput: (e) => { draft.geo[i].city = e.target.value; } })),
      h('td', {}, h('input', { class: 'input', value: g.county || '', disabled: !admin, 'aria-label': 'County', oninput: (e) => { draft.geo[i].county = e.target.value; } })),
      h('td', {}, h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: g.inBuyBox, disabled: !admin, onchange: (e) => { draft.geo[i].inBuyBox = e.target.checked; } }), 'We buy here')),
      h('td', {}, admin ? button('Remove', () => { draft.geo.splice(i, 1); drawGeo(); }, { kind: 'ghost', small: true }) : null))));
  };
  drawGeo();
  root.append(card({
    kicker: 'Buy box', title: 'Cities and counties', sub: 'Cities not listed show their county as blank and are never treated as outside the buy box.',
    body: [h('div', { class: 'table-wrap editable-table' }, h('table', { class: 'data' }, h('thead', {}, h('tr', {}, h('th', {}, 'City'), h('th', {}, 'County'), h('th', {}, 'Buy box'), h('th', {}, ''))), geoBody)),
      admin ? button('Add city', () => { draft.geo.push({ city: '', state: 'CA', county: '', inBuyBox: true }); drawGeo(); }, { small: true }) : null],
  }));

  // Seller situations.
  const sitBody = h('div', { class: 'list' });
  const drawSits = () => {
    clear(sitBody);
    draft.situations.forEach((sit, i) => {
      const fixed = sit.code === 'other' || sit.code === 'unknown';
      sitBody.append(h('div', { class: 'list-row' },
        h('div', { class: 'list-main' },
          h('input', { class: 'input', value: sit.label, disabled: !admin, 'aria-label': 'Situation name', oninput: (e) => { draft.situations[i].label = e.target.value; } }),
          fixed ? h('span', { class: 'small muted' }, sit.code === 'other' ? 'Used when the text matches nothing.' : 'Used when REI has no motivation text.')
            : h('input', { class: 'input', value: (sit.patterns || []).join(', '), disabled: !admin, 'aria-label': 'Words that mean this situation', oninput: (e) => { draft.situations[i].patterns = e.target.value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean); } })),
        admin && !fixed ? button('Remove', () => { draft.situations.splice(i, 1); drawSits(); }, { kind: 'ghost', small: true }) : null));
    });
  };
  drawSits();
  root.append(card({
    kicker: 'Seller situations', title: 'How motivation text is sorted', sub: 'The first situation (top to bottom) whose words appear in the REI motivation or tags wins. Words match at the start of a word.',
    body: [sitBody, admin ? button('Add situation', () => { draft.situations.splice(draft.situations.length - 2, 0, { code: `custom_${Date.now().toString(36)}`, label: 'New situation', patterns: [] }); drawSits(); }, { small: true }) : null],
  }));

  // REI statuses.
  const statuses = new Set([...Object.keys(draft.rei.statusMap || {}), ...Object.keys(a.model.dataset.rei?.unmappedStatuses || {})]);
  const statusBody = h('div', { class: 'form-grid' });
  const drawStatus = () => {
    clear(statusBody);
    for (const st of statuses) {
      statusBody.append(h('div', { class: 'field' }, h('label', {}, `“${st}” means`),
        h('select', { class: 'select', disabled: !admin, onchange: (e) => { draft.rei.statusMap = { ...draft.rei.statusMap, [st]: e.target.value }; if (!e.target.value) delete draft.rei.statusMap[st]; } },
          h('option', { value: '' }, 'Not mapped (treated as new)'), STAGES.map(([v, l]) => h('option', { value: v, selected: draft.rei.statusMap?.[st] === v }, l)))));
    }
    if (!statuses.size) statusBody.append(h('p', { class: 'small muted' }, 'Every status in the data is understood. New unknown statuses appear here after an import.'));
  };
  drawStatus();
  const newStatus = h('input', { class: 'input', placeholder: 'Status name as it appears in REI', 'aria-label': 'New status' });
  root.append(card({
    kicker: 'REI BlackBook', title: 'Lead statuses', sub: 'Tell the dashboard what your own REI statuses mean. Applies to the next import.',
    body: [statusBody, admin ? h('div', { class: 'btn-row' }, newStatus, button('Add status', () => { if (newStatus.value.trim()) { statuses.add(newStatus.value.trim()); newStatus.value = ''; drawStatus(); } }, { small: true })) : null,
      h('div', { class: 'form-grid' }, h('div', { class: 'field' }, h('label', { for: 's-rei-score' }, 'Lead score that counts as qualified'),
        h('input', { class: 'input num', id: 's-rei-score', type: 'number', disabled: !admin, value: draft.rei.qualifiedScoreMin ?? 7, oninput: (e) => { draft.rei.qualifiedScoreMin = Number(e.target.value); } }),
        h('span', { class: 'hint' }, 'Used only when REI has no qualification column')))],
  }));

  // Attribution.
  const tnBody = h('div', { class: 'list' });
  const drawTn = () => {
    clear(tnBody);
    draft.attribution.trackingNumbers.forEach((t, i) => tnBody.append(h('div', { class: 'list-row' },
      h('input', { class: 'input', value: t.number, disabled: !admin, 'aria-label': 'Tracking number', oninput: (e) => { draft.attribution.trackingNumbers[i].number = e.target.value; } }),
      h('select', { class: 'select', disabled: !admin, 'aria-label': 'Channel', onchange: (e) => { draft.attribution.trackingNumbers[i].channel = e.target.value; } },
        h('option', { value: 'google_ads', selected: t.channel === 'google_ads' }, 'Google Ads'), h('option', { value: 'other', selected: t.channel !== 'google_ads' }, 'Other channel')),
      h('input', { class: 'input', value: t.label || '', disabled: !admin, placeholder: 'Label', 'aria-label': 'Label', oninput: (e) => { draft.attribution.trackingNumbers[i].label = e.target.value; } }),
      admin ? button('Remove', () => { draft.attribution.trackingNumbers.splice(i, 1); drawTn(); }, { kind: 'ghost', small: true }) : null)));
  };
  drawTn();
  root.append(card({
    kicker: 'Attribution', title: 'Tracking numbers and lead sources',
    sub: 'A call from a tracking number mapped to Google Ads counts as a Google Ads lead (medium confidence). Nothing else is guessed.',
    body: [tnBody,
      admin ? button('Add tracking number', () => { draft.attribution.trackingNumbers.push({ number: '', channel: 'google_ads', label: '' }); drawTn(); }, { small: true }) : null,
      h('div', { class: 'form-grid' },
        h('div', { class: 'field' }, h('label', { for: 's-ppc-words' }, 'Lead source words that mean Google Ads'), h('input', { class: 'input', id: 's-ppc-words', disabled: !admin, value: draft.attribution.ppcSourcePatterns.join(', '), oninput: (e) => { draft.attribution.ppcSourcePatterns = e.target.value.split(',').map((x) => x.trim()).filter(Boolean); } })),
        h('div', { class: 'field' }, h('label', { for: 's-other-words' }, 'Lead source words for other channels'), h('input', { class: 'input', id: 's-other-words', disabled: !admin, value: draft.attribution.otherSourcePatterns.join(', '), oninput: (e) => { draft.attribution.otherSourcePatterns = e.target.value.split(',').map((x) => x.trim()).filter(Boolean); } })),
        h('div', { class: 'field' }, h('label', { for: 's-call-window' }, 'Match calls to leads within'), h('input', { class: 'input num', id: 's-call-window', type: 'number', disabled: !admin, value: draft.attribution.callMatchWindowDays, oninput: (e) => { draft.attribution.callMatchWindowDays = Number(e.target.value); } }), h('span', { class: 'hint' }, 'days')),
        h('div', { class: 'field' }, h('label', { for: 's-consent' }, 'Share of visitors who accept ad cookies'), h('input', { class: 'input num', id: 's-consent', type: 'number', min: '0', max: '100', disabled: !admin, value: draft.retargeting.consentRate == null ? '' : PPC.round(draft.retargeting.consentRate * 100, 0), placeholder: 'from GA4 if blank', oninput: (e) => { draft.retargeting.consentRate = e.target.value === '' ? null : Number(e.target.value) / 100; } }), h('span', { class: 'hint' }, 'percent, for retargeting list sizes'))),
    ],
  }));
  if (state.settings?.updatedAt) root.append(h('p', { class: 'muted small' }, `Last saved ${fmt.dateTime(state.settings.updatedAt)}${state.settings.updatedBy ? ` by ${nameOf(state.settings.updatedBy)}` : ''}.`));
}

/** Stored settings on top of the engine defaults (for editing). */
function settingsWithDefaults(stored = {}) {
  const st = stored || {};
  return {
    decision: { ...PPC.DEFAULT_DECISION_SETTINGS, ...(st.decision || {}) },
    actions: { ...PPC.DEFAULT_ACTION_SETTINGS, ...(st.actions || {}) },
    waste: { ...PPC.DEFAULT_WASTE_SETTINGS, ...(st.waste || {}) },
    alerts: { ...PPC.DEFAULT_ALERT_SETTINGS, ...(st.alerts || {}) },
    geo: (st.geo?.length ? st.geo : PPC.DEFAULT_GEO).map((g) => ({ ...g })),
    situations: (st.situations?.length ? st.situations : PPC.DEFAULT_SITUATIONS).map((x) => ({ ...x, patterns: [...(x.patterns || [])] })),
    rei: { statusMap: {}, qualifiedScoreMin: 7, ...(st.rei || {}) },
    attribution: {
      ...PPC.DEFAULT_ATTRIBUTION_SETTINGS, ...(st.attribution || {}),
      trackingNumbers: [...(st.attribution?.trackingNumbers || [])].map((t) => ({ ...t })),
      ppcSourcePatterns: [...(st.attribution?.ppcSourcePatterns || PPC.DEFAULT_ATTRIBUTION_SETTINGS.ppcSourcePatterns)],
      otherSourcePatterns: [...(st.attribution?.otherSourcePatterns || PPC.DEFAULT_ATTRIBUTION_SETTINGS.otherSourcePatterns)],
    },
    retargeting: { consentRate: null, ...(st.retargeting || {}) },
  };
}
