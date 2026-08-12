/**
 * Intent documents for the frozen YAML operation registry.
 *
 * authority: crates/consema-yaml/src/operation_registry.rs:16-83 (the eight
 * descriptors) and :107-135 (both profiles publish the same surface: six
 * structural Supported ops and two scalar ExistingTypedCapability ops);
 * RFC 0007 §12 (:357-368).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatOperationRegistry, PROFILE_YAML12_CORE, PROFILE_YAML11_COMPAT } from './index.ts';
import { FormatOperationId } from '../document/operation.ts';

const STRUCTURAL_IDS = [
  'yaml.edit.insert-alias@1',
  'yaml.edit.insert-mapping-entry@1',
  'yaml.edit.insert-sequence-element@1',
  'yaml.edit.remove-mapping-entry@1',
  'yaml.edit.remove-sequence-element@1',
  'yaml.edit.rename-anchor@1',
];

test('both YAML profiles publish the frozen eight-record surface (operation_registry.rs:107-135)', () => {
  for (const profile of [PROFILE_YAML12_CORE, PROFILE_YAML11_COMPAT]) {
    const registry = formatOperationRegistry(profile);
    const operations = registry.operations();
    assert.equal(operations.length, 8);
    const structural = operations
      .filter((descriptor) => descriptor.support() === 'Supported')
      .map((descriptor) => descriptor.id().toString());
    assert.deepEqual(structural, STRUCTURAL_IDS);
  }
});

test('insert-alias targets yaml.sequence with anchor(NodeRef) and placement(Placement)', () => {
  const registry = formatOperationRegistry(PROFILE_YAML12_CORE);
  const alias = registry.descriptor(new FormatOperationId('yaml.edit.insert-alias', 1));
  assert.ok(alias !== null, 'insert-alias descriptor exists');
  if (alias !== null) {
    assert.equal(alias.targetRole().id(), 'yaml.sequence');
    assert.equal(alias.arguments()[0].name(), 'anchor');
    assert.equal(alias.arguments()[0].kind(), 'NodeRef');
    assert.equal(alias.arguments()[1].name(), 'placement');
    assert.equal(alias.arguments()[1].kind(), 'Placement');
  }
});

test('scalar operations are ExistingTypedCapability (RFC 0004 §10:263-265)', () => {
  const registry = formatOperationRegistry(PROFILE_YAML11_COMPAT);
  const semantic = registry.descriptor(
    new FormatOperationId('yaml.edit.replace-scalar-semantic', 1),
  );
  assert.ok(semantic !== null);
  if (semantic !== null) {
    assert.equal(semantic.support(), 'ExistingTypedCapability');
    assert.equal(semantic.targetRole().id(), 'yaml.scalar');
  }
  const literal = registry.descriptor(
    new FormatOperationId('yaml.edit.replace-scalar-literal', 1),
  );
  assert.ok(literal !== null);
  if (literal !== null) {
    assert.equal(literal.support(), 'ExistingTypedCapability');
    assert.equal(literal.arguments()[0].name(), 'literal');
    assert.equal(literal.arguments()[0].kind(), 'ExactBytes');
  }
});
