// =============================================================================
// Shared adapter interface (requirement #7).
//
// Both the sandbox adapter and the (future) live REI BlackBook adapter
// implement this exact contract, so the engine never needs rewriting when the
// Playwright adapter is added. The engine depends ONLY on these method names.
//
// An adapter GATHERS FACTS and PERFORMS ACTIONS. It NEVER decides anything —
// all decisions live in sop.js. Every method is async.
//
// Method contract:
//   findContact(query)            -> { status, candidates[], searched } PHONE search;
//                                    gathers every candidate, decides nothing
//   openContact(candidate)        -> { opened, contactId? } open the one the
//                                    decision layer (contactMatch.js) selected
//   readContactFacts(contactId)   -> facts (tags, phones, notes, chatHistory, state, name, address)
//   getSmsStatus(contactId)       -> { smsEnabled, optedIn } RE-READ after opt-in
//   optInAvailable(contactId)     -> boolean; false = no Opt In control exists
//   profitDialSelectorAvailable() -> boolean; false = no sender selector exists
//   optInPhone(contactId)         -> { status:'opted_in'|'failed', smsEnabled, reason? }
//   getProfitDialNumbers()        -> [ '(510) 916-3995', ... ] numbers available in REI
//   selectProfitDial(contactId, number) -> { selected: true|false, reason? }
//   enterMessage(contactId, text) -> { entered: true|false }
//   sendMessage(contactId)        -> { sent: true|false, reason? }
//   verifyMessageSent(contactId, text) -> { verified: true|false, reason? }
//   readDeliveryStatus(contactId) -> { delivery:'delivered'|'failed'|'pending' }
//   readReplies(contactId)        -> { text } most recent inbound reply (or {text:''})
//   listContacts()                -> [ contactId, ... ] the working set (SOP Step 2 filtered)
// =============================================================================

export const ADAPTER_METHODS = Object.freeze([
  'findContact',
  'openContact',
  'readContactFacts',
  'getSmsStatus',
  'optInAvailable',
  'profitDialSelectorAvailable',
  'optInPhone',
  'getProfitDialNumbers',
  'selectProfitDial',
  'enterMessage',
  'sendMessage',
  'verifyMessageSent',
  'readDeliveryStatus',
  'readReplies',
  'listContacts',
]);

/** Base class documenting the contract. Concrete adapters extend & override. */
export class Adapter {
  get name() {
    return 'base';
  }
  get isSandbox() {
    return false;
  }
  async init() {}
  async close() {}
}

/** Throw if an object is missing any required adapter method. */
export function assertAdapter(adapter) {
  const missing = ADAPTER_METHODS.filter((m) => typeof adapter[m] !== 'function');
  if (missing.length) {
    throw new Error(`Adapter "${adapter?.name || 'unknown'}" is missing methods: ${missing.join(', ')}`);
  }
  return adapter;
}
