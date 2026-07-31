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
  UNDELIVERED: 'Sent but Undelivered',
  BATCH_CAP_REACHED: 'Batch Cap Reached',
  ERROR: 'Error',
});

// -----------------------------------------------------------------------------
// TRACKING STATUSES (exact strings, as specified for the Level 10 tracker).
//
// These sit ALONGSIDE the dispositions above, which the dashboard and the KPI
// report already speak. A status is the precise machine-readable state of a row;
// STATUS_TO_DISPOSITION maps it onto the plain-language outcome the dashboard
// shows, so both stay in sync without rewriting either.
// -----------------------------------------------------------------------------
export const L10_STATUS = Object.freeze({
  PENDING: 'PENDING',
  SEARCHING_BY_PHONE: 'SEARCHING_BY_PHONE',
  NO_CONTACT_FOUND_BY_PHONE: 'NO_CONTACT_FOUND_BY_PHONE',
  ONE_CONTACT_FOUND: 'ONE_CONTACT_FOUND',
  MULTIPLE_CONTACTS_FOUND: 'MULTIPLE_CONTACTS_FOUND',
  PHONE_MATCH_NAME_MATCH: 'PHONE_MATCH_NAME_MATCH',
  PHONE_MATCH_NAME_MISMATCH: 'PHONE_MATCH_NAME_MISMATCH',
  MULTIPLE_CONTACTS_MANUAL_REVIEW: 'MULTIPLE_CONTACTS_MANUAL_REVIEW',
  CONTACT_VERIFIED: 'CONTACT_VERIFIED',
  LEVEL_10_TAG_MISSING: 'LEVEL_10_TAG_MISSING',
  SAFETY_REVIEW_FAILED: 'SAFETY_REVIEW_FAILED',
  OPT_IN_REQUIRED: 'OPT_IN_REQUIRED',
  OPT_IN_FAILED: 'OPT_IN_FAILED',
  PROFITDIAL_NOT_VERIFIED: 'PROFITDIAL_NOT_VERIFIED',
  READY_TO_SEND: 'READY_TO_SEND',
  SMS_SENT: 'SMS_SENT',
  SMS_SEND_FAILED: 'SMS_SEND_FAILED',
  MANUAL_REVIEW_REQUIRED: 'MANUAL_REVIEW_REQUIRED',
  ALREADY_PROCESSED: 'ALREADY_PROCESSED',
});

// Status -> existing disposition, so the dashboard/KPI keep working unchanged.
export const STATUS_TO_DISPOSITION = Object.freeze({
  [L10_STATUS.NO_CONTACT_FOUND_BY_PHONE]: DISPOSITION.LEAD_NOT_FOUND,
  [L10_STATUS.PHONE_MATCH_NAME_MISMATCH]: DISPOSITION.SHEET_CONFLICT,
  [L10_STATUS.MULTIPLE_CONTACTS_MANUAL_REVIEW]: DISPOSITION.NEEDS_REVIEW,
  [L10_STATUS.MANUAL_REVIEW_REQUIRED]: DISPOSITION.NEEDS_REVIEW,
  [L10_STATUS.LEVEL_10_TAG_MISSING]: DISPOSITION.MISSING_TAG,
  [L10_STATUS.SAFETY_REVIEW_FAILED]: DISPOSITION.NEEDS_REVIEW,
  [L10_STATUS.OPT_IN_REQUIRED]: DISPOSITION.OPT_IN_FAILED,
  [L10_STATUS.OPT_IN_FAILED]: DISPOSITION.OPT_IN_FAILED,
  [L10_STATUS.PROFITDIAL_NOT_VERIFIED]: DISPOSITION.MISSING_PROFITDIAL,
  [L10_STATUS.SMS_SENT]: DISPOSITION.TEXT_SENT,
  [L10_STATUS.SMS_SEND_FAILED]: DISPOSITION.SEND_VERIFY_FAILED,
  [L10_STATUS.ALREADY_PROCESSED]: DISPOSITION.ALREADY_PROCESSED,
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

// Phrases that block a send when found in tags/notes/history.
export const BLOCKING_PHRASES = Object.freeze([
  'not interested',
  'wrong number',
  'do not contact',
  'do not text',
  'do not automate',
  'dnc',
  'attorney',
  'lawsuit',
  'harass',
  'complaint',
  'sold',
  'already sold',
  'listed',
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
  // The precise machine-readable state of the row (see L10_STATUS).
  'L10_Status',
  // Direct link to the contact in REI BlackBook, so a row can be opened and
  // checked by hand from the exported sheet.
  'L10_ReiUrl',
  // The exact text prepared/sent for this contact — the audit record of what
  // the homeowner actually received.
  'L10_Message',
]);

// Merge fields the templates are allowed to reference. Anything else in a
// template body is an INVALID_MERGE_FIELD block (fail closed — never sent).
export const ALLOWED_MERGE_FIELDS = Object.freeze(['first_name', 'property_address']);
