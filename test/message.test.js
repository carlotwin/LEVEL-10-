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
  EXPECTED_CHECKSUM,
  TEMPLATES,
} from '../server/automation/message.js';

const APPROVED_IDS = ['L10-1', 'L10-2', 'L10-3', 'L10-4', 'L10-5', 'L10-6'];
const FACTS = { firstName: 'Maria', propertyAddress: '123 Oak St, Fresno, CA 93701' };

test('integrity check passes and the pinned checksum matches the approved copy', () => {
  assert.equal(assertMessageIntegrity(), true);
  // The checksum is PINNED to a literal — if approved wording is edited without
  // regenerating it, this fails (which is the point).
  assert.equal(computeChecksum(), EXPECTED_CHECKSUM);
});

test('approved pool is installed: 6 templates, no placeholder enabled', () => {
  const enabled = TEMPLATES.filter((t) => t.enabled).map((t) => t.id);
  assert.deepEqual(enabled, APPROVED_IDS);
  // The live-send blocker is cleared only because nothing enabled is a placeholder.
  assert.equal(anyPlaceholderEnabled(), false);
  assert.equal(eligibleTemplates({ sandbox: false }).length, 6);
  assert.equal(eligibleTemplates({ sandbox: true }).length, 6);
});

test('every approved template uses only allowed merge fields and both are present', () => {
  for (const t of TEMPLATES.filter((x) => x.enabled)) {
    const insp = inspectMergeFields(t.body);
    assert.equal(insp.valid, true, `${t.id} has invalid fields: ${insp.invalid.join(', ')}`);
    assert.ok(insp.fields.includes('first_name'), `${t.id} missing {{first_name}}`);
    assert.ok(insp.fields.includes('property_address'), `${t.id} missing {{property_address}}`);
  }
});

test('every approved template carries the STOP opt-out language', () => {
  for (const t of TEMPLATES.filter((x) => x.enabled)) {
    assert.match(t.body, /Reply STOP to opt out\./, `${t.id} missing opt-out language`);
  }
});

test('allocation prefers least-used template (balanced)', () => {
  const usage = { 'L10-1': 3, 'L10-2': 0, 'L10-3': 5, 'L10-4': 2, 'L10-5': 4, 'L10-6': 6 };
  const { template } = allocateTemplate({ sandbox: true, usageCounts: usage, lastTemplateId: null, seed: 'abc' });
  assert.equal(template.id, 'L10-2'); // the only least-used
});

test('allocation avoids immediate repeat when alternatives exist', () => {
  const usage = {}; // all zero -> full tie set
  const first = allocateTemplate({ sandbox: true, usageCounts: usage, lastTemplateId: 'L10-1', seed: 'x' }).template.id;
  assert.notEqual(first, 'L10-1');
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
  for (let i = 0; i < 60; i++) {
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

test('a 20-lead run spreads across all 6 approved templates', () => {
  const usage = {};
  let last = null;
  for (let i = 0; i < 20; i++) {
    const { template } = allocateTemplate({ sandbox: true, usageCounts: usage, lastTemplateId: last, seed: 'lead-' + i });
    usage[template.id] = (usage[template.id] || 0) + 1;
    last = template.id;
  }
  assert.equal(Object.keys(usage).length, 6, 'all six templates used at least once');
  assert.equal(Object.values(usage).reduce((a, b) => a + b, 0), 20);
});

test('rendering fills both merge fields with the exact approved wording', () => {
  const tpl = TEMPLATES.find((t) => t.id === 'L10-1');
  const out = renderTemplate(tpl, FACTS);
  assert.match(out, /^Hi Maria, it's Juan with Twin Home Buyer\./);
  assert.ok(out.includes('123 Oak St, Fresno, CA 93701'));
  assert.doesNotMatch(out, /\{\{|\}\}/); // no unfilled holes
});

test('rendering fails closed on a blank first name', () => {
  const tpl = TEMPLATES.find((t) => t.id === 'L10-1');
  assert.throws(() => renderTemplate(tpl, { ...FACTS, firstName: '  ' }), /first name|INVALID_MERGE_FIELD/);
});

test('rendering fails closed on a blank property address (no hole in a real text)', () => {
  const tpl = TEMPLATES.find((t) => t.id === 'L10-1');
  assert.throws(() => renderTemplate(tpl, { firstName: 'Maria', propertyAddress: '' }), /property address|INVALID_MERGE_FIELD/);
});

test('rendering falls back to the scraped address when the sheet address is absent', () => {
  const tpl = TEMPLATES.find((t) => t.id === 'L10-2');
  const out = renderTemplate(tpl, { firstName: 'Dan', address: '9 Elm Ave, Clovis, CA' });
  assert.ok(out.includes('9 Elm Ave, Clovis, CA'));
});

test('disabled test template with an unapproved merge field is rejected', () => {
  const bad = TEMPLATES.find((t) => t.id === 'TEST-BAD');
  assert.equal(bad.enabled, false);
  assert.equal(inspectMergeFields(bad.body).valid, false);
  assert.throws(() => renderTemplate(bad, FACTS));
});
