/**
 * Cross-language normalized-result differential harness test — TypeScript
 * side (design: docs/five-language-ci-design.md §3.3; Go precedent:
 * go/conformance/differential/normalized/normalized_test.go).
 *
 * TestCaseFileIntegrity always runs and guards the checked-in case set
 * (manifest id, case count, unique ids), so `npm test` protects the input
 * set even without the orchestrator.
 *
 * TestNormalizedDifferential skips without CONSEMA_DIFFERENTIAL_NORMALIZED_RUST_DIR
 * (documented skip, never silent) and runs only when
 * scripts/ts-verify-normalized-differential.ps1 provisioned the Rust
 * evidence directory: the TS facts for the same input set are compared
 * field by field against the Rust golden files.
 *
 * TestEmitTSNormalizedResults emits the TS-side evidence files for the same
 * input set into CONSEMA_DIFFERENTIAL_NORMALIZED_TS_DIR (the reverse
 * direction of the bidirectional differential: the Rust example's --consume
 * mode reads this directory and compares it with its own results).
 *
 * TestEmitFormatConsistency always runs and proves the emitted files
 * round-trip through the forward reader.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CASE_FILE_MANIFEST,
  MIN_CASE_COUNT,
  TS_DIR_ENV,
  compareFacts,
  defaultCasesFile,
  emitFactsToDir,
  loadCaseFile,
  readEvidenceFile,
  runCase,
  runNormalizedForward,
} from './normalized.ts';

/** The environment variable naming the Rust golden evidence directory. */
const RUST_DIR_ENV = 'CONSEMA_DIFFERENTIAL_NORMALIZED_RUST_DIR';

test('normalized: case file integrity (manifest, count, ids)', () => {
  const cases = loadCaseFile(defaultCasesFile());
  assert.equal(cases.length, 108, 'the differential input set has 108 cases');
  const seen = new Set<string>();
  for (const c of cases) {
    assert.ok(!seen.has(c.id), `duplicate case id ${c.id}`);
    seen.add(c.id);
    assert.ok(c.kind === 'document' || c.kind === 'source', `unknown kind ${c.kind}`);
  }
  assert.ok(CASE_FILE_MANIFEST.length > 0);
  assert.ok(MIN_CASE_COUNT >= 104);
});

test('normalized: TS facts match the Rust golden facts for 108/108 cases', (t) => {
  const rustDir = process.env[RUST_DIR_ENV];
  if (rustDir === undefined || rustDir === '') {
    t.skip(`${RUST_DIR_ENV} is not set: run scripts/ts-verify-normalized-differential.ps1 to provision the Rust evidence files`);
    return;
  }
  const cases = loadCaseFile(defaultCasesFile());
  const result = runNormalizedForward(defaultCasesFile(), rustDir);
  for (const failure of result.failures) {
    assert.fail(failure);
  }
  assert.equal(result.failures.length, 0);
  assert.equal(result.passed, cases.length, 'every case must match');
  t.diagnostic(`normalized-result differential: ${result.passed}/${cases.length} equal`);
});

test('normalized: TS evidence files emit into CONSEMA_DIFFERENTIAL_NORMALIZED_TS_DIR', (t) => {
  const tsDir = process.env[TS_DIR_ENV];
  if (tsDir === undefined || tsDir === '') {
    t.skip(`${TS_DIR_ENV} is not set: run scripts/ts-verify-normalized-differential.ps1 to provision the TS evidence directory`);
    return;
  }
  const cases = loadCaseFile(defaultCasesFile());
  const emitted = emitFactsToDir(cases, tsDir);
  assert.equal(emitted, cases.length, 'every case must emit');
  t.diagnostic(`emitted ${emitted} TS normalized results into ${tsDir}`);
});

test('normalized: emitted format round-trips through the forward reader', () => {
  const cases = loadCaseFile(defaultCasesFile());
  const dir = mkdtempSync(join(tmpdir(), 'consema-ts-normalized-'));
  try {
    const emitted = emitFactsToDir(cases, dir);
    assert.equal(emitted, cases.length);
    for (const c of cases) {
      const lines = readEvidenceFile(dir, c.id);
      const computed = runCase(c);
      for (const failure of compareFacts(c.id, computed, lines)) {
        assert.fail(failure);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
