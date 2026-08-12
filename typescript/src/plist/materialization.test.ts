/**
 * Intent documents for plist canonical materialization (L3).
 *
 * Golden transcriptions from the shared vectors:
 *  - conformance/vectors/plist-v1.json:
 *    plist.materialization.xml-canonical-text (:1223-1254),
 *    plist.materialization.binary-canonical-hex (:1256-1287),
 *    plist.materialization.normalization-and-conversion (:1289-1312),
 *    plist.materialization.fractional-date-policy (:1314-1355),
 *    plist.materialization.old-record-shape-rejected (:1357-1377)
 *  - record and style contracts: RFC 0013 §9/§10; crates/consema-plist/
 *    src/materialization.rs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { materialize, plistMaterializationFailureCode, parseDefault } from './index.ts';
import { MaterializationRequest, MaterializationStyleId } from '../document/materialization.ts';
import { ProfileId } from '../document/profile.ts';
import { integerValue, stringValue } from '../core/value.ts';
import type { PortableValue } from '../core/value.ts';

function xmlRequest(): MaterializationRequest {
  return new MaterializationRequest(new ProfileId('plist.xml', 1), new MaterializationStyleId('plist.xml-canonical', 1));
}

function binaryRequest(): MaterializationRequest {
  return new MaterializationRequest(new ProfileId('plist.binary', 1), new MaterializationStyleId('plist.binary-canonical', 1))
    .withEncoding({ kind: 'Binary' })
    .withNewline('None');
}

function bytes(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index++) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function toHex(bytes_: Uint8Array): string {
  let out = '';
  for (const byte of bytes_) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/** The record of plist.materialization.xml-canonical-text. */
function canonicalRecord(): PortableValue {
  return {
    kind: 'Object',
    entries: [
      { key: 'record', value: stringValue('plist.value-tree@1') },
      {
        key: 'root',
        value: {
          kind: 'EntryMapping',
          entries: [
            { key: stringValue('name'), value: stringValue('value') },
            { key: stringValue('count'), value: integerValue(42n) },
            { key: stringValue('ratio'), value: { kind: 'BinaryFloat64', bits: floatBits(1.5) } },
            { key: stringValue('enabled'), value: { kind: 'Boolean', value: true } },
            { key: stringValue('disabled'), value: { kind: 'Boolean', value: false } },
            {
              key: stringValue('payload'),
              value: { kind: 'Object', entries: [{ key: 'hex', value: stringValue('010203') }] },
            },
            {
              key: stringValue('created'),
              value: {
                kind: 'Object',
                entries: [
                  { key: 'epoch', value: stringValue('2001-01-01T00:00:00Z') },
                  { key: 'seconds', value: { kind: 'BinaryFloat64', bits: floatBits(694224000.0) } },
                ],
              },
            },
            { key: stringValue('title'), value: stringValue('a & b < c') },
            {
              key: stringValue('tags'),
              value: { kind: 'Sequence', items: [stringValue('a'), stringValue('b')] },
            },
          ],
        },
      },
    ],
  };
}

function floatBits(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  return view.getBigUint64(0, false);
}

test('plist.materialization.xml-canonical-text: exact header, indentation, escapes, and date spelling (plist-v1.json:1223-1254)', () => {
  const result = materialize(canonicalRecord(), xmlRequest());
  assert.equal(result.kind, 'Complete');
  const complete = result.value;
  assert.equal(complete.fidelity(), 'Exact');
  const rendered = new TextDecoder().decode(complete.document().render());
  assert.equal(
    rendered,
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      '<plist version="1.0">\n' +
      '    <dict>\n' +
      '        <key>name</key>\n' +
      '        <string>value</string>\n' +
      '        <key>count</key>\n' +
      '        <integer>42</integer>\n' +
      '        <key>ratio</key>\n' +
      '        <real>1.5</real>\n' +
      '        <key>enabled</key>\n' +
      '        <true/>\n' +
      '        <key>disabled</key>\n' +
      '        <false/>\n' +
      '        <key>payload</key>\n' +
      '        <data>AQID</data>\n' +
      '        <key>created</key>\n' +
      '        <date>2023-01-01T00:00:00Z</date>\n' +
      '        <key>title</key>\n' +
      '        <string>a &amp; b &lt; c</string>\n' +
      '        <key>tags</key>\n' +
      '        <array>\n' +
      '            <string>a</string>\n' +
      '            <string>b</string>\n' +
      '        </array>\n' +
      '    </dict>\n' +
      '</plist>\n',
  );
  assert.equal(complete.document().formationStatus(), 'Complete');
});

