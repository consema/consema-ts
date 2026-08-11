/**
 * Intent documents for YAML canonical materialization.
 *
 * Golden transcriptions from the shared vectors — each test cites its
 * case id in conformance/vectors/yaml-v1.json:
 *  - materialization.graph-cycle-flow (:96-99)
 *  - materialization.value-flow (:101-104)
 * Materialization semantics: RFC 0007 §11; crates/consema-yaml/src/
 * materialization.rs (the canonical output bytes are byte-exact golden).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  materializeGraph,
  materializeValue,
  parse,
  projectGraph,
} from './index.ts';
import { PROFILE_YAML12_CORE } from './index.ts';
import { DEFAULT_PARSE_LIMITS } from '../document/formation.ts';
import { MaterializationRequest, MaterializationStyleId } from '../document/materialization.ts';
import { ProfileId } from '../document/profile.ts';
import {
  booleanValue,
  integerValue,
  sequenceValue,
  stringValue,
  objectValue,
} from '../core/value.ts';
import { Builder } from '../graph/graph.ts';
import { decodeUtf8 } from './test_decode.ts';

function request(style: string): MaterializationRequest {
  return new MaterializationRequest(
    new ProfileId('yaml.1.2-core', 1),
    new MaterializationStyleId(style, 1),
  );
}

function render(document: { render(): Uint8Array }): string {
  return decodeUtf8(document.render());
}

test('materialization.graph-cycle-flow — canonical flow output with g0 anchors (yaml-v1.json:96-99)', () => {
  // The source `&root [one, *root]` composes one cyclic graph; canonical
  // materialization must reproduce the golden bytes exactly.
  const source = new TextEncoder().encode('&root [one, *root]\n');
  const document = parse(source, PROFILE_YAML12_CORE, DEFAULT_PARSE_LIMITS);
  const graph = projectGraph(document);
  const result = materializeGraph(graph, request('yaml.canonical-flow'));
  assert.equal(result.kind, 'Complete');
  if (result.kind === 'Complete') {
    assert.equal(result.value.fidelity, 'Exact');
    assert.equal(render(result.value.document), '--- &g0 !!seq [!!str "one", *g0]\n');
  }
});

test('materialization.value-flow — canonical flow fragments (yaml-v1.json:101-104)', () => {
  const value = objectValue([
    {
      key: 'a',
      value: sequenceValue([integerValue(1n), booleanValue(true)]),
    },
  ]);
  const result = materializeValue(value, request('yaml.canonical-flow'));
  assert.equal(result.kind, 'Complete');
  if (result.kind === 'Complete') {
    assert.equal(
      render(result.value.document()),
      '--- !!map {? !!str "a" : !!seq [!!int "1", !!bool "true"]}\n',
    );
  }
});

test('materialization round-trips through the best-exact projection', () => {
  const value = objectValue([
    {
      key: 'k',
      value: stringValue('v'),
    },
  ]);
  const result = materializeValue(value, request('yaml.canonical-block'));
  assert.equal(result.kind, 'Complete');
  if (result.kind === 'Complete') {
    const rendered = render(result.value.document());
    // Block style renders an explicit-key block mapping (materialization.rs
    // block_after_indicator; the Rust block test asserts the same shape).
    assert.equal(rendered, '--- !!map\n? !!str "k"\n: !!str "v"\n');
  }
});

test('graph materialization of a shared node emits one anchor and one alias', () => {
  const builder = new Builder({
    maxRoots: 1,
    maxNodes: 4,
    maxEdges: 8,
    maxContainerEntries: 4,
    maxTagBytes: 64,
    maxScalarBytes: 1024,
    maxTraversalDepth: 16,
  });
  const shared = builder.reserveNode();
  builder.defineScalar(shared, 'tag:yaml.org,2002:str', 'one');
  const seq = builder.reserveNode();
  builder.defineSequence(seq, 'tag:yaml.org,2002:seq', [shared, shared]);
  builder.pushRoot(seq);
  const graph = builder.build();
  const result = materializeGraph(graph, request('yaml.canonical-flow'));
  assert.equal(result.kind, 'Complete');
  if (result.kind === 'Complete') {
    // The shared scalar has two occurrences and is anchored; the sequence
    // occurs once and is not (materialization.rs:392-398).
    assert.equal(render(result.value.document), '--- !!seq [&g0 !!str "one", *g0]\n');
  }
});

test('unsupported styles and profiles fail atomically', () => {
  const value = stringValue('x');
  assert.equal(
    materializeValue(value, request('yaml.canonical-flow').withNewline('None')).kind,
    'Failed',
  );
  assert.equal(
    materializeValue(
      value,
      new MaterializationRequest(
        new ProfileId('json.strict', 1),
        new MaterializationStyleId('yaml.canonical-flow', 1),
      ),
    ).kind,
    'Failed',
  );
});

test('custom graph tags fail with the frozen code', () => {
  const builder = new Builder({
    maxRoots: 1,
    maxNodes: 2,
    maxEdges: 4,
    maxContainerEntries: 2,
    maxTagBytes: 64,
    maxScalarBytes: 1024,
    maxTraversalDepth: 16,
  });
  const scalar = builder.reserveNode();
  builder.defineScalar(scalar, '!custom', 'payload');
  builder.pushRoot(scalar);
  const graph = builder.build();
  const result = materializeGraph(graph, request('yaml.canonical-flow'));
  assert.equal(result.kind, 'Failed');
  if (result.kind === 'Failed') {
    assert.equal(result.value.failure.code, 'yaml.materialization.unsupported-tag@1');
  }
});
