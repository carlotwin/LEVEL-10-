// One sync run: each configured source in turn, merged into the local
// dataset (idempotently), each run recorded in the sync history the
// dashboard's Data health page shows, then the dashboard sync file is
// written and new alerts are sent. A failing source never stops the others,
// and never erases the last good data.
import { buildAlerts, buildModel, mergeDataset, normalizeReiRows, recordSync, statusRulesFrom, todayUtc } from '../engine/index.js';
import { sourceConfigured } from './config.js';
import { syncGa4 } from './connectors/ga4.js';
import { syncGoogleAds } from './connectors/googleAds.js';
import { crawlRei, loadSelectors } from './connectors/reiCrawler.js';
import { importReiExportFolder, importReiSheet } from './connectors/reiFiles.js';
import { scanPages } from './connectors/site.js';
import { sendAlerts } from './notify.js';
import { createStore } from './store.js';

export const SOURCE_ORDER = ['google_ads', 'ga4', 'rei', 'pages'];

const withoutSync = (part) => {
  const { sync, ...rest } = part || {};
  return rest;
};

export async function runSync(cfg, { only, log, fetchImpl = fetch, now = Date.now(), connectors = {}, forceCrawler = false, launch } = {}) {
  const store = createStore(cfg);
  let ds = store.loadDataset();
  const state = store.loadState();
  const settings = store.loadSettings();
  const today = todayUtc(new Date(now));
  const summary = [];
  const wanted = (s) => !only?.length || only.includes(s);

  const run = async (source, mode, fn) => {
    const startedAt = new Date().toISOString();
    try {
      const r = await fn();
      let created = 0;
      let updated = 0;
      if (r.part) {
        const merged = mergeDataset(ds, withoutSync(r.part));
        ds = merged.dataset;
        created = merged.stats.leads?.created || merged.stats.ads?.rows || merged.stats.web?.rows || merged.stats.web?.pages || 0;
        updated = merged.stats.leads?.updated || merged.stats.ads?.replacedRows || 0;
      }
      const status = r.status || (r.errors?.length ? 'partial' : 'ok');
      recordSync(ds, {
        source, mode: r.mode || mode, status, startedAt, created, updated, failed: r.stats?.failed || 0,
        message: r.message || '', errors: r.errors || [],
      });
      summary.push({ source, mode: r.mode || mode, status, message: r.message || '' });
      log?.info('source_done', { message: `${source} (${r.mode || mode}): ${status}${r.message ? ` · ${r.message}` : ''}` });
      return { ok: true, result: r };
    } catch (e) {
      recordSync(ds, {
        source, mode, status: 'failed', startedAt, failed: e.stats?.failed || 0, message: e.message,
        errors: e.errors || [{ step: e.step || source, selector: e.selector || '', message: e.message }],
      });
      summary.push({ source, mode, status: 'failed', message: e.message });
      log?.error('source_failed', { message: `${source} (${mode}): ${e.message}`, step: e.step, selector: e.selector });
      return { ok: false, error: e };
    }
  };

  if (wanted('google_ads') && sourceConfigured.google_ads(cfg)) {
    await run('google_ads', 'api', async () => {
      const r = await (connectors.googleAds || syncGoogleAds)(cfg.googleAds, state.ads, { log, today, fetchImpl });
      return { part: { ads: r.ads }, stats: r.stats, message: `${r.stats.window}: ${r.stats.keywords} keywords, ${r.stats.clicks} clicks with GCLID` };
    });
  } else if (wanted('google_ads')) summary.push({ source: 'google_ads', status: 'skipped', message: 'Not set up (see npm run ppc:check).' });

  if (wanted('ga4') && sourceConfigured.ga4(cfg)) {
    await run('ga4', 'api', async () => {
      const r = await (connectors.ga4 || syncGa4)(cfg.ga4, state.ga4, { fetchImpl, today, log });
      return { part: { web: r.web }, stats: r.stats, message: `${r.stats.window}: ${r.stats.rows} rows` };
    });
  } else if (wanted('ga4')) summary.push({ source: 'ga4', status: 'skipped', message: 'Not set up (see npm run ppc:check).' });

  if (wanted('rei') && sourceConfigured.rei(cfg)) {
    const r = cfg.rei;
    if (r.exportDir) {
      await run('rei', 'csv', async () => {
        const out = await (connectors.reiExports || importReiExportFolder)(r, state.rei, { settings });
        return { part: out.part, stats: out.stats, message: out.message };
      });
    }
    if (r.sheetId) {
      await run('rei', 'sheet', async () => {
        const out = await (connectors.reiSheet || importReiSheet)(r, { settings });
        return { part: out.part, stats: out.stats, message: out.message };
      });
    }
    if (r.crawlerEnabled) {
      if (state.rei.mode === 'csv-fallback' && !forceCrawler) {
        recordSync(ds, { source: 'rei', mode: 'crawler', status: 'partial', message: `Crawler paused after ${state.rei.consecutiveFailures} failed runs; REI CSV exports are used until it is fixed. Fix the selector, then run: npm run ppc:sync -- --only=rei --force-crawler` });
        summary.push({ source: 'rei', mode: 'crawler', status: 'paused', message: 'Crawler paused (CSV fallback in use).' });
      } else {
        const res = await run('rei', 'crawler', async () => {
          const out = await (connectors.reiCrawler || crawlRei)(r, {
            selectors: loadSelectors(r.selectorsFile), state: state.rei, log, launch, now,
            sessionFile: store.files.session, secretKey: r.persistSession ? cfg.secretKey : '',
          });
          const norm = await normalizeReiRows(out.rows, {
            mapping: settings.rei?.mapping || {}, statusRules: statusRulesFrom(settings.rei?.statusMap),
            situations: settings.situations?.length ? settings.situations : undefined, qualifiedScoreMin: settings.rei?.qualifiedScoreMin ?? 7, sourceSystem: 'rei_crawler',
          });
          return {
            part: { rei: { leads: norm.leads, unmappedStatuses: norm.unmappedStatuses } }, status: out.status, errors: out.errors,
            stats: { ...out.stats, failed: out.stats.failed }, message: `${out.stats.listed} listed, ${out.stats.read} read, ${out.stats.failed} failed, ${out.stats.skipped} not due`,
          };
        });
        if (res.ok) {
          state.rei.consecutiveFailures = 0;
          state.rei.mode = 'auto';
        } else {
          state.rei.consecutiveFailures = (state.rei.consecutiveFailures || 0) + 1;
          if (state.rei.consecutiveFailures >= r.fallbackAfterFailures && res.error?.code !== 'MANUAL_LOGIN_REQUIRED') {
            state.rei.mode = 'csv-fallback';
            log?.warn('rei_crawler_paused', { message: `Crawler paused after ${state.rei.consecutiveFailures} failures; CSV import is the fallback.` });
          }
        }
      }
    }
  } else if (wanted('rei')) summary.push({ source: 'rei', status: 'skipped', message: 'Not set up (see npm run ppc:check).' });

  if (wanted('pages') && (ds.ads?.keywords?.length || cfg.site.extraUrls.length)) {
    await run('pages', 'scan', async () => {
      const out = await (connectors.pages || scanPages)(cfg, ds, { fetchImpl, log });
      return { part: { web: { pages: out.web.pages } }, stats: out.stats, errors: out.errors, message: `${out.stats.rows} pages read${out.stats.failed ? `, ${out.stats.failed} failed` : ''}` };
    });
  }

  const datasetFile = store.saveDataset(ds);
  const bundleFile = store.writeBundle(ds);
  const alerts = buildAlerts(buildModel(ds, settings), { now });
  const sent = await sendAlerts(cfg, alerts, state, { fetchImpl, log, now });
  store.saveState(state);
  log?.info('sync_done', { message: `dataset ${datasetFile}; sync file ${bundleFile}; alerts ${alerts.length} (${sent.sent} sent)` });
  return { summary, alerts, files: { dataset: datasetFile, bundle: bundleFile }, dataset: ds, state };
}
