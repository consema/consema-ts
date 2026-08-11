/**
 * Intent documents for plist projection (L3).
 *
 * Golden transcriptions from the shared vectors:
 *  - conformance/vectors/plist-v1.json:
 *    plist.projection.value-tree-record (:1091-1148),
 *    plist.projection.require-object-policies (:1150-1199),
 *    plist.projection.atomic-failures (:1201-1221)
 *  - target/policy contract: RFC 0013 §9; crates/consema-plist/src/
 *    projection.rs (failure codes :393-402)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDefault, project, ProjectionRequest } from './index.ts';
import type { PortableValue } from '../core/value.ts';

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

/** Leaf facts of one projected dict root: keys plus the typed leaf values. */
function leafFacts(value: PortableValue): Map<string, PortableValue> {
  assert.equal(value.kind, 'Object');
  const record = value.entries.find((entry) => entry.key === 'record');
  const root = value.entries.find((entry) => entry.key === 'root');
  assert.ok(record !== undefined && record.value.kind === 'String');
  assert.equal(record.value.value, 'plist.value-tree@1');
  assert.ok(root !== undefined && root.value.kind === 'EntryMapping');
  const facts = new Map<string, PortableValue>();
  for (const entry of root.value.entries) {
    assert.equal(entry.key.kind, 'String');
    facts.set(entry.key.value, entry.value);
  }
  return facts;
}

test('plist.projection.value-tree-record: typed leaves and ordered associations (plist-v1.json:1091-1148)', () => {
  const document = parseDefault(
    bytes('<plist version="1.0"><dict><key>name</key><string>text</string><key>count</key><integer>42</integer><key>ratio</key><real>1.5</real><key>enabled</key><true/><key>disabled</key><false/><key>payload</key><data>AQID</data><key>created</key><date>2023-01-01T00:00:00Z</date><key>tags</key><array><string>a</string><string>b</string></array></dict></plist>'),
    'XmlV1',
  );
  const result = project(document, ProjectionRequest.valueTree());
  assert.equal(result.kind, 'Complete');
  const complete = result.value;
  assert.equal(complete.fidelity(), 'Exact');
  const facts = leafFacts(complete.value());
  assert.deepEqual([...facts.keys()], ['name', 'count', 'ratio', 'enabled', 'disabled', 'payload', 'created', 'tags']);
  assert.equal((facts.get('name') as { kind: 'String'; value: string }).value, 'text');
  assert.equal((facts.get('count') as { kind: 'Integer'; value: bigint }).value, 42n);
  assert.equal((facts.get('ratio') as { kind: 'BinaryFloat64'; bits: bigint }).bits, floatBits(1.5));
  assert.equal((facts.get('enabled') as { kind: 'Boolean'; value: boolean }).value, true);
  assert.equal((facts.get('disabled') as { kind: 'Boolean'; value: boolean }).value, false);
  assert.deepEqual(Array.from((facts.get('payload') as { kind: 'Bytes'; value: Uint8Array }).value), [1, 2, 3]);
  const created = facts.get('created') as {
    kind: 'Object';
    entries: readonly { key: string; value: PortableValue }[];
  };
  const epoch = created.entries.find((entry) => entry.key === 'epoch')!;
  const seconds = created.entries.find((entry) => entry.key === 'seconds')!;
  assert.equal((epoch.value as { kind: 'String'; value: string }).value, '2001-01-01T00:00:00Z');
  assert.equal((seconds.value as { kind: 'BinaryFloat64'; bits: bigint }).bits, floatBits(694224000.0));
  const tags = facts.get('tags') as { kind: 'Sequence'; items: readonly PortableValue[] };
  assert.deepEqual(tags.items.map((item) => (item as { kind: 'String'; value: string }).value), ['a', 'b']);
  // Association order is preserved in the provenance entries too.
  const provenance = complete.provenance().entries();
  assert.ok(provenance.length >= 7);
});

function floatBits(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  return view.getBigUint64(0, false);
}

