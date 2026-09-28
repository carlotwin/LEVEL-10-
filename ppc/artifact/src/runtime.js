// ---------------------------------------------------------------------------
// Runtime capabilities: shared database, who is viewing, dataset storage,
// downloads, Google Drive (the viewer's own connector) and comments.
// Every capability may be missing in a given view; the page works without it.
// ---------------------------------------------------------------------------
const rt = { db: null, user: null, assets: null, downloads: null, mcp: null, comments: null, permissions: null, ready: false };
const me = { id: null, isOwner: false, canEdit: false, canWrite: null, role: 'viewer', writeRefused: false };
const DRIVE = 'Google Drive';

async function initRuntime() {
  if (!window.claude || typeof window.claude.use !== 'function') {
    rt.ready = true;
    return rt;
  }
  const names = ['db', 'user', 'assets', 'downloads', 'mcp', 'comments', 'permissions'];
  const got = await Promise.all(names.map((n) => window.claude.use(n).catch(() => null)));
  names.forEach((n, i) => { rt[n] = got[i]; });
  if (rt.user) {
    const [isOwner, canEdit, canWrite, id] = await Promise.all([
      rt.user.isOwner().catch(() => false), rt.user.canEdit().catch(() => false),
      rt.user.can('data.write').catch(() => null), rt.user.id().catch(() => null),
    ]);
    Object.assign(me, { isOwner, canEdit, canWrite, id });
  }
  updateRole();
  rt.ready = true;
  return rt;
}

/** admin = editor (settings, imports); manager = may approve actions; viewer = read only. */
function updateRole() {
  if (!rt.db) me.role = 'viewer';
  else if (me.canEdit) me.role = 'admin';
  else if (me.canWrite === false || me.writeRefused) me.role = 'viewer';
  else me.role = 'manager';
}
const ROLE_LABEL = { admin: 'Admin', manager: 'Manager', viewer: 'Viewer' };
const ROLE_HINT = {
  admin: 'You can import data, change settings and approve actions.',
  manager: 'You can approve or reject actions. Settings and imports need an editor.',
  viewer: 'Read only. Ask an editor for Contributor access to approve actions.',
};
const can = {
  approve: () => me.role === 'admin' || me.role === 'manager',
  admin: () => me.role === 'admin',
  import: () => me.role === 'admin' && !!rt.assets,
};

/** Wrap a shared-data write: a refused write means this viewer is read-only. */
async function dbWrite(fn, what) {
  if (!rt.db) {
    toast('Saving is not available in this view.', 'bad');
    return false;
  }
  try {
    await fn();
    return true;
  } catch (e) {
    if (e?.code === 'invalid_argument') {
      if (!me.canEdit) { me.writeRefused = true; updateRole(); renderAll(); }
      toast(`You do not have permission to ${what}.`, 'bad');
    } else if (e?.code === 'quota_exceeded') {
      toast('The shared store is full. Delete old import history, then try again.', 'bad');
    } else if (e?.code === 'resource_exhausted') {
      toast('Too many changes at once. Wait a moment and try again.', 'bad');
    } else {
      toast(`Could not ${what}. Try again in a moment.`, 'bad');
    }
    return false;
  }
}

