// =============================================================================
// KPI aggregation — the Daily KPI report + per-template performance table.
// Pure: takes the array of per-contact result rows, returns the report object.
// Mirrors the SOP's "Daily KPI Report" section exactly.
// =============================================================================
import { DISPOSITION, SENT_DISPOSITIONS, REPLY_CLASS } from '../automation/constants.js';

const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

export function buildKpi(results, { assigned = 0 } = {}) {
  const rows = results.filter(Boolean);

  const processed = rows.length;
  const optedIn = rows.filter((r) => r.L10_OptInStatus === 'opted_in').length;
  const sent = rows.filter((r) => SENT_DISPOSITIONS.includes(r.L10_Disposition)).length;
  const delivered = rows.filter((r) => r.delivery === 'delivered').length;
  const failed = rows.filter((r) => r.delivery === 'failed').length;

  const replies = rows.filter((r) => r.L10_ReplyClass && r.L10_ReplyClass !== REPLY_CLASS.NONE).length;
  const positive = rows.filter((r) => r.L10_ReplyClass === REPLY_CLASS.POSITIVE).length;
  const negative = rows.filter((r) => r.L10_ReplyClass === REPLY_CLASS.NEGATIVE).length;
  const unclear = rows.filter((r) => r.L10_ReplyClass === REPLY_CLASS.UNCLEAR).length;
  const optOuts = rows.filter((r) => r.L10_ReplyClass === REPLY_CLASS.OPT_OUT).length;

  // Disposition breakdown (all buckets).
  const byDisposition = {};
  for (const r of rows) byDisposition[r.L10_Disposition] = (byDisposition[r.L10_Disposition] || 0) + 1;

  // Per-template performance table.
  const templates = {};
  for (const r of rows) {
    if (!SENT_DISPOSITIONS.includes(r.L10_Disposition)) continue;
    const id = r.L10_TemplateId || '(none)';
    const t = (templates[id] = templates[id] || { id, sent: 0, delivered: 0, replies: 0, positive: 0, optOut: 0 });
    t.sent += 1;
    if (r.delivery === 'delivered') t.delivered += 1;
    if (r.L10_ReplyClass && r.L10_ReplyClass !== REPLY_CLASS.NONE) t.replies += 1;
    if (r.L10_ReplyClass === REPLY_CLASS.POSITIVE) t.positive += 1;
    if (r.L10_ReplyClass === REPLY_CLASS.OPT_OUT) t.optOut += 1;
  }
  const templateTable = Object.values(templates)
    .map((t) => ({
      ...t,
      deliveryRate: pct(t.delivered, t.sent),
      responseRate: pct(t.replies, t.sent),
      positiveRate: pct(t.positive, t.sent),
      optOutRate: pct(t.optOut, t.sent),
    }))
    .sort((a, b) => b.positiveRate - a.positiveRate || b.responseRate - a.responseRate);

  const bestTemplate = templateTable[0] ? templateTable[0].id : null;

  return {
    generatedAt: new Date().toISOString(),
    production: {
      assigned,
      processed,
      optedIn,
      smsSent: sent,
    },
    delivery: {
      delivered,
      failed,
      deliveryRate: pct(delivered, sent),
    },
    engagement: {
      replies,
      positive,
      negative,
      unclear,
      optOuts,
      responseRate: pct(replies, sent),
    },
    templatePerformance: templateTable,
    bestTemplate,
    byDisposition,
    dataIssues: countDataIssues(byDisposition),
  };
}

function countDataIssues(byDisposition) {
  const issueDispositions = [
    DISPOSITION.NEEDS_REVIEW,
    DISPOSITION.LEAD_NOT_FOUND,
    DISPOSITION.MISSING_TAG,
    DISPOSITION.INVALID_PHONE,
    DISPOSITION.MULTIPLE_PHONES,
    DISPOSITION.OPT_IN_FAILED,
    DISPOSITION.MISSING_PROFITDIAL,
    DISPOSITION.MULTIPLE_PROFITDIAL,
    DISPOSITION.PROFITDIAL_UNAVAILABLE,
    DISPOSITION.PROFITDIAL_MISMATCH,
    DISPOSITION.SHEET_CONFLICT,
    DISPOSITION.INVALID_MERGE_FIELD,
    DISPOSITION.TEMPLATE_BLOCKED,
    DISPOSITION.SEND_VERIFY_FAILED,
    DISPOSITION.ERROR,
  ];
  let total = 0;
  const breakdown = {};
  for (const d of issueDispositions) {
    if (byDisposition[d]) {
      breakdown[d] = byDisposition[d];
      total += byDisposition[d];
    }
  }
  return { total, breakdown };
}
