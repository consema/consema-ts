/**
 * Lossless TOML source tokenization: exhaustive token/trivia pieces and
 * the closed syntax-kind vocabulary, plus the delimiter-nesting preflight.
 *
 * authority: crates/consema-toml/src/parser.rs:360-478 (tokenize) —
 *  - piece classes: Whitespace/Newline/Comment are Trivia; String/
 *    Equals/LeftBracket/RightBracket/LeftBrace/RightBrace/Comma/Dot/Bare
 *    are Token (parser.rs:370-411)
 *  - CRLF is one Newline piece; a bare CR is retained as a Newline piece
 *    for formation diagnostics (lib.rs:46)
 *  - the String piece consumes a whole string including escapes and
 *    multiline forms (string_end, parser.rs:480-499)
 *  - the token limit applies to every piece: observed = len+1, limit name
 *    "token_count" (parser.rs:413-420)
 *  - the nesting preflight counts `[`/`{` tokens only, limit name
 *    "nesting_depth" (parser.rs:433-461)
 *  - syntax-kind stable names: crates/consema-toml/src/lib.rs:73-88
 *    ("Whitespace", "Newline", "Comment", "String", "Bare", "Equals",
 *    "LeftBracket", "RightBracket", "LeftBrace", "RightBrace", "Comma",
 *    "Dot")
 *  - structural piece kinds: crates/consema-document/src/lib.rs:413-422
 *    (Token | Trivia | ErrorRegion)
 *
 * Design (TypeScript-idiomatic): a pure function over the decoded text
 * producing StructuralPiece records; the pieces are validated into an
 * exact-coverage LosslessStructuralIndex by the caller. Token counts are
 * checked eagerly so a resource limit is reported before any grammar work.
 */

import { DocumentAuthority } from '../document/identity.ts';
import { StructuralPiece } from '../document/structural.ts';
import { TomlFormationFailure } from './errors.ts';

/** Closed TOML v1 lossless syntax-piece classification (lib.rs:43-68). */
export type TomlSyntaxKind =
  | 'Whitespace'
  | 'Newline'
  | 'Comment'
  | 'String'
  | 'Bare'
  | 'Equals'
  | 'LeftBracket'
  | 'RightBracket'
  | 'LeftBrace'
  | 'RightBrace'
  | 'Comma'
  | 'Dot';

/** Resolves one exact stable kind name (lib.rs:92-108). */
export function tomlSyntaxKindFromName(name: string): TomlSyntaxKind | null {
  switch (name) {
    case 'Whitespace':
    case 'Newline':
    case 'Comment':
    case 'String':
    case 'Bare':
    case 'Equals':
    case 'LeftBracket':
    case 'RightBracket':
    case 'LeftBrace':
    case 'RightBrace':
    case 'Comma':
    case 'Dot':
      return name;
    default:
      return null;
  }
}

const PUNCTUATION: Readonly<Record<number, TomlSyntaxKind>> = Object.freeze({
  0x3d: 'Equals', // =
  0x5b: 'LeftBracket', // [
  0x5d: 'RightBracket', // ]
  0x7b: 'LeftBrace', // {
  0x7d: 'RightBrace', // }
  0x2c: 'Comma', // ,
  0x2e: 'Dot', // .
});

function isPunctuation(byte: number): boolean {
  return PUNCTUATION[byte] !== undefined;
}

/**
 * Tokenizes every source byte into ordered structural pieces and their
 * syntax kinds (parser.rs:360-431). Throws TomlFormationFailure with the
 * frozen "token_count" limit when max_token_count is exceeded.
 */
