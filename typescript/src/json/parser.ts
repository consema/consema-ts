/**
 * Lossless JSON/JSONC/JSON5 parsing into the immutable document model.
 *
 * authority (language-neutral behavior, byte-exact spans, recovery):
 *  - crates/consema-json/src/parser.rs — lex :174-402 (strict/JSONC), lex_json5
 *    :404-581, JSON5 whitespace :590-614 (RFC 0005 §3), identifier
 *    classification :616-687 (RFC 0005 §4; Consema pins
 *    unicode-id-start 1.4.0 / Unicode 17.0.0), number candidates :689-760,
 *    valid_json_number :776-815, Parser :817-1225 (parse_value :830-951,
 *    parse_object :953-1069, parse_array :1071-1133, parse_object_key
 *    :1135-1145), decode_json_string :1232-1315, decode_json5_identifier
 *    :1349-1373, parse_json5_number :1375-1443, DiagnosticSink
 *    :1500-1537 (occurrence ordinals, core.diagnostic.truncated@1 marker)
 *  - source and encoding: crates/consema-document/src/lib.rs:643-761
 *    (FatalFormationFailure; codes in crates/consema-protocol/src/
 *    error_registry.rs:207, 372, 366, 405, 399)
 *  - profiles: crates/consema-json/src/lib.rs:137-159 (RFC 0005 §1)
 *  - vector-pinned behavior: conformance/vectors/json-family-v2.json
 *    (all json5.parse.* / json5.reject.* / json.strict.* / jsonc.* cases),
 *    conformance/vectors/v1.json (parse.strict-exact-roundtrip,
 *    parse.jsonc-comments-trailing-comma, parse.recovery-missing-close,
 *    parse.duplicate-members, parse.lossless-byte-coverage,
 *    resource.parse-token-limit)
 *
 * RECORDED DIVERGENCE RISK (blind-write, L1): the Rust lexer classifies
 * JSON5 identifiers with the pinned `unicode-id-start` 1.4.0 tables
 * (Unicode 17.0.0, RFC 0005 §4 :82-85). TypeScript has no Unicode tables
 * in the standard library; this implementation uses the host regex
 * property escapes `\p{ID_Start}` / `\p{ID_Continue}` (ES2018+, Node 26).
 * The vectors exercise only version-stable characters ($, _, letters,
 * ZWNJ/ZWJ, escaped forms), so conformance is unaffected; a future
 * Unicode-version audit is recorded as a follow-up.
 *
 * Design (TypeScript-idiomatic): one lexer walks the decoded UTF-8 text
 * as code points while tracking exact raw byte offsets (the decoded byte
 * offsets equal the raw byte offsets for UTF-8); token literals are
 * accumulated as raw text during scanning. The parser builds the
 * immutable `JsonDocument` with typed entities, or throws
 * `FatalFormationFailure` — no partial document ever exists.
 */

import { DocumentAuthority, Span } from '../document/identity.ts';
import { LosslessStructuralIndex, StructuralPiece } from '../document/structural.ts';
import { SourceSnapshot } from '../document/source.ts';
import { diagnostic, sortDiagnostics } from '../document/diagnostic.ts';
import type { Diagnostic } from '../document/diagnostic.ts';
import type { FormationStatus, ParseLimits } from '../document/formation.ts';
import { decimalValue } from '../core/value.ts';
import { SourceError } from '../document/errors.ts';
import { FatalFormationFailure } from './errors.ts';
import { JsonDocument } from './document.ts';
import type { Entity, InternalValueKind } from './document.ts';
import { isJson5, permitsJsoncExtensions } from './profile.ts';
import type { JsonProfile } from './profile.ts';
import type { JsonSyntaxKind } from './syntax.ts';

// ---------------------------------------------------------------------------
// Tokens and lexemes
// ---------------------------------------------------------------------------

type TokenKind =
  | 'LeftBrace'
  | 'RightBrace'
  | 'LeftBracket'
  | 'RightBracket'
  | 'Colon'
  | 'Comma'
  | 'String'
  | 'Identifier'
  | 'Number'
  | 'True'
  | 'False'
  | 'Null';

interface Token {
  readonly kind: TokenKind;
  readonly start: number;
  readonly end: number;
  /** Exact raw literal text of the token (escapes preserved). */
  readonly text: string;
}

type LexemeClass =
  | { readonly kind: 'Token'; readonly token: TokenKind; readonly literal?: string }
  | { readonly kind: 'Trivia'; readonly syntax: JsonSyntaxKind }
  | { readonly kind: 'Error' };

interface Lexeme {
  readonly start: number;
  readonly end: number;
  readonly class: LexemeClass;
}

interface Lexed {
  readonly lexemes: readonly Lexeme[];
  readonly tokens: readonly Token[];
  readonly recovered: boolean;
}

