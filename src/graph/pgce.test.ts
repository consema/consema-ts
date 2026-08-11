/**
 * PGCE/1 codec intent tests with golden bytes.
 *
 * The golden vectors are transcribed from conformance/vectors/portable-
 * graph-v1.json (pgce.empty-vector, pgce.scalar-vector, pgce.cycle-roundtrip,
 * pgce.reject-nonminimal-varint, pgce.reject-noncanonical-node-order) and
 * cross-checked against the Rust frozen vectors
 * (crates/consema-graph/src/pgce.rs:664-686). They run once the toolchain is
 * ready; no gate is claimed before that (§7 START GATE).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Builder, defaultLimits } from './graph.ts';
import { equal } from './equal.ts';
import {
  encodePGCE,
  decodePGCE,
  encodePGCERecords,
  defaultPgceLimits,
} from './pgce.ts';
import type { PgceLimits } from './pgce.ts';
import { PGCEError } from './errors.ts';

const STR = 'tag:yaml.org,2002:str';
const SEQ = 'tag:yaml.org,2002:seq';
const MAP = 'tag:yaml.org,2002:map';

function hex(bytes: Uint8Array): string {
  return [...bytes].map((octet) => octet.toString(16).padStart(2, '0')).join('');
}

function unhex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const LIMITS: PgceLimits = defaultPgceLimits();

function scalarGraph(content: string) {
  const builder = new Builder(defaultLimits());
  const root = builder.reserveNode();
  builder.defineScalar(root, STR, content);
  builder.pushRoot(root);
  return builder.build();
}

test('vector pgce.empty-vector: the empty graph encodes to the frozen bytes', () => {
  // conformance/vectors/portable-graph-v1.json; crates/consema-graph/src/pgce.rs:681-686.
  const graph = new Builder(defaultLimits()).build();
  assert.equal(hex(encodePGCE(graph)), '50474345010000');
  const decoded = decodePGCE(unhex('50474345010000'), LIMITS);
  assert.equal(equal(decoded, graph), true);
});

test('vector pgce.scalar-vector: one scalar root encodes to the frozen bytes', () => {
  // conformance/vectors/portable-graph-v1.json; crates/consema-graph/src/pgce.rs:664-678.
  const graph = scalarGraph('x');
  assert.equal(
    hex(encodePGCE(graph)),
    '504743450101010020157461673a79616d6c2e6f72672c323030323a7374720178',
  );
  const decoded = decodePGCE(
    unhex('504743450101010020157461673a79616d6c2e6f72672c323030323a7374720178'),
    LIMITS,
  );
  assert.equal(equal(decoded, graph), true);
});

test('vector pgce.cycle-roundtrip: cyclic graphs round-trip byte-stably', () => {
  // conformance/vectors/portable-graph-v1.json.
  const builder = new Builder(defaultLimits());
  const root = builder.reserveNode();
  builder.defineSequence(root, SEQ, [root]);
  builder.pushRoot(root);
  const graph = builder.build();
  const bytes = encodePGCE(graph);
  const decoded = decodePGCE(bytes, LIMITS);
  assert.equal(equal(decoded, graph), true);
  assert.equal(hex(encodePGCE(decoded)), hex(bytes));
});

test('vector pgce.reject-nonminimal-varint: non-minimal varint fails', () => {
  // conformance/vectors/portable-graph-v1.json.
  assert.throws(
    () => decodePGCE(unhex('5047434581000000'), LIMITS),
    (e: unknown) =>
      (e as PGCEError).kind === 'NonMinimalVarint' &&
      (e as PGCEError).code === 'core.pgce.non-canonical@1',
  );
});

test('vector pgce.reject-noncanonical-node-order: wire numbering must be first-discovery', () => {
  // conformance/vectors/portable-graph-v1.json; the stream names root node 1
  // before node 0 is discovered.
  const stream = unhex(
    '504743450101020120157461673a79616d6c2e6f72672c323030323a737472017840157461673a79616d6c2e6f72672c323030323a7365710100',
  );
  assert.throws(
    () => decodePGCE(stream, LIMITS),
    (e: unknown) =>
      (e as PGCEError).kind === 'NonCanonicalNodeOrder' &&
      (e as PGCEError).code === 'core.pgce.non-canonical@1',
  );
});

test('decoding rejects trailing bytes, bad magic, and unsupported versions', () => {
  const scalar = encodePGCE(scalarGraph('x'));
  assert.throws(() => decodePGCE(concat(scalar, Uint8Array.of(0)), LIMITS), (e: unknown) =>
    (e as PGCEError).kind === 'TrailingBytes',
  );
  const badMagic = Uint8Array.from([0x50, 0x47, 0x43, 0x45 ^ 0x01, ...scalar.subarray(4)]);
  assert.throws(() => decodePGCE(badMagic, LIMITS), (e: unknown) =>
    (e as PGCEError).kind === 'InvalidMagic',
  );
  const versionTwo = Uint8Array.from([...scalar.subarray(0, 4), 0x02, ...scalar.subarray(5)]);
  assert.throws(() => decodePGCE(versionTwo, LIMITS), (e: unknown) =>
    (e as PGCEError).kind === 'UnsupportedVersion',
  );
});

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

test('decoding rejects out-of-range references', () => {
  // A scalar graph whose root reference is 1 while node_count is 1.
  const stream = unhex('50474345010101012001610178');
  // magic version roots=01 nodes=01 root=01 ... the root reference 1 is out of range.
  assert.throws(
    () => decodePGCE(stream, LIMITS),
    (e: unknown) =>
      (e as PGCEError).kind === 'ReferenceOutOfRange' &&
      (e as PGCEError).value === 1n,
  );
});

test('decoding rejects unknown node kind octets', () => {
  // roots=0, nodes=1, kind octet 0x10 (unassigned), empty tag.
  const stream = unhex('504743450100011000');
  assert.throws(
    () => decodePGCE(stream, LIMITS),
    (e: unknown) =>
      (e as PGCEError).kind === 'UnknownNodeKind' &&
      (e as PGCEError).code === 'core.pgce.invalid@1',
  );
});

test('decoding rejects invalid tags and invalid UTF-8', () => {
  // One scalar node whose tag is a single space (invalid tag), roots=1.
  // The root reference must be 0 with node_count 1 (the InvalidUtf8 stream
  // below shows the correct root=00 layout).
  const badTag = unhex('50474345010101002001200178');
  // node record: kind 20, tag blob len 01, byte 0x20 (space), content blob len 01 'x'
  assert.throws(
    () => decodePGCE(badTag, LIMITS),
    (e: unknown) => (e as PGCEError).kind === 'InvalidTag',
  );
  // One scalar node whose content is an invalid UTF-8 byte.
  // Root reference must be 0 with node_count 1; the tag is the frozen
  // 'tag:yaml.org,2002:str' spelling (0x74 leading byte).
  const badUtf8 = unhex('504743450101010020157461673a79616d6c2e6f72672c323030323a73747201ff');
  assert.throws(
    () => decodePGCE(badUtf8, LIMITS),
    (e: unknown) => (e as PGCEError).kind === 'InvalidUtf8',
  );
});

test('sharing, cycles, and arbitrary mapping keys round-trip', () => {
  // Mirrors the Rust round-trip test (crates/consema-graph/src/pgce.rs:716-746).
  const builder = new Builder(defaultLimits());
  const mapping = builder.reserveNode();
  const key = builder.reserveNode();
  const sequence = builder.reserveNode();
  builder.defineScalar(key, STR, 'k');
  builder.defineSequence(sequence, SEQ, [mapping, key]);
  builder.defineMapping(mapping, MAP, [
    { key: sequence, value: key },
    { key, value: mapping },
  ]);
  builder.pushRoot(mapping);
  const graph = builder.build();
  const bytes = encodePGCE(graph);
  const decoded = decodePGCE(bytes, LIMITS);
  assert.equal(equal(decoded, graph), true);
  assert.equal(hex(encodePGCE(decoded)), hex(bytes));
});

test('isomorphic builder numbering produces identical PGCE bytes', () => {
  // crates/consema-graph/src/pgce.rs:689-713: the same graph reserved with
  // the shared scalar first or the sequence first.
  const build = (sharedFirst: boolean) => {
    const builder = new Builder(defaultLimits());
    const first = builder.reserveNode(); // index 0
    const second = builder.reserveNode(); // index 1
    const shared = sharedFirst ? first : second;
    const root = sharedFirst ? second : first;
    builder.defineScalar(shared, STR, 'x');
    builder.defineSequence(root, SEQ, [shared, shared]);
    builder.pushRoot(root);
    return builder.build();
  };
  const first = build(false);
  const second = build(true);
  assert.equal(equal(first, second), true);
  assert.equal(hex(encodePGCE(first)), hex(encodePGCE(second)));
});

test('encode and decode enforce limits atomically', () => {
  const graph = scalarGraph('x');
  const bytes = encodePGCE(graph);
  const smallStream = { ...LIMITS, maxStreamBytes: bytes.length - 1 };
  assert.throws(
    () => decodePGCE(bytes, smallStream),
    (e: unknown) =>
      (e as PGCEError).kind === 'ResourceLimit' &&
      (e as PGCEError).field === 'stream-bytes' &&
      (e as PGCEError).code === 'core.pgce.resource-limit@1',
  );
  assert.throws(() => encodePGCERecords(graph, smallStream), (e: unknown) =>
    (e as PGCEError).field === 'stream-bytes',
  );
  // A scalar root sits at depth 0 and fits maxTraversalDepth: 0; a root
  // sequence with a scalar child reaches depth 1 (the Go authority's
  // TestDecodeRejectsTraversalDepthLimit shape, go/graph/pgce_test.go:482-505).
  const deepBuilder = new Builder(defaultLimits());
  const deepRoot = deepBuilder.reserveNode();
  const deepChild = deepBuilder.reserveNode();
  deepBuilder.defineScalar(deepChild, STR, 'x');
  deepBuilder.defineSequence(deepRoot, SEQ, [deepChild]);
  deepBuilder.pushRoot(deepRoot);
  const deep = deepBuilder.build();
  assert.throws(() => encodePGCERecords(deep, { ...LIMITS, maxTraversalDepth: 0 }), (e: unknown) =>
    (e as PGCEError).field === 'traversal-depth',
  );
});

test('edge limits apply during decode', () => {
  // One mapping node with one association = 2 edges; limit maxEdges to 1.
  const builder = new Builder(defaultLimits());
  const mapping = builder.reserveNode();
  const key = builder.reserveNode();
  const value = builder.reserveNode();
  builder.defineScalar(key, STR, 'k');
  builder.defineScalar(value, STR, 'v');
  builder.defineMapping(mapping, MAP, [{ key, value }]);
  builder.pushRoot(mapping);
  const bytes = encodePGCE(builder.build());
  assert.throws(
    () => decodePGCE(bytes, { ...LIMITS, maxEdges: 1 }),
    (e: unknown) =>
      (e as PGCEError).kind === 'ResourceLimit' &&
      (e as PGCEError).field === 'graph-edges',
  );
});

test('frozen PGCE error codes are registered', () => {
  // core.pgce.invalid@1 / non-canonical@1 / resource-limit@1 /
  // unsupported-version@1 (crates/consema-protocol/src/error_registry.rs:706-724).
  const badMagic = Uint8Array.of(0x50, 0x47, 0x43, 0x44, 0x01, 0x00, 0x00);
  assert.throws(
    () => decodePGCE(badMagic, LIMITS),
    (e: unknown) => (e as PGCEError).code === 'core.pgce.invalid@1',
  );
  const versionTwo = Uint8Array.of(0x50, 0x47, 0x43, 0x45, 0x02, 0x00, 0x00);
  assert.throws(
    () => decodePGCE(versionTwo, LIMITS),
    (e: unknown) => (e as PGCEError).code === 'core.pgce.unsupported-version@1',
  );
});

test('node IDs are graph-local and never part of encoding', () => {
  const left = scalarGraph('x');
  const right = scalarGraph('x');
  // Different builder identities, identical bytes.
  assert.notEqual(left.identity, right.identity);
  assert.equal(hex(encodePGCE(left)), hex(encodePGCE(right)));
});
