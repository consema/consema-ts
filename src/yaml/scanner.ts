/**
 * Lossless YAML tokenizer: exhaustive ordered lexemes with syntax kinds,
 * anchor/alias names, and exact raw-byte spans.
 *
 * authority: crates/consema-yaml/src/syntax.rs
 *  - tokenize :16-71 (lexeme → StructuralPiece Trivia/Token/ErrorRegion,
 *    named anchor/alias occurrences, LosslessStructuralIndex)
 *  - Scanner::scan :111-219 (the dispatch order: block content, plain
 *    continuation, BOM, whitespace, newline, comment, directive, document
 *    markers, quoted scalars, block headers, anchor/alias/tag, indicators,
 *    plain scalars)
 *  - scan_block_content :335-364 (the content lexeme INCLUDES its trailing
 *    line break — pinned by vector case syntax.styles-and-trivia with
 *    piece_count 48, conformance/vectors/yaml-v1.json:31-34)
 *  - scan_plain :319-333, scan_quoted :284-317, indicator_kind :366-379,
 *    starts_indented_structure :257-282, is_block_header :398-403
 *  - limit name "syntax-pieces" (push :221-238)
 *
 * Design (TypeScript-idiomatic): the scanner walks the decoded text as an
 * array of code points with scalar-index positions, exactly like the Rust
 * `chars: Vec<char>`; raw-byte spans are resolved in one forward pass by
 * the shared RawByteResolver (offsets.ts).
 */

import type { DocumentAuthority, NodeRef, Span } from '../document/identity.ts';
import { LosslessStructuralIndex, StructuralPiece } from '../document/structural.ts';
import type { SourceSnapshot } from '../document/source.ts';
import { FatalFormationFailure } from './errors.ts';
import { RawByteResolver } from './offsets.ts';
import { isYamlTriviaKind } from './syntax.ts';
import type { YamlSyntaxKind } from './syntax.ts';

/** One named anchor or alias occurrence (syntax.rs NamedOccurrence :73-77). */
export interface NamedOccurrence {
  readonly name: string;
  readonly span: Span;
}

/** The tokenized lossless facts (syntax.rs Tokenized :79-84). */
export interface Tokenized {
  readonly index: LosslessStructuralIndex;
  readonly kinds: readonly YamlSyntaxKind[];
  readonly anchors: readonly NamedOccurrence[];
  readonly aliases: readonly NamedOccurrence[];
}

interface Lexeme {
  readonly start: number;
  readonly end: number;
  readonly kind: YamlSyntaxKind;
}

/** Tokenizes one YAML source into exhaustive lossless pieces (syntax.rs:16-71). */
export function tokenize(
  source: SourceSnapshot,
  authority: DocumentAuthority,
  maxTokens: number,
): Tokenized {
  const text = source.decodedText();
  if (text === null) {
    throw new Error('internal: YAML source always has decoded text');
  }
  const chars = Array.from(text);
  const lexemes = new Scanner(chars, maxTokens).scan();
  const pieces: StructuralPiece[] = [];
  const kinds: YamlSyntaxKind[] = [];
  const anchors: NamedOccurrence[] = [];
  const aliases: NamedOccurrence[] = [];
  const raw = new RawByteResolver(source);
  for (const lexeme of lexemes) {
    const start = raw.resolve(lexeme.start);
    const end = raw.resolve(lexeme.end);
    const span = authority.span(start, end);
    pieces.push(
      new StructuralPiece(
        span,
        isYamlTriviaKind(lexeme.kind)
          ? 'Trivia'
          : lexeme.kind === 'ErrorRegion'
            ? 'ErrorRegion'
            : 'Token',
      ),
    );
    kinds.push(lexeme.kind);
    if (lexeme.kind === 'Anchor' || lexeme.kind === 'Alias') {
      const name = chars.slice(lexeme.start + 1, lexeme.end).join('');
      if (lexeme.kind === 'Anchor') {
        anchors.push({ name, span });
      } else {
        aliases.push({ name, span });
      }
    }
  }
  const index = LosslessStructuralIndex.create(authority.identity(), source.len(), pieces);
  return {
    index,
    kinds: Object.freeze(kinds),
    anchors: Object.freeze(anchors),
    aliases: Object.freeze(aliases),
  };
}

function isSeparation(value: string): boolean {
  return value === ' ' || value === '\t' || value === '\r' || value === '\n';
}

function isFlowIndicator(value: string): boolean {
  return value === '[' || value === ']' || value === '{' || value === '}' || value === ',';
}

/** The lossless scanner (syntax.rs:86-95). */
class Scanner {
  readonly #chars: readonly string[];
  #offset = 0;
  #lineStart = 0;
  readonly #maxTokens: number;
  readonly #output: Lexeme[] = [];
  #pendingBlockParentIndent: number | null = null;
  #plainLineActive = false;
  #plainParentIndent: number | null = null;

  constructor(chars: readonly string[], maxTokens: number) {
    this.#chars = chars;
    this.#maxTokens = maxTokens;
  }

