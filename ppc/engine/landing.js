// Landing page analyzer: does the page a keyword sends people to match what
// they searched for? Checks the seller situation, the city, and the call to
// action, then recommends the page intent that would match.
import { cleanPath } from './normalize/ga4.js';
import { intentOf, situationLabel } from './situations.js';
import { normText, safeDiv, titleCase } from './util.js';

const REGION_WORDS = ['bay area', 'east bay', 'south bay', 'north bay', 'peninsula', 'silicon valley'];
const STATE_WORDS = ['california', ' ca ', 'nationwide', 'usa'];

/** City (or region/state) named in text, using the geo list. */
export function placeIn(text, geo) {
  const t = ` ${normText(String(text).replace(/[-_/]+/g, ' '))} `;
  const cities = (geo?.list || []).map((g) => g.city).sort((a, b) => b.length - a.length);
  for (const c of cities) if (t.includes(` ${normText(c)} `)) return { level: 'city', name: c };
  for (const r of REGION_WORDS) if (t.includes(` ${r} `)) return { level: 'region', name: titleCase(r) };
  for (const s of STATE_WORDS) if (t.includes(s.includes(' ') ? s : ` ${s} `)) return { level: 'state', name: titleCase(s.trim()) };
  return { level: 'none', name: '' };
}

function situationMatch(kwIntent, pageIntent) {
  if (kwIntent === pageIntent) return 'good';
  if (kwIntent !== 'general' && pageIntent === 'general') return 'poor';
  if (kwIntent === 'general' && pageIntent !== 'general') return 'partial';
  return 'poor'; // two different specific situations
}

function placeMatch(kwPlace, pagePlace) {
  if (kwPlace.level === 'none') return 'good';
  if (kwPlace.level === 'city') {
    if (pagePlace.level === 'city') return normText(pagePlace.name) === normText(kwPlace.name) ? 'good' : 'poor';
    if (pagePlace.level === 'region') return 'partial';
    return 'poor';
  }
  return pagePlace.level === 'none' ? 'partial' : 'good';
}

const worst = (...levels) => (levels.includes('poor') ? 'poor' : levels.includes('partial') ? 'partial' : 'good');

/**
 * @param model buildModel result
 * @param keywordRows rollUp(model, rows, 'keyword') with spend/lead metrics
 */
export function analyzeLandingPages(model, keywordRows = []) {
  const { situations } = model.settings;
  const pages = model.dataset.web?.pages || [];
  const byPath = new Map(pages.map((p) => [normText(cleanPath(p.url || p.path)), p]));
  const pageStats = new Map();
  for (const r of model.dataset.web?.landingDaily || []) {
    const key = normText(r.path);
    const s = pageStats.get(key) || { sessions: 0, keyEvents: 0 };
    s.sessions += r.sessions || 0;
    s.keyEvents += r.keyEvents || 0;
    pageStats.set(key, s);
  }
  const results = [];
  for (const row of keywordRows) {
    if (!row.keyword || row.keyword.startsWith('(')) continue;
    const kwIntent = intentOf(row.keyword, situations);
    const kwPlace = placeIn(row.keyword, model.geo);
    const urls = [...new Set(row.keywordIds.map((id) => model.keywordsById.get(id)?.finalUrl).filter(Boolean))];
    const url = urls[0] || '';
    const path = url ? cleanPath(url) : '';
    const page = path ? byPath.get(normText(path)) : null;
    const issues = [];
    let match = 'unknown';
    let pageIntent = null;
    let pagePlace = { level: 'none', name: '' };
    if (!url) {
      issues.push('No landing page URL recorded for this keyword.');
    } else if (!page) {
      issues.push(`Page ${path} is not in the page list yet, so its headline could not be checked.`);
    } else {
      const pageText = `${page.h1 || ''} ${page.title || ''} ${path}`;
      pageIntent = page.situation || intentOf(pageText, situations);
      pagePlace = placeIn(`${page.h1 || ''} ${page.title || ''} ${path}`, model.geo);
      const sMatch = situationMatch(kwIntent, pageIntent);
      const pMatch = placeMatch(kwPlace, pagePlace);
      const ctaOk = !!String(page.cta || '').trim();
      match = worst(sMatch, pMatch, ctaOk ? 'good' : 'partial');
      if (sMatch === 'poor') {
        issues.push(kwIntent !== 'general' && pageIntent === 'general'
          ? `The search is about "${situationLabel(kwIntent, situations)}" but the page is a general "${page.h1 || page.title}" page.`
          : `The search is about "${situationLabel(kwIntent, situations)}" but the page is about "${situationLabel(pageIntent, situations)}".`);
      } else if (sMatch === 'partial') {
        issues.push(`The page is about "${situationLabel(pageIntent, situations)}", narrower than this general search.`);
      }
      if (pMatch === 'poor') {
        issues.push(kwPlace.level === 'city'
          ? `The search names ${kwPlace.name} but the page ${pagePlace.level === 'none' ? 'names no city' : `says "${pagePlace.name}"`}.`
          : 'The page does not name the area searched.');
      } else if (pMatch === 'partial') {
        issues.push(`The search names ${kwPlace.name}; the page only says "${pagePlace.name || 'no area'}".`);
      }
      if (!ctaOk) issues.push('No clear call to action found (for example "Get my cash offer").');
    }
    // A better existing page: same situation, and same city or region.
    const better = pages
      .map((p) => {
        const pi = p.situation || intentOf(`${p.h1 || ''} ${p.title || ''} ${p.path || ''}`, situations);
        const pp = placeIn(`${p.h1 || ''} ${p.title || ''} ${p.path || ''}`, model.geo);
        return { p, score: (pi === kwIntent ? 2 : 0) + (placeMatch(kwPlace, pp) === 'good' ? 1 : 0) + (p.cta ? 0.5 : 0) };
      })
      .filter((x) => x.score >= 2 && normText(cleanPath(x.p.url || x.p.path)) !== normText(path))
      .sort((a, b) => b.score - a.score)[0]?.p || null;
    const want = `${kwIntent === 'general' ? 'Sell your house fast for cash' : situationLabel(kwIntent, situations)}${kwPlace.level === 'city' ? ` in ${kwPlace.name}` : kwPlace.level !== 'none' ? ` in the ${kwPlace.name}` : ''}`;
    const stats = path ? pageStats.get(normText(path)) : null;
    results.push({
      key: row.key, keyword: row.keyword, campaignName: row.campaignName, url, path, page,
      keywordIntent: kwIntent, keywordPlace: kwPlace, pageIntent, pagePlace, match, issues,
      recommendation: match === 'good' ? 'Good match. Keep it.'
        : better ? `Send this keyword to ${better.path || better.url} ("${better.h1 || better.title}"), which matches better.`
        : `Use a page whose headline says "${want}" with a clear "Get my cash offer" button.`,
      wantHeadline: want,
      betterPage: better ? (better.path || better.url) : null,
      spend: row.metrics.spend, leads: row.metrics.leads, qualified: row.metrics.qualified,
      sessions: stats?.sessions ?? null, pageConversionRate: stats ? safeDiv(stats.keyEvents, stats.sessions) : null,
    });
  }
  const rank = { poor: 0, partial: 1, unknown: 2, good: 3 };
  results.sort((a, b) => rank[a.match] - rank[b.match] || b.spend - a.spend);
  return results;
}