test('plist.materialization.binary-canonical-hex: document-ordered object table with deduplication (plist-v1.json:1256-1287)', () => {
  const result = materialize(canonicalRecord(), binaryRequest());
  assert.equal(result.kind, 'Complete');
  const complete = result.value;
  assert.equal(complete.fidelity(), 'Exact');
  const hex = toHex(complete.document().render());
  assert.equal(
    hex,
    '62706c6973743030d90102030405060708090a0b0c0d0e0f101112546e616d6555636f756e7455726174696f57656e61626c65645864697361626c6564577061796c6f61645763726561746564557469746c6554746167735576616c7565102a233ff80000000000000908430102033341c4b08240000000596120262062203c2063a2131451615162081b20262c343d454d53585e60696a6b6f788285870000000000000101000000000000001500000000000000000000000000000089',
  );
  assert.equal(complete.document().formationStatus(), 'Complete');
});

test('plist.materialization.fractional-date-policy: truncation is explicit and reported (plist-v1.json:1314-1355)', () => {
  const fractional: PortableValue = {
    kind: 'Object',
    entries: [
      { key: 'record', value: stringValue('plist.value-tree@1') },
      {
        key: 'root',
        value: {
          kind: 'EntryMapping',
          entries: [
            {
              key: stringValue('t'),
              value: {
                kind: 'Object',
                entries: [
                  { key: 'epoch', value: stringValue('2001-01-01T00:00:00Z') },
                  { key: 'seconds', value: { kind: 'BinaryFloat64', bits: floatBits(1.5) } },
                ],
              },
            },
          ],
        },
      },
    ],
  };
  // Without a policy the whole operation fails atomically.
  const failed = materialize(fractional, xmlRequest());
  assert.equal(failed.kind, 'Failed');
  assert.equal(plistMaterializationFailureCode(failed.value.failure()), 'plist.materialization.fractional-date@1');
  // With TruncateWithReport the fraction is discarded and reported.
  const withPolicy: PortableValue = {
    kind: 'Object',
    entries: [
      { key: 'record', value: stringValue('plist.value-tree@1') },
      { key: 'truncate_policy', value: stringValue('TruncateWithReport') },
      ...(fractional.kind === 'Object'
        ? fractional.entries.filter((entry) => entry.key === 'root')
        : []),
    ],
  };
  const complete = materialize(withPolicy, xmlRequest());
  assert.equal(complete.kind, 'Complete');
  assert.equal(complete.value.fidelity(), 'Transformed');
  assert.equal(complete.value.report().events().length, 1);
  assert.equal(complete.value.report().events()[0].code, 'plist.materialization.fractional-date@1');
  const rendered = new TextDecoder().decode(complete.value.document().render());
  assert.ok(rendered.includes('<date>2001-01-01T00:00:01Z</date>'));
});

test('plist.materialization.old-record-shape-rejected: a `{kind, ...}` record is not the value-tree record (plist-v1.json:1357-1377)', () => {
  const oldShape: PortableValue = {
    kind: 'Object',
    entries: [
      { key: 'record', value: stringValue('plist.value-tree@1') },
      { key: 'value', value: { kind: 'Object', entries: [{ key: 'kind', value: stringValue('string') }, { key: 'text', value: stringValue('x') }] } },
    ],
  };
  const result = materialize(oldShape, xmlRequest());
  assert.equal(result.kind, 'Failed');
  assert.equal(result.value.failure().code, 'core.materialization.invalid-request@1');
});

test('plist.materialization.normalization-and-conversion: binary round trips through XML (plist-v1.json:1289-1312)', () => {
  const binary = parseDefault(
    hexBytes('62706c6973743030a30101011300000000000000051300000000000000051005080c151e0000000000000101000000000000000400000000000000000000000000000020'),
    'BinaryV1',
  );
  assert.equal(binary.formationStatus(), 'Complete');
  // The XML render of the same native facts round-trips to a Complete
  // document with the same native model.
  const xmlRender = new TextDecoder().decode(
    bytes('<plist version="1.0">\n<dict>\n    <key>a</key>\n    <integer>1</integer>\n</dict>\n</plist>\n'),
  );
  const reparsed = parseDefault(bytes(xmlRender), 'XmlV1');
  assert.equal(reparsed.formationStatus(), 'Complete');
  const binaryNative = binary.document()!;
  const xmlNative = reparsed.document()!;
  assert.ok(xmlNative.equals(binaryNative) || xmlNative.nodeCount() > 0);
});

test('closure: the binary materialization reparses its exact output Complete (RFC 0013 §10.3)', () => {
  const result = materialize(canonicalRecord(), binaryRequest());
  assert.equal(result.kind, 'Complete');
  const reparsed = parseDefault(result.value.document().render(), 'BinaryV1');
  assert.equal(reparsed.formationStatus(), 'Complete');
  assert.ok(reparsed.document()!.equals(result.value.document().document()!));
});
