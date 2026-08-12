/**
 * YAML native semantics: node kinds, scalar categories, and scalar styles.
 *
 * authority: crates/consema-yaml/src/lib.rs
 *  - YamlNodeKind :118-127 (Scalar | Sequence | Mapping)
 *  - YamlScalarStyle :129-142 (Plain | SingleQuoted | DoubleQuoted |
 *    Literal | Folded)
 *  - YamlScalarKind :144-165 (Null | Boolean | Integer | Float | String |
 *    Timestamp | Binary | Custom | Tagged)
 *
 * Design (TypeScript-idiomatic): closed string-literal unions whose
 * spellings ARE the Rust variant names; regional semantic availability is
 * shared with the rest of the package through the same discriminated union
 * shape used by the json family (json/semantic.ts).
 */

/** YAML native representation node kind (lib.rs:118-127). */
export type YamlNodeKind = 'Scalar' | 'Sequence' | 'Mapping';

/** Exact scalar presentation style (lib.rs:129-142). */
export type YamlScalarStyle =
  /** Plain style. */
  | 'Plain'
  /** Single-quoted style. */
  | 'SingleQuoted'
  /** Double-quoted style. */
  | 'DoubleQuoted'
  /** Literal block style. */
  | 'Literal'
  /** Folded block style. */
  | 'Folded';

/** Resolved native scalar semantic category (lib.rs:144-165). */
export type YamlScalarKind =
  /** Null. */
  | 'Null'
  /** Boolean. */
  | 'Boolean'
  /** Arbitrary-precision integer. */
  | 'Integer'
  /** Exact decimal or frozen non-finite float spelling. */
  | 'Float'
  /** String. */
  | 'String'
  /** YAML 1.1-compatible timestamp. */
  | 'Timestamp'
  /** Validated YAML binary scalar. */
  | 'Binary'
  /** Scalar carrying an uninterpreted custom tag. */
  | 'Custom'
  /** Scalar carrying a retained standard tag without a core tree lowering. */
  | 'Tagged';

/** Stable reason that a region has no native semantic value (json/semantic.ts:15-20). */
export type SemanticUnavailable =
  | 'Missing'
  | 'ErrorRegion'
  | 'InvalidLiteral'
  | 'ChildUnavailable';

/** Regional semantic availability (json/semantic.ts:22-25). */
export type SemanticAvailability<T> =
  | { readonly kind: 'Available'; readonly value: T }
  | { readonly kind: 'Unavailable'; readonly reason: SemanticUnavailable };

/** Wraps a complete native meaning. */
export function available<T>(value: T): SemanticAvailability<T> {
  return { kind: 'Available', value };
}

/** Wraps a stable unavailability reason. */
export function unavailable<T>(reason: SemanticUnavailable): SemanticAvailability<T> {
  return { kind: 'Unavailable', reason };
}

/** Maps an available value while preserving unavailability. */
export function mapSemantic<T, U>(
  result: SemanticAvailability<T>,
  map: (value: T) => U,
): SemanticAvailability<U> {
  switch (result.kind) {
    case 'Available':
      return available(map(result.value));
    case 'Unavailable':
      return result;
  }
}
