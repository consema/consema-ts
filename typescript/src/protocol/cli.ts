/**
 * The CLI machine-protocol payloads of RFC 0015.
 *
 * authority: RFC 0015 §4 (core.cli-output@1), §8 (core.batch-plan@1), §9
 * (core.batch-result@1); the Rust record codecs (crates/consema-protocol/
 * src/cli.rs); the golden envelope bytes of RFC 0015 §4.4. The full
 * presence/cross-constraint validation is implemented here: per-status field
 * presence, `source_digest == source_patch.base_digest`, command/payload
 * schema consistency, diagnostic registry binding, the semantic-version
 * shape, and the redaction invariant `redacted == (count > 0)`.
 *
 * Design (TypeScript-idiomatic): plain readonly records built by validating
 * factory functions; failures throw the typed ProtocolError carrying the
 * frozen code. The source-patch@2 record nested in a planned plan entry is
 * carried at the wire level (the document milestone owns the applied patch
 * type).
 */

import { createHash } from 'node:crypto';
import type { PortableValue, ObjectValue } from '../core/value.ts';
import { ProtocolError, protocolError, invalid } from './errors.ts';
import {
  exactFields,
  schemaFields,
  stringOf,
  unsigned32,
  unsigned64,
  sequenceOf,
  booleanOf,
  bytesOf,
  referenceValue,
  parseReference,
  objectValueFrom,
  wireInteger,
} from './records.ts';
import { stringMapObject, stringMapFromObject } from './string_map.ts';
import { wireNull, wireBoolean } from './canonical.ts';
import { ErrorCodeRegistry } from './error_registry.ts';
import {
  diagnosticToValue,
  diagnosticFromValue,
  validateDiagnosticCode,
} from './diagnostic.ts';
import type { Diagnostic } from './diagnostic.ts';
import { parseExitClass } from './exit_class.ts';
import type { ExitClass } from './exit_class.ts';

// ---------------------------------------------------------------------------
// Commands and the envelope
// ---------------------------------------------------------------------------

/** One of the eleven formal CLI commands (RFC 0015 §6.1). */
export type CliCommand =
  | 'inspect'
  | 'capabilities'
  | 'query'
  | 'project'
  | 'materialize'
  | 'convert'
  | 'edit'
  | 'plan'
  | 'apply'
  | 'conformance'
  | 'explain';

const COMMANDS: readonly CliCommand[] = [
  'inspect',
  'capabilities',
  'query',
  'project',
  'materialize',
  'convert',
  'edit',
  'plan',
  'apply',
  'conformance',
  'explain',
];

/** Parses one canonical command name into the closed command set. */
export function parseCliCommand(name: string): CliCommand | undefined {
  return (COMMANDS as readonly string[]).includes(name) ? (name as CliCommand) : undefined;
}

/** The payload schemas the command may carry (RFC 0015 §6.1 table; cli.rs:92-115). */
export function payloadSchemas(command: CliCommand): readonly string[] {
  switch (command) {
    case 'inspect':
      return ['cli.inspect@1'];
    case 'capabilities':
      return ['cli.capabilities@1'];
    case 'query':
      return [
        'core.query-result@1',
        'core.ini-query-result@1',
        'core.java-properties-query-result@1',
        'core.yaml-query-result@1',
        'core.graph-query-result@1',
      ];
    case 'project':
      return ['core.projection-result@1'];
    case 'materialize':
      return ['core.materialization-result@2'];
    case 'convert':
      return ['cli.convert@1'];
    case 'edit':
      return ['cli.edit@1'];
    case 'plan':
      return ['core.batch-plan@1'];
    case 'apply':
      return ['core.batch-result@1'];
    case 'conformance':
      return ['cli.conformance@1'];
    case 'explain':
      return ['cli.explain@1'];
  }
}

/** The envelope redaction facts (RFC 0015 §11.3; cli.rs:117-147). */
export interface Redaction {
  readonly redacted: boolean;
  readonly count: bigint;
}

/** Validates the `redacted == (count > 0)` invariant. */
export function newRedaction(redacted: boolean, count: bigint): Redaction {
  if (redacted !== (count > 0n)) {
    throw invalid('$.redaction', 'redacted must equal (count > 0)');
  }
  return { redacted, count };
}

/** The stable SHA-256 identity of exact raw source bytes (RFC 0015 §4.1). */
export interface ContentDigest {
  /** The exact 32 digest bytes. */
  readonly bytes: Uint8Array;
}

/**
 * Computes the digest of exact raw bytes. node:crypto is a Node platform
 * builtin (the standard-library analog of Go's crypto/sha256), not a
 * third-party dependency.
 */
export function digestOf(data: Uint8Array): ContentDigest {
  return { bytes: createHash('sha256').update(data).digest() };
}

/** The digest algorithm identifier frozen by the v1 source contract. */
export function digestAlgorithm(): string {
  return 'sha256';
}

