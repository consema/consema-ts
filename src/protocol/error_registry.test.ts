/**
 * Error-code registry intent tests.
 *
 * These pin the frozen semantic-model v1-v7 error-code sets
 * (55/62/90/92/132/166/187 codes) transcribed from
 * crates/consema-protocol/src/error_registry.rs (go/protocol/error_registry.go,
 * cross-reference). They run once the toolchain is ready; no gate is claimed
 * before that (§7 START GATE).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ErrorCodeRegistry, CATEGORIES, errorCodeManifestValueV7 } from './error_registry.ts';

function codes(version: number): string[] {
  return new ErrorCodeRegistry(version as 1 | 2 | 3 | 4 | 5 | 6 | 7).codes().map((descriptor) => descriptor.code);
}

test('the error registry pins the v1-v7 counts 55/62/90/92/132/166/187', () => {
  assert.equal(codes(1).length, 55);
  assert.equal(codes(2).length, 62);
  assert.equal(codes(3).length, 90);
  assert.equal(codes(4).length, 92);
  assert.equal(codes(5).length, 132);
  assert.equal(codes(6).length, 166);
  assert.equal(codes(7).length, 187);
});

test('codes are strictly sorted, unique, and versioned', () => {
  for (const version of [1, 2, 3, 4, 5, 6, 7]) {
    const list = codes(version);
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i - 1] < list[i], `codes must be sorted and unique at v${version}`);
      assert.ok(list[i].includes('@'), `code must carry a version: ${list[i]}`);
    }
  }
});

test('every superset relationship holds across versions', () => {
  for (let version = 1; version < 7; version++) {
    const earlier = new Set(codes(version));
    const later = codes(version + 1);
    for (const code of earlier) {
      assert.ok(later.includes(code), `v${version + 1} must contain ${code}`);
    }
  }
});

test('the eleven categories are the frozen set', () => {
  assert.deepEqual(CATEGORIES, [
    'Lexical',
    'Syntax',
    'Conformance',
    'Semantic',
    'Query',
    'Projection',
    'Materialization',
    'Conversion',
    'Edit',
    'Resource',
    'Encoding',
  ]);
});

test('spot checks on registered codes and their metadata', () => {
  const registry = new ErrorCodeRegistry(7);
  const descriptor = registry.descriptor('core.query.unknown-operator@1');
  assert.ok(descriptor);
  assert.equal(descriptor.category, 'Query');
  assert.equal(descriptor.introduced, '0.3.0');
  assert.equal(registry.contains('core.query.unknown-operator@1'), true);
  assert.equal(registry.contains('core.query.not-a-code@1'), false);
  assert.equal(registry.descriptor('json.syntax.missing-object-close@1')?.category, 'Syntax');
});

test('the graph and PGCE codes are registered from v5', () => {
  const v4 = new ErrorCodeRegistry(4);
  const v5 = new ErrorCodeRegistry(5);
  assert.equal(v4.contains('core.pgce.invalid@1'), false);
  assert.equal(v5.contains('core.pgce.invalid@1'), true);
  assert.equal(v5.contains('core.graph.resource-limit@1'), true);
  assert.equal(v5.contains('core.graph.invalid@1'), true);
});

test('the RFC 0015 CLI error family of 20 codes is registered in v7', () => {
  const registry = new ErrorCodeRegistry(7);
  const cliCodes = codes(7).filter((code) => code.startsWith('cli.'));
  assert.equal(cliCodes.length, 20);
  assert.ok(cliCodes.includes('cli.usage.unknown-command@1'));
  assert.ok(cliCodes.includes('cli.data.invalid-request@1'));
  assert.ok(cliCodes.includes('cli.limit.file-size@1'));
  assert.ok(cliCodes.includes('cli.write.read-only@1'));
  assert.ok(cliCodes.includes('cli.interrupted.signal@1'));
  assert.ok(cliCodes.includes('cli.internal.unclassified@1'));
});

test('validate rejects unregistered codes', () => {
  const registry = new ErrorCodeRegistry(7);
  assert.doesNotThrow(() => registry.validate('core.query.unknown-operator@1'));
  assert.throws(() => registry.validate('core.query.not-registered@1'));
});

test('the error-code manifest payload has the fixed shape', () => {
  const value = errorCodeManifestValueV7();
  assert.equal(value.entries[0].key, 'schema');
  assert.equal((value.entries[0].value as { value: string }).value, 'core.error-code-registry@1');
  assert.equal(value.entries[1].key, 'error_codes');
  const items = (value.entries[1].value as { kind: 'Sequence'; items: unknown[] }).items;
  assert.equal(items.length, 187);
  const first = items[0] as { entries: { key: string; value: { value: string } }[] };
  assert.equal(first.entries[0].value.value, 'cli.data.invalid-request@1');
});
