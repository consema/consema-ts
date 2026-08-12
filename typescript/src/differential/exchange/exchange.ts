/**
 * Cross-language protocol exchange harness — TypeScript side (design:
 * docs/five-language-ci-design.md §3.4; Go precedent:
 * go/conformance/differential/protocol-exchange/exchange_test.go; the Rust
 * example crates/consema-conformance/examples/emit_protocol_exchange.rs is
 * the byte authority for the golden files).
 *
 * For every case (83: 40 accept + 43 reject):
 *   - accept cases: both sides decode the canonical transport JSON with the
 *     full typed record decoder, re-encode byte-identically on both
 *     transports (canonical JSON and PVCE/1), and the cross-language bytes
 *     are byte-equal; each side decodes the other side's bytes, the typed
 *     record is equivalent (value-tree equality through the typed record
 *     codec), and re-encoding is byte-identical;
 *   - reject cases: both sides reject the same transport bytes with the
 *     same registered error code (core.protocol.*@1). Error text never
 *     participates in any comparison.
 *
 * The TS side emits its own encoder bytes into CONSEMA_EXCHANGE_TS_DIR
 * (`<case-id>.json.hex` / `<case-id>.pvce.hex` / `<case-id>.error.txt`),
 * which the Rust example's --verify mode closes over (TS encode ->
 * Rust decode direction).
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PortableValue } from '../../core/value.ts';
import { DecodeJSON, EncodeJSON } from '../../protocol/canonical.ts';
import { defaultProtocolLimits } from '../../protocol/limits.ts';
import type { ProtocolLimits } from '../../protocol/limits.ts';
import { encode as encodePVCE, decode as decodePVCE, defaultEncodeLimits } from '../../core/pvce.ts';
import { equal as coreEqual } from '../../core/equal.ts';
import { ProtocolError } from '../../protocol/errors.ts';
import { ErrorCodeRegistry, validateErrorCodeManifestValue } from '../../protocol/error_registry.ts';
import {
  cliOutputFromValue, cliOutputToValue, batchPlanFromValue, batchPlanToValue,
  batchResultFromValue, batchResultToValue,
} from '../../protocol/cli.ts';
import { Completion, CancellationRequest, ExecutionPolicy } from '../../protocol/records_execution.ts';
import {
  capabilityDeclarationFromValue, capabilityDeclarationToValue, profileDescriptorFromValue,
  profileDescriptorToValue, registryManifestFromValue, registryManifestToValue,
} from '../../protocol/registry_descriptor.ts';
import { ChangeSetMessage } from '../../protocol/records_change_set.ts';
import { diagnosticFromValue, diagnosticToValue } from '../../protocol/diagnostic.ts';
import {
  PortableGraphMessage, GraphProjectionResultMessage, GraphProvenanceMapMessage,
  GraphQueryResultMessage, IniQueryResultMessage, JavaPropertiesQueryResultMessage,
  YamlQueryResultMessage,
} from '../../protocol/records_graph.ts';
import { JavaUtf16String } from '../../protocol/records_java_utf16.ts';
import { MaterializationRequestMessageV2, MaterializationResultMessageV2 } from '../../protocol/records_materialization.ts';
import {
  ProjectionReportMessage, ProjectionRequestMessage, ProjectionResultMessage,
  ProvenanceMapMessage,
} from '../../protocol/records_projection.ts';
import { QueryResultMessage, queryDefinitionFromValue, queryDefinitionToValue } from '../../protocol/records_query.ts';
import { SourceEncodingMessage, SourcePatchMessageV2, SourceSnapshotMessageV2 } from '../../protocol/records_source.ts';
import { defaultPgceLimits } from '../../graph/pgce.ts';
import { DEFAULT_SOURCE_LIMITS } from '../../document/source.ts';
import { DEFAULT_SOURCE_PATCH_LIMITS } from '../../document/source_patch.ts';

/** The frozen manifest id of the differential input set. */
export const CASE_FILE_MANIFEST = 'consema.differential.protocol-exchange@1';

/** The task's lower bound for the input set ("至少 40 个 case"). */
export const MIN_CASE_COUNT = 40;

