/**
 * Frozen TOML profile, capability, query-domain, and style identifiers.
 *
 * authority:
 *  - TomlProfile: crates/consema-toml/src/lib.rs:34-39 (Toml10V1) and the
 *    profile id mapping :111-119 — ProfileId("toml.1.0", 1)
 *  - profile spelling: RFC 0004 §4 (:98-127) freezes "toml.1.0@1"; the
 *    vector suite pins it (conformance/vectors/toml-v1.json:3 "profile")
 *  - capability ids: the vector suite capability field of every case
 *    (toml-v1.json) — toml.document.complete@1 (:7), toml.document.lossless-
 *    syntax@1 (:13), toml.native.items@1 (:19,24,30,36), toml.projection.
 *    best-exact-core@1 (:54,60,66), toml.edit.scalar-replace@1 (:72,78),
 *    core.query.ordered-results@1 (:43,49), core.parse.resource-limits@1
 *    (:91,97); RFC 0001 §3 (:62) freezes the formation capability
 *    toml.document.complete@1 and §5 (:80) the projection target
 *    toml.best-exact-core@1
 *  - query domains: RFC 0001 §4 (:66) — toml.native-semantic-query@1;
 *    crates/consema-toml/src/query.rs:95-96 (native) and :136-137
 *    (toml.lossless-syntax-query@1); the TS protocol agent pins the same
 *    spellings (typescript/src/protocol/query.ts:108,115,500,512)
 *  - materialization style: RFC 0004 §4 (:100-103) — toml.canonical-
 *    document@1; crates/consema-toml/src/materialization.rs:89
 *
 * Design (TypeScript-idiomatic): TomlProfile is a frozen singleton with
 * value semantics (one profile in v1); capability/style/domain ids are
 * built on the document/protocol id classes so `toString()` renders the
 * canonical "id@version" spellings used by the wire contracts.
 */

import { ProfileId } from '../document/profile.ts';
import { MaterializationStyleId } from '../document/materialization.ts';
import { newCapabilityId } from '../protocol/registry_descriptor.ts';
import type { CapabilityId } from '../protocol/registry_descriptor.ts';
import { newQueryDomain } from '../protocol/query.ts';
import type { QueryDomain } from '../protocol/query.ts';

/** The one frozen TOML language profile (lib.rs:34-39). */
export class TomlProfile {
  private constructor() {}

  /** TOML 1.0.0 without implementation extensions (lib.rs:37-38). */
  static readonly TOML_10_V1: TomlProfile = new TomlProfile();

  /** Stable profile identity for registry and wire use (lib.rs:111-119). */
  id(): ProfileId {
    return new ProfileId('toml.1.0', 1);
  }

  equals(other: TomlProfile): boolean {
    return this === other;
  }
}

// ---------------------------------------------------------------------------
// Frozen capability ids (toml-v1.json capability field)
// ---------------------------------------------------------------------------

/** `toml.document.complete@1` — complete valid documents only (RFC 0001 §3; toml-v1.json:7). */
export function capabilityTomlDocumentComplete(): CapabilityId {
  return newCapabilityId('toml.document.complete', 1);
}

/** `toml.document.lossless-syntax@1` (toml-v1.json:13). */
export function capabilityTomlDocumentLosslessSyntax(): CapabilityId {
  return newCapabilityId('toml.document.lossless-syntax', 1);
}

/** `toml.native.items@1` (toml-v1.json:19). */
export function capabilityTomlNativeItems(): CapabilityId {
  return newCapabilityId('toml.native.items', 1);
}

/** `toml.projection.best-exact-core@1` (toml-v1.json:54; RFC 0001 §5). */
export function capabilityTomlProjectionBestExactCore(): CapabilityId {
  return newCapabilityId('toml.projection.best-exact-core', 1);
}

/** `toml.edit.scalar-replace@1` (toml-v1.json:72). */
export function capabilityTomlEditScalarReplace(): CapabilityId {
  return newCapabilityId('toml.edit.scalar-replace', 1);
}

/** `core.query.ordered-results@1` (toml-v1.json:43; required by every validated query). */
export function capabilityCoreQueryOrderedResults(): CapabilityId {
  return newCapabilityId('core.query.ordered-results', 1);
}

/** `core.parse.resource-limits@1` (toml-v1.json:91). */
export function capabilityCoreParseResourceLimits(): CapabilityId {
  return newCapabilityId('core.parse.resource-limits', 1);
}

// ---------------------------------------------------------------------------
// Query domains and materialization style (frozen spellings)
// ---------------------------------------------------------------------------

/** `toml.native-semantic-query@1` (RFC 0001 §4; query.rs:95-96). */
export function tomlNativeQueryDomain(): QueryDomain {
  return newQueryDomain('toml.native-semantic-query', 1);
}

/** `toml.lossless-syntax-query@1` (query.rs:136-137). */
export function tomlLosslessSyntaxQueryDomain(): QueryDomain {
  return newQueryDomain('toml.lossless-syntax-query', 1);
}

/** `toml.canonical-document@1` — the frozen canonical materialization style (RFC 0004 §4; materialization.rs:89). */
export function tomlCanonicalDocumentStyle(): MaterializationStyleId {
  return new MaterializationStyleId('toml.canonical-document', 1);
}
