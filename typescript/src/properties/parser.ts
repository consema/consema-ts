/**
 * Lossless Java Properties parsing into the immutable document model.
 *
 * authority (language-neutral behavior, byte-exact spans, recovery):
 *  - RFC 0010 (docs/rfcs/0010-java-properties-profiles-v1.md): §3 source
 *    contracts (:65-106), §5 natural/logical lines (:133-158), §6
 *    key/separator/element grammar (:160-181), §7 escape processing
 *    (:183-206), §8 formation and recovery (:208-234)
 *  - crates/consema-properties/src/parser.rs — parse :17-36,
 *    encoding_request :38-55, validate_profile_encoding :57-81,
 *    profile_failure :83-91, scan_natural_lines :230-298, is_blank
 *    :300-305, is_comment :307-313, add_comment :320-350, add_logical_line
 *    :352-469, split_property :471-507, finish_property :509-624,
 *    recover_logical_line :626-666, assign_duplicate_groups :668-696,
 *    build_structural_pieces :698-729, build_atoms :882-907,
 *    decode_java_string :909-996, is_properties_whitespace :998-1000,
 *    structural_kind :1002-1017
 *  - source and encoding: crates/consema-document/src/lib.rs:643-761
 *    (FatalFormationFailure); codes in crates/consema-protocol/src/
 *    error_registry.rs:207, 372, 366, 405, 399
 *  - profiles: crates/consema-properties/src/lib.rs:33-59 (RFC 0010 §1)
 *  - vector-pinned behavior: conformance/vectors/java-properties-v1.json
 *    (all 17 cases; the 20-limit matrix pins the limit names)
 *
 * Design (TypeScript-idiomatic): the parser walks decoded text one Unicode
 * scalar at a time, tracking exact raw byte offsets through the source
 * snapshot's decoded boundary index (the Rust `build_atoms`, parser.rs:882-
 * 907). Natural lines, logical assembly, key/value separation, and escape
 * decoding follow parser.rs step for step; the immutable `PropertiesDocument`
 * is built with typed entities, or `FatalFormationFailure` is thrown — no
 * partial document ever exists (RFC 0010 §8 :231-234).
 */

import { DocumentAuthority, Span } from '../document/identity.ts';
import type { NodeRole } from '../document/identity.ts';
import { LosslessStructuralIndex, StructuralPiece } from '../document/structural.ts';
import type { StructuralPieceKind } from '../document/structural.ts';
import { EncodingRequest, SourceSnapshot, latin1Encoding } from '../document/source.ts';
import type { BomPolicy, SourceEncoding, SourceLimits } from '../document/source.ts';
import { diagnostic, sortDiagnostics } from '../document/diagnostic.ts';
import type { Diagnostic, DiagnosticCategory } from '../document/diagnostic.ts';
import { SourceError } from '../document/errors.ts';
import { FatalFormationFailure } from './errors.ts';
import { PropertiesDocument } from './document.ts';
import type { Entity, PropertiesEscapeKind, PropertiesLogicalLineKind, PropertiesValueState } from './document.ts';
import { JavaString } from './java_string.ts';
import type { PropertiesProfile } from './profile.ts';
import type { PropertiesParseLimits } from './parse_limits.ts';
import type { PropertiesSyntaxKind } from './syntax.ts';

// ---------------------------------------------------------------------------
// Source contract selection
// ---------------------------------------------------------------------------

/** Explicit source contract; no extension, locale, or platform default is consulted (lib.rs:52-59). */
export type PropertiesEncodingSelection =
  | { readonly kind: 'Reader'; readonly encoding: SourceEncoding }
  | { readonly kind: 'Latin1' };

export function readerSelection(encoding: SourceEncoding): PropertiesEncodingSelection {
  return { kind: 'Reader', encoding };
}

