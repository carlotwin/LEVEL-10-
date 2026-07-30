'use strict';
const $ = (id) => document.getElementById(id);
const api = (url, opts) => fetch(url, opts).then((r) => r.json());

const SENT = ['Text Sent', 'Simulated Sent'];
const REVIEW = ['Needs Review', 'Missing ProfitDial', 'Multiple ProfitDial Assignments', 'ProfitDial Unavailable in REI', 'ProfitDial Readback Mismatch', 'Sheet/REI Conflict', 'Invalid Merge Field', 'Multiple Phone Numbers'];

function dispPill(d) {
  if (SENT.includes(d)) return `<span class="pill sent">${d}</span>`;
  if (REVIEW.includes(d)) return `<span class="pill review">${d}</span>`;
  if (d === 'Already Processed') return `<span class="pill neutral">${d}</span>`;
  return `<span class="pill block">${d}</span>`;
}

// ---- config / safety banner ----
async function loadConfig() {
  const cfg = await api('/api/config');
  const badge = $('modeBadge');
  badge.textContent = cfg.sandbox ? 'SANDBOX' : 'LIVE';
  badge.className = 'badge ' + (cfg.sandbox ? 'badge-sandbox' : 'badge-live');
  const banner = $('safetyBanner');
  if (cfg.sandbox) {
    banner.className = 'safety';
    banner.innerHTML = `🛡️ SANDBOX mode — no carrier is contacted. ALLOW_LIVE_SEND=${cfg.allowLiveSend}. Batch cap ${cfg.maxSendsPerRun}/run. Campaign batch: <b>${cfg.campaignBatch}</b>.` +
      (cfg.placeholderEnabled ? ' Placeholder templates are ENABLED (live sending is blocked until Cherry\'s approved copy is installed).' : '');
  } else {
    banner.className = 'safety warn';
    banner.textContent = '⚠️ LIVE mode selected but the live adapter is not implemented — runs will be refused. Keep SANDBOX=true.';
  }
  const pool = $('templatePool');
  pool.innerHTML = cfg.templates.map((t) => `
    <div class="tpl">
      <div class="id">${t.id} ${t.enabled ? '' : '<span class="muted">(disabled)</span>'}</div>
      ${t.placeholder ? '<div class="ph">⚠ placeholder — sandbox only</div>' : ''}
      <div class="muted">${t.mergeOk ? 'merge ok' : '⚠ invalid merge field'}</div>
      <div>${t.preview}…</div>
    </div>`).join('');
}

// ---- state rendering ----
function setControls(status, hasJob) {
  $('btnStart').disabled = !hasJob || status === 'running' || status === 'done';
  $('btnPause').disabled = status !== 'running';
  $('btnResume').disabled = status !== 'paused';
  $('btnStop').disabled = status !== 'running' && status !== 'paused';
}
function renderStatus(s) {
  const chip = $('runStatus');
  chip.textContent = s.status;
  chip.className = 'status-chip ' + s.status;
  $('progress').textContent = `${s.cursor}/${s.total} processed · ${s.sendsThisRun} sent this run (cap ${s.maxSends})`;
  setControls(s.status, s.total > 0);
}
function renderResults(results) {
  const tb = $('resultsTable').querySelector('tbody');
  tb.innerHTML = results.map((r, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${r.contactId}</td>
      <td class="muted">${r.scenario || ''}</td>
      <td>${dispPill(r.L10_Disposition)}</td>
      <td>${r.L10_TemplateId || ''}</td>
      <td>${r.L10_ProfitDial || ''}</td>
      <td>${r.L10_OptInStatus || ''}</td>
      <td>${r.delivery || ''}</td>
      <td>${r.L10_ReplyClass || ''}</td>
      <td class="muted">${r.L10_Reason || ''}</td>
    </tr>`).join('');
}

async function refreshKpi() {
  const k = await api('/api/kpi');
  $('kpiCards').innerHTML = [
    ['Assigned', k.production.assigned],
    ['Processed', k.production.processed],
    ['Opted In', k.production.optedIn],
    ['SMS Sent', k.production.smsSent],
    ['Delivered', k.delivery.delivered],
    ['Delivery %', k.delivery.deliveryRate + '%'],
    ['Replies', k.engagement.replies],
    ['Positive', k.engagement.positive],
    ['Opt-Outs', k.engagement.optOuts],
    ['Response %', k.engagement.responseRate + '%'],
  ].map(([l, n]) => `<div class="card"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');

  const tb = $('templateTable').querySelector('tbody');
  tb.innerHTML = k.templatePerformance.map((t) => `
    <tr><td>${t.id}</td><td>${t.sent}</td><td>${t.delivered}</td><td>${t.deliveryRate}%</td><td>${t.replies}</td><td>${t.responseRate}%</td><td>${t.positive}</td><td>${t.positiveRate}%</td><td>${t.optOut}</td></tr>`).join('')
    || '<tr><td colspan="9" class="muted">No sends yet.</td></tr>';
  $('bestTemplate').innerHTML = k.bestTemplate ? `🏆 Best performing so far: <b>${k.bestTemplate}</b>` : '';
  $('dataIssues').innerHTML = k.dataIssues.total
    ? `⚠ ${k.dataIssues.total} data issue(s): ` + Object.entries(k.dataIssues.breakdown).map(([d, n]) => `${d} (${n})`).join(', ')
    : '';
}

// ---- SSE ----
function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => {
    const s = JSON.parse(e.data);
    renderStatus(s);
    renderResults(s.results || []);
    refreshKpi();
  });
  es.addEventListener('row', () => refreshKpi());
  es.addEventListener('done', () => refreshKpi());
  es.addEventListener('batch-cap', (e) => alert('Batch cap reached: ' + JSON.parse(e.data).cap + '. Resume to continue the next batch.'));
}

