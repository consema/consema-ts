/**
 * Intent documents for XML projection (L3).
 *
 * Golden transcriptions from the shared vectors — each test cites its
 * case id — plus the exact `xml.element-tree@1` record shape and the
 * explicit-policy entry mapping:
 *  - conformance/vectors/xml-1-0-safe-v1.json: xml.projection.element-
 *    tree-record (:311-325), xml.projection.namespace-record (:327-339),
 *    xml.projection.recovered-never-projects (:341-350)
 *  - the record shape: crates/consema-xml/src/projection.rs:600-644,
 *    669-797, 799-973 (declaration facts, entities, ordered namespaces,
 *    ordered attributes, ordered mixed content, exact fragments)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parse, PROFILE_XML_SAFE } from '../xml/index.ts';
import { project, ProjectionRequest } from '../xml/index.ts';
import { ProjectionFailure } from '../xml/index.ts';
import { DEFAULT_XML_PARSE_LIMITS } from '../xml/profile.ts';
import type { PortableValue } from '../core/value.ts';

function bytes(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

function parseXml(source: string) {
  return parse(bytes(source), PROFILE_XML_SAFE, { kind: 'ProfileDefault' }, DEFAULT_XML_PARSE_LIMITS);
}

function projectedValue(source: string): PortableValue {
  const document = parseXml(source);
  const result = project(document, ProjectionRequest.elementTree());
  assert.equal(result.kind, 'Complete');
  assert.equal(result.projection.fidelity(), 'Exact');
  return result.projection.value();
}

/** The ordered entries of one projected object. */
function objectEntries(
  value: PortableValue,
): readonly { readonly key: string; readonly value: PortableValue }[] {
  assert.equal(value.kind, 'Object');
  return value.entries;
}

/** The string value of one projected string. */
function stringOf(value: PortableValue): string {
  assert.equal(value.kind, 'String');
  return value.value;
}

/** One projected field of an object. */
function objectField(value: PortableValue, key: string): PortableValue {
  const entry = objectEntries(value).find((candidate) => candidate.key === key);
  assert.ok(entry !== undefined, `missing field ${key}`);
  return entry.value;
}

/** Reads one string field of a projected object. */
function objectString(value: PortableValue, key: string): string {
  const field = objectField(value, key);
  assert.equal(field.kind, 'String');
  return field.value;
}

test('xml.projection.element-tree-record: the exact record for a plain document (xml-1-0-safe-v1.json:311-325)', () => {
  const value = projectedValue('<root a="1"><child>t</child></root>');
  assert.equal(objectString(value, 'record'), 'xml.element-tree@1');
  const root = objectField(value, 'root');
  assert.equal(root.kind, 'Object');
  const expandedName = objectField(root, 'expanded-name');
  assert.equal(expandedName.kind, 'Object');
  assert.equal(objectField(expandedName, 'namespace').kind, 'Null');
  assert.equal(objectString(expandedName, 'local'), 'root');
  const attributes = objectField(root, 'attributes');
  assert.equal(attributes.kind, 'Sequence');
  assert.equal(objectString(attributes.items[0], 'value'), '1');
  const content = objectField(root, 'content');
  assert.equal(content.kind, 'Sequence');
  // Element content items carry an expanded-name record, never a kind tag.
  const child = content.items[0];
  assert.equal(child.kind, 'Object');
  const childName = objectField(child, 'expanded-name');
  assert.equal(objectString(childName, 'local'), 'child');
  const childContent = objectField(child, 'content');
  assert.equal(childContent.kind, 'Sequence');
  const text = childContent.items[0];
  assert.equal(objectString(text, 'kind'), 'text');
});

test('xml.projection.namespace-record: expanded names carry the resolved URI (xml-1-0-safe-v1.json:327-339)', () => {
  const value = projectedValue('<p:root xmlns:p="urn:p"/>');
  const root = objectField(value, 'root');
  assert.equal(root.kind, 'Object');
  const expandedName = objectField(root, 'expanded-name');
  assert.equal(objectString(expandedName, 'namespace'), 'urn:p');
  assert.equal(objectString(expandedName, 'local'), 'root');
  const namespaces = objectField(root, 'namespaces');
  assert.equal(namespaces.kind, 'Sequence');
  assert.equal(objectString(namespaces.items[0], 'prefix'), 'p');
  assert.equal(objectString(namespaces.items[0], 'uri'), 'urn:p');
});

test('xml.projection.recovered-never-projects: Recovered documents fail with xml.projection.recovered-document@1 (xml-1-0-safe-v1.json:341-350)', () => {
  const document = parseXml('<p:root/>');
  const result = project(document, ProjectionRequest.elementTree());
  assert.equal(result.kind, 'Failed');
  assert.ok(result.attempt.failure() instanceof ProjectionFailure);
  assert.equal(result.attempt.failure().kind, 'RecoveredDocument');
  assert.equal(result.attempt.failure().code, 'xml.projection.recovered-document@1');
});

