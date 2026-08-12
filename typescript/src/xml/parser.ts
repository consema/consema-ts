/**
 * XML formation: source facts, tokenization, native tree, safe DTD subset,
 * bounded entity expansion, recovery, and exhaustive piece coverage
 * (RFC 0012 §2-4, §6-7, §12-13).
 *
 * authority (language-neutral behavior, byte-exact spans, recovery):
 *  - the tokenizer state machine follows the pinned backend contract of
 *    crates/consema-xml/src/parser.rs (:246-273) and the xmlparser 0.13.6
 *    behavior it binds (RFC 0012 §13; the pinned backend's stream semantics
 *    are observed in the crate probes below). Key deterministic facts:
 *    - a tokenizer-level failure jumps the stream to the end of the input
 *      (xmlparser Stream::jump_to_end), so the recovery region is always
 *      the final decoded byte and tokenization stops
 *      (parser.rs:255-269; go/xml/parser.go:153-161)
 *    - EOF between tokens is a clean end; EOF inside a construct is a
 *      tokenizer error (xmlparser next() loop)
 *    - top-level (outside the root) whitespace is skipped without a token;
 *      any other top-level content is a tokenizer error
 *      (xmlparser AfterDeclaration/AfterDtd/AfterElements states)
 *    - `<?xml ` (with the trailing space) is a declaration only at the
 *      stream start; anywhere else it is a tokenizer error
 *    - the declaration grammar is `<?xml` S version Eq value
 *      (S encoding Eq value)? (S standalone Eq value)? S? `?>`
 *    - an attribute value can never contain `<`
 *    - a text run can never contain `]]>`
 *  - profile/encoding: parser.rs:22-108 (encoding_request :56-80,
 *    validate_profile_encoding :82-108; RFC 0012 §2 :54-67)
 *  - declaration: parser.rs:334-503 (declaration_parts :411-503)
 *  - PI/comment/CDATA: parser.rs:505-644, 1371-1401
 *  - doctype: parser.rs:646-911 (doctype_start :646-667,
 *    doctype_empty :669-689, build_doctype :692-711, entity_declaration
 *    :747-849, dtd_end :851-863, scan_excluded_dtd_markup :865-911)
 *  - elements/attributes: parser.rs:913-1305 (element_start :913-961,
 *    attribute :963-1063, finalize_start_tag :1067-1174, element_end
 *    :1176-1248, close_frame :1250-1305)
 *  - text/references: parser.rs:1307-1729 (text :1307-1369,
 *    text_fragments :1467-1555, resolve_reference :1558-1645,
 *    resolve_nested :1651-1692, value_fragments :1696-1729)
 *  - recovery and finish: parser.rs:1736-1914 (recover :1736-1749,
 *    entity_limit :1751-1757, recover_error_region :1759-1786,
 *    finish :1792-1914 — gap filling :1830-1891)
 *  - qname facts: parser.rs:1916-2007
 *  - the exact xml.* diagnostic codes and categories: parser.rs (see
 *    typescript/src/xml/errors.ts header for the full file:line map);
 *    xml.* codes are registered by RFC 0012 §12, not the core registry
 *  - source/encoding layer: typescript/src/document/source.ts (the decoded
 *    text retains a leading BOM as U+FEFF; raw spans resolve through
 *    rawByteAt exactly like typescript/src/properties/parser.ts:152-199)
 *  - vector-pinned behavior: conformance/vectors/xml-1-0-safe-v1.json
 *    (all xml.formation.* and xml.limit.* cases; byte-exact spans and
 *    piece ordinals probed against the Rust crate at write time)
 *
 * RECORDED DIVERGENCE RISK (blind-write, L3): piece ORDINALS in the
 * published vector xml.syntax-query.kind-and-text-filter list the second
 * local-name as ordinal 10, while the current Rust crate emits ordinal 11
 * (the vector's ordinal field is informational — the conformance runner
 * checks kind and text only, crates/consema-conformance/src/xml_v1.rs:
 * 297-325 — and the vector predates the text-piece emission). This
 * implementation follows the current Rust crate: the end-tag local-name
 * is ordinal 11.
 *
 * Design (TypeScript-idiomatic): one hand-written scanner walks the
 * decoded text by JS code-unit index while tracking decoded-UTF-8 byte
 * offsets; a per-scalar boundary index (built once, properties-family
 * pattern) resolves every decoded boundary to its exact raw byte offset,
 * so UTF-16 sources keep byte-exact raw spans. The scanner mirrors the
 * pinned backend's state machine; the parser builds the immutable
 * `XmlDocument` with a content arena, or throws `FatalFormationFailure` —
 * no partial document ever exists.
 */

import { DocumentAuthority, Span } from '../document/identity.ts';
import { LosslessStructuralIndex, StructuralPiece } from '../document/structural.ts';
import { SourceSnapshot, EncodingRequest } from '../document/source.ts';
import type { SourceLimits, BomKind } from '../document/source.ts';
import type { Diagnostic } from '../document/diagnostic.ts';
import { diagnostic, sortDiagnostics } from '../document/diagnostic.ts';
import type { FormationStatus } from '../document/formation.ts';
import { SourceError } from '../document/errors.ts';
import { FatalFormationFailure } from './errors.ts';
import { XmlDocument } from './document.ts';
import type {
  EntityDeclarationData,
  QNameFacts,
  ReferenceFragment,
  XmlAttributeData,
  XmlContent,
  XmlDeclarationData,
  XmlDoctypeData,
  XmlElementData,
  XmlNamespaceBindingData,
  XmlPrologItem,
} from './document.ts';
import type { XmlProfile, XmlEncodingSelection, XmlParseLimits } from './profile.ts';
import { xmlEntityLimits } from './profile.ts';
import type { XmlSyntaxKind } from './syntax.ts';
import { EntityExpansionState, isXmlChar, predefinedValue, validateReplacementText } from './entity.ts';
import type { ExpansionBreach } from './entity.ts';
import { NamespaceScope, namespaceErrorCode } from './namespace.ts';
import type { NamespaceError, ExpandedName, QName } from './namespace.ts';
import { utf8ByteOffset } from '../document/source.ts';

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parses a complete immutable `xml.1.0-safe@1` document snapshot
 * (lib.rs:174-186). Throws FatalFormationFailure — no partial document
 * ever exists.
 */
export function parse(
  bytes: Uint8Array,
  profile: XmlProfile,
  selection: XmlEncodingSelection,
  limits: XmlParseLimits,
): XmlDocument {
  if (profile !== 'SafeV1') {
    throw FatalFormationFailure.profile('xml.profile.unknown@1');
  }
  const request = encodingRequest(selection);
  let source: SourceSnapshot;
  try {
    source = SourceSnapshot.fromRaw(
      bytes,
      request,
      sourceLimitsFor(limits),
    );
  } catch (error) {
    if (!(error instanceof SourceError)) {
      throw error;
    }
    throw FatalFormationFailure.sourceError(error);
  }
  validateProfileEncoding(source, selection);
  const decoded = source.decodedText();
  if (decoded === null) {
    throw FatalFormationFailure.source('xml.source.decoding@1', -1);
  }
  return new XmlParser(source, limits).parse(decoded);
}

/** Resolves the source encoding request under the RFC 0012 §2 table (parser.rs:56-80). */
function encodingRequest(selection: XmlEncodingSelection): EncodingRequest {
  if (selection.kind === 'ProfileDefault') {
    return EncodingRequest.create({ kind: 'Utf8' }).withBomPolicy('DetectUnicode');
  }
  const encoding = selection.encoding;
  const admitted = encoding.kind === 'Utf8' || encoding.kind === 'Utf16Le' || encoding.kind === 'Utf16Be';
  if (!admitted) {
    // UTF-32, Latin-1, Windows code pages, and other IANA encodings are
    // explicit v1 Profile exclusions (RFC 0012 §2 :65-67).
    throw FatalFormationFailure.profile('xml.profile.encoding@1');
  }
  return EncodingRequest.create({ kind: 'Utf8' }).withCallerOverride(encoding);
}

/** Source limits derived from the XML parse limits (parser.rs:29-40). */
function sourceLimitsFor(limits: XmlParseLimits): SourceLimits {
  return {
    maxRawBytes: limits.common.maxSourceBytes,
    maxDecodedUtf8Bytes: limits.maxDecodedUtf8Bytes,
    maxDecodedScalars: limits.maxDecodedScalars,
  };
}

/** Re-checks the selected encoding under the RFC 0012 §2 table (parser.rs:82-108). */
function validateProfileEncoding(
  source: SourceSnapshot,
  selection: XmlEncodingSelection,
): void {
  const facts = source.encodingFacts();
  const selected = facts.selected();
  let valid: boolean;
  if (selection.kind === 'ProfileDefault') {
    valid = selected.kind === 'Utf8' || selected.kind === 'Utf16Le' || selected.kind === 'Utf16Be';
  } else if (selection.encoding.kind === 'Utf8') {
    valid = selected.kind === 'Utf8';
  } else if (selection.encoding.kind === 'Utf16Le') {
    valid = selected.kind === 'Utf16Le' && facts.bom() === 'Utf16Le';
  } else if (selection.encoding.kind === 'Utf16Be') {
    valid = selected.kind === 'Utf16Be' && facts.bom() === 'Utf16Be';
  } else {
    valid = false;
  }
  if (!valid) {
    throw FatalFormationFailure.profile('xml.profile.encoding@1');
  }
}

/** Raw byte length of one BOM (parser.rs:48-53). */
function bomLen(bom: BomKind): number {
  switch (bom) {
    case 'Utf8':
      return 3;
    case 'Utf16Le':
    case 'Utf16Be':
      return 2;
  }
}

