/**
 * YAML 1.2.2 presentation parser and native composer for both profiles.
 *
 * authority:
 *  - RFC 0007 (the yaml contract): §3 source/encoding (:55-71), §5 1.2
 *    profile (:98-138), §6 1.1 profile (:140-165), §7 lossless document
 *    (:167-192), §8 composition (:194-212), §13 security (:400-429)
 *  - crates/consema-yaml/src/lib.rs: parse :259-320 (source-bytes limit
 *    :266-272, BOM-stripped backend text :285-287, version-directive
 *    validation :288, event/tokenize/compose order :289-309),
 *    validate_version_directives :789-831 (yaml.profile.version-
 *    directive@1), backend_failure :833-858 (yaml.parse.syntax@1),
 *    exact_empty_scalar :516-539 (native.rs)
 *  - crates/consema-yaml/src/native.rs: compose :111-141, Composer
 *    :223-508 (anchor registration before descending :429-445; alias
 *    resolution to the most recent preceding anchor :267-295; document
 *    span covering DocumentStart..DocumentEnd :492-501), resolve_collection_tag
 *    :541-563 (yaml.tag.kind-mismatch@1), resolve_scalar :565-653
 *    (yaml.scalar.invalid-explicit-tag@1), node_ref :1159-1161
 *  - parser structure cross-referenced with go/yaml/parser.go (the
 *    independent runner; never copied line-for-line)
 *  - vector-pinned behavior: conformance/vectors/yaml-v1.json
 *    (source.utf16le-bom :16-19, stream.empty :21-24,
 *    stream.multi-document :26-29, native.arbitrary-duplicate-mapping
 *    :36-39, formation.undefined-alias :41-44, graph.shared-cycle :46-49,
 *    regression.plain-property-characters :136-139,
 *    resource.parse-source-bytes :126-129)
 *
 * Design (TypeScript-idiomatic): one recursive-descent parser walks the
 * decoded text as code points with scalar-index positions and composes the
 * native model directly (the Go counterpart leaves the internal tree free;
 * the Rust backend events are private). All positions are decoded Unicode
 * scalar offsets; a final publish pass resolves every span to exact raw
 * bytes through the shared RawByteResolver (offsets.ts). Undefined aliases
 * fail at parse time with yaml.parse.syntax@1 (the vector-pinned surface).
 * The parser never expands aliases (RFC 0007 §8: one edge per occurrence)
 * and never evaluates or constructs application objects (RFC 0007 §13).
 *
 * RECORDED DIVERGENCE RISK (blind-write, L2): multi-paragraph plain and
 * quoted scalar folding uses the simple single-space join of the
 * conformance-passing Go runner (go/yaml/parser.go parsePlainBlock) rather
 * than the full YAML blank-line folding algebra; the shared vectors do not
 * exercise multi-paragraph plain scalars. A future differential audit is
 * recorded as a follow-up.
 */

import { DocumentAuthority } from '../document/identity.ts';
import type { Span } from '../document/identity.ts';
import { EncodingRequest, SourceSnapshot, utf8Encoding } from '../document/source.ts';
import { SourceError } from '../document/errors.ts';
import type { ParseLimits } from '../document/formation.ts';
import type { LosslessStructuralIndex } from '../document/structural.ts';
import { FatalFormationFailure } from './errors.ts';
import { RawByteResolver } from './offsets.ts';
import { tokenize } from './scanner.ts';
import { resolveExplicit, resolveImplicit } from './scalar.ts';
import { TAG_MAP, TAG_OMAP, TAG_PAIRS, TAG_SEQ, TAG_SET } from './scalar.ts';
import type { ResolvedScalar } from './scalar.ts';
import { acceptedVersion, yamlProfileId } from './profile.ts';
import type { YamlProfile } from './profile.ts';
import type { YamlScalarKind, YamlScalarStyle } from './semantic.ts';
import type { YamlSyntaxKind } from './syntax.ts';
import { YamlDocument } from './document.ts';
import type {
  InternalAlias,
  InternalContent,
  InternalDocument,
  InternalMappingEntry,
  InternalNode,
  InternalScalar,
  InternalSequenceItem,
} from './document.ts';

// ---------------------------------------------------------------------------
// Parse entry point
// ---------------------------------------------------------------------------

/** Parses one exact YAML stream using BOM-detected UTF-8/UTF-16 source rules (lib.rs:259-320). */
export function parse(
  bytes: Uint8Array,
  profile: YamlProfile,
  limits: ParseLimits,
): YamlDocument {
  if (bytes.length > limits.maxSourceBytes) {
    throw FatalFormationFailure.resourceLimit('source-bytes', bytes.length, limits.maxSourceBytes);
  }
  let source: SourceSnapshot;
  try {
    source = SourceSnapshot.fromRaw(bytes, EncodingRequest.create(utf8Encoding()), {
      maxRawBytes: limits.maxSourceBytes,
      maxDecodedUtf8Bytes: limits.maxSourceBytes * 2,
      maxDecodedScalars: limits.maxSourceBytes,
    });
  } catch (error) {
    if (error instanceof SourceError) {
      throw FatalFormationFailure.sourceError(error);
    }
    throw error;
  }
  const text = source.decodedText();
  if (text === null) {
    throw new Error('internal: YAML profiles always request decoded text');
  }
  validateVersionDirectives(text, profile);
  const authority = DocumentAuthority.fresh();
  const parser = new Parser(text, profile, limits);
  const composed = parser.parseStream();
  const tokenized = tokenize(source, authority, limits.maxTokenCount);
  return publish(composed, tokenized.index, tokenized.kinds, source, authority, profile, limits);
}

