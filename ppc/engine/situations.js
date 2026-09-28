// Seller situations: one normalized category per lead, derived from whatever
// REI recorded (motivation field, tags, notes). The list and its patterns are
// defaults; admins edit them in Settings and the edited list is passed in.
//
// Patterns are plain lowercase phrases matched as substrings. They are chosen
// to avoid everyday words that would mis-file a lead ("real estate" is not an
// inherited estate; "good condition" is not a repair job).
import { normText } from './util.js';

export const DEFAULT_SITUATIONS = Object.freeze([
  {
    code: 'inherited_probate', label: 'Inherited / Probate',
    patterns: ['inherit', 'probate', 'estate sale', 'the estate', 'estate of', 'passed away', 'deceased', 'heir', 'executor', 'trust sale'],
  },
  {
    code: 'divorce', label: 'Divorce',
    patterns: ['divorce', 'separation', 'separated', 'split up'],
  },
  {
    code: 'financial_pressure', label: 'Financial Pressure',
    patterns: ['behind on', 'back taxes', 'tax delinquent', 'delinquent tax', 'tax lien', 'foreclos', 'default notice', 'notice of default',
      'debt', 'financial', 'bankrupt', 'lost job', 'lost my job', 'laid off', 'layoff', 'job loss', 'medical bills', 'late payment', 'cant afford', "can't afford"],
  },
  {
    code: 'tired_landlord', label: 'Tired Landlord / Tenant Problems',
    patterns: ['landlord', 'tenant', 'rental property', 'evict', 'renters', 'section 8'],
  },
  {
    code: 'failed_listing', label: 'Failed Listing',
    patterns: ['expired listing', 'listing expired', "didn't sell", 'did not sell', 'failed escrow', 'escrow fell', 'fell out of escrow', 'withdrawn listing', 'failed listing'],
  },
  {
    code: 'code_title', label: 'Code / Permit / Title Problem',
    patterns: ['code violation', 'violation', 'unpermitted', 'permit', 'title issue', 'title problem', 'lien', 'red tag', 'condemned'],
  },
  {
    code: 'major_repairs', label: 'Major Repairs',
    patterns: ['repair', 'as is', 'as-is', 'fixer', 'needs work', 'fire damage', 'water damage', 'mold', 'foundation', 'roof leak', 'bad roof',
      'hoarder', 'poor condition', 'bad condition', 'rundown', 'run down', 'termite'],
  },
  {
    code: 'vacant', label: 'Vacant Property',
    patterns: ['vacant', 'empty house', 'unoccupied', 'abandoned', 'sitting empty'],
  },
  {
    code: 'relocation', label: 'Relocation',
    patterns: ['relocat', 'moving out of', 'moving to', 'moving away', 'job transfer', 'out of state', 'move away'],
  },
  {
    code: 'sell_fast', label: 'Sell Fast / Urgent Timeline',
    patterns: ['sell fast', 'quick sale', 'asap', 'urgent', 'fast close', 'close quickly', 'need to sell quickly', 'short timeline'],
  },
  { code: 'other', label: 'Other', patterns: [] },
  { code: 'unknown', label: 'Unknown', patterns: [] },
]);

/**
 * Pick one situation for free text. The first category (in list order) with a
 * matching pattern wins, so the list runs from most to least specific.
 * Empty text -> 'unknown'; text that matches nothing -> 'other'.
 */
export function classifySituation(text, situations = DEFAULT_SITUATIONS) {
  const t = normText(text);
  if (!t) return 'unknown';
  for (const s of situations) {
    if (s.code === 'other' || s.code === 'unknown') continue;
    if ((s.patterns || []).some((p) => matchesAtWordStart(t, normText(p)))) return s.code;
  }
  return 'other';
}

/**
 * True when `pattern` occurs in `text` starting at a word boundary. The end
 * is left open so 'inherit' also matches 'inherited'. Starting at a boundary
 * is what stops 'heir' matching 'their' and 'as is' matching 'has issues'.
 */
export function matchesAtWordStart(text, pattern) {
  if (!pattern) return false;
  let i = text.indexOf(pattern);
  while (i !== -1) {
    if (i === 0 || !/[a-z0-9]/.test(text[i - 1])) return true;
    i = text.indexOf(pattern, i + 1);
  }
  return false;
}

/** Like classifySituation but returns null (not 'other') when nothing matches. */
export function detectSituation(text, situations = DEFAULT_SITUATIONS) {
  const code = classifySituation(text, situations);
  return code === 'other' || code === 'unknown' ? null : code;
}

export function situationLabel(code, situations = DEFAULT_SITUATIONS) {
  if (code === 'general') return 'General seller (no specific situation)';
  return situations.find((s) => s.code === code)?.label || 'Unknown';
}

/**
 * Intent of a search keyword or page text: a specific situation when the words
 * name one ("sell inherited house" -> inherited_probate), otherwise 'general'
 * (a generic "we buy houses" / "sell my house fast" search).
 */
export function intentOf(text, situations = DEFAULT_SITUATIONS) {
  return detectSituation(text, situations) || 'general';
}
