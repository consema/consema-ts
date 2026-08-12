/**
 * Conformance runner test (L4; authority: docs/five-language-ci-design.md
 * §2.2 — the runner test asserts the digest, the 18/519 inventory, the
 * per-suite counts, and executes every case; conformance/README.md:81-82
 * "每个 suite 必须验证 case 数量").
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RECORDED_AGGREGATE_DIGEST,
  SUITE_EXPECTED_COUNTS,
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
