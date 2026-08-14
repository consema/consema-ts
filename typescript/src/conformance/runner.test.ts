/**
 * Conformance runner test (L4; authority: https://github.com/consema/consema/blob/main/docs/five-language-ci-design.md
 * §2.2 — the runner test asserts the digest, the 18/519 inventory, the
 * per-suite counts, and executes every case; conformance/README.md 规则 4
 * "每个 suite 必须验证 case 数量"——行号可能漂移，以规则编号为锚).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RECORDED_AGGREGATE_DIGEST,
  SUITE_EXPECTED_COUNTS,
  main,
  runAll,
} from './runner.ts';

test('conformance: 18 suites / 519 cases, digest match, zero failures', () => {
  const result = runAll();
  assert.equal(result.digest.digest, RECORDED_AGGREGATE_DIGEST, 'aggregate digest must match the manifest');
  assert.equal(result.digest.suites, 18, '18 suites');
  assert.equal(result.digest.cases, 519, '519 cases');
  assert.equal(result.digestOk, true, 'digest and inventory must match the manifest');
  assert.equal(result.failed, 0, `zero failures, observed ${result.failed}`);
  // L5 zero documented skip (five-language-ci-design.md §5.3 L5 row): the
  // whole 519-case inventory executes with no capability gaps — a case that
  // lands in documented skip makes the assertion red, so a new capability
  // gap cannot be introduced silently.
  assert.equal(result.passed, 519, `all 519 cases pass, observed ${result.passed}`);
  assert.equal(result.skipped, 0, `zero documented skips at L5, observed ${result.skipped}`);
});

test('CLI exit classes (RFC 0015 §5.1): success 0, usage 1, data 2', () => {
  // A bare invocation runs the full suite (the provisioned vectors are the
  // same data runAll above consumes) and must exit success.
  assert.equal(main(['node', 'runner.ts']), 0, 'full run with default vectors dir exits 0');
  // More than one positional argument is a usage error (exit 1), not a
  // data failure.
  assert.equal(main(['node', 'runner.ts', 'vectors-dir', 'unexpected']), 1, 'extra positional argument exits 1');
  // A missing vectors directory is an input-read failure (exit 2, data).
  assert.equal(main(['node', 'runner.ts', 'no-such-vectors-dir']), 2, 'missing vectors dir exits 2');
});

test('conformance: per-suite counts match the published inventory', () => {
  const result = runAll();
  for (const report of result.reports) {
    const expected = SUITE_EXPECTED_COUNTS[report.file];
    assert.ok(expected !== undefined, `${report.file} must be a published suite`);
    const observed = report.outcomes.length;
    assert.equal(
      observed,
      expected,
      `${report.file}: case count ${observed} != published ${expected}`,
    );
  }
});

test('conformance: every skip is a documented capability skip with a reason', () => {
  const result = runAll();
  for (const report of result.reports) {
    for (const outcome of report.outcomes) {
      if (outcome.status === 'skipped') {
        assert.ok(
          outcome.message !== undefined && outcome.message.length > 0,
          `${report.file}/${outcome.id}: documented skip requires a reason`,
        );
      }
    }
  }
});
