// =============================================================================
// Adapter factory — the ONLY place an adapter is constructed.
// Enforces requirement #7 / #9: SANDBOX=true can NEVER return a live adapter;
// SANDBOX=false returns the live skeleton (which refuses to run).
// =============================================================================
import { env, adapterMode } from '../config/env.js';
import { assertAdapter } from './adapter-interface.js';
import { SandboxAdapter } from './sandbox.js';
import { ReiBlackBookAdapter } from './reibb.js';

export function createAdapter(opts = {}) {
  const mode = adapterMode();
  if (mode === 'sandbox') {
    // Hard invariant: sandbox mode yields ONLY the sandbox adapter.
    return assertAdapter(new SandboxAdapter(opts));
  }
  // Live mode. This adapter throws LIVE_ADAPTER_NOT_IMPLEMENTED on init(), so
  // the engine's assertRunnable()/init will refuse to proceed.
  if (env.SANDBOX) {
    throw new Error('Invariant violated: live adapter requested while SANDBOX=true');
  }
  return assertAdapter(new ReiBlackBookAdapter());
}
