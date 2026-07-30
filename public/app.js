'use strict';
const $ = (id) => document.getElementById(id);
const api = (url, opts) => fetch(url, opts).then((r) => r.json());

let MODE = 'test';

// Friendly labels — no technical jargon.
const OUTCOME = {
  'Simulated Sent': { label: 'Ready to send', cls: 'ok' },
  'Text Sent': { label: 'Sent', cls: 'ok' },
  'Needs Review': { label: 'Needs review', cls: 'warn' },
  'Missing ProfitDial': { label: 'No ProfitDial assigned', cls: 'warn' },
  'Multiple ProfitDial Assignments': { label: 'Multiple ProfitDials', cls: 'warn' },
  'ProfitDial Unavailable in REI': { label: 'ProfitDial not available', cls: 'warn' },
  'ProfitDial Readback Mismatch': { label: 'ProfitDial mismatch', cls: 'warn' },
  'Sheet/REI Conflict': { label: 'Data conflict', cls: 'warn' },
  'Invalid Merge Field': { label: 'Name missing', cls: 'warn' },
  'Multiple Phone Numbers': { label: 'Multiple phones', cls: 'warn' },
  'Invalid Phone': { label: 'Invalid phone', cls: 'warn' },
  'Opt-In Failed': { label: 'Could not opt in', cls: 'warn' },
  'Send Verification Failed': { label: 'Send not confirmed', cls: 'warn' },
  'Opted Out': { label: 'Opted out', cls: 'skip' },
  'Do Not Contact': { label: 'Do not contact', cls: 'skip' },
  'Already Processed': { label: 'Already texted', cls: 'skip' },
  'Missing Level 10 Tag': { label: 'Not Level 10', cls: 'skip' },
  'Out of State': { label: 'Out of state', cls: 'skip' },
  'Lead Not Found': { label: 'Not found', cls: 'skip' },
  'Error': { label: 'Error', cls: 'bad' },
  'Template Blocked (placeholder in live)': { label: 'Message not approved', cls: 'bad' },
};
const outcome = (d) => OUTCOME[d] || { label: d, cls: 'skip' };
const msgName = (id) => (id ? id.replace(/^PH-/, 'Message ') : '');
const isSent = (d) => d === 'Simulated Sent' || d === 'Text Sent';

// ---- config / header ----
async function loadConfig() {
  const cfg = await api('/api/config');
  MODE = cfg.sandbox ? 'test' : 'live';
  const pill = $('modePill');
  pill.textContent = cfg.sandbox ? 'Test Mode' : 'Live';
  pill.className = 'pill-mode' + (cfg.sandbox ? '' : ' live');
  const note = $('note');
  if (cfg.sandbox) {
    note.className = 'note';
    note.textContent = 'Test Mode — every lead is checked and prepared, but no text messages are actually sent.';
  } else {
    note.className = 'note live';
    note.textContent = 'Live — approved messages will be sent to real homeowners.';
  }
}

// ---- controls state ----
function setControls(status, hasJob) {
  $('btnStart').disabled = !hasJob || status === 'running' || status === 'done';
  $('btnPause').disabled = status !== 'running';
  $('btnResume').disabled = status !== 'paused';
  $('btnStop').disabled = status !== 'running' && status !== 'paused';
}
function renderStatus(s) {
  const chip = $('runStatus');
  chip.textContent = s.status;
  chip.className = 'status ' + s.status;
  const pct = s.total ? Math.round((s.cursor / s.total) * 100) : 0;
  $('progressBar').style.width = pct + '%';
  $('progressText').textContent = s.total ? `${s.cursor} of ${s.total} leads processed` : 'No leads loaded yet.';
  setControls(s.status, s.total > 0);
}

