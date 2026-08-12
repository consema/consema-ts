/**
 * PortableGraph intent tests.
 *
 * These are blind-written intent documents (docs/multi-language-implementation
 * -plan.md §3) pinning the language-neutral facts of RFC 0006 and
 * conformance/vectors/portable-graph-v1.json; they run once the toolchain is
 * ready. No gate is claimed before that (§7 START GATE).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Builder, defaultLimits, nodeAt } from './graph.ts';
import { equal, hash } from './equal.ts';
import { GraphError } from './errors.ts';

const STR = 'tag:yaml.org,2002:str';
const SEQ = 'tag:yaml.org,2002:seq';
const MAP = 'tag:yaml.org,2002:map';

test('an empty graph represents an empty root stream', () => {
  const graph = new Builder(defaultLimits()).build();
  assert.equal(graph.roots.length, 0);
  assert.equal(graph.nodes.length, 0);
  assert.equal(graph.edgeCount, 0);
});

test('builder lifecycle: reserve, define once, root, build', () => {
  const builder = new Builder(defaultLimits());
  const root = builder.reserveNode();
  builder.defineScalar(root, STR, 'x');
  builder.pushRoot(root);
  const graph = builder.build();
  assert.equal(graph.roots.length, 1);
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.edgeCount, 0);
  const node = nodeAt(graph, root);
  assert.ok(node);
  assert.equal(node.kind, 'Scalar');
  assert.equal(node.tag, STR);
  assert.equal((node as { content: string }).content, 'x');
});

test('sequence and mapping nodes count their edges', () => {
  const builder = new Builder(defaultLimits());
  const root = builder.reserveNode();
  const shared = builder.reserveNode();
  builder.defineScalar(shared, STR, 'x');
  builder.defineSequence(root, SEQ, [shared, shared]);
  builder.pushRoot(root);
  const graph = builder.build();
  assert.equal(graph.edgeCount, 2);
});

test('an ID from another builder is rejected (WrongGraph)', () => {
  const first = new Builder(defaultLimits());
  const foreign = first.reserveNode();
  first.defineScalar(foreign, STR, 'x');
  const second = new Builder(defaultLimits());
  assert.throws(() => second.defineScalar(foreign, STR, 'y'), (e: unknown) => {
    const error = e as GraphError;
    return error.kind === 'WrongGraph' && error.code === 'core.graph.invalid@1';
  });
});

test('unknown, duplicate, and undefined node failures are typed', () => {
  const builder = new Builder(defaultLimits());
  const root = builder.reserveNode();
  builder.defineScalar(root, STR, 'x');
  builder.pushRoot(root);
  // Duplicate definition.
  assert.throws(() => builder.defineScalar(root, STR, 'y'), (e: unknown) =>
    (e as GraphError).kind === 'DuplicateDefinition',
  );
  // Undefined node at build time.
  builder.reserveNode();
  assert.throws(() => builder.build(), (e: unknown) => {
    const error = e as GraphError;
    return error.kind === 'UndefinedNode' && error.id?.index === 1;
  });
  // Unknown node ID (not reserved by this builder; graph identity differs).
  const other = new Builder(defaultLimits());
  assert.throws(() => other.pushRoot({ graph: 999n, index: 0 }), (e: unknown) =>
    (e as GraphError).kind === 'WrongGraph',
  );
});

test('unreachable nodes fail the build', () => {
  const builder = new Builder(defaultLimits());
  const root = builder.reserveNode();
  const orphan = builder.reserveNode();
  builder.defineScalar(root, STR, 'x');
  builder.defineScalar(orphan, STR, 'orphan');
  builder.pushRoot(root);
  assert.throws(() => builder.build(), (e: unknown) => {
    const error = e as GraphError;
    return error.kind === 'UnreachableNode' && error.id?.index === 1;
  });
});

test('tags reject empty, control, and whitespace characters', () => {
  const builder = new Builder(defaultLimits());
  const root = builder.reserveNode();
  assert.throws(() => builder.defineScalar(root, '', 'x'), (e: unknown) =>
    (e as GraphError).kind === 'InvalidTag',
  );
  assert.throws(() => builder.defineScalar(root, 'bad tag', 'x'), (e: unknown) =>
    (e as GraphError).kind === 'InvalidTag',
  );
  assert.throws(() => builder.defineScalar(root, 'bad\ttag', 'x'), (e: unknown) =>
    (e as GraphError).kind === 'InvalidTag',
  );
});

test('scalar content and tags must be valid UTF-8 scalar sequences', () => {
  const builder = new Builder(defaultLimits());
  const root = builder.reserveNode();
  const loneSurrogate = 'x\uD800y';
  assert.throws(() => builder.defineScalar(root, STR, loneSurrogate), (e: unknown) =>
    (e as GraphError).kind === 'InvalidUtf8',
  );
});

test('resource limits are enforced per field', () => {
  const builder = new Builder({ ...defaultLimits(), maxNodes: 1 });
  builder.reserveNode();
  assert.throws(() => builder.reserveNode(), (e: unknown) => {
    const error = e as GraphError;
    return error.kind === 'ResourceLimit' && error.field === 'graph-nodes';
  });
  const rooted = new Builder({ ...defaultLimits(), maxRoots: 1 });
  const a = rooted.reserveNode();
  const b = rooted.reserveNode();
  rooted.defineScalar(a, STR, 'x');
  rooted.defineScalar(b, STR, 'y');
  rooted.pushRoot(a);
  // The Rust and Go authorities enforce graph-roots eagerly at push time
  // (crates/consema-graph/src/lib.rs:286-294; go/graph/graph.go:261-267),
  // not at build(); build() only checks definitions, reachability, and depth.
  assert.throws(() => rooted.pushRoot(b), (e: unknown) => {
    const error = e as GraphError;
    return error.kind === 'ResourceLimit' && error.field === 'graph-roots';
  });
});

test('vector graph.isomorphic-builder-numbering: equal despite different IDs', () => {
  // conformance/vectors/portable-graph-v1.json: the left graph reserves the
  // sequence first, the right graph reserves the shared scalar first; both
  // must be strictly equal with equal hashes.
  const left = buildLeft();
  const right = buildRight();
  assert.equal(equal(left, right), true);
  assert.equal(hash(left), hash(right));
  assert.equal(equal(left, left), true);
});

function buildLeft() {
  const builder = new Builder(defaultLimits());
  const root = builder.reserveNode();
  const shared = builder.reserveNode();
  builder.defineSequence(root, SEQ, [shared, shared]);
  builder.defineScalar(shared, STR, 'x');
  builder.pushRoot(root);
  return builder.build();
}

function buildRight() {
  const builder = new Builder(defaultLimits());
  const shared = builder.reserveNode();
  const root = builder.reserveNode();
  builder.defineScalar(shared, STR, 'x');
  builder.defineSequence(root, SEQ, [shared, shared]);
  builder.pushRoot(root);
  return builder.build();
}

test('vector graph.sharing-is-not-duplication: sharing is value semantics', () => {
  // conformance/vectors/portable-graph-v1.json: sharing (two references to
  // one node) is not equal to duplication (two distinct nodes).
  const shared = buildLeft(); // seq -> [shared, shared] (1 scalar node)
  const duplicated = () => {
    const builder = new Builder(defaultLimits());
    const root = builder.reserveNode();
    const first = builder.reserveNode();
    const second = builder.reserveNode();
    builder.defineSequence(root, SEQ, [first, second]);
    builder.defineScalar(first, STR, 'x');
    builder.defineScalar(second, STR, 'x');
    builder.pushRoot(root);
    return builder.build();
  };
  assert.equal(equal(shared, duplicated()), false);
});

test('cycles are safe for equality, hashing, and node resolution', () => {
  // conformance/vectors/portable-graph-v1.json pgce.cycle-roundtrip:
  // roots [0], nodes [sequence items [0]] — a self-referential sequence.
  const builder = new Builder(defaultLimits());
  const root = builder.reserveNode();
  builder.defineSequence(root, SEQ, [root]);
  builder.pushRoot(root);
  const graph = builder.build();
  assert.equal(graph.nodes.length, 1);
  assert.equal(equal(graph, graph), true);
  const again = hash(graph);
  assert.equal(again, hash(graph));
  const node = nodeAt(graph, root);
  assert.equal(node?.kind, 'Sequence');
});

test('mapping edges visit key before value in canonical order', () => {
  const builder = new Builder(defaultLimits());
  const mapping = builder.reserveNode();
  const key = builder.reserveNode();
  const value = builder.reserveNode();
  builder.defineScalar(key, STR, 'k');
  builder.defineScalar(value, STR, 'v');
  builder.defineMapping(mapping, MAP, [{ key, value }]);
  builder.pushRoot(mapping);
  const graph = builder.build();
  assert.equal(graph.edgeCount, 2);
  assert.equal(equal(graph, graph), true);
});

test('the frozen graph error codes are registered', () => {
  // core.graph.resource-limit@1 and core.graph.invalid@1
  // (crates/consema-protocol/src/error_registry.rs:694-700).
  const builder = new Builder({ ...defaultLimits(), maxNodes: 0 });
  try {
    builder.reserveNode();
    assert.fail('expected resource limit');
  } catch (error) {
    assert.equal((error as GraphError).code, 'core.graph.resource-limit@1');
  }
  try {
    const other = new Builder(defaultLimits());
    const root = other.reserveNode();
    other.defineScalar(root, '', 'x');
    assert.fail('expected invalid tag');
  } catch (error) {
    assert.equal((error as GraphError).code, 'core.graph.invalid@1');
  }
});
