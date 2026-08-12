/**
 * Cross-language PVCE/PGCE byte-parity harness test — TypeScript side
 * (design: docs/five-language-ci-design.md §3.2; Go precedent:
 * go/conformance/differential/differential_test.go).
 *
 * TestCaseFileIntegrity always runs and guards the checked-in case set
 * (manifest id, case count, unique ids, kinds coverage), so `npm test`
 * protects the input set even without the orchestrator.
 *
 * TestDifferentialByteParity skips without the environment variable
 * (documented skip, never silent) and runs only when
 * scripts/ts-verify-byte-parity.ps1 provisioned the Rust byte directory
 * (CONSEMA_DIFFERENTIAL_RUST_DIR): the TS encoders produce the bytes for the
 * same input set, compared byte for byte against the Rust golden files, and
 * the bidirectional direction (Rust bytes -> TS decode -> TS re-encode) is
 * verified.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_KIND_NAMES,
  CASE_FILE_MANIFEST,
  MIN_CASE_COUNT,
  defaultCasesFile,
  loadCaseFile,
  runByteParity,
} from './byte_parity.ts';

/** The environment variable naming the Rust golden byte directory. */
const RUST_DIR_ENV = 'CONSEMA_DIFFERENTIAL_RUST_DIR';

test('byte parity: case file integrity (manifest, count, ids, kinds)', () => {
  const cases = loadCaseFile(defaultCasesFile());
  assert.equal(cases.length, 68, 'the differential input set has 68 cases');
  const seen = new Set<string>();
  for (const c of cases) {
    assert.ok(!seen.has(c.id), `duplicate case id ${c.id}`);
    seen.add(c.id);
    assert.ok(c.codec === 'pvce' || c.codec === 'pgce', `unknown codec ${c.codec}`);
  }
  const kinds = new Set(cases.flatMap((c) => [...c.kinds]));
  for (const kind of ALL_KIND_NAMES) {
    assert.ok(kinds.has(kind), `case set does not cover kind ${kind}`);
  }
});

test('byte parity: TS encoders match the Rust golden bytes for 68/68 cases', (t) => {
  const rustDir = process.env[RUST_DIR_ENV];
  if (rustDir === undefined || rustDir === '') {
    t.skip(`${RUST_DIR_ENV} is not set: run scripts/ts-verify-byte-parity.ps1 to provision the Rust encoder bytes`);
    return;
  }
  const cases = loadCaseFile(defaultCasesFile());
  const result = runByteParity(defaultCasesFile(), rustDir);
  for (const failure of result.failures) {
    assert.fail(failure.detail);
  }
  assert.equal(result.failures.length, 0);
  assert.equal(result.passed, cases.length, 'every case must match');
  t.diagnostic(`byte parity: ${result.passed}/${cases.length} equal (${result.pvceCount} pvce, ${result.pgceCount} pgce)`);
  assert.ok(CASE_FILE_MANIFEST.length > 0);
  assert.ok(MIN_CASE_COUNT >= 40);
});