function renderResults(results) {
  const tb = $('resultsTable').querySelector('tbody');
  if (!results.length) {
    tb.innerHTML = '<tr><td colspan="6" class="muted" style="padding:18px">No leads processed yet.</td></tr>';
    $('reviewCount').textContent = '';
    return;
  }
  tb.innerHTML = results.map((r) => {
    const o = outcome(r.L10_Disposition);
    return `<tr>
      <td>${r.contactId}</td>
      <td>${r.phone || ''}</td>
      <td><span class="tag ${o.cls}">${o.label}</span></td>
      <td>${msgName(r.L10_TemplateId)}</td>
      <td>${r.L10_ReplyClass && r.L10_ReplyClass !== 'none' ? r.L10_ReplyClass : ''}</td>
      <td class="note-cell">${r.L10_Reason || ''}</td>
    </tr>`;
  }).join('');
  const review = results.filter((r) => outcome(r.L10_Disposition).cls === 'warn').length;
  $('reviewCount').textContent = review ? `${review} need review` : '';
}

async function refreshKpi() {
  const k = await api('/api/kpi');
  const sentLabel = MODE === 'test' ? 'Ready to send' : 'Sent';
  const tiles = [
    ['Processed', k.production.processed, false],
    ['Opted in', k.production.optedIn, false],
    [sentLabel, k.production.smsSent, true],
    ['Delivered', k.delivery.delivered, false],
    ['Delivery rate', k.delivery.deliveryRate + '%', false],
    ['Replies', k.engagement.replies, false],
    ['Positive', k.engagement.positive, true],
    ['Opt-outs', k.engagement.optOuts, false],
  ];
  $('kpi').innerHTML = tiles.map(([l, n, hi]) =>
    `<div class="tile ${hi ? 'hi' : ''}"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');

  const tb = $('templateTable').querySelector('tbody');
  tb.innerHTML = k.templatePerformance.length
    ? k.templatePerformance.map((t) =>
        `<tr><td>${msgName(t.id)}</td><td>${t.sent}</td><td>${t.delivered} (${t.deliveryRate}%)</td><td>${t.replies} (${t.responseRate}%)</td><td>${t.positive}</td><td>${t.optOut}</td></tr>`).join('')
    : '<tr><td colspan="6" class="muted" style="padding:16px">No messages prepared yet.</td></tr>';
  $('bestTemplate').textContent = k.bestTemplate ? `Best so far: ${msgName(k.bestTemplate)}` : '';
}

// ---- live updates ----
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
}

// ---- actions ----
$('btnLoadSample').onclick = async () => {
  const r = await api('/api/sandbox/load', { method: 'POST' });
  $('loadInfo').textContent = r.ok ? `Loaded ${r.scenarios} sample leads. Click Start.` : 'Error: ' + r.error;
};
$('contactFile').onchange = async (e) => {
  const fd = new FormData(); fd.append('file', e.target.files[0]);
  const r = await api('/api/upload/contacts', { method: 'POST', body: fd });
  $('loadInfo').textContent = r.ok ? `Loaded ${r.count} leads. Click Start.` : 'Error: ' + r.error;
};
$('pdFile').onchange = async (e) => {
  const fd = new FormData(); fd.append('file', e.target.files[0]);
  const r = await api('/api/upload/profitdial', { method: 'POST', body: fd });
  $('loadInfo').textContent = r.ok ? `ProfitDial sheet loaded (${r.analysis.totalRows} rows).` : 'Error: ' + r.error;
};
$('btnGoogleSheet').onclick = async () => {
  const url = $('gsUrl').value.trim();
  if (!url) return alert('Paste a Google Sheet link first.');
  const r = await api('/api/ingest/googlesheet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
  $('loadInfo').textContent = r.ok ? `ProfitDial sheet loaded (${r.rowCount} rows).` : (r.error || 'Error');
};
$('btnStart').onclick = async () => { const r = await api('/api/start', { method: 'POST' }); if (!r.ok) alert('Cannot start: ' + r.error); };
$('btnPause').onclick = () => api('/api/pause', { method: 'POST' });
$('btnResume').onclick = () => api('/api/resume', { method: 'POST' });
$('btnStop').onclick = () => api('/api/stop', { method: 'POST' });

loadConfig();
connectSSE();
