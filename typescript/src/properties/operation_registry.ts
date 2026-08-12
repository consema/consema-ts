/**
 * Versioned Java Properties edit-operation discovery for one exact profile.
 *
 * authority: crates/consema-properties/src/operation_registry.rs
 *  - the five frozen descriptors :16-48 — operation ids, target roles,
 *    argument schemas, and support classification (do not guess):
 *      java-properties.edit.insert-property@1       java-properties.document@1
 *        arguments: key(PortableValue) value(PortableValue) placement(Placement)
 *      java-properties.edit.remove-property@1       java-properties.property@1
 *      java-properties.edit.rename-property@1       java-properties.property@1
 *        arguments: key(PortableValue)
 *      java-properties.edit.replace-literal-value@1 java-properties.property@1
 *        arguments: literal(ExactBytes)
 *      java-properties.edit.replace-semantic-value@1 java-properties.property@1
 *        arguments: value(PortableValue)
 *  - every descriptor is OperationSupport::Supported (operation_registry.rs:89-93)
 *  - both profiles publish the same frozen five-operation surface
 *    (operation_registry.rs:72-95; RFC 0010 §13 :385-393)
 *  - registry validation/canonicalization: typescript/src/document/
 *    operation.ts (FormatOperationRegistry.create)
 *  - the vector pins the exact ordered list: conformance/vectors/
 *    java-properties-v1.json:149 ("registry.frozen-five-operation-surface")
 *
 * Design (TypeScript-idiomatic): one immutable registry per exact profile;
 * the shared registry record type validates and canonicalizes the
 * descriptors (canonical id sort, exact-version lookup).
 */

import {
  FormatOperationDescriptor,
  FormatOperationId,
  FormatOperationRegistry,
  OperationArgumentDescriptor,
  OperationTargetRoleId,
} from '../document/operation.ts';
import type { OperationArgumentKind, OperationSupport } from '../document/operation.ts';
import { propertiesProfileId } from './profile.ts';
import type { PropertiesProfile } from './profile.ts';

/** Returns the validated operation registry for one exact Properties profile (operation_registry.rs:9-14). */
export function formatOperationRegistry(profile: PropertiesProfile): FormatOperationRegistry {
  return FormatOperationRegistry.create(propertiesProfileId(profile), descriptors());
}

function descriptors(): FormatOperationDescriptor[] {
  return [
    descriptor(
      'java-properties.edit.insert-property',
      'java-properties.document',
      [
        argument('key', 'PortableValue'),
        argument('value', 'PortableValue'),
        argument('placement', 'Placement'),
      ],
      'Supported',
    ),
    descriptor('java-properties.edit.remove-property', 'java-properties.property', [], 'Supported'),
    descriptor(
      'java-properties.edit.rename-property',
      'java-properties.property',
      [argument('key', 'PortableValue')],
      'Supported',
    ),
    descriptor(
      'java-properties.edit.replace-literal-value',
      'java-properties.property',
      [argument('literal', 'ExactBytes')],
      'Supported',
    ),
    descriptor(
      'java-properties.edit.replace-semantic-value',
      'java-properties.property',
      [argument('value', 'PortableValue')],
      'Supported',
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