/** The lowercase hexadecimal representation of the digest. */
export function digestHex(digest: ContentDigest): string {
  let out = '';
  for (const octet of digest.bytes) {
    out += octet.toString(16).padStart(2, '0');
  }
  return out;
}

/** A stable format-operation contract identity. */
export interface FormatOperationId {
  readonly id: string;
  readonly version: number;
}

export function newFormatOperationId(id: string, version: number): FormatOperationId {
  return { id, version };
}

/** One safe, content-free summary of a declared edit operation. */
export interface EditOperationSummary {
  readonly operation: FormatOperationId;
  /** Sorted deterministic summary map. */
  readonly summary: ReadonlyMap<string, string>;
}

/** Validates a bounded summary (cli.rs:166-215). */
export function newEditOperationSummary(
  operation: FormatOperationId,
  summary: ReadonlyMap<string, string>,
): EditOperationSummary {
  if (summary.size > 64) {
    throw invalid('$.files[].operations', 'invalid operation summary');
  }
  for (const [name, value] of summary) {
    if (!validSummaryName(name) || value === '' || value.length > 1024) {
      throw invalid('$.files[].operations', 'invalid operation summary');
    }
  }
  return { operation, summary: new Map(summary) };
}

function validSummaryName(name: string): boolean {
  if (name === '' || name.length > 64) {
    return false;
  }
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (!(code >= 0x61 && code <= 0x7a) && !(code >= 0x30 && code <= 0x39) && code !== 0x5f) {
      return false;
    }
  }
  return true;
}

/** The wire form of one core.source-encoding@1 record (protocol/src/source.rs:497-514). */
export interface SourceEncoding {
  /** Frozen kind spelling: Binary, Utf8, Utf16Le, Utf16Be, Latin1, or WindowsCodePage. */
  readonly kind: string;
  /** The numeric code page of WindowsCodePage records. */
  readonly windowsCodePage?: number;
}

/** The source-patch@2 encoding facts record (protocol/src/source.rs:598-631). */
export interface EncodingFacts {
  readonly profileDefault?: SourceEncoding;
  /** "DetectUnicode" or "TreatAsContent". */
  readonly bomPolicy: string;
  /** Detected byte-order mark: "Utf8", "Utf16Le", or "Utf16Be"; undefined when none. */
  readonly bom?: string;
  readonly declaration?: SourceEncoding;
  readonly callerOverride?: SourceEncoding;
  readonly selected?: SourceEncoding;
}

/** One structural replacement of a wire source patch (source_patch.rs:31-90). */
export interface SourceReplacement {
  readonly oldStart: bigint;
  readonly oldEnd: bigint;
  /** The exact original bytes of the replaced range (precondition facts). */
  readonly original: Uint8Array;
  readonly replacement: Uint8Array;
  readonly redactOriginal: boolean;
  readonly redactReplacement: boolean;
}

/** The wire form of a source patch (core.source-patch@2). */
export interface SourcePatch {
  readonly baseDigest: ContentDigest;
  readonly targetDigest: ContentDigest;
  readonly encoding: EncodingFacts;
  readonly replacements: readonly SourceReplacement[];
  /** Deterministic sorted metadata map. */
  readonly metadata: ReadonlyMap<string, string>;
}

// ---------------------------------------------------------------------------
// core.batch-plan@1
// ---------------------------------------------------------------------------

/** One file-level status in a core.batch-plan@1 manifest (RFC 0015 §8.2). */
export type BatchPlanFileStatus = 'planned' | 'failed';

/** One file entry of a core.batch-plan@1 manifest (cli.rs:376-541). */
export interface BatchPlanFileEntry {
  readonly path: string;
  readonly status: BatchPlanFileStatus;
  readonly profile?: { id: string; version: number };
  readonly sourceDigest?: ContentDigest;
  readonly operations?: readonly EditOperationSummary[];
  readonly sourcePatch?: SourcePatch;
  readonly failureCode?: string;
  readonly diagnostics?: readonly Diagnostic[];
}

/**
 * Validates the per-status presence rules and the
 * `source_digest == source_patch.base_digest` cross constraint (cli.rs:389-492).
 */
