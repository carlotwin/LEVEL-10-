// Landing page scan: reads the headline (H1), title and main call to action
// of each page the ads send people to, on the team's own domains only
// (PPC_SITE_DOMAINS), slowly (PPC_SITE_DELAY_MS between pages).
import { cleanPath } from '../../engine/index.js';

const CTA_WORDS = /(cash offer|get (my|your|a)? ?offer|get started|call (us|now|today)|talk to|contact|free quote|sell (my|your) house|start)/i;
const strip = (html) => String(html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

export function parsePage(html) {
  const title = strip(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '');
  const h1 = strip(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] || '');
  let cta = '';
  for (const m of html.matchAll(/<(a|button)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = strip(m[2]);
    if (text && text.length <= 60 && CTA_WORDS.test(text)) { cta = text; break; }
  }
  if (!cta) {
    const v = /<input[^>]+type=["']submit["'][^>]*value=["']([^"']+)["']/i.exec(html)?.[1];
    if (v && CTA_WORDS.test(v)) cta = v.trim();
  }
  return { title, h1, cta };
}

export function allowedUrl(url, domains) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return /^https?:$/.test(u.protocol) && domains.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

export async function scanPages(cfg, dataset, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log } = {}) {
  const urls = new Set([...(dataset.ads?.keywords || []).map((k) => k.finalUrl), ...(dataset.ads?.adCopy || []).map((a) => a.finalUrl), ...cfg.site.extraUrls].filter(Boolean));
  const byPath = new Map();
  for (const url of urls) {
    if (!allowedUrl(url, cfg.site.domains)) continue;
    const u = new URL(url);
    const key = `${u.hostname}${cleanPath(u.pathname)}`;
    if (!byPath.has(key)) byPath.set(key, `${u.origin}${u.pathname}`);
  }
  const pages = [];
  const failed = [];
  for (const url of byPath.values()) {
    try {
      const res = await fetchImpl(url, { headers: { 'user-agent': 'TwinPPC-PageCheck/1.0 (landing page headline check)' }, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const p = parsePage(await res.text());
      pages.push({ path: cleanPath(url), url, ...p });
    } catch (e) {
      failed.push({ step: 'pages.fetch', selector: url, message: e.message });
      log?.warn('page_scan_failed', { message: `${url}: ${e.message}` });
    }
    await sleep(cfg.site.delayMs);
  }
  return { web: { pages }, stats: { rows: pages.length, failed: failed.length }, errors: failed };
}
