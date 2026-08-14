/**
 * The TS conformance runner framework (mirror of consema-rs/consema-conformance
 * src/lib.rs + the Go runner's digest verification; authority:
 * https://github.com/consema/consema/blob/main/docs/five-language-ci-design.md §2 — each runner is the sole executor of
 * the shared vectors; conformance/README.md — case structure, per-suite
 * counts; https://github.com/consema/consema/blob/main/docs/fc-manifest-0.13.0.json — 键 aggregate_sha256
 * （聚合 digest 值）/ note（聚合算法；行号可能漂移，以键名为锚）).
 *
 * The runner reads conformance/vectors/*.json (18 files / 519 cases) by
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
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exitCode } from '../protocol/exit_class.ts';
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
  'java-properties-v1.json': 25,
  'json-family-v2.json': 33,
  'operations-v1.json': 35,
  'plist-v1.json': 49,
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
  'yaml-v1.json': 31,
});

/** The recorded aggregate digest (https://github.com/consema/consema/blob/main/docs/fc-manifest-0.13.0.json — 键 aggregate_sha256). */
export const RECORDED_AGGREGATE_DIGEST = 'cfd6e296da5b22b62d37b076d35bf6bbf58b0678ceddb37eea51a8b47200ab6a';

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
  // W3-43: join (not `${dir}${file}`) — dir is a public parameter and may
  // arrive without a trailing separator; the concatenation silently
  // misresolved such inputs.
  const bytes = readFileSync(join(dir, file));
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
// Aggregate digest (fc-manifest-0.13.0.json — 键 aggregate_sha256 / note)
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
  // G38 (2026-08-14): the digest must cover the whole on-disk inventory —
  // iterating only the frozen SUITE_FILES list would leave a 19th vector
  // file invisible (digest/suites/cases unchanged, gate still green). The
  // disk glob must contain exactly the 18 published suite files (the same
  // assertion the go/kt/py runners enforce).
  const onDisk = readdirSync(dir).filter((name) => name.endsWith('.json'));
  if (onDisk.length !== SUITE_FILES.length) {
    throw new Error(
      `vectors directory must contain exactly ${SUITE_FILES.length} published suite files, found ${onDisk.length} (a new or missing vector file must not silently desync the digest)`,
    );
  }
  const builder: string[] = [];
  let cases = 0;
  for (const file of SUITE_FILES) {
    const bytes = readFileSync(join(dir, file));
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
 * (unknown action rejection — conformance/README.md「未知 action 拒绝」规则，行号可能漂移，以规则语义为锚).
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
    digestOk: digest.digest === RECORDED_AGGREGATE_DIGEST && digest.suites === 18 && digest.cases === 519,
    totalCases: digest.cases,
    passed,
    failed,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

/**
 * Prints the per-suite report and returns the process exit code (RFC 0015
 * §5.1 six exit classes; W3-43 — classification paths as implemented):
 * success 0 / usage 1 / data 2 / limit 3 / precondition 4 / internal 5.
 * The conformance CLI reaches:
 *  - usage (1): unexpected positional arguments (argv.length > 3);
 *  - data (2): input-read failures as classified by isInputReadFailure
 *    (ENOENT from the vectors directory or any read, or an error whose
 *    message contains "missing vector file" — not every inventory
 *    problem), and digest/case-count mismatches or failed cases after a
 *    run;
 *  - limit (3): typed resource-limit failures during runAll, as
 *    classified by isLimitFailure (per-case limit failures are reported
 *    as failed cases and end in data, not limit);
 *  - internal (5): everything else, including vector structure-validation
 *    errors (a non-consema.* suite id, a case without an id, ...).
 * precondition (4) is part of the RFC 0015 §5.1 vocabulary but this CLI
 * never returns it.
 */
export function main(argv: readonly string[]): number {
  if (argv.length > 3) {
    console.error('consema conformance: usage: consema-conformance [vectors-dir]');
    return exitCode('usage');
  }
  const dir = argv.length > 2 ? argv[2] : vectorsDir();
  let result: RunResult;
  try {
    result = runAll(dir);
  } catch (error) {
    if (isLimitFailure(error)) {
      console.error(`consema conformance: resource limit: ${error instanceof Error ? error.message : String(error)}`);
      return exitCode('limit');
    }
    if (isInputReadFailure(error)) {
      console.error(`consema conformance: data: ${error instanceof Error ? error.message : String(error)}`);
      return exitCode('data');
    }
    console.error(`consema conformance: internal: ${error instanceof Error ? error.message : String(error)}`);
    return exitCode('internal');
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
  // G67 (2026-08-14): the frozen inventory is 519 cases at L5 — every case
  // must execute and pass; a skipped case (passed < 519) is not success.
  // passed === 519 with cases === 519 implies skipped === 0 and failed === 0.
  if (!result.digestOk || result.failed > 0 || result.digest.cases !== 519 || result.passed !== 519) {
    return exitCode('data');
  }
  return exitCode('success');
}

/** RFC 0015 §5.2: any typed resource-limit failure is the limit exit class. */
function isLimitFailure(error: unknown): boolean {
  const kind = (error as { kind?: unknown } | null)?.kind;
  return kind === 'ResourceLimit' || kind === 'ResourceLimitExceeded';
}

/** RFC 0015 §5.2: input-file read failures are the data exit class. */
function isInputReadFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    ((error as { code?: unknown }).code === 'ENOENT' || error.message.includes('missing vector file'))
  );
}

/**
 * Direct CLI execution (node src/conformance/runner.ts).
 *
 * Detects the entry point by realpath-normalizing both sides and comparing:
 * Node ESM resolves the entry module to its real path on disk (symlinks and
 * junctions are followed), while process.argv[1] is the literal path given
 * on the command line — a literal-vs-realpath comparison silently skips CLI
 * mode for symlinked/junctioned repo paths (G37, 2026-08-14). realpath also
 * handles the URL normalization the previous form did (spaces/%/#/non-ASCII,
 * backslash conversion, relative-path resolution). File URLs are
 * case-insensitive on Windows and on the default macOS filesystem
 * (case-insensitive APFS), so the comparison folds case on every platform —
 * otherwise a case-mismatched path on macOS would silently skip CLI mode.
 */
if (process.argv[1] !== undefined) {
  const entry = realpathSync(fileURLToPath(import.meta.url));
  let invoked: string;
  try {
    invoked = realpathSync(process.argv[1]);
  } catch {
    invoked = fileURLToPath(pathToFileURL(process.argv[1]));
  }
  const foldCase = (path: string): string =>
    process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path;
  if (foldCase(entry) === foldCase(invoked)) {
    process.exitCode = main(process.argv);
  }
}
