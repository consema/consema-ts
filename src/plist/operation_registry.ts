/**
 * Versioned plist edit-operation discovery for one exact profile.
 *
 * authority: crates/consema-plist/src/operation_registry.rs
 *  - the six frozen descriptors :20-83 — operation ids, target roles,
 *    argument schemas, and support classification (do not guess):
 *      plist.edit.set-value@1              plist.value@1
 *        arguments: path(NodeRef) value(PortableValue)
 *      plist.edit.insert-dict-entry@1     plist.value@1
 *        arguments: path(NodeRef) key(String) value(PortableValue)
 *          placement(Placement)
 *      plist.edit.remove-dict-entry@1     plist.dict-entry@1
 *        arguments: path(NodeRef) key(String) occurrence(NodeRef)
 *      plist.edit.rename-dict-key@1       plist.dict-entry@1
 *        arguments: path(NodeRef) from(String) occurrence(NodeRef)
 *          to(String)
 *      plist.edit.insert-array-element@1  plist.value@1
 *        arguments: path(NodeRef) index(NodeRef) value(PortableValue)
 *      plist.edit.remove-array-element@1  plist.array-element@1
 *        arguments: path(NodeRef) index(NodeRef)
 *  - both profiles publish the same six operations, all Supported
 *    (operation_registry.rs:108-132); RFC 0013 §11 (:683-695)
 *  - registry validation/canonicalization: typescript/src/document/
 *    operation.ts (FormatOperationRegistry.create)
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
import { plistProfileId } from './profile.ts';
import type { PlistProfile } from './profile.ts';

/** Returns the validated operation registry for one exact plist profile (operation_registry.rs:15-18). */
export function formatOperationRegistry(profile: PlistProfile): FormatOperationRegistry {
  return FormatOperationRegistry.create(plistProfileId(profile), descriptors());
}

function descriptors(): FormatOperationDescriptor[] {
  return [
    descriptor(
      'plist.edit.set-value',
      'plist.value',
      [
        argument('path', 'NodeRef'),
        argument('value', 'PortableValue'),
      ],
      'Supported',
    ),
    descriptor(
      'plist.edit.insert-dict-entry',
      'plist.value',
      [
        argument('path', 'NodeRef'),
        argument('key', 'String'),
        argument('value', 'PortableValue'),
        argument('placement', 'Placement'),
      ],
      'Supported',
    ),
    descriptor(
      'plist.edit.remove-dict-entry',
      'plist.dict-entry',
      [
        argument('path', 'NodeRef'),
        argument('key', 'String'),
        argument('occurrence', 'NodeRef'),
      ],
      'Supported',
    ),
    descriptor(
      'plist.edit.rename-dict-key',
      'plist.dict-entry',
      [
        argument('path', 'NodeRef'),
        argument('from', 'String'),
        argument('occurrence', 'NodeRef'),
        argument('to', 'String'),
      ],
      'Supported',
    ),
    descriptor(
      'plist.edit.insert-array-element',
      'plist.value',
      [
        argument('path', 'NodeRef'),
        argument('index', 'NodeRef'),
        argument('value', 'PortableValue'),
      ],
      'Supported',
    ),
    descriptor(
      'plist.edit.remove-array-element',
      'plist.array-element',
      [
        argument('path', 'NodeRef'),
        argument('index', 'NodeRef'),
      ],
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
