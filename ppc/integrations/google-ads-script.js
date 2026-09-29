/**
 * Twin PPC: Google Ads Script export (no developer token needed).
 *
 * Runs inside Google Ads (Tools → Bulk actions → Scripts), read only. Every
 * run writes the same report rows the sync agent pulls through the API to one
 * JSON file in Google Drive (twin-ppc-gads.json, kind "twin-ppc-gads/1"). In
 * the dashboard: Data sources → Google Drive → "Find sync files" → Import.
 *
 * Setup:
 *   1. Google Ads → Tools → Bulk actions → Scripts → + New script.
 *   2. Paste this whole file. Click Authorize (it asks for Google Ads read
 *      access and Google Drive access for the file below).
 *   3. Preview once, then Run. Schedule it Daily (e.g. 5 AM).
 * This script never changes campaigns, bids, budgets or keywords.
 */
var CONFIG = {
  FOLDER_NAME: 'Twin PPC',          // Drive folder (created if missing)
  FILE_NAME: 'twin-ppc-gads.json',  // replaced on every run
  DAYS: 90,                         // click data only reaches back 90 days
};

function fmtDate(d) {
  return Utilities.formatDate(d, AdsApp.currentAccount().getTimeZone(), 'yyyy-MM-dd');
}

function rows(query) {
  var out = [];
  var it = AdsApp.search(query);
  while (it.hasNext()) out.push(it.next());
  return out;
}

function main() {
  var end = new Date();
  var start = new Date(end.getTime() - (CONFIG.DAYS - 1) * 86400000);
  var s = fmtDate(start);
  var e = fmtDate(end);
  var results = {
    campaigns: rows("SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type FROM campaign WHERE campaign.status != 'REMOVED'"),
    adGroups: rows("SELECT campaign.id, ad_group.id, ad_group.name, ad_group.status FROM ad_group WHERE ad_group.status != 'REMOVED'"),
    keywordView: rows("SELECT campaign.id, ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group_criterion.final_urls, segments.date, segments.device, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM keyword_view WHERE segments.date BETWEEN '" + s + "' AND '" + e + "'"),
    searchTermView: rows("SELECT search_term_view.search_term, campaign.id, ad_group.id, segments.keyword.ad_group_criterion, segments.keyword.info.text, segments.keyword.info.match_type, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM search_term_view WHERE segments.date BETWEEN '" + s + "' AND '" + e + "'"),
    geographicView: rows("SELECT geographic_view.location_type, geographic_view.country_criterion_id, campaign.id, ad_group.id, segments.date, segments.geo_target_city, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM geographic_view WHERE segments.date BETWEEN '" + s + "' AND '" + e + "' AND geographic_view.location_type = 'LOCATION_OF_PRESENCE'"),
    clickView: [],
    geoConstants: [],
  };
  // click_view accepts one day per query.
  for (var t = start.getTime(); t <= end.getTime(); t += 86400000) {
    var d = fmtDate(new Date(t));
    results.clickView = results.clickView.concat(rows("SELECT click_view.gclid, click_view.keyword, click_view.keyword_info.text, click_view.keyword_info.match_type, click_view.location_of_presence.city, click_view.location_of_presence.most_specific, campaign.id, ad_group.id, segments.date, segments.device FROM click_view WHERE segments.date = '" + d + "'"));
  }
  var ids = {};
  results.geographicView.forEach(function (r) { var m = /geoTargetConstants\/(\d+)/.exec((r.segments || {}).geoTargetCity || ''); if (m) ids[m[1]] = true; });
  results.clickView.forEach(function (r) { var m = /geoTargetConstants\/(\d+)/.exec(((r.clickView || {}).locationOfPresence || {}).city || ''); if (m) ids[m[1]] = true; });
  var list = Object.keys(ids);
  for (var i = 0; i < list.length; i += 200) {
    results.geoConstants = results.geoConstants.concat(rows('SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.canonical_name, geo_target_constant.target_type FROM geo_target_constant WHERE geo_target_constant.id IN (' + list.slice(i, i + 200).join(', ') + ')'));
  }
  var adCopy = rows("SELECT ad_group.id, ad_group_ad.ad.id, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.final_urls FROM ad_group_ad WHERE ad_group_ad.status = 'ENABLED'").map(function (r) {
    var ad = (r.adGroupAd || {}).ad || {};
    return { id: String(ad.id || ''), adGroupId: String((r.adGroup || {}).id || ''), headlines: ((ad.responsiveSearchAd || {}).headlines || []).map(function (h) { return h.text; }), finalUrl: (ad.finalUrls || [])[0] || '' };
  });
  var payload = JSON.stringify({ kind: 'twin-ppc-gads/1', generatedAt: new Date().toISOString(), customerId: AdsApp.currentAccount().getCustomerId(), window: { start: s, end: e }, results: results, adCopy: adCopy });
  var folders = DriveApp.getFoldersByName(CONFIG.FOLDER_NAME);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(CONFIG.FOLDER_NAME);
  var files = folder.getFilesByName(CONFIG.FILE_NAME);
  if (files.hasNext()) files.next().setContent(payload);
  else folder.createFile(CONFIG.FILE_NAME, payload, MimeType.PLAIN_TEXT);
  Logger.log('Twin PPC: wrote ' + CONFIG.FILE_NAME + ' (' + results.keywordView.length + ' keyword rows, ' + results.clickView.length + ' clicks).');
}
