// The PPC decision engine: one recommendation per row (keyword + city,
// keyword, city, or search term) with the reason in plain words.
//
//   SCALE   good lead/deal results at an acceptable cost
//   WATCH   not enough data yet, or mixed results
//   REDUCE  weak results, or cost well above target
//   PAUSE   meaningful spend with nothing acceptable to show for it
//
// Every threshold is a setting. The engine never calls a row "profitable"
// unless every closed deal in it has profit recorded; otherwise it judges on
// the deepest funnel step that has data and says so.
import { formatInt, formatMoney, round, safeDiv } from './util.js';

export const DEFAULT_DECISION_SETTINGS = Object.freeze({
  targetCpl: 650,                // target cost per lead
  targetQualifiedCpl: 1500,      // target cost per qualified lead
  targetCostPerAppointment: 2500,
  targetCostPerContract: 10000,
  targetCostPerDeal: 15000,      // target cost per closed deal
  minClicks: 25,                 // minimum clicks before judging...
  minSpend: 500,                 // ...or minimum spend, whichever comes first
  minConversions: 3,             // qualified leads needed before SCALE on cost alone
  profitabilityThreshold: 1.5,   // profit per $1 of ad spend needed to SCALE on profit
  reduceMultiplier: 1.5,         // cost above target x this -> REDUCE (between -> WATCH)
  pauseSpendNoLeads: 800,        // spend with zero leads -> PAUSE
  pauseSpendNoQualified: 1200,   // spend with leads but zero qualified -> PAUSE
  outsideBuyBoxShare: 0.8,       // this share of spend outside the buy box -> PAUSE
  minSpendOutsideBuyBox: 100,    // ...once at least this much was spent there
});

export const RECOMMENDATIONS = ['SCALE', 'WATCH', 'REDUCE', 'PAUSE'];

/** Cost ratios for one row of summed numbers. Missing money stays null. */
export function computeMetrics(t) {
  const spend = t.spend || 0;
  return {
    ...t,
    ctr: safeDiv(t.clicks, t.impressions),
    cpc: safeDiv(spend, t.clicks),
    costPerLead: safeDiv(spend, t.leads),
    costPerQualified: safeDiv(spend, t.qualified),
    costPerAppointment: safeDiv(spend, t.appointments),
    costPerOffer: safeDiv(spend, t.offers),
    costPerContract: safeDiv(spend, t.contracts),
    costPerDeal: safeDiv(spend, t.deals),
    qualifiedRate: safeDiv(t.qualified, t.leads),
    leadRate: safeDiv(t.leads, t.clicks),
    // Profit is only "known" when every closed deal has a profit figure.
    profitKnown: t.deals > 0 && t.dealsWithProfit === t.deals,
    revenueKnown: t.deals > 0 && t.dealsWithRevenue === t.deals,
    profitPerDollar: t.deals > 0 && t.dealsWithProfit === t.deals ? safeDiv(t.profit, spend) : null,
  };
}

export function emptyTotals() {
  return {
    impressions: 0, clicks: 0, spend: 0, googleConversions: 0,
    leads: 0, qualified: 0, appointments: 0, offers: 0, contracts: 0, deals: 0, junk: 0,
    revenue: 0, profit: 0, dealsWithRevenue: 0, dealsWithProfit: 0,
    attrHigh: 0, attrMedium: 0, attrLow: 0, estimatedSpend: 0, outOfAreaSpend: 0,
  };
}

export function addTotals(a, b) {
  for (const k of Object.keys(emptyTotals())) a[k] = (a[k] || 0) + (b[k] || 0);
  return a;
}

const money = formatMoney;
const n = formatInt;
const plural = (count, one, many = `${one}s`) => `${n(count)} ${count === 1 ? one : many}`;

function baseFacts(m) {
  const facts = [
    { label: 'Spent', value: money(m.spend) },
    { label: 'Clicks', value: n(m.clicks) },
    { label: 'Leads', value: n(m.leads) },
    { label: 'Qualified leads', value: n(m.qualified) },
    { label: 'Appointments', value: n(m.appointments) },
    { label: 'Offers', value: n(m.offers) },
    { label: 'Contracts', value: n(m.contracts) },
    { label: 'Closed deals', value: n(m.deals) },
  ];
  if (m.deals > 0) {
    facts.push({ label: 'Revenue', value: m.revenueKnown ? money(m.revenue) : m.dealsWithRevenue ? `${money(m.revenue)} (${m.dealsWithRevenue} of ${m.deals} deals recorded)` : 'not recorded' });
    facts.push({ label: 'Profit', value: m.profitKnown ? money(m.profit) : m.dealsWithProfit ? `${money(m.profit)} (${m.dealsWithProfit} of ${m.deals} deals recorded)` : 'not recorded' });
  }
  return facts;
}

