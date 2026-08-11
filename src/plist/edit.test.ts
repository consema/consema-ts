/**
 * Intent documents for plist structural edit (L3).
 *
 * Golden transcriptions from the shared vectors:
 *  - conformance/vectors/plist-v1.json:
 *    plist.edit.xml-six-operations (:1380-1450),
 *    plist.edit.binary-structural (:1452-1496),
 *    plist.edit.conflicts (:1498-1564)
 *  - operation contract: RFC 0013 §11; crates/consema-plist/src/edit.rs
 *    (failure codes :442-454)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDefault,
  EditTransactionBuilder,
  EditPath,
  EditFailure,
  commitEdits,
  PlistValueRef,
} from './index.ts';
import { EditPlanSourceId, EditPlan } from '../document/index.ts';
import { dryRunEdits } from './edit.ts';

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

const R = EditPath.root;
const key = (name: string, occurrence = 0) => ({ kind: 'DictKey' as const, key: name, occurrence });
const at = (index: number) => ({ kind: 'ArrayIndex' as const, index });

function stringValue(text: string) {
  return { kind: 'String' as const, text };
}

function integerValue(value: bigint) {
  return { kind: 'Integer' as const, value };
}

function booleanValue(value: boolean) {
  return { kind: 'Boolean' as const, value };
}

function ref(index: number): PlistValueRef {
  return PlistValueRef.fromIndex(index);
}

test('plist.edit.xml-six-operations: set, insert, remove, rename over one snapshot (plist-v1.json:1380-1450)', () => {
  const document = parseDefault(
    bytes('<plist version="1.0"><dict><key>a</key><dict><key>b</key><string>old</string></dict><key>arr</key><array><integer>1</integer><integer>2</integer></array></dict></plist>'),
    'XmlV1',
  );
  const transaction = new EditTransactionBuilder(document)
    .setValue(EditPath.new([key('a'), key('b')]), stringValue('new'))
    .insertDictEntry(EditPath.new([key('a')]), 'c', integerValue(3n), { kind: 'End' })
    .insertArrayElement(EditPath.new([key('arr')]), 0, stringValue('z'))
    .removeArrayElement(EditPath.new([key('arr')]), 2)
    .renameDictKey(EditPath.new([key('a')]), 'c', 0, 'c2')
    .removeDictEntry(EditPath.new([key('a')]), 'b', 0)
    .build();
  const commit = commitEdits(document, transaction, document.parseLimits());
  const final = commit.document();
  assert.equal(final.formationStatus(), 'Complete');
  const native = final.document()!;
  const root = native.get(native.root()) as { kind: 'Dict'; entries: readonly { key: string; value: number }[] };
  const dictA = native.get(ref(root.entries.find((entry) => entry.key === 'a')!.value)) as {
    kind: 'Dict';
    entries: readonly { key: string; value: number }[];
  };
  assert.deepEqual(dictA.entries.map((entry) => entry.key), ['c2']);
  assert.equal((native.get(ref(dictA.entries[0].value)) as { kind: 'Integer'; value: bigint }).value, 3n);
  const arr = native.get(ref(root.entries.find((entry) => entry.key === 'arr')!.value)) as {
    kind: 'Array';
    elements: readonly number[];
  };
  const elements = arr.elements.map((element) => native.get(ref(element))!);
  assert.equal(elements.length, 2);
  assert.equal((elements[0] as { kind: 'String'; text: string }).text, 'z');
  assert.equal((elements[1] as { kind: 'Integer'; value: bigint }).value, 1n);
  // Untouched-byte proof, change set, and a replayable patch.
  commit.untouchedProof().verify(document.source(), final.source(), commit.sourcePatch().replacements());
  const patched = commit.sourcePatch().apply(document.source(), {
    source: {
      maxRawBytes: 64 * 1024 * 1024,
      maxDecodedUtf8Bytes: 128 * 1024 * 1024,
      maxDecodedScalars: 64 * 1024 * 1024,
    },
    maxReplacements: 100,
    maxPatchBytes: 64 * 1024 * 1024,
  });
  assert.deepEqual(patched.bytes(), final.render());
});

test('plist.edit.binary-structural: set-value and insert rewrite the object table (plist-v1.json:1452-1496)', () => {
  const document = parseDefault(
    hexBytes('62706c6973743030a2010210015162080b0d000000000000010100000000000000030000000000000000000000000000000f'),
    'BinaryV1',
  );
  const transaction = new EditTransactionBuilder(document)
    .setValue(EditPath.new([at(1)]), integerValue(42n))
    .insertArrayElement(R(), 0, booleanValue(true))
    .build();
  const commit = commitEdits(document, transaction, document.parseLimits());
  const final = commit.document();
  assert.equal(final.formationStatus(), 'Complete');
  const native = final.document()!;
  const root = native.get(native.root()) as { kind: 'Array'; elements: readonly number[] };
  const elements = root.elements.map((element) => native.get(ref(element))!);
  assert.deepEqual(
    elements.map((element) => (element.kind === 'Boolean' ? element.value : (element as { kind: 'Integer'; value: bigint }).value)),
    [true, 1n, 42n],
  );
  // Untouched objects keep their exact bytes: the proof covers them.
  commit.untouchedProof().verify(document.source(), final.source(), commit.sourcePatch().replacements());
});

test('plist.edit.conflicts: uid-in-xml, incomplete target, and wrong snapshot (plist-v1.json:1498-1564)', () => {
  // UID insertion into an XML document.
  const xml = parseDefault(bytes('<plist version="1.0"><dict><key>a</key><string>x</string></dict></plist>'), 'XmlV1');
  const uidTransaction = new EditTransactionBuilder(xml)
    .setValue(EditPath.new([key('a')]), { kind: 'Uid', value: 5 })
    .build();
  assert.throws(() => commitEdits(xml, uidTransaction, xml.parseLimits()), (error: unknown) => {
    assert.ok(error instanceof EditFailure);
    assert.equal(error.code, 'plist.edit.uid-in-xml@1');
    return true;
  });

  // Incomplete base document.
  const incomplete = parseDefault(bytes('<plist version="1.0"><dict><key>a</key></dict></plist>'), 'XmlV1');
  assert.equal(incomplete.formationStatus(), 'Recovered');
  const incompleteTransaction = new EditTransactionBuilder(incomplete)
    .setValue(EditPath.new([key('a')]), integerValue(1n))
    .build();
  assert.throws(() => commitEdits(incomplete, incompleteTransaction, incomplete.parseLimits()), (error: unknown) => {
    assert.ok(error instanceof EditFailure);
    assert.equal(error.code, 'core.edit.incomplete-target@1');
    return true;
  });

  // Wrong snapshot: the transaction is bound to another snapshot.
  const binary = parseDefault(
    hexBytes('62706c6973743030a2010210015162080b0d000000000000010100000000000000030000000000000000000000000000000f'),
    'BinaryV1',
  );
  const other = parseDefault(
    hexBytes('62706c697374303050080000000000000101000000000000000100000000000000000000000000000009'),
    'BinaryV1',
  );
  const foreign = new EditTransactionBuilder(other)
    .setValue(EditPath.new([at(1)]), integerValue(42n))
    .build();
  assert.throws(() => commitEdits(binary, foreign, binary.parseLimits()), (error: unknown) => {
    assert.ok(error instanceof EditFailure);
    assert.equal(error.code, 'core.edit.wrong-snapshot@1');
    return true;
  });
});

test('dry-run EditPlan equals the committed replacements and target digest (RFC 0004 §14)', () => {
  const document = parseDefault(bytes('<plist version="1.0"><array><integer>1</integer></array></plist>'), 'XmlV1');
  const transaction = new EditTransactionBuilder(document)
    .insertArrayElement(R(), 0, stringValue('x'))
    .build();
  const commit = commitEdits(document, transaction, document.parseLimits());
  const plan = dryRunEdits(
    document,
    transaction,
    new EditPlanSourceId('memory:plist-edit-test'),
    document.parseLimits(),
  );
  assert.ok(plan instanceof EditPlan);
  assert.equal(plan.baseDigest().toHex(), commit.sourcePatch().baseDigest().toHex());
  assert.equal(plan.targetDigest().toHex(), commit.sourcePatch().targetDigest().toHex());
  assert.equal(plan.replacements().length, commit.sourcePatch().replacements().length);
  assert.equal(plan.operations().length, 1);
  assert.equal(plan.operations()[0].operation().toString(), 'plist.edit.insert-array-element@1');
});
