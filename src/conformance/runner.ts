/**
 * The TS conformance runner framework (mirror of crates/consema-conformance
 * src/lib.rs + the Go runner's digest verification; authority:
 * docs/five-language-ci-design.md §2 — each runner is the sole executor of
 * the shared vectors; conformance/README.md — case structure, per-suite
 * counts; docs/fc-manifest-0.13.0.json:38-40 — the aggregate digest
 * algorithm).
 *
 * The runner reads conformance/vectors/*.json (18 files / 508 cases) by
 * explicit repository-relative path (no embedded copy — a second authority
 * would drift), verifies the aggregate digest, validates suite ids, case
 * id uniqueness, and per-suite counts, then dispatches every case to its
 * suite handler. Unimplemented capabilities are documented skips; every
 * case that fails the dispatch check fails loudly ("unknown action
 * rejected"), never silently.
 *
 * The CLI entry (`main`) prints per-suite pass/fail and exits non-zero on
 * any failure (RFC 0015 exit-class semantics: success 0 / data 2).
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { VectorCase } from './helpers.ts';
import { ConformanceFailure } from './helpers.ts';
import { SkippedCase } from './suites/common.ts';
import { runV1 } from './suites/v1.ts';
import { runTomlV1 } from './suites/toml_v1.ts';
import { runProtocolV1 } from './suites/protocol_v1.ts';
import { runSourceV1 } from './suites/source_v1.ts';
import { runSyntaxQueryV1 } from './suites/syntax_query_v1.ts';
import { runProtocolV2 } from './suites/protocol_v2.ts';
import { runOperationsV1 } from './suites/operations_v1.ts';
import { runJsonFamilyV2 } from './suites/json_family_v2.ts';
import { runPortableGraphV1 } from './suites/portable_graph_v1.ts';
import { runSemanticModelV5 } from './suites/semantic_model_v5.ts';
import { runYamlV1 } from './suites/yaml_v1.ts';
import { runSemanticModelV6 } from './suites/semantic_model_v6.ts';
import { runIniV1 } from './suites/ini_v1.ts';
import { runPropertiesV1 } from './suites/java_properties_v1.ts';
import { runXmlV1 } from './suites/xml_1_0_safe_v1.ts';
import { runPlistV1 } from './suites/plist_v1.ts';
import { runHclV1 } from './suites/hcl_v1.ts';
import { runCliV1 } from './suites/cli_v1.ts';

// ---------------------------------------------------------------------------
// Vector inventory
// ---------------------------------------------------------------------------

/** The 18 published suite files in byte-order (the digest sort order). */
export const SUITE_FILES: readonly string[] = Object.freeze([
  'cli-v1.json',
  'hcl-v1.json',
  'ini-v1.json',
  'java-properties-v1.json',
  'json-family-v2.json',
  'operations-v1.json',
  'plist-v1.json',
  'portable-graph-v1.json',
  'protocol-v1.json',
  'protocol-v2.json',
  'semantic-model-v5.json',
  'semantic-model-v6.json',
  'source-v1.json',
  'syntax-query-v1.json',
  'toml-v1.json',
  'v1.json',
  'xml-1-0-safe-v1.json',
  'yaml-v1.json',
]);

/** The per-suite case counts pinned by conformance/README.md. */
export const SUITE_EXPECTED_COUNTS: Readonly<Record<string, number>> = Object.freeze({
  'cli-v1.json': 40,
  'hcl-v1.json': 57,
  'ini-v1.json': 20,
  'java-properties-v1.json': 22,
  'json-family-v2.json': 33,
  'operations-v1.json': 35,
  'plist-v1.json': 45,
  'portable-graph-v1.json': 10,
  'protocol-v1.json': 32,
  'protocol-v2.json': 11,
  'semantic-model-v5.json': 22,
  'semantic-model-v6.json': 25,
  'source-v1.json': 28,
  'syntax-query-v1.json': 19,
  'toml-v1.json': 18,
  'v1.json': 30,
  'xml-1-0-safe-v1.json': 34,
  'yaml-v1.json': 27,
});

/** The recorded aggregate digest (docs/fc-manifest-0.13.0.json:38). */
export const RECORDED_AGGREGATE_DIGEST = '35bebc8d384d71740f7c1a886bc50f4e095ff52fe05d2a407f04b842ee6922fa';

/** The repository-relative vectors directory (resolved from this file). */
export function vectorsDir(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  // typescript/src/conformance/ -> repository root, then conformance/vectors.
  return `${here}../../../conformance/vectors/`;
}

/** The repository-relative fixtures directory. */
export function fixturesDir(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  return `${here}../../../conformance/fixtures/`;
}

/** The repository root directory. */
export function repoRootDir(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  return `${here}../../../`;
}

// ---------------------------------------------------------------------------
// Vector loading and validation
// ---------------------------------------------------------------------------

