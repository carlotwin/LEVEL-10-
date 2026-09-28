// Notifications: things a person should look at today. Data alerts are
// measured against the newest day in the data (so a late sync does not hide
// them); sync alerts against the clock. Each alert has a stable id so the
// dashboard and the agent can remember which ones were already seen or sent.
import { keywordCityTable, rollUp } from './model.js';
import { computeMetrics, emptyTotals } from './decisions.js';
import { addDays, formatInt, formatMoney, formatPct, inRange, safeDiv } from './util.js';

export const DEFAULT_ALERT_SETTINGS = Object.freeze({
  dailySpendHigh: 0,             // alert when one day's spend is above this (0 = off)
  spendSpikeRatio: 1.6,          // ...or above this multiple of the previous 7-day average
  spendSpikeMin: 150,            // ignore spikes on days below this spend
  keywordNoLeadSpend: 300,       // keyword spend in the last 7 days with 0 leads
  keywordNoQualifiedSpend: 700,  // keyword spend in the last 14 days with leads but 0 qualified
  changeRatio: 0.5,              // week-over-week change in cost per lead (0.5 = 50%)
  changeMinLeads: 4,             // leads needed in each week to compare
  newContractDays: 7,            // contracts signed in the last N days
  syncStaleHours: 36,
});

const SEVERITY = { high: 0, medium: 1, low: 2 };

