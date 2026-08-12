/**
 * Intent documents for XML canonical materialization (L3).
 *
 * Golden transcriptions from the shared vectors — each test cites its
 * case id — plus the closure contract (reparse + semantic comparison)
 * and the representability boundary:
 *  - conformance/vectors/xml-1-0-safe-v1.json: xml.materialization.
 *    canonical-round-trip (:352-388), xml.materialization.escapes-content
 *    (:390-417), xml.materialization.invalid-record-rejected (:419-435)
 *  - the canonical style: crates/consema-xml/src/materialization.rs
 *    (double-quoted attributes, first-use namespace placement, empty-
 *    element spelling, reference spelling, LF/CRLF final newline)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parse, PROFILE_XML_SAFE } from '../xml/index.ts';
import { project, ProjectionRequest } from '../xml/index.ts';
import { materialize } from '../xml/index.ts';
import { DEFAULT_XML_PARSE_LIMITS } from '../xml/profile.ts';
import { MaterializationRequest, MaterializationStyleId } from '../document/materialization.ts';
import { ProfileId } from '../document/profile.ts';
import { nullValue, objectValue, sequenceValue, stringValue } from '../core/value.ts';
import type { PortableValue } from '../core/value.ts';

function bytes(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

function request(): MaterializationRequest {
  return new MaterializationRequest(
    new ProfileId('xml.1.0-safe', 1),
    new MaterializationStyleId('xml.safe-canonical-document', 1),
  );
}

function render(result: { kind: 'Complete' | 'Failed' }): string {
  assert.equal(result.kind, 'Complete');
  const complete = result as { kind: 'Complete'; value: { document(): { render(): Uint8Array } } };
  return new TextDecoder().decode(complete.value.document().render());
}

/** Unwraps a failed attempt's stable failure kind. */
function failureKind(result: { kind: 'Complete' | 'Failed' }): string {
  assert.equal(result.kind, 'Failed');
  const failed = result as { kind: 'Failed'; value: { failure(): { kind: string } } };
  return failed.value.failure().kind;
}

test('xml.materialization.canonical-round-trip: the element-tree record materializes canonically (xml-1-0-safe-v1.json:352-388)', () => {
  const value = objectValue([
    { key: 'record', value: stringValue('xml.element-tree@1') },
    {
      key: 'root',
      value: objectValue([
        {
          key: 'expanded-name',
          value: objectValue([
            { key: 'namespace', value: nullValue() },
            { key: 'local', value: stringValue('root') },
          ]),
        },
        {
          key: 'attributes',
          value: sequenceValue([
            objectValue([
              {
                key: 'expanded-name',
                value: objectValue([
                  { key: 'namespace', value: nullValue() },
                  { key: 'local', value: stringValue('a') },
                ]),
              },
              { key: 'value', value: stringValue('1') },
            ]),
          ]),
        },
        {
          key: 'content',
          value: sequenceValue([
            objectValue([
              { key: 'kind', value: stringValue('text') },
              {
                key: 'fragments',
                value: sequenceValue([
                  objectValue([
                    { key: 'kind', value: stringValue('literal') },
                    { key: 'text', value: stringValue('t') },
                  ]),
                ]),
              },
            ]),
          ]),
        },
      ]),
    },
  ]);
  const result = materialize(value, request());
  assert.equal(render(result), '<root a="1">t</root>\n');
});

test('xml.materialization.escapes-content: literals are XML-escaped, never interpolated (xml-1-0-safe-v1.json:390-417)', () => {
  const value = objectValue([
    { key: 'record', value: stringValue('xml.element-tree@1') },
    {
      key: 'root',
      value: objectValue([
        {
          key: 'expanded-name',
          value: objectValue([
            { key: 'namespace', value: nullValue() },
            { key: 'local', value: stringValue('root') },
          ]),
        },
        {
          key: 'content',
          value: sequenceValue([
            objectValue([
              { key: 'kind', value: stringValue('text') },
              {
                key: 'fragments',
                value: sequenceValue([
                  objectValue([
                    { key: 'kind', value: stringValue('literal') },
                    { key: 'text', value: stringValue('a < b & c') },
                  ]),
                ]),
              },
            ]),
          ]),
        },
      ]),
    },
  ]);
  const result = materialize(value, request());
  assert.equal(render(result), '<root>a &lt; b &amp; c</root>\n');
});

test('xml.materialization.invalid-record-rejected: a foreign record id fails with no partial output (xml-1-0-safe-v1.json:419-435)', () => {
  const value = objectValue([
    { key: 'record', value: stringValue('xml.something-else@1') },
    {
      key: 'root',
      value: objectValue([
        {
          key: 'expanded-name',
          value: objectValue([
            { key: 'namespace', value: nullValue() },
            { key: 'local', value: stringValue('root') },
          ]),
        },
      ]),
    },
  ]);
  const result = materialize(value, request());
  assert.equal(result.kind, 'Failed');
  assert.equal(failureKind(result), 'InvalidRequest');
});

test('materialization: projection then materialization round-trips the native tree', () => {
  const source = '<root a="1"><child>t</child></root>';
  const document = parse(bytes(source), PROFILE_XML_SAFE, { kind: 'ProfileDefault' }, DEFAULT_XML_PARSE_LIMITS);
  const projected = project(document, ProjectionRequest.elementTree());
  assert.equal(projected.kind, 'Complete');
  const result = materialize(projected.projection.value(), request());
  assert.equal(render(result), '<root a="1"><child>t</child></root>\n');
});

