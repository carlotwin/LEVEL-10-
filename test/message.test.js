import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateTemplate,
  renderTemplate,
  inspectMergeFields,
  anyPlaceholderEnabled,
  eligibleTemplates,
  assertMessageIntegrity,
  computeChecksum,
  TEMPLATES,
} from '../server/automation/message.js';

const IDS = TEMPLATES.filter((t) => t.enabled).map((t) => t.id);

test('integrity check passes for untampered pool', () => {
  assert.equal(assertMessageIntegrity(), true);
  assert.equal(computeChecksum(), computeChecksum());
});

test('approved pool has no placeholders and is eligible in live', () => {
  assert.equal(anyPlaceholderEnabled(), false);
  assert.ok(eligibleTemplates({ sandbox: true }).length >= 5);
  assert.equal(eligibleTemplates({ sandbox: false }).length, IDS.length);
});

test('allocation prefers least-used template (balanced)', () => {
  const usage = Object.fromEntries(IDS.map((id) => [id, 3]));
  usage[IDS[1]] = 0; // make the 2nd the only least-used
  const { template } = allocateTemplate({ sandbox: false, usageCounts: usage, lastTemplateId: null, seed: 'abc' });
  assert.equal(template.id, IDS[1]);
});

test('allocation avoids immediate repeat when alternatives exist', () => {
  const first = allocateTemplate({ sandbox: false, usageCounts: {}, lastTemplateId: IDS[0], seed: 'x' }).template.id;
  assert.notEqual(first, IDS[0]);
});

test('allocation is deterministic for a given seed', () => {
  const a = allocateTemplate({ sandbox: false, usageCounts: {}, lastTemplateId: null, seed: 'contact-42' }).template.id;
  const b = allocateTemplate({ sandbox: false, usageCounts: {}, lastTemplateId: null, seed: 'contact-42' }).template.id;
  assert.equal(a, b);
});

test('allocation balances over a run and avoids obvious repeats', () => {
  const usage = {};
  let last = null;
  const picks = [];
  for (let i = 0; i < 60; i++) {
    const { template } = allocateTemplate({ sandbox: false, usageCounts: usage, lastTemplateId: last, seed: 'c' + i });
    usage[template.id] = (usage[template.id] || 0) + 1;
    last = template.id;
    picks.push(template.id);
  }
  const counts = IDS.map((id) => usage[id] || 0);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, 'balanced within 1');
  let maxRun = 1, run = 1;
  for (let i = 1; i < picks.length; i++) {
    run = picks[i] === picks[i - 1] ? run + 1 : 1;
    maxRun = Math.max(maxRun, run);
  }
  assert.ok(maxRun <= 2, 'no obvious repeating run');
});

test('merge fields: renders first_name and property_address', () => {
  const t1 = TEMPLATES.find((t) => t.id === 'T1');
  assert.equal(inspectMergeFields(t1.body).valid, true);
  const out = renderTemplate(t1, { firstName: 'Maria', address: '100 Alpha St, Oakland, CA' });
  assert.match(out, /Maria/);
  assert.match(out, /100 Alpha St/);
  assert.doesNotMatch(out, /\{\{/);
});

test('merge fields: fail closed when first name or address missing', () => {
  const t1 = TEMPLATES.find((t) => t.id === 'T1');
  assert.throws(() => renderTemplate(t1, { firstName: '', address: '100 Alpha St' }), /INVALID_MERGE_FIELD|first_name/);
  assert.throws(() => renderTemplate(t1, { firstName: 'Maria', address: '' }), /INVALID_MERGE_FIELD|property_address/);
});

test('only approved merge fields are allowed', () => {
  assert.equal(inspectMergeFields('Hi {{first_name}} at {{property_address}}').valid, true);
  assert.equal(inspectMergeFields('Hi {{firstname}} {{offer_amount}}').valid, false);
});
