// Shared fixtures: small, hand-checkable datasets built through the real
// normalizers (CSV text in, dataset out), so tests exercise the same path as
// a real import.
import { emptyDataset, markDuplicates, mergeDataset, normalizeReiRows, parseGoogleAdsCsv } from '../engine/index.js';

export const KEYWORDS_CSV = `Keyword report
"September 1, 2026 - September 27, 2026"
Day,Campaign,Ad group,Keyword,Match type,Final URL,Impr.,Clicks,Cost,Conversions
2026-09-01,Search - Bay Area,Inherited,[sell inherited house],Exact match,https://twinhomebuyer.com/,120,10,"$450.00",2
2026-09-01,Search - Bay Area,Core,"""we buy houses""",Phrase match,https://twinhomebuyer.com/,300,31,"1,420.00",5
2026-09-02,Search - Bay Area,Inherited,[sell inherited house],Exact match,https://twinhomebuyer.com/,80,6,"$500.00",1
Total: Account,,,,,,500,47,"2,370.00",8
`;

export const LOCATIONS_CSV = `Day,Campaign,Ad group,City (User location),Impr.,Clicks,Cost
2026-09-01,Search - Bay Area,Inherited,"San Francisco, California, United States",120,10,450
2026-09-01,Search - Bay Area,Core,"Stockton, California, United States",300,31,1420
2026-09-02,Search - Bay Area,Inherited,"San Francisco, California, United States",80,6,500
`;

export const CLICKS_CSV = `Day,Campaign,Ad group,Keyword,Match type,GCLID,City
2026-09-01,Search - Bay Area,Inherited,sell inherited house,Exact,G1,San Francisco
2026-09-01,Search - Bay Area,Core,we buy houses,Phrase,G2,Stockton
2026-09-02,Search - Bay Area,Inherited,sell inherited house,Exact,G5,San Francisco
`;

export const SEARCH_TERMS_CSV = `Day,Search term,Campaign,Ad group,Keyword,Match type,Impr.,Clicks,Cost,Conversions
2026-09-01,we buy houses stockton,Search - Bay Area,Core,we buy houses,Phrase,200,20,900,0
2026-09-01,we buy houses jobs,Search - Bay Area,Core,we buy houses,Phrase,50,5,120,0
2026-09-01,sell inherited house sf,Search - Bay Area,Inherited,sell inherited house,Exact,120,10,450,2
`;

export const REI_ROWS = [
  { 'Lead ID': 'L1', 'Created Date': '2026-09-02', 'Lead Status': 'Under Contract', GCLID: 'G1', City: 'San Francisco', Phone: '(415) 555-0100', Name: 'Pat Doe', Motivation: 'Inherited from mom, probate done' },
  { 'Lead ID': 'L2', 'Created Date': '2026-09-02', 'Lead Status': 'Not Interested', GCLID: 'G2', City: 'Stockton', Phone: '209-555-0101' },
  { 'Lead ID': 'L3', 'Created Date': '2026-09-03', 'Lead Status': 'Unqualified', 'Lead Source': 'Google Ads', Phone: '209-555-0102' },
  { 'Lead ID': 'L4', 'Created Date': '2026-09-04', 'Lead Status': 'New', 'Lead Source': 'Direct Mail', Phone: '(415) 555-0100' },
  { 'Lead ID': 'L5', 'Created Date': '2026-09-03', 'Lead Status': 'Appointment Set', GCLID: 'G5', City: 'San Francisco', Phone: '415-555-0199', Motivation: 'Heir, house needs repairs' },
];

/** Google Ads + REI dataset through the real importers. */
export async function miniDataset({ reiRows = REI_ROWS, extra = [] } = {}) {
  let ds = emptyDataset();
  for (const csv of [KEYWORDS_CSV, LOCATIONS_CSV, CLICKS_CSV, SEARCH_TERMS_CSV, ...extra]) {
    const parsed = parseGoogleAdsCsv(csv);
    ds = mergeDataset(ds, { ...emptyDataset(), ads: parsed.ads }).dataset;
  }
  const rei = await normalizeReiRows(reiRows);
  markDuplicates(rei.leads);
  ds = mergeDataset(ds, { ...emptyDataset(), rei: { leads: rei.leads, unmappedStatuses: rei.unmappedStatuses } }).dataset;
  return ds;
}

/** Totals row for decision tests, with every field defaulted to 0. */
export function totals(overrides = {}) {
  return {
    impressions: 0, clicks: 0, spend: 0, googleConversions: 0, leads: 0, qualified: 0, appointments: 0, offers: 0,
    contracts: 0, deals: 0, junk: 0, revenue: 0, profit: 0, dealsWithRevenue: 0, dealsWithProfit: 0,
    attrHigh: 0, attrMedium: 0, attrLow: 0, estimatedSpend: 0, ...overrides,
  };
}
