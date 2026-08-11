/**
 * The HCL body/expression grammar with deterministic recovery (RFC 0014
 * §3, §4).
 *
 * authority: crates/consema-hcl/src/parser.rs —
 *  - the grammar codes :77-98 (item/attribute/block/label/expression/
 *    directive/newline/separator/duplicate-attribute)
 *  - parse_body :620-733 (per-body counts and duplicate-attribute
 *    exclusion), parse_attribute :700-767 (the NEWLINE terminator
 *    recovery), parse_block :769-864, parse_quoted_label :866-899,
 *    parse_one_line_body :901-970, parse_expression :982-1034 (the
 *    precedence ladder, conditional), the binary levels :1041-1242,
 *    parse_term :1263-1327 (unary chains over the base term),
 *    parse_identifier_term :1351-1553 (keywords as dual-read roots,
 *    GetAttr/Index/AttrSplat/FullSplat postfix steps, D-5 `foo.0`
 *    rejection), parse_call :1555-1620 (trailing comma and `...`),
 *    parse_paren :1622-1650, parse_bracket :1652-1704 (tuple or
 *    for-expression), parse_brace :1706-1808 (object or for-expression),
 *    parse_for_intro :1810-1870 (D-7 single-identifier form),
 *    parse_quoted_template :2030-2098, parse_heredoc :2100-2212,
 *    parse_region_expression / with_region :2214-2267,
 *    parse_expression_region :2269-2289, parse_directive :2291-2360,
 *    scan_recovery :549-588, fail_item :524-537, scan_to_close_brace
 *    :590-616
 *  - the literal decoders: decode_quoted_literal :2387-2482,
 *    decode_heredoc_literal :2484-2510
 *
 * Design (TypeScript-idiomatic): a recursive-descent parser over the
 * lexer's token stream; interpolation and directive interiors are re-lexed
 * through `lexHclRegion` and parsed on a sub-parser whose recovery facts
 * merge into this pass (the Rust `with_region`). Recovery is deterministic:
 * a failed body item emits one error region from its start to the
 * end-of-line boundary (extended by unterminated brackets) and body parsing
 * resumes at the next line; the missing-newline terminator is
 * diagnostic-only and the item survives. `ParsedFormed` carries the native
 * body tree, the merged error regions and diagnostics, and the lossless
 * piece coverage.
 */

import { DocumentAuthority } from '../document/identity.ts';
import type { Span } from '../document/identity.ts';
import { diagnostic as makeDiagnostic, sortDiagnostics } from '../document/diagnostic.ts';
import type { Diagnostic } from '../document/diagnostic.ts';
import { StructuralPiece } from '../document/structural.ts';
import type { StructuralPieceKind } from '../document/structural.ts';
import { HclFormationFailure } from './errors.ts';
import type { HclParseLimits } from './limits.ts';
import { lexHclSource, lexHclRegion } from './tokenizer.ts';
import type { HclLexOutput, HclToken, HclTokenKind, HclSyntaxKind } from './tokenizer.ts';
import {
  codeHclParseItem,
  codeHclParseAttribute,
  codeHclParseBlock,
  codeHclParseLabel,
  codeHclParseExpression,
  codeHclParseDirective,
  codeHclParseNewline,
  codeHclParseSeparator,
  codeHclParseDuplicateAttribute,
} from './errors.ts';
import { canonicalDecimal } from './expression.ts';
import type {
  BinaryOp,
  HclCallArg,
  HclDirective,
  HclExpr,
  HclForIntro,
  HclNumber,
  HclObjectEntry,
  HclObjectKey,
  HclTemplatePart,
  HclTraversalRoot,
  HclTraversalStep,
  HeredocFacts,
  HeredocMode,
  UnaryOp,
} from './expression.ts';

// ---------------------------------------------------------------------------
// Native parse output (RFC 0014 §6)
// ---------------------------------------------------------------------------

/** One parsed attribute occurrence (native.rs:145-193). */
export interface ParsedAttribute {
  readonly name: string;
  readonly nameSpan: Span;
  readonly equalsSpan: Span;
  readonly expression: HclExpr;
  readonly span: Span;
}

/** One parsed block label with its quote/naked fact (native.rs:259-291). */
export interface ParsedBlockLabel {
  readonly text: string;
  readonly span: Span;
  readonly quoted: boolean;
}

/** One parsed block occurrence (native.rs:203-251). */
export interface ParsedBlock {
  readonly type: string;
  readonly labels: readonly ParsedBlockLabel[];
  readonly body: ParsedBody;
  readonly span: Span;
}

/** One body item: an attribute or a block occurrence (native.rs:111-136). */
export type ParsedItem =
  | { readonly kind: 'attribute'; readonly attribute: ParsedAttribute }
  | { readonly kind: 'block'; readonly block: ParsedBlock };

/** An ordered body item container (native.rs:72-103). */
export interface ParsedBody {
  readonly items: readonly ParsedItem[];
  readonly span: Span;
}

/** One recovered error region with its stable code. */
export interface ParsedErrorRegion {
  readonly span: Span;
  readonly code: string;
}

/** One formed HCL document (parser.rs:109-178). */
export interface ParsedFormed {
  readonly body: ParsedBody;
  readonly errorRegions: readonly ParsedErrorRegion[];
  readonly diagnostics: readonly Diagnostic[];
  readonly recovered: boolean;
  readonly pieces: readonly StructuralPiece[] | null;
  readonly syntaxKinds: readonly HclSyntaxKind[];
}

/** Body termination context (parser.rs BodyEnd). */
export type BodyEnd = 'Eof' | 'BraceClose';

/** Expression trivia mode (parser.rs ExprMode). */
export type ExprMode = 'Top' | 'Nested';

type Delim = 'Brace' | 'Bracket' | 'Paren';

function delimOf(kind: HclTokenKind): Delim | null {
  switch (kind) {
    case 'BraceOpen':
      return 'Brace';
    case 'BracketOpen':
      return 'Bracket';
    case 'ParenOpen':
      return 'Paren';
    default:
      return null;
  }
}

function delimMatches(delim: Delim, kind: HclTokenKind): boolean {
  switch (delim) {
    case 'Brace':
      return kind === 'BraceClose';
    case 'Bracket':
      return kind === 'BracketClose';
    case 'Paren':
      return kind === 'ParenClose';
  }
}

// ---------------------------------------------------------------------------
// Decoded view: byte spans to exact decoded text (RFC 0014 §2, §6)
// ---------------------------------------------------------------------------

/**
 * Maps raw-byte spans to exact decoded text. Checkpoints every 256 decoded
 * scalars keep lookups O(stride) after an O(log n) search; the decoded text
 * is validated UTF-8 exactly once by the source snapshot.
 */
class DecodedView {
  readonly #bytes: Uint8Array;
  readonly #text: string;
  readonly #checkpoints: { byte: number; index: number }[] = [{ byte: 0, index: 0 }];
  #built = false;

  constructor(bytes: Uint8Array, text: string) {
    this.#bytes = bytes;
    this.#text = text;
  }

  build(): void {
    let byte = 0;
    let index = 0;
    for (const character of this.#text) {
      if (index % 256 === 0) {
        this.#checkpoints.push({ byte, index });
      }
      byte += utf8Width(character);
      index += 1;
    }
    this.#built = true;
  }

  /** Exact decoded text of one half-open raw-byte range. */
  slice(startByte: number, endByte: number): string {
    if (!this.#built) {
      this.build();
    }
    const start = this.#toIndex(startByte);
    const end = this.#toIndex(endByte);
    return this.#text.slice(start, end);
  }

  #toIndex(byte: number): number {
    let low = 0;
    let high = this.#checkpoints.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.#checkpoints[mid].byte <= byte) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    const checkpoint = this.#checkpoints[Math.max(0, low - 1)];
    let position = checkpoint.byte;
    let index = checkpoint.index;
    while (position < byte) {
      position += utf8Width(this.#text[index]);
      index += 1;
    }
    return index;
  }
}

