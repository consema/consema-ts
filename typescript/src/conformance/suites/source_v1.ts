/**
 * `consema.source.conformance@1` runner (28 cases; mirror of
 * crates/consema-conformance/src/source_v1.rs).
 */

import type { VectorCase } from '../helpers.ts';
import { caseField, caseFieldOptional, expectedField, expectedFieldOptional, hexToBytes, toHex, utf8 } from '../helpers.ts';
import { fail, skip, SkippedCase } from './common.ts';
import type { SuiteExecutor } from '../runner.ts';
import { ContentDigest } from '../../document/sha256.ts';
import {
  SourceSnapshot,
  EncodingRequest,
  binaryEncoding,
  utf8Encoding,
  utf16LeEncoding,
  utf16BeEncoding,
  latin1Encoding,
  encodingAsStr,
  UNBOUNDED_SOURCE_LIMITS,
} from '../../document/source.ts';
import type { SourceEncoding, SourceLimits } from '../../document/source.ts';
import { SourceError, SourcePatchError } from '../../document/errors.ts';
import { DocumentAuthority } from '../../document/identity.ts';
import { BinaryStructuralIndex } from '../../document/structural.ts';
import type { BinaryRegion } from '../../document/structural.ts';
import { BinaryRegion as BinaryRegionClass } from '../../document/structural.ts';
import {
  SourcePatch,
  SourceReplacement,
  DEFAULT_SOURCE_PATCH_LIMITS,
} from '../../document/source_patch.ts';
import type { SourcePatchLimits } from '../../document/source_patch.ts';

function encodingOf(name: string): SourceEncoding {
  switch (name) {
    case 'utf-8':
      return utf8Encoding();
    case 'utf-16le':
      return utf16LeEncoding();
    case 'utf-16be':
      return utf16BeEncoding();
    case 'latin-1':
      return latin1Encoding();
    case 'binary':
      return binaryEncoding();
    default:
      fail(`unknown encoding ${name}`);
  }
}

function fromRawCase(case_: VectorCase, limits: SourceLimits = UNBOUNDED_SOURCE_LIMITS): SourceSnapshot {
  const raw = hexToBytes(caseField(case_, 'raw_hex') as string);
  const encoding = encodingOf(caseField(case_, 'encoding') as string);
  let request = EncodingRequest.create(encoding);
  const declaration = caseFieldOptional(case_, 'declaration') as string | undefined;
  if (declaration !== undefined) {
    request = request.withDeclaration(encodingOf(declaration));
  }
  const callerOverride = caseFieldOptional(case_, 'caller_override') as string | undefined;
  if (callerOverride !== undefined) {
    request = request.withCallerOverride(encodingOf(callerOverride));
  }
  return SourceSnapshot.fromRaw(raw, request, limits);
}

function sourceErrorCode(error: SourceError): string {
  return error.code;
}

/** core.source.snapshot@1 */
function snapshot(case_: VectorCase): void {
  const raw = hexToBytes(caseField(case_, 'raw_hex') as string);
  const snapshot = SourceSnapshot.fromRaw(raw, EncodingRequest.create(utf8Encoding()), UNBOUNDED_SOURCE_LIMITS);
  const digest = expectedFieldOptional(case_, 'digest') as string | undefined;
  if (digest !== undefined && snapshot.digest().toHex() !== digest) {
    fail(`digest: expected ${digest}, observed ${snapshot.digest().toHex()}`);
  }
  const equalDigest = expectedFieldOptional(case_, 'equal_digest');
  const distinctSnapshot = expectedFieldOptional(case_, 'distinct_snapshot');
  if (equalDigest === true) {
    const other = SourceSnapshot.fromRaw(raw, EncodingRequest.create(utf8Encoding()), UNBOUNDED_SOURCE_LIMITS);
    if (other.digest().toHex() !== snapshot.digest().toHex()) {
      fail('equal bytes must produce equal digests');
    }
    if (distinctSnapshot === true && other === snapshot) {
      fail('distinct snapshots must be distinct objects');
    }
  }
}

