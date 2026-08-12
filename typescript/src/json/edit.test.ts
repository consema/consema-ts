/**
 * Intent documents for scalar and structural edit operations.
 *
 * Golden transcriptions from the shared vectors — each test cites its
 * case id:
 *  - conformance/vectors/json-family-v2.json: json5.edit.move-member
 *    (:174-178), json5.edit.move-cross-object-rejected (:180-184),
 *    json5.edit.preserve-scalars (:186-190)
 *  - conformance/vectors/v1.json: edit.scalar-minimal (:107-111),
 *    edit.preserve-decimal-scale (:113-117), edit.preserve-exponent-style
 *    (:119-123), edit.canonical-for-profile (:125-129),
 *    edit.preserve-else-canonical (:131-135),
 *    edit.preserve-incompatible-rejected (:137-141), edit.wrong-snapshot
 *    (:173-177)
 *  - operation ids (EXACT registry): crates/consema-json/src/edit.rs:
 *    1110-1133; RFC 0005 §10 (:227-241) for move-member ownership
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parse,
  commitEdits,
  dryRunEdits,
  EditTransactionBuilder,
  EditFailure,
} from '../json/index.ts';
import { PROFILE_JSON5_STANDARD, PROFILE_JSONC_BOUNDED, PROFILE_JSON_STRICT } from '../json/index.ts';
import { DEFAULT_PARSE_LIMITS } from '../document/formation.ts';
import { EditPlanSourceId } from '../document/edit_plan.ts';
import {
  binaryFloat64Value,
  decimalValue,
  integerValue,
  stringValue,
} from '../core/value.ts';

function bytes(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

function parse5(source: string): ReturnType<typeof parse> {
  return parse(bytes(source), PROFILE_JSON5_STANDARD, DEFAULT_PARSE_LIMITS);
}

function render(document: { render(): Uint8Array }): string {
  return new TextDecoder().decode(document.render());
}

function memberRefs(document: ReturnType<typeof parse>) {
  const members = document.root().objectMembers();
  if (members.kind !== 'Available' || members.value === null) {
    throw new Error('expected an available object');
  }
  return members.value;
}

test('json5.edit.move-member: byte-exact golden (json-family-v2.json:174-178)', () => {
  const document = parse5('{ /*before*/ a:1, /*stay*/ b:2, c:3, }');
  const members = memberRefs(document);
  const transaction = new EditTransactionBuilder(document)
    .moveMember(members[1].nodeRef(), { kind: 'Start' })
    .build();
  const plan = dryRunEdits(document, transaction, new EditPlanSourceId('config.json5'));
  const commit = commitEdits(document, transaction);
  assert.equal(render(commit.document()), '{ /*before*/ b:2,a:1, /*stay*/  c:3, }');
  // patch_equal: dry-run and commit publish the exact same replacement set
  // and target digest (RFC 0004 §14).
  const patch = commit.sourcePatch();
  assert.deepEqual(
    plan.replacements().map((replacement) => ({
      oldStart: replacement.oldStart(),
      oldEnd: replacement.oldEnd(),
      original: Array.from(replacement.original()),
      replacement: Array.from(replacement.replacement()),
    })),
    patch.replacements().map((replacement) => ({
      oldStart: replacement.oldStart(),
      oldEnd: replacement.oldEnd(),
      original: Array.from(replacement.original()),
      replacement: Array.from(replacement.replacement()),
    })),
  );
  assert.equal(plan.targetDigest().toHex(), patch.targetDigest().toHex());
  // proof_valid: every byte outside the replacements is identical.
  commit.untouchedProof().verify(document.source(), commit.document().source(), patch.replacements());
  // The patch reapplies to the base and reproduces the exact committed bytes.
  const reapplied = patch.apply(document.source(), { source: { maxRawBytes: 1024, maxDecodedUtf8Bytes: 1024, maxDecodedScalars: 1024 }, maxReplacements: 8, maxPatchBytes: 4096 });
  assert.equal(new TextDecoder().decode(reapplied.bytes()), render(commit.document()));
});

