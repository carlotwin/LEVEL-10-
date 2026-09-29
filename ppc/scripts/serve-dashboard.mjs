#!/usr/bin/env node
// Local preview of the dashboard with a stand-in for the claude.ai runtime:
// one shared store, asset storage, downloads and a fake Google Drive that
// serves the demo CSVs and the latest agent bundle. For trying the dashboard
// and for the end-to-end tests; the real dashboard runs on claude.ai.
//
//   node ppc/scripts/serve-dashboard.mjs [--port=4173] [--no-build]
//   open http://localhost:4173/?role=admin   (or manager / viewer)
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPage } from './build-artifact.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ppc = path.resolve(here, '..');
const arg = (name, dflt) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? dflt;

// Google-native entries like the ones a real Drive search returns: a folder
// (the page's query excludes folders) and a Google Doc (the page leaves out
// what it cannot import). Neither can be downloaded here.
const DRIVE_NATIVE = [
  { id: 'mock-folder', title: 'landing-pages archive', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-01-05T17:00:00.000Z' },
  { id: 'mock-doc', title: 'landing-pages notes', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-01-05T17:00:00.000Z' },
];

export function createDashboardServer({ driveDirs = [path.join(ppc, 'demo/csv'), path.join(ppc, '..', 'data/ppc/out')] } = {}) {
  let page = buildPage();
  const docs = new Map(); // path -> {data, version}
  const assets = new Map(); // id -> {type, body}
  const downloads = [];
  let version = 0;
  const roleOf = (req) => String(req.headers['x-mock-role'] || 'admin');
  const send = (res, code, body, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
  // Same levels as the published rules: config/* needs admin, everything else interact.
  const canWrite = (role, p) => (p.startsWith('config/') ? role === 'admin' : role === 'admin' || role === 'manager');
  const driveFiles = () => {
    const out = [];
    for (const dir of driveDirs) {
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = statSync(full);
        if (!st.isFile()) continue;
        out.push({ id: Buffer.from(full).toString('base64url'), title: name, mimeType: name.endsWith('.json') ? 'application/json' : 'text/csv', modifiedTime: st.mtime.toISOString(), fileSize: String(st.size), full });
      }
    }
    return out;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (p === '/' || p === '/index.html') {
        if (url.searchParams.get('rebuild') !== '0') page = buildPage();
        const mock = url.searchParams.get('mock') !== '0' ? '<script src="/__mock/runtime.js"></script>' : '';
        return send(res, 200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">${mock}<style>html{color-scheme:light}body{margin:0}[hidden]{display:none!important}img{max-width:100%}</style></head><body>${page}</body></html>`, 'text/html; charset=utf-8');
      }
      if (p === '/demo-dataset.json') return send(res, 200, readFileSync(path.join(ppc, 'demo/demo-dataset.json')), 'application/json');
      if (p === '/__mock/runtime.js') return send(res, 200, readFileSync(path.join(ppc, 'artifact/dev/mock-runtime.js')), 'text/javascript');
      if (p === '/__mock/db/doc') {
        const dp = url.searchParams.get('path');
        if (req.method === 'GET') return send(res, 200, { data: docs.get(dp)?.data ?? null, version: docs.get(dp)?.version ?? 0 });
        if (!canWrite(roleOf(req), dp)) return send(res, 403, { code: 'invalid_argument', message: 'write below the minimum level' });
        if (req.method === 'DELETE') { docs.delete(dp); version += 1; return send(res, 200, {}); }
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        if (JSON.stringify(body).length > 256 * 1024) return send(res, 400, { code: 'invalid_argument', message: 'document over 256 KiB' });
        version += 1;
        if (req.method === 'PATCH') {
          if (!docs.has(dp)) return send(res, 400, { code: 'invalid_argument', message: 'update of a missing document' });
          docs.set(dp, { data: { ...docs.get(dp).data, ...body }, version });
        } else docs.set(dp, { data: body, version });
        return send(res, 200, {});
      }
      if (p === '/__mock/db/collection') {
        const cp = url.searchParams.get('path');
        const orderBy = url.searchParams.get('orderBy');
        const dir = url.searchParams.get('dir') === 'desc' ? -1 : 1;
        const limit = Number(url.searchParams.get('limit') || 1000);
        let list = [...docs.entries()].filter(([k]) => k.startsWith(`${cp}/`) && k.split('/').length === cp.split('/').length + 1)
          .map(([k, v]) => ({ id: k.split('/').pop(), data: v.data, v: v.version }));
        if (orderBy) list.sort((a, b) => String(a.data[orderBy] ?? '').localeCompare(String(b.data[orderBy] ?? '')) * dir);
        list = list.slice(0, limit);
        return send(res, 200, { docs: list.map(({ id, data }) => ({ id, data })), version: list.map((x) => `${x.id}:${x.v}`).join(',') });
      }
      if (p === '/__mock/assets') {
        if (req.method === 'POST') {
          if (roleOf(req) !== 'admin') return send(res, 403, { code: 'not_granted', message: 'writers only' });
          const body = await readBody(req);
          const id = Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32);
          assets.set(id, { type: req.headers['content-type'], body });
          return send(res, 200, { id, url: `/_blob/${id}`, sizeBytes: body.length, contentType: req.headers['content-type'] });
        }
        if (req.method === 'DELETE') return send(res, 200, { deleted: assets.delete(url.searchParams.get('id')) });
        return send(res, 200, { assets: [...assets.entries()].map(([id, a]) => ({ id, url: `/_blob/${id}`, contentType: a.type, sizeBytes: a.body.length })), usage: { files: assets.size } });
      }
      if (p.startsWith('/_blob/')) {
        const a = assets.get(p.slice(7));
        return a ? send(res, 200, a.body, a.type) : send(res, 404, { code: 'not_found' });
      }
      if (p === '/__mock/downloads') {
        if (req.method === 'POST') downloads.push(JSON.parse((await readBody(req)).toString()));
        return send(res, 200, { downloads });
      }
      if (p === '/__mock/drive/search_files') {
        const input = JSON.parse((await readBody(req)).toString() || '{}');
        const m = /title contains '((?:[^'\\]|\\.)*)'/.exec(input.query || '');
        const needle = (m ? m[1].replace(/\\(.)/g, '$1') : '').toLowerCase();
        const excluded = [...(input.query || '').matchAll(/mimeType != '([^']*)'/g)].map((x) => x[1]);
        const files = [...driveFiles(), ...DRIVE_NATIVE]
          .filter((f) => f.title.toLowerCase().includes(needle) && !excluded.includes(f.mimeType))
          .map(({ full, ...f }) => f);
        return send(res, 200, { files });
      }
      if (p === '/__mock/drive/download_file_content') {
        const input = JSON.parse((await readBody(req)).toString() || '{}');
        const f = driveFiles().find((x) => x.id === input.fileId);
        if (!f) return send(res, 404, { code: 'tool_error', message: 'File not found' });
        return send(res, 200, { content: readFileSync(f.full).toString('base64'), id: f.id, mimeType: f.mimeType, title: f.title });
      }
      if (p === '/__mock/state') return send(res, 200, { docs: Object.fromEntries(docs), assets: assets.size, downloads });
      return send(res, 404, { code: 'not_found' });
    } catch (e) {
      return send(res, 500, { code: 'unavailable', message: String(e?.message || e) });
    }
  });
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(arg('port', 4173));
  createDashboardServer().listen(port, () => {
    console.log(`Twin PPC dashboard (local preview, mock claude.ai runtime):`);
    console.log(`  http://localhost:${port}/?role=admin    editor: imports, settings, approvals`);
    console.log(`  http://localhost:${port}/?role=manager  contributor: approvals`);
    console.log(`  http://localhost:${port}/?role=viewer   read only`);
  });
}