/** core.source.encoding@1 */
function sourceEncoding(case_: VectorCase): void {
  const code = expectedFieldOptional(case_, 'code') as string | undefined;
  if (code !== undefined) {
    try {
      fromRawCase(case_);
    } catch (error) {
      if (error instanceof SourceError && sourceErrorCode(error) === code) {
        return;
      }
      fail(`expected code ${code}, observed ${String(error)}`);
    }
    fail(`expected a source failure with code ${code}`);
  }
  const snapshot = fromRawCase(case_);
  const selected = expectedField(case_, 'selected') as string;
  if (encodingAsStr(snapshot.encodingFacts().selected()) !== selected) {
    fail(`selected: expected ${selected}, observed ${encodingAsStr(snapshot.encodingFacts().selected())}`);
  }
  const rawHex = expectedFieldOptional(case_, 'raw_hex');
  if (rawHex !== undefined && toHex(snapshot.bytes()) !== rawHex) {
    fail('raw bytes must be retained exactly');
  }
  const decodedUtf8Hex = expectedFieldOptional(case_, 'decoded_utf8_hex') as string | null | undefined;
  if (decodedUtf8Hex !== undefined) {
    const decoded = snapshot.decodedText();
    if (decodedUtf8Hex === null) {
      if (decoded !== null) {
        fail('binary sources must not decode');
      }
    } else if (toHex(new TextEncoder().encode(decoded ?? '')) !== decodedUtf8Hex) {
      fail(
        `decoded_utf8_hex: expected ${decodedUtf8Hex}, observed ${toHex(new TextEncoder().encode(decoded ?? ''))}`,
      );
    }
  }
}

/** core.source.decoded-location@1 */
function decodedLocation(case_: VectorCase): void {
  const code = expectedFieldOptional(case_, 'code') as string | undefined;
  if (code !== undefined) {
    if (code === 'NoDecodedText') {
      const snapshot = fromRawCase(case_);
      let failed = false;
      try {
        snapshot.decodedPosition(0);
      } catch {
        failed = true;
      }
      if (!failed) {
        fail('binary sources must not expose decoded positions');
      }
      return;
    }
    try {
      fromRawCase(case_);
    } catch (error) {
      if (error instanceof SourceError && sourceErrorCode(error) === code) {
        return;
      }
      fail(`expected code ${code}, observed ${String(error)}`);
    }
    fail(`expected a source failure with code ${code}`);
  }
  const snapshot = fromRawCase(case_);
  const rawByte = caseField(case_, 'raw_byte') as number;
  const decodedUtf8Byte = expectedField(case_, 'decoded_utf8_byte') as number;
  const unicodeScalarOffset = expectedField(case_, 'unicode_scalar_offset') as number;
  const utf16CodeUnitOffset = expectedField(case_, 'utf16_code_unit_offset') as number;
  const position = snapshot.decodedPosition(rawByte);
  if (position.decodedUtf8Byte !== decodedUtf8Byte) {
    fail(`decoded_utf8_byte: expected ${decodedUtf8Byte}, observed ${position.decodedUtf8Byte}`);
  }
  if (position.unicodeScalarOffset !== unicodeScalarOffset) {
    fail(`unicode_scalar_offset: expected ${unicodeScalarOffset}, observed ${position.unicodeScalarOffset}`);
  }
  if (position.utf16CodeUnitOffset !== utf16CodeUnitOffset) {
    fail(`utf16_code_unit_offset: expected ${utf16CodeUnitOffset}, observed ${position.utf16CodeUnitOffset}`);
  }
  const invalidRawByte = caseFieldOptional(case_, 'invalid_raw_byte') as number | undefined;
  if (invalidRawByte !== undefined) {
    let failed = false;
    try {
      snapshot.decodedPosition(invalidRawByte);
    } catch (error) {
      failed = error instanceof Error;
    }
    if (!failed) {
      fail('invalid raw byte must fail');
    }
  }
}

