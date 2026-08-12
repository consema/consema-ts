/**
 * The self-owned HCL lexer: token stream, recovery regions, diagnostics,
 * and the lossless 30-kind piece assembly (RFC 0014 §7.2).
 *
 * authority: crates/consema-hcl/src/lexer.rs —
 *  - HclTokenKind :103-245 (the token vocabulary, including Dot/Arrow/
 *    Ellipsis/Star that map to the `Operator` syntax kind :281-297)
 *  - syntax kind mapping :251-301 (the frozen RFC 0014 §7.2 kinds,
 *    spellings pinned in native.rs:400-474)
 *  - structural classification :305-313 (trivia / token / error region)
 *  - the scanner: scan_root :654-1127 (BOM :1097-1104, lone CR :668-681,
 *    identifier :1113-1115, `_` :1105-1112, number :1090-1092,
 *    comments :682-694, `::` :787-802, `&&`/`||` :755-782),
 *    scan_quoted :1131-1254 ($${/%%{ escapes :1168-1189, escape
 *    validation :1190-1213, unterminated string :1215-1252),
 *    scan_heredoc :1257-1292 (TrimSpace closing-line matching :1266-1270),
 *    scan_heredoc_line :1297-1372, open_quoted :1377-1391,
 *    open_heredoc :1393-1484 (heredoc-marker@1 :1477-1481),
 *    open_interpolation :1486-1530, scan_escape :1533-1586,
 *    scan_number :1619-1684 (the §4.1 decimal grammar and the
 *    invalid-number continuation rule :1646-1679), scan_identifier
 *    :1594-1615, scan_inline_comment :1700-1732, terminate_string
 *    :1738-1777, terminate_heredoc :1783-1811, emit buffering :1895-1921,
 *    emit_error_region :1936-1992, finish_eof :1994-2025 (the outermost
 *    unterminated template owns the error region), finish :2060-2094
 *  - the frozen `hcl.parse.*@1` lexical codes: lexer.rs:457-487
 *  - the template stack: TemplateFrame :498-537 (interior tokens are
 *    scanned but not emitted — `emitting()` :645-651)
 *  - limits: max_token_count/max_syntax_pieces (:1898-1911),
 *    max_template_depth (:1883-1893), max_string_len/max_template_len
 *    (:1144-1158), max_heredoc_bytes/max_heredoc_lines (:1783-1811),
 *    max_identifier_len (:1604-1610)
 *
 * Design (TypeScript-idiomatic): a single byte-oriented pass over the
 * frozen UTF-8 source. Tokens are plain records; emitted tokens are
 * buffered in the outermost open template frame and flushed only when that
 * template closes, so an unterminated template publishes no partial pieces
 * (the Rust `buffered` discipline, :1826-1840). The scanner validates
 * escape sequences and the number grammar exactly as the Rust authority;
 * every non-empty byte belongs to exactly one emitted token or error
 * region, so `LosslessStructuralIndex.create` accepts the piece stream.
 */

import { DocumentAuthority } from '../document/identity.ts';
import type { Span } from '../document/identity.ts';
import { diagnostic as makeDiagnostic } from '../document/diagnostic.ts';
import type { Diagnostic } from '../document/diagnostic.ts';
import { StructuralPiece } from '../document/structural.ts';
import type { StructuralPieceKind } from '../document/structural.ts';
import { HclFormationFailure } from './errors.ts';
import type { HclParseLimits } from './limits.ts';
import {
  codeHclParseByteOrderMark,
  codeHclParseIdentifier,
  codeHclParseInvalidCharacter,
  codeHclParseInvalidEscape,
  codeHclParseInvalidNumber,
  codeHclParseLoneCr,
  codeHclParseUnterminatedComment,
  codeHclParseUnterminatedHeredoc,
  codeHclParseUnterminatedInterpolation,
  codeHclParseUnterminatedDirective,
  codeHclParseUnterminatedString,
  codeHclParseHeredocMarker,
} from './errors.ts';

// ---------------------------------------------------------------------------
// Syntax kinds (RFC 0014 §7.2 — the frozen 30-kind set, native.rs:334-398)
// ---------------------------------------------------------------------------

/** Closed HCL lossless syntax kind set (native.rs:334-398); exactly thirty kinds. */
export type HclSyntaxKind =
  | 'Whitespace'
  | 'LineBreak'
  | 'LineComment'
  | 'InlineComment'
  | 'Identifier'
  | 'Equals'
  | 'Number'
  | 'StringOpen'
  | 'StringContent'
  | 'StringClose'
  | 'InterpolationOpen'
  | 'InterpolationContent'
  | 'InterpolationClose'
  | 'DirectiveOpen'
  | 'DirectiveContent'
  | 'DirectiveClose'
  | 'HeredocOpen'
  | 'HeredocContent'
  | 'HeredocClose'
  | 'BraceOpen'
  | 'BraceClose'
  | 'BracketOpen'
  | 'BracketClose'
  | 'ParenOpen'
  | 'ParenClose'
  | 'Comma'
  | 'Colon'
  | 'QuestionMark'
  | 'Operator'
  | 'ErrorRegion';

