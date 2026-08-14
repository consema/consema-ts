/**
 * Portable value and association locations (provisional document-domain
 * mirror of the core domain).
 *
 * authority: consema-rs/consema-core/src/location.rs — ValuePathSegment :4-14,
 * ValuePath :16-40, AssociationRole :42-51, AssociationLocation :53-89.
 * Consumed by materialization provenance and failure records (RFC 0004 §8,
 * materialization.rs).
 *
 * NOTE (recorded home): ValuePath/AssociationLocation are core-domain
 * concepts (they live in consema-core, not consema-document), but the TS
 * core module (`typescript/src/core/`) has landed without publishing them;
 * the document domain needs them for the materialization contracts, so
 * this module is the permanent home in the TypeScript implementation — a
 * faithful local mirror of the Rust core types, recorded duplication with
 * no pending integration (G84, 2026-08-14).
 *
 * Design (TypeScript-idiomatic): segments are a closed discriminated
 * union; paths are immutable classes with value equality; ordinals are
 * bigints (u64 on the wire).
 */

/** One segment of a root-relative portable value path (location.rs). */
export type ValuePathSegment =
  | { readonly kind: 'ObjectValue'; readonly name: string }
  | { readonly kind: 'SequenceElement'; readonly index: bigint }
  | { readonly kind: 'EntryKey'; readonly index: bigint }
  | { readonly kind: 'EntryValue'; readonly index: bigint };

/** A path to a value; the empty path denotes the root (location.rs). */
export class ValuePath {
  readonly #segments: readonly ValuePathSegment[];

  private constructor(segments: readonly ValuePathSegment[]) {
    this.#segments = segments;
  }

  /** Root path (location.rs). */
  static root(): ValuePath {
    return new ValuePath([]);
  }

  /** Returns path segments (location.rs). */
  segments(): readonly ValuePathSegment[] {
    return this.#segments;
  }

  /** Creates a child path without modifying this path (location.rs). */
  child(segment: ValuePathSegment): ValuePath {
    return new ValuePath([...this.#segments, segment]);
  }

  equals(other: ValuePath): boolean {
    if (this.#segments.length !== other.#segments.length) {
      return false;
    }
    for (let i = 0; i < this.#segments.length; i++) {
      const left = this.#segments[i];
      const right = other.#segments[i];
      if (left.kind !== right.kind) {
        return false;
      }
      switch (left.kind) {
        case 'ObjectValue':
          if (left.name !== (right as { name: string }).name) return false;
          break;
        case 'SequenceElement':
        case 'EntryKey':
        case 'EntryValue':
          if (left.index !== (right as { index: bigint }).index) return false;
          break;
      }
    }
    return true;
  }
}

/** Association kind independent from child values (location.rs). */
export type AssociationRole = 'ObjectEntry' | 'ObjectKey' | 'EntryMappingEntry';

/** Location of an association, not a portable value node (location.rs). */
export class AssociationLocation {
  readonly #container: ValuePath;
  readonly #ordinal: bigint;
  readonly #role: AssociationRole;

  constructor(container: ValuePath, ordinal: bigint, role: AssociationRole) {
    if (ordinal < 0n) {
      throw new RangeError('association ordinal must be non-negative');
    }
    this.#container = container;
    this.#ordinal = ordinal;
    this.#role = role;
  }

  /** Path of the containing value (location.rs). */
  container(): ValuePath {
    return this.#container;
  }

  /** Structural association ordinal (location.rs). */
  ordinal(): bigint {
    return this.#ordinal;
  }

  /** Association role (location.rs). */
  role(): AssociationRole {
    return this.#role;
  }
}
