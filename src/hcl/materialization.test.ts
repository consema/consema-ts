/**
 * HCL materialization intent tests — golden transcriptions from the shared
 * vector suite (RFC 0014 §9).
 *
 * Blind-written intent documents (docs/multi-language-implementation
 * -plan.md §3); no gate is claimed before the §7 START GATE.
 *
 * Golden cases cited: hcl-v1.json case ids are named in each test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MaterializationRequest } from '../document/materialization.ts';
import type { MaterializationResult } from '../document/materialization.ts';
import { materializeHcl } from './materialization.ts';
import type { HclBodyRecordInput } from './materialization.ts';
import { projectHcl, HclProjectionRequest } from './projection.ts';
import type { HclDocument } from './document.ts';
import { parseHcl, profileDefaultEncoding } from './document.ts';
import { HclProfile, hclCanonicalDocumentStyle } from './profile.ts';
import { hclParseLimits } from './limits.ts';

function request(profile: string): MaterializationRequest {
  const target = profile === 'hcl.tfvars@1' ? HclProfile.TFVARS_V1 : HclProfile.NATIVE_V1;
  return new MaterializationRequest(target.id(), hclCanonicalDocumentStyle());
}

function render(result: MaterializationResult<HclDocument>): string {
  assert.equal(result.kind, 'Complete', `materialization must complete: ${JSON.stringify(result)}`);
  return new TextDecoder().decode(result.value.document().render());
}

function parse(text: string, profile: HclProfile = HclProfile.NATIVE_V1): HclDocument {
  return parseHcl(new TextEncoder().encode(text), profile, profileDefaultEncoding(), hclParseLimits());
}

// ---------------------------------------------------------------------------
// Golden transcriptions (hcl.materialization@1)
// ---------------------------------------------------------------------------

test('golden hcl.materialization.canonical-document: canonical rendering with minimal escapes', () => {
  // conformance/vectors/hcl-v1.json:1153-1283 (id hcl.materialization.
  // canonical-document; the record spelling pinned by the vectors).
  const record: HclBodyRecordInput = {
    record: 'hcl.body@1',
    items: [
      { kind: 'attribute', name: 'name', value: { kind: 'string', text: 'hello' } },
      { kind: 'attribute', name: 'escaped', value: { kind: 'string', text: 'a\nb\t"c\\d' } },
      { kind: 'attribute', name: 'count', value: { kind: 'integer', value: 42 } },
      { kind: 'attribute', name: 'ratio', value: { kind: 'real', value: 1.5 } },
      { kind: 'attribute', name: 'enabled', value: { kind: 'boolean', value: true } },
      { kind: 'attribute', name: 'nothing', value: { kind: 'null' } },
      { kind: 'attribute', name: 'tags', value: { kind: 'tuple', elements: [{ kind: 'string', text: 'a' }, { kind: 'string', text: 'b' }] } },
      { kind: 'attribute', name: 'labels', value: { kind: 'object', entries: [['env', { kind: 'string', text: 'prod' }]] } },
      { kind: 'attribute', name: 'empty_tuple', value: { kind: 'tuple', elements: [] } },
      { kind: 'attribute', name: 'empty_obj', value: { kind: 'object', entries: [] } },
      {
        kind: 'block',
        type: 'server',
        labels: ['web', '1'],
        body: {
          record: 'hcl.body@1',
          items: [{ kind: 'attribute', name: 'port', value: { kind: 'integer', value: 8080 } }],
        },
      },
    ],
  };
  const result = materializeHcl(record, request('hcl.native@1'));
  assert.equal(
    render(result),
    'name = "hello"\nescaped = "a\\nb\\t\\"c\\\\d"\ncount = 42\nratio = 1.5\nenabled = true\nnothing = null\ntags = [\n  "a",\n  "b"\n]\nlabels = {\n  env = "prod"\n}\nempty_tuple = []\nempty_obj = {}\nserver "web" "1" {\n  port = 8080\n}\n',
  );
});

test('golden hcl.materialization.reparse-closure: expressions emit their canonical text and reparse', () => {
  // conformance/vectors/hcl-v1.json:1285-1329 (id hcl.materialization.
  // reparse-closure; closure true, fingerprint_match true).
  const record: HclBodyRecordInput = {
    record: 'hcl.body@1',
    items: [
      {
        kind: 'attribute',
        name: 'derived',
        value: { kind: 'expression', expression: { record: 'hcl.expression@1', kind: 'binary', text: '1 + 2' } },
      },
      { kind: 'attribute', name: 'big', value: { kind: 'integer', value: 1000 } },
      { kind: 'attribute', name: 'small', value: { kind: 'real', value: 1.5 } },
    ],
  };
  const result = materializeHcl(record, request('hcl.native@1'));
  assert.equal(result.kind, 'Complete');
  if (result.kind !== 'Complete') return;
  const document = result.value.document();
  assert.equal(document.formationStatus(), 'Complete', 'closure');
  assert.equal(render(result), 'derived = 1 + 2\nbig = 1000\nsmall = 1.5\n');
  // fingerprint_match: the re-projection reproduces the expression record
  // (hcl_v1.rs:1688-1765).
  const projection = projectHcl(document, HclProjectionRequest.bodyWithExpressionPolicy('ProjectExpression'));
  assert.equal(projection.kind, 'Complete');
  if (projection.kind === 'Complete') {
    const value = projection.value.value();
    assert.equal(value.kind, 'Object');
    const items = value.entries.find((entry) => entry.key === 'items');
    assert.ok(items !== undefined && items.value.kind === 'Sequence');
    const derived = items.value.items[0];
    assert.equal(derived.kind, 'Object');
    const name = derived.entries.find((entry) => entry.key === 'name');
    assert.ok(name !== undefined && name.value.kind === 'String');
    assert.equal(name.value.value, 'derived');
    const projectedValue = derived.entries.find((entry) => entry.key === 'value');
    assert.ok(projectedValue !== undefined && projectedValue.value.kind === 'Object');
    const kind = projectedValue.value.entries.find((entry) => entry.key === 'kind');
    assert.ok(kind !== undefined && kind.value.kind === 'String');
    assert.equal(kind.value.value, 'binary');
    const text = projectedValue.value.entries.find((entry) => entry.key === 'text');
    assert.ok(text !== undefined && text.value.kind === 'String');
    assert.equal(text.value.value, '1 + 2');
  }
});

test('golden hcl.materialization.unrepresentable: tfvars blocks and invalid records fail', () => {
  // conformance/vectors/hcl-v1.json:1331-1411 (id hcl.materialization.
  // unrepresentable; codes [hcl.materialization.unrepresentable@1,
  // invalid-record, null]).
  const blockRecord = {
    record: 'hcl.body@1',
    items: [
      {
        kind: 'block',
        type: 'server',
        labels: ['x'],
        body: { record: 'hcl.body@1', items: [{ kind: 'attribute', name: 'a', value: { kind: 'integer', value: 1 } }] },
      },
    ],
  };
  const tfvars = materializeHcl(blockRecord as HclBodyRecordInput, request('hcl.tfvars@1'));
  assert.equal(tfvars.kind, 'Failed');
  if (tfvars.kind === 'Failed') {
    assert.equal(tfvars.value.failure().kind, 'Unrepresentable');
  }
  const wrongRecord = { record: 'hcl.something-else@1', items: [] };
  const invalid = materializeHcl(wrongRecord as HclBodyRecordInput, request('hcl.native@1'));
  assert.equal(invalid.kind, 'Failed');
  if (invalid.kind === 'Failed') {
    assert.equal(invalid.value.failure().kind, 'InvalidRequest');
  }
  const native = materializeHcl(blockRecord as HclBodyRecordInput, request('hcl.native@1'));
  assert.equal(render(native), 'server "x" {\n  a = 1\n}\n');
});

test('golden hcl.materialization.typed-member-form: the raw typed member spelling materializes identically', () => {
  // conformance/vectors/hcl-v1.json:1413-1460 (id hcl.materialization.typed-
  // member-form; the raw form the projection publishes).
  const record = {
    record: 'hcl.body@1',
    items: [
      { kind: 'attribute', name: 'name', value: 'hello' },
      { kind: 'attribute', name: 'count', value: 42 },
      { kind: 'attribute', name: 'ratio', value: 1.5 },
      { kind: 'attribute', name: 'enabled', value: true },
      { kind: 'attribute', name: 'nothing', value: null },
      { kind: 'attribute', name: 'tags', value: ['a', 'b'] },
    ],
  };
  assert.equal(
    render(materializeHcl(record as HclBodyRecordInput, request('hcl.native@1'))),
    'name = "hello"\ncount = 42\nratio = 1.5\nenabled = true\nnothing = null\ntags = [\n  "a",\n  "b"\n]\n',
  );
});

test('golden hcl.materialization.tfvars-canonical: attribute-only records under the tfvars profile', () => {
  // conformance/vectors/hcl-v1.json:1973-2045 (id hcl.materialization.
  // tfvars-canonical; closure true).
  const record: HclBodyRecordInput = {
    record: 'hcl.body@1',
    items: [
      { kind: 'attribute', name: 'region', value: { kind: 'string', text: 'us-east-1' } },
      { kind: 'attribute', name: 'count', value: { kind: 'integer', value: 3 } },
      { kind: 'attribute', name: 'ratio', value: { kind: 'real', value: 0.5 } },
      { kind: 'attribute', name: 'tags', value: { kind: 'tuple', elements: [{ kind: 'string', text: 'a' }, { kind: 'string', text: 'b' }] } },
      { kind: 'attribute', name: 'labels', value: { kind: 'object', entries: [['env', { kind: 'string', text: 'prod' }]] } },
    ],
  };
  const result = materializeHcl(record, request('hcl.tfvars@1'));
  assert.equal(result.kind, 'Complete');
  if (result.kind !== 'Complete') return;
  assert.equal(result.value.document().formationStatus(), 'Complete', 'closure');
  assert.equal(
    render(result),
    'region = "us-east-1"\ncount = 3\nratio = 0.5\ntags = [\n  "a",\n  "b"\n]\nlabels = {\n  env = "prod"\n}\n',
  );
});

test('canonical decimal spellings: real values emit their canonical decimal', () => {
  // RFC 0014 §9: numbers emit their canonical decimal spelling, so 1.50
  // and 15e-1 both materialize as 1.5.
  const record = {
    record: 'hcl.body@1',
    items: [
      { kind: 'attribute', name: 'a', value: { kind: 'real', value: 1.5 } },
      { kind: 'attribute', name: 'b', value: { kind: 'real', value: 0.5 } },
    ],
  };
  const result = materializeHcl(record as HclBodyRecordInput, request('hcl.native@1'));
  assert.equal(result.kind, 'Complete');
  if (result.kind !== 'Complete') return;
  assert.equal(render(result), 'a = 1.5\nb = 0.5\n');
  // The emitted document reparses completely (reparse closure).
  const reparsed = parse(new TextDecoder().decode(result.value.document().render()));
  assert.equal(reparsed.formationStatus(), 'Complete');
});
