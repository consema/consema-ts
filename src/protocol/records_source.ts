/**
 * Transferable raw source snapshots and verifiable source patches
 * (core.source-encoding@1, core.source-snapshot@1, core.source-patch@1).
 *
 * authority: crates/consema-protocol/src/source.rs —
 *  - SourceEncodingMessage :17-46, source_encoding_value :497-514,
 *    source_encoding_from_value :516-561
 *  - SourceSnapshotMessage :48-96 / SourceSnapshotMessageV2 :98-146,
 *    source_snapshot_value :241-260, source_snapshot_from_value :262-321
 *  - SourcePatchMessage :148-193 / SourcePatchMessageV2 :196-239,
 *    source_patch_value :323-370, source_patch_from_value :372-430,
 *    replacement_from_value :432-461
 *  - digest_value / digest_from_value :463-495
 *  - v1 encoding-facts wire: encoding_value :563-596, encoding_from_value
 *    :659-679, encoding_name :725-736, encoding_from_name :738-747,
 *    bom_name :749-755, optional_bom :757-767, optional_encoding :769-778
 *  - v2 encoding-facts wire: encoding_value_v2 :598-631, encoding_from_value_v2
 *    :681-723, optional_source_encoding_v2 :780-789
 *  - the v1 facts guard ensure_v1_encoding_facts :633-657
 *  - request_from_facts :791-800 / request_from_facts_v2 :802-812
 *  - error mappings: source_error :821-831, patch_error :833-846
 * The payload dispatch decodes these records with SourceLimits /
 * SourcePatchLimits defaults (crates/consema-protocol/src/payload.rs:159-170).
 * Python transcription: python/src/consema/protocol/records_source.py
 * (same wire spellings; both implementations pass the shared vectors).
 *
 * Design (TypeScript-idiomatic): each message is an immutable class with a
 * private constructor and static factories (fromSnapshot / fromValue), a
 * `toValue()` that encodes the exact fixed-field wire object, and strict
 * re-verification on decode — the raw bytes are rebuilt into a fresh
 * SourceSnapshot and its digest, encoding facts, and decoded status must all
 * match the claimed wire facts (forged facts are invalid-value rejections).
 * `fromValue` accepts caller-supplied limits so the resource-limit cases can
 * tighten them; the envelope dispatch always passes the frozen defaults.
 */

import type { ObjectValue, PortableValue } from '../core/value.ts';
import {
  booleanValue,
  bytesValue,
  integerValue,
  nullValue,
  sequenceValue,
  stringValue,
} from '../core/value.ts';
import { ContentDigest } from '../document/sha256.ts';
import {
  type BomKind,
  type BomPolicy,
  DEFAULT_SOURCE_LIMITS,
  EncodingFacts,
  type SourceEncoding,
  type SourceLimits,
  SourceSnapshot,
  WindowsCodePage,
} from '../document/source.ts';
import {
  DEFAULT_SOURCE_PATCH_LIMITS,
  SourcePatch,
  type SourcePatchLimits,
  SourceReplacement,
} from '../document/source_patch.ts';
import { SourceError, SourcePatchError } from '../document/errors.ts';
import { invalid, ProtocolError } from './errors.ts';
import {
  booleanOf,
  bytesOf,
  exactFields,
  objectValueFrom,
  schemaFields,
  sequenceOf,
  stringOf,
} from './records.ts';
import { registerPayloadValidator } from './payload_validators.ts';
import { stringMapFromObject, stringMapObject } from './string_map.ts';

const SOURCE_ENCODING_SCHEMA = 'core.source-encoding@1';
const SOURCE_SNAPSHOT_SCHEMA = 'core.source-snapshot@1';
const SOURCE_PATCH_SCHEMA = 'core.source-patch@1';

// ---------------------------------------------------------------------------
// core.source-encoding@1 (source.rs:17-46, 497-561)
// ---------------------------------------------------------------------------

/** Transferable `core.source-encoding@1` value (source.rs:17-46). */
export class SourceEncodingMessage {
  readonly #encoding: SourceEncoding;

  private constructor(encoding: SourceEncoding) {
    this.#encoding = encoding;
  }

