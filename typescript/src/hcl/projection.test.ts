/**
 * HCL projection intent tests — golden transcriptions from the shared
 * vector suite (RFC 0014 §8).
 *
 * Blind-written intent documents (docs/multi-language-implementation
 * -plan.md §3); no gate is claimed before the §7 START GATE.
 *
 * Golden cases cited: hcl-v1.json case ids are named in each test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { projectHcl, HclProjectionRequest } from './projection.ts';
import type { HclCompleteProjection, HclFailedProjectionAttempt } from './projection.ts';
import { parseHcl, profileDefaultEncoding } from './document.ts';
import type { HclDocument } from './document.ts';
import { HclProfile } from './profile.ts';
import { hclParseLimits } from './limits.ts';
import type { PortableValue } from '../core/value.ts';

function parse(text: string, profile: HclProfile = HclProfile.NATIVE_V1): HclDocument {
  return parseHcl(new TextEncoder().encode(text), profile, profileDefaultEncoding(), hclParseLimits());
}

function project(document: HclDocument, policy: 'Fail' | 'ProjectExpression' = 'Fail'): HclCompleteProjection {
  const request = policy === 'Fail' ? new HclProjectionRequest() : HclProjectionRequest.bodyWithExpressionPolicy('ProjectExpression');
  const result = projectHcl(document, request);
  assert.equal(result.kind, 'Complete', `projection must complete: ${JSON.stringify(result)}`);
  return result.value;
}

function projectedAttributes(value: PortableValue): Record<string, PortableValue> {
  assert.equal(value.kind, 'Object');
  const items = value.entries.find((entry) => entry.key === 'items');
  assert.ok(items !== undefined && items.value.kind === 'Sequence');
  const attributes: Record<string, PortableValue> = {};
  for (const item of items.value.items) {
    if (item.kind !== 'Object') continue;
    const kind = item.entries.find((entry) => entry.key === 'kind');
    if (kind === undefined || kind.value.kind !== 'String' || kind.value.value !== 'attribute') continue;
    const name = item.entries.find((entry) => entry.key === 'name');
    const valueEntry = item.entries.find((entry) => entry.key === 'value');
    if (name !== undefined && name.value.kind === 'String' && valueEntry !== undefined) {
      attributes[name.value.value] = valueEntry.value;
    }
  }
  return attributes;
}

/** The flat `{kind, text|value|elements|entries}` descriptor of one projected value. */
function describeValue(value: PortableValue): Record<string, unknown> {
  switch (value.kind) {
    case 'String':
      return { kind: 'string', text: value.value };
    case 'Integer':
      return { kind: 'integer', value: Number(value.value) };
    case 'Decimal':
      return { kind: 'real', value: Number(`${value.coefficient}e${value.exponent}`) };
    case 'Boolean':
      return { kind: 'boolean', value: value.value };
    case 'Null':
      return { kind: 'null' };
    case 'Sequence':
      return { kind: 'tuple', elements: value.items.map(describeValue) };
    case 'EntryMapping':
      return {
        kind: 'object',
        entries: value.entries.map((entry) => [
          entry.key.kind === 'String' ? entry.key.value : String(entry.key),
          describeValue(entry.value),
        ]),
      };
    case 'Object':
      return Object.fromEntries(value.entries.map((entry) => [entry.key, describeValue(entry.value)]));
    default:
      return { kind: value.kind };
  }
}

// ---------------------------------------------------------------------------
// Golden transcriptions (hcl.projection@1)
// ---------------------------------------------------------------------------

test('golden hcl.projection.literal-complete-record: typed members with canonical decimals', () => {
  // conformance/vectors/hcl-v1.json:889-1009 (id hcl.projection.literal-
  // complete-record; record hcl.body@1; attribute_order_preserved,
  // duplicate_keys_preserved, canonical_decimal all true).
  const source =
    'name = "consema"\ncount = 42\nratio = 1.50\nbig = 1e3\nsmall = 15e-1\nenabled = true\nnothing = null\ntags = ["a", "b"]\nlabels = { env = "prod" }\ndups = { a = 1, a = 2 }\nnumkeys = { 1 = "one", 2 = "two" }\nnested = { "x" = { y = [1, 2] } }\n';
  const projection = project(parse(source));
  assert.equal(projection.fidelity(), 'Exact');
  assert.deepEqual(projection.report().events(), []);
  assert.ok(projection.provenance().entries().length > 0, 'event_provenance');
  const attributes = projectedAttributes(projection.value());
  assert.deepEqual(describeValue(attributes.name), { kind: 'string', text: 'consema' });
  assert.deepEqual(describeValue(attributes.count), { kind: 'integer', value: 42 });
  assert.deepEqual(describeValue(attributes.ratio), { kind: 'real', value: 1.5 });
  assert.deepEqual(describeValue(attributes.big), { kind: 'integer', value: 1000 });
  assert.deepEqual(describeValue(attributes.small), { kind: 'real', value: 1.5 });
  assert.deepEqual(describeValue(attributes.enabled), { kind: 'boolean', value: true });
  assert.deepEqual(describeValue(attributes.nothing), { kind: 'null' });
  assert.deepEqual(describeValue(attributes.tags), {
    kind: 'tuple',
    elements: [
      { kind: 'string', text: 'a' },
      { kind: 'string', text: 'b' },
    ],
  });
  assert.deepEqual(describeValue(attributes.labels), {
    kind: 'object',
    entries: [['env', { kind: 'string', text: 'prod' }]],
  });
  // Duplicate object-constructor keys remain ordered entries.
  const dups = describeValue(attributes.dups) as { kind: string; entries: unknown[] };
  assert.equal(dups.kind, 'object');
  assert.deepEqual(dups.entries, [
    ['a', { kind: 'integer', value: 1 }],
    ['a', { kind: 'integer', value: 2 }],
  ]);
  const numkeys = describeValue(attributes.numkeys) as { kind: string; entries: unknown[] };
  assert.deepEqual(numkeys.entries, [
    ['1', { kind: 'string', text: 'one' }],
    ['2', { kind: 'string', text: 'two' }],
  ]);
});

