/**
 * Lossless `plist.binary@1` formation (RFC 0013 §2.2, §3, §5, §12).
 *
 * authority: crates/consema-plist/src/parser_binary.rs
 *  - header §5.1 (:42-51, `bplist00`), minimum source 42 bytes
 *  - trailer layout §5.10 (RawTrailer :420-478), mandatory integrity
 *    checks §5.11 (validate_trailer :776-917: unused bytes zero,
 *    sortVersion 0|1, 1..=8 widths, numObjects >= 1, topObject <
 *    numObjects, offsetTableOffset in [9, len-32), width-sufficiency
 *    `2^(8*size) > bound`, total-length equality)
 *  - offset table :919-972 (entry value in [8, offsetTableOffset) — the
 *    stricter v1 range, RFC 0013 §5.11; the first invalid entry cuts the
 *    proven prefix)
 *  - object scan :1002-1252 (marker table §5.2 :1033-1119, extended sizes
 *    §5.4 :1256-1324, value checks :1149-1200 — ASCII high-bit
 *    `plist.binary.string@1`, non-finite date `plist.binary.date@1`,
 *    UID > 32 bits `plist.binary.uid@1`, container references <
 *    numObjects `plist.binary.reference@1` :1216-1223, extent
 *    `plist.binary.extent@1` :1135-1146)
 *  - dict keys must be strings :1328-1354 (`plist.binary.non-string-key@1`)
 *  - native eligibility :614-671 (`plist.binary.unproven-top-object@1`,
 *    `plist.binary.unproven-reference@1`, cycle `plist.binary.cycle@1`)
 *  - facts and regions :53-251, 673-730; coverage :753
 *  - arithmetic overflow `plist.binary.overflow@1` :1600-1609, limit
 *    codes `plist.limit.*@1` :1648-1664
 *  - GO FUZZ FINDING ① FIX (offset/object-ref range checks — no false
 *    Complete): every offset-table entry must lie in [8, offsetTableOffset)
 *    and every reference must be < numObjects; the offset-table validation
 *    and the marker/extent reads are locally bounds-checked so no chain of
 *    prior checks can be bypassed (parser_binary.rs:935-949, 1014-1030,
 *    1278-1292)
 *
 * Design (TypeScript-idiomatic): one deterministic forward pass — header,
 * trailer, offset table, object table — with prefix-based recovery: the
 * first object that fails cuts the proven prefix; every proven construct
 * keeps its facts and native value. All size arithmetic is checked before
 * use; a limit failure is always fatal.
 */

import { DocumentAuthority, Span } from '../document/identity.ts';
import { BinaryRegion, BinaryStructuralIndex } from '../document/structural.ts';
import { SourceSnapshot } from '../document/source.ts';
import { diagnostic, sortDiagnostics } from '../document/diagnostic.ts';
import type { Diagnostic } from '../document/diagnostic.ts';
import type { FormationStatus } from '../document/formation.ts';
import { FatalFormationFailure } from './errors.ts';
import type { PlistParseLimits } from './profile.ts';
import {
  BinaryFacts,
  BinaryObjectFact,
  BinaryObjectRefFact,
  BinaryOffsetFact,
  BinaryTrailerFacts,
  PlistDocument,
} from './document.ts';
import {
  PlistArenaError,
  PlistDocument as PlistNativeDocument,
  PlistDocumentBuilder,
  PlistReal,
  plistBooleanValue,
  plistDataValue,
  plistDateValue,
  plistIntegerValue,
  plistRealValue,
  plistStringValue,
  plistUidValue,
} from './native.ts';
import type { PlistValue } from './native.ts';

/** Exact `bplist00` header bytes (RFC 0013 §5.1). */
const HEADER = 'bplist00';
/** Minimum admissible source length: 8-byte header, at least one 1-byte
 * object, at least one 1-byte offset entry, and the 32-byte trailer (RFC 0013 §2.2). */
const MIN_SOURCE_BYTES = 42;
/** Trailer byte length (RFC 0013 §5.10). */
const TRAILER_BYTES = 32;
/** Largest legal integer/offset/ref payload width in bytes (RFC 0013 §5.11). */
const MAX_FIELD_WIDTH = 8;

// ---------------------------------------------------------------------------
// Decode helpers
// ---------------------------------------------------------------------------

/** Big-endian unsigned value of `width` bytes at `start`; `null` when the window leaves the source. */
function readBe(bytes: Uint8Array, start: number, width: number): bigint | null {
  const end = start + width;
  if (start < 0 || end > bytes.length || width > 8) {
    return null;
  }
  let value = 0n;
  for (let index = 0; index < width; index++) {
    value = (value << 8n) | BigInt(bytes[start + index]);
  }
  return value;
}

/** Signed 8-byte big-endian two's-complement value. */
function readBeSigned(bytes: Uint8Array, start: number): bigint | null {
  const end = start + 8;
  if (start < 0 || end > bytes.length) {
    return null;
  }
  let value = 0n;
  for (let index = 0; index < 8; index++) {
    value = (value << 8n) | BigInt(bytes[start + index]);
  }
  if (value >= 1n << 63n) {
    value -= 1n << 64n;
  }
  return value;
}

