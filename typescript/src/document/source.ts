/**
 * Raw source ownership, encoding facts, content identity, and decoded
 * locations.
 *
 * authority:
 *  - RFC 0003 (docs/rfcs/0003-source-syntax-query-and-patch-v1.md):
 *    §3 content identity (:47-58), §4 encoding facts (:64-122) — closed v1
 *    encoding IDs (:68-77), resolution inputs and the frozen priority rule
 *    caller_override -> declaration -> bom -> profile_default (:80-107),
 *    decoding rejections (:109-122); §5 raw spans and decoded boundaries
 *    (:124-141)
 *  - vectors: conformance/vectors/source-v1.json (all 28 cases)
 *  - Rust (byte/registry arbitration): crates/consema-document/src/source.rs
 *    — ContentDigest :15-54, WindowsCodePage :56-119, SourceEncoding :121-155,
 *    BomPolicy :157-165, BomKind :166-187, EncodingRequest :189-260,
 *    EncodingFacts :262-379, SourceLimits :381-409, DecodedPosition :411-422,
 *    DecodedOffset :424-433, SourceSnapshot :476-666, SourceError :668-716,
 *    UnsupportedBomKind :718-725, resolution :727-804, decoders :806-1014,
 *    boundary index :1016-1216
 *
 * Design (TypeScript-idiomatic): SourceEncoding is a closed discriminated
 * union with constructor functions; requests are immutable builder
 * classes; the decoded boundary index mirrors the Rust checkpoint scheme
 * (stride 256, crates/consema-document/src/source.rs:13,1053) so memory
 * stays O(source/256) while lookups are O(stride). The decoded text is
 * validated exactly once at construction and retained (the O(n²)
 * formation root cause documented in source.rs:598-607 / task #53).
 */

import { ContentDigest } from './sha256.ts';
import { LocationError, SourceError } from './errors.ts';
import { MALFORMED_BYTE_SENTINEL, singleByteTableFor } from './cp_tables.ts';
import { cp932Lookup } from './cp932_table.ts';

/** One deterministic Windows code page admitted by source contract v2 (source.rs:56-119). */
export class WindowsCodePage {
  readonly #number: number;

  private constructor(number: number) {
    this.#number = number;
  }

  /** Resolves one numeric code page only when source v2 publishes it (source.rs:62-68). */
  static fromNumber(number: number): WindowsCodePage | null {
    switch (number) {
      case 874:
      case 932:
      case 936:
      case 949:
      case 950:
      case 1250:
      case 1251:
      case 1252:
      case 1253:
      case 1254:
      case 1255:
      case 1256:
      case 1257:
      case 1258:
      case 65001:
        return new WindowsCodePage(number);
      default:
        return null;
    }
  }

  /** Canonical numeric code-page identity (source.rs:71-74). */
  number(): number {
    return this.#number;
  }

  /** Stable wire identifier ("windows-1252") (source.rs:76-96). */
  name(): string {
    return `windows-${this.#number}`;
  }

  equals(other: WindowsCodePage): boolean {
    return this.#number === other.#number;
  }
}

/**
 * Closed source encoding set supported by source contracts v1 and v2
 * (source.rs:121-155). The v1 IDs are exactly Binary, Utf8, Utf16Le,
 * Utf16Be, Latin1 (RFC 0003 §4.1); WindowsCodePage is the source-v2
 * extension.
 */
export type SourceEncoding =
  | { readonly kind: 'Binary' }
  | { readonly kind: 'Utf8' }
  | { readonly kind: 'Utf16Le' }
  | { readonly kind: 'Utf16Be' }
  | { readonly kind: 'Latin1' }
  | { readonly kind: 'WindowsCodePage'; readonly codePage: WindowsCodePage };

export function binaryEncoding(): SourceEncoding {
  return { kind: 'Binary' };
}
export function utf8Encoding(): SourceEncoding {
  return { kind: 'Utf8' };
}
export function utf16LeEncoding(): SourceEncoding {
  return { kind: 'Utf16Le' };
}
export function utf16BeEncoding(): SourceEncoding {
  return { kind: 'Utf16Be' };
}
export function latin1Encoding(): SourceEncoding {
  return { kind: 'Latin1' };
}
export function windowsCodePageEncoding(page: WindowsCodePage): SourceEncoding {
  return { kind: 'WindowsCodePage', codePage: page };
}

/** Stable wire identifier ("binary", "utf-8", "utf-16le", "utf-16be", "latin-1", "windows-1252") (source.rs:138-150). */
export function encodingAsStr(encoding: SourceEncoding): string {
  switch (encoding.kind) {
    case 'Binary':
      return 'binary';
    case 'Utf8':
      return 'utf-8';
    case 'Utf16Le':
      return 'utf-16le';
    case 'Utf16Be':
      return 'utf-16be';
    case 'Latin1':
      return 'latin-1';
    case 'WindowsCodePage':
      return encoding.codePage.name();
  }
}

/** Whether the encoding has a decoded-text view (source.rs:152-154). */
export function encodingIsText(encoding: SourceEncoding): boolean {
  return encoding.kind !== 'Binary';
}

function encodingEquals(left: SourceEncoding, right: SourceEncoding): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'WindowsCodePage' && right.kind === 'WindowsCodePage') {
    return left.codePage.equals(right.codePage);
  }
  return true;
}

/** Whether marker-shaped leading bytes participate in Unicode BOM resolution (source.rs:157-165). */
export type BomPolicy = 'DetectUnicode' | 'TreatAsContent';