export function newBatchPlanFileEntry(
  path: string,
  status: BatchPlanFileStatus,
  profile: { id: string; version: number } | undefined,
  sourceDigest: ContentDigest | undefined,
  operations: readonly EditOperationSummary[] | undefined,
  sourcePatch: SourcePatch | undefined,
  failureCode: string | undefined,
  diagnostics: readonly Diagnostic[] | undefined,
  registry: ErrorCodeRegistry,
): BatchPlanFileEntry {
  if (path === '' || path.length > 1024) {
    throw invalid('$.files[].path', 'invalid path');
  }
  for (const operation of operations ?? []) {
    newEditOperationSummary(operation.operation, operation.summary);
  }
  switch (status) {
    case 'planned':
      if (profile === undefined || sourceDigest === undefined || operations === undefined || sourcePatch === undefined) {
        throw invalid('$.files[]', 'planned entries require profile, source_digest, operations, and source_patch');
      }
      if (failureCode !== undefined || diagnostics !== undefined) {
        throw invalid('$.files[]', 'planned entries cannot carry failure_code or diagnostics');
      }
      if (!digestsEqual(sourceDigest, sourcePatch.baseDigest)) {
        throw invalid('$.files[].source_digest', 'source_digest must equal source_patch.base_digest');
      }
      break;
    case 'failed':
      if (profile !== undefined || sourceDigest !== undefined || operations !== undefined || sourcePatch !== undefined) {
        throw invalid('$.files[]', 'failed entries cannot carry planning facts');
      }
      if (failureCode === undefined || failureCode === '') {
        throw invalid('$.files[].failure_code', 'failed entries require a failure_code');
      }
      if (diagnostics === undefined) {
        throw invalid('$.files[].diagnostics', 'failed entries require a diagnostics sequence');
      }
      break;
  }
  for (const diagnostic of diagnostics ?? []) {
    validateDiagnosticCode(diagnostic.code, diagnostic.category, registry);
  }
  return {
    path,
    status,
    ...(profile !== undefined ? { profile } : {}),
    ...(sourceDigest !== undefined ? { sourceDigest } : {}),
    ...(operations !== undefined ? { operations } : {}),
    ...(sourcePatch !== undefined ? { sourcePatch } : {}),
    ...(failureCode !== undefined ? { failureCode } : {}),
    ...(diagnostics !== undefined ? { diagnostics } : {}),
  };
}

function digestsEqual(a: ContentDigest, b: ContentDigest): boolean {
  if (a.bytes.length !== b.bytes.length) {
    return false;
  }
  for (let i = 0; i < a.bytes.length; i++) {
    if (a.bytes[i] !== b.bytes[i]) {
      return false;
    }
  }
  return true;
}

/** The full core.batch-plan@1 manifest (RFC 0015 §8). */
export interface BatchPlanMessage {
  readonly productVersion: string;
  /** File entries in command-line argument order. */
  readonly files: readonly BatchPlanFileEntry[];
}

/** Validates the manifest fields and every file entry. */
export function newBatchPlanMessage(
  productVersion: string,
  files: readonly BatchPlanFileEntry[],
  registry: ErrorCodeRegistry,
): BatchPlanMessage {
  if (productVersion === '') {
    throw invalid('$.product_version', 'product_version cannot be empty');
  }
  files.forEach((entry, index) => {
    revalidatePlanEntry(entry, index, registry);
  });
  return { productVersion, files: [...files] };
}

/** Encodes the fixed core.batch-plan@1 schema as a PortableValue tree. */
export function batchPlanToValue(message: BatchPlanMessage): ObjectValue {
  const files = message.files.map((entry, index) => planEntryValue(entry, index));
  return objectValueFrom([
    { key: 'schema', value: { kind: 'String', value: 'core.batch-plan@1' } },
    { key: 'product_version', value: { kind: 'String', value: message.productVersion } },
    { key: 'command', value: { kind: 'String', value: 'plan' } },
    { key: 'files', value: { kind: 'Sequence', items: files } },
  ]);
}

/** Strictly decodes core.batch-plan@1 under the semantic-model v7 error registry. */
export function batchPlanFromValue(
  value: PortableValue,
  registry: ErrorCodeRegistry,
): BatchPlanMessage {
  const fields = schemaFields(
    value,
    'core.batch-plan@1',
    ['product_version', 'command', 'files'],
    '$',
  );
  const productVersion = stringOf(fields[0], '$.product_version');
  const command = stringOf(fields[1], '$.command');
  if (command !== 'plan') {
    throw invalid('$.command', 'expected command "plan"');
  }
  const fileValues = sequenceOf(fields[2], '$.files');
  const files = fileValues.map((item, index) => parsePlanEntry(item, index, registry));
  return newBatchPlanMessage(productVersion, files, registry);
}

/** Re-verifies the entry-level cross constraints (cli.rs:887-938). */
function revalidatePlanEntry(entry: BatchPlanFileEntry, index: number, registry: ErrorCodeRegistry): void {
  const path = `$.files[${index}]`;
  switch (entry.status) {
    case 'planned':
      if (
        entry.profile === undefined ||
        entry.sourceDigest === undefined ||
        entry.operations === undefined ||
        entry.sourcePatch === undefined ||
        entry.failureCode !== undefined ||
        entry.diagnostics !== undefined
      ) {
        throw invalid(path, 'invalid planned entry');
      }
      break;
    case 'failed':
      if (entry.failureCode === undefined || entry.diagnostics === undefined) {
        throw invalid(path, 'invalid failed entry');
      }
      break;
  }
  newBatchPlanFileEntry(
    entry.path,
    entry.status,
    entry.profile,
    entry.sourceDigest,
    entry.operations,
    entry.sourcePatch,
    entry.failureCode,
    entry.diagnostics,
    registry,
  );
}

