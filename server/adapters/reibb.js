// =============================================================================
// LIVE REI BlackBook adapter — NON-FUNCTIONAL SKELETON (requirement #7).
//
// This is intentionally not implemented. Every method throws
// LIVE_ADAPTER_NOT_IMPLEMENTED so that:
//   - SANDBOX=false refuses to run (env.runnableReason blocks at boot), and
//   - if it were ever instantiated, no action could silently succeed.
//
// When the real Playwright automation is built, implement each method against
// the shared interface (adapter-interface.js). The engine will NOT need
// changes — it depends only on the interface method names.
//
// Intended real implementation (future): Playwright Chromium driving the CRM —
// login, filter the "Level 10 Properties" tag, open a contact, opt-in the
// phone, select the ProfitDial number, enter + send the approved template, and
// verify the message appears in the thread. Ordered search fallbacks and
// browser-crash recovery as in the Revival AI reference.
// =============================================================================
import { Adapter } from './adapter-interface.js';

const NOT_IMPL = 'LIVE_ADAPTER_NOT_IMPLEMENTED';

function notImplemented(method) {
  const err = new Error(
    `${NOT_IMPL}: reibb.${method}() is a skeleton. The live REI BlackBook ` +
      `Playwright adapter has not been built. Keep SANDBOX=true.`
  );
  err.code = NOT_IMPL;
  throw err;
}

export class ReiBlackBookAdapter extends Adapter {
  get name() {
    return 'reibb-live';
  }
  get isSandbox() {
    return false;
  }

  async init() {
    notImplemented('init');
  }
  async close() {
    notImplemented('close');
  }
  async findContact() {
    notImplemented('findContact');
  }
  async readContactFacts() {
    notImplemented('readContactFacts');
  }
  async getSmsStatus() {
    notImplemented('getSmsStatus');
  }
  async optInPhone() {
    notImplemented('optInPhone');
  }
  async getProfitDialNumbers() {
    notImplemented('getProfitDialNumbers');
  }
  async selectProfitDial() {
    notImplemented('selectProfitDial');
  }
  async enterMessage() {
    notImplemented('enterMessage');
  }
  async sendMessage() {
    notImplemented('sendMessage');
  }
  async verifyMessageSent() {
    notImplemented('verifyMessageSent');
  }
  async readDeliveryStatus() {
    notImplemented('readDeliveryStatus');
  }
  async readReplies() {
    notImplemented('readReplies');
  }
}

export { NOT_IMPL as LIVE_ADAPTER_NOT_IMPLEMENTED };
