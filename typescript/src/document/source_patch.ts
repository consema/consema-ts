/**
 * Verifiable raw-byte patches between immutable source snapshots.
 *
 * authority:
 *  - RFC 0003 §10 (docs/rfcs/0003-source-syntax-query-and-patch-v1.md:
 *    250-291): `core.source-patch@1` fields, replacement facts, and the
 *    application rules — half-open ordered non-overlapping old ranges,
 *    original exactly equals the base bytes, zero-width insertions
 *    permitted but two replacements may not target the same insertion
 *    point, base digest / encoding facts / every original-byte
 *    precondition / computed target digest must match, atomic failure
 *    returns no new snapshot, successful application reruns encoding
 *    resolution, metadata never affects application, redaction flags
 *    control review presentation only
 *  - vectors: conformance/vectors/source-v1.json:120-172 (source.patch.*)
 *  - Rust (arbitration): crates/consema-document/src/source_patch.rs —
 *    SourcePatchLimits :8-27 (defaults: source limits, 100_000
 *    replacements, 128 MiB patch bytes), SourceReplacement :29-131,
 *    SourcePatch :133-365 (derive :143-205, new :206-224, create :226-251,
 *    apply :253-280), redaction :312-364, error kinds :387-432, code
 *    mapping :434-459, validation :469-566
 *  - conformance runner: crates/consema-conformance/src/source_v1.rs:245-317
 *    (patch case modes create-apply / stale-base / wrong-original /
 *    overlap / count-limit / wrong-target / encoding-change)
 *
 * Design (TypeScript-idiomatic): SourceReplacement is an immutable class
 * with builder methods for redaction flags; SourcePatch is an immutable
 * class with static factories (new / create / derive) and `apply`.
 * Validation mirrors the Rust `validate_replacements` / `apply_replacements`
 * exactly, including limit names ("patch-replacements", "patch-bytes",
 * "target-raw-bytes") that appear in resource-limit arguments.
 */

import { ContentDigest } from './sha256.ts';
import {
  SourceError,
  SourcePatchError,
  SourcePatchRedactionError,
} from './errors.ts';
import {
  DEFAULT_SOURCE_LIMITS,
  EncodingFacts,
  type SourceLimits,
  SourceSnapshot,
} from './source.ts';
import { ChangeSet } from './change_set.ts';

/** Resource bounds for constructing or applying one source patch (source_patch.rs:8-27). */
export interface SourcePatchLimits {
  /** Limits for the resulting source snapshot. */
  readonly source: SourceLimits;
  /** Maximum number of ordered replacements. */
  readonly maxReplacements: number;
  /** Maximum sum of original and replacement payload bytes. */
  readonly maxPatchBytes: number;
}

/** The frozen defaults (source_patch.rs:19-27): default source limits, 100_000 replacements, 128 MiB patch bytes. */
export const DEFAULT_SOURCE_PATCH_LIMITS: Readonly<SourcePatchLimits> = Object.freeze({
  source: DEFAULT_SOURCE_LIMITS,
  maxReplacements: 100_000,
  maxPatchBytes: 128 * 1024 * 1024,
});

/** One raw-byte precondition and replacement in a source patch (source_patch.rs:29-131). */
export class SourceReplacement {
  readonly #oldStart: number;
  readonly #oldEnd: number;
  readonly #original: Uint8Array;
  readonly #replacement: Uint8Array;
  // Not `readonly`: the redaction flags are reassigned on the private copy
  // in the with*/#copy methods; the copy is never published, so logical
  // immutability of completed replacements is preserved.
  #redactOriginal: boolean;
  #redactReplacement: boolean;

  constructor(oldStart: number, oldEnd: number, original: Uint8Array, replacement: Uint8Array) {
    this.#oldStart = oldStart;
    this.#oldEnd = oldEnd;
    // V8 forbids Object.freeze on non-empty typed arrays (TypeError: Cannot
    // freeze array buffer views with elements); immutability is logical —
    // the replacement retains private copies and accessors are read-only.
    this.#original = Uint8Array.from(original);
    this.#replacement = Uint8Array.from(replacement);
    this.#redactOriginal = false;
    this.#redactReplacement = false;
  }

  /** Controls whether the original bytes are hidden in review/debug presentation (source_patch.rs:59-63). */
  withOriginalRedacted(redacted: boolean): SourceReplacement {
    const copy = this.#copy();
    copy.#redactOriginal = redacted;
    return copy;
  }

  /** Controls whether replacement bytes are hidden in review/debug presentation (source_patch.rs:65-70). */
  withReplacementRedacted(redacted: boolean): SourceReplacement {
    const copy = this.#copy();
    copy.#redactReplacement = redacted;
    return copy;
  }

