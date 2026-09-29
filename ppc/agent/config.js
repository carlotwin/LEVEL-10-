// Sync agent configuration. Everything comes from environment variables
// (.env in the project root, never committed). Nothing secret is hard-coded
// and nothing secret is ever written to logs or to the dashboard bundle.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../../server/loadenv.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, '..', '..');

const bool = (v, d = false) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v).trim()));
const int = (v, d) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : d;
};
const str = (v, d = '') => (v == null ? d : String(v).trim());
const digits = (v) => String(v ?? '').replace(/\D/g, '');

/** Read the configuration (loads .env first unless told not to). */
export function readConfig(env = process.env, { loadDotEnv = true } = {}) {
  if (loadDotEnv && env === process.env) loadEnv();
  const dataDir = path.resolve(PROJECT_ROOT, str(env.PPC_DATA_DIR, 'data/ppc'));
  return {
    dataDir,
    bundleDir: str(env.PPC_BUNDLE_DIR) ? path.resolve(str(env.PPC_BUNDLE_DIR)) : path.join(dataDir, 'out'),
    bundleName: str(env.PPC_BUNDLE_NAME, 'twin-ppc-bundle.json'),
    bundleDirSet: !!str(env.PPC_BUNDLE_DIR),
    secretKey: str(env.PPC_SECRET_KEY),
    timezone: str(env.PPC_TIMEZONE, 'America/Los_Angeles'),
    alertWebhook: str(env.PPC_ALERT_WEBHOOK_URL),
    settingsFile: str(env.PPC_SETTINGS_FILE) ? path.resolve(str(env.PPC_SETTINGS_FILE)) : path.join(dataDir, 'settings.json'),
    googleAds: {
      developerToken: str(env.GOOGLE_ADS_DEVELOPER_TOKEN),
      clientId: str(env.GOOGLE_ADS_CLIENT_ID || env.GOOGLE_OAUTH_CLIENT_ID),
      clientSecret: str(env.GOOGLE_ADS_CLIENT_SECRET || env.GOOGLE_OAUTH_CLIENT_SECRET),
      refreshToken: str(env.GOOGLE_ADS_REFRESH_TOKEN),
      customerId: digits(env.GOOGLE_ADS_CUSTOMER_ID),
      loginCustomerId: digits(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID),
      apiVersion: str(env.GOOGLE_ADS_API_VERSION, 'v25'),
      backfillDays: Math.min(90, int(env.PPC_ADS_BACKFILL_DAYS, 90)),
      lookbackDays: Math.max(1, int(env.PPC_ADS_LOOKBACK_DAYS, 3)),
      endpoint: str(env.GOOGLE_ADS_API_ENDPOINT, 'https://googleads.googleapis.com'),
    },
    ga4: {
      propertyId: digits(env.GA4_PROPERTY_ID),
      serviceAccountFile: str(env.GA4_SERVICE_ACCOUNT_FILE),
      refreshToken: str(env.GA4_REFRESH_TOKEN || env.GOOGLE_ADS_REFRESH_TOKEN),
      clientId: str(env.GOOGLE_ADS_CLIENT_ID || env.GOOGLE_OAUTH_CLIENT_ID),
      clientSecret: str(env.GOOGLE_ADS_CLIENT_SECRET || env.GOOGLE_OAUTH_CLIENT_SECRET),
      lookbackDays: int(env.PPC_GA4_LOOKBACK_DAYS, 90),
      endpoint: str(env.GA4_API_ENDPOINT, 'https://analyticsdata.googleapis.com'),
    },
    rei: {
      exportDir: str(env.PPC_REI_EXPORT_DIR) ? path.resolve(str(env.PPC_REI_EXPORT_DIR)) : '',
      sheetId: str(env.PPC_REI_SHEET_ID),
      sheetGid: str(env.PPC_REI_SHEET_GID),
      crawlerEnabled: bool(env.REI_CRAWLER_ENABLED, false),
      loginUrl: str(env.REIBB_LOGIN_URL, 'https://my.reiblackbook.com/services/account/login'),
      email: str(env.REIBB_EMAIL),
      password: str(env.REIBB_PASSWORD),
      headless: bool(env.REI_HEADLESS, true),
      persistSession: bool(env.REI_PERSIST_SESSION, false),
      delayMs: Math.max(1000, int(env.REI_CRAWL_DELAY_MS, 2500)),
      maxPages: Math.max(1, int(env.REI_CRAWL_MAX_PAGES, 20)),
      maxContacts: Math.max(1, int(env.REI_CRAWL_MAX_CONTACTS, 150)),
      recrawlHours: Math.max(1, int(env.REI_RECRAWL_HOURS, 24)),
      tag: str(env.REI_CRAWL_TAG),
      selectorsFile: str(env.REI_SELECTORS_FILE) ? path.resolve(str(env.REI_SELECTORS_FILE)) : path.join(PROJECT_ROOT, 'ppc/config/rei-crawler.selectors.json'),
      timeoutMs: int(env.REI_ACTION_TIMEOUT_MS, 15000),
      fallbackAfterFailures: Math.max(1, int(env.REI_FALLBACK_AFTER_FAILURES, 3)),
      executablePath: str(env.PPC_CHROMIUM_PATH),
    },
    site: {
      domains: str(env.PPC_SITE_DOMAINS, 'twinhomebuyer.com').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
      extraUrls: str(env.PPC_SITE_EXTRA_URLS).split(',').map((u) => u.trim()).filter(Boolean),
      delayMs: int(env.PPC_SITE_DELAY_MS, 1000),
    },
    schedules: {
      google_ads: str(env.PPC_SCHEDULE_ADS, '15 5 * * *'),
      ga4: str(env.PPC_SCHEDULE_GA4, '25 5 * * *'),
      rei: str(env.PPC_SCHEDULE_REI, '5 */4 * * *'),
      pages: str(env.PPC_SCHEDULE_PAGES, '40 4 * * 1'),
    },
  };
}

