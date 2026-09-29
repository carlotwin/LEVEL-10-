// GA4 Data API connector (read only). Landing page sessions by day and
// source/medium, form events, and page-level visitor totals for the
// retargeting audiences. Signs in with a service account (JSON key kept
// outside the repo) or with the same Google sign-in as Google Ads.
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { addDays, cleanPath, isPaidMedium, todayUtc, toDate } from '../../engine/index.js';
import { SourceError } from './googleAds.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const FORM_EVENTS = ['form_start', 'form_submit', 'generate_lead'];

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** A signed JWT for the service account token exchange. */
export function serviceAccountJwt(key, now = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(key.private_key))}`;
}

export async function ga4AccessToken(cfg, fetchImpl = fetch) {
  let body;
  if (cfg.serviceAccountFile) {
    let key;
    try {
      key = JSON.parse(readFileSync(cfg.serviceAccountFile, 'utf8'));
    } catch {
      throw new SourceError('GA4 service account key file could not be read. Check GA4_SERVICE_ACCOUNT_FILE.', { code: 'AUTH', step: 'ga4.key' });
    }
    body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: serviceAccountJwt(key) });
  } else {
    body = new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: cfg.refreshToken, grant_type: 'refresh_token' });
  }
  const res = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new SourceError(`GA4 sign-in failed (${json.error || `HTTP ${res.status}`}).`, { code: 'AUTH', step: 'ga4.token' });
  return json.access_token;
}

async function runReport(cfg, token, request, fetchImpl, step) {
  const rows = [];
  let offset = 0;
  for (;;) {
    const res = await fetchImpl(`${cfg.endpoint}/v1beta/properties/${cfg.propertyId}:runReport`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, limit: 100000, offset }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = res.status === 403 ? 'The GA4 sign-in has no access to this property. Add the service account (or Google user) as a Viewer in GA4 → Admin → Property access.'
        : res.status === 400 ? `GA4 rejected the report (${json.error?.message || 'bad request'}).` : `GA4 Data API error (HTTP ${res.status}).`;
      throw new SourceError(msg, { code: res.status === 403 ? 'PERMISSION' : 'API', step, status: res.status, retryable: res.status >= 500 });
    }
    const dims = (json.dimensionHeaders || []).map((d) => d.name);
    const mets = (json.metricHeaders || []).map((m) => m.name);
    for (const r of json.rows || []) {
      const o = {};
      dims.forEach((d, i) => { o[d] = r.dimensionValues?.[i]?.value ?? ''; });
      mets.forEach((m, i) => { o[m] = Number(r.metricValues?.[i]?.value ?? 0); });
      rows.push(o);
    }
    offset += (json.rows || []).length;
    if (!json.rows?.length || offset >= (json.rowCount || 0)) break;
  }
  return rows;
}

export async function syncGa4(cfg, state, { fetchImpl = fetch, today = todayUtc(), log } = {}) {
  const token = await ga4AccessToken(cfg, fetchImpl);
  const start = addDays(today, -(cfg.lookbackDays - 1));
  const dateRanges = [{ startDate: start, endDate: today }];
  const eventFilter = { filter: { fieldName: 'eventName', inListFilter: { values: FORM_EVENTS } } };

  const landing = await runReport(cfg, token, {
    dateRanges,
    dimensions: ['date', 'landingPagePlusQueryString', 'sessionSource', 'sessionMedium', 'sessionCampaignName', 'deviceCategory'].map((name) => ({ name })),
    metrics: ['sessions', 'engagedSessions', 'keyEvents'].map((name) => ({ name })),
  }, fetchImpl, 'ga4.landing_pages');
  const landingEvents = await runReport(cfg, token, {
    dateRanges, dimensions: ['date', 'landingPagePlusQueryString', 'sessionSource', 'sessionMedium', 'eventName'].map((name) => ({ name })),
    metrics: [{ name: 'eventCount' }], dimensionFilter: eventFilter,
  }, fetchImpl, 'ga4.form_events');
  const pages = await runReport(cfg, token, { dateRanges, dimensions: [{ name: 'pagePath' }], metrics: ['activeUsers', 'newUsers', 'keyEvents'].map((name) => ({ name })) }, fetchImpl, 'ga4.pages');
  const pagesPaid = await runReport(cfg, token, {
    dateRanges, dimensions: [{ name: 'pagePath' }], metrics: [{ name: 'activeUsers' }],
    dimensionFilter: { filter: { fieldName: 'sessionMedium', stringFilter: { value: 'cpc', matchType: 'EXACT' } } },
  }, fetchImpl, 'ga4.pages_paid');
  const pageEvents = await runReport(cfg, token, { dateRanges, dimensions: [{ name: 'pagePath' }, { name: 'eventName' }], metrics: [{ name: 'eventCount' }], dimensionFilter: eventFilter }, fetchImpl, 'ga4.page_events');

  const key = (r) => `${r.date}|${cleanPath(r.landingPagePlusQueryString)}|${r.sessionSource}|${r.sessionMedium}`;
  const events = new Map();
  for (const r of landingEvents) {
    const e = events.get(key(r)) || { starts: 0, submits: 0 };
    if (r.eventName === 'form_start') e.starts += r.eventCount; else e.submits += r.eventCount;
    events.set(key(r), e);
  }
  const landingDaily = landing.filter((r) => r.landingPagePlusQueryString && r.landingPagePlusQueryString !== '(not set)').map((r) => {
    const e = events.get(key(r)) || { starts: 0, submits: 0 };
    return {
      d: toDate(r.date), path: cleanPath(r.landingPagePlusQueryString), source: r.sessionSource, medium: r.sessionMedium,
      paid: isPaidMedium(`${r.sessionSource} / ${r.sessionMedium}`, r.sessionMedium), campaign: r.sessionCampaignName === '(not set)' ? '' : r.sessionCampaignName,
      kw: '', city: '', st: '', dev: String(r.deviceCategory || '').toLowerCase(),
      sessions: r.sessions, engaged: r.engagedSessions, keyEvents: r.keyEvents, formStarts: e.starts, formSubmits: e.submits,
    };
  });
  const paid = new Map(pagesPaid.map((r) => [cleanPath(r.pagePath), r.activeUsers]));
  const pev = new Map();
  for (const r of pageEvents) {
    const p = cleanPath(r.pagePath);
    const e = pev.get(p) || { starts: 0, submits: 0 };
    if (r.eventName === 'form_start') e.starts += r.eventCount; else e.submits += r.eventCount;
    pev.set(p, e);
  }
  const pagePaths = pages.map((r) => {
    const p = cleanPath(r.pagePath);
    return {
      path: p, users: r.activeUsers, returningUsers: Math.max(0, r.activeUsers - r.newUsers), ppcUsers: paid.get(p) || 0,
      keyEvents: r.keyEvents, formStarts: pev.get(p)?.starts || 0, formSubmits: pev.get(p)?.submits || 0,
    };
  });
  state.lastSyncedThrough = today;
  log?.info('ga4_synced', { message: `${landingDaily.length} landing rows, ${pagePaths.length} pages` });
  return { web: { landingDaily, pagePaths }, stats: { rows: landingDaily.length + pagePaths.length, window: `${start} to ${today}` } };
}
