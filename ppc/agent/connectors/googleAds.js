// Google Ads API connector (read only). Pulls, for the sync window:
//   campaigns, ad groups, keyword_view (daily, by device), search_term_view,
//   geographic_view (ad group x city x day, location of presence),
//   click_view (one day per query, the API's rule; GCLID -> keyword + city),
//   geo target constant names, and ad headlines (for the landing page check).
// Uses REST searchStream with an OAuth refresh token; nothing is ever changed
// in the account (version 1 is recommendations only).
import { addDays, normalizeGaql, todayUtc } from '../../engine/index.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export class SourceError extends Error {
  constructor(message, { code = 'SOURCE_ERROR', step = '', retryable = false, status } = {}) {
    super(message);
    this.code = code;
    this.step = step;
    this.retryable = retryable;
    this.status = status;
  }
}

const QUERIES = {
  campaigns: () => `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type FROM campaign WHERE campaign.status != 'REMOVED'`,
  adGroups: () => `SELECT campaign.id, ad_group.id, ad_group.name, ad_group.status FROM ad_group WHERE ad_group.status != 'REMOVED'`,
  keywordView: (s, e) => `SELECT campaign.id, ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group_criterion.final_urls, segments.date, segments.device, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM keyword_view WHERE segments.date BETWEEN '${s}' AND '${e}'`,
  searchTermView: (s, e) => `SELECT search_term_view.search_term, campaign.id, ad_group.id, segments.keyword.ad_group_criterion, segments.keyword.info.text, segments.keyword.info.match_type, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM search_term_view WHERE segments.date BETWEEN '${s}' AND '${e}'`,
  geographicView: (s, e) => `SELECT geographic_view.location_type, geographic_view.country_criterion_id, campaign.id, ad_group.id, segments.date, segments.geo_target_city, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM geographic_view WHERE segments.date BETWEEN '${s}' AND '${e}' AND geographic_view.location_type = 'LOCATION_OF_PRESENCE'`,
  clickView: (d) => `SELECT click_view.gclid, click_view.keyword, click_view.keyword_info.text, click_view.keyword_info.match_type, click_view.location_of_presence.city, click_view.location_of_presence.most_specific, campaign.id, ad_group.id, segments.date, segments.device FROM click_view WHERE segments.date = '${d}'`,
  geoConstants: (ids) => `SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.canonical_name, geo_target_constant.target_type FROM geo_target_constant WHERE geo_target_constant.id IN (${ids.join(', ')})`,
  adCopy: () => `SELECT ad_group.id, ad_group_ad.ad.id, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.final_urls FROM ad_group_ad WHERE ad_group_ad.status = 'ENABLED'`,
};
export { QUERIES as GOOGLE_ADS_QUERIES };

/** Plain-words message for a Google Ads API failure. */
export function explainGoogleAdsError(status, body, cfg) {
  const detail = Array.isArray(body) ? body[0]?.error : body?.error;
  const errors = (detail?.details || []).flatMap((d) => d.errors || []);
  const codes = errors.map((e) => Object.values(e.errorCode || {})[0]).filter(Boolean);
  const has = (c) => codes.includes(c);
  const cid = cfg.customerId ? `${cfg.customerId.slice(0, 3)}-${cfg.customerId.slice(3, 6)}-${cfg.customerId.slice(6)}` : 'the account';
  if (status === 401 || has('OAUTH_TOKEN_EXPIRED') || has('OAUTH_TOKEN_REVOKED') || has('OAUTH_TOKEN_INVALID')) {
    return { code: 'AUTH', message: 'Google sign-in expired or was revoked. Run "npm run ppc:google-auth" and update GOOGLE_ADS_REFRESH_TOKEN in .env.' };
  }
  if (has('DEVELOPER_TOKEN_NOT_APPROVED')) return { code: 'DEV_TOKEN_TEST', message: 'The developer token only has test access. Apply for Basic access in Google Ads → Tools → API Center; until then the Google Ads Script or CSV exports work.' };
  if (has('DEVELOPER_TOKEN_PROHIBITED') || has('DEVELOPER_TOKEN_NOT_WHITELISTED')) return { code: 'DEV_TOKEN', message: 'Google refused the developer token. Check GOOGLE_ADS_DEVELOPER_TOKEN in Google Ads → API Center.' };
  if (has('USER_PERMISSION_DENIED')) return { code: 'PERMISSION', message: `The Google account behind the refresh token cannot open ${cid}. If a manager account (MCC) owns it, set GOOGLE_ADS_LOGIN_CUSTOMER_ID to the manager's id.` };
  if (has('CUSTOMER_NOT_ENABLED')) return { code: 'CUSTOMER', message: `Google Ads account ${cid} is not active.` };
  if (status === 429 || has('RESOURCE_EXHAUSTED') || has('RESOURCE_TEMPORARILY_EXHAUSTED')) return { code: 'QUOTA', message: 'Google Ads API quota reached. The next scheduled run will try again.', retryable: true };
  if (errors.some((e) => e.errorCode?.queryError)) return { code: 'QUERY', message: `Google Ads rejected a report query (${errors[0]?.message || 'query error'}). Check GOOGLE_ADS_API_VERSION.` };
  if (status >= 500) return { code: 'UNAVAILABLE', message: `Google Ads API is not responding (HTTP ${status}).`, retryable: true };
  return { code: 'API', message: `Google Ads API error (HTTP ${status}): ${detail?.message || errors[0]?.message || 'unknown error'}` };
}

