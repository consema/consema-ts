/**
 * Portable value and association locations (provisional document-domain
 * mirror of the core domain).
 *
 * authority: crates/consema-core/src/location.rs — ValuePathSegment :4-14,
 * ValuePath :16-40, AssociationRole :42-51, AssociationLocation :53-89.
 * Consumed by materialization provenance and failure records (RFC 0004 §8,
 * materialization.rs:239-247, 327-351).
 *
 * NOTE (provisional home): ValuePath/AssociationLocation are core-domain
 * (they live in consema-core, not consema-document). The L0 core agent
 * owns `typescript/src/core/` and has not published these at blind-write
 * time; the document domain needs them for the materialization contracts,
 * so a faithful local mirror lives here until the core module lands and
 * this module re-exports it (documentation of the pending integration
 * point).
 *
 * Design (TypeScript-idiomatic): segments are a closed discriminated
 * union; paths are immutable classes with value equality; ordinals are
 * bigints (u64 on the wire).
 */

/** One segment of a root-relative portable value path (location.rs:4-14). */
export type ValuePathSegment =
  | { readonly kind: 'ObjectValue'; readonly name: string }
  | { readonly kind: 'SequenceElement'; readonly index: bigint }
  | { readonly kind: 'EntryKey'; readonly index: bigint }
  | { readonly kind: 'EntryValue'; readonly index: bigint };

/** A path to a value; the empty path denotes the root (location.rs:16-40). */
export class ValuePath {
  readonly #segments: readonly ValuePathSegment[];

  private constructor(segments: readonly ValuePathSegment[]) {
    this.#segments = segments;
  }

  /** Root path (location.rs:22-25). */
  static root(): ValuePath {
    return new ValuePath([]);
  }

  /** Returns path segments (location.rs:27-31). */
  segments(): readonly ValuePathSegment[] {
    return this.#segments;
  }

  /** Creates a child path without modifying this path (location.rs:33-39). */
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

/** Association kind independent from child values (location.rs:42-51). */
export type AssociationRole = 'ObjectEntry' | 'ObjectKey' | 'EntryMappingEntry';

/** Location of an association, not a portable value node (location.rs:53-89). */
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

  /** Path of the containing value (location.rs:72-76). */
  container(): ValuePath {
    return this.#container;
  }

  /** Structural association ordinal (location.rs:78-81). */
  ordinal(): bigint {
    return this.#ordinal;
  }

  /** Association role (location.rs:83-87). */
  role(): AssociationRole {
    return this.#role;
  }
}
