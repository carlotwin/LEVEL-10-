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
const SCORE = { good: 2, partial: 1, poor: 0 };

/** How well a page fits a keyword: situation, place and call to action. */
function fit(kwIntent, kwPlace, page, situations, geo) {
  const text = `${page.h1 || ''} ${page.title || ''} ${page.path || cleanPath(page.url)}`;
  const pageIntent = page.situation || intentOf(text, situations);
  const pagePlace = placeIn(text, geo);
  const s = situationMatch(kwIntent, pageIntent);
  const p = placeMatch(kwPlace, pagePlace);
  const cta = String(page.cta || '').trim() ? 'good' : 'partial';
  return { pageIntent, pagePlace, s, p, cta, score: SCORE[s] * 2 + SCORE[p] * 2 + SCORE[cta] };
}

/** Ad headlines for the keyword's ad groups (from the ad copy sync). */
function adHeadlines(model, keywordIds) {
  const groups = new Set(keywordIds.map((id) => model.keywordsById.get(id)?.adGroupId).filter(Boolean));
  const out = [];
  for (const ad of model.dataset.ads?.adCopy || []) if (groups.has(ad.adGroupId)) out.push(...(ad.headlines || []));
  return [...new Set(out)];
}

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
    const outsideBuyBox = kwPlace.level === 'city' && model.geo.inBuyBox(kwPlace.name, 'CA') === false;
    const urls = [...new Set(row.keywordIds.map((id) => model.keywordsById.get(id)?.finalUrl).filter(Boolean))];
    const url = urls[0] || '';
    const path = url ? cleanPath(url) : '';
    const page = path ? byPath.get(normText(path)) : null;
    const headlines = adHeadlines(model, row.keywordIds);
    const issues = [];
    let match = 'unknown';
    let current = null;
    if (!url) {
      issues.push('No landing page URL recorded for this keyword.');
    } else if (!page) {
      issues.push(`Page ${path} is not in the page list yet, so its headline could not be checked.`);
    } else {
      current = fit(kwIntent, kwPlace, page, situations, model.geo);
      match = worst(current.s, current.p, current.cta);
      if (current.s === 'poor') {
        issues.push(kwIntent !== 'general' && current.pageIntent === 'general'
          ? `The search is about "${situationLabel(kwIntent, situations)}" but the page is a general "${page.h1 || page.title}" page.`
          : `The search is about "${situationLabel(kwIntent, situations)}" but the page is about "${situationLabel(current.pageIntent, situations)}".`);
      } else if (current.s === 'partial') {
        issues.push(`The page is about "${situationLabel(current.pageIntent, situations)}", narrower than this general search.`);
      }
      if (current.p === 'poor') {
        issues.push(kwPlace.level === 'city'
          ? `The search names ${kwPlace.name} but the page ${current.pagePlace.level === 'none' ? 'names no city' : `says "${current.pagePlace.name}"`}.`
          : 'The page does not name the area searched.');
      } else if (current.p === 'partial') {
        issues.push(`The search names ${kwPlace.name}; the page only says "${current.pagePlace.name || 'no area'}".`);
      }
      if (current.cta !== 'good') issues.push('No clear call to action found (for example "Get my cash offer").');
    }
    // The ad in between: does it speak to the same situation?
    let adMatch = headlines.length ? 'good' : 'unknown';
    if (headlines.length && kwIntent !== 'general' && intentOf(headlines.join(' · '), situations) !== kwIntent) {
      adMatch = 'partial';
      issues.push(`The ad headlines ("${headlines[0]}") do not mention "${situationLabel(kwIntent, situations)}".`);
      if (match === 'good') match = 'partial';
    }
    if (outsideBuyBox) issues.push(`${kwPlace.name} is outside your buy box.`);

    // A better existing page must fit on every count and beat the current page.
    const better = outsideBuyBox ? null : pages
      .filter((p) => normText(cleanPath(p.url || p.path)) !== normText(path))
      .map((p) => ({ p, f: fit(kwIntent, kwPlace, p, situations, model.geo) }))
      .filter((x) => x.f.s !== 'poor' && x.f.p !== 'poor' && x.f.score > (current?.score ?? -1))
      .sort((a, b) => b.f.score - a.f.score)[0]?.p || null;
    const want = `${kwIntent === 'general' ? 'Sell your house fast for cash' : situationLabel(kwIntent, situations)}${kwPlace.level === 'city' ? ` in ${kwPlace.name}` : kwPlace.level !== 'none' ? ` in the ${kwPlace.name}` : ''}`;
    const stats = path ? pageStats.get(normText(path)) : null;
    let recommendation;
    if (outsideBuyBox) recommendation = `This keyword targets ${kwPlace.name}, outside your buy box. Pause the keyword rather than building a page for it.`;
    else if (match === 'good') recommendation = 'Good match. Keep it.';
    else if (better) recommendation = `Send this keyword to ${better.path || better.url} ("${better.h1 || better.title}"), which matches better.`;
    else if (match === 'unknown') recommendation = 'Add this page to the landing page list (or run the page scan) so it can be checked.';
    else recommendation = `Use a page whose headline says "${want}" with a clear "Get my cash offer" button.`;
    results.push({
      key: row.key, keyword: row.keyword, campaignName: row.campaignName, url, path, page, adHeadlines: headlines, adMatch,
      keywordIntent: kwIntent, keywordPlace: kwPlace, pageIntent: current?.pageIntent ?? null, pagePlace: current?.pagePlace ?? { level: 'none', name: '' },
      match, issues, outsideBuyBox, recommendation, wantHeadline: want,
      betterPage: better ? (better.path || better.url) : null,
      spend: row.metrics.spend, leads: row.metrics.leads, qualified: row.metrics.qualified,
      sessions: stats?.sessions ?? null, pageConversionRate: stats ? safeDiv(stats.keyEvents, stats.sessions) : null,
    });
  }
  const rank = { poor: 0, partial: 1, unknown: 2, good: 3 };
  results.sort((a, b) => rank[a.match] - rank[b.match] || b.spend - a.spend);
  return results;
}