/** validate_version_directives (lib.rs:789-831). */
export function validateVersionDirectives(text: string, profile: YamlProfile): void {
  let lineIndex = 0;
  for (const rawLine of text.split('\n')) {
    lineIndex += 1;
    let line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith('\u{feff}')) {
      line = line.slice(1);
    }
    if (!line.startsWith('%YAML')) {
      continue;
    }
    const rest = line.slice('%YAML'.length);
    if (rest.length === 0 || (rest[0] !== ' ' && rest[0] !== '\t')) {
      continue;
    }
    const trimmed = rest.trimStart();
    let version = '';
    for (const character of trimmed) {
      if (character === ' ' || character === '\t' || character === '#') {
        break;
      }
      version += character;
    }
    if (version !== acceptedVersion(profile)) {
      throw FatalFormationFailure.versionDirective(
        yamlProfileId(profile).id(),
        version,
        lineIndex,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Scalar-coordinate native model
// ---------------------------------------------------------------------------

interface ScalarSpan {
  readonly start: number;
  readonly end: number;
}

interface ScratchScalar {
  readonly decoded: string;
  readonly canonical: string;
  readonly kind: YamlScalarKind;
  readonly style: YamlScalarStyle;
}

interface ScratchNode {
  tag: string;
  anchor: string | null;
  anchorSpan: ScalarSpan | null;
  span: ScalarSpan;
  content: ScratchContent;
}

type ScratchContent =
  | { readonly kind: 'Scalar'; readonly scalar: ScratchScalar }
  | { readonly kind: 'Sequence'; readonly items: ScratchItem[] }
  | { readonly kind: 'Mapping'; readonly entries: ScratchEntry[] };

interface ScratchItem {
  readonly identity: bigint;
  readonly node: number;
  readonly span: ScalarSpan;
  readonly alias: number | null;
}

interface ScratchEntry {
  readonly identity: bigint;
  readonly key: number;
  readonly value: number;
  readonly span: ScalarSpan;
  readonly keyAlias: number | null;
  readonly valueAlias: number | null;
}

interface ScratchAlias {
  readonly identity: bigint;
  readonly name: string;
  readonly target: number;
  readonly span: ScalarSpan;
}

interface ScratchDocument {
  readonly root: number;
  readonly span: ScalarSpan;
}

interface Composed {
  readonly nodes: readonly ScratchNode[];
  readonly documents: readonly ScratchDocument[];
  readonly aliases: readonly ScratchAlias[];
}

interface Properties {
  readonly anchor: string | null;
  readonly anchorStart: number;
  readonly anchorEnd: number;
  readonly tag: string;
}

interface Occurrence {
  readonly node: number;
  readonly start: number;
  readonly end: number;
  readonly alias: number | null;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function isSeparation(value: string | undefined): boolean {
  return value === ' ' || value === '\t' || value === '\r' || value === '\n';
}

function isFlowIndicator(value: string | undefined): boolean {
  return value === '[' || value === ']' || value === '{' || value === '}' || value === ',';
}

function nextLineStart(chars: readonly string[], offset: number): number {
  let cursor = offset;
  if (chars[cursor] === '\r') {
    cursor += 1;
    if (chars[cursor] === '\n') {
      cursor += 1;
    }
  } else if (chars[cursor] === '\n') {
    cursor += 1;
  }
  return cursor;
}

/** The recursive-descent YAML 1.2.2 presentation parser and composer. */
class Parser {
  readonly #chars: readonly string[];
  readonly #profile: YamlProfile;
  readonly #limits: ParseLimits;
  #pos = 0;
  #lineStart = 0;
  #depth = 0;
  #events = 0;
  #nodes: (ScratchNode | null)[] = [];
  #documents: ScratchDocument[] = [];
  #aliases: ScratchAlias[] = [];
  #anchors = new Map<string, number>();
  #tagDirectives = new Map<string, string>();
  #versionSeen = false;
  #nextAssociation = 0n;

  constructor(text: string, profile: YamlProfile, limits: ParseLimits) {
    this.#chars = Array.from(text);
    this.#profile = profile;
    this.#limits = limits;
    // The backend text is the BOM-stripped decoded text; the BOM remains
    // source content and occupies scalar offset 0 (lib.rs:285-287).
    if (this.#chars[0] === '\u{feff}') {
      this.#pos = 1;
      this.#lineStart = 1;
    }
  }

  parseStream(): Composed {
    this.#countEvent(); // StreamStart
    this.#parseDirectives();
    for (;;) {
      this.#skipBlankLines();
      if (this.#atEOF()) {
        break;
      }
      if (this.#atDocumentMarker('---')) {
        this.#parseDocument(true);
      } else if (this.#atDocumentMarker('...')) {
        this.#failSyntax();
      } else {
        this.#parseDocument(false);
      }
      // After one document: end markers and directives, then the next
      // document or the end of the stream.
      for (;;) {
        this.#skipBlankLines();
        if (this.#atEOF()) {
          this.#countEvent(); // StreamEnd
          return {
            nodes: Object.freeze(this.#nodes.map((node) => node!)),
            documents: Object.freeze(this.#documents),
            aliases: Object.freeze(this.#aliases),
          };
        }
        if (this.#atDocumentMarker('---')) {
          break;
        }
        if (this.#atDocumentMarker('...')) {
          this.#pos += 3;
          this.#parseDirectives();
          continue;
        }
        this.#failSyntax();
      }
    }
    this.#countEvent(); // StreamEnd
    return {
      nodes: Object.freeze(this.#nodes.map((node) => node!)),
      documents: Object.freeze(this.#documents),
      aliases: Object.freeze(this.#aliases),
    };
  }

  /** Consumes directive lines at a directive position (go/parser.go parseDirectives). */
  #parseDirectives(): void {
    while (!this.#atEOF() && this.#atLineStart() && this.#current() === '%') {
      const lineEnd = this.#lineEndAt(this.#pos);
      const line = this.#chars.slice(this.#pos, lineEnd).join('');
      this.#pos = lineEnd;
      this.#countEvent();
      this.#parseDirective(line);
      if (lineEnd >= this.#chars.length) {
        return;
      }
      this.#pos = nextLineStart(this.#chars, lineEnd);
      this.#lineStart = this.#pos;
    }
  }

  /** Validates one directive line: %YAML, %TAG, or a reserved directive. */
  #parseDirective(line: string): void {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (text.startsWith('%YAML')) {
      const rest = text.slice('%YAML'.length);
      if (rest.length === 0 || (rest[0] !== ' ' && rest[0] !== '\t')) {
        this.#failSyntax();
      }
      if (this.#versionSeen) {
        // Duplicate version directives fail as syntax (RFC 0007 §5:103).
        this.#failSyntax();
      }
      this.#versionSeen = true;
      const version = firstToken(rest);
      if (version !== '1.1' && version !== '1.2') {
        this.#failSyntax();
      }
      return;
    }
    if (text.startsWith('%TAG')) {
      const fields = tokenFields(text.slice('%TAG'.length));
      if (fields.length < 2) {
        this.#failSyntax();
      }
      const handle = fields[0];
      const prefix = fields[1];
      if (handle.length < 2 || handle[0] !== '!' || handle[handle.length - 1] !== '!') {
        this.#failSyntax();
      }
      if (handle === '!!') {
        this.#failSyntax();
      }
      if (this.#tagDirectives.has(handle)) {
        this.#failSyntax();
      }
      this.#tagDirectives.set(handle, prefix);
      return;
    }
    // Reserved directives are ignored (YAML 1.2.2 §7.1.2).
  }

  #parseDocument(explicit: boolean): void {
    const start = this.#pos;
    this.#countEvent(); // DocumentStart
    this.#anchors = new Map();
    this.#tagDirectives = new Map();
    this.#versionSeen = false;
    if (explicit) {
      this.#pos += 3;
      this.#skipSeparationInline();
    }
    let root: number;
    if (!explicit && this.#lineIndentAt(this.#pos) > 0) {
      this.#failSyntax();
    }
    this.#skipBlankLines();
    if (this.#atEOF() || this.#atDocumentMarker('---') || this.#atDocumentMarker('...')) {
      // An empty document composes the profile's resolved null scalar
      // (RFC 0007 §8:196-197).
      root = this.#emptyNullNode(this.#pos);
    } else {
      const node = this.#parseBlockNode();
      root = node.node;
    }
    // Consume an optional `...` end marker at the start of a line.
    if (!this.#atEOF() && this.#atLineStart() && this.#atDocumentMarker('...')) {
      this.#pos += 3;
    }
    this.#countEvent(); // DocumentEnd
    const span = explicit
      ? { start, end: this.#pos }
      : this.#nodes[root]!.span;
    this.#documents.push({ root, span });
  }

  #parseBlockNode(): Occurrence {
    const props = this.#parseProperties();
    return this.#parseBlockNodeWithProps(props);
  }

  #parseBlockNodeWithProps(props: Properties): Occurrence {
    // Every caller positions the cursor at a line start, so the current
    // line's indentation is the block collection indent. It must be read
    // BEFORE `#skipSeparationInline` consumes the indentation: the previous
    // code asked `#lineIndentAt(#pos)` mid-line at the indicator, which
    // always read 0 and rejected every nested block sequence/mapping whose
    // next sibling line sits at the real indent (e.g. `a:\n  - one\n  - two`
    // and `a:\n  ? x\n  : 1\n  ? y\n  : 2` failed as yaml.parse.syntax@1).
    const lineIndent = this.#lineIndentAt(this.#pos);
    this.#skipSeparationInline();
    if (this.#atEOF() || this.#current() === '\r' || this.#current() === '\n' || this.#current() === '#') {
      // Properties followed by the line end: a nested block node on the
      // following lines, or the resolved empty node carrying the properties.
      const found = this.#peekContentLine();
      if (found !== null) {
        this.#skipBlankLines();
        return this.#parseBlockNodeWithProps(props);
      }
      return this.#parseEmptyPropertyNode(props);
    }
    const character = this.#current();
    if (character === '-' && this.#followedBySeparation(1)) {
      return this.#parseBlockSequence(lineIndent, props);
    }
    if (character === '?' && this.#followedBySeparation(1)) {
      return this.#parseBlockMapping(lineIndent, props);
    }
    if (this.#looksLikeImplicitKey()) {
      // The mapping identity is reserved before the key node, matching the
      // backend event order (MappingStart precedes its children). The block
      // mapping's indentation is the first key's column on its line: the
      // saphyr backend opens the nested BlockMappingStart at the key column
      // and sibling lines at that column continue the mapping —
      // `a:\n  b: 1\n  c: 2` composes one nested mapping. The previous code
      // asked `#lineIndentAt(#pos)` where the cursor is mid-line at the `:`
      // after the key, which always read 0 and rejected every nested block
      // mapping with a second entry as yaml.parse.syntax@1.
      const index = this.#reserveNode();
      if (props.anchor !== null) {
        this.#anchors.set(props.anchor, index);
      }
      const keyLineStart = this.#lineStart;
      const key = this.#parseInlineNode();
      const indent = key.start - keyLineStart;
      return this.#parseBlockMappingWithFirstEntry(index, indent, key, props);
    }
    switch (character) {
      case '[':
      case '{':
        return this.#parseFlowNode(props);
      case "'":
      case '"':
        return this.#parseQuoted(character, props);
      case '*':
        if (props.anchor !== null || props.tag !== '') {
          this.#failSyntax();
        }
        return this.#parseAlias();
      case '|':
      case '>':
        return this.#parseBlockScalar(character === '>', this.#lineIndentAt(this.#pos), props);
      default:
        return this.#parsePlainBlock(props);
    }
  }

  #parseEmptyPropertyNode(props: Properties): Occurrence {
    const marker = this.#pos;
    const index = this.#reserveNode();
    const node = emptyScratchNode(marker);
    if (props.tag !== '') {
      const resolved = resolveExplicit('', 'Plain', props.tag, this.#profile);
      if (resolved === null) {
        this.#nativeFailure('yaml.scalar.invalid-explicit-tag@1');
      }
      node.tag = resolved.tag;
      node.content = {
        kind: 'Scalar',
        scalar: {
          decoded: resolved.decoded,
          canonical: resolved.canonical,
          kind: resolved.kind,
          style: resolved.style,
        },
      };
    }
    if (props.anchor !== null) {
      this.#anchors.set(props.anchor, index);
      node.anchor = props.anchor;
      node.anchorSpan = { start: props.anchorStart, end: props.anchorEnd };
    }
    this.#nodes[index] = node;
    return { node: index, start: marker, end: marker, alias: null };
  }

  #parseBlockSequence(indent: number, props: Properties): Occurrence {
    const start = this.#pos;
    const index = this.#reserveNode();
    if (props.anchor !== null) {
      // The anchor registers before the children so self-aliases resolve.
      this.#anchors.set(props.anchor, index);
    }
    this.#countDepth();
    this.#countEvent(); // SequenceStart
    const items: ScratchItem[] = [];
    for (;;) {
      if (this.#current() !== '-' || !this.#followedBySeparation(1)) {
        this.#failSyntax();
      }
      this.#pos += 1;
      this.#skipSeparationInline();
      const item = this.#parseNodeAfterIndicator(indent, true);
      items.push({
        identity: this.#associationIdentity(),
        node: item.node,
        span: { start: item.start, end: item.end },
        alias: item.alias,
      });
      // Next item?
      this.#skipBlankLines();
      if (this.#atEOF() || this.#atDocumentMarker('---') || this.#atDocumentMarker('...')) {
        break;
      }
      const lineIndent = this.#lineIndentAt(this.#pos);
      if (lineIndent < indent) {
        break;
      }
      if (lineIndent > indent || !this.#atLineStart()) {
        this.#failSyntax();
      }
      this.#skipSeparationInline();
      if (!(this.#current() === '-' && this.#followedBySeparation(1))) {
        break;
      }
    }
    this.#depth -= 1;
    this.#countEvent(); // SequenceEnd
    let end = start;
    if (items.length > 0) {
      end = items[items.length - 1].span.end;
    }
    const node: ScratchNode = {
      tag: TAG_SEQ,
      anchor: null,
      anchorSpan: null,
      span: { start, end },
      content: { kind: 'Sequence', items },
    };
    return this.#finishNode(index, node, props);
  }

  #parseBlockMapping(indent: number, props: Properties): Occurrence {
    const start = this.#pos;
    const index = this.#reserveNode();
    if (props.anchor !== null) {
      this.#anchors.set(props.anchor, index);
    }
    this.#countDepth();
    this.#countEvent(); // MappingStart
    const entries: ScratchEntry[] = [];
    for (;;) {
      const entry = this.#parseMappingEntry(indent);
      if (entry === null) {
        break;
      }
      entries.push(entry);
    }
    this.#depth -= 1;
    this.#countEvent(); // MappingEnd
    let end = start;
    if (entries.length > 0) {
      end = entries[entries.length - 1].span.end;
    }
    const node: ScratchNode = {
      tag: TAG_MAP,
      anchor: null,
      anchorSpan: null,
      span: { start, end },
      content: { kind: 'Mapping', entries },
    };
    return this.#finishNode(index, node, props);
  }

  #parseBlockMappingWithFirstEntry(
    index: number,
    indent: number,
    key: Occurrence,
    props: Properties,
  ): Occurrence {
    const start = key.start;
    this.#countDepth();
    this.#countEvent(); // MappingStart
    const entries: ScratchEntry[] = [];
    entries.push(this.#parseImplicitEntry(indent, key));
    for (;;) {
      const entry = this.#parseMappingEntry(indent);
      if (entry === null) {
        break;
      }
      entries.push(entry);
    }
    this.#depth -= 1;
    this.#countEvent(); // MappingEnd
    let end = start;
    if (entries.length > 0) {
      end = entries[entries.length - 1].span.end;
    }
    const node: ScratchNode = {
      tag: TAG_MAP,
      anchor: null,
      anchorSpan: null,
      span: { start, end },
      content: { kind: 'Mapping', entries },
    };
    return this.#finishNode(index, node, props);
  }

  #finishNode(index: number, node: ScratchNode, props: Properties): Occurrence {
    if (props.anchor !== null) {
      node.anchor = props.anchor;
      node.anchorSpan = { start: props.anchorStart, end: props.anchorEnd };
    }
    this.#nodes[index] = node;
    return { node: index, start: node.span.start, end: node.span.end, alias: null };
  }

  #parseMappingEntry(indent: number): ScratchEntry | null {
    this.#skipBlankLines();
    if (this.#atEOF() || this.#atDocumentMarker('---') || this.#atDocumentMarker('...')) {
      return null;
    }
    if (!this.#atLineStart()) {
      this.#failSyntax();
    }
    const lineIndent = this.#lineIndentAt(this.#pos);
    if (lineIndent < indent) {
      return null;
    }
    if (lineIndent > indent) {
      this.#failSyntax();
    }
    this.#skipSeparationInline();
    if (this.#current() === '?' && this.#followedBySeparation(1)) {
      return this.#parseExplicitEntry(indent);
    }
    if (!this.#looksLikeImplicitKey()) {
      return null;
    }
    const key = this.#parseInlineNode();
    return this.#parseImplicitEntry(indent, key);
  }

  #parseExplicitEntry(indent: number): ScratchEntry {
    const marker = this.#pos;
    this.#pos += 1; // consume '?'
    this.#skipSeparationInline();
    let key: Occurrence;
    if (this.#atEOF() || this.#current() === '\r' || this.#current() === '\n' || this.#current() === '#') {
      const keyIndex = this.#emptyNullNode(marker);
      key = { node: keyIndex, start: marker, end: marker, alias: null };
    } else {
      key = this.#parseInlineNode();
    }
    // Expect the `:` value indicator on this line or the next line at the
    // mapping's indentation.
    this.#skipSeparationInline();
    let colonFound = false;
    if (!this.#atEOF() && this.#current() === ':' && this.#followedBySeparation(1)) {
      colonFound = true;
      this.#pos += 1;
      this.#skipSeparationInline();
    } else if (this.#atEOF() || this.#current() === '\r' || this.#current() === '\n' || this.#current() === '#') {
      const saved = this.#pos;
      this.#skipBlankLines();
      if (
        !this.#atEOF() &&
        this.#atLineStart() &&
        this.#lineIndentAt(this.#pos) === indent &&
        this.#current() === ':' &&
        this.#followedBySeparation(1)
      ) {
        colonFound = true;
        this.#pos += 1;
        this.#skipSeparationInline();
      } else {
        this.#pos = saved;
      }
    }
    if (!colonFound) {
      this.#failSyntax();
    }
    const value = this.#parseNodeAfterIndicator(indent, false);
    return {
      identity: this.#associationIdentity(),
      key: key.node,
      value: value.node,
      span: { start: key.start, end: value.end },
      keyAlias: key.alias,
      valueAlias: value.alias,
    };
  }

  #parseImplicitEntry(indent: number, key: Occurrence): ScratchEntry {
    this.#skipSeparationInline();
    if (this.#atEOF() || this.#current() !== ':') {
      this.#failSyntax();
    }
    this.#pos += 1; // consume ':'
    this.#skipSeparationInline();
    const value = this.#parseNodeAfterIndicator(indent, false);
    return {
      identity: this.#associationIdentity(),
      key: key.node,
      value: value.node,
      span: { start: key.start, end: value.end },
      keyAlias: key.alias,
      valueAlias: value.alias,
    };
  }

  #looksLikeImplicitKey(): boolean {
    if (this.#atEOF()) {
      return false;
    }
    const lineEnd = this.#lineEndAt(this.#pos);
    let offset = this.#pos;
    const character = this.#chars[offset];
    if (character === "'" || character === '"') {
      const after = this.#scanQuotedLookahead(offset);
      if (after < 0 || after > lineEnd) {
        return false;
      }
      offset = after;
      while (offset < lineEnd && (this.#chars[offset] === ' ' || this.#chars[offset] === '\t')) {
        offset += 1;
      }
    } else if (character === '[' || character === '{') {
      const after = this.#scanFlowLookahead(offset);
      if (after < 0 || after > lineEnd) {
        return false;
      }
      offset = after;
      while (offset < lineEnd && (this.#chars[offset] === ' ' || this.#chars[offset] === '\t')) {
        offset += 1;
      }
    } else {
      while (offset < lineEnd) {
        const item = this.#chars[offset];
        if (isSeparation(item) || isFlowIndicator(item)) {
          break;
        }
        if (item === ':' && this.#colonFollowsSep(offset)) {
          break;
        }
        offset += 1;
      }
      if (offset >= lineEnd || this.#chars[offset] !== ':') {
        return false;
      }
    }
    if (offset >= lineEnd || this.#chars[offset] !== ':') {
      return false;
    }
    return this.#colonFollowsSep(offset);
  }

  #colonFollowsSep(offset: number): boolean {
    if (offset + 1 >= this.#chars.length) {
      return true;
    }
    const next = this.#chars[offset + 1];
    return isSeparation(next) || isFlowIndicator(next);
  }

  #scanQuotedLookahead(cursor: number): number {
    const quote = this.#chars[cursor];
    cursor += 1;
    while (cursor < this.#chars.length) {
      const character = this.#chars[cursor];
      if (character === quote) {
        if (quote === "'" && cursor + 1 < this.#chars.length && this.#chars[cursor + 1] === "'") {
          cursor += 2;
          continue;
        }
        return cursor + 1;
      }
      if (character === '\\' && quote === '"') {
        cursor += 2;
        continue;
      }
      cursor += 1;
    }
    return -1;
  }

  #scanFlowLookahead(cursor: number): number {
    let depth = 0;
    while (cursor < this.#chars.length) {
      const character = this.#chars[cursor];
      switch (character) {
        case "'":
        case '"': {
          const after = this.#scanQuotedLookahead(cursor);
          if (after < 0) {
            return -1;
          }
          cursor = after;
          continue;
        }
        case '[':
        case '{':
          depth += 1;
          break;
        case ']':
        case '}':
          depth -= 1;
          if (depth === 0) {
            return cursor + 1;
          }
          break;
        case '\r':
        case '\n':
          return -1;
      }
      cursor += 1;
    }
    return -1;
  }

  #parseNodeAfterIndicator(parentIndent: number, allowCompact: boolean): Occurrence {
    const marker = this.#pos;
    this.#skipSeparationInline();
    if (this.#atEOF() || this.#current() === '\r' || this.#current() === '\n' || this.#current() === '#') {
      return this.#parseEmptyValue(parentIndent, marker);
    }
    const node = this.#parseInlineValue(parentIndent, allowCompact);
    // A same-line value must end at a line boundary, a comment, or the end
    // of the stream.
    if (!this.#atEOF() && !this.#atLineStart() && !this.#lineEndsCleanly()) {
      this.#failSyntax();
    }
    return node;
  }

  #parseEmptyValue(parentIndent: number, marker: number): Occurrence {
    const next = this.#peekContentLine();
    if (next !== null && next > parentIndent) {
      this.#skipBlankLines();
      return this.#parseBlockNode();
    }
    return { node: this.#emptyNullNode(marker), start: marker, end: marker, alias: null };
  }

  #peekContentLine(): number | null {
    let offset = this.#pos;
    for (;;) {
      if (offset >= this.#chars.length) {
        return null;
      }
      const lineEnd = this.#lineEndAt(offset);
      let blank = true;
      for (let cursor = offset; cursor < lineEnd; cursor++) {
        const character = this.#chars[cursor];
        if (character === '#') {
          break;
        }
        if (character !== ' ' && character !== '\t') {
          blank = false;
          break;
        }
      }
      if (!blank) {
        return this.#lineIndentAt(offset);
      }
      if (lineEnd >= this.#chars.length) {
        return null;
      }
      offset = nextLineStart(this.#chars, lineEnd);
    }
  }

  #parseInlineValue(parentIndent: number, allowCompact: boolean): Occurrence {
    const props = this.#parseProperties();
    this.#skipSeparationInline();
    if (this.#atEOF() || this.#current() === '\r' || this.#current() === '\n' || this.#current() === '#') {
      const next = this.#peekContentLine();
      if (next !== null && next > parentIndent) {
        this.#skipBlankLines();
        return this.#parseBlockNodeWithProps(props);
      }
      return this.#parseEmptyPropertyNode(props);
    }
    const character = this.#current();
    switch (character) {
      case '[':
      case '{':
        return this.#parseFlowNode(props);
      case "'":
      case '"':
        return this.#parseQuoted(character, props);
      case '*':
        if (props.anchor !== null || props.tag !== '') {
          this.#failSyntax();
        }
        return this.#parseAlias();
      case '|':
      case '>':
        return this.#parseBlockScalar(character === '>', parentIndent, props);
      case '-':
        if (this.#followedBySeparation(1)) {
          if (props.anchor !== null || props.tag !== '') {
            this.#failSyntax();
          }
          return this.#parseBlockSequence(this.#pos - this.#lineStart, emptyProperties());
        }
        break;
      case '?':
        if (this.#followedBySeparation(1)) {
          if (!allowCompact) {
            this.#failSyntax();
          }
          if (props.anchor !== null || props.tag !== '') {
            this.#failSyntax();
          }
          return this.#parseBlockMapping(this.#pos - this.#lineStart, emptyProperties());
        }
        break;
      default:
        break;
    }
    if (this.#looksLikeImplicitKey() && allowCompact) {
      // Compact block mapping value (`- key: value`), indented at the
      // key's column; the mapping identity is reserved first.
      const index = this.#reserveNode();
      const key = this.#parseInlineNode();
      return this.#parseBlockMappingWithFirstEntry(
        index,
        key.start - this.#lineStart,
        key,
        emptyProperties(),
      );
    }
    return this.#parsePlainBlock(props);
  }

  #parseInlineNode(): Occurrence {
    const props = this.#parseProperties();
    this.#skipSeparationInline();
    if (this.#atEOF() || this.#current() === '\r' || this.#current() === '\n' || this.#current() === '#') {
      this.#failSyntax();
    }
    const character = this.#current();
    switch (character) {
      case '[':
      case '{':
        return this.#parseFlowNode(props);
      case "'":
      case '"':
        return this.#parseQuoted(character, props);
      case '*':
        if (props.anchor !== null || props.tag !== '') {
          this.#failSyntax();
        }
        return this.#parseAlias();
      default:
        return this.#parsePlainSingleLine(props);
    }
  }

  #parseProperties(): Properties {
    let anchor: string | null = null;
    let anchorStart = 0;
    let anchorEnd = 0;
    let tag = '';
    for (;;) {
      const character = this.#current();
      if (character === '&') {
        if (anchor !== null) {
          this.#failSyntax();
        }
        const start = this.#pos;
        this.#pos += 1;
        const name = this.#scanPropertyName();
        if (name === '') {
          this.#failSyntax();
        }
        anchor = name;
        anchorStart = start;
        anchorEnd = this.#pos;
      } else if (character === '!') {
        if (tag !== '') {
          this.#failSyntax();
        }
        tag = this.#parseTag();
      } else {
        break;
      }
      if (this.#atEOF() || isSeparation(this.#current())) {
        this.#skipSeparationInline();
        continue;
      }
      this.#failSyntax();
    }
    return { anchor, anchorStart, anchorEnd, tag };
  }

  #scanPropertyName(): string {
    const start = this.#pos;
    while (!this.#atEOF()) {
      const character = this.#current();
      if (isSeparation(character) || isFlowIndicator(character)) {
        break;
      }
      this.#pos += 1;
    }
    return this.#chars.slice(start, this.#pos).join('');
  }

  #parseTag(): string {
    this.#pos += 1; // consume '!'
    if (this.#current() === '<') {
      this.#pos += 1;
      const start = this.#pos;
      while (!this.#atEOF() && this.#current() !== '>') {
        this.#pos += 1;
      }
      if (this.#atEOF()) {
        this.#failSyntax();
      }
      const verbatim = this.#chars.slice(start, this.#pos).join('');
      this.#pos += 1; // consume '>'
      if (verbatim === '') {
        this.#failSyntax();
      }
      return verbatim;
    }
    const text = this.#scanPropertyName();
    if (text === '') {
      return '!'; // the non-specific tag
    }
    const index = text.indexOf('!');
    if (index >= 0) {
      const handle = '!' + text.slice(0, index + 1);
      const suffix = text.slice(index + 1);
      if (handle === '!!') {
        return 'tag:yaml.org,2002:' + suffix;
      }
      const prefix = this.#tagDirectives.get(handle);
      if (prefix === undefined) {
        this.#failSyntax();
      }
      return prefix + suffix;
    }
    return '!' + text;
  }

  #parseAlias(): Occurrence {
    const start = this.#pos;
    this.#pos += 1;
    const name = this.#scanPropertyName();
    if (name === '') {
      this.#failSyntax();
    }
    const target = this.#anchors.get(name);
    if (target === undefined) {
      // Undefined aliases fail at parse time (yaml.parse.syntax@1), the
      // vector-pinned surface (yaml-v1.json formation.undefined-alias).
      this.#failSyntax();
    }
    const ordinal = this.#aliases.length;
    this.#aliases.push({
      identity: this.#associationIdentity(),
      name,
      target,
      span: { start, end: this.#pos },
    });
    this.#countEvent(); // one node occurrence
    return { node: target, start, end: this.#pos, alias: ordinal };
  }

  #parsePlainSingleLine(props: Properties): Occurrence {
    const start = this.#pos;
    const decoded = this.#scanPlainLine();
    const end = this.#pos;
    const index = this.#reserveNode();
    const resolved = this.#resolveScalar(decoded, 'Plain', props.tag);
    const node: ScratchNode = {
      tag: resolved.tag,
      anchor: null,
      anchorSpan: null,
      span: { start, end },
      content: { kind: 'Scalar', scalar: { ...resolved, style: 'Plain' } },
    };
    if (props.anchor !== null) {
      this.#anchors.set(props.anchor, index);
      node.anchor = props.anchor;
      node.anchorSpan = { start: props.anchorStart, end: props.anchorEnd };
    }
    this.#nodes[index] = node;
    this.#countEvent();
    return { node: index, start, end, alias: null };
  }

  #parsePlainBlock(props: Properties): Occurrence {
    const start = this.#pos;
    const firstLineIndent = this.#lineIndentAt(this.#pos);
    const parts: string[] = [];
    let continuation = false;
    for (;;) {
      const part = this.#scanBlockPlainLine();
      if (continuation) {
        parts[parts.length - 1] = parts[parts.length - 1] + ' ' + part;
      } else {
        parts.push(part);
      }
      continuation = false;
      if (this.#atEOF() || !this.#peekContinuationLine(firstLineIndent)) {
        break;
      }
      this.#skipBlankLines();
      continuation = true;
    }
    const end = this.#pos;
    const decoded = parts.join(' ');
    const index = this.#reserveNode();
    const resolved = this.#resolveScalar(decoded, 'Plain', props.tag);
    const node: ScratchNode = {
      tag: resolved.tag,
      anchor: null,
      anchorSpan: null,
      span: { start, end },
      content: { kind: 'Scalar', scalar: { ...resolved, style: 'Plain' } },
    };
    if (props.anchor !== null) {
      this.#anchors.set(props.anchor, index);
      node.anchor = props.anchor;
      node.anchorSpan = { start: props.anchorStart, end: props.anchorEnd };
    }
    this.#nodes[index] = node;
    this.#countEvent();
    return { node: index, start, end, alias: null };
  }

  #scanPlainLine(): string {
    const start = this.#pos;
    while (!this.#atEOF()) {
      const character = this.#current();
      if (isSeparation(character) || isFlowIndicator(character)) {
        break;
      }
      if (character === ':' && this.#colonFollowsSep(this.#pos)) {
        break;
      }
      this.#pos += 1;
    }
    return this.#chars.slice(start, this.#pos).join('');
  }

  #scanBlockPlainLine(): string {
    let start = this.#pos;
    while (!this.#atEOF()) {
      const character = this.#current();
      if (character === ' ' || character === '\t') {
        // Look ahead: trailing separation before a stop is not content.
        let offset = this.#pos;
        while (offset < this.#chars.length && (this.#chars[offset] === ' ' || this.#chars[offset] === '\t')) {
          offset += 1;
        }
        if (
          offset >= this.#chars.length ||
          this.#chars[offset] === '\r' ||
          this.#chars[offset] === '\n' ||
          this.#chars[offset] === '#' ||
          (this.#chars[offset] === ':' && this.#colonFollowsSep(offset))
        ) {
          break;
        }
        if (this.#pos === start) {
          // Leading separation of the line is indentation, not content
          // (` &a !t s` folds to `&a !t s`).
          start = offset;
        }
        this.#pos = offset;
        continue;
      }
      if (character === '\r' || character === '\n') {
        break;
      }
      // A `#` ends the scalar only at a token boundary (preceded by
      // separation); mid-word hashes are content (`k:#foo`).
      if (character === '#' && this.#pos > start && (this.#chars[this.#pos - 1] === ' ' || this.#chars[this.#pos - 1] === '\t')) {
        break;
      }
      if (character === ':' && this.#colonFollowsSep(this.#pos)) {
        break;
      }
      this.#pos += 1;
    }
    return this.#chars.slice(start, this.#pos).join('');
  }

  #peekContinuationLine(firstLineIndent: number): boolean {
    let offset = this.#pos;
    if (offset >= this.#chars.length) {
      return false;
    }
    // Skip the line break and any blank/comment lines.
    while (offset < this.#chars.length && (this.#chars[offset] === '\r' || this.#chars[offset] === '\n')) {
      offset = nextLineStart(this.#chars, offset);
    }
    for (;;) {
      if (offset >= this.#chars.length) {
        return false;
      }
      const lineEnd = this.#lineEndAt(offset);
      let blank = true;
      for (let cursor = offset; cursor < lineEnd; cursor++) {
        const character = this.#chars[cursor];
        if (character === '#') {
          break;
        }
        if (character !== ' ' && character !== '\t') {
          blank = false;
          break;
        }
      }
      if (!blank) {
        break;
      }
      if (lineEnd >= this.#chars.length) {
        return false;
      }
      offset = nextLineStart(this.#chars, lineEnd);
    }
    if (offset >= this.#chars.length) {
      return false;
    }
    const indent = this.#lineIndentAt(offset);
    if (indent <= firstLineIndent) {
      return false;
    }
    // The continuation must not start an indented structure.
    const lineEnd = this.#lineEndAt(offset);
    for (let cursor = offset + indent; cursor < lineEnd; cursor++) {
      const character = this.#chars[cursor];
      if (character === '#') {
        break;
      }
      if (
        (character === '-' || character === '?') &&
        (cursor + 1 >= lineEnd || isSeparation(this.#chars[cursor + 1]))
      ) {
        return false;
      }
      if (character === ':' && (cursor + 1 >= lineEnd || isSeparation(this.#chars[cursor + 1]))) {
        return false;
      }
    }
    return true;
  }

  #parseQuoted(quote: string, props: Properties): Occurrence {
    const start = this.#pos;
    this.#pos += 1; // opening quote
    let decoded = '';
    for (;;) {
      if (this.#atEOF()) {
        this.#failSyntax();
      }
      const character = this.#current();
      if (character === quote) {
        if (quote === "'" && this.#peek() === "'") {
          decoded += "'";
          this.#pos += 2;
          continue;
        }
        this.#pos += 1; // closing quote
        break;
      }
      if (character === '\\' && quote === '"') {
        decoded += this.#parseEscape();
        continue;
      }
      if (character === '\r' || character === '\n') {
        decoded += this.#foldQuotedBreak();
        continue;
      }
      decoded += character;
      this.#pos += 1;
    }
    const end = this.#pos;
    const style = quote === "'" ? 'SingleQuoted' : 'DoubleQuoted';
    const index = this.#reserveNode();
    const resolved = this.#resolveScalar(decoded, style, props.tag);
    const node: ScratchNode = {
      tag: resolved.tag,
      anchor: null,
      anchorSpan: null,
      span: { start, end },
      content: { kind: 'Scalar', scalar: { ...resolved, style } },
    };
    if (props.anchor !== null) {
      this.#anchors.set(props.anchor, index);
      node.anchor = props.anchor;
      node.anchorSpan = { start: props.anchorStart, end: props.anchorEnd };
    }
    this.#nodes[index] = node;
    this.#countEvent();
    return { node: index, start, end, alias: null };
  }

  #foldQuotedBreak(): string {
    let breaks = 0;
    while (!this.#atEOF()) {
      const character = this.#current();
      if (character !== '\r' && character !== '\n') {
        break;
      }
      breaks += 1;
      this.#pos = nextLineStart(this.#chars, this.#pos);
      this.#lineStart = this.#pos;
    }
    // Leading whitespace of the continuation line is stripped.
    while (!this.#atEOF()) {
      const character = this.#current();
      if (character === ' ' || character === '\t') {
        this.#pos += 1;
        continue;
      }
      break;
    }
    if (breaks === 1) {
      return ' ';
    }
    return '\n'.repeat(breaks - 1);
  }

    #parseEscape(): string {
    this.#pos += 1; // consume '\'
    if (this.#atEOF()) {
      this.#failSyntax();
    }
    const character = this.#current();
    this.#pos += 1;
    switch (character) {
      case '0':
        return '\x00';
      case 'a':
        return '\x07';
      case 'b':
        return '\x08';
      case 't':
        return '\t';
      case 'n':
        return '\n';
      case 'v':
        return '\x0b';
      case 'f':
        return '\x0c';
      case 'r':
        return '\r';
      case 'e':
        return '\x1b';
      case ' ':
        return ' ';
      case '"':
        return '"';
      case '/':
        return '/';
      case '\\':
        return '\\';
      case 'N':
        return '\x85';
      case '_':
        return '\xa0';
      case 'L':
        return '\u2028';
      case 'P':
        return '\u2029';
      case 'x':
        return this.#parseHexEscape(2);
      case 'u':
        return this.#parseHexEscape(4);
      case 'U':
        return this.#parseHexEscape(8);
      case '\r':
      case '\n': {
        // Line continuation: consume the break and the leading whitespace
        // of the next line; nothing is emitted.
        this.#pos = nextLineStart(this.#chars, this.#pos - 1);
        this.#lineStart = this.#pos;
        while (!this.#atEOF()) {
          const next = this.#current();
          if (next === ' ' || next === '\t') {
            this.#pos += 1;
            continue;
          }
          break;
        }
        return '';
      }
      default:
        this.#failSyntax();
    }
  }

  #parseHexEscape(digits: number): string {
    let value = 0;
    for (let index = 0; index < digits; index++) {
      if (this.#atEOF()) {
        this.#failSyntax();
      }
      const character = this.#current()!;
      let digit: number;
      if (character >= '0' && character <= '9') {
        digit = character.charCodeAt(0) - 0x30;
      } else if (character >= 'a' && character <= 'f') {
        digit = character.charCodeAt(0) - 0x61 + 10;
      } else if (character >= 'A' && character <= 'F') {
        digit = character.charCodeAt(0) - 0x41 + 10;
      } else {
        this.#failSyntax();
      }
      value = (value << 4) | digit;
      this.#pos += 1;
    }
    if (value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
      this.#failSyntax();
    }
    return String.fromCodePoint(value);
  }

  #parsePlainFlow(props: Properties): Occurrence {
    const start = this.#pos;
    let decoded = '';
    for (;;) {
      if (this.#atEOF()) {
        break;
      }
      const character = this.#current();
      if (character === ' ' || character === '\t') {
        // Interior separation is scalar content when the entry does not
        // end there.
        let offset = this.#pos;
        while (
          offset < this.#chars.length &&
          (this.#chars[offset] === ' ' || this.#chars[offset] === '\t')
        ) {
          offset += 1;
        }
        if (
          offset >= this.#chars.length ||
          this.#chars[offset] === '\r' ||
          this.#chars[offset] === '\n' ||
          this.#chars[offset] === '#' ||
          isFlowIndicator(this.#chars[offset]) ||
          (this.#chars[offset] === ':' && this.#colonFollowsSep(offset))
        ) {
          break;
        }
        decoded += this.#chars.slice(this.#pos, offset).join('');
        this.#pos = offset;
        continue;
      }
      if (character === '\r' || character === '\n') {
        // Fold the break when the next line continues the scalar.
        let offset = this.#pos;
        while (offset < this.#chars.length && (this.#chars[offset] === '\r' || this.#chars[offset] === '\n')) {
          offset = nextLineStart(this.#chars, offset);
        }
        while (offset < this.#chars.length && (this.#chars[offset] === ' ' || this.#chars[offset] === '\t')) {
          offset += 1;
        }
        if (
          offset >= this.#chars.length ||
          isFlowIndicator(this.#chars[offset]) ||
          this.#chars[offset] === '#'
        ) {
          break;
        }
        decoded += ' ';
        this.#pos = offset;
        continue;
      }
      if (isFlowIndicator(character)) {
        break;
      }
      if (character === ':' && this.#colonFollowsSep(this.#pos)) {
        break;
      }
      decoded += character;
      this.#pos += 1;
    }
    const end = this.#pos;
    const index = this.#reserveNode();
    const resolved = this.#resolveScalar(decoded, 'Plain', props.tag);
    const node: ScratchNode = {
      tag: resolved.tag,
      anchor: null,
      anchorSpan: null,
      span: { start, end },
      content: { kind: 'Scalar', scalar: { ...resolved, style: 'Plain' } },
    };
    if (props.anchor !== null) {
      this.#anchors.set(props.anchor, index);
      node.anchor = props.anchor;
      node.anchorSpan = { start: props.anchorStart, end: props.anchorEnd };
    }
    this.#nodes[index] = node;
    this.#countEvent();
    return { node: index, start, end, alias: null };
  }

  #parseFlowNode(props: Properties): Occurrence {
    const character = this.#current();
    if (character === '[') {
      return this.#parseFlowSequence(props);
    }
    if (character === '{') {
      return this.#parseFlowMapping(props);
    }
    this.#failSyntax();
  }

  #skipFlowSeparation(): void {
    for (;;) {
      if (this.#atEOF()) {
        return;
      }
      const character = this.#current();
      switch (character) {
        case ' ':
        case '\t':
          this.#pos += 1;
          break;
        case '\r':
        case '\n':
          this.#pos = nextLineStart(this.#chars, this.#pos);
          this.#lineStart = this.#pos;
          break;
        case '#': {
          const lineEnd = this.#lineEndAt(this.#pos);
          this.#pos = lineEnd;
          break;
        }
        default:
          return;
      }
    }
  }

  #parseFlowSequence(props: Properties): Occurrence {
    const start = this.#pos;
    const index = this.#reserveNode();
    if (props.anchor !== null) {
      this.#anchors.set(props.anchor, index);
    }
    this.#countDepth();
    this.#countEvent(); // SequenceStart
    this.#pos += 1; // consume '['
    const items: ScratchItem[] = [];
    let done = false;
    while (!done) {
      this.#skipFlowSeparation();
      if (this.#atEOF()) {
        this.#failSyntax();
      }
      if (this.#current() === ']') {
        this.#pos += 1;
        break;
      }
      if (this.#current() === ',') {
        // An empty entry.
        const marker = this.#pos;
        this.#pos += 1;
        const empty = this.#emptyNullNode(marker);
        items.push({
          identity: this.#associationIdentity(),
          node: empty,
          span: { start: marker, end: marker },
          alias: null,
        });
        continue;
      }
      const entry = this.#parseFlowEntry();
      items.push({
        identity: this.#associationIdentity(),
        node: entry.node,
        span: { start: entry.start, end: entry.end },
        alias: entry.alias,
      });
      this.#skipFlowSeparation();
      if (this.#atEOF()) {
        this.#failSyntax();
      }
      switch (this.#current()) {
        case ',':
          this.#pos += 1;
          continue;
        case ']':
          this.#pos += 1;
          done = true;
          break;
        default:
          this.#failSyntax();
      }
    }
    this.#depth -= 1;
    this.#countEvent(); // SequenceEnd
    let end = start;
    if (items.length > 0) {
      end = items[items.length - 1].span.end;
    }
    const node: ScratchNode = {
      tag: TAG_SEQ,
      anchor: null,
      anchorSpan: null,
      span: { start, end },
      content: { kind: 'Sequence', items },
    };
    return this.#finishFlowNode(index, node, props);
  }

  #finishFlowNode(index: number, node: ScratchNode, props: Properties): Occurrence {
    if (props.tag !== '') {
      const expected = node.content.kind === 'Mapping' ? TAG_MAP : TAG_SEQ;
      const resolved = this.#resolveCollectionTag(props.tag, expected);
      node.tag = resolved;
    }
    return this.#finishNode(index, node, props);
  }

  #parseFlowMapping(props: Properties): Occurrence {
    const start = this.#pos;
    const index = this.#reserveNode();
    if (props.anchor !== null) {
      this.#anchors.set(props.anchor, index);
    }
    this.#countDepth();
    this.#countEvent(); // MappingStart
    this.#pos += 1; // consume '{'
    const entries: ScratchEntry[] = [];
    for (;;) {
      this.#skipFlowSeparation();
      if (this.#atEOF()) {
        this.#failSyntax();
      }
      if (this.#current() === '}') {
        this.#pos += 1;
        break;
      }
      if (this.#current() === ',') {
        this.#pos += 1;
        continue;
      }
      let key: Occurrence;
      if (this.#current() === '?' && this.#followedBySeparation(1)) {
        this.#pos += 1;
        this.#skipSeparationInline();
        key = this.#parseFlowValueNode();
        this.#skipSeparationInline();
        if (!this.#atEOF() && this.#current() === ':' && (this.#followedBySeparation(1) || this.#colonFollowsFlow(this.#pos))) {
          this.#pos += 1;
          this.#skipSeparationInline();
        } else if (this.#atEOF() || (this.#current() !== ',' && this.#current() !== '}')) {
          this.#failSyntax();
        }
      } else {
        key = this.#parseFlowValueNode();
        this.#skipSeparationInline();
        if (!this.#atEOF() && this.#current() === ':' && (this.#followedBySeparation(1) || this.#colonFollowsFlow(this.#pos))) {
          this.#pos += 1;
          this.#skipSeparationInline();
        } else if (this.#atEOF() || (this.#current() !== ',' && this.#current() !== '}')) {
          this.#failSyntax();
        }
      }
      // The value: empty when the entry ends, else a flow node.
      this.#skipFlowSeparation();
      let value: Occurrence;
      if (!this.#atEOF() && this.#current() !== ',' && this.#current() !== '}') {
        value = this.#parseFlowValueNode();
      } else {
        const marker = this.#pos;
        value = { node: this.#emptyNullNode(marker), start: marker, end: marker, alias: null };
      }
      entries.push({
        identity: this.#associationIdentity(),
        key: key.node,
        value: value.node,
        span: { start: key.start, end: value.end },
        keyAlias: key.alias,
        valueAlias: value.alias,
      });
      this.#skipFlowSeparation();
      if (this.#atEOF()) {
        this.#failSyntax();
      }
      if (this.#current() === ',') {
        this.#pos += 1;
        continue;
      }
      if (this.#current() === '}') {
        this.#pos += 1;
        break;
      }
      this.#failSyntax();
    }
    this.#depth -= 1;
    this.#countEvent(); // MappingEnd
    let end = start;
    if (entries.length > 0) {
      end = entries[entries.length - 1].span.end;
    }
    const node: ScratchNode = {
      tag: TAG_MAP,
      anchor: null,
      anchorSpan: null,
      span: { start, end },
      content: { kind: 'Mapping', entries },
    };
    return this.#finishFlowNode(index, node, props);
  }

  #colonFollowsFlow(pos: number): boolean {
    return this.#colonFollowsSep(pos);
  }

  #parseFlowEntry(): Occurrence {
    const first = this.#parseFlowValueNode();
    this.#skipSeparationInline();
    if (!this.#atEOF() && this.#current() === ':' && (this.#followedBySeparation(1) || this.#colonFollowsFlow(this.#pos))) {
      // Single-pair mapping entry `[k: v]`.
      this.#pos += 1;
      this.#skipSeparationInline();
      let value: Occurrence;
      if (!this.#atEOF() && this.#current() !== ',' && this.#current() !== ']') {
        value = this.#parseFlowValueNode();
      } else {
        const marker = this.#pos;
        value = { node: this.#emptyNullNode(marker), start: marker, end: marker, alias: null };
      }
      const index = this.#reserveNode();
      this.#nodes[index] = {
        tag: TAG_MAP,
        anchor: null,
        anchorSpan: null,
        span: { start: first.start, end: value.end },
        content: {
          kind: 'Mapping',
          entries: [
            {
              identity: this.#associationIdentity(),
              key: first.node,
              value: value.node,
              span: { start: first.start, end: value.end },
              keyAlias: first.alias,
              valueAlias: value.alias,
            },
          ],
        },
      };
      this.#countEvent();
      return { node: index, start: first.start, end: value.end, alias: null };
    }
    return first;
  }

  #parseFlowValueNode(): Occurrence {
    const props = this.#parseProperties();
    this.#skipSeparationInline();
    if (this.#atEOF()) {
      this.#failSyntax();
    }
    const character = this.#current();
    switch (character) {
      case '[':
      case '{':
        return this.#parseFlowNode(props);
      case "'":
      case '"':
        return this.#parseQuoted(character, props);
      case '*':
        if (props.anchor !== null || props.tag !== '') {
          this.#failSyntax();
        }
        return this.#parseAlias();
      default:
        if (isFlowIndicator(character)) {
          this.#failSyntax();
        }
        return this.#parsePlainFlow(props);
    }
  }

  #parseBlockScalar(folded: boolean, parentIndent: number, props: Properties): Occurrence {
    const start = this.#pos;
    this.#pos += 1; // the header indicator
    let chomping = '';
    let indentDigit = 0;
    for (;;) {
      if (this.#atEOF()) {
        break;
      }
      const character = this.#current()!;
      if (character === '+' || character === '-') {
        if (chomping !== '') {
          this.#failSyntax();
        }
        chomping = character;
        this.#pos += 1;
        continue;
      }
      if (character >= '1' && character <= '9') {
        if (indentDigit !== 0) {
          this.#failSyntax();
        }
        indentDigit = character.charCodeAt(0) - 0x30;
        this.#pos += 1;
        continue;
      }
      break;
    }
    // The rest of the header line must be spaces, tabs, and an optional
    // comment.
    const lineEnd = this.#lineEndAt(this.#pos);
    while (this.#pos < lineEnd) {
      const character = this.#current();
      if (character === ' ' || character === '\t') {
        this.#pos += 1;
        continue;
      }
      if (character === '#') {
        this.#pos = lineEnd;
        break;
      }
      this.#failSyntax();
    }
    let contentIndent = 0;
    if (indentDigit !== 0) {
      contentIndent = parentIndent + indentDigit;
    }
    // Scan the content lines.
    const lines: string[] = [];
    let endedWithBreak = false;
    if (this.#atEOF()) {
      // Header at EOF: no content.
    } else {
      this.#pos = nextLineStart(this.#chars, this.#pos);
      this.#lineStart = this.#pos;
    }
    for (;;) {
      if (this.#atEOF()) {
        break;
      }
      const lineEndAt = this.#lineEndAt(this.#pos);
      let blank = true;
      for (let cursor = this.#pos; cursor < lineEndAt; cursor++) {
        const character = this.#chars[cursor];
        if (character !== ' ' && character !== '\t') {
          blank = false;
          break;
        }
      }
      if (!blank) {
        const indent = this.#lineIndentAt(this.#pos);
        if (indent <= parentIndent) {
          break;
        }
        if (contentIndent === 0) {
          contentIndent = indent;
        }
        if (indent < contentIndent) {
          this.#failSyntax();
        }
      }
      // Accept the line: strip the content indentation.
      let text = '';
      if (!blank) {
        text = this.#chars.slice(this.#pos + contentIndent, lineEndAt).join('');
      }
      lines.push(text);
      if (lineEndAt >= this.#chars.length) {
        if (lineEndAt > 0 && (this.#chars[lineEndAt - 1] === '\n' || this.#chars[lineEndAt - 1] === '\r')) {
          endedWithBreak = true;
        }
        this.#pos = this.#chars.length;
        break;
      }
      endedWithBreak = true;
      this.#pos = nextLineStart(this.#chars, lineEndAt);
      this.#lineStart = this.#pos;
    }
    const end = this.#pos;
    const trailing = endedWithBreak ? '\n' : '';
    let decoded: string;
    if (folded) {
      decoded = foldBlockLines(lines) + trailing;
    } else {
      decoded = lines.join('\n') + trailing;
    }
    switch (chomping) {
      case '-':
        decoded = decoded.replace(/\n+$/, '');
        break;
      case '+':
        break;
      default:
        decoded = clipChomp(decoded);
        break;
    }
    const style: YamlScalarStyle = folded ? 'Folded' : 'Literal';
    const index = this.#reserveNode();
    const resolved = this.#resolveScalar(decoded, style, props.tag);
    const node: ScratchNode = {
      tag: resolved.tag,
      anchor: null,
      anchorSpan: null,
      span: { start, end },
      content: { kind: 'Scalar', scalar: { ...resolved, style } },
    };
    if (props.anchor !== null) {
      this.#anchors.set(props.anchor, index);
      node.anchor = props.anchor;
      node.anchorSpan = { start: props.anchorStart, end: props.anchorEnd };
    }
    this.#nodes[index] = node;
    this.#countEvent();
    return { node: index, start, end, alias: null };
  }

  #resolveScalar(decoded: string, style: YamlScalarStyle, explicitTag: string): ResolvedScalar {
    if (explicitTag !== '') {
      const resolved = resolveExplicit(decoded, style, explicitTag, this.#profile);
      if (resolved === null) {
        this.#nativeFailure('yaml.scalar.invalid-explicit-tag@1');
      }
      return resolved;
    }
    if (style !== 'Plain') {
      // Quoted and block scalars are always strings (RFC 0007 §5:105-107).
      return { tag: 'tag:yaml.org,2002:str', decoded, canonical: decoded, kind: 'String', style };
    }
    return resolveImplicit(decoded, 'Plain', this.#profile);
  }

  #resolveCollectionTag(tag: string, expected: string): string {
    if (tag === '!') {
      return expected;
    }
    const validCollection =
      expected === TAG_SEQ
        ? tag === TAG_SEQ || tag === TAG_OMAP || tag === TAG_PAIRS
        : tag === TAG_MAP || tag === TAG_SET;
    if ((isStandardCollectionTag(tag) && !validCollection) || isStandardScalarTag(tag)) {
      this.#nativeFailure('yaml.tag.kind-mismatch@1');
    }
    return tag;
  }

  #emptyNullNode(marker: number): number {
    const index = this.#reserveNode();
    this.#countEvent(); // the empty node composes one null node
    this.#nodes[index] = emptyScratchNode(marker);
    return index;
  }

  #reserveNode(): number {
    const observed = this.#nodes.length + 1;
    if (observed > this.#limits.maxNodeCount) {
      throw FatalFormationFailure.resourceLimit('native-nodes', observed, this.#limits.maxNodeCount);
    }
    const index = this.#nodes.length;
    this.#nodes.push(null);
    return index;
  }

  #countDepth(): void {
    const observed = this.#depth + 1;
    if (observed > this.#limits.maxNestingDepth) {
      throw FatalFormationFailure.resourceLimit('nesting-depth', observed, this.#limits.maxNestingDepth);
    }
    this.#depth = observed;
  }

  #countEvent(): void {
    const observed = this.#events + 1;
    if (observed > this.#limits.maxTokenCount) {
      throw FatalFormationFailure.resourceLimit('syntax-events', observed, this.#limits.maxTokenCount);
    }
    this.#events = observed;
  }

  #associationIdentity(): bigint {
    const identity = this.#nextAssociation;
    this.#nextAssociation += 1n;
    return identity;
  }

  #failSyntax(): never {
    throw FatalFormationFailure.syntaxError(this.#pos, null);
  }

  #nativeFailure(
    code: 'yaml.scalar.invalid-explicit-tag@1' | 'yaml.tag.kind-mismatch@1',
  ): never {
    throw FatalFormationFailure.nativeFailure(code);
  }

  #current(): string | undefined {
    return this.#chars[this.#pos];
  }

  #peek(): string | undefined {
    return this.#chars[this.#pos + 1];
  }

  #atEOF(): boolean {
    return this.#pos >= this.#chars.length;
  }

  #atLineStart(): boolean {
    return this.#pos === this.#lineStart;
  }

  #atDocumentMarker(marker: string): boolean {
    if (!this.#atLineStart()) {
      return false;
    }
    if (this.#chars[this.#pos] !== marker[0]) {
      return false;
    }
    for (let index = 0; index < marker.length; index++) {
      if (this.#chars[this.#pos + index] !== marker[index]) {
        return false;
      }
    }
    const next = this.#chars[this.#pos + marker.length];
    return next === undefined || isSeparation(next);
  }

  #followedBySeparation(length: number): boolean {
    const next = this.#chars[this.#pos + length];
    return next === undefined || isSeparation(next);
  }

  #skipSeparationInline(): void {
    while (!this.#atEOF()) {
      const character = this.#current();
      if (character === ' ' || character === '\t') {
        this.#pos += 1;
        continue;
      }
      break;
    }
  }

  #skipBlankLines(): void {
    for (;;) {
      if (this.#atEOF()) {
        return;
      }
      if (this.#current() === '\r' || this.#current() === '\n') {
        this.#pos = nextLineStart(this.#chars, this.#pos);
        this.#lineStart = this.#pos;
        continue;
      }
      if (this.#current() === ' ' || this.#current() === '\t') {
        // A line of only separation (possibly followed by a comment) is
        // blank.
        const lineEnd = this.#lineEndAt(this.#pos);
        let blank = true;
        for (let cursor = this.#pos; cursor < lineEnd; cursor++) {
          const character = this.#chars[cursor];
          if (character === '#') {
            break;
          }
          if (character !== ' ' && character !== '\t') {
            blank = false;
            break;
          }
        }
        if (!blank) {
          return;
        }
        if (lineEnd >= this.#chars.length) {
          this.#pos = this.#chars.length;
          return;
        }
        this.#pos = nextLineStart(this.#chars, lineEnd);
        this.#lineStart = this.#pos;
        continue;
      }
      if (this.#current() === '#') {
        const lineEnd = this.#lineEndAt(this.#pos);
        if (lineEnd >= this.#chars.length) {
          this.#pos = this.#chars.length;
          return;
        }
        this.#pos = nextLineStart(this.#chars, lineEnd);
        this.#lineStart = this.#pos;
        continue;
      }
      return;
    }
  }

  #lineEndAt(offset: number): number {
    let cursor = offset;
    while (cursor < this.#chars.length && this.#chars[cursor] !== '\r' && this.#chars[cursor] !== '\n') {
      cursor += 1;
    }
    return cursor;
  }

  #lineIndentAt(offset: number): number {
    let count = 0;
    while (offset + count < this.#chars.length && this.#chars[offset + count] === ' ') {
      count += 1;
    }
    return count;
  }

  #lineEndsCleanly(): boolean {
    if (this.#atEOF()) {
      return true;
    }
    let cursor = this.#pos;
    while (cursor < this.#chars.length && (this.#chars[cursor] === ' ' || this.#chars[cursor] === '\t')) {
      cursor += 1;
    }
    if (cursor >= this.#chars.length || this.#chars[cursor] === '\r' || this.#chars[cursor] === '\n') {
      return true;
    }
    if (this.#chars[cursor] === '#') {
      return true;
    }
    return false;
  }
}

