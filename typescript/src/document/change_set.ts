/**
 * Complete immutable description of one atomic document transition.
 *
 * authority: crates/consema-document/src/lib.rs
 *  - SourceEdit :800-809 (ordered non-overlapping source replacement)
 *  - NodeMappingStatus :811-826 (Preserved | Replaced | Deleted | Split |
 *    Merged | Unmapped)
 *  - NodeMapping :828-839
 *  - ChangeSet :841-900 (binds one old and one new snapshot identity to
 *    ordered source edits, explicit node mappings, and operation
 *    diagnostics; ChangeSet remains the document-level change fact while
 *    SourcePatch remains the portable raw-byte application fact,
 *    RFC 0004 §16)
 *
 * Design (TypeScript-idiomatic): a plain immutable record. The Rust
 * constructor is doc(hidden) and trusts "already ordered validated facts";
 * validation of ordering and byte agreement happens in
 * `SourcePatch.derive`, exactly as in the Rust authority.
 */

import type { Diagnostic } from './diagnostic.ts';
import { NodeRef, SnapshotIdentity, Span } from './identity.ts';

/** One ordered non-overlapping source replacement (lib.rs:800-809). */
export class SourceEdit {
  readonly #oldSpan: Span;
  readonly #newSpan: Span;
  readonly #replacement: Uint8Array;

  constructor(oldSpan: Span, newSpan: Span, replacement: Uint8Array) {
    this.#oldSpan = oldSpan;
    this.#newSpan = newSpan;
    // V8 forbids Object.freeze on non-empty typed arrays (TypeError: Cannot
    // freeze array buffer views with elements); immutability is logical —
    // the edit retains its own private copy and the accessor is read-only.
    this.#replacement = Uint8Array.from(replacement);
  }

  /** Replaced old range (lib.rs:811-813). */
  oldSpan(): Span {
    return this.#oldSpan;
  }

  /** Range occupied by replacement bytes in the new snapshot (lib.rs:814-817). */
  newSpan(): Span {
    return this.#newSpan;
  }

  /** Exact replacement bytes (lib.rs:818-820); logically immutable — treat the returned buffer as read-only. */
  replacement(): Uint8Array {
    return this.#replacement;
  }
}

/** Explicit node mapping status across immutable snapshots (lib.rs:811-826). */
export type NodeMappingStatus =
  | 'Preserved'
  | 'Replaced'
  | 'Deleted'
  | 'Split'
  | 'Merged'
  | 'Unmapped';

/** One explicit old-to-new node mapping fact (lib.rs:828-839). */
export class NodeMapping {
  readonly #old: NodeRef;
  readonly #new: NodeRef | null;
  readonly #status: NodeMappingStatus;
  readonly #reason: string | null;

  constructor(old: NodeRef, status: NodeMappingStatus, new_: NodeRef | null, reason: string | null) {
    this.#old = old;
    this.#new = new_;
    this.#status = status;
    this.#reason = reason;
  }

  /** Old handle (lib.rs:833-835). */
  old(): NodeRef {
    return this.#old;
  }

  /** New handle when a one-to-one mapping is known (lib.rs:836-838). */
  new(): NodeRef | null {
    return this.#new;
  }

  /** Mapping status (lib.rs:839-842). */
  status(): NodeMappingStatus {
    return this.#status;
  }

  /** Stable reason for missing or non-trivial mapping (lib.rs:843-846). */
  reason(): string | null {
    return this.#reason;
  }
}

/** Complete immutable description of one atomic document transition (lib.rs:841-900). */
export class ChangeSet {
  readonly #oldSnapshot: SnapshotIdentity;
  readonly #newSnapshot: SnapshotIdentity;
  readonly #sourceEdits: readonly SourceEdit[];
  readonly #nodeMappings: readonly NodeMapping[];
  readonly #diagnostics: readonly Diagnostic[];

  /**
   * @internal — creates a complete change set from already ordered
   * validated facts (lib.rs:851-869, doc(hidden) in Rust).
   */
  constructor(
    oldSnapshot: SnapshotIdentity,
    newSnapshot: SnapshotIdentity,
    sourceEdits: readonly SourceEdit[],
    nodeMappings: readonly NodeMapping[],
    diagnostics: readonly Diagnostic[],
  ) {
    this.#oldSnapshot = oldSnapshot;
    this.#newSnapshot = newSnapshot;
    this.#sourceEdits = Object.freeze([...sourceEdits]);
    this.#nodeMappings = Object.freeze([...nodeMappings]);
    this.#diagnostics = Object.freeze([...diagnostics]);
  }

  /** Base snapshot (lib.rs:872-875). */
  oldSnapshot(): SnapshotIdentity {
    return this.#oldSnapshot;
  }

  /** Committed snapshot (lib.rs:877-880). */
  newSnapshot(): SnapshotIdentity {
    return this.#newSnapshot;
  }

  /** Ordered non-overlapping source edits (lib.rs:882-886). */
  sourceEdits(): readonly SourceEdit[] {
    return this.#sourceEdits;
  }

  /** Explicit node mappings (lib.rs:888-892). */
  nodeMappings(): readonly NodeMapping[] {
    return this.#nodeMappings;
  }

  /** Operation diagnostics, never written into either Document (lib.rs:893-899). */
  diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics;
  }
}
