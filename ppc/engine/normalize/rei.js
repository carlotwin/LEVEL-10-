// REI BlackBook leads (CSV/XLSX export, Google Sheet, or the crawler) -> one
// normalized lead shape.
//
// PRIVACY: names are dropped, and phone / email / street address are replaced
// by salted SHA-256 hashes before anything is stored in shared data. The hashes
// are enough to match calls and de-duplicate leads. City, state and ZIP are
// kept because the dashboard analyzes by city.
//
// FUNNEL: stages are cumulative. A lead under contract also counts as having
// had an appointment and as qualified, even if REI never recorded those steps,
// because it could not reach contract without them.
import { mapColumns } from '../csv.js';
import { normalizeCity, normalizeState } from '../geo.js';
import { classifySituation, DEFAULT_SITUATIONS } from '../situations.js';
import {
  fnv1a, normalizeEmail, normalizePhone, normText, scrubText, sha256Hex, toBool, toDate, toInt, toNumber, toTimestamp,
} from '../util.js';

export const REI_COLUMNS = {
  id: ['Lead ID', 'Contact ID', 'REI ID', 'Record ID', 'ID', 'Id'],
  name: ['Seller Name', 'Full Name', 'Name', 'Owner Name', 'Contact Name', 'Primary Name'],
  firstName: ['First Name', 'FIrst Name', 'Firstname'],
  lastName: ['Last Name', 'Lastname', 'Surname'],
  phone: ['Phone', 'Phone Number', 'Phone (Mobile)', 'Mobile', 'Cell', 'Primary Phone', 'Phone 1'],
  email: ['Email', 'Email Address', 'E-mail'],
  address: ['Property Address', 'Address', 'Street Address', 'Street', 'Full Address'],
  city: ['City', 'Property City'],
  state: ['State', 'Property State'],
  zip: ['ZIP', 'Zip', 'Zip Code', 'Postal Code', 'Property Zip'],
  leadSource: ['Lead Source', 'Source', 'Marketing Source', 'Lead Channel', 'Channel', 'How Did You Hear'],
  sourceCampaign: ['Source Campaign', 'Campaign', 'Marketing Campaign', 'Lead Campaign'],
  gclid: ['GCLID', 'Google Click ID', 'gclid'],
  utmSource: ['utm_source', 'UTM Source'],
  utmMedium: ['utm_medium', 'UTM Medium'],
  utmCampaign: ['utm_campaign', 'UTM Campaign'],
  utmTerm: ['utm_term', 'UTM Term', 'Keyword'],
  utmContent: ['utm_content', 'UTM Content'],
  landingPage: ['Landing Page', 'Page URL', 'Form URL', 'Source URL'],
  situation: ['Seller Situation', 'Motivation', 'Seller Motivation', 'Situation', 'Reason for Selling', 'Reason For Selling'],
  tags: ['Tags', 'Tag'],
  notes: ['Notes', 'Note', 'Comments'],
  status: ['Lead Status', 'Status', 'Stage', 'Pipeline Stage', 'Deal Stage', 'Disposition'],
  qualified: ['Qualified', 'Is Qualified', 'Qualification', 'Lead Quality'],
  score: ['Lead Score', 'Score', 'Rating'],
  appointmentAt: ['Appointment Date', 'Appointment', 'Appt Date', 'Walkthrough Date'],
  offerAt: ['Offer Date', 'Offer Made Date', 'Offer Sent'],
  offerAmount: ['Offer Amount'],
  contractAt: ['Contract Date', 'Under Contract Date', 'Contract Signed'],
  contractStatus: ['Contract Status'],
  closedAt: ['Closed Date', 'Close Date', 'Closing Date', 'Purchase Date'],
  lostAt: ['Lost Date', 'Dead Date'],
  lostReason: ['Lost Reason', 'Dead Reason', 'Reason Lost', 'Disqualification Reason'],
  revenue: ['Deal Revenue', 'Revenue', 'Gross Revenue', 'Assignment Fee'],
  profit: ['Profit', 'Net Profit', 'Deal Profit', 'Gross Profit'],
  createdAt: ['Created Date', 'Created', 'Date Created', 'Created At', 'Lead Date', 'Date Added'],
  updatedAt: ['Updated Date', 'Last Updated', 'Updated', 'Modified', 'Updated At', 'Last Activity'],
};

