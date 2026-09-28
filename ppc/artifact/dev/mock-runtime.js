// Local stand-in for the claude.ai artifact runtime (window.claude.use), for
// running and testing the dashboard outside claude.ai. It talks to the dev
// server (ppc/scripts/serve-dashboard.mjs), which keeps one shared store, so
// two browsers (say an admin and a viewer) see each other's changes, just as
// in claude.ai. Role comes from ?role=admin|manager|viewer (default admin).
(function () {
  const params = new URLSearchParams(location.search);
  const role = params.get('role') || 'admin';
  const userId = params.get('user') || `u_${role}`;
  const disabled = new Set((params.get('off') || '').split(',').filter(Boolean));
  const headers = { 'content-type': 'application/json', 'x-mock-role': role, 'x-mock-user': userId };
  const api = async (method, url, body) => {
    const res = await fetch(url, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.message || `HTTP ${res.status}`), { code: json.code || 'unavailable' });
    return json;
  };
  const snap = (path, data) => ({ id: path.split('/').pop(), exists: data != null, data: () => (data == null ? undefined : structuredClone(data)), metadata: { fromCache: false, hasPendingWrites: false } });
  const listeners = new Set();
  const poll = () => { for (const l of listeners) l(); };
  setInterval(poll, 400);
  const checkPath = (p, even) => {
    const segs = p.split('/');
    if (segs.some((x) => !/^[A-Za-z0-9_\-.~:@+]+$/.test(x) || x === '.' || x === '..')) throw new TypeError(`bad path segment in ${p}`);
    if ((segs.length % 2 === 0) !== even) throw new TypeError(`${p}: ${segs.length} segments`);
  };
  function docRef(path) {
    checkPath(path, true);
    return {
      id: path.split('/').pop(), path,
      get: async () => snap(path, (await api('GET', `/__mock/db/doc?path=${encodeURIComponent(path)}`)).data),
      set: async (data) => { await api('PUT', `/__mock/db/doc?path=${encodeURIComponent(path)}`, data); poll(); },
      update: async (data) => { await api('PATCH', `/__mock/db/doc?path=${encodeURIComponent(path)}`, data); poll(); },
      delete: async () => { await api('DELETE', `/__mock/db/doc?path=${encodeURIComponent(path)}`); poll(); },
      onSnapshot(next, error) {
        let last;
        const run = async () => {
          try {
            const { data, version } = await api('GET', `/__mock/db/doc?path=${encodeURIComponent(path)}`);
            if (version !== last) { last = version; next(snap(path, data)); }
          } catch (e) { listeners.delete(run); if (error) error(e); }
        };
        listeners.add(run);
        run();
        return () => listeners.delete(run);
      },
      collection: (sub) => collRef(`${path}/${sub}`),
    };
  }
  function collRef(path, q = {}) {
    checkPath(path, false);
    const query = () => `/__mock/db/collection?path=${encodeURIComponent(path)}&orderBy=${encodeURIComponent(q.orderBy || '')}&dir=${q.dir || 'asc'}&limit=${q.limit || 1000}`;
    const toSnap = (docs) => ({ docs: docs.map((d) => snap(`${path}/${d.id}`, d.data)), size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } });
    return {
      path,
      doc: (id) => docRef(`${path}/${id || Math.random().toString(36).slice(2, 12)}`),
      add: async (data) => { const ref = docRef(`${path}/${Math.random().toString(36).slice(2, 12)}`); await ref.set(data); return ref; },
      where: () => collRef(path, q),
      orderBy: (field, dir = 'asc') => collRef(path, { ...q, orderBy: field, dir }),
      limit: (n) => collRef(path, { ...q, limit: n }),
      get: async () => toSnap((await api('GET', query())).docs),
      onSnapshot(next, error) {
        let last;
        const run = async () => {
          try {
            const { docs, version } = await api('GET', query());
            if (version !== last) { last = version; next(toSnap(docs)); }
          } catch (e) { listeners.delete(run); if (error) error(e); }
        };
        listeners.add(run);
        run();
        return () => listeners.delete(run);
      },
    };
  }
  const db = Object.freeze({ doc: docRef, collection: (p) => collRef(p) });
  const names = { u_admin: 'Alex Admin', u_manager: 'Morgan Manager', u_viewer: 'Val Viewer' };
  const profile = (id) => ({ id, name: names[id] || '', avatarUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', color: '#2a78d6', email: null, isMe: id === userId, guest: false });
  const user = Object.freeze({
    isOwner: async () => role === 'admin', canEdit: async () => role === 'admin',
    can: async (name) => (name === 'data.write' ? role !== 'viewer' : name === 'assets.write' || name === 'files.write' ? role === 'admin' : false),
    id: async () => (role === 'anon' ? null : userId), name: async () => names[userId] || '',
    me: async () => ({ ...profile(userId), isOwner: role === 'admin', canEdit: role === 'admin' }),
    profiles: async (ids) => Object.fromEntries([].concat(ids).map((id) => [id, profile(id)])),
    search: async () => [],
  });
  const assets = Object.freeze({
    upload: async (blob, opts = {}) => {
      const res = await fetch('/__mock/assets', { method: 'POST', headers: { 'content-type': opts.type || blob.type, 'x-mock-role': role }, body: blob });
      const json = await res.json();
      if (!res.ok) throw Object.assign(new Error(json.message), { code: json.code || 'upstream_error' });
      return json;
    },
    list: async () => api('GET', '/__mock/assets'),
    delete: async (ref) => api('DELETE', `/__mock/assets?id=${encodeURIComponent(String(ref).replace('/_blob/', ''))}`),
  });
  window.__mockDownloads = [];
  const downloads = Object.freeze({
    save: async ({ filename, data }) => {
      const text = typeof data === 'string' ? data : await new Response(data).text();
      window.__mockDownloads.push({ filename, text });
      await fetch('/__mock/downloads', { method: 'POST', headers, body: JSON.stringify({ filename, size: text.length }) });
      return { status: 'saved' };
    },
  });
  const mcp = Object.freeze({
    callTool: async (server, tool, input) => {
      if (server !== 'Google Drive') throw Object.assign(new Error('not in manifest'), { code: 'not_in_manifest' });
      if (params.get('drive') === 'reauth') throw Object.assign(new Error('token expired'), { code: 'needs_reauth', server });
      const out = await api('POST', `/__mock/drive/${tool}`, input);
      return { content: [{ type: 'text', text: JSON.stringify(out) }], payload: out };
    },
    listTools: async () => ({ servers: [{ server: 'Google Drive', authStatus: 'connected', tools: [{ name: 'search_files', description: '' }, { name: 'download_file_content', description: '' }] }] }),
    watchTool: () => () => {},
    invalidate: async () => {},
  });
  window.__mockComments = [];
  const comments = Object.freeze({ openComposer: async ({ element }) => { window.__mockComments.push(element?.getAttribute?.('aria-label') || element?.tagName); return { opened: true }; } });
  const permissions = Object.freeze({ state: async () => 'granted', request: async () => ({}) });
  const caps = { db, user, assets: role === 'admin' ? assets : null, downloads, mcp, comments, permissions };
  window.claude = Object.freeze({
    use: (name) => new Promise((resolve) => setTimeout(() => resolve(disabled.has(name) ? null : caps[name] ?? null), 30)),
  });
})();