/** firstToken returns the first space/tab-separated token of one directive rest. */
function firstToken(rest: string): string {
  const trimmed = rest.replace(/^[ \t]+/, '');
  let token = '';
  for (const character of trimmed) {
    if (character === ' ' || character === '\t' || character === '#') {
      break;
    }
    token += character;
  }
  return token;
}

/** tokenFields splits one directive rest into space/tab-separated fields. */
function tokenFields(rest: string): string[] {
  return rest.trim().split(/[ \t]+/).filter((field) => field !== '');
}

function emptyProperties(): Properties {
  return { anchor: null, anchorStart: 0, anchorEnd: 0, tag: '' };
}

function emptyScratchNode(marker: number): ScratchNode {
  return {
    tag: 'tag:yaml.org,2002:null',
    anchor: null,
    anchorSpan: null,
    span: { start: marker, end: marker },
    content: {
      kind: 'Scalar',
      scalar: { decoded: '', canonical: '', kind: 'Null', style: 'Plain' },
    },
  };
}

function isStandardCollectionTag(tag: string): boolean {
  return tag === TAG_SEQ || tag === TAG_MAP || tag === TAG_OMAP || tag === TAG_PAIRS || tag === TAG_SET;
}

function isStandardScalarTag(tag: string): boolean {
  return (
    tag === 'tag:yaml.org,2002:null' ||
    tag === 'tag:yaml.org,2002:bool' ||
    tag === 'tag:yaml.org,2002:int' ||
    tag === 'tag:yaml.org,2002:float' ||
    tag === 'tag:yaml.org,2002:str' ||
    tag === 'tag:yaml.org,2002:timestamp' ||
    tag === 'tag:yaml.org,2002:binary' ||
    tag === 'tag:yaml.org,2002:merge' ||
    tag === 'tag:yaml.org,2002:value' ||
    tag === 'tag:yaml.org,2002:yaml'
  );
}

