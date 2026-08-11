/**
 * INI operation registry intent tests.
 *
 * These are blind-written intent documents (docs/multi-language-implementation
 * -plan.md §3): they transcribe the language-neutral facts from
 * conformance/vectors/ini-v1.json and crates/consema-ini/src/operation_registry.rs
 * and run once the toolchain is ready. Golden vector case id cited:
 * registry.frozen-eight-operation-surface (ini-v1.json:135-139).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { IniProfile } from './profile.ts';
import { iniFormatOperationRegistry } from './operation_registry.ts';

const EXPECTED = [
  'ini.edit.insert-entry@1',
  'ini.edit.insert-section@1',
  'ini.edit.remove-entry@1',
  'ini.edit.remove-section@1',
  'ini.edit.rename-entry@1',
  'ini.edit.rename-section@1',
  'ini.edit.replace-literal-value@1',
  'ini.edit.replace-semantic-value@1',
];

test('golden registry.frozen-eight-operation-surface: every profile publishes the same surface', () => {
  // conformance/vectors/ini-v1.json:135-139 — the eight exact operation
  // ids for every profile with 6 direct structural operations
  // (Supported).
  for (const profile of [
    IniProfile.PORTABLE_V1,
    IniProfile.WINDOWS_V1,
    IniProfile.PYTHON_CONFIGPARSER_V1,
  ]) {
    const registry = iniFormatOperationRegistry(profile);
    assert.deepEqual(
      registry.operations().map((descriptor) => descriptor.id().toString()),
      EXPECTED,
    );
    assert.equal(
      registry
        .operations()
        .filter((descriptor) => descriptor.support() === 'Supported')
        .length,
      6,
    );
  }
});

test('descriptor target roles and argument schemas are exact', () => {
  // operation_registry.rs:16-80 — the frozen target roles and argument
  // schemas of the eight operations.
  const registry = iniFormatOperationRegistry(IniProfile.PORTABLE_V1);
  const byId = new Map(
    registry.operations().map((descriptor) => [descriptor.id().toString(), descriptor]),
  );
  assert.equal(byId.get('ini.edit.insert-section@1')!.targetRole().toString(), 'ini.document@1');
  assert.equal(byId.get('ini.edit.remove-section@1')!.targetRole().toString(), 'ini.section@1');
  assert.equal(byId.get('ini.edit.rename-section@1')!.targetRole().toString(), 'ini.section@1');
  assert.equal(byId.get('ini.edit.insert-entry@1')!.targetRole().toString(), 'ini.section@1');
  assert.equal(byId.get('ini.edit.remove-entry@1')!.targetRole().toString(), 'ini.entry@1');
  assert.equal(byId.get('ini.edit.rename-entry@1')!.targetRole().toString(), 'ini.entry@1');
  assert.equal(
    byId.get('ini.edit.replace-semantic-value@1')!.targetRole().toString(),
    'ini.entry@1',
  );
  assert.equal(
    byId.get('ini.edit.replace-literal-value@1')!.targetRole().toString(),
    'ini.entry@1',
  );
  assert.deepEqual(
    byId.get('ini.edit.insert-section@1')!.arguments().map((argument) => argument.name()),
    ['name', 'placement'],
  );
  assert.deepEqual(
    byId.get('ini.edit.insert-entry@1')!.arguments().map((argument) => argument.name()),
    ['key', 'value', 'placement'],
  );
  assert.deepEqual(
    byId.get('ini.edit.replace-semantic-value@1')!.arguments().map((argument) => argument.name()),
    ['value', 'representation_policy'],
  );
  assert.deepEqual(
    byId.get('ini.edit.replace-literal-value@1')!.arguments().map((argument) => argument.name()),
    ['literal'],
  );
});
