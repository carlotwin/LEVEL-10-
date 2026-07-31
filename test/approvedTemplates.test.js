// =============================================================================
// EXACT approved template proof.
//
// The six strings are pasted here verbatim from the specification, independently
// of server/automation/message.js. If either side is edited, these fail — which
// is the point: the copy a homeowner receives is fixed by two files agreeing, not
// by one file asserting about itself.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TEMPLATES,
  APPROVED_TEMPLATE_IDS,
  REQUIRED_OPT_OUT_SENTENCE,
  validateRenderedMessage,
  isUsableFirstName,
  renderTemplate,
  allocateTemplate,
} from '../server/automation/message.js';

const SPEC = {
  LEVEL10_TEMPLATE_1:
    "Hi {{first_name}}, it's Juan with Twin Home Buyer. We sent a few postcards about {{property_address}} but never connected. Should I keep following up, or have your plans changed? Reply STOP to opt out.",
  LEVEL10_TEMPLATE_2:
    "Hi {{first_name}}, it's Juan with Twin Home Buyer. I was going through my notes and realized we never connected after sending a few postcards about {{property_address}}. What's the current plan for the property? Reply STOP to opt out.",
  LEVEL10_TEMPLATE_3:
    "Hi {{first_name}}, it's Juan with Twin Home Buyer. We reached out by mail about {{property_address}}, but I never found out what ended up happening. Would you mind sharing where things stand? Reply STOP to opt out.",
  LEVEL10_TEMPLATE_4:
    "Hi {{first_name}}, it's Juan with Twin Home Buyer. We mailed you a few times regarding {{property_address}} and I didn't want to assume anything. Have your plans changed? Reply STOP to opt out.",
  LEVEL10_TEMPLATE_5:
    "Hi {{first_name}}, it's Juan with Twin Home Buyer. Just wanted to check in after the postcards we sent about {{property_address}}. Is this still a property you'd ever consider selling? Reply STOP to opt out.",
  LEVEL10_TEMPLATE_6:
    "Hi {{first_name}}, it's Juan with Twin Home Buyer. I know life gets busy, so I figured I'd send one quick text after the postcards we mailed about {{property_address}}. Should we stay in touch, or would you rather we close out our file? Reply STOP to opt out.",
};

const enabled = () => TEMPLATES.filter((t) => t.enabled);

// 35. All six exact approved strings
test('all six templates match the approved text byte for byte', () => {
  for (const [id, text] of Object.entries(SPEC)) {
    const t = TEMPLATES.find((x) => x.id === id);
    assert.ok(t, `${id} is missing from the pool`);
    assert.equal(t.body, text, `${id} wording differs from the approved copy`);
  }
});

// 36. No seventh template
test('there is no seventh enabled template', () => {
  assert.equal(enabled().length, 6);
  assert.deepEqual(
    enabled().map((t) => t.id),
    APPROVED_TEMPLATE_IDS
  );
  assert.equal(Object.keys(SPEC).length, 6);
});

test('an unapproved template id is rejected even with perfect text', () => {
  const r = validateRenderedMessage({
    templateId: 'LEVEL10_TEMPLATE_7',
    rendered: SPEC.LEVEL10_TEMPLATE_1.replace('{{first_name}}', 'Tony').replace('{{property_address}}', '1 A St'),
    firstName: 'Tony',
    propertyAddress: '1 A St',
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not one of the six approved/i);
});

// 37 + 38. Merge fields present in every template
test('every template contains both merge fields and nothing else', () => {
  for (const t of enabled()) {
    assert.ok(t.body.includes('{{first_name}}'), `${t.id} missing {{first_name}}`);
    assert.ok(t.body.includes('{{property_address}}'), `${t.id} missing {{property_address}}`);
    const fields = [...t.body.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(fields)].sort(), ['first_name', 'property_address']);
  }
});

// 39. Ends with the STOP sentence
test('every template ends with the required opt-out sentence', () => {
  for (const t of enabled()) {
    assert.ok(t.body.endsWith(REQUIRED_OPT_OUT_SENTENCE), `${t.id} does not end with the STOP sentence`);
  }
});

