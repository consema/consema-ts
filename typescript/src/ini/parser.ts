/**
 * INI scanner and formation parser producing the lossless native model.
 *
 * authority: crates/consema-ini/src/parser.rs — the complete formation
 * pipeline: encoding request (:37-59), profile encoding validation (:61-94),
 * the profile failure (:96-104), physical-line scanning (:228-301),
 * per-line classification (:303-346), portable (:348-399), windows
 * (:401-467), python (:469-578), python continuation (:580-747),
 * add_section/add_entry/add_logical (:749-867), recovery (:869-905), syntax
 * pieces (:907-1050), raw span mapping (:1084-1130), node issuance and
 * limit checks (:1132-1156), diagnostics (:1158-1195), comparison names
 * (:1197-1210), duplicate-group assignment (:1212-1304), and the character
 * class helpers (:1307-1362). RFC 0009 §4 (:118-146) defines the
 * Complete/Recovered/FatalFormationFailure algebra.
 *
 * Design (TypeScript-idiomatic): the parser works over the decoded text
 * (a JS string) with a parallel per-scalar boundary index — the JS string
 * index and the exact raw-byte offset at every scalar boundary — so every
 * span is a raw-byte range regardless of the selected encoding (UTF-8,
 * UTF-16LE, Latin-1, or a Windows code page; the per-scalar raw width
 * mirrors document/source.ts rawStepWidth :1044-1059). All offsets in this
 * module are JS string indices unless noted. The native model is an entity
 * list indexed by the node index from the document authority, plus ordered
 * per-role index lists, mirroring the Rust parallel slices.
 */

import { DocumentAuthority, type NodeRole, type Span } from '../document/identity.ts';
import {
  LosslessStructuralIndex,
  StructuralPiece,
  type StructuralPieceKind,
} from '../document/structural.ts';
import {
  EncodingRequest,
  SourceSnapshot,
  utf8Encoding,
  type EncodingFacts,
  type SourceEncoding,
  type SourceLimits,
} from '../document/source.ts';
import { SourceError } from '../document/errors.ts';
import {
  sortDiagnostics,
  diagnostic as makeDiagnostic,
  type Diagnostic,
} from '../document/diagnostic.ts';
import {
  type IniEncodingSelection,
  type IniLogicalLineKind,
  type IniParseLimits,
  IniProfile,
  type IniQuoteStyle,
  type IniSyntaxKind,
  type IniValueState,
} from './profile.ts';
import { IniFormationFailure } from './errors.ts';
import { optionxform } from './python_case.ts';

// ---------------------------------------------------------------------------
// Native entity model
// ---------------------------------------------------------------------------

/** One structural entity payload bound to the snapshot (parser.rs Document fields). */
export type IniEntityKind =
  | { readonly role: 'Document' }
  | {
      readonly role: 'PhysicalLine';
      readonly contentSpan: Span;
      readonly lineBreakSpan: Span | null;
    }
  | {
      readonly role: 'LogicalLine';
      readonly kind: IniLogicalLineKind;
      readonly physicalLines: number[];
    }
  | {
      readonly role: 'Section' | 'DefaultSection';
      readonly logicalLine: number;
      readonly nameSpan: Span;
      readonly name: string;
      readonly comparisonName: string;
      readonly isDefault: boolean;
      readonly duplicateGroup: number | null;
    }
  | {
      readonly role: 'Entry';
      readonly logicalLine: number;
      readonly section: number;
      readonly keySpan: Span;
      readonly valueSpan: Span;
      readonly key: string;
      readonly comparisonKey: string;
      readonly value: string;
      readonly state: IniValueState;
      readonly quoteStyle: IniQuoteStyle;
      readonly duplicateGroup: number | null;
    }
  | {
      readonly role: 'ErrorLine';
      readonly logicalLine: number;
      readonly physicalLine: number;
      readonly span: Span;
      readonly code: string;
    };

/** One structural entity; the entity index is the node index issued by the authority. */
export interface IniEntity {
  readonly span: Span;
  readonly kind: IniEntityKind;
}

/** Construction-time entity payload; the parser mutates records before freezing the snapshot. */
type Mutable<T> = T extends unknown ? { -readonly [K in keyof T]: T[K] } : never;
type MutableIniEntityKind = Mutable<IniEntityKind>;

/** Construction-time entity record; frozen into IniEntity on completion. */
interface MutableIniEntity {
  span: Span;
  kind: MutableIniEntityKind;
}

/** Complete parse result: the root node index and every ordered index list. */
export interface IniParseOutput {
  /** @internal — the fresh authority that issued every entity index. */
  readonly authority: DocumentAuthority;
  /** @internal — the source snapshot that formed this output. */
  readonly source: SourceSnapshot;
  /** @internal — the selected profile. */
  readonly profile: IniProfile;
  /** @internal — the applied parse limits. */
  readonly limits: IniParseLimits;
  readonly root: number;
  readonly entities: readonly IniEntity[];
  readonly physicalLines: readonly number[];
  readonly logicalLines: readonly number[];
  readonly sections: readonly number[];
  readonly entries: readonly number[];
  readonly errorLines: readonly number[];
  readonly structuralIndex: LosslessStructuralIndex;
  readonly syntaxKinds: readonly IniSyntaxKind[];
  readonly diagnostics: readonly Diagnostic[];
  readonly recovered: boolean;
}

/** One scanned physical line in decoded (JS string index) coordinates (parser.rs:106-113). */
interface ScannedLine {
  readonly decodedStart: number;
  readonly decodedContentEnd: number;
  readonly decodedBreakStart: number;
  readonly decodedEnd: number;
  readonly physicalIndex: number;
}

