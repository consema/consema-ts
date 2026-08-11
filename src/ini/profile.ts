/**
 * Frozen INI profile, encoding-selection, parse-limit, syntax-kind, and
 * identity contracts.
 *
 * authority:
 *  - IniProfile: crates/consema-ini/src/lib.rs:35-56 — the three frozen
 *    profiles and their ProfileId mappings (:49-55): "ini.portable"@1,
 *    "ini.windows"@1, "ini.python-configparser"@1; RFC 0009 §1
 *    (docs/rfcs/0009-ini-family-profiles-v1.md:20-26) freezes the spellings
 *    ini.portable@1 / ini.windows@1 / ini.python-configparser@1
 *  - IniEncodingSelection: lib.rs:58-65 (ProfileDefault | Explicit)
 *  - IniParseLimits: lib.rs:67-119 — the field set and the frozen defaults
 *    (:100-118): common ParseLimits defaults, max_decoded_utf8_bytes
 *    128 MiB, max_decoded_scalars 64 MiB, max_physical_lines 2M,
 *    max_physical_line_bytes 4 MiB, max_physical_line_scalars 2 MiB,
 *    max_logical_lines 2M, max_logical_line_bytes 16 MiB,
 *    max_logical_line_scalars 8 MiB, max_continuation_lines 100k,
 *    max_sections 1M, max_entries 1M, max_duplicate_group_members 100k,
 *    max_recovery_regions 100k
 *  - IniSyntaxKind: lib.rs:121-195 — the closed kind set and the stable
 *    query names ("Bom" ... "ErrorRegion", :154-195)
 *  - IniValueState: lib.rs:197-206 (Missing | Empty | Present)
 *  - IniQuoteStyle: lib.rs:208-217 (None | Single | Double)
 *  - IniLogicalLineKind: lib.rs:219-228 (Section | Entry | Error)
 *  - capability ids: the vector suite capability field
 *    (conformance/vectors/ini-v1.json:6,40,44,59,74,88,102,130,136) —
 *    ini.document@1, ini.formation@1, ini.query@1, ini.projection@1,
 *    ini.materialization@1, ini.edit@1
 *  - query domains: RFC 0009 §9 (:287-345) — ini.native-semantic-query@1
 *    and ini.lossless-syntax-query@1; the protocol domain constants pin
 *    the same spellings (typescript/src/protocol/query.ts:111,118)
 *  - materialization styles: RFC 0009 §11 (:393-399) —
 *    ini.portable-canonical@1, ini.windows-canonical@1,
 *    ini.python-configparser-canonical@1
 *
 * Design (TypeScript-idiomatic): IniProfile is a frozen singleton per
 * profile with value identity; IniSyntaxKind is a closed string-literal
 * union so exhaustive switches are compiler-checked; parse limits are a
 * plain record plus a frozen default instance.
 */

import { DEFAULT_PARSE_LIMITS, type ParseLimits } from '../document/formation.ts';
import { ProfileId } from '../document/profile.ts';
import { MaterializationStyleId } from '../document/materialization.ts';
import { newCapabilityId, type CapabilityId } from '../protocol/registry_descriptor.ts';
import { newQueryDomain, type QueryDomain } from '../protocol/query.ts';
import type { SourceEncoding } from '../document/source.ts';

/** The three frozen INI formation profiles (lib.rs:35-44; RFC 0009 §1). */
export type IniProfileId = 'PortableV1' | 'WindowsV1' | 'PythonConfigParserV1';

/** One frozen INI formation profile (lib.rs:35-44). */
export class IniProfile {
  readonly #id: IniProfileId;

  private constructor(id: IniProfileId) {
    this.#id = id;
  }

  /** Conservative ASCII exchange subset (RFC 0009 §5). */
  static readonly PORTABLE_V1: IniProfile = new IniProfile('PortableV1');
  /** Deterministic Windows profile-string file surface (RFC 0009 §6). */
  static readonly WINDOWS_V1: IniProfile = new IniProfile('WindowsV1');
  /** Python 3.14 ConfigParser default formation surface without evaluation (RFC 0009 §7). */
  static readonly PYTHON_CONFIGPARSER_V1: IniProfile = new IniProfile('PythonConfigParserV1');