/** The strict/JSONC lexer (parser.rs:174-402). */
function lex(
  text: string,
  profile: JsonProfile,
  authority: DocumentAuthority,
  limits: ParseLimits,
  diagnostics: DiagnosticSink,
): Lexed {
  if (isJson5(profile)) {
    return lexJson5(text, authority, limits, diagnostics);
  }
  const lexemes: Lexeme[] = [];
  const tokens: Token[] = [];
  const walker = new SourceWalker(text);
  let recovered = false;
  if (text.startsWith('\uFEFF')) {
    lexemes.push({ start: 0, end: 3, class: { kind: 'Trivia', syntax: 'Bom' } });
    if (profile === 'JsonStrict') {
      diagnostics.push(
        sourceDiagnostic(authority, 'json.strict.leading-bom@1', 'Conformance', 'Warning', 0, 3),
      );
    }
    walker.consumeBom();
  }
  while (!walker.atEnd()) {
    const start = walker.byteOffset();
    const character = walker.peek()!;
    let class_: LexemeClass;
    let literal: string | null = null;
    if (character === ' ' || character === '\t' || character === '\r' || character === '\n') {
      walker.next();
      while (!walker.atEnd() && isJsonWhitespace(walker.peek()!)) {
        walker.next();
      }
      class_ = { kind: 'Trivia', syntax: 'Whitespace' };
    } else if (character === '/' && walker.startsWith('//')) {
      walker.next();
      walker.next();
      while (!walker.atEnd() && walker.peek() !== '\r' && walker.peek() !== '\n') {
        walker.next();
      }
      if (!permitsJsoncExtensions(profile)) {
        recovered = true;
        diagnostics.push(
          sourceDiagnostic(
            authority,
            'json.strict.comment-not-allowed@1',
            'Conformance',
            'Error',
            start,
            walker.byteOffset(),
          ),
        );
      }
      class_ = { kind: 'Trivia', syntax: 'LineComment' };
    } else if (character === '/' && walker.startsWith('/*')) {
      walker.next();
      walker.next();
      let closed = false;
      while (!walker.atEnd()) {
        if (walker.peek() === '*' && walker.peekAt(1) === '/') {
          walker.next();
          walker.next();
          closed = true;
          break;
        }
        walker.next();
      }
      if (closed) {
        if (!permitsJsoncExtensions(profile)) {
          recovered = true;
          diagnostics.push(
            sourceDiagnostic(
              authority,
              'json.strict.comment-not-allowed@1',
              'Conformance',
              'Error',
              start,
              walker.byteOffset(),
            ),
          );
        }
        class_ = { kind: 'Trivia', syntax: 'BlockComment' };
      } else {
        recovered = true;
        diagnostics.push(
          sourceDiagnostic(
            authority,
            'json.syntax.unterminated-block-comment@1',
            'Syntax',
            'Error',
            start,
            walker.byteOffset(),
          ),
        );
        class_ = { kind: 'Error' };
      }
    } else if (isSingleToken(character)) {
      walker.next();
      class_ = { kind: 'Token', token: singleTokenKind(character) };
    } else if (character === '"') {
      class_ = lexStrictString(walker, start, (code, s, e) => {
        recovered = true;
        diagnostics.push(sourceDiagnostic(authority, code, 'Syntax', 'Error', s, e));
      });
    } else if (character === '-' || isAsciiDigit(character.codePointAt(0)!)) {
      const buffer: string[] = [walker.next()!];
      while (!walker.atEnd() && isNumberScanChar(walker.peek()!)) {
        buffer.push(walker.next()!);
      }
      literal = buffer.join('');
      if (validJsonNumber(literal)) {
        class_ = { kind: 'Token', token: 'Number' };
      } else {
        recovered = true;
        diagnostics.push(
          sourceDiagnostic(
            authority,
            'json.syntax.invalid-number@1',
            'Syntax',
            'Error',
            start,
            walker.byteOffset(),
          ),
        );
        class_ = { kind: 'Error' };
      }
    } else if (isWordStart(character)) {
      const buffer: string[] = [walker.next()!];
      while (!walker.atEnd() && isWordContinue(walker.peek()!)) {
        buffer.push(walker.next()!);
      }
      literal = buffer.join('');
      if (literal === 'true') {
        class_ = { kind: 'Token', token: 'True' };
      } else if (literal === 'false') {
        class_ = { kind: 'Token', token: 'False' };
      } else if (literal === 'null') {
        class_ = { kind: 'Token', token: 'Null' };
      } else {
        recovered = true;
        diagnostics.push(
          sourceDiagnostic(
            authority,
            'json.syntax.unexpected-word@1',
            'Syntax',
            'Error',
            start,
            walker.byteOffset(),
          ),
        );
        class_ = { kind: 'Error' };
      }
    } else {
      walker.next();
      recovered = true;
      diagnostics.push(
        sourceDiagnostic(
          authority,
          'json.syntax.unexpected-character@1',
          'Syntax',
          'Error',
          start,
          walker.byteOffset(),
        ),
      );
      class_ = { kind: 'Error' };
    }
    pushLexeme(lexemes, tokens, start, walker.byteOffset(), class_, literal, limits);
  }
  return { lexemes, tokens, recovered };
}

/** The Standard JSON5 lexical surface (parser.rs:404-581). */
function lexJson5(
  text: string,
  authority: DocumentAuthority,
  limits: ParseLimits,
  diagnostics: DiagnosticSink,
): Lexed {
  const lexemes: Lexeme[] = [];
  const tokens: Token[] = [];
  const walker = new SourceWalker(text);
  let recovered = false;
  if (text.startsWith('\uFEFF')) {
    lexemes.push({ start: 0, end: 3, class: { kind: 'Trivia', syntax: 'Bom' } });
    walker.consumeBom();
  }
  while (!walker.atEnd()) {
    const start = walker.byteOffset();
    const character = walker.peek()!;
    let class_: LexemeClass;
    let literal: string | null = null;
    if (isJson5WhitespaceCodePoint(character.codePointAt(0)!)) {
      walker.next();
      while (!walker.atEnd() && isJson5WhitespaceCodePoint(walker.peek()!.codePointAt(0)!)) {
        walker.next();
      }
      class_ = { kind: 'Trivia', syntax: 'Whitespace' };
    } else if (walker.startsWith('//')) {
      walker.next();
      walker.next();
      while (!walker.atEnd() && !isJson5LineTerminator(walker.peek()!.codePointAt(0)!)) {
        walker.next();
      }
      class_ = { kind: 'Trivia', syntax: 'LineComment' };
    } else if (walker.startsWith('/*')) {
      walker.next();
      walker.next();
      let closed = false;
      while (!walker.atEnd()) {
        if (walker.peek() === '*' && walker.peekAt(1) === '/') {
          walker.next();
          walker.next();
          closed = true;
          break;
        }
        walker.next();
      }
      if (closed) {
        class_ = { kind: 'Trivia', syntax: 'BlockComment' };
      } else {
        recovered = true;
        diagnostics.push(
          sourceDiagnostic(
            authority,
            'json.syntax.unterminated-block-comment@1',
            'Syntax',
            'Error',
            start,
            walker.byteOffset(),
          ),
        );
        class_ = { kind: 'Error' };
      }
    } else if (isSingleToken(character)) {
      walker.next();
      class_ = { kind: 'Token', token: singleTokenKind(character) };
    } else if (character === "'" || character === '"') {
      class_ = lexJson5String(walker, start, (code, s, e) => {
        recovered = true;
        diagnostics.push(sourceDiagnostic(authority, code, 'Syntax', 'Error', s, e));
      });
    } else if (
      character === '+' ||
      character === '-' ||
      character === '.' ||
      isAsciiDigit(character.codePointAt(0)!)
    ) {
      const next = walker.peekAt(1);
      if (character === '.' && (next === null || !isAsciiDigit(next.codePointAt(0)!))) {
        walker.next();
        recovered = true;
        diagnostics.push(
          sourceDiagnostic(
            authority,
            'json.syntax.unexpected-character@1',
            'Syntax',
            'Error',
            start,
            walker.byteOffset(),
          ),
        );
        class_ = { kind: 'Error' };
      } else {
        const buffer: string[] = [walker.next()!];
        while (!walker.atEnd() && isNumberScanChar5(walker.peek()!)) {
          buffer.push(walker.next()!);
        }
        literal = buffer.join('');
        if (validJson5Number(literal)) {
          class_ = { kind: 'Token', token: 'Number' };
        } else {
          recovered = true;
          diagnostics.push(
            sourceDiagnostic(
              authority,
              'json.syntax.invalid-number@1',
              'Syntax',
              'Error',
              start,
              walker.byteOffset(),
            ),
          );
          class_ = { kind: 'Error' };
        }
      }
    } else if (character === '\\' || isJson5IdentifierStart(character)) {
      const scanned = scanJson5Identifier(walker);
      if (scanned.valid) {
        class_ = { kind: 'Token', token: 'Identifier' };
        literal = scanned.literal;
      } else {
        recovered = true;
        diagnostics.push(
          sourceDiagnostic(
            authority,
            'json5.syntax.invalid-identifier@1',
            'Syntax',
            'Error',
            start,
            walker.byteOffset(),
          ),
        );
        class_ = { kind: 'Error' };
      }
    } else {
      walker.next();
      recovered = true;
      diagnostics.push(
        sourceDiagnostic(
          authority,
          'json.syntax.unexpected-character@1',
          'Syntax',
          'Error',
          start,
          walker.byteOffset(),
        ),
      );
      class_ = { kind: 'Error' };
    }
    pushLexeme(lexemes, tokens, start, walker.byteOffset(), class_, literal, limits);
  }
  return { lexemes, tokens, recovered };
}

