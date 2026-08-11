/**
 * Cross-language protocol exchange harness test — TypeScript side (design:
 * docs/five-language-ci-design.md §3.4; Go precedent:
 * go/conformance/differential/protocol-exchange/exchange_test.go).
 *
 * TestCaseFileIntegrity always runs and guards the checked-in case set
 * (manifest id, case count, unique ids, per-record accept/reject coverage,
 * canonical transport JSON, registered expected codes), so `npm test`
 * protects the input set even without the orchestrator.
 *
 * TestProtocolExchange skips without CONSEMA_EXCHANGE_RUST_DIR (documented
 * skip, never silent) and runs only when
 * scripts/ts-verify-protocol-exchange.ps1 provisioned the Rust side: TS
 * bytes vs the Rust golden bytes on both transports, Rust bytes -> TS typed
 * record decode -> byte-identical re-encode, and rejection codes compared.
 *
 * TestEmitTSCodes emits the TS-side encoder files into
 * CONSEMA_EXCHANGE_TS_DIR (consumed by the Rust example's --verify pass,
 * closing the TS-encode -> Rust-decode direction).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_RECORDS,
  CASE_FILE_MANIFEST,
  MIN_CASE_COUNT,
  TS_DIR_ENV,
  defaultCasesFile,
  loadCaseFile,
  runExchange,
  verifyAcceptCanonical,
} from './exchange.ts';
import { defaultProtocolLimits } from '../../protocol/limits.ts';

/** The environment variable naming the Rust exchange directory. */
const RUST_DIR_ENV = 'CONSEMA_EXCHANGE_RUST_DIR';

test('exchange: case file integrity (manifest, count, ids, coverage)', () => {
  const cases = loadCaseFile(defaultCasesFile());
  assert.equal(cases.length, 83, 'the differential input set has 83 cases');
  const seen = new Set<string>();
  const coverage = new Map<string, [number, number]>();
  for (const c of cases) {
    assert.ok(!seen.has(c.id), `duplicate case id ${c.id}`);
    seen.add(c.id);
    assert.ok(ALL_RECORDS.includes(c.record), `unknown record ${c.record}`);
    const counts = coverage.get(c.record) ?? [0, 0];
    if (c.expectedErrorCode !== '') {
      counts[1]++;
    } else {
      counts[0]++;
    }
    coverage.set(c.record, counts);
  }
  for (const record of ALL_RECORDS) {
    const counts = coverage.get(record) ?? [0, 0];
    assert.ok(counts[0] > 0 && counts[1] > 0, `record ${record} must have accept and reject cases`);
  }
  assert.ok(CASE_FILE_MANIFEST.length > 0);
  assert.ok(MIN_CASE_COUNT >= 40);
});

test('exchange: TS codecs decode every accept case canonically', (t) => {
  // The TS-side canonicality check of the whole accept set (the Go
  // loadCaseFile strict check, kept per-case so divergences are reported
  // precisely). This is the documented protocol-layer surface: any
  // failure here is a TS typed-record codec divergence from the reference
  // wire format, not a case-file defect.
  const cases = loadCaseFile(defaultCasesFile());
  const failures: string[] = [];
  let passed = 0;
  for (const c of cases) {
    if (c.expectedErrorCode !== '') {
      continue;
    }
    const failure = verifyAcceptCanonical(c, defaultProtocolLimits());
    if (failure === null) {
      passed++;
    } else {
      failures.push(failure);
    }
  }
  for (const failure of failures) {
    t.diagnostic(`DIVERGENCE: ${failure}`);
  }
  assert.equal(failures.length, 0, `every accept case must decode canonically, observed ${failures.length} divergences`);
  t.diagnostic(`accept canonicality: ${passed} cases decode and re-encode byte-identically`);
});

test('exchange: TS codecs match the Rust golden bytes and rejection codes', (t) => {
  const rustDir = process.env[RUST_DIR_ENV];
  if (rustDir === undefined || rustDir === '') {
    t.skip(`${RUST_DIR_ENV} is not set: run scripts/ts-verify-protocol-exchange.ps1 to provision the Rust side`);
    return;
  }
  const result = runExchange(defaultCasesFile(), rustDir, null);
  for (const failure of result.failures) {
    t.diagnostic(`DIVERGENCE: ${failure}`);
  }
  t.diagnostic(
    `protocol exchange: ${result.acceptPassed}/${result.acceptCount} accept cases and ${result.rejectPassed}/${result.rejectCount} reject cases verified`,
  );
  assert.equal(result.failures.length, 0);
  assert.equal(result.acceptPassed, result.acceptCount, 'every accept case must verify');
  assert.equal(result.rejectPassed, result.rejectCount, 'every reject case must verify');
});

test('exchange: TS-side encoder files emit into CONSEMA_EXCHANGE_TS_DIR', (t) => {
  const tsDir = process.env[TS_DIR_ENV];
  if (tsDir === undefined || tsDir === '') {
    t.skip(`${TS_DIR_ENV} is not set: run scripts/ts-verify-protocol-exchange.ps1 to provision the TS exchange directory`);
    return;
  }
  const rustDir = process.env[RUST_DIR_ENV];
  if (rustDir === undefined || rustDir === '') {
    t.skip(`${RUST_DIR_ENV} is not set: the TS emitter needs the Rust directory for the byte comparison`);
    return;
  }
  const cases = loadCaseFile(defaultCasesFile());
  const result = runExchange(defaultCasesFile(), rustDir, tsDir);
  for (const failure of result.failures) {
    assert.fail(failure);
  }
  assert.equal(result.failures.length, 0);
  t.diagnostic(`emitted the TS encoder bytes for ${cases.length} cases into ${tsDir}`);
});
