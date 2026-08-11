/**
 * Java Properties parse and recovery resource limits.
 *
 * authority: crates/consema-properties/src/lib.rs
 *  - PropertiesParseLimits :61-98 (the twenty properties-owned bounds plus
 *    the common ParseLimits)
 *  - defaults :100-122 (2M natural/logical lines, 4 MiB natural-line bytes,
 *    2M scalars per natural line, 100k logical-line constituents,
 *    16 MiB logical-line scalars, 2M properties/comments, 8M escapes,
 *    16 MiB Java code units per string, 64 MiB total, 1M duplicate-group
 *    members, 100k recovery regions)
 *  - RFC 0010 §14 (:415-425) mandates the bounded surfaces: raw/decoded
 *    bytes and scalars, natural/logical line counts and sizes, property,
 *    comment, escape, and Unicode-escape counts, Java code units per
 *    key/value and in total, duplicate-group members, syntax pieces,
 *    diagnostics, and recovery regions
 *  - the vector limit-name vocabulary is pinned by the conformance runner:
 *    crates/consema-conformance/src/properties_v1.rs:1150-1180
 *
 * Design (TypeScript-idiomatic): a plain record plus a frozen default
 * instance; limits are plain numbers because they are host-size usizes in
 * the Rust authority. The common `ParseLimits` record comes from the
 * document domain (document/formation.ts).
 */

import { DEFAULT_PARSE_LIMITS } from '../document/formation.ts';
import type { ParseLimits } from '../document/formation.ts';

/** Java Properties parse and recovery limits (lib.rs:61-98). */
export interface PropertiesParseLimits {
  /** Common source, node, piece, and diagnostic limits. */
  readonly common: ParseLimits;
  /** Maximum decoded UTF-8 bytes in the source snapshot. */
  readonly maxDecodedUtf8Bytes: number;
  /** Maximum decoded Unicode scalars and coordinate steps. */
  readonly maxDecodedScalars: number;
  /** Maximum natural source lines. */
  readonly maxNaturalLines: number;
  /** Maximum raw bytes in one natural line. */
  readonly maxNaturalLineBytes: number;
  /** Maximum decoded scalars in one natural line. */
  readonly maxNaturalLineScalars: number;
  /** Maximum logical property or error lines. */
  readonly maxLogicalLines: number;
  /** Maximum natural-line constituents in one logical line. */
  readonly maxLogicalLineNaturalLines: number;
  /** Maximum decoded source scalars assembled into one logical line. */
  readonly maxLogicalLineScalars: number;
  /** Maximum property occurrences. */
  readonly maxProperties: number;
  /** Maximum comment occurrences. */
  readonly maxComments: number;
  /** Maximum escape occurrences. */
  readonly maxEscapes: number;
  /** Maximum Unicode escape occurrences. */
  readonly maxUnicodeEscapes: number;
  /** Maximum Java UTF-16 code units in one key or value. */
  readonly maxJavaCodeUnitsPerString: number;
  /** Maximum Java UTF-16 code units across the document. */
  readonly maxTotalJavaCodeUnits: number;
  /** Maximum members in one duplicate-key group. */
  readonly maxDuplicateGroupMembers: number;
  /** Maximum recovered error lines. */
  readonly maxRecoveryRegions: number;
}

/** The frozen defaults (lib.rs:100-122). */
export const DEFAULT_PROPERTIES_PARSE_LIMITS: Readonly<PropertiesParseLimits> = Object.freeze({
  common: DEFAULT_PARSE_LIMITS,
  maxDecodedUtf8Bytes: 128 * 1024 * 1024,
  maxDecodedScalars: 64 * 1024 * 1024,
  maxNaturalLines: 2_000_000,
  maxNaturalLineBytes: 4 * 1024 * 1024,
  maxNaturalLineScalars: 2 * 1024 * 1024,
  maxLogicalLines: 2_000_000,
  maxLogicalLineNaturalLines: 100_000,
  maxLogicalLineScalars: 16 * 1024 * 1024,
  maxProperties: 2_000_000,
  maxComments: 2_000_000,
  maxEscapes: 8_000_000,
  maxUnicodeEscapes: 8_000_000,
  maxJavaCodeUnitsPerString: 16 * 1024 * 1024,
  maxTotalJavaCodeUnits: 64 * 1024 * 1024,
  maxDuplicateGroupMembers: 1_000_000,
  maxRecoveryRegions: 100_000,
});