/** Encodes one plan entry (cli.rs:1136-1206). */
function planEntryValue(entry: BatchPlanFileEntry, index: number): ObjectValue {
  let sourcePatch: PortableValue = wireNull();
  if (entry.sourcePatch !== undefined) {
    sourcePatch = sourcePatchValue(entry.sourcePatch);
  }
  return objectValueFrom([
    { key: 'path', value: { kind: 'String', value: entry.path } },
    { key: 'status', value: { kind: 'String', value: entry.status } },
    {
      key: 'profile',
      value: entry.profile !== undefined ? referenceValue(entry.profile.id, entry.profile.version) : wireNull(),
    },
    { key: 'source_digest', value: entry.sourceDigest !== undefined ? digestValue(entry.sourceDigest) : wireNull() },
    { key: 'operations', value: entry.operations !== undefined ? operationsValue(entry.operations) : wireNull() },
    { key: 'source_patch', value: sourcePatch },
    { key: 'failure_code', value: entry.failureCode !== undefined ? { kind: 'String', value: entry.failureCode } : wireNull() },
    {
      key: 'diagnostics',
      value: entry.diagnostics !== undefined
        ? { kind: 'Sequence', items: entry.diagnostics.map(diagnosticToValue) }
        : wireNull(),
    },
  ]);
}

/** Strictly decodes one plan entry at the value level (cli.rs:1022-1135). */
function parsePlanEntry(value: PortableValue, index: number, registry: ErrorCodeRegistry): BatchPlanFileEntry {
  const path = `$.files[${index}]`;
  const fields = exactFields(
    value,
    ['path', 'status', 'profile', 'source_digest', 'operations', 'source_patch', 'failure_code', 'diagnostics'],
    path,
  );
  const pathText = stringOf(fields[0], `${path}.path`);
  const statusName = stringOf(fields[1], `${path}.status`);
  if (statusName !== 'planned' && statusName !== 'failed') {
    throw invalid(`${path}.status`, 'unknown plan file status');
  }
  if (statusName === 'planned') {
    const profile = parseProfile(fields[2], `${path}.profile`);
    const sourceDigest = parseDigest(fields[3], `${path}.source_digest`);
    const operations = parseOperations(fields[4], `${path}.operations`);
    const sourcePatch = parseSourcePatchValue(fields[5], `${path}.source_patch`);
    if (fields[6].kind !== 'Null' || fields[7].kind !== 'Null') {
      throw invalid(path, 'planned entries cannot carry failure_code or diagnostics');
    }
    return newBatchPlanFileEntry(
      pathText,
      'planned',
      profile,
      sourceDigest,
      operations,
      sourcePatch,
      undefined,
      undefined,
      registry,
    );
  }
  // statusName === 'failed'
  for (let i = 2; i <= 5; i++) {
    if (fields[i].kind !== 'Null') {
      throw invalid(path, 'failed entries cannot carry planning facts');
    }
  }
  const failureCode = stringOf(fields[6], `${path}.failure_code`);
  if (failureCode === '') {
    throw invalid(`${path}.failure_code`, 'failure_code cannot be empty');
  }
  const diagnosticValues = sequenceOf(fields[7], `${path}.diagnostics`);
  const diagnostics = diagnosticValues.map((item) => diagnosticFromValue(item, registry));
  return newBatchPlanFileEntry(
    pathText,
    'failed',
    undefined,
    undefined,
    undefined,
    undefined,
    failureCode,
    diagnostics,
    registry,
  );
}

function operationsValue(operations: readonly EditOperationSummary[]): PortableValue {
  return {
    kind: 'Sequence',
    items: operations.map((operation) =>
      objectValueFrom([
        {
          key: 'operation',
          value: referenceValue(operation.operation.id, operation.operation.version),
        },
        { key: 'summary', value: stringMapObject(operation.summary) },
      ]),
    ),
  };
}

function parseOperations(value: PortableValue, path: string): EditOperationSummary[] {
  const values = sequenceOf(value, path);
  return values.map((item, index) => {
    const fields = exactFields(item, ['operation', 'summary'], `${path}[${index}]`);
    const parsed = parseReference(fields[0], `${path}[${index}].operation`);
    const summary = stringMapFromObject(fields[1], `${path}[${index}].summary`);
    return newEditOperationSummary(newFormatOperationId(parsed.id, parsed.version), summary);
  });
}

function digestValue(digest: ContentDigest): ObjectValue {
  return objectValueFrom([
    { key: 'algorithm', value: { kind: 'String', value: 'sha256' } },
    { key: 'hex', value: { kind: 'String', value: digestHex(digest) } },
  ]);
}

