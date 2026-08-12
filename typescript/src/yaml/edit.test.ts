/**
 * Intent documents for YAML structural editing.
 *
 * Golden transcriptions from the shared vectors — each test cites its
 * case id in conformance/vectors/yaml-v1.json:
 *  - edit.scalar-atomic (:106-109), edit.anchor-rename (:111-114),
 *    edit.structural-insert (:116-119), edit.anchor-dependency (:121-124)
 * Edit semantics: RFC 0007 §12 (the anchor-safe rules :383-392);
 * crates/consema-yaml/src/edit.rs (the e420ad7 anchor-dependency behavior:
 * only the deleted subtree is collected for validation, edit.rs:1398-1442).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parse,
  EditTransactionBuilder,
  EditFailure,
  commitEdits,
  dryRunEdits,
} from './index.ts';
import { PROFILE_YAML12_CORE } from './index.ts';
import { DEFAULT_PARSE_LIMITS } from '../document/formation.ts';
import { EditPlanSourceId } from '../document/edit_plan.ts';
import { booleanValue, integerValue, stringValue } from '../core/value.ts';
import { decodeUtf8 } from './test_decode.ts';

function core(source: string) {
  return parse(new TextEncoder().encode(source), PROFILE_YAML12_CORE, DEFAULT_PARSE_LIMITS);
}

function render(document: { render(): Uint8Array }): string {
  return decodeUtf8(document.render());
}

test('edit.scalar-atomic — semantic replacement keeps trivia (yaml-v1.json:106-109)', () => {
  const document = core('# keep\na: 1\nb: two\n');
  const entry = document.document(0)!.root().mappingEntry(0)!;
  const builder = new EditTransactionBuilder(document);
  builder.semanticScalar(entry.value().nodeRef(), integerValue(2n), 'PreserveCompatible');
  const transaction = builder.build();
  const commit = commitEdits(document, transaction);
  assert.equal(render(commit.document()), '# keep\na: 2\nb: two\n');
  assert.equal(commit.changeSet().sourceEdits().length, 1);
  commit
    .untouchedProof()
    .verify(
      document.source(),
      commit.document().source(),
      commit.sourcePatch().replacements(),
    );
});

test('edit.anchor-rename — dependent aliases update in one transaction (yaml-v1.json:111-114)', () => {
  const document = core('first: &x [one]\ncopy: *x\n');
  const anchored = document.document(0)!.root().mappingEntry(0)!.value();
  const builder = new EditTransactionBuilder(document);
  builder.renameAnchor(anchored.anchorNodeRef()!, 'renamed');
  const transaction = builder.build();
  const commit = commitEdits(document, transaction);
  assert.equal(render(commit.document()), 'first: &renamed [one]\ncopy: *renamed\n');
  assert.equal(commit.document().alias(0)!.name(), 'renamed');
});

test('edit.structural-insert — canonical flow fragments (yaml-v1.json:116-119)', () => {
  const document = core('seq: [one, two]\nmap: {a: 1}\n');
  const root = document.document(0)!.root();
  const sequence = root.mappingEntry(0)!.value();
  const mapping = root.mappingEntry(1)!.value();
  const builder = new EditTransactionBuilder(document);
  // Insert `true` before the second sequence element and entry `b: 2` at
  // the mapping end; the vector input pins the exact canonical spellings.
  builder.insertSequenceElement(
    sequence.nodeRef(),
    booleanValue(true),
    { kind: 'Before', anchor: sequence.sequenceItem(1)!.nodeRef() },
  );
  builder.insertMappingEntry(
    mapping.nodeRef(),
    stringValue('b'),
    integerValue(2n),
    { kind: 'End' },
  );
  const commit = commitEdits(document, builder.build());
  assert.equal(
    render(commit.document()),
    'seq: [one, !!bool "true", two]\nmap: {a: 1, ? !!str "b" : !!int "2"}\n',
  );
});

test('edit.anchor-dependency — removing an anchored definition with live aliases fails (yaml-v1.json:121-124)', () => {
  const document = core('seq:\n  - &x one\ncopy: *x\n');
  const seqEntry = document.document(0)!.root().mappingEntry(0)!;
  const builder = new EditTransactionBuilder(document);
  builder.removeMappingEntry(seqEntry.nodeRef());
  assert.throws(
    () => commitEdits(document, builder.build()),
    (error: unknown) => {
      assert.ok(error instanceof EditFailure);
      assert.equal(error.kind, 'AnchorDependency');
      assert.equal(error.code, 'yaml.edit.anchor-dependency@1');
      return true;
    },
  );
});

test('edit.anchor-dependency — deleting an alias does not delete its target', () => {
  // Removing the alias association is fine: only the deleted subtree is
  // collected for validation (edit.rs:1398-1418).
  const document = core('first: &x [one]\ncopy: *x\n');
  const copyEntry = document.document(0)!.root().mappingEntry(1)!;
  const builder = new EditTransactionBuilder(document);
  builder.removeMappingEntry(copyEntry.nodeRef());
  const commit = commitEdits(document, builder.build());
  assert.equal(render(commit.document()), 'first: &x [one]\n');
  assert.equal(commit.document().aliasCount(), 0);
});

test('edit.anchor-dependency — a subtree reachable only through an alias is not owned', () => {
  // The anchored subtree is referenced by an alias edge; removing a
  // sibling that shares no owned nodes must not trigger the dependency.
  const document = core('a: &x [one]\nb: [two]\ncopy: *x\n');
  const bEntry = document.document(0)!.root().mappingEntry(1)!;
  const builder = new EditTransactionBuilder(document);
  builder.removeMappingEntry(bEntry.nodeRef());
  const commit = commitEdits(document, builder.build());
  assert.equal(render(commit.document()), 'a: &x [one]\ncopy: *x\n');
});

test('edit — dry-run and commit produce the same target digest', () => {
  const document = core('# keep\na: 1\nb: two\n');
  const entry = document.document(0)!.root().mappingEntry(0)!;
  const builder = new EditTransactionBuilder(document);
  builder.semanticScalar(entry.value().nodeRef(), integerValue(2n), 'PreserveCompatible');
  const transaction = builder.build();
  const plan = dryRunEdits(document, transaction, new EditPlanSourceId('scalar.yaml'));
  const commit = commitEdits(document, transaction);
  assert.equal(
    plan.targetDigest().equals(commit.sourcePatch().targetDigest()),
    true,
  );
  assert.equal(render(commit.document()), '# keep\na: 2\nb: two\n');
});

test('edit — one structural mutation per base container is enforced', () => {
  const document = core('seq: [one]\n');
  const sequence = document.document(0)!.root().mappingEntry(0)!.value();
  const element = sequence.sequenceItem(0)!;
  const builder = new EditTransactionBuilder(document);
  // Different targets (the sequence container and one element inside it)
  // resolve to the same structural container and conflict.
  builder.insertSequenceElement(sequence.nodeRef(), stringValue('a'), { kind: 'End' });
  builder.removeSequenceElement(element.nodeRef());
  assert.throws(
    () => commitEdits(document, builder.build()),
    (error: unknown) => {
      assert.ok(error instanceof EditFailure);
      assert.equal(error.kind, 'StructuralContainerConflict');
      assert.equal(error.code, 'yaml.edit.structural-container-conflict@1');
      return true;
    },
  );
});

test('edit — canonical fallback is explicit and keeps anchor properties', () => {
  const document = core('value: &x plain\ncopy: *x\n');
  const target = document.document(0)!.root().mappingEntry(0)!.value();
  const builder = new EditTransactionBuilder(document);
  builder.semanticScalar(target.nodeRef(), booleanValue(true), 'PreserveElseCanonical');
  const commit = commitEdits(document, builder.build());
  assert.equal(commit.changeSet().diagnostics().length, 1);
  assert.equal(
    commit.changeSet().diagnostics()[0].code,
    'yaml.edit.canonical-fallback@1',
  );
  assert.ok(render(commit.document()).includes('&x !!bool "true"'));
  assert.equal(commit.document().alias(0)!.target().scalar()!.canonical(), 'true');
});

test('edit — wrong snapshot is rejected before any output', () => {
  const document = core('a: 1\n');
  const other = core('b: 2\n');
  const entry = other.document(0)!.root().mappingEntry(0)!;
  const builder = new EditTransactionBuilder(document);
  builder.semanticScalar(entry.value().nodeRef(), integerValue(9n), 'PreserveCompatible');
  assert.throws(
    () => commitEdits(document, builder.build()),
    (error: unknown) => {
      assert.ok(error instanceof EditFailure);
      assert.equal(error.kind, 'WrongSnapshot');
      return true;
    },
  );
});
