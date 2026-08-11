/**
 * Conformance runner test (L4; authority: docs/five-language-ci-design.md
 * §2.2 — the runner test asserts the digest, the 18/508 inventory, the
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

test('conformance: 18 suites / 508 cases, digest match, zero failures', () => {
  const result = runAll();
  assert.equal(result.digest.digest, RECORDED_AGGREGATE_DIGEST, 'aggregate digest must match the manifest');
  assert.equal(result.digest.suites, 18, '18 suites');
  assert.equal(result.digest.cases, 508, '508 cases');
  assert.equal(result.digestOk, true, 'digest and inventory must match the manifest');
  assert.equal(result.failed, 0, `zero failures, observed ${result.failed}`);
  assert.equal(result.passed + result.skipped, 508, 'every case executes (passed or documented skip)');
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
