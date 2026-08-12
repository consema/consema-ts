/**
 * Frozen XML language profile, encoding selection, and parse limits.
 *
 * authority: crates/consema-xml/src/lib.rs
 *  - XmlProfile :54-67 (SafeV1; the one published profile
 *    "xml.1.0-safe@1" :61-66, frozen by RFC 0012 §1 :17-20)
 *  - XmlEncodingSelection :69-79 (ProfileDefault | Explicit(SourceEncoding))
 *  - XmlParseLimits :81-128 (every field), Default :130-157 (the exact
 *    frozen default magnitudes), entity_limits :159-172
 *  - the v1 document-entity encoding table: RFC 0012 §2 :54-67 (UTF-8
 *    optional BOM; UTF-16LE/BE require a BOM; no-BOM defaults to UTF-8;
 *    UTF-16 without a BOM is rejected even with explicit endianness)
 *
 * Design (TypeScript-idiomatic): XmlProfile is a closed string-literal
 * union (the Rust variant name is the discriminant); XmlParseLimits is a
 * plain frozen record like document ParseLimits. `selected` spelling and
 * BOM agreement are re-checked after source construction by the parser.
 */

import { ProfileId } from '../document/profile.ts';
import { DEFAULT_PARSE_LIMITS } from '../document/formation.ts';
import type { ParseLimits } from '../document/formation.ts';
import type { SourceEncoding } from '../document/source.ts';
import type { EntityExpansionLimits } from './entity.ts';

/** Frozen XML formation profile (lib.rs:54-59; RFC 0012 §1). */
export type XmlProfile = 'SafeV1';

/** `xml.1.0-safe@1` — the one published XML profile (lib.rs:61-66). */
export const PROFILE_XML_SAFE: XmlProfile = 'SafeV1';

/** Immutable profile identifier (lib.rs:61-66). */
export function xmlProfileId(profile: XmlProfile): ProfileId {
  switch (profile) {
    case 'SafeV1':
      return new ProfileId('xml.1.0-safe', 1);
  }
}

/**
 * Explicit document-entity encoding selection (lib.rs:69-79).
 *
 * No-BOM source defaults to UTF-8. An explicit caller choice is evidence,
 * not permission to contradict a BOM or a declaration (RFC 0012 §2 :62-63).
 */
export type XmlEncodingSelection =
  | { readonly kind: 'ProfileDefault' }
  | { readonly kind: 'Explicit'; readonly encoding: SourceEncoding };

/** Applies only the frozen profile default and BOM rules (lib.rs:74-75). */
export function profileDefaultSelection(): XmlEncodingSelection {
  return { kind: 'ProfileDefault' };
}

/** Uses one caller-selected document-entity encoding (lib.rs:76-78). */
export function explicitSelection(encoding: SourceEncoding): XmlEncodingSelection {
  return { kind: 'Explicit', encoding };
}

/** XML-specific formation, entity, and recovery limits (lib.rs:81-128; RFC 0012 §12). */
export interface XmlParseLimits {
  /** Common source, node, piece, nesting, and diagnostic limits. */
  readonly common: ParseLimits;
  /** Maximum decoded UTF-8 bytes. */
  readonly maxDecodedUtf8Bytes: number;
  /** Maximum decoded Unicode scalars and coordinate steps. */
  readonly maxDecodedScalars: number;
  /** Maximum elements in the native tree. */
  readonly maxElementCount: number;
  /** Maximum attributes per element. */
  readonly maxAttributeCount: number;
  /** Maximum namespace declarations per element. */
  readonly maxNamespaceDeclarationCount: number;
  /** Maximum child content items per element. */
  readonly maxMixedContentItems: number;
  /** Maximum QName bytes (prefix, local, and full spelling). */
  readonly maxQNameLength: number;
  /** Maximum namespace URI bytes. */
  readonly maxNamespaceUriLength: number;
  /** Maximum attribute-value decoded bytes. */
  readonly maxAttributeValueLength: number;
  /** Maximum comment decoded bytes. */
  readonly maxCommentLength: number;
  /** Maximum processing-instruction content decoded bytes. */
  readonly maxPiLength: number;
  /** Maximum CDATA content decoded bytes. */
  readonly maxCdataLength: number;
  /** Maximum text content decoded bytes. */
  readonly maxTextLength: number;
  /** Maximum DTD subset raw bytes. */
  readonly maxDtdBytes: number;
  /** Maximum entity declarations. */
  readonly maxEntityDeclarations: number;
  /** Maximum entity references. */
  readonly maxEntityReferences: number;
  /** Maximum reference expansion depth. */
  readonly maxEntityExpansionDepth: number;
  /** Maximum expanded bytes across the whole document. */
  readonly maxExpandedEntityBytes: number;
  /** Maximum expanded scalars across the whole document. */
  readonly maxExpandedEntityScalars: number;
  /** Maximum expanded/declared byte amplification ratio. */
  readonly maxEntityAmplificationRatio: number;
  /** Maximum recovery error regions. */
  readonly maxRecoveryRegions: number;
}

/** The frozen defaults (lib.rs:130-157). */
export const DEFAULT_XML_PARSE_LIMITS: Readonly<XmlParseLimits> = Object.freeze({
  common: DEFAULT_PARSE_LIMITS,
  maxDecodedUtf8Bytes: 128 * 1024 * 1024,
  maxDecodedScalars: 64 * 1024 * 1024,
  maxElementCount: 1_000_000,
  maxAttributeCount: 100_000,
  maxNamespaceDeclarationCount: 100_000,
  maxMixedContentItems: 2_000_000,
  maxQNameLength: 4 * 1024,
  maxNamespaceUriLength: 8 * 1024,
  maxAttributeValueLength: 4 * 1024 * 1024,
  maxCommentLength: 4 * 1024 * 1024,
  maxPiLength: 4 * 1024 * 1024,
  maxCdataLength: 4 * 1024 * 1024,
  maxTextLength: 4 * 1024 * 1024,
  maxDtdBytes: 4 * 1024 * 1024,
  maxEntityDeclarations: 10_000,
  maxEntityReferences: 1_000_000,
  maxEntityExpansionDepth: 100,
  maxExpandedEntityBytes: 32 * 1024 * 1024,
  maxExpandedEntityScalars: 16 * 1024 * 1024,
  maxEntityAmplificationRatio: 1_000,
  maxRecoveryRegions: 100_000,
});

/** Entity expansion limits derived from these parse limits (lib.rs:159-172). */
export function xmlEntityLimits(limits: XmlParseLimits): EntityExpansionLimits {
  return {
    maxDeclarations: limits.maxEntityDeclarations,
    maxReferences: limits.maxEntityReferences,
    maxExpansionDepth: limits.maxEntityExpansionDepth,
    maxExpandedBytes: limits.maxExpandedEntityBytes,
    maxExpandedScalars: limits.maxExpandedEntityScalars,
    maxAmplificationRatio: limits.maxEntityAmplificationRatio,
  };
}