/** Appends one lexeme and optional token; enforces the token-count limit (parser.rs:382-395, 561-574). */
function pushLexeme(
  lexemes: Lexeme[],
  tokens: Token[],
  start: number,
  end: number,
  class_: LexemeClass,
  literal: string | null,
  limits: ParseLimits,
): void {
  if (class_.kind === 'Token') {
    tokens.push({ kind: class_.token, start, end, text: class_.literal ?? literal ?? '' });
  }
  lexemes.push({ start, end, class: class_ });
  if (lexemes.length > limits.maxTokenCount) {
    throw FatalFormationFailure.resourceLimit('token-count', lexemes.length, limits.maxTokenCount);
  }
}

/** Scans one complete double-quoted strict string token (parser.rs:285-314). */
function lexStrictString(
  walker: SourceWalker,
  start: number,
  recover: (code: string, start: number, end: number) => void,
): LexemeClass {
  const literal: string[] = [walker.next()!];
  let escaped = false;
  let closed = false;
  while (!walker.atEnd()) {
    const octet = walker.next()!;
    literal.push(octet);
    if (escaped) {
      escaped = false;
    } else if (octet === '\\') {
      escaped = true;
    } else if (octet === '"') {
      closed = true;
      break;
    }
  }
  if (closed) {
    return { kind: 'Token', token: 'String', literal: literal.join('') };
  }
  recover('json.syntax.unterminated-string@1', start, walker.byteOffset());
  return { kind: 'Error' };
}

/** Scans one complete single- or double-quoted JSON5 string token (parser.rs:469-502). */
function lexJson5String(
  walker: SourceWalker,
  start: number,
  recover: (code: string, start: number, end: number) => void,
): LexemeClass {
  const quote = walker.next()!;
  const literal: string[] = [quote];
  let closed = false;
  while (!walker.atEnd()) {
    const current = walker.next()!;
    literal.push(current);
    if (current === '\\') {
      if (!walker.atEnd()) {
        const escaped = walker.next()!;
        literal.push(escaped);
        if (escaped === '\r' && walker.startsWith('\n')) {
          literal.push(walker.next()!);
        }
      }
    } else if (current === quote) {
      closed = true;
      break;
    }
  }
  if (closed) {
    return { kind: 'Token', token: 'String', literal: literal.join('') };
  }
  recover('json.syntax.unterminated-string@1', start, walker.byteOffset());
  return { kind: 'Error' };
}

// ---------------------------------------------------------------------------
// JSON5 lexical predicates (parser.rs:590-687; RFC 0005 §3/§4)
// ---------------------------------------------------------------------------

const ID_START = /\p{ID_Start}/u;
const ID_CONTINUE = /\p{ID_Continue}/u;

function isJson5LineTerminator(codePoint: number): boolean {
  return (
    codePoint === 0x0a ||
    codePoint === 0x0d ||
    codePoint === 0x2028 ||
    codePoint === 0x2029
  );
}

/** JSON5 whitespace is the exact union of RFC 0005 §3 (parser.rs:594-614); never the host predicate. */
function isJson5WhitespaceCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x0009 ||
    codePoint === 0x000a ||
    codePoint === 0x000b ||
    codePoint === 0x000c ||
    codePoint === 0x000d ||
    codePoint === 0x0020 ||
    codePoint === 0x00a0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000 ||
    codePoint === 0xfeff
  );
}

function isJson5IdentifierStart(character: string): boolean {
  return character === '$' || character === '_' || ID_START.test(character);
}

function isJson5IdentifierContinue(character: string): boolean {
  return (
    character === '$' ||
    character === '_' ||
    character === '\u200C' ||
    character === '\u200D' ||
    ID_CONTINUE.test(character)
  );
}

/** Scans one IdentifierName candidate; escapes decode before position rules (parser.rs:625-658). */
function scanJson5Identifier(walker: SourceWalker): { valid: boolean; literal: string } {
  let first = true;
  let valid = true;
  const literal: string[] = [];
  while (!walker.atEnd()) {
    const character = walker.peek()!;
    let decoded: string;
    if (character === '\\') {
      const decodedEscape = decodeIdentifierEscape(walker.text(), walker.charIndex());
      if (decodedEscape === null) {
        valid = false;
        scanJson5InvalidWord(walker);
        break;
      }
      decoded = decodedEscape;
    } else {
      decoded = character;
    }
    const permitted = first ? isJson5IdentifierStart(decoded) : isJson5IdentifierContinue(decoded);
    if (!permitted) {
      if (first || character === '\\') {
        valid = false;
        scanJson5InvalidWord(walker);
      }
      break;
    }
    if (character === '\\') {
      // Consumes `\uXXXX` (six ASCII characters, parser.rs:677-687).
      walker.next();
      walker.next();
      for (let i = 0; i < 4; i++) {
        walker.next();
      }
      literal.push('\\u', walker.text().slice(walker.charIndex() - 4, walker.charIndex()));
    } else {
      walker.next();
      literal.push(character);
    }
    first = false;
  }
  return { valid: valid && !first, literal: literal.join('') };
}

