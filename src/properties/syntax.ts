/**
 * Closed Java Properties lossless syntax-piece classification.
 *
 * authority: crates/consema-properties/src/lib.rs
 *  - PropertiesSyntaxKind :208-235 (the twelve kinds)
 *  - stable query and protocol names :237-274 (as_str :240-254,
 *    from_name :257-273)
 *  - RFC 0010 §10 (:287-309) freezes the kind filter vocabulary in the
 *    same order: Bom, Whitespace, LineBreak, CommentMarker, CommentText,
 *    Key, Separator, Value, EscapeMarker, EscapeBody, ContinuationMarker,
 *    ErrorRegion
 *
 * Design (TypeScript-idiomatic): a closed string-literal union whose
 * spellings ARE the stable query names (RFC 0016 §8 F15: the lossless
 * syntax-query match roles reproduce the Rust spellings byte-for-byte).
 */

/** Closed Java Properties v1 lossless syntax-piece classification (lib.rs:208-235). */
export type PropertiesSyntaxKind =
  /** Unicode byte-order mark recognized by the Reader source contract. */
  | 'Bom'
  /** Space, tab, or form feed. */
  | 'Whitespace'
  /** LF, CR, or CRLF. */
  | 'LineBreak'
  /** `#` or `!` starting a comment natural line. */
  | 'CommentMarker'
  /** Comment payload. */
  | 'CommentText'
  /** Raw property key content. */
  | 'Key'
  /** Whitespace and optional `=` or `:` between key and value. */
  | 'Separator'
  /** Raw property element content. */
  | 'Value'
  /** Backslash beginning a normal escape. */
  | 'EscapeMarker'
  /** Named, Unicode, or dropped-backslash escape body. */
  | 'EscapeBody'
  /** Backslash consumed by natural-line continuation. */
  | 'ContinuationMarker'
  /** Malformed source retained through recovery. */
  | 'ErrorRegion';

/** Resolves one exact stable kind name (lib.rs:257-273). */
export function propertiesSyntaxKindFromName(name: string): PropertiesSyntaxKind | null {
  switch (name) {
    case 'Bom':
    case 'Whitespace':
    case 'LineBreak':
    case 'CommentMarker':
    case 'CommentText':
    case 'Key':
    case 'Separator':
    case 'Value':
    case 'EscapeMarker':
    case 'EscapeBody':
    case 'ContinuationMarker':
    case 'ErrorRegion':
      return name;
    default:
      return null;
  }
}
