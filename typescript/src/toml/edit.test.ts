/**
 * TOML scalar and structural edit intent tests.
 *
 * These are blind-written intent documents (docs/multi-language-implementation
 * -plan.md §3): they transcribe the language-neutral facts from
 * conformance/vectors/toml-v1.json and crates/consema-toml/src/edit.rs
 * and run once the toolchain is ready. Golden cases cited: toml-v1.json
 * case ids are named in each test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PARSE_LIMITS } from '../document/formation.ts';
import { DEFAULT_SOURCE_PATCH_LIMITS } from '../document/source_patch.ts';
import { EditPlanSourceId } from '../document/edit_plan.ts';
import { binaryFloat64Value, integerValue, stringValue, booleanValue, sequenceValue } from '../core/value.ts';
import { parseToml, TomlDocument, TomlEntry } from './document.ts';
import { TomlProfile } from './profile.ts';
import {
  TomlEditTransactionBuilder,
  commitTomlEdits,
  dryRunTomlEdits,
  canonicalString,
} from './edit.ts';
import { TomlEditFailure } from './errors.ts';

function parseSource(source: string): TomlDocument {
  return parseToml(new TextEncoder().encode(source), TomlProfile.TOML_10_V1, DEFAULT_PARSE_LIMITS);
}

function rootItem(document: TomlDocument, name: string) {
  return rootEntry(document, name).item();
}

function rootEntry(document: TomlDocument, name: string): TomlEntry {
  const found = document.root().tableEntries()!.find((entry) => entry.name() === name);
  assert.ok(found !== undefined, `root entry ${name} exists`);
  return found;
}

function textOf(document: TomlDocument): string {
  return new TextDecoder().decode(document.render());
}

// ---------------------------------------------------------------------------
// Golden edit cases
// ---------------------------------------------------------------------------

test('golden toml.edit.literal-minimal: exact literal replaces only the scalar span', () => {
  // conformance/vectors/toml-v1.json:71-76 (source "hex = 0x2A # keep\n",
  // literal "0x2B"; expected source "hex = 0x2B # keep\n",
  // source_edit_count 1).
  const document = parseSource('hex = 0x2A # keep\n');
  const target = rootItem(document, 'hex').nodeRef();
  const builder = new TomlEditTransactionBuilder(document);
  builder.literalScalar(target, new TextEncoder().encode('0x2B'));
  const commit = commitTomlEdits(document, builder.build());
  assert.equal(textOf(commit.document()), 'hex = 0x2B # keep\n');
  assert.equal(commit.changeSet().sourceEdits().length, 1);
  const edit = commit.changeSet().sourceEdits()[0];
  assert.equal(edit.oldSpan().startByte(), 6);
  assert.equal(edit.oldSpan().endByte(), 10);
  assert.equal(new TextDecoder().decode(edit.replacement()), '0x2B');
  // The derived patch reapplies byte-exact to the base.
  const reapplied = commit.sourcePatch().apply(document.source(), DEFAULT_SOURCE_PATCH_LIMITS);
  assert.deepEqual(reapplied.bytes(), commit.document().render());
  // The untouched-byte proof verifies.
  commit.untouchedProof().verify(
    document.source(),
    commit.document().source(),
    commit.sourcePatch().replacements(),
  );
});

test('golden toml.edit.reject-unrepresentable: non-canonical NaN payload fails atomically', () => {
  // conformance/vectors/toml-v1.json:77-82 (source "float = 1.0\n",
  // binary64_bits 7ff8000000000001; expected status Failed, failure
  // UnsupportedSemanticValue, source_unchanged true).
  const document = parseSource('float = 1.0\n');
  const target = rootItem(document, 'float').nodeRef();
  const builder = new TomlEditTransactionBuilder(document);
  builder.semanticScalar(
    target,
    binaryFloat64Value(0x7ff8000000000001n),
    'CanonicalForProfile',
  );
  assert.throws(
    () => commitTomlEdits(document, builder.build()),
    (failure: TomlEditFailure) => {
      assert.equal(failure.kind, 'UnsupportedSemanticValue');
      assert.equal(failure.code, 'core.edit.unsupported-value@1');
      assert.equal(failure.valueKind, 'BinaryFloat64');
      return true;
    },
  );
  assert.equal(textOf(document), 'float = 1.0\n', 'base snapshot is unchanged');
});

// ---------------------------------------------------------------------------
// Scalar edits
// ---------------------------------------------------------------------------

test('literal and semantic edits change only scalar spans; mappings are Replaced', () => {
  // edit.rs:1685-1732 test shape.
  const document = parseSource("hex = 0x2A # keep\nname = 'old'\nfloat = 1.0\n");
  const builder = new TomlEditTransactionBuilder(document);
  builder
    .literalScalar(rootItem(document, 'hex').nodeRef(), new TextEncoder().encode('0x2B'))
    .semanticScalar(
      rootItem(document, 'name').nodeRef(),
      stringValue('new\nvalue'),
      'PreserveCompatible',
    )
    .semanticScalar(
      rootItem(document, 'float').nodeRef(),
      binaryFloat64Value(0x8000000000000000n), // -0.0
      'PreserveCompatible',
    );
  const commit = commitTomlEdits(document, builder.build());
  assert.equal(
    textOf(commit.document()),
    'hex = 0x2B # keep\nname = "new\\nvalue"\nfloat = -0.0\n',
  );
  assert.equal(commit.changeSet().sourceEdits().length, 3);
  assert.equal(commit.changeSet().nodeMappings().length, 3);
  assert.ok(
    commit.changeSet().nodeMappings().every((mapping) => mapping.new() !== null),
  );
});

test('exact literal rejects trivia, containers, and extra assignments', () => {
  // edit.rs:1819-1837 test shape: " 2", "2 # comment", "[1, 2]", "2\nother = 3"
  // are all InvalidLiteral.
  const document = parseSource('value = 1\n');
  const target = rootItem(document, 'value').nodeRef();
  for (const literal of [' 2', '2 # comment', '[1, 2]', '2\nother = 3']) {
    const builder = new TomlEditTransactionBuilder(document);
    builder.literalScalar(target, new TextEncoder().encode(literal));
    assert.throws(
      () => commitTomlEdits(document, builder.build()),
      (failure: TomlEditFailure) => failure.kind === 'InvalidLiteral',
      `literal ${JSON.stringify(literal)} is invalid`,
    );
  }
  const builder = new TomlEditTransactionBuilder(document);
  builder.literalScalar(target, new TextEncoder().encode('0x2A'));
  const commit = commitTomlEdits(document, builder.build());
  assert.equal(textOf(commit.document()), 'value = 0x2A\n');
});

test('semantic policy boundaries reject instead of rounding', () => {
  // edit.rs:1767-1817 test shape.
  const document = parseSource('float = 1.0\ntime = 00:00:00\noffset = 1979-05-27T00:00:00Z\n');
  const floatTarget = rootItem(document, 'float').nodeRef();
  const incompatible = new TomlEditTransactionBuilder(document);
  incompatible.semanticScalar(
    floatTarget,
    stringValue('one'),
    'PreserveCompatible',
  );
  assert.throws(
    () => commitTomlEdits(document, incompatible.build()),
    (failure: TomlEditFailure) => failure.kind === 'RepresentationIncompatible',
  );

  // A literal on a non-scalar (the root table) is WrongRole (edit.rs:487-489);
  // a scalar target accepts any one-scalar literal spelling.
  const container = new TomlEditTransactionBuilder(document);
  container.literalScalar(document.root().nodeRef(), new TextEncoder().encode('3'));
  assert.throws(
    () => commitTomlEdits(document, container.build()),
    (failure: TomlEditFailure) => failure.kind === 'WrongRole',
  );

  const duplicate = new TomlEditTransactionBuilder(document);
  duplicate
    .literalScalar(floatTarget, new TextEncoder().encode('2'))
    .literalScalar(floatTarget, new TextEncoder().encode('3'));
  assert.throws(
    () => commitTomlEdits(document, duplicate.build()),
    (failure: TomlEditFailure) => failure.kind === 'DuplicateTarget',
  );
});

test('PreserveElseCanonical reports toml.edit.representation-fallback@1 on category change', () => {
  const document = parseSource('value = 1\n');
  const builder = new TomlEditTransactionBuilder(document);
  builder.semanticScalar(
    rootItem(document, 'value').nodeRef(),
    stringValue('one'),
    'PreserveElseCanonical',
  );
  const commit = commitTomlEdits(document, builder.build());
  assert.equal(textOf(commit.document()), 'value = "one"\n');
  const diagnostics = commit.changeSet().diagnostics();
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'toml.edit.representation-fallback@1');
  assert.equal(diagnostics[0].category, 'Edit');
  assert.equal(diagnostics[0].severity, 'Warning');
  assert.equal(diagnostics[0].arguments.get('old_kind'), 'Integer');
  assert.equal(diagnostics[0].arguments.get('new_kind'), 'String');
});

// ---------------------------------------------------------------------------
// Structural edits
// ---------------------------------------------------------------------------

test('root and standard table insertions preserve table ownership', () => {
  // edit.rs:1839-1892 test shape.
  const document = parseSource('root = 1\n\n[service]\nport = 80\n');
  const service = rootEntry(document, 'service').item();

  const rootInsert = new TomlEditTransactionBuilder(document);
  rootInsert.insertEntry(
    document.root().nodeRef(),
    'enabled',
    booleanValue(true),
    { kind: 'End' },
  );
  const rootCommit = commitTomlEdits(document, rootInsert.build());
  assert.equal(
    textOf(rootCommit.document()),
    'root = 1\n\n"enabled" = true\n[service]\nport = 80\n',
  );
  const enabled = rootCommit
    .document()
    .root()
    .tableEntries()!
    .find((entry) => entry.name() === 'enabled')!;
  assert.equal(enabled.item().asBoolean(), true);

  const tableInsert = new TomlEditTransactionBuilder(document);
  tableInsert.insertEntry(
    service.nodeRef(),
    'host',
    stringValue('localhost'),
    { kind: 'End' },
  );
  const tableCommit = commitTomlEdits(document, tableInsert.build());
  assert.equal(
    textOf(tableCommit.document()),
    'root = 1\n\n[service]\nport = 80\n"host" = "localhost"',
  );
});

test('inline table operations preserve exact association identity', () => {
  // edit.rs:1894-1940 test shape.
  const document = parseSource('point = { a = 1, b = 2 }\n');
  const point = rootItem(document, 'point');
  const entries = point.tableEntries()!;

  const insert = new TomlEditTransactionBuilder(document);
  insert.insertEntry(
    point.nodeRef(),
    'axis',
    sequenceValue([booleanValue(true)]),
    { kind: 'Before', anchor: entries[1].nodeRef() },
  );
  assert.equal(
    textOf(commitTomlEdits(document, insert.build()).document()),
    'point = { a = 1, "axis" = [true],b = 2 }\n',
  );

  const rename = new TomlEditTransactionBuilder(document);
  rename.renameEntry(entries[1].nodeRef(), 'beta');
  assert.equal(
    textOf(commitTomlEdits(document, rename.build()).document()),
    'point = { a = 1, "beta" = 2 }\n',
  );

  const remove = new TomlEditTransactionBuilder(document);
  remove.removeEntry(entries[0].nodeRef());
  const removed = commitTomlEdits(document, remove.build());
  assert.equal(textOf(removed.document()), 'point = {  b = 2 }\n');
  const reapplied = removed.sourcePatch().apply(document.source(), DEFAULT_SOURCE_PATCH_LIMITS);
  assert.deepEqual(reapplied.bytes(), removed.document().render());
});

test('array insert and remove cover empty and commented arrays', () => {
  // edit.rs:1942-1977 test shape.
  const empty = parseSource('items = [ ]\n');
  const array = rootItem(empty, 'items');
  const start = new TomlEditTransactionBuilder(empty);
  start.insertArrayElement(array.nodeRef(), integerValue(1n), { kind: 'Start' });
  assert.equal(
    textOf(commitTomlEdits(empty, start.build()).document()),
    'items = [1 ]\n',
  );

  const document = parseSource('items = [1, # keep\n 2, 3,]\n');
  const items = rootItem(document, 'items');
  const elements = items.arrayElements()!;
  const insert = new TomlEditTransactionBuilder(document);
  insert.insertArrayElement(
    items.nodeRef(),
    stringValue('end'),
    { kind: 'After', anchor: elements[2].nodeRef() },
  );
  assert.equal(
    textOf(commitTomlEdits(document, insert.build()).document()),
    'items = [1, # keep\n 2, 3,"end",]\n',
  );

  const remove = new TomlEditTransactionBuilder(document);
  remove.removeArrayElement(elements[1].nodeRef());
  assert.equal(
    textOf(commitTomlEdits(document, remove.build()).document()),
    'items = [1, # keep\n  3,]\n',
  );
});

test('structural dependencies and table rules fail atomically', () => {
  // edit.rs:1979-2093 test shape.
  const document = parseSource('a = 1\nb = 2\n\n[service]\nport = 80\n');
  const entries = document.root().tableEntries()!;
  const a = entries.find((entry) => entry.name() === 'a')!;
  const b = entries.find((entry) => entry.name() === 'b')!;
  const service = entries.find((entry) => entry.name() === 'service')!;

  const duplicateKey = new TomlEditTransactionBuilder(document);
  duplicateKey.insertEntry(
    document.root().nodeRef(),
    'a',
    booleanValue(true),
    { kind: 'Start' },
  );
  assert.throws(
    () => commitTomlEdits(document, duplicateKey.build()),
    (failure: TomlEditFailure) => failure.kind === 'DuplicateKey',
  );

  const duplicateRename = new TomlEditTransactionBuilder(document);
  duplicateRename.renameEntry(b.nodeRef(), 'a');
  assert.throws(
    () => commitTomlEdits(document, duplicateRename.build()),
    (failure: TomlEditFailure) => failure.kind === 'DuplicateKey',
  );

  const removedAnchor = new TomlEditTransactionBuilder(document);
  removedAnchor
    .removeEntry(a.nodeRef())
    .insertEntry(document.root().nodeRef(), 'x', booleanValue(true), {
      kind: 'Before',
      anchor: a.nodeRef(),
    });
  assert.throws(
    () => commitTomlEdits(document, removedAnchor.build()),
    (failure: TomlEditFailure) => failure.kind === 'PlacementAnchorRemoved',
  );

  const duplicateTarget = new TomlEditTransactionBuilder(document);
  duplicateTarget.renameEntry(a.nodeRef(), 'x').removeEntry(a.nodeRef());
  assert.throws(
    () => commitTomlEdits(document, duplicateTarget.build()),
    (failure: TomlEditFailure) => failure.kind === 'DuplicateTarget',
  );

  const removeTable = new TomlEditTransactionBuilder(document);
  removeTable.removeEntry(service.nodeRef());
  assert.throws(
    () => commitTomlEdits(document, removeTable.build()),
    (failure: TomlEditFailure) => failure.kind === 'UnsupportedOperation',
  );

  const crossContainer = new TomlEditTransactionBuilder(document);
  crossContainer.insertEntry(
    service.item().nodeRef(),
    'x',
    booleanValue(true),
    { kind: 'Before', anchor: a.nodeRef() },
  );
  assert.throws(
    () => commitTomlEdits(document, crossContainer.build()),
    (failure: TomlEditFailure) => failure.kind === 'TargetNotFound',
  );

  const sameBoundary = new TomlEditTransactionBuilder(document);
  sameBoundary
    .insertEntry(document.root().nodeRef(), 'x', booleanValue(true), { kind: 'End' })
    .insertEntry(document.root().nodeRef(), 'y', booleanValue(false), { kind: 'End' });
  assert.throws(
    () => commitTomlEdits(document, sameBoundary.build()),
    (failure: TomlEditFailure) => failure.kind === 'OverlappingOwnership',
  );

  const ancestorDescendant = new TomlEditTransactionBuilder(document);
  ancestorDescendant
    .semanticScalar(a.item().nodeRef(), integerValue(3n), 'PreserveCompatible')
    .removeEntry(a.nodeRef());
  assert.throws(
    () => commitTomlEdits(document, ancestorDescendant.build()),
    (failure: TomlEditFailure) => failure.kind === 'AncestorDescendantConflict',
  );

  const nullValue = new TomlEditTransactionBuilder(document);
  nullValue.insertEntry(document.root().nodeRef(), 'null', { kind: 'Null' }, { kind: 'Start' });
  assert.throws(
    () => commitTomlEdits(document, nullValue.build()),
    (failure: TomlEditFailure) => {
      assert.equal(failure.kind, 'UnrepresentableValue');
      assert.equal(failure.code, 'core.edit.unsupported-value@1');
      return true;
    },
  );
  assert.equal(textOf(document), 'a = 1\nb = 2\n\n[service]\nport = 80\n');
});

test('empty standard table insertion uses its header newline and CRLF', () => {
  // edit.rs:2095-2120 test shape.
  const document = parseSource('[empty]\r\n[next]\r\nx = 1\r\n');
  const empty = rootEntry(document, 'empty').item();
  const builder = new TomlEditTransactionBuilder(document);
  builder.insertEntry(empty.nodeRef(), 'enabled', booleanValue(true), { kind: 'End' });
  const commit = commitTomlEdits(document, builder.build());
  assert.equal(
    textOf(commit.document()),
    '[empty]\r\n"enabled" = true\r\n[next]\r\nx = 1\r\n',
  );
});

test('dry run and commit produce identical patches and target digests', () => {
  // edit.rs:2122-2155 test shape.
  const document = parseSource('value = 1\n');
  const builder = new TomlEditTransactionBuilder(document);
  builder.insertEntry(
    document.root().nodeRef(),
    'secret-key',
    stringValue('secret-value'),
    { kind: 'End' },
  );
  const transaction = builder.build();
  const plan = dryRunTomlEdits(document, transaction, new EditPlanSourceId('config.toml'));
  const commit = commitTomlEdits(document, transaction);
  assert.deepEqual(
    plan.replacements().map((replacement) => replacement.replacement()),
    commit.sourcePatch().replacements().map((replacement) => replacement.replacement()),
  );
  assert.ok(plan.targetDigest().equals(commit.sourcePatch().targetDigest()));
  assert.ok(
    [...plan.operations()[0].arguments().values()].every((value) => !value.includes('secret')),
  );
  const applied = plan.sourcePatch().apply(document.source(), DEFAULT_SOURCE_PATCH_LIMITS);
  assert.deepEqual(applied.bytes(), commit.document().render());
});

test('canonical string escaping matches the frozen table', () => {
  // edit.rs:1516-1537 escaping table.
  assert.equal(canonicalString('a\nb'), '"a\\nb"');
  assert.equal(canonicalString('quote " back \\ tab \t'), '"quote \\" back \\\\ tab \\t"');
  assert.equal(canonicalString('\u0000'), '"\\u0000"');
  assert.equal(canonicalString('\u007F'), '"\\u007F"');
  assert.equal(canonicalString('café'), '"café"');
});