// ---------------------------------------------------------------- subscriptions
function subscribeShared(onChange) {
  if (!rt.db) return;
  const err = (label) => (e) => {
    if (e?.code !== 'revoked') console.warn(`Live updates for ${label} stopped:`, e?.code);
  };
  rt.db.doc('config/dataset').onSnapshot((snap) => onChange('pointer', snap.exists ? snap.data() : null), err('dataset'));
  rt.db.doc('config/settings').onSnapshot((snap) => onChange('settings', snap.exists ? snap.data() : null), err('settings'));
  rt.db.doc('config/overrides').onSnapshot((snap) => onChange('overrides', snap.exists ? snap.data() : null), err('overrides'));
  rt.db.collection('actions').onSnapshot((snap) => {
    const map = {};
    for (const d of snap.docs) map[d.id] = d.data();
    onChange('decisions', map);
  }, err('actions'));
  rt.db.collection('alerts').onSnapshot((snap) => {
    const map = {};
    for (const d of snap.docs) map[d.id] = d.data();
    onChange('acks', map);
  }, err('alerts'));
  rt.db.collection('imports').orderBy('at', 'desc').limit(30).onSnapshot((snap) => {
    onChange('imports', snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }, err('imports'));
}

// ---------------------------------------------------------------- datasets
async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function loadDemoDataset() {
  return fetchJson('demo-dataset.json');
}
async function loadSharedDataset(pointer) {
  const ds = await fetchJson(`/_blob/${pointer.assetId}`);
  const v = PPC.validateDataset(ds);
  if (!v.ok) throw new Error(v.errors.join(' '));
  return ds;
}

/** Store a new dataset version (admins). Keeps one step of undo. */
async function saveDataset(ds, previousPointer, note) {
  const v = PPC.validateDataset(ds);
  if (!v.ok) throw new Error(v.errors.join(' '));
  if (!rt.assets) throw new Error('Uploading needs editor access to this dashboard.');
  const blob = new Blob([JSON.stringify(ds)], { type: 'application/json' });
  const up = await rt.assets.upload(blob, { type: 'application/json' });
  const pointer = {
    assetId: up.id, previousAssetId: previousPointer?.assetId || null, isDemo: !!ds.isDemo,
    uploadedAt: new Date().toISOString(), uploadedBy: me.id || '', note: String(note || '').slice(0, 200),
    summary: PPC.summarizeDataset(ds), schema: PPC.DATASET_SCHEMA, engine: PPC.ENGINE_VERSION,
  };
  const ok = await dbWrite(() => rt.db.doc('config/dataset').set(pointer), 'save the data');
  if (!ok) {
    rt.assets.delete(up.id).catch(() => {});
    throw new Error('The data was not saved.');
  }
  // The version before the previous one is no longer referenced by anything.
  const stale = previousPointer?.previousAssetId;
  if (stale && stale !== up.id && stale !== previousPointer?.assetId) rt.assets.delete(stale).catch(() => {});
  return pointer;
}

/** Undo swaps the current and previous versions (so it can be undone too). */
function canUndo(pointer) {
  return !!(pointer && (pointer.assetId || pointer.previousAssetId) && pointer.assetId !== pointer.previousAssetId);
}
async function undoDataset(pointer) {
  if (!canUndo(pointer)) return false;
  const backId = pointer.previousAssetId || null;
  const back = backId ? await fetchJson(`/_blob/${backId}`).catch(() => null) : null;
  if (backId && !back) {
    toast('The previous version is no longer available.', 'bad');
    return false;
  }
  return dbWrite(() => rt.db.doc('config/dataset').set({
    assetId: backId, previousAssetId: pointer.assetId || null, isDemo: !backId || !!back?.isDemo, uploadedAt: new Date().toISOString(),
    uploadedBy: me.id || '', note: backId ? 'Restored the previous version' : 'Back to demo data',
    summary: back ? PPC.summarizeDataset(back) : null, schema: PPC.DATASET_SCHEMA, engine: PPC.ENGINE_VERSION,
  }), 'restore the previous data');
}

async function useDemoData(pointer) {
  const ok = await dbWrite(() => rt.db.doc('config/dataset').set({
    assetId: null, previousAssetId: pointer?.assetId || null, isDemo: true, uploadedAt: new Date().toISOString(),
    uploadedBy: me.id || '', note: 'Switched to demo data', summary: null, schema: PPC.DATASET_SCHEMA, engine: PPC.ENGINE_VERSION,
  }), 'switch to demo data');
  // The version before the current one drops out of the undo chain.
  const dropped = pointer?.previousAssetId;
  if (ok && dropped && dropped !== pointer?.assetId && rt.assets) rt.assets.delete(dropped).catch(() => {});
  return ok;
}

// ---------------------------------------------------------------- downloads
async function offerDownload(filename, data) {
  if (!rt.downloads) {
    toast('Downloads are not available in this view.', 'bad');
    return;
  }
  try {
    await rt.downloads.save({ filename, data });
  } catch (e) {
    if (e?.code === 'declined') return;
    if (e?.code === 'rate_limited') toast('A download is already waiting for your answer.');
    else toast('The download could not start here.', 'bad');
  }
}

// ---------------------------------------------------------------- Google Drive (viewer's connector)
function driveErrorText(e) {
  switch (e?.code) {
    case 'needs_reauth': return 'Reconnect Google Drive in claude.ai Settings → Connectors, then try again.';
    case 'server_not_connected': return 'Add the Google Drive connector in claude.ai Settings → Connectors to sync from Drive.';
    case 'selection_required': return 'You have more than one Google Drive connector. Choose one when claude.ai asks, then try again.';
    case 'not_in_manifest': return 'Google Drive is not allowed for this page. Allow it from the page permissions, then try again.';
    case 'blocked_by_policy':
    case 'approval_required': return 'Your organization blocks this Google Drive action here.';
    case 'server_unavailable': return 'Google Drive is not responding right now. Try again in a minute.';
    case 'tool_error': return `Google Drive could not do that: ${e.message || 'unknown error'}`;
    case 'consent_required': return 'Allow Google Drive for this page when asked, then try again.';
    default: return 'The Google Drive request did not finish. Try again.';
  }
}
async function driveCall(tool, input) {
  if (!rt.mcp) throw Object.assign(new Error('Google Drive is not available in this view.'), { code: 'not_granted' });
  let attempt = 0;
  for (;;) {
    try {
      const res = await rt.mcp.callTool(DRIVE, tool, input);
      let p = res?.payload;
      if (typeof p === 'string') { try { p = JSON.parse(p); } catch { /* leave as text */ } }
      return p;
    } catch (e) {
      // Reads only: one retry for errors marked retryable.
      if (e?.retryable && attempt === 0) {
        attempt += 1;
        await new Promise((r) => setTimeout(r, Math.min(e.retryAfterMs || 1500, 60000) + Math.random() * 500));
        continue;
      }
      throw e;
    }
  }
}
async function driveSearch(query) {
  const p = await driveCall('search_files', { query, pageSize: 20, excludeContentSnippets: true });
  return Array.isArray(p?.files) ? p.files : [];
}
function base64ToBytes(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
async function driveDownload(file) {
  const input = { fileId: file.id };
  if (file.mimeType === 'application/vnd.google-apps.spreadsheet') input.exportMimeType = 'text/csv';
  const p = await driveCall('download_file_content', input);
  if (!p || typeof p.content !== 'string') throw Object.assign(new Error('Google Drive returned no file content.'), { code: 'tool_error', message: 'no file content returned' });
  return base64ToBytes(p.content);
}

// ---------------------------------------------------------------- files (CSV / XLSX / JSON)
let sheetJsPromise = null;
function loadSheetJs() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!sheetJsPromise) {
    sheetJsPromise = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      el.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error('The Excel reader did not load.')));
      el.onerror = () => { sheetJsPromise = null; reject(new Error('The Excel reader could not be loaded.')); };
      document.head.append(el);
    });
  }
  return sheetJsPromise;
}
const isExcel = (name, bytes) => /\.xlsx?$/i.test(name) || (bytes && bytes[0] === 0x50 && bytes[1] === 0x4b);
/** Bytes -> text for the importers. Excel sheets become CSV (first sheet). */
async function bytesToText(name, bytes) {
  if (isExcel(name, bytes)) {
    const XLSX = await loadSheetJs();
    const wb = XLSX.read(bytes, { type: 'array', cellDates: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
  }
  return new TextDecoder('utf-8').decode(bytes);
}