/** foldBlockLines applies the YAML folded-scalar folding rules to one block-scalar line list. */
function foldBlockLines(lines: readonly string[]): string {
  if (lines.length === 0) {
    return '';
  }
  let output = lines[0];
  for (let index = 1; index < lines.length; index++) {
    if (lines[index - 1] === '' || lines[index] === '') {
      output += '\n';
    } else {
      output += ' ';
    }
    output += lines[index];
  }
  return output;
}

/** clipChomp applies the clip chomping: trailing line breaks are removed and a single break retained when the content has a final break. */
function clipChomp(decoded: string): string {
  if (decoded === '') {
    return '';
  }
  const trimmed = decoded.replace(/\n+$/, '');
  if (trimmed === '') {
    return '';
  }
  if (trimmed.length !== decoded.length) {
    return trimmed + '\n';
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Publish: scalar coordinates → raw-byte spans → YamlDocument
// ---------------------------------------------------------------------------

function publish(
  composed: Composed,
  structuralIndex: LosslessStructuralIndex,
  kinds: readonly YamlSyntaxKind[],
  source: SourceSnapshot,
  authority: DocumentAuthority,
  profile: YamlProfile,
  limits: ParseLimits,
): YamlDocument {
  const raw = new RawByteResolver(source);
  const rawSpan = (span: ScalarSpan): Span => {
    const start = raw.resolve(span.start);
    const end = raw.resolve(span.end);
    return authority.span(start, end);
  };
  const nodes: InternalNode[] = [];
  for (const scratch of composed.nodes) {
    const anchorSpan = scratch.anchorSpan === null ? null : rawSpan(scratch.anchorSpan);
    let content: InternalContent;
    switch (scratch.content.kind) {
      case 'Scalar': {
        const scalar: InternalScalar = {
          decoded: scratch.content.scalar.decoded,
          canonical: scratch.content.scalar.canonical,
          kind: scratch.content.scalar.kind,
          style: scratch.content.scalar.style,
        };
        content = { kind: 'Scalar', scalar };
        break;
      }
      case 'Sequence': {
        const items: InternalSequenceItem[] = scratch.content.items.map((item) => ({
          identity: item.identity,
          node: item.node,
          span: rawSpan(item.span),
          alias: item.alias,
        }));
        content = { kind: 'Sequence', items };
        break;
      }
      case 'Mapping': {
        const entries: InternalMappingEntry[] = scratch.content.entries.map((entry) => ({
          identity: entry.identity,
          key: entry.key,
          value: entry.value,
          span: rawSpan(entry.span),
          keyAlias: entry.keyAlias,
          valueAlias: entry.valueAlias,
        }));
        content = { kind: 'Mapping', entries };
        break;
      }
    }
    nodes.push({
      tag: scratch.tag,
      anchor: scratch.anchor,
      anchorSpan,
      span: rawSpan(scratch.span),
      content,
    });
  }
  const documents: InternalDocument[] = composed.documents.map((document) => ({
    root: document.root,
    span: rawSpan(document.span),
  }));
  const aliases: InternalAlias[] = composed.aliases.map((alias) => ({
    identity: alias.identity,
    name: alias.name,
    target: alias.target,
    span: rawSpan(alias.span),
  }));
  return new YamlDocument(
    authority,
    source,
    profile,
    structuralIndex,
    kinds,
    nodes,
    documents,
    aliases,
    documents.length,
    limits,
  );
}