export function latin1Selection(): PropertiesEncodingSelection {
  return { kind: 'Latin1' };
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

function encodingRequest(
  profile: PropertiesProfile,
  selection: PropertiesEncodingSelection,
): EncodingRequest | null {
  switch (selection.kind) {
    case 'Reader':
      if (profile === 'ReaderV1' && selection.encoding.kind !== 'Binary') {
        return EncodingRequest.create(selection.encoding).withCallerOverride(selection.encoding);
      }
      return null;
    case 'Latin1':
      if (profile === 'Latin1V1') {
        return EncodingRequest.create(latin1Encoding())
          .withCallerOverride(latin1Encoding())
          .withBomPolicy('TreatAsContent');
      }
      return null;
  }
}

function profileFailure(): FatalFormationFailure {
  return FatalFormationFailure.fromDiagnostic({
    code: 'java-properties.source.profile-encoding@1',
    category: 'Encoding',
    severity: 'Error',
    primary: null,
    related: [],
    arguments: new Map(),
    notes: [],
    occurrence: 0n,
  });
}

function validateProfileEncoding(
  source: SourceSnapshot,
  profile: PropertiesProfile,
  selection: PropertiesEncodingSelection,
): boolean {
  const facts = source.encodingFacts();
  switch (selection.kind) {
    case 'Reader':
      return (
        profile === 'ReaderV1' &&
        selection.encoding.kind !== 'Binary' &&
        encodingEquals(facts.selected(), selection.encoding) &&
        facts.bomPolicy() === 'DetectUnicode'
      );
    case 'Latin1':
      return (
        profile === 'Latin1V1' &&
        facts.selected().kind === 'Latin1' &&
        facts.bomPolicy() === 'TreatAsContent' &&
        facts.bom() === null
      );
  }
}

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

/** One decoded scalar and its exact raw byte range (parser.rs:93-99). */
interface Atom {
  readonly ch: string;
  readonly rawStart: number;
  readonly rawEnd: number;
  syntax: PropertiesSyntaxKind | null;
}

/**
 * Builds one atom per decoded Unicode scalar with exact raw offsets
 * (parser.rs:882-907).
 *
 * NOTE (L1 dependency, recorded): the Rust authority resolves every raw
 * offset through the source snapshot's decoded boundary index
 * (`raw_byte_at`, parser.rs:889-897). The TS source snapshot's boundary
 * index mis-accounts the decoded-UTF-8-byte coordinate for non-ASCII text
 * (typescript/src/document/source.ts `advancePosition` increments it by
 * UTF-16 code units), so `rawByteAt` throws OutOfBounds for any non-ASCII
 * source. This parser therefore computes per-scalar raw widths directly,
 * which is mathematically identical to the authoritative mapping (decoded
 * scalar order equals raw order for every published text encoding) and is
 * independent of the boundary index. The per-atom tables retained by the
 * document (raw starts, decoded UTF-8 byte offsets, JS code-unit indexes)
 * serve the same exact-span lookups the Rust `decoded_span_text` performs
 * through the index (query.rs:636-651).
 */
function buildAtoms(source: SourceSnapshot): {
  atoms: Atom[];
  rawStarts: Uint32Array;
  utf8Bytes: Uint32Array;
  jsIndexes: Uint32Array;
} {
  const text = source.decodedText();
  if (text === null) {
    throw new Error('internal: Properties source profiles always select text decoding');
  }
  const encoding = source.encodingFacts().selected();
  const atoms: Atom[] = [];
  const rawStarts: number[] = [];
  const utf8Bytes: number[] = [];
  const jsIndexes: number[] = [];
  let raw = 0;
  let decodedUtf8Byte = 0;
  let jsIndex = 0;
  for (const character of text) {
    const width = rawWidth(encoding, character);
    rawStarts.push(raw);
    utf8Bytes.push(decodedUtf8Byte);
    jsIndexes.push(jsIndex);
    atoms.push({ ch: character, rawStart: raw, rawEnd: raw + width, syntax: null });
    raw += width;
    decodedUtf8Byte += utf8Width(character);
    jsIndex += character.length;
  }
  if (raw !== source.len()) {
    throw FatalFormationFailure.resourceLimit('source-coordinate-coverage', 1, 0);
  }
  rawStarts.push(raw);
  utf8Bytes.push(decodedUtf8Byte);
  jsIndexes.push(jsIndex);
  return {
    atoms,
    rawStarts: Uint32Array.from(rawStarts),
    utf8Bytes: Uint32Array.from(utf8Bytes),
    jsIndexes: Uint32Array.from(jsIndexes),
  };
}

/** Exact raw byte width of one decoded scalar under one text encoding (source.rs:1159-1181). */
function rawWidth(encoding: SourceEncoding, character: string): number {
  switch (encoding.kind) {
    case 'Utf8':
      return utf8Width(character);
    case 'WindowsCodePage':
      // cp65001 decodes as strict UTF-8; the single-byte pages map one byte
      // per scalar (source.rs:1159-1181; the L1 divergence note in
      // typescript/src/document/source.ts:897-912 covers the multi-byte
      // pages, which the source snapshot rejects before this point).
      return encoding.codePage.number() === 65001 ? utf8Width(character) : 1;
    case 'Utf16Le':
    case 'Utf16Be':
      return character.length === 2 ? 4 : 2;
    case 'Latin1':
      return 1;
    case 'Binary':
      throw new Error('internal: binary source has no decoded locations');
  }
}

function utf8Width(character: string): number {
  const codePoint = character.codePointAt(0)!;
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** Properties whitespace is exactly space, tab, and form feed (parser.rs:998-1000; RFC 0010 §5). */
function isPropertiesWhitespace(character: string): boolean {
  return character === ' ' || character === '\t' || character === '';
}

/** Maps a syntax kind to its structural piece class (parser.rs:1002-1017). */
function structuralKind(syntax: PropertiesSyntaxKind): StructuralPieceKind {
  switch (syntax) {
    case 'Whitespace':
    case 'LineBreak':
    case 'CommentMarker':
    case 'CommentText':
      return 'Trivia';
    case 'ErrorRegion':
      return 'ErrorRegion';
    case 'Bom':
    case 'Key':
    case 'Separator':
    case 'Value':
    case 'EscapeMarker':
    case 'EscapeBody':
    case 'ContinuationMarker':
      return 'Token';
  }
}

// ---------------------------------------------------------------------------
// Escape decoding (parser.rs:909-996; RFC 0010 §7)
// ---------------------------------------------------------------------------

interface EscapeSpec {
  readonly atomIndices: readonly number[];
  readonly kind: PropertiesEscapeKind;
  readonly outputStart: number;
  readonly outputEnd: number;
}

interface DecodedJavaString {
  readonly units: readonly number[];
  readonly escapes: readonly EscapeSpec[];
  readonly unicodeEscapes: number;
}

interface DecodeFailure {
  readonly ok: false;
  readonly atomStart: number;
  readonly atomEnd: number;
}

type DecodeResult = { readonly ok: true; readonly value: DecodedJavaString } | DecodeFailure;

/** Exact left-to-right escape decoding into Java UTF-16 code units (parser.rs:909-996). */
function decodeJavaString(atoms: readonly Atom[], atomIndices: readonly number[]): DecodeResult {
  const units: number[] = [];
  const escapes: EscapeSpec[] = [];
  let unicodeEscapes = 0;
  let cursor = 0;
  while (cursor < atomIndices.length) {
    const atomIndex = atomIndices[cursor];
    const ch = atoms[atomIndex].ch;
    if (ch !== '\\') {
      units.push(...codeUnitsOf(ch));
      cursor += 1;
      continue;
    }
    const nextIndex = atomIndices[cursor + 1];
    if (nextIndex === undefined) {
      return { ok: false, atomStart: atomIndex, atomEnd: atomIndex + 1 };
    }
    const next = atoms[nextIndex].ch;
    const outputStart = units.length;
    let kind: PropertiesEscapeKind;
    let consumed: number;
    switch (next) {
      case 'u': {
        if (cursor + 6 > atomIndices.length) {
          return {
            ok: false,
            atomStart: atomIndex,
            atomEnd: (atomIndices[atomIndices.length - 1] ?? atomIndex) + 1,
          };
        }
        let value = 0;
        for (const digitIndex of atomIndices.slice(cursor + 2, cursor + 6)) {
          const digit = hexDigit(atoms[digitIndex].ch);
          if (digit === null) {
            return { ok: false, atomStart: atomIndex, atomEnd: digitIndex + 1 };
          }
          value = (value << 4) | digit;
        }
        units.push(value);
        unicodeEscapes += 1;
        kind = 'Unicode';
        consumed = 6;
        break;
      }
      case 't':
        units.push(0x09);
        kind = 'Named';
        consumed = 2;
        break;
      case 'n':
        units.push(0x0a);
        kind = 'Named';
        consumed = 2;
        break;
      case 'r':
        units.push(0x0d);
        kind = 'Named';
        consumed = 2;
        break;
      case 'f':
        units.push(0x0c);
        kind = 'Named';
        consumed = 2;
        break;
      case '\\':
        units.push(0x5c);
        kind = 'Backslash';
        consumed = 2;
        break;
      default:
        units.push(...codeUnitsOf(next));
        kind = 'DroppedBackslash';
        consumed = 2;
        break;
    }
    escapes.push({
      atomIndices: atomIndices.slice(cursor, cursor + consumed),
      kind,
      outputStart,
      outputEnd: units.length,
    });
    cursor += consumed;
  }
  return { ok: true, value: { units, escapes, unicodeEscapes } };
}

function hexDigit(character: string): number | null {
  if (character.length !== 1) {
    return null;
  }
  const code = character.charCodeAt(0);
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  return null;
}

/** Exact UTF-16 code units of one decoded scalar (parser.rs:921-924, 977-981). */
function codeUnitsOf(character: string): readonly number[] {
  if (character.length === 1) {
    return [character.charCodeAt(0)];
  }
  return [character.charCodeAt(0), character.charCodeAt(1)];
}

// ---------------------------------------------------------------------------
// Diagnostic sink (parser.rs:847-879)
// ---------------------------------------------------------------------------

class DiagnosticSink {
  readonly #maxDiagnostics: number;
  readonly #diagnostics: Diagnostic[] = [];
  #occurrence = 0n;

  constructor(maxDiagnostics: number) {
    this.#maxDiagnostics = maxDiagnostics;
  }

  push(code: string, category: DiagnosticCategory, start: number, end: number, identity: bigint): void {
    if (this.#diagnostics.length + 1 > this.#maxDiagnostics) {
      throw FatalFormationFailure.resourceLimit(
        'diagnostics',
        this.#diagnostics.length + 1,
        this.#maxDiagnostics,
      );
    }
    this.#diagnostics.push(
      diagnostic(
        code,
        category,
        'Error',
        { snapshot: identity, startByte: BigInt(start), endByte: BigInt(end) },
        this.#occurrence,
      ),
    );
    this.#occurrence += 1n;
  }

  finish(): readonly Diagnostic[] {
    return this.#diagnostics;
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

interface ScannedLine {
  readonly atomStart: number;
  readonly atomContentEnd: number;
  readonly atomEnd: number;
  readonly naturalIndex: number;
}

class Parser {
  readonly #source: SourceSnapshot;
  readonly #profile: PropertiesProfile;
  readonly #limits: PropertiesParseLimits;
  readonly #authority: DocumentAuthority;
  readonly #atoms: Atom[];
  readonly #rawStarts: Uint32Array;
  readonly #utf8Bytes: Uint32Array;
  readonly #jsIndexes: Uint32Array;
  readonly #diagnostics: DiagnosticSink;
  readonly #entities: Entity[] = [];
  #recovered = false;
  #totalJavaUnits = 0;
  #totalUnicodeEscapes = 0;
  #commentCount = 0;
  #logicalLineCount = 0;
  #propertyCount = 0;
  #escapeCount = 0;
  #errorLineCount = 0;
  readonly #lines: ScannedLine[] = [];

  constructor(
    source: SourceSnapshot,
    profile: PropertiesProfile,
    limits: PropertiesParseLimits,
    atoms: Atom[],
    rawStarts: Uint32Array,
    utf8Bytes: Uint32Array,
    jsIndexes: Uint32Array,
  ) {
    this.#source = source;
    this.#profile = profile;
    this.#limits = limits;
    this.#authority = DocumentAuthority.fresh();
    this.#atoms = atoms;
    this.#rawStarts = rawStarts;
    this.#utf8Bytes = utf8Bytes;
    this.#jsIndexes = jsIndexes;
    this.#diagnostics = new DiagnosticSink(limits.common.maxDiagnostics);
    this.#entities.push({ kind: 'Document' });
  }

  parse(): PropertiesDocument {
    this.scanNaturalLines();
    let lineIndex = 0;
    while (lineIndex < this.#lines.length) {
      if (this.isBlank(lineIndex)) {
        this.markLineContent(lineIndex, 'Whitespace');
        lineIndex += 1;
      } else if (this.isComment(lineIndex)) {
        this.addComment(lineIndex);
        lineIndex += 1;
      } else {
        lineIndex = this.addLogicalLine(lineIndex);
      }
    }
    this.assignDuplicateGroups();
    const { pieces, syntaxKinds } = this.buildStructuralPieces();
    const structuralIndex = LosslessStructuralIndex.create(
      this.#authority.identity(),
      this.#source.len(),
      pieces,
    );
    const orderedDiagnostics = sortDiagnostics(this.#diagnostics.finish());
    return new PropertiesDocument(
      this.#authority,
      this.#source,
      this.#profile,
      structuralIndex,
      syntaxKinds,
      this.#recovered ? 'Recovered' : 'Complete',
      orderedDiagnostics,
      this.#entities,
      this.#rawStarts,
      this.#utf8Bytes,
      this.#jsIndexes,
      this.#limits,
    );
  }

  // -- natural lines ---------------------------------------------------------

  scanNaturalLines(): void {
    let start = 0;
    if (
      this.#source.encodingFacts().bom() !== null &&
      this.#atoms.length > 0 &&
      this.#atoms[0].ch === '\uFEFF'
    ) {
      this.#atoms[0].syntax = 'Bom';
      start = 1;
    }
    let cursor = start;
    while (cursor < this.#atoms.length) {
      const lineStart = cursor;
      while (cursor < this.#atoms.length && this.#atoms[cursor].ch !== '\r' && this.#atoms[cursor].ch !== '\n') {
        cursor += 1;
      }
      const contentEnd = cursor;
      if (cursor < this.#atoms.length) {
        if (this.#atoms[cursor].ch === '\r' && this.#atoms[cursor + 1]?.ch === '\n') {
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      const end = cursor;
      this.checkLimit('natural-lines', this.#lines.length + 1, this.#limits.maxNaturalLines);
      const scalarCount = contentEnd - lineStart;
      this.checkLimit('natural-line-scalars', scalarCount, this.#limits.maxNaturalLineScalars);
      const span = this.atomSpan(lineStart, end);
      this.checkLimit('natural-line-bytes', span.len(), this.#limits.maxNaturalLineBytes);
      const contentSpan = this.atomSpan(lineStart, contentEnd);
      let lineBreakSpan: Span | null = null;
      if (contentEnd < end) {
        this.markAtoms(contentEnd, end, 'LineBreak');
        lineBreakSpan = this.atomSpan(contentEnd, end);
      }
      const naturalIndex = this.issueEntity('NaturalLine', {
        span,
        contentSpan,
        lineBreakSpan,
      });
      this.#lines.push({
        atomStart: lineStart,
        atomContentEnd: contentEnd,
        atomEnd: end,
        naturalIndex,
      });
    }
  }

  isBlank(lineIndex: number): boolean {
    const line = this.#lines[lineIndex];
    for (let index = line.atomStart; index < line.atomContentEnd; index++) {
      if (!isPropertiesWhitespace(this.#atoms[index].ch)) {
        return false;
      }
    }
    return true;
  }

  isComment(lineIndex: number): boolean {
    const line = this.#lines[lineIndex];
    for (let index = line.atomStart; index < line.atomContentEnd; index++) {
      if (!isPropertiesWhitespace(this.#atoms[index].ch)) {
        return this.#atoms[index].ch === '#' || this.#atoms[index].ch === '!';
      }
    }
    return false;
  }

  markLineContent(lineIndex: number, syntax: PropertiesSyntaxKind): void {
    const line = this.#lines[lineIndex];
    this.markAtoms(line.atomStart, line.atomContentEnd, syntax);
  }

  addComment(lineIndex: number): void {
    this.checkLimit('comments', this.#commentCount + 1, this.#limits.maxComments);
    const line = this.#lines[lineIndex];
    let markerIndex = line.atomStart;
    while (markerIndex < line.atomContentEnd && isPropertiesWhitespace(this.#atoms[markerIndex].ch)) {
      markerIndex += 1;
    }
    this.markAtoms(line.atomStart, markerIndex, 'Whitespace');
    this.markAtoms(markerIndex, markerIndex + 1, 'CommentMarker');
    this.markAtoms(markerIndex + 1, line.atomContentEnd, 'CommentText');
    this.issueEntity('Comment', {
      naturalLine: line.naturalIndex,
      span: this.atomSpan(line.atomStart, line.atomContentEnd),
      marker: this.#atoms[markerIndex].ch,
    });
    this.#commentCount += 1;
  }

  // -- logical lines ---------------------------------------------------------

  addLogicalLine(firstLine: number): number {
    this.checkLimit('logical-lines', this.#logicalLineCount + 1, this.#limits.maxLogicalLines);
    let lineIndex = firstLine;
    const naturalIndices: number[] = [];
    const logicalAtoms: number[] = [];
    for (;;) {
      const line = this.#lines[lineIndex];
      naturalIndices.push(line.naturalIndex);
      this.checkLimit('logical-line-natural-lines', naturalIndices.length, this.#limits.maxLogicalLineNaturalLines);
      let leadingCount = 0;
      if (lineIndex !== firstLine) {
        for (let index = line.atomStart; index < line.atomContentEnd; index++) {
          if (!isPropertiesWhitespace(this.#atoms[index].ch)) {
            break;
          }
          leadingCount += 1;
        }
      }
      // The trailing backslash run decides continuation (parser.rs:383-393).
      let slashRun = 0;
      for (let index = line.atomContentEnd - 1; index >= line.atomStart + leadingCount; index--) {
        if (this.#atoms[index].ch !== '\\') {
          break;
        }
        slashRun += 1;
      }
      const hasBreak = line.atomContentEnd < line.atomEnd;
      const removeTerminalSlash = slashRun % 2 === 1;
      const logicalEnd = removeTerminalSlash ? line.atomContentEnd - 1 : line.atomContentEnd;
      for (let index = line.atomStart + leadingCount; index < logicalEnd; index++) {
        logicalAtoms.push(index);
      }
      this.checkLimit('logical-line-scalars', logicalAtoms.length, this.#limits.maxLogicalLineScalars);
      if (removeTerminalSlash) {
        this.markAtoms(logicalEnd, line.atomContentEnd, 'ContinuationMarker');
      }
      if (removeTerminalSlash && hasBreak && lineIndex + 1 < this.#lines.length) {
        lineIndex += 1;
        continue;
      }
      break;
    }

    const nextLine = lineIndex + 1;
    const logicalNodeIndex = this.issueEntity('LogicalLine', {
      recordKind: 'Property',
      naturalLines: naturalIndices,
    });
    this.#logicalLineCount += 1;
    // Leading Properties whitespace over the assembled logical atoms
    // (parser.rs:421-425, take_while).
    let leading = 0;
    while (
      leading < logicalAtoms.length &&
      isPropertiesWhitespace(this.#atoms[logicalAtoms[leading]].ch)
    ) {
      leading += 1;
    }
    this.markLogicalPositions(logicalAtoms, 0, leading, 'Whitespace');
    const split = this.splitProperty(logicalAtoms, leading);
    this.markLogicalPositions(logicalAtoms, split.keyStart, split.keyEnd, 'Key');
    this.markLogicalPositions(logicalAtoms, split.keyEnd, split.valueStart, 'Separator');
    this.markLogicalPositions(logicalAtoms, split.valueStart, logicalAtoms.length, 'Value');

    const keyResult = decodeJavaString(this.#atoms, logicalAtoms.slice(split.keyStart, split.keyEnd));
    const valueResult = decodeJavaString(this.#atoms, logicalAtoms.slice(split.valueStart));
    if (!keyResult.ok) {
      this.recoverLogicalLine(
        logicalNodeIndex,
        naturalIndices,
        logicalAtoms,
        firstLine,
        lineIndex,
        keyResult,
      );
    } else if (!valueResult.ok) {
      this.recoverLogicalLine(
        logicalNodeIndex,
        naturalIndices,
        logicalAtoms,
        firstLine,
        lineIndex,
        valueResult,
      );
    } else {
      this.finishProperty(
        logicalNodeIndex,
        logicalAtoms,
        split,
        keyResult.value,
        valueResult.value,
        firstLine,
        lineIndex,
      );
    }
    return nextLine;
  }

  /** Key/separator/element separation over the assembled logical atoms (parser.rs:471-507; RFC 0010 §6). */
  splitProperty(
    logicalAtoms: readonly number[],
    keyStart: number,
  ): { keyStart: number; keyEnd: number; valueStart: number; hadSeparator: boolean } {
    let cursor = keyStart;
    let escaped = false;
    while (cursor < logicalAtoms.length) {
      const ch = this.#atoms[logicalAtoms[cursor]].ch;
      if (!escaped && (ch === '=' || ch === ':' || isPropertiesWhitespace(ch))) {
        break;
      }
      if (ch === '\\') {
        escaped = !escaped;
      } else {
        escaped = false;
      }
      cursor += 1;
    }
    const keyEnd = cursor;
    const hadSeparator = cursor < logicalAtoms.length;
    while (cursor < logicalAtoms.length && isPropertiesWhitespace(this.#atoms[logicalAtoms[cursor]].ch)) {
      cursor += 1;
    }
    if (cursor < logicalAtoms.length && (this.#atoms[logicalAtoms[cursor]].ch === '=' || this.#atoms[logicalAtoms[cursor]].ch === ':')) {
      cursor += 1;
    }
    while (cursor < logicalAtoms.length && isPropertiesWhitespace(this.#atoms[logicalAtoms[cursor]].ch)) {
      cursor += 1;
    }
    return { keyStart, keyEnd, valueStart: cursor, hadSeparator };
  }

  finishProperty(
    logicalNodeIndex: number,
    logicalAtoms: readonly number[],
    split: { keyStart: number; keyEnd: number; valueStart: number; hadSeparator: boolean },
    key: DecodedJavaString,
    value: DecodedJavaString,
    firstLine: number,
    lastLine: number,
  ): void {
    this.checkLimit('properties', this.#propertyCount + 1, this.#limits.maxProperties);
    this.checkLimit('java-code-units-per-string', key.units.length, this.#limits.maxJavaCodeUnitsPerString);
    this.checkLimit('java-code-units-per-string', value.units.length, this.#limits.maxJavaCodeUnitsPerString);
    const addedUnits = key.units.length + value.units.length;
    this.checkLimit('total-java-code-units', this.#totalJavaUnits + addedUnits, this.#limits.maxTotalJavaCodeUnits);
    const addedEscapes = key.escapes.length + value.escapes.length;
    const addedUnicodeEscapes = key.unicodeEscapes + value.unicodeEscapes;
    this.checkLimit('escapes', this.#escapeCount + addedEscapes, this.#limits.maxEscapes);
    this.checkLimit('unicode-escapes', this.#totalUnicodeEscapes + addedUnicodeEscapes, this.#limits.maxUnicodeEscapes);

    const span = this.logicalSourceSpan(firstLine, lastLine);
    const propertyIndex = this.issueEntity('Property', {
      logicalLine: logicalNodeIndex,
      span,
      keyAnchor: this.logicalAnchorSpan(logicalAtoms, split.keyStart, span.startByte()),
      valueAnchor: this.logicalAnchorSpan(logicalAtoms, split.valueStart, span.endByte()),
      keyFragments: this.fragmentSpans(logicalAtoms, split.keyStart, split.keyEnd),
      valueFragments: this.fragmentSpans(logicalAtoms, split.valueStart, logicalAtoms.length),
      key: JavaString.fromCodeUnits(key.units),
      value: JavaString.fromCodeUnits(value.units),
      valueState: valueStateOf(value.units, split.hadSeparator),
      escapes: [],
      duplicateGroup: null,
    });
    this.#propertyCount += 1;
    const escapeIndexes: number[] = [];
    for (const inKey of [true, false]) {
      const specs = inKey ? key.escapes : value.escapes;
      for (const spec of specs) {
        const escapeIndex = this.issueEntity('Escape', {
          property: propertyIndex,
          inKey,
          escapeKind: spec.kind,
          span: this.atomSpan(spec.atomIndices[0], spec.atomIndices[spec.atomIndices.length - 1] + 1),
          outputStart: spec.outputStart,
          outputEnd: spec.outputEnd,
        });
        this.#escapeCount += 1;
        this.#atoms[spec.atomIndices[0]].syntax = 'EscapeMarker';
        for (const atomIndex of spec.atomIndices.slice(1)) {
          this.#atoms[atomIndex].syntax = 'EscapeBody';
        }
        escapeIndexes.push(escapeIndex);
      }
    }
    const propertyEntity = this.#entities[propertyIndex];
    if (propertyEntity.kind === 'Property') {
      (propertyEntity as { kind: 'Property'; escapes: readonly number[] }).escapes = Object.freeze(escapeIndexes);
    }
    this.#totalJavaUnits += addedUnits;
    this.#totalUnicodeEscapes += addedUnicodeEscapes;
  }

  recoverLogicalLine(
    logicalNodeIndex: number,
    naturalIndices: readonly number[],
    logicalAtoms: readonly number[],
    firstLine: number,
    lastLine: number,
    failure: DecodeFailure,
  ): void {
    this.checkLimit('recovery-regions', this.#errorLineCount + 1, this.#limits.maxRecoveryRegions);
    for (const atomIndex of logicalAtoms) {
      this.#atoms[atomIndex].syntax = 'ErrorRegion';
    }
    const span = this.logicalSourceSpan(firstLine, lastLine);
    const errorSpan = this.atomSpan(failure.atomStart, failure.atomEnd);
    const code = 'java-properties.parse.malformed-unicode-escape@1';
    this.issueEntity('ErrorLine', {
      logicalLine: logicalNodeIndex,
      naturalLines: naturalIndices,
      span,
      code,
    });
    this.#errorLineCount += 1;
    this.#diagnostics.push(code, 'Syntax', errorSpan.startByte(), errorSpan.endByte(), this.#authority.identity().asBigInt());
    this.#recovered = true;
  }

  assignDuplicateGroups(): void {
    const groups = new Map<string, number[]>();
    for (let index = 0; index < this.#entities.length; index++) {
      const entity = this.#entities[index];
      if (entity.kind === 'Property') {
        const key = entity.key.utf16beHex();
        const group = groups.get(key);
        if (group === undefined) {
          groups.set(key, [index]);
        } else {
          group.push(index);
        }
      }
    }
    let nextGroup = 1;
    for (const indices of groups.values()) {
      if (indices.length <= 1) {
        continue;
      }
      this.checkLimit('duplicate-group-members', indices.length, this.#limits.maxDuplicateGroupMembers);
      const group = nextGroup;
      nextGroup += 1;
      for (const index of indices) {
        const entity = this.#entities[index];
        if (entity.kind === 'Property') {
          (entity as { kind: 'Property'; duplicateGroup: number | null }).duplicateGroup = group;
        }
      }
    }
  }

  buildStructuralPieces(): { pieces: StructuralPiece[]; syntaxKinds: PropertiesSyntaxKind[] } {
    const pieces: StructuralPiece[] = [];
    const syntaxKinds: PropertiesSyntaxKind[] = [];
    let cursor = 0;
    while (cursor < this.#atoms.length) {
      const syntax = this.#atoms[cursor].syntax ?? 'ErrorRegion';
      const kind = structuralKind(syntax);
      const start = cursor;
      cursor += 1;
      while (
        cursor < this.#atoms.length &&
        (this.#atoms[cursor].syntax ?? 'ErrorRegion') === syntax &&
        this.#atoms[cursor].rawStart === this.#atoms[cursor - 1].rawEnd
      ) {
        cursor += 1;
      }
      this.checkLimit('syntax-pieces', pieces.length + 1, this.#limits.common.maxTokenCount);
      pieces.push(new StructuralPiece(this.atomSpan(start, cursor), kind));
      syntaxKinds.push(syntax);
    }
    return { pieces, syntaxKinds };
  }

  // -- helpers ---------------------------------------------------------------

  markAtoms(start: number, end: number, syntax: PropertiesSyntaxKind): void {
    for (let index = start; index < end; index++) {
      this.#atoms[index].syntax = syntax;
    }
  }

  markLogicalPositions(logicalAtoms: readonly number[], start: number, end: number, syntax: PropertiesSyntaxKind): void {
    for (let position = start; position < end; position++) {
      this.#atoms[logicalAtoms[position]].syntax = syntax;
    }
  }

  fragmentSpans(logicalAtoms: readonly number[], start: number, end: number): readonly Span[] {
    const spans: Span[] = [];
    if (start >= end) {
      return spans;
    }
    let fragmentStart = logicalAtoms[start];
    let previous = fragmentStart;
    for (let position = start + 1; position < end; position++) {
      const current = logicalAtoms[position];
      if (this.#atoms[current].rawStart !== this.#atoms[previous].rawEnd) {
        spans.push(this.atomSpan(fragmentStart, previous + 1));
        fragmentStart = current;
      }
      previous = current;
    }
    spans.push(this.atomSpan(fragmentStart, previous + 1));
    return spans;
  }

  logicalSourceSpan(firstLine: number, lastLine: number): Span {
    const first = this.#lines[firstLine];
    const last = this.#lines[lastLine];
    return this.atomSpan(first.atomStart, last.atomContentEnd);
  }

  logicalAnchorSpan(logicalAtoms: readonly number[], position: number, emptyFallback: number): Span {
    const index = logicalAtoms[position];
    let raw: number;
    if (index !== undefined) {
      raw = this.#atoms[index].rawStart;
    } else {
      const last = logicalAtoms[logicalAtoms.length - 1];
      raw = last === undefined ? emptyFallback : this.#atoms[last].rawEnd;
    }
    return this.#authority.span(raw, raw);
  }

  atomSpan(start: number, end: number): Span {
    const rawStart = start < this.#atoms.length ? this.#atoms[start].rawStart : this.#source.len();
    const rawEnd =
      start === end ? rawStart : this.#atoms[end - 1] === undefined ? this.#source.len() : this.#atoms[end - 1].rawEnd;
    return this.#authority.span(rawStart, rawEnd);
  }

  issueEntity(kind: Entity['kind'], fields: object): number {
    const index = this.#entities.length;
    this.checkLimit('nodes', index + 1, this.#limits.common.maxNodeCount);
    this.#entities.push({ kind, ...fields } as Entity);
    return index;
  }

  checkLimit(name: string, observed: number, limit: number): void {
    if (observed > limit) {
      throw FatalFormationFailure.resourceLimit(name, observed, limit);
    }
  }
}

function valueStateOf(units: readonly number[], hadSeparator: boolean): PropertiesValueState {
  if (units.length === 0) {
    return hadSeparator ? 'ExplicitEmpty' : 'ImplicitEmpty';
  }
  return 'Present';
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Parses one immutable Properties snapshot under one exact profile/source
 * contract (parser.rs:17-36; lib.rs:777-785). Throws FatalFormationFailure —
 * no partial document ever exists.
 */
export function parse(
  bytes: Uint8Array,
  profile: PropertiesProfile,
  selection: PropertiesEncodingSelection,
  limits: PropertiesParseLimits,
): PropertiesDocument {
  if (bytes.length > limits.common.maxSourceBytes) {
    throw FatalFormationFailure.resourceLimit('source-bytes', bytes.length, limits.common.maxSourceBytes);
  }
  const request = encodingRequest(profile, selection);
  if (request === null) {
    throw profileFailure();
  }
  let source: SourceSnapshot;
  try {
    source = SourceSnapshot.fromRaw(bytes, request, {
      maxRawBytes: limits.common.maxSourceBytes,
      maxDecodedUtf8Bytes: limits.maxDecodedUtf8Bytes,
      maxDecodedScalars: limits.maxDecodedScalars,
    });
  } catch (error) {
    if (!(error instanceof SourceError)) {
      throw error;
    }
    throw FatalFormationFailure.sourceError(error);
  }
  if (!validateProfileEncoding(source, profile, selection)) {
    throw profileFailure();
  }
  const { atoms, rawStarts, utf8Bytes, jsIndexes } = buildAtoms(source);
  const parser = new Parser(source, profile, limits, atoms, rawStarts, utf8Bytes, jsIndexes);
  return parser.parse();
}

/** Parses Reader input using one explicit published text encoding (lib.rs:787-799). */
export function parseReader(
  bytes: Uint8Array,
  encoding: SourceEncoding,
  limits: PropertiesParseLimits,
): PropertiesDocument {
  return parse(bytes, 'ReaderV1', readerSelection(encoding), limits);
}

/** Parses InputStream-compatible Latin-1 bytes with marker bytes as content (lib.rs:801-812). */
export function parseLatin1(bytes: Uint8Array, limits: PropertiesParseLimits): PropertiesDocument {
  return parse(bytes, 'Latin1V1', latin1Selection(), limits);
}