test('golden hcl.projection.non-literal-expression: derived expressions fail atomically', () => {
  // conformance/vectors/hcl-v1.json:1011-1041 (id hcl.projection.non-literal-
  // expression; codes hcl.projection.non-literal-expression@1 for every
  // sample; atomic_failure true; record null).
  for (const text of ['count = 1 + 2\n', 'name = var.name\n', 'msg = "hi ${name}"\n', 'items = [for x in list : x]\n']) {
    const document = parse(text);
    const result = projectHcl(document, new HclProjectionRequest());
    assert.equal(result.kind, 'Failed', text);
    if (result.kind === 'Failed') {
      const diagnostics = result.value.diagnostics();
      assert.ok(diagnostics.length >= 1, text);
      assert.equal(diagnostics[0].code, 'hcl.projection.non-literal-expression@1', text);
      assert.deepEqual(result.value.report().events(), [], text);
    }
  }
});

test('golden hcl.projection.project-expression-policy: the authorized hcl.expression@1 ExtendedValue', () => {
  // conformance/vectors/hcl-v1.json:1043-1081 (id hcl.projection.project-
  // expression-policy; transformed_events 2, event_provenance true; the
  // expression records carry kind and text).
  const source = 'count = 1 + 2\nname = var.name\nok = 42\n';
  const projection = project(parse(source), 'ProjectExpression');
  assert.equal(projection.fidelity(), 'Transformed');
  const attributes = projectedAttributes(projection.value());
  // The projected value member is the `hcl.expression@1` record
  // (RFC 0014 §8.2): {record, kind, text, fingerprint}.
  const count = describeValue(attributes.count) as Record<string, unknown>;
  assert.equal((count.record as { text: string }).text, 'hcl.expression@1');
  assert.equal((count.kind as { text: string }).text, 'binary');
  assert.equal((count.text as { text: string }).text, '1 + 2');
  assert.equal(typeof (count.fingerprint as { text: string }).text, 'string');
  const name = describeValue(attributes.name) as Record<string, unknown>;
  assert.equal((name.kind as { text: string }).text, 'variable');
  assert.equal((name.text as { text: string }).text, 'var.name');
  assert.deepEqual(describeValue(attributes.ok), { kind: 'integer', value: 42 });
  const substituted = projection.report().events().filter((event) => event.kind() === 'ExpressionSubstituted');
  assert.equal(substituted.length, 2, 'transformed_events');
  assert.ok(projection.provenance().entries().length > 0, 'event_provenance');
});

test('golden hcl.projection.literal-complete-boundary: the syntactic boundary is exact', () => {
  // conformance/vectors/hcl-v1.json:1083-1151 (id hcl.projection.literal-
  // complete-boundary; the literals array per sample).
  const samples: [string, boolean][] = [
    ['a = -1\n', true],
    ['a = 1 + 2\n', false],
    ['a = {1 = "a"}\n', true],
    ['a = "no interpolation"\n', true],
    ['a = "x${y}"\n', false],
    ['a = <<EOT\nplain\nEOT\n', true],
    ['a = <<EOT\nhi ${x}\nEOT\n', false],
    ['a = (42)\n', true],
    ['a = -x\n', false],
    ['a = [1, "two", {k = 3}]\n', true],
    ['a = null\n', true],
    ['a = !true\n', false],
    ['a = max(1, 2)\n', false],
    ['a = 15e-1\n', true],
  ];
  for (const [text, literal] of samples) {
    const result = projectHcl(parse(text), new HclProjectionRequest());
    assert.equal(result.kind === 'Complete', literal, text);
  }
});

test('a Recovered document never projects (RFC 0014 §8.2)', () => {
  const document = parse('a = 1\na = 2\n');
  assert.equal(document.formationStatus(), 'Recovered');
  const result = projectHcl(document, new HclProjectionRequest());
  assert.equal(result.kind, 'Failed');
  if (result.kind === 'Failed') {
    const attempt: HclFailedProjectionAttempt = result.value;
    assert.ok(attempt.diagnostics().length >= 1);
    assert.equal(attempt.diagnostics()[0].code, 'hcl.projection.incomplete-document@1');
  }
});