test('projection: text fragments stay exact with reference kinds and resolved values', () => {
  const value = projectedValue('<root>a &lt; &#65;</root>');
  const root = objectField(value, 'root');
  const content = objectField(root, 'content');
  assert.equal(content.kind, 'Sequence');
  const text = content.items[0];
  assert.equal(objectString(text, 'kind'), 'text');
  const fragments = objectField(text, 'fragments');
  assert.equal(fragments.kind, 'Sequence');
  assert.equal(objectString(fragments.items[0], 'kind'), 'literal');
  assert.equal(objectString(fragments.items[1], 'kind'), 'predefined-entity');
  assert.equal(objectString(fragments.items[1], 'name'), 'lt');
  assert.equal(objectString(fragments.items[1], 'resolved'), '<');
  assert.equal(objectString(fragments.items[2], 'kind'), 'literal');
  assert.equal(objectString(fragments.items[3], 'kind'), 'character-reference');
  assert.equal(objectString(fragments.items[3], 'resolved'), 'A');
  assert.equal(fragments.items.length, 4);
});

test('projection: declaration and entity facts are projected verbatim', () => {
  const value = projectedValue('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<!DOCTYPE root [<!ENTITY greeting "hello">]><root>&greeting;</root>');
  const declaration = objectField(value, 'declaration');
  assert.equal(declaration.kind, 'Object');
  assert.equal(objectString(declaration, 'version'), '1.0');
  assert.equal(objectString(declaration, 'encoding'), 'UTF-8');
  assert.equal(objectField(declaration, 'standalone').kind, 'Boolean');
  const entities = objectField(value, 'entities');
  assert.equal(entities.kind, 'Sequence');
  assert.equal(objectString(entities.items[0], 'name'), 'greeting');
  assert.equal(objectString(entities.items[0], 'replacement'), 'hello');
});

test('projection: text-content projection is always Transformed and reports discards', () => {
  const document = parseXml('<root>a<child>b</child><![CDATA[c]]><!--d--></root>');
  const root = document.root()!;
  const result = project(document, ProjectionRequest.textContent(root.nodeRef(), 'TextAndCdata'));
  assert.equal(result.kind, 'Complete');
  assert.equal(result.projection.fidelity(), 'Transformed');
  assert.equal(result.projection.value().kind, 'String');
  assert.equal(stringOf(result.projection.value()), 'abc');
  const kinds = result.projection.report().events().map((event) => event.kind());
  assert.ok(kinds.includes('ElementDiscarded'));
  assert.ok(kinds.includes('CommentDiscarded'));
  // TextOnly excludes CDATA and reports it.
  const textOnly = project(document, ProjectionRequest.textContent(root.nodeRef(), 'TextOnly'));
  assert.equal(textOnly.kind, 'Complete');
  assert.equal(stringOf(textOnly.projection.value()), 'ab');
  assert.ok(textOnly.projection.report().events().some((event) => event.kind() === 'CdataDiscarded'));
});

test('projection: simple entry mapping honors its explicit policies', () => {
  const document = parseXml('<root><a>1</a><b>2</b><a>3</a></root>');
  const root = document.root()!;
  const result = project(
    document,
    ProjectionRequest.simpleEntryMapping(
      root.nodeRef(),
      'RejectAttributes',
      'RejectText',
      'First',
      'LocalOnly',
      'Reject',
    ),
  );
  assert.equal(result.kind, 'Complete');
  assert.equal(result.projection.fidelity(), 'Transformed');
  const value = result.projection.value();
  assert.equal(value.kind, 'EntryMapping');
  assert.equal(value.entries.length, 2);
  assert.equal(stringOf(value.entries[0].key), 'a');
  // The retained ordinal keeps the LAST occurrence's value, exactly like
  // the Rust commit_entry replacement (projection.rs:1202-1236).
  assert.equal(stringOf(value.entries[0].value), '3');
  assert.equal(stringOf(value.entries[1].key), 'b');
  assert.equal(stringOf(value.entries[1].value), '2');
});

test('projection: simple entry mapping rejects collisions under Reject with xml.projection.collision@1', () => {
  const document = parseXml('<root><a>1</a><a>2</a></root>');
  const root = document.root()!;
  const result = project(
    document,
    ProjectionRequest.simpleEntryMapping(
      root.nodeRef(),
      'RejectAttributes',
      'RejectText',
      'Reject',
      'LocalOnly',
      'Reject',
    ),
  );
  assert.equal(result.kind, 'Failed');
  assert.equal(result.attempt.failure().kind, 'Collision');
  assert.equal(result.attempt.failure().code, 'xml.projection.collision@1');
});