// Default status words -> funnel stage. Admins extend this in Settings with the
// exact status names their REI account uses.
export const DEFAULT_STATUS_RULES = Object.freeze([
  { stage: 'closed', words: ['closed', 'purchased', 'bought', 'won', 'funded', 'acquired', 'deal closed'] },
  { stage: 'contract', words: ['under contract', 'contract', 'in escrow', 'escrow', 'signed'] },
  { stage: 'offer', words: ['offer made', 'offer sent', 'offer', 'negotiating', 'negotiation', 'counter'] },
  { stage: 'appointment', words: ['appointment', 'appt', 'walkthrough', 'walk-through', 'site visit', 'inspection'] },
  { stage: 'qualified', words: ['qualified', 'hot', 'warm', 'motivated', 'interested'] },
  { stage: 'lost', words: ['dead', 'lost', 'not interested', 'unqualified', 'junk', 'spam', 'wrong number', 'do not call', 'dnc',
    'wholesaler', 'realtor', 'out of area', 'not the owner', 'duplicate', 'bad number', 'disconnected', 'sold elsewhere', 'listed with agent', 'no longer',
    'cancelled', 'canceled', 'fell through', 'terminated'] },
  { stage: 'contacted', words: ['contacted', 'attempted', 'voicemail', 'no answer', 'follow up', 'follow-up', 'nurture', 'callback', 'cold'] },
  { stage: 'new', words: ['new', 'new lead', 'new inquiry', 'fresh lead', 'unworked', 'not contacted'] },
]);

// Lost reasons that mean the lead was never a real seller opportunity.
export const JUNK_REASONS = Object.freeze([
  { code: 'spam', label: 'Spam / robot', words: ['spam', 'robot', 'bot', 'test'] },
  { code: 'wrong_number', label: 'Wrong number', words: ['wrong number', 'bad number', 'disconnected', 'invalid number'] },
  { code: 'sales_call', label: 'Sales caller / telemarketer', words: ['telemarketer', 'sales call', 'solicitor', 'vendor'] },
  { code: 'wholesaler', label: 'Wholesaler', words: ['wholesaler', 'investor'] },
  { code: 'realtor', label: 'Realtor / agent', words: ['realtor', 'agent', 'broker'] },
  { code: 'out_of_area', label: 'Out of area', words: ['out of area', 'outside area', 'out of market'] },
  { code: 'not_owner', label: 'Not the owner', words: ['not the owner', 'not owner', 'renter'] },
  { code: 'duplicate', label: 'Duplicate', words: ['duplicate', 'dupe'] },
]);

export const STAGE_ORDER = ['new', 'contacted', 'qualified', 'appointment', 'offer', 'contract', 'closed'];

export function stageFromStatus(status, rules = DEFAULT_STATUS_RULES) {
  const s = normText(status);
  if (!s) return null;
  // 1) exact status names win
  for (const r of rules) {
    if (r.words.some((w) => s === normText(w))) return r.stage;
  }
  // 2) partial matches, negative stages first: "Not interested" contains
  //    "interested" and "Unqualified" contains "qualified", and both are lost.
  const ordered = [...rules.filter((r) => r.stage === 'lost'), ...rules.filter((r) => r.stage !== 'lost')];
  for (const r of ordered) {
    if (r.words.some((w) => w.length > 3 && s.includes(normText(w)))) return r.stage;
  }
  return null;
}

export function junkReason(text) {
  const s = normText(text);
  if (!s) return null;
  for (const r of JUNK_REASONS) if (r.words.some((w) => s.includes(w))) return r.code;
  return null;
}

/**
 * Normalize REI rows (header -> value objects).
 * @param rows      array of objects from a CSV/XLSX sheet or the crawler
 * @param options   { mapping (field->header overrides), statusRules, situations,
 *                    qualifiedScoreMin, sourceSystem, now }
 * @returns {Promise<{leads, mapping, missing, unused, warnings, unmappedStatuses}>}
 */