/** Active Python entry continuation state (parser.rs:115-124). */
interface PythonEntryState {
  readonly entryIndex: number;
  readonly logicalIndex: number;
  readonly indent: number;
  continuationLines: number;
  logicalBytes: number;
  logicalScalars: number;
  pendingBlankLines: number[];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parses one immutable INI snapshot under exactly one selected profile
 * (lib.rs:663-671; parser.rs:16-35). Throws IniFormationFailure on any
 * fatal failure; a truncated success never exists (RFC 0009 §4).
 */
export function parseIni(
  bytes: Uint8Array,
  profile: IniProfile,
  selection: IniEncodingSelection,
  limits: IniParseLimits,
): IniParseOutput {
  const request = encodingRequest(profile, selection);
  let source: SourceSnapshot;
  try {
    source = SourceSnapshot.fromRaw(
      bytes,
      request,
      {
        maxRawBytes: limits.common.maxSourceBytes,
        maxDecodedUtf8Bytes: limits.maxDecodedUtf8Bytes,
        maxDecodedScalars: limits.maxDecodedScalars,
      } satisfies SourceLimits,
    );
  } catch (error) {
    if (error instanceof SourceError) {
      throw IniFormationFailure.source(error);
    }
    throw error;
  }
  validateProfileEncoding(source, profile, selection);
  return new IniParser(source, profile, limits).parse();
}

/** Builds the frozen source encoding request (parser.rs:37-59). */
function encodingRequest(
  profile: IniProfile,
  selection: IniEncodingSelection,
): EncodingRequest {
  const encoding =
    selection.kind === 'ProfileDefault' ? utf8Encoding() : selection.encoding;
  if (encoding.kind === 'Binary') {
    throw IniFormationFailure.profile();
  }
  let request = EncodingRequest.create(utf8Encoding());
  if (selection.kind === 'Explicit') {
    request = request.withCallerOverride(encoding);
  }
  if (encoding.kind === 'WindowsCodePage') {
    request = request.withBomPolicy('TreatAsContent');
  }
  if (profile.tag() === 'PortableV1' && encoding.kind !== 'Utf8') {
    throw IniFormationFailure.profile();
  }
  return request;
}

/** Enforces the frozen per-profile encoding contract (parser.rs:61-94). */
function validateProfileEncoding(
  source: SourceSnapshot,
  profile: IniProfile,
  selection: IniEncodingSelection,
): void {
  const facts = source.encodingFacts();
  const valid = profileEncodingValid(source, profile, selection, facts);
  if (!valid) {
    throw IniFormationFailure.profile();
  }
}

function profileEncodingValid(
  source: SourceSnapshot,
  profile: IniProfile,
  selection: IniEncodingSelection,
  facts: EncodingFacts,
): boolean {
  switch (profile.tag()) {
    case 'PortableV1':
      return facts.selected().kind === 'Utf8' && facts.bom() === null;
    case 'WindowsV1': {
      if (selection.kind === 'ProfileDefault') {
        return (
          (facts.selected().kind === 'Utf16Le' && facts.bom() === 'Utf16Le') ||
          (facts.selected().kind === 'Utf8' && facts.bom() === null && allAscii(source.bytes()))
        );
      }
      const encoding = selection.encoding;
      if (encoding.kind === 'Utf16Le') {
        return facts.selected().kind === 'Utf16Le' && facts.bom() === 'Utf16Le';
      }
      if (encoding.kind === 'WindowsCodePage') {
        const selected = facts.selected();
        return (
          selected.kind === 'WindowsCodePage' &&
          selected.codePage.equals(encoding.codePage) &&
          facts.bomPolicy() === 'TreatAsContent' &&
          facts.bom() === null
        );
      }
      return false;
    }
    case 'PythonConfigParserV1':
      return facts.selected().kind !== 'Binary';
  }
}

function allAscii(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte >= 0x80) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class IniParser {
  readonly #source: SourceSnapshot;
  readonly #profile: IniProfile;
  readonly #limits: IniParseLimits;
  readonly #authority: DocumentAuthority;
  readonly #text: string;
  /** JS string index at each scalar boundary (length = scalars + 1). */
  readonly #stringAt: number[];
  /** Raw byte offset at each scalar boundary (length = scalars + 1). */
  readonly #rawAt: number[];
  readonly #lines: ScannedLine[] = [];
  readonly #entities: MutableIniEntity[] = [];
  readonly #physicalLines: number[] = [];
  readonly #logicalLines: number[] = [];
  readonly #sections: number[] = [];
  readonly #entries: number[] = [];
  readonly #entrySectionIndices: number[] = [];
  readonly #errorLines: number[] = [];
  readonly #pieces: StructuralPiece[] = [];
  readonly #syntaxKinds: IniSyntaxKind[] = [];
  readonly #diagnostics: Diagnostic[] = [];
  #nextNode = 1;
  #occurrence = 0;
  #recovered = false;
  #currentSection: number | null = null;
  #pythonEntry: PythonEntryState | null = null;

  constructor(source: SourceSnapshot, profile: IniProfile, limits: IniParseLimits) {
    this.#source = source;
    this.#profile = profile;
    this.#limits = limits;
    this.#authority = DocumentAuthority.fresh();
    this.#text = source.decodedText() ?? '';
    const boundaries = this.#buildBoundaries();
    this.#stringAt = boundaries.stringAt;
    this.#rawAt = boundaries.rawAt;
    const rootSpan = this.#authority.span(0, source.len());
    this.#entities.push({ span: rootSpan, kind: { role: 'Document' } });
  }

  parse(): IniParseOutput {
    this.#scanPhysicalLines();
    this.#pushBom();
    for (let lineIndex = 0; lineIndex < this.#lines.length; lineIndex++) {
      this.#parseLine(lineIndex);
      this.#pushLineBreak(lineIndex);
    }
    if (this.#profile.tag() === 'PortableV1' && this.#sections.length === 0) {
      const at = this.#source.len();
      this.#diagnostic('ini.parse.missing-section@1', 'Conformance', at, at, true);
    }
    this.#assignDuplicateGroups();
    let structuralIndex: LosslessStructuralIndex;
    try {
      structuralIndex = LosslessStructuralIndex.create(
        this.#authority.identity(),
        this.#source.len(),
        this.#pieces,
      );
    } catch {
      throw IniFormationFailure.resourceLimit('source-coordinate-coverage', 1, 0);
    }
    return {
      authority: this.#authority,
      source: this.#source,
      profile: this.#profile,
      limits: this.#limits,
      root: 0,
      entities: this.#entities,
      physicalLines: this.#physicalLines,
      logicalLines: this.#logicalLines,
      sections: this.#sections,
      entries: this.#entries,
      errorLines: this.#errorLines,
      structuralIndex,
      syntaxKinds: this.#syntaxKinds,
      diagnostics: sortDiagnostics(this.#diagnostics),
      recovered: this.#recovered,
    };
  }

  // -- scalar boundary index -------------------------------------------------

  /** Builds per-scalar JS-string-index and raw-byte-offset boundaries (source.ts:1044-1059 rule). */
  #buildBoundaries(): { stringAt: number[]; rawAt: number[] } {
    const stringAt = [0];
    const rawAt = [0];
    let stringIndex = 0;
    let raw = 0;
    for (const character of this.#text) {
      stringIndex += character.length;
      raw += rawWidthOf(this.#source.encodingFacts().selected(), character);
      stringAt.push(stringIndex);
      rawAt.push(raw);
    }
    return { stringAt, rawAt };
  }

  /** Scalar boundary index of one JS string index (all call sites pass scalar boundaries). */
  #scalarOf(stringIndex: number): number {
    let low = 0;
    let high = this.#stringAt.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.#stringAt[mid] <= stringIndex) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    const index = low - 1;
    if (this.#stringAt[index] !== stringIndex) {
      throw new Error('internal: ini parser offset is not a scalar boundary');
    }
    return index;
  }

  /** Raw byte span of one decoded (JS string index) range (parser.rs:1109-1125). */
  #rawSpan(start: number, end: number): Span {
    return this.#authority.span(this.#rawAt[this.#scalarOf(start)], this.#rawAt[this.#scalarOf(end)]);
  }