/** Resolves one kind spelling; `None` for an unknown spelling (native.rs:440-474). */
export function hclSyntaxKindFromName(name: string): HclSyntaxKind | null {
  switch (name) {
    case 'Whitespace':
    case 'LineBreak':
    case 'LineComment':
    case 'InlineComment':
    case 'Identifier':
    case 'Equals':
    case 'Number':
    case 'StringOpen':
    case 'StringContent':
    case 'StringClose':
    case 'InterpolationOpen':
    case 'InterpolationContent':
    case 'InterpolationClose':
    case 'DirectiveOpen':
    case 'DirectiveContent':
    case 'DirectiveClose':
    case 'HeredocOpen':
    case 'HeredocContent':
    case 'HeredocClose':
    case 'BraceOpen':
    case 'BraceClose':
    case 'BracketOpen':
    case 'BracketClose':
    case 'ParenOpen':
    case 'ParenClose':
    case 'Comma':
    case 'Colon':
    case 'QuestionMark':
    case 'Operator':
    case 'ErrorRegion':
      return name;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Internal token vocabulary (lexer.rs:103-245)
// ---------------------------------------------------------------------------

/** The closed internal token vocabulary of the lexer (lexer.rs:103-245). */
export type HclTokenKind =
  | 'Whitespace'
  | 'LineBreak'
  | 'LineComment'
  | 'InlineComment'
  | 'Identifier'
  | 'Number'
  | 'Equals'
  | 'StringOpen'
  | 'StringContent'
  | 'StringClose'
  | 'InterpolationOpen'
  | 'InterpolationContent'
  | 'InterpolationClose'
  | 'DirectiveOpen'
  | 'DirectiveContent'
  | 'DirectiveClose'
  | 'HeredocOpen'
  | 'HeredocContent'
  | 'HeredocClose'
  | 'Dot'
  | 'Comma'
  | 'Colon'
  | 'QuestionMark'
  | 'Arrow'
  | 'Ellipsis'
  | 'Star'
  | 'BraceOpen'
  | 'BraceClose'
  | 'BracketOpen'
  | 'BracketClose'
  | 'ParenOpen'
  | 'ParenClose'
  | 'OpEqual'
  | 'OpNotEqual'
  | 'OpLess'
  | 'OpGreater'
  | 'OpLessEqual'
  | 'OpGreaterEqual'
  | 'OpAdd'
  | 'OpSubtract'
  | 'OpNot'
  | 'OpDivide'
  | 'OpModulo'
  | 'OpAnd'
  | 'OpOr'
  | 'ErrorRegion'
  | 'Eof';

/** The frozen syntax kind of one token; `null` for the zero-length `Eof` terminal (lexer.rs:251-301). */
export function tokenSyntaxKind(kind: HclTokenKind): HclSyntaxKind | null {
  switch (kind) {
    case 'Whitespace':
    case 'LineBreak':
    case 'LineComment':
    case 'InlineComment':
    case 'Identifier':
    case 'Number':
    case 'Equals':
    case 'StringOpen':
    case 'StringContent':
    case 'StringClose':
    case 'InterpolationOpen':
    case 'InterpolationContent':
    case 'InterpolationClose':
    case 'DirectiveOpen':
    case 'DirectiveContent':
    case 'DirectiveClose':
    case 'HeredocOpen':
    case 'HeredocContent':
    case 'HeredocClose':
    case 'BraceOpen':
    case 'BraceClose':
    case 'BracketOpen':
    case 'BracketClose':
    case 'ParenOpen':
    case 'ParenClose':
    case 'Comma':
    case 'Colon':
    case 'QuestionMark':
    case 'ErrorRegion':
      return kind;
    case 'Dot':
    case 'Arrow':
    case 'Ellipsis':
    case 'Star':
    case 'OpEqual':
    case 'OpNotEqual':
    case 'OpLess':
    case 'OpGreater':
    case 'OpLessEqual':
    case 'OpGreaterEqual':
    case 'OpAdd':
    case 'OpSubtract':
    case 'OpNot':
    case 'OpDivide':
    case 'OpModulo':
    case 'OpAnd':
    case 'OpOr':
      return 'Operator';
    case 'Eof':
      return null;
  }
}

/** The structural classification of one token's piece (lexer.rs:305-313). */
export function tokenStructuralKind(kind: HclTokenKind): StructuralPieceKind {
  switch (kind) {
    case 'Whitespace':
    case 'LineBreak':
    case 'LineComment':
    case 'InlineComment':
      return 'Trivia';
    case 'ErrorRegion':
      return 'ErrorRegion';
    default:
      return 'Token';
  }
}

/** One token of the lexer stream (lexer.rs:89-101). */
export interface HclToken {
  readonly kind: HclTokenKind;
  readonly startByte: number;
  readonly endByte: number;
}

/** One recovered error region with its stable code (native.rs:293-325). */
export interface HclErrorRegionNode {
  readonly span: Span;
  readonly code: string;
}

/** Complete result of one lexer pass (lexer.rs:316-359). */
export interface HclLexOutput {
  /** Ordered token stream, ending with the zero-length `Eof` terminal. */
  readonly tokens: readonly HclToken[];
  /** Recovered error regions in source order (lexer.rs:348-353). */
  readonly errorRegions: readonly HclErrorRegionNode[];
  /** Ordered diagnostics (lexer.rs:355-359). */
  readonly diagnostics: readonly Diagnostic[];
  /** Whether any lexical deviation was recovered. */
  readonly recovered: boolean;
  /** Exhaustive structural pieces in source order; `null` for a region lex. */
  readonly pieces: readonly StructuralPiece[] | null;
  /** Syntax kinds parallel to the pieces; empty for a region lex (lexer.rs:2082-2083). */
  readonly syntaxKinds: readonly HclSyntaxKind[];
}

/** One open template construct of the scanner stack (lexer.rs:498-537). */
type TemplateFrame =
  | { readonly kind: 'Quoted'; readonly open: number }
  | {
      readonly kind: 'Heredoc';
      readonly marker: string;
      readonly contentStart: number;
      readonly bytes: number;
      readonly lines: number;
    }
  | { readonly kind: 'Interp'; readonly directive: boolean; readonly depth: number; readonly interiorStart: number };

const ID_START = /^\p{ID_Start}$/u;
const ID_CONTINUE = /^\p{ID_Continue}$/u;

/** Whether one scalar is an ID_Start per UAX #31 (RFC 0014 §4.1). */
function isIdentifierStart(character: string): boolean {
  return ID_START.test(character);
}

/** Whether one scalar continues an identifier (ID_Continue or the frozen hyphen). */
function isIdentifierContinue(character: string): boolean {
  return ID_CONTINUE.test(character) || character === '-';
}

/** Decodes one UTF-8 scalar at a byte offset; the source is pre-validated UTF-8. */
function scalarAt(bytes: Uint8Array, pos: number): { character: string; width: number } {
  const b0 = bytes[pos];
  if (b0 < 0x80) {
    return { character: String.fromCharCode(b0), width: 1 };
  }
  if (b0 >= 0xc2 && b0 <= 0xdf) {
    return { character: String.fromCharCode(((b0 & 0x1f) << 6) | (bytes[pos + 1] & 0x3f)), width: 2 };
  }
  if (b0 >= 0xe0 && b0 <= 0xef) {
    return {
      character: String.fromCharCode(
        ((b0 & 0x0f) << 12) | ((bytes[pos + 1] & 0x3f) << 6) | (bytes[pos + 2] & 0x3f),
      ),
      width: 3,
    };
  }
  const scalar =
    ((b0 & 0x07) << 18) |
    ((bytes[pos + 1] & 0x3f) << 12) |
    ((bytes[pos + 2] & 0x3f) << 6) |
    (bytes[pos + 3] & 0x3f);
  return { character: String.fromCodePoint(scalar), width: 4 };
}

/**
 * One deterministic lexer pass over a decoded UTF-8 source (lexer.rs:580-642).
 * Byte offsets are raw-byte offsets under the UTF-8-only source contract;
 * the scanner is total — every byte of `[start, end)` is consumed by
 * exactly one token or error region.
 */
class Lexer {
  readonly #bytes: Uint8Array;
  readonly #authority: DocumentAuthority;
  readonly #limits: HclParseLimits;
  readonly #start: number;
  readonly #end: number;
  readonly #buildIndex: boolean;
  readonly #tokens: HclToken[] = [];
  readonly #errorRegions: HclErrorRegionNode[] = [];
  readonly #diagnostics: Diagnostic[] = [];
  readonly #stack: TemplateFrame[] = [];
  /** Tokens buffered in the outermost open template frame (lexer.rs:1895-1921). */
  #buffer: HclToken[] = [];
  #recovered = false;
  #pos: number;
  #truncated = false;

  constructor(
    bytes: Uint8Array,
    authority: DocumentAuthority,
    limits: HclParseLimits,
    start: number,
    end: number,
    buildIndex: boolean,
  ) {
    this.#bytes = bytes;
    this.#authority = authority;
    this.#limits = limits;
    this.#start = start;
    this.#end = end;
    this.#buildIndex = buildIndex;
    this.#pos = start;
  }

  scan(): void {
    while (this.#pos < this.#end) {
      const top = this.#stack[this.#stack.length - 1];
      if (top === undefined) {
        this.scanRoot();
      } else if (top.kind === 'Interp') {
        this.scanAbsorb();
      } else if (top.kind === 'Quoted') {
        this.scanQuoted();
      } else {
        this.scanHeredoc();
      }
    }
    this.finishEof();
  }

  /** Whether the current position is outside every interpolation/directive interior (lexer.rs:645-651). */
  #emitting(): boolean {
    return this.#stack.every((frame) => frame.kind !== 'Interp');
  }

  byte(): number | undefined {
    return this.#bytes[this.#pos];
  }

  byteAt(offset: number): number | undefined {
    return this.#bytes[this.#pos + offset];
  }

  span(start: number, end: number): Span {
    if (start > end || end > this.#bytes.length) {
      throw new HclFormationFailure('Syntax', { parserReason: 'coordinates' });
    }
    return this.#authority.span(start, end);
  }

  /** Emits one token, buffering it when an open quoted/heredoc template owns the position (lexer.rs:1895-1921). */
  emit(token: HclToken): void {
    const count = this.#tokens.length + this.#buffer.length + 1;
    if (count > this.#limits.common.maxTokenCount) {
      throw new HclFormationFailure('ResourceLimit', {
        limitName: 'token-count',
        observed: count,
        limit: this.#limits.common.maxTokenCount,
      });
    }
    if (count > this.#limits.maxSyntaxPieces) {
      throw new HclFormationFailure('ResourceLimit', {
        limitName: 'syntax-pieces',
        observed: count,
        limit: this.#limits.maxSyntaxPieces,
      });
    }
    const outer = this.#stack[0];
    if (outer !== undefined && (outer.kind === 'Quoted' || outer.kind === 'Heredoc')) {
      this.#buffer.push(token);
    } else {
      this.#tokens.push(token);
    }
  }

  emitKind(kind: HclTokenKind, start: number, end: number): void {
    this.emit({ kind, startByte: start, endByte: end });
  }

  /** Records one recovery diagnostic and marks the pass Recovered. */
  diagnose(code: string, category: 'Lexical' | 'Syntax' | 'Encoding', span: Span): void {
    this.#recovered = true;
    this.pushDiagnostic(makeDiagnostic(code, category, 'Error', span.diagnosticLocation(), 0n));
  }

  pushDiagnostic(diagnostic: Diagnostic): void {
    if (this.#diagnostics.length < this.#limits.common.maxDiagnostics) {
      this.#diagnostics.push(diagnostic);
    } else if (!this.#truncated) {
      this.#truncated = true;
      this.#diagnostics.push(
        makeDiagnostic(
          'core.diagnostic.truncated@1',
          'Resource',
          'Warning',
          null,
          0n,
        ),
      );
    }
  }

  /** Emits one error-region token and records its recovery fact (lexer.rs:1936-1992). */
  emitErrorRegion(start: number, end: number, code: string, category: 'Lexical' | 'Syntax' | 'Encoding'): void {
    this.#recovered = true;
    if (end > start) {
      const span = this.span(start, end);
      this.pushDiagnostic(makeDiagnostic(code, category, 'Error', span.diagnosticLocation(), 0n));
      if (this.#errorRegions.length >= this.#limits.maxRecoveryRegions) {
        throw new HclFormationFailure('ResourceLimit', {
          limitName: 'recovery-regions',
          observed: this.#errorRegions.length + 1,
          limit: this.#limits.maxRecoveryRegions,
        });
      }
      if (this.#errorRegions.length >= this.#limits.maxErrorRegions) {
        throw new HclFormationFailure('ResourceLimit', {
          limitName: 'error-regions',
          observed: this.#errorRegions.length + 1,
          limit: this.#limits.maxErrorRegions,
        });
      }
      this.#errorRegions.push({ span, code });
      this.emit({ kind: 'ErrorRegion', startByte: start, endByte: end });
    } else {
      this.pushDiagnostic(makeDiagnostic(code, category, 'Error', null, 0n));
    }
  }

  /** Non-emitting recovery: diagnostic only, never a piece (inside interpolation interiors). */
  recover(code: string, category: 'Lexical' | 'Syntax' | 'Encoding', start: number, end: number): void {
    this.#recovered = true;
    this.pushDiagnostic(makeDiagnostic(code, category, 'Error', this.span(start, end).diagnosticLocation(), 0n));
  }

  fatalLimit(limitName: string, observed: number, limit: number): HclFormationFailure {
    return new HclFormationFailure('ResourceLimit', { limitName, observed, limit });
  }

  checkTemplateDepth(): void {
    const depth = this.#stack.length + 1;
    if (depth > this.#limits.maxTemplateDepth) {
      throw this.fatalLimit('template-depth', depth, this.#limits.maxTemplateDepth);
    }
  }

  noteHeredocContent(bytes: number, lines: number): void {
    if (bytes > this.#limits.maxHeredocBytes) {
      throw this.fatalLimit('heredoc-bytes', bytes, this.#limits.maxHeredocBytes);
    }
    if (lines > this.#limits.maxHeredocLines) {
      throw this.fatalLimit('heredoc-lines', lines, this.#limits.maxHeredocLines);
    }
  }

  /** Updates the heredoc byte/line accounting after one content line. */
  noteHeredocLine(lineBytes: number): void {
    const top = this.#stack[this.#stack.length - 1];
    if (top === undefined || top.kind !== 'Heredoc') {
      throw new Error('internal: hcl heredoc frame expected');
    }
    const bytes = top.bytes + lineBytes;
    const lines = top.lines + 1;
    this.#stack[this.#stack.length - 1] = { ...top, bytes, lines };
    this.noteHeredocContent(bytes, lines);
  }

  // -- root scanning (lexer.rs:654-1127) -------------------------------------

  scanRoot(): void {
    const byte = this.byte()!;
    switch (byte) {
      case 0x20:
      case 0x09: {
        const start = this.#pos;
        while (this.byte() === 0x20 || this.byte() === 0x09) {
          this.#pos += 1;
        }
        this.emitKind('Whitespace', start, this.#pos);
        return;
      }
      case 0x0a: {
        this.emitKind('LineBreak', this.#pos, this.#pos + 1);
        this.#pos += 1;
        return;
      }
      case 0x0d: {
        if (this.byteAt(1) === 0x0a) {
          this.emitKind('LineBreak', this.#pos, this.#pos + 2);
          this.#pos += 2;
        } else {
          this.emitErrorRegion(this.#pos, this.#pos + 1, codeHclParseLoneCr, 'Lexical');
          this.#pos += 1;
        }
        return;
      }
      case 0x23: {
        this.scanLineComment(true);
        return;
      }
      case 0x2f: {
        if (this.byteAt(1) === 0x2f) {
          this.scanLineComment(true);
        } else if (this.byteAt(1) === 0x2a) {
          this.scanInlineComment(true);
        } else {
          this.emitKind('OpDivide', this.#pos, this.#pos + 1);
          this.#pos += 1;
        }
        return;
      }
      case 0x22: {
        this.openQuoted(true);
        return;
      }
      case 0x3c: {
        if (this.byteAt(1) === 0x3c) {
          this.openHeredoc(true);
        } else if (this.byteAt(1) === 0x3d) {
          this.emitKind('OpLessEqual', this.#pos, this.#pos + 2);
          this.#pos += 2;
        } else {
          this.emitKind('OpLess', this.#pos, this.#pos + 1);
          this.#pos += 1;
        }
        return;
      }
      case 0x3e: {
        if (this.byteAt(1) === 0x3d) {
          this.emitKind('OpGreaterEqual', this.#pos, this.#pos + 2);
          this.#pos += 2;
        } else {
          this.emitKind('OpGreater', this.#pos, this.#pos + 1);
          this.#pos += 1;
        }
        return;
      }
      case 0x3d: {
        if (this.byteAt(1) === 0x3d) {
          this.emitKind('OpEqual', this.#pos, this.#pos + 2);
          this.#pos += 2;
        } else if (this.byteAt(1) === 0x3e) {
          this.emitKind('Arrow', this.#pos, this.#pos + 2);
          this.#pos += 2;
        } else {
          this.emitKind('Equals', this.#pos, this.#pos + 1);
          this.#pos += 1;
        }
        return;
      }
      case 0x21: {
        if (this.byteAt(1) === 0x3d) {
          this.emitKind('OpNotEqual', this.#pos, this.#pos + 2);
          this.#pos += 2;
        } else {
          this.emitKind('OpNot', this.#pos, this.#pos + 1);
          this.#pos += 1;
        }
        return;
      }
      case 0x2d: {
        this.emitKind('OpSubtract', this.#pos, this.#pos + 1);
        this.#pos += 1;
        return;
      }
      case 0x2b: {
        this.emitKind('OpAdd', this.#pos, this.#pos + 1);
        this.#pos += 1;
        return;
      }
      case 0x2a: {
        this.emitKind('Star', this.#pos, this.#pos + 1);
        this.#pos += 1;
        return;
      }
      case 0x25: {
        this.emitKind('OpModulo', this.#pos, this.#pos + 1);
        this.#pos += 1;
        return;
      }
      case 0x26: {
        if (this.byteAt(1) === 0x26) {
          this.emitKind('OpAnd', this.#pos, this.#pos + 2);
          this.#pos += 2;
        } else {
          this.emitErrorRegion(this.#pos, this.#pos + 1, codeHclParseInvalidCharacter, 'Syntax');
          this.#pos += 1;
        }
        return;
      }
      case 0x7c: {
        if (this.byteAt(1) === 0x7c) {
          this.emitKind('OpOr', this.#pos, this.#pos + 2);
          this.#pos += 2;
        } else {
          this.emitErrorRegion(this.#pos, this.#pos + 1, codeHclParseInvalidCharacter, 'Syntax');
          this.#pos += 1;
        }
        return;
      }
      case 0x3f: {
        this.emitKind('QuestionMark', this.#pos, this.#pos + 1);
        this.#pos += 1;
        return;
      }
      case 0x3a: {
        if (this.byteAt(1) === 0x3a) {
          // `::` is never an operator: the namespaced function form has no
          // spec production (RFC 0014 §12 D-6).
          this.emitErrorRegion(this.#pos, this.#pos + 2, codeHclParseInvalidCharacter, 'Syntax');
          this.#pos += 2;
        } else {
          this.emitKind('Colon', this.#pos, this.#pos + 1);
          this.#pos += 1;
        }
        return;
      }
      case 0x2c: {
        this.emitKind('Comma', this.#pos, this.#pos + 1);
        this.#pos += 1;
        return;
      }
      case 0x2e: {
        if (this.byteAt(1) === 0x2e && this.byteAt(2) === 0x2e) {
          this.emitKind('Ellipsis', this.#pos, this.#pos + 3);
          this.#pos += 3;
        } else {
          this.emitKind('Dot', this.#pos, this.#pos + 1);
          this.#pos += 1;
        }
        return;
      }
      case 0x7b: {
        this.emitKind('BraceOpen', this.#pos, this.#pos + 1);
        this.#pos += 1;
        return;
      }
      case 0x7d: {
        this.emitKind('BraceClose', this.#pos, this.#pos + 1);
        this.#pos += 1;
        return;
      }
      case 0x5b: {
        this.emitKind('BracketOpen', this.#pos, this.#pos + 1);
        this.#pos += 1;
        return;
      }
      case 0x5d: {
        this.emitKind('BracketClose', this.#pos, this.#pos + 1);
        this.#pos += 1;
        return;
      }
      case 0x28: {
        this.emitKind('ParenOpen', this.#pos, this.#pos + 1);
        this.#pos += 1;
        return;
      }
      case 0x29: {
        this.emitKind('ParenClose', this.#pos, this.#pos + 1);
        this.#pos += 1;
        return;
      }
      case 0x5c:
      case 0x24: {
        // A lone backslash or dollar outside a template is an invalid
        // character (lexer.rs:1051-1059).
        this.emitErrorRegion(this.#pos, this.#pos + 1, codeHclParseInvalidCharacter, 'Syntax');
        this.#pos += 1;
        return;
      }
      case 0x30:
      case 0x31:
      case 0x32:
      case 0x33:
      case 0x34:
      case 0x35:
      case 0x36:
      case 0x37:
      case 0x38:
      case 0x39: {
        this.scanNumber(true);
        return;
      }
      default: {
        const { character, width } = scalarAt(this.#bytes, this.#pos);
        if (character === '\uFEFF') {
          this.emitErrorRegion(this.#pos, this.#pos + 3, codeHclParseByteOrderMark, 'Encoding');
          this.#pos += 3;
        } else if (character === '_') {
          // `_foo` is rejected at the lexer (RFC 0014 §12 D-4).
          this.emitErrorRegion(this.#pos, this.#pos + 1, codeHclParseIdentifier, 'Syntax');
          this.#pos += 1;
        } else if (isIdentifierStart(character)) {
          this.scanIdentifier(true);
        } else {
          this.emitErrorRegion(this.#pos, this.#pos + width, codeHclParseInvalidCharacter, 'Syntax');
          this.#pos += width;
        }
        return;
      }
    }
  }

  /** Scans one identifier (lexer.rs:1594-1615). */
  scanIdentifier(emit: boolean): void {
    const start = this.#pos;
    for (;;) {
      const scalar = scalarAt(this.#bytes, this.#pos);
      if (isIdentifierContinue(scalar.character)) {
        this.#pos += scalar.width;
      } else {
        break;
      }
    }
    const len = this.#pos - start;
    if (len > this.#limits.maxIdentifierLen) {
      throw this.fatalLimit('identifier-len', len, this.#limits.maxIdentifierLen);
    }
    if (emit) {
      this.emitKind('Identifier', start, this.#pos);
    }
  }

  /** Scans one number-shaped run and validates the §4.1 decimal grammar (lexer.rs:1619-1684). */
  scanNumber(emit: boolean): void {
    const start = this.#pos;
    while (this.byte() !== undefined && this.byte()! >= 0x30 && this.byte()! <= 0x39) {
      this.#pos += 1;
    }
    if (this.byte() === 0x2e) {
      const next = this.byteAt(1);
      if (next !== undefined && next >= 0x30 && next <= 0x39) {
        this.#pos += 2;
        while (this.byte() !== undefined && this.byte()! >= 0x30 && this.byte()! <= 0x39) {
          this.#pos += 1;
        }
      }
    }
    if (this.byte() === 0x65 || this.byte() === 0x45) {
      const sign = this.byteAt(1) === 0x2b || this.byteAt(1) === 0x2d;
      const digitsStart = sign ? 2 : 1;
      const digitsByte = this.byteAt(digitsStart);
      if (digitsByte !== undefined && digitsByte >= 0x30 && digitsByte <= 0x39) {
        this.#pos += 1;
        if (sign) {
          this.#pos += 1;
        }
        while (this.byte() !== undefined && this.byte()! >= 0x30 && this.byte()! <= 0x39) {
          this.#pos += 1;
        }
      }
    }
    // A continuation that cannot start a fresh token makes the whole run one
    // invalid number: hex/octal/binary forms, underscores, a second
    // fraction, or an identifier extension (lexer.rs:1646-1679).
    let end = this.#pos;
    for (;;) {
      const scalar = scalarAt(this.#bytes, end);
      if (isIdentifierContinue(scalar.character)) {
        end += scalar.width;
      } else if (
        scalar.character === '.' &&
        end + scalar.width < this.#bytes.length &&
        this.#bytes[end + scalar.width] >= 0x30 &&
        this.#bytes[end + scalar.width] <= 0x39
      ) {
        end += 1;
        // The digit after the dot is a single byte.
        end += 1;
      } else {
        break;
      }
    }
    if (end > this.#pos) {
      if (emit) {
        this.emitErrorRegion(start, end, codeHclParseInvalidNumber, 'Syntax');
      } else {
        this.recover(codeHclParseInvalidNumber, 'Syntax', start, end);
      }
      this.#pos = end;
    } else if (emit) {
      this.emitKind('Number', start, this.#pos);
    }
  }

  /** Scans a `//` or `#` line comment up to (not including) the newline (lexer.rs:1686-1696). */
  scanLineComment(emit: boolean): void {
    const start = this.#pos;
    while (this.#pos < this.#end && this.byte() !== 0x0a && this.byte() !== 0x0d) {
      this.#pos += 1;
    }
    if (emit) {
      this.emitKind('LineComment', start, this.#pos);
    }
  }

  /** Scans a `/* ... *​/` inline comment, which may span lines (lexer.rs:1698-1732). */
  scanInlineComment(emit: boolean): void {
    const start = this.#pos;
    this.#pos += 2;
    while (this.#pos + 1 < this.#end && !(this.#bytes[this.#pos] === 0x2a && this.#bytes[this.#pos + 1] === 0x2f)) {
      this.#pos += 1;
    }
    if (this.#pos + 1 < this.#end) {
      this.#pos += 2;
      if (emit) {
        this.emitKind('InlineComment', start, this.#pos);
      }
    } else {
      if (emit) {
        this.emitErrorRegion(start, this.#end, codeHclParseUnterminatedComment, 'Syntax');
      } else {
        this.recover(codeHclParseUnterminatedComment, 'Syntax', start, this.#end);
      }
      this.#pos = this.#end;
    }
  }

  /** Opens a quoted template at the current `"` (lexer.rs:1377-1391). */
  openQuoted(emit: boolean): void {
    const open = this.#pos;
    this.#pos += 1;
    this.checkTemplateDepth();
    if (emit) {
      this.emitKind('StringOpen', open, this.#pos);
    }
    this.#stack.push({ kind: 'Quoted', open });
  }

  /** Opens a heredoc at the current `<<` or `<<-` (lexer.rs:1393-1484). */
  openHeredoc(emit: boolean): void {
    const start = this.#pos;
    this.#pos += 2;
    if (this.byte() === 0x2d) {
      this.#pos += 1;
    }
    const markerScalar = scalarAt(this.#bytes, this.#pos);
    if (isIdentifierStart(markerScalar.character)) {
      const markerStart = this.#pos;
      for (;;) {
        const scalar = scalarAt(this.#bytes, this.#pos);
        if (isIdentifierContinue(scalar.character)) {
          this.#pos += scalar.width;
        } else {
          break;
        }
      }
      const marker = this.textBytes(markerStart, this.#pos);
      // The introducer must be followed by a newline (or end of file); the
      // pinned Go parser trims the closing line with TrimSpace (RFC 0014
      // §4.5), so leading spaces after the marker are admitted here too.
      let lineCursor = this.#pos;
      while (lineCursor < this.#end && (this.#bytes[lineCursor] === 0x20 || this.#bytes[lineCursor] === 0x09)) {
        lineCursor += 1;
      }
      const newlineOk =
        lineCursor >= this.#end ||
        this.#bytes[lineCursor] === 0x0a ||
        (this.#bytes[lineCursor] === 0x0d && lineCursor + 1 < this.#end && this.#bytes[lineCursor + 1] === 0x0a);
      if (newlineOk) {
        this.checkTemplateDepth();
        if (emit) {
          this.emitKind('HeredocOpen', start, this.#pos);
          if (lineCursor > this.#pos) {
            this.emitKind('Whitespace', this.#pos, lineCursor);
          }
        }
        let contentStart = lineCursor;
        if (lineCursor < this.#end) {
          const newlineEnd = this.#bytes[lineCursor] === 0x0d ? lineCursor + 2 : lineCursor + 1;
          if (emit) {
            this.emitKind('LineBreak', lineCursor, newlineEnd);
          }
          contentStart = newlineEnd;
        }
        this.#pos = contentStart;
        this.#stack.push({ kind: 'Heredoc', marker, contentStart, bytes: 0, lines: 0 });
        return;
      }
      this.failHeredocMarker(start, emit);
      return;
    }
    this.failHeredocMarker(start, emit);
  }

  /** A `<<`/`<<-` that does not introduce a heredoc (lexer.rs:1477-1481). */
  failHeredocMarker(start: number, emit: boolean): void {
    if (emit) {
      this.emitErrorRegion(start, this.#pos, codeHclParseHeredocMarker, 'Syntax');
    } else {
      this.recover(codeHclParseHeredocMarker, 'Syntax', start, this.#pos);
    }
  }

  /** Opens an interpolation (`${`) or directive (`%{`) sequence (lexer.rs:1486-1530). */
  openInterpolation(directive: boolean, emit: boolean): void {
    const openStart = this.#pos;
    this.#pos += 2;
    if (this.byte() === 0x7e) {
      this.#pos += 1;
    }
    const interiorStart = this.#pos;
    if (emit) {
      this.emitKind(directive ? 'DirectiveOpen' : 'InterpolationOpen', openStart, this.#pos);
    }
    this.#stack.push({ kind: 'Interp', directive, depth: 0, interiorStart });
  }

  /** Scans quoted-template content (lexer.rs:1131-1254). */
  scanQuoted(): void {
    const emit = this.#emitting();
    let runStart = this.#pos;
    for (;;) {
      const byte = this.byte();
      if (byte === undefined) {
        this.terminateString(this.#end);
        return;
      }
      switch (byte) {
        case 0x22: {
          this.endRun(runStart, emit, 'StringContent');
          const closeStart = this.#pos;
          this.#pos += 1;
          const frame = this.#stack[this.#stack.length - 1];
          const open = frame.kind === 'Quoted' ? frame.open : -1;
          const spanLen = this.#pos - open;
          if (spanLen > this.#limits.maxStringLen) {
            throw this.fatalLimit('string-len', spanLen, this.#limits.maxStringLen);
          }
          if (spanLen > this.#limits.maxTemplateLen) {
            throw this.fatalLimit('template-len', spanLen, this.#limits.maxTemplateLen);
          }
          if (emit) {
            this.flushBuffer();
            this.#stack.pop();
            this.emitKind('StringClose', closeStart, this.#pos);
          } else {
            this.#stack.pop();
          }
          return;
        }
        case 0x24: {
          if (this.byteAt(1) === 0x24 && this.byteAt(2) === 0x7b) {
            this.#pos += 3;
          } else if (this.byteAt(1) === 0x7b) {
            this.endRun(runStart, emit, 'StringContent');
            this.openInterpolation(false, emit);
            return;
          } else {
            this.#pos += 1;
          }
          break;
        }
        case 0x25: {
          if (this.byteAt(1) === 0x25 && this.byteAt(2) === 0x7b) {
            this.#pos += 3;
          } else if (this.byteAt(1) === 0x7b) {
            this.endRun(runStart, emit, 'StringContent');
            this.openInterpolation(true, emit);
            return;
          } else {
            this.#pos += 1;
          }
          break;
        }
        case 0x5c: {
          if (this.byteAt(1) === 0x0a) {
            this.recover(codeHclParseInvalidEscape, 'Syntax', this.#pos, this.#pos + 2);
            this.#pos += 2;
          } else if (this.byteAt(1) === 0x0d && this.byteAt(2) === 0x0a) {
            this.recover(codeHclParseInvalidEscape, 'Syntax', this.#pos, this.#pos + 3);
            this.#pos += 3;
          } else {
            this.scanEscape();
          }
          break;
        }
        case 0x0a: {
          this.terminateString(this.#pos);
          return;
        }
        case 0x0d: {
          if (this.byteAt(1) === 0x0a) {
            this.terminateString(this.#pos);
            return;
          }
          this.endRun(runStart, emit, 'StringContent');
          if (emit) {
            this.emitErrorRegion(this.#pos, this.#pos + 1, codeHclParseLoneCr, 'Lexical');
          } else {
            this.recover(codeHclParseLoneCr, 'Lexical', this.#pos, this.#pos + 1);
          }
          this.#pos += 1;
          runStart = this.#pos;
          break;
        }
        default: {
          this.#pos += scalarAt(this.#bytes, this.#pos).width;
          break;
        }
      }
    }
  }

  /** Validates one escape sequence of a quoted template (lexer.rs:1533-1586). */
  scanEscape(): void {
    const start = this.#pos;
    this.#pos += 1;
    const scalar = scalarAt(this.#bytes, this.#pos);
    this.#pos += scalar.width;
    let valid: boolean;
    switch (scalar.character) {
      case 'n':
      case 'r':
      case 't':
      case '"':
      case '\\':
        valid = true;
        break;
      case 'u': {
        const digitsStart = this.#pos;
        const consumed = this.consumeHex(4);
        valid = consumed === 4 && validUnicodeEscape(this.#bytes, digitsStart, this.#pos);
        break;
      }
      case 'U': {
        const digitsStart = this.#pos;
        const consumed = this.consumeHex(8);
        valid = consumed === 8 && validUnicodeEscape(this.#bytes, digitsStart, this.#pos);
        break;
      }
      default:
        valid = false;
        break;
    }
    if (!valid) {
      this.recover(codeHclParseInvalidEscape, 'Syntax', start, this.#pos);
    }
  }

  /** Consumes up to `count` ASCII hex digits; returns the consumed count. */
  consumeHex(count: number): number {
    let consumed = 0;
    while (consumed < count) {
      const byte = this.byte();
      const isHex =
        (byte !== undefined && byte >= 0x30 && byte <= 0x39) ||
        (byte !== undefined && byte >= 0x61 && byte <= 0x66) ||
        (byte !== undefined && byte >= 0x41 && byte <= 0x46);
      if (!isHex) {
        break;
      }
      this.#pos += 1;
      consumed += 1;
    }
    return consumed;
  }

  /** Terminates an unterminated quoted template (lexer.rs:1738-1777). */
  terminateString(end: number): void {
    const frame = this.#stack[this.#stack.length - 1];
    if (frame === undefined || frame.kind !== 'Quoted') {
      throw new Error('internal: hcl quoted template frame expected');
    }
    const spanLen = end - frame.open;
    if (spanLen > this.#limits.maxStringLen) {
      throw this.fatalLimit('string-len', spanLen, this.#limits.maxStringLen);
    }
    if (spanLen > this.#limits.maxTemplateLen) {
      throw this.fatalLimit('template-len', spanLen, this.#limits.maxTemplateLen);
    }
    if (this.#emitting()) {
      // The terminating template is the outermost one: every token buffered
      // in it is discarded (lexer.rs:1758-1766), and the content becomes one
      // error region after the opening quote.
      this.#buffer = [];
      this.#stack.pop();
      this.emitErrorRegion(frame.open + 1, end, codeHclParseUnterminatedString, 'Syntax');
    } else {
      this.#stack.pop();
      this.recover(codeHclParseUnterminatedString, 'Syntax', frame.open + 1, end);
    }
  }

  /** Scans one heredoc content line or the closing marker line (lexer.rs:1257-1292). */
  scanHeredoc(): void {
    if (this.#pos >= this.#end) {
      this.terminateHeredoc(this.#end);
      return;
    }
    const emit = this.#emitting();
    const atLineStart = this.#pos === 0 || this.#bytes[this.#pos - 1] === 0x0a;
    const lineEnd = this.findLineEnd();
    if (atLineStart) {
      const frame = this.#stack[this.#stack.length - 1];
      const marker = frame.kind === 'Heredoc' ? frame.marker : '';
      const trimmed = this.textBytes(this.#pos, lineEnd).trim();
      if (trimmed === marker) {
        // The closing marker line; the whole line is HeredocClose.
        if (emit) {
          this.flushBuffer();
        }
        this.#stack.pop();
        if (emit) {
          this.emitKind('HeredocClose', this.#pos, lineEnd);
        }
        if (lineEnd < this.#end) {
          if (emit) {
            this.emitKind('LineBreak', lineEnd, lineEnd + 1);
          }
          this.#pos = lineEnd + 1;
        } else {
          this.#pos = lineEnd;
        }
        return;
      }
    }
    this.scanHeredocLine(lineEnd);
  }

  /** Template-scans one heredoc content line (lexer.rs:1297-1372). */
  scanHeredocLine(lineEnd: number): void {
    const emit = this.#emitting();
    const lineStart = this.#pos;
    let runStart = this.#pos;
    for (;;) {
      if (this.#pos >= lineEnd) {
        break;
      }
      const byte = this.#bytes[this.#pos];
      switch (byte) {
        case 0x24: {
          if (this.byteAt(1) === 0x24 && this.byteAt(2) === 0x7b) {
            this.#pos += 3;
          } else if (this.byteAt(1) === 0x7b) {
            this.endRun(runStart, emit, 'HeredocContent');
            this.openInterpolation(false, emit);
            return;
          } else {
            this.#pos += 1;
          }
          break;
        }
        case 0x25: {
          if (this.byteAt(1) === 0x25 && this.byteAt(2) === 0x7b) {
            this.#pos += 3;
          } else if (this.byteAt(1) === 0x7b) {
            this.endRun(runStart, emit, 'HeredocContent');
            this.openInterpolation(true, emit);
            return;
          } else {
            this.#pos += 1;
          }
          break;
        }
        case 0x0d: {
          if (this.#pos + 1 === lineEnd && this.byteAt(1) === 0x0a) {
            // The CR of a line-ending CRLF stays inside the content run.
            this.#pos += 1;
          } else {
            this.endRun(runStart, emit, 'HeredocContent');
            if (emit) {
              this.emitErrorRegion(this.#pos, this.#pos + 1, codeHclParseLoneCr, 'Lexical');
            } else {
              this.recover(codeHclParseLoneCr, 'Lexical', this.#pos, this.#pos + 1);
            }
            this.#pos += 1;
            runStart = this.#pos;
          }
          break;
        }
        default: {
          this.#pos += scalarAt(this.#bytes, this.#pos).width;
          break;
        }
      }
    }
    this.endRun(runStart, emit, 'HeredocContent');
    let lineBytes: number;
    if (lineEnd < this.#end) {
      if (emit) {
        this.emitKind('LineBreak', lineEnd, lineEnd + 1);
      }
      this.#pos = lineEnd + 1;
      lineBytes = this.#pos - lineStart;
    } else {
      this.#pos = lineEnd;
      lineBytes = this.#pos - lineStart;
    }
    this.noteHeredocLine(lineBytes);
  }

  /** Terminates an unterminated heredoc (lexer.rs:1783-1811). */
  terminateHeredoc(end: number): void {
    const frame = this.#stack[this.#stack.length - 1];
    if (frame === undefined || frame.kind !== 'Heredoc') {
      throw new Error('internal: hcl heredoc frame expected');
    }
    const bytes = end - frame.contentStart;
    if (bytes > this.#limits.maxHeredocBytes) {
      throw this.fatalLimit('heredoc-bytes', bytes, this.#limits.maxHeredocBytes);
    }
    if (this.#emitting()) {
      // The terminating heredoc is the outermost template: the buffered
      // content tokens are discarded and the content becomes one error
      // region (lexer.rs:1783-1811).
      this.#buffer = [];
      this.#stack.pop();
      this.emitErrorRegion(frame.contentStart, end, codeHclParseUnterminatedHeredoc, 'Syntax');
    } else {
      this.#stack.pop();
      this.recover(codeHclParseUnterminatedHeredoc, 'Syntax', frame.contentStart, end);
    }
  }

  /** Ends the current literal run as one content token when non-empty (lexer.rs:1813-1824). */
  endRun(runStart: number, emit: boolean, kind: HclTokenKind): void {
    if (emit && this.#pos > runStart) {
      this.emitKind(kind, runStart, this.#pos);
    }
  }

  /** Appends the top frame's buffered tokens to the stream (lexer.rs:1826-1840). */
  flushBuffer(): void {
    this.#tokens.push(...this.#buffer);
    this.#buffer = [];
  }

  /** Pops the template stack at end of source (lexer.rs:1994-2025). */
  finishEof(): void {
    for (;;) {
      const frame = this.#stack[this.#stack.length - 1];
      if (frame === undefined) {
        break;
      }
      if (frame.kind === 'Interp') {
        const code = frame.directive ? codeHclParseUnterminatedDirective : codeHclParseUnterminatedInterpolation;
        this.#stack.pop();
        this.recover(code, 'Syntax', frame.interiorStart, this.#end);
      } else if (frame.kind === 'Quoted') {
        this.terminateString(this.#end);
      } else {
        this.terminateHeredoc(this.#end);
      }
    }
  }

  /** Scans interpolation/directive interior bytes (the absorbing scanner, lexer.rs:880-1127). */
  scanAbsorb(): void {
    const frame = this.#stack[this.#stack.length - 1];
    const byte = this.byte()!;
    if (byte === 0x7b) {
      const top = this.#stack[this.#stack.length - 1];
      if (top.kind === 'Interp') {
        this.#stack[this.#stack.length - 1] = { ...top, depth: top.depth + 1 };
      }
      this.#pos += 1;
      return;
    }
    let closeWidth: number | null = null;
    if (byte === 0x7d) {
      closeWidth = frame.kind === 'Interp' && frame.depth === 0 ? 1 : null;
    } else if (byte === 0x7e) {
      closeWidth = frame.kind === 'Interp' && frame.depth === 0 && this.byteAt(1) === 0x7d ? 2 : null;
    }
    if (closeWidth !== null) {
      const closeStart = this.#pos;
      this.#pos += closeWidth;
      const contentKind = frame.kind === 'Interp' && frame.directive ? 'DirectiveContent' : 'InterpolationContent';
      const closeKind = frame.kind === 'Interp' && frame.directive ? 'DirectiveClose' : 'InterpolationClose';
      const interiorStart = frame.kind === 'Interp' ? frame.interiorStart : closeStart;
      this.#stack.pop();
      if (this.#emitting()) {
        this.emit({ kind: contentKind, startByte: interiorStart, endByte: closeStart });
        this.emit({ kind: closeKind, startByte: closeStart, endByte: this.#pos });
      }
      return;
    }
    if (byte === 0x7d) {
      const top = this.#stack[this.#stack.length - 1];
      if (top.kind === 'Interp') {
        this.#stack[this.#stack.length - 1] = { ...top, depth: top.depth - 1 };
      }
      this.#pos += 1;
      return;
    }
    switch (byte) {
      case 0x20:
      case 0x09: {
        while (this.byte() === 0x20 || this.byte() === 0x09) {
          this.#pos += 1;
        }
        return;
      }
      case 0x2e: {
        if (this.byteAt(1) === 0x2e && this.byteAt(2) === 0x2e) {
          this.#pos += 3;
        } else {
          this.#pos += 1;
        }
        return;
      }
      case 0x2b:
      case 0x2d:
      case 0x2a:
      case 0x25:
      case 0x3f:
      case 0x2c:
      case 0x28:
      case 0x29:
      case 0x5b:
      case 0x5d:
      case 0x3a: {
        if (byte === 0x3a && this.byteAt(1) === 0x3a) {
          this.recover(codeHclParseInvalidCharacter, 'Syntax', this.#pos, this.#pos + 2);
          this.#pos += 2;
          return;
        }
        this.#pos += 1;
        return;
      }
      case 0x5c:
      case 0x24: {
        this.recover(codeHclParseInvalidCharacter, 'Syntax', this.#pos, this.#pos + 1);
        this.#pos += 1;
        return;
      }
      case 0x3d: {
        if (this.byteAt(1) === 0x3d || this.byteAt(1) === 0x3e) {
          this.#pos += 2;
        } else {
          this.#pos += 1;
        }
        return;
      }
      case 0x3c: {
        if (this.byteAt(1) === 0x3c) {
          this.openHeredoc(false);
        } else if (this.byteAt(1) === 0x3d) {
          this.#pos += 2;
        } else {
          this.#pos += 1;
        }
        return;
      }
      case 0x3e:
      case 0x21: {
        if (this.byteAt(1) === 0x3d) {
          this.#pos += 2;
        } else {
          this.#pos += 1;
        }
        return;
      }
      case 0x26: {
        if (this.byteAt(1) === 0x26) {
          this.#pos += 2;
        } else {
          this.recover(codeHclParseInvalidCharacter, 'Syntax', this.#pos, this.#pos + 1);
          this.#pos += 1;
        }
        return;
      }
      case 0x7c: {
        if (this.byteAt(1) === 0x7c) {
          this.#pos += 2;
        } else {
          this.recover(codeHclParseInvalidCharacter, 'Syntax', this.#pos, this.#pos + 1);
          this.#pos += 1;
        }
        return;
      }
      case 0x22: {
        const open = this.#pos;
        this.#pos += 1;
        this.checkTemplateDepth();
        this.#stack.push({ kind: 'Quoted', open });
        return;
      }
      case 0x0a: {
        this.#pos += 1;
        return;
      }
      case 0x0d: {
        if (this.byteAt(1) === 0x0a) {
          this.#pos += 2;
        } else {
          this.recover(codeHclParseLoneCr, 'Lexical', this.#pos, this.#pos + 1);
          this.#pos += 1;
        }
        return;
      }
      case 0x2f: {
        if (this.byteAt(1) === 0x2f) {
          this.scanLineComment(false);
        } else if (this.byteAt(1) === 0x2a) {
          this.scanInlineComment(false);
        } else {
          this.#pos += 1;
        }
        return;
      }
      case 0x23: {
        this.scanLineComment(false);
        return;
      }
      default: {
        const scalar = scalarAt(this.#bytes, this.#pos);
        if (scalar.character >= '0' && scalar.character <= '9') {
          this.scanNumber(false);
        } else if (scalar.character === '\uFEFF') {
          this.recover(codeHclParseByteOrderMark, 'Encoding', this.#pos, this.#pos + 3);
          this.#pos += 3;
        } else if (scalar.character === '_') {
          this.recover(codeHclParseIdentifier, 'Syntax', this.#pos, this.#pos + 1);
          this.#pos += 1;
        } else if (isIdentifierStart(scalar.character)) {
          this.scanIdentifier(false);
        } else {
          this.recover(codeHclParseInvalidCharacter, 'Syntax', this.#pos, this.#pos + scalar.width);
          this.#pos += scalar.width;
        }
        return;
      }
    }
  }

  findLineEnd(): number {
    for (let at = this.#pos; at < this.#end; at++) {
      if (this.#bytes[at] === 0x0a) {
        return at;
      }
    }
    return this.#end;
  }

  /** Exact ASCII/UTF-8 text of one byte range (the source is pre-validated UTF-8). */
  textBytes(start: number, end: number): string {
    let out = '';
    let pos = start;
    while (pos < end) {
      const { character, width } = scalarAt(this.#bytes, pos);
      out += character;
      pos += width;
    }
    return out;
  }

  finish(): HclLexOutput {
    const tokens = [...this.#tokens, { kind: 'Eof' as const, startByte: this.#end, endByte: this.#end }];
    let pieces: StructuralPiece[] | null = null;
    let syntaxKinds: HclSyntaxKind[] = [];
    if (this.#buildIndex) {
      pieces = [];
      for (const token of tokens) {
        const kind = tokenSyntaxKind(token.kind);
        if (kind === null) {
          continue;
        }
        pieces.push(new StructuralPiece(this.span(token.startByte, token.endByte), tokenStructuralKind(token.kind)));
        syntaxKinds.push(kind);
      }
    }
    const diagnostics = [...this.#diagnostics].sort((left, right) => {
      const leftStart = left.primary?.startByte ?? BigInt(Number.MAX_SAFE_INTEGER);
      const rightStart = right.primary?.startByte ?? BigInt(Number.MAX_SAFE_INTEGER);
      if (leftStart !== rightStart) {
        return leftStart < rightStart ? -1 : 1;
      }
      if (left.category !== right.category) {
        return left.category < right.category ? -1 : 1;
      }
      if (left.code !== right.code) {
        return left.code < right.code ? -1 : 1;
      }
      return 0;
    });
    return {
      tokens,
      errorRegions: [...this.#errorRegions],
      diagnostics,
      recovered: this.#recovered,
      pieces,
      syntaxKinds,
    };
  }
}

/** Whether one hex range is a valid `\u`/`\U` escape value (lexer.rs:1551-1564). */
function validUnicodeEscape(bytes: Uint8Array, start: number, end: number): boolean {
  let value = 0;
  for (let pos = start; pos < end; pos++) {
    const byte = bytes[pos];
    value = value * 16 + hexValue(byte);
  }
  return value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff);
}

function hexValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  return byte - 0x41 + 10;
}

/**
 * Lexes one whole HCL source into tokens, recovery regions, diagnostics,
 * and the lossless piece index (lexer.rs:432-455). The caller has already
 * validated the UTF-8 source and the common limits.
 */
export function lexHclSource(
  bytes: Uint8Array,
  authority: DocumentAuthority,
  limits: HclParseLimits,
): HclLexOutput {
  const lexer = new Lexer(bytes, authority, limits, 0, bytes.length, true);
  lexer.scan();
  return lexer.finish();
}

/**
 * Re-lexes one interpolation/directive interior as a token stream bound to
 * the same authority; never emits pieces (lexer.rs:444-455 region lex).
 */
export function lexHclRegion(
  bytes: Uint8Array,
  authority: DocumentAuthority,
  limits: HclParseLimits,
  start: number,
  end: number,
): HclLexOutput {
  const lexer = new Lexer(bytes, authority, limits, start, end, false);
  lexer.scan();
  return lexer.finish();
}