/**
 * The numbers behind a decision, in the order a person reads a funnel:
 *   "$1,420 spent, 31 clicks, 5 leads, 0 qualified leads, 0 contracts"
 *   "$950 spent, 8 qualified leads, 3 appointments, 1 contract"
 */
export function funnelLine(m) {
  const parts = [`${money(m.spend)} spent`];
  if (m.qualified > 0) {
    parts.push(plural(m.qualified, 'qualified lead'));
    if (m.appointments) parts.push(plural(m.appointments, 'appointment'));
    if (m.offers && !m.contracts) parts.push(plural(m.offers, 'offer'));
    parts.push(plural(m.contracts, 'contract'));
    if (m.deals) parts.push(plural(m.deals, 'closed deal'));
  } else {
    parts.push(plural(m.clicks, 'click'), plural(m.leads, 'lead'));
    if (m.leads > 0) parts.push('0 qualified leads', plural(m.contracts, 'contract'));
  }
  return parts.join(', ');
}

function confidenceFor(m, s) {
  const matched = m.attrHigh + m.attrMedium + m.attrLow;
  const highShare = matched ? m.attrHigh / matched : 0;
  const sample = m.qualified >= s.minConversions * 2 || m.deals >= 2 ? 2 : m.qualified >= s.minConversions || m.contracts > 0 ? 1 : 0;
  const score = sample + (highShare >= 0.7 ? 1 : 0);
  return score >= 3 ? 'high' : score >= 1 ? 'medium' : 'low';
}

/**
 * Decide for one row of totals (already passed through computeMetrics).
 * `headline` is a few words for a table cell; `reason` is the full WHY,
 * facts first, e.g. "$1,420 spent, 31 clicks, 5 leads, 0 qualified leads,
 * 0 contracts. Spending with no qualified leads."
 * @returns {{rec, basis, basisLabel, headline, reason, facts, confidence}}
 */
