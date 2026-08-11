/**
 * Closed JSON/JSONC v1 lossless syntax-piece classification.
 *
 * authority: crates/consema-json/src/lib.rs
 *  - JsonSyntaxKind :48-84 (the seventeen kinds)
 *  - stable query and protocol names :86-109 (as_str), :112-134 (from_name)
 *
 * Design (TypeScript-idiomatic): a closed string-literal union whose
 * spellings ARE the stable query names (RFC 0016 §8 F15: the lossless
 * syntax-query match roles reproduce the Rust spellings byte-for-byte).
 */

/** Closed JSON/JSONC v1 lossless syntax-piece classification (lib.rs:48-84). */
export type JsonSyntaxKind =
  /** Leading UTF-8 byte-order mark. */
  | 'Bom'
  /** JSON whitespace. */
  | 'Whitespace'
  /** `//` comment. */
  | 'LineComment'
  /** Closed block comment. */
  | 'BlockComment'
  /** `{`. */
  | 'LeftBrace'
  /** `}`. */
  | 'RightBrace'
  /** `[`. */
  | 'LeftBracket'
  /** `]`. */
  | 'RightBracket'
  /** `:`. */
  | 'Colon'
  /** `,`. */
  | 'Comma'
  /** Complete string token. */
  | 'String'
  /** Complete JSON5 IdentifierName token. */
  | 'Identifier'
  /** Valid JSON number token. */
  | 'Number'
  /** `true`. */
  | 'True'
  /** `false`. */
  | 'False'
  /** `null`. */
  | 'Null'
  /** Bytes retained after bounded lexical recovery. */
  | 'ErrorRegion';

/** Resolves one exact stable kind name (lib.rs:112-134). */
export function jsonSyntaxKindFromName(name: string): JsonSyntaxKind | null {
  switch (name) {
    case 'Bom':
    case 'Whitespace':
    case 'LineComment':
    case 'BlockComment':
    case 'LeftBrace':
    case 'RightBrace':
    case 'LeftBracket':
    case 'RightBracket':
    case 'Colon':
    case 'Comma':
    case 'String':
    case 'Identifier':
    case 'Number':
    case 'True':
    case 'False':
    case 'Null':
    case 'ErrorRegion':
      return name;
    default:
      return null;
  }
}