  // -- physical line scan (parser.rs:228-301) ----------------------------------

  #scanPhysicalLines(): void {
    const bom = this.#source.encodingFacts().bom();
    const skipBom = bom !== null && this.#text.startsWith('\u{feff}') ? 1 : 0;
    let start = this.#stringAt[skipBom];
    while (start < this.#text.length) {
      const newline = this.#text.indexOf('\n', start);
      let contentEnd: number;
      let breakStart: number;
      let end: number;
      if (newline >= 0) {
        breakStart = newline > start && this.#text.charCodeAt(newline - 1) === 0x0d ? newline - 1 : newline;
        contentEnd = breakStart;
        end = newline + 1;
      } else {
        contentEnd = this.#text.length;
        breakStart = this.#text.length;
        end = this.#text.length;
      }
      const observed = this.#lines.length + 1;
      this.#checkLimit('physical-lines', observed, this.#limits.maxPhysicalLines);
      const scalarCount = this.#scalarOf(contentEnd) - this.#scalarOf(start);
      const fullSpan = this.#rawSpan(start, end);
      this.#checkLimit('physical-line-bytes', fullSpan.len(), this.#limits.maxPhysicalLineBytes);
      this.#checkLimit('physical-line-scalars', scalarCount, this.#limits.maxPhysicalLineScalars);
      const contentSpan = this.#rawSpan(start, contentEnd);
      const lineBreakSpan = breakStart < end ? this.#rawSpan(breakStart, end) : null;
      this.#issueNode('IniPhysicalLine');
      const physicalIndex = this.#physicalLines.length;
      this.#entities.push({ span: fullSpan, kind: { role: 'PhysicalLine', contentSpan, lineBreakSpan } });
      this.#physicalLines.push(this.#entities.length - 1);
      this.#lines.push({
        decodedStart: start,
        decodedContentEnd: contentEnd,
        decodedBreakStart: breakStart,
        decodedEnd: end,
        physicalIndex,
      });
      start = end;
    }
  }

  // -- line classification (parser.rs:303-346) ---------------------------------

  #parseLine(lineIndex: number): void {
    const line = this.#lines[lineIndex];
    const content = this.#text.slice(line.decodedStart, line.decodedContentEnd);
    if (content.includes('\0') || content.includes('\r')) {
      this.#recoverLine(lineIndex, 'ini.parse.invalid-character@1');
      return;
    }
    if (this.#profile.tag() === 'PortableV1') {
      for (const character of content) {
        const code = character.codePointAt(0)!;
        if (code !== 0x09 && !(code >= 0x20 && code <= 0x7e)) {
          this.#recoverLine(lineIndex, 'ini.parse.invalid-character@1');
          return;
        }
      }
    }
    if (allHorizontal(content)) {
      if (content.length > 0) {
        this.#pushPiece(line.decodedStart, line.decodedContentEnd, 'Trivia', 'Whitespace');
      }
      if (this.#profile.tag() === 'PythonConfigParserV1' && this.#pythonEntry !== null) {
        this.#pythonEntry.pendingBlankLines.push(lineIndex);
      }
      return;
    }
    const leading = leadingHorizontal(content);
    const marker = content.charCodeAt(leading);
    const isComment =
      this.#profile.tag() === 'PythonConfigParserV1'
        ? marker === 0x3b || marker === 0x23
        : marker === 0x3b;
    if (isComment) {
      this.#pushComment(line, leading);
      return;
    }
    switch (this.#profile.tag()) {
      case 'PortableV1':
        this.#parsePortableLine(lineIndex);
        break;
      case 'WindowsV1':
        this.#parseWindowsLine(lineIndex);
        break;
      case 'PythonConfigParserV1':
        this.#parsePythonLine(lineIndex);
        break;
    }
  }

  #parsePortableLine(lineIndex: number): void {
    this.#pythonEntry = null;
    const line = this.#lines[lineIndex];
    const content = this.#text.slice(line.decodedStart, line.decodedContentEnd);
    if (content.startsWith('[')) {
      if (
        line.decodedBreakStart === line.decodedEnd ||
        !content.endsWith(']') ||
        content.length < 3
      ) {
        this.#recoverLine(lineIndex, 'ini.parse.malformed-section@1');
        return;
      }
      const name = content.slice(1, content.length - 1);
      if (!allBytes(name, isPortableName)) {
        this.#recoverLine(lineIndex, 'ini.parse.invalid-character@1');
        return;
      }
      this.#pushSectionSyntax(line, 0, 1, content.length - 1, content.length);
      this.#addSection(lineIndex, 1, content.length - 1, name, false);
    } else {
      const delimiter = content.indexOf('=');
      if (delimiter < 0) {
        this.#recoverLine(lineIndex, 'ini.parse.missing-delimiter@1');
        return;
      }
      const key = content.slice(0, delimiter);
      const value = content.slice(delimiter + 1);
      if (key.length === 0 || !allBytes(key, isPortableName)) {
        this.#recoverLine(lineIndex, 'ini.parse.invalid-character@1');
        return;
      }
      if (!allBytes(value, isPortableValue)) {
        this.#recoverLine(lineIndex, 'ini.parse.invalid-character@1');
        return;
      }
      const sectionIndex = this.#currentSection;
      if (sectionIndex === null) {
        this.#recoverLine(lineIndex, 'ini.parse.missing-section@1');
        return;
      }
      this.#pushEntrySyntax(line, 0, delimiter, delimiter, delimiter + 1, delimiter + 1, content.length, null);
      this.#addEntry(
        lineIndex,
        sectionIndex,
        0,
        delimiter,
        delimiter + 1,
        content.length,
        key,
        value,
        'None',
      );
    }
  }

  #parseWindowsLine(lineIndex: number): void {
    this.#pythonEntry = null;
    const line = this.#lines[lineIndex];
    const content = this.#text.slice(line.decodedStart, line.decodedContentEnd);
    const [trimStart, trimEnd] = trimHorizontalBounds(content);
    const core = content.slice(trimStart, trimEnd);
    if (core.startsWith('[')) {
      if (!core.endsWith(']') || core.length < 3) {
        this.#recoverLine(lineIndex, 'ini.parse.malformed-section@1');
        return;
      }
      const name = core.slice(1, core.length - 1);
      if (!allBytes(name, isWindowsName)) {
        this.#recoverLine(lineIndex, 'ini.parse.invalid-character@1');
        return;
      }
      this.#pushOptionalWhitespace(line, 0, trimStart);
      this.#pushSectionSyntax(line, trimStart, trimStart + 1, trimEnd - 1, trimEnd);
      this.#pushOptionalWhitespace(line, trimEnd, content.length);
      this.#addSection(lineIndex, trimStart + 1, trimEnd - 1, name, false);
    } else {
      const relative = content.indexOf('=', trimStart);
      if (relative < 0) {
        this.#recoverLine(lineIndex, 'ini.parse.missing-delimiter@1');
        return;
      }
      const [relativeKeyStart, relativeKeyEnd] = trimHorizontalBounds(content.slice(trimStart, relative));
      const keyStart = trimStart + relativeKeyStart;
      const keyEnd = trimStart + relativeKeyEnd;
      const key = content.slice(keyStart, keyEnd);
      if (key.length === 0 || !allBytes(key, isWindowsName)) {
        this.#recoverLine(lineIndex, 'ini.parse.invalid-character@1');
        return;
      }
      const sectionIndex = this.#currentSection;
      if (sectionIndex === null) {
        this.#recoverLine(lineIndex, 'ini.parse.missing-section@1');
        return;
      }
      const literalStart = relative + 1;
      const literalEnd = content.length;
      const literal = content.slice(literalStart, literalEnd);
      const [valueRange, quoteStyle] = quotedWindowsValue(literal, literalStart);
      const value = content.slice(valueRange.start, valueRange.end);
      this.#pushOptionalWhitespace(line, 0, keyStart);
      this.#pushPieceLocal(line, keyStart, keyEnd, 'Token', 'EntryKey');
      this.#pushOptionalWhitespace(line, keyEnd, relative);
      this.#pushPieceLocal(line, relative, relative + 1, 'Token', 'Delimiter');
      this.#pushWindowsValueSyntax(line, literalStart, literalEnd, valueRange, quoteStyle);
      this.#addEntry(
        lineIndex,
        sectionIndex,
        keyStart,
        keyEnd,
        valueRange.start,
        valueRange.end,
        key,
        value,
        quoteStyle,
      );
    }
  }

  #parsePythonLine(lineIndex: number): void {
    const line = this.#lines[lineIndex];
    const content = this.#text.slice(line.decodedStart, line.decodedContentEnd);
    const indent = leadingHorizontal(content);
    if (this.#pythonEntry !== null && indent > this.#pythonEntry.indent) {
      this.#addPythonContinuation(lineIndex, indent);
      return;
    }
    if (this.#pythonEntry !== null) {
      this.#pythonEntry.pendingBlankLines = [];
    }
    this.#pythonEntry = null;
    const [trimStart, trimEnd] = trimHorizontalBounds(content);
    const core = content.slice(trimStart, trimEnd);
    if (core.startsWith('[')) {
      if (!core.endsWith(']') || core.length < 3) {
        this.#recoverLine(lineIndex, 'ini.parse.malformed-section@1');
        return;
      }
      const name = core.slice(1, core.length - 1);
      this.#pushOptionalWhitespace(line, 0, trimStart);
      this.#pushSectionSyntax(line, trimStart, trimStart + 1, trimEnd - 1, trimEnd);
      this.#pushOptionalWhitespace(line, trimEnd, content.length);
      this.#addSection(lineIndex, trimStart + 1, trimEnd - 1, name, name === 'DEFAULT');
      return;
    }
    const relative = firstPythonDelimiter(content.slice(trimStart));
    const delimiter = relative === null ? null : trimStart + relative;
    if (delimiter === null) {
      this.#recoverLine(
        lineIndex,
        indent > 0 ? 'ini.parse.invalid-continuation@1' : 'ini.parse.missing-delimiter@1',
      );
      return;
    }
    const [relativeKeyStart, relativeKeyEnd] = trimHorizontalBounds(content.slice(trimStart, delimiter));
    const keyStart = trimStart + relativeKeyStart;
    const keyEnd = trimStart + relativeKeyEnd;
    if (keyStart === keyEnd) {
      this.#recoverLine(lineIndex, 'ini.parse.malformed-line@1');
      return;
    }
    const sectionIndex = this.#currentSection;
    if (sectionIndex === null) {
      this.#recoverLine(lineIndex, 'ini.parse.missing-section@1');
      return;
    }
    const [relativeValueStart, relativeValueEnd] = trimHorizontalBounds(content.slice(delimiter + 1));
    const valueStart = delimiter + 1 + relativeValueStart;
    const valueEnd = delimiter + 1 + relativeValueEnd;
    const key = content.slice(keyStart, keyEnd);
    const value = content.slice(valueStart, valueEnd);
    this.#pushOptionalWhitespace(line, 0, keyStart);
    this.#pushPieceLocal(line, keyStart, keyEnd, 'Token', 'EntryKey');
    this.#pushOptionalWhitespace(line, keyEnd, delimiter);
    this.#pushPieceLocal(line, delimiter, delimiter + 1, 'Token', 'Delimiter');
    this.#pushOptionalWhitespace(line, delimiter + 1, valueStart);
    if (valueStart < valueEnd) {
      this.#pushPieceLocal(line, valueStart, valueEnd, 'Token', 'EntryValue');
    }
    this.#pushOptionalWhitespace(line, valueEnd, content.length);
    const entryIndex = this.#addEntry(
      lineIndex,
      sectionIndex,
      keyStart,
      keyEnd,
      valueStart,
      valueEnd,
      key,
      value,
      'None',
    );
    const entryKind = this.#entities[entryIndex].kind;
    if (entryKind.role !== 'Entry') {
      throw new Error('internal: ini entry entity expected');
    }
    const logicalIndex = this.#logicalLines.indexOf(entryKind.logicalLine);
    const physical = this.#entities[this.#physicalLines[line.physicalIndex]].span;
    this.#pythonEntry = {
      entryIndex,
      logicalIndex,
      indent,
      continuationLines: 0,
      logicalBytes: physical.len(),
      logicalScalars: content.length === 0 ? 0 : [...content].length,
      pendingBlankLines: [],
    };
  }

  #addPythonContinuation(lineIndex: number, indent: number): void {
    const line = this.#lines[lineIndex];
    const content = this.#text.slice(line.decodedStart, line.decodedContentEnd);
    const [, relativeValueEnd] = trimHorizontalBounds(content.slice(indent));
    const valueStart = indent;
    const valueEnd = indent + relativeValueEnd;
    const state = this.#pythonEntry!;
    this.#pythonEntry = null;
    const addedLines = state.pendingBlankLines.length + 1;
    const continuationLines = state.continuationLines + addedLines;
    this.#checkLimit('continuation-lines', continuationLines, this.#limits.maxContinuationLines);

    let pendingBytes = 0;
    let pendingScalars = 0;
    for (const pending of state.pendingBlankLines) {
      const pendingLine = this.#lines[pending];
      const physical = this.#entities[this.#physicalLines[pendingLine.physicalIndex]].span;
      pendingBytes += physical.len();
      pendingScalars += scalarCountOf(this.#text, pendingLine.decodedStart, pendingLine.decodedContentEnd);
    }
    const physical = this.#entities[this.#physicalLines[line.physicalIndex]].span;
    const logicalBytes = state.logicalBytes + pendingBytes + physical.len();
    this.#checkLimit('logical-line-bytes', logicalBytes, this.#limits.maxLogicalLineBytes);
    const logicalScalars = state.logicalScalars + pendingScalars + scalarCountOf(this.#text, line.decodedStart, line.decodedContentEnd);
    this.#checkLimit('logical-line-scalars', logicalScalars, this.#limits.maxLogicalLineScalars);

    const fragment = content.slice(valueStart, valueEnd);
    const entryEntity = this.#entities[state.entryIndex];
    if (entryEntity.kind.role !== 'Entry') {
      throw new Error('internal: ini entry entity expected');
    }
    const valueStorageBytes = entryEntity.kind.value.length + addedLines + fragment.length;
    this.#checkLimit('logical-value-storage-bytes', valueStorageBytes, this.#limits.maxDecodedUtf8Bytes);
    let joined = entryEntity.kind.value;
    const logical = this.#entities[this.#logicalLines[state.logicalIndex]];
    if (logical.kind.role !== 'LogicalLine') {
      throw new Error('internal: ini logical-line entity expected');
    }
    for (const pending of state.pendingBlankLines) {
      const pendingLine = this.#lines[pending];
      const physicalNode = this.#entities[this.#physicalLines[pendingLine.physicalIndex]];
      if (physicalNode.kind.role !== 'PhysicalLine') {
        throw new Error('internal: ini physical-line entity expected');
      }
      logical.kind.physicalLines.push(this.#physicalLines[pendingLine.physicalIndex]);
      joined += '\n';
    }
    logical.kind.physicalLines.push(this.#physicalLines[line.physicalIndex]);
    joined += '\n';
    joined += fragment;
    entryEntity.kind.value = joined;
    entryEntity.kind.state = joined.length === 0 ? 'Empty' : 'Present';
    this.#pushPieceLocal(line, 0, indent, 'Trivia', 'ContinuationMarker');
    if (valueStart < valueEnd) {
      this.#pushPieceLocal(line, valueStart, valueEnd, 'Token', 'EntryValue');
    }
    this.#pushOptionalWhitespace(line, valueEnd, content.length);
    state.continuationLines = continuationLines;
    state.logicalBytes = logicalBytes;
    state.logicalScalars = logicalScalars;
    state.pendingBlankLines = [];
    this.#pythonEntry = state;
  }

  // -- record construction (parser.rs:749-867) ---------------------------------

  #addSection(
    lineIndex: number,
    nameStart: number,
    nameEnd: number,
    name: string,
    isDefault: boolean,
  ): void {
    this.#checkLimit('sections', this.#sections.length + 1, this.#limits.maxSections);
    const line = this.#lines[lineIndex];
    const logicalIndex = this.#addLogical(lineIndex, 'Section');
    const role: NodeRole = isDefault ? 'IniDefaultSection' : 'IniSection';
    this.#issueNode(role);
    const physical = this.#entities[this.#physicalLines[line.physicalIndex]];
    if (physical.kind.role !== 'PhysicalLine') {
      throw new Error('internal: ini physical-line entity expected');
    }
    const sectionIndex = this.#entities.length;
    this.#entities.push({
      span: physical.kind.contentSpan,
      kind: {
        role: isDefault ? 'DefaultSection' : 'Section',
        logicalLine: logicalIndex,
        nameSpan: this.#rawSpan(line.decodedStart + nameStart, line.decodedStart + nameEnd),
        name,
        comparisonName: this.#sectionComparison(name),
        isDefault,
        duplicateGroup: null,
      },
    });
    this.#sections.push(sectionIndex);
    this.#currentSection = sectionIndex;
    this.#pythonEntry = null;
  }

  #addEntry(
    lineIndex: number,
    sectionIndex: number,
    keyStart: number,
    keyEnd: number,
    valueStart: number,
    valueEnd: number,
    key: string,
    value: string,
    quoteStyle: IniQuoteStyle,
  ): number {
    this.#checkLimit('entries', this.#entries.length + 1, this.#limits.maxEntries);
    const line = this.#lines[lineIndex];
    const logicalIndex = this.#addLogical(lineIndex, 'Entry');
    this.#issueNode('IniEntry');
    const physical = this.#entities[this.#physicalLines[line.physicalIndex]];
    if (physical.kind.role !== 'PhysicalLine') {
      throw new Error('internal: ini physical-line entity expected');
    }
    const state: IniValueState = value.length === 0 ? 'Empty' : 'Present';
    const entryIndex = this.#entities.length;
    this.#entities.push({
      span: physical.kind.contentSpan,
      kind: {
        role: 'Entry',
        logicalLine: logicalIndex,
        // sectionIndex is the section ENTITY index (from #currentSection).
        section: sectionIndex,
        keySpan: this.#rawSpan(line.decodedStart + keyStart, line.decodedStart + keyEnd),
        valueSpan: this.#rawSpan(line.decodedStart + valueStart, line.decodedStart + valueEnd),
        key,
        comparisonKey: this.#keyComparison(key),
        value,
        state,
        quoteStyle,
        duplicateGroup: null,
      },
    });
    this.#entries.push(entryIndex);
    this.#entrySectionIndices.push(sectionIndex);
    return entryIndex;
  }

  #addLogical(lineIndex: number, kind: IniLogicalLineKind): number {
    this.#checkLimit('logical-lines', this.#logicalLines.length + 1, this.#limits.maxLogicalLines);
    const line = this.#lines[lineIndex];
    const physical = this.#entities[this.#physicalLines[line.physicalIndex]];
    if (physical.kind.role !== 'PhysicalLine') {
      throw new Error('internal: ini physical-line entity expected');
    }
    const physicalSpan = physical.span;
    this.#checkLimit('logical-line-bytes', physicalSpan.len(), this.#limits.maxLogicalLineBytes);
    this.#checkLimit(
      'logical-line-scalars',
      scalarCountOf(this.#text, line.decodedStart, line.decodedContentEnd),
      this.#limits.maxLogicalLineScalars,
    );
    this.#issueNode('IniLogicalLine');
    const logicalIndex = this.#entities.length;
    this.#entities.push({
      span: physicalSpan,
      kind: {
        role: 'LogicalLine',
        kind,
        physicalLines: [this.#physicalLines[line.physicalIndex]],
      },
    });
    this.#logicalLines.push(logicalIndex);
    return logicalIndex;
  }

  // -- recovery (parser.rs:869-905) ----------------------------------------------

  #recoverLine(lineIndex: number, code: string): void {
    this.#checkLimit('recovery-regions', this.#errorLines.length + 1, this.#limits.maxRecoveryRegions);
    this.#pythonEntry = null;
    const line = this.#lines[lineIndex];
    if (line.decodedStart < line.decodedContentEnd) {
      this.#pushPiece(line.decodedStart, line.decodedContentEnd, 'ErrorRegion', 'ErrorRegion');
    }
    const logicalIndex = this.#addLogical(lineIndex, 'Error');
    this.#issueNode('IniErrorLine');
    const physical = this.#entities[this.#physicalLines[line.physicalIndex]];
    if (physical.kind.role !== 'PhysicalLine') {
      throw new Error('internal: ini physical-line entity expected');
    }
    this.#entities.push({
      span: physical.kind.contentSpan,
      kind: {
        role: 'ErrorLine',
        logicalLine: logicalIndex,
        physicalLine: this.#physicalLines[line.physicalIndex],
        span: physical.kind.contentSpan,
        code,
      },
    });
    this.#errorLines.push(this.#entities.length - 1);
    this.#diagnostic(code, 'Syntax', physical.kind.contentSpan.startByte(), physical.kind.contentSpan.endByte(), true);
  }

  // -- syntax pieces (parser.rs:907-1072) -------------------------------------------

  #pushBom(): void {
    const bom = this.#source.encodingFacts().bom();
    if (bom !== null && this.#text.startsWith('\u{feff}')) {
      this.#pushPiece(0, '\u{feff}'.length, 'Trivia', 'Bom');
    }
  }

  #pushComment(line: ScannedLine, leading: number): void {
    this.#pushOptionalWhitespace(line, 0, leading);
    this.#pushPieceLocal(line, leading, leading + 1, 'Trivia', 'CommentMarker');
    const len = line.decodedContentEnd - line.decodedStart;
    if (leading + 1 < len) {
      this.#pushPieceLocal(line, leading + 1, len, 'Trivia', 'CommentText');
    }
  }

  #pushSectionSyntax(
    line: ScannedLine,
    open: number,
    nameStart: number,
    nameEnd: number,
    closeEnd: number,
  ): void {
    this.#pushPieceLocal(line, open, nameStart, 'Token', 'SectionOpen');
    this.#pushPieceLocal(line, nameStart, nameEnd, 'Token', 'SectionName');
    this.#pushPieceLocal(line, nameEnd, closeEnd, 'Token', 'SectionClose');
  }

  #pushEntrySyntax(
    line: ScannedLine,
    keyStart: number,
    keyEnd: number,
    delimiterStart: number,
    delimiterEnd: number,
    valueStart: number,
    valueEnd: number,
    quote: { readonly open: [number, number]; readonly close: [number, number] } | null,
  ): void {
    this.#pushPieceLocal(line, keyStart, keyEnd, 'Token', 'EntryKey');
    this.#pushPieceLocal(line, delimiterStart, delimiterEnd, 'Token', 'Delimiter');
    if (quote !== null) {
      this.#pushPieceLocal(line, quote.open[0], quote.open[1], 'Token', 'Quote');
      if (valueStart < valueEnd) {
        this.#pushPieceLocal(line, valueStart, valueEnd, 'Token', 'EntryValue');
      }
      this.#pushPieceLocal(line, quote.close[0], quote.close[1], 'Token', 'Quote');
    } else if (valueStart < valueEnd) {
      this.#pushPieceLocal(line, valueStart, valueEnd, 'Token', 'EntryValue');
    }
  }

  #pushWindowsValueSyntax(
    line: ScannedLine,
    literalStart: number,
    literalEnd: number,
    valueRange: { start: number; end: number },
    quoteStyle: IniQuoteStyle,
  ): void {
    if (quoteStyle === 'None') {
      this.#pushEntrySyntax(line, 0, 0, 0, 0, literalStart, literalEnd, null);
      return;
    }
    this.#pushEntrySyntax(
      line,
      0,
      0,
      0,
      0,
      valueRange.start,
      valueRange.end,
      { open: [literalStart, valueRange.start], close: [valueRange.end, literalEnd] },
    );
  }

  #pushLineBreak(lineIndex: number): void {
    const line = this.#lines[lineIndex];
    if (line.decodedBreakStart < line.decodedEnd) {
      this.#pushPiece(line.decodedBreakStart, line.decodedEnd, 'Trivia', 'LineBreak');
    }
  }

  #pushOptionalWhitespace(line: ScannedLine, start: number, end: number): void {
    if (start < end) {
      this.#pushPieceLocal(line, start, end, 'Trivia', 'Whitespace');
    }
  }

  #pushPieceLocal(
    line: ScannedLine,
    start: number,
    end: number,
    kind: StructuralPieceKind,
    syntax: IniSyntaxKind,
  ): void {
    if (start === end) {
      return;
    }
    this.#pushPiece(line.decodedStart + start, line.decodedStart + end, kind, syntax);
  }

  #pushPiece(
    start: number,
    end: number,
    kind: StructuralPieceKind,
    syntax: IniSyntaxKind,
  ): void {
    const observed = this.#pieces.length + 1;
    this.#checkLimit('syntax-pieces', observed, this.#limits.common.maxTokenCount);
    const span = this.#rawSpan(start, end);
    if (span.isEmpty()) {
      throw IniFormationFailure.resourceLimit('source-coordinate-coverage', 1, 0);
    }
    this.#pieces.push(new StructuralPiece(span, kind));
    this.#syntaxKinds.push(syntax);
  }

  // -- nodes, limits, diagnostics (parser.rs:1132-1195) -----------------------------

  #issueNode(role: NodeRole): void {
    // The entity index equals the issued node index: every issueNode call is
    // followed by exactly one entity push, so entities.length === nextNode.
    const observed = this.#nextNode + 1;
    this.#checkLimit('nodes', observed, this.#limits.common.maxNodeCount);
    this.#authority.nodeRef(BigInt(this.#nextNode), role);
    this.#nextNode += 1;
  }

  #checkLimit(name: string, observed: number, limit: number): void {
    if (observed > limit) {
      throw IniFormationFailure.resourceLimit(name, observed, limit);
    }
  }

  #diagnostic(
    code: string,
    category: 'Lexical' | 'Syntax' | 'Conformance' | 'Semantic' | 'Resource' | 'Encoding',
    start: number,
    end: number,
    recovered: boolean,
  ): void {
    this.#checkLimit('diagnostics', this.#diagnostics.length + 1, this.#limits.common.maxDiagnostics);
    this.#diagnostics.push(
      makeDiagnostic(
        code,
        category,
        recovered ? 'Error' : 'Warning',
        {
          snapshot: this.#authority.identity().asBigInt(),
          startByte: BigInt(start),
          endByte: BigInt(end),
        },
        BigInt(this.#occurrence),
      ),
    );
    this.#occurrence += 1;
    this.#recovered = this.#recovered || recovered;
  }

  // -- comparison names (parser.rs:1197-1210) ----------------------------------------

  #sectionComparison(name: string): string {
    switch (this.#profile.tag()) {
      case 'WindowsV1':
        return name.toLowerCase();
      case 'PortableV1':
      case 'PythonConfigParserV1':
        return name;
    }
  }

  #keyComparison(key: string): string {
    switch (this.#profile.tag()) {
      case 'PortableV1':
        return key;
      case 'WindowsV1':
        return key.toLowerCase();
      case 'PythonConfigParserV1':
        return optionxform(key);
    }
  }

  // -- duplicate groups (parser.rs:1212-1304) ------------------------------------------

  #assignDuplicateGroups(): void {
    let nextGroup = 1;
    const sectionGroups = new Map<string, number[]>();
    for (const index of this.#sections) {
      const kind = this.#entities[index].kind;
      const comparison = kind.role === 'Section' || kind.role === 'DefaultSection'
        ? kind.comparisonName
        : '';
      const indices = sectionGroups.get(comparison);
      if (indices === undefined) {
        sectionGroups.set(comparison, [index]);
      } else {
        indices.push(index);
      }
    }
    for (const indices of sectionGroups.values()) {
      if (indices.length <= 1) {
        continue;
      }
      this.#checkLimit('duplicate-group-members', indices.length, this.#limits.maxDuplicateGroupMembers);
      const group = nextGroup;
      nextGroup += 1;
      const first = this.#entities[indices[0]].kind;
      const firstName = first.role === 'Section' || first.role === 'DefaultSection' ? first.name : '';
      for (const index of indices) {
        const kind = this.#entities[index].kind;
        if (kind.role === 'Section' || kind.role === 'DefaultSection') {
          kind.duplicateGroup = group;
        }
      }
      for (let i = 1; i < indices.length; i++) {
        const entity = this.#entities[indices[i]];
        const kind = entity.kind;
        const code =
          kind.role === 'Section' || kind.role === 'DefaultSection'
            ? kind.name === firstName
              ? 'ini.formation.duplicate-section@1'
              : 'ini.formation.case-collision@1'
            : 'ini.formation.case-collision@1';
        this.#diagnostic(code, 'Semantic', entity.span.startByte(), entity.span.endByte(), this.#profile.tag() !== 'WindowsV1');
      }
    }

    const entryGroups = new Map<string, number[]>();
    for (let i = 0; i < this.#entries.length; i++) {
      const index = this.#entries[i];
      const kind = this.#entities[index].kind;
      const sectionIndex = this.#entrySectionIndices[i];
      const sectionKind = this.#entities[sectionIndex].kind;
      const sectionIdentity =
        this.#profile.tag() === 'WindowsV1'
          ? sectionKind.role === 'Section' || sectionKind.role === 'DefaultSection'
            ? sectionKind.comparisonName
            : ''
          : String(sectionIndex);
      const comparison = kind.role === 'Entry' ? kind.comparisonKey : '';
      const key = `${sectionIdentity}\u0000${comparison}`;
      const indices = entryGroups.get(key);
      if (indices === undefined) {
        entryGroups.set(key, [index]);
      } else {
        indices.push(index);
      }
    }
    for (const indices of entryGroups.values()) {
      if (indices.length <= 1) {
        continue;
      }
      this.#checkLimit('duplicate-group-members', indices.length, this.#limits.maxDuplicateGroupMembers);
      const group = nextGroup;
      nextGroup += 1;
      const first = this.#entities[indices[0]].kind;
      const firstKey = first.role === 'Entry' ? first.key : '';
      for (const index of indices) {
        const kind = this.#entities[index].kind;
        if (kind.role === 'Entry') {
          kind.duplicateGroup = group;
        }
      }
      for (let i = 1; i < indices.length; i++) {
        const entity = this.#entities[indices[i]];
        const kind = entity.kind;
        const code =
          kind.role === 'Entry' && kind.key === firstKey
            ? 'ini.formation.duplicate-entry@1'
            : 'ini.formation.case-collision@1';
        this.#diagnostic(code, 'Semantic', entity.span.startByte(), entity.span.endByte(), this.#profile.tag() !== 'WindowsV1');
      }
    }
  }

}