/** The closed record inventory of the exchange set. */
export const ALL_RECORDS: readonly string[] = Object.freeze([
  'core.batch-plan@1',
  'core.batch-result@1',
  'core.cancellation-request@1',
  'core.capability-declaration@1',
  'core.change-set@1',
  'core.cli-output@1',
  'core.completion@1',
  'core.diagnostic@1',
  'core.error-code-registry@1',
  'core.execution-policy@1',
  'core.graph-projection-result@1',
  'core.graph-provenance-map@1',
  'core.graph-query-result@1',
  'core.ini-query-result@1',
  'core.java-properties-query-result@1',
  'core.java-utf16-string@1',
  'core.materialization-request@2',
  'core.materialization-result@2',
  'core.portable-graph@1',
  'core.portable-value-json@1',
  'core.profile-descriptor@1',
  'core.projection-report@1',
  'core.projection-request@1',
  'core.projection-result@1',
  'core.provenance-map@1',
  'core.query-definition@1',
  'core.query-result@1',
  'core.registry-manifest@1',
  'core.source-encoding@1',
  'core.source-patch@2',
  'core.source-snapshot@2',
  'core.yaml-query-result@1',
]);

export interface ExchangeCase {
  readonly id: string;
  readonly record: string;
  readonly json: string;
  readonly expectedErrorCode: string;
}

/** The repository root directory (resolved from this file). */
export function repoRootDir(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  return `${here}../../../../`;
}

/** The checked-in differential case file. */
export function defaultCasesFile(): string {
  return `${repoRootDir()}conformance/differential/protocol-exchange/cases.json`;
}

/** Loads and validates the checked-in case set (manifest, count, ids, coverage). */
export function loadCaseFile(file: string): ExchangeCase[] {
  const parsed = JSON.parse(new TextDecoder('utf-8').decode(readFileSync(file))) as {
    manifest?: unknown;
    cases?: unknown;
  };
  if (parsed.manifest !== CASE_FILE_MANIFEST) {
    throw new Error(`cases.json manifest = ${JSON.stringify(parsed.manifest)}, want ${CASE_FILE_MANIFEST}`);
  }
  if (!Array.isArray(parsed.cases)) {
    throw new Error('cases.json: cases must be a sequence');
  }
  if (parsed.cases.length < MIN_CASE_COUNT) {
    throw new Error(`cases.json has ${parsed.cases.length} cases, want >= ${MIN_CASE_COUNT}`);
  }
  const known = new Set(ALL_RECORDS);
  const coverage = new Map<string, [number, number]>(); // record -> {accept, reject}
  const seen = new Set<string>();
  const cases: ExchangeCase[] = [];
  const limits = defaultProtocolLimits();
  for (const raw of parsed.cases) {
    const c = raw as {
      id?: unknown; record?: unknown; json?: unknown; expected?: { error_code?: unknown };
    };
    if (typeof c.id !== 'string' || c.id === '') {
      throw new Error('case with an empty id');
    }
    if (seen.has(c.id)) {
      throw new Error(`duplicate case id ${JSON.stringify(c.id)}`);
    }
    seen.add(c.id);
    if (typeof c.record !== 'string' || !known.has(c.record)) {
      throw new Error(`case ${c.id}: record ${JSON.stringify(c.record)} is not in the exchange inventory`);
    }
    if (typeof c.json !== 'string') {
      throw new Error(`case ${c.id}: missing json`);
    }
    const expectedErrorCode = typeof c.expected?.error_code === 'string' ? c.expected.error_code : '';
    if (expectedErrorCode !== '' && !new ErrorCodeRegistry(7).contains(expectedErrorCode)) {
      throw new Error(`case ${c.id}: expected code ${JSON.stringify(expectedErrorCode)} is not a registered protocol code`);
    }
    const case_: ExchangeCase = { id: c.id, record: c.record, json: c.json, expectedErrorCode };
    if (expectedErrorCode !== '') {
      coverage.set(c.record, [coverage.get(c.record)?.[0] ?? 0, (coverage.get(c.record)?.[1] ?? 0) + 1]);
      cases.push(case_);
      continue;
    }
    coverage.set(c.record, [(coverage.get(c.record)?.[0] ?? 0) + 1, coverage.get(c.record)?.[1] ?? 0]);
    cases.push(case_);
  }
  for (const record of ALL_RECORDS) {
    const counts = coverage.get(record) ?? [0, 0];
    if (counts[0] === 0 || counts[1] === 0) {
      throw new Error(`record ${record} has no ${counts[0] === 0 ? 'accept' : 'reject'} case in the exchange set`);
    }
  }
  return cases;
}

/**
 * The TS-side canonicality check of one accept case: the transport JSON
 * decodes, the typed record decodes, and the re-encode is byte-identical
 * on both transports. Returns the failure text, or null when the case
 * verifies (the Go loadCaseFile strict check, kept per-case so every
 * divergence is reported precisely rather than aborting the run).
 */