/** Reads one IEEE 754 double payload. */
function readF64(bytes: Uint8Array, start: number): number | null {
  const value = readBe(bytes, start, 8);
  if (value === null) {
    return null;
  }
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, value, false);
  return view.getFloat64(0, false);
}

function overflow(): FatalFormationFailure {
  return FatalFormationFailure.fromDiagnostic(
    diagnostic('plist.binary.overflow@1', 'Resource', 'Error', null, 0n),
  );
}

function internal(): FatalFormationFailure {
  return FatalFormationFailure.fromDiagnostic(
    diagnostic('plist.binary.internal@1', 'Resource', 'Error', null, 0n),
  );
}

function coverage(): FatalFormationFailure {
  return FatalFormationFailure.fromDiagnostic(
    diagnostic('plist.binary.coverage@1', 'Syntax', 'Error', null, 0n),
  );
}

// ---------------------------------------------------------------------------
// Decoded shapes
// ---------------------------------------------------------------------------

type ShapeKind =
  | { readonly kind: 'False' }
  | { readonly kind: 'True' }
  | { readonly kind: 'Integer'; readonly width: number }
  | { readonly kind: 'Real'; readonly width: number }
  | { readonly kind: 'Date' }
  | { readonly kind: 'Data' }
  | { readonly kind: 'AsciiString' }
  | { readonly kind: 'Utf16String' }
  | { readonly kind: 'Uid' }
  | { readonly kind: 'Array' }
  | { readonly kind: 'Dict' };

function shapeIsString(shape: ShapeKind): boolean {
  return shape.kind === 'AsciiString' || shape.kind === 'Utf16String';
}

interface RefTarget {
  readonly target: number;
  readonly start: number;
  readonly end: number;
}

/** Structural facts of one object. */
interface ObjectShape {
  readonly kind: ShapeKind;
  readonly marker: number;
  readonly offset: number;
  readonly extent: number;
  readonly count: number;
  readonly payloadStart: number;
  readonly refs: readonly RefTarget[];
}

/** Raw trailer field values (RFC 0013 §5.10). */
interface RawTrailer {
  readonly unused: readonly number[];
  readonly sortVersion: number;
  readonly offsetIntSize: number;
  readonly objectRefSize: number;
  readonly numObjects: bigint;
  readonly topObject: bigint;
  readonly offsetTableOffset: bigint;
}

