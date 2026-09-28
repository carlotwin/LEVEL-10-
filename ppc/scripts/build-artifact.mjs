#!/usr/bin/env node
// Builds the dashboard page: bundles ppc/engine (plain ES modules) into one
// script, concatenates the app sources, and inlines everything into the page
// template, so the published artifact runs exactly the tested engine code.
//
//   node ppc/scripts/build-artifact.mjs                 -> ppc/artifact/dist/
//   node ppc/scripts/build-artifact.mjs --out=<dir>     -> <dir>/
//
// Output: index.html (page content, without <html>/<head>/<body>, as the
// Artifact publisher wraps it) and demo-dataset.json (published next to it).
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ppc = path.resolve(here, '..');
const outArg = process.argv.find((a) => a.startsWith('--out='));
const outDir = path.resolve(outArg ? outArg.slice(6) : path.join(ppc, 'artifact/dist'));

const IMPORT_RE = /^import\s*\{([\s\S]*?)\}\s*from\s*'(\.[^']+)';[ \t]*$/gm;
const STAR_RE = /^export\s*\*\s*from\s*'(\.[^']+)';[ \t]*$/gm;
const DECL_RE = /^export\s+(async\s+function\*?|function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;
const LIST_RE = /^export\s*\{([^}]*)\};?[ \t]*$/gm;

function names(list) {
  return list.split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
    const [a, b] = p.split(/\s+as\s+/).map((x) => x.trim());
    return { from: a, to: b || a };
  });
}

/** Bundle an ES module graph (relative named imports/exports only) into one script. */
export function bundleEngine(entry) {
  const done = new Map();
  const order = [];
  const idOf = (file) => path.relative(path.dirname(entry), file).replace(/\\/g, '/');
  const visit = (file) => {
    if (done.has(file)) return;
    done.set(file, null);
    let code = readFileSync(file, 'utf8');
    const header = [];
    const stars = [];
    const exported = [];
    const deps = [];
    code = code.replace(IMPORT_RE, (m, list, spec) => {
      const dep = path.resolve(path.dirname(file), spec);
      deps.push(dep);
      header.push(`const { ${names(list).map((n) => (n.from === n.to ? n.from : `${n.from}: ${n.to}`)).join(', ')} } = __m[${JSON.stringify(idOf(dep))}];`);
      return '';
    });
    code = code.replace(STAR_RE, (m, spec) => {
      const dep = path.resolve(path.dirname(file), spec);
      deps.push(dep);
      stars.push(idOf(dep));
      return '';
    });
    code = code.replace(DECL_RE, (m, kind, name) => {
      exported.push(`${name}`);
      return `${kind} ${name}`;
    });
    code = code.replace(LIST_RE, (m, list) => {
      for (const n of names(list)) exported.push(n.from === n.to ? n.from : `${n.to}: ${n.from}`);
      return '';
    });
    const leftover = /^(import\s|export\s)/m.exec(code);
    if (leftover) throw new Error(`${idOf(file)}: unsupported module syntax near "${code.slice(leftover.index, leftover.index + 60)}"`);
    for (const dep of deps) visit(dep);
    done.set(file, { id: idOf(file), header, stars, exported, code });
    order.push(file);
  };
  visit(entry);
  const parts = order.map((file) => {
    const m = done.get(file);
    const spreads = m.stars.map((id) => `...__m[${JSON.stringify(id)}]`);
    return `// ---- ${m.id}\n__m[${JSON.stringify(m.id)}] = (() => {\n${m.header.join('\n')}\n${m.code}\nreturn Object.freeze({ ${[...spreads, ...m.exported].join(', ')} });\n})();`;
  });
  return `(function () {\n'use strict';\nconst __m = {};\n${parts.join('\n')}\nwindow.PPC = __m[${JSON.stringify(idOf(entry))}];\n})();`;
}

const APP_FILES = ['ui.js', 'charts.js', 'runtime.js', 'views-main.js', 'views-ops.js', 'app.js'];

export function buildPage() {
  const src = path.join(ppc, 'artifact/src');
  const engine = bundleEngine(path.join(ppc, 'engine/index.js'));
  const app = `(function () {\n'use strict';\nconst PPC = window.PPC;\n${APP_FILES.map((f) => `// ---- ${f}\n${readFileSync(path.join(src, f), 'utf8')}`).join('\n')}\n})();`;
  const css = readFileSync(path.join(src, 'styles.css'), 'utf8');
  const guard = (text, what) => {
    if (/<\/script/i.test(text)) throw new Error(`${what} contains "</script": it would end the inline script early.`);
    return text;
  };
  const template = readFileSync(path.join(src, 'index.html'), 'utf8');
  return template
    .replace('/*__CSS__*/', () => css)
    .replace('/*__ENGINE__*/', () => guard(engine, 'engine bundle'))
    .replace('/*__APP__*/', () => guard(app, 'app code'));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  mkdirSync(outDir, { recursive: true });
  const html = buildPage();
  writeFileSync(path.join(outDir, 'index.html'), html);
  copyFileSync(path.join(ppc, 'demo/demo-dataset.json'), path.join(outDir, 'demo-dataset.json'));
  console.log(`Built ${path.relative(process.cwd(), path.join(outDir, 'index.html'))} (${Math.round(html.length / 1024)} KB) + demo-dataset.json`);
}
