/**
 * HCL structural edit intent tests — golden transcriptions from the shared
 * vector suite (RFC 0014 §10; RFC 0004 §13-§16).
 *
 * Blind-written intent documents (docs/multi-language-implementation
 * -plan.md §3); no gate is claimed before the §7 START GATE.
 *
 * Golden cases cited: hcl-v1.json case ids are named in each test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  commitHclEdits,
  dryRunHclEdits,
  HclEditTransactionBuilder,
  HclBodyPath,
} from './edit.ts';
import { EditPlanSourceId } from '../document/edit_plan.ts';
import { DEFAULT_SOURCE_PATCH_LIMITS } from '../document/source_patch.ts';
import { parseHcl, profileDefaultEncoding } from './document.ts';
import type { HclDocument } from './document.ts';
import { HclProfile } from './profile.ts';
import { hclParseLimits } from './limits.ts';
import { HclEditFailure } from './errors.ts';

function parse(text: string, profile: HclProfile = HclProfile.NATIVE_V1): HclDocument {
  return parseHcl(new TextEncoder().encode(text), profile, profileDefaultEncoding(), hclParseLimits());
}

function render(document: HclDocument): string {
  return new TextDecoder().decode(document.render());
}

function commit(
  document: HclDocument,
  build: (builder: HclEditTransactionBuilder) => void,
): HclDocument {
  const builder = new HclEditTransactionBuilder(document);
  build(builder);
  const result = commitHclEdits(document, builder.build());
  return result.document();
}

/** Expects one frozen edit failure code (edit.rs:599-611). */
function expectEditFailure(
  document: HclDocument,
  build: (builder: HclEditTransactionBuilder) => void,
  code: string,
): void {
  const builder = new HclEditTransactionBuilder(document);
  build(builder);
  assert.throws(
    () => commitHclEdits(document, builder.build()),
    (error: unknown) => error instanceof HclEditFailure && error.code === code,
  );
}

// ---------------------------------------------------------------------------
// Golden transcriptions (hcl.edit@1)
// ---------------------------------------------------------------------------

test('golden hcl.edit.attribute-operations: insert/set/rename/remove in one transaction', () => {
  // conformance/vectors/hcl-v1.json:1462-1504 (id hcl.edit.attribute-
  // operations; expected render "zone = \"a\"\ncount = 3\nactive = true\n",
  // reparse_closure, untouched_byte_proof, patch_replays all true).
  const document = parse('region = "us-east-1"\ncount = 2\nenabled = true\n');
  const target = commit(document, (builder) => {
    builder
      .insertAttribute(HclBodyPath.root(), 'zone', { kind: 'String', value: 'a' }, { kind: 'First' })
      .setAttributeValue(HclBodyPath.root(), 'count', { kind: 'Integer', value: 3n })
      .renameAttribute(HclBodyPath.root(), 'enabled', 'active')
      .removeAttribute(HclBodyPath.root(), 'region');
  });
  assert.equal(target.formationStatus(), 'Complete', 'reparse_closure');
  assert.equal(render(target), 'zone = "a"\ncount = 3\nactive = true\n');
  // untouched_byte_proof and patch_replays are verified by the runner over
  // the committed artifacts; the commit derives both.
  const builder = new HclEditTransactionBuilder(document);
  builder
    .insertAttribute(HclBodyPath.root(), 'zone', { kind: 'String', value: 'a' }, { kind: 'First' })
    .setAttributeValue(HclBodyPath.root(), 'count', { kind: 'Integer', value: 3n })
    .renameAttribute(HclBodyPath.root(), 'enabled', 'active')
    .removeAttribute(HclBodyPath.root(), 'region');
  const committed = commitHclEdits(document, builder.build());
  committed.untouchedProof().verify(document.source(), committed.document().source(), committed.sourcePatch().replacements());
  const replay = committed.sourcePatch().apply(document.source(), DEFAULT_SOURCE_PATCH_LIMITS);
  assert.deepEqual(replay.bytes(), committed.document().render());
});

test('golden hcl.edit.block-operations: insert and remove blocks; labels always quoted', () => {
  // conformance/vectors/hcl-v1.json:1506-1549 (id hcl.edit.block-operations;
  // expected render "server \"db\" {\n  port = 5432\n}\n",
  // labels_always_quoted true).
  const document = parse('server "web" {\n  port = 8080\n}\n');
  const target = commit(document, (builder) => {
    builder
      .insertBlock(
        HclBodyPath.root(),
        'server',
        ['db'],
        [['port', { kind: 'Integer', value: 5432n }]],
        { kind: 'Last' },
      )
      .removeBlock(HclBodyPath.root(), 'server', ['web'], 0);
  });
  assert.equal(target.formationStatus(), 'Complete', 'reparse_closure');
  assert.equal(render(target), 'server "db" {\n  port = 5432\n}\n');
  // labels_always_quoted: every label of the committed document is quoted.
  for (const item of target.root().items()) {
    if ('labels' in item) {
      for (const label of item.labels()) {
        assert.equal(label.quoted(), true);
      }
    }
  }
});