  #copy(): SourceReplacement {
    const copy = new SourceReplacement(this.#oldStart, this.#oldEnd, this.#original, this.#replacement);
    copy.#redactOriginal = this.#redactOriginal;
    copy.#redactReplacement = this.#redactReplacement;
    return copy;
  }

  /** Inclusive start raw byte (source_patch.rs:73-77). */
  oldStart(): number {
    return this.#oldStart;
  }

  /** Exclusive end raw byte (source_patch.rs:79-83). */
  oldEnd(): number {
    return this.#oldEnd;
  }

  /** Exact bytes required at the old range (source_patch.rs:85-89); logically immutable — treat the returned buffer as read-only. */
  original(): Uint8Array {
    return this.#original;
  }

  /** Exact bytes written in place of the old range (source_patch.rs:91-95); logically immutable — treat the returned buffer as read-only. */
  replacement(): Uint8Array {
    return this.#replacement;
  }

  /** Whether review/debug presentation hides the original bytes (source_patch.rs:97-101). */
  redactOriginal(): boolean {
    return this.#redactOriginal;
  }

  /** Whether review/debug presentation hides the replacement bytes (source_patch.rs:103-107). */
  redactReplacement(): boolean {
    return this.#redactReplacement;
  }

  /** Review/debug presentation honoring the redaction flags (source_patch.rs:110-131). */
  debugString(): string {
    const original = this.#redactOriginal ? '<redacted>' : bytesToHex(this.#original);
    const replacement = this.#redactReplacement ? '<redacted>' : bytesToHex(this.#replacement);
    return `SourceReplacement { old_start: ${this.#oldStart}, old_end: ${this.#oldEnd}, ` +
      `original: ${original}, replacement: ${replacement}, redact_original: ${this.#redactOriginal}, ` +
      `redact_replacement: ${this.#redactReplacement} }`;
  }
}

/**
 * Immutable, transferable facts needed to verify one raw source
 * transition (source_patch.rs:133-141).
 */
export class SourcePatch {
  readonly #baseDigest: ContentDigest;
  readonly #targetDigest: ContentDigest;
  readonly #encoding: EncodingFacts;
  readonly #replacements: readonly SourceReplacement[];
  readonly #metadata: ReadonlyMap<string, string>;

  private constructor(
    baseDigest: ContentDigest,
    targetDigest: ContentDigest,
    encoding: EncodingFacts,
    replacements: readonly SourceReplacement[],
    metadata: ReadonlyMap<string, string>,
  ) {
    this.#baseDigest = baseDigest;
    this.#targetDigest = targetDigest;
    this.#encoding = encoding;
    this.#replacements = Object.freeze([...replacements]);
    this.#metadata = new Map(metadata);
  }

  /**
   * Creates a patch from externally supplied facts after structural and
   * resource validation (the Rust `new`, source_patch.rs:206-224).
   */
  static create(
    baseDigest: ContentDigest,
    targetDigest: ContentDigest,
    encoding: EncodingFacts,
    replacements: readonly SourceReplacement[],
    metadata: ReadonlyMap<string, string>,
    limits: SourcePatchLimits,
  ): SourcePatch;
  /** Builds a self-consistent patch against one immutable base snapshot (the Rust `create`, source_patch.rs:226-251). */
  static create(
    base: SourceSnapshot,
    replacements: readonly SourceReplacement[],
    metadata: ReadonlyMap<string, string>,
    limits: SourcePatchLimits,
  ): SourcePatch;
  static create(
    first: ContentDigest | SourceSnapshot,
    second: ContentDigest | readonly SourceReplacement[],
    third: EncodingFacts | ReadonlyMap<string, string>,
    fourth: readonly SourceReplacement[] | SourcePatchLimits,
    fifth?: ReadonlyMap<string, string>,
    sixth?: SourcePatchLimits,
  ): SourcePatch {
    if (first instanceof ContentDigest) {
      const baseDigest = first;
      const targetDigest = second as ContentDigest;
      const encoding = third as EncodingFacts;
      const replacements = fourth as readonly SourceReplacement[];
      const metadata = (fifth ?? new Map()) as ReadonlyMap<string, string>;
      const limits = sixth as SourcePatchLimits;
      validateReplacements(replacements, limits);
      return new SourcePatch(baseDigest, targetDigest, encoding, replacements, metadata);
    }
    const base = first;
    const replacements = second as readonly SourceReplacement[];
    const metadata = third as ReadonlyMap<string, string>;
    const limits = fourth as SourcePatchLimits;
    validateReplacements(replacements, limits);
    const targetBytes = applyReplacements(base.bytes(), replacements, limits);
    const target = wrapSourceFailure(() =>
      SourceSnapshot.fromRaw(targetBytes, base.encodingFacts().resolutionRequest(), limits.source),
    );
    if (!target.encodingFacts().equals(base.encodingFacts())) {
      throw new SourcePatchError('EncodingMismatch');
    }
    return new SourcePatch(
      base.digest(),
      target.digest(),
      base.encodingFacts(),
      replacements,
      metadata,
    );
  }