/** Consumes the invalid word tail after an identifier failure (parser.rs:660-675). */
function scanJson5InvalidWord(walker: SourceWalker): void {
  while (!walker.atEnd()) {
    const character = walker.peek()!;
    if (
      isJson5WhitespaceCodePoint(character.codePointAt(0)!) ||
      character === '{' ||
      character === '}' ||
      character === '[' ||
      character === ']' ||
      character === ':' ||
      character === ',' ||
      character === '/' ||
      character === "'" ||
      character === '"'
    ) {
      break;
    }
    walker.next();
  }
}

/** Decodes one `\uXXXX` identifier escape (parser.rs:677-687). */
function decodeIdentifierEscape(text: string, charIndex: number): string | null {
  if (!text.startsWith('\\u', charIndex) || charIndex + 6 > text.length) {
    return null;
  }
  const digits = text.slice(charIndex + 2, charIndex + 6);
  if (!/^[0-9a-fA-F]{4}$/.test(digits)) {
    return null;
  }
  const value = Number.parseInt(digits, 16);
  // Isolated surrogates cannot be identifier characters.
  if (value >= 0xd800 && value <= 0xdfff) {
    return null;
  }
  return String.fromCodePoint(value);
}

/** Consumes one JSON5 number candidate (parser.rs:689-699). */
function isNumberScanChar5(character: string): boolean {
  const codePoint = character.codePointAt(0)!;
  return (
    isAsciiAlphanumeric(codePoint) ||
    character === '+' ||
    character === '-' ||
    character === '.' ||
    character === '_'
  );
}

// ---------------------------------------------------------------------------
// ASCII predicates
// ---------------------------------------------------------------------------

function isAsciiDigit(codePoint: number): boolean {
  return codePoint >= 0x30 && codePoint <= 0x39;
}

function isAsciiAlphanumeric(codePoint: number): boolean {
  return (
    (codePoint >= 0x30 && codePoint <= 0x39) ||
    (codePoint >= 0x41 && codePoint <= 0x5a) ||
    (codePoint >= 0x61 && codePoint <= 0x7a)
  );
}

function isJsonWhitespace(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\r' || character === '\n';
}

function isNumberScanChar(character: string): boolean {
  const codePoint = character.codePointAt(0)!;
  return (
    isAsciiDigit(codePoint) ||
    character === '+' ||
    character === '-' ||
    character === '.' ||
    character === 'e' ||
    character === 'E'
  );
}

function isWordStart(character: string): boolean {
  const codePoint = character.codePointAt(0)!;
  return (
    (codePoint >= 0x61 && codePoint <= 0x7a) ||
    (codePoint >= 0x41 && codePoint <= 0x5a) ||
    character === '_'
  );
}

function isWordContinue(character: string): boolean {
  const codePoint = character.codePointAt(0)!;
  return (
    (codePoint >= 0x61 && codePoint <= 0x7a) ||
    (codePoint >= 0x41 && codePoint <= 0x5a) ||
    isAsciiDigit(codePoint) ||
    character === '_'
  );
}

function isSingleToken(character: string): boolean {
  return (
    character === '{' ||
    character === '}' ||
    character === '[' ||
    character === ']' ||
    character === ':' ||
    character === ','
  );
}

function singleTokenKind(character: string): TokenKind {
  switch (character) {
    case '{':
      return 'LeftBrace';
    case '}':
      return 'RightBrace';
    case '[':
      return 'LeftBracket';
    case ']':
      return 'RightBracket';
    case ':':
      return 'Colon';
    case ',':
      return 'Comma';
    default:
      throw new Error(`internal: not a single token: ${character}`);
  }
}

// ---------------------------------------------------------------------------
// Number validation (parser.rs:701-760, 776-815)
// ---------------------------------------------------------------------------

/** RFC-style JSON number grammar (parser.rs:776-815). */
function validJsonNumber(text: string): boolean {
  let index = 0;
  if (text[index] === '-') {
    index += 1;
  }
  const first = text[index];
  if (first === '0') {
    index += 1;
  } else if (first >= '1' && first <= '9') {
    index += 1;
    while (index < text.length && text[index] >= '0' && text[index] <= '9') {
      index += 1;
    }
  } else {
    return false;
  }
  if (text[index] === '.') {
    index += 1;
    const fractionStart = index;
    while (index < text.length && text[index] >= '0' && text[index] <= '9') {
      index += 1;
    }
    if (index === fractionStart) {
      return false;
    }
  }
  if (text[index] === 'e' || text[index] === 'E') {
    index += 1;
    if (text[index] === '+' || text[index] === '-') {
      index += 1;
    }
    const exponentStart = index;
    while (index < text.length && text[index] >= '0' && text[index] <= '9') {
      index += 1;
    }
    if (index === exponentStart) {
      return false;
    }
  }
  return index === text.length;
}

/** Standard JSON5 number grammar (parser.rs:701-760). */
function validJson5Number(text: string): boolean {
  const unsigned = text.startsWith('+') || text.startsWith('-') ? text.slice(1) : text;
  if (unsigned === 'Infinity' || unsigned === 'NaN') {
    return true;
  }
  if (unsigned.startsWith('0x') || unsigned.startsWith('0X')) {
    const hex = unsigned.slice(2);
    return hex.length > 0 && /^[0-9a-fA-F]+$/.test(hex);
  }
  let index = 0;
  if (unsigned[index] === '.') {
    index += 1;
    const start = index;
    while (index < unsigned.length && unsigned[index] >= '0' && unsigned[index] <= '9') {
      index += 1;
    }
    if (index === start) {
      return false;
    }
  } else {
    const first = unsigned[index];
    if (first === '0') {
      index += 1;
      if (unsigned[index] >= '0' && unsigned[index] <= '9') {
        return false;
      }
    } else if (first >= '1' && first <= '9') {
      index += 1;
      while (index < unsigned.length && unsigned[index] >= '0' && unsigned[index] <= '9') {
        index += 1;
      }
    } else {
      return false;
    }
    if (unsigned[index] === '.') {
      index += 1;
      while (index < unsigned.length && unsigned[index] >= '0' && unsigned[index] <= '9') {
        index += 1;
      }
    }
  }
  if (unsigned[index] === 'e' || unsigned[index] === 'E') {
    index += 1;
    if (unsigned[index] === '+' || unsigned[index] === '-') {
      index += 1;
    }
    const exponentStart = index;
    while (index < unsigned.length && unsigned[index] >= '0' && unsigned[index] <= '9') {
      index += 1;
    }
    if (index === exponentStart) {
      return false;
    }
  }
  return index === unsigned.length;
}

