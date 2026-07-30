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
const msgName = (id) => (id ? id.replace(/^(L10|PH)-/, 'Message ') : '');
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
  } else if (cfg.watchOnly) {
    note.className = 'note';
    note.textContent = 'Live · Watch only — the bot logs into REI and checks each lead, but does NOT opt-in or send. Nothing is changed.';
    $('modePill').textContent = 'Live · Watch';
  } else if (!cfg.allowLiveSend) {
    note.className = 'note';
    note.textContent = 'Live — connected to REI, but sending is OFF. It will prepare each lead and stop before sending.';
    $('modePill').textContent = 'Live · No send';
  } else {
    note.className = 'note live';
    note.textContent = 'Live — approved messages WILL be sent to real homeowners.';
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

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderResults(results) {
  const tb = $('resultsTable').querySelector('tbody');
  if (!results.length) {
    tb.innerHTML = '<tr><td colspan="6" class="muted" style="padding:18px">No leads processed yet.</td></tr>';
    $('reviewCount').textContent = '';
    return;
  }
  tb.innerHTML = results.map((r, i) => {
    const o = outcome(r.L10_Disposition);
    const nameText = esc(r.name || r.contactId);
    const nameCell = r.reiUrl
      ? `<a class="rei" href="${esc(r.reiUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${nameText} ↗</a>`
      : nameText;
    const reply = r.L10_ReplyClass && r.L10_ReplyClass !== 'none' ? r.L10_ReplyClass : '';
    const detail = `
      <tr class="detail" id="d${i}" style="display:none"><td></td><td colspan="5">
        ${r.message ? `<div class="msg">${esc(r.message)}</div>` : '<div class="small muted">No message prepared for this lead.</div>'}
        <div class="small"><b>ProfitDial:</b> ${esc(r.L10_ProfitDial || '—')} &nbsp;·&nbsp; <b>Opt-in:</b> ${esc(r.L10_OptInStatus || '—')} &nbsp;·&nbsp; <b>Delivery:</b> ${esc(r.delivery || '—')}</div>
        <div class="small muted" style="margin-top:4px"><b>Notes:</b> ${esc(r.L10_Reason || '')}</div>
      </td></tr>`;
    return `<tr class="lead-row" data-i="${i}">
      <td><span class="chev">▸</span></td>
      <td>${nameCell}</td>
      <td>${esc(r.phone || '')}</td>
      <td><span class="tag ${o.cls}">${o.label}</span></td>
      <td>${esc(msgName(r.L10_TemplateId))}</td>
      <td>${esc(reply)}</td>
    </tr>${detail}`;
  }).join('');

  tb.querySelectorAll('.lead-row').forEach((row) => {
    row.onclick = () => {
      const i = row.getAttribute('data-i');
      const d = document.getElementById('d' + i);
      const open = d.style.display !== 'none';
      d.style.display = open ? 'none' : '';
      row.classList.toggle('open', !open);
    };
  });
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
const leadLimit = () => parseInt($('limit').value || '0', 10) || 0;
$('btnLoadSample').onclick = async () => {
  const r = await api('/api/sandbox/load', { method: 'POST' });
  $('loadInfo').textContent = r.ok ? `Loaded ${r.scenarios} sample leads. Click Start.` : 'Error: ' + r.error;
};
$('pdFile').onchange = async (e) => {
  const fd = new FormData(); fd.append('file', e.target.files[0]); fd.append('limit', leadLimit());
  const r = await api(`/api/upload/profitdial?limit=${leadLimit()}`, { method: 'POST', body: fd });
  $('loadInfo').textContent = r.ok
    ? `Loaded ${r.leadCount} of ${r.totalRows} leads from your sheet (${r.analysis.blankProfitDial} missing ProfitDial). Click Start.`
    : 'Error: ' + r.error;
};
$('btnGoogleSheet').onclick = async () => {
  const url = $('gsUrl').value.trim();
  if (!url) return alert('Paste your Google Sheet link first.');
  const r = await api('/api/ingest/googlesheet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, limit: leadLimit() }) });
  $('loadInfo').textContent = r.ok
    ? `Loaded ${r.leadCount} of ${r.rowCount} leads from your sheet. Click Start.`
    : (r.error || 'Error');
};
// ---- printable daily report ----
$('btnPrint').onclick = async () => {
  const [k, cfg, state] = await Promise.all([api('/api/kpi'), api('/api/config'), api('/api/state')]);
  const date = new Date().toLocaleString();
  const modeTxt = cfg.sandbox ? 'Test Mode (no messages sent)' : 'Live';
  const kv = (l, v) => `<tr><td>${l}</td><td style="text-align:right"><b>${v}</b></td></tr>`;
  const trow = (t) => `<tr><td>${msgName(t.id)}</td><td>${t.sent}</td><td>${t.delivered} (${t.deliveryRate}%)</td><td>${t.replies} (${t.responseRate}%)</td><td>${t.positive}</td><td>${t.optOut}</td></tr>`;
  const issues = Object.entries(k.dataIssues.breakdown || {}).map(([d, n]) => `${d}: ${n}`).join('<br>') || 'None';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Level 10 Daily Report</title>
    <style>
      body{font:14px/1.5 Arial,sans-serif;color:#111;margin:32px;}
      h1{font-size:20px;margin:0 0 2px} h2{font-size:15px;margin:22px 0 8px;border-bottom:1px solid #ccc;padding-bottom:4px}
      .sub{color:#666;font-size:13px;margin-bottom:6px}
      table{border-collapse:collapse;width:100%;font-size:13px} td,th{border:1px solid #ddd;padding:7px 10px;text-align:left}
      th{background:#f3f4f6} .half{max-width:380px}
      @media print{button{display:none}}
    </style></head><body>
    <h1>Twin Home Buyer — Level 10 SMS Outreach</h1>
    <div class="sub">Daily KPI Report · ${date} · ${modeTxt} · Campaign: ${esc(cfg.campaignBatch)}</div>
    <h2>Production</h2>
    <table class="half">${kv('Total assigned', k.production.assigned)}${kv('Processed', k.production.processed)}${kv('Numbers opted in', k.production.optedIn)}${kv('SMS ' + (cfg.sandbox ? 'ready to send' : 'sent'), k.production.smsSent)}</table>
    <h2>Delivery</h2>
    <table class="half">${kv('Delivered', k.delivery.delivered)}${kv('Failed', k.delivery.failed)}${kv('Delivery rate', k.delivery.deliveryRate + '%')}</table>
    <h2>Engagement</h2>
    <table class="half">${kv('Total replies', k.engagement.replies)}${kv('Positive', k.engagement.positive)}${kv('Negative', k.engagement.negative)}${kv('Opt-outs', k.engagement.optOuts)}${kv('Response rate', k.engagement.responseRate + '%')}</table>
    <h2>Template Performance</h2>
    <table><tr><th>Message</th><th>Sent</th><th>Delivered</th><th>Replies</th><th>Positive</th><th>Opt-outs</th></tr>${k.templatePerformance.map(trow).join('') || '<tr><td colspan=6>No messages yet</td></tr>'}</table>
    <div class="sub" style="margin-top:6px">Best performing: <b>${k.bestTemplate ? msgName(k.bestTemplate) : '—'}</b></div>
    <h2>Data Issues (${k.dataIssues.total})</h2>
    <div>${issues}</div>
    <p style="margin-top:24px"><button onclick="window.print()">Print</button></p>
    </body></html>`;
  const w = window.open('', '_blank');
  w.document.write(html);
  w.document.close();
  setTimeout(() => w.print(), 400);
};

$('btnStart').onclick = async () => { const r = await api('/api/start', { method: 'POST' }); if (!r.ok) alert('Cannot start: ' + r.error); };
$('btnPause').onclick = () => api('/api/pause', { method: 'POST' });
$('btnResume').onclick = () => api('/api/resume', { method: 'POST' });
$('btnStop').onclick = () => api('/api/stop', { method: 'POST' });

loadConfig();
connectSSE();
