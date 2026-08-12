/**
 * INI edit intent tests.
 *
 * These are blind-written intent documents (docs/multi-language-implementation
 * -plan.md §3): they transcribe the language-neutral facts from
 * conformance/vectors/ini-v1.json and crates/consema-ini/src/edit.rs and
 * run once the toolchain is ready. Golden vector case ids are cited in
 * each test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EditPlanSourceId } from '../document/edit_plan.ts';
import { DEFAULT_SOURCE_PATCH_LIMITS } from '../document/source_patch.ts';
import type { AssociationPlacement } from '../document/identity.ts';
import { windowsCodePageEncoding, WindowsCodePage } from '../document/source.ts';
import {
  DEFAULT_INI_PARSE_LIMITS,
  IniProfile,
  explicitSelection,
  profileDefaultSelection,
} from './profile.ts';
import { parseIniDocument } from './document.ts';
import { IniEditFailure, editFailureCode } from './errors.ts';
import type { IniEditFailureKind } from './errors.ts';
import {
  IniEditTransactionBuilder,
  commitIniEdits,
  dryRunIniEdits,
} from './edit.ts';

function parseText(profile: IniProfile, text: string) {
  return parseIniDocument(
    new TextEncoder().encode(text),
    profile,
    profileDefaultSelection(),
    DEFAULT_INI_PARSE_LIMITS,
  );
}

function utf16leBom(text: string): Uint8Array {
  const units = [];
  for (let index = 0; index < text.length; index++) {
    units.push(text.charCodeAt(index));
  }
  const bytes = new Uint8Array(2 + units.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let index = 0; index < units.length; index++) {
    bytes[2 + index * 2] = units[index] & 0xff;
    bytes[3 + index * 2] = (units[index] >> 8) & 0xff;
  }
  return bytes;
}

function end(): AssociationPlacement {
  return { kind: 'End' };
}

test('golden edit.all-eight-operations: one source edit each', () => {
  // conformance/vectors/ini-v1.json:88-101 — the eight operations against
  // "[one]\na=1\n[two]\nb=2\n" produce exactly the eight expected outputs
  // with one source edit each.
  const source = '[one]\na=1\n[two]\nb=2\n';
  const expected = [
    '[one]\na=9\n[two]\nb=2\n',
    '[one]\na=8\n[two]\nb=2\n',
    '[one]\na=1\n[two]\nb=2\n[three]\n',
    '[two]\nb=2\n',
    '[renamed]\na=1\n[two]\nb=2\n',
    '[one]\na=1\nc=3\n[two]\nb=2\n',
    '[one]\n[two]\nb=2\n',
    '[one]\nrenamed=1\n[two]\nb=2\n',
  ];
  const outputs: string[] = [];
  const editCounts: number[] = [];

  let document = parseText(IniProfile.PORTABLE_V1, source);
  let builder = new IniEditTransactionBuilder(document);
  builder.semanticValue(document.entries()[0].nodeRef(), '9', 'CanonicalForProfile');
  collect(document, builder, outputs, editCounts);

  document = parseText(IniProfile.PORTABLE_V1, source);
  builder = new IniEditTransactionBuilder(document);
  builder.literalValue(document.entries()[0].nodeRef(), new TextEncoder().encode('8'));
  collect(document, builder, outputs, editCounts);

  document = parseText(IniProfile.PORTABLE_V1, source);
  builder = new IniEditTransactionBuilder(document);
  builder.insertSection(document.nodeRef(), 'three', end());
  collect(document, builder, outputs, editCounts);

  document = parseText(IniProfile.PORTABLE_V1, source);
  builder = new IniEditTransactionBuilder(document);
  builder.removeSection(document.sections()[0].nodeRef());
  collect(document, builder, outputs, editCounts);

  document = parseText(IniProfile.PORTABLE_V1, source);
  builder = new IniEditTransactionBuilder(document);
  builder.renameSection(document.sections()[0].nodeRef(), 'renamed');
  collect(document, builder, outputs, editCounts);

  document = parseText(IniProfile.PORTABLE_V1, source);
  builder = new IniEditTransactionBuilder(document);
  builder.insertEntry(document.sections()[0].nodeRef(), 'c', '3', end());
  collect(document, builder, outputs, editCounts);

  document = parseText(IniProfile.PORTABLE_V1, source);
  builder = new IniEditTransactionBuilder(document);
  builder.removeEntry(document.entries()[0].nodeRef());
  collect(document, builder, outputs, editCounts);

  document = parseText(IniProfile.PORTABLE_V1, source);
  builder = new IniEditTransactionBuilder(document);
  builder.renameEntry(document.entries()[0].nodeRef(), 'renamed');
  collect(document, builder, outputs, editCounts);

  assert.deepEqual(outputs, expected);
  assert.ok(editCounts.every((count) => count === 1), 'one source edit each');
});

function collect(
  document: ReturnType<typeof parseText>,
  builder: IniEditTransactionBuilder,
  outputs: string[],
  editCounts: number[],
): void {
  const commit = commitIniEdits(document, builder.build());
  outputs.push(new TextDecoder().decode(commit.document().render()));
  editCounts.push(commit.changeSet().sourceEdits().length);
}

test('golden edit.dry-run-patch-proof-and-atomic-failure', () => {
  // conformance/vectors/ini-v1.json:102-106 — dry-run equals commit, the
  // patch replays to the exact target bytes, the untouched proof verifies,
  // a wrong-snapshot target fails with core.edit.wrong-snapshot@1, and the
  // base document is unchanged.
  const source = '; before\n[s]\nk=old\n; after\n';
  const document = parseText(IniProfile.PORTABLE_V1, source);
  const builder = new IniEditTransactionBuilder(document);
  builder.semanticValue(document.entries()[0].nodeRef(), 'new value', 'CanonicalForProfile');
  const transaction = builder.build();
  const plan = dryRunIniEdits(
    document,
    transaction,
    new EditPlanSourceId('memory:ini-conformance'),
  );
  const commit = commitIniEdits(document, transaction);
  assert.equal(
    new TextDecoder().decode(commit.document().render()),
    '; before\n[s]\nk=new value\n; after\n',
  );
  // Dry-run and commit produce the same replacement facts and target
  // digest (RFC 0004 §14; ini-v1.json:102-106 "dry_run_equals_commit").
  assert.equal(
    plan.targetDigest().equals(commit.sourcePatch().targetDigest()),
    true,
  );
  assert.deepEqual(
    plan.sourcePatch().replacements().map((replacement) => replacement.original()),
    commit.sourcePatch().replacements().map((replacement) => replacement.original()),
  );
  const replay = commit
    .sourcePatch()
    .apply(document.source(), DEFAULT_SOURCE_PATCH_LIMITS);
  assert.deepEqual(replay.bytes(), commit.document().render());
  commit
    .untouchedProof()
    .verify(
      document.source(),
      commit.document().source(),
      commit.sourcePatch().replacements(),
    );

  const other = parseText(IniProfile.PORTABLE_V1, '[x]\nk=other\n');
  const wrong = new IniEditTransactionBuilder(document);
  wrong.literalValue(other.entries()[0].nodeRef(), new TextEncoder().encode('new'));
  assert.throws(
    () => commitIniEdits(document, wrong.build()),
    (failure: unknown) => {
      return (
        failure instanceof IniEditFailure &&
        failure.kind === 'WrongSnapshot' &&
        failure.code === 'core.edit.wrong-snapshot@1'
      );
    },
  );
  assert.equal(new TextDecoder().decode(document.render()), source);
});

test('Windows quote preservation and canonical fallback', () => {
  // edit.rs:1865-1889 — PreserveCompatible keeps a compatible quote style;
  // PreserveElseCanonical falls back to canonical quoting for unquoted
  // values with a ini.edit.canonical-fallback@1 warning.
  const document = parseText(IniProfile.WINDOWS_V1, "[S]\r\na='old'\r\nb=plain\r\n");
  const builder = new IniEditTransactionBuilder(document);
  builder
    .semanticValue(document.entries()[0].nodeRef(), ' new ', 'PreserveCompatible')
    .semanticValue(document.entries()[1].nodeRef(), ' spaced ', 'PreserveElseCanonical');
  const commit = commitIniEdits(document, builder.build());
  assert.equal(
    new TextDecoder().decode(commit.document().render()),
    "[S]\r\na=' new '\r\nb=\" spaced \"\r\n",
  );
  assert.equal(commit.changeSet().diagnostics()[0].code, 'ini.edit.canonical-fallback@1');
});

test('Python multiline preservation and canonical shape changes', () => {
  // edit.rs:1891-1917 — PreserveCompatible retains per-line trivia for the
  // same multiline shape; a shape change falls back to canonical form with
  // one reported fallback event.
  const source = '[S]\nkey : first  \n\tsecond\t\n\n\tthird\nnext=x\n';
  const document = parseText(IniProfile.PYTHON_CONFIGPARSER_V1, source);
  const preserve = new IniEditTransactionBuilder(document);
  preserve.semanticValue(
    document.entries()[0].nodeRef(),
    'one\ntwo\n\nthree',
    'PreserveCompatible',
  );
  const preserved = commitIniEdits(document, preserve.build());
  assert.equal(
    new TextDecoder().decode(preserved.document().render()),
    '[S]\nkey : one  \n\ttwo\t\n\n\tthree\nnext=x\n',
  );
  assert.equal(preserved.document().entries()[0].value(), 'one\ntwo\n\nthree');

  const fallback = new IniEditTransactionBuilder(document);
  fallback.semanticValue(document.entries()[0].nodeRef(), 'single', 'PreserveElseCanonical');
  const fallen = commitIniEdits(document, fallback.build());
  assert.equal(fallen.document().entries()[0].value(), 'single');
  assert.equal(fallen.changeSet().diagnostics().length, 1);
});

test('section insertion, rename, and removal have exact ownership', () => {
  // edit.rs:2113-2163 — insertion between sections, name replacement, and
  // atomic removal of a section with its owned entries while an
  // independent comment survives.
  const source = '[one]\na=1\n; independent\n[two]\nb=2\n';
  const document = parseText(IniProfile.PORTABLE_V1, source);

  const insert = new IniEditTransactionBuilder(document);
  insert.insertSection(
    document.nodeRef(),
    'middle',
    { kind: 'After', anchor: document.sections()[0].nodeRef() },
  );
  const inserted = commitIniEdits(document, insert.build());
  assert.equal(
    new TextDecoder().decode(inserted.document().render()),
    '[one]\na=1\n; independent\n[middle]\n[two]\nb=2\n',
  );

  const rename = new IniEditTransactionBuilder(document);
  rename.renameSection(document.sections()[1].nodeRef(), 'renamed');
  const renamed = commitIniEdits(document, rename.build());
  assert.equal(
    new TextDecoder().decode(renamed.document().render()),
    '[one]\na=1\n; independent\n[renamed]\nb=2\n',
  );

  const remove = new IniEditTransactionBuilder(document);
  remove.removeSection(document.sections()[0].nodeRef());
  const removed = commitIniEdits(document, remove.build());
  assert.equal(
    new TextDecoder().decode(removed.document().render()),
    '; independent\n[two]\nb=2\n',
  );
  assert.equal(removed.changeSet().nodeMappings().length, 2);
});

test('section removal owns Python continuations but not comments', () => {
  // edit.rs:2165-2176 — the multiline entry's continuation lines are owned
  // by the removed section; an independent comment survives.
  const document = parseText(
    IniProfile.PYTHON_CONFIGPARSER_V1,
    '[one]\nk=first\n  second\n\n  fourth\n# keep\n[two]\nx=y\n',
  );
  const builder = new IniEditTransactionBuilder(document);
  builder.removeSection(document.sections()[0].nodeRef());
  const commit = commitIniEdits(document, builder.build());
  assert.equal(new TextDecoder().decode(commit.document().render()), '# keep\n[two]\nx=y\n');
  assert.equal(commit.document().entries().length, 1);
});

test('appending after an EOF entry introduces one profile newline', () => {
  // edit.rs:2178-2185 — "[one]\na=1" + insert-section End yields
  // "[one]\na=1\n[two]\n".
  const document = parseText(IniProfile.PORTABLE_V1, '[one]\na=1');
  const builder = new IniEditTransactionBuilder(document);
  builder.insertSection(document.nodeRef(), 'two', end());
  const commit = commitIniEdits(document, builder.build());
  assert.equal(new TextDecoder().decode(commit.document().render()), '[one]\na=1\n[two]\n');
});

test('dependency, name, and collision failures are atomic', () => {
  // edit.rs:2203-2259 — ancestor conflicts, removed anchors, invalid
  // names, name collisions, and same-position insertions all fail before a
  // patch exists.
  const document = parseText(IniProfile.PORTABLE_V1, '[one]\na=1\n[two]\nb=2\n');
  const first = document.sections()[0].nodeRef();

  const conflict = new IniEditTransactionBuilder(document);
  conflict.removeSection(first).semanticValue(
    document.entries()[0].nodeRef(),
    'new',
    'CanonicalForProfile',
  );
  assert.throws(
    () => commitIniEdits(document, conflict.build()),
    (failure: unknown) =>
      failure instanceof IniEditFailure && failure.kind === 'AncestorDescendantConflict',
  );

  const removedAnchor = new IniEditTransactionBuilder(document);
  removedAnchor.removeSection(first).insertSection(document.nodeRef(), 'three', {
    kind: 'After',
    anchor: first,
  });
  assert.throws(
    () => commitIniEdits(document, removedAnchor.build()),
    (failure: unknown) =>
      failure instanceof IniEditFailure && failure.kind === 'PlacementAnchorRemoved',
  );

  const invalid = new IniEditTransactionBuilder(document);
  invalid.renameSection(first, 'bad name');
  assert.throws(
    () => commitIniEdits(document, invalid.build()),
    (failure: unknown) =>
      failure instanceof IniEditFailure &&
      failure.kind === 'InvalidName' &&
      failure.code === 'ini.edit.invalid-name@1',
  );

  const collision = new IniEditTransactionBuilder(document);
  collision.renameSection(first, 'two');
  assert.throws(
    () => commitIniEdits(document, collision.build()),
    (failure: unknown) =>
      failure instanceof IniEditFailure &&
      failure.kind === 'NameCollision' &&
      failure.code === 'core.edit.duplicate-key@1',
  );

  const samePosition = new IniEditTransactionBuilder(document);
  samePosition
    .insertSection(document.nodeRef(), 'three', end())
    .insertSection(document.nodeRef(), 'four', end());
  assert.throws(
    () => commitIniEdits(document, samePosition.build()),
    (failure: unknown) =>
      failure instanceof IniEditFailure && failure.kind === 'OverlappingOwnership',
  );
});

test('entry insertion, rename, and removal preserve unowned comments', () => {
  // edit.rs:2261-2303.
  const source = '[s]\na=1\n; independent\nc=3\n[next]\nx=y\n';
  const document = parseText(IniProfile.PORTABLE_V1, source);
  const section = document.sections()[0].nodeRef();

  const insert = new IniEditTransactionBuilder(document);
  insert.insertEntry(
    section,
    'b',
    '2',
    { kind: 'After', anchor: document.entries()[0].nodeRef() },
  );
  const inserted = commitIniEdits(document, insert.build());
  assert.equal(
    new TextDecoder().decode(inserted.document().render()),
    '[s]\na=1\nb=2\n; independent\nc=3\n[next]\nx=y\n',
  );

  const rename = new IniEditTransactionBuilder(document);
  rename.renameEntry(document.entries()[1].nodeRef(), 'renamed');
  const renamed = commitIniEdits(document, rename.build());
  assert.equal(
    new TextDecoder().decode(renamed.document().render()),
    '[s]\na=1\n; independent\nrenamed=3\n[next]\nx=y\n',
  );

  const remove = new IniEditTransactionBuilder(document);
  remove.removeEntry(document.entries()[0].nodeRef());
  const removed = commitIniEdits(document, remove.build());
  assert.equal(
    new TextDecoder().decode(removed.document().render()),
    '[s]\n; independent\nc=3\n[next]\nx=y\n',
  );
});

test('inserted values use each profile canonical entry representation', () => {
  // edit.rs:2305-2344 — Windows quotes " spaced ", Python multiline uses
  // the four-space continuation.
  const windows = parseText(IniProfile.WINDOWS_V1, '[S]\r\na=1\r\n');
  const windowsBuilder = new IniEditTransactionBuilder(windows);
  windowsBuilder.insertEntry(
    windows.sections()[0].nodeRef(),
    'quoted',
    ' spaced ',
    end(),
  );
  const windowsCommit = commitIniEdits(windows, windowsBuilder.build());
  assert.equal(
    new TextDecoder().decode(windowsCommit.document().render()),
    '[S]\r\na=1\r\nquoted=" spaced "\r\n',
  );

  const python = parseText(IniProfile.PYTHON_CONFIGPARSER_V1, '[S]\na=1\n');
  const pythonBuilder = new IniEditTransactionBuilder(python);
  pythonBuilder.insertEntry(
    python.sections()[0].nodeRef(),
    'multi',
    'first\n\nthird',
    end(),
  );
  const pythonCommit = commitIniEdits(python, pythonBuilder.build());
  assert.equal(
    new TextDecoder().decode(pythonCommit.document().render()),
    '[S]\na=1\nmulti = first\n\n    third\n',
  );
  assert.equal(pythonCommit.document().entries()[1].value(), 'first\n\nthird');
});

test('python key collisions and placements are validated before rendering', () => {
  // edit.rs:2358-2423 — optionxform collisions fail with
  // ini.edit.case-collision@1, invalid keys with ini.edit.invalid-name@1,
  // cross-section anchors with ini.edit.invalid-placement@1, exact
  // duplicates with core.edit.duplicate-key@1.
  const document = parseText(
    IniProfile.PYTHON_CONFIGPARSER_V1,
    '[S]\nKey=1\nother=2\n[T]\nx=3\n',
  );
  const section = document.sections()[0].nodeRef();

  const collision = new IniEditTransactionBuilder(document);
  collision.renameEntry(document.entries()[1].nodeRef(), 'KEY');
  assert.throws(
    () => commitIniEdits(document, collision.build()),
    (failure: unknown) =>
      failure instanceof IniEditFailure &&
      failure.kind === 'KeyCollision' &&
      failure.code === 'ini.edit.case-collision@1',
  );

  const invalid = new IniEditTransactionBuilder(document);
  invalid.insertEntry(section, 'bad:key', 'v', end());
  assert.throws(
    () => commitIniEdits(document, invalid.build()),
    (failure: unknown) =>
      failure instanceof IniEditFailure &&
      failure.kind === 'InvalidKey' &&
      failure.code === 'ini.edit.invalid-name@1',
  );

  const crossSection = new IniEditTransactionBuilder(document);
  crossSection.insertEntry(
    section,
    'new',
    'v',
    { kind: 'Before', anchor: document.entries()[2].nodeRef() },
  );
  assert.throws(
    () => commitIniEdits(document, crossSection.build()),
    (failure: unknown) =>
      failure instanceof IniEditFailure &&
      failure.kind === 'InvalidPlacement' &&
      failure.code === 'ini.edit.invalid-placement@1',
  );

  const duplicate = new IniEditTransactionBuilder(document);
  duplicate.insertEntry(section, 'Key', 'v', end());
  assert.throws(
    () => commitIniEdits(document, duplicate.build()),
    (failure: unknown) =>
      failure instanceof IniEditFailure &&
      failure.kind === 'DuplicateKey' &&
      failure.code === 'core.edit.duplicate-key@1',
  );
});

test('every edit failure maps to a frozen v6 or common code', () => {
  // edit.rs:1949-2013 — the complete kind→code table.
  const cases: [IniEditFailureKind, string][] = [
    ['RecoveredDocument', 'core.edit.incomplete-target@1'],
    ['WrongSnapshot', 'core.edit.wrong-snapshot@1'],
    ['WrongRole', 'core.edit.wrong-role@1'],
    ['DuplicateTarget', 'core.edit.conflicting-edits@1'],
    ['OverlappingOwnership', 'core.edit.conflicting-edits@1'],
    ['AncestorDescendantConflict', 'core.edit.conflicting-edits@1'],
    ['PlacementAnchorRemoved', 'core.edit.conflicting-edits@1'],
    ['TargetNotFound', 'core.edit.target-not-found@1'],
    ['InvalidPlacement', 'ini.edit.invalid-placement@1'],
    ['InvalidName', 'ini.edit.invalid-name@1'],
    ['NameCollision', 'core.edit.duplicate-key@1'],
    ['InvalidKey', 'ini.edit.invalid-name@1'],
    ['DuplicateKey', 'core.edit.duplicate-key@1'],
    ['KeyCollision', 'ini.edit.case-collision@1'],
    ['RepresentationIncompatible', 'core.edit.representation-incompatible@1'],
    ['ExactLiteralRequiresLiteralOperation', 'core.edit.exact-literal-requires-literal@1'],
    ['UnrepresentableValue', 'core.edit.unsupported-value@1'],
    ['EncodingUnrepresentable', 'core.edit.representation-incompatible@1'],
    ['InvalidLiteral', 'core.edit.invalid-literal@1'],
    ['ResourceLimit', 'core.edit.resource-limit@1'],
    ['NewDocumentFormationFailed', 'core.edit.formation-failed@1'],
  ];
  for (const [kind, code] of cases) {
    assert.equal(editFailureCode(kind), code, kind);
  }
});

test('selected UTF-16 and code-page encodings are preserved by edits', () => {
  // edit.rs:2057-2111 — a UTF-16LE base keeps its encoding facts after a
  // semantic replacement and after a section insertion; a cp1252 base
  // encodes € exactly.
  const text = '[S]\r\nk=old\r\n';
  const utf16 = utf16leBom(text);
  const document = parseIniDocument(
    utf16,
    IniProfile.WINDOWS_V1,
    profileDefaultSelection(),
    DEFAULT_INI_PARSE_LIMITS,
  );
  const replace = new IniEditTransactionBuilder(document);
  replace.semanticValue(document.entries()[0].nodeRef(), 'wide', 'CanonicalForProfile');
  const replaced = commitIniEdits(document, replace.build());
  assert.equal(replaced.document().entries()[0].value(), 'wide');
  assert.equal(
    replaced.document().source().encodingFacts().equals(document.source().encodingFacts()),
    true,
  );

  const insert = new IniEditTransactionBuilder(document);
  insert.insertSection(document.nodeRef(), 'Next', end());
  const inserted = commitIniEdits(document, insert.build());
  assert.equal(inserted.document().sections().length, 2);
  assert.equal(
    inserted.document().source().encodingFacts().equals(document.source().encodingFacts()),
    true,
  );

  const page = WindowsCodePage.fromNumber(1252);
  assert.ok(page !== null);
  const cpDocument = parseIniDocument(
    new TextEncoder().encode('[S]\r\nk=old\r\n'),
    IniProfile.WINDOWS_V1,
    explicitSelection(windowsCodePageEncoding(page!)),
    DEFAULT_INI_PARSE_LIMITS,
  );
  const cpBuilder = new IniEditTransactionBuilder(cpDocument);
  cpBuilder.semanticValue(cpDocument.entries()[0].nodeRef(), '€', 'CanonicalForProfile');
  const cpCommit = commitIniEdits(cpDocument, cpBuilder.build());
  assert.equal(cpCommit.document().entries()[0].value(), '€');
  assert.equal(cpCommit.document().render().includes(0x80), true);
});

test('Windows entry edits keep ordered case-equivalent occurrences', () => {
  // edit.rs:2425-2437 — renaming "other" to "KEY" keeps both occurrences
  // in the same duplicate group.
  const document = parseText(IniProfile.WINDOWS_V1, '[S]\r\nKey=1\r\nother=2\r\n');
  const builder = new IniEditTransactionBuilder(document);
  builder.renameEntry(document.entries()[1].nodeRef(), 'KEY');
  const commit = commitIniEdits(document, builder.build());
  assert.equal(commit.document().entries()[0].comparisonKey(), 'key');
  assert.equal(commit.document().entries()[1].comparisonKey(), 'key');
  assert.equal(
    commit.document().entries()[0].duplicateGroup(),
    commit.document().entries()[1].duplicateGroup(),
  );
});