function parseDigest(value: PortableValue, path: string): ContentDigest {
  const fields = exactFields(value, ['algorithm', 'hex'], path);
  const algorithm = stringOf(fields[0], `${path}.algorithm`);
  if (algorithm !== 'sha256') {
    throw invalid(`${path}.algorithm`, 'unsupported digest algorithm');
  }
  const hex = stringOf(fields[1], `${path}.hex`);
  if (!isLowercaseHex(hex) || hex.length !== 64) {
    throw invalid(`${path}.hex`, 'invalid digest hex');
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return { bytes };
}

function isLowercaseHex(text: string): boolean {
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (!(code >= 0x30 && code <= 0x39) && !(code >= 0x61 && code <= 0x66)) {
      return false;
    }
  }
  return true;
}

function parseProfile(value: PortableValue, path: string): { id: string; version: number } {
  return parseReference(value, path);
}

function sourcePatchValue(patch: SourcePatch): PortableValue {
  const replacements = patch.replacements.map((replacement) =>
    objectValueFrom([
      { key: 'old_start', value: wireInteger(replacement.oldStart) },
      { key: 'old_end', value: wireInteger(replacement.oldEnd) },
      { key: 'original', value: { kind: 'Bytes', value: Uint8Array.from(replacement.original) } },
      { key: 'replacement', value: { kind: 'Bytes', value: Uint8Array.from(replacement.replacement) } },
      { key: 'redact_original', value: wireBoolean(replacement.redactOriginal) },
      { key: 'redact_replacement', value: wireBoolean(replacement.redactReplacement) },
    ]),
  );
  return objectValueFrom([
    { key: 'schema', value: { kind: 'String', value: 'core.source-patch@2' } },
    { key: 'base_digest', value: digestValue(patch.baseDigest) },
    { key: 'target_digest', value: digestValue(patch.targetDigest) },
    { key: 'encoding', value: encodingFactsValue(patch.encoding) },
    { key: 'replacements', value: { kind: 'Sequence', items: replacements } },
    { key: 'metadata', value: stringMapObject(patch.metadata) },
  ]);
}

/** Strictly decodes the core.source-patch@2 record at the value level. */
function parseSourcePatchValue(value: PortableValue, path: string): SourcePatch {
  const fields = schemaFields(
    value,
    'core.source-patch@2',
    ['base_digest', 'target_digest', 'encoding', 'replacements', 'metadata'],
    path,
  );
  const baseDigest = parseDigest(fields[0], `${path}.base_digest`);
  const targetDigest = parseDigest(fields[1], `${path}.target_digest`);
  const encoding = parseEncodingFactsValue(fields[2], `${path}.encoding`);
  const replacementValues = sequenceOf(fields[3], `${path}.replacements`);
  const replacements = replacementValues.map((item, index) => {
    const replacementPath = `${path}.replacements[${index}]`;
    const fields = exactFields(
      item,
      ['old_start', 'old_end', 'original', 'replacement', 'redact_original', 'redact_replacement'],
      replacementPath,
    );
    const oldStart = unsigned64(fields[0], `${replacementPath}.old_start`);
    const oldEnd = unsigned64(fields[1], `${replacementPath}.old_end`);
    const original = bytesOf(fields[2], `${replacementPath}.original`);
    const replacement = bytesOf(fields[3], `${replacementPath}.replacement`);
    const redactOriginal = booleanOf(fields[4], `${replacementPath}.redact_original`);
    const redactReplacement = booleanOf(fields[5], `${replacementPath}.redact_replacement`);
    if (oldStart > oldEnd || BigInt(original.length) !== oldEnd - oldStart) {
      throw invalid(replacementPath, 'invalid replacement range or original length');
    }
    return { oldStart, oldEnd, original, replacement, redactOriginal, redactReplacement };
  });
  const metadata = stringMapFromObject(fields[4], `${path}.metadata`);
  return { baseDigest, targetDigest, encoding, replacements, metadata };
}

function encodingFactsValue(facts: EncodingFacts): PortableValue {
  return objectValueFrom([
    {
      key: 'profile_default',
      value: facts.profileDefault !== undefined ? sourceEncodingValue(facts.profileDefault) : wireNull(),
    },
    { key: 'bom_policy', value: { kind: 'String', value: facts.bomPolicy } },
    { key: 'bom', value: facts.bom !== undefined ? { kind: 'String', value: facts.bom } : wireNull() },
    {
      key: 'declaration',
      value: facts.declaration !== undefined ? sourceEncodingValue(facts.declaration) : wireNull(),
    },
    {
      key: 'caller_override',
      value: facts.callerOverride !== undefined ? sourceEncodingValue(facts.callerOverride) : wireNull(),
    },
    {
      key: 'selected',
      value: facts.selected !== undefined ? sourceEncodingValue(facts.selected) : wireNull(),
    },
  ]);
}

function sourceEncodingValue(encoding: SourceEncoding): PortableValue {
  return objectValueFrom([
    { key: 'schema', value: { kind: 'String', value: 'core.source-encoding@1' } },
    { key: 'kind', value: { kind: 'String', value: encoding.kind } },
    {
      key: 'windows_code_page',
      value: encoding.windowsCodePage !== undefined
        ? wireInteger(encoding.windowsCodePage)
        : wireNull(),
    },
  ]);
}