test('json5.edit.move-cross-object-rejected: cross-object anchors are TargetNotFound (json-family-v2.json:180-184)', () => {
  const document = parse5('{left:{a:1},right:{b:2}}');
  const root = memberRefs(document);
  const leftObject = root[0].value().objectMembers();
  const rightObject = root[1].value().objectMembers();
  assert.equal(leftObject.kind, 'Available');
  assert.equal(rightObject.kind, 'Available');
  const transaction = new EditTransactionBuilder(document)
    .moveMember(leftObject.value![0].nodeRef(), {
      kind: 'Before',
      anchor: rightObject.value![0].nodeRef(),
    })
    .build();
  assert.throws(
    () => commitEdits(document, transaction),
    (error: unknown) => {
      assert.ok(error instanceof EditFailure);
      assert.equal(error.kind, 'TargetNotFound');
      assert.equal(error.code, 'core.edit.target-not-found@1');
      return true;
    },
  );
});

test('json5.edit.preserve-scalars: compatible lexical preservation (json-family-v2.json:186-190)', () => {
  const document = parse5("{hex:+0X0f,point:+.50,string:'a\\x20\\v',nf:+Infinity}");
  const members = memberRefs(document);
  const transaction = new EditTransactionBuilder(document)
    .semanticScalar(members[0].valueNodeRef(), integerValue(16n), 'PreserveCompatible')
    .semanticScalar(members[1].valueNodeRef(), decimalValue(75n, -2n), 'PreserveCompatible')
    .semanticScalar(members[2].valueNodeRef(), stringValue('a \u000b'), 'PreserveCompatible')
    .semanticScalar(members[3].valueNodeRef(), binaryFloat64Value(0x7ff8000000000000n), 'PreserveCompatible')
    .build();
  const commit = commitEdits(document, transaction);
  assert.equal(render(commit.document()), "{hex:+0X10,point:+.75,string:'a\\x20\\v',nf:+NaN}");
});

test('edit.scalar-minimal: only the literal changes, trivia stays (v1.json:107-111)', () => {
  const document = parse(bytes('{ /* lead */ "a" : 1 // tail\n}'), PROFILE_JSONC_BOUNDED, DEFAULT_PARSE_LIMITS);
  const members = memberRefs(document);
  const transaction = new EditTransactionBuilder(document)
    .semanticScalar(members[0].valueNodeRef(), integerValue(200n), 'PreserveCompatible')
    .build();
  const commit = commitEdits(document, transaction);
  assert.equal(render(commit.document()), '{ /* lead */ "a" : 200 // tail\n}');
  assert.equal(commit.changeSet().sourceEdits().length, 1);
});

test('edit.preserve-decimal-scale (v1.json:113-117)', () => {
  const document = parse(bytes('{"a": 1.00}'), PROFILE_JSON_STRICT, DEFAULT_PARSE_LIMITS);
  const members = memberRefs(document);
  const transaction = new EditTransactionBuilder(document)
    .semanticScalar(members[0].valueNodeRef(), decimalValue(25n, -1n), 'PreserveCompatible')
    .build();
  const commit = commitEdits(document, transaction);
  assert.equal(render(commit.document()), '{"a": 2.50}');
});

test('edit.preserve-exponent-style (v1.json:119-123)', () => {
  const document = parse(bytes('{"a": 1E+02}'), PROFILE_JSON_STRICT, DEFAULT_PARSE_LIMITS);
  const members = memberRefs(document);
  const transaction = new EditTransactionBuilder(document)
    .semanticScalar(members[0].valueNodeRef(), integerValue(2n), 'PreserveCompatible')
    .build();
  const commit = commitEdits(document, transaction);
  assert.equal(render(commit.document()), '{"a": 2E+0}');
});

test('edit.canonical-for-profile (v1.json:125-129)', () => {
  const document = parse(bytes('{"a": 1.00}'), PROFILE_JSON_STRICT, DEFAULT_PARSE_LIMITS);
  const members = memberRefs(document);
  const transaction = new EditTransactionBuilder(document)
    .semanticScalar(members[0].valueNodeRef(), decimalValue(25n, -1n), 'CanonicalForProfile')
    .build();
  const commit = commitEdits(document, transaction);
  assert.equal(render(commit.document()), '{"a": 25e-1}');
});