export async function normalizeReiRows(rows, options = {}) {
  const {
    mapping: overrides = {}, statusRules = DEFAULT_STATUS_RULES, situations = DEFAULT_SITUATIONS,
    qualifiedScoreMin = 7, sourceSystem = 'rei_csv',
  } = options;
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const { mapping, missing, unused } = mapColumns(headers, REI_COLUMNS, overrides);
  const warnings = [];
  const unmappedStatuses = new Map();
  const leads = [];
  const get = (row, field) => (mapping[field] ? row[mapping[field]] : undefined);

  for (const row of rows) {
    const phone = normalizePhone(get(row, 'phone'));
    const email = normalizeEmail(get(row, 'email'));
    const address = normText(get(row, 'address'));
    const createdAt = toTimestamp(get(row, 'createdAt'));
    let id = String(get(row, 'id') ?? '').trim();
    if (!id) {
      if (!phone && !email && !address) continue; // nothing to identify the row by
      id = `rei_${fnv1a(`${phone}|${email}|${address}|${createdAt || ''}`)}`;
    }
    const statusRaw = String(get(row, 'status') ?? '').trim();
    const lostReasonRaw = String(get(row, 'lostReason') ?? '').trim();
    const appointmentAt = toDate(get(row, 'appointmentAt'));
    const offerAt = toDate(get(row, 'offerAt'));
    const contractAt = toDate(get(row, 'contractAt'));
    const closedAt = toDate(get(row, 'closedAt'));
    const lostAt = toDate(get(row, 'lostAt'));
    const contractStatus = normText(get(row, 'contractStatus'));

    let statusStage = stageFromStatus(statusRaw, statusRules);
    if (statusRaw && !statusStage) unmappedStatuses.set(statusRaw, (unmappedStatuses.get(statusRaw) || 0) + 1);
    if (/cancel|terminated|fell through/.test(contractStatus)) statusStage = statusStage === 'closed' ? 'closed' : 'lost';

    const reached = new Set();
    if (closedAt || statusStage === 'closed') reached.add('closed');
    if (contractAt || statusStage === 'contract' || /signed|active|pending|open/.test(contractStatus)) reached.add('contract');
    if (offerAt || statusStage === 'offer') reached.add('offer');
    if (appointmentAt || statusStage === 'appointment') reached.add('appointment');
    const explicitQualified = toBool(get(row, 'qualified'));
    const qualText = normText(get(row, 'qualified'));
    const score = toInt(get(row, 'score'));
    if (statusStage === 'qualified' || explicitQualified === true || /^(qualified|hot|warm|a|b)$/.test(qualText)) reached.add('qualified');

    // Cumulative funnel.
    const idx = Math.max(-1, ...[...reached].map((s) => STAGE_ORDER.indexOf(s)));
    const has = (stage) => idx >= STAGE_ORDER.indexOf(stage);
    let qualified = has('qualified');
    if (!qualified && explicitQualified == null && !qualText && score != null && score >= qualifiedScoreMin && statusStage !== 'lost') qualified = true;

    const junk = junkReason(lostReasonRaw) || (statusStage === 'lost' ? junkReason(statusRaw) : null);
    const lost = !has('closed') && (statusStage === 'lost' || !!lostReasonRaw || !!lostAt);
    if (junk && !has('appointment')) qualified = false;

    // Notes help classify the seller situation but are never stored: only the
    // motivation/tags text is kept, scrubbed of phones, emails and addresses.
    const situationText = [get(row, 'situation'), get(row, 'tags')].filter(Boolean).join(' · ');
    const classifyText = [situationText, get(row, 'notes')].filter(Boolean).join(' · ');
    const city = normalizeCity(get(row, 'city'));
    const stateRaw = get(row, 'state');
    const lead = {
      id,
      sourceSystem,
      createdAt,
      createdDate: createdAt ? createdAt.slice(0, 10) : null,
      updatedAt: toTimestamp(get(row, 'updatedAt')),
      city,
      st: stateRaw ? normalizeState(stateRaw) : city ? 'CA' : '',
      zip: String(get(row, 'zip') ?? '').replace(/[^\d-]/g, '').slice(0, 10),
      source: String(get(row, 'leadSource') ?? '').trim(),
      sourceCampaign: String(get(row, 'sourceCampaign') ?? '').trim(),
      gclid: String(get(row, 'gclid') ?? '').trim(),
      utm: {
        source: String(get(row, 'utmSource') ?? '').trim(),
        medium: String(get(row, 'utmMedium') ?? '').trim(),
        campaign: String(get(row, 'utmCampaign') ?? '').trim(),
        term: String(get(row, 'utmTerm') ?? '').trim(),
        content: String(get(row, 'utmContent') ?? '').trim(),
      },
      landingPage: String(get(row, 'landingPage') ?? '').trim(),
      situationRaw: scrubText(situationText, 120),
      situation: classifySituation(classifyText, situations),
      statusRaw,
      stage: lost && !has('appointment') ? 'lost' : idx >= 0 ? STAGE_ORDER[idx] : statusStage || 'new',
      qualified,
      appointment: has('appointment'),
      offer: has('offer'),
      contract: has('contract') && !/cancel|terminated|fell through/.test(contractStatus),
      closed: has('closed'),
      lost,
      junk: junk || null,
      lostReason: scrubText(lostReasonRaw, 80),
      appointmentAt, offerAt, contractAt, closedAt,
      score,
      revenue: toNumber(get(row, 'revenue')),
      profit: toNumber(get(row, 'profit')),
      offerAmount: toNumber(get(row, 'offerAmount')),
      phoneHash: phone ? await sha256Hex(phone) : '',
      emailHash: email ? await sha256Hex(email) : '',
      addressHash: address ? await sha256Hex(`${address}|${normText(city)}`) : '',
    };
    leads.push(lead);
  }
  if (!mapping.id) warnings.push('No lead ID column: ids were built from phone/email/address, so an edited phone creates a new lead.');
  if (!mapping.createdAt) warnings.push('No created-date column: leads cannot be placed in date ranges.');
  if (!mapping.gclid && !mapping.utmSource) warnings.push('No GCLID or UTM columns: these leads can only be matched to Google Ads by lead source text or calls.');
  if (!mapping.status && !mapping.qualified) warnings.push('No status or qualification column: lead quality is unknown.');
  if (unmappedStatuses.size) {
    warnings.push(`Status values not mapped to a stage: ${[...unmappedStatuses.keys()].slice(0, 8).join(', ')}. Map them in Settings.`);
  }
  return { leads, mapping, missing, unused, warnings, unmappedStatuses: Object.fromEntries(unmappedStatuses) };
}

/**
 * Mark duplicates: leads sharing a phone hash, email hash or address hash
 * within `windowDays` of the first one. The earliest stays primary; later ones
 * get `duplicateOf`. Returns the number of duplicates found.
 */
export function markDuplicates(leads, windowDays = 60) {
  const sorted = [...leads].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  const seen = new Map(); // hash -> {id, createdAt}
  let count = 0;
  for (const lead of sorted) {
    lead.duplicateOf = null;
    const keys = [lead.phoneHash && `p:${lead.phoneHash}`, lead.emailHash && `e:${lead.emailHash}`, lead.addressHash && `a:${lead.addressHash}`].filter(Boolean);
    let primary = null;
    for (const k of keys) {
      const first = seen.get(k);
      if (first && first.id !== lead.id) {
        const gap = lead.createdAt && first.createdAt ? (Date.parse(lead.createdAt) - Date.parse(first.createdAt)) / 86400000 : 0;
        if (gap <= windowDays) {
          primary = first;
          break;
        }
      }
    }
    if (primary) {
      lead.duplicateOf = primary.id;
      count += 1;
    } else {
      for (const k of keys) seen.set(k, { id: lead.id, createdAt: lead.createdAt });
    }
  }
  return count;
}
