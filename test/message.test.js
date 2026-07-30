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

test('integrity check passes for untampered pool', () => {
  assert.equal(assertMessageIntegrity(), true);
  assert.equal(computeChecksum(), computeChecksum());
});

test('placeholder pool is flagged and eligible only in sandbox', () => {
  assert.equal(anyPlaceholderEnabled(), true);
  assert.ok(eligibleTemplates({ sandbox: true }).length >= 5);
  // In live mode, placeholders are NEVER eligible.
  assert.equal(eligibleTemplates({ sandbox: false }).length, 0);
});

test('allocation prefers least-used template (balanced)', () => {
  const usage = { 'PH-1': 3, 'PH-2': 0, 'PH-3': 5, 'PH-4': 2, 'PH-5': 4 };
  const { template } = allocateTemplate({ sandbox: true, usageCounts: usage, lastTemplateId: null, seed: 'abc' });
  assert.equal(template.id, 'PH-2'); // the only least-used
});

test('allocation avoids immediate repeat when alternatives exist', () => {
  const usage = {}; // all zero -> full tie set
  const first = allocateTemplate({ sandbox: true, usageCounts: usage, lastTemplateId: 'PH-1', seed: 'x' }).template.id;
  assert.notEqual(first, 'PH-1');
});

test('allocation is deterministic for a given seed', () => {
  const a = allocateTemplate({ sandbox: true, usageCounts: {}, lastTemplateId: null, seed: 'contact-42' }).template.id;
  const b = allocateTemplate({ sandbox: true, usageCounts: {}, lastTemplateId: null, seed: 'contact-42' }).template.id;
  assert.equal(a, b);
});

test('allocation is not an obvious 1,2,3 sequence and balances over a run', () => {
  const usage = {};
  const lastId = { v: null };
  const picks = [];
  for (let i = 0; i < 50; i++) {
    const { template } = allocateTemplate({ sandbox: true, usageCounts: usage, lastTemplateId: lastId.v, seed: 'c' + i });
    usage[template.id] = (usage[template.id] || 0) + 1;
    lastId.v = template.id;
    picks.push(template.id);
  }
  const counts = Object.values(usage);
  const max = Math.max(...counts);
  const min = Math.min(...counts);
  assert.ok(max - min <= 1, `balanced within 1 (got spread ${min}..${max})`);
  // no long identical runs
  let maxRun = 1, run = 1;
  for (let i = 1; i < picks.length; i++) {
    run = picks[i] === picks[i - 1] ? run + 1 : 1;
    maxRun = Math.max(maxRun, run);
  }
  assert.ok(maxRun <= 2, 'no obvious repeating run');
});

test('live mode throws when no approved templates enabled', () => {
  assert.throws(() => allocateTemplate({ sandbox: false, usageCounts: {}, lastTemplateId: null, seed: 'x' }), /No eligible/);
});

test('merge field validation and rendering', () => {
  const tpl = TEMPLATES.find((t) => t.id === 'PH-1');
  assert.equal(inspectMergeFields(tpl.body).valid, true);
  assert.match(renderTemplate(tpl, { firstName: 'Maria' }), /Maria/);
  assert.throws(() => renderTemplate(tpl, { firstName: '' }), /INVALID_MERGE_FIELD|first_name/);
});

test('bad template with unapproved merge field is rejected', () => {
  const bad = TEMPLATES.find((t) => t.id === 'PH-BAD');
  assert.equal(inspectMergeFields(bad.body).valid, false);
  assert.throws(() => renderTemplate(bad, { firstName: 'X' }));
});
