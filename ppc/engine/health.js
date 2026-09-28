// Data Health: is the data complete and fresh enough to trust the
// recommendations? Each check says what is wrong, how big it is, and how to
// fix it, in plain words.
import { SOURCES } from './dataset.js';
import { formatInt, formatMoney, formatPct, inRange, safeDiv } from './util.js';

export const DEFAULT_HEALTH_SETTINGS = Object.freeze({
  staleHours: { google_ads: 36, rei: 36, ga4: 72, calls: 72, pages: 24 * 14 },
  staleLeadDays: 14,        // "new" leads untouched this long
  staleContractDays: 75,    // contracts with no closed/lost outcome after this long
});

const hoursSince = (iso, now) => (iso ? (now - Date.parse(iso)) / 3600000 : Infinity);

function sourceStatus(key, src, hasData, isDemo, now, staleHours) {
  const label = SOURCES[key] || key;
  if (isDemo) return { key, label, ...src, status: 'demo', text: 'Demo data', detail: 'Showing demo data. Connect the real source to replace it.' };
  if (!src || (!src.lastSuccessAt && !src.lastAttemptAt)) {
    return hasData
      ? { key, label, status: 'unknown', text: 'Imported (no sync record)', detail: 'Data is present but its import time is unknown.' }
      : { key, label, status: 'missing', text: 'Not connected', detail: 'No data from this source yet.' };
  }
  const failed = src.status === 'failed';
  const age = hoursSince(src.lastSuccessAt, now);
  if (failed) {
    return { key, label, ...src, status: 'failed', text: 'Last sync failed', detail: src.lastError || 'The last sync did not finish.' };
  }
  if (age > (staleHours[key] ?? 48)) {
    return { key, label, ...src, status: 'stale', text: 'Out of date', detail: `Last successful sync ${Math.round(age)} hours ago.` };
  }
  return { key, label, ...src, status: 'ok', text: 'Up to date', detail: src.lastError ? `Finished with warnings: ${src.lastError}` : '' };
}

/**
 * @param model   buildModel result
 * @param opts    { now (ms), filters (date range), settings }
 */