  /** Wraps one normalized source encoding (source.rs:25-28). */
  static fromEncoding(encoding: SourceEncoding): SourceEncodingMessage {
    return new SourceEncodingMessage(encoding);
  }

  /** Normalized source encoding (source.rs:30-34). */
  encoding(): SourceEncoding {
    return this.#encoding;
  }

  /** Encodes the exact standalone source-encoding schema (source.rs:36-40). */
  toValue(): ObjectValue {
    return sourceEncodingValue(this.#encoding);
  }

  /** Strictly decodes one canonical source-encoding value (source.rs:42-45). */
  static fromValue(value: PortableValue): SourceEncodingMessage {
    return new SourceEncodingMessage(sourceEncodingFromValue(value, '$'));
  }
}

function sourceEncodingValue(encoding: SourceEncoding): ObjectValue {
  const [kind, page] = encodingKindAndPage(encoding);
  return objectValueFrom([
    { key: 'schema', value: stringValue(SOURCE_ENCODING_SCHEMA) },
    { key: 'kind', value: stringValue(kind) },
    { key: 'windows_code_page', value: page },
  ]);
}

function encodingKindAndPage(encoding: SourceEncoding): [string, PortableValue] {
  switch (encoding.kind) {
    case 'Binary':
      return ['Binary', nullValue()];
    case 'Utf8':
      return ['Utf8', nullValue()];
    case 'Utf16Le':
      return ['Utf16Le', nullValue()];
    case 'Utf16Be':
      return ['Utf16Be', nullValue()];
    case 'Latin1':
      return ['Latin1', nullValue()];
    case 'WindowsCodePage':
      return ['WindowsCodePage', integerValue(BigInt(encoding.codePage.number()))];
  }
}

function sourceEncodingFromValue(value: PortableValue, path: string): SourceEncoding {
  const fields = schemaFields(value, SOURCE_ENCODING_SCHEMA, ['kind', 'windows_code_page'], path);
  const kind = stringOf(fields[0], `${path}.kind`);
  const codePagePath = `${path}.windows_code_page`;
  switch (kind) {
    case 'Binary':
    case 'Utf8':
    case 'Utf16Le':
    case 'Utf16Be':
    case 'Latin1':
      if (fields[1].kind !== 'Null') {
        throw invalid(codePagePath, 'non-Windows encoding requires null');
      }
      return { kind };
    case 'WindowsCodePage': {
      const page = WindowsCodePage.fromNumber(unsignedU32(fields[1], codePagePath));
      if (page === null) {
        throw invalid(codePagePath, 'unsupported Windows code page');
      }
      return { kind: 'WindowsCodePage', codePage: page };
    }
    default:
      throw invalid(`${path}.kind`, 'unknown source encoding kind');
  }
}

// ---------------------------------------------------------------------------
// unsigned integer leaves (the Rust schema.rs helpers: unsigned_u32 /
// unsigned_u64 fail every non-conforming Integer with invalid-value)
// ---------------------------------------------------------------------------

function unsignedU32(value: PortableValue, path: string): number {
  if (value.kind !== 'Integer') {
    throw invalid(path, 'expected an unsigned 32-bit Integer');
  }
  const number = value.value;
  if (number < 0n || number > 0xffffffffn) {
    throw invalid(path, 'expected an unsigned 32-bit Integer');
  }
  return Number(number);
}

function unsignedU64(value: PortableValue, path: string): bigint {
  if (value.kind !== 'Integer') {
    throw invalid(path, 'expected an unsigned 64-bit Integer');
  }
  const number = value.value;
  if (number < 0n || number > 0xffffffffffffffffn) {
    throw invalid(path, 'expected an unsigned 64-bit Integer');
  }
  return number;
}

/** One host-offset field: an unsigned 64-bit Integer that fits a JS number (source.rs:449-452). */
function usizeOf(value: PortableValue, path: string): number {
  const number = unsignedU64(value, path);
  if (number > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw invalid(path, 'exceeds usize');
  }
  return Number(number);
}

// ---------------------------------------------------------------------------
// v1 encoding-facts wire (source.rs:563-596, 659-679) and its guard
// (ensure_v1_encoding_facts :633-657)
// ---------------------------------------------------------------------------

function encodingValue(facts: EncodingFacts): ObjectValue {
  return objectValueFrom([
    { key: 'profile_default', value: stringValue(encodingNameV1(facts.profileDefault())) },
    { key: 'bom', value: bomNameValue(facts.bom()) },
    { key: 'declaration', value: optionalEncodingName(facts.declaration()) },
    { key: 'caller_override', value: optionalEncodingName(facts.callerOverride()) },
    { key: 'selected', value: stringValue(encodingNameV1(facts.selected())) },
  ]);
}

function optionalEncodingName(encoding: SourceEncoding | null): PortableValue {
  return encoding === null ? nullValue() : stringValue(encodingNameV1(encoding));
}

function bomNameValue(bom: BomKind | null): PortableValue {
  return bom === null ? nullValue() : stringValue(bomName(bom));
}

/** The v1 wire spelling of one BOM kind (source.rs:749-755). */
function bomName(bom: BomKind): string {
  switch (bom) {
    case 'Utf8':
      return 'Utf8';
    case 'Utf16Le':
      return 'Utf16Le';
    case 'Utf16Be':
      return 'Utf16Be';
  }
}

function encodingFromValue(value: PortableValue, path: string): EncodingFacts {
  const fields = exactFields(
    value,
    ['profile_default', 'bom', 'declaration', 'caller_override', 'selected'],
    path,
  );
  const profileDefault = encodingFromNameV1(stringOf(fields[0], `${path}.profile_default`));
  const bom = optionalBom(fields[1], `${path}.bom`);
  const declaration = optionalEncodingV1(fields[2], `${path}.declaration`);
  const callerOverride = optionalEncodingV1(fields[3], `${path}.caller_override`);
  const selected = encodingFromNameV1(stringOf(fields[4], `${path}.selected`));
  try {
    return EncodingFacts.fromClaim(profileDefault, bom, declaration, callerOverride, selected);
  } catch (error) {
    if (error instanceof SourceError) {
      throw sourceError(path, error);
    }
    throw error;
  }
}

function optionalBom(value: PortableValue, path: string): BomKind | null {
  if (value.kind === 'Null') {
    return null;
  }
  switch (stringOf(value, path)) {
    case 'Utf8':
      return 'Utf8';
    case 'Utf16Le':
      return 'Utf16Le';
    case 'Utf16Be':
      return 'Utf16Be';
    default:
      throw invalid(path, 'unknown BOM ID');
  }
}

function optionalEncodingV1(value: PortableValue, path: string): SourceEncoding | null {
  if (value.kind === 'Null') {
    return null;
  }
  return encodingFromNameV1(stringOf(value, path));
}

/** The closed v1 encoding IDs (source.rs:738-747): Windows code pages are never on the v1 wire. */
function encodingFromNameV1(name: string): SourceEncoding {
  switch (name) {
    case 'Binary':
    case 'Utf8':
    case 'Utf16Le':
    case 'Utf16Be':
    case 'Latin1':
      return { kind: name };
    default:
      throw invalid('$.encoding', 'unknown encoding ID');
  }
}

/** The v1 wire spelling of one encoding (source.rs:725-736). */
function encodingNameV1(encoding: SourceEncoding): string {
  switch (encoding.kind) {
    case 'Binary':
      return 'Binary';
    case 'Utf8':
      return 'Utf8';
    case 'Utf16Le':
      return 'Utf16Le';
    case 'Utf16Be':
      return 'Utf16Be';
    case 'Latin1':
      return 'Latin1';
    case 'WindowsCodePage':
      throw new Error('internal: core source v1 validation rejects Windows code pages');
  }
}

// ---------------------------------------------------------------------------
// v2 encoding-facts wire (source.rs:598-631, 681-723): full encodings
// (including Windows code pages) and an explicit BOM policy
// ---------------------------------------------------------------------------

function encodingValueV2(facts: EncodingFacts): ObjectValue {
  return objectValueFrom([
    { key: 'profile_default', value: sourceEncodingValue(facts.profileDefault()) },
    {
      key: 'bom_policy',
      value: stringValue(facts.bomPolicy() === 'DetectUnicode' ? 'DetectUnicode' : 'TreatAsContent'),
    },
    { key: 'bom', value: bomNameValue(facts.bom()) },
    { key: 'declaration', value: optionalSourceEncodingV2(facts.declaration()) },
    { key: 'caller_override', value: optionalSourceEncodingV2(facts.callerOverride()) },
    { key: 'selected', value: sourceEncodingValue(facts.selected()) },
  ]);
}

function optionalSourceEncodingV2(encoding: SourceEncoding | null): PortableValue {
  return encoding === null ? nullValue() : sourceEncodingValue(encoding);
}

function encodingFromValueV2(value: PortableValue, path: string): EncodingFacts {
  const fields = exactFields(
    value,
    ['profile_default', 'bom_policy', 'bom', 'declaration', 'caller_override', 'selected'],
    path,
  );
  const profileDefault = sourceEncodingFromValue(fields[0], `${path}.profile_default`);
  let bomPolicy: BomPolicy;
  switch (stringOf(fields[1], `${path}.bom_policy`)) {
    case 'DetectUnicode':
      bomPolicy = 'DetectUnicode';
      break;
    case 'TreatAsContent':
      bomPolicy = 'TreatAsContent';
      break;
    default:
      throw invalid(`${path}.bom_policy`, 'unknown BOM policy');
  }
  const bom = optionalBom(fields[2], `${path}.bom`);
  const declaration = optionalSourceEncodingValueV2(fields[3], `${path}.declaration`);
  const callerOverride = optionalSourceEncodingValueV2(fields[4], `${path}.caller_override`);
  const selected = sourceEncodingFromValue(fields[5], `${path}.selected`);
  try {
    return EncodingFacts.fromClaimWithBomPolicy(
      profileDefault,
      bomPolicy,
      bom,
      declaration,
      callerOverride,
      selected,
    );
  } catch (error) {
    if (error instanceof SourceError) {
      throw sourceError(path, error);
    }
    throw error;
  }
}

function optionalSourceEncodingValueV2(value: PortableValue, path: string): SourceEncoding | null {
  if (value.kind === 'Null') {
    return null;
  }
  return sourceEncodingFromValue(value, path);
}

/** The v1 facts guard: DetectUnicode policy and no Windows code pages (source.rs:633-657). */
function ensureV1EncodingFacts(facts: EncodingFacts, path: string): void {
  if (facts.bomPolicy() !== 'DetectUnicode') {
    throw invalid(path, 'core source v1 requires DetectUnicode BOM policy');
  }
  for (const encoding of [
    facts.profileDefault(),
    facts.declaration(),
    facts.callerOverride(),
    facts.selected(),
  ]) {
    if (encoding !== null && encoding.kind === 'WindowsCodePage') {
      throw invalid(path, 'core source v1 does not support Windows code pages');
    }
  }
}

// ---------------------------------------------------------------------------
// content digest wire (source.rs:463-495)
// ---------------------------------------------------------------------------

function digestValue(digest: ContentDigest): ObjectValue {
  return objectValueFrom([
    { key: 'algorithm', value: stringValue('sha256') },
    { key: 'hex', value: stringValue(digest.toHex()) },
  ]);
}

function digestFromValue(value: PortableValue, path: string): ContentDigest {
  const fields = exactFields(value, ['algorithm', 'hex'], path);
  if (stringOf(fields[0], `${path}.algorithm`) !== 'sha256') {
    throw invalid(`${path}.algorithm`, 'expected sha256');
  }
  const hex = stringOf(fields[1], `${path}.hex`);
  if (hex.length !== 64 || !isLowercaseHex(hex)) {
    throw invalid(`${path}.hex`, 'expected 64 lowercase hexadecimal characters');
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return ContentDigest.fromBytes(bytes);
}

function isLowercaseHex(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (!((code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x66))) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// core.source-snapshot@1 (source.rs:48-96, 241-321)
// ---------------------------------------------------------------------------

/** Transferable `core.source-snapshot@1` content fact (source.rs:48-96). */
export class SourceSnapshotMessage {
  readonly #snapshot: SourceSnapshot;

  private constructor(snapshot: SourceSnapshot) {
    this.#snapshot = snapshot;
  }

  /** Copies one immutable snapshot into a transferable content message (source.rs:55-61). */
  static fromSnapshot(snapshot: SourceSnapshot): SourceSnapshotMessage {
    ensureV1EncodingFacts(snapshot.encodingFacts(), '$.encoding');
    return new SourceSnapshotMessage(snapshot);
  }

  /** Verified immutable source snapshot (source.rs:63-67). */
  snapshot(): SourceSnapshot {
    return this.#snapshot;
  }

  /** Encodes the fixed-field PortableValue schema (source.rs:76-83). */
  toValue(): ObjectValue {
    return sourceSnapshotValue(this.#snapshot, SOURCE_SNAPSHOT_SCHEMA, encodingValue(this.#snapshot.encodingFacts()));
  }

  /** Strictly decodes and re-verifies raw bytes, digest, encoding, and decoded status (source.rs:85-95). */
  static fromValue(value: PortableValue, limits: SourceLimits): SourceSnapshotMessage {
    return new SourceSnapshotMessage(
      sourceSnapshotFromValue(value, SOURCE_SNAPSHOT_SCHEMA, encodingFromValue, limits),
    );
  }
}

/** Transferable `core.source-snapshot@2` content fact (source.rs:98-146). */
export class SourceSnapshotMessageV2 {
  readonly #snapshot: SourceSnapshot;

  private constructor(snapshot: SourceSnapshot) {
    this.#snapshot = snapshot;
  }

  /** Copies one immutable snapshot into a source-v2 message (source.rs:106-112). */
  static fromSnapshot(snapshot: SourceSnapshot): SourceSnapshotMessageV2 {
    return new SourceSnapshotMessageV2(snapshot);
  }

  /** Verified immutable source snapshot (source.rs:114-118). */
  snapshot(): SourceSnapshot {
    return this.#snapshot;
  }

  /** Encodes the exact source-snapshot v2 schema (source.rs:125-132). */
  toValue(): ObjectValue {
    return sourceSnapshotValue(this.#snapshot, 'core.source-snapshot@2', encodingValueV2(this.#snapshot.encodingFacts()));
  }

  /** Strictly decodes and re-verifies every source-v2 fact (source.rs:135-145). */
  static fromValue(value: PortableValue, limits: SourceLimits): SourceSnapshotMessageV2 {
    return new SourceSnapshotMessageV2(
      sourceSnapshotFromValue(value, 'core.source-snapshot@2', encodingFromValueV2, limits),
    );
  }
}

function sourceSnapshotValue(snapshot: SourceSnapshot, schema: string, encoding: ObjectValue): ObjectValue {
  return objectValueFrom([
    { key: 'schema', value: stringValue(schema) },
    { key: 'raw_bytes', value: bytesValue(snapshot.bytes()) },
    { key: 'digest', value: digestValue(snapshot.digest()) },
    { key: 'encoding', value: encoding },
    {
      key: 'decoded_status',
      value: stringValue(snapshot.decodedText() === null ? 'NotText' : 'Available'),
    },
  ]);
}

function sourceSnapshotFromValue(
  value: PortableValue,
  schema: string,
  parseEncoding: (value: PortableValue, path: string) => EncodingFacts,
  limits: SourceLimits,
): SourceSnapshot {
  const fields = schemaFields(value, schema, ['raw_bytes', 'digest', 'encoding', 'decoded_status'], '$');
  const raw = bytesOf(fields[0], '$.raw_bytes');
  const claimedDigest = digestFromValue(fields[1], '$.digest');
  const claimedEncoding = parseEncoding(fields[2], '$.encoding');
  const decodedStatus = stringOf(fields[3], '$.decoded_status');
  if (decodedStatus !== 'Available' && decodedStatus !== 'NotText') {
    throw invalid('$.decoded_status', 'expected Available or NotText');
  }
  const snapshot = buildSnapshot(raw, claimedEncoding, limits);
  if (!snapshot.digest().equals(claimedDigest)) {
    throw invalid('$.digest', 'digest does not match raw_bytes');
  }
  if (!snapshot.encodingFacts().equals(claimedEncoding)) {
    throw invalid('$.encoding', 'encoding facts do not match raw_bytes resolution');
  }
  const actualStatus = snapshot.decodedText() === null ? 'NotText' : 'Available';
  if (decodedStatus !== actualStatus) {
    throw invalid('$.decoded_status', 'decoded status contradicts selected encoding');
  }
  return snapshot;
}

/** Rebuilds the source from wire facts under the request derived from claimed facts (source.rs:291-296). */
function buildSnapshot(raw: Uint8Array, facts: EncodingFacts, limits: SourceLimits): SourceSnapshot {
  try {
    return SourceSnapshot.fromRaw(raw, facts.resolutionRequest(), limits);
  } catch (error) {
    if (error instanceof SourceError) {
      throw sourceError('$.raw_bytes', error);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// core.source-patch@1 (source.rs:148-193, 323-461)
// ---------------------------------------------------------------------------

/** Transferable `core.source-patch@1` verification facts (source.rs:148-193). */
export class SourcePatchMessage {
  readonly #patch: SourcePatch;

  private constructor(patch: SourcePatch) {
    this.#patch = patch;
  }

  /** Copies one validated source patch into a transferable message (source.rs:156-161). */
  static fromPatch(patch: SourcePatch): SourcePatchMessage {
    return new SourcePatchMessage(patch);
  }

  /** Validated source patch (source.rs:163-167). */
  patch(): SourcePatch {
    return this.#patch;
  }

  /** Encodes the fixed-field PortableValue schema (source.rs:175-183). */
  toValue(): ObjectValue {
    ensureV1EncodingFacts(this.#patch.encodingFacts(), '$.encoding');
    return sourcePatchValue(this.#patch, SOURCE_PATCH_SCHEMA, encodingValue(this.#patch.encodingFacts()));
  }

  /** Strictly decodes structural patch facts without applying them to a base snapshot (source.rs:185-192). */
  static fromValue(value: PortableValue, limits: SourcePatchLimits): SourcePatchMessage {
    return new SourcePatchMessage(
      sourcePatchFromValue(value, SOURCE_PATCH_SCHEMA, encodingFromValue, limits),
    );
  }
}

/** Transferable `core.source-patch@2` verification facts (source.rs:196-239). */
export class SourcePatchMessageV2 {
  readonly #patch: SourcePatch;

  private constructor(patch: SourcePatch) {
    this.#patch = patch;
  }

  /** Copies one validated source patch into a source-v2 message (source.rs:204-209). */
  static fromPatch(patch: SourcePatch): SourcePatchMessageV2 {
    return new SourcePatchMessageV2(patch);
  }

  /** Validated source patch (source.rs:211-215). */
  patch(): SourcePatch {
    return this.#patch;
  }

  /** Encodes the exact source-patch v2 schema (source.rs:222-229). */
  toValue(): ObjectValue {
    return sourcePatchValue(this.#patch, 'core.source-patch@2', encodingValueV2(this.#patch.encodingFacts()));
  }

  /** Strictly decodes structural source-patch v2 facts (source.rs:231-238). */
  static fromValue(value: PortableValue, limits: SourcePatchLimits): SourcePatchMessageV2 {
    return new SourcePatchMessageV2(
      sourcePatchFromValue(value, 'core.source-patch@2', encodingFromValueV2, limits),
    );
  }
}

function sourcePatchValue(patch: SourcePatch, schema: string, encoding: ObjectValue): ObjectValue {
  const replacements = patch.replacements().map((replacement) =>
    objectValueFrom([
      { key: 'old_start', value: integerValue(BigInt(replacement.oldStart())) },
      { key: 'old_end', value: integerValue(BigInt(replacement.oldEnd())) },
      { key: 'original', value: bytesValue(replacement.original()) },
      { key: 'replacement', value: bytesValue(replacement.replacement()) },
      { key: 'redact_original', value: booleanValue(replacement.redactOriginal()) },
      { key: 'redact_replacement', value: booleanValue(replacement.redactReplacement()) },
    ]),
  );
  return objectValueFrom([
    { key: 'schema', value: stringValue(schema) },
    { key: 'base_digest', value: digestValue(patch.baseDigest()) },
    { key: 'target_digest', value: digestValue(patch.targetDigest()) },
    { key: 'encoding', value: encoding },
    { key: 'replacements', value: sequenceValue(replacements) },
    { key: 'metadata', value: stringMapObject(patch.metadata()) },
  ]);
}

function sourcePatchFromValue(
  value: PortableValue,
  schema: string,
  parseEncoding: (value: PortableValue, path: string) => EncodingFacts,
  limits: SourcePatchLimits,
): SourcePatch {
  const fields = schemaFields(value, schema, ['base_digest', 'target_digest', 'encoding', 'replacements', 'metadata'], '$');
  const baseDigest = digestFromValue(fields[0], '$.base_digest');
  const targetDigest = digestFromValue(fields[1], '$.target_digest');
  const encoding = parseEncoding(fields[2], '$.encoding');
  const replacementValues = sequenceOf(fields[3], '$.replacements');
  if (replacementValues.length > limits.maxReplacements) {
    throw new ProtocolError('ResourceLimit', '$.replacements', 'replacement count exceeds configured limit');
  }
  const replacements = replacementValues.map((item, index) => replacementFromValue(item, index));
  const metadata = stringMapFromObject(fields[4], '$.metadata');
  try {
    return SourcePatch.create(baseDigest, targetDigest, encoding, replacements, metadata, limits);
  } catch (error) {
    if (error instanceof SourcePatchError) {
      throw patchError(error);
    }
    throw error;
  }
}

function replacementFromValue(value: PortableValue, index: number): SourceReplacement {
  const path = `$.replacements[${index}]`;
  const fields = exactFields(
    value,
    ['old_start', 'old_end', 'original', 'replacement', 'redact_original', 'redact_replacement'],
    path,
  );
  const oldStart = usizeOf(fields[0], `${path}.old_start`);
  const oldEnd = usizeOf(fields[1], `${path}.old_end`);
  return new SourceReplacement(
    oldStart,
    oldEnd,
    bytesOf(fields[2], `${path}.original`),
    bytesOf(fields[3], `${path}.replacement`),
  )
    .withOriginalRedacted(booleanOf(fields[4], `${path}.redact_original`))
    .withReplacementRedacted(booleanOf(fields[5], `${path}.redact_replacement`));
}

// ---------------------------------------------------------------------------
// error mappings (source.rs:821-846)
// ---------------------------------------------------------------------------

/** The protocol mapping of a source construction failure (source.rs:821-831). */
function sourceError(path: string, error: SourceError): ProtocolError {
  const kind =
    error.kind === 'ResourceLimit' || error.kind === 'OffsetOverflow'
      ? 'ResourceLimit'
      : 'InvalidValue';
  return new ProtocolError(kind, path, error.message);
}

/** The protocol mapping of a source-patch construction failure (source.rs:833-846). */
function patchError(error: SourcePatchError): ProtocolError {
  const kind =
    error.kind === 'ResourceLimit' ||
    (error.kind === 'Source' &&
      error.source !== undefined &&
      (error.source.kind === 'ResourceLimit' || error.source.kind === 'OffsetOverflow'))
      ? 'ResourceLimit'
      : 'InvalidValue';
  return new ProtocolError(kind, '$.replacements', error.message);
}

// ---------------------------------------------------------------------------
// payload dispatch self-registration (payload.rs:159-168: the envelope
// decodes these records with SourceLimits / SourcePatchLimits defaults)
// ---------------------------------------------------------------------------

registerPayloadValidator('core.source-encoding', 1, (payload) => {
  SourceEncodingMessage.fromValue(payload);
});
registerPayloadValidator('core.source-patch', 1, (payload) => {
  SourcePatchMessage.fromValue(payload, DEFAULT_SOURCE_PATCH_LIMITS);
});
registerPayloadValidator('core.source-snapshot', 1, (payload) => {
  SourceSnapshotMessage.fromValue(payload, DEFAULT_SOURCE_LIMITS);
});
registerPayloadValidator('core.source-patch', 2, (payload) => {
  SourcePatchMessageV2.fromValue(payload, DEFAULT_SOURCE_PATCH_LIMITS);
});
registerPayloadValidator('core.source-snapshot', 2, (payload) => {
  SourceSnapshotMessageV2.fromValue(payload, DEFAULT_SOURCE_LIMITS);
});
