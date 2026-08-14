/**
 * Intent documents for formation: FormationStatus closure and the frozen
 * parse/materialization limit defaults.
 *
 * authority: consema-rs/consema-document/src/lib.rs (FormationStatus)
 * and :614-639 (ParseLimits defaults); RFC 0016 §5.1 (F10: only the
 * `formation_status` equivalent, no `status` alias);
 * consema-rs/consema-document/src/materialization.rs;
 * consema-rs/consema-document/src/source_patch.rs;
 * consema-rs/consema-document/src/source.rs.
 * Cross-checked by consema-go/go/document/limits.go，行号可能漂移，以符号名为锚.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PARSE_LIMITS, type FormationStatus } from './formation.ts';
import { DEFAULT_SOURCE_LIMITS } from './source.ts';
import { DEFAULT_SOURCE_PATCH_LIMITS } from './source_patch.ts';
import { DEFAULT_MATERIALIZATION_LIMITS } from './materialization.ts';

/**
 * FormationStatus closure: the switch below is exhaustive over the closed
 * two-value union — if a third value were ever added to
 * `src/document/formation.ts`, this function would not compile
 * (RFC 0016 §4.1 "no default that silently accepts unknown kinds" applied
 * to status).
 */
function describeStatus(status: FormationStatus): string {
  switch (status) {
    case 'Complete':
      return 'entire syntax was formed without recovery';
    case 'Recovered':
      return 'a complete snapshot with explicit recovery structure was formed';
  }
}

test('FormationStatus is closed over Complete and Recovered (lib.rs)', () => {
  assert.equal(describeStatus('Complete'), 'entire syntax was formed without recovery');
  assert.equal(describeStatus('Recovered'), 'a complete snapshot with explicit recovery structure was formed');
  // The two values are distinct.
  assert.notEqual('Complete' as FormationStatus, 'Recovered' as FormationStatus);
});

test('ParseLimits defaults are the frozen values (lib.rs; consema-go/go/document/limits.go)', () => {
  assert.equal(DEFAULT_PARSE_LIMITS.maxSourceBytes, 64 * 1024 * 1024);
  assert.equal(DEFAULT_PARSE_LIMITS.maxNestingDepth, 256);
  assert.equal(DEFAULT_PARSE_LIMITS.maxTokenCount, 2_000_000);
  assert.equal(DEFAULT_PARSE_LIMITS.maxNodeCount, 1_000_000);
  assert.equal(DEFAULT_PARSE_LIMITS.maxDiagnostics, 10_000);
});

test('SourceLimits defaults are the frozen values (source.rs)', () => {
  assert.equal(DEFAULT_SOURCE_LIMITS.maxRawBytes, 64 * 1024 * 1024);
  assert.equal(DEFAULT_SOURCE_LIMITS.maxDecodedUtf8Bytes, 128 * 1024 * 1024);
  assert.equal(DEFAULT_SOURCE_LIMITS.maxDecodedScalars, 64 * 1024 * 1024);
});

test('SourcePatchLimits defaults are the frozen values (source_patch.rs)', () => {
  assert.equal(DEFAULT_SOURCE_PATCH_LIMITS.maxReplacements, 100_000);
  assert.equal(DEFAULT_SOURCE_PATCH_LIMITS.maxPatchBytes, 128 * 1024 * 1024);
  assert.equal(DEFAULT_SOURCE_PATCH_LIMITS.source.maxRawBytes, 64 * 1024 * 1024);
});

test('MaterializationLimits defaults are the frozen values (materialization.rs; consema-go/go/document/limits.go)', () => {
  assert.equal(DEFAULT_MATERIALIZATION_LIMITS.maxInputNodes, 1_000_000);
  assert.equal(DEFAULT_MATERIALIZATION_LIMITS.maxOutputBytes, 64 * 1024 * 1024);
  assert.equal(DEFAULT_MATERIALIZATION_LIMITS.maxDepth, 256);
  assert.equal(DEFAULT_MATERIALIZATION_LIMITS.maxReportEntries, 100_000);
  assert.equal(DEFAULT_MATERIALIZATION_LIMITS.maxProvenanceEntries, 2_000_000);
});
