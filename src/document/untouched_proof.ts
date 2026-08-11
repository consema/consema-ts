/**
 * Verifiable proof that planned replacements did not alter surrounding bytes.
 *
 * authority:
 *  - RFC 0004 §15 (docs/rfcs/0004-materialization-conversion-and-
 *    structural-edit-v1.md:358-372): an ordered cover of all old-source
 *    intervals outside replacements mapped to target intervals; old regions
 *    exactly cover every non-replaced old byte once, new regions exactly
 *    cover every non-inserted new byte once, each mapped region has equal
 *    length and equal bytes, region order is monotonic, base and target
 *    digests match the proof
 *  - Rust: crates/consema-document/src/untouched_proof.rs —
 *    UntouchedByteRegion :7-59, UntouchedByteProof :61-132 (create :70-82,
 *    from_facts :84-96, verify :98-113), error kinds :134-172, region
 *    derivation :182-245, validation :247-317
 *
 * Design (TypeScript-idiomatic): immutable classes; `verify` recomputes
 * the canonical region set from the supplied snapshots and replacements
 * and compares it to the stored facts, exactly like the Rust authority.
 */

import { UntouchedByteProofError } from './errors.ts';
import { ContentDigest } from './sha256.ts';
import { SourceReplacement } from './source_patch.ts';
import { SourceSnapshot } from './source.ts';

/** One maximal unchanged raw-byte interval mapped across two source snapshots (untouched_proof.rs:7-59). */
export class UntouchedByteRegion {
  readonly #oldStart: number;
  readonly #oldEnd: number;
  readonly #newStart: number;
  readonly #newEnd: number;

  constructor(oldStart: number, oldEnd: number, newStart: number, newEnd: number) {
    this.#oldStart = oldStart;
    this.#oldEnd = oldEnd;
    this.#newStart = newStart;
    this.#newEnd = newEnd;
  }

  /** Inclusive start in the base snapshot (untouched_proof.rs:28-31). */
  oldStart(): number {
    return this.#oldStart;
  }

  /** Exclusive end in the base snapshot (untouched_proof.rs:33-36). */
  oldEnd(): number {
    return this.#oldEnd;
  }

  /** Inclusive start in the target snapshot (untouched_proof.rs:38-41). */
  newStart(): number {
    return this.#newStart;
  }

  /** Exclusive end in the target snapshot (untouched_proof.rs:43-46). */
  newEnd(): number {
    return this.#newEnd;
  }

  #oldLen(): number {
    return this.#oldEnd - this.#oldStart;
  }

  #newLen(): number {
    return this.#newEnd - this.#newStart;
  }

  equals(other: UntouchedByteRegion): boolean {
    return (
      this.#oldStart === other.#oldStart &&
      this.#oldEnd === other.#oldEnd &&
      this.#newStart === other.#newStart &&
      this.#newEnd === other.#newEnd
    );
  }
}

/** Immutable evidence for every byte outside one exact replacement plan (untouched_proof.rs:61-67). */
export class UntouchedByteProof {
  readonly #baseDigest: ContentDigest;
  readonly #targetDigest: ContentDigest;
  readonly #regions: readonly UntouchedByteRegion[];

  private constructor(
    baseDigest: ContentDigest,
    targetDigest: ContentDigest,
    regions: readonly UntouchedByteRegion[],
  ) {
    this.#baseDigest = baseDigest;
    this.#targetDigest = targetDigest;
    this.#regions = Object.freeze([...regions]);
  }

  /** Creates a proof only when the replacements exactly produce the supplied target snapshot (untouched_proof.rs:69-82). */
  static create(
    base: SourceSnapshot,
    target: SourceSnapshot,
    replacements: readonly SourceReplacement[],
  ): UntouchedByteProof {
    const regions = expectedRegions(base, target, replacements);
    return new UntouchedByteProof(base.digest(), target.digest(), regions);
  }

  /** Constructs transferable proof facts after validating their canonical structure (untouched_proof.rs:84-96). */
  static fromFacts(
    baseDigest: ContentDigest,
    targetDigest: ContentDigest,
    regions: readonly UntouchedByteRegion[],
  ): UntouchedByteProof {
    validateRegions(regions);
    return new UntouchedByteProof(baseDigest, targetDigest, regions);
  }