export function dataHealth(model, { now = Date.now(), filters = {}, settings = {} } = {}) {
  const s = { ...DEFAULT_HEALTH_SETTINGS, ...settings, staleHours: { ...DEFAULT_HEALTH_SETTINGS.staleHours, ...(settings.staleHours || {}) } };
  const ds = model.dataset;
  const sources = ds.sync?.sources || {};
  const has = {
    google_ads: (ds.ads?.keywordDaily?.length || 0) + (ds.ads?.keywordCityDaily?.length || 0) > 0,
    rei: (ds.rei?.leads?.length || 0) > 0,
    ga4: (ds.web?.landingDaily?.length || 0) + (ds.web?.pagePaths?.length || 0) > 0,
    calls: (ds.calls?.length || 0) > 0,
    pages: (ds.web?.pages?.length || 0) > 0,
  };
  const sourceRows = Object.keys(SOURCES).map((k) => sourceStatus(k, sources[k], has[k], model.isDemo, now, s.staleHours));

  const checks = [];
  const add = (c) => checks.push(c);
  const leads = model.leads.filter((l) => inRange(l.createdDate, filters.start, filters.end));
  const live = leads.filter((l) => !l.duplicateOf);
  const ppc = live.filter((l) => l.attr?.channel === 'ppc');

  // 1) Missing GCLIDs on Google Ads leads.
  const noGclid = ppc.filter((l) => !l.gclid && l.attr?.method !== 'call_gclid');
  const noGclidShare = safeDiv(noGclid.length, ppc.length);
  add({
    code: 'missing_gclid', label: 'Google Ads leads without a GCLID', value: noGclid.length,
    display: ppc.length ? `${formatInt(noGclid.length)} of ${formatInt(ppc.length)} (${formatPct(noGclidShare)})` : 'No Google Ads leads',
    severity: !ppc.length ? 'info' : noGclidShare > 0.5 ? 'error' : noGclidShare > 0.2 ? 'warn' : 'ok',
    detail: 'Without the GCLID a lead cannot be tied to the exact keyword and city that produced it.',
    fix: 'Add a hidden GCLID field to every website form and map it to a REI BlackBook custom field; capture GCLID in call tracking.',
  });

  // 2) Unmatched leads.
  const unmatched = ppc.filter((l) => !l.attr?.keywordText);
  const unknown = live.filter((l) => l.attr?.channel === 'unknown');
  add({
    code: 'unmatched_leads', label: 'Unmatched leads', value: unmatched.length + unknown.length,
    display: `${formatInt(unmatched.length)} Google Ads lead(s) with no keyword · ${formatInt(unknown.length)} lead(s) with no source at all`,
    severity: unmatched.length + unknown.length === 0 ? 'ok' : safeDiv(unmatched.length + unknown.length, live.length) > 0.25 ? 'warn' : 'info',
    detail: 'Unmatched leads are shown as "Unknown / Unmatched". They are never guessed onto a keyword.',
    fix: 'Capture GCLID and UTM tags on forms; set "Lead source" on every REI lead; map tracking numbers in Settings.',
  });

  // 3) Duplicates.
  const dups = leads.filter((l) => l.duplicateOf);
  add({
    code: 'duplicates', label: 'Duplicate leads', value: dups.length, display: formatInt(dups.length),
    severity: dups.length ? 'info' : 'ok',
    detail: 'Same phone, email or property within 60 days. Duplicates are left out of every count.',
    fix: 'Merge duplicate contacts in REI BlackBook so the history stays on one record.',
  });

  // 4) Missing cities.
  const noCityLeads = ppc.filter((l) => !l.attr?.city && !l.city);
  let spend = 0;
  let noCitySpend = 0;
  let estimated = 0;
  let outOfArea = 0;
  for (const r of model.spendRows) {
    if (!inRange(r.d, filters.start, filters.end)) continue;
    spend += r.cost || 0;
    if (!r.city) noCitySpend += r.cost || 0;
    if (r.est === 'allocated') estimated += r.cost || 0;
    if (r.city && model.geo.inBuyBox(r.city, r.st || 'CA') === false) outOfArea += r.cost || 0;
  }
  const noCityShare = safeDiv(noCitySpend, spend);
  add({
    code: 'missing_city', label: 'Missing cities', value: noCityLeads.length,
    display: `${formatMoney(noCitySpend)} of spend (${formatPct(noCityShare)}) · ${formatInt(noCityLeads.length)} Google Ads lead(s)`,
    severity: noCityShare > 0.3 ? 'warn' : noCitySpend > 0 || noCityLeads.length ? 'info' : 'ok',
    detail: 'Spend or leads that Google Ads or REI could not place in a city appear as "(unknown)" city.',
    fix: 'Sync the Google Ads location report and click report; make City a required field in REI.',
  });

  // 5) Estimated spend split.
  add({
    code: 'estimated_spend', label: 'Keyword + city spend that is estimated', value: estimated,
    display: `${formatMoney(estimated)} (${formatPct(safeDiv(estimated, spend))})`,
    severity: 'info',
    detail: 'Google Ads reports spend by ad group and city, not by keyword and city. That spend is split across the ad group\'s keywords by where their clicks came from.',
    fix: 'Nothing to fix. Tighter ad groups (one theme per ad group) make the split more exact.',
  });

  // 6) Missing deal outcomes.
  const closed = live.filter((l) => l.closed);
  const noProfit = closed.filter((l) => l.profit == null);
  const noRevenue = closed.filter((l) => l.revenue == null);
  const today = model.bounds.max || new Date(now).toISOString().slice(0, 10);
  const daysAgo = (d) => (d ? (Date.parse(today) - Date.parse(d)) / 86400000 : 0);
  const openContracts = live.filter((l) => l.contract && !l.closed && !l.lost && daysAgo(l.contractAt || l.createdDate) > s.staleContractDays);
  const staleNew = live.filter((l) => (l.stage === 'new') && daysAgo(l.createdDate) > s.staleLeadDays);
  const outcomeIssues = noProfit.length + openContracts.length;
  add({
    code: 'missing_outcomes', label: 'Missing deal outcomes', value: outcomeIssues,
    display: `${formatInt(noProfit.length)} closed deal(s) without profit · ${formatInt(noRevenue.length)} without revenue · ${formatInt(openContracts.length)} contract(s) with no outcome after ${s.staleContractDays} days`,
    severity: noProfit.length ? 'warn' : openContracts.length ? 'info' : 'ok',
    detail: 'Without profit per deal, the system judges on cost per contract or deal instead and says so. It never calls a row profitable without profit data.',
    fix: 'Enter revenue and profit on every closed deal in REI (or the deals sheet); close out old contracts as closed or lost.',
  });
  add({
    code: 'stale_statuses', label: 'Leads still "new" after two weeks', value: staleNew.length, display: formatInt(staleNew.length),
    severity: staleNew.length > 5 ? 'warn' : staleNew.length ? 'info' : 'ok',
    detail: 'Leads never updated in REI look unqualified here, which can make good keywords look bad.',
    fix: 'Update lead status in REI after each call attempt.',
  });

  // 7) Crawler errors (last 10 runs).
  const crawlerRuns = (ds.sync?.history || []).filter((h) => h.source === 'rei' && h.mode === 'crawler').slice(0, 10);
  const crawlerFails = crawlerRuns.filter((h) => h.status !== 'ok');
  const lastFail = crawlerFails[0];
  add({
    code: 'crawler_errors', label: 'REI crawler errors', value: crawlerFails.length,
    display: crawlerRuns.length ? `${formatInt(crawlerFails.length)} of the last ${formatInt(crawlerRuns.length)} run(s)` : 'Crawler not used',
    severity: !crawlerRuns.length ? 'info' : crawlerRuns[0].status === 'failed' ? 'error' : crawlerFails.length ? 'warn' : 'ok',
    detail: lastFail
      ? `Last problem (${lastFail.finishedAt?.slice(0, 16).replace('T', ' ')}): ${lastFail.message}${lastFail.errors?.[0]?.selector ? ` [step "${lastFail.errors[0].step}", selector "${lastFail.errors[0].selector}"]` : ''}`
      : 'The crawler reads your own REI BlackBook account. CSV import is always available as the fallback.',
    fix: lastFail ? 'Update the selector named above in ppc/config/rei-crawler.selectors.json, or import an REI CSV export meanwhile.' : '',
    errors: lastFail?.errors || [],
  });

  // 8) Attribution gap: Google-counted conversions vs PPC leads in REI.
  let googleConv = 0;
  for (const r of model.spendRows) if (inRange(r.d, filters.start, filters.end)) googleConv += r.conv || 0;
  const gap = Math.round(googleConv) - ppc.length;
  const lowConf = ppc.filter((l) => l.attr?.confidence === 'low' || l.attr?.confidence === 'none');
  add({
    code: 'attribution_gap', label: 'Attribution gaps', value: Math.abs(gap) + lowConf.length,
    display: `Google Ads counted ${formatInt(Math.round(googleConv))} conversion(s); REI has ${formatInt(ppc.length)} Google Ads lead(s). ${formatInt(lowConf.length)} matched by lead-source text only.`,
    severity: googleConv && Math.abs(gap) / Math.max(googleConv, ppc.length) > 0.3 ? 'warn' : lowConf.length ? 'info' : 'ok',
    detail: gap > 0
      ? 'Google counted more conversions than REI has Google leads: some conversions may be duplicates, spam, or leads not entered in REI.'
      : gap < 0 ? 'REI has more Google leads than Google counted: conversion tracking may be missing on some forms or calls.' : 'Google Ads and REI agree on the number of leads.',
    fix: 'Count only real leads as conversions in Google Ads (form submit + qualified call), and make sure every lead reaches REI.',
  });

  // 9) Unmapped REI statuses.
  const unmapped = Object.entries(ds.rei?.unmappedStatuses || {});
  add({
    code: 'unmapped_statuses', label: 'REI statuses not understood', value: unmapped.length,
    display: unmapped.length ? unmapped.slice(0, 6).map(([k, v]) => `${k} (${v})`).join(', ') : 'All statuses mapped',
    severity: unmapped.length ? 'warn' : 'ok',
    detail: 'Leads with these statuses are treated as "new", so they do not count as qualified, appointments or contracts.',
    fix: 'Map each status to a funnel step in Settings → Lead statuses.',
  });

  // 10) Spend outside the buy box.
  add({
    code: 'out_of_area', label: 'Spend outside the buy box', value: outOfArea,
    display: `${formatMoney(outOfArea)} (${formatPct(safeDiv(outOfArea, spend))})`,
    severity: outOfArea > 0.1 * spend ? 'warn' : outOfArea > 0 ? 'info' : 'ok',
    detail: 'Clicks from cities marked "outside buy box" in Settings.',
    fix: 'Exclude those locations in Google Ads, or mark them as inside the buy box in Settings if you buy there.',
  });

  if (model.isDemo) {
    add({ code: 'demo', label: 'Demo data', value: 1, display: 'Everything shown is demo data', severity: 'warn',
      detail: 'Numbers are realistic but made up. No real leads, spend or people.', fix: 'Import or sync real data on the Data Sources page.' });
  }

  const rank = { error: 0, warn: 1, info: 2, ok: 3, demo: 1 };
  const worst = checks.reduce((acc, c) => Math.min(acc, rank[c.severity] ?? 3), 3);
  const sourceIssues = sourceRows.filter((r) => ['failed', 'stale', 'missing'].includes(r.status)).length;
  return {
    sources: sourceRows,
    checks,
    summary: {
      status: worst === 0 || sourceRows.some((r) => r.status === 'failed') ? 'error' : worst === 1 || sourceIssues ? 'warn' : 'ok',
      problems: checks.filter((c) => c.severity === 'error' || c.severity === 'warn').length + sourceIssues,
      leads: live.length, ppcLeads: ppc.length, duplicates: dups.length,
    },
  };
}
