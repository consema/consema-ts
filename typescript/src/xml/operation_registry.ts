/**
 * Versioned XML edit-operation discovery for one exact profile.
 *
 * authority: crates/consema-xml/src/operation_registry.rs
 *  - the eight frozen descriptors :16-89 — operation ids, target roles,
 *    argument schemas, and support classification (do not guess):
 *      xml.edit.replace-text@1         xml.text@1
 *        arguments: text(String)
 *      xml.edit.insert-attribute@1    xml.element@1
 *        arguments: name(String) value(String) placement(Placement)
 *      xml.edit.remove-attribute@1    xml.attribute@1
 *      xml.edit.rename-attribute@1    xml.attribute@1
 *        arguments: name(String)
 *      xml.edit.set-attribute-value@1 xml.attribute@1
 *        arguments: value(String)
 *      xml.edit.insert-element@1      xml.element@1
 *        arguments: name(String) content(String) placement(Placement)
 *      xml.edit.remove-element@1      xml.element@1
 *      xml.edit.rename-element@1      xml.element@1
 *        arguments: name(String)
 *  - every XML-family profile publishes the same eight records, all
 *    Supported :99-124
 *  - the frozen eight-operation surface is also pinned by RFC 0012 §11
 *    (:375-387)
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
import { xmlProfileId } from './profile.ts';
import type { XmlProfile } from './profile.ts';

/** Returns the validated operation registry for one exact XML profile (operation_registry.rs:10-14). */
export function formatOperationRegistry(profile: XmlProfile): FormatOperationRegistry {
  return FormatOperationRegistry.create(xmlProfileId(profile), descriptors());
}

function descriptors(): FormatOperationDescriptor[] {
  return [
    descriptor(
      'xml.edit.replace-text',
      'xml.text',
      [argument('text', 'String')],
      'Supported',
    ),
    descriptor(
      'xml.edit.insert-attribute',
      'xml.element',
      [
        argument('name', 'String'),
        argument('value', 'String'),
        argument('placement', 'Placement'),
      ],
      'Supported',
    ),
    descriptor('xml.edit.remove-attribute', 'xml.attribute', [], 'Supported'),
    descriptor(
      'xml.edit.rename-attribute',
      'xml.attribute',
      [argument('name', 'String')],
      'Supported',
    ),
    descriptor(
      'xml.edit.set-attribute-value',
      'xml.attribute',
      [argument('value', 'String')],
      'Supported',
    ),
    descriptor(
      'xml.edit.insert-element',
      'xml.element',
      [
        argument('name', 'String'),
        argument('content', 'String'),
        argument('placement', 'Placement'),
      ],
      'Supported',
    ),
    descriptor('xml.edit.remove-element', 'xml.element', [], 'Supported'),
    descriptor(
      'xml.edit.rename-element',
      'xml.element',
      [argument('name', 'String')],
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
