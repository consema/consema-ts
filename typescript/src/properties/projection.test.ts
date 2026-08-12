/**
 * Intent documents for Java Properties projection.
 *
 * Golden transcriptions from the shared vectors — each test cites its
 * case id:
 *  - conformance/vectors/java-properties-v1.json:
 *    projection.exact-duplicates-and-fragments (:76-79),
 *    projection.unpaired-and-recovered-atomic-failure (:81-84),
 *    projection.explicit-jdk-table-collapse (:86-89),
 *    resource.projection-limit-matrix (:142-145)
 *  - RFC 0010 §11 (:310-349) freezes the projection surface
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PROPERTIES_PARSE_LIMITS } from '../properties/parse_limits.ts';
import { parseReader } from '../properties/parser.ts';
import { project, ProjectionRequest, DEFAULT_PROJECTION_LIMITS } from '../properties/projection.ts';
import { utf8Encoding } from '../document/source.ts';

function bytes(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

function parse(source: string) {
  return parseReader(bytes(source), utf8Encoding(), DEFAULT_PROPERTIES_PARSE_LIMITS);
}

test('projection.exact-duplicates-and-fragments: EntryMapping with fragmented provenance (java-properties-v1.json:76-79)', () => {
  const document = parse('a\\ key=one\\\n two\\u0021\na\\ key=last\n');
  const result = project(document, ProjectionRequest.bestExactEntryMapping());
  assert.equal(result.kind, 'Complete');
  if (result.kind !== 'Complete') return;
  assert.equal(result.value.fidelity(), 'Exact');
  assert.equal(result.value.report().events().length, 0);
  const mapping = result.value.value();
  assert.equal(mapping.kind, 'EntryMapping');
  if (mapping.kind !== 'EntryMapping') return;
  assert.deepEqual(
    mapping.entries.map((entry) => (entry.key.kind === 'String' ? entry.key.value : null)),
    ['a key', 'a key'],
  );
  assert.deepEqual(
    mapping.entries.map((entry) => (entry.value.kind === 'String' ? entry.value.value : null)),
    ['onetwo!', 'last'],
  );
  const provenance = result.value.provenance();
  assert.ok(
    provenance
      .entries()
      .some((entry) => entry.origins().some((origin) => origin.relation() === 'EscapeDerived')),
  );
  assert.ok(
    provenance
      .entries()
      .some(
        (entry) =>
          entry.origins().filter((origin) => origin.relation() === 'ValueFragment').length === 2,
      ),
  );
  assert.ok(
    provenance
      .entries()
      .some((entry) => entry.projected().kind === 'Association'),
  );
});

test('projection.unpaired-and-recovered-atomic-failure: no partial value (java-properties-v1.json:81-84)', () => {
  const unpaired = parse('a=ok\nb=\\uD800');
  const unpairedResult = project(unpaired, ProjectionRequest.bestExactEntryMapping());
  assert.equal(unpairedResult.kind, 'Failed');
  if (unpairedResult.kind !== 'Failed') return;
  assert.equal(unpairedResult.value.diagnostics()[0].code, 'java-properties.projection.unpaired-surrogate@1');
  assert.equal(
    Number(unpairedResult.value.diagnostics()[0].primary?.startByte),
    5,
  );
  assert.equal(unpairedResult.value.report().events().length, 0);

  const recovered = parse('good=ok\nbad=\\u12G4');
  const recoveredResult = project(recovered, ProjectionRequest.bestExactEntryMapping());
  assert.equal(recoveredResult.kind, 'Failed');
  if (recoveredResult.kind !== 'Failed') return;
  assert.equal(recoveredResult.value.diagnostics()[0].code, 'java-properties.projection.incomplete-document@1');
  assert.equal(recoveredResult.value.report().events().length, 0);
});

test('projection.explicit-jdk-table-collapse: RequireUnique, FirstWins, LastWinsJdkTable (java-properties-v1.json:86-89)', () => {
  const document = parse('a=first\nb=middle\na=last\n');

  const unique = project(document, ProjectionRequest.requireObject('RequireUnique'));
  assert.equal(unique.kind, 'Failed');
  if (unique.kind !== 'Failed') return;
  assert.equal(unique.value.diagnostics()[0].code, 'core.projection.target-not-applicable@1');

  const first = project(document, ProjectionRequest.requireObject('FirstWins'));
  assert.equal(first.kind, 'Complete');
  if (first.kind !== 'Complete') return;
  assert.equal(first.value.fidelity(), 'Lossy');
  assert.equal(first.value.report().events().length, 1);
  assert.equal(first.value.report().events()[0].code(), 'java-properties.projection.duplicate-collapsed@1');
  assert.deepEqual(objectPairs(first.value.value()), [['a', 'first'], ['b', 'middle']]);
  assert.ok(
    first.value
      .provenance()
      .entries()
      .some((entry) => entry.origins().some((origin) => origin.relation() === 'Collapsed')),
  );

  const last = project(document, ProjectionRequest.requireObject('LastWinsJdkTable'));
  assert.equal(last.kind, 'Complete');
  if (last.kind !== 'Complete') return;
  assert.deepEqual(objectPairs(last.value.value()), [['b', 'middle'], ['a', 'last']]);
});

test('resource.projection-limit-matrix: every limit fails atomically (java-properties-v1.json:142-145)', () => {
  const document = parse('a=1\n');
  const names: readonly { name: string; limits: typeof DEFAULT_PROJECTION_LIMITS }[] = [
    { name: 'max_source_associations', limits: { ...DEFAULT_PROJECTION_LIMITS, maxSourceAssociations: 0 } },
    { name: 'max_value_nodes', limits: { ...DEFAULT_PROJECTION_LIMITS, maxValueNodes: 1 } },
    { name: 'max_provenance_units', limits: { ...DEFAULT_PROJECTION_LIMITS, maxProvenanceUnits: 1 } },
  ];
  let failedCount = 0;
  for (const descriptor of names) {
    const result = project(
      document,
      ProjectionRequest.bestExactEntryMapping().withLimits(descriptor.limits),
    );
    assert.equal(result.kind, 'Failed', descriptor.name);
    if (result.kind === 'Failed') {
      assert.equal(result.value.diagnostics()[0].code, 'core.projection.resource-limit@1');
      failedCount += 1;
    }
  }
  // The report limit fails on the explicit duplicate collapse.
  const duplicate = parse('a=1\na=2\n');
  const reportResult = project(
    duplicate,
    ProjectionRequest.requireObject('FirstWins').withLimits({
      ...DEFAULT_PROJECTION_LIMITS,
      maxReportEntries: 0,
    }),
  );
  assert.equal(reportResult.kind, 'Failed');
  if (reportResult.kind === 'Failed') {
    assert.equal(reportResult.value.diagnostics()[0].code, 'core.projection.resource-limit@1');
    failedCount += 1;
  }
  assert.equal(failedCount, 4);
});

function objectPairs(value: unknown): [string, string][] {
  assert.ok(value !== null && typeof value === 'object' && 'kind' in value);
  const object = value as { kind: string; entries: { key: string; value: { kind: string; value: string } }[] };
  assert.equal(object.kind, 'Object');
  return object.entries.map((entry) => [entry.key, entry.value.value]);
}
