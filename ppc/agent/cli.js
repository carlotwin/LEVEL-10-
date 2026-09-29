#!/usr/bin/env node
// Twin PPC sync agent.
//   node ppc/agent/cli.js check                 what is set up, what is missing
//   node ppc/agent/cli.js sync [--only=google_ads,ga4,rei,pages] [--force-crawler]
//   node ppc/agent/cli.js schedule              run the syncs on their schedules
//   node ppc/agent/cli.js import <files...>     import CSV / XLSX / JSON files
//   node ppc/agent/cli.js rei-login             sign in to REI yourself (MFA/CAPTCHA)
//   node ppc/agent/cli.js google-auth           get the Google refresh token for .env
//   node ppc/agent/cli.js bundle                rewrite the dashboard sync file
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { importFile, mergeDataset } from '../engine/index.js';
import { missingSetup, readConfig, sourceConfigured } from './config.js';
import { crawlRei, loadSelectors } from './connectors/reiCrawler.js';
import { fileToText } from './connectors/reiFiles.js';
import { googleAuth } from './googleAuth.js';
import { createLogger } from './log.js';
import { runScheduler } from './scheduler.js';
import { createStore } from './store.js';
import { runSync, SOURCE_ORDER } from './sync.js';

const [, , command = 'help', ...rest] = process.argv;
const flags = Object.fromEntries(rest.filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const args = rest.filter((a) => !a.startsWith('--'));

const cfg = readConfig();
const log = createLogger(cfg.dataDir);

async function main() {
  switch (command) {
    case 'check': {
      console.log('Twin PPC sync agent: setup check (nothing is sent anywhere)\n');
      for (const s of SOURCE_ORDER) console.log(`  ${sourceConfigured[s](cfg) ? '✔' : '✘'} ${s}`);
      console.log('');
      for (const m of missingSetup(cfg)) console.log(`  ${m.ok ? '✔' : '○'} ${m.source.padEnd(10)} ${m.what}${m.ok ? '' : `\n      → ${m.how}`}`);
      console.log(`\n  Data folder: ${cfg.dataDir}\n  Sync file:   ${path.join(cfg.bundleDir, cfg.bundleName)}`);
      return;
    }
    case 'sync': {
      const only = typeof flags.only === 'string' ? flags.only.split(',') : undefined;
      const r = await runSync(cfg, { only, log, forceCrawler: !!flags['force-crawler'] });
      console.log('\nResult:');
      for (const s of r.summary) console.log(`  ${s.status.padEnd(8)} ${s.source}${s.mode ? ` (${s.mode})` : ''}${s.message ? `: ${s.message}` : ''}`);
      console.log(`  Alerts: ${r.alerts.length}. Sync file: ${r.files.bundle}`);
      if (r.summary.some((s) => s.status === 'failed')) process.exitCode = 2;
      return;
    }
    case 'schedule': {
      const jobs = SOURCE_ORDER.filter((s) => s === 'pages' || sourceConfigured[s](cfg)).map((s) => ({
        name: s, cron: cfg.schedules[s], run: () => runSync(cfg, { only: [s], log }),
      }));
      if (!jobs.length) throw new Error('Nothing is set up yet. Run: npm run ppc:check');
      const ctrl = new AbortController();
      process.on('SIGINT', () => { log.info('schedule_stop', { message: 'stopping after the current job' }); ctrl.abort(); });
      await runScheduler(jobs, { timeZone: cfg.timezone, log, signal: ctrl.signal });
      return;
    }
    case 'import': {
      if (!args.length) throw new Error('Name one or more files: npm run ppc:import -- path/to/export.csv');
      const store = createStore(cfg);
      let ds = store.loadDataset();
      const settings = store.loadSettings();
      for (const file of args) {
        const r = await importFile({ name: path.basename(file), text: /\.json$/i.test(file) ? readFileSync(file, 'utf8') : fileToText(file) }, { settings, mode: 'csv' });
        if (!r.part) {
          console.log(`  ✘ ${file}: ${r.errors.join(' ')}`);
          process.exitCode = 2;
          continue;
        }
        const m = mergeDataset(ds, r.part);
        ds = m.dataset;
        console.log(`  ✔ ${file}: ${r.label}${r.stats.leads != null ? `, ${r.stats.leads} leads` : r.stats.rows != null ? `, ${r.stats.rows} rows` : ''}${r.warnings.length ? `\n      ${r.warnings.join('\n      ')}` : ''}`);
      }
      store.saveDataset(ds);
      console.log(`  Sync file: ${store.writeBundle(ds)}`);
      return;
    }
    case 'rei-login': {
      const store = createStore(cfg);
      if (!cfg.rei.persistSession) console.log('Note: REI_PERSIST_SESSION is not true, so the sign-in is not kept after this window closes.');
      await crawlRei(cfg.rei, {
        selectors: loadSelectors(cfg.rei.selectorsFile), interactive: true, loginOnly: true, log,
        sessionFile: store.files.session, secretKey: cfg.rei.persistSession ? cfg.secretKey : '',
      });
      console.log(cfg.rei.persistSession && cfg.secretKey ? 'Signed in; the session is saved encrypted for the next runs.' : 'Signed in.');
      return;
    }
    case 'google-auth': {
      const token = await googleAuth(cfg.googleAds);
      console.log('\nAdd this line to .env (keep it secret; it is not saved anywhere by this script):\n');
      console.log(`GOOGLE_ADS_REFRESH_TOKEN=${token}\n`);
      return;
    }
    case 'bundle': {
      const store = createStore(cfg);
      console.log(`Sync file: ${store.writeBundle(store.loadDataset())}`);
      return;
    }
    default:
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 10).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  }
}

main().catch((e) => {
  log.error('agent_failed', { message: e.message, step: e.step, selector: e.selector });
  process.exitCode = 1;
});
