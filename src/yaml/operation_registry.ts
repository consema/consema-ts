/**
 * Versioned YAML edit-operation discovery for one exact profile.
 *
 * authority: crates/consema-yaml/src/operation_registry.rs
 *  - the eight frozen descriptors :16-83 — operation ids, target roles,
 *    argument schemas, and support classification (do not guess):
 *      yaml.edit.insert-alias@1               yaml.sequence@1
 *        arguments: anchor(NodeRef) placement(Placement)
 *      yaml.edit.insert-mapping-entry@1      yaml.mapping@1
 *        arguments: key(PortableValue) value(PortableValue)
 *          placement(Placement)
 *      yaml.edit.insert-sequence-element@1   yaml.sequence@1
 *        arguments: value(PortableValue) placement(Placement)
 *      yaml.edit.remove-mapping-entry@1      yaml.mapping-entry@1
 *      yaml.edit.remove-sequence-element@1   yaml.sequence-element@1
 *      yaml.edit.rename-anchor@1             yaml.anchor-definition@1
 *        arguments: name(String)
 *      yaml.edit.replace-scalar-literal@1    yaml.scalar@1
 *        arguments: literal(ExactBytes)
 *        support: ExistingTypedCapability
 *      yaml.edit.replace-scalar-semantic@1   yaml.scalar@1
 *        arguments: value(PortableValue)
 *          representation_policy(RepresentationPolicy)
 *        support: ExistingTypedCapability
 *  - both YAML profiles publish the same eight records :107-135 (the six
 *    structural ops are Supported; the two scalar ops are
 *    ExistingTypedCapability)
 *  - registry validation/canonicalization: typescript/src/document/
 *    operation.ts (FormatOperationRegistry.create)
 *  - RFC 0007 §12 (:357-368) freezes the structural ids
 *
 * Design (TypeScript-idiomatic): one immutable registry per exact
 * profile; the shared registry record type validates and canonicalizes
 * the descriptors (canonical id sort, exact-version lookup).
 */

import {
  FormatOperationDescriptor,
  FormatOperationId,
  FormatOperationRegistry,
  OperationArgumentDescriptor,
  OperationTargetRoleId,
} from '../document/operation.ts';
import type { OperationArgumentKind, OperationSupport } from '../document/operation.ts';
import { yamlProfileId } from './profile.ts';
import type { YamlProfile } from './profile.ts';

/** Returns the validated operation registry for one exact YAML profile (operation_registry.rs:9-14). */
export function formatOperationRegistry(profile: YamlProfile): FormatOperationRegistry {
  return FormatOperationRegistry.create(yamlProfileId(profile), descriptors());
}

function descriptors(): FormatOperationDescriptor[] {
  return [
    descriptor(
      'yaml.edit.insert-alias',
      'yaml.sequence',
      [
        argument('anchor', 'NodeRef'),
        argument('placement', 'Placement'),
      ],
      'Supported',
    ),
    descriptor(
      'yaml.edit.insert-mapping-entry',
      'yaml.mapping',
      [
        argument('key', 'PortableValue'),
        argument('value', 'PortableValue'),
        argument('placement', 'Placement'),
      ],
      'Supported',
    ),
    descriptor(
      'yaml.edit.insert-sequence-element',
      'yaml.sequence',
      [
        argument('value', 'PortableValue'),
        argument('placement', 'Placement'),
      ],
      'Supported',
    ),
    descriptor('yaml.edit.remove-mapping-entry', 'yaml.mapping-entry', [], 'Supported'),
    descriptor('yaml.edit.remove-sequence-element', 'yaml.sequence-element', [], 'Supported'),
    descriptor(
      'yaml.edit.rename-anchor',
      'yaml.anchor-definition',
      [argument('name', 'String')],
      'Supported',
    ),
    descriptor(
      'yaml.edit.replace-scalar-literal',
      'yaml.scalar',
      [argument('literal', 'ExactBytes')],
      'ExistingTypedCapability',
    ),
    descriptor(
      'yaml.edit.replace-scalar-semantic',
      'yaml.scalar',
      [
        argument('value', 'PortableValue'),
        argument('representation_policy', 'RepresentationPolicy'),
      ],
      'ExistingTypedCapability',
    ),
  ];
}

function descriptor(
  id: string,
  targetRole: string,
  arguments_: OperationArgumentDescriptor[],
  support: OperationSupport,
): FormatOperationDescriptor {
  return new FormatOperationDescriptor(
    new FormatOperationId(id, 1),
    new OperationTargetRoleId(targetRole, 1),
    arguments_,
    support,
  );
}

function argument(name: string, kind: OperationArgumentKind): OperationArgumentDescriptor {
  return new OperationArgumentDescriptor(name, kind, true);
}