/** What each source still needs. Used by `check` and by SETUP_CHECKLIST.md. */
export function missingSetup(cfg) {
  const out = [];
  const need = (source, ok, what, how) => out.push({ source, ok: !!ok, what, how });
  const g = cfg.googleAds;
  need('google_ads', g.developerToken, 'GOOGLE_ADS_DEVELOPER_TOKEN', 'Google Ads → Tools → API Center (needs a manager account; Basic access for production).');
  need('google_ads', g.clientId && g.clientSecret, 'GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET', 'Google Cloud console → APIs & Services → Credentials → OAuth client (Desktop app); enable the Google Ads API.');
  need('google_ads', g.refreshToken, 'GOOGLE_ADS_REFRESH_TOKEN', 'Run: npm run ppc:google-auth (signs in once in your browser and prints the token).');
  need('google_ads', g.customerId, 'GOOGLE_ADS_CUSTOMER_ID', 'The ad account id shown at the top of Google Ads (123-456-7890).');
  const a = cfg.ga4;
  need('ga4', a.propertyId, 'GA4_PROPERTY_ID', 'GA4 → Admin → Property details → Property ID (numbers only).');
  need('ga4', a.serviceAccountFile || a.refreshToken, 'GA4_SERVICE_ACCOUNT_FILE (or the Google sign-in above)', 'Create a service account, add it as a Viewer on the GA4 property, save its JSON key outside the repo.');
  const r = cfg.rei;
  need('rei', r.exportDir || r.sheetId || r.crawlerEnabled, 'PPC_REI_EXPORT_DIR, PPC_REI_SHEET_ID or REI_CRAWLER_ENABLED=true', 'Best: save REI exports to a folder. Or share a Google Sheet. Or enable the crawler for your own REI login.');
  if (r.crawlerEnabled) {
    need('rei', r.persistSession ? cfg.secretKey : true, 'PPC_SECRET_KEY (to keep the REI sign-in between runs)', 'Any random 32-byte key: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  need('dashboard', cfg.bundleDirSet, 'PPC_BUNDLE_DIR', 'A Google Drive for desktop folder (e.g. G:\\My Drive\\Twin PPC), so the dashboard can load the sync file.');
  need('alerts', cfg.alertWebhook, 'PPC_ALERT_WEBHOOK_URL (optional)', 'A Google Chat or Slack incoming webhook for notifications.');
  return out;
}

export const sourceConfigured = {
  google_ads: (c) => !!(c.googleAds.developerToken && c.googleAds.clientId && c.googleAds.clientSecret && c.googleAds.refreshToken && c.googleAds.customerId),
  ga4: (c) => !!(c.ga4.propertyId && (c.ga4.serviceAccountFile || (c.ga4.refreshToken && c.ga4.clientId && c.ga4.clientSecret))),
  rei: (c) => !!(c.rei.exportDir || c.rei.sheetId || c.rei.crawlerEnabled),
  pages: () => true,
};