  /** Derives and verifies a portable patch from one complete document-level change fact (source_patch.rs:143-205). */
  static derive(
    base: SourceSnapshot,
    target: SourceSnapshot,
    changeSet: ChangeSet,
    metadata: ReadonlyMap<string, string>,
    limits: SourcePatchLimits,
  ): SourcePatch {
    if (!base.encodingFacts().equals(target.encodingFacts())) {
      throw new SourcePatchError('EncodingMismatch');
    }
    const edits = changeSet.sourceEdits();
    if (edits.length > limits.maxReplacements) {
      throw new SourcePatchError('ResourceLimit', {
        limitName: 'patch-replacements',
        observed: edits.length,
        limit: limits.maxReplacements,
      });
    }
    const replacements: SourceReplacement[] = [];
    let previousNew: { start: number; end: number } | null = null;
    for (let index = 0; index < edits.length; index++) {
      const edit = edits[index];
      const oldSpan = edit.oldSpan();
      const newSpan = edit.newSpan();
      const baseBytes = base.bytes();
      const targetBytes = target.bytes();
      if (
        !oldSpan.snapshot().equals(changeSet.oldSnapshot()) ||
        !newSpan.snapshot().equals(changeSet.newSnapshot()) ||
        oldSpan.endByte() > baseBytes.length ||
        newSpan.endByte() > targetBytes.length ||
        !bytesEqual(edit.replacement(), targetBytes.slice(newSpan.startByte(), newSpan.endByte()))
      ) {
        throw new SourcePatchError('ChangeSetMismatch', { index });
      }
      const newRange = { start: newSpan.startByte(), end: newSpan.endByte() };
      if (
        previousNew !== null &&
        (newRange.start < previousNew.end ||
          (newRange.start === previousNew.start && newRange.end <= previousNew.end))
      ) {
        // New ranges must be strictly increasing: new_range <= previous or
        // new_range.0 < previous.1 is a ChangeSetMismatch (source_patch.rs:175-179).
        throw new SourcePatchError('ChangeSetMismatch', { index });
      }
      const original = baseBytes.slice(oldSpan.startByte(), oldSpan.endByte());
      replacements.push(new SourceReplacement(oldSpan.startByte(), oldSpan.endByte(), original, edit.replacement()));
      previousNew = newRange;
    }
    const patch = SourcePatch.create(
      base.digest(),
      target.digest(),
      base.encodingFacts(),
      replacements,
      metadata,
      limits,
    );
    const reapplied = patch.apply(base, limits);
    if (!bytesEqual(reapplied.bytes(), target.bytes())) {
      throw new SourcePatchError('TargetMismatch');
    }
    return patch;
  }