/** Recognized Unicode byte-order mark (source.rs:166-187). */
export type BomKind = 'Utf8' | 'Utf16Le' | 'Utf16Be';

/** Encoding asserted by one marker (source.rs:177-187). */
export function bomKindEncoding(kind: BomKind): SourceEncoding {
  switch (kind) {
    case 'Utf8':
      return utf8Encoding();
    case 'Utf16Le':
      return utf16LeEncoding();
    case 'Utf16Be':
      return utf16BeEncoding();
  }
}

/** Caller inputs to deterministic encoding resolution (source.rs:189-260). */
export class EncodingRequest {
  readonly #profileDefault: SourceEncoding;
  readonly #bomPolicy: BomPolicy;
  readonly #declaration: SourceEncoding | null;
  readonly #callerOverride: SourceEncoding | null;

  private constructor(
    profileDefault: SourceEncoding,
    bomPolicy: BomPolicy,
    declaration: SourceEncoding | null,
    callerOverride: SourceEncoding | null,
  ) {
    this.#profileDefault = profileDefault;
    this.#bomPolicy = bomPolicy;
    this.#declaration = declaration;
    this.#callerOverride = callerOverride;
  }

  /** Starts with the required profile default and no higher-priority facts (source.rs:198-207). */
  static create(profileDefault: SourceEncoding): EncodingRequest {
    return new EncodingRequest(profileDefault, 'DetectUnicode', null, null);
  }

  /** Opaque-binary request (source.rs:209-214). */
  static binary(): EncodingRequest {
    return EncodingRequest.create(binaryEncoding());
  }