export interface VectorFile {
  readonly file: string;
  readonly suite: string;
  readonly semanticModel?: string;
  readonly profiles?: readonly string[];
  readonly cases: readonly VectorCase[];
}

/** Reads and validates one vector file. */
export function loadVectorFile(file: string, dir: string): VectorFile {
  const bytes = readFileSync(`${dir}${file}`);
  const parsed = JSON.parse(new TextDecoder('utf-8').decode(bytes)) as {
    suite?: unknown;
    semantic_model?: unknown;
    profiles?: unknown;
    cases?: unknown;
  };
  if (typeof parsed.suite !== 'string' || !parsed.suite.startsWith('consema.')) {
    throw new Error(`${file}: suite id must be a consema.* namespace`);
  }
  if (!Array.isArray(parsed.cases)) {
    throw new Error(`${file}: cases must be a sequence`);
  }
  const semanticModel = typeof parsed.semantic_model === 'string' ? parsed.semantic_model : undefined;
  const profiles = Array.isArray(parsed.profiles)
    ? parsed.profiles.filter((item): item is string => typeof item === 'string')
    : undefined;
  return {
    file,
    suite: parsed.suite,
    semanticModel,
    profiles,
    cases: parsed.cases.map((case_, index) => {
      const record = case_ as { id?: unknown; capability?: unknown; contract?: unknown; input?: unknown; expected?: unknown };
      if (typeof record.id !== 'string') {
        throw new Error(`${file}: case ${index} lacks an id`);
      }
      if (record.capability !== undefined && typeof record.capability !== 'string') {
        throw new Error(`${file}: case ${record.id} capability must be a string`);
      }
      if (record.contract !== undefined && typeof record.contract !== 'string') {
        throw new Error(`${file}: case ${record.id} contract must be a string`);
      }
      if (typeof record.expected !== 'object' || record.expected === null) {
        throw new Error(`${file}: case ${record.id} expected must be an object`);
      }
      return {
        id: record.id,
        ...(record.capability !== undefined ? { capability: record.capability } : {}),
        ...(record.contract !== undefined ? { contract: record.contract } : {}),
        ...(record.input !== undefined ? { input: record.input } : {}),
        expected: record.expected as Record<string, unknown>,
      };
    }),
  };
}

/** Loads the 18 published vector files. */
export function loadVectors(dir = vectorsDir()): VectorFile[] {
  const onDisk = new Set(readdirSync(dir).filter((name) => name.endsWith('.json')));
  for (const file of SUITE_FILES) {
    if (!onDisk.has(file)) {
      throw new Error(`missing vector file ${file}`);
    }
  }
  return SUITE_FILES.map((file) => loadVectorFile(file, dir));
}

// ---------------------------------------------------------------------------
// Aggregate digest (fc-manifest-0.13.0.json:40)
// ---------------------------------------------------------------------------

export interface DigestResult {
  readonly digest: string;
  readonly suites: number;
  readonly cases: number;
}

/**
 * Computes the documented aggregate: byte-order filename sort, per-file
 * sha256 (lowercase hex), `{name}:{digest}` lines joined with `\n` (no
 * trailing newline), sha256 of that UTF-8 string. The per-file bytes are
 * the raw bytes as read (the canonical checkout is LF, .gitattributes
 * `eol=lf`).
 */