  scan(): readonly Lexeme[] {
    while (this.#offset < this.#chars.length) {
      if (
        this.#offset === this.#lineStart &&
        this.#pendingBlockParentIndent !== null &&
        this.#scanBlockContent()
      ) {
        continue;
      }
      const start = this.#offset;
      const current = this.#chars[start];
      if (
        current !== ' ' &&
        current !== '\t' &&
        current !== '\r' &&
        current !== '\n' &&
        !this.#plainLineActive &&
        this.#plainParentIndent !== null
      ) {
        if (
          this.#lineIndent() > this.#plainParentIndent &&
          !this.#startsIndentedStructure()
        ) {
          this.#takeUntilBreak();
          this.#push(start, this.#offset, 'PlainScalar');
          this.#plainLineActive = true;
          continue;
        }
        this.#plainParentIndent = null;
      }
      if (current === '\u{feff}') {
        this.#offset += 1;
        this.#push(start, this.#offset, 'Bom');
        this.#endPlainScalar();
        if (start === this.#lineStart) {
          this.#lineStart = this.#offset;
        }
      } else if (current === ' ' || current === '\t') {
        this.#takeWhile((item) => item === ' ' || item === '\t');
        this.#push(start, this.#offset, 'Whitespace');
      } else if (current === '\r' || current === '\n') {
        this.#scanNewline(start);
      } else if (current === '#') {
        this.#takeUntilBreak();
        this.#push(start, this.#offset, 'Comment');
        this.#endPlainScalar();
      } else if (this.#atDirective()) {
        this.#takeUntilBreak();
        this.#push(start, this.#offset, 'Directive');
        this.#endPlainScalar();
      } else if (this.#atDocumentIndicator('-', '-', '-')) {
        this.#offset += 3;
        this.#push(start, this.#offset, 'DocumentStart');
        this.#endPlainScalar();
      } else if (this.#atDocumentIndicator('.', '.', '.')) {
        this.#offset += 3;
        this.#push(start, this.#offset, 'DocumentEnd');
        this.#endPlainScalar();
      } else if (current === "'" || current === '"') {
        this.#scanQuoted(current);
        this.#push(start, this.#offset, current === "'" ? 'SingleQuotedScalar' : 'DoubleQuotedScalar');
        this.#endPlainScalar();
      } else if ((current === '|' || current === '>') && this.#isBlockHeader()) {
        const parentIndent = this.#lineIndent();
        this.#takeUntilBreak();
        this.#push(start, this.#offset, current === '|' ? 'LiteralBlockHeader' : 'FoldedBlockHeader');
        this.#pendingBlockParentIndent = parentIndent;
        this.#endPlainScalar();
      } else if ((current === '&' || current === '*' || current === '!') && !this.#plainLineActive) {
        this.#offset += 1;
        this.#takeWhile((item) => !isSeparation(item) && !isFlowIndicator(item));
        this.#push(start, this.#offset, current === '&' ? 'Anchor' : current === '*' ? 'Alias' : 'Tag');
        this.#endPlainScalar();
      } else {
        const kind = this.#indicatorKind();
        if (kind !== null) {
          this.#offset += 1;
          this.#push(start, this.#offset, kind);
          this.#endPlainScalar();
        } else {
          this.#scanPlain();
          this.#push(start, this.#offset, 'PlainScalar');
          if (!this.#plainLineActive) {
            this.#plainParentIndent = this.#lineIndent();
          }
          this.#plainLineActive = true;
        }
      }
    }
    return this.#output;
  }

  #push(start: number, end: number, kind: YamlSyntaxKind): void {
    const observed = this.#output.length + 1;
    if (observed > this.#maxTokens) {
      throw FatalFormationFailure.resourceLimit('syntax-pieces', observed, this.#maxTokens);
    }
    this.#output.push({ start, end, kind });
  }

