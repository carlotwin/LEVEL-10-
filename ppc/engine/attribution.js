// Lead attribution: connect REI leads to Google Ads traffic using only the
// evidence that exists. Nothing is guessed: a keyword or city is set only when
// an identifier ties the lead to it. Leads with no evidence are "unknown".
//
// Evidence, strongest first:
//   high    GCLID on the lead (or on its call) found in Google Ads click data
//   medium  GCLID on the lead but no click record (older than 90 days, or
//           click data not loaded) | UTM tags saying google/cpc | a call from a
//           tracking number mapped to Google Ads, or a call-tracking row
//           labelled Google Ads, matched to the lead by phone within N days
//   low     REI "lead source" text says Google Ads / PPC, nothing else
//   none    no evidence -> channel 'unknown' (or 'other' when the lead source
//           names another channel such as direct mail)
import { normText } from './util.js';

export const DEFAULT_ATTRIBUTION_SETTINGS = Object.freeze({
  ppcSourcePatterns: ['google ads', 'adwords', 'ppc', 'paid search', 'google cpc', 'google paid', 'sem', 'google - paid', 'google ad'],
  otherSourcePatterns: ['direct mail', 'postcard', 'mailer', 'letter', 'sms', 'text blast', 'cold call', 'cold calling', 'referral',
    'organic', 'seo', 'facebook', 'instagram', 'driving for dollars', 'd4d', 'bandit', 'list', 'probate list', 'zillow', 'craigslist', 'walk in', 'radio', 'tv'],
  callMatchWindowDays: 3,
  trackingNumbers: [], // [{number: '4155550100', channel: 'google_ads' | 'other', label}]
});

const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1, none: 0 };