export function createGoogleAdsClient(cfg, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log } = {}) {
  let token = null;
  let tokenExpires = 0;
  async function accessToken() {
    if (token && Date.now() < tokenExpires - 60000) return token;
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: cfg.refreshToken, grant_type: 'refresh_token' }).toString(),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      const why = json.error === 'invalid_grant' ? 'the refresh token is no longer valid' : json.error === 'invalid_client' ? 'the OAuth client id or secret is wrong' : `HTTP ${res.status}`;
      throw new SourceError(`Google sign-in failed: ${why}. Run "npm run ppc:google-auth" and update .env.`, { code: 'AUTH', step: 'google_ads.token' });
    }
    token = json.access_token;
    tokenExpires = Date.now() + (json.expires_in || 3600) * 1000;
    return token;
  }
  async function search(query, step) {
    const url = `${cfg.endpoint}/${cfg.apiVersion}/customers/${cfg.customerId}/googleAds:searchStream`;
    for (let attempt = 1; ; attempt += 1) {
      const headers = { authorization: `Bearer ${await accessToken()}`, 'developer-token': cfg.developerToken, 'content-type': 'application/json' };
      if (cfg.loginCustomerId) headers['login-customer-id'] = cfg.loginCustomerId;
      let res;
      try {
        res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify({ query }) });
      } catch (e) {
        if (attempt < 3) { await sleep(1000 * 2 ** attempt); continue; }
        throw new SourceError(`Could not reach the Google Ads API: ${e.message}`, { code: 'NETWORK', step, retryable: true });
      }
      const body = await res.json().catch(() => null);
      if (res.ok) {
        const batches = Array.isArray(body) ? body : [body];
        return batches.flatMap((b) => b?.results || []);
      }
      const why = explainGoogleAdsError(res.status, body, cfg);
      if (why.code === 'AUTH' && attempt === 1) { token = null; continue; }
      if (why.retryable && attempt < 3) {
        log?.warn('google_ads_retry', { message: why.message, attempt });
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      throw new SourceError(why.message, { code: why.code, step, status: res.status });
    }
  }
  return { search, accessToken };
}

/** The dates to (re)pull: a backfill on first run, then the last few days. */
export function adsWindow(cfg, state, today = todayUtc()) {
  const oldest = addDays(today, -89); // click_view only reaches back 90 days
  let start = state.lastSyncedThrough ? addDays(state.lastSyncedThrough, -(cfg.lookbackDays - 1)) : addDays(today, -(cfg.backfillDays - 1));
  if (start < oldest) start = oldest;
  return { start, end: today };
}

export async function syncGoogleAds(cfg, state, { client, today = todayUtc(), log } = {}) {
  const c = client || createGoogleAdsClient(cfg, { log });
  const { start, end } = adsWindow(cfg, state, today);
  const results = {};
  results.campaigns = await c.search(QUERIES.campaigns(), 'google_ads.campaigns');
  results.adGroups = await c.search(QUERIES.adGroups(), 'google_ads.ad_groups');
  results.keywordView = await c.search(QUERIES.keywordView(start, end), 'google_ads.keyword_view');
  results.searchTermView = await c.search(QUERIES.searchTermView(start, end), 'google_ads.search_term_view');
  results.geographicView = await c.search(QUERIES.geographicView(start, end), 'google_ads.geographic_view');
  results.clickView = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    results.clickView.push(...(await c.search(QUERIES.clickView(d), `google_ads.click_view ${d}`)));
  }
  const geoIds = new Set();
  const idOf = (res) => /geoTargetConstants\/(\d+)/.exec(String(res || ''))?.[1];
  for (const r of results.geographicView) { const id = idOf(r.segments?.geoTargetCity); if (id) geoIds.add(id); }
  for (const r of results.clickView) {
    for (const res of [r.clickView?.locationOfPresence?.city, r.clickView?.locationOfPresence?.mostSpecific]) { const id = idOf(res); if (id) geoIds.add(id); }
  }
  results.geoConstants = [];
  const ids = [...geoIds];
  for (let i = 0; i < ids.length; i += 200) results.geoConstants.push(...(await c.search(QUERIES.geoConstants(ids.slice(i, i + 200)), 'google_ads.geo_target_constant')));
  let adRows = [];
  try {
    adRows = await c.search(QUERIES.adCopy(), 'google_ads.ad_group_ad');
  } catch (e) {
    log?.warn('google_ads_ad_copy_skipped', { message: e.message });
  }
  const ads = normalizeGaql(results);
  ads.adCopy = adRows.map((r) => ({
    id: String(r.adGroupAd?.ad?.id || ''), adGroupId: String(r.adGroup?.id || ''),
    headlines: (r.adGroupAd?.ad?.responsiveSearchAd?.headlines || []).map((x) => x.text).filter(Boolean),
    finalUrl: (r.adGroupAd?.ad?.finalUrls || [])[0] || '',
  })).filter((a) => a.adGroupId);
  state.lastSyncedThrough = end;
  const stats = {
    rows: ads.keywordDaily.length + ads.searchTermsDaily.length + ads.geoDaily.length, clicks: ads.clicks.length,
    keywords: ads.keywords.length, window: `${start} to ${end}`,
  };
  return { ads, stats, window: { start, end } };
}