/** core.source.binary-coverage@1 */
function binaryCoverage(case_: VectorCase): void {
  const sourceLen = caseField(case_, 'source_len') as number;
  const regions = caseField(case_, 'regions') as { start: number; end: number; kind: string }[];
  const authority = DocumentAuthority.fresh();
  const identity = authority.identity();
  const binaryRegions: BinaryRegion[] = regions.map((region) => {
    return new BinaryRegionClass(
      authority.nodeRef(BigInt(binaryRegionsCount++), 'BinaryRegion'),
      authority.span(region.start, region.end),
      region.kind,
    );
  });
  const code = expectedFieldOptional(case_, 'code') as string | undefined;
  if (code !== undefined) {
    try {
      BinaryStructuralIndex.create(identity, sourceLen, binaryRegions);
    } catch (error) {
      if (error instanceof Error && error.message.toLowerCase().includes('coverage')) {
        return;
      }
      fail(`expected incomplete coverage, observed ${String(error)}`);
    }
    fail('expected an incomplete-coverage failure');
  }
  const index = BinaryStructuralIndex.create(identity, sourceLen, binaryRegions);
  const regionCount = expectedField(case_, 'region_count') as number;
  if (index.regions().length !== regionCount) {
    fail(`region_count: expected ${regionCount}, observed ${index.regions().length}`);
  }
}

let binaryRegionsCount = 0;

/** core.source.patch@1 */
function sourcePatch(case_: VectorCase): void {
  const mode = caseField(case_, 'mode') as string;
  const base = hexToBytes(caseField(case_, 'base_hex') as string);
  const baseSnapshot = SourceSnapshot.fromRaw(base, EncodingRequest.create(utf8Encoding()), UNBOUNDED_SOURCE_LIMITS);
  const replacements = (
    caseField(case_, 'replacements') as {
      old_start: number;
      old_end: number;
      original_hex: string;
      replacement_hex: string;
    }[]
  ).map(
    (replacement) =>
      new SourceReplacement(
        replacement.old_start,
        replacement.old_end,
        hexToBytes(replacement.original_hex),
        hexToBytes(replacement.replacement_hex),
      ),
  );
  const limits: SourcePatchLimits = {
    ...DEFAULT_SOURCE_PATCH_LIMITS,
    ...(caseFieldOptional(case_, 'max_replacements') !== undefined
      ? { maxReplacements: caseFieldOptional(case_, 'max_replacements') as number }
      : {}),
  };
  const code = expectedFieldOptional(case_, 'code') as string | undefined;
  if (code !== undefined) {
    try {
      if (mode === 'stale-base') {
        const staleBytes = hexToBytes(caseField(case_, 'stale_hex') as string);
        const stale = SourceSnapshot.fromRaw(staleBytes, EncodingRequest.create(utf8Encoding()), UNBOUNDED_SOURCE_LIMITS);
        const patch = SourcePatch.create(baseSnapshot, replacements, new Map(), limits);
        patch.apply(stale, limits);
      } else if (mode === 'count-limit' || mode === 'wrong-original') {
        SourcePatch.create(baseSnapshot, replacements, new Map(), limits);
      } else if (mode === 'overlap') {
        // Document-level canonical-order rejection (source_v1.rs:286-289):
        // SourcePatch.create validates the ordered non-overlapping ranges and
        // the ReplacementOrder kind carries core.protocol.invalid-value@1.
        SourcePatch.create(baseSnapshot, replacements, new Map(), limits);
      } else {
        // wrong-target / encoding-change (source_v1.rs:290-314): the patch is
        // built from externally supplied digest facts (a deliberately wrong
        // target digest for wrong-target; the true target digest for
        // encoding-change), then applied to the base.
        const targetBytes =
          mode === 'wrong-target'
            ? utf8('deliberately-wrong-target')
            : hexToBytes(caseField(case_, 'target_hex') as string);
        const patch = SourcePatch.create(
          baseSnapshot.digest(),
          ContentDigest.of(targetBytes),
          baseSnapshot.encodingFacts(),
          replacements,
          new Map(),
          limits,
        );
        patch.apply(baseSnapshot, limits);
      }
    } catch (error) {
      if (error instanceof SkippedCase) {
        throw error;
      }
      if (error instanceof SourcePatchError && error.code === code) {
        return;
      }
      if (error instanceof SourceError && sourceErrorCode(error) === code) {
        return;
      }
      fail(`expected code ${code}, observed ${String(error)}`);
    }
    fail(`expected a patch failure with code ${code}`);
  }
  const patch = SourcePatch.create(baseSnapshot, replacements, new Map(), limits);
  const target = patch.apply(baseSnapshot, limits);
  const targetHex = expectedField(case_, 'target_hex') as string;
  if (toHex(target.bytes()) !== targetHex) {
    fail(`target_hex: expected ${targetHex}, observed ${toHex(target.bytes())}`);
  }
}