export function computeAggregateDigest(dir = vectorsDir()): DigestResult {
  const builder: string[] = [];
  let cases = 0;
  for (const file of SUITE_FILES) {
    const bytes = readFileSync(`${dir}${file}`);
    const fileCases = (loadVectorFile(file, dir)).cases.length;
    cases += fileCases;
    builder.push(`${file}:${createHash('sha256').update(bytes).digest('hex')}`);
  }
  const aggregate = createHash('sha256').update(builder.join('\n'), 'utf-8').digest('hex');
  return { digest: aggregate, suites: SUITE_FILES.length, cases };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type CaseStatus = 'passed' | 'failed' | 'skipped';

export interface CaseOutcome {
  readonly id: string;
  readonly status: CaseStatus;
  readonly message?: string;
}

export interface SuiteReport {
  readonly file: string;
  readonly suite: string;
  readonly outcomes: readonly CaseOutcome[];
}

export interface RunResult {
  readonly reports: readonly SuiteReport[];
  readonly digest: DigestResult;
  readonly digestOk: boolean;
  readonly totalCases: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
}

/** One suite executor: every case must be recognized or explicitly skipped. */
export interface SuiteExecutor {
  /** Runs one case; throws ConformanceFailure (or any Error) on mismatch. */
  runCase(case_: VectorCase): void;
}

const executors: Record<string, SuiteExecutor> = {
  'v1.json': runV1,
  'toml-v1.json': runTomlV1,
  'protocol-v1.json': runProtocolV1,
  'source-v1.json': runSourceV1,
  'syntax-query-v1.json': runSyntaxQueryV1,
  'protocol-v2.json': runProtocolV2,
  'operations-v1.json': runOperationsV1,
  'json-family-v2.json': runJsonFamilyV2,
  'portable-graph-v1.json': runPortableGraphV1,
  'semantic-model-v5.json': runSemanticModelV5,
  'yaml-v1.json': runYamlV1,
  'semantic-model-v6.json': runSemanticModelV6,
  'ini-v1.json': runIniV1,
  'java-properties-v1.json': runPropertiesV1,
  'xml-1-0-safe-v1.json': runXmlV1,
  'plist-v1.json': runPlistV1,
  'hcl-v1.json': runHclV1,
  'cli-v1.json': runCliV1,
};

/**
 * Runs one vector file through its suite executor. Every case is dispatched
 * to the suite handler; a case the suite does not recognize fails loudly
 * (unknown action rejection, conformance/README.md:73).
 */
export function runSuiteFile(file: VectorFile): SuiteReport {
  const expected = SUITE_EXPECTED_COUNTS[file.file];
  if (expected !== undefined && file.cases.length !== expected) {
    throw new Error(
      `${file.file}: case count ${file.cases.length} != published ${expected} (a silent skip would corrupt the inventory)`,
    );
  }
  const executor = executors[file.file];
  if (executor === undefined) {
    throw new Error(`${file.file}: no TS suite executor registered`);
  }
  const seen = new Set<string>();
  const outcomes: CaseOutcome[] = [];
  for (const case_ of file.cases) {
    if (seen.has(case_.id)) {
      outcomes.push({ id: case_.id, status: 'failed', message: 'duplicate case id' });
      continue;
    }
    seen.add(case_.id);
    try {
      executor.runCase(case_);
      outcomes.push({ id: case_.id, status: 'passed' });
    } catch (error) {
      if (error instanceof SkippedCase) {
        outcomes.push({ id: case_.id, status: 'skipped', message: error.message });
      } else if (error instanceof ConformanceFailure) {
        outcomes.push({ id: case_.id, status: 'failed', message: error.message });
      } else {
        outcomes.push({
          id: case_.id,
          status: 'failed',
          message: error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error),
        });
      }
    }
  }
  return { file: file.file, suite: file.suite, outcomes };
}

export { SkippedCase };

/** Runs all 18 suites and the digest/count assertions. */
export function runAll(dir = vectorsDir()): RunResult {
  const files = loadVectors(dir);
  const digest = computeAggregateDigest(dir);
  const reports = files.map((file) => runSuiteFile(file));
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const report of reports) {
    for (const outcome of report.outcomes) {
      switch (outcome.status) {
        case 'passed':
          passed += 1;
          break;
        case 'failed':
          failed += 1;
          break;
        case 'skipped':
          skipped += 1;
          break;
      }
    }
  }
  return {
    reports,
    digest,
    digestOk: digest.digest === RECORDED_AGGREGATE_DIGEST && digest.suites === 18 && digest.cases === 508,
    totalCases: digest.cases,
    passed,
    failed,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

/** Prints the per-suite report and returns the process exit code (0 ok, 2 data failure). */
export function main(argv: readonly string[]): number {
  const dir = argv.length > 2 ? argv[2] : vectorsDir();
  let result: RunResult;
  try {
    result = runAll(dir);
  } catch (error) {
    console.error(`consema conformance: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  for (const report of result.reports) {
    const passed = report.outcomes.filter((outcome) => outcome.status === 'passed').length;
    const failed = report.outcomes.filter((outcome) => outcome.status === 'failed').length;
    const skipped = report.outcomes.filter((outcome) => outcome.status === 'skipped').length;
    console.log(`${report.file}: ${passed} passed, ${skipped} skipped, ${failed} failed`);
    for (const outcome of report.outcomes) {
      if (outcome.status !== 'passed') {
        console.log(`  ${outcome.status} ${outcome.id}${outcome.message !== undefined ? `: ${outcome.message}` : ''}`);
      }
    }
  }
  console.log(
    `aggregate digest: ${result.digest.digest} ${result.digestOk ? 'match' : `MISMATCH (recorded ${RECORDED_AGGREGATE_DIGEST})`}`,
  );
  console.log(`suites: ${result.digest.suites}, cases: ${result.totalCases}`);
  console.log(`total: ${result.passed} passed, ${result.skipped} skipped, ${result.failed} failed`);
  if (!result.digestOk || result.failed > 0 || result.digest.cases !== 508) {
    return 2;
  }
  return 0;
}

/** Direct CLI execution (node src/conformance/runner.ts). */
if (import.meta.url === `file:///${process.argv[1]?.replaceAll('\\', '/')}`) {
  process.exitCode = main(process.argv);
}
