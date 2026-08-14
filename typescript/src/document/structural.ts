/**
 * Exhaustive source coverage: text structural pieces and binary regions.
 *
 * authority: consema-rs/consema-document/src/lib.rs（:N-M 区间引用，
 * 行号可能漂移，以符号名为锚）
 *  - StructuralPieceKind :413-422 (Token | Trivia | ErrorRegion)
 *  - StructuralPiece :424-449
 *  - LosslessStructuralIndex :451-490 (no-gap/no-overlap/final-length
 *    invariant; RFC 0003 §7)
 *  - BinaryRegion :492-528 (snapshot-bound Span, process-local NodeRef,
 *    non-empty stable format-owned kind; RFC 0003 §7)
 *  - BinaryStructuralIndex :530-579 (exact raw-byte coverage, unique
 *    identities; empty source has an empty valid index)
 *  - LocationError kinds: lib.rs; frozen names used by the
 *    vectors: conformance/vectors/source-v1.json:117 ("IncompleteStructuralCoverage")
 *    and consema-rs/consema-conformance/src/source_v1.rs
 *
 * Design (TypeScript-idiomatic): plain immutable records for pieces and
 * regions; the indexes validate the exact-coverage invariant at
 * construction, so a published index always covers every source byte once.
 */

import { LocationError } from './errors.ts';
import { NodeRef, Span, SnapshotIdentity } from './identity.ts';

/** One exhaustive source-byte classification (lib.rs). */
export type StructuralPieceKind = 'Token' | 'Trivia' | 'ErrorRegion';

/** One source byte interval and its lossless class (lib.rs). */
export class StructuralPiece {
  readonly #span: Span;
  readonly #kind: StructuralPieceKind;

  constructor(span: Span, kind: StructuralPieceKind) {
    this.#span = span;
    this.#kind = kind;
  }

  /** Exact source range (lib.rs). */
  span(): Span {
    return this.#span;
  }

  /** Classification (lib.rs). */
  kind(): StructuralPieceKind {
    return this.#kind;
  }
}

/** Exhaustive ordered token/trivia/error-region coverage (lib.rs). */
export class LosslessStructuralIndex {
  readonly #pieces: readonly StructuralPiece[];

  private constructor(pieces: readonly StructuralPiece[]) {
    this.#pieces = pieces;
  }

  /** Validates exact source coverage and stores pieces in structural order (lib.rs). */
  static create(identity: SnapshotIdentity, sourceLen: number, pieces: readonly StructuralPiece[]): LosslessStructuralIndex {
    let next = 0;
    for (const piece of pieces) {
      const span = piece.span();
      if (!span.snapshot().equals(identity)) {
        throw new LocationError('WrongSnapshot');
      }
      if (
        span.startByte() !== next ||
        span.endByte() <= span.startByte() ||
        span.endByte() > sourceLen
      ) {
        throw new LocationError('IncompleteStructuralCoverage');
      }
      next = span.endByte();
    }
    if (next !== sourceLen) {
      throw new LocationError('IncompleteStructuralCoverage');
    }
    return new LosslessStructuralIndex(Object.freeze([...pieces]));
  }

  /** Ordered exhaustive pieces (lib.rs). */
  pieces(): readonly StructuralPiece[] {
    return this.#pieces;
  }
}

/** One format-owned region in an opaque binary source (lib.rs). */
export class BinaryRegion {
  readonly #node: NodeRef;
  readonly #span: Span;
  readonly #kind: string;

  constructor(node: NodeRef, span: Span, kind: string) {
    this.#node = node;
    this.#span = span;
    this.#kind = kind;
  }

  /** Process-local structural identity (lib.rs). */
  nodeRef(): NodeRef {
    return this.#node;
  }

  /** Exact raw byte range (lib.rs). */
  span(): Span {
    return this.#span;
  }

  /** Non-empty stable format-owned kind (lib.rs). */
  kind(): string {
    return this.#kind;
  }
}

/** Exhaustive ordered format-owned region coverage for one opaque binary source (lib.rs). */
export class BinaryStructuralIndex {
  readonly #regions: readonly BinaryRegion[];

  private constructor(regions: readonly BinaryRegion[]) {
    this.#regions = regions;
  }

  /**
   * Validates exact raw-byte coverage, snapshot binding, roles, kinds, and
   * unique identities (lib.rs). Empty source has an empty valid
   * index; non-empty source requires at least one non-empty region
   * (RFC 0003 §7).
   */
  static create(
    identity: SnapshotIdentity,
    sourceLen: number,
    regions: readonly BinaryRegion[],
  ): BinaryStructuralIndex {
    let next = 0;
    // NodeRef is a value type (equals), so Set<NodeRef> would dedupe by
    // object identity and miss value-equal duplicates; scan with equals.
    const identities: NodeRef[] = [];
    for (const region of regions) {
      const span = region.span();
      const node = region.nodeRef();
      if (!span.snapshot().equals(identity) || !node.snapshot().equals(identity)) {
        throw new LocationError('WrongSnapshot');
      }
      if (node.role() !== 'BinaryRegion') {
        throw new LocationError('WrongRole');
      }
      if (region.kind().length === 0) {
        throw new LocationError('InvalidBinaryRegionKind');
      }
      if (identities.some((existing) => existing.equals(node))) {
        throw new LocationError('DuplicateStructuralIdentity');
      }
      identities.push(node);
      if (
        span.startByte() !== next ||
        span.endByte() <= span.startByte() ||
        span.endByte() > sourceLen
      ) {
        throw new LocationError('IncompleteStructuralCoverage');
      }
      next = span.endByte();
    }
    if (next !== sourceLen) {
      throw new LocationError('IncompleteStructuralCoverage');
    }
    return new BinaryStructuralIndex(Object.freeze([...regions]));
  }

  /** Ordered exhaustive regions (lib.rs). */
  regions(): readonly BinaryRegion[] {
    return this.#regions;
  }
}