  /** Adds a normalized declaration supplied by the format layer (source.rs:216-221). */
  withDeclaration(declaration: SourceEncoding): EncodingRequest {
    return new EncodingRequest(this.#profileDefault, this.#bomPolicy, declaration, this.#callerOverride);
  }

  /** Adds an explicit caller override (source.rs:223-228). */
  withCallerOverride(callerOverride: SourceEncoding): EncodingRequest {
    return new EncodingRequest(this.#profileDefault, this.#bomPolicy, this.#declaration, callerOverride);
  }

  /**
   * Internal: applies a possibly-absent declaration. Exposed for
   * `EncodingFacts.resolutionRequest`; callers use `withDeclaration`.
   */
  withDeclarationOrNull(declaration: SourceEncoding | null): EncodingRequest {
    return new EncodingRequest(this.#profileDefault, this.#bomPolicy, declaration, this.#callerOverride);
  }

  /**
   * Internal: applies a possibly-absent caller override. Exposed for
   * `EncodingFacts.resolutionRequest`; callers use `withCallerOverride`.
   */
  withCallerOverrideOrNull(callerOverride: SourceEncoding | null): EncodingRequest {
    return new EncodingRequest(this.#profileDefault, this.#bomPolicy, this.#declaration, callerOverride);
  }

  /** Selects whether leading marker-shaped bytes are BOM evidence or content (source.rs:230-235). */
  withBomPolicy(bomPolicy: BomPolicy): EncodingRequest {
    return new EncodingRequest(this.#profileDefault, bomPolicy, this.#declaration, this.#callerOverride);
  }

  /** Profile fallback (source.rs:237-241). */
  profileDefault(): SourceEncoding {
    return this.#profileDefault;
  }

  /** BOM interpretation policy (source.rs:243-247). */
  bomPolicy(): BomPolicy {
    return this.#bomPolicy;
  }

  /** Normalized in-source declaration, when one exists (source.rs:249-253). */
  declaration(): SourceEncoding | null {
    return this.#declaration;
  }

  /** Explicit caller choice, when one exists (source.rs:255-259). */
  callerOverride(): SourceEncoding | null {
    return this.#callerOverride;
  }
}

/** Complete, auditable result of encoding resolution (source.rs:262-379). */
export class EncodingFacts {
  readonly #profileDefault: SourceEncoding;
  readonly #bomPolicy: BomPolicy;
  readonly #bom: BomKind | null;
  readonly #declaration: SourceEncoding | null;
  readonly #callerOverride: SourceEncoding | null;
  readonly #selected: SourceEncoding;

  /**
   * @internal — construction is normally via `fromClaim`/
   * `fromClaimWithBomPolicy` or `SourceSnapshot.fromRaw`; the resolution
   * pipeline inside this module is the only other construction site.
   */
  constructor(
    profileDefault: SourceEncoding,
    bomPolicy: BomPolicy,
    bom: BomKind | null,
    declaration: SourceEncoding | null,
    callerOverride: SourceEncoding | null,
    selected: SourceEncoding,
  ) {
    this.#profileDefault = profileDefault;
    this.#bomPolicy = bomPolicy;
    this.#bom = bom;
    this.#declaration = declaration;
    this.#callerOverride = callerOverride;
    this.#selected = selected;
  }

  /**
   * Validates a structurally complete encoding-facts claim (source.rs:274-300).
   * Proves resolution consistency only; a source decoder must still verify
   * that the claimed BOM is present in the supplied raw bytes.
   */
  static fromClaim(
    profileDefault: SourceEncoding,
    bom: BomKind | null,
    declaration: SourceEncoding | null,
    callerOverride: SourceEncoding | null,
    selected: SourceEncoding,
  ): EncodingFacts {
    return EncodingFacts.fromClaimWithBomPolicy(
      profileDefault,
      'DetectUnicode',
      bom,
      declaration,
      callerOverride,
      selected,
    );
  }

  /** Validates a source-v2 claim including explicit BOM interpretation (source.rs:302-333). */
  static fromClaimWithBomPolicy(
    profileDefault: SourceEncoding,
    bomPolicy: BomPolicy,
    bom: BomKind | null,
    declaration: SourceEncoding | null,
    callerOverride: SourceEncoding | null,
    selected: SourceEncoding,
  ): EncodingFacts {
    if (bomPolicy === 'TreatAsContent' && bom !== null) {
      throw encodingConflict(bom, declaration, callerOverride);
    }
    const resolved = resolveAssertions(
      { profileDefault, bomPolicy, declaration, callerOverride },
      bom,
    );
    if (!encodingEquals(resolved.selected(), selected)) {
      throw encodingConflict(bom, declaration, callerOverride);
    }
    return resolved;
  }

  /** Profile fallback that participated in resolution (source.rs:336-339). */
  profileDefault(): SourceEncoding {
    return this.#profileDefault;
  }

  /** BOM interpretation policy used for this source (source.rs:341-344). */
  bomPolicy(): BomPolicy {
    return this.#bomPolicy;
  }

  /** Recognized byte-order mark (source.rs:346-351). */
  bom(): BomKind | null {
    return this.#bom;
  }

  /** Normalized in-source declaration (source.rs:353-357). */
  declaration(): SourceEncoding | null {
    return this.#declaration;
  }

  /** Explicit caller override (source.rs:359-363). */
  callerOverride(): SourceEncoding | null {
    return this.#callerOverride;
  }

  /** Encoding selected by the frozen priority rule (source.rs:365-369). */
  selected(): SourceEncoding {
    return this.#selected;
  }

  /** The request that produced these facts (source.rs:371-378). */
  resolutionRequest(): EncodingRequest {
    return EncodingRequest.create(this.#profileDefault)
      .withBomPolicy(this.#bomPolicy)
      .withDeclarationOrNull(this.#declaration)
      .withCallerOverrideOrNull(this.#callerOverride);
  }

  equals(other: EncodingFacts): boolean {
    return (
      encodingEquals(this.#profileDefault, other.#profileDefault) &&
      this.#bomPolicy === other.#bomPolicy &&
      this.#bom === other.#bom &&
      encodingEqualsNullable(this.#declaration, other.#declaration) &&
      encodingEqualsNullable(this.#callerOverride, other.#callerOverride) &&
      encodingEquals(this.#selected, other.#selected)
    );
  }
}

function encodingEqualsNullable(
  left: SourceEncoding | null,
  right: SourceEncoding | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return encodingEquals(left, right);
}

/** Resource bounds applied while a source snapshot is constructed (source.rs:381-409). */
export interface SourceLimits {
  /** Maximum retained raw bytes. */
  readonly maxRawBytes: number;
  /** Maximum decoded UTF-8 bytes. */
  readonly maxDecodedUtf8Bytes: number;
  /** Maximum decoded Unicode scalar values. */
  readonly maxDecodedScalars: number;
}

/** The frozen defaults (source.rs:401-409): 64 MiB raw, 128 MiB decoded UTF-8, 64 MiB scalars. */
export const DEFAULT_SOURCE_LIMITS: Readonly<SourceLimits> = Object.freeze({
  maxRawBytes: 64 * 1024 * 1024,
  maxDecodedUtf8Bytes: 128 * 1024 * 1024,
  maxDecodedScalars: 64 * 1024 * 1024,
});

/**
 * Compatibility limits for already-bounded format parsers (source.rs:392-399).
 * The Rust value is usize::MAX, which a JS number cannot represent; the
 * largest safe integer is the closest faithful equivalent.
 */
export const UNBOUNDED_SOURCE_LIMITS: Readonly<SourceLimits> = Object.freeze({
  maxRawBytes: Number.MAX_SAFE_INTEGER,
  maxDecodedUtf8Bytes: Number.MAX_SAFE_INTEGER,
  maxDecodedScalars: Number.MAX_SAFE_INTEGER,
});

/** One exact boundary expressed in every supported coordinate system (source.rs:411-422). */
export interface DecodedPosition {
  /** Offset in retained raw source bytes. */
  readonly rawByte: number;
  /** Offset in the UTF-8 representation of decoded text. */
  readonly decodedUtf8Byte: number;
  /** Number of decoded Unicode scalar values. */
  readonly unicodeScalarOffset: number;
  /** Number of UTF-16 code units in decoded text. */
  readonly utf16CodeUnitOffset: number;
}

export function decodedPositionEquals(left: DecodedPosition, right: DecodedPosition): boolean {
  return (
    left.rawByte === right.rawByte &&
    left.decodedUtf8Byte === right.decodedUtf8Byte &&
    left.unicodeScalarOffset === right.unicodeScalarOffset &&
    left.utf16CodeUnitOffset === right.utf16CodeUnitOffset
  );
}

/** A decoded coordinate to resolve back to an exact raw-byte boundary (source.rs:424-433). */
export type DecodedOffset =
  | { readonly kind: 'Utf8Byte'; readonly value: number }
  | { readonly kind: 'UnicodeScalar'; readonly value: number }
  | { readonly kind: 'Utf16CodeUnit'; readonly value: number };

export function utf8ByteOffset(value: number): DecodedOffset {
  return { kind: 'Utf8Byte', value };
}
export function unicodeScalarOffset(value: number): DecodedOffset {
  return { kind: 'UnicodeScalar', value };
}
export function utf16CodeUnitOffset(value: number): DecodedOffset {
  return { kind: 'Utf16CodeUnit', value };
}

/** Checkpoint stride of the decoded boundary index (source.rs:13). */
const CHECKPOINT_STRIDE = 256;

/** One boundary checkpoint plus the terminal position (source.rs:458-463). */
interface DecodedIndex {
  readonly checkpoints: readonly DecodedPosition[];
  readonly terminal: DecodedPosition;
}

/** Per-scalar raw byte width for variable-width code-page decoding. */
type Widths = readonly number[] | null;

/** Immutable ownership of exact raw bytes plus explicitly derived text facts (source.rs:476-484). */
export class SourceSnapshot {
  readonly #bytes: Uint8Array;
  readonly #digest: ContentDigest;
  readonly #encoding: EncodingFacts;
  readonly #decodedText: string | null;
  readonly #index: DecodedIndex | null;

  private constructor(
    bytes: Uint8Array,
    digest: ContentDigest,
    encoding: EncodingFacts,
    decodedText: string | null,
    index: DecodedIndex | null,
  ) {
    this.#bytes = bytes;
    this.#digest = digest;
    this.#encoding = encoding;
    this.#decodedText = decodedText;
    this.#index = index;
  }

  /** Constructs a source from raw bytes using explicit resolution inputs and limits (source.rs:486-550). */
  static fromRaw(
    bytes: Uint8Array,
    request: EncodingRequest,
    limits: SourceLimits,
  ): SourceSnapshot {
    if (bytes.length > limits.maxRawBytes) {
      throw new SourceError('ResourceLimit', {
        limitName: 'raw-bytes',
        observed: bytes.length,
        limit: limits.maxRawBytes,
      });
    }
    // V8 forbids Object.freeze on non-empty typed arrays (TypeError: Cannot
    // freeze array buffer views with elements); immutability is enforced
    // logically — the snapshot owns its private copy and accessors are
    // read-only by contract (source.rs:578-582).
    const owned = Uint8Array.from(bytes);
    const encoding = resolveEncoding(owned, request);
    const digest = ContentDigest.of(owned);
    const selected = encoding.selected();

    let decodedText: string | null;
    let widths: Widths = null;
    switch (selected.kind) {
      case 'Binary':
        decodedText = null;
        break;
      case 'Utf8': {
        const result = decodeUtf8(owned, limits);
        decodedText = result.text;
        widths = result.widths;
        break;
      }
      case 'Utf16Le':
        decodedText = decodeUtf16(owned, true, limits);
        break;
      case 'Utf16Be':
        decodedText = decodeUtf16(owned, false, limits);
        break;
      case 'Latin1':
        decodedText = decodeLatin1(owned, limits);
        break;
      case 'WindowsCodePage': {
        const result = decodeCodePage(owned, selected.codePage, limits);
        decodedText = result.text;
        widths = result.widths;
        break;
      }
    }

    const index =
      decodedText === null
        ? null
        : buildIndex(decodedText, encoding.selected(), owned.length, limits, widths);

    return new SourceSnapshot(owned, digest, encoding, decodedText, index);
  }

  /** Compatibility constructor for exact UTF-8 sources (source.rs:551-568). */
  static fromUtf8(bytes: Uint8Array): SourceSnapshot {
    try {
      return SourceSnapshot.fromRaw(
        bytes,
        EncodingRequest.create(utf8Encoding()).withCallerOverride(utf8Encoding()),
        UNBOUNDED_SOURCE_LIMITS,
      );
    } catch (error) {
      if (
        error instanceof SourceError &&
        error.kind === 'InvalidSequence' &&
        error.encoding === 'utf-8'
      ) {
        throw new SourceError('InvalidUtf8', { validUpTo: error.byteOffset });
      }
      throw error;
    }
  }

  /** Constructs an opaque binary source without decoding or BOM interpretation (source.rs:569-576). */
  static fromBinary(bytes: Uint8Array, limits: SourceLimits): SourceSnapshot {
    return SourceSnapshot.fromRaw(bytes, EncodingRequest.binary(), limits);
  }

  /** Exact retained source bytes; returns a defensive copy each call so callers can never mutate the snapshot's internal buffer (source.rs:578-582; Kotlin `raw.copyOf()` precedent). */
  bytes(): Uint8Array {
    return this.#bytes.slice();
  }

  /** Stable SHA-256 identity of exact retained bytes (source.rs:584-588). */
  digest(): ContentDigest {
    return this.#digest;
  }

  /** Complete encoding-resolution facts (source.rs:590-594). */
  encodingFacts(): EncodingFacts {
    return this.#encoding;
  }

  /**
   * Decoded text, or null for an opaque binary source (source.rs:596-608).
   * Fully validated exactly once at construction; each call returns the
   * stored view in O(1).
   */
  decodedText(): string | null {
    return this.#decodedText;
  }

  /** Source byte length (source.rs:610-614). */
  len(): number {
    return this.#bytes.length;
  }

  /** Whether the source is empty (source.rs:616-620). */
  isEmpty(): boolean {
    return this.#bytes.length === 0;
  }

  /** Resolves one raw byte offset only when it is a decoded scalar boundary (source.rs:622-641). */
  decodedPosition(rawByte: number): DecodedPosition {
    if (rawByte > this.#bytes.length) {
      throw new LocationError('OutOfBounds');
    }
    const index = this.#index;
    if (index === null) {
      throw new LocationError('NoDecodedText');
    }
    const checkpoint = lastCheckpoint(index.checkpoints, (position) => position.rawByte <= rawByte);
    return scanToRaw(this.#decodedText!, this.#encoding.selected(), checkpoint, rawByte);
  }

  /** Resolves one decoded offset only when it denotes a scalar boundary (source.rs:642-665). */
  rawByteAt(offset: DecodedOffset): number {
    const index = this.#index;
    if (index === null) {
      throw new LocationError('NoDecodedText');
    }
    const requested = offsetComponentFromOffset(offset);
    const terminalComponent = offsetComponent(index.terminal, offset);
    if (requested > terminalComponent) {
      throw new LocationError('OutOfBounds');
    }
    const checkpoint = lastCheckpoint(index.checkpoints, (position) => {
      return offsetComponent(position, offset) <= requested;
    });
    const position = scanToDecoded(this.#decodedText!, this.#encoding.selected(), checkpoint, offset);
    return position.rawByte;
  }
}

// ---------------------------------------------------------------------------
// Encoding resolution (source.rs:727-804; RFC 0003 §4.2)
// ---------------------------------------------------------------------------

interface ResolutionInputs {
  profileDefault: SourceEncoding;
  bomPolicy: BomPolicy;
  declaration: SourceEncoding | null;
  callerOverride: SourceEncoding | null;
}

function resolveEncoding(bytes: Uint8Array, request: EncodingRequest): EncodingFacts {
  const declaration = request.declaration();
  const callerOverride = request.callerOverride();
  const hasExplicitText =
    (declaration !== null && encodingIsText(declaration)) ||
    (callerOverride !== null && encodingIsText(callerOverride));
  const interpretBom =
    request.bomPolicy() === 'DetectUnicode' &&
    (encodingIsText(request.profileDefault()) || hasExplicitText);
  const bom = interpretBom ? detectBom(bytes) : null;
  return resolveAssertions(
    {
      profileDefault: request.profileDefault(),
      bomPolicy: request.bomPolicy(),
      declaration: request.declaration(),
      callerOverride: request.callerOverride(),
    },
    bom,
  );
}

/** Frozen priority rule: caller_override -> declaration -> bom -> profile_default (RFC 0003 §4.2; source.rs:740-782). */
function resolveAssertions(inputs: ResolutionInputs, bom: BomKind | null): EncodingFacts {
  const bomEncoding = bom === null ? null : bomKindEncoding(bom);
  if (
    inputs.profileDefault.kind === 'Binary' &&
    ((inputs.declaration !== null && encodingIsText(inputs.declaration)) ||
      (inputs.callerOverride !== null && encodingIsText(inputs.callerOverride)))
  ) {
    throw encodingConflict(bom, inputs.declaration, inputs.callerOverride);
  }
  const assertions = [
    bomEncoding,
    inputs.declaration,
    inputs.callerOverride,
  ].filter((encoding): encoding is SourceEncoding => encoding !== null);
  if (assertions.length > 1) {
    const expected = assertions[0];
    if (assertions.some((encoding) => !encodingEquals(encoding, expected))) {
      throw encodingConflict(bom, inputs.declaration, inputs.callerOverride);
    }
  }
  const selected =
    inputs.callerOverride ??
    inputs.declaration ??
    bomEncoding ??
    inputs.profileDefault;
  return new EncodingFacts(
    inputs.profileDefault,
    inputs.bomPolicy,
    bom,
    inputs.declaration,
    inputs.callerOverride,
    selected,
  );
}

function encodingConflict(
  bom: BomKind | null,
  declaration: SourceEncoding | null,
  callerOverride: SourceEncoding | null,
): SourceError {
  return new SourceError('EncodingConflict', {
    bom: bom === null ? undefined : encodingAsStr(bomKindEncoding(bom)),
    declaration: declaration === null ? undefined : encodingAsStr(declaration),
    callerOverride: callerOverride === null ? undefined : encodingAsStr(callerOverride),
  });
}

/** Recognizes the frozen BOM set and rejects UTF-32 markers (source.rs:784-804). */
function detectBom(bytes: Uint8Array): BomKind | null {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xfe &&
    bytes[2] === 0x00 &&
    bytes[3] === 0x00
  ) {
    throw new SourceError('UnsupportedBom', { unsupportedBom: 'Utf32Le' });
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x00 &&
    bytes[2] === 0xfe &&
    bytes[3] === 0xff
  ) {
    throw new SourceError('UnsupportedBom', { unsupportedBom: 'Utf32Be' });
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return 'Utf8';
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return 'Utf16Le';
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return 'Utf16Be';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Decoders (source.rs:806-1014)
// ---------------------------------------------------------------------------

/** Strict UTF-8 decode with per-scalar raw widths; throws InvalidSequence at the first bad byte. */
function decodeUtf8(bytes: Uint8Array, limits: SourceLimits): { text: string; widths: number[] } {
  const output: string[] = [];
  const widths: number[] = [];
  let decodedUtf8Bytes = 0;
  let offset = 0;
  while (offset < bytes.length) {
    const scalar = utf8ScalarAt(bytes, offset);
    if (scalar === null) {
      throw new SourceError('InvalidSequence', { encoding: 'utf-8', byteOffset: offset });
    }
    checkScalarLimits(decodedUtf8Bytes, widths.length, scalar.character, limits);
    output.push(scalar.character);
    widths.push(scalar.width);
    decodedUtf8Bytes += utf8Width(scalar.character);
    offset += scalar.width;
  }
  return { text: output.join(''), widths };
}

interface Utf8Scalar {
  readonly character: string;
  readonly width: number;
}

/** Strict single-scalar UTF-8 read (length rules, continuation bytes, overlong/surrogate/range exclusions). */
function utf8ScalarAt(bytes: Uint8Array, offset: number): Utf8Scalar | null {
  const b0 = bytes[offset];
  let width: number;
  let min: number;
  let max: number;
  if (b0 < 0x80) {
    return { character: String.fromCodePoint(b0), width: 1 };
  } else if (b0 >= 0xc2 && b0 <= 0xdf) {
    width = 2;
    min = 0x80;
    max = 0x7ff;
  } else if (b0 >= 0xe0 && b0 <= 0xef) {
    width = 3;
    min = 0x800;
    max = 0xffff;
  } else if (b0 >= 0xf0 && b0 <= 0xf4) {
    width = 4;
    min = 0x10000;
    max = 0x10ffff;
  } else {
    return null;
  }
  if (offset + width > bytes.length) {
    return null;
  }
  for (let k = 1; k < width; k++) {
    if ((bytes[offset + k] & 0xc0) !== 0x80) {
      return null;
    }
  }
  let scalar: number;
  switch (width) {
    case 2:
      scalar = ((b0 & 0x1f) << 6) | (bytes[offset + 1] & 0x3f);
      break;
    case 3:
      scalar = ((b0 & 0x0f) << 12) | ((bytes[offset + 1] & 0x3f) << 6) | (bytes[offset + 2] & 0x3f);
      break;
    default:
      scalar =
        ((b0 & 0x07) << 18) |
        ((bytes[offset + 1] & 0x3f) << 12) |
        ((bytes[offset + 2] & 0x3f) << 6) |
        (bytes[offset + 3] & 0x3f);
      break;
  }
  if (scalar < min || scalar > max || (scalar >= 0xd800 && scalar <= 0xdfff)) {
    return null;
  }
  return { character: String.fromCodePoint(scalar), width };
}

function checkScalarLimits(decodedUtf8Bytes: number, scalars: number, character: string, limits: SourceLimits): void {
  // decodedUtf8Bytes counts UTF-8 bytes, so each scalar adds its UTF-8
  // byte width — character.length is the UTF-16 unit count and undercounts
  // every non-ASCII scalar (e.g. 'é' is 1 unit but 2 bytes).
  const nextUtf8 = decodedUtf8Bytes + utf8Width(character);
  if (nextUtf8 > limits.maxDecodedUtf8Bytes) {
    throw new SourceError('ResourceLimit', {
      limitName: 'decoded-utf8-bytes',
      observed: nextUtf8,
      limit: limits.maxDecodedUtf8Bytes,
    });
  }
  const nextScalars = scalars + 1;
  if (nextScalars > limits.maxDecodedScalars) {
    throw new SourceError('ResourceLimit', {
      limitName: 'decoded-scalars',
      observed: nextScalars,
      limit: limits.maxDecodedScalars,
    });
  }
}

/** Strict UTF-16 decode (source.rs:806-869): odd length, isolated or reversed surrogates are rejected. */
function decodeUtf16(bytes: Uint8Array, littleEndian: boolean, limits: SourceLimits): string {
  const encoding = littleEndian ? 'utf-16le' : 'utf-16be';
  if (bytes.length % 2 !== 0) {
    throw new SourceError('InvalidSequence', { encoding, byteOffset: bytes.length - 1 });
  }
  const output: string[] = [];
  let offset = 0;
  let decodedUtf8Bytes = 0;
  let scalars = 0;
  while (offset < bytes.length) {
    const first = readU16(bytes, offset, littleEndian);
    let scalar: number;
    let consumed: number;
    if (first >= 0xd800 && first <= 0xdbff) {
      if (offset + 3 >= bytes.length) {
        throw new SourceError('InvalidSequence', { encoding, byteOffset: offset });
      }
      const second = readU16(bytes, offset + 2, littleEndian);
      if (!(second >= 0xdc00 && second <= 0xdfff)) {
        throw new SourceError('InvalidSequence', { encoding, byteOffset: offset });
      }
      scalar = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
      consumed = 4;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      throw new SourceError('InvalidSequence', { encoding, byteOffset: offset });
    } else {
      scalar = first;
      consumed = 2;
    }
    const character = String.fromCodePoint(scalar);
    checkScalarLimits(decodedUtf8Bytes, scalars, character, limits);
    output.push(character);
    decodedUtf8Bytes += utf8Width(character);
    scalars++;
    offset += consumed;
  }
  return output.join('');
}

function readU16(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  const high = littleEndian ? bytes[offset + 1] : bytes[offset];
  const low = littleEndian ? bytes[offset] : bytes[offset + 1];
  return (high << 8) | low;
}

/** ISO-8859-1 byte-to-scalar decode (source.rs:880-894). */
function decodeLatin1(bytes: Uint8Array, limits: SourceLimits): string {
  const output: string[] = [];
  let decodedUtf8Bytes = 0;
  for (const byte of bytes) {
    const character = String.fromCodePoint(byte);
    checkScalarLimits(decodedUtf8Bytes, output.length, character, limits);
    output.push(character);
    decodedUtf8Bytes += utf8Width(character);
  }
  return output.join('');
}

/**
 * Decodes one frozen Windows code page strictly (source.rs:901-1014;
 * go/document/source.go:571-712).
 *
 * cp65001 decodes as strict UTF-8; the nine single-byte pages (874,
 * 1250-1258) decode through the frozen encoding_rs-derived tables with the
 * malformed sentinel 0xFFFF failing the whole source (InvalidSequence);
 * cp932 decodes through the frozen single-scalar two-byte table
 * (go/document/source.go:612-649, 714-722; cp932_table.ts). The remaining
 * multi-byte pages 936, 949, 950 are recognized but not decoded and are
 * rejected with InvalidSequence at byte 0 — Go documents the same
 * rejection for 936, 949, 950 (go/document/source.go:574-588); Rust
 * decodes all four through encoding_rs.
 */
function decodeCodePage(
  bytes: Uint8Array,
  page: WindowsCodePage,
  limits: SourceLimits,
): { text: string; widths: number[] } {
  const pageNumber = page.number();
  if (pageNumber === 65001) {
    return decodeUtf8(bytes, limits);
  }
  if (pageNumber === 932) {
    return decodeCP932(bytes, page, limits);
  }
  const table = singleByteTableFor(pageNumber);
  if (table === null) {
    // 936, 949, 950: recognized but not decoded (see above).
    throw new SourceError('InvalidSequence', {
      encoding: page.name(),
      byteOffset: 0,
    });
  }
  const output: string[] = [];
  const widths: number[] = [];
  let decodedUtf8Bytes = 0;
  for (let offset = 0; offset < bytes.length; offset++) {
    const byte = bytes[offset];
    let scalar = byte;
    if (byte >= 0x80) {
      scalar = table[byte - 0x80];
      if (scalar === MALFORMED_BYTE_SENTINEL) {
        throw new SourceError('InvalidSequence', {
          encoding: page.name(),
          byteOffset: offset,
        });
      }
    }
    const character = String.fromCodePoint(scalar);
    checkScalarLimits(decodedUtf8Bytes, output.length, character, limits);
    output.push(character);
    widths.push(1);
    decodedUtf8Bytes += utf8Width(character);
  }
  return { text: output.join(''), widths };
}

/**
 * Decodes cp932 exactly as go/document/source.go:612-649: ASCII single
 * bytes, half-width katakana 0xA1-0xDF, and the frozen single-scalar
 * two-byte table (an unknown or truncated two-byte code fails the whole
 * source with InvalidSequence at the lead byte).
 */
function decodeCP932(
  bytes: Uint8Array,
  page: WindowsCodePage,
  limits: SourceLimits,
): { text: string; widths: number[] } {
  const output: string[] = [];
  const widths: number[] = [];
  let decodedUtf8Bytes = 0;
  let offset = 0;
  while (offset < bytes.length) {
    const start = offset;
    let scalar: number;
    const byte = bytes[offset];
    if (byte < 0x80) {
      scalar = byte;
      offset += 1;
    } else if (byte >= 0xa1 && byte <= 0xdf) {
      scalar = byte - 0xa1 + 0xff61;
      offset += 1;
    } else if (offset + 1 < bytes.length) {
      const code = (byte << 8) | bytes[offset + 1];
      const resolved = cp932Lookup(code);
      if (resolved === null) {
        throw new SourceError('InvalidSequence', {
          encoding: page.name(),
          byteOffset: start,
        });
      }
      scalar = resolved;
      offset += 2;
    } else {
      throw new SourceError('InvalidSequence', {
        encoding: page.name(),
        byteOffset: start,
      });
    }
    const character = String.fromCodePoint(scalar);
    checkScalarLimits(decodedUtf8Bytes, output.length, character, limits);
    output.push(character);
    widths.push(offset - start);
    decodedUtf8Bytes += utf8Width(character);
  }
  return { text: output.join(''), widths };
}

// ---------------------------------------------------------------------------
// Decoded boundary index (source.rs:1016-1216)
// ---------------------------------------------------------------------------

/** Builds checkpoints every 256 scalars plus the terminal position (source.rs:1016-1067). */
function buildIndex(
  text: string,
  encoding: SourceEncoding,
  rawLen: number,
  limits: SourceLimits,
  widths: Widths,
): DecodedIndex {
  // text.length counts UTF-16 code units, NOT decoded UTF-8 bytes, so the
  // limit check below measures the text's UTF-8 byte length directly.
  let codePoints = 0;
  let utf8Bytes = 0;
  for (const character of text) {
    codePoints++;
    utf8Bytes += utf8Width(character);
  }
  if (utf8Bytes > limits.maxDecodedUtf8Bytes) {
    throw new SourceError('ResourceLimit', {
      limitName: 'decoded-utf8-bytes',
      observed: utf8Bytes,
      limit: limits.maxDecodedUtf8Bytes,
    });
  }
  // The widths array has one entry per decoded scalar (code point), while
  // text.length counts UTF-16 code units; compare against the code-point
  // count (source.rs:1035-1039 compares against `text.chars().count()`).
  if (widths !== null && widths.length !== codePoints) {
    throw new SourceError('OffsetOverflow');
  }
  const checkpoints: DecodedPosition[] = [{ rawByte: 0, decodedUtf8Byte: 0, unicodeScalarOffset: 0, utf16CodeUnitOffset: 0 }];
  let current: DecodedPosition = {
    rawByte: 0,
    decodedUtf8Byte: 0,
    unicodeScalarOffset: 0,
    utf16CodeUnitOffset: 0,
  };
  let scalarIndex = 0;
  for (const character of text) {
    const rawWidth =
      widths !== null ? widths[scalarIndex] : rawStepWidth(encoding, character);
    if (current.unicodeScalarOffset + 1 > limits.maxDecodedScalars) {
      throw new SourceError('ResourceLimit', {
        limitName: 'decoded-scalars',
        observed: current.unicodeScalarOffset + 1,
        limit: limits.maxDecodedScalars,
      });
    }
    current = advancePosition(current, character, rawWidth);
    scalarIndex++;
    if (current.unicodeScalarOffset % CHECKPOINT_STRIDE === 0) {
      checkpoints.push(current);
    }
  }
  const last = checkpoints[checkpoints.length - 1];
  if (
    last.rawByte !== current.rawByte ||
    last.decodedUtf8Byte !== current.decodedUtf8Byte ||
    last.unicodeScalarOffset !== current.unicodeScalarOffset ||
    last.utf16CodeUnitOffset !== current.utf16CodeUnitOffset
  ) {
    checkpoints.push(current);
  }
  if (current.rawByte !== rawLen) {
    throw new SourceError('OffsetOverflow');
  }
  return { checkpoints, terminal: current };
}

function advancePosition(
  position: DecodedPosition,
  character: string,
  rawWidth: number,
): DecodedPosition {
  // character.length is the UTF-16 code-unit count (1 for BMP, 2 for
  // astral) and drives the utf16CodeUnitOffset increment exactly
  // (source.rs:1069-1080). decodedUtf8Byte must instead advance by the
  // scalar's UTF-8 byte width: the two coordinate systems differ for every
  // non-ASCII scalar ('é' is 1 unit but 2 bytes), and decodedUtf8Byte is a
  // byte offset into the UTF-8 representation of the decoded text — counting
  // UTF-16 units there drifts the boundary index from the raw bytes.
  return {
    rawByte: position.rawByte + rawWidth,
    decodedUtf8Byte: position.decodedUtf8Byte + utf8Width(character),
    unicodeScalarOffset: position.unicodeScalarOffset + 1,
    utf16CodeUnitOffset: position.utf16CodeUnitOffset + character.length,
  };
}

/**
 * Raw byte width of one scalar in a fixed-width encoding (source.rs:1159-1181).
 * Code pages decode to fixed raw widths: the single-byte pages (874,
 * 1250-1258) are width 1, cp65001 is the UTF-8 width, and cp932 is width 1
 * for ASCII and half-width katakana (0xA1-0xDF → 0xFF61-0xFF9F) and width 2
 * for every two-byte table scalar (go/document/source.go:612-649).
 */
function rawStepWidth(encoding: SourceEncoding, character: string): number {
  switch (encoding.kind) {
    case 'Utf8':
      return utf8Width(character);
    case 'Utf16Le':
    case 'Utf16Be':
      return character.length === 2 ? 4 : 2;
    case 'Latin1':
      return 1;
    case 'WindowsCodePage': {
      const pageNumber = encoding.codePage.number();
      if (pageNumber === 65001) {
        return utf8Width(character);
      }
      if (pageNumber === 932) {
        const codePoint = character.codePointAt(0)!;
        return codePoint < 0x80 || (codePoint >= 0xff61 && codePoint <= 0xff9f) ? 1 : 2;
      }
      return 1;
    }
    case 'Binary':
      // Binary has no decoded locations.
      throw new Error(`internal: binary source has no decoded locations`);
  }
}

/** UTF-8 byte width of one BMP/astral character (surrogate pairs are never stored raw). */
function utf8Width(character: string): number {
  const codePoint = character.codePointAt(0)!;
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

function offsetComponent(position: DecodedPosition, offset: DecodedOffset): number {
  switch (offset.kind) {
    case 'Utf8Byte':
      return position.decodedUtf8Byte;
    case 'UnicodeScalar':
      return position.unicodeScalarOffset;
    case 'Utf16CodeUnit':
      return position.utf16CodeUnitOffset;
  }
}

function offsetComponentFromOffset(offset: DecodedOffset): number {
  return offset.value;
}

function lastCheckpoint(
  checkpoints: readonly DecodedPosition[],
  predicate: (position: DecodedPosition) => boolean,
): DecodedPosition {
  let low = 0;
  let high = checkpoints.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (predicate(checkpoints[mid])) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return checkpoints[Math.max(0, low - 1)];
}

/** Scans forward from one checkpoint to a raw byte boundary (source.rs:1090-1116). */
function scanToRaw(
  text: string,
  encoding: SourceEncoding,
  checkpoint: DecodedPosition,
  requested: number,
): DecodedPosition {
  let position = checkpoint;
  if (position.rawByte === requested) {
    return position;
  }
  // Slice by the UTF-16 code-unit offset, the exact JS string index:
  // decodedUtf8Byte is a byte offset into the text's UTF-8 encoding and is
  // not a valid string index for non-ASCII text.
  for (const character of text.slice(checkpoint.utf16CodeUnitOffset)) {
    const rawWidth = rawStepWidth(encoding, character);
    position = advancePosition(position, character, rawWidth);
    if (position.rawByte === requested) {
      return position;
    }
    if (position.rawByte > requested) {
      throw new LocationError('NotDecodedBoundary');
    }
  }
  throw new LocationError('OutOfBounds');
}

/** Scans forward from one checkpoint to a decoded-coordinate boundary (source.rs:1118-1150). */
function scanToDecoded(
  text: string,
  encoding: SourceEncoding,
  checkpoint: DecodedPosition,
  requested: DecodedOffset,
): DecodedPosition {
  const target = offsetComponentFromOffset(requested);
  let position = checkpoint;
  if (offsetComponent(position, requested) === target) {
    return position;
  }
  // Slice by the UTF-16 code-unit offset, the exact JS string index (see
  // scanToRaw: decodedUtf8Byte is a UTF-8 byte offset, not a string index).
  for (const character of text.slice(checkpoint.utf16CodeUnitOffset)) {
    const rawWidth = rawStepWidth(encoding, character);
    position = advancePosition(position, character, rawWidth);
    const observed = offsetComponent(position, requested);
    if (observed === target) {
      return position;
    }
    if (observed > target) {
      throw new LocationError('DecodedOffsetNotBoundary');
    }
  }
  throw new LocationError('OutOfBounds');
}
