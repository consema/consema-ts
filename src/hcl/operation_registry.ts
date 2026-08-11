/**
 * The frozen HCL format operation registry.
 *
 * authority: crates/consema-hcl/src/operation_registry.rs:16-94 — the exact
 * descriptors (ids, target roles, argument schema, support classification)
 * and the profile split (:10-23): `hcl.native@1` publishes all six
 * structural operations, `hcl.tfvars@1` the four attribute operations only
 * (RFC 0014 §5, §10). The canonical id sort of the registry is enforced by
 * the document domain FormatOperationRegistry
 * (typescript/src/document/operation.ts:201-278).
 *
 *   hcl.edit.insert-attribute@1     hcl.body@1
 *     name:String, value:PortableValue, placement:Placement
 *   hcl.edit.remove-attribute@1     hcl.attribute@1
 *   hcl.edit.rename-attribute@1     hcl.attribute@1
 *     name:String
 *   hcl.edit.set-attribute-value@1  hcl.attribute@1
 *     value:PortableValue
 *   hcl.edit.insert-block@1         hcl.body@1
 *     type:String, labels:String, attributes:PortableValue, placement:Placement
 *   hcl.edit.remove-block@1         hcl.block@1
 *
 * The Rust test pins the surface: six operations for native, four for
 * tfvars, all Supported (operation_registry.rs:100-157).
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
import { HclProfile } from './profile.ts';

/** One frozen HCL operation descriptor (operation_registry.rs:82-98). */
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

/** The attribute-only surface of `hcl.tfvars@1` (operation_registry.rs:49-80). */
function tfvarsDescriptors(): readonly FormatOperationDescriptor[] {
  return [
    descriptor('hcl.edit.insert-attribute', 'hcl.body', [
      ['name', 'String'],
      ['value', 'PortableValue'],
      ['placement', 'Placement'],
    ], 'Supported'),
    descriptor('hcl.edit.remove-attribute', 'hcl.attribute', [], 'Supported'),
    descriptor('hcl.edit.rename-attribute', 'hcl.attribute', [['name', 'String']], 'Supported'),
    descriptor('hcl.edit.set-attribute-value', 'hcl.attribute', [['value', 'PortableValue']], 'Supported'),
  ];
}

/** The full six-operation surface of `hcl.native@1` (operation_registry.rs:26-46). */
export function hclOperationDescriptors(profile: HclProfile): readonly FormatOperationDescriptor[] {
  if (profile.isTfvars()) {
    return tfvarsDescriptors();
  }
  return [
    ...tfvarsDescriptors(),
    descriptor('hcl.edit.insert-block', 'hcl.body', [
      ['type', 'String'],
      ['labels', 'String'],
      ['attributes', 'PortableValue'],
      ['placement', 'Placement'],
    ], 'Supported'),
    descriptor('hcl.edit.remove-block', 'hcl.block', [], 'Supported'),
  ];
}

/**
 * Returns the validated operation registry for one exact HCL profile
 * (operation_registry.rs:16-23). Throws FormatOperationRegistryError on an
 * invalid descriptor table — the built-in table is valid by construction.
 */
export function hclFormatOperationRegistry(profile: HclProfile): FormatOperationRegistry {
  return FormatOperationRegistry.create(profile.id(), hclOperationDescriptors(profile));
}