export function decide(m, settings = {}) {
  const s = { ...DEFAULT_DECISION_SETTINGS, ...settings };
  const facts = baseFacts(m);
  const line = funnelLine(m);
  const out = (rec, basis, basisLabel, headline, verdict) => ({
    rec, basis, basisLabel, headline, reason: `${line}. ${verdict}`, facts, confidence: confidenceFor(m, s),
  });

  if (m.unattributed) {
    return out('WATCH', 'attribution', 'Attribution', 'Keyword unknown',
      'These Google Ads leads could not be tied to a keyword or city (no GCLID or UTM match). Fix tracking before judging them.');
  }
  if (m.unknownCity && m.leads > 0) {
    return out('WATCH', 'attribution', 'Attribution', 'City unknown',
      'These leads could not be placed in a city (no click location), so they are not compared with city spend. They still count in the keyword and account totals.');
  }
  if (m.spend <= 0 && m.leads > 0) {
    return out('WATCH', 'attribution', 'Attribution', 'No matching spend',
      'Leads are recorded here but there is no ad spend for this keyword and city in the date range (the click may be older than the range).');
  }

  // 0) Outside the buy box: money spent where the team does not buy.
  const outsideShare = m.spend > 0 ? (m.outOfAreaSpend || 0) / m.spend : 0;
  if (outsideShare >= s.outsideBuyBoxShare && m.spend >= s.minSpendOutsideBuyBox) {
    if (m.deals > 0 && m.profitKnown && m.profit > m.spend) {
      return out('WATCH', 'buy_box', 'Buy box', 'Outside buy box, but profitable',
        `Outside your buy box, yet it produced ${plural(m.deals, 'profitable deal')}. Decide whether to add this area to the buy box.`);
    }
    return out('PAUSE', 'buy_box', 'Buy box', 'Outside buy box',
      `${Math.round(outsideShare * 100)}% of this spend came from cities marked outside your buy box in Settings.`);
  }

  // 1) Profit, only when every closed deal has profit recorded.
  if (m.deals > 0 && m.profitKnown && m.spend > 0) {
    const perDollar = m.profit / m.spend;
    const x = `$${round(perDollar, 2)}`;
    const profitLine = `${money(m.profit)} profit recorded`;
    if (perDollar >= s.profitabilityThreshold) {
      return out('SCALE', 'profit', 'Profit (recorded)', 'Profitable',
        `Profitable: ${profitLine}, ${x} per $1 of ad spend (target $${s.profitabilityThreshold}).`);
    }
    if (perDollar >= 1) {
      return out('WATCH', 'profit', 'Profit (recorded)', 'Thin profit',
        `Profitable but thin: ${profitLine}, ${x} per $1 of ad spend, below your $${s.profitabilityThreshold} target.`);
    }
    return out('REDUCE', 'profit', 'Profit (recorded)', 'Profit below spend',
      `${profitLine}, less than the ad spend (${x} per $1).`);
  }

  // 2) Enough data to judge at all? A contract or closed deal is always enough:
  //    the sample-size rule exists to stop early noise, not to hide a real deal.
  const judged = m.spend >= s.minSpend || m.clicks >= s.minClicks || m.contracts > 0 || m.deals > 0;
  if (!judged) {
    return out('WATCH', 'sample', 'Not enough data', 'Not enough data',
      `Not enough data yet. Judged after ${money(s.minSpend)} spent or ${n(s.minClicks)} clicks.`);
  }

  // 3) Deepest funnel step with data (no profit data yet).
  const ladder = [
    { count: m.deals, cost: m.costPerDeal, target: s.targetCostPerDeal, key: 'deal', noun: 'closed deal', label: 'Cost per closed deal' },
    { count: m.contracts, cost: m.costPerContract, target: s.targetCostPerContract, key: 'contract', noun: 'contract', label: 'Cost per contract' },
    { count: m.appointments, cost: m.costPerAppointment, target: s.targetCostPerAppointment, key: 'appointment', noun: 'appointment', label: 'Cost per appointment' },
    { count: m.qualified, cost: m.costPerQualified, target: s.targetQualifiedCpl, key: 'qualified', noun: 'qualified lead', label: 'Cost per qualified lead' },
  ];
  const step = ladder.find((x) => x.count > 0);
  if (step) {
    const cost = `${money(step.cost)} per ${step.noun} (target ${money(step.target)})`;
    const note = m.deals > 0
      ? (m.dealsWithProfit ? ' Profit is recorded for only some deals, so this is acquisition cost, not profit.' : ' No profit recorded for these deals yet, so this is acquisition cost, not profit.')
      : ' No revenue or profit recorded yet.';
    const strongSample = m.qualified >= s.minConversions || m.contracts > 0 || m.deals > 0;
    if (step.cost <= step.target && strongSample) {
      return out('SCALE', step.key, step.label, 'Within target',
        `Estimated acquisition cost within target: ${cost}.${note}`);
    }
    if (step.cost <= step.target) {
      return out('WATCH', step.key, step.label, 'Promising, small sample',
        `Promising: ${cost}, but only ${plural(m.qualified, 'qualified lead')} so far; needs ${n(s.minConversions)}.`);
    }
    if (step.cost <= step.target * s.reduceMultiplier) {
      return out('WATCH', step.key, step.label, 'Above target',
        `Mixed: ${cost}, above target but within ${s.reduceMultiplier}×.`);
    }
    return out('REDUCE', step.key, step.label, `${round(step.cost / step.target, 1)}× target`,
      `Too expensive: ${cost}, ${round(step.cost / step.target, 1)}× the target.`);
  }

  // 4) Leads, but none qualified.
  if (m.leads > 0) {
    if (m.spend >= s.pauseSpendNoQualified) {
      return out('PAUSE', 'qualified', 'Qualified leads', 'No qualified leads',
        `Spending with no qualified leads (pause point ${money(s.pauseSpendNoQualified)}).`);
    }
    if (m.leads >= s.minConversions) {
      return out('REDUCE', 'qualified', 'Qualified leads', 'Leads not qualifying',
        `${plural(m.leads, 'lead')} so far and none qualified.`);
    }
    return out('WATCH', 'qualified', 'Qualified leads', 'None qualified yet', 'Leads are coming in; none qualified yet.');
  }

  // 5) No leads at all.
  if (m.spend >= s.pauseSpendNoLeads) {
    return out('PAUSE', 'leads', 'Leads', 'No leads', `Spending with no leads (pause point ${money(s.pauseSpendNoLeads)}).`);
  }
  if (m.spend >= s.targetCpl) {
    return out('REDUCE', 'leads', 'Leads', 'No leads yet', `Already spent more than your ${money(s.targetCpl)} target cost per lead with no leads.`);
  }
  return out('WATCH', 'leads', 'Leads', 'No leads yet', 'No leads yet, still under your target cost per lead.');
}

/** Order used when sorting rows by recommendation. */
export const REC_ORDER = { PAUSE: 0, REDUCE: 1, WATCH: 2, SCALE: 3 };