test('edit.preserve-else-canonical: explicit fallback event (v1.json:131-135)', () => {
  const document = parse(bytes('{"a": 1.000}'), PROFILE_JSON_STRICT, DEFAULT_PARSE_LIMITS);
  const members = memberRefs(document);
  const transaction = new EditTransactionBuilder(document)
    .semanticScalar(members[0].valueNodeRef(), decimalValue(1n, -4n), 'PreserveElseCanonical')
    .build();
  const commit = commitEdits(document, transaction);
  assert.equal(render(commit.document()), '{"a": 1e-4}');
  const diagnostics = commit.changeSet().diagnostics();
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'json.edit.representation-fallback@1');
  assert.equal(diagnostics[0].category, 'Edit');
  assert.equal(diagnostics[0].severity, 'Warning');
});

test('edit.preserve-incompatible-rejected (v1.json:137-141)', () => {
  const document = parse(bytes('{"a": 1.000}'), PROFILE_JSON_STRICT, DEFAULT_PARSE_LIMITS);
  const members = memberRefs(document);
  const transaction = new EditTransactionBuilder(document)
    .semanticScalar(members[0].valueNodeRef(), decimalValue(1n, -4n), 'PreserveCompatible')
    .build();
  assert.throws(
    () => commitEdits(document, transaction),
    (error: unknown) => {
      assert.ok(error instanceof EditFailure);
      assert.equal(error.kind, 'RepresentationIncompatible');
      assert.equal(error.code, 'core.edit.representation-incompatible@1');
      return true;
    },
  );
});

test('edit.wrong-snapshot: transactions bind exactly one base snapshot (v1.json:173-177)', () => {
  const first = parse(bytes('1'), PROFILE_JSON_STRICT, DEFAULT_PARSE_LIMITS);
  const second = parse(bytes('2'), PROFILE_JSON_STRICT, DEFAULT_PARSE_LIMITS);
  const transaction = new EditTransactionBuilder(first).build();
  assert.throws(
    () => commitEdits(second, transaction),
    (error: unknown) => {
      assert.ok(error instanceof EditFailure);
      assert.equal(error.kind, 'WrongSnapshot');
      assert.equal(error.code, 'core.edit.wrong-snapshot@1');
      return true;
    },
  );
  // The second snapshot stays byte-identical.
  assert.equal(render(second), '2');
});

test('structural conflicts fail before a document exists (edit.rs:1025-1078)', () => {
  const document = parse(bytes('{"a":1,"b":2}'), PROFILE_JSON_STRICT, DEFAULT_PARSE_LIMITS);
  const members = memberRefs(document);

  const removedAnchor = new EditTransactionBuilder(document)
    .removeMember(members[0].nodeRef())
    .insertMember(
      document.root().nodeRef(),
      'x',
      integerValue(1n),
      { kind: 'Before', anchor: members[0].nodeRef() },
    )
    .build();
  assert.throws(
    () => commitEdits(document, removedAnchor),
    (error: unknown) => error instanceof EditFailure && error.kind === 'PlacementAnchorRemoved',
  );

  const duplicateTarget = new EditTransactionBuilder(document)
    .renameMember(members[0].nodeRef(), 'x')
    .removeMember(members[0].nodeRef())
    .build();
  assert.throws(
    () => commitEdits(document, duplicateTarget),
    (error: unknown) => error instanceof EditFailure && error.kind === 'DuplicateTarget',
  );

  const sameBoundary = new EditTransactionBuilder(document)
    .insertMember(document.root().nodeRef(), 'x', integerValue(1n), { kind: 'End' })
    .insertMember(document.root().nodeRef(), 'y', integerValue(2n), { kind: 'End' })
    .build();
  assert.throws(
    () => commitEdits(document, sameBoundary),
    (error: unknown) => error instanceof EditFailure && error.kind === 'OverlappingOwnership',
  );

  const ancestorDescendant = new EditTransactionBuilder(document)
    .semanticScalar(members[0].valueNodeRef(), integerValue(3n), 'PreserveCompatible')
    .removeMember(members[0].nodeRef())
    .build();
  assert.throws(
    () => commitEdits(document, ancestorDescendant),
    (error: unknown) => error instanceof EditFailure && error.kind === 'AncestorDescendantConflict',
  );
  assert.equal(render(document), '{"a":1,"b":2}');
});

