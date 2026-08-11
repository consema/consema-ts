/**
 * Intent documents for the dry-run EditPlan (RFC 0004 §14;
 * crates/consema-document/src/edit_plan.rs:72-197): a plan closes only
 * when its ordered operation metadata matches its exact SourcePatch, and
 * possessing a plan never authorizes a write.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EditPlan, EditOperationSummary, EditPlanSourceId } from './edit_plan.ts';
import { SourcePatch } from './source_patch.ts';
import { DEFAULT_SOURCE_PATCH_LIMITS } from './source_patch.ts';
import { EncodingRequest, SourceSnapshot, utf8Encoding } from './source.ts';
import { DEFAULT_SOURCE_LIMITS } from './source.ts';
import { FormatOperationId } from './operation.ts';
import { ProfileId } from './profile.ts';
import { EditPlanError } from './errors.ts';
import { decodeHex } from './hex.ts';

const LIMITS = DEFAULT_SOURCE_PATCH_LIMITS;

test('plan requires a non-empty bounded external source identity (edit_plan.rs:17-24)', () => {
  assert.throws(
    () => new EditPlanSourceId(''),
    (error: unknown) => {
      assert.ok(error instanceof EditPlanError);
      assert.equal(error.kind, 'InvalidSourceId');
      return true;
    },
  );
  const long = 'a'.repeat(1025);
  assert.throws(
    () => new EditPlanSourceId(long),
    (error: unknown) => error instanceof EditPlanError && error.kind === 'InvalidSourceId',
  );
  assert.equal(new EditPlanSourceId('config.json').asString(), 'config.json');
});

test('plan closes only when operation metadata matches the patch (edit_plan.rs:82-121)', () => {
  const source = SourceSnapshot.fromRaw(decodeHex('61'), EncodingRequest.create(utf8Encoding()), DEFAULT_SOURCE_LIMITS);
  const operation = new FormatOperationId('json.edit.remove-member', 1);
  const patch = SourcePatch.create(
    source,
    [],
    new Map([['operation.0', operation.toString()]]),
    LIMITS,
  );
  const summary = new EditOperationSummary(
    operation,
    new Map([['target_role', 'json.object-member@1']]),
  );
  const plan = new EditPlan(
    new EditPlanSourceId('config.json'),
    new ProfileId('json.strict', 1),
    [summary],
    patch,
    [],
  );
  assert.equal(plan.sourceId().asString(), 'config.json');
  assert.equal(plan.profile().toString(), 'json.strict@1');
  assert.equal(plan.baseDigest().toHex(), plan.targetDigest().toHex());
  assert.equal(plan.operations().length, 1);
  assert.equal(plan.replacements().length, 0);
  assert.equal(plan.sourcePatch().metadata().get('operation.0'), 'json.edit.remove-member@1');

  // A summary whose operation does not match the patch metadata is rejected.
  const mismatched = new EditOperationSummary(
    new FormatOperationId('json.edit.insert-member', 1),
    new Map(),
  );
  assert.throws(
    () =>
      new EditPlan(
        new EditPlanSourceId('config.json'),
        new ProfileId('json.strict', 1),
        [mismatched],
        patch,
        [],
      ),
    (error: unknown) => {
      assert.ok(error instanceof EditPlanError);
      assert.equal(error.kind, 'OperationMetadataMismatch');
      assert.equal(error.index, 0);
      return true;
    },
  );
});

test('operation summaries reject raw edited values and invalid names (edit_plan.rs:33-70)', () => {
  assert.throws(
    () => new EditOperationSummary(new FormatOperationId('json.edit.remove-member', 1), new Map([['Bad-Name', 'x']])),
    (error: unknown) => error instanceof EditPlanError && error.kind === 'InvalidOperationSummary',
  );
  assert.throws(
    () =>
      new EditOperationSummary(
        new FormatOperationId('json.edit.remove-member', 1),
        new Map([['value', '']]),
      ),
    (error: unknown) => error instanceof EditPlanError && error.kind === 'InvalidOperationSummary',
  );
});