export function tokenizeTomlSource(
  source: string,
  authority: DocumentAuthority,
  maxTokenCount: number,
): { pieces: StructuralPiece[]; syntaxKinds: TomlSyntaxKind[] } {
  const bytes = utf8Bytes(source);
  const pieces: StructuralPiece[] = [];
  const syntaxKinds: TomlSyntaxKind[] = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    const byte = bytes[cursor];
    let end: number;
    let kind: 'Trivia' | 'Token';
    let syntaxKind: TomlSyntaxKind;
    if (byte === 0x20 || byte === 0x09) {
      // space / tab
      end = cursor + 1;
      while (end < bytes.length && (bytes[end] === 0x20 || bytes[end] === 0x09)) {
        end += 1;
      }
      kind = 'Trivia';
      syntaxKind = 'Whitespace';
    } else if (byte === 0x0d || byte === 0x0a) {
      // CRLF is one Newline piece; a bare CR is retained as Newline (lib.rs:46).
      end = byte === 0x0d && bytes[cursor + 1] === 0x0a ? cursor + 2 : cursor + 1;
      kind = 'Trivia';
      syntaxKind = 'Newline';
    } else if (byte === 0x23) {
      // '#' comment excluding its newline
      end = cursor + 1;
      while (end < bytes.length && bytes[end] !== 0x0d && bytes[end] !== 0x0a) {
        end += 1;
      }
      kind = 'Trivia';
      syntaxKind = 'Comment';
    } else if (byte === 0x27 || byte === 0x22) {
      // ' or " — a whole string token, including multiline forms (parser.rs:389-394, 480-499)
      end = stringEnd(bytes, cursor);
      kind = 'Token';
      syntaxKind = 'String';
    } else if (isPunctuation(byte)) {
      end = cursor + 1;
      kind = 'Token';
      syntaxKind = PUNCTUATION[byte];
    } else {
      // Bare token run: stops at whitespace, '#', punctuation, and quotes (parser.rs:401-411).
      end = cursor + 1;
      while (
        end < bytes.length &&
        !(bytes[end] === 0x20 || bytes[end] === 0x09 || bytes[end] === 0x0d || bytes[end] === 0x0a) &&
        bytes[end] !== 0x23 &&
        !isPunctuation(bytes[end]) &&
        bytes[end] !== 0x27 &&
        bytes[end] !== 0x22
      ) {
        end += 1;
      }
      kind = 'Token';
      syntaxKind = 'Bare';
    }
    const observed = pieces.length + 1;
    if (observed > maxTokenCount) {
      throw new TomlFormationFailure('ResourceLimit', {
        limitName: 'token_count',
        observed,
        limit: maxTokenCount,
      });
    }
    pieces.push(new StructuralPiece(authority.span(cursor, end), kind));
    syntaxKinds.push(syntaxKind);
    cursor = end;
  }
  return { pieces, syntaxKinds };
}

/**
 * Preflights delimiter nesting over token pieces only (parser.rs:433-461).
 * Throws TomlFormationFailure with the frozen "nesting_depth" limit.
 */
export function preflightDelimiterNesting(
  source: string,
  pieces: readonly StructuralPiece[],
  maxNestingDepth: number,
): void {
  let depth = 0;
  for (const piece of pieces) {
    if (piece.kind() !== 'Token') {
      continue;
    }
    const span = piece.span();
    const token = source.slice(span.startByte(), span.endByte());
    if (token === '[' || token === '{') {
      depth += 1;
      if (depth > maxNestingDepth) {
        throw new TomlFormationFailure('ResourceLimit', {
          limitName: 'nesting_depth',
          observed: depth,
          limit: maxNestingDepth,
        });
      }
    } else if (token === ']' || token === '}') {
      depth -= 1;
    }
  }
}

/**
 * End of one string token (parser.rs:480-499): basic strings skip escaped
 * characters; an unterminated string consumes to the end (the grammar pass
 * then reports the syntax failure).
 */
function stringEnd(bytes: Uint8Array, start: number): number {
  const quote = bytes[start];
  const triple =
    bytes[start] === quote && bytes[start + 1] === quote && bytes[start + 2] === quote;
  let cursor = start + (triple ? 3 : 1);
  while (cursor < bytes.length) {
    if (quote === 0x22 && bytes[cursor] === 0x5c) {
      // '"' with backslash escape — skip the escaped character
      cursor = Math.min(cursor + 2, bytes.length);
      continue;
    }
    if (triple) {
      if (bytes[cursor] === quote && bytes[cursor + 1] === quote && bytes[cursor + 2] === quote) {
        return cursor + 3;
      }
    } else if (bytes[cursor] === quote) {
      return cursor + 1;
    }
    cursor += 1;
  }
  return bytes.length;
}

/** UTF-8 bytes of one decoded text (identical to the source bytes for the TOML UTF-8 profile). */
export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Re-encodes one source byte range to text (used by syntax-text-equals and edit preparation). */
export function textFromSource(source: string, startByte: number, endByte: number): string {
  return source.slice(startByte, endByte);
}