/** Strictly decodes the source-patch@2 encoding facts record. */
function parseEncodingFactsValue(value: PortableValue, path: string): EncodingFacts {
  const fields = exactFields(
    value,
    ['profile_default', 'bom_policy', 'bom', 'declaration', 'caller_override', 'selected'],
    path,
  );
  const bomPolicy = stringOf(fields[1], `${path}.bom_policy`);
  if (bomPolicy !== 'DetectUnicode' && bomPolicy !== 'TreatAsContent') {
    throw invalid(`${path}.bom_policy`, 'unknown BOM policy');
  }
  const optionalEncoding = (field: PortableValue, name: string): SourceEncoding | undefined =>
    field.kind === 'Null' ? undefined : parseSourceEncodingValue(field, `${path}.${name}`);
  let bom: string | undefined;
  if (fields[2].kind !== 'Null') {
    bom = stringOf(fields[2], `${path}.bom`);
  }
  const profileDefault = optionalEncoding(fields[0], 'profile_default');
  const declaration = optionalEncoding(fields[3], 'declaration');
  const callerOverride = optionalEncoding(fields[4], 'caller_override');
  const selected = optionalEncoding(fields[5], 'selected');
  return {
    ...(profileDefault !== undefined ? { profileDefault } : {}),
    bomPolicy,
    ...(bom !== undefined ? { bom } : {}),
    ...(declaration !== undefined ? { declaration } : {}),
    ...(callerOverride !== undefined ? { callerOverride } : {}),
    ...(selected !== undefined ? { selected } : {}),
  };
}

/** Strictly decodes one core.source-encoding@1 record. */
function parseSourceEncodingValue(value: PortableValue, path: string): SourceEncoding {
  const fields = schemaFields(
    value,
    'core.source-encoding@1',
    ['kind', 'windows_code_page'],
    path,
  );
  const kind = stringOf(fields[0], `${path}.kind`);
  let windowsCodePage: number | undefined;
  if (fields[1].kind !== 'Null') {
    windowsCodePage = unsigned32(fields[1], `${path}.windows_code_page`);
  }
  return { kind, ...(windowsCodePage !== undefined ? { windowsCodePage } : {}) };
}

// ---------------------------------------------------------------------------
// core.batch-result@1
// ---------------------------------------------------------------------------

/** One file-level status in a core.batch-result@1 manifest (RFC 0015 §9.2). */
export type BatchResultFileStatus = 'completed' | 'failed' | 'pending' | 'skipped-stale';

/** One result entry of a core.batch-result@1 manifest. */
export interface BatchResultFileEntry {
  readonly path: string;
  readonly status: BatchResultFileStatus;
  readonly failureCode?: string;
  readonly targetDigest?: ContentDigest;
  /** True bytes on disk are unchanged; this file's edits matched a redaction key pattern. */
  readonly redacted: boolean;
}

/** Validates the per-status presence rules and the closed status set (cli.rs:666-712). */
export function newBatchResultFileEntry(
  path: string,
  status: BatchResultFileStatus,
  failureCode: string | undefined,
  targetDigest: ContentDigest | undefined,
  redacted: boolean,
): BatchResultFileEntry {
  if (path === '' || path.length > 1024) {
    throw invalid('$.files[].path', 'invalid path');
  }
  switch (status) {
    case 'completed':
      if (failureCode !== undefined || targetDigest === undefined) {
        throw invalid('$.files[]', 'completed entries require a target_digest and no failure_code');
      }
      break;
    case 'failed':
    case 'skipped-stale':
      if (failureCode === undefined || failureCode === '' || targetDigest !== undefined) {
        throw invalid('$.files[]', 'failed or skipped-stale entries require a failure_code and no target_digest');
      }
      break;
    case 'pending':
      if (failureCode !== undefined || targetDigest !== undefined) {
        throw invalid('$.files[]', 'pending entries cannot carry failure_code or target_digest');
      }
      break;
    default:
      throw invalid('$.files[].status', 'unknown result file status');
  }
  return {
    path,
    status,
    ...(failureCode !== undefined ? { failureCode } : {}),
    ...(targetDigest !== undefined ? { targetDigest } : {}),
    redacted,
  };
}

/** The full core.batch-result@1 manifest (RFC 0015 §9). */
export interface BatchResultMessage {
  readonly productVersion: string;
  /** Result entries in input plan order. */
  readonly files: readonly BatchResultFileEntry[];
}

/** Validates the manifest fields and every result entry. */
export function newBatchResultMessage(
  productVersion: string,
  files: readonly BatchResultFileEntry[],
): BatchResultMessage {
  if (productVersion === '') {
    throw invalid('$.product_version', 'product_version cannot be empty');
  }
  return { productVersion, files: [...files] };
}

