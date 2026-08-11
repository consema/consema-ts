/**
 * Regional semantic availability of JSON syntax.
 *
 * authority: crates/consema-json/src/lib.rs
 *  - SemanticAvailability :289-306 (Available | Unavailable)
 *  - SemanticUnavailable :308-319 (Missing | ErrorRegion |
 *    InvalidLiteral | ChildUnavailable)
 *
 * Design (TypeScript-idiomatic): a closed discriminated union; `mapSemantic`
 * maps an available value while preserving unavailability (lib.rs:297-305).
 * This tiny module is shared by `document.ts` (the handles) and `errors.ts`
 * (the projection failure surface) without an import cycle.
 */

/** Stable reason that a region has no native semantic value (lib.rs:308-319). */
export type SemanticUnavailable =
  | 'Missing'
  | 'ErrorRegion'
  | 'InvalidLiteral'
  | 'ChildUnavailable';

/** Regional semantic availability (lib.rs:289-306). */
export type SemanticAvailability<T> =
  | { readonly kind: 'Available'; readonly value: T }
  | { readonly kind: 'Unavailable'; readonly reason: SemanticUnavailable };

/** Wraps a complete native meaning (lib.rs:289-295). */
export function available<T>(value: T): SemanticAvailability<T> {
  return { kind: 'Available', value };
}

/** Wraps a stable unavailability reason (lib.rs:289-295). */
export function unavailable<T>(reason: SemanticUnavailable): SemanticAvailability<T> {
  return { kind: 'Unavailable', reason };
}

/** Maps an available value while preserving unavailability (lib.rs:297-305). */
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
