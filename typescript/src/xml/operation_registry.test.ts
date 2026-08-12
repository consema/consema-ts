/**
 * Intent documents for the frozen XML format-operation registry.
 *
 * The eight records and their exact ids/roles/arguments/support are
 * transcribed from crates/consema-xml/src/operation_registry.rs:16-89;
 * the frozen eight-operation surface is pinned by RFC 0012 §11 (:375-387)
 * and by operation_registry.rs:99-124 (all Supported).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatOperationRegistry } from '../xml/index.ts';
import { PROFILE_XML_SAFE } from '../xml/index.ts';
import { FormatOperationId } from '../document/operation.ts';

test('the frozen surface is exactly the eight Supported XML operations (operation_registry.rs:99-124)', () => {
  const registry = formatOperationRegistry(PROFILE_XML_SAFE);
  const ids = registry.operations().map((descriptor) => descriptor.id().toString());
  assert.deepEqual(ids, [
    'xml.edit.insert-attribute@1',
    'xml.edit.insert-element@1',
    'xml.edit.remove-attribute@1',
    'xml.edit.remove-element@1',
    'xml.edit.rename-attribute@1',
    'xml.edit.rename-element@1',
    'xml.edit.replace-text@1',
    'xml.edit.set-attribute-value@1',
  ]);
  for (const descriptor of registry.operations()) {
    assert.equal(descriptor.support(), 'Supported', descriptor.id().toString());
  }
});

test('every descriptor id, target role, and argument schema is exact (operation_registry.rs:16-89)', () => {
  const registry = formatOperationRegistry(PROFILE_XML_SAFE);
  const byId = new Map(
    registry.operations().map((descriptor) => [descriptor.id().toString(), descriptor]),
  );

  const replaceText = byId.get('xml.edit.replace-text@1')!;
  assert.equal(replaceText.targetRole().toString(), 'xml.text@1');
  assert.deepEqual(
    replaceText.arguments().map((argument) => [argument.name(), argument.kind(), argument.required()]),
    [['text', 'String', true]],
  );

  const insertAttribute = byId.get('xml.edit.insert-attribute@1')!;
  assert.equal(insertAttribute.targetRole().toString(), 'xml.element@1');
  assert.deepEqual(
    insertAttribute.arguments().map((argument) => [argument.name(), argument.kind()]),
    [
      ['name', 'String'],
      ['value', 'String'],
      ['placement', 'Placement'],
    ],
  );

  const removeAttribute = byId.get('xml.edit.remove-attribute@1')!;
  assert.equal(removeAttribute.targetRole().toString(), 'xml.attribute@1');
  assert.equal(removeAttribute.arguments().length, 0);

  const renameAttribute = byId.get('xml.edit.rename-attribute@1')!;
  assert.equal(renameAttribute.targetRole().toString(), 'xml.attribute@1');
  assert.deepEqual(
    renameAttribute.arguments().map((argument) => [argument.name(), argument.kind()]),
    [['name', 'String']],
  );

  const setAttributeValue = byId.get('xml.edit.set-attribute-value@1')!;
  assert.equal(setAttributeValue.targetRole().toString(), 'xml.attribute@1');
  assert.deepEqual(
    setAttributeValue.arguments().map((argument) => [argument.name(), argument.kind()]),
    [['value', 'String']],
  );

  const insertElement = byId.get('xml.edit.insert-element@1')!;
  assert.equal(insertElement.targetRole().toString(), 'xml.element@1');
  assert.deepEqual(
    insertElement.arguments().map((argument) => [argument.name(), argument.kind()]),
    [
      ['name', 'String'],
      ['content', 'String'],
      ['placement', 'Placement'],
    ],
  );

  const removeElement = byId.get('xml.edit.remove-element@1')!;
  assert.equal(removeElement.targetRole().toString(), 'xml.element@1');
  assert.equal(removeElement.arguments().length, 0);

  const renameElement = byId.get('xml.edit.rename-element@1')!;
  assert.equal(renameElement.targetRole().toString(), 'xml.element@1');
  assert.deepEqual(
    renameElement.arguments().map((argument) => [argument.name(), argument.kind()]),
    [['name', 'String']],
  );
});

test('exact-version descriptor lookup (operation.ts:260-277)', () => {
  const registry = formatOperationRegistry(PROFILE_XML_SAFE);
  const found = registry.descriptor(new FormatOperationId('xml.edit.replace-text', 1));
  assert.ok(found !== null);
  assert.equal(found.id().toString(), 'xml.edit.replace-text@1');
  assert.equal(registry.descriptor(new FormatOperationId('xml.edit.replace-text', 2)), null);
});
