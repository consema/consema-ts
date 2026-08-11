/**
 * Intent documents for YAML graph and value projection.
 *
 * Golden transcriptions from the shared vectors — each test cites its
 * case id in conformance/vectors/yaml-v1.json:
 *  - graph.shared-cycle (:46-49, pgce hex), projection.sharing-policy
 *    (:71-74), projection.cycle (:76-79), projection.tag-policy (:81-84),
 *    projection.mapping-policy (:86-89), projection.graph-provenance
 *    (:91-94), resource.graph-provenance (:131-134)
 * Projection semantics: RFC 0007 §10; crates/consema-yaml/src/projection.rs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parse,
  projectGraph,
  projectGraphWithProvenance,
  projectValueComplete,
  GraphProjectionRequest,
  ValueProjectionRequest,
  GraphProjectionFailure,
  ValueProjectionFailure,
  defaultGraphProjectionLimits,
} from './index.ts';
import { PROFILE_YAML12_CORE } from './index.ts';
import { DEFAULT_PARSE_LIMITS } from '../document/formation.ts';
import { encodePGCE } from '../graph/pgce.ts';
import { toHex } from './test_helpers.ts';

function core(source: string) {
  return parse(new TextEncoder().encode(source), PROFILE_YAML12_CORE, DEFAULT_PARSE_LIMITS);
}

test('graph.shared-cycle — exact PGCE golden bytes (yaml-v1.json:46-49)', () => {
  const document = core('&root [one, *root]\n');
  const graph = projectGraph(document);
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.roots.length, 1);
  assert.equal(
    toHex(encodePGCE(graph)),
    '504743450101020040157461673a79616d6c2e6f72672c323030323a73657102010020157461673a79616d6c2e6f72672c323030323a737472036f6e65',
  );
});

test('projection.sharing-policy — reject by default, report duplication when authorized (yaml-v1.json:71-74)', () => {
  const document = core('[&x {k: v}, *x]\n');
  const rejected = projectValueComplete(document, ValueProjectionRequest.bestExactV1());
  assert.equal(rejected.kind, 'Failed');
  if (rejected.kind === 'Failed') {
    assert.equal(rejected.failure.kind, 'Sharing');
    assert.equal(rejected.failure.code, 'yaml.projection.sharing@1');
  }
  const duplicated = projectValueComplete(
    document,
    ValueProjectionRequest.bestExactV1().withSharing('DuplicateAcyclic'),
  );
  assert.equal(duplicated.kind, 'Complete');
  if (duplicated.kind === 'Complete') {
    assert.equal(duplicated.complete.fidelity, 'Transformed');
    assert.equal(duplicated.complete.report.events().length, 3);
    assert.ok(
      duplicated.complete.report.events().every((event) => event.kind === 'SharingDuplicated'),
    );
  }
});

test('projection.cycle — cycles never enter PortableValue trees (yaml-v1.json:76-79)', () => {
  const document = core('&x [*x]\n');
  const result = projectValueComplete(document, ValueProjectionRequest.bestExactV1());
  assert.equal(result.kind, 'Failed');
  if (result.kind === 'Failed') {
    assert.equal(result.failure.kind, 'Cycle');
    assert.equal(result.failure.code, 'yaml.projection.cycle@1');
  }
});

test('projection.tag-policy — custom tags need explicit stripping (yaml-v1.json:81-84)', () => {
  const document = core('!example value\n');
  const rejected = projectValueComplete(document, ValueProjectionRequest.bestExactV1());
  assert.equal(rejected.kind, 'Failed');
  if (rejected.kind === 'Failed') {
    assert.equal(rejected.failure.kind, 'UnsupportedTag');
    assert.equal(rejected.failure.code, 'yaml.projection.unsupported-tag@1');
    assert.equal(rejected.failure.tag, '!example');
  }
  const stripped = projectValueComplete(
    document,
    ValueProjectionRequest.bestExactV1().withTags('StripToNodeKind'),
  );
  assert.equal(stripped.kind, 'Complete');
  if (stripped.kind === 'Complete') {
    const value = stripped.complete.value;
    assert.equal(value.kind, 'String');
    assert.equal(value.value, 'value');
    assert.ok(
      stripped.complete.report.events().some((event) => event.kind === 'TagStripped'),
    );
  }
});

test('projection.mapping-policy — duplicates fall back to EntryMapping (yaml-v1.json:86-89)', () => {
  const document = core('{a: 1, a: 2}\n');
  const exact = projectValueComplete(document, ValueProjectionRequest.bestExactV1());
  assert.equal(exact.kind, 'Complete');
  if (exact.kind === 'Complete') {
    const value = exact.complete.value;
    assert.equal(value.kind, 'EntryMapping');
    assert.equal(value.entries.length, 2);
  }
  const object = projectValueComplete(
    document,
    ValueProjectionRequest.bestExactV1().withMapping('RequireObject'),
  );
  assert.equal(object.kind, 'Failed');
  if (object.kind === 'Failed') {
    assert.equal(object.failure.kind, 'MappingNotObject');
    assert.equal(object.failure.code, 'yaml.projection.mapping-not-object@1');
  }
});

test('projection.graph-provenance — alias origins are Reference (yaml-v1.json:91-94)', () => {
  const document = core('&root [one, *root]\n');
  const result = projectGraphWithProvenance(document, GraphProjectionRequest.bestExactV1());
  const entries = result.provenance.entries();
  const associationEntries = entries.filter((entry) => {
    return (
      entry.projected.kind === 'SequenceElement' ||
      entry.projected.kind === 'MappingKey' ||
      entry.projected.kind === 'MappingValue'
    );
  });
  assert.equal(associationEntries.length, 2);
  const referenceOrigins = entries.flatMap((entry) =>
    entry.origins.filter((origin) => origin.relation === 'Reference'),
  );
  assert.equal(referenceOrigins.length, 1);
});

test('resource.graph-provenance — provenance limit is atomic (yaml-v1.json:131-134)', () => {
  const document = core('[one, two]\n');
  const limits = defaultGraphProjectionLimits();
  assert.throws(
    () =>
      projectGraphWithProvenance(
        document,
        GraphProjectionRequest.bestExactV1().withLimits({
          ...limits,
          maxProvenanceEntries: 1,
        }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof GraphProjectionFailure);
      assert.equal(error.kind, 'ProvenanceLimit');
      assert.equal(error.code, 'yaml.projection.provenance-limit@1');
      return true;
    },
  );
});

test('graph projection rejects custom tags with the frozen code', () => {
  const document = core('!application/object payload\n');
  assert.throws(
    () => projectGraph(document),
    (error: unknown) => {
      assert.ok(error instanceof GraphProjectionFailure);
      assert.equal(error.kind, 'UnsupportedTag');
      assert.equal(error.code, 'yaml.projection.unsupported-tag@1');
      assert.equal(error.tag, '!application/object');
      return true;
    },
  );
});

test('value projection of standard scalars keeps exact categories', () => {
  const document = core('{a: [1, true, 1.5]}\n');
  const result = projectValueComplete(document, ValueProjectionRequest.bestExactV1());
  assert.equal(result.kind, 'Complete');
  if (result.kind === 'Complete') {
    const value = result.complete.value;
    assert.equal(value.kind, 'Object');
    const sequence = value.entries[0].value;
    assert.equal(sequence.kind, 'Sequence');
    assert.deepEqual(
      sequence.items.map((item) => item.kind),
      ['Integer', 'Boolean', 'Decimal'],
    );
    if (sequence.items[2].kind === 'Decimal') {
      assert.equal(sequence.items[2].coefficient, 15n);
      assert.equal(sequence.items[2].exponent, -1n);
    }
  }
});