/** core.source.limits@1 */
function sourceLimits(case_: VectorCase): void {
  const mode = caseFieldOptional(case_, 'mode') as string | undefined;
  if (mode === 'count-limit') {
    // The patch count limit is a patch-construction limit.
    const base = hexToBytes(caseField(case_, 'base_hex') as string);
    const baseSnapshot = SourceSnapshot.fromRaw(base, EncodingRequest.create(utf8Encoding()), UNBOUNDED_SOURCE_LIMITS);
    const replacements = (caseField(case_, 'replacements') as { old_start: number; old_end: number; original_hex: string; replacement_hex: string }[]).map(
      (replacement) =>
        new SourceReplacement(
          replacement.old_start,
          replacement.old_end,
          hexToBytes(replacement.original_hex),
          hexToBytes(replacement.replacement_hex),
        ),
    );
    const limits: SourcePatchLimits = { ...DEFAULT_SOURCE_PATCH_LIMITS, maxReplacements: 0 };
    try {
      SourcePatch.create(baseSnapshot, replacements, new Map(), limits);
    } catch (error) {
      if (error instanceof SourcePatchError && error.code === 'core.source.resource-limit@1') {
        return;
      }
      fail(`expected core.source.resource-limit@1, observed ${String(error)}`);
    }
    fail('expected a patch count-limit failure');
  }
  const maxRawBytes = caseFieldOptional(case_, 'max_raw_bytes') as number | undefined;
  const maxDecodedUtf8Bytes = caseFieldOptional(case_, 'max_decoded_utf8_bytes') as number | undefined;
  const limits: SourceLimits = {
    ...UNBOUNDED_SOURCE_LIMITS,
    ...(maxRawBytes !== undefined ? { maxRawBytes } : {}),
    ...(maxDecodedUtf8Bytes !== undefined ? { maxDecodedUtf8Bytes } : {}),
  };
  const code = expectedField(case_, 'code') as string;
  try {
    fromRawCase(case_, limits);
  } catch (error) {
    if (error instanceof SourceError && sourceErrorCode(error) === code) {
      return;
    }
    fail(`expected code ${code}, observed ${String(error)}`);
  }
  fail(`expected a source limit failure with code ${code}`);
}

export const runSourceV1: SuiteExecutor = {
  runCase(case_: VectorCase): void {
    switch (case_.capability) {
      case 'core.source.snapshot@1':
        snapshot(case_);
        return;
      case 'core.source.encoding@1':
        sourceEncoding(case_);
        return;
      case 'core.source.decoded-location@1':
        decodedLocation(case_);
        return;
      case 'core.source.binary-coverage@1':
        binaryCoverage(case_);
        return;
      case 'core.source.patch@1':
        sourcePatch(case_);
        return;
      case 'core.source.limits@1':
        sourceLimits(case_);
        return;
      default:
        return skip(
          case_.capability ?? 'unknown',
          `runner does not recognize published case ${case_.id}`,
        );
    }
  },
};