  /** Applies all facts atomically and returns a new immutable snapshot only on complete success (source_patch.rs:253-280). */
  apply(base: SourceSnapshot, limits: SourcePatchLimits): SourceSnapshot {
    validateReplacements(this.#replacements, limits);
    if (!base.digest().equals(this.#baseDigest)) {
      throw new SourcePatchError('BaseMismatch');
    }
    if (!base.encodingFacts().equals(this.#encoding)) {
      throw new SourcePatchError('EncodingMismatch');
    }
    const targetBytes = applyReplacements(base.bytes(), this.#replacements, limits);
    const target = wrapSourceFailure(() =>
      SourceSnapshot.fromRaw(targetBytes, this.#encoding.resolutionRequest(), limits.source),
    );
    if (!target.encodingFacts().equals(this.#encoding)) {
      throw new SourcePatchError('EncodingMismatch');
    }
    if (!target.digest().equals(this.#targetDigest)) {
      throw new SourcePatchError('TargetMismatch');
    }
    return target;
  }

  /** Required base content identity (source_patch.rs:282-286). */
  baseDigest(): ContentDigest {
    return this.#baseDigest;
  }

  /** Required result content identity (source_patch.rs:288-292). */
  targetDigest(): ContentDigest {
    return this.#targetDigest;
  }

  /** Encoding facts that both base and result must reproduce (source_patch.rs:294-298). */
  encodingFacts(): EncodingFacts {
    return this.#encoding;
  }

  /** Ordered non-overlapping replacements (source_patch.rs:300-304). */
  replacements(): readonly SourceReplacement[] {
    return this.#replacements;
  }

  /** Deterministically ordered audit metadata, which never affects application (source_patch.rs:306-310). */
  metadata(): ReadonlyMap<string, string> {
    return this.#metadata;
  }

  /** Marks every replacement payload for redacted review/debug presentation (source_patch.rs:312-336). */
  withAllReplacementsRedacted(redactOriginal: boolean, redactReplacement: boolean): SourcePatch {
    return new SourcePatch(
      this.#baseDigest,
      this.#targetDigest,
      this.#encoding,
      this.#replacements.map((replacement) =>
        replacement.withOriginalRedacted(redactOriginal).withReplacementRedacted(redactReplacement),
      ),
      this.#metadata,
    );
  }

  /** Marks one exact replacement payload for redacted review/debug presentation (source_patch.rs:338-364). */
  withReplacementRedacted(
    index: number,
    redactOriginal: boolean,
    redactReplacement: boolean,
  ): SourcePatch {
    if (index >= this.#replacements.length) {
      throw new SourcePatchRedactionError('UnknownReplacement', index);
    }
    const replacements = this.#replacements.map((replacement, position) =>
      position === index
        ? replacement.withOriginalRedacted(redactOriginal).withReplacementRedacted(redactReplacement)
        : replacement,
    );
    return new SourcePatch(this.#baseDigest, this.#targetDigest, this.#encoding, replacements, this.#metadata);
  }
}

/** Wraps a source-construction failure as SourcePatchError::Source (source_patch.rs:430-432). */
function wrapSourceFailure<T>(build: () => T): T {
  try {
    return build();
  } catch (error) {
    if (error instanceof SourceError) {
      throw new SourcePatchError('Source', { source: error });
    }
    throw error;
  }
}

/** Structural and resource validation of an ordered replacement set (source_patch.rs:469-512). */
function validateReplacements(
  replacements: readonly SourceReplacement[],
  limits: SourcePatchLimits,
): void {
  if (replacements.length > limits.maxReplacements) {
    throw new SourcePatchError('ResourceLimit', {
      limitName: 'patch-replacements',
      observed: replacements.length,
      limit: limits.maxReplacements,
    });
  }
  let patchBytes = 0;
  let previous: SourceReplacement | null = null;
  for (let index = 0; index < replacements.length; index++) {
    const replacement = replacements[index];
    if (
      replacement.oldStart() > replacement.oldEnd() ||
      replacement.original().length !== replacement.oldEnd() - replacement.oldStart()
    ) {
      throw new SourcePatchError('InvalidReplacement', { index });
    }
    if (previous !== null) {
      if (
        replacement.oldStart() === replacement.oldEnd() &&
        previous.oldStart() === previous.oldEnd() &&
        replacement.oldStart() === previous.oldStart()
      ) {
        throw new SourcePatchError('DuplicateInsertion', { index });
      }
      const ordered =
        replacement.oldStart() > previous.oldStart() ||
        (replacement.oldStart() === previous.oldStart() && replacement.oldEnd() > previous.oldEnd());
      if (!ordered || replacement.oldStart() < previous.oldEnd()) {
        throw new SourcePatchError('ReplacementOrder', { index });
      }
    }
    patchBytes = patchBytes + replacement.original().length + replacement.replacement().length;
    if (patchBytes > limits.maxPatchBytes) {
      throw new SourcePatchError('ResourceLimit', {
        limitName: 'patch-bytes',
        observed: patchBytes,
        limit: limits.maxPatchBytes,
      });
    }
    previous = replacement;
  }
}

/** Applies an ordered replacement set to base bytes (source_patch.rs:514-554). */
function applyReplacements(
  base: Uint8Array,
  replacements: readonly SourceReplacement[],
  limits: SourcePatchLimits,
): Uint8Array {
  let targetLen = base.length;
  for (let index = 0; index < replacements.length; index++) {
    const replacement = replacements[index];
    if (
      replacement.oldEnd() > base.length ||
      !bytesEqual(base.slice(replacement.oldStart(), replacement.oldEnd()), replacement.original())
    ) {
      throw new SourcePatchError('OriginalMismatch', { index });
    }
    targetLen = targetLen - replacement.original().length + replacement.replacement().length;
    if (targetLen > limits.source.maxRawBytes) {
      throw new SourcePatchError('ResourceLimit', {
        limitName: 'target-raw-bytes',
        observed: targetLen,
        limit: limits.source.maxRawBytes,
      });
    }
  }

  const target = new Uint8Array(targetLen);
  let cursor = 0;
  let output = 0;
  for (const replacement of replacements) {
    target.set(base.slice(cursor, replacement.oldStart()), output);
    output += replacement.oldStart() - cursor;
    target.set(replacement.replacement(), output);
    output += replacement.replacement().length;
    cursor = replacement.oldEnd();
  }
  target.set(base.slice(cursor), output);
  return target;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) {
      return false;
    }
  }
  return true;
}

function bytesToHex(bytes: Uint8Array): string {
  let output = '';
  for (const byte of bytes) {
    output += byte.toString(16).padStart(2, '0');
  }
  return output;
}