test('materialization: namespace facts are reproduced with first-use declaration placement', () => {
  const value = objectValue([
    { key: 'record', value: stringValue('xml.element-tree@1') },
    {
      key: 'root',
      value: objectValue([
        {
          key: 'expanded-name',
          value: objectValue([
            { key: 'namespace', value: stringValue('urn:p') },
            { key: 'local', value: stringValue('root') },
          ]),
        },
        {
          key: 'namespaces',
          value: sequenceValue([
            objectValue([
              { key: 'prefix', value: stringValue('p') },
              { key: 'uri', value: stringValue('urn:p') },
            ]),
          ]),
        },
        {
          key: 'content',
          value: sequenceValue([
            objectValue([
              {
                key: 'expanded-name',
                value: objectValue([
                  { key: 'namespace', value: stringValue('urn:q') },
                  { key: 'local', value: stringValue('child') },
                ]),
              },
              {
                key: 'namespaces',
                value: sequenceValue([
                  objectValue([
                    { key: 'prefix', value: stringValue('q') },
                    { key: 'uri', value: stringValue('urn:q') },
                  ]),
                ]),
              },
            ]),
          ]),
        },
      ]),
    },
  ]);
  const result = materialize(value, request());
  assert.equal(render(result), '<p:root xmlns:p="urn:p"><q:child xmlns:q="urn:q"/></p:root>\n');
});

test('materialization: an unbound element namespace fails exactly like the Rust crate (probed at write time)', () => {
  // The Rust writer's unbound-element fallback emits malformed output that
  // fails the reparse closure (FormationFailed); the vector never
  // exercises it and the closure contract forbids partial output.
  const value = objectValue([
    { key: 'record', value: stringValue('xml.element-tree@1') },
    {
      key: 'root',
      value: objectValue([
        {
          key: 'expanded-name',
          value: objectValue([
            { key: 'namespace', value: stringValue('urn:p') },
            { key: 'local', value: stringValue('root') },
          ]),
        },
        {
          key: 'namespaces',
          value: sequenceValue([
            objectValue([
              { key: 'prefix', value: stringValue('p') },
              { key: 'uri', value: stringValue('urn:p') },
            ]),
          ]),
        },
        {
          key: 'content',
          value: sequenceValue([
            objectValue([
              {
                key: 'expanded-name',
                value: objectValue([
                  { key: 'namespace', value: stringValue('urn:q') },
                  { key: 'local', value: stringValue('child') },
                ]),
              },
            ]),
          ]),
        },
      ]),
    },
  ]);
  const result = materialize(value, request());
  assert.equal(result.kind, 'Failed');
  assert.equal(failureKind(result), 'FormationFailed');
});

test('materialization: UTF-16 output carries its BOM under the source rules', () => {
  const value = objectValue([
    { key: 'record', value: stringValue('xml.element-tree@1') },
    {
      key: 'root',
      value: objectValue([
        {
          key: 'expanded-name',
          value: objectValue([
            { key: 'namespace', value: nullValue() },
            { key: 'local', value: stringValue('root') },
          ]),
        },
      ]),
    },
  ]);
  const utf16 = materialize(value, request().withEncoding({ kind: 'Utf16Le' }));
  assert.equal(utf16.kind, 'Complete');
  const complete = utf16 as { kind: 'Complete'; value: { document(): { render(): Uint8Array } } };
  const bytes16 = complete.value.document().render();
  assert.equal(bytes16[0], 0xff, 'UTF-16LE BOM first byte');
  assert.equal(bytes16[1], 0xfe, 'UTF-16LE BOM second byte');
});

test('materialization: unrepresentable content fails without a partial document', () => {
  const value = objectValue([
    { key: 'record', value: stringValue('xml.element-tree@1') },
    {
      key: 'root',
      value: objectValue([
        {
          key: 'expanded-name',
          value: objectValue([
            { key: 'namespace', value: nullValue() },
            { key: 'local', value: stringValue('root') },
          ]),
        },
        {
          key: 'content',
          value: sequenceValue([
            objectValue([
              { key: 'kind', value: stringValue('comment') },
              { key: 'text', value: stringValue('bad -- comment') },
            ]),
          ]),
        },
      ]),
    },
  ]);
  const result = materialize(value, request());
  assert.equal(result.kind, 'Failed');
  assert.equal(failureKind(result), 'Unrepresentable');
});

test('materialization: an entity replacement that would create markup is rejected', () => {
  const value = objectValue([
    { key: 'record', value: stringValue('xml.element-tree@1') },
    {
      key: 'entities',
      value: sequenceValue([
        objectValue([
          { key: 'name', value: stringValue('bad') },
          { key: 'replacement', value: stringValue('x < y') },
        ]),
      ]),
    },
    {
      key: 'root',
      value: objectValue([
        {
          key: 'expanded-name',
          value: objectValue([
            { key: 'namespace', value: nullValue() },
            { key: 'local', value: stringValue('root') },
          ]),
        },
      ]),
    },
  ]);
  const result = materialize(value, request());
  assert.equal(result.kind, 'Failed');
  assert.equal(failureKind(result), 'Unrepresentable');
});
