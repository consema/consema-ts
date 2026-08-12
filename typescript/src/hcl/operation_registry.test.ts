/**
 * HCL operation-registry intent tests — golden transcriptions from the
 * frozen registry surface (RFC 0014 §10; RFC 0004 §10).
 *
 * Blind-written intent documents (docs/multi-language-implementation
 * -plan.md §3); no gate is claimed before the §7 START GATE.
 *
 * Authority: crates/consema-hcl/src/operation_registry.rs:100-157 pins the
 * surface: six operations for `hcl.native@1` (all Supported), four for
 * `hcl.tfvars@1`, canonically sorted by operation id.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hclFormatOperationRegistry } from './operation_registry.ts';
import { HclProfile } from './profile.ts';
import { FormatOperationId } from '../document/operation.ts';

test('native profile publishes the frozen six-operation surface', () => {
  // operation_registry.rs:105-127 (native_profile_publishes_the_frozen_
  // six_operation_surface).
  const registry = hclFormatOperationRegistry(HclProfile.NATIVE_V1);
  assert.deepEqual(
    registry.operations().map((descriptor) => descriptor.id().toString()),
    [
      'hcl.edit.insert-attribute@1',
      'hcl.edit.insert-block@1',
      'hcl.edit.remove-attribute@1',
      'hcl.edit.remove-block@1',
      'hcl.edit.rename-attribute@1',
      'hcl.edit.set-attribute-value@1',
    ],
  );
  assert.ok(registry.operations().every((descriptor) => descriptor.support() === 'Supported'));
});

test('tfvars profile publishes attribute operations only', () => {
  // operation_registry.rs:130-156 (tfvars_profile_publishes_attribute_
  // operations_only).
  const registry = hclFormatOperationRegistry(HclProfile.TFVARS_V1);
  assert.deepEqual(
    registry.operations().map((descriptor) => descriptor.id().toString()),
    [
      'hcl.edit.insert-attribute@1',
      'hcl.edit.remove-attribute@1',
      'hcl.edit.rename-attribute@1',
      'hcl.edit.set-attribute-value@1',
    ],
  );
  assert.ok(!registry.operations().some((descriptor) => descriptor.id().id().includes('block')));
});

test('the argument schemas match the frozen descriptors', () => {
  // operation_registry.rs:26-80 (the descriptor tables).
  const registry = hclFormatOperationRegistry(HclProfile.NATIVE_V1);
  const insertAttribute = registry.descriptor(new FormatOperationId('hcl.edit.insert-attribute', 1));
  assert.ok(insertAttribute !== null);
  assert.deepEqual(
    insertAttribute.arguments().map((argument) => [argument.name(), argument.kind()]),
    [
      ['name', 'String'],
      ['value', 'PortableValue'],
      ['placement', 'Placement'],
    ],
  );
  const insertBlock = registry.descriptor(new FormatOperationId('hcl.edit.insert-block', 1));
  assert.ok(insertBlock !== null);
  assert.equal(insertBlock.targetRole().toString(), 'hcl.body@1');
  assert.deepEqual(
    insertBlock.arguments().map((argument) => [argument.name(), argument.kind()]),
    [
      ['type', 'String'],
      ['labels', 'String'],
      ['attributes', 'PortableValue'],
      ['placement', 'Placement'],
    ],
  );
});