// ---------------------------------------------------------------------------
// Character classes (parser.rs:1307-1362)
// ---------------------------------------------------------------------------

function leadingHorizontal(value: string): number {
  let count = 0;
  while (count < value.length) {
    const code = value.charCodeAt(count);
    if (code !== 0x20 && code !== 0x09) {
      break;
    }
    count += 1;
  }
  return count;
}

/** Trims leading/trailing horizontal whitespace; returns [start, end) code-unit offsets (parser.rs:1314-1321). */
function trimHorizontalBounds(value: string): [number, number] {
  const start = leadingHorizontal(value);
  let end = value.length;
  while (end > start) {
    const code = value.charCodeAt(end - 1);
    if (code === 0x20 || code === 0x09) {
      end -= 1;
    } else {
      break;
    }
  }
  return [Math.min(start, end), end];
}

function allHorizontal(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code !== 0x20 && code !== 0x09) {
      return false;
    }
  }
  return true;
}

function isPortableName(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    byte === 0x5f ||
    byte === 0x2d ||
    byte === 0x2e
  );
}

function isPortableValue(byte: number): boolean {
  return (
    (byte >= 0x21 && byte <= 0x7e &&
      byte !== 0x27 && byte !== 0x22 && byte !== 0x5c && byte !== 0x3a && byte !== 0x23 && byte !== 0x3b) ||
    byte === 0x20
  );
}

