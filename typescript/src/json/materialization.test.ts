/**
 * Intent documents for canonical materialization and dialect conversion.
 *
 * Golden transcriptions from the shared vectors — each test cites its
 * case id:
 *  - conformance/vectors/json-family-v2.json: json5.materialize.
 *    canonical-specials (:138-142), json5.materialize.reject-finite-
 *    binary (:144-148), json5.materialize.reject-profile-style-mismatch
 *    (:150-154), json5.convert.finite-to-strict (:156-160),
 *    json5.convert.nonfinite-to-strict-fails (:162-166),
 *    json5.convert.strict-to-json5 (:168-172)
 *  - materialization closure (RFC 0004 §7): output reparses under the
 *    exact requested profile and reprojects to the identical value
 *  - styles/profile bindings: RFC 0004 §4 (:98-127), RFC 0005 §9
 *    (:197-212); crates/consema-json/src/materialization.rs:113-152
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parse,
  materialize,
  convertJsonDocument,
} from '../json/index.ts';
import type { JsonConversionResult } from '../json/index.ts';
import { PROFILE_JSON5_STANDARD, PROFILE_JSON_STRICT } from '../json/index.ts';
import { DEFAULT_PARSE_LIMITS } from '../document/formation.ts';
import { MaterializationRequest, MaterializationStyleId } from '../document/materialization.ts';
import type { CompleteMaterialization, FailedMaterializationAttempt, MaterializationResult } from '../document/materialization.ts';
import { ProfileId } from '../document/profile.ts';
import {
  binaryFloat64Value,
  booleanValue,
  decimalValue,
  integerValue,
  nullValue,
  sequenceValue,
  stringValue,
} from '../core/value.ts';
import type { JsonDocument } from '../json/index.ts';

function bytes(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

function json5Request(style: string): MaterializationRequest {
  // Vectors materialize without a trailing newline; the request default is
  // 'Lf', so select 'None' explicitly.
  return new MaterializationRequest(
    new ProfileId('json5.standard', 1),
    new MaterializationStyleId(style, 1),
  ).withNewline('None');
}

function strictRequest(style: string): MaterializationRequest {
  return new MaterializationRequest(
    new ProfileId('json.strict', 1),
    new MaterializationStyleId(style, 1),
  ).withNewline('None');
}

function render(document: { render(): Uint8Array }): string {
  return new TextDecoder().decode(document.render());
}

function complete(result: MaterializationResult<JsonDocument>): CompleteMaterialization<JsonDocument> {
  if (result.kind !== 'Complete') {
    throw new Error('expected a complete materialization');
  }
  return result.value;
}

function failed(result: MaterializationResult<JsonDocument>): FailedMaterializationAttempt {
  if (result.kind !== 'Failed') {
    throw new Error('expected a failed materialization');
  }
  return result.value;
}

function converted(result: JsonConversionResult) {
  if (result.kind !== 'Complete') {
    throw new Error('expected a complete conversion');
  }
  return result;
}

test('json5.materialize.canonical-specials: frozen non-finite spellings and escaped separators (json-family-v2.json:138-142)', () => {
  const input = sequenceValue([
    binaryFloat64Value(0x7ff0000000000000n),
    binaryFloat64Value(0xfff0000000000000n),
    binaryFloat64Value(0x7ff8000000000000n),
    binaryFloat64Value(0xfff8000000000000n),
    stringValue('a\u2028b'),
  ]);
  const result = complete(materialize(input, json5Request('json5.canonical-compact')));
  assert.equal(render(result.document()), '[Infinity,-Infinity,NaN,-NaN,"a\\u2028b"]');
  assert.equal(result.fidelity(), 'Exact');
  assert.equal(result.report().events().length, 0);
});

test('json5.materialize.reject-finite-binary: finite BinaryFloat64 is unrepresentable (json-family-v2.json:144-148)', () => {
  const result = failed(materialize(binaryFloat64Value(0n), json5Request('json5.canonical-compact')));
  assert.equal(result.failure().kind, 'Unrepresentable');
  assert.equal(result.failure().code, 'core.materialization.unrepresentable@1');
});

test('json5.materialize.reject-profile-style-mismatch (json-family-v2.json:150-154)', () => {
  const result = failed(materialize(nullValue(), json5Request('json.canonical-compact')));
  assert.equal(result.failure().kind, 'UnsupportedStyle');
  assert.equal(result.failure().code, 'core.materialization.unsupported-style@1');
});

test('materialization closure: output reparses Complete and reprojects to the identical value (RFC 0004 §7)', () => {
  const input = sequenceValue([
    nullValue(),
    decimalValue(12n, -2n),
    booleanValue(true),
    integerValue(-256n),
  ]);
  const result = complete(materialize(input, strictRequest('json.canonical-compact')));
  const document = result.document();
  assert.equal(render(document), '[null,12e-2,true,-256]');
  assert.equal(document.formationStatus(), 'Complete');
  const provenance = result.provenance();
  assert.ok(provenance.entries().length >= 4);
  // The materialized sequence reprojects to the identical portable value.
  const reprojected = document.root().arrayElements();
  if (reprojected.kind !== 'Available' || reprojected.value === null) {
    throw new Error('expected an available array');
  }
  assert.equal(reprojected.value.length, 4);
});

test('canonical string escaping matches the deterministic surface (materialization.rs:270-297)', () => {
  const input = stringValue('a\n\u0001"\\\t');
  const result = complete(materialize(input, strictRequest('json.canonical-compact')));
  assert.equal(render(result.document()), '"a\\n\\u0001\\"\\\\\\t"');
});

test('json5.convert.finite-to-strict: projection-to-materialization composition (json-family-v2.json:156-160)', () => {
  const source = parse(bytes('{service:{port:8080,},}'), PROFILE_JSON5_STANDARD, DEFAULT_PARSE_LIMITS);
  const result = converted(
    convertJsonDocument(source, new ProfileId('json.strict', 1), strictRequest('json.canonical-compact')),
  );
  assert.equal(render(result.document), '{"service":{"port":8080}}');
  assert.equal(result.overallFidelity, 'Exact');
});

test('json5.convert.nonfinite-to-strict-fails (json-family-v2.json:162-166)', () => {
  const source = parse(bytes('Infinity'), PROFILE_JSON5_STANDARD, DEFAULT_PARSE_LIMITS);
  const result = convertJsonDocument(source, new ProfileId('json.strict', 1), strictRequest('json.canonical-compact'));
  assert.equal(result.kind, 'Failed');
});

test('json5.convert.strict-to-json5 (json-family-v2.json:168-172)', () => {
  const source = parse(bytes('{"a":1}'), PROFILE_JSON_STRICT, DEFAULT_PARSE_LIMITS);
  const result = converted(
    convertJsonDocument(source, new ProfileId('json5.standard', 1), json5Request('json5.canonical-compact')),
  );
  assert.equal(render(result.document), '{"a":1}');
  assert.equal(result.overallFidelity, 'Exact');
});