// ---------------------------------------------------------------------------
// Number decoding (parser.rs:1375-1443)
// ---------------------------------------------------------------------------

/** Exact JSON5 number semantics: non-finite bits, hex, normalized decimal/integer (parser.rs:1375-1443). */
function parseJson5Number(text: string): InternalValueKind {
  const negative = text.startsWith('-');
  const unsigned = text.startsWith('+') || text.startsWith('-') ? text.slice(1) : text;
  if (unsigned === 'Infinity') {
    return {
      kind: 'BinaryFloat64',
      bits: negative ? 0xfff0000000000000n : 0x7ff0000000000000n,
    };
  }
  if (unsigned === 'NaN') {
    return { kind: 'BinaryFloat64', bits: negative ? 0xfff8000000000000n : 0x7ff8000000000000n };
  }
  if (unsigned.startsWith('0x') || unsigned.startsWith('0X')) {
    const magnitude = BigInt('0x' + unsigned.slice(2));
    return { kind: 'Integer', value: negative ? -magnitude : magnitude };
  }
  let normalized = negative ? '-' + unsigned : unsigned;
  const signWidth = negative ? 1 : 0;
  if (normalized[signWidth] === '.') {
    normalized = normalized.slice(0, signWidth) + '0' + normalized.slice(signWidth);
  }
  const exponentIndex = normalized.search(/[eE]/);
  if (exponentIndex !== -1 && normalized.slice(0, exponentIndex).endsWith('.')) {
    normalized = normalized.slice(0, exponentIndex) + '0' + normalized.slice(exponentIndex);
  }
  if (/[.eE]/.test(normalized)) {
    const { coefficient, exponent } = parseJsonDecimal(normalized);
    return { kind: 'Decimal', coefficient, exponent };
  }
  return { kind: 'Integer', value: BigInt(normalized) };
}

/** Exact decimal from a JSON number literal; canonical trailing-zero normalization (value.rs:277-292). */
function parseJsonDecimal(text: string): { coefficient: bigint; exponent: bigint } {
  const exponentIndex = text.search(/[eE]/);
  const mantissa = exponentIndex === -1 ? text : text.slice(0, exponentIndex);
  const exponentText = exponentIndex === -1 ? '' : text.slice(exponentIndex + 1);
  const dotIndex = mantissa.indexOf('.');
  const digits =
    (dotIndex === -1 ? mantissa : mantissa.slice(0, dotIndex) + mantissa.slice(dotIndex + 1));
  const fractionDigits = dotIndex === -1 ? 0 : mantissa.length - dotIndex - 1;
  const exponent = (exponentText === '' ? 0n : BigInt(exponentText)) - BigInt(fractionDigits);
  const value = decimalValue(BigInt(digits), exponent);
  return { coefficient: value.coefficient, exponent: value.exponent };
}

// ---------------------------------------------------------------------------
// String decoding (parser.rs:1232-1347)
// ---------------------------------------------------------------------------

interface DecodedString {
  readonly value: string;
  readonly hasUnescapedLineSeparator: boolean;
}

/**
 * Reads the code point at a code-unit index (JS strings are UTF-16
 * indexed). Past the end, a NUL sentinel is returned: NUL can never be a
 * real continuation character of any checked escape form ('\\', 'u',
 * '\n', ASCII digits), so the call sites behave like the Rust
 * `chars().peek()` at end-of-input (None).
 */
function charAt(text: string, index: number): string {
  if (index >= text.length) {
    return '\0';
  }
  return String.fromCodePoint(text.codePointAt(index)!);
}

/** Decodes one string literal under the exact profile escape surface (parser.rs:1232-1315). */
function decodeJsonString(literal: string, profile: JsonProfile): DecodedString | null {
  const quote = literal[0];
  if (quote !== '"' && !(isJson5(profile) && quote === "'")) {
    return null;
  }
  const inner = literal.slice(1, literal.length - 1);
  const output: string[] = [];
  let hasUnescapedLineSeparator = false;
  let index = 0;
  while (index < inner.length) {
    const character = charAt(inner, index);
    if (character === '\\') {
      const escaped = charAt(inner, index + 1);
      index += 2;
      switch (escaped) {
        case '"':
          output.push('"');
          break;
        case "'":
          if (!isJson5(profile)) {
            return null;
          }
          output.push("'");
          break;
        case '\\':
          output.push('\\');
          break;
        case '/':
          output.push('/');
          break;
        case 'b':
          output.push('\u0008');
          break;
        case 'f':
          output.push('\u000C');
          break;
        case 'n':
          output.push('\n');
          break;
        case 'r':
          output.push('\r');
          break;
        case 't':
          output.push('\t');
          break;
        case 'v':
          if (!isJson5(profile)) {
            return null;
          }
          output.push('\u000B');
          break;
        case '0': {
          if (!isJson5(profile)) {
            return null;
          }
          const next = charAt(inner, index);
          if (isAsciiDigit(next.codePointAt(0)!)) {
            return null;
          }
          output.push('\0');
          break;
        }
        case 'x': {
          if (!isJson5(profile)) {
            return null;
          }
          const hex = inner.slice(index, index + 2);
          if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
            return null;
          }
          index += 2;
          output.push(String.fromCodePoint(Number.parseInt(hex, 16)));
          break;
        }
        case 'u': {
          const first = readHexQuad(inner, index);
          if (first === null) {
            return null;
          }
          index += 4;
          let scalar: number;
          if (first >= 0xd800 && first <= 0xdbff) {
            if (charAt(inner, index) !== '\\' || charAt(inner, index + 1) !== 'u') {
              return null;
            }
            const second = readHexQuad(inner, index + 2);
            if (second === null || !(second >= 0xdc00 && second <= 0xdfff)) {
              return null;
            }
            index += 6;
            scalar = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
          } else if (first >= 0xdc00 && first <= 0xdfff) {
            return null;
          } else {
            scalar = first;
          }
          output.push(String.fromCodePoint(scalar));
          break;
        }
        case '\n':
        case '\u2028':
        case '\u2029':
          if (!isJson5(profile)) {
            return null;
          }
          break;
        case '\r':
          if (!isJson5(profile)) {
            return null;
          }
          if (charAt(inner, index) === '\n') {
            index += 1;
          }
          break;
        default:
          if (
            !isJson5(profile) ||
            isAsciiDigit(escaped.codePointAt(0)!) ||
            isJson5LineTerminator(escaped.codePointAt(0)!)
          ) {
            return null;
          }
          output.push(escaped);
          break;
      }
    } else {
      const codePoint = character.codePointAt(0)!;
      if (codePoint <= 0x1f) {
        return null;
      }
      if (codePoint === 0x2028 || codePoint === 0x2029) {
        hasUnescapedLineSeparator = true;
      }
      output.push(character);
      index += character.length;
    }
  }
  return { value: output.join(''), hasUnescapedLineSeparator };
}