export function buildAlerts(model, { now = Date.now(), settings = {} } = {}) {
  const s = { ...DEFAULT_ALERT_SETTINGS, ...(model.settings.alerts || {}), ...settings };
  const alerts = [];
  const asOf = model.bounds.max;
  const push = (a) => alerts.push({ at: asOf, ...a });

  if (asOf) {
    // 1) Unusually high spend.
    const daily = new Map();
    for (const r of model.spendRows) {
      if (!inRange(r.d, addDays(asOf, -7), asOf)) continue;
      daily.set(r.d, (daily.get(r.d) || 0) + (r.cost || 0));
    }
    const last = daily.get(asOf) || 0;
    const prev = [...Array(7)].map((_, i) => daily.get(addDays(asOf, -(i + 1))) || 0);
    const avg = prev.reduce((a, b) => a + b, 0) / 7;
    if ((s.dailySpendHigh > 0 && last > s.dailySpendHigh) || (last >= s.spendSpikeMin && avg > 0 && last >= avg * s.spendSpikeRatio)) {
      push({
        id: `spend_spike:${asOf}`, type: 'spend_spike', severity: 'high', title: 'Unusually high spend',
        detail: `${formatMoney(last)} spent on ${asOf}, versus a ${formatMoney(avg)} daily average over the previous 7 days.`,
      });
    }

    // 2) + 3) Keywords spending without (qualified) leads.
    const week = rollUp(model, keywordCityTable(model, { start: addDays(asOf, -6), end: asOf }).rows, 'keyword');
    for (const k of week) {
      if (k.keyword.startsWith('(')) continue;
      if (k.metrics.spend >= s.keywordNoLeadSpend && k.metrics.leads === 0) {
        push({
          id: `kw_no_leads:${k.key}:${asOf}`, type: 'keyword_no_leads', severity: 'high', title: `"${k.keyword}" is spending with no leads`,
          detail: `${formatMoney(k.metrics.spend)} and ${formatInt(k.metrics.clicks)} clicks in the last 7 days, 0 leads (${k.campaignName}).`,
          target: { campaignId: k.campaignId, keyword: k.keyword },
        });
      }
    }
    const twoWeeks = rollUp(model, keywordCityTable(model, { start: addDays(asOf, -13), end: asOf }).rows, 'keyword');
    for (const k of twoWeeks) {
      if (k.keyword.startsWith('(')) continue;
      if (k.metrics.spend >= s.keywordNoQualifiedSpend && k.metrics.leads > 0 && k.metrics.qualified === 0) {
        push({
          id: `kw_no_qualified:${k.key}:${asOf}`, type: 'keyword_no_qualified', severity: 'medium', title: `"${k.keyword}" leads are not qualifying`,
          detail: `${formatMoney(k.metrics.spend)} in the last 14 days, ${formatInt(k.metrics.leads)} lead(s), 0 qualified (${k.campaignName}).`,
          target: { campaignId: k.campaignId, keyword: k.keyword },
        });
      }
    }

    // 6) New Google Ads contracts.
    for (const l of model.leads) {
      if (l.duplicateOf || !l.contract || l.attr?.channel !== 'ppc') continue;
      const d = l.contractAt || l.closedAt;
      if (!d || !inRange(d, addDays(asOf, -(s.newContractDays - 1)), asOf)) continue;
      const where = [l.attr.keywordText ? `"${l.attr.keywordText}"` : 'keyword unknown', l.attr.city || l.city || 'city unknown'].join(' · ');
      push({
        id: `new_contract:${l.id}`, type: 'new_contract', severity: 'low', at: d, title: l.closed ? 'Google Ads deal closed' : 'New Google Ads contract',
        detail: `Lead ${l.id} (${where}) reached ${l.closed ? 'closed' : 'contract'} on ${d}.`,
      });
    }

    // 7) Significant performance change, week over week.
    const weekTotals = (start, end) => {
      const t = emptyTotals();
      for (const r of keywordCityTable(model, { start, end }).rows) {
        t.spend += r.totals.spend; t.leads += r.totals.leads; t.qualified += r.totals.qualified; t.clicks += r.totals.clicks;
      }
      return computeMetrics(t);
    };
    const thisWeek = weekTotals(addDays(asOf, -6), asOf);
    const lastWeek = weekTotals(addDays(asOf, -13), addDays(asOf, -7));
    if (thisWeek.leads >= s.changeMinLeads && lastWeek.leads >= s.changeMinLeads) {
      const change = safeDiv(thisWeek.costPerLead - lastWeek.costPerLead, lastWeek.costPerLead);
      if (change != null && Math.abs(change) >= s.changeRatio) {
        push({
          id: `perf_change:cpl:${asOf}`, type: 'performance_change', severity: change > 0 ? 'medium' : 'low',
          title: change > 0 ? 'Cost per lead jumped' : 'Cost per lead dropped',
          detail: `Cost per lead ${formatMoney(thisWeek.costPerLead)} this week vs ${formatMoney(lastWeek.costPerLead)} last week (${change > 0 ? '+' : ''}${formatPct(change)}).`,
        });
      }
      const qChange = (thisWeek.qualifiedRate ?? 0) - (lastWeek.qualifiedRate ?? 0);
      if (Math.abs(qChange) >= 0.2) {
        push({
          id: `perf_change:qrate:${asOf}`, type: 'performance_change', severity: qChange < 0 ? 'medium' : 'low',
          title: qChange < 0 ? 'Fewer leads are qualifying' : 'More leads are qualifying',
          detail: `Qualified rate ${formatPct(thisWeek.qualifiedRate)} this week vs ${formatPct(lastWeek.qualifiedRate)} last week.`,
        });
      }
    }
  }

  // 4) + 5) Sync failures (measured against the clock).
  const history = model.dataset.sync?.history || [];
  const latest = (source, mode) => history.find((h) => h.source === source && (!mode || h.mode === mode));
  const crawl = latest('rei', 'crawler');
  if (crawl && crawl.status === 'failed') {
    const e = crawl.errors?.[0];
    push({
      id: `crawler_failed:${crawl.id}`, type: 'crawler_failed', severity: 'high', at: crawl.finishedAt, title: 'REI crawler failed',
      detail: `${crawl.message}${e?.selector ? ` (step "${e.step}", selector "${e.selector}")` : ''}. CSV import still works as a fallback.`,
    });
  }
  const adsRun = latest('google_ads');
  if (adsRun && adsRun.status === 'failed') {
    push({
      id: `ads_sync_failed:${adsRun.id}`, type: 'ads_sync_failed', severity: 'high', at: adsRun.finishedAt, title: 'Google Ads sync failed',
      detail: adsRun.message || 'The last Google Ads sync did not finish.',
    });
  }
  const adsSource = model.dataset.sync?.sources?.google_ads;
  if (!model.isDemo && adsSource?.lastSuccessAt && (now - Date.parse(adsSource.lastSuccessAt)) / 3600000 > s.syncStaleHours) {
    push({
      id: `ads_stale:${adsSource.lastSuccessAt}`, type: 'ads_sync_failed', severity: 'medium', at: new Date(now).toISOString(),
      title: 'Google Ads data is out of date',
      detail: `Last successful sync ${adsSource.lastSuccessAt.slice(0, 16).replace('T', ' ')} UTC.`,
    });
  }

  alerts.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || String(b.at).localeCompare(String(a.at)));
  return alerts;
}