function isWindowsName(byte: number): boolean {
  return (
    (byte >= 0x21 && byte <= 0x7e) || byte === 0x20
  ) && !(byte === 0x5b || byte === 0x5d || byte === 0x3d);
}

/** Exact single- or double-quoted Windows value (parser.rs:1341-1358). */
function quotedWindowsValue(
  value: string,
  absoluteStart: number,
): [{ start: number; end: number }, IniQuoteStyle] {
  if (value.length >= 2) {
    const first = value.charCodeAt(0);
    const last = value.charCodeAt(value.length - 1);
    if (first === 0x27 && last === 0x27) {
      return [{ start: absoluteStart + 1, end: absoluteStart + value.length - 1 }, 'Single'];
    }
    if (first === 0x22 && last === 0x22) {
      return [{ start: absoluteStart + 1, end: absoluteStart + value.length - 1 }, 'Double'];
    }
  }
  return [{ start: absoluteStart, end: absoluteStart + value.length }, 'None'];
}

/** First '=' or ':' delimiter (parser.rs:1360-1362). */
function firstPythonDelimiter(value: string): number | null {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x3d || code === 0x3a) {
      return i;
    }
  }
  return null;
}

function scalarCountOf(text: string, start: number, end: number): number {
  let count = 0;
  for (const _ of text.slice(start, end)) {
    count += 1;
  }
  return count;
}

/** Raw byte width of one decoded scalar in the selected encoding (document/source.ts:1044-1059). */
function rawWidthOf(encoding: SourceEncoding, character: string): number {
  switch (encoding.kind) {
    case 'Utf8':
      return utf8Width(character);
    case 'Utf16Le':
    case 'Utf16Be':
      return character.length === 2 ? 4 : 2;
    case 'Latin1':
      return 1;
    case 'WindowsCodePage':
      return encoding.codePage.number() === 65001 ? utf8Width(character) : 1;
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

/** Whether every code unit satisfies one byte predicate (ASCII-only predicates). */
function allBytes(value: string, predicate: (byte: number) => boolean): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code > 0x7f || !predicate(code)) {
      return false;
    }
  }
  return true;
}
