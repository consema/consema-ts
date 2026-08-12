/**
 * Versioned JSON edit-operation discovery for one exact profile.
 *
 * authority: crates/consema-json/src/operation_registry.rs
 *  - the eight frozen descriptors :16-80 — operation ids, target roles,
 *    argument schemas, and support classification (do not guess):
 *      json.edit.insert-member@1             json.object@1
 *        arguments: name(String) value(PortableValue) placement(Placement)
 *      json.edit.remove-member@1             json.object-member@1
 *      json.edit.move-member@1               json.object-member@1
 *        arguments: placement(Placement)
 *      json.edit.rename-member@1             json.object-member@1
 *        arguments: name(String)
 *      json.edit.insert-array-element@1      json.array@1
 *        arguments: value(PortableValue) placement(Placement)
 *      json.edit.remove-array-element@1      json.array-element@1
 *      json.edit.replace-scalar-semantic@1   json.scalar@1
 *        arguments: value(PortableValue) representation_policy(RepresentationPolicy)
 *        support: ExistingTypedCapability
 *      json.edit.replace-scalar-literal@1    json.scalar@1
 *        arguments: literal(ExactBytes)
 *        support: ExistingTypedCapability
 *  - every JSON-family profile publishes the same eight records :104-129
 *    (the six structural ops are Supported; the two scalar ops are
 *    ExistingTypedCapability)
 *  - registry validation/canonicalization: typescript/src/document/
 *    operation.ts (FormatOperationRegistry.create)
 *  - RFC 0004 §10 (:244-269) freezes the structural ids
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
import { jsonProfileId } from './profile.ts';
import type { JsonProfile } from './profile.ts';

/** Returns the validated operation registry for one exact JSON-family profile (operation_registry.rs:10-14). */
export function formatOperationRegistry(profile: JsonProfile): FormatOperationRegistry {
  return FormatOperationRegistry.create(jsonProfileId(profile), descriptors());
}

function descriptors(): FormatOperationDescriptor[] {
  return [
    descriptor(
      'json.edit.insert-member',
      'json.object',
      [
        argument('name', 'String'),
        argument('value', 'PortableValue'),
        argument('placement', 'Placement'),
      ],
      'Supported',
    ),
    descriptor('json.edit.remove-member', 'json.object-member', [], 'Supported'),
    descriptor(
      'json.edit.move-member',
      'json.object-member',
      [argument('placement', 'Placement')],
      'Supported',
    ),
    descriptor(
      'json.edit.rename-member',
      'json.object-member',
      [argument('name', 'String')],
      'Supported',
    ),
    descriptor(
      'json.edit.insert-array-element',
      'json.array',
      [
        argument('value', 'PortableValue'),
        argument('placement', 'Placement'),
      ],
      'Supported',
    ),
    descriptor('json.edit.remove-array-element', 'json.array-element', [], 'Supported'),
    descriptor(
      'json.edit.replace-scalar-semantic',
      'json.scalar',
      [
        argument('value', 'PortableValue'),
        argument('representation_policy', 'RepresentationPolicy'),
      ],
      'ExistingTypedCapability',
    ),
    descriptor(
      'json.edit.replace-scalar-literal',
      'json.scalar',
      [argument('literal', 'ExactBytes')],
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