export function verifyAcceptCanonical(c: ExchangeCase, limits: ProtocolLimits): string | null {
  try {
    const value = DecodeJSON(new TextEncoder().encode(c.json), limits);
    const recordValue = decodeRecord(c.record, value, limits);
    const reEncoded = EncodeJSON(recordValue, limits);
    if (!bytesEqual(reEncoded, new TextEncoder().encode(c.json))) {
      return `case ${c.id}: TS typed re-encode is not byte-identical to the case json`;
    }
    encodePVCE(recordValue);
    return null;
  } catch (error) {
    return `case ${c.id}: TS typed record decode failed: ${String(error)}`;
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

/**
 * Dispatches one record schema to its full typed record decoder and returns
 * the record's re-encodeable value tree (the Go decodeRecord / the Rust
 * decode_record mirror).
 */
export function decodeRecord(record: string, value: PortableValue, limits: ProtocolLimits): PortableValue {
  switch (record) {
    case 'core.cli-output@1':
      return cliOutputToValue(cliOutputFromValue(value, new ErrorCodeRegistry(7)));
    case 'core.batch-plan@1':
      return batchPlanToValue(batchPlanFromValue(value, new ErrorCodeRegistry(7)));
    case 'core.batch-result@1':
      return batchResultToValue(batchResultFromValue(value));
    case 'core.cancellation-request@1':
      return CancellationRequest.fromValue(value).toValue();
    case 'core.capability-declaration@1':
      return capabilityDeclarationToValue(capabilityDeclarationFromValue(value));
    case 'core.change-set@1':
      return ChangeSetMessage.fromValueWithRegistry(value, new ErrorCodeRegistry(7)).toValue();
    case 'core.completion@1':
      return Completion.fromValue(value).toValue();
    case 'core.diagnostic@1':
      return diagnosticToValue(diagnosticFromValue(value, new ErrorCodeRegistry(7)));
    case 'core.error-code-registry@1':
      validateErrorCodeManifestValue(value);
      return value;
    case 'core.execution-policy@1':
      return ExecutionPolicy.fromValue(value).toValue();
    case 'core.graph-projection-result@1':
      return GraphProjectionResultMessage.fromValue(value, defaultPgceLimits(), new ErrorCodeRegistry(7)).toValue();
    case 'core.graph-provenance-map@1':
      return GraphProvenanceMapMessage.fromValue(value).toValue();
    case 'core.graph-query-result@1':
      return GraphQueryResultMessage.fromValue(value, defaultPgceLimits(), new ErrorCodeRegistry(7)).toValue();
    case 'core.ini-query-result@1':
      return IniQueryResultMessage.fromValue(value, new ErrorCodeRegistry(7)).toValue();
    case 'core.java-properties-query-result@1':
      return JavaPropertiesQueryResultMessage.fromValue(value, new ErrorCodeRegistry(7)).toValue();
    case 'core.java-utf16-string@1':
      return JavaUtf16String.fromValue(value, limits).toValue();
    case 'core.materialization-request@2':
      return MaterializationRequestMessageV2.fromValue(value).toValue();
    case 'core.materialization-result@2':
      // The Go default registry for this record is v6; mirror it.
      return MaterializationResultMessageV2.fromValueWithRegistry(value, new ErrorCodeRegistry(6)).toValue();
    case 'core.portable-graph@1':
      return PortableGraphMessage.fromValue(value, defaultPgceLimits()).toValue();
    case 'core.portable-value-json@1':
      return value;
    case 'core.profile-descriptor@1':
      return profileDescriptorToValue(profileDescriptorFromValue(value));
    case 'core.projection-report@1':
      return ProjectionReportMessage.fromValue(value).toValue();
    case 'core.projection-request@1':
      return ProjectionRequestMessage.fromValue(value).toValue();
    case 'core.projection-result@1':
      return ProjectionResultMessage.fromValue(value).toValue();
    case 'core.provenance-map@1':
      return ProvenanceMapMessage.fromValue(value).toValue();
    case 'core.query-definition@1':
      return queryDefinitionToValue(queryDefinitionFromValue(value));
    case 'core.query-result@1':
      return QueryResultMessage.fromValueWithRegistry(value, new ErrorCodeRegistry(7)).toValue();
    case 'core.registry-manifest@1':
      return registryManifestToValue(registryManifestFromValue(value));
    case 'core.source-encoding@1':
      return SourceEncodingMessage.fromValue(value).toValue();
    case 'core.source-patch@2':
      return SourcePatchMessageV2.fromValue(value, DEFAULT_SOURCE_PATCH_LIMITS).toValue();
    case 'core.source-snapshot@2':
      return SourceSnapshotMessageV2.fromValue(value, DEFAULT_SOURCE_LIMITS).toValue();
    case 'core.yaml-query-result@1':
      return YamlQueryResultMessage.fromValue(value, new ErrorCodeRegistry(7)).toValue();
    default:
      throw new ProtocolError('UnknownContract', '$.contract', `record ${record} is not in the exchange inventory`);
  }
}

/** The registered rejection code of one reject case (transport then typed record decoder). */
export function tsRejectionCode(c: ExchangeCase, limits: ProtocolLimits): string {
  try {
    const value = DecodeJSON(new TextEncoder().encode(c.json), limits);
    decodeRecord(c.record, value, limits);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : '';
  }
  return '';
}

/** Reads one hex byte file. */
function readHexFile(dir: string, name: string): Uint8Array {
  const text = readFileSync(`${dir}/${name}.hex`, 'utf-8');
  const decoded = /^[0-9a-f]*$/.exec(text.trim());
  if (decoded === null || decoded[0].length % 2 !== 0) {
    throw new Error(`file ${name}.hex is not valid hex`);
  }
  const bytes = new Uint8Array(decoded[0].length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(decoded[0].slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Reads one recorded rejection code file. */
function readErrorFile(dir: string, id: string): string {
  return readFileSync(`${dir}/${id}.error.txt`, 'utf-8').trim();
}

function firstDiff(id: string, direction: string, left: Uint8Array, right: Uint8Array): string {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index++;
  }
  return (
    `case ${id} (${direction}): TS ${left.length} bytes, Rust ${right.length} bytes, ` +
    `first difference at offset ${index}\n  TS:   ${hex(left)}\n  Rust: ${hex(right)}`
  );
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const octet of bytes) {
    out += octet.toString(16).padStart(2, '0');
  }
  return out;
}

export interface ExchangeResult {
  readonly acceptPassed: number;
  readonly acceptCount: number;
  readonly rejectPassed: number;
  readonly rejectCount: number;
  readonly failures: readonly string[];
}

/** Verifies one accept case end to end. */
function verifyAcceptCase(
  c: ExchangeCase,
  rustDir: string,
  tsDir: string | null,
  limits: ProtocolLimits,
): string[] {
  const failures: string[] = [];
  let value: PortableValue;
  try {
    value = DecodeJSON(new TextEncoder().encode(c.json), limits);
  } catch (error) {
    return [`case ${c.id}: case json no longer decodes: ${String(error)}`];
  }
  let recordValue: PortableValue;
  try {
    recordValue = decodeRecord(c.record, value, limits);
  } catch (error) {
    return [`case ${c.id}: TS typed record decode failed: ${String(error)}`];
  }
  let tsJSON: Uint8Array;
  let tsPVCE: Uint8Array;
  try {
    tsJSON = EncodeJSON(recordValue, limits);
    tsPVCE = encodePVCE(recordValue);
  } catch (error) {
    return [`case ${c.id}: TS encode failed: ${String(error)}`];
  }
  if (tsDir !== null) {
    writeHex(tsDir, `${c.id}.json`, tsJSON);
    writeHex(tsDir, `${c.id}.pvce`, tsPVCE);
  }

  // Rust encoder bytes must be byte-equal on both transports.
  let rustJSON: Uint8Array;
  let rustPVCE: Uint8Array;
  try {
    rustJSON = readHexFile(rustDir, `${c.id}.json`);
    rustPVCE = readHexFile(rustDir, `${c.id}.pvce`);
  } catch (error) {
    return [`case ${c.id}: missing Rust byte files: ${String(error)}`];
  }
  if (!bytesEqual(tsJSON, rustJSON)) {
    failures.push(firstDiff(c.id, 'json', tsJSON, rustJSON));
  }
  if (!bytesEqual(tsPVCE, rustPVCE)) {
    failures.push(firstDiff(c.id, 'pvce', tsPVCE, rustPVCE));
  }

  // Rust encode -> TS decode over the JSON transport.
  try {
    const rustValue = DecodeJSON(rustJSON, limits);
    const rustRecord = decodeRecord(c.record, rustValue, limits);
    if (!coreEqual(rustRecord, recordValue)) {
      failures.push(`case ${c.id}: TS typed decode of the Rust JSON is not equivalent to the case record`);
    } else {
      const reEncoded = EncodeJSON(rustRecord, limits);
      if (!bytesEqual(reEncoded, rustJSON)) {
        failures.push(`case ${c.id}: TS JSON re-encode of the Rust bytes is not byte-identical`);
      }
    }
  } catch (error) {
    failures.push(`case ${c.id}: TS cannot decode the Rust JSON bytes: ${String(error)}`);
  }

  // Rust encode -> TS decode over the PVCE transport.
  try {
    const rustValue = decodePVCE(rustPVCE, limits);
    const rustRecord = decodeRecord(c.record, rustValue, limits);
    if (!coreEqual(rustRecord, recordValue)) {
      failures.push(`case ${c.id}: TS typed decode of the Rust PVCE is not equivalent to the case record`);
    } else {
      const reEncoded = encodePVCE(rustRecord);
      if (!bytesEqual(reEncoded, rustPVCE)) {
        failures.push(`case ${c.id}: TS PVCE re-encode of the Rust bytes is not byte-identical`);
      }
    }
  } catch (error) {
    failures.push(`case ${c.id}: TS cannot decode the Rust PVCE bytes: ${String(error)}`);
  }
  return failures;
}

/** Verifies one reject case cross-language. */
function verifyRejectCase(c: ExchangeCase, rustDir: string, tsDir: string | null, limits: ProtocolLimits): string[] {
  const code = tsRejectionCode(c, limits);
  if (code !== c.expectedErrorCode) {
    return [`case ${c.id}: TS rejection code ${JSON.stringify(code)} != expected ${JSON.stringify(c.expectedErrorCode)}`];
  }
  if (tsDir !== null) {
    writeFileSync(`${tsDir}/${c.id}.error.txt`, `${code}\n`, 'utf-8');
  }
  let rustCode: string;
  try {
    rustCode = readErrorFile(rustDir, c.id);
  } catch (error) {
    return [`case ${c.id}: missing Rust rejection file: ${String(error)}`];
  }
  if (rustCode !== c.expectedErrorCode) {
    return [`case ${c.id}: rejection codes diverge: TS ${c.expectedErrorCode}, Rust ${rustCode} (want ${c.expectedErrorCode})`];
  }
  return [];
}

/**
 * Runs the bidirectional exchange: TS bytes vs the Rust golden bytes,
 * Rust bytes -> TS typed decode -> re-encode byte-identically, rejection
 * codes compared, and the TS-side encoder files emitted into tsDir (null
 * skips the emission).
 */
export function runExchange(
  casesFile: string,
  rustDir: string,
  tsDir: string | null,
): ExchangeResult {
  const cases = loadCaseFile(casesFile);
  const knownIDs = new Set(cases.map((c) => c.id));
  for (const entry of readdirSync(rustDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      continue;
    }
    let base = entry.name;
    base = base.endsWith('.json.hex') ? base.slice(0, -'.json.hex'.length) : base;
    base = base.endsWith('.pvce.hex') ? base.slice(0, -'.pvce.hex'.length) : base;
    base = base.endsWith('.error.txt') ? base.slice(0, -'.error.txt'.length) : base;
    if (base !== entry.name && !knownIDs.has(base)) {
      throw new Error(`rust file ${JSON.stringify(entry.name)} does not correspond to any case (case file drift?)`);
    }
  }
  if (tsDir !== null) {
    mkdirSync(tsDir, { recursive: true });
  }
  const limits = defaultProtocolLimits();
  const failures: string[] = [];
  let acceptPassed = 0;
  let acceptCount = 0;
  let rejectPassed = 0;
  let rejectCount = 0;
  for (const c of cases) {
    if (c.expectedErrorCode !== '') {
      rejectCount++;
      const before = failures.length;
      failures.push(...verifyRejectCase(c, rustDir, tsDir, limits));
      if (failures.length === before) {
        rejectPassed++;
      }
      continue;
    }
    acceptCount++;
    const canonical = verifyAcceptCanonical(c, limits);
    if (canonical !== null) {
      failures.push(canonical);
      continue;
    }
    const before = failures.length;
    failures.push(...verifyAcceptCase(c, rustDir, tsDir, limits));
    if (failures.length === before) {
      acceptPassed++;
    }
  }
  return { acceptPassed, acceptCount, rejectPassed, rejectCount, failures };
}

/** The TS-side encoder output directory environment variable. */
export const TS_DIR_ENV = 'CONSEMA_EXCHANGE_TS_DIR';

function writeHex(dir: string, name: string, bytes: Uint8Array): void {
  writeFileSync(`${dir}/${name}.hex`, `${hex(bytes)}\n`, 'utf-8');
}