  /** Stable profile identifier (lib.rs:46-56). */
  id(): ProfileId {
    switch (this.#id) {
      case 'PortableV1':
        return new ProfileId('ini.portable', 1);
      case 'WindowsV1':
        return new ProfileId('ini.windows', 1);
      case 'PythonConfigParserV1':
        return new ProfileId('ini.python-configparser', 1);
    }
  }

  /** Profile singleton identity (one profile object per frozen contract). */
  equals(other: IniProfile): boolean {
    return this === other;
  }

  /** @internal — closed profile tag used by the family modules. */
  tag(): IniProfileId {
    return this.#id;
  }
}

/** Explicit source-encoding selection; no host locale is consulted (lib.rs:58-65). */
export type IniEncodingSelection =
  | { readonly kind: 'ProfileDefault' }
  | { readonly kind: 'Explicit'; readonly encoding: SourceEncoding };

export function profileDefaultSelection(): IniEncodingSelection {
  return { kind: 'ProfileDefault' };
}
export function explicitSelection(encoding: SourceEncoding): IniEncodingSelection {
  return { kind: 'Explicit', encoding };
}

/** INI-specific parse and recovery limits (lib.rs:67-98). */
export interface IniParseLimits {
  /** Common source, node, piece, nesting, and diagnostic limits. */
  readonly common: ParseLimits;
  /** Maximum decoded UTF-8 bytes. */
  readonly maxDecodedUtf8Bytes: number;
  /** Maximum decoded Unicode scalars and coordinate steps. */
  readonly maxDecodedScalars: number;
  /** Maximum physical source lines. */
  readonly maxPhysicalLines: number;
  /** Maximum raw bytes in one physical line. */
  readonly maxPhysicalLineBytes: number;
  /** Maximum decoded scalars in one physical line. */
  readonly maxPhysicalLineScalars: number;
  /** Maximum logical records. */
  readonly maxLogicalLines: number;
  /** Maximum raw bytes owned by one logical record. */
  readonly maxLogicalLineBytes: number;
  /** Maximum decoded scalars in one logical record. */
  readonly maxLogicalLineScalars: number;
  /** Maximum continuation physical lines per Python entry. */
  readonly maxContinuationLines: number;
  /** Maximum section occurrences. */
  readonly maxSections: number;
  /** Maximum entry occurrences. */
  readonly maxEntries: number;
  /** Maximum members in one duplicate or case-equivalence group. */
  readonly maxDuplicateGroupMembers: number;
  /** Maximum recovered error lines. */
  readonly maxRecoveryRegions: number;
}

/** The frozen defaults (lib.rs:100-118). */
export const DEFAULT_INI_PARSE_LIMITS: Readonly<IniParseLimits> = Object.freeze({
  common: DEFAULT_PARSE_LIMITS,
  maxDecodedUtf8Bytes: 128 * 1024 * 1024,
  maxDecodedScalars: 64 * 1024 * 1024,
  maxPhysicalLines: 2_000_000,
  maxPhysicalLineBytes: 4 * 1024 * 1024,
  maxPhysicalLineScalars: 2 * 1024 * 1024,
  maxLogicalLines: 2_000_000,
  maxLogicalLineBytes: 16 * 1024 * 1024,
  maxLogicalLineScalars: 8 * 1024 * 1024,
  maxContinuationLines: 100_000,
  maxSections: 1_000_000,
  maxEntries: 1_000_000,
  maxDuplicateGroupMembers: 100_000,
  maxRecoveryRegions: 100_000,
});