  /** Rechecks digests, replacement preconditions, exact target bytes, and every region fact (untouched_proof.rs:98-113). */
  verify(
    base: SourceSnapshot,
    target: SourceSnapshot,
    replacements: readonly SourceReplacement[],
  ): void {
    if (!base.digest().equals(this.#baseDigest) || !target.digest().equals(this.#targetDigest)) {
      throw new UntouchedByteProofError('DigestMismatch');
    }
    const expected = expectedRegions(base, target, replacements);
    if (expected.length !== this.#regions.length) {
      throw new UntouchedByteProofError('ProofMismatch');
    }
    for (let i = 0; i < expected.length; i++) {
      if (!expected[i].equals(this.#regions[i])) {
        throw new UntouchedByteProofError('ProofMismatch');
      }
    }
  }

  /** Required base digest (untouched_proof.rs:114-119). */
  baseDigest(): ContentDigest {
    return this.#baseDigest;
  }

  /** Required target digest (untouched_proof.rs:121-126). */
  targetDigest(): ContentDigest {
    return this.#targetDigest;
  }

  /** Canonical maximal unchanged regions (untouched_proof.rs:128-131). */
  regions(): readonly UntouchedByteRegion[] {
    return this.#regions;
  }
}

/** Derives the canonical maximal unchanged regions (untouched_proof.rs:182-245). */
function expectedRegions(
  base: SourceSnapshot,
  target: SourceSnapshot,
  replacements: readonly SourceReplacement[],
): UntouchedByteRegion[] {
  if (!base.encodingFacts().equals(target.encodingFacts())) {
    throw new UntouchedByteProofError('EncodingMismatch');
  }
  const regions: UntouchedByteRegion[] = [];
  let oldCursor = 0;
  let newCursor = 0;
  let previous: SourceReplacement | null = null;
  const baseBytes = base.bytes();
  const targetBytes = target.bytes();

  for (let index = 0; index < replacements.length; index++) {
    const replacement = replacements[index];
    validateReplacement(baseBytes, previous, replacement, index);

    const unchangedLen = replacement.oldStart() - oldCursor;
    const newUnchangedEnd = newCursor + unchangedLen;
    if (!bytesRangeEqual(targetBytes, newCursor, newUnchangedEnd, baseBytes, oldCursor, replacement.oldStart())) {
      throw new UntouchedByteProofError('TargetMismatch');
    }
    pushRegion(regions, new UntouchedByteRegion(oldCursor, replacement.oldStart(), newCursor, newUnchangedEnd));

    const replacementEnd = newUnchangedEnd + replacement.replacement().length;
    if (!bytesRangeEqual(targetBytes, newUnchangedEnd, replacementEnd, replacement.replacement(), 0, replacement.replacement().length)) {
      throw new UntouchedByteProofError('TargetMismatch');
    }
    oldCursor = replacement.oldEnd();
    newCursor = replacementEnd;
    previous = replacement;
  }

  const tailLen = baseBytes.length - oldCursor;
  const newEnd = newCursor + tailLen;
  if (
    newEnd !== targetBytes.length ||
    !bytesRangeEqual(targetBytes, newCursor, newEnd, baseBytes, oldCursor, baseBytes.length)
  ) {
    throw new UntouchedByteProofError('TargetMismatch');
  }
  pushRegion(regions, new UntouchedByteRegion(oldCursor, baseBytes.length, newCursor, newEnd));
  validateRegions(regions);
  return regions;
}

/** One replacement's structural and byte preconditions (untouched_proof.rs:247-281). */
function validateReplacement(
  baseBytes: Uint8Array,
  previous: SourceReplacement | null,
  replacement: SourceReplacement,
  index: number,
): void {
  if (
    replacement.oldStart() > replacement.oldEnd() ||
    replacement.oldEnd() > baseBytes.length ||
    replacement.original().length !== replacement.oldEnd() - replacement.oldStart()
  ) {
    throw new UntouchedByteProofError('InvalidReplacement', index);
  }
  if (previous !== null) {
    if (
      replacement.oldStart() === replacement.oldEnd() &&
      previous.oldStart() === previous.oldEnd() &&
      replacement.oldStart() === previous.oldStart()
    ) {
      throw new UntouchedByteProofError('DuplicateInsertion', index);
    }
    const ordered =
      replacement.oldStart() > previous.oldStart() ||
      (replacement.oldStart() === previous.oldStart() && replacement.oldEnd() > previous.oldEnd());
    if (!ordered || replacement.oldStart() < previous.oldEnd()) {
      throw new UntouchedByteProofError('ReplacementOrder', index);
    }
  }
  if (!bytesRangeEqual(baseBytes, replacement.oldStart(), replacement.oldEnd(), replacement.original(), 0, replacement.original().length)) {
    throw new UntouchedByteProofError('OriginalMismatch', index);
  }
}

/** Appends one region, merging adjacent intervals (untouched_proof.rs:283-295). */
function pushRegion(regions: UntouchedByteRegion[], region: UntouchedByteRegion): void {
  if (region.oldStart() === region.oldEnd()) {
    return;
  }
  const previous = regions[regions.length - 1];
  if (previous !== undefined && previous.oldEnd() === region.oldStart() && previous.newEnd() === region.newStart()) {
    regions[regions.length - 1] = new UntouchedByteRegion(
      previous.oldStart(),
      region.oldEnd(),
      previous.newStart(),
      region.newEnd(),
    );
    return;
  }
  regions.push(region);
}

/** Canonical region facts: valid ranges, equal lengths, monotonic order (untouched_proof.rs:297-317). */
function validateRegions(regions: readonly UntouchedByteRegion[]): void {
  let previous: UntouchedByteRegion | null = null;
  for (let index = 0; index < regions.length; index++) {
    const region = regions[index];
    if (
      region.oldStart() >= region.oldEnd() ||
      region.newStart() >= region.newEnd() ||
      region.oldEnd() - region.oldStart() !== region.newEnd() - region.newStart()
    ) {
      throw new UntouchedByteProofError('InvalidRegion', index);
    }
    if (previous !== null) {
      if (
        region.oldStart() < previous.oldEnd() ||
        region.newStart() < previous.newEnd() ||
        (region.oldStart() === previous.oldEnd() && region.newStart() === previous.newEnd())
      ) {
        throw new UntouchedByteProofError('InvalidRegion', index);
      }
    }
    previous = region;
  }
}

function bytesRangeEqual(
  left: Uint8Array,
  leftStart: number,
  leftEnd: number,
  right: Uint8Array,
  rightStart: number,
  rightEnd: number,
): boolean {
  if (leftEnd - leftStart !== rightEnd - rightStart) {
    return false;
  }
  for (let i = 0; i < leftEnd - leftStart; i++) {
    if (left[leftStart + i] !== right[rightStart + i]) {
      return false;
    }
  }
  return true;
}