/** Reads four hexadecimal digits as a UTF-16 code unit (parser.rs:1333-1347). */
function readHexQuad(text: string, index: number): number | null {
  const digits = text.slice(index, index + 4);
  if (!/^[0-9a-fA-F]{4}$/.test(digits)) {
    return null;
  }
  return Number.parseInt(digits, 16);
}

/** Decodes one validated JSON5 IdentifierName (parser.rs:1349-1373). */
function decodeJson5Identifier(literal: string): string {
  let output = '';
  let index = 0;
  let first = true;
  while (index < literal.length) {
    const character = literal[index];
    let decoded: string;
    let width: number;
    if (character === '\\') {
      decoded = decodeIdentifierEscape(literal, index)!;
      width = 6;
    } else {
      decoded = character;
      width = utf8WidthOf(character);
    }
    const permitted = first ? isJson5IdentifierStart(decoded) : isJson5IdentifierContinue(decoded);
    if (!permitted) {
      throw new Error('internal: lexer validated identifier');
    }
    output += decoded;
    index += width;
    first = false;
  }
  return output;
}

// ---------------------------------------------------------------------------
// Source walker (byte-accurate code-point scanning)
// ---------------------------------------------------------------------------

/** Walks decoded UTF-8 text as code points while tracking exact raw byte offsets. */
class SourceWalker {
  readonly #text: string;
  #byteOffset: number;
  #charIndex: number;

  constructor(text: string) {
    this.#text = text;
    this.#byteOffset = 0;
    this.#charIndex = 0;
  }

  atEnd(): boolean {
    return this.#charIndex >= this.#text.length;
  }

  byteOffset(): number {
    return this.#byteOffset;
  }

  charIndex(): number {
    return this.#charIndex;
  }

  text(): string {
    return this.#text;
  }

