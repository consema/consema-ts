/**
 * Intent documents for Java Properties structural edits.
 *
 * Golden transcriptions from the shared vectors — each test cites its
 * case id:
 *  - conformance/vectors/java-properties-v1.json:
 *    edit.all-five-operations (:106-109),
 *    edit.dry-run-patch-proof-conflict-atomicity (:111-114)
 *  - RFC 0010 §13 (:383-413) freezes the five operations and the
 *    transaction/conflict algebra
 *  - RFC 0004 §13-§16 for transaction atomicity, dry-run plans, untouched
 *    proofs, and SourcePatch replay
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PROPERTIES_PARSE_LIMITS } from '../properties/parse_limits.ts';
import { parseReader } from '../properties/parser.ts';
import { commitEdits, dryRunEdits, EditTransactionBuilder } from '../properties/edit.ts';
import { EditFailure } from '../properties/errors.ts';
import { JavaString } from '../properties/java_string.ts';
import { EditPlanSourceId } from '../document/edit_plan.ts';
import { utf8Encoding } from '../document/source.ts';

function bytes(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

function parse(source: string) {
  return parseReader(bytes(source), utf8Encoding(), DEFAULT_PROPERTIES_PARSE_LIMITS);
}

function render(document: { render(): Uint8Array }): string {
  return new TextDecoder().decode(document.render());
}

test('edit.all-five-operations: golden outputs, one source edit each (java-properties-v1.json:106-109)', () => {
  const source = 'a=1\nb=2\n';
  const outputs: string[] = [];
  const editCounts: number[] = [];

  const semantic = parse(source);
  const semanticCommit = commitEdits(
    semantic,
    new EditTransactionBuilder(semantic)
      .semanticValue(semantic.properties()[0].nodeRef(), JavaString.fromUnicode('changed'))
      .build(),
  );
  outputs.push(render(semanticCommit.document()));
  editCounts.push(semanticCommit.changeSet().sourceEdits().length);

  const literal = parse(source);
  const literalCommit = commitEdits(
    literal,
    new EditTransactionBuilder(literal)
      .literalValue(literal.properties()[0].nodeRef(), bytes('raw\\ value'))
      .build(),
  );
  outputs.push(render(literalCommit.document()));
  editCounts.push(literalCommit.changeSet().sourceEdits().length);
  assert.equal(literalCommit.document().properties()[0].value().toUnicode(), 'raw value');

  const inserted = parse(source);
  const insertCommit = commitEdits(
    inserted,
    new EditTransactionBuilder(inserted)
      .insertProperty(
        inserted.nodeRef(),
        JavaString.fromUnicode('c'),
        JavaString.fromUnicode('3'),
        { kind: 'End' },
      )
      .build(),
  );
  outputs.push(render(insertCommit.document()));
  editCounts.push(insertCommit.changeSet().sourceEdits().length);

  const removed = parse(source);
  const removeCommit = commitEdits(
    removed,
    new EditTransactionBuilder(removed)
      .removeProperty(removed.properties()[0].nodeRef())
      .build(),
  );
  outputs.push(render(removeCommit.document()));
  editCounts.push(removeCommit.changeSet().sourceEdits().length);

  const renamed = parse(source);
  const renameCommit = commitEdits(
    renamed,
    new EditTransactionBuilder(renamed)
      .renameProperty(renamed.properties()[0].nodeRef(), JavaString.fromUnicode('renamed'))
      .build(),
  );
  outputs.push(render(renameCommit.document()));
  editCounts.push(renameCommit.changeSet().sourceEdits().length);

  assert.deepEqual(outputs, ['a=changed\nb=2\n', 'a=raw\\ value\nb=2\n', 'a=1\nb=2\nc=3\n', 'b=2\n', 'renamed=1\nb=2\n']);
  assert.ok(editCounts.every((count) => count === 1));
});

test('edit.dry-run-patch-proof-conflict-atomicity: patch replays, proof verifies (java-properties-v1.json:111-114)', () => {
  const document = parse('a=one\nb=two\n');
  const first = document.properties()[0].nodeRef();
  const second = document.properties()[1].nodeRef();
  const transaction = new EditTransactionBuilder(document)
    .renameProperty(first, JavaString.fromUnicode('first'))
    .semanticValue(second, JavaString.fromUnicode('changed'))
    .build();

  const plan = dryRunEdits(document, transaction, new EditPlanSourceId('fixture.properties'));
  const commit = commitEdits(document, transaction);
  assert.equal(render(commit.document()), 'first=one\nb=changed\n');
  assert.equal(commit.changeSet().sourceEdits().length, 2);
  assert.equal(plan.operations().length, 2);
  assert.equal(plan.operations()[0].operation().toString(), 'java-properties.edit.rename-property@1');
  assert.equal(plan.operations()[1].operation().toString(), 'java-properties.edit.replace-semantic-value@1');
  // Dry-run and commit publish the exact same replacement set and digest.
  assert.equal(plan.targetDigest().toHex(), commit.sourcePatch().targetDigest().toHex());
  assert.deepEqual(
    plan.replacements().map((replacement) => replacement.oldStart()),
    commit.sourcePatch().replacements().map((replacement) => replacement.oldStart()),
  );
  // The patch reapplies to the base and reproduces the exact committed bytes.
  const replayed = commit.sourcePatch().apply(document.source(), {
    source: { maxRawBytes: 1024, maxDecodedUtf8Bytes: 1024, maxDecodedScalars: 1024 },
    maxReplacements: 8,
    maxPatchBytes: 4096,
  });
  assert.equal(new TextDecoder().decode(replayed.bytes()), render(commit.document()));
  // Every byte outside the replacements is identical.
  commit.untouchedProof().verify(
    document.source(),
    commit.document().source(),
    commit.sourcePatch().replacements(),
  );
  // A duplicate-target transaction conflicts before any document is published.
  const conflict = new EditTransactionBuilder(document)
    .semanticValue(first, JavaString.fromUnicode('x'))
    .renameProperty(first, JavaString.fromUnicode('renamed'))
    .build();
  assert.throws(
    () => commitEdits(document, conflict),
    (error: unknown) => {
      assert.ok(error instanceof EditFailure);
      assert.equal(error.kind, 'DuplicateTarget');
      assert.equal(error.code, 'core.edit.conflicting-edits@1');
      return true;
    },
  );
  assert.equal(render(document), 'a=one\nb=two\n');
});

test('semantic replacement preserves direct style and falls back canonically (edit.rs:1186-1213)', () => {
  const direct = parse('a=one\n');
  const directCommit = commitEdits(
    direct,
    new EditTransactionBuilder(direct)
      .semanticValue(direct.properties()[0].nodeRef(), JavaString.fromUnicode('two words'))
      .build(),
  );
  assert.equal(render(directCommit.document()), 'a=two words\n');
  assert.equal(directCommit.changeSet().diagnostics().length, 0);

  const escaped = parse('a=one\\ value\n');
  const fallbackCommit = commitEdits(
    escaped,
    new EditTransactionBuilder(escaped)
      .semanticValue(escaped.properties()[0].nodeRef(), JavaString.fromUnicode('next value'))
      .build(),
  );
  assert.equal(render(fallbackCommit.document()), 'a=next value\n');
  assert.equal(
    fallbackCommit.changeSet().diagnostics()[0].code,
    'java-properties.edit.canonical-fallback@1',
  );
});

test('semantic replacement preserves exact unpaired Java units via escapes (edit.rs:1215-1224)', () => {
  const document = parse('a=x\n');
  const exact = JavaString.fromCodeUnits([0xd800]);
  const commit = commitEdits(
    document,
    new EditTransactionBuilder(document)
      .semanticValue(document.properties()[0].nodeRef(), exact)
      .build(),
  );
  assert.equal(render(commit.document()), 'a=\\uD800\n');
  assert.ok(commit.document().properties()[0].value().equals(exact));
});

test('literal replacement requires one exact value ownership interval (edit.rs:1226-1256)', () => {
  const document = parse('a=one\nb=two\n');
  for (const invalid of [' leading', 'line\nbreak', 'tail\\']) {
    const transaction = new EditTransactionBuilder(document)
      .literalValue(document.properties()[0].nodeRef(), bytes(invalid))
      .build();
    assert.throws(
      () => commitEdits(document, transaction),
      (error: unknown) => {
        assert.ok(error instanceof EditFailure);
        assert.equal(error.kind, 'InvalidLiteral');
        assert.equal(error.code, 'core.edit.invalid-literal@1');
        return true;
      },
      invalid,
    );
  }
});

test('removal owns continuation lines but not adjacent comments (edit.rs:1320-1329)', () => {
  const document = parse('# before\nkey=first\\\n  second\n# after\nnext=v\n');
  const commit = commitEdits(
    document,
    new EditTransactionBuilder(document)
      .removeProperty(document.properties()[0].nodeRef())
      .build(),
  );
  assert.equal(render(commit.document()), '# before\n# after\nnext=v\n');
  assert.equal(commit.document().comments().length, 2);
  assert.equal(commit.document().properties().length, 1);
});

test('rename replaces the complete continued key ownership (edit.rs:1331-1345)', () => {
  const document = parse('old\\\n key=value\n');
  const commit = commitEdits(
    document,
    new EditTransactionBuilder(document)
      .renameProperty(document.properties()[0].nodeRef(), JavaString.fromUnicode('new key'))
      .build(),
  );
  assert.equal(render(commit.document()), 'new\\ key=value\n');
  assert.equal(commit.document().properties()[0].key().toUnicode(), 'new key');
});

test('snapshot, role, recovery, and encoding contracts are enforced (edit.rs:1394-1485)', () => {
  const document = parse('a=1\n');
  const other = parse('a=1\n');

  const wrongSnapshot = new EditTransactionBuilder(document)
    .semanticValue(other.properties()[0].nodeRef(), JavaString.fromUnicode('x'))
    .build();
  assert.throws(
    () => commitEdits(document, wrongSnapshot),
    (error: unknown) => {
      assert.ok(error instanceof EditFailure);
      assert.equal(error.kind, 'WrongSnapshot');
      assert.equal(error.code, 'core.edit.wrong-snapshot@1');
      return true;
    },
  );

  const wrongRole = new EditTransactionBuilder(document)
    .semanticValue(document.nodeRef(), JavaString.fromUnicode('x'))
    .build();
  assert.throws(
    () => commitEdits(document, wrongRole),
    (error: unknown) => {
      assert.ok(error instanceof EditFailure);
      assert.equal(error.kind, 'WrongRole');
      assert.equal(error.code, 'core.edit.wrong-role@1');
      return true;
    },
  );

  const recovered = parse('bad=\\u12G4\n');
  const recoveredTransaction = new EditTransactionBuilder(recovered).build();
  assert.throws(
    () => commitEdits(recovered, recoveredTransaction),
    (error: unknown) => {
      assert.ok(error instanceof EditFailure);
      assert.equal(error.kind, 'RecoveredDocument');
      assert.equal(error.code, 'core.edit.incomplete-target@1');
      return true;
    },
  );
});

test('insertions honor all property-relative placements and duplicates (edit.rs:1258-1318)', () => {
  const source = '# head\na=1\n# middle\nb=2';
  const cases: readonly { placement: 'Start' | 'End' | 'BeforeSecond' | 'AfterFirst'; expected: string }[] = [
    { placement: 'Start', expected: '# head\nx=0\na=1\n# middle\nb=2' },
    { placement: 'BeforeSecond', expected: '# head\na=1\n# middle\nx=0\nb=2' },
    { placement: 'AfterFirst', expected: '# head\na=1\nx=0\n# middle\nb=2' },
    { placement: 'End', expected: '# head\na=1\n# middle\nb=2\nx=0\n' },
  ];
  for (const sample of cases) {
    const document = parse(source);
    const placement =
      sample.placement === 'Start' || sample.placement === 'End'
        ? { kind: sample.placement } as const
        : sample.placement === 'BeforeSecond'
          ? { kind: 'Before' as const, anchor: document.properties()[1].nodeRef() }
          : { kind: 'After' as const, anchor: document.properties()[0].nodeRef() };
    const commit = commitEdits(
      document,
      new EditTransactionBuilder(document)
        .insertProperty(document.nodeRef(), JavaString.fromUnicode('x'), JavaString.fromUnicode('0'), placement)
        .build(),
    );
    assert.equal(render(commit.document()), sample.expected, sample.placement);
  }

  const duplicate = parse('a=1\na=2\n');
  const duplicateCommit = commitEdits(
    duplicate,
    new EditTransactionBuilder(duplicate)
      .insertProperty(
        duplicate.nodeRef(),
        JavaString.fromUnicode('a'),
        JavaString.fromUnicode('3'),
        { kind: 'End' },
      )
      .build(),
  );
  assert.equal(duplicateCommit.document().properties().length, 3);
  assert.ok(
    duplicateCommit
      .document()
      .properties()
      .every((property) => property.key().toUnicode() === 'a'),
  );
});