/** UTF-8 byte width of one decoded character. */
function utf8Width(character: string): number {
  const codePoint = character.codePointAt(0)!;
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

// ---------------------------------------------------------------------------
// Literal decoders (parser.rs:2387-2510)
// ---------------------------------------------------------------------------

/** Decodes one quoted-template literal run (parser.rs:2387-2482). */
function decodeQuotedLiteral(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const byte = text.charCodeAt(index);
    if (byte === 0x5c) {
      const next = text[index + 1];
      if (next === undefined) {
        out += '\\';
        index += 1;
        continue;
      }
      switch (next) {
        case 'n':
          out += '\n';
          index += 2;
          break;
        case 'r':
          out += '\r';
          index += 2;
          break;
        case 't':
          out += '\t';
          index += 2;
          break;
        case '"':
          out += '"';
          index += 2;
          break;
        case '\\':
          out += '\\';
          index += 2;
          break;
        case 'u': {
          const hex = text.slice(index + 2, index + 6);
          const value = Number.parseInt(hex, 16);
          if (hex.length === 4 && Number.isInteger(value) && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)) {
            out += String.fromCodePoint(value);
            index += 6;
            break;
          }
          out += '\\';
          index += 1;
          break;
        }
        case 'U': {
          const hex = text.slice(index + 2, index + 10);
          const value = Number.parseInt(hex, 16);
          if (hex.length === 8 && Number.isInteger(value) && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)) {
            out += String.fromCodePoint(value);
            index += 10;
            break;
          }
          out += '\\';
          index += 1;
          break;
        }
        default:
          out += '\\';
          index += 1;
          break;
      }
    } else if (byte === 0x24) {
      if (text[index + 1] === '$' && text[index + 2] === '{') {
        out += '${';
        index += 3;
      } else {
        out += '$';
        index += 1;
      }
    } else if (byte === 0x25) {
      if (text[index + 1] === '%' && text[index + 2] === '{') {
        out += '%{';
        index += 3;
      } else {
        out += '%';
        index += 1;
      }
    } else {
      const character = text.codePointAt(index)!;
      out += String.fromCodePoint(character);
      index += character > 0xffff ? 2 : 1;
    }
  }
  return out;
}