test('insert/remove member around comments and trailing commas keeps trivia in place (RFC 0004 §11)', () => {
  const document = parse(bytes('{ /*lead*/ "a":1, /*keep*/ "a":2, "z":3, }'), PROFILE_JSONC_BOUNDED, DEFAULT_PARSE_LIMITS);
  const members = memberRefs(document);

  const inserted = commitEdits(
    document,
    new EditTransactionBuilder(document)
      .insertMember(document.root().nodeRef(), 'x', integerValue(1n), {
        kind: 'Before',
        anchor: members[1].nodeRef(),
      })
      .build(),
  );
  assert.equal(render(inserted.document()), '{ /*lead*/ "a":1, /*keep*/ "x":1,"a":2, "z":3, }');

  const renamed = commitEdits(
    document,
    new EditTransactionBuilder(document).renameMember(members[1].nodeRef(), 'b').build(),
  );
  assert.equal(render(renamed.document()), '{ /*lead*/ "a":1, /*keep*/ "b":2, "z":3, }');

  const removed = commitEdits(
    document,
    new EditTransactionBuilder(document).removeMember(members[0].nodeRef()).build(),
  );
  assert.equal(render(removed.document()), '{ /*lead*/  /*keep*/ "a":2, "z":3, }');
});

test('scalar edit round-trip: patch reapplies and proof verifies (RFC 0004 §15-16)', () => {
  const document = parse(bytes('{"a": 1}'), PROFILE_JSON_STRICT, DEFAULT_PARSE_LIMITS);
  const members = memberRefs(document);
  const transaction = new EditTransactionBuilder(document)
    .semanticScalar(members[0].valueNodeRef(), integerValue(42n), 'CanonicalForProfile')
    .build();
  const commit = commitEdits(document, transaction);
  assert.equal(render(commit.document()), '{"a": 42}');
  const patch = commit.sourcePatch();
  commit.untouchedProof().verify(document.source(), commit.document().source(), patch.replacements());
  const reapplied = patch.apply(
    document.source(),
    { source: { maxRawBytes: 1024, maxDecodedUtf8Bytes: 1024, maxDecodedScalars: 1024 }, maxReplacements: 8, maxPatchBytes: 4096 },
  );
  assert.equal(new TextDecoder().decode(reapplied.bytes()), render(commit.document()));
  // Operation metadata names the exact registered operation id (edit.rs:1110-1133).
  assert.equal(patch.metadata().get('operation.0'), 'json.edit.replace-scalar-semantic@1');
});

test('mapping plans: replaced literals are located in the new snapshot (edit.rs:389-414)', () => {
  const document = parse(bytes('{"a": 1}'), PROFILE_JSON_STRICT, DEFAULT_PARSE_LIMITS);
  const members = memberRefs(document);
  const transaction = new EditTransactionBuilder(document)
    .semanticScalar(members[0].valueNodeRef(), integerValue(42n), 'CanonicalForProfile')
    .build();
  const commit = commitEdits(document, transaction);
  const mappings = commit.changeSet().nodeMappings();
  assert.equal(mappings.length, 1);
  assert.equal(mappings[0].status(), 'Replaced');
  assert.ok(mappings[0].new() !== null);
  const removed = commitEdits(
    document,
    new EditTransactionBuilder(document).removeMember(members[0].nodeRef()).build(),
  );
  const removedMapping = removed.changeSet().nodeMappings();
  assert.ok(removedMapping.some((mapping) => mapping.status() === 'Deleted'));
});
