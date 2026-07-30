// Prints the integrity checksum for the CURRENT template pool.
// Run this AFTER installing Cherry's approved templates (and setting them
// placeholder:false) to get the value to pin into EXPECTED_CHECKSUM in
// server/automation/message.js — the last step before live sending is possible.
import { computeChecksum, anyPlaceholderEnabled, TEMPLATES } from '../server/automation/message.js';

const enabled = TEMPLATES.filter((t) => t.enabled);
console.log('Enabled templates:', enabled.map((t) => t.id).join(', ') || '(none)');
console.log('Any placeholder enabled:', anyPlaceholderEnabled());
console.log('Checksum:', computeChecksum());
if (anyPlaceholderEnabled()) {
  console.log('\n⚠ Placeholder templates are still enabled. Live sending stays BLOCKED');
  console.log('  regardless of this checksum until every placeholder is removed/disabled');
  console.log("  and Cherry's approved copy is installed.");
}
