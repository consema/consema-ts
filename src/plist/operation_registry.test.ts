/**
 * Intent documents for the frozen plist operation registry (L3).
 *
 * Golden transcription from the authoritative descriptor list:
 *  - crates/consema-plist/src/operation_registry.rs:20-83 (the six
 *    descriptors) and :108-132 (both profiles publish the same six
 *    operations, all Supported); RFC 0013 §11 (:683-695)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatOperationRegistry, PROFILE_PLIST_XML, PROFILE_PLIST_BINARY } from './index.ts';
import { FormatOperationId } from '../document/operation.ts';

test('every plist profile publishes the frozen six-operation surface (operation_registry.rs:108-132)', () => {
  const expected = [
    'plist.edit.insert-array-element@1',
    'plist.edit.insert-dict-entry@1',
    'plist.edit.remove-array-element@1',
    'plist.edit.remove-dict-entry@1',
    'plist.edit.rename-dict-key@1',
    'plist.edit.set-value@1',
  ];
  for (const profile of [PROFILE_PLIST_XML, PROFILE_PLIST_BINARY]) {
    const registry = formatOperationRegistry(profile);
    const ids = registry.operations().map((descriptor) => descriptor.id().toString());
    assert.deepEqual(ids, expected, profile);
    assert.ok(
      registry.operations().every((descriptor) => descriptor.support() === 'Supported'),
      profile,
    );
  }
});

test('operation ids, target roles, and argument schemas are frozen (operation_registry.rs:20-83)', () => {
  const registry = formatOperationRegistry(PROFILE_PLIST_XML);
  const lookup = (id: string) => registry.descriptor(new FormatOperationId(id, 1))!;

  const setValue = lookup('plist.edit.set-value');
  assert.equal(setValue.targetRole().toString(), 'plist.value@1');
  assert.deepEqual(
    setValue.arguments().map((argument) => [argument.name(), argument.kind()]),
    [
      ['path', 'NodeRef'],
      ['value', 'PortableValue'],
    ],
  );

  const insertDict = lookup('plist.edit.insert-dict-entry');
  assert.equal(insertDict.targetRole().toString(), 'plist.value@1');
  assert.deepEqual(
    insertDict.arguments().map((argument) => [argument.name(), argument.kind()]),
    [
      ['path', 'NodeRef'],
      ['key', 'String'],
      ['value', 'PortableValue'],
      ['placement', 'Placement'],
    ],
  );

  const removeDict = lookup('plist.edit.remove-dict-entry');
  assert.equal(removeDict.targetRole().toString(), 'plist.dict-entry@1');
  assert.deepEqual(
    removeDict.arguments().map((argument) => [argument.name(), argument.kind()]),
    [
      ['path', 'NodeRef'],
      ['key', 'String'],
      ['occurrence', 'NodeRef'],
    ],
  );

  const renameKey = lookup('plist.edit.rename-dict-key');
  assert.equal(renameKey.targetRole().toString(), 'plist.dict-entry@1');
  assert.deepEqual(
    renameKey.arguments().map((argument) => [argument.name(), argument.kind()]),
    [
      ['path', 'NodeRef'],
      ['from', 'String'],
      ['occurrence', 'NodeRef'],
      ['to', 'String'],
    ],
  );

  const insertArray = lookup('plist.edit.insert-array-element');
  assert.equal(insertArray.targetRole().toString(), 'plist.value@1');
  assert.deepEqual(
    insertArray.arguments().map((argument) => [argument.name(), argument.kind()]),
    [
      ['path', 'NodeRef'],
      ['index', 'NodeRef'],
      ['value', 'PortableValue'],
    ],
  );

  const removeArray = lookup('plist.edit.remove-array-element');
  assert.equal(removeArray.targetRole().toString(), 'plist.array-element@1');
  assert.deepEqual(
    removeArray.arguments().map((argument) => [argument.name(), argument.kind()]),
    [
      ['path', 'NodeRef'],
      ['index', 'NodeRef'],
    ],
  );
});

test('both profiles bind the same ids and exact-version lookup (operation_registry.rs:15-18)', () => {
  const xml = formatOperationRegistry(PROFILE_PLIST_XML);
  const binary = formatOperationRegistry(PROFILE_PLIST_BINARY);
  assert.deepEqual(
    xml.operations().map((descriptor) => descriptor.id().toString()),
    binary.operations().map((descriptor) => descriptor.id().toString()),
  );
  assert.equal(xml.profile().toString(), 'plist.xml@1');
  assert.equal(binary.profile().toString(), 'plist.binary@1');
});