/** Encodes the fixed core.batch-result@1 schema. */
export function batchResultToValue(message: BatchResultMessage): ObjectValue {
  return objectValueFrom([
    { key: 'schema', value: { kind: 'String', value: 'core.batch-result@1' } },
    { key: 'product_version', value: { kind: 'String', value: message.productVersion } },
    { key: 'command', value: { kind: 'String', value: 'apply' } },
    {
      key: 'files',
      value: { kind: 'Sequence', items: message.files.map(resultEntryValue) },
    },
  ]);
}

/** Strictly decodes core.batch-result@1 (cli.rs:801-821). */
export function batchResultFromValue(value: PortableValue): BatchResultMessage {
  const fields = schemaFields(
    value,
    'core.batch-result@1',
    ['product_version', 'command', 'files'],
    '$',
  );
  const productVersion = stringOf(fields[0], '$.product_version');
  const command = stringOf(fields[1], '$.command');
  if (command !== 'apply') {
    throw invalid('$.command', 'expected command "apply"');
  }
  const fileValues = sequenceOf(fields[2], '$.files');
  const files = fileValues.map((item, index) => parseResultEntry(item, `$.files[${index}]`));
  return newBatchResultMessage(productVersion, files);
}

function resultEntryValue(entry: BatchResultFileEntry): ObjectValue {
  return objectValueFrom([
    { key: 'path', value: { kind: 'String', value: entry.path } },
    { key: 'status', value: { kind: 'String', value: entry.status } },
    {
      key: 'failure_code',
      value: entry.failureCode !== undefined ? { kind: 'String', value: entry.failureCode } : wireNull(),
    },
    {
      key: 'target_digest',
      value: entry.targetDigest !== undefined ? digestValue(entry.targetDigest) : wireNull(),
    },
    { key: 'redacted', value: wireBoolean(entry.redacted) },
  ]);
}

function parseResultEntry(value: PortableValue, path: string): BatchResultFileEntry {
  const fields = exactFields(
    value,
    ['path', 'status', 'failure_code', 'target_digest', 'redacted'],
    path,
  );
  const pathText = stringOf(fields[0], `${path}.path`);
  const statusName = stringOf(fields[1], `${path}.status`);
  if (
    statusName !== 'completed' &&
    statusName !== 'failed' &&
    statusName !== 'pending' &&
    statusName !== 'skipped-stale'
  ) {
    throw invalid(`${path}.status`, 'unknown result file status');
  }
  let failureCode: string | undefined;
  if (fields[2].kind !== 'Null') {
    failureCode = stringOf(fields[2], `${path}.failure_code`);
  }
  let targetDigest: ContentDigest | undefined;
  if (fields[3].kind !== 'Null') {
    targetDigest = parseDigest(fields[3], `${path}.target_digest`);
  }
  const redacted = booleanOf(fields[4], `${path}.redacted`);
  return newBatchResultFileEntry(pathText, statusName, failureCode, targetDigest, redacted);
}

// ---------------------------------------------------------------------------
// core.cli-output@1
// ---------------------------------------------------------------------------

/** The full core.cli-output@1 machine envelope (RFC 0015 §4). */
export interface CliOutputMessage {
  readonly command: CliCommand;
  readonly exitClass: ExitClass;
  readonly productVersion: string;
  /** The validated command payload. */
  readonly payload: PortableValue;
  readonly diagnostics: readonly Diagnostic[];
  readonly redaction: Redaction;
}

/** Validates the envelope under the semantic-model v7 error registry (cli.rs:160-220). */
export function newCliOutputMessage(
  command: CliCommand,
  exitClass: ExitClass,
  productVersion: string,
  payload: PortableValue,
  diagnostics: readonly Diagnostic[],
  redaction: Redaction,
  registry: ErrorCodeRegistry,
): CliOutputMessage {
  if (!isSemanticVersion(productVersion)) {
    throw invalid(
      '$.product_version',
      'expected MAJOR.MINOR.PATCH[-prerelease] without leading zeros or build metadata',
    );
  }
  validatePayloadSchema(payload, command);
  diagnostics.forEach((diagnostic, index) => {
    validateDiagnosticCode(diagnostic.code, diagnostic.category, registry);
  });
  return { command, exitClass, productVersion, payload, diagnostics: [...diagnostics], redaction };
}

/** Encodes the fixed core.cli-output@1 envelope. */
export function cliOutputToValue(message: CliOutputMessage): ObjectValue {
  return objectValueFrom([
    { key: 'schema', value: { kind: 'String', value: 'core.cli-output@1' } },
    { key: 'command', value: { kind: 'String', value: message.command } },
    { key: 'exit_class', value: { kind: 'String', value: message.exitClass } },
    { key: 'product_version', value: { kind: 'String', value: message.productVersion } },
    { key: 'payload', value: message.payload },
    { key: 'diagnostics', value: { kind: 'Sequence', items: message.diagnostics.map(diagnosticToValue) } },
    {
      key: 'redaction',
      value: objectValueFrom([
        { key: 'redacted', value: wireBoolean(message.redaction.redacted) },
        { key: 'count', value: wireInteger(message.redaction.count) },
      ]),
    },
  ]);
}