function readTrailer(bytes: Uint8Array): RawTrailer {
  const start = bytes.length - TRAILER_BYTES;
  const unused = [
    bytes[start],
    bytes[start + 1],
    bytes[start + 2],
    bytes[start + 3],
    bytes[start + 4],
  ];
  return {
    unused,
    sortVersion: bytes[start + 5],
    offsetIntSize: bytes[start + 6],
    objectRefSize: bytes[start + 7],
    numObjects: readBe(bytes, start + 8, 8)!,
    topObject: readBe(bytes, start + 16, 8)!,
    offsetTableOffset: readBe(bytes, start + 24, 8)!,
  };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** Bounded ordered diagnostic recording with the house truncation marker. */
class DiagnosticSink {
  readonly #diagnostics: Diagnostic[] = [];
  readonly #max: number;
  #occurrence = 0n;
  #truncated = false;

  constructor(max: number) {
    this.#max = max;
  }

  push(d: Diagnostic): void {
    const withOccurrence = { ...d, occurrence: this.#occurrence };
    this.#occurrence += 1n;
    if (this.#diagnostics.length < this.#max) {
      this.#diagnostics.push(withOccurrence);
    } else if (!this.#truncated) {
      this.#truncated = true;
      this.#diagnostics.push({
        code: 'core.diagnostic.truncated@1',
        category: 'Resource',
        severity: 'Warning',
        primary: null,
        related: [],
        arguments: new Map(),
        notes: [],
        occurrence: this.#occurrence,
      });
    }
  }

  finish(): readonly Diagnostic[] {
    return sortDiagnostics(this.#diagnostics);
  }
}

class Parser {
  readonly #source: SourceSnapshot;
  readonly #bytes: Uint8Array;
  readonly #authority: DocumentAuthority;
  readonly #limits: PlistParseLimits;
  readonly #sink: DiagnosticSink;
  #recovered = false;
  #uidCount = 0;
  #extendedIntegers = 0;
  #facts = 0;

  constructor(source: SourceSnapshot, limits: PlistParseLimits) {
    this.#source = source;
    this.#bytes = source.bytes();
    this.#authority = DocumentAuthority.fresh();
    this.#limits = limits;
    this.#sink = new DiagnosticSink(limits.common.maxDiagnostics);
  }

  span(start: number, end: number): Span {
    return this.#authority.span(start, end);
  }

  recover(
    code: string,
    start: number,
    end: number,
    arguments_: ReadonlyArray<readonly [string, string]> = [],
  ): void {
    this.#recovered = true;
    this.#sink.push(
      diagnostic(code, 'Syntax', 'Error', this.span(start, end).diagnosticLocation(), 0n, {
        arguments: arguments_,
      }),
    );
  }

  recoverNoLocation(code: string, arguments_: ReadonlyArray<readonly [string, string]> = []): void {
    this.#recovered = true;
    this.#sink.push(diagnostic(code, 'Syntax', 'Error', null, 0n, { arguments: arguments_ }));
  }

  recordFact(): void {
    this.#facts += 1;
    if (this.#facts > this.#limits.maxBinaryFacts) {
      throw FatalFormationFailure.resourceLimit('binary-facts', this.#facts, this.#limits.maxBinaryFacts);
    }
  }

  parse(): PlistDocument {
    const bytes = this.#bytes;
    const len = bytes.length;
    if (len < MIN_SOURCE_BYTES) {
      throw FatalFormationFailure.fromDiagnostic(
        diagnostic('plist.binary.minimum-size@1', 'Syntax', 'Error', this.span(0, len).diagnosticLocation(), 0n),
      );
    }
    const trailerStart = len - TRAILER_BYTES;

    // Header (RFC 0013 §5.1): any other version string is Recovered.
    const headerOk = decodeUtf8Prefix(bytes, 0, 8) === HEADER;
    if (!headerOk) {
      this.recover('plist.binary.header@1', 0, 8, [['expected', 'bplist00']]);
    }

    // Trailer facts are bytes of the source and are always recorded.
    const raw = readTrailer(bytes);
    this.recordFact();
    const trailerFacts = new BinaryTrailerFacts(
      raw.sortVersion,
      raw.offsetIntSize,
      raw.objectRefSize,
      raw.numObjects,
      raw.topObject,
      raw.offsetTableOffset,
      this.span(trailerStart, len),
    );

    // Mandatory integrity checks run before any object is decoded (§5.11).
    const trailerOk = this.validateTrailer(raw);
    if (!trailerOk) {
      // The object table cannot be located; the middle bytes are one error
      // region and no native document exists (parser_binary.rs:569-588).
      const regions = [
        this.region(0, headerOk ? 'header' : 'error-region', 0, 8),
        this.region(1, 'error-region', 8, trailerStart),
        this.region(2, 'error-region', trailerStart, len),
      ];
      return this.finish(
        null,
        new BinaryFacts([], [], [], trailerFacts),
        regions,
      );
    }

    const offsetTableOffset = Number(raw.offsetTableOffset);
    const numObjects = Number(raw.numObjects);
    const offsetIntSize = raw.offsetIntSize;
    const objectRefSize = raw.objectRefSize;
    const tableBytes = numObjects * offsetIntSize;
    if (tableBytes > this.#limits.maxOffsetTableBytes) {
      throw FatalFormationFailure.resourceLimit('offset-table-bytes', tableBytes, this.#limits.maxOffsetTableBytes);
    }

    const offsetRead = this.readOffsetTable(offsetTableOffset, numObjects, offsetIntSize);
    const offsetFacts = offsetRead.facts;
    const objectOffsets = offsetRead.offsets;
    let cut = offsetRead.cut;
    const scan = this.scanObjects(objectOffsets, cut, offsetTableOffset, objectRefSize, numObjects);
    const shapes = scan.shapes;
    cut = scan.cut;
    cut = this.verifyDictKeys(shapes, cut);

    // Native document eligibility (parser_binary.rs:614-671).
    const topObject = Number(raw.topObject);
    let nativeUnproven = false;
    if (topObject >= cut) {
      this.recover('plist.binary.unproven-top-object@1', trailerStart + 16, trailerStart + 24, [
        ['top-object', String(topObject)],
      ]);
      nativeUnproven = true;
    }
    for (let owner = 0; owner < cut; owner++) {
      const bad = shapes[owner].refs.find((reference) => reference.target >= cut);
      if (bad !== undefined) {
        this.recover('plist.binary.unproven-reference@1', bad.start, bad.end, [
          ['owner', String(owner)],
          ['target', String(bad.target)],
        ]);
        nativeUnproven = true;
        break;
      }
    }

    let native: PlistNativeDocument | null = null;
    if (!nativeUnproven) {
      const values = this.buildValues(shapes, cut);
      const builder = new PlistDocumentBuilder({
        maxObjects: this.#limits.maxObjectCount,
        maxContainerDepth: this.#limits.maxContainerDepth,
      });
      for (const value of values) {
        try {
          builder.add(value);
        } catch (error) {
          if (error instanceof PlistArenaError && error.kind === 'ObjectLimitExceeded') {
            throw FatalFormationFailure.resourceLimit('object-count', cut, this.#limits.maxObjectCount);
          }
          throw internal();
        }
      }
      try {
        native = builder.build(topObject);
      } catch (error) {
        if (error instanceof PlistArenaError && error.kind === 'CycleDetected') {
          this.recoverNoLocation('plist.binary.cycle@1');
          native = null;
        } else if (error instanceof PlistArenaError && error.kind === 'ContainerDepthLimitExceeded') {
          throw FatalFormationFailure.resourceLimit(
            'container-depth',
            error.node ?? 0,
            this.#limits.maxContainerDepth,
          );
        } else {
          throw internal();
        }
      }
    }

    // Facts of the proven prefix (RFC 0013 §8.3).
    const objects: BinaryObjectFact[] = [];
    for (let index = 0; index < cut; index++) {
      this.recordFact();
      objects.push(
        new BinaryObjectFact(index, shapes[index].offset, shapes[index].marker, this.span(shapes[index].offset, shapes[index].offset + shapes[index].extent)),
      );
    }
    const refs: BinaryObjectRefFact[] = [];
    for (let owner = 0; owner < cut; owner++) {
      for (let position = 0; position < shapes[owner].refs.length; position++) {
        this.recordFact();
        const reference = shapes[owner].refs[position];
        refs.push(new BinaryObjectRefFact(owner, position, reference.target, this.span(reference.start, reference.end)));
      }
    }
    const facts = new BinaryFacts(objects, offsetFacts, refs, trailerFacts);

    // Exhaustive region coverage (parser_binary.rs:703-727).
    const regions: BinaryRegion[] = [];
    regions.push(this.region(0, headerOk ? 'header' : 'error-region', 0, 8));
    if (cut > 0) {
      const lastEnd = shapes[cut - 1].offset + shapes[cut - 1].extent;
      regions.push(this.region(1, 'object-table', 8, lastEnd));
      if (cut < numObjects) {
        if (lastEnd < offsetTableOffset) {
          regions.push(this.region(2, 'error-region', lastEnd, offsetTableOffset));
        }
      } else if (lastEnd < offsetTableOffset) {
        regions.push(this.region(2, 'padding', lastEnd, offsetTableOffset));
      }
    } else if (8 < offsetTableOffset) {
      regions.push(this.region(1, 'error-region', 8, offsetTableOffset));
    }
    regions.push(this.region(regions.length, 'offset-table', offsetTableOffset, offsetTableOffset + tableBytes));
    regions.push(this.region(regions.length, 'trailer', trailerStart, len));

    return this.finish(native, facts, regions);
  }

  finish(native: PlistNativeDocument | null, facts: BinaryFacts, regions: BinaryRegion[]): PlistDocument {
    const errorRegions = regions.filter((region) => region.kind() === 'error-region').length;
    if (errorRegions > this.#limits.maxRecoveryRegions) {
      throw FatalFormationFailure.resourceLimit(
        'recovery-regions',
        errorRegions,
        this.#limits.maxRecoveryRegions,
      );
    }
    let index: BinaryStructuralIndex;
    try {
      index = BinaryStructuralIndex.create(this.#authority.identity(), this.#source.len(), regions);
    } catch {
      throw coverage();
    }
    const status: FormationStatus = this.#recovered ? 'Recovered' : 'Complete';
    return new PlistDocument(
      this.#authority,
      this.#source,
      'BinaryV1',
      status,
      this.#sink.finish(),
      null,
      null,
      index,
      facts,
      native,
      this.#limits,
    );
  }

  /** Validates the mandatory trailer checks (RFC 0013 §5.11). */
  validateTrailer(raw: RawTrailer): boolean {
    let ok = true;
    const len = this.#bytes.length;
    const start = len - TRAILER_BYTES;
    const trailerSpan = (fieldStart: number, fieldEnd: number) => this.span(start + fieldStart, start + fieldEnd);

    if (raw.unused.some((byte) => byte !== 0)) {
      this.recover('plist.binary.trailer@1', start, start + 5, [['check', 'unused-bytes']]);
      ok = false;
    }
    if (raw.sortVersion !== 0 && raw.sortVersion !== 1) {
      this.recover('plist.binary.trailer@1', start + 5, start + 6, [
        ['check', 'sort-version'],
        ['sort-version', `0x${raw.sortVersion.toString(16).padStart(2, '0')}`],
      ]);
      ok = false;
    }
    if (raw.offsetIntSize < 1 || raw.offsetIntSize > MAX_FIELD_WIDTH) {
      this.recover('plist.binary.trailer@1', start + 6, start + 7, [
        ['check', 'offset-int-size'],
        ['offset-int-size', String(raw.offsetIntSize)],
      ]);
      ok = false;
    } else if (raw.offsetIntSize > this.#limits.maxOffsetIntSize) {
      throw FatalFormationFailure.resourceLimit('offset-int-size', raw.offsetIntSize, this.#limits.maxOffsetIntSize);
    }
    if (raw.objectRefSize < 1 || raw.objectRefSize > MAX_FIELD_WIDTH) {
      this.recover('plist.binary.trailer@1', start + 7, start + 8, [
        ['check', 'object-ref-size'],
        ['object-ref-size', String(raw.objectRefSize)],
      ]);
      ok = false;
    } else if (raw.objectRefSize > this.#limits.maxObjectRefSize) {
      throw FatalFormationFailure.resourceLimit('object-ref-size', raw.objectRefSize, this.#limits.maxObjectRefSize);
    }
    if (raw.numObjects === 0n) {
      this.recover('plist.binary.trailer@1', start + 8, start + 16, [['check', 'num-objects']]);
      ok = false;
    } else if (raw.numObjects > BigInt(this.#limits.maxObjectCount)) {
      throw FatalFormationFailure.resourceLimit('object-count', Number(raw.numObjects), this.#limits.maxObjectCount);
    }
    if (raw.topObject >= raw.numObjects) {
      this.recover('plist.binary.trailer@1', start + 16, start + 24, [
        ['check', 'top-object'],
        ['top-object', raw.topObject.toString()],
      ]);
      ok = false;
    }
    const maxTableOffset = len - TRAILER_BYTES;
    if (raw.offsetTableOffset < 9n || raw.offsetTableOffset >= BigInt(maxTableOffset)) {
      this.recover('plist.binary.trailer@1', start + 24, start + 32, [
        ['check', 'offset-table-offset'],
        ['offset-table-offset', raw.offsetTableOffset.toString()],
      ]);
      ok = false;
    }
    if (raw.offsetIntSize >= 1 && raw.offsetIntSize < MAX_FIELD_WIDTH) {
      const capacity = 1n << BigInt(8 * raw.offsetIntSize);
      if (capacity <= raw.offsetTableOffset) {
        this.recover('plist.binary.trailer@1', start + 24, start + 32, [
          ['check', 'offset-int-size-sufficiency'],
        ]);
        ok = false;
      }
    }
    if (raw.objectRefSize >= 1 && raw.objectRefSize < MAX_FIELD_WIDTH) {
      const capacity = 1n << BigInt(8 * raw.objectRefSize);
      if (capacity <= raw.numObjects) {
        this.recover('plist.binary.trailer@1', start + 7, start + 8, [
          ['check', 'object-ref-size-sufficiency'],
        ]);
        ok = false;
      }
    }
    const tableBytes = raw.numObjects * BigInt(raw.offsetIntSize);
    const expected = raw.offsetTableOffset + tableBytes + BigInt(TRAILER_BYTES);
    if (expected !== BigInt(len)) {
      this.recover('plist.binary.trailer@1', start, len, [
        ['check', 'total-length'],
        ['expected', expected.toString()],
        ['observed', String(len)],
      ]);
      ok = false;
    }
    return ok;
  }

  /** Reads and validates the offset table in entry order (RFC 0013 §5.10, §5.11). */
  readOffsetTable(
    offsetTableOffset: number,
    numObjects: number,
    offsetIntSize: number,
  ): { readonly facts: BinaryOffsetFact[]; readonly offsets: number[]; readonly cut: number } {
    const bytes = this.#bytes;
    const facts: BinaryOffsetFact[] = [];
    const offsets: number[] = [];
    let cut = numObjects;
    for (let index = 0; index < numObjects; index++) {
      const start = offsetTableOffset + index * offsetIntSize;
      const end = start + offsetIntSize;
      if (end > bytes.length) {
        // Defensive: the entry window must stay inside the source
        // (parser_binary.rs:935-949); cuts the proven prefix exactly like a
        // malformed entry value.
        this.recover('plist.binary.offset-table@1', Math.min(start, bytes.length - 1), bytes.length, [
          ['index', String(index)],
          ['end', String(end)],
        ]);
        cut = index;
        break;
      }
      const value = readBe(bytes, start, offsetIntSize);
      if (value === null) {
        throw overflow();
      }
      const valueNum = Number(value);
      // The stricter v1 range: every entry must lie in [8, offsetTableOffset)
      // (RFC 0013 §5.11; parser_binary.rs:951-962).
      if (valueNum < 8 || valueNum >= offsetTableOffset) {
        this.recover('plist.binary.offset-table@1', start, end, [
          ['index', String(index)],
          ['value', `0x${value.toString(16)}`],
        ]);
        cut = index;
        break;
      }
      this.recordFact();
      facts.push(new BinaryOffsetFact(index, valueNum, this.span(start, end)));
      offsets.push(valueNum);
    }
    return { facts, offsets, cut };
  }

  /** Scans objects in index order and returns the proven shapes plus the prefix cut. */
  scanObjects(
    objectOffsets: readonly number[],
    initialCut: number,
    offsetTableOffset: number,
    objectRefSize: number,
    numObjects: number,
  ): { readonly shapes: ObjectShape[]; readonly cut: number } {
    const shapes: ObjectShape[] = [];
    let cut = initialCut;
    for (let index = 0; index < initialCut; index++) {
      const shape = this.scanObject(index, objectOffsets[index], offsetTableOffset, objectRefSize, numObjects);
      if (shape === null) {
        cut = index;
        break;
      }
      shapes.push(shape);
    }
    return { shapes, cut };
  }

  /** Decodes one object's marker, size, extent, and references; `null` cuts the proven prefix at `index`. */
  scanObject(
    index: number,
    offset: number,
    tableEnd: number,
    objectRefSize: number,
    numObjects: number,
  ): ObjectShape | null {
    const bytes = this.#bytes;
    if (offset >= bytes.length) {
      // Defensive: the marker byte must exist inside the source
      // (parser_binary.rs:1014-1030).
      this.recover('plist.binary.offset-table@1', bytes.length - 1, bytes.length, [
        ['index', String(index)],
        ['value', `0x${offset.toString(16)}`],
      ]);
      return null;
    }
    const marker = bytes[offset];
    const markerStart = offset;
    const markerEnd = offset + 1;
    let shapeKind: ShapeKind;
    let count = 0;
    let extBytes = 0;
    if (marker === 0x08) {
      shapeKind = { kind: 'False' };
    } else if (marker === 0x09) {
      shapeKind = { kind: 'True' };
    } else if (marker >= 0x10 && marker <= 0x13) {
      shapeKind = { kind: 'Integer', width: 1 << (marker & 0x0f) };
    } else if (marker === 0x22) {
      shapeKind = { kind: 'Real', width: 4 };
    } else if (marker === 0x23) {
      shapeKind = { kind: 'Real', width: 8 };
    } else if (marker === 0x33) {
      shapeKind = { kind: 'Date' };
    } else if (marker >= 0x40 && marker <= 0x4f) {
      const sized = this.sizedCount(marker, offset, index);
      if (sized === null) {
        return null;
      }
      count = sized.count;
      extBytes = sized.extBytes;
      if (count > this.#limits.maxDataBytes) {
        throw FatalFormationFailure.resourceLimit('data-bytes', count, this.#limits.maxDataBytes);
      }
      shapeKind = { kind: 'Data' };
    } else if (marker >= 0x50 && marker <= 0x5f) {
      const sized = this.sizedCount(marker, offset, index);
      if (sized === null) {
        return null;
      }
      count = sized.count;
      extBytes = sized.extBytes;
      if (count > this.#limits.maxStringCodeUnits) {
        throw FatalFormationFailure.resourceLimit('string-code-units', count, this.#limits.maxStringCodeUnits);
      }
      shapeKind = { kind: 'AsciiString' };
    } else if (marker >= 0x60 && marker <= 0x6f) {
      const sized = this.sizedCount(marker, offset, index);
      if (sized === null) {
        return null;
      }
      count = sized.count;
      extBytes = sized.extBytes;
      if (count > this.#limits.maxStringCodeUnits) {
        throw FatalFormationFailure.resourceLimit('string-code-units', count, this.#limits.maxStringCodeUnits);
      }
      shapeKind = { kind: 'Utf16String' };
    } else if (marker >= 0x80 && marker <= 0x8f) {
      shapeKind = { kind: 'Uid' };
      count = (marker & 0x0f) + 1;
    } else if (marker >= 0xa0 && marker <= 0xaf) {
      const sized = this.sizedCount(marker, offset, index);
      if (sized === null) {
        return null;
      }
      count = sized.count;
      extBytes = sized.extBytes;
      if (count > this.#limits.maxArrayElements) {
        throw FatalFormationFailure.resourceLimit('array-elements', count, this.#limits.maxArrayElements);
      }
      shapeKind = { kind: 'Array' };
    } else if (marker >= 0xd0 && marker <= 0xdf) {
      const sized = this.sizedCount(marker, offset, index);
      if (sized === null) {
        return null;
      }
      count = sized.count;
      extBytes = sized.extBytes;
      if (count > this.#limits.maxDictEntries) {
        throw FatalFormationFailure.resourceLimit('dict-entries', count, this.#limits.maxDictEntries);
      }
      shapeKind = { kind: 'Dict' };
    } else {
      // Excluded markers (RFC 0013 §5.2): null, URL, UUID, fill, 16-byte
      // integer, unused real widths, UTF-8 string, sets, and the
      // unassigned ranges (parser_binary.rs:1108-1118).
      this.recover('plist.binary.marker@1', markerStart, markerEnd, [
        ['marker', `0x${marker.toString(16).padStart(2, '0')}`],
        ['object', String(index)],
      ]);
      return null;
    }
    const payloadStart = offset + 1 + extBytes;
    let payloadLen: number;
    switch (shapeKind.kind) {
      case 'Uid':
      case 'Data':
      case 'AsciiString':
      case 'False':
      case 'True':
        payloadLen = count;
        break;
      case 'Integer':
      case 'Real':
        payloadLen = shapeKind.width;
        break;
      case 'Date':
        payloadLen = 8;
        break;
      case 'Utf16String':
        payloadLen = count * 2;
        break;
      case 'Array':
        payloadLen = count * objectRefSize;
        break;
      case 'Dict':
        payloadLen = count * 2 * objectRefSize;
        break;
    }
    const extent = 1 + extBytes + payloadLen;
    const end = offset + extent;
    if (end > tableEnd) {
      this.recover('plist.binary.extent@1', markerStart, markerEnd, [
        ['object', String(index)],
        ['end', String(end)],
        ['table-end', String(tableEnd)],
      ]);
      return null;
    }

    // Value-validity checks that cut the prefix here (RFC 0013 §5.5-5.8).
    switch (shapeKind.kind) {
      case 'AsciiString': {
        for (let at = payloadStart; at < end; at++) {
          if (bytes[at] >= 0x80) {
            this.recover('plist.binary.string@1', at, at + 1, [
              ['byte', `0x${bytes[at].toString(16).padStart(2, '0')}`],
              ['object', String(index)],
            ]);
            return null;
          }
        }
        break;
      }
      case 'Date': {
        const seconds = readF64(bytes, payloadStart);
        if (seconds === null || !Number.isFinite(seconds)) {
          this.recover('plist.binary.date@1', payloadStart, payloadStart + 8, [['object', String(index)]]);
          return null;
        }
        break;
      }
      case 'Uid': {
        const value = readBe(bytes, payloadStart, count);
        if (value === null) {
          throw overflow();
        }
        if (value > 0xffffffffn) {
          this.recover('plist.binary.uid@1', payloadStart, payloadStart + count, [
            ['value', `0x${value.toString(16)}`],
            ['object', String(index)],
          ]);
          return null;
        }
        this.#uidCount += 1;
        if (this.#uidCount > this.#limits.maxUidCount) {
          throw FatalFormationFailure.resourceLimit('uid-count', this.#uidCount, this.#limits.maxUidCount);
        }
        break;
      }
      default:
        break;
    }

    // Container references (RFC 0013 §5.9).
    const refs: RefTarget[] = [];
    if (shapeKind.kind === 'Array' || shapeKind.kind === 'Dict') {
      const total = shapeKind.kind === 'Dict' ? count * 2 : count;
      for (let position = 0; position < total; position++) {
        const refStart = payloadStart + position * objectRefSize;
        const refEnd = refStart + objectRefSize;
        const target = readBe(bytes, refStart, objectRefSize);
        if (target === null) {
          throw overflow();
        }
        const targetNum = Number(target);
        // Object-reference range check: every reference must index a valid
        // object (< numObjects) — the Go fuzz finding ① fix, no false
        // Complete (RFC 0013 §5.9; parser_binary.rs:1216-1223).
        if (targetNum >= numObjects) {
          this.recover('plist.binary.reference@1', refStart, refEnd, [
            ['owner', String(index)],
            ['target', String(targetNum)],
          ]);
          return null;
        }
        refs.push({ target: targetNum, start: refStart, end: refEnd });
      }
      this.#facts += total;
      if (this.#facts > this.#limits.maxBinaryFacts) {
        throw FatalFormationFailure.resourceLimit('binary-facts', this.#facts, this.#limits.maxBinaryFacts);
      }
    }
    return {
      kind: shapeKind,
      marker,
      offset,
      extent,
      count,
      payloadStart,
      refs,
    };
  }

  /** Reads a sized construct's count, honoring the extended-size rule (RFC 0013 §5.4). */
  sizedCount(marker: number, objectOffset: number, index: number): { readonly count: number; readonly extBytes: number } | null {
    const nibble = marker & 0x0f;
    if (nibble !== 0x0f) {
      return { count: nibble, extBytes: 0 };
    }
    return this.readCount(objectOffset, index);
  }

  /** Reads one extended-size integer and enforces its limits (RFC 0013 §5.4, §12). */
  readCount(objectOffset: number, index: number): { readonly count: number; readonly extBytes: number } | null {
    const bytes = this.#bytes;
    if (objectOffset + 1 >= bytes.length) {
      this.recover('plist.binary.offset-table@1', bytes.length - 1, bytes.length, [
        ['index', String(index)],
        ['value', `0x${objectOffset.toString(16)}`],
      ]);
      return null;
    }
    const marker = bytes[objectOffset + 1];
    if (marker < 0x10 || marker > 0x13) {
      this.recover('plist.binary.extended-size@1', objectOffset + 1, objectOffset + 2, [
        ['marker', `0x${marker.toString(16).padStart(2, '0')}`],
        ['object', String(index)],
      ]);
      return null;
    }
    const width = 1 << (marker & 0x0f);
    const value = readBe(bytes, objectOffset + 2, width);
    if (value === null) {
      throw overflow();
    }
    if (value > BigInt(this.#limits.maxExtendedSizeValue)) {
      throw FatalFormationFailure.resourceLimit(
        'extended-size-value',
        Number(value),
        this.#limits.maxExtendedSizeValue,
      );
    }
    this.#extendedIntegers += 1;
    if (this.#extendedIntegers > this.#limits.maxExtendedSizeIntegers) {
      throw FatalFormationFailure.resourceLimit(
        'extended-size-integers',
        this.#extendedIntegers,
        this.#limits.maxExtendedSizeIntegers,
      );
    }
    return { count: Number(value), extBytes: 1 + width };
  }

  /** Verifies that every dictionary key target is a string object (RFC 0013 §5.9). */
  verifyDictKeys(shapes: readonly ObjectShape[], cut: number): number {
    for (let index = 0; index < cut; index++) {
      const shape = shapes[index];
      if (shape.kind.kind !== 'Dict') {
        continue;
      }
      for (let position = 0; position < shape.count; position++) {
        const keyRef = shape.refs[position];
        if (keyRef.target >= cut) {
          continue;
        }
        if (!shapeIsString(shapes[keyRef.target].kind)) {
          this.recover('plist.binary.non-string-key@1', keyRef.start, keyRef.end, [
            ['key-object', String(keyRef.target)],
            ['object', String(index)],
          ]);
          return index;
        }
      }
    }
    return cut;
  }

  /** Builds native values in object-table order so arena indices equal object indices. */
  buildValues(shapes: readonly ObjectShape[], cut: number): PlistValue[] {
    const bytes = this.#bytes;
    const values: PlistValue[] = [];
    for (const shape of shapes.slice(0, cut)) {
      let value: PlistValue;
      switch (shape.kind.kind) {
        case 'False':
          value = plistBooleanValue(false);
          break;
        case 'True':
          value = plistBooleanValue(true);
          break;
        case 'Integer': {
          const width = shape.kind.width;
          if (width < 8) {
            const raw = readBe(bytes, shape.payloadStart, width);
            if (raw === null) {
              throw overflow();
            }
            value = plistIntegerValue(raw);
          } else {
            const signed = readBeSigned(bytes, shape.payloadStart);
            if (signed === null) {
              throw overflow();
            }
            value = plistIntegerValue(signed);
          }
          break;
        }
        case 'Real': {
          if (shape.kind.width === 4) {
            const raw = readBe(bytes, shape.payloadStart, 4);
            if (raw === null) {
              throw overflow();
            }
            value = plistRealValue(PlistReal.fromBits('Float32', raw));
          } else {
            const raw = readBe(bytes, shape.payloadStart, 8);
            if (raw === null) {
              throw overflow();
            }
            value = plistRealValue(PlistReal.fromBits('Float64', raw));
          }
          break;
        }
        case 'Date': {
          const seconds = readF64(bytes, shape.payloadStart);
          if (seconds === null) {
            throw overflow();
          }
          value = plistDateValue(seconds);
          break;
        }
        case 'Data':
          value = plistDataValue(bytes.slice(shape.payloadStart, shape.payloadStart + shape.count));
          break;
        case 'AsciiString': {
          let text = '';
          for (let at = shape.payloadStart; at < shape.payloadStart + shape.count; at++) {
            text += String.fromCharCode(bytes[at]);
          }
          value = plistStringValue(text);
          break;
        }
        case 'Utf16String': {
          let text = '';
          for (let at = shape.payloadStart; at < shape.payloadStart + shape.count * 2; at += 2) {
            text += String.fromCharCode((bytes[at] << 8) | bytes[at + 1]);
          }
          value = plistStringValue(text);
          break;
        }
        case 'Uid': {
          const raw = readBe(bytes, shape.payloadStart, shape.count);
          if (raw === null) {
            throw overflow();
          }
          value = plistUidValue(Number(raw));
          break;
        }
        case 'Array':
          value = { kind: 'Array', elements: Object.freeze(shape.refs.map((reference) => reference.target)) };
          break;
        case 'Dict':
          value = { kind: 'Dict', entries: Object.freeze([]) };
          break;
      }
      values.push(value);
    }
    // Dictionary entries need the key target's string content (forward key
    // references materialize in a second pass).
    for (let index = 0; index < cut; index++) {
      const shape = shapes[index];
      if (shape.kind.kind !== 'Dict') {
        continue;
      }
      const entries: Array<{ readonly key: string; readonly value: number }> = [];
      const groups = new Map<string, number>();
      for (let position = 0; position < shape.count; position++) {
        const keyRef = shape.refs[position];
        const keyNode = values[keyRef.target];
        if (keyNode.kind !== 'String') {
          throw internal();
        }
        const key = keyNode.text;
        const group = (groups.get(key) ?? 0) + 1;
        if (group > this.#limits.maxDuplicateKeyGroupMembers) {
          throw FatalFormationFailure.resourceLimit('duplicate-key-group', group, this.#limits.maxDuplicateKeyGroupMembers);
        }
        groups.set(key, group);
        entries.push({ key, value: shape.refs[shape.count + position].target });
      }
      values[index] = { kind: 'Dict', entries: Object.freeze(entries) };
    }
    return values;
  }

  region(index: number, kind: string, start: number, end: number): BinaryRegion {
    return new BinaryRegion(this.#authority.nodeRef(BigInt(index), 'BinaryRegion'), this.span(start, end), kind);
  }
}

function decodeUtf8Prefix(bytes: Uint8Array, start: number, len: number): string {
  const decoder = new TextDecoder('utf-8');
  return decoder.decode(bytes.slice(start, start + len));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Forms one `plist.binary@1` document from raw bytes (RFC 0013 §2.2, §3, §5).
 * The source is an opaque binary snapshot; there is no text encoding, no
 * BOM, no newline, and no decoding step.
 */
export function parseBinary(source: SourceSnapshot, limits: PlistParseLimits): PlistDocument {
  return new Parser(source, limits).parse();
}
