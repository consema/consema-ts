/**
 * TOML projection intent tests — the explicit best-exact-core projection
 * with fidelity, report, and provenance.
 *
 * These are blind-written intent documents (docs/multi-language-implementation
 * -plan.md §3): they transcribe the language-neutral facts from
 * conformance/vectors/toml-v1.json and crates/consema-toml/src/projection.rs
 * and run once the toolchain is ready. Golden cases cited: toml-v1.json
 * case ids are named in each test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { DEFAULT_PARSE_LIMITS } from '../document/formation.ts';
import { parseToml } from './document.ts';
import { TomlProfile } from './profile.ts';
import {
  projectToml,
  TomlProjectionRequest,
  TOML_PROJECTION_TARGET_BEST_EXACT_CORE_V1,
} from './projection.ts';
import type { TomlProjectionResult } from './projection.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../../conformance/fixtures/toml');

function parseFixture(name: string) {
  return parseToml(readFileSync(resolve(FIXTURES, name)), TomlProfile.TOML_10_V1, DEFAULT_PARSE_LIMITS);
}

function parseSource(source: string) {
  return parseToml(new TextEncoder().encode(source), TomlProfile.TOML_10_V1, DEFAULT_PARSE_LIMITS);
}

function project(document: ReturnType<typeof parseSource>): TomlProjectionResult {
  return projectToml(document, new TomlProjectionRequest(TOML_PROJECTION_TARGET_BEST_EXACT_CORE_V1));
}

test('golden toml.projection.all-core-kinds: all-values.toml projects Exact to an Object', () => {
  // conformance/vectors/toml-v1.json:53-58 (expected status Success,
  // fidelity Exact, root Object).
  const result = project(parseFixture('all-values.toml'));
  assert.equal(result.kind, 'Complete');
  const complete = result.value;
  assert.equal(complete.fidelity(), 'Exact');
  assert.equal(complete.report().events().length, 0);
  const value = complete.value();
  assert.equal(value.kind, 'Object');
  const keys = value.entries.map((entry) => entry.key);
  assert.deepEqual(keys, [
    'title', 'enabled', 'integer', 'hex', 'float', 'positive_infinity',
    'not_a_number', 'local_date', 'local_time', 'local_date_time',
    'offset_date_time', 'ports', 'point',
  ]);
  const byName = new Map(value.entries.map((entry) => [entry.key, entry.value]));
  assert.equal((byName.get('title') as { kind: string; value: string }).value, 'Consema fixture');
  assert.equal((byName.get('enabled') as { kind: string; value: boolean }).value, true);
  assert.equal((byName.get('integer') as { kind: string; value: bigint }).value, 42n);
  assert.equal((byName.get('hex') as { kind: string; value: bigint }).value, 0xdeadbeefn);
  const float = byName.get('float') as { kind: string; bits: bigint };
  assert.equal(float.kind, 'BinaryFloat64');
  assert.equal(float.bits, 0x8000000000000000n); // -0.0
  const ports = byName.get('ports') as { kind: string; items: readonly unknown[] };
  assert.equal(ports.kind, 'Sequence');
  assert.equal(ports.items.length, 3);
  const point = byName.get('point') as { kind: string; entries: readonly { key: string }[] };
  assert.equal(point.kind, 'Object');
  assert.deepEqual(point.entries.map((entry) => entry.key), ['x', 'y']);
});

test('golden toml.projection.provenance: every value and association maps to snapshot-bound origins', () => {
  // conformance/vectors/toml-v1.json:59-64 (source "point = { x = 1, y = 2 }\n";
  // expected all_origins_snapshot_bound true, object_associations_present true).
  const result = project(parseSource('point = { x = 1, y = 2 }\n'));
  assert.equal(result.kind, 'Complete');
  const provenance = result.value.provenance().entries();
  assert.ok(provenance.length > 0);
  const snapshot = provenance[0].origins()[0].snapshot();
  for (const entry of provenance) {
    for (const origin of entry.origins()) {
      assert.ok(origin.snapshot().equals(snapshot), 'every origin is snapshot-bound');
    }
  }
  const associations = provenance.filter((entry) => entry.projected().kind === 'Association');
  assert.ok(associations.length > 0, 'object associations are present');
  const associationRoles = associations.map((entry) => {
    const projected = entry.projected();
    return projected.kind === 'Association' ? projected.location.role() : null;
  });
  assert.ok(associationRoles.includes('ObjectEntry'));
  assert.ok(associationRoles.includes('ObjectKey'));
  // Root value origin is Direct with the root item role.
  const rootOrigin = provenance.find((entry) => {
    const projected = entry.projected();
    return projected.kind === 'Value' && projected.path.segments().length === 0;
  });
  assert.ok(rootOrigin !== undefined);
  assert.equal(rootOrigin!.origins()[0].node().role(), 'TomlItem');
  assert.equal(rootOrigin!.origins()[0].relation(), 'Direct');
});

test('golden toml.projection.reject-leap-second: second 60 fails the whole projection', () => {
  // conformance/vectors/toml-v1.json:65-70 (source "time = 23:59:60\n";
  // expected status Failed, diagnostic toml.projection.unrepresentable-datetime@1,
  // partial_value false).
  const result = project(parseSource('time = 23:59:60\n'));
  assert.equal(result.kind, 'Failed');
  const diagnostics = result.value.diagnostics();
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'toml.projection.unrepresentable-datetime@1');
  assert.equal(diagnostics[0].category, 'Projection');
});

test('table-vs-object distinction: table flavors survive natively and meet Object only here', () => {
  // RFC 0001 §2 and docs/IMPLEMENTATION.md:102 — a DottedTable and a
  // StandardTable project to the same Object shape, but the native item
  // kinds remain distinct before projection.
  const document = parseSource('a.b = 1\n[c]\nd = 2\n');
  assert.equal(document.root().tableEntries()![0].item().kind(), 'DottedTable');
  assert.equal(document.root().tableEntries()![1].item().kind(), 'StandardTable');
  const result = project(document);
  assert.equal(result.kind, 'Complete');
  const object = result.value.value();
  assert.equal(object.kind, 'Object');
  assert.deepEqual(
    object.entries.map((entry) => entry.key),
    ['a', 'c'],
  );
});

test('projection resource limits fail without partial values', () => {
  const document = parseSource('a = 1\nb = 2\n');
  const result = projectToml(
    document,
    new TomlProjectionRequest(TOML_PROJECTION_TARGET_BEST_EXACT_CORE_V1, {
      maxValueNodes: 1,
      maxReportEntries: 100_000,
      maxProvenanceEntries: 2_000_000,
      maxDepth: 256,
    }),
  );
  assert.equal(result.kind, 'Failed');
  assert.equal(result.value.diagnostics()[0].code, 'core.projection.resource-limit@1');
  assert.equal(result.value.partialAnalysis().length, 0);
});