function matchesAny(text, patterns) {
  const t = normText(text);
  if (!t) return false;
  return patterns.some((p) => {
    const q = normText(p);
    if (!q) return false;
    if (q.length <= 4) return new RegExp(`(^|[^a-z0-9])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(t);
    return t.includes(q);
  });
}

export function isPpcUtm(utm = {}) {
  const src = normText(utm.source);
  const med = normText(utm.medium);
  return (/google|adwords/.test(src) || src === '') && /^(cpc|ppc|paid|paidsearch|paid search|sem)$/.test(med) && !!(src || med);
}

/**
 * @param {object} p
 * @param {Array} p.leads    normalized leads
 * @param {object} p.ads     normalized ads {clicks, keywords, campaigns, geoConstants}
 * @param {Array} [p.calls]  normalized calls
 * @param {object} [p.settings] attribution settings (see defaults)
 * @returns {Map<string, object>} leadId -> attribution
 */
export function attributeLeads({ leads = [], ads = {}, calls = [], settings = {} }) {
  const s = { ...DEFAULT_ATTRIBUTION_SETTINGS, ...settings };
  const clicksByGclid = new Map((ads.clicks || []).filter((c) => c.gclid).map((c) => [c.gclid, c]));
  const keywordsById = new Map((ads.keywords || []).map((k) => [k.id, k]));
  const campaigns = ads.campaigns || [];
  const trackedNumbers = new Map((s.trackingNumbers || []).map((t) => [String(t.number).replace(/\D/g, '').slice(-10), t]));
  const callsByPhone = new Map();
  for (const c of calls) {
    if (!c.phoneHash) continue;
    const list = callsByPhone.get(c.phoneHash) || [];
    list.push(c);
    callsByPhone.set(c.phoneHash, list);
  }
  // keyword text -> keywords, for UTM terms
  const keywordsByText = new Map();
  for (const k of ads.keywords || []) {
    const t = normText(k.text);
    const list = keywordsByText.get(t) || [];
    list.push(k);
    keywordsByText.set(t, list);
  }
  const campaignByName = new Map(campaigns.map((c) => [normText(c.name), c]));
  const campaignById = new Map(campaigns.map((c) => [String(c.id), c]));
  const geoName = (id) => {
    const g = ads.geoConstants?.[String(id)];
    if (!g) return null;
    const parts = String(g.canonicalName || g.name || '').split(',');
    return { city: (parts[0] || g.name || '').trim(), st: /california/i.test(parts[1] || '') ? 'CA' : '' };
  };

  const fromClick = (click, method, evidence) => {
    const kw = keywordsById.get(click.k);
    return {
      channel: 'ppc', method, confidence: 'high',
      keywordId: click.k || null, keywordText: kw ? normText(kw.text) : null,
      campaignId: click.c || kw?.campaignId || null, adGroupId: click.g || kw?.adGroupId || null,
      city: click.city || '', st: click.st || '', date: click.d || null, device: click.dev || null, gclid: click.gclid, evidence,
    };
  };

  const out = new Map();
  for (const lead of leads) {
    const evidence = [];
    let result = null;

    // 1) GCLID on the lead
    if (lead.gclid) {
      const click = clicksByGclid.get(lead.gclid);
      if (click) {
        result = fromClick(click, 'gclid', [`GCLID on the lead matches a Google Ads click on ${click.d}.`]);
      } else {
        evidence.push('GCLID on the lead, but no matching click in the loaded Google Ads data (older than 90 days, or clicks not synced).');
      }
    }

    // 2) Calls matched by phone within the window
    if (!result && lead.phoneHash && callsByPhone.has(lead.phoneHash)) {
      const leadTime = lead.createdAt ? Date.parse(lead.createdAt) : null;
      const windowMs = s.callMatchWindowDays * 86400000;
      const candidates = callsByPhone.get(lead.phoneHash).filter((c) => !leadTime || !c.at || Math.abs(Date.parse(c.at) - leadTime) <= windowMs);
      for (const call of candidates) {
        if (call.gclid && clicksByGclid.has(call.gclid)) {
          result = fromClick(clicksByGclid.get(call.gclid), 'call_gclid', ['A call from the lead\'s phone carried a GCLID that matches a Google Ads click.']);
          break;
        }
        const tracked = call.trackingNumber ? trackedNumbers.get(call.trackingNumber) : null;
        const callIsPpc = tracked ? tracked.channel === 'google_ads' : matchesAny(call.source, s.ppcSourcePatterns);
        if (callIsPpc) {
          const kwList = call.keyword ? keywordsByText.get(normText(call.keyword)) || [] : [];
          const kw = kwList.length === 1 ? kwList[0] : null;
          result = {
            channel: 'ppc', method: 'call_tracking', confidence: 'medium',
            keywordId: kw?.id || null, keywordText: call.keyword ? normText(call.keyword) : null,
            campaignId: kw?.campaignId || (tracked?.campaignId ?? null), adGroupId: kw?.adGroupId || null,
            city: call.city || '', st: call.st || '', date: call.d || lead.createdDate, gclid: null,
            evidence: [
              tracked ? `A call from the lead's phone came in on a tracking number labelled "${tracked.label || 'Google Ads'}".`
                : `A call from the lead's phone came from source "${call.source}".`,
              ...(kwList.length > 1 ? [`Call keyword "${call.keyword}" matches ${kwList.length} keywords, so no single keyword is assigned.`] : []),
            ],
          };
          break;
        }
      }
    }

    // 3) UTM tags
    if (!result && isPpcUtm(lead.utm)) {
      const campaign = campaignByName.get(normText(lead.utm.campaign)) || campaignById.get(String(lead.utm.campaign)) || null;
      const term = normText(lead.utm.term);
      let kwList = term ? keywordsByText.get(term) || [] : [];
      if (campaign) kwList = kwList.filter((k) => k.campaignId === campaign.id);
      const campaignsWithTerm = [...new Set(kwList.map((k) => k.campaignId))];
      const loc = lead.utm.loc ? geoName(lead.utm.loc) : null;
      result = {
        channel: 'ppc', method: 'utm', confidence: 'medium',
        keywordId: kwList.length === 1 ? kwList[0].id : null,
        keywordText: term || null,
        campaignId: campaign?.id || (campaignsWithTerm.length === 1 ? campaignsWithTerm[0] : null),
        adGroupId: kwList.length === 1 ? kwList[0].adGroupId : null,
        city: loc?.city || '', st: loc?.st || '', date: lead.createdDate, gclid: lead.gclid || null,
        evidence: [
          ...evidence,
          `UTM tags say ${lead.utm.source || '(no source)'} / ${lead.utm.medium}${lead.utm.campaign ? `, campaign "${lead.utm.campaign}"` : ''}${term ? `, keyword "${lead.utm.term}"` : ''}.`,
          ...(term && !kwList.length ? ['The UTM keyword does not match any keyword in the Google Ads data.'] : []),
          ...(loc ? [] : ['No location in the UTM tags, so the ad city is unknown.']),
        ],
      };
    }

    // 4) GCLID present but no click: still Google Ads, keyword/city unknown
    if (!result && lead.gclid) {
      result = {
        channel: 'ppc', method: 'gclid_unmatched', confidence: 'medium', keywordId: null, keywordText: null,
        campaignId: null, adGroupId: null, city: '', st: '', date: lead.createdDate, gclid: lead.gclid, evidence,
      };
    }

    // 5) Lead source text only
    if (!result && matchesAny(lead.source, s.ppcSourcePatterns)) {
      result = {
        channel: 'ppc', method: 'source_label', confidence: 'low', keywordId: null, keywordText: null,
        campaignId: null, adGroupId: null, city: '', st: '', date: lead.createdDate, gclid: null,
        evidence: [...evidence, `REI lead source says "${lead.source}", but there is no GCLID, UTM or call record to show which keyword or city.`],
      };
    }

    if (!result) {
      const other = matchesAny(lead.source, s.otherSourcePatterns);
      result = {
        channel: other ? 'other' : 'unknown', method: 'none', confidence: 'none', keywordId: null, keywordText: null,
        campaignId: null, adGroupId: null, city: '', st: '', date: lead.createdDate, gclid: null,
        evidence: [...evidence, other ? `Lead source "${lead.source}" is another channel.` : 'No GCLID, UTM, call or source information ties this lead to any channel.'],
      };
    }
    if (!result.date) result.date = lead.createdDate;
    out.set(lead.id, result);
  }
  return out;
}

export function confidenceRank(c) {
  return CONFIDENCE_RANK[c] ?? 0;
}

export const METHOD_LABELS = Object.freeze({
  gclid: 'GCLID matched a click',
  call_gclid: 'Call GCLID matched a click',
  call_tracking: 'Call tracking',
  utm: 'UTM tags',
  gclid_unmatched: 'GCLID (click not found)',
  source_label: 'Lead source text only',
  none: 'Unknown / Unmatched',
});