  #scanNewline(start: number): void {
    if (this.#chars[this.#offset] === '\r' && this.#chars[this.#offset + 1] === '\n') {
      this.#offset += 2;
    } else {
      this.#offset += 1;
    }
    this.#push(start, this.#offset, 'Newline');
    this.#lineStart = this.#offset;
    this.#plainLineActive = false;
  }

  #endPlainScalar(): void {
    this.#plainLineActive = false;
    this.#plainParentIndent = null;
  }

  #startsIndentedStructure(): boolean {
    if (
      (this.#chars[this.#offset] === '-' || this.#chars[this.#offset] === '?') &&
      (this.#chars[this.#offset + 1] === undefined || isSeparation(this.#chars[this.#offset + 1]))
    ) {
      return true;
    }
    let cursor = this.#offset;
    while (cursor < this.#chars.length) {
      const character = this.#chars[cursor];
      if (character === '\r' || character === '\n' || character === '#') {
        return false;
      }
      if (
        character === ':' &&
        (this.#chars[cursor + 1] === undefined || isSeparation(this.#chars[cursor + 1]))
      ) {
        return true;
      }
      cursor += 1;
    }
    return false;
  }

  #scanQuoted(quote: string): void {
    this.#offset += 1;
    while (this.#offset < this.#chars.length) {
      const current = this.#chars[this.#offset];
      this.#offset += 1;
      if (quote === '"' && current === '\\' && this.#offset < this.#chars.length) {
        if (this.#chars[this.#offset] === '\r') {
          this.#offset += 1;
          if (this.#chars[this.#offset] === '\n') {
            this.#offset += 1;
          }
          this.#lineStart = this.#offset;
        } else if (this.#chars[this.#offset] === '\n') {
          this.#offset += 1;
          this.#lineStart = this.#offset;
        } else {
          this.#offset += 1;
        }
      } else if (current === quote) {
        if (quote === "'" && this.#chars[this.#offset] === "'") {
          this.#offset += 1;
        } else {
          break;
        }
      } else if (current === '\n') {
        this.#lineStart = this.#offset;
      } else if (current === '\r') {
        if (this.#chars[this.#offset] === '\n') {
          this.#offset += 1;
        }
        this.#lineStart = this.#offset;
      }
    }
  }

  #scanPlain(): void {
    this.#offset += 1;
    while (this.#offset < this.#chars.length) {
      const current = this.#chars[this.#offset];
      if (isSeparation(current) || isFlowIndicator(current)) {
        break;
      }
      if (current === ':') {
        const next = this.#chars[this.#offset + 1];
        if (next === undefined || isSeparation(next) || isFlowIndicator(next)) {
          break;
        }
      }
      this.#offset += 1;
    }
  }

  #scanBlockContent(): boolean {
    const parentIndent = this.#pendingBlockParentIndent!;
    const start = this.#offset;
    let cursor = start;
    let acceptedEnd = start;
    while (cursor < this.#chars.length) {
      const lineEnd = nextLineEnd(this.#chars, cursor);
      const contentEnd = lineContentEnd(this.#chars, cursor, lineEnd);
      let indent = 0;
      while (cursor + indent < contentEnd && this.#chars[cursor + indent] === ' ') {
        indent += 1;
      }
      let blank = true;
      for (let index = cursor + indent; index < contentEnd; index++) {
        const item = this.#chars[index];
        if (item !== ' ' && item !== '\t') {
          blank = false;
          break;
        }
      }
      if (!blank && indent <= parentIndent) {
        break;
      }
      acceptedEnd = lineEnd;
      cursor = lineEnd;
    }
    this.#pendingBlockParentIndent = null;
    if (acceptedEnd === start) {
      return false;
    }
    this.#offset = acceptedEnd;
    this.#lineStart = acceptedEnd;
    this.#push(start, acceptedEnd, 'BlockScalarContent');
    return true;
  }

  #indicatorKind(): YamlSyntaxKind | null {
    const current = this.#chars[this.#offset];
    switch (current) {
      case '[':
        return 'FlowSequenceStart';
      case ']':
        return 'FlowSequenceEnd';
      case '{':
        return 'FlowMappingStart';
      case '}':
        return 'FlowMappingEnd';
      case ',':
        return 'FlowEntry';
      case '-':
        return this.#followedBySeparation(1) ? 'SequenceEntry' : null;
      case '?':
        return this.#followedBySeparation(1) ? 'ExplicitKey' : null;
      case ':':
        return this.#followedBySeparation(1) ? 'MappingValue' : null;
      default:
        return null;
    }
  }

  #atDirective(): boolean {
    return this.#offset === this.#lineStart && this.#chars[this.#offset] === '%';
  }

  #atDocumentIndicator(a: string, b: string, c: string): boolean {
    return (
      this.#offset === this.#lineStart &&
      this.#chars[this.#offset] === a &&
      this.#chars[this.#offset + 1] === b &&
      this.#chars[this.#offset + 2] === c &&
      this.#followedBySeparation(3)
    );
  }

  #followedBySeparation(length: number): boolean {
    const next = this.#chars[this.#offset + length];
    return next === undefined || isSeparation(next);
  }

  #isBlockHeader(): boolean {
    for (let index = this.#offset + 1; index < this.#chars.length; index++) {
      const item = this.#chars[index];
      if (item === '\r' || item === '\n') {
        return true;
      }
      if (item !== '+' && item !== '-' && !(item >= '0' && item <= '9') && item !== ' ' && item !== '\t' && item !== '#') {
        return false;
      }
    }
    return true;
  }

  #lineIndent(): number {
    let count = 0;
    while (this.#lineStart + count < this.#offset && this.#chars[this.#lineStart + count] === ' ') {
      count += 1;
    }
    return count;
  }

  #takeUntilBreak(): void {
    this.#takeWhile((item) => item !== '\r' && item !== '\n');
  }

  #takeWhile(predicate: (item: string) => boolean): void {
    while (this.#offset < this.#chars.length && predicate(this.#chars[this.#offset])) {
      this.#offset += 1;
    }
  }
}

function nextLineEnd(chars: readonly string[], start: number): number {
  let cursor = start;
  while (cursor < chars.length && chars[cursor] !== '\r' && chars[cursor] !== '\n') {
    cursor += 1;
  }
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

function lineContentEnd(chars: readonly string[], start: number, lineEnd: number): number {
  let end = lineEnd;
  if (end > start && chars[end - 1] === '\n') {
    end -= 1;
  }
  if (end > start && chars[end - 1] === '\r') {
    end -= 1;
  }
  return end;
}