/** UTF-8 byte width of one code point. */
function utf8Width(character: string): number {
  const codePoint = character.codePointAt(0)!;
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

// ---------------------------------------------------------------------------
// XML 1.0 name productions
// ---------------------------------------------------------------------------

function isNameStartChar(code: number): boolean {
  return (
    code === 0x3a || // ':'
    (code >= 0x41 && code <= 0x5a) || // A-Z
    code === 0x5f || // '_'
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0xc0 && code <= 0xd6) ||
    (code >= 0xd8 && code <= 0xf6) ||
    (code >= 0xf8 && code <= 0x2ff) ||
    (code >= 0x370 && code <= 0x37d) ||
    (code >= 0x37f && code <= 0x1fff) ||
    (code >= 0x200c && code <= 0x200d) ||
    (code >= 0x2070 && code <= 0x218f) ||
    (code >= 0x2c00 && code <= 0x2fef) ||
    (code >= 0x3001 && code <= 0xd7ff) ||
    (code >= 0xf900 && code <= 0xfdcf) ||
    (code >= 0xfdf0 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0xeffff)
  );
}

function isNameChar(code: number): boolean {
  return (
    isNameStartChar(code) ||
    code === 0x2d || // '-'
    code === 0x2e || // '.'
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0xb7 ||
    (code >= 0x300 && code <= 0x36f) ||
    (code >= 0x203f && code <= 0x2040)
  );
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** One attribute seen before start-tag finalization (parser.rs:151-159). */
interface PendingAttribute {
  readonly qname: QNameFacts;
  readonly span: Span;
  readonly valueSpan: Span;
  readonly fragments: readonly ReferenceFragment[];
  readonly normalized: string;
  readonly singleQuote: boolean;
}

/** One namespace declaration seen before start-tag finalization (parser.rs:161-166). */
interface PendingDeclaration {
  readonly qname: QNameFacts;
  readonly uri: string;
  readonly uriSpan: Span;
}

/** One open element frame (parser.rs:168-180). */
class Frame {
  startRaw: number;
  span: Span;
  qname: QNameFacts;
  expanded: ExpandedName | null;
  namespaceError: NamespaceError | null;
  scope: NamespaceScope;
  namespaces: XmlNamespaceBindingData[] = [];
  attributes: XmlAttributeData[] = [];
  children: number[] = [];
  pendingDeclarations: PendingDeclaration[] = [];
  pendingAttributes: PendingAttribute[] = [];

  constructor(startRaw: number, span: Span, qname: QNameFacts, scope: NamespaceScope) {
    this.startRaw = startRaw;
    this.span = span;
    this.qname = qname;
    this.expanded = null;
    this.namespaceError = null;
    this.scope = scope;
  }
}

/** A structural piece pending assembly: `[jsStart, jsEnd)` in decoded space. */
interface PendingPiece {
  readonly jsStart: number;
  readonly jsEnd: number;
  readonly kind: XmlSyntaxKind;
  readonly structural: 'Token' | 'Trivia' | 'ErrorRegion';
}

class XmlParser {
  readonly #source: SourceSnapshot;
  readonly #limits: XmlParseLimits;
  readonly #authority = DocumentAuthority.fresh();
  readonly #diagnostics: Diagnostic[] = [];
  readonly #pieces: PendingPiece[] = [];
  readonly #nodes: XmlContent[] = [];
  readonly #parentOf: (number | null)[] = [];
  readonly #stack: Frame[] = [];
  readonly #prolog: XmlPrologItem[] = [];
  readonly #epilog: XmlPrologItem[] = [];
  readonly #entities: EntityDeclarationData[] = [];
  readonly #entityState = EntityExpansionState.new();

  #text = '';
  /** Decoded UTF-8 byte offset per JS code-unit index (length = text.length + 1). */
  #decodedUtf8At: number[] = [];
  /** Raw byte offset per JS code-unit index (length = text.length + 1). */
  #rawAt: number[] = [];

  #nextOrdinal = 0;
  #declaration: XmlDeclarationData | null = null;
  #doctype: XmlDoctypeData | null = null;
  #doctypeName: QNameFacts | null = null;
  #doctypeSpanStartRaw: number | null = null;
  #externalSubsetRecovered = false;
  #dtdSubsetStart: number | null = null;
  #root: number | null = null;
  #recovered = false;
  #errorRegions = 0;

  constructor(source: SourceSnapshot, limits: XmlParseLimits) {
    this.#source = source;
    this.#limits = limits;
  }

  parse(text: string): XmlDocument {
    this.#text = text;
    this.#buildBoundaries(text);
    this.#coverBom();
    const start = text.length > 0 && text.codePointAt(0) === 0xfeff ? 1 : 0;
    let pos = start;
    let stopped = false;
    while (pos < text.length && !stopped) {
      const result =
        this.#stack.length === 0 ? this.#scanTopLevel(pos) : this.#scanContent(pos);
      switch (result.kind) {
        case 'Next':
          pos = result.pos;
          break;
        case 'Error':
          // A tokenizer error jumps the stream to the end of the document
          // (xmlparser Stream::jump_to_end), so the recovery region is
          // always the final decoded byte and tokenization stops
          // (parser.rs:255-269; go/xml/parser.go:153-161).
          this.#recoverErrorRegion(text.length - 1, text.length);
          stopped = true;
          break;
        case 'End':
          stopped = true;
          break;
      }
    }
    return this.#finish();
  }

  // -------------------------------------------------------------------------
  // Boundaries and spans
  // -------------------------------------------------------------------------

  /** Covers a leading BOM as trivia; the tokenizer skips it in decoded text (parser.rs:275-285). */
  #coverBom(): void {
    const bom = this.#source.encodingFacts().bom();
    if (bom !== null) {
      const length = bomLen(bom);
      if (length > 0) {
        // The decoded text retains the BOM as one U+FEFF scalar; its raw
        // span resolves to exactly the BOM bytes.
        this.#pieces.push({ jsStart: 0, jsEnd: 1, kind: 'bom', structural: 'Trivia' });
      }
    }
  }

  /** Builds the decoded-UTF-8-byte and raw-byte boundary index (properties parser.ts:152-199 pattern). */
  #buildBoundaries(text: string): void {
    const decodedUtf8At: number[] = [0];
    const rawAt: number[] = [];
    rawAt.push(this.#boundaryRaw(0));
    let decoded = 0;
    for (let index = 0; index < text.length; ) {
      const codePoint = text.codePointAt(index)!;
      const character = String.fromCodePoint(codePoint);
      decoded += utf8Width(character);
      index += character.length;
      decodedUtf8At.push(decoded);
      rawAt.push(this.#boundaryRaw(decoded));
    }
    this.#decodedUtf8At = decodedUtf8At;
    this.#rawAt = rawAt;
  }

  #boundaryRaw(decodedUtf8Byte: number): number {
    try {
      return this.#source.rawByteAt(utf8ByteOffset(decodedUtf8Byte));
    } catch {
      throw FatalFormationFailure.source('xml.source.span@1', -1);
    }
  }

  /** Skips an XML S run (space, tab, CR, LF) forward; returns the new index. */
  #skipSpaces(pos: number): number {
    const text = this.#text;
    let at = pos;
    while (at < text.length && isXmlSpace(text[at])) {
      at += 1;
    }
    return at;
  }

  /** Raw span of one decoded `[jsStart, jsEnd)` interval. */
  #rawSpan(jsStart: number, jsEnd: number): Span {
    const startRaw = this.#rawAt[jsStart];
    const endRaw = this.#rawAt[jsEnd];
    try {
      return this.#authority.span(startRaw, endRaw);
    } catch {
      throw FatalFormationFailure.profile('xml.source.span@1');
    }
  }

  #pushPiece(
    jsStart: number,
    jsEnd: number,
    kind: XmlSyntaxKind,
    structural: 'Token' | 'Trivia' | 'ErrorRegion',
  ): void {
    this.#pieces.push({ jsStart, jsEnd, kind, structural });
  }

  /** Decoded UTF-8 byte length of one decoded interval. */
  #decodedLen(jsStart: number, jsEnd: number): number {
    return this.#decodedUtf8At[jsEnd] - this.#decodedUtf8At[jsStart];
  }

  /** Unicode scalar count of one decoded interval. */
  #scalarCount(jsStart: number, jsEnd: number): number {
    let count = 0;
    for (let index = jsStart; index < jsEnd; ) {
      const codePoint = this.#text.codePointAt(index)!;
      index += String.fromCodePoint(codePoint).length;
      count += 1;
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // Diagnostics and limits
  // -------------------------------------------------------------------------

  /** Records a recovery diagnostic with its exact failing span (parser.rs:1736-1749). */
  #recover(code: string, span: Span, category: Diagnostic['category']): void {
    this.#recovered = true;
    if (this.#errorRegions >= this.#limits.maxRecoveryRegions) {
      return;
    }
    this.#errorRegions += 1;
    this.#diagnostics.push(
      diagnostic(
        code,
        category,
        'Error',
        {
          snapshot: null,
          startByte: BigInt(span.startByte()),
          endByte: BigInt(span.endByte()),
        },
        BigInt(this.#diagnostics.length),
      ),
    );
  }

  /** Fatal resource-limit check with the limit's own frozen code (parser.rs:2015-2020). */
  #limit(code: string, observed: number, max: number): void {
    if (observed > max) {
      throw FatalFormationFailure.limit(code, observed, max);
    }
  }

  /** Records an entity expansion breach (parser.rs:1751-1757). */
  #entityLimit(breach: ExpansionBreach, span: Span): void {
    const code = breach === 'Amplification' ? 'xml.entity.amplification@1' : 'xml.entity.limit@1';
    this.#recover(code, span, 'Conformance');
  }

  /** Tokenizer-level failure: the region is always the final decoded byte (parser.rs:1759-1786). */
  #recoverErrorRegion(start: number, end: number): void {
    this.#recovered = true;
    if (this.#errorRegions >= this.#limits.maxRecoveryRegions) {
      return;
    }
    this.#errorRegions += 1;
    this.#pushPiece(start, end, 'error-region', 'ErrorRegion');
    this.#diagnostics.push(
      diagnostic(
        'xml.syntax.well-formedness@1',
        'Syntax',
        'Error',
        {
          snapshot: null,
          startByte: BigInt(this.#rawAt[start]),
          endByte: BigInt(this.#rawAt[end]),
        },
        BigInt(this.#diagnostics.length),
      ),
    );
  }

  #ordinal(): number {
    const ordinal = this.#nextOrdinal;
    this.#nextOrdinal += 1;
    return ordinal;
  }

  // -------------------------------------------------------------------------
  // Top-level scanning (xmlparser AfterDeclaration/AfterDtd/AfterElements)
  // -------------------------------------------------------------------------

  #scanTopLevel(pos: number): { kind: 'Next'; pos: number } | { kind: 'Error' } | { kind: 'End' } {
    const text = this.#text;
    const character = text[pos];
    if (isXmlSpace(character)) {
      return { kind: 'Next', pos: this.#skipSpaces(pos) };
    }
    if (text.startsWith('<!DOCTYPE', pos)) {
      if (this.#doctype !== null || this.#root !== null) {
        // AfterDtd/AfterElements reject a further DOCTYPE.
        return { kind: 'Error' };
      }
      return this.#scanDoctype(pos);
    }
    if (text.startsWith('<!--', pos)) {
      return this.#scanComment(pos);
    }
    if (text.startsWith('<?', pos)) {
      if (text.startsWith('<?xml ', pos) && !this.#atStreamStart(pos)) {
        // `<?xml ` is only legal at the very start of the stream.
        return { kind: 'Error' };
      }
      return this.#scanQuestion(pos);
    }
    if (text.startsWith('<!', pos)) {
      return { kind: 'Error' };
    }
    if (text.startsWith('</', pos)) {
      return { kind: 'Error' };
    }
    if (text.startsWith('<', pos)) {
      if (this.#root !== null) {
        // AfterElements rejects any further root-level markup.
        return { kind: 'Error' };
      }
      return this.#scanStartTag(pos);
    }
    // Non-whitespace character data outside the document element is a
    // tokenizer error.
    return { kind: 'Error' };
  }

  /** Whether the construct at pos is the first construct after an optional BOM. */
  #atStreamStart(pos: number): boolean {
    return pos === (this.#text.codePointAt(0) === 0xfeff ? 1 : 0);
  }

  // -------------------------------------------------------------------------
  // Element-content scanning (xmlparser Elements state)
  // -------------------------------------------------------------------------

  #scanContent(pos: number): { kind: 'Next'; pos: number } | { kind: 'Error' } | { kind: 'End' } {
    const text = this.#text;
    if (text.startsWith('<?', pos)) {
      if (text.startsWith('<?xml ', pos)) {
        return { kind: 'Error' };
      }
      return this.#scanQuestion(pos);
    }
    if (text.startsWith('<!--', pos)) {
      return this.#scanComment(pos);
    }
    if (text.startsWith('<![CDATA[', pos)) {
      return this.#scanCdata(pos);
    }
    if (text.startsWith('<!', pos)) {
      return { kind: 'Error' };
    }
    if (text.startsWith('</', pos)) {
      return this.#scanEndTag(pos);
    }
    if (text.startsWith('<', pos)) {
      return this.#scanStartTag(pos);
    }
    return this.#scanText(pos);
  }

  // -------------------------------------------------------------------------
  // Declaration and processing instruction
  // -------------------------------------------------------------------------

  /** Scans `<?xml …?>` (only as the first construct) or a processing instruction. */
  #scanQuestion(pos: number): { kind: 'Next'; pos: number } | { kind: 'Error' } {
    const text = this.#text;
    const atStart = this.#atStreamStart(pos);
    let cursor = pos + 2;
    const name = this.#scanQName(cursor);
    if (name === null) {
      return { kind: 'Error' };
    }
    if (
      atStart &&
      this.#text.slice(name.start, name.end) === 'xml' &&
      name.end < text.length &&
      isXmlSpace(text[name.end])
    ) {
      return this.#scanDeclaration(pos, name);
    }
    return this.#scanProcessingInstruction(pos, name);
  }

  /** Scans the fixed declaration grammar and pushes its pieces (parser.rs:334-503). */
  #scanDeclaration(
    pos: number,
    name: { start: number; end: number },
  ): { kind: 'Next'; pos: number } | { kind: 'Error' } {
    const text = this.#text;
    let cursor = name.end;
    cursor = this.#skipSpaces(cursor);
    const version = this.#scanPseudoAttribute(cursor);
    if (version === null || text.slice(version.nameStart, version.nameEnd) !== 'version') {
      return { kind: 'Error' };
    }
    cursor = version.after;
    const open = this.#rawSpan(pos, pos + 5);
    this.#pushPiece(pos, pos + 5, 'declaration-open', 'Token');
    this.#pushPiece(version.nameStart, version.nameEnd, 'declaration-name', 'Token');
    this.#pushPiece(version.valueStart, version.valueEnd, 'declaration-value', 'Token');
    if (this.#text.slice(version.valueStart, version.valueEnd) !== '1.0') {
      this.#recover(
        'xml.declaration.version@1',
        this.#rawSpan(version.valueStart, version.valueEnd),
        'Syntax',
      );
    }
    cursor = this.#skipSpaces(cursor);
    const encoding = this.#scanPseudoAttribute(cursor);
    if (encoding !== null && text.slice(encoding.nameStart, encoding.nameEnd) === 'encoding') {
      this.#pushPiece(encoding.nameStart, encoding.nameEnd, 'declaration-name', 'Token');
      this.#pushPiece(encoding.valueStart, encoding.valueEnd, 'declaration-value', 'Token');
      const declared = text.slice(encoding.valueStart, encoding.valueEnd);
      const upper = declared.toUpperCase();
      const selected = this.#source.encodingFacts().selected();
      const agrees =
        selected.kind === 'Utf8'
          ? upper === 'UTF-8'
          : selected.kind === 'Utf16Le'
            ? upper === 'UTF-16' || upper === 'UTF-16LE'
            : selected.kind === 'Utf16Be'
              ? upper === 'UTF-16' || upper === 'UTF-16BE'
              : false;
      if (!agrees) {
        this.#recover(
          'xml.declaration.conflict@1',
          this.#rawSpan(encoding.valueStart, encoding.valueEnd),
          'Encoding',
        );
      }
      cursor = this.#skipSpaces(encoding.after);
    }
    const standalone = this.#scanPseudoAttribute(cursor);
    let standaloneFacts: { span: Span; value: boolean } | null = null;
    if (standalone !== null) {
      if (text.slice(standalone.nameStart, standalone.nameEnd) !== 'standalone') {
        return { kind: 'Error' };
      }
      const value = text.slice(standalone.valueStart, standalone.valueEnd);
      if (value !== 'yes' && value !== 'no') {
        return { kind: 'Error' };
      }
      this.#pushPiece(standalone.nameStart, standalone.nameEnd, 'declaration-name', 'Token');
      this.#pushPiece(standalone.valueStart, standalone.valueEnd, 'declaration-value', 'Token');
      standaloneFacts = {
        span: this.#rawSpan(standalone.valueStart, standalone.valueEnd),
        value: value === 'yes',
      };
      cursor = this.#skipSpaces(standalone.after);
    } else {
      cursor = this.#skipSpaces(cursor);
    }
    // The declaration must end with `?>`; any other content is an error
    // (xmlparser parse_declaration: S? '?>').
    if (text.startsWith('?>', cursor)) {
      const end = cursor + 2;
      this.#pushPiece(end - 2, end, 'declaration-close', 'Token');
      const raw = this.#rawSpan(pos, end);
      if (this.#declaration !== null) {
        this.#recover('xml.declaration.duplicate@1', raw, 'Syntax');
      }
      this.#declaration = {
        span: raw,
        versionSpan: this.#rawSpan(version.valueStart, version.valueEnd),
        version: text.slice(version.valueStart, version.valueEnd),
        encoding:
          encoding !== null && text.slice(encoding.nameStart, encoding.nameEnd) === 'encoding'
            ? {
                span: this.#rawSpan(encoding.valueStart, encoding.valueEnd),
                value: text.slice(encoding.valueStart, encoding.valueEnd),
              }
            : null,
        standalone: standaloneFacts,
      };
      return { kind: 'Next', pos: end };
    }
    return { kind: 'Error' };
  }

  /** One `name = "value"` pseudo-attribute; positions in decoded space. */
  #scanPseudoAttribute(cursor: number): {
    nameStart: number;
    nameEnd: number;
    valueStart: number;
    valueEnd: number;
    after: number;
  } | null {
    const text = this.#text;
    const name = this.#scanQName(cursor);
    if (name === null) {
      return null;
    }
    let at = this.#skipSpaces(name.end);
    if (text[at] !== '=') {
      return null;
    }
    at += 1;
    at = this.#skipSpaces(at);
    const quote = text[at];
    if (quote !== '"' && quote !== "'") {
      return null;
    }
    const valueStart = at + 1;
    const close = text.indexOf(quote, valueStart);
    if (close < 0) {
      return null;
    }
    return {
      nameStart: name.start,
      nameEnd: name.end,
      valueStart,
      valueEnd: close,
      after: close + 1,
    };
  }

  /** Scans one processing instruction and pushes its pieces (parser.rs:505-579). */
  #scanProcessingInstruction(
    pos: number,
    name: { start: number; end: number },
  ): { kind: 'Next'; pos: number } | { kind: 'Error' } {
    const text = this.#text;
    const targetRaw = this.#rawSpan(name.start, name.end);
    const target = text.slice(name.start, name.end);
    if (target.toLowerCase() === 'xml') {
      this.#recover('xml.pi.target@1', targetRaw, 'Syntax');
    }
    let contentStart = this.#skipSpaces(name.end);
    const close = text.indexOf('?>', contentStart);
    if (close < 0) {
      return { kind: 'Error' };
    }
    const end = close + 2;
    const content: { span: Span; text: string } | null =
      close > contentStart
        ? {
            span: this.#rawSpan(contentStart, close),
            text: text.slice(contentStart, close),
          }
        : null;
    if (content !== null) {
      this.#limit('xml.limit.pi@1', this.#decodedLen(contentStart, close), this.#limits.maxPiLength);
    }
    if (this.#dtdSubsetStart !== null) {
      // A PI inside the internal subset is admitted DTD markup, never a
      // prolog/epilog or element-content occurrence (parser.rs:528-533).
      this.#pushPiece(pos, end, 'dtd-markup', 'Token');
      return { kind: 'Next', pos: end };
    }
    this.#pushPiece(pos, pos + 2, 'processing-instruction-open', 'Token');
    this.#pushPiece(name.start, name.end, 'processing-instruction-target', 'Token');
    if (content !== null) {
      this.#pushPiece(contentStart, close, 'processing-instruction-content', 'Token');
    }
    this.#pushPiece(end - 2, end, 'processing-instruction-close', 'Token');
    const item = {
      ordinal: this.#ordinal(),
      span: this.#rawSpan(pos, end),
      targetSpan: targetRaw,
      target,
      content,
    };
    if (this.#stack.length === 0) {
      if (this.#root === null) {
        this.#prolog.push({ kind: 'ProcessingInstruction', data: item });
      } else {
        this.#epilog.push({ kind: 'ProcessingInstruction', data: item });
      }
    } else {
      this.#pushContent({ kind: 'ProcessingInstruction', data: item });
    }
    return { kind: 'Next', pos: end };
  }

  // -------------------------------------------------------------------------
  // Comment and CDATA
  // -------------------------------------------------------------------------

  /** Scans one comment and pushes its pieces (parser.rs:581-644). */
  #scanComment(pos: number): { kind: 'Next'; pos: number } | { kind: 'Error' } {
    const text = this.#text;
    const close = text.indexOf('-->', pos + 4);
    if (close < 0) {
      return { kind: 'Error' };
    }
    const end = close + 3;
    const value = text.slice(pos + 4, close);
    if (value.includes('--') || value.endsWith('-')) {
      this.#recover('xml.comment.content@1', this.#rawSpan(pos + 4, close), 'Syntax');
    }
    this.#limit('xml.limit.comment@1', this.#decodedLen(pos + 4, close), this.#limits.maxCommentLength);
    if (this.#dtdSubsetStart !== null) {
      // A comment inside the internal subset is admitted DTD markup
      // (parser.rs:600-605).
      this.#pushPiece(pos, end, 'dtd-markup', 'Trivia');
      return { kind: 'Next', pos: end };
    }
    this.#pushPiece(pos, pos + 4, 'comment-open', 'Trivia');
    this.#pushPiece(pos + 4, close, 'comment-text', 'Trivia');
    this.#pushPiece(close, end, 'comment-close', 'Trivia');
    const item = {
      ordinal: this.#ordinal(),
      span: this.#rawSpan(pos, end),
      textSpan: this.#rawSpan(pos + 4, close),
      text: value,
    };
    if (this.#stack.length === 0) {
      if (this.#root === null) {
        this.#prolog.push({ kind: 'Comment', data: item });
      } else {
        this.#epilog.push({ kind: 'Comment', data: item });
      }
    } else {
      this.#pushContent({ kind: 'Comment', data: item });
    }
    return { kind: 'Next', pos: end };
  }

  /** Scans one CDATA section and pushes its pieces (parser.rs:1371-1401). */
  #scanCdata(pos: number): { kind: 'Next'; pos: number } | { kind: 'Error' } {
    const text = this.#text;
    const close = text.indexOf(']]>', pos + 9);
    if (close < 0) {
      return { kind: 'Error' };
    }
    const end = close + 3;
    const value = text.slice(pos + 9, close);
    this.#limit('xml.limit.cdata@1', this.#decodedLen(pos + 9, close), this.#limits.maxCdataLength);
    this.#pushPiece(pos, pos + 9, 'cdata-open', 'Token');
    this.#pushPiece(pos + 9, close, 'cdata-text', 'Token');
    this.#pushPiece(close, end, 'cdata-close', 'Token');
    this.#pushContent({
      kind: 'Cdata',
      data: {
        ordinal: this.#ordinal(),
        span: this.#rawSpan(pos, end),
        textSpan: this.#rawSpan(pos + 9, close),
        text: value,
      },
    });
    return { kind: 'Next', pos: end };
  }

  // -------------------------------------------------------------------------
  // DOCTYPE and the internal subset
  // -------------------------------------------------------------------------

  /** Scans one DOCTYPE construct (parser.rs:646-911). */
  #scanDoctype(pos: number): { kind: 'Next'; pos: number } | { kind: 'Error' } {
    const text = this.#text;
    let cursor = pos + 9; // past `<!DOCTYPE`
    if (cursor >= text.length || !isXmlSpace(text[cursor])) {
      return { kind: 'Error' };
    }
    this.#pushPiece(pos, pos + 9, 'doctype-open', 'Token');
    cursor = this.#skipSpaces(cursor);
    const name = this.#scanQName(cursor);
    if (name === null) {
      return { kind: 'Error' };
    }
    const qname = this.#qnameFacts(name);
    this.#limit('xml.limit.qname@1', this.#decodedLen(name.start, name.end), this.#limits.maxQNameLength);
    this.#pushPiece(name.start, name.end, 'doctype-name', 'Token');
    if (this.#doctype !== null) {
      this.#recover('xml.dtd.multiple-doctype@1', this.#rawSpan(pos, name.end), 'Syntax');
    }
    this.#doctypeName = qname;
    cursor = this.#skipSpaces(name.end);
    const external = this.#scanExternalId(cursor);
    if (external !== null) {
      this.#externalSubsetRecovered = true;
    }
    let afterExternal = external === null ? cursor : external;
    afterExternal = this.#skipSpaces(afterExternal);
    const next = text[afterExternal];
    if (next === '[') {
      const subsetStart = afterExternal + 1;
      if (external !== null) {
        this.#recover(
          'xml.dtd.external-subset@1',
          this.#rawSpan(pos, subsetStart),
          'Conformance',
        );
      }
      this.#doctypeSpanStartRaw = this.#rawAt[pos];
      this.#dtdSubsetStart = subsetStart;
      let at = subsetStart;
      while (at < text.length) {
        const character = text[at];
        if (isXmlSpace(character)) {
          at = this.#skipSpaces(at);
          continue;
        }
        if (text.startsWith('<!ENTITY', at)) {
          const result = this.#scanEntityDeclaration(at);
          if (result === null) {
            return { kind: 'Error' };
          }
          at = result;
          continue;
        }
        if (text.startsWith('<!--', at)) {
          const result = this.#scanComment(at);
          if (result.kind === 'Error') {
            return { kind: 'Error' };
          }
          at = result.pos;
          continue;
        }
        if (text.startsWith('<?', at)) {
          if (text.startsWith('<?xml ', at)) {
            return { kind: 'Error' };
          }
          const result = this.#scanQuestion(at);
          if (result.kind === 'Error') {
            return { kind: 'Error' };
          }
          at = result.pos;
          continue;
        }
        if (
          text.startsWith('<!ELEMENT', at) ||
          text.startsWith('<!ATTLIST', at) ||
          text.startsWith('<!NOTATION', at)
        ) {
          // xmlparser consumes these declarations silently; the raw subset
          // scan flags them after the subset closes (parser.rs:865-911).
          const end = text.indexOf('>', at);
          if (end < 0) {
            return { kind: 'Error' };
          }
          at = end + 1;
          continue;
        }
        if (text[at] === ']') {
          let after = this.#skipSpaces(at + 1);
          if (text[after] !== '>') {
            return { kind: 'Error' };
          }
          const end = after + 1;
          this.#pushPiece(at, end, 'doctype-close', 'Token');
          return this.#dtdEnd(pos, subsetStart, at, end);
        }
        return { kind: 'Error' };
      }
      return { kind: 'Error' };
    }
    if (next === '>') {
      const end = afterExternal + 1;
      if (external !== null) {
        // The pinned backend's DtdStart/EmptyDtd span covers through `>`
        // for an external id without a subset (probe: (0,50)).
        this.#recover('xml.dtd.external-subset@1', this.#rawSpan(pos, end), 'Conformance');
      }
      this.#doctypeSpanStartRaw = this.#rawAt[pos];
      this.#buildDoctype(this.#rawSpan(pos, end));
      return { kind: 'Next', pos: end };
    }
    return { kind: 'Error' };
  }

  /** Scans an optional external id; returns the decoded position after it. */
  #scanExternalId(cursor: number): number | null {
    const text = this.#text;
    if (text.startsWith('SYSTEM', cursor) || text.startsWith('PUBLIC', cursor)) {
      let at = cursor + 6;
      if (at >= text.length || !isXmlSpace(text[at])) {
        return null;
      }
      at = this.#skipSpaces(at);
      const quote = text[at];
      if (quote !== '"' && quote !== "'") {
        return null;
      }
      const literal1 = text.indexOf(quote, at + 1);
      if (literal1 < 0) {
        return null;
      }
      at = literal1 + 1;
      if (text.startsWith('PUBLIC', cursor)) {
        if (at >= text.length || !isXmlSpace(text[at])) {
          return null;
        }
        at = this.#skipSpaces(at);
        const quote2 = text[at];
        if (quote2 !== '"' && quote2 !== "'") {
          return null;
        }
        const literal2 = text.indexOf(quote2, at + 1);
        if (literal2 < 0) {
          return null;
        }
        at = literal2 + 1;
      }
      return at;
    }
    return null;
  }

  /** Scans one `<!ENTITY …>` declaration inside the subset (parser.rs:747-849). */
  #scanEntityDeclaration(pos: number): number | null {
    const text = this.#text;
    let cursor = pos + 8; // past `<!ENTITY`
    if (cursor >= text.length || !isXmlSpace(text[cursor])) {
      return null;
    }
    cursor = this.#skipSpaces(cursor);
    const isParameter = text[cursor] === '%';
    if (isParameter) {
      cursor = this.#skipSpaces(cursor + 1);
    }
    const name = this.#scanQName(cursor);
    if (name === null) {
      return null;
    }
    const declaredName = text.slice(name.start, name.end);
    cursor = this.#skipSpaces(name.end);
    // The whole declaration span is known only after the definition.
    let definitionEnd: number | null = null;
    let value: { start: number; end: number } | null = null;
    const quote = text[cursor];
    if (quote === '"' || quote === "'") {
      const valueEnd = text.indexOf(quote, cursor + 1);
      if (valueEnd < 0) {
        return null;
      }
      value = { start: cursor + 1, end: valueEnd };
      cursor = valueEnd + 1;
      cursor = this.#skipSpaces(cursor);
      if (text[cursor] === '>') {
        definitionEnd = cursor + 1;
      }
    } else if (text.startsWith('SYSTEM', cursor) || text.startsWith('PUBLIC', cursor)) {
      const afterExternal = this.#scanExternalId(cursor);
      if (afterExternal !== null) {
        let at = afterExternal;
        at = this.#skipSpaces(at);
        if (text.startsWith('NDATA', at)) {
          at = this.#skipSpaces(at + 5);
          const ndataName = this.#scanQName(at);
          if (ndataName === null) {
            return null;
          }
          at = ndataName.end;
          at = this.#skipSpaces(at);
        }
        if (text[at] === '>') {
          definitionEnd = at + 1;
        }
      }
    }
    if (definitionEnd === null) {
      return null;
    }
    this.#pushPiece(pos, definitionEnd, 'dtd-markup', 'Token');
    const raw = this.#rawSpan(pos, definitionEnd);
    if (isParameter) {
      this.#recover('xml.dtd.parameter-entity@1', raw, 'Conformance');
      return definitionEnd;
    }
    if (value === null) {
      this.#recover('xml.dtd.external-entity@1', raw, 'Conformance');
      return definitionEnd;
    }
    const valueText = text.slice(value.start, value.end);
    this.#limit(
      'xml.limit.entity-replacement@1',
      this.#decodedLen(value.start, value.end),
      this.#limits.maxAttributeValueLength,
    );
    const replacementError = validateReplacementText(valueText);
    if (replacementError !== null) {
      if (replacementError.kind === 'ContainsMarkup') {
        this.#recover('xml.entity.markup@1', raw, 'Conformance');
      } else {
        this.#recover('xml.entity.illegal-character@1', raw, 'Syntax');
      }
      return definitionEnd;
    }
    if (valueText.includes('%')) {
      // A `%` inside an entity value is a parameter-entity reference,
      // which the Profile excludes (parser.rs:802-811).
      this.#recover('xml.dtd.parameter-entity@1', raw, 'Conformance');
      return definitionEnd;
    }
    if (predefinedValue(declaredName) !== null || declaredName === 'xml' || declaredName === 'xmlns') {
      this.#recover('xml.entity.reserved-name@1', raw, 'Conformance');
      return definitionEnd;
    }
    if (this.#entities.some((entity) => entity.name === declaredName)) {
      this.#recover('xml.entity.duplicate@1', raw, 'Syntax');
      return definitionEnd;
    }
    const declared: EntityDeclarationData = {
      span: raw,
      name: declaredName,
      replacementSpan: this.#rawSpan(value.start, value.end),
      replacement: valueText,
    };
    const breach = this.#entityState.recordDeclaration(
      this.#decodedLen(value.start, value.end),
      this.#scalarCount(value.start, value.end),
      xmlEntityLimits(this.#limits),
    );
    if (breach !== null) {
      this.#entityLimit(breach, raw);
      return definitionEnd;
    }
    this.#entities.push(declared);
    return definitionEnd;
  }

  /** Completes the doctype after its internal subset closed (parser.rs:851-863, 692-711). */
  #dtdEnd(
    pos: number,
    subsetStart: number,
    closeStart: number,
    end: number,
  ): { kind: 'Next'; pos: number } {
    const subset = this.#text.slice(subsetStart, closeStart);
    this.#scanExcludedDtdMarkup(subset);
    this.#limit('xml.limit.dtd@1', this.#decodedLen(subsetStart, closeStart), this.#limits.maxDtdBytes);
    this.#dtdSubsetStart = null;
    this.#buildDoctype(this.#rawSpan(pos, end));
    return { kind: 'Next', pos: end };
  }

  /**
   * Scans the internal subset raw text for excluded declarations
   * (parser.rs:865-911). Comments are skipped as a whole: their text is
   * character data, so `<!-- <!ELEMENT x> -->` must not be misread as a
   * declaration.
   */
  #scanExcludedDtdMarkup(subset: string): void {
    let base = 0;
    let search = subset;
    for (;;) {
      const commentAt = search.indexOf('<!--');
      const markers: { at: number; marker: string }[] = [];
      for (const marker of ['<!ELEMENT', '<!ATTLIST', '<!NOTATION', '<![']) {
        const at = search.indexOf(marker);
        if (at >= 0) {
          markers.push({ at, marker });
        }
      }
      let first: { at: number; marker: string } | null = null;
      for (const candidate of markers) {
        if (first === null || candidate.at < first.at) {
          first = candidate;
        }
      }
      if (commentAt >= 0 && (first === null || commentAt < first.at)) {
        const relativeEnd = search.indexOf('-->', commentAt + 4);
        if (relativeEnd < 0) {
          // An unterminated comment is already a recovery case; nothing
          // further to scan.
          return;
        }
        const skip = commentAt + 4 + relativeEnd + 3;
        base += skip;
        search = search.slice(skip);
        continue;
      }
      if (first === null) {
        return;
      }
      const absolute = base + first.at;
      const span = this.#rawSpan(absolute, absolute + first.marker.length);
      this.#recover(
        first.marker === '<![' ? 'xml.dtd.conditional-section@1' : 'xml.dtd.validation-declaration@1',
        span,
        'Conformance',
      );
      const next = first.at + first.marker.length;
      base += next;
      search = search.slice(next);
    }
  }

  /** Assembles the immutable DOCTYPE facts (parser.rs:692-711). */
  #buildDoctype(end: Span): void {
    const start = this.#doctypeSpanStartRaw;
    const name = this.#doctypeName;
    if (start === null || name === null) {
      throw FatalFormationFailure.profile('xml.dtd.name@1');
    }
    let span: Span;
    try {
      span = this.#authority.span(start, end.endByte());
    } catch {
      throw FatalFormationFailure.profile('xml.source.span@1');
    }
    this.#doctype = {
      span,
      name,
      entities: Object.freeze([...this.#entities]),
      recovered: this.#externalSubsetRecovered,
    };
  }

  // -------------------------------------------------------------------------
  // Elements and attributes
  // -------------------------------------------------------------------------

  /** Scans one start tag (parser.rs:913-961; xmlparser parse_attribute). */
  #scanStartTag(pos: number): { kind: 'Next'; pos: number } | { kind: 'Error' } | { kind: 'End' } {
    const text = this.#text;
    const name = this.#scanQName(pos + 1);
    if (name === null) {
      return { kind: 'Error' };
    }
    this.#pushPiece(pos, pos + 1, 'tag-open', 'Token');
    this.#pushQNameParts(name);
    const qname = this.#qnameFacts(name);
    this.#limit('xml.limit.qname@1', this.#decodedLen(name.start, name.end), this.#limits.maxQNameLength);
    if (this.#nodes.length >= this.#limits.common.maxNodeCount) {
      throw FatalFormationFailure.profile('xml.limit.node@1');
    }
    if (this.#nodes.length >= this.#limits.maxElementCount) {
      throw FatalFormationFailure.profile('xml.limit.element@1');
    }
    if (this.#stack.length >= this.#limits.common.maxNestingDepth) {
      throw FatalFormationFailure.profile('xml.limit.depth@1');
    }
    // Element-name resolution is deferred to start-tag finalization so that
    // declarations on this very element are in scope (parser.rs:940-945).
    const scope =
      this.#stack.length === 0 ? NamespaceScope.empty() : this.#stack[this.#stack.length - 1].scope;
    this.#stack.push(
      new Frame(this.#rawAt[pos], this.#rawSpan(pos, name.end), qname, scope),
    );
    let cursor = name.end;
    if (cursor >= text.length) {
      // EOF immediately after the name is a clean end (the tokenizer's
      // next() call observes an exhausted stream).
      return { kind: 'End' };
    }
    for (;;) {
      const skipped = this.#skipSpaces(cursor);
      if (skipped >= text.length) {
        // EOF inside the attribute loop is a tokenizer error.
        return { kind: 'Error' };
      }
      const character = text[skipped];
      if (character === '>') {
        this.#pushPiece(skipped, skipped + 1, 'tag-close', 'Token');
        const end = skipped + 1;
        this.#extendFrameSpan(this.#rawAt[end]);
        this.#finalizeStartTag();
        return { kind: 'Next', pos: end };
      }
      if (character === '/' && text[skipped + 1] === '>') {
        this.#pushPiece(skipped, skipped + 2, 'empty-element-close', 'Token');
        const end = skipped + 2;
        this.#extendFrameSpan(this.#rawAt[end]);
        this.#finalizeStartTag();
        this.#closeFrame(this.#rawSpan(skipped, end));
        return { kind: 'Next', pos: end };
      }
      if (skipped === cursor) {
        // An attribute must be preceded by whitespace (xmlparser
        // InvalidSpace).
        return { kind: 'Error' };
      }
      const attribute = this.#scanAttribute(skipped);
      if (attribute === null) {
        return { kind: 'Error' };
      }
      cursor = attribute;
    }
  }

  /** Extends the top frame's span to cover the whole start tag (parser.rs:1186-1210). */
  #extendFrameSpan(endRaw: number): void {
    const frame = this.#stack[this.#stack.length - 1];
    if (frame === undefined) {
      return;
    }
    try {
      frame.span = this.#authority.span(frame.startRaw, endRaw);
    } catch {
      throw FatalFormationFailure.profile('xml.source.span@1');
    }
  }

  /** Scans one attribute `name = "value"` (parser.rs:963-1063; xmlparser parse_attribute). */
  #scanAttribute(pos: number): number | null {
    const text = this.#text;
    const name = this.#scanQName(pos);
    if (name === null) {
      return null;
    }
    const frame = this.#stack[this.#stack.length - 1];
    const declarationCount = frame.pendingDeclarations.length + frame.namespaces.length;
    const attributeCount = frame.pendingAttributes.length + frame.attributes.length;
    if (
      attributeCount >= this.#limits.maxAttributeCount ||
      declarationCount >= this.#limits.maxNamespaceDeclarationCount
    ) {
      throw FatalFormationFailure.profile('xml.limit.attribute@1');
    }
    const qname = this.#qnameFacts(name);
    const isDeclaration =
      qname.prefix === 'xmlns' || (qname.prefix === null && qname.local === 'xmlns');
    // The attribute name is one unit; `xmlns`/`xmlns:p` names are the
    // NamespaceDeclaration kind (parser.rs:983-1000).
    this.#pushPiece(
      name.start,
      name.end,
      isDeclaration ? 'namespace-declaration' : 'attribute-name',
      'Token',
    );
    let at = this.#skipSpaces(name.end);
    if (text[at] !== '=') {
      return null;
    }
    this.#pushPiece(at, at + 1, 'equals', 'Token');
    at += 1;
    at = this.#skipSpaces(at);
    const quote = text[at];
    if (quote !== '"' && quote !== "'") {
      return null;
    }
    const valueStart = at + 1;
    let valueEnd = valueStart;
    while (valueEnd < text.length && text[valueEnd] !== quote && text[valueEnd] !== '<') {
      valueEnd += 1;
    }
    if (valueEnd >= text.length || text[valueEnd] !== quote) {
      return null;
    }
    this.#pushPiece(at, at + 1, 'quote', 'Token');
    // The value pieces are emitted by the fragment splitter (literal runs
    // as attribute-value pieces, references as their own kinds).
    this.#pushPiece(valueEnd, valueEnd + 1, 'quote', 'Token');
    const singleQuote = quote === "'";
    const valueRaw = this.#rawSpan(valueStart, valueEnd);
    const { fragments, normalized } = this.#valueFragments(valueStart, valueEnd);
    if (isDeclaration) {
      this.#limit(
        'xml.limit.namespace-uri@1',
        this.#decodedLen(valueStart, valueEnd),
        this.#limits.maxNamespaceUriLength,
      );
      frame.pendingDeclarations.push({
        qname,
        uri: normalized,
        uriSpan: valueRaw,
      });
    } else {
      this.#limit(
        'xml.limit.attribute-value@1',
        this.#decodedLen(valueStart, valueEnd),
        this.#limits.maxAttributeValueLength,
      );
      frame.pendingAttributes.push({
        qname,
        span: this.#rawSpan(pos, valueEnd + 1),
        valueSpan: valueRaw,
        fragments,
        normalized,
        singleQuote,
      });
    }
    return valueEnd + 1;
  }

  /** Resolves element and attribute names once the whole start tag has been read (parser.rs:1067-1174). */
  #finalizeStartTag(): void {
    const frame = this.#stack[this.#stack.length - 1];
    if (frame === undefined) {
      return;
    }
    const pendingDeclarations = frame.pendingDeclarations;
    const pendingAttributes = frame.pendingAttributes;
    frame.pendingDeclarations = [];
    frame.pendingAttributes = [];
    let scope = frame.scope;
    const namespaces: XmlNamespaceBindingData[] = [];
    for (const declaration of pendingDeclarations) {
      const prefix = declaration.qname.prefix === 'xmlns' ? declaration.qname.local : null;
      const result = scope.declare(prefix, declaration.uri);
      if (result instanceof NamespaceScope) {
        scope = result;
        namespaces.push({
          ordinal: this.#ordinal(),
          span: declaration.qname.span,
          prefix,
          uriSpan: declaration.uriSpan,
          uri: declaration.uri,
        });
      } else {
        this.#recover(namespaceErrorCode(result), declaration.qname.span, 'Semantic');
      }
    }
    const elementResult = scope.resolveElement(qnameFactsToQName(frame.qname));
    if (elementResult.kind === 'Error') {
      frame.expanded = null;
      frame.namespaceError = elementResult.error;
      this.#recover(namespaceErrorCode(elementResult.error), frame.qname.span, 'Semantic');
    } else {
      frame.expanded = elementResult.expanded;
      frame.namespaceError = null;
    }
    const attributes: XmlAttributeData[] = [];
    for (const pending of pendingAttributes) {
      const attributeResult = scope.resolveAttribute(qnameFactsToQName(pending.qname));
      let expanded: ExpandedName | null;
      let namespaceError: NamespaceError | null;
      if (attributeResult.kind === 'Error') {
        expanded = null;
        namespaceError = attributeResult.error;
        this.#recover(namespaceErrorCode(attributeResult.error), pending.qname.span, 'Semantic');
      } else {
        expanded = attributeResult.expanded;
        namespaceError = null;
      }
      let duplicate = false;
      if (expanded !== null) {
        duplicate =
          attributes.some(
            (existing) =>
              existing.expanded !== null && existingExpandedEquals(existing.expanded, expanded),
          ) ||
          namespaces.some((binding) => {
            return expandedEquals(
              NamespaceScope.declarationExpandedName(binding.prefix),
              expanded,
            );
          });
      }
      if (duplicate) {
        this.#recover('xml.namespace.duplicate-attribute@1', pending.qname.span, 'Semantic');
      }
      attributes.push({
        ordinal: this.#ordinal(),
        span: pending.span,
        qname: pending.qname,
        expanded,
        namespaceError,
        singleQuote: pending.singleQuote,
        valueSpan: pending.valueSpan,
        fragments: Object.freeze([...pending.fragments]),
        normalizedValue: pending.normalized,
      });
    }
    frame.scope = scope;
    frame.namespaces.push(...namespaces);
    frame.attributes.push(...attributes);
  }

  /** Scans one end tag (parser.rs:1215-1246). */
  #scanEndTag(pos: number): { kind: 'Next'; pos: number } | { kind: 'Error' } {
    const text = this.#text;
    const name = this.#scanQName(pos + 2);
    if (name === null) {
      return { kind: 'Error' };
    }
    const at = this.#skipSpaces(name.end);
    if (text[at] !== '>') {
      return { kind: 'Error' };
    }
    const end = at + 1;
    this.#pushPiece(pos, pos + 2, 'end-tag-open', 'Token');
    this.#pushQNameParts(name);
    this.#pushPiece(at, end, 'tag-close', 'Token');
    const endQname = this.#qnameFacts(name);
    const frame = this.#stack[this.#stack.length - 1];
    if (frame !== undefined && !qnamesEqual(qnameFactsToQName(frame.qname), qnameFactsToQName(endQname))) {
      this.#recover('xml.tree.mismatched-end-tag@1', endQname.span, 'Syntax');
    }
    this.#closeFrame(this.#rawSpan(pos, end));
    return { kind: 'Next', pos: end };
  }

  /** Closes the top frame into an arena element (parser.rs:1250-1305). */
  #closeFrame(endTagSpan: Span): void {
    const frame = this.#stack.pop();
    if (frame === undefined) {
      // An extra end tag cannot close any proven element (parser.rs:1251-1261).
      this.#recover('xml.tree.extra-end-tag@1', endTagSpan, 'Syntax');
      return;
    }
    const index = this.#nodes.length;
    const element: XmlElementData = {
      index,
      span: frame.span,
      qname: frame.qname,
      expanded: frame.expanded,
      namespaceError: frame.namespaceError,
      scope: frame.scope,
      namespaces: Object.freeze([...frame.namespaces]),
      attributes: Object.freeze([...frame.attributes]),
      children: Object.freeze([...frame.children]),
    };
    // Every child content item attached to this element now knows its
    // parent arena index (parser.rs:1274-1280).
    for (const child of element.children) {
      this.#parentOf[child] = index;
    }
    this.#parentOf.push(null);
    this.#nodes.push({ kind: 'Element', data: element });
    const parent = this.#stack[this.#stack.length - 1];
    if (parent !== undefined) {
      if (parent.children.length >= this.#limits.maxMixedContentItems) {
        this.#recover('xml.limit.mixed-content@1', this.#nodes[index].data.span, 'Conformance');
      } else {
        parent.children.push(index);
      }
    } else if (this.#root === null) {
      this.#root = index;
    } else {
      this.#recover('xml.tree.multiple-roots@1', this.#nodes[index].data.span, 'Syntax');
    }
  }

  // -------------------------------------------------------------------------
  // Text and references
  // -------------------------------------------------------------------------

  /** Scans one text run up to the next markup start (parser.rs:1307-1369; xmlparser parse_text). */
  #scanText(pos: number): { kind: 'Next'; pos: number } | { kind: 'Error' } {
    const text = this.#text;
    let next = text.indexOf('<', pos);
    if (next < 0) {
      next = text.length;
    }
    if (text.slice(pos, next).includes(']]>')) {
      // `]]>` must not appear inside a Text node.
      return { kind: 'Error' };
    }
    this.#textOccurrence(pos, next);
    return { kind: 'Next', pos: next };
  }

  /** Builds one text occurrence with its pieces (parser.rs:1307-1369). */
  #textOccurrence(start: number, end: number): void {
    const value = this.#text.slice(start, end);
    const whitespaceOnly = isWhitespaceOnly(value);
    if (this.#stack.length === 0) {
      if (whitespaceOnly) {
        // Top-level whitespace is normally skipped without a token; this
        // path mirrors the Rust text() recovery flow.
        this.#pushWhitespacePieces(start, end);
        const span = this.#rawSpan(start, end);
        const item: XmlPrologItem = { kind: 'Whitespace', span };
        if (this.#root === null) {
          this.#prolog.push(item);
        } else {
          this.#epilog.push(item);
        }
        return;
      }
      this.#recover('xml.syntax.text-outside-root@1', this.#rawSpan(start, end), 'Syntax');
      this.#pushPiece(start, end, 'error-region', 'ErrorRegion');
      const ordinal = this.#ordinal();
      this.#pushContent({
        kind: 'Text',
        data: {
          ordinal,
          span: this.#rawSpan(start, end),
          fragments: Object.freeze([
            { kind: 'Literal', span: this.#rawSpan(start, end), text: value },
          ]),
        },
      });
      return;
    }
    if (whitespaceOnly) {
      this.#pushWhitespacePieces(start, end);
    } else {
      const fragments = this.#textFragments(start, end, 'text');
      this.#limit('xml.limit.text@1', this.#decodedLen(start, end), this.#limits.maxTextLength);
      this.#pushContent({
        kind: 'Text',
        data: {
          ordinal: this.#ordinal(),
          span: this.#rawSpan(start, end),
          fragments: Object.freeze(fragments),
        },
      });
      return;
    }
    this.#pushContent({
      kind: 'Text',
      data: {
        ordinal: this.#ordinal(),
        span: this.#rawSpan(start, end),
        fragments: Object.freeze([
          { kind: 'Literal', span: this.#rawSpan(start, end), text: value },
        ]),
      },
    });
  }

  /** Splits one whitespace-only text run into Whitespace and LineBreak pieces (parser.rs:1424-1458). */
  #pushWhitespacePieces(start: number, end: number): void {
    const text = this.#text;
    let index = start;
    while (index < end) {
      const character = text[index];
      const lineBreak = character === '\n' || character === '\r';
      let runEnd = index;
      if (lineBreak) {
        runEnd = character === '\r' && text[index + 1] === '\n' ? index + 2 : index + 1;
      } else {
        runEnd = index + 1;
      }
      while (runEnd < end) {
        const nextCharacter = text[runEnd];
        const nextLineBreak = nextCharacter === '\n' || nextCharacter === '\r';
        if (nextLineBreak !== lineBreak) {
          break;
        }
        runEnd += nextLineBreak && nextCharacter === '\r' && text[runEnd + 1] === '\n' ? 2 : 1;
      }
      this.#pushPiece(index, runEnd, lineBreak ? 'line-break' : 'whitespace', 'Trivia');
      index = runEnd;
    }
  }

  /**
   * Splits one text or attribute-value occurrence into reference fragments
   * (parser.rs:1460-1555).
   */
  #textFragments(start: number, end: number, literalKind: 'text' | 'attribute-value'): ReferenceFragment[] {
    const text = this.#text;
    const bytes = text.slice(start, end);
    if (!bytes.includes('&')) {
      // Fast path: a single literal covers the whole run.
      this.#pushPiece(start, end, literalKind, 'Token');
      return [{ kind: 'Literal', span: this.#rawSpan(start, end), text: bytes }];
    }
    const fragments: ReferenceFragment[] = [];
    let cursor = start;
    let index = start;
    while (index < end) {
      const relative = bytes.indexOf('&', index - start);
      if (relative < 0) {
        break;
      }
      const at = start + relative;
      if (at > cursor) {
        const literal = text.slice(cursor, at);
        this.#pushPiece(cursor, at, literalKind, 'Token');
        fragments.push({ kind: 'Literal', span: this.#rawSpan(cursor, at), text: literal });
      }
      const semiRelative = bytes.indexOf(';', at + 1 - start);
      const semi = semiRelative < 0 ? -1 : start + semiRelative;
      if (semi < 0) {
        // Unterminated reference: recover and keep the rest literal
        // (parser.rs:1504-1522).
        const span = this.#rawSpan(at, end);
        this.#recover('xml.reference.malformed@1', span, 'Syntax');
        this.#pushPiece(at, end, literalKind, 'Token');
        fragments.push({ kind: 'Literal', span, text: text.slice(at, end) });
        cursor = end;
        index = end;
        continue;
      }
      const body = text.slice(at + 1, semi);
      const refSpan = this.#rawSpan(at, semi + 1);
      const fragment = this.#resolveReference(body, refSpan, 0);
      if (fragment !== null) {
        const kind: XmlSyntaxKind =
          fragment.kind === 'CharacterReference'
            ? 'character-reference'
            : fragment.kind === 'PredefinedEntity' || fragment.kind === 'GeneralEntity'
              ? 'entity-reference'
              : literalKind;
        this.#pushPiece(at, semi + 1, kind, 'Token');
        fragments.push(fragment);
      }
      cursor = semi + 1;
      index = semi + 1;
    }
    if (cursor < end) {
      const literal = text.slice(cursor, end);
      this.#pushPiece(cursor, end, literalKind, 'Token');
      fragments.push({ kind: 'Literal', span: this.#rawSpan(cursor, end), text: literal });
    }
    return fragments;
  }

  /** Resolves one `&…;` reference body into a fragment (parser.rs:1557-1645). */
  #resolveReference(body: string, refSpan: Span, depth: number): ReferenceFragment | null {
    if (body.startsWith('#')) {
      const digits = body.slice(1);
      let isHex = false;
      let value: number | null = null;
      if (digits.startsWith('x') || digits.startsWith('X')) {
        const hex = digits.slice(1);
        isHex = hex.length > 0 && isAsciiHex(hex);
        if (isHex) {
          value = Number.parseInt(hex, 16);
        }
      } else {
        isHex = false;
        if (digits.length > 0 && isAsciiDigits(digits)) {
          value = Number.parseInt(digits, 10);
        }
      }
      const resolved =
        value !== null && Number.isSafeInteger(value) && value <= 0x10ffff
          ? String.fromCodePoint(value)
          : null;
      if (resolved !== null && isXmlChar(resolved)) {
        return { kind: 'CharacterReference', span: refSpan, resolved };
      }
      this.#recover('xml.reference.invalid-character@1', refSpan, 'Syntax');
      return null;
    }
    const predefined = predefinedValue(body);
    if (predefined !== null) {
      return { kind: 'PredefinedEntity', span: refSpan, name: body, resolved: predefined };
    }
    const declared = this.#entities.find((entity) => entity.name === body);
    if (declared === undefined) {
      this.#recover('xml.entity.unknown@1', refSpan, 'Conformance');
      return null;
    }
    const limits = xmlEntityLimits(this.#limits);
    const breach = this.#entityState.enterReference(
      this.#decodedLenOf(declared.replacement),
      scalarCountOf(declared.replacement),
      limits,
    );
    if (breach !== null) {
      // Note: on breach the depth is intentionally not restored, exactly
      // like the Rust (parser.rs:1618-1626).
      this.#entityLimit(breach, refSpan);
      return null;
    }
    const nested = this.#resolveNested(declared.replacement, refSpan, depth + 1);
    this.#entityState.leaveReference();
    if (nested === null) {
      this.#recover('xml.entity.cyclic@1', refSpan, 'Conformance');
      return null;
    }
    return {
      kind: 'GeneralEntity',
      span: refSpan,
      name: body,
      resolved: nested,
      declarationSpan: declared.span,
    };
  }

  /**
   * Resolves nested references inside one replacement text
   * (parser.rs:1647-1692). Unknown references, cycles, or limit breaches
   * inside replacement text produce no partial native text.
   */
  #resolveNested(replacement: string, sourceSpan: Span, depth: number): string | null {
    if (depth > this.#limits.maxEntityExpansionDepth) {
      return null;
    }
    let out = '';
    let cursor = 0;
    let index = 0;
    while (index < replacement.length) {
      const relative = replacement.indexOf('&', index);
      if (relative < 0) {
        break;
      }
      const at = relative;
      out += replacement.slice(cursor, at);
      const semiRelative = replacement.indexOf(';', at + 1);
      if (semiRelative < 0) {
        return null;
      }
      const semi = semiRelative;
      const body = replacement.slice(at + 1, semi);
      const fragment = this.#resolveReference(body, sourceSpan, depth);
      if (fragment === null) {
        return null;
      }
      switch (fragment.kind) {
        case 'CharacterReference':
          out += fragment.resolved;
          break;
        case 'PredefinedEntity':
        case 'GeneralEntity':
          out += fragment.resolved;
          break;
        case 'Literal':
          out += fragment.text;
          break;
      }
      cursor = semi + 1;
      index = semi + 1;
    }
    out += replacement.slice(cursor);
    return out;
  }

  /** Decoded UTF-8 byte length of one plain string (replacement text is stored decoded). */
  #decodedLenOf(text: string): number {
    let bytes = 0;
    for (const character of text) {
      bytes += utf8Width(character);
    }
    return bytes;
  }

  /**
   * Splits an attribute value into fragments and applies XML 1.0 CDATA
   * normalization to the semantic value (parser.rs:1694-1729).
   */
  #valueFragments(start: number, end: number): { fragments: ReferenceFragment[]; normalized: string } {
    const fragments = this.#textFragments(start, end, 'attribute-value');
    let normalized = '';
    for (const fragment of fragments) {
      switch (fragment.kind) {
        case 'Literal':
          for (const character of fragment.text) {
            normalized += isAttributeWhitespace(character) ? ' ' : character;
          }
          break;
        case 'CharacterReference':
          normalized += fragment.resolved;
          break;
        case 'PredefinedEntity':
        case 'GeneralEntity':
          for (const character of fragment.resolved) {
            normalized += isAttributeWhitespace(character) ? ' ' : character;
          }
          break;
      }
    }
    return { fragments, normalized };
  }

  /** Pushes one content occurrence with its mixed-content budget (parser.rs:1403-1422). */
  #pushContent(item: XmlContent): void {
    const frame = this.#stack[this.#stack.length - 1];
    if (frame !== undefined) {
      if (frame.children.length >= this.#limits.maxMixedContentItems) {
        // The item is dropped under the hard budget, never silently
        // (parser.rs:1404-1415).
        this.#recover('xml.limit.mixed-content@1', xmlContentSpanInternal(item), 'Conformance');
        this.#parentOf.push(null);
        this.#nodes.push(item);
        return;
      }
      frame.children.push(this.#nodes.length);
    }
    this.#parentOf.push(null);
    this.#nodes.push(item);
  }

  // -------------------------------------------------------------------------
  // QName helpers
  // -------------------------------------------------------------------------

  /** Scans one QName; returns its decoded positions or null (parser.rs:1916-2007). */
  #scanQName(pos: number): { start: number; end: number } | null {
    const text = this.#text;
    const start = pos;
    let at = pos;
    const first = text.codePointAt(at);
    if (first === undefined || !isNameStartChar(first)) {
      return null;
    }
    at += String.fromCodePoint(first).length;
    while (at < text.length) {
      const code = text.codePointAt(at)!;
      if (!isNameChar(code)) {
        break;
      }
      at += String.fromCodePoint(code).length;
    }
    return { start, end: at };
  }

  /** Pushes the QName part pieces for one element or end-tag name (parser.rs:1944-1976). */
  #pushQNameParts(name: { start: number; end: number }): void {
    const text = this.#text;
    const colonRelative = text.slice(name.start, name.end).indexOf(':');
    if (colonRelative < 0) {
      this.#pushPiece(name.start, name.end, 'local-name', 'Token');
      return;
    }
    const colon = name.start + colonRelative;
    this.#pushPiece(name.start, colon, 'prefix', 'Token');
    this.#pushPiece(colon, colon + 1, 'colon', 'Token');
    this.#pushPiece(colon + 1, name.end, 'local-name', 'Token');
  }

  /** Source-derived QName facts for one scanned name (parser.rs:1916-2007). */
  #qnameFacts(name: { start: number; end: number }): QNameFacts {
    const text = this.#text;
    const spelling = text.slice(name.start, name.end);
    const raw = this.#rawSpan(name.start, name.end);
    const colonRelative = spelling.indexOf(':');
    if (colonRelative < 0) {
      return {
        prefix: null,
        local: spelling,
        span: raw,
        prefixSpan: null,
        localSpan: raw,
      };
    }
    const colon = name.start + colonRelative;
    return {
      prefix: spelling.slice(0, colonRelative),
      local: spelling.slice(colonRelative + 1),
      span: raw,
      prefixSpan: this.#rawSpan(name.start, colon),
      localSpan: this.#rawSpan(colon + 1, name.end),
    };
  }

  // -------------------------------------------------------------------------
  // Finish
  // -------------------------------------------------------------------------

  /** Final assembly: recovery classification, gap filling, and the document (parser.rs:1792-1914). */
  #finish(): XmlDocument {
    if (this.#stack.length > 0) {
      this.#recovered = true;
      this.#diagnostics.push(
        diagnostic('xml.tree.unclosed-element@1', 'Syntax', 'Error', null, BigInt(this.#diagnostics.length)),
      );
    }
    if (this.#root === null) {
      this.#recovered = true;
      this.#diagnostics.push(
        diagnostic('xml.tree.missing-root@1', 'Syntax', 'Error', null, BigInt(this.#diagnostics.length)),
      );
    }
    if (this.#root !== null && this.#doctypeName !== null) {
      const rootNode = this.#nodes[this.#root];
      if (rootNode.kind !== 'Element') {
        throw FatalFormationFailure.profile('xml.tree.root@1');
      }
      if (!qnamesEqual(qnameFactsToQName(rootNode.data.qname), qnameFactsToQName(this.#doctypeName))) {
        this.#recover('xml.doctype.root-mismatch@1', rootNode.data.qname.span, 'Syntax');
      }
    }
    const status: FormationStatus = this.#recovered ? 'Recovered' : 'Complete';
    // Pair every piece with its kind, sort by decoded start, and fill gaps
    // (parser.rs:1830-1891).
    const sorted = [...this.#pieces].sort((left, right) => left.jsStart - right.jsStart);
    const finalPieces: { span: Span; structural: 'Token' | 'Trivia' | 'ErrorRegion' }[] = [];
    const finalKinds: XmlSyntaxKind[] = [];
    let next = 0;
    for (const piece of sorted) {
      if (piece.jsStart > next) {
        finalPieces.push({
          span: this.#rawSpan(next, piece.jsStart),
          structural: this.#recovered ? 'ErrorRegion' : 'Trivia',
        });
        finalKinds.push(this.#recovered ? 'error-region' : 'whitespace');
      }
      next = piece.jsEnd;
      finalPieces.push({
        span: this.#rawSpan(piece.jsStart, piece.jsEnd),
        structural: piece.structural,
      });
      finalKinds.push(piece.kind);
    }
    if (next < this.#text.length) {
      finalPieces.push({
        span: this.#rawSpan(next, this.#text.length),
        structural: this.#recovered ? 'ErrorRegion' : 'Trivia',
      });
      finalKinds.push(this.#recovered ? 'error-region' : 'whitespace');
    }
    const structural = finalPieces.map((piece, ordinal) => {
      return new StructuralPiece(piece.span, piece.structural);
    });
    let index: LosslessStructuralIndex;
    try {
      index = LosslessStructuralIndex.create(
        this.#authority.identity(),
        this.#source.len(),
        structural,
      );
    } catch {
      throw FatalFormationFailure.profile('xml.source.coverage@1');
    }
    return new XmlDocument(
      this.#authority,
      this.#source,
      'SafeV1',
      status,
      this.#declaration,
      this.#doctype,
      this.#prolog,
      this.#epilog,
      this.#root,
      index,
      finalKinds,
      sortDiagnostics(this.#diagnostics),
      this.#nodes,
      this.#parentOf,
      this.#limits,
    );
  }
}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

/** XML S production: space, tab, CR, LF. */
function isXmlSpace(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\r' || character === '\n';
}

/** Attribute-value whitespace under XML 1.0 CDATA normalization. */
function isAttributeWhitespace(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r';
}

function isWhitespaceOnly(text: string): boolean {
  for (const character of text) {
    if (!isXmlSpace(character)) {
      return false;
    }
  }
  return true;
}

function isAsciiHex(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (!((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66))) {
      return false;
    }
  }
  return true;
}

function isAsciiDigits(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (!(code >= 0x30 && code <= 0x39)) {
      return false;
    }
  }
  return true;
}

function scalarCountOf(text: string): number {
  let count = 0;
  for (const _ of text) {
    count += 1;
  }
  return count;
}

function expandedEquals(left: ExpandedName, right: ExpandedName): boolean {
  return left.namespace === right.namespace && left.local === right.local;
}

function existingExpandedEquals(left: ExpandedName, right: ExpandedName): boolean {
  return left.namespace === right.namespace && left.local === right.local;
}

function qnamesEqual(left: QName, right: QName): boolean {
  return left.prefix === right.prefix && left.local === right.local;
}

/** Converts source-derived QName facts into a resolvable QName (document.rs:111-120). */
function qnameFactsToQName(facts: QNameFacts): QName {
  return { prefix: facts.prefix, local: facts.local };
}

function xmlContentSpanInternal(item: XmlContent): Span {
  return item.data.span;
}