test('plist.projection.require-object-policies: Reject, First, and scalar admission (plist-v1.json:1150-1199)', () => {
  const duplicateSource =
    '<plist version="1.0"><dict><key>a</key><string>one</string><key>a</key><string>last</string><key>b</key><string>two</string></dict></plist>';
  const rejected = project(parseDefault(bytes(duplicateSource), 'XmlV1'), ProjectionRequest.requireObject('Reject'));
  assert.equal(rejected.kind, 'Failed');
  assert.equal(rejected.value.diagnostics()[0].code, 'plist.projection.collision@1');

  const first = project(parseDefault(bytes(duplicateSource), 'XmlV1'), ProjectionRequest.requireObject('First'));
  assert.equal(first.kind, 'Complete');
  assert.equal(first.value.fidelity(), 'Transformed');
  const firstObject = first.value.value() as {
    kind: 'Object';
    entries: readonly { key: string; value: PortableValue }[];
  };
  assert.deepEqual(firstObject.entries.map((entry) => entry.key), ['a', 'b']);
  assert.equal((firstObject.entries[0].value as { kind: 'String'; value: string }).value, 'one');
  assert.equal(first.value.report().events().length, 1);
  assert.equal(first.value.report().events()[0].kind(), 'AssociationDiscarded');

  // Date and data leaves fail the require-object target with a diagnostic
  // rather than being rendered as strings (hard gate 3).
  const withDate = parseDefault(
    bytes('<plist version="1.0"><dict><key>d</key><date>2023-01-01T00:00:00Z</date><key>s</key><string>x</string></dict></plist>'),
    'XmlV1',
  );
  const dateResult = project(withDate, ProjectionRequest.requireObject('Reject'));
  assert.equal(dateResult.kind, 'Failed');
  assert.equal(dateResult.value.diagnostics()[0].code, 'plist.projection.unrepresentable@1');

  const withData = parseDefault(
    bytes('<plist version="1.0"><dict><key>p</key><data>AQID</data></dict></plist>'),
    'XmlV1',
  );
  const dataResult = project(withData, ProjectionRequest.requireObject('Reject'));
  assert.equal(dataResult.kind, 'Failed');
  assert.equal(dataResult.value.diagnostics()[0].code, 'plist.projection.unrepresentable@1');
});

test('plist.projection.atomic-failures: incomplete documents and unpaired surrogates (plist-v1.json:1201-1221)', () => {
  const incomplete = parseDefault(bytes('<plist version="1.0"><dict><key>a</key></dict></plist>'), 'XmlV1');
  const incompleteResult = project(incomplete, ProjectionRequest.valueTree());
  assert.equal(incompleteResult.kind, 'Failed');
  assert.equal(incompleteResult.value.diagnostics()[0].code, 'plist.projection.incomplete-document@1');

  const unpaired = parseDefault(
    hexBytes('62706c697374303062d800004108000000000000010100000000000000010000000000000000000000000000000d'),
    'BinaryV1',
  );
  const unpairedResult = project(unpaired, ProjectionRequest.valueTree());
  assert.equal(unpairedResult.kind, 'Failed');
  assert.equal(unpairedResult.value.diagnostics()[0].code, 'plist.projection.unpaired-surrogate@1');
});

test('plist.projection: UIDs are never disguised as integers (RFC 0013 §9)', () => {
  const document = parseDefault(
    hexBytes('62706c6973743030800508000000000000010100000000000000010000000000000000000000000000000a'),
    'BinaryV1',
  );
  const excluded = project(document, ProjectionRequest.valueTree());
  assert.equal(excluded.kind, 'Failed');
  assert.equal(excluded.value.diagnostics()[0].code, 'plist.projection.unrepresentable@1');
  const included = project(document, ProjectionRequest.valueTreeWithUid('Include'));
  assert.equal(included.kind, 'Complete');
  const root = included.value.value() as {
    kind: 'Object';
    entries: readonly { key: string; value: PortableValue }[];
  };
  const rootValue = root.entries.find((entry) => entry.key === 'root')!.value as {
    kind: 'Object';
    entries: readonly { key: string; value: PortableValue }[];
  };
  const uid = rootValue.entries.find((entry) => entry.key === 'uid')!;
  assert.equal((uid.value as { kind: 'Integer'; value: bigint }).value, 5n);
});

test('plist.projection: recovered documents are never projected (RFC 0013 §9)', () => {
  const recovered = parseDefault(bytes('<plist version="1.0"><integer>12a</integer></plist>'), 'XmlV1');
  assert.equal(recovered.formationStatus(), 'Recovered');
  const result = project(recovered, ProjectionRequest.valueTree());
  assert.equal(result.kind, 'Failed');
  assert.equal(result.value.diagnostics()[0].code, 'plist.projection.incomplete-document@1');
});