test('golden hcl.edit.conflicts: the frozen conflict codes, base unchanged', () => {
  // conformance/vectors/hcl-v1.json:1551-1647 (id hcl.edit.conflicts; codes
  // [hcl.edit.duplicate-attribute@1, hcl.edit.block-in-tfvars@1,
  // hcl.edit.unrepresentable@1, core.edit.incomplete-target@1,
  // core.edit.wrong-snapshot@1]; base_unchanged true).
  const duplicate = parse('count = 2\n');
  expectEditFailure(duplicate, (builder) => {
    builder.insertAttribute(HclBodyPath.root(), 'count', { kind: 'Integer', value: 3n }, { kind: 'Last' });
  }, 'hcl.edit.duplicate-attribute@1');

  const tfvars = parse('region = "x"\n', HclProfile.TFVARS_V1);
  expectEditFailure(tfvars, (builder) => {
    builder.insertBlock(HclBodyPath.root(), 'server', ['db'], [], { kind: 'Last' });
  }, 'hcl.edit.block-in-tfvars@1');

  const unrepresentable = parse('count = 2\n');
  expectEditFailure(unrepresentable, (builder) => {
    builder.setAttributeValue(HclBodyPath.root(), 'count', {
      kind: 'Expression',
      kindName: 'binary',
      text: '1 + 2',
    });
  }, 'hcl.edit.unrepresentable@1');

  const missing = parse('count = 2\n');
  expectEditFailure(missing, (builder) => {
    builder.setAttributeValue(HclBodyPath.root(), 'missing', { kind: 'Integer', value: 1n });
  }, 'core.edit.incomplete-target@1');

  // The transaction is bound to another document's snapshot.
  const wrongSource = parse('other = 1\n');
  const base = parse('count = 2\n');
  const wrongTransaction = new HclEditTransactionBuilder(wrongSource);
  wrongTransaction.setAttributeValue(HclBodyPath.root(), 'count', { kind: 'Integer', value: 9n });
  assert.throws(
    () => commitHclEdits(base, wrongTransaction.build()),
    (error: unknown) => error instanceof HclEditFailure && error.code === 'core.edit.wrong-snapshot@1',
  );
  // base_unchanged: failures never mutate the base document.
  assert.equal(render(base), 'count = 2\n');
  assert.equal(render(duplicate), 'count = 2\n');
  assert.equal(render(tfvars), 'region = "x"\n');
});

test('golden hcl.edit.dry-run-equivalence: dry-run and commit share replacements and digest', () => {
  // conformance/vectors/hcl-v1.json:2047-2080 (id hcl.edit.dry-run-
  // equivalence; expected render
  // "region = \"us-east-1\"\ncount = 7\nenabled = true\nzone = \"b\"\n",
  // dry_run_equivalent true).
  const document = parse('region = "us-east-1"\ncount = 2\nenabled = true\n');
  const builder = new HclEditTransactionBuilder(document);
  builder
    .setAttributeValue(HclBodyPath.root(), 'count', { kind: 'Integer', value: 7n })
    .insertAttribute(HclBodyPath.root(), 'zone', { kind: 'String', value: 'b' }, { kind: 'Last' });
  const transaction = builder.build();
  const committed = commitHclEdits(document, transaction);
  assert.equal(render(committed.document()), 'region = "us-east-1"\ncount = 7\nenabled = true\nzone = "b"\n');
  const plan = dryRunHclEdits(document, transaction, new EditPlanSourceId('hcl-conformance'));
  assert.equal(plan.targetDigest().equals(committed.document().source().digest()), true);
  assert.equal(
    plan.replacements().length,
    committed.sourcePatch().replacements().length,
    'dry-run replacement set equals the committed replacement set',
  );
  for (let index = 0; index < plan.replacements().length; index++) {
    const planned = plan.replacements()[index];
    const actual = committed.sourcePatch().replacements()[index];
    assert.equal(planned.oldStart(), actual.oldStart());
    assert.equal(planned.oldEnd(), actual.oldEnd());
    assert.deepEqual(planned.replacement(), actual.replacement());
  }
});
