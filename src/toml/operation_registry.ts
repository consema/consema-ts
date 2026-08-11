/**
 * The frozen TOML format operation registry.
 *
 * authority: crates/consema-toml/src/operation_registry.rs:16-74 — the
 * exact seven descriptors (ids, target roles, argument schema, support
 * classification) and the canonical id sort of the registry
 * (consema-document/src/operation_registry.rs; the TS document domain
 * FormatOperationRegistry enforces the same validation and sort,
 * typescript/src/document/operation.ts:201-278). RFC 0004 §10 (:256-261)
 * freezes the five structural ids; the two scalar replacements are
 * declared as ExistingTypedCapability (operation_registry.rs:55-72).
 *
 *   toml.edit.insert-entry@1            toml.table-item@1
 *     key:String, value:PortableValue, placement:Placement
 *   toml.edit.remove-entry@1            toml.entry@1
 *   toml.edit.rename-entry@1            toml.entry@1
 *     key:String
 *   toml.edit.insert-array-element@1    toml.array-item@1
 *     value:PortableValue, placement:Placement
 *   toml.edit.remove-array-element@1    toml.array-element@1
 *   toml.edit.replace-scalar-semantic@1 toml.scalar-item@1
 *     value:PortableValue, representation_policy:RepresentationPolicy
 *   toml.edit.replace-scalar-literal@1  toml.scalar-item@1
 *     literal:ExactBytes
 *
 * The Rust test pins the structural surface and the total count
 * (operation_registry.rs:99-118: 7 operations, 5 Supported).
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
import { TomlProfile } from './profile.ts';

/** One frozen TOML operation descriptor (operation_registry.rs:76-88). */
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

/** The seven frozen TOML operation descriptors (operation_registry.rs:16-74). */
export function tomlOperationDescriptors(): readonly FormatOperationDescriptor[] {
  return [
    descriptor('toml.edit.insert-entry', 'toml.table-item', [
      ['key', 'String'],
      ['value', 'PortableValue'],
      ['placement', 'Placement'],
    ], 'Supported'),
    descriptor('toml.edit.remove-entry', 'toml.entry', [], 'Supported'),
    descriptor('toml.edit.rename-entry', 'toml.entry', [['key', 'String']], 'Supported'),
    descriptor('toml.edit.insert-array-element', 'toml.array-item', [
      ['value', 'PortableValue'],
      ['placement', 'Placement'],
    ], 'Supported'),
    descriptor('toml.edit.remove-array-element', 'toml.array-element', [], 'Supported'),
    descriptor('toml.edit.replace-scalar-semantic', 'toml.scalar-item', [
      ['value', 'PortableValue'],
      ['representation_policy', 'RepresentationPolicy'],
    ], 'ExistingTypedCapability'),
    descriptor('toml.edit.replace-scalar-literal', 'toml.scalar-item', [
      ['literal', 'ExactBytes'],
    ], 'ExistingTypedCapability'),
  ];
}

/**
 * Returns the validated operation registry for one exact TOML profile
 * (operation_registry.rs:9-14). Throws FormatOperationRegistryError on an
 * invalid descriptor table — the built-in table is valid by construction.
 */
export function tomlFormatOperationRegistry(profile: TomlProfile): FormatOperationRegistry {
  return FormatOperationRegistry.create(profile.id(), tomlOperationDescriptors());
}