  /** The code point at the current position, or null at end. */
  peek(): string | null {
    if (this.atEnd()) {
      return null;
    }
    return String.fromCodePoint(this.#text.codePointAt(this.#charIndex)!);
  }

  /** The code point at a lookahead offset from the current position, or null. */
  peekAt(offset: number): string | null {
    const index = this.#charIndex + offset;
    if (index >= this.#text.length) {
      return null;
    }
    return String.fromCodePoint(this.#text.codePointAt(index)!);
  }

  /** Whether the text at the current position starts with an ASCII prefix. */
  startsWith(prefix: string): boolean {
    return this.#text.startsWith(prefix, this.#charIndex);
  }

  /** Consumes one code point, advancing byte and code-unit offsets. */
  next(): string | null {
    if (this.atEnd()) {
      return null;
    }
    const character = String.fromCodePoint(this.#text.codePointAt(this.#charIndex)!);
    this.#charIndex += character.length;
    this.#byteOffset += utf8WidthOf(character);
    return character;
  }

  /** Consumes a leading U+FEFF BOM (3 raw bytes, parser.rs:193-214, 414-421). */
  consumeBom(): void {
    this.#charIndex = 1;
    this.#byteOffset = 3;
  }
}

/** UTF-8 byte width of one code point (parser.rs:767-774). */
function utf8WidthOf(character: string): number {
  const codePoint = character.codePointAt(0)!;
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

// ---------------------------------------------------------------------------
// Diagnostic sink (parser.rs:1500-1537)
// ---------------------------------------------------------------------------

/** Bounded diagnostic collection with occurrence ordinals and an explicit truncation marker. */
class DiagnosticSink {
  readonly #diagnostics: Diagnostic[] = [];
  readonly #max: number;
  #occurrence = 0n;
  #truncated = false;

  constructor(max: number) {
    this.#max = max;
  }

  push(diagnostic_: Diagnostic): void {
    const withOccurrence = { ...diagnostic_, occurrence: this.#occurrence };
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
    return this.#diagnostics;
  }
}

/** Creates one snapshot-bound diagnostic (parser.rs:1458-1498). */
function sourceDiagnostic(
  authority: DocumentAuthority,
  code: string,
  category: Diagnostic['category'],
  severity: Diagnostic['severity'],
  start: number,
  end: number,
): Diagnostic {
  return diagnostic(
    code,
    category,
    severity,
    authority.span(start, end).diagnosticLocation(),
    0n,
  );
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** Token stream parser producing the immutable document (parser.rs:817-1225). */
class Parser {
  readonly #sourceByteLength: number;
  readonly #profile: JsonProfile;
  readonly #authority: DocumentAuthority;
  readonly #tokens: readonly Token[];
  readonly #limits: ParseLimits;
  readonly #diagnostics: DiagnosticSink;
  #position = 0;
  #entities: Entity[] = [];
  #recovered: boolean;

  constructor(
    sourceByteLength: number,
    profile: JsonProfile,
    authority: DocumentAuthority,
    tokens: readonly Token[],
    recovered: boolean,
    limits: ParseLimits,
    diagnostics: DiagnosticSink,
  ) {
    this.#sourceByteLength = sourceByteLength;
    this.#profile = profile;
    this.#authority = authority;
    this.#tokens = tokens;
    this.#recovered = recovered;
    this.#limits = limits;
    this.#diagnostics = diagnostics;
  }

  /** Parses the root value; throws FatalFormationFailure on resource exhaustion (parser.rs:830-837). */
  parseRoot(): number {
    const root = this.parseValue(0);
    if (this.#position < this.#tokens.length) {
      const token = this.#tokens[this.#position];
      const last = this.#tokens[this.#tokens.length - 1];
      this.syntaxDiagnostic('json.syntax.trailing-content@1', token.start, last.end);
      this.#recovered = true;
    }
    return root;
  }

  parseValue(depth: number): number {
    if (depth > this.#limits.maxNestingDepth) {
      throw FatalFormationFailure.resourceLimit('nesting-depth', depth, this.#limits.maxNestingDepth);
    }
    const token = this.peek();
    if (token === null) {
      const offset = this.#sourceByteLength;
      this.syntaxDiagnostic('json.syntax.missing-value@1', offset, offset);
      this.#recovered = true;
      return this.allocValue(offset, offset, null, false, { kind: 'Unavailable', reason: 'Missing' });
    }
    switch (token.kind) {
      case 'Null':
        this.#position += 1;
        return this.allocScalar(token, { kind: 'Null' });
      case 'True':
        this.#position += 1;
        return this.allocScalar(token, { kind: 'Boolean', value: true });
      case 'False':
        this.#position += 1;
        return this.allocScalar(token, { kind: 'Boolean', value: false });
      case 'Number': {
        this.#position += 1;
        let kind: InternalValueKind;
        if (isJson5(this.#profile)) {
          kind = parseJson5Number(token.text);
        } else if (/[.eE]/.test(token.text)) {
          const decimal = parseJsonDecimal(token.text);
          kind = { kind: 'Decimal', coefficient: decimal.coefficient, exponent: decimal.exponent };
        } else {
          kind = { kind: 'Integer', value: BigInt(token.text) };
        }
        return this.allocScalar(token, kind);
      }
      case 'String': {
        this.#position += 1;
        const decoded = decodeJsonString(token.text, this.#profile);
        if (decoded !== null) {
          if (decoded.hasUnescapedLineSeparator) {
            this.#diagnostics.push(
              sourceDiagnostic(
                this.#authority,
                'json5.string.unescaped-line-separator@1',
                'Conformance',
                'Warning',
                token.start,
                token.end,
              ),
            );
          }
          return this.allocScalar(token, { kind: 'String', value: decoded.value });
        }
        this.syntaxDiagnostic('json.syntax.invalid-string-escape@1', token.start, token.end);
        this.#recovered = true;
        return this.allocValue(token.start, token.end, { start: token.start, end: token.end }, true, {
          kind: 'Unavailable',
          reason: 'InvalidLiteral',
        });
      }
      case 'Identifier': {
        if (isJson5(this.#profile)) {
          this.#position += 1;
          const text = decodeJson5Identifier(token.text);
          let kind: InternalValueKind;
          switch (text) {
            case 'null':
              kind = { kind: 'Null' };
              break;
            case 'true':
              kind = { kind: 'Boolean', value: true };
              break;
            case 'false':
              kind = { kind: 'Boolean', value: false };
              break;
            case 'Infinity':
              kind = { kind: 'BinaryFloat64', bits: 0x7ff0000000000000n };
              break;
            case 'NaN':
              kind = { kind: 'BinaryFloat64', bits: 0x7ff8000000000000n };
              break;
            default:
              this.syntaxDiagnostic('json.syntax.expected-value@1', token.start, token.end);
              this.#recovered = true;
              kind = { kind: 'Unavailable', reason: 'ErrorRegion' };
              break;
          }
          return this.allocScalar(token, kind);
        }
        break;
      }
      case 'LeftBrace':
        return this.parseObject(depth);
      case 'LeftBracket':
        return this.parseArray(depth);
      default:
        break;
    }
    this.#position += 1;
    this.syntaxDiagnostic('json.syntax.expected-value@1', token.start, token.end);
    this.#recovered = true;
    return this.allocValue(token.start, token.end, null, false, {
      kind: 'Unavailable',
      reason: 'ErrorRegion',
    });
  }

  parseObject(depth: number): number {
    const open = this.consume('LeftBrace')!;
    const members: number[] = [];
    const names = new Map<string, number>();
    for (;;) {
      const close = this.consume('RightBrace');
      if (close !== null) {
        return this.allocValue(open.start, close.end, null, true, { kind: 'Object', members });
      }
      if (this.peek() === null) {
        break;
      }
      const ordinal = members.length;
      const token = this.peek()!;
      let key: number;
      if (token.kind === 'String' || (isJson5(this.#profile) && token.kind === 'Identifier')) {
        key = this.parseObjectKey(depth + 1);
      } else {
        const offset = this.currentOffset();
        this.syntaxDiagnostic('json.syntax.expected-object-key@1', offset, offset);
        this.#recovered = true;
        key = this.allocValue(offset, offset, null, false, {
          kind: 'Unavailable',
          reason: 'Missing',
        });
      }
      if (this.consume('Colon') === null) {
        const offset = this.currentOffset();
        this.syntaxDiagnostic('json.syntax.missing-colon@1', offset, offset);
        this.#recovered = true;
      }
      const value = this.parseValue(depth + 1);
      const memberStart = this.spanOf(key).startByte();
      const memberEnd = this.spanOf(value).endByte();
      const member = this.allocEntity({
        kind: 'Member',
        span: this.#authority.span(memberStart, memberEnd),
        key,
        value,
        ordinal,
      });
      members.push(member);
      const keyEntity = this.#entities[key];
      if (keyEntity.kind === 'Value' && keyEntity.value.kind === 'String') {
        const name = keyEntity.value.value;
        const first = names.get(name);
        if (first !== undefined) {
          const duplicate = sourceDiagnostic(
            this.#authority,
            'json.object.duplicate-member@1',
            'Semantic',
            'Error',
            this.spanOf(member).startByte(),
            this.spanOf(member).endByte(),
          );
          this.#diagnostics.push({
            ...duplicate,
            arguments: new Map([['name', name]]),
            related: [
              {
                role: 'first-member',
                location: this.spanOf(first).diagnosticLocation(),
              },
            ],
          });
        } else {
          names.set(name, member);
        }
      }
      if (this.consume('Comma') !== null) {
        const next = this.peek();
        if (next !== null && next.kind === 'RightBrace' && !permitsJsoncExtensions(this.#profile)) {
          this.syntaxDiagnostic('json.strict.trailing-comma@1', next.start - 1, next.start);
          this.#recovered = true;
        }
        continue;
      }
      const next = this.peek();
      if (next !== null && next.kind === 'RightBrace') {
        continue;
      }
      const offset = this.currentOffset();
      this.syntaxDiagnostic('json.syntax.missing-comma@1', offset, offset);
      this.#recovered = true;
      const following = this.peek();
      if (
        following !== null &&
        following.kind !== 'String' &&
        following.kind !== 'Identifier' &&
        following.kind !== 'RightBrace'
      ) {
        this.#position += 1;
      }
    }
    const end = this.#sourceByteLength;
    this.syntaxDiagnostic('json.syntax.missing-object-close@1', end, end);
    this.#recovered = true;
    return this.allocValue(open.start, end, null, false, { kind: 'Object', members });
  }

  parseArray(depth: number): number {
    const open = this.consume('LeftBracket')!;
    const elements: number[] = [];
    for (;;) {
      const close = this.consume('RightBracket');
      if (close !== null) {
        return this.allocValue(open.start, close.end, null, true, { kind: 'Array', elements });
      }
      if (this.peek() === null) {
        const end = this.#sourceByteLength;
        this.syntaxDiagnostic('json.syntax.missing-array-close@1', end, end);
        this.#recovered = true;
        return this.allocValue(open.start, end, null, false, { kind: 'Array', elements });
      }
      const ordinal = elements.length;
      const value = this.parseValue(depth + 1);
      const element = this.allocEntity({
        kind: 'Element',
        span: this.spanOf(value),
        value,
        ordinal,
      });
      elements.push(element);
      if (this.consume('Comma') !== null) {
        const next = this.peek();
        if (
          next !== null &&
          next.kind === 'RightBracket' &&
          !permitsJsoncExtensions(this.#profile)
        ) {
          this.syntaxDiagnostic('json.strict.trailing-comma@1', next.start - 1, next.start);
          this.#recovered = true;
        }
        continue;
      }
      const next = this.peek();
      if (next !== null && next.kind === 'RightBracket') {
        continue;
      }
      const offset = this.currentOffset();
      this.syntaxDiagnostic('json.syntax.missing-comma@1', offset, offset);
      this.#recovered = true;
    }
  }

  parseObjectKey(depth: number): number {
    const token = this.peek()!;
    if (token.kind === 'String') {
      return this.parseValue(depth);
    }
    this.#position += 1;
    const name = decodeJson5Identifier(token.text);
    return this.allocScalar(token, { kind: 'String', value: name });
  }

  allocScalar(token: Token, kind: InternalValueKind): number {
    return this.allocValue(
      token.start,
      token.end,
      { start: token.start, end: token.end },
      true,
      kind,
    );
  }

  allocValue(
    start: number,
    end: number,
    literal: { start: number; end: number } | null,
    complete: boolean,
    kind: InternalValueKind,
  ): number {
    return this.allocEntity({
      kind: 'Value',
      span: this.#authority.span(start, end),
      literalSpan: literal === null ? null : this.#authority.span(literal.start, literal.end),
      complete,
      value: kind,
    });
  }

  allocEntity(entity: Entity): number {
    if (this.#entities.length >= this.#limits.maxNodeCount) {
      throw FatalFormationFailure.resourceLimit(
        'node-count',
        this.#entities.length + 1,
        this.#limits.maxNodeCount,
      );
    }
    const index = this.#entities.length;
    this.#entities.push(entity);
    return index;
  }

  spanOf(index: number): Span {
    return this.#entities[index].span;
  }

  peek(): Token | null {
    return this.#tokens[this.#position] ?? null;
  }

  consume(kind: TokenKind): Token | null {
    const token = this.peek();
    if (token !== null && token.kind === kind) {
      this.#position += 1;
      return token;
    }
    return null;
  }

  currentOffset(): number {
    return this.peek()?.start ?? this.#sourceByteLength;
  }

  syntaxDiagnostic(code: string, start: number, end: number): void {
    this.#diagnostics.push(sourceDiagnostic(this.#authority, code, 'Syntax', 'Error', start, end));
  }

  recovered(): boolean {
    return this.#recovered;
  }

  entities(): readonly Entity[] {
    return this.#entities;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parses a complete immutable JSON/JSONC/JSON5 document snapshot
 * (parser.rs:73-166). Throws FatalFormationFailure — no partial document
 * ever exists.
 */
export function parse(
  bytes: Uint8Array,
  profile: JsonProfile,
  limits: ParseLimits,
): JsonDocument {
  if (bytes.length > limits.maxSourceBytes) {
    throw FatalFormationFailure.resourceLimit('source-bytes', bytes.length, limits.maxSourceBytes);
  }
  let source: SourceSnapshot;
  try {
    source = SourceSnapshot.fromUtf8(bytes);
  } catch (error) {
    if (!(error instanceof SourceError)) {
      throw error;
    }
    throw FatalFormationFailure.sourceError(error);
  }
  const authority = DocumentAuthority.fresh();
  const diagnostics = new DiagnosticSink(limits.maxDiagnostics);
  const decodedText = source.decodedText()!;
  const lexed = lex(decodedText, profile, authority, limits, diagnostics);
  const syntaxKinds = lexed.lexemes.map((lexeme) => lexemeSyntaxKind(lexeme.class));
  const pieces = lexed.lexemes.map((lexeme) => {
    return new StructuralPiece(
      authority.span(lexeme.start, lexeme.end),
      lexeme.class.kind === 'Token' ? 'Token' : lexeme.class.kind === 'Trivia' ? 'Trivia' : 'ErrorRegion',
    );
  });
  const structuralIndex = LosslessStructuralIndex.create(authority.identity(), source.len(), pieces);

  const parser = new Parser(
    source.len(),
    profile,
    authority,
    lexed.tokens,
    lexed.recovered,
    limits,
    diagnostics,
  );
  const root = parser.parseRoot();
  const formationStatus: FormationStatus = parser.recovered() ? 'Recovered' : 'Complete';
  const entities = parser.entities();
  const orderedDiagnostics = sortDiagnostics(diagnostics.finish());
  return new JsonDocument(
    authority,
    source,
    profile,
    structuralIndex,
    syntaxKinds,
    formationStatus,
    orderedDiagnostics,
    entities,
    root,
    limits,
  );
}

function lexemeSyntaxKind(class_: LexemeClass): JsonSyntaxKind {
  switch (class_.kind) {
    case 'Token':
      return tokenSyntaxKind(class_.token);
    case 'Trivia':
      return class_.syntax;
    case 'Error':
      return 'ErrorRegion';
  }
}

function tokenSyntaxKind(token: TokenKind): JsonSyntaxKind {
  switch (token) {
    case 'LeftBrace':
      return 'LeftBrace';
    case 'RightBrace':
      return 'RightBrace';
    case 'LeftBracket':
      return 'LeftBracket';
    case 'RightBracket':
      return 'RightBracket';
    case 'Colon':
      return 'Colon';
    case 'Comma':
      return 'Comma';
    case 'String':
      return 'String';
    case 'Identifier':
      return 'Identifier';
    case 'Number':
      return 'Number';
    case 'True':
      return 'True';
    case 'False':
      return 'False';
    case 'Null':
      return 'Null';
  }
}
