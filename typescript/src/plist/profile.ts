/**
 * Frozen plist language profiles and formation limits.
 *
 * authority (frozen data — do not guess):
 *  - PlistProfile and profile ids: crates/consema-plist/src/lib.rs:76-92
 *    (XmlV1 -> "plist.xml@1", BinaryV1 -> "plist.binary@1");
 *    RFC 0013 §1 (docs/rfcs/0013-plist-family-profiles-v1.md:27-32)
 *  - PlistEncodingSelection: lib.rs:103-110 (ProfileDefault |
 *    Explicit(SourceEncoding); the binary profile has no text encoding
 *    and no BOM, RFC 0013 §2.2)
 *  - PlistParseLimits fields and defaults: lib.rs:119-194 (common limits
 *    from consema-document ParseLimits, max_decoded_utf8_bytes 128 MiB,
 *    max_decoded_scalars 64 MiB, max_object_count 1_000_000,
 *    max_container_depth 256, max_dict_entries 1_000_000,
 *    max_array_elements 1_000_000, max_duplicate_key_group_members
 *    1_000_000, max_string_code_units 16 MiB, max_data_bytes 16 MiB,
 *    max_uid_count 100_000, max_extended_size_integers 10_000,
 *    max_extended_size_value 1_000_000, max_offset_int_size 8,
 *    max_object_ref_size 8, max_offset_table_bytes 8 MiB,
 *    max_syntax_pieces 2_000_000, max_binary_facts 2_000_000,
 *    max_conversion_nodes 1_000_000, max_report_events 100_000,
 *    max_recovery_regions 100_000)
 *  - RFC 0013 §12 (:716-732) lists the bounded resource classes
 *
 * Design (TypeScript-idiomatic): a closed string-literal union for the
 * profile; an immutable record for the limits with a frozen default
 * instance, matching the json/toml family conventions.
 */

import { ProfileId } from '../document/profile.ts';
import { DEFAULT_PARSE_LIMITS } from '../document/formation.ts';
import type { ParseLimits } from '../document/formation.ts';
import type { SourceEncoding } from '../document/source.ts';

/** Frozen plist formation profile (lib.rs:76-81). */
export type PlistProfile = 'XmlV1' | 'BinaryV1';

/** `plist.xml@1` — the plist value vocabulary as XML 1.0 (RFC 0013 §4). */
export const PROFILE_PLIST_XML: PlistProfile = 'XmlV1';
/** `plist.binary@1` — the binary object-table representation (RFC 0013 §5). */
export const PROFILE_PLIST_BINARY: PlistProfile = 'BinaryV1';

/** Stable profile identifier (lib.rs:83-92). */
export function plistProfileId(profile: PlistProfile): ProfileId {
  switch (profile) {
    case 'XmlV1':
      return new ProfileId('plist.xml', 1);
    case 'BinaryV1':
      return new ProfileId('plist.binary', 1);
  }
}

/**
 * Explicit source-encoding selection (lib.rs:94-110; RFC 0013 §2).
 *
 * For the XML profile the selection follows the RFC 0012 source contract:
 * no-BOM source defaults to UTF-8, and an explicit caller choice is
 * evidence, not permission to contradict a BOM or a declaration. The
 * binary profile has no text encoding and no BOM; only `ProfileDefault`
 * and `Explicit(Binary)` are consistent with it.
 */
export type PlistEncodingSelection =
  | { readonly kind: 'ProfileDefault' }
  | { readonly kind: 'Explicit'; readonly encoding: SourceEncoding };

/** The frozen default selection. */
export const PROFILE_DEFAULT_ENCODING: PlistEncodingSelection = { kind: 'ProfileDefault' };

/** Plist-specific formation, structure, recovery, and conversion limits (RFC 0013 §12). */
export interface PlistParseLimits {
  /** Common source, node, nesting, token, and diagnostic limits. */
  readonly common: ParseLimits;
  /** Maximum decoded UTF-8 bytes (XML profile). */
  readonly maxDecodedUtf8Bytes: number;
  /** Maximum decoded Unicode scalars and coordinate steps (XML profile). */
  readonly maxDecodedScalars: number;
  /** Maximum native objects: binary object-table entries and arena nodes. */
  readonly maxObjectCount: number;
  /** Maximum container nesting depth of the native value graph. */
  readonly maxContainerDepth: number;
  /** Maximum dictionary entries in one dictionary. */
  readonly maxDictEntries: number;
  /** Maximum array elements in one array. */
  readonly maxArrayElements: number;
  /** Maximum members in one duplicate-key group. */
  readonly maxDuplicateKeyGroupMembers: number;
  /** Maximum UTF-16 code units in one string or key. */
  readonly maxStringCodeUnits: number;
  /** Maximum bytes in one data value. */
  readonly maxDataBytes: number;
  /** Maximum UID values in one document. */
  readonly maxUidCount: number;
  /** Maximum extended-size integer objects (binary profile). */
  readonly maxExtendedSizeIntegers: number;
  /** Maximum magnitude claimed by one extended size (binary profile). */
  readonly maxExtendedSizeValue: number;
  /** Maximum `offsetIntSize` width in bytes (binary profile). */
  readonly maxOffsetIntSize: number;
  /** Maximum `objectRefSize` width in bytes (binary profile). */
  readonly maxObjectRefSize: number;
  /** Maximum offset-table bytes (binary profile). */
  readonly maxOffsetTableBytes: number;
  /** Maximum XML lossless syntax pieces. */
  readonly maxSyntaxPieces: number;
  /** Maximum binary object/offset/trailer structural facts. */
  readonly maxBinaryFacts: number;
  /** Maximum cross-representation conversion nodes. */
  readonly maxConversionNodes: number;
  /** Maximum conversion, projection, or edit report events. */
  readonly maxReportEvents: number;
  /** Maximum recovery regions. */
  readonly maxRecoveryRegions: number;
}

/** The frozen defaults (lib.rs:168-194). */
export const DEFAULT_PLIST_PARSE_LIMITS: Readonly<PlistParseLimits> = Object.freeze({
  common: DEFAULT_PARSE_LIMITS,
  maxDecodedUtf8Bytes: 128 * 1024 * 1024,
  maxDecodedScalars: 64 * 1024 * 1024,
  maxObjectCount: 1_000_000,
  maxContainerDepth: 256,
  maxDictEntries: 1_000_000,
  maxArrayElements: 1_000_000,
  maxDuplicateKeyGroupMembers: 1_000_000,
  maxStringCodeUnits: 16 * 1024 * 1024,
  maxDataBytes: 16 * 1024 * 1024,
  maxUidCount: 100_000,
  maxExtendedSizeIntegers: 10_000,
  maxExtendedSizeValue: 1_000_000,
  maxOffsetIntSize: 8,
  maxObjectRefSize: 8,
  maxOffsetTableBytes: 8 * 1024 * 1024,
  maxSyntaxPieces: 2_000_000,
  maxBinaryFacts: 2_000_000,
  maxConversionNodes: 1_000_000,
  maxReportEvents: 100_000,
  maxRecoveryRegions: 100_000,
});
