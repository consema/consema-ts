/**
 * Intent documents for the frozen Java Properties operation registry.
 *
 * Golden transcription from the shared vectors — this test cites its
 * case id:
 *  - conformance/vectors/java-properties-v1.json:
 *    registry.frozen-five-operation-surface (:147-150)
 *  - crates/consema-properties/src/operation_registry.rs:16-48 (the exact
 *    descriptors), :72-95 (both profiles publish the same surface)
 *  - RFC 0010 §13 (:385-393) freezes the five operation ids
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatOperationRegistry } from '../properties/operation_registry.ts';
import { PROFILE_READER_V1, PROFILE_LATIN1_V1 } from '../properties/profile.ts';

test('registry.frozen-five-operation-surface: both profiles publish the same five operations (java-properties-v1.json:147-150)', () => {
  const expected = [
    'java-properties.edit.insert-property@1',
    'java-properties.edit.remove-property@1',
    'java-properties.edit.rename-property@1',
    'java-properties.edit.replace-literal-value@1',
    'java-properties.edit.replace-semantic-value@1',
  ];
  for (const profile of [PROFILE_READER_V1, PROFILE_LATIN1_V1]) {
    const registry = formatOperationRegistry(profile);
    assert.deepEqual(
      registry.operations().map((descriptor) => descriptor.id().toString()),
      expected,
      profile,
    );
    assert.ok(
      registry.operations().every((descriptor) => descriptor.support() === 'Supported'),
      profile,
    );
    assert.equal(
      registry.operations().filter((descriptor) => descriptor.support() === 'Supported').length,
      5,
    );
  }
});

test('the five descriptors carry the exact target roles and argument schemas (operation_registry.rs:16-48)', () => {
  const registry = formatOperationRegistry(PROFILE_READER_V1);
  const byId = new Map(registry.operations().map((descriptor) => [descriptor.id().id(), descriptor]));
  const insert = byId.get('java-properties.edit.insert-property')!;
  assert.equal(insert.targetRole().toString(), 'java-properties.document@1');
  assert.deepEqual(
    insert.arguments().map((argument) => [argument.name(), argument.kind(), argument.required()]),
    [['key', 'PortableValue', true], ['value', 'PortableValue', true], ['placement', 'Placement', true]],
  );
  for (const id of [
    'java-properties.edit.remove-property',
    'java-properties.edit.rename-property',
    'java-properties.edit.replace-literal-value',
    'java-properties.edit.replace-semantic-value',
  ]) {
    assert.equal(byId.get(id)!.targetRole().toString(), 'java-properties.property@1', id);
  }
  const literal = byId.get('java-properties.edit.replace-literal-value')!;
  assert.deepEqual(
    literal.arguments().map((argument) => [argument.name(), argument.kind()]),
    [['literal', 'ExactBytes']],
  );
  const semantic = byId.get('java-properties.edit.replace-semantic-value')!;
  assert.deepEqual(
    semantic.arguments().map((argument) => [argument.name(), argument.kind()]),
    [['value', 'PortableValue']],
  );
  const rename = byId.get('java-properties.edit.rename-property')!;
  assert.deepEqual(
    rename.arguments().map((argument) => [argument.name(), argument.kind()]),
    [['key', 'PortableValue']],
  );
  assert.equal(byId.get('java-properties.edit.remove-property')!.arguments().length, 0);
});
