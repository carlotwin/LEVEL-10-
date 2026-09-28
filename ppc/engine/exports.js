// Downloads: the main table as CSV, approved actions as a checklist, and the
// keyword-level approved actions in Google Ads Editor's CSV format (review in
// Editor, then post: nothing is sent to Google Ads from here).
import { toCsv } from './csv.js';
import { round } from './util.js';

const money = (v) => (v == null ? '' : round(v, 2));
const arraysToCsv = (header, rows) => toCsv(rows, header.map((label, i) => ({ label, value: (r) => r[i] })));

export function keywordCityCsv(rows) {
  const columns = [
    ['Keyword', (r) => r.keyword], ['Top search term', (r) => r.topSearchTerm], ['City', (r) => r.city || '(unknown)'],
    ['County', (r) => r.county], ['Campaign', (r) => r.campaignName], ['Spend', (r) => money(r.metrics.spend)],
    ['Clicks', (r) => round(r.metrics.clicks, 0)], ['CPC', (r) => money(r.metrics.cpc)], ['Leads', (r) => r.metrics.leads],
    ['Qualified leads', (r) => r.metrics.qualified], ['Appointments', (r) => r.metrics.appointments], ['Offers', (r) => r.metrics.offers],
    ['Contracts', (r) => r.metrics.contracts], ['Closed deals', (r) => r.metrics.deals],
    ['Revenue', (r) => (r.metrics.dealsWithRevenue ? money(r.metrics.revenue) : '')], ['Profit', (r) => (r.metrics.dealsWithProfit ? money(r.metrics.profit) : '')],
    ['Cost per qualified lead', (r) => money(r.metrics.costPerQualified)], ['Cost per contract', (r) => money(r.metrics.costPerContract)],
    ['Cost per deal', (r) => money(r.metrics.costPerDeal)], ['Recommendation', (r) => r.decision.rec], ['Reason', (r) => r.decision.reason],
    ['Spend estimated %', (r) => round((r.estimatedShare || 0) * 100, 0)],
  ];
  return toCsv(rows, columns.map(([label, value]) => ({ label, value })));
}

export function actionsChecklistCsv(actions) {
  const header = ['Status', 'Action', 'What to do', 'Campaign', 'Keyword / term', 'City', 'Reason', 'Decided by', 'Decided at', 'API ready', 'Note'];
  const rows = actions.map((a) => [
    a.status, a.typeLabel, a.summary, a.target?.campaignName || '', a.target?.keyword || a.target?.negative || '', a.target?.city || '',
    a.reason, a.decidedByName || a.decidedBy || '', a.decidedAt || '', a.apiReady ? 'yes' : 'no', a.manualNote || '',
  ]);
  return arraysToCsv(header, rows);
}

const kwSyntax = (text, matchType) => (matchType === 'EXACT' ? `[${text}]` : matchType === 'PHRASE' ? `"${text}"` : text);
const editorMatch = (m) => ({ EXACT: 'Exact', PHRASE: 'Phrase', BROAD: 'Broad' }[m] || 'Broad');

/**
 * Google Ads Editor CSV (Account → Import → From file / Make multiple
 * changes). Covers keyword pauses, final URL changes, campaign negative
 * keywords, location exclusions and location bid adjustments. Bid changes in
 * % are not included: Editor needs the new bid amount, so they stay on the
 * checklist.
 */
export function editorCsv(actions) {
  const header = ['Campaign', 'Ad group', 'Keyword', 'Criterion Type', 'Status', 'Final URL', 'Location', 'Bid adjustment'];
  const rows = [];
  for (const a of actions) {
    if (a.status !== 'approved') continue;
    const t = a.target || {};
    if (a.type === 'pause_keyword' || a.type === 'change_landing_page') {
      for (const c of t.criteria || []) {
        rows.push([t.campaignName, c.adGroupName, t.keyword, editorMatch(c.matchType), a.type === 'pause_keyword' ? 'Paused' : '', a.type === 'change_landing_page' ? t.to : '', '', '']);
      }
    } else if (a.type === 'add_negative') {
      rows.push([t.campaignName, '', kwSyntax(t.negative, t.matchType), 'Campaign negative', '', '', '', '']);
    } else if (a.type === 'exclude_location') {
      rows.push([t.campaignName, '', '', 'Negative', '', '', `${t.city}, ${t.st === 'CA' ? 'California' : t.st}, United States`, '']);
    } else if (a.type === 'location_bid') {
      rows.push([t.campaignName, '', '', '', '', '', `${t.city}, ${t.st === 'CA' ? 'California' : t.st}, United States`, `${a.change.value > 0 ? '+' : ''}${a.change.value}%`]);
    }
  }
  return arraysToCsv(header, rows);
}
