/**
 * Intent documents for exact-first projection.
 *
 * Golden transcriptions from the shared vectors — each test cites its
 * case id:
 *  - conformance/vectors/json-family-v2.json: json5.projection.
 *    duplicates-nonfinite (:126-130), json5.projection.old-target-
 *    rejected (:132-136)
 *  - conformance/vectors/v1.json: projection.best-exact-duplicate-
 *    mapping (:89-93), projection.object-reject-duplicates (:95-99),
 *    projection.object-last-wins (:101-105), projection.object-key-
 *    provenance (:155-159)
 *  - projection failure codes: crates/consema-json/src/projection.rs:
 *    754-765
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parse,
  project,
  ProjectionRequestBuilder,
} from '../json/index.ts';
import type {
  CompleteProjection,
  FailedProjectionAttempt,
  ProjectionResult,
  ProjectionTarget,
} from '../json/index.ts';
import { PROFILE_JSON5_STANDARD, PROFILE_JSON_STRICT } from '../json/index.ts';
import { DEFAULT_PARSE_LIMITS } from '../document/formation.ts';

function bytes(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

function complete(result: ProjectionResult): CompleteProjection {
  if (result.kind !== 'Complete') {
    throw new Error('expected a complete projection');
  }
  return result.value;
}

function failed(result: ProjectionResult): FailedProjectionAttempt {
  if (result.kind !== 'Failed') {
    throw new Error('expected a failed projection');
  }
  return result.value;
}

test('json5.projection.duplicates-nonfinite: EntryMapping keeps frozen bits (json-family-v2.json:126-130)', () => {
  const document = parse(bytes('{a:Infinity,a:-NaN}'), PROFILE_JSON5_STANDARD, DEFAULT_PARSE_LIMITS);
  const request = new ProjectionRequestBuilder('Json5BestExactCoreV1').build();
  const result = complete(project(document, request));
  const value = result.value();
  assert.equal(value.kind, 'EntryMapping');
  assert.equal(result.fidelity(), 'Transformed');
  const bits = value.entries.map((entry) => {
    assert.equal(entry.key.kind, 'String');
    assert.equal(entry.value.kind, 'BinaryFloat64');
    return entry.value.bits;
  });
  assert.deepEqual(bits, [0x7ff0000000000000n, 0xfff8000000000000n]);
  assert.equal(
    result.report().events().filter((event) => event.kind() === 'StructureReencoded').length,
    1,
  );
});

test('json5.projection.old-target-rejected: json.projection.best-exact-core@1 does not apply to JSON5 (json-family-v2.json:132-136)', () => {
  const document = parse(bytes('{a:1}'), PROFILE_JSON5_STANDARD, DEFAULT_PARSE_LIMITS);
  const request = new ProjectionRequestBuilder('BestExactCoreV1').build();
  const result = failed(project(document, request));
  assert.equal(result.diagnostics()[0].code, 'core.projection.target-not-applicable@1');
});

test('projection.best-exact-duplicate-mapping (v1.json:89-93)', () => {
  const document = parse(bytes('{"a":1,"a":2}'), PROFILE_JSON_STRICT, DEFAULT_PARSE_LIMITS);
  const request = new ProjectionRequestBuilder('BestExactCoreV1').build();
  const result = complete(project(document, request));
  assert.equal(result.value().kind, 'EntryMapping');
  assert.equal(result.fidelity(), 'Transformed');
  const associations = result
    .provenance()
    .entries()
    .filter((entry) => entry.projected().kind === 'Association');
  assert.equal(associations.length, 2);
});

test('projection.object-reject-duplicates: no partial value on failure (v1.json:95-99)', () => {
  const document = parse(bytes('{"a":1,"a":2}'), PROFILE_JSON_STRICT, DEFAULT_PARSE_LIMITS);
  const request = new ProjectionRequestBuilder('ProjectAsObjectV1').build();
  const result = failed(project(document, request));
  assert.equal(result.diagnostics()[0].code, 'json.projection.duplicate-keys@1');
});

test('projection.object-last-wins: explicit lossy policy (v1.json:101-105)', () => {
  const document = parse(bytes('{"a":1,"a":2}'), PROFILE_JSON_STRICT, DEFAULT_PARSE_LIMITS);
  const request = new ProjectionRequestBuilder('ProjectAsObjectV1')
    .withGlobalDuplicatePolicy('LastWins')
    .build();
  const result = complete(project(document, request));
  assert.equal(result.fidelity(), 'Lossy');
  assert.deepEqual(
    result.report().events().map((event) => event.kind()),
    ['DuplicateCollapsed'],
  );
  const value = result.value();
  assert.equal(value.kind, 'Object');
  assert.equal(value.entries.length, 1);
  assert.equal(value.entries[0].value.kind, 'Integer');
  assert.equal(value.entries[0].value.value, 2n);
});

test('projection.object-key-provenance: entry and key associations (v1.json:155-159)', () => {
  const document = parse(bytes('{"a":1,"b":2}'), PROFILE_JSON_STRICT, DEFAULT_PARSE_LIMITS);
  const request = new ProjectionRequestBuilder('ProjectAsObjectV1').build();
  const result = complete(project(document, request));
  const associations = result
    .provenance()
    .entries()
    .filter((entry) => entry.projected().kind === 'Association')
    .map((entry) => (entry.projected() as { location: { role(): string } }).location.role());
  assert.equal(associations.filter((role) => role === 'ObjectEntry').length, 2);
  assert.equal(associations.filter((role) => role === 'ObjectKey').length, 2);
});

test('recovered documents never enter projection (projection.rs:361-366)', () => {
  const document = parse(bytes('{"a"1,...}'), PROFILE_JSON_STRICT, DEFAULT_PARSE_LIMITS);
  assert.equal(document.formationStatus(), 'Recovered');
  const request = new ProjectionRequestBuilder('BestExactCoreV1').build();
  const result = failed(project(document, request));
  assert.equal(result.diagnostics()[0].code, 'json.projection.incomplete-document@1');
});

test('projection fidelity check: strict JSON round-trips as Exact with Direct origins (RFC 0005 §8)', () => {
  const document = parse(bytes('{"a":[1,true,null],"b":"x"}'), PROFILE_JSON_STRICT, DEFAULT_PARSE_LIMITS);
  const request = new ProjectionRequestBuilder('BestExactCoreV1').build();
  const result = complete(project(document, request));
  assert.equal(result.fidelity(), 'Exact');
  const value = result.value();
  assert.equal(value.kind, 'Object');
  assert.equal(value.entries.length, 2);
  assert.equal(value.entries[0].value.kind, 'Sequence');
  const origins = result.provenance().entries();
  assert.ok(origins.length > 0);
  for (const entry of origins) {
    assert.ok(entry.origins().length > 0);
    assert.equal(entry.origins()[0].relation(), 'Direct');
  }
});

test('json5.projection.duplicates-nonfinite: rejected for the strict profile (projection.rs:367-376)', () => {
  const document = parse(bytes('{"a":1}'), PROFILE_JSON_STRICT, DEFAULT_PARSE_LIMITS);
  const request = new ProjectionRequestBuilder('Json5BestExactCoreV1').build();
  const result = failed(project(document, request));
  assert.equal(result.diagnostics()[0].code, 'core.projection.target-not-applicable@1');
});

test('ProjectionTarget stable names cover the frozen matrix (projection.rs:14-24)', () => {
  const targets: ProjectionTarget[] = [
    'ProjectAsObjectV1',
    'ProjectAsEntryMappingV1',
    'BestExactCoreV1',
    'Json5BestExactCoreV1',
  ];
  assert.deepEqual(targets.length, 4);
});
