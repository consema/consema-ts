/**
 * Conformance runner test (L4; authority: https://github.com/consema/consema/blob/main/docs/five-language-ci-design.md
 * §2.2 — the runner test asserts the digest, the 18/519 inventory, the
 * per-suite counts, and executes every case; conformance/README.md 规则 4
 * "每个 suite 必须验证 case 数量"——行号可能漂移，以规则编号为锚).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUITE_EXPECTED_COUNTS,
  SUITE_SCHEMA,
  main,
  runAll,
  runSuiteFile,
} from './runner.ts';

test('conformance: 18 suites / 519 cases, digest match or documented skip, zero failures', () => {
  const result = runAll();
  // W4-13/R10: the recorded digest comes from the provisioned fc-manifest
  // (no hardcoded literal); without the manifest the digest assertion is a
  // documented skip (never silent) and the inventory/pass assertions below
  // still run.
  if (result.digestSkipped !== undefined) {
    assert.ok(result.digestSkipped.length > 0, 'a skipped digest carries a reason');
    assert.equal(result.digestOk, false, 'a skipped digest is not reported as a match');
  } else {
    assert.equal(result.digestOk, true, 'digest and inventory must match the manifest');
  }
  assert.equal(result.digest.suites, 18, '18 suites');
  assert.equal(result.digest.cases, 519, '519 cases');
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
  // A single unknown option-like argument (--help) is the usage class
  // (exit 1, RFC 0015 §5.1 unknown-argument), not an input-read data
  // failure (W4-22).
  assert.equal(main(['node', 'runner.ts', '--help']), 1, 'unknown option exits 1');
  assert.equal(main(['node', 'runner.ts', '--unknown-flag']), 1, 'unknown flag exits 1');
  // A missing vectors directory is an input-read failure (exit 2, data).
  assert.equal(main(['node', 'runner.ts', 'no-such-vectors-dir']), 2, 'missing vectors dir exits 2');
});

test('W4-16 (R4): every published suite pins its schema (suite id + semantic model)', () => {
  const result = runAll();
  assert.equal(result.reports.length, 18, '18 published suites');
  for (const report of result.reports) {
    const pin = SUITE_SCHEMA[report.file];
    assert.ok(pin !== undefined, `${report.file} must be pinned in SUITE_SCHEMA`);
    assert.equal(report.suite, pin.suiteId, `${report.file} suite id must match the pin`);
  }
});

test('W4-16 (R4): a drifted semantic_model declaration fails as suite.schema', () => {
  // A vector whose declared semantic_model differs from the published pin
  // must fail loudly (the vendored conformance README claims every runner
  // validates suite/schema/semantic-model).
  const drifted = {
    file: 'protocol-v2.json',
    suite: 'consema.protocol.conformance@2',
    semanticModel: 'core.semantic-model@99',
    cases: Array.from({ length: 11 }, (_, index) => ({
      id: `x${index}`,
      expected: {},
    })),
  };
  assert.throws(
    () => runSuiteFile(drifted),
    /suite\.schema/,
    'a drifted semantic-model declaration fails loudly',
  );
  // An unpinned suite file also fails loudly.
  assert.throws(
    () =>
      runSuiteFile({
        file: 'unpublished.json',
        suite: 'consema.conformance@1',
        cases: [],
      }),
    /no published suite schema pin/,
    'an unpinned suite file fails loudly',
  );
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