/** Strictly decodes core.cli-output@1 under the semantic-model v7 error registry (cli.rs:288-343). */
export function cliOutputFromValue(value: PortableValue, registry: ErrorCodeRegistry): CliOutputMessage {
  const fields = schemaFields(
    value,
    'core.cli-output@1',
    ['command', 'exit_class', 'product_version', 'payload', 'diagnostics', 'redaction'],
    '$',
  );
  const commandName = stringOf(fields[0], '$.command');
  const command = parseCliCommand(commandName);
  if (command === undefined) {
    throw invalid('$.command', 'unknown command');
  }
  const exitClassName = stringOf(fields[1], '$.exit_class');
  const exitClass = parseExitClass(exitClassName);
  if (exitClass === undefined) {
    throw invalid('$.exit_class', 'unknown exit class');
  }
  const productVersion = stringOf(fields[2], '$.product_version');
  const payload = fields[3];
  const diagnosticValues = sequenceOf(fields[4], '$.diagnostics');
  const diagnostics = diagnosticValues.map((item, index) => diagnosticFromValue(item, registry));
  const redactionFields = exactFields(fields[5], ['redacted', 'count'], '$.redaction');
  const redaction = newRedaction(
    booleanOf(redactionFields[0], '$.redaction.redacted'),
    unsigned64(redactionFields[1], '$.redaction.count'),
  );
  return newCliOutputMessage(
    command,
    exitClass,
    productVersion,
    payload,
    diagnostics,
    redaction,
    registry,
  );
}

/**
 * Requires the payload schema to match the command (RFC 0015 §6.1 table;
 * cli.rs:824-871). The failure kinds are pinned by the shared vectors:
 * WrongType for a non-object payload, MissingField for an absent schema,
 * SchemaMismatch when the schema is not the first field or is not published
 * by the command (the schema-mismatch vector pins
 * core.protocol.schema-mismatch@1 at $.payload.schema).
 */
function validatePayloadSchema(payload: PortableValue, command: CliCommand): void {
  if (payload.kind !== 'Object') {
    throw protocolError('WrongType', '$.payload', 'payload must be an Object');
  }
  if (payload.entries.length === 0) {
    throw protocolError('MissingField', '$.payload.schema', 'payload schema is absent');
  }
  if (payload.entries[0].key !== 'schema') {
    throw protocolError('SchemaMismatch', '$.payload', 'schema must be the first field');
  }
  const schema = stringOf(payload.entries[0].value, '$.payload.schema');
  if (!payloadSchemas(command).includes(schema)) {
    throw protocolError(
      'SchemaMismatch',
      '$.payload.schema',
      `payload schema ${schema} is not published by ${command}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Semantic-version shape (RFC 0015 §4.3)
// ---------------------------------------------------------------------------

/** Reports whether the string is shaped like MAJOR.MINOR.PATCH[-prerelease] per SemVer 2.0. */
export function isSemanticVersion(version: string): boolean {
  if (version.includes('+')) {
    return false;
  }
  let core = version;
  let prerelease: string | undefined;
  const dash = version.indexOf('-');
  if (dash >= 0) {
    core = version.slice(0, dash);
    prerelease = version.slice(dash + 1);
  }
  if (!numericCore(core)) {
    return false;
  }
  if (prerelease === undefined) {
    return true;
  }
  if (prerelease === '') {
    return false;
  }
  for (const identifier of prerelease.split('.')) {
    if (!prereleaseIdentifier(identifier)) {
      return false;
    }
  }
  return true;
}

/** Exactly three dot-separated numeric segments without leading zeros. */
function numericCore(text: string): boolean {
  const segments = text.split('.');
  if (segments.length !== 3) {
    return false;
  }
  return segments.every(numericSegment);
}

/** One non-empty digit run without a leading zero (single "0" allowed). */
function numericSegment(segment: string): boolean {
  if (segment === '') {
    return false;
  }
  for (const ch of segment) {
    if (ch < '0' || ch > '9') {
      return false;
    }
  }
  return segment.length === 1 || segment[0] !== '0';
}

/** One well-formed SemVer prerelease identifier (ASCII alphanumeric or hyphen; no leading zero on numeric). */
function prereleaseIdentifier(identifier: string): boolean {
  if (identifier === '') {
    return false;
  }
  let numeric = true;
  for (const ch of identifier) {
    if (ch < '0' || ch > '9') {
      numeric = false;
      if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '-')) {
        return false;
      }
    }
  }
  return !(numeric && identifier.length > 1 && identifier[0] === '0');
}

/** Narrowing helper used by tests. */
export function isProtocolError(error: unknown): error is ProtocolError {
  return error instanceof ProtocolError;
}
