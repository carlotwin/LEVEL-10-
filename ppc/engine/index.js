// Engine entry point. Pure JavaScript with no dependencies: the same code
// runs in the dashboard (browser), the sync agent (Node) and the tests.
import { DEFAULT_ACTION_SETTINGS, proposeActions } from './actions.js';
import { buildAlerts } from './alerts.js';
import { dataHealth } from './health.js';
import { analyzeLandingPages } from './landing.js';
import { buildModel, filterOptions, hasLeadOnlyFilters, overview, rollUp, weeklyTrend } from './model.js';
import { analyzeRetargeting } from './retargeting.js';
import { analyzeSearchTerms } from './waste.js';
import { addDays } from './util.js';

export * from './util.js';
export * from './csv.js';
export * from './geo.js';
export * from './situations.js';
export * from './normalize/googleAds.js';
export * from './normalize/rei.js';
export * from './normalize/ga4.js';
export * from './normalize/calls.js';
export * from './attribution.js';
export * from './decisions.js';
export * from './model.js';
export * from './waste.js';
export * from './retargeting.js';
export * from './landing.js';
export * from './health.js';
export * from './alerts.js';
export * from './actions.js';
export * from './dataset.js';
export * from './exports.js';

export const ENGINE_VERSION = '1.0.0';

/** The fixed window the Action Queue decides on: the last N days of data. */
export function decisionWindow(model, settings = {}) {
  const days = settings.actions?.windowDays ?? DEFAULT_ACTION_SETTINGS.windowDays;
  const end = model.bounds.max;
  return end ? { start: addDays(end, -(days - 1)), end, days } : { start: null, end: null, days };
}

/**
 * Everything the dashboard shows for one set of filters.
 * Actions are always decided on the decision window with no other filters,
 * so what a person approves does not depend on what they happened to filter.
 */
export function analyze(dataset, settings = {}, filters = {}, { now = Date.now() } = {}) {
  const model = buildModel(dataset, settings);
  const ov = overview(model, filters);
  const rows = ov.table.rows;
  const keywordRows = rollUp(model, rows, 'keyword');
  const cityRows = rollUp(model, rows, 'city');
  const campaignRows = rollUp(model, rows, 'campaign');
  const searchTerms = analyzeSearchTerms(model, filters, keywordRows);
  const landing = analyzeLandingPages(model, keywordRows);

  const win = decisionWindow(model, settings);
  const winFilters = { start: win.start, end: win.end };
  const winRows = overview(model, winFilters).table.rows;
  const winKeywords = rollUp(model, winRows, 'keyword');
  const actions = proposeActions(model, {
    keywordRows: winKeywords,
    campaignCityRows: rollUp(model, winRows, 'campaign_city'),
    searchTerms: analyzeSearchTerms(model, winFilters, winKeywords),
    landing: analyzeLandingPages(model, winKeywords),
    window: winFilters,
  });

  return {
    model,
    overview: ov,
    rows,
    unmatched: ov.table.unmatched,
    leadOnlyFilters: hasLeadOnlyFilters(filters),
    keywordRows,
    cityRows,
    campaignRows,
    searchTerms,
    landing,
    retargeting: analyzeRetargeting(dataset, { situations: model.settings.situations, consentRate: settings.retargeting?.consentRate }),
    health: dataHealth(model, { now, filters }),
    alerts: buildAlerts(model, { now }),
    actions,
    decisionWindow: win,
    trend: weeklyTrend(model, filters),
    options: filterOptions(model),
  };
}