/** One lossless INI syntax category (lib.rs:121-152). */
export type IniSyntaxKind =
  | 'Bom'
  | 'Whitespace'
  | 'LineBreak'
  | 'CommentMarker'
  | 'CommentText'
  | 'SectionOpen'
  | 'SectionName'
  | 'SectionClose'
  | 'EntryKey'
  | 'Delimiter'
  | 'Quote'
  | 'EntryValue'
  | 'ContinuationMarker'
  | 'ErrorRegion';

/** Stable query/protocol name of one kind (lib.rs:154-174). */
export function iniSyntaxKindAsStr(kind: IniSyntaxKind): string {
  return kind;
}

/** Resolves one frozen kind name, or null for an unknown name (lib.rs:176-194). */
export function iniSyntaxKindFromName(name: string): IniSyntaxKind | null {
  switch (name) {
    case 'Bom':
    case 'Whitespace':
    case 'LineBreak':
    case 'CommentMarker':
    case 'CommentText':
    case 'SectionOpen':
    case 'SectionName':
    case 'SectionClose':
    case 'EntryKey':
    case 'Delimiter':
    case 'Quote':
    case 'EntryValue':
    case 'ContinuationMarker':
    case 'ErrorRegion':
      return name;
    default:
      return null;
  }
}

/** Native value-presence fact (lib.rs:197-206). */
export type IniValueState = 'Missing' | 'Empty' | 'Present';

/** Profile-recognized outer quote style (lib.rs:208-217). */
export type IniQuoteStyle = 'None' | 'Single' | 'Double';

/** Kind of one logical INI record (lib.rs:219-228). */
export type IniLogicalLineKind = 'Section' | 'Entry' | 'Error';

// ---------------------------------------------------------------------------
// Frozen capability ids (ini-v1.json capability field)
// ---------------------------------------------------------------------------

/** `ini.document@1` — lossless formation facts (ini-v1.json:6). */
export function capabilityIniDocument(): CapabilityId {
  return newCapabilityId('ini.document', 1);
}

/** `ini.formation@1` (ini-v1.json:40). */
export function capabilityIniFormation(): CapabilityId {
  return newCapabilityId('ini.formation', 1);
}

/** `ini.query@1` (ini-v1.json:44). */
export function capabilityIniQuery(): CapabilityId {
  return newCapabilityId('ini.query', 1);
}

/** `ini.projection@1` (ini-v1.json:59). */
export function capabilityIniProjection(): CapabilityId {
  return newCapabilityId('ini.projection', 1);
}

/** `ini.materialization@1` (ini-v1.json:74). */
export function capabilityIniMaterialization(): CapabilityId {
  return newCapabilityId('ini.materialization', 1);
}

/** `ini.edit@1` (ini-v1.json:88). */
export function capabilityIniEdit(): CapabilityId {
  return newCapabilityId('ini.edit', 1);
}

// ---------------------------------------------------------------------------
// Query domains and materialization styles (frozen spellings)
// ---------------------------------------------------------------------------

/** `ini.native-semantic-query@1` (RFC 0009 §9; protocol/query.ts:111). */
export function iniNativeQueryDomain(): QueryDomain {
  return newQueryDomain('ini.native-semantic-query', 1);
}

/** `ini.lossless-syntax-query@1` (RFC 0009 §9; protocol/query.ts:118). */
export function iniLosslessSyntaxQueryDomain(): QueryDomain {
  return newQueryDomain('ini.lossless-syntax-query', 1);
}

/** `ini.portable-canonical@1` (RFC 0009 §11:395). */
export function iniPortableCanonicalStyle(): MaterializationStyleId {
  return new MaterializationStyleId('ini.portable-canonical', 1);
}

/** `ini.windows-canonical@1` (RFC 0009 §11:396). */
export function iniWindowsCanonicalStyle(): MaterializationStyleId {
  return new MaterializationStyleId('ini.windows-canonical', 1);
}

/** `ini.python-configparser-canonical@1` (RFC 0009 §11:397). */
export function iniPythonConfigParserCanonicalStyle(): MaterializationStyleId {
  return new MaterializationStyleId('ini.python-configparser-canonical', 1);
}
