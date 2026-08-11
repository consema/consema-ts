/**
 * Intent documents for the frozen JSON format-operation registry.
 *
 * The eight records and their exact ids/roles/arguments/support are
 * transcribed from crates/consema-json/src/operation_registry.rs:16-80;
 * the per-profile closure (all three profiles publish the same eight
 * records) is pinned by operation_registry.rs:104-129. RFC 0004 §10
 * (:244-269) freezes the six structural ids; the two scalar operations
 * are declared as ExistingTypedCapability (RFC 0004 §10 :263-265).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatOperationRegistry } from '../json/index.ts';
import { PROFILE_JSON5_STANDARD, PROFILE_JSONC_BOUNDED, PROFILE_JSON_STRICT } from '../json/index.ts';
import { FormatOperationId } from '../document/operation.ts';

test('the frozen structural surface is exactly six Supported operations (operation_registry.rs:104-129)', () => {
  const expected = [
    'json.edit.insert-array-element@1',
    'json.edit.insert-member@1',
    'json.edit.move-member@1',
    'json.edit.remove-array-element@1',
    'json.edit.remove-member@1',
    'json.edit.rename-member@1',
  ];
  for (const profile of [PROFILE_JSON_STRICT, PROFILE_JSONC_BOUNDED, PROFILE_JSON5_STANDARD]) {
    const registry = formatOperationRegistry(profile);
    const structural = registry
      .operations()
      .filter((descriptor) => descriptor.support() === 'Supported')
      .map((descriptor) => descriptor.id().toString());
    assert.deepEqual(structural, expected, profile);
    assert.equal(registry.operations().length, 8, profile);
  }
});

test('every descriptor id, target role, and argument schema is exact (operation_registry.rs:16-80)', () => {
  const registry = formatOperationRegistry(PROFILE_JSON_STRICT);
  const byId = new Map(
    registry.operations().map((descriptor) => [descriptor.id().toString(), descriptor]),
  );

  const insertMember = byId.get('json.edit.insert-member@1')!;
  assert.equal(insertMember.targetRole().toString(), 'json.object@1');
  assert.deepEqual(
    insertMember.arguments().map((argument) => [argument.name(), argument.kind(), argument.required()]),
    [
      ['name', 'String', true],
      ['value', 'PortableValue', true],
      ['placement', 'Placement', true],
    ],
  );

  const removeMember = byId.get('json.edit.remove-member@1')!;
  assert.equal(removeMember.targetRole().toString(), 'json.object-member@1');
  assert.equal(removeMember.arguments().length, 0);

  const moveMember = byId.get('json.edit.move-member@1')!;
  assert.equal(moveMember.targetRole().toString(), 'json.object-member@1');
  assert.deepEqual(
    moveMember.arguments().map((argument) => [argument.name(), argument.kind()]),
    [['placement', 'Placement']],
  );

  const renameMember = byId.get('json.edit.rename-member@1')!;
  assert.equal(renameMember.targetRole().toString(), 'json.object-member@1');
  assert.deepEqual(
    renameMember.arguments().map((argument) => [argument.name(), argument.kind()]),
    [['name', 'String']],
  );

  const insertArray = byId.get('json.edit.insert-array-element@1')!;
  assert.equal(insertArray.targetRole().toString(), 'json.array@1');
  assert.deepEqual(
    insertArray.arguments().map((argument) => [argument.name(), argument.kind()]),
    [
      ['value', 'PortableValue'],
      ['placement', 'Placement'],
    ],
  );

  const removeArray = byId.get('json.edit.remove-array-element@1')!;
  assert.equal(removeArray.targetRole().toString(), 'json.array-element@1');
  assert.equal(removeArray.arguments().length, 0);

  const semantic = byId.get('json.edit.replace-scalar-semantic@1')!;
  assert.equal(semantic.targetRole().toString(), 'json.scalar@1');
  assert.equal(semantic.support(), 'ExistingTypedCapability');
  assert.deepEqual(
    semantic.arguments().map((argument) => [argument.name(), argument.kind()]),
    [
      ['value', 'PortableValue'],
      ['representation_policy', 'RepresentationPolicy'],
    ],
  );

  const literal = byId.get('json.edit.replace-scalar-literal@1')!;
  assert.equal(literal.targetRole().toString(), 'json.scalar@1');
  assert.equal(literal.support(), 'ExistingTypedCapability');
  assert.deepEqual(
    literal.arguments().map((argument) => [argument.name(), argument.kind()]),
    [['literal', 'ExactBytes']],
  );
});

test('exact-version descriptor lookup (operation.ts:260-277)', () => {
  const registry = formatOperationRegistry(PROFILE_JSON5_STANDARD);
  const found = registry.descriptor(new FormatOperationId('json.edit.move-member', 1));
  assert.ok(found !== null);
  assert.equal(found.id().toString(), 'json.edit.move-member@1');
  assert.equal(registry.descriptor(new FormatOperationId('json.edit.move-member', 2)), null);
});
