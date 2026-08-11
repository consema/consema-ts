/**
 * Closed YAML lossless presentation-piece classification.
 *
 * authority: crates/consema-yaml/src/lib.rs
 *  - YamlSyntaxKind :63-116 (the twenty-five kinds)
 *  - stable query and protocol names :167-198 (as_str), :200-231 (from_name)
 *  - trivia classification :233-238 (Bom | Whitespace | Newline | Comment)
 *  - the lossless-syntax-query vocabulary is frozen in
 *    typescript/src/protocol/query.ts:1117-1148 (isYAMLSyntaxKind — the
 *    exact twenty-five spellings)
 *
 * Design (TypeScript-idiomatic): a closed string-literal union whose
 * spellings ARE the stable query names (RFC 0016 §8 F15: the lossless
 * syntax-query match roles reproduce the Rust spellings byte-for-byte).
 */

/** Closed YAML lossless syntax-piece classification (lib.rs:63-116). */
export type YamlSyntaxKind =
  /** Unicode byte-order mark retained in the decoded stream. */
  | 'Bom'
  /** Horizontal separation. */
  | 'Whitespace'
  /** LF, CRLF, or bare CR line break. */
  | 'Newline'
  /** Comment excluding its line break. */
  | 'Comment'
  /** `%YAML`, `%TAG`, or reserved directive line. */
  | 'Directive'
  /** `---` document start. */
  | 'DocumentStart'
  /** `...` document end. */
  | 'DocumentEnd'
  /** Block sequence `-` indicator. */
  | 'SequenceEntry'
  /** Explicit mapping key `?` indicator. */
  | 'ExplicitKey'
  /** Mapping value `:` indicator. */
  | 'MappingValue'
  /** `[`. */
  | 'FlowSequenceStart'
  /** `]`. */
  | 'FlowSequenceEnd'
  /** `{`. */
  | 'FlowMappingStart'
  /** `}`. */
  | 'FlowMappingEnd'
  /** Flow `,` separator. */
  | 'FlowEntry'
  /** Anchor spelling beginning with `&`. */
  | 'Anchor'
  /** Alias spelling beginning with `*`. */
  | 'Alias'
  /** Tag spelling beginning with `!`. */
  | 'Tag'
  /** Plain scalar presentation fragment. */
  | 'PlainScalar'
  /** Complete single-quoted scalar presentation. */
  | 'SingleQuotedScalar'
  /** Complete double-quoted scalar presentation. */
  | 'DoubleQuotedScalar'
  /** Literal block-scalar header beginning with `|`. */
  | 'LiteralBlockHeader'
  /** Folded block-scalar header beginning with `>`. */
  | 'FoldedBlockHeader'
  /** Exact indented block-scalar content region. */
  | 'BlockScalarContent'
  /** Bytes retained after bounded syntax recovery. */
  | 'ErrorRegion';

/** Resolves one exact stable kind name (lib.rs:200-231). */
export function yamlSyntaxKindFromName(name: string): YamlSyntaxKind | null {
  switch (name) {
    case 'Bom':
    case 'Whitespace':
    case 'Newline':
    case 'Comment':
    case 'Directive':
    case 'DocumentStart':
    case 'DocumentEnd':
    case 'SequenceEntry':
    case 'ExplicitKey':
    case 'MappingValue':
    case 'FlowSequenceStart':
    case 'FlowSequenceEnd':
    case 'FlowMappingStart':
    case 'FlowMappingEnd':
    case 'FlowEntry':
    case 'Anchor':
    case 'Alias':
    case 'Tag':
    case 'PlainScalar':
    case 'SingleQuotedScalar':
    case 'DoubleQuotedScalar':
    case 'LiteralBlockHeader':
    case 'FoldedBlockHeader':
    case 'BlockScalarContent':
    case 'ErrorRegion':
      return name;
    default:
      return null;
  }
}

/** Whether the kind is presentation trivia (lib.rs:233-238). */
export function isYamlTriviaKind(kind: YamlSyntaxKind): boolean {
  return kind === 'Bom' || kind === 'Whitespace' || kind === 'Newline' || kind === 'Comment';
}
