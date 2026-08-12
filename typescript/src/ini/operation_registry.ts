/**
 * The frozen INI format operation registry.
 *
 * authority: crates/consema-ini/src/operation_registry.rs:16-80 — the
 * exact eight descriptors (ids, target roles, argument schema, support
 * classification) shared by all three INI profiles; the canonical id sort
 * of the registry (consema-document/src/operation_registry.rs; the TS
 * document domain FormatOperationRegistry enforces the same validation and
 * sort, typescript/src/document/operation.ts:201-278). RFC 0009 §12
 * (:439-450) freezes the eight ids; the two scalar replacements are
 * declared as ExistingTypedCapability (operation_registry.rs:61-78).
 * The Rust test pins the surface: 8 operations, 6 Supported for every
 * profile (operation_registry.rs:100-137); the vector pins it end-to-end
 * (conformance/vectors/ini-v1.json:136-139 "direct_structural": 6).
 *
 *   ini.edit.insert-section@1           ini.document@1
 *     name:String, placement:Placement
 *   ini.edit.remove-section@1           ini.section@1
 *   ini.edit.rename-section@1           ini.section@1
 *     name:String
 *   ini.edit.insert-entry@1             ini.section@1
 *     key:String, value:String, placement:Placement
 *   ini.edit.remove-entry@1             ini.entry@1
 *   ini.edit.rename-entry@1             ini.entry@1
 *     key:String
 *   ini.edit.replace-semantic-value@1   ini.entry@1
 *     value:String, representation_policy:RepresentationPolicy
 *   ini.edit.replace-literal-value@1    ini.entry@1
 *     literal:ExactBytes
 *
 * Design (TypeScript-idiomatic): a pure descriptor table; the document
 * domain's FormatOperationRegistry validates and canonicalizes it.
 */

import {
  FormatOperationDescriptor,
  FormatOperationId,
  FormatOperationRegistry,
  OperationArgumentDescriptor,
  OperationTargetRoleId,
} from '../document/operation.ts';
import type { OperationArgumentKind, OperationSupport } from '../document/operation.ts';
import { IniProfile } from './profile.ts';

/** One frozen INI operation descriptor (operation_registry.rs:81-98). */
function descriptor(
  id: string,
  targetRole: string,
  arguments_: readonly [string, OperationArgumentKind][],
  support: OperationSupport,
): FormatOperationDescriptor {
  return new FormatOperationDescriptor(
    new FormatOperationId(id, 1),
    new OperationTargetRoleId(targetRole, 1),
    arguments_.map(([name, kind]) => new OperationArgumentDescriptor(name, kind, true)),
    support,
  );
}

/** The eight frozen INI operation descriptors (operation_registry.rs:16-80). */
export function iniOperationDescriptors(): readonly FormatOperationDescriptor[] {
  return [
    descriptor('ini.edit.insert-section', 'ini.document', [
      ['name', 'String'],
      ['placement', 'Placement'],
    ], 'Supported'),
    descriptor('ini.edit.remove-section', 'ini.section', [], 'Supported'),
    descriptor('ini.edit.rename-section', 'ini.section', [['name', 'String']], 'Supported'),
    descriptor('ini.edit.insert-entry', 'ini.section', [
      ['key', 'String'],
      ['value', 'String'],
      ['placement', 'Placement'],
    ], 'Supported'),
    descriptor('ini.edit.remove-entry', 'ini.entry', [], 'Supported'),
    descriptor('ini.edit.rename-entry', 'ini.entry', [['key', 'String']], 'Supported'),
    descriptor('ini.edit.replace-semantic-value', 'ini.entry', [
      ['value', 'String'],
      ['representation_policy', 'RepresentationPolicy'],
    ], 'ExistingTypedCapability'),
    descriptor('ini.edit.replace-literal-value', 'ini.entry', [
      ['literal', 'ExactBytes'],
    ], 'ExistingTypedCapability'),
  ];
}

/**
 * Returns the validated operation registry for one exact INI profile
 * (operation_registry.rs:9-14). Every INI profile publishes the same
 * frozen eight-operation surface (RFC 0009 §12:437-440). Throws
 * FormatOperationRegistryError on an invalid descriptor table — the
 * built-in table is valid by construction.
 */
export function iniFormatOperationRegistry(profile: IniProfile): FormatOperationRegistry {
  return FormatOperationRegistry.create(profile.id(), iniOperationDescriptors());
}