// ---- actions ----
$('btnLoadSandbox').onclick = async () => {
  const r = await api('/api/sandbox/load', { method: 'POST' });
  $('loadInfo').textContent = r.ok ? `Loaded ${r.scenarios} sandbox scenarios.` : 'Error: ' + r.error;
};
$('pdFile').onchange = async (e) => {
  const fd = new FormData();
  fd.append('file', e.target.files[0]);
  const r = await api('/api/upload/profitdial', { method: 'POST', body: fd });
  const box = $('sheetAnalysis');
  if (r.ok) {
    box.classList.remove('hidden');
    const a = r.analysis;
    box.innerHTML = `<b>ProfitDial sheet "${r.tab}" ingested.</b><table>
      <tr><td>Total rows</td><td>${a.totalRows}</td></tr>
      <tr><td>Blank ProfitDial</td><td>${a.blankProfitDial}</td></tr>
      <tr><td>Distinct ProfitDial numbers</td><td>${a.distinctProfitDialNumbers}</td></tr>
      <tr><td>Duplicate phones</td><td>${a.duplicatePhones}</td></tr>
      <tr><td>Duplicate addresses</td><td>${a.duplicateAddresses}</td></tr>
      <tr><td>Contacts w/ multiple assignments</td><td>${a.contactsWithMultipleAssignments}</td></tr>
      <tr><td>Contact ID column</td><td>${a.contactIdAvailable ? 'yes' : 'no'}</td></tr></table>`;
  } else {
    box.classList.remove('hidden');
    box.innerHTML = '<b style="color:#fca5a5">Error:</b> ' + r.error;
  }
};
$('btnGoogleSheet').onclick = async () => {
  const url = $('gsUrl').value.trim();
  if (!url) return alert('Paste a Google Sheet URL first.');
  const r = await api('/api/ingest/googlesheet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const box = $('sheetAnalysis');
  box.classList.remove('hidden');
  if (r.ok) {
    const a = r.analysis;
    box.innerHTML = `<b>Google Sheet ingested (${r.rowCount} rows).</b><table>
      <tr><td>Blank ProfitDial</td><td>${a.blankProfitDial}</td></tr>
      <tr><td>Distinct ProfitDial numbers</td><td>${a.distinctProfitDialNumbers}</td></tr>
      <tr><td>Duplicate phones</td><td>${a.duplicatePhones}</td></tr>
      <tr><td>Contacts w/ multiple assignments</td><td>${a.contactsWithMultipleAssignments}</td></tr>
      <tr><td>Contact ID column</td><td>${a.contactIdAvailable ? 'yes' : 'no'}</td></tr></table>`;
  } else {
    box.innerHTML = `<b style="color:#fca5a5">${r.code || 'Error'}:</b> ${r.error}`;
  }
};
$('contactFile').onchange = async (e) => {
  const fd = new FormData();
  fd.append('file', e.target.files[0]);
  const r = await api('/api/upload/contacts', { method: 'POST', body: fd });
  $('loadInfo').textContent = r.ok ? `Loaded ${r.count} contacts from ${e.target.files[0].name}.` : 'Error: ' + r.error;
};
$('btnStart').onclick = async () => {
  const r = await api('/api/start', { method: 'POST' });
  if (!r.ok) alert('Cannot start: ' + r.error);
};
$('btnPause').onclick = () => api('/api/pause', { method: 'POST' });
$('btnResume').onclick = () => api('/api/resume', { method: 'POST' });
$('btnStop').onclick = () => api('/api/stop', { method: 'POST' });

loadConfig();
connectSSE();