// 40. No internal "Why" explanations, no emoji, no links, no second signature
test('no template carries internal notes, emoji, links or a second signature', () => {
  for (const t of enabled()) {
    assert.doesNotMatch(t.body, /\bWhy\b/, `${t.id} contains an internal explanation`);
    assert.doesNotMatch(t.body, /https?:\/\/|www\./i, `${t.id} contains a link`);
    assert.doesNotMatch(t.body, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${t.id} contains an emoji`);
    // "Juan with Twin Home Buyer" appears exactly once.
    assert.equal((t.body.match(/Twin Home Buyer/g) || []).length, 1, `${t.id} has a duplicate signature`);
  }
});

const render = (id, first, addr) =>
  renderTemplate(TEMPLATES.find((t) => t.id === id), { firstName: first, propertyAddress: addr });

// 41. Missing first name blocks
test('a blank or unsafe first name blocks the message', () => {
  const good = render('LEVEL10_TEMPLATE_1', 'Tony', '1 A St');
  for (const bad of ['', '   ', 'TRUST', 'LIVING', 'TRUSTEE', 'TR', 'LLC', 'ESTATE', 'UNKNOWN', 'OWNER']) {
    const r = validateRenderedMessage({
      templateId: 'LEVEL10_TEMPLATE_1',
      rendered: good.replace('Tony', bad || 'Tony'),
      firstName: bad,
      propertyAddress: '1 A St',
    });
    assert.equal(r.ok, false, `first name "${bad}" must block`);
  }
  assert.equal(isUsableFirstName('Tony'), true);
  assert.equal(isUsableFirstName('TRUST'), false);
  assert.equal(isUsableFirstName('J'), false, 'a single initial is not a first name');
});

// 42. Missing property address blocks
test('a blank property address blocks the message', () => {
  assert.throws(() => render('LEVEL10_TEMPLATE_1', 'Tony', ''), /property address/i);
  const r = validateRenderedMessage({
    templateId: 'LEVEL10_TEMPLATE_1',
    rendered: render('LEVEL10_TEMPLATE_1', 'Tony', '1 A St'),
    firstName: 'Tony',
    propertyAddress: '',
  });
  assert.equal(r.ok, false);
});

// 43. Unresolved merge field blocks
test('an unresolved merge field or a forbidden token blocks the message', () => {
  for (const bad of ['{{first_name}}', '{{', '}}', 'undefined', 'null', 'N/A', 'UNKNOWN']) {
    const rendered = `Hi ${bad}, it's Juan with Twin Home Buyer. ${REQUIRED_OPT_OUT_SENTENCE}`;
    const r = validateRenderedMessage({
      templateId: 'LEVEL10_TEMPLATE_1',
      rendered,
      firstName: 'Tony',
      propertyAddress: '1 A St',
    });
    assert.equal(r.ok, false, `"${bad}" must block`);
  }
});

// 44. Unauthorized text difference blocks
test('any unauthorized change to the approved wording blocks the message', () => {
  const base = render('LEVEL10_TEMPLATE_1', 'Tony', '2700 Humboldt Ave');
  const ok = validateRenderedMessage({
    templateId: 'LEVEL10_TEMPLATE_1',
    rendered: base,
    firstName: 'Tony',
    propertyAddress: '2700 Humboldt Ave',
  });
  assert.equal(ok.ok, true, ok.reason);

  const tampered = [
    base.replace('Hi Tony', 'Hey Tony'), // reworded
    base.replace('Reply STOP to opt out.', 'Reply STOP.'), // weakened opt-out
    base + ' Call me!', // appended
    base.replace('Twin Home Buyer', 'Twin Home Buyers'), // altered company
    base.replace('postcards', 'letters'), // altered body
    base.slice(0, -1), // truncated
  ];
  for (const t of tampered) {
    const r = validateRenderedMessage({
      templateId: 'LEVEL10_TEMPLATE_1',
      rendered: t,
      firstName: 'Tony',
      propertyAddress: '2700 Humboldt Ave',
    });
    assert.equal(r.ok, false, `tampered text must block: ${t.slice(0, 60)}…`);
  }
});

test('a different property address than the one verified blocks the message', () => {
  const r = validateRenderedMessage({
    templateId: 'LEVEL10_TEMPLATE_1',
    rendered: render('LEVEL10_TEMPLATE_1', 'Tony', '999 Wrong St'),
    firstName: 'Tony',
    propertyAddress: '2700 Humboldt Ave',
  });
  assert.equal(r.ok, false, 'the address in the text must be the verified one');
});

// 45. Balanced rotation uses all six
test('balanced rotation uses all six templates and stays even', () => {
  const usage = {};
  let last = null;
  for (let i = 0; i < 60; i++) {
    const { template } = allocateTemplate({ sandbox: false, usageCounts: usage, lastTemplateId: last, seed: 'row-' + i });
    assert.ok(APPROVED_TEMPLATE_IDS.includes(template.id));
    usage[template.id] = (usage[template.id] || 0) + 1;
    last = template.id;
  }
  assert.equal(Object.keys(usage).length, 6);
  const counts = Object.values(usage);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, 'rotation is balanced within one');
});
