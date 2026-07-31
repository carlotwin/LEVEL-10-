// =============================================================================
// Campaign constants — dispositions, tags, blocking phrases, regexes.
// No logic here; just the vocabulary the pure rules speak in.
// =============================================================================

// Final outcome labels for a contact. Every processed row ends as exactly one.
export const DISPOSITION = Object.freeze({
  TEXT_SENT: 'Text Sent',
  SIMULATED_SENT: 'Simulated Sent', // sandbox: would have sent
  ALREADY_PROCESSED: 'Already Processed', // duplicate ledger hit
  NEEDS_REVIEW: 'Needs Review',
  LEAD_NOT_FOUND: 'Lead Not Found',
  MISSING_TAG: 'Missing Level 10 Tag',
  OUT_OF_STATE: 'Out of State',
  OPTED_OUT: 'Opted Out',
  DO_NOT_CONTACT: 'Do Not Contact',
  INVALID_PHONE: 'Invalid Phone',
  MULTIPLE_PHONES: 'Multiple Phone Numbers',
  OPT_IN_FAILED: 'Opt-In Failed',
  MISSING_PROFITDIAL: 'Missing ProfitDial',
  MULTIPLE_PROFITDIAL: 'Multiple ProfitDial Assignments',
  PROFITDIAL_UNAVAILABLE: 'ProfitDial Unavailable in REI',
  PROFITDIAL_MISMATCH: 'ProfitDial Readback Mismatch',
  SHEET_CONFLICT: 'Sheet/REI Conflict',
  INVALID_MERGE_FIELD: 'Invalid Merge Field',
  TEMPLATE_BLOCKED: 'Template Blocked (placeholder in live)',
  SEND_VERIFY_FAILED: 'Send Verification Failed',
  BATCH_CAP_REACHED: 'Batch Cap Reached',
  ERROR: 'Error',
});

// Dispositions that count as a successful send (for KPIs).
export const SENT_DISPOSITIONS = Object.freeze([
  DISPOSITION.TEXT_SENT,
  DISPOSITION.SIMULATED_SENT,
]);

// Reply classifications (SOP Step 9 / KPI engagement).
export const REPLY_CLASS = Object.freeze({
  POSITIVE: 'positive',
  NEGATIVE: 'negative',
  UNCLEAR: 'unclear',
  OPT_OUT: 'opt_out',
  NONE: 'none',
});

// Opt-out / STOP detection. Carrier-standard keywords + common phrasings.
export const OPT_OUT_REGEX =
  /\b(stop|stopall|unsubscribe|cancel|end|quit|remove me|opt[\s-]?out|take me off)\b/i;

// Phrases/tags that block a send when found in tags/notes/history.
// Mirrors Revival AI's SAFETY_TAG_RULES (same REI account) for parity.
// (Opt-out/STOP/unsubscribe are handled separately by OPT_OUT_REGEX.)
export const BLOCKING_PHRASES = Object.freeze([
  'not interested',
  'no interest in selling',
  'wrong number',
  'wrong call',
  'not the owner',
  'do not contact',
  'do not text',
  'do not call',
  'do not automate',
  'dnc',
  'close my file',
  'remove me',
  'remove from list',
  'remove from the list',
  'attorney',
  'lawsuit',
  'harass',
  'sold',
  'already sold',
  'sold to competitor',
  'sold to realtor',
  'deal closed',
  'under contract',
  'contract signed',
  'listed',
  'already listed',
  'currently for sale',
  'dead lead',
  'disqualified',
  'spam',
  'telemarketer',
]);

// Positive / negative reply signal words (coarse; sales team does real triage).
export const POSITIVE_WORDS = Object.freeze([
  'yes',
  'interested',
  'how much',
  'what is your offer',
  'call me',
  'sure',
  'lets talk',
  "let's talk",
  'cash',
  'sounds good',
]);
export const NEGATIVE_WORDS = Object.freeze([
  'no',
  'not interested',
  'go away',
  'never',
  'wrong number',
  'stop contacting',
]);

// Export columns appended to the user's spreadsheet on export.
export const EXPORT_COLUMNS = Object.freeze([
  'L10_Disposition',
  'L10_Reason',
  'L10_TemplateId',
  'L10_ProfitDial',
  'L10_OptInStatus',
  'L10_SendVerified',
  'L10_ReplyClass',
  'L10_ProcessedAt',
]);

// Merge fields the templates are allowed to reference.
export const ALLOWED_MERGE_FIELDS = Object.freeze(['first_name', 'property_address']);

// Owner-name keywords that make a single first-name unsafe to derive → the lead
// is routed to manual review instead of auto-sent (per the pilot handoff spec).
export const NAME_REVIEW_KEYWORDS = Object.freeze([
  'trust', 'trustee', ' tr ', ' tr,', 'llc', 'estate', 'owner', 'unknown', 'l l c', 'inc', 'company', ' co ',
]);

// Tokens that must never appear in a final rendered message.
export const FORBIDDEN_MESSAGE_TOKENS = Object.freeze(['{{', '}}', 'undefined', 'null', 'n/a', 'unknown']);