/** Decodes one heredoc literal run (parser.rs:2484-2510). */
function decodeHeredocLiteral(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const byte = text.charCodeAt(index);
    if (byte === 0x24) {
      if (text[index + 1] === '$' && text[index + 2] === '{') {
        out += '${';
        index += 3;
      } else {
        out += '$';
        index += 1;
      }
    } else if (byte === 0x25) {
      if (text[index + 1] === '%' && text[index + 2] === '{') {
        out += '%{';
        index += 3;
      } else {
        out += '%';
        index += 1;
      }
    } else {
      const character = text.codePointAt(index)!;
      out += String.fromCodePoint(character);
      index += character > 0xffff ? 2 : 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

type AttributeOutcome =
  | { readonly kind: 'Formed'; readonly attribute: ParsedAttribute }
  | { readonly kind: 'Failed'; readonly code: string };

/** One recursive-descent pass over one token stream (parser.rs:317-354). */
class HclParser {
  readonly #bytes: Uint8Array;
  readonly #view: DecodedView;
  readonly #authority: DocumentAuthority;
  readonly #limits: HclParseLimits;
  readonly #tokens: readonly HclToken[];
  #pos = 0;
  readonly #diagnostics: Diagnostic[] = [];
  readonly #errorRegions: ParsedErrorRegion[] = [];
  #recovered = false;
  #truncated = false;
  /** Brackets opened by the expression parser but never closed (parser.rs:329-331). */
  #brackets: Delim[] = [];

  constructor(bytes: Uint8Array, view: DecodedView, authority: DocumentAuthority, limits: HclParseLimits, tokens: readonly HclToken[]) {
    this.#bytes = bytes;
    this.#view = view;
    this.#authority = authority;
    this.#limits = limits;
    this.#tokens = tokens;
  }

  peek(): HclToken {
    return this.#tokens[this.#pos];
  }

  peekKind(): HclTokenKind {
    return this.peek().kind;
  }

  advance(): HclToken {
    const token = this.peek();
    if (token.kind !== 'Eof') {
      this.#pos += 1;
    }
    return token;
  }

  at(kind: HclTokenKind): boolean {
    return this.peekKind() === kind;
  }

  eat(kind: HclTokenKind): HclToken | null {
    if (this.at(kind)) {
      return this.advance();
    }
    return null;
  }

  text(token: HclToken): string {
    return this.#view.slice(token.startByte, token.endByte);
  }

  span(start: number, end: number): Span {
    if (start > end || end > this.#bytes.length) {
      throw new HclFormationFailure('Syntax', { parserReason: 'coordinates' });
    }
    return this.#authority.span(start, end);
  }

  /** Skips same-line trivia: whitespace and inline comments only (parser.rs:421-428). */
  skipTrivia(): void {
    while (this.at('Whitespace') || this.at('InlineComment')) {
      this.#pos += 1;
    }
  }

  /** Skips all trivia, including newlines and line comments (parser.rs:430-441). */
  skipStructural(): void {
    while (this.at('Whitespace') || this.at('InlineComment') || this.at('LineBreak') || this.at('LineComment')) {
      this.#pos += 1;
    }
  }

  skipExpressionTrivia(mode: ExprMode): void {
    if (mode === 'Top') {
      this.skipTrivia();
    } else {
      this.skipStructural();
    }
  }

  /** Records one recovery diagnostic and marks the parse Recovered (parser.rs:469-479). */
  diagnose(code: string, span: Span): void {
    this.#recovered = true;
    this.pushDiagnostic(makeDiagnostic(code, 'Syntax', 'Error', span.diagnosticLocation(), 0n));
  }

  pushDiagnostic(diagnostic: Diagnostic): void {
    if (this.#diagnostics.length < this.#limits.common.maxDiagnostics) {
      this.#diagnostics.push(diagnostic);
    } else if (!this.#truncated) {
      this.#truncated = true;
      this.#diagnostics.push(makeDiagnostic('core.diagnostic.truncated@1', 'Resource', 'Warning', null, 0n));
    }
  }

  /** Emits one error region with its diagnostic (parser.rs:483-504). */
  emitErrorRegion(start: number, end: number, code: string): void {
    this.#recovered = true;
    const span = this.span(start, end);
    this.pushDiagnostic(makeDiagnostic(code, 'Syntax', 'Error', span.diagnosticLocation(), 0n));
    if (end > start) {
      this.#errorRegions.push({ span, code });
      this.checkErrorRegionLimits();
    }
  }

  checkErrorRegionLimits(): void {
    if (this.#errorRegions.length > this.#limits.maxRecoveryRegions) {
      throw new HclFormationFailure('ResourceLimit', {
        limitName: 'recovery-regions',
        observed: this.#errorRegions.length,
        limit: this.#limits.maxRecoveryRegions,
      });
    }
    if (this.#errorRegions.length > this.#limits.maxErrorRegions) {
      throw new HclFormationFailure('ResourceLimit', {
        limitName: 'error-regions',
        observed: this.#errorRegions.length,
        limit: this.#limits.maxErrorRegions,
      });
    }
  }

  fatalLimit(limitName: string, observed: number, limit: number): HclFormationFailure {
    return new HclFormationFailure('ResourceLimit', { limitName, observed, limit });
  }

  /**
   * Scans forward to the recovery boundary and advances `pos` to the
   * boundary token (parser.rs:549-588). A newline or line comment stops the
   * scan when no bracket is open; an open bracket pushes; a close that
   * matches the innermost open bracket pops it and ends the region after
   * the close when the stack empties; a close with an empty stack ends the
   * region before it; a mismatched close discards the innermost open
   * bracket and the scan continues.
   */
  scanRecovery(stack: Delim[]): number {
    for (;;) {
      const token = this.peek();
      switch (token.kind) {
        case 'Eof':
          return this.#bytes.length;
        case 'LineBreak':
        case 'LineComment': {
          if (stack.length === 0) {
            return token.startByte;
          }
          this.#pos += 1;
          break;
        }
        case 'BraceOpen':
        case 'BracketOpen':
        case 'ParenOpen': {
          const delim = delimOf(token.kind);
          if (delim !== null) {
            stack.push(delim);
          }
          this.#pos += 1;
          break;
        }
        case 'BraceClose':
        case 'BracketClose':
        case 'ParenClose': {
          if (stack.length === 0) {
            return token.startByte;
          }
          if (delimMatches(stack[stack.length - 1], token.kind)) {
            stack.pop();
            if (stack.length === 0) {
              this.#pos += 1;
              return token.endByte;
            }
          } else {
            stack.pop();
          }
          this.#pos += 1;
          break;
        }
        default:
          this.#pos += 1;
          break;
      }
    }
  }

  /** Fails one body item: error region from the item start to the deterministic boundary (parser.rs:524-537). */
  failItem(start: number, code: string): void {
    const brackets = [...this.#brackets];
    this.#brackets = [];
    const boundary = this.scanRecovery(brackets);
    this.emitErrorRegion(start, boundary, code);
  }

  /** Consumes tokens through the next `}` at brace depth zero (parser.rs:590-616). */
  scanToCloseBrace(): number | null {
    let braces = 0;
    for (;;) {
      const token = this.peek();
      switch (token.kind) {
        case 'Eof':
          return null;
        case 'BraceOpen':
          braces += 1;
          this.#pos += 1;
          break;
        case 'BraceClose':
          if (braces === 0) {
            this.#pos += 1;
            return token.endByte;
          }
          braces -= 1;
          this.#pos += 1;
          break;
        default:
          this.#pos += 1;
          break;
      }
    }
  }

  // -- body grammar (parser.rs:620-970) -------------------------------------

  parseBody(depth: number, end: BodyEnd): ParsedBody {
    if (depth > this.#limits.maxBodyDepth) {
      throw this.fatalLimit('body-depth', depth, this.#limits.maxBodyDepth);
    }
    const items: ParsedItem[] = [];
    const names = new Set<string>();
    let attributeCount = 0;
    let blockCount = 0;
    let itemCount = 0;
    let bodyStart = this.peek().startByte;
    for (;;) {
      this.skipStructural();
      const token = this.peek();
      switch (token.kind) {
        case 'Eof':
          return { items, span: this.span(bodyStart, this.#bytes.length) };
        case 'BraceClose': {
          if (end === 'BraceClose') {
            return { items, span: this.span(bodyStart, token.startByte) };
          }
          // An orphan closing delimiter at this body level.
          this.diagnose(codeHclParseItem, this.span(token.startByte, token.endByte));
          this.#pos += 1;
          break;
        }
        case 'Identifier': {
          const nameToken = this.advance();
          const name = this.text(nameToken);
          this.skipTrivia();
          switch (this.peekKind()) {
            case 'Equals': {
              itemCount += 1;
              attributeCount += 1;
              if (itemCount > this.#limits.maxBodyItemCount) {
                throw this.fatalLimit('body-item-count', itemCount, this.#limits.maxBodyItemCount);
              }
              if (attributeCount > this.#limits.maxAttributeCount) {
                throw this.fatalLimit('attribute-count', attributeCount, this.#limits.maxAttributeCount);
              }
              const outcome = this.parseAttribute(nameToken, name, false);
              if (outcome.kind === 'Formed') {
                if (!names.has(name)) {
                  names.add(name);
                  items.push({ kind: 'attribute', attribute: outcome.attribute });
                } else {
                  // The duplicate stays a proven syntax piece but never a
                  // native attribute (RFC 0014 §3).
                  this.diagnose(codeHclParseDuplicateAttribute, this.span(nameToken.startByte, nameToken.endByte));
                }
              } else {
                this.failItem(nameToken.startByte, outcome.code);
              }
              break;
            }
            case 'StringOpen':
            case 'BraceOpen':
            case 'Identifier': {
              itemCount += 1;
              blockCount += 1;
              if (itemCount > this.#limits.maxBodyItemCount) {
                throw this.fatalLimit('body-item-count', itemCount, this.#limits.maxBodyItemCount);
              }
              if (blockCount > this.#limits.maxBlockCount) {
                throw this.fatalLimit('block-count', blockCount, this.#limits.maxBlockCount);
              }
              const block = this.parseBlock(nameToken, depth);
              if (block !== null) {
                items.push({ kind: 'block', block });
              }
              break;
            }
            default:
              this.failItem(nameToken.startByte, codeHclParseItem);
              break;
          }
          break;
        }
        case 'BraceClose':
        case 'BracketClose':
        case 'ParenClose': {
          // An orphan closing delimiter: it closes no open construct.
          this.diagnose(codeHclParseItem, this.span(token.startByte, token.endByte));
          this.#pos += 1;
          break;
        }
        default:
          this.failItem(token.startByte, codeHclParseItem);
          break;
      }
    }
  }

  /** Parses one attribute occurrence (parser.rs:700-767). */
  parseAttribute(nameToken: HclToken, name: string, singleLine: boolean): AttributeOutcome {
    this.skipTrivia();
    const equals = this.eat('Equals');
    if (equals === null) {
      return { kind: 'Failed', code: codeHclParseAttribute };
    }
    this.skipTrivia();
    const expression = this.parseExpression('Top', 0);
    if (expression === null) {
      return { kind: 'Failed', code: codeHclParseExpression };
    }
    if (!singleLine) {
      this.skipTrivia();
      const next = this.peekKind();
      if (next !== 'LineBreak' && next !== 'LineComment' && next !== 'Eof') {
        // The attribute is proven; only its terminator is missing
        // (RFC 0014 §2, §12 D-9).
        this.diagnose(codeHclParseNewline, this.span(this.peek().startByte, this.peek().endByte));
        this.scanRecovery([]);
      }
    }
    return {
      kind: 'Formed',
      attribute: {
        name,
        nameSpan: this.span(nameToken.startByte, nameToken.endByte),
        equalsSpan: this.span(equals.startByte, equals.endByte),
        expression,
        span: this.span(nameToken.startByte, expression.span.endByte()),
      },
    };
  }

  /** Parses one block occurrence (parser.rs:769-864). */
  parseBlock(typeToken: HclToken, depth: number): ParsedBlock | null {
    const blockStart = typeToken.startByte;
    const blockType = this.text(typeToken);
    const labels: ParsedBlockLabel[] = [];
    for (;;) {
      this.skipTrivia();
      switch (this.peekKind()) {
        case 'Identifier': {
          const token = this.advance();
          labels.push({ text: this.text(token), span: this.span(token.startByte, token.endByte), quoted: false });
          if (labels.length > this.#limits.maxLabelCount) {
            throw this.fatalLimit('label-count', labels.length, this.#limits.maxLabelCount);
          }
          break;
        }
        case 'StringOpen': {
          const label = this.parseQuotedLabel();
          if (label === null) {
            this.failItem(blockStart, codeHclParseLabel);
            return null;
          }
          labels.push(label);
          if (labels.length > this.#limits.maxLabelCount) {
            throw this.fatalLimit('label-count', labels.length, this.#limits.maxLabelCount);
          }
          break;
        }
        case 'BraceOpen':
          break;
        default:
          this.failItem(blockStart, codeHclParseBlock);
          return null;
      }
      if (this.at('BraceOpen')) {
        break;
      }
    }
    this.advance(); // open brace
    this.skipTrivia();
    let body: ParsedBody;
    let closeEnd: number;
    switch (this.peekKind()) {
      case 'LineBreak':
      case 'LineComment': {
        this.skipStructural();
        body = this.parseBody(depth + 1, 'BraceClose');
        if (this.at('BraceClose')) {
          const close = this.advance();
          closeEnd = close.endByte;
        } else {
          this.failItem(blockStart, codeHclParseBlock);
          return null;
        }
        break;
      }
      case 'BraceClose': {
        const close = this.advance();
        body = { items: [], span: this.span(close.startByte, close.startByte) };
        closeEnd = close.endByte;
        break;
      }
      case 'Eof':
        this.failItem(blockStart, codeHclParseBlock);
        return null;
      default: {
        const formed = this.parseOneLineBody(blockStart);
        if (formed === null) {
          return null;
        }
        body = formed.body;
        closeEnd = formed.closeEnd;
        break;
      }
    }
    this.skipTrivia();
    const next = this.peekKind();
    if (next !== 'LineBreak' && next !== 'LineComment' && next !== 'Eof') {
      this.diagnose(codeHclParseNewline, this.span(this.peek().startByte, this.peek().endByte));
      this.scanRecovery([]);
    }
    return {
      type: blockType,
      labels,
      body,
      span: this.span(blockStart, closeEnd),
    };
  }

  /** Parses one quoted block label (parser.rs:866-899). */
  parseQuotedLabel(): ParsedBlockLabel | null {
    const open = this.advance();
    let text = '';
    for (;;) {
      const token = this.peek();
      switch (token.kind) {
        case 'StringContent': {
          this.#pos += 1;
          text += decodeQuotedLiteral(this.text(token));
          break;
        }
        case 'StringClose': {
          const close = this.advance();
          return { text, span: this.span(open.startByte, close.endByte), quoted: true };
        }
        case 'ErrorRegion':
        case 'Eof':
          // Unterminated at the lexer; the lexer already published its
          // diagnostic.
          return null;
        default:
          this.diagnose(codeHclParseLabel, this.span(token.startByte, token.endByte));
          return null;
      }
    }
  }

  /** Parses a one-line block body (parser.rs:901-970). */
  parseOneLineBody(blockStart: number): { body: ParsedBody; closeEnd: number } | null {
    switch (this.peekKind()) {
      case 'BraceClose': {
        const close = this.advance();
        return { body: { items: [], span: this.span(close.startByte, close.startByte) }, closeEnd: close.endByte };
      }
      case 'Eof':
        this.failItem(blockStart, codeHclParseBlock);
        return null;
      case 'Identifier': {
        const nameToken = this.advance();
        const name = this.text(nameToken);
        const outcome = this.parseAttribute(nameToken, name, true);
        if (outcome.kind === 'Formed') {
          this.skipTrivia();
          switch (this.peekKind()) {
            case 'BraceClose': {
              const close = this.advance();
              return {
                body: { items: [{ kind: 'attribute', attribute: outcome.attribute }], span: this.span(nameToken.startByte, outcome.attribute.span.endByte()) },
                closeEnd: close.endByte,
              };
            }
            case 'Eof':
              this.failItem(blockStart, codeHclParseBlock);
              return null;
            default:
              this.diagnose(codeHclParseBlock, this.span(this.peek().startByte, this.peek().endByte));
              {
                const closeEnd = this.scanToCloseBrace();
                if (closeEnd === null) {
                  this.failItem(blockStart, codeHclParseBlock);
                  return null;
                }
                return {
                  body: { items: [{ kind: 'attribute', attribute: outcome.attribute }], span: this.span(nameToken.startByte, outcome.attribute.span.endByte()) },
                  closeEnd,
                };
              }
          }
        }
        this.failItem(nameToken.startByte, outcome.code);
        const closeEnd = this.scanToCloseBrace();
        if (closeEnd === null) {
          this.failItem(blockStart, codeHclParseBlock);
          return null;
        }
        return { body: { items: [], span: this.span(nameToken.startByte, nameToken.startByte) }, closeEnd };
      }
      default: {
        this.diagnose(codeHclParseBlock, this.span(this.peek().startByte, this.peek().endByte));
        const closeEnd = this.scanToCloseBrace();
        if (closeEnd === null) {
          this.failItem(blockStart, codeHclParseBlock);
          return null;
        }
        return { body: { items: [], span: this.span(blockStart, blockStart) }, closeEnd };
      }
    }
  }

  // -- expression grammar (parser.rs:982-1620) ------------------------------

  parseExpression(mode: ExprMode, depth: number): HclExpr | null {
    if (depth >= this.#limits.maxExpressionDepth) {
      throw this.fatalLimit('expression-depth', depth + 1, this.#limits.maxExpressionDepth);
    }
    return this.parseConditional(mode, depth);
  }

  parseConditional(mode: ExprMode, depth: number): HclExpr | null {
    const condition = this.parseOr(mode, depth);
    if (condition === null) {
      return null;
    }
    this.skipTrivia();
    if (!this.at('QuestionMark')) {
      return condition;
    }
    this.advance();
    const then = this.parseConditional(mode, depth + 1);
    if (then === null) {
      return null;
    }
    this.skipTrivia();
    if (this.eat('Colon') === null) {
      this.diagnose(codeHclParseExpression, this.span(this.peek().startByte, this.peek().endByte));
      return null;
    }
    const else_ = this.parseConditional(mode, depth + 1);
    if (else_ === null) {
      return null;
    }
    return {
      kind: 'Conditional',
      condition,
      then,
      else_,
      span: this.span(condition.span.startByte(), else_.span.endByte()),
    };
  }

  /** One left-associative binary level; `||` (parser.rs:1041-1071). */
  parseOr(mode: ExprMode, depth: number): HclExpr | null {
    let lhs = this.parseAnd(mode, depth);
    if (lhs === null) {
      return null;
    }
    let chain = 0;
    for (;;) {
      this.skipTrivia();
      if (!this.at('OpOr')) {
        break;
      }
      chain += 1;
      if (chain > this.#limits.maxExpressionDepth) {
        throw this.fatalLimit('expression-depth', chain, this.#limits.maxExpressionDepth);
      }
      this.advance();
      this.skipExpressionTrivia(mode);
      const rhs = this.parseAnd(mode, depth);
      if (rhs === null) {
        return null;
      }
      lhs = this.binary('Or', lhs, rhs);
    }
    return lhs;
  }

  /** `&&` (parser.rs:1073-1103). */
  parseAnd(mode: ExprMode, depth: number): HclExpr | null {
    let lhs = this.parseEquality(mode, depth);
    if (lhs === null) {
      return null;
    }
    let chain = 0;
    for (;;) {
      this.skipTrivia();
      if (!this.at('OpAnd')) {
        break;
      }
      chain += 1;
      if (chain > this.#limits.maxExpressionDepth) {
        throw this.fatalLimit('expression-depth', chain, this.#limits.maxExpressionDepth);
      }
      this.advance();
      this.skipExpressionTrivia(mode);
      const rhs = this.parseEquality(mode, depth);
      if (rhs === null) {
        return null;
      }
      lhs = this.binary('And', lhs, rhs);
    }
    return lhs;
  }

  /** `==`/`!=` (parser.rs:1105-1137). */
  parseEquality(mode: ExprMode, depth: number): HclExpr | null {
    let lhs = this.parseRelational(mode, depth);
    if (lhs === null) {
      return null;
    }
    let chain = 0;
    for (;;) {
      this.skipTrivia();
      let op: BinaryOp;
      if (this.at('OpEqual')) {
        op = 'Equal';
      } else if (this.at('OpNotEqual')) {
        op = 'NotEqual';
      } else {
        break;
      }
      chain += 1;
      if (chain > this.#limits.maxExpressionDepth) {
        throw this.fatalLimit('expression-depth', chain, this.#limits.maxExpressionDepth);
      }
      this.advance();
      this.skipExpressionTrivia(mode);
      const rhs = this.parseRelational(mode, depth);
      if (rhs === null) {
        return null;
      }
      lhs = this.binary(op, lhs, rhs);
    }
    return lhs;
  }

  /** `<`/`>`/`<=`/`>=` (parser.rs:1139-1173). */
  parseRelational(mode: ExprMode, depth: number): HclExpr | null {
    let lhs = this.parseAdditive(mode, depth);
    if (lhs === null) {
      return null;
    }
    let chain = 0;
    for (;;) {
      this.skipTrivia();
      let op: BinaryOp;
      if (this.at('OpLess')) {
        op = 'Less';
      } else if (this.at('OpGreater')) {
        op = 'Greater';
      } else if (this.at('OpLessEqual')) {
        op = 'LessEqual';
      } else if (this.at('OpGreaterEqual')) {
        op = 'GreaterEqual';
      } else {
        break;
      }
      chain += 1;
      if (chain > this.#limits.maxExpressionDepth) {
        throw this.fatalLimit('expression-depth', chain, this.#limits.maxExpressionDepth);
      }
      this.advance();
      this.skipExpressionTrivia(mode);
      const rhs = this.parseAdditive(mode, depth);
      if (rhs === null) {
        return null;
      }
      lhs = this.binary(op, lhs, rhs);
    }
    return lhs;
  }

  /** `+`/`-` (parser.rs:1175-1207). */
  parseAdditive(mode: ExprMode, depth: number): HclExpr | null {
    let lhs = this.parseMultiplicative(mode, depth);
    if (lhs === null) {
      return null;
    }
    let chain = 0;
    for (;;) {
      this.skipTrivia();
      let op: BinaryOp;
      if (this.at('OpAdd')) {
        op = 'Add';
      } else if (this.at('OpSubtract')) {
        op = 'Subtract';
      } else {
        break;
      }
      chain += 1;
      if (chain > this.#limits.maxExpressionDepth) {
        throw this.fatalLimit('expression-depth', chain, this.#limits.maxExpressionDepth);
      }
      this.advance();
      this.skipExpressionTrivia(mode);
      const rhs = this.parseMultiplicative(mode, depth);
      if (rhs === null) {
        return null;
      }
      lhs = this.binary(op, lhs, rhs);
    }
    return lhs;
  }

  /** `*`/`/`/`%` (parser.rs:1209-1242). */
  parseMultiplicative(mode: ExprMode, depth: number): HclExpr | null {
    let lhs = this.parseTerm(mode, depth);
    if (lhs === null) {
      return null;
    }
    let chain = 0;
    for (;;) {
      this.skipTrivia();
      let op: BinaryOp;
      if (this.at('Star')) {
        op = 'Multiply';
      } else if (this.at('OpDivide')) {
        op = 'Divide';
      } else if (this.at('OpModulo')) {
        op = 'Modulo';
      } else {
        break;
      }
      chain += 1;
      if (chain > this.#limits.maxExpressionDepth) {
        throw this.fatalLimit('expression-depth', chain, this.#limits.maxExpressionDepth);
      }
      this.advance();
      this.skipExpressionTrivia(mode);
      const rhs = this.parseTerm(mode, depth);
      if (rhs === null) {
        return null;
      }
      lhs = this.binary(op, lhs, rhs);
    }
    return lhs;
  }

  binary(op: BinaryOp, lhs: HclExpr, rhs: HclExpr): HclExpr {
    return {
      kind: 'Binary',
      op,
      lhs,
      rhs,
      span: this.span(lhs.span.startByte(), rhs.span.endByte()),
    };
  }

  /** The term layer: unary chains over the base term (parser.rs:1263-1327). */
  parseTerm(mode: ExprMode, depth: number): HclExpr | null {
    if (depth >= this.#limits.maxExpressionDepth) {
      throw this.fatalLimit('expression-depth', depth + 1, this.#limits.maxExpressionDepth);
    }
    this.skipExpressionTrivia(mode);
    const token = this.peek();
    switch (token.kind) {
      case 'OpSubtract':
      case 'OpNot': {
        const opToken = this.advance();
        const op: UnaryOp = opToken.kind === 'OpSubtract' ? 'Minus' : 'Not';
        const operand = this.parseTerm(mode, depth + 1);
        if (operand === null) {
          return null;
        }
        return {
          kind: 'Unary',
          op,
          operand,
          span: this.span(opToken.startByte, operand.span.endByte()),
        };
      }
      case 'Number': {
        const token = this.advance();
        const number = this.number(token);
        return { kind: 'Number', number, span: this.span(token.startByte, token.endByte) };
      }
      case 'StringOpen':
        return this.parseQuotedTemplate(depth);
      case 'HeredocOpen':
        return this.parseHeredoc(depth);
      case 'ParenOpen':
        return this.parseParen(depth);
      case 'BracketOpen':
        return this.parseBracket(depth);
      case 'BraceOpen':
        return this.parseBrace(depth);
      case 'Identifier':
        return this.parseIdentifierTerm(mode, depth);
      default:
        this.diagnose(codeHclParseExpression, this.span(token.startByte, token.endByte));
        return null;
    }
  }

  number(token: HclToken): HclNumber {
    const spelling = this.text(token);
    const canonical = canonicalDecimal(spelling, this.#limits.maxNumberDigits);
    if (canonical === null) {
      throw this.fatalLimit('number-digits', Number.MAX_SAFE_INTEGER, this.#limits.maxNumberDigits);
    }
    const digits = canonical.replace(/\D/g, '').length;
    if (digits > this.#limits.maxNumberDigits) {
      throw this.fatalLimit('number-digits', digits, this.#limits.maxNumberDigits);
    }
    return { span: this.span(token.startByte, token.endByte), spelling, canonical };
  }

  parseIdentifierTerm(mode: ExprMode, depth: number): HclExpr | null {
    const nameToken = this.peek();
    const name = this.text(nameToken);
    this.advance();
    this.skipExpressionTrivia(mode);
    if (this.at('ParenOpen')) {
      return this.parseCall(nameToken, depth);
    }
    const base: HclExpr =
      name === 'true'
        ? { kind: 'Boolean', value: true, span: this.span(nameToken.startByte, nameToken.endByte) }
        : name === 'false'
          ? { kind: 'Boolean', value: false, span: this.span(nameToken.startByte, nameToken.endByte) }
          : name === 'null'
            ? { kind: 'Null', span: this.span(nameToken.startByte, nameToken.endByte) }
            : { kind: 'VariableRef', name, span: this.span(nameToken.startByte, nameToken.endByte) };
    const steps: HclTraversalStep[] = [];
    let end = nameToken.endByte;
    for (;;) {
      this.skipExpressionTrivia(mode);
      const next = this.peekKind();
      if (next === 'Dot') {
        const dot = this.advance();
        this.skipExpressionTrivia(mode);
        if (this.at('Identifier')) {
          const ident = this.advance();
          steps.push({ kind: 'GetAttr', name: this.text(ident) });
          end = ident.endByte;
        } else if (this.at('Star')) {
          // Attribute splat `. * GetAttr*`.
          const star = this.advance();
          end = star.endByte;
          const nested: HclTraversalStep[] = [];
          for (;;) {
            this.skipExpressionTrivia(mode);
            if (!this.at('Dot')) {
              break;
            }
            const ndot = this.advance();
            this.skipExpressionTrivia(mode);
            if (!this.at('Identifier')) {
              this.diagnose(codeHclParseExpression, this.span(this.peek().startByte, this.peek().endByte));
              return null;
            }
            const nident = this.advance();
            nested.push({ kind: 'GetAttr', name: this.text(nident) });
            end = nident.endByte;
          }
          steps.push({ kind: 'AttrSplat', steps: nested });
        } else {
          // D-5: `foo.0` is rejected — GetAttr admits identifiers only.
          this.diagnose(codeHclParseExpression, this.span(this.peek().startByte, this.peek().endByte));
          return null;
        }
      } else if (next === 'BracketOpen') {
        this.#brackets.push('Bracket');
        const open = this.advance();
        this.skipStructural();
        if (this.at('Star')) {
          // Full splat `[ * ] (GetAttr | Index)*`.
          this.advance();
          this.skipStructural();
          if (!this.at('BracketClose')) {
            this.diagnose(codeHclParseExpression, this.span(this.peek().startByte, this.peek().endByte));
            return null;
          }
          const close = this.advance();
          end = close.endByte;
          const nested: HclTraversalStep[] = [];
          for (;;) {
            this.skipExpressionTrivia(mode);
            if (this.at('Dot')) {
              const dot = this.advance();
              this.skipExpressionTrivia(mode);
              if (!this.at('Identifier')) {
                this.diagnose(codeHclParseExpression, this.span(this.peek().startByte, this.peek().endByte));
                return null;
              }
              const ident = this.advance();
              nested.push({ kind: 'GetAttr', name: this.text(ident) });
              end = ident.endByte;
            } else if (this.at('BracketOpen')) {
              const indexOpen = this.advance();
              this.#brackets.push('Bracket');
              this.skipStructural();
              const key = this.parseExpression('Nested', depth + 1);
              if (key === null) {
                return null;
              }
              this.skipStructural();
              if (!this.at('BracketClose')) {
                this.diagnose(codeHclParseExpression, this.span(this.peek().startByte, this.peek().endByte));
                return null;
              }
              const indexClose = this.advance();
              this.#brackets.pop();
              nested.push({ kind: 'Index', key });
              end = indexClose.endByte;
            } else {
              break;
            }
          }
          steps.push({ kind: 'FullSplat', steps: nested });
          this.#brackets.pop();
        } else {
          // Index step `[ Expression ]`.
          const key = this.parseExpression('Nested', depth + 1);
          if (key === null) {
            return null;
          }
          this.skipStructural();
          if (!this.at('BracketClose')) {
            this.diagnose(codeHclParseExpression, this.span(this.peek().startByte, this.peek().endByte));
            return null;
          }
          const close = this.advance();
          this.#brackets.pop();
          steps.push({ kind: 'Index', key });
          end = close.endByte;
        }
      } else {
        break;
      }
    }
    if (steps.length === 0) {
      return base;
    }
    const root: HclTraversalRoot =
      name === 'true'
        ? { kind: 'Boolean', value: true }
        : name === 'false'
          ? { kind: 'Boolean', value: false }
          : name === 'null'
            ? { kind: 'Null' }
            : { kind: 'Variable', name };
    return {
      kind: 'Traversal',
      root,
      steps,
      span: this.span(nameToken.startByte, end),
    };
  }

  parseCall(nameToken: HclToken, depth: number): HclExpr | null {
    this.#brackets.push('Paren');
    this.advance(); // open paren
    const args: HclCallArg[] = [];
    let close: HclToken | null = null;
    for (;;) {
      this.skipStructural();
      if (this.at('ParenClose')) {
        close = this.advance();
        break;
      }
      const expression = this.parseExpression('Nested', depth + 1);
      if (expression === null) {
        return null;
      }
      let expand = false;
      this.skipStructural();
      if (this.at('Ellipsis')) {
        // The expansion marker may only appear on the final argument.
        this.advance();
        expand = true;
        this.skipStructural();
        if (this.at('Comma')) {
          this.advance();
          this.skipStructural();
        }
        if (!this.at('ParenClose')) {
          this.diagnose(codeHclParseExpression, this.span(this.peek().startByte, this.peek().endByte));
          return null;
        }
      }
      args.push({ expression, expand });
      if (this.at('ParenClose')) {
        close = this.advance();
        break;
      }
      if (this.at('Comma') || this.at('LineBreak') || this.at('LineComment')) {
        this.advance();
        continue;
      }
      this.diagnose(codeHclParseExpression, this.span(this.peek().startByte, this.peek().endByte));
      return null;
    }
    if (close === null) {
      throw new Error('internal: hcl call close expected');
    }
    this.#brackets.pop();
    return {
      kind: 'FunctionCall',
      name: this.text(nameToken),
      args,
      span: this.span(nameToken.startByte, close.endByte),
    };
  }

  parseParen(depth: number): HclExpr | null {
    this.#brackets.push('Paren');
    const open = this.advance();
    this.skipStructural();
    const inner = this.parseExpression('Nested', depth + 1);
    if (inner === null) {
      return null;
    }
    this.skipStructural();
    if (!this.at('ParenClose')) {
      this.diagnose(codeHclParseExpression, this.span(this.peek().startByte, this.peek().endByte));
      return null;
    }
    const close = this.advance();
    this.#brackets.pop();
    return { kind: 'Paren', inner, span: this.span(open.startByte, close.endByte) };
  }

  parseBracket(depth: number): HclExpr | null {
    this.#brackets.push('Bracket');
    const open = this.advance();
    this.skipStructural();
    if (this.at('Identifier') && this.text(this.peek()) === 'for') {
      // The for-expression interpretation has priority over a first
      // element literally spelled `for` (RFC 0014 §4.6).
      return this.parseForTuple(open, depth);
    }
    const elements: HclExpr[] = [];
    let close: HclToken | null = null;
    for (;;) {
      this.skipStructural();
      if (this.at('BracketClose')) {
        close = this.advance();
        break;
      }
      const element = this.parseExpression('Nested', depth + 1);
      if (element === null) {
        return null;
      }
      if (elements.length >= this.#limits.maxTupleElements) {
        throw this.fatalLimit('tuple-elements', elements.length + 1, this.#limits.maxTupleElements);
      }
      elements.push(element);
      this.skipTrivia();
      const next = this.peekKind();
      if (next === 'Comma' || next === 'LineBreak' || next === 'LineComment') {
        this.advance();
      } else if (next !== 'BracketClose') {
        this.diagnose(codeHclParseSeparator, this.span(this.peek().startByte, this.peek().endByte));
      }
    }
    if (close === null) {
      throw new Error('internal: hcl bracket close expected');
    }
    this.#brackets.pop();
    return { kind: 'Tuple', elements, span: this.span(open.startByte, close.endByte) };
  }

  parseBrace(depth: number): HclExpr | null {
    this.#brackets.push('Brace');
    const open = this.advance();
    this.skipStructural();
    if (this.at('Identifier') && this.text(this.peek()) === 'for') {
      // The for-expression interpretation has priority over a first key
      // literally spelled `for` (RFC 0014 §4.6).
      return this.parseForObject(open, depth);
    }
    const entries: HclObjectEntry[] = [];
    let close: HclToken | null = null;
    for (;;) {
      this.skipStructural();
      if (this.at('BraceClose')) {
        close = this.advance();
        break;
      }
      let key: HclObjectKey;
      const next = this.peekKind();
      if (next === 'Identifier') {
        const token = this.advance();
        key = { kind: 'Identifier', name: this.text(token) };
      } else if (next === 'Number') {
        const token = this.advance();
        key = { kind: 'Number', number: this.number(token) };
      } else if (next === 'StringOpen') {
        const template = this.parseQuotedTemplate(depth);
        if (template === null || template.kind !== 'Template') {
          return null;
        }
        key = { kind: 'Template', parts: template.parts };
      } else if (next === 'ParenOpen') {
        const inner = this.parseParen(depth);
        if (inner === null) {
          return null;
        }
        key = { kind: 'Paren', inner };
      } else {
        this.diagnose(codeHclParseExpression, this.span(this.peek().startByte, this.peek().endByte));
        return null;
      }
      this.skipStructural();
      if (this.at('Equals')) {
        this.advance();
      } else if (this.at('Colon')) {
        this.advance();
      } else {
        this.diagnose(codeHclParseExpression, this.span(this.peek().startByte, this.peek().endByte));
        return null;
      }
      this.skipStructural();
      const value = this.parseExpression('Nested', depth + 1);
      if (value === null) {
        return null;
      }
      if (entries.length >= this.#limits.maxObjectEntries) {
        throw this.fatalLimit('object-entries', entries.length + 1, this.#limits.maxObjectEntries);
      }
      entries.push({ key, value });
      this.skipTrivia();
      const sep = this.peekKind();
      if (sep === 'Comma' || sep === 'LineBreak' || sep === 'LineComment') {
        this.advance();
      } else if (sep !== 'BraceClose') {
        this.diagnose(codeHclParseSeparator, this.span(this.peek().startByte, this.peek().endByte));
      }
    }
    if (close === null) {
      throw new Error('internal: hcl brace close expected');
    }
    this.#brackets.pop();
    return { kind: 'Object', entries, span: this.span(open.startByte, close.endByte) };
  }

  /** Parses the shared `for` introduction (parser.rs:1810-1870). */
  parseForIntro(forStart: number, depth: number, expectColon: boolean): HclForIntro | null {
    this.skipStructural();
    let firstToken: HclToken;
    if (this.at('Identifier')) {
      firstToken = this.advance();
    } else {
      this.diagnose(codeHclParseExpression, this.span(this.peek().startByte, this.peek().endByte));
      return null;
    }
    let key: string | null = null;
    let value: string;
    this.skipStructural();
    if (this.at('Comma')) {
      this.advance();
      this.skipStructural();
      if (this.at('Identifier')) {
        key = this.text(firstToken);
        value = this.text(this.advance());
      } else {
        this.diagnose(codeHclParseExpression, this.span(this.peek().startByte, this.peek().endByte));
        return null;
      }
    } else {
      value = this.text(firstToken);
    }
    this.skipStructural();
    if (this.at('Identifier') && this.text(this.peek()) === 'in') {
      this.advance();
    } else {
      this.diagnose(codeHclParseExpression, this.span(this.peek().startByte, this.peek().endByte));
      return null;
    }
    this.skipStructural();
    const collection = this.parseExpression('Nested', depth + 1);
    if (collection === null) {
      return null;
    }
    if (expectColon) {
      this.skipStructural();
      if (!this.at('Colon')) {
        this.diagnose(codeHclParseExpression, this.span(this.peek().startByte, this.peek().endByte));
        return null;
      }
      this.advance();
    }
    return { key, value, collection };
  }

  parseForTuple(open: HclToken, depth: number): HclExpr | null {
    const forToken = this.advance(); // `for`
    const intro = this.parseForIntro(open.startByte, depth, true);
    if (intro === null) {
      return null;
    }
    this.skipStructural();
    const value = this.parseExpression('Nested', depth + 1);
    if (value === null) {
      return null;
    }
    this.skipStructural();
    let condition: HclExpr | null = null;
    if (this.at('Identifier') && this.text(this.peek()) === 'if') {
      this.advance();
      this.skipStructural();
      condition = this.parseExpression('Nested', depth + 1);
      if (condition === null) {
        return null;
      }
      this.skipStructural();
    }
    if (!this.at('BracketClose')) {
      this.diagnose(codeHclParseExpression, this.span(this.peek().startByte, this.peek().endByte));
      return null;
    }
    const close = this.advance();
    this.#brackets.pop();
    this.checkForExtent(forToken.startByte, close.endByte);
    return {
      kind: 'ForTuple',
      intro,
      value,
      condition,
      span: this.span(open.startByte, close.endByte),
    };
  }

  parseForObject(open: HclToken, depth: number): HclExpr | null {
    const forToken = this.advance(); // `for`
    const intro = this.parseForIntro(open.startByte, depth, true);
    if (intro === null) {
      return null;
    }
    this.skipStructural();
    const key = this.parseExpression('Nested', depth + 1);
    if (key === null) {
      return null;
    }
    this.skipStructural();
    if (!this.at('Arrow')) {
      this.diagnose(codeHclParseExpression, this.span(this.peek().startByte, this.peek().endByte));
      return null;
    }
    this.advance();
    this.skipStructural();
    const value = this.parseExpression('Nested', depth + 1);
    if (value === null) {
      return null;
    }
    this.skipStructural();
    let grouping = false;
    if (this.at('Ellipsis')) {
      this.advance();
      grouping = true;
      this.skipStructural();
    }
    let condition: HclExpr | null = null;
    if (this.at('Identifier') && this.text(this.peek()) === 'if') {
      this.advance();
      this.skipStructural();
      condition = this.parseExpression('Nested', depth + 1);
      if (condition === null) {
        return null;
      }
      this.skipStructural();
    }
    if (!this.at('BraceClose')) {
      this.diagnose(codeHclParseExpression, this.span(this.peek().startByte, this.peek().endByte));
      return null;
    }
    const close = this.advance();
    this.#brackets.pop();
    this.checkForExtent(forToken.startByte, close.endByte);
    return {
      kind: 'ForObject',
      intro,
      key,
      value,
      grouping,
      condition,
      span: this.span(open.startByte, close.endByte),
    };
  }

  /** Bounds one for-expression's byte extent (RFC 0014 §11 max_for_extent). */
  checkForExtent(start: number, end: number): void {
    const extent = end - start;
    if (extent > this.#limits.maxForExtent) {
      throw this.fatalLimit('for-extent', extent, this.#limits.maxForExtent);
    }
  }

  // -- templates (parser.rs:2030-2212) --------------------------------------

  /** Parses one quoted template (parser.rs:2030-2098). */
  parseQuotedTemplate(depth: number): HclExpr | null {
    const open = this.advance();
    const parts: HclTemplatePart[] = [];
    for (;;) {
      const token = this.peek();
      switch (token.kind) {
        case 'StringContent': {
          this.#pos += 1;
          parts.push({
            kind: 'Literal',
            text: decodeQuotedLiteral(this.text(token)),
            span: this.span(token.startByte, token.endByte),
          });
          break;
        }
        case 'StringClose': {
          const close = this.advance();
          return {
            kind: 'Template',
            parts,
            heredoc: null,
            span: this.span(open.startByte, close.endByte),
          };
        }
        case 'InterpolationOpen':
        case 'DirectiveOpen': {
          const directive = token.kind === 'DirectiveOpen';
          const partOpen = this.advance();
          const content = this.eat(directive ? 'DirectiveContent' : 'InterpolationContent');
          const partClose = this.eat(directive ? 'DirectiveClose' : 'InterpolationClose');
          if (content === null || partClose === null) {
            return null;
          }
          const partSpan = this.span(partOpen.startByte, partClose.endByte);
          if (directive) {
            const kind = this.parseDirectiveRegion(content, depth + 1);
            if (kind === null) {
              return null;
            }
            parts.push({ kind: 'Directive', directive: kind, span: partSpan });
          } else {
            const expression = this.parseRegionExpression(content, depth + 1);
            if (expression === null) {
              return null;
            }
            parts.push({ kind: 'Interpolation', expression, span: partSpan });
          }
          break;
        }
        case 'ErrorRegion':
        case 'Eof':
          // Unterminated at the lexer; no extra diagnostic.
          return null;
        default:
          this.diagnose(codeHclParseExpression, this.span(token.startByte, token.endByte));
          return null;
      }
    }
  }

  /** Parses one heredoc template (parser.rs:2100-2212). */
  parseHeredoc(depth: number): HclExpr | null {
    const open = this.advance();
    this.skipTrivia();
    if (!this.at('LineBreak')) {
      // Unterminated introducer or content; the lexer recovered it.
      return null;
    }
    this.advance();
    const parts: HclTemplatePart[] = [];
    for (;;) {
      const token = this.peek();
      switch (token.kind) {
        case 'HeredocClose': {
          const close = this.advance();
          const heredocSpan = this.span(open.startByte, close.endByte);
          const openText = this.text(open);
          const mode: HeredocMode = openText.startsWith('<<-') ? 'StripIndent' : 'Plain';
          const markerStart = open.startByte + (mode === 'StripIndent' ? 3 : 2);
          const marker = this.#view.slice(markerStart, open.endByte);
          const facts: HeredocFacts = { mode, marker };
          return { kind: 'Template', parts, heredoc: facts, span: heredocSpan };
        }
        case 'HeredocContent': {
          this.#pos += 1;
          parts.push({
            kind: 'Literal',
            text: decodeHeredocLiteral(this.text(token)),
            span: this.span(token.startByte, token.endByte),
          });
          break;
        }
        case 'LineBreak': {
          const token = this.advance();
          parts.push({ kind: 'Literal', text: '\n', span: this.span(token.startByte, token.endByte) });
          break;
        }
        case 'InterpolationOpen':
        case 'DirectiveOpen': {
          const directive = token.kind === 'DirectiveOpen';
          const partOpen = this.advance();
          const content = this.eat(directive ? 'DirectiveContent' : 'InterpolationContent');
          const partClose = this.eat(directive ? 'DirectiveClose' : 'InterpolationClose');
          if (content === null || partClose === null) {
            return null;
          }
          const partSpan = this.span(partOpen.startByte, partClose.endByte);
          if (directive) {
            const kind = this.parseDirectiveRegion(content, depth + 1);
            if (kind === null) {
              return null;
            }
            parts.push({ kind: 'Directive', directive: kind, span: partSpan });
          } else {
            const expression = this.parseRegionExpression(content, depth + 1);
            if (expression === null) {
              return null;
            }
            parts.push({ kind: 'Interpolation', expression, span: partSpan });
          }
          break;
        }
        default:
          // Unterminated at the lexer (error region or end of file); no
          // extra diagnostic.
          return null;
      }
    }
  }

  /** Re-lexes one interior and parses it as an expression (parser.rs:2214-2267). */
  parseRegionExpression(content: HclToken, depth: number): HclExpr | null {
    const output = this.lexRegion(content.startByte, content.endByte);
    const sub = new HclParser(this.#bytes, this.#view, this.#authority, this.#limits, output.tokens);
    const result = sub.parseExpressionRegion(depth);
    this.mergeRegion(output, sub);
    return result;
  }

  parseDirectiveRegion(content: HclToken, depth: number): HclDirective | null {
    const output = this.lexRegion(content.startByte, content.endByte);
    const sub = new HclParser(this.#bytes, this.#view, this.#authority, this.#limits, output.tokens);
    const result = sub.parseDirective(depth);
    this.mergeRegion(output, sub);
    return result;
  }

  lexRegion(start: number, end: number): HclLexOutput {
    return lexHclRegion(this.#bytes, this.#authority, this.#limits, start, end);
  }

  /** Merges one sub-parser's recovery facts into this pass (parser.rs:2235-2267). */
  mergeRegion(output: HclLexOutput, sub: HclParser): void {
    this.#recovered = this.#recovered || output.recovered || sub.#recovered;
    for (const diagnostic of output.diagnostics) {
      this.pushDiagnostic(diagnostic);
    }
    for (const region of output.errorRegions) {
      this.#errorRegions.push({ span: region.span, code: region.code });
    }
    for (const diagnostic of sub.#diagnostics) {
      this.pushDiagnostic(diagnostic);
    }
    for (const region of sub.#errorRegions) {
      this.#errorRegions.push(region);
    }
    this.checkErrorRegionLimits();
  }

  /** One expression over the region token stream (parser.rs:2269-2289). */
  parseExpressionRegion(depth: number): HclExpr | null {
    const expression = this.parseExpression('Nested', depth);
    if (expression === null) {
      return null;
    }
    this.skipStructural();
    if (this.at('Eof')) {
      return expression;
    }
    this.diagnose(codeHclParseExpression, this.span(this.peek().startByte, this.peek().endByte));
    return null;
  }

  /** One template directive over the region token stream (parser.rs:2291-2360). */
  parseDirective(depth: number): HclDirective | null {
    this.skipStructural();
    const token = this.peek();
    if (token.kind !== 'Identifier') {
      this.diagnose(codeHclParseDirective, this.span(token.startByte, token.endByte));
      return null;
    }
    const name = this.text(token);
    switch (name) {
      case 'if': {
        this.advance();
        this.skipStructural();
        const condition = this.parseExpression('Nested', depth + 1);
        if (condition === null) {
          return null;
        }
        this.skipStructural();
        if (!this.at('Eof')) {
          this.diagnose(codeHclParseDirective, this.span(this.peek().startByte, this.peek().endByte));
          return null;
        }
        return { kind: 'If', condition };
      }
      case 'else':
      case 'endif':
      case 'endfor': {
        this.advance();
        this.skipStructural();
        if (!this.at('Eof')) {
          this.diagnose(codeHclParseDirective, this.span(this.peek().startByte, this.peek().endByte));
          return null;
        }
        return name === 'else' ? { kind: 'Else' } : name === 'endif' ? { kind: 'EndIf' } : { kind: 'EndFor' };
      }
      case 'for': {
        this.advance();
        const intro = this.parseForIntro(token.startByte, depth, false);
        if (intro === null) {
          return null;
        }
        this.skipStructural();
        if (!this.at('Eof')) {
          this.diagnose(codeHclParseDirective, this.span(this.peek().startByte, this.peek().endByte));
          return null;
        }
        return { kind: 'For', intro };
      }
      default:
        this.diagnose(codeHclParseDirective, this.span(token.startByte, token.endByte));
        return null;
    }
  }

  // -- assembly --------------------------------------------------------------

  /** Merges one lexer pass's recovery facts into this pass (parser.rs:356-364). */
  mergeLexed(lexed: HclLexOutput): void {
    this.#recovered = this.#recovered || lexed.recovered;
    for (const diagnostic of lexed.diagnostics) {
      this.pushDiagnostic(diagnostic);
    }
    for (const region of lexed.errorRegions) {
      this.#errorRegions.push({ span: region.span, code: region.code });
    }
    this.checkErrorRegionLimits();
  }

  finish(body: ParsedBody, lexed: HclLexOutput): ParsedFormed {
    const sorted = sortDiagnostics(this.#diagnostics);
    this.#errorRegions.sort((left, right) => left.span.startByte() - right.span.startByte());
    return {
      body,
      errorRegions: this.#errorRegions,
      diagnostics: sorted,
      recovered: this.#recovered,
      pieces: lexed.pieces,
      syntaxKinds: lexed.syntaxKinds,
    };
  }
}

/**
 * Forms one HCL document from a validated UTF-8 source (parser.rs:356-376;
 * RFC 0014 §3). The lexer's recovery facts merge with the parser's own;
 * every limit failure is fatal, never a truncated success.
 */
export function parseHclTokens(
  bytes: Uint8Array,
  decoded: string,
  authority: DocumentAuthority,
  limits: HclParseLimits,
): ParsedFormed {
  const lexed = lexHclSource(bytes, authority, limits);
  const view = new DecodedView(bytes, decoded);
  const parser = new HclParser(bytes, view, authority, limits, lexed.tokens);
  parser.mergeLexed(lexed);
  const body = parser.parseBody(1, 'Eof');
  return parser.finish(body, lexed);
}
