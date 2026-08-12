/**
 * Frozen HCL profiles, capabilities, query domains, and materialization
 * style identifiers.
 *
 * authority:
 *  - HclProfile: crates/consema-hcl/src/lib.rs:100-118 — NativeV1 /
 *    TfvarsV1 and the profile id mapping (:112-117): ProfileId("hcl.native",
 *    1), ProfileId("hcl.tfvars", 1); the profile spellings are frozen by
 *    RFC 0014 §1 (:27-30) and pinned by the vector suite
 *    (conformance/vectors/hcl-v1.json:4-7 "profiles")
 *  - capability ids: the vector suite capability field of every case —
 *    hcl.native-formation@1 (:10), hcl.tfvars-formation@1 (:506),
 *    hcl.query@1 (:566), hcl.projection@1 (:889), hcl.materialization@1
 *    (:1153), hcl.edit@1 (:1462), hcl.limit@1 (:1781)
 *  - query domains: RFC 0014 §7 (:450-507) — hcl.native-semantic-query@1
 *    and hcl.lossless-syntax-query@1; the TS protocol agent pins the same
 *    spellings (typescript/src/protocol/query.ts:124-125)
 *  - materialization style: RFC 0014 §9 (:580-585) —
 *    hcl.canonical-document@1; crates/consema-hcl/src/materialization.rs:185
 *
 * Design (TypeScript-idiomatic): HclProfile is a closed two-instance class
 * with value semantics; capability/style/domain ids are built on the
 * document/protocol id classes so `toString()` renders the canonical
 * "id@version" spellings used by the wire contracts.
 */

import { ProfileId } from '../document/profile.ts';
import { MaterializationStyleId } from '../document/materialization.ts';
import { newCapabilityId } from '../protocol/registry_descriptor.ts';
import type { CapabilityId } from '../protocol/registry_descriptor.ts';
import { newQueryDomain } from '../protocol/query.ts';
import type { QueryDomain } from '../protocol/query.ts';

/** The two frozen HCL language profiles (lib.rs:100-107; RFC 0014 §1). */
export class HclProfile {
  #id: string;

  private constructor(id: string) {
    this.#id = id;
  }

  /** The full HCL Native Syntax (RFC 0014 §4). */
  static readonly NATIVE_V1: HclProfile = new HclProfile('hcl.native');
  /** `hcl.native@1` under the tfvars structural restriction (RFC 0014 §5). */
  static readonly TFVARS_V1: HclProfile = new HclProfile('hcl.tfvars');

  /** Stable profile identity for registry and wire use (lib.rs:112-117). */
  id(): ProfileId {
    return new ProfileId(this.#id, 1);
  }

  /** Whether this is the tfvars profile (RFC 0014 §5). */
  isTfvars(): boolean {
    return this.#id === 'hcl.tfvars';
  }

  equals(other: HclProfile): boolean {
    return this === other;
  }
}

// ---------------------------------------------------------------------------
// Frozen capability ids (hcl-v1.json capability field)
// ---------------------------------------------------------------------------

/** `hcl.native-formation@1` (hcl-v1.json:10). */
export function capabilityHclNativeFormation(): CapabilityId {
  return newCapabilityId('hcl.native-formation', 1);
}

/** `hcl.tfvars-formation@1` (hcl-v1.json:506). */
export function capabilityHclTfvarsFormation(): CapabilityId {
  return newCapabilityId('hcl.tfvars-formation', 1);
}

/** `hcl.query@1` (hcl-v1.json:566). */
export function capabilityHclQuery(): CapabilityId {
  return newCapabilityId('hcl.query', 1);
}

/** `hcl.projection@1` (hcl-v1.json:889). */
export function capabilityHclProjection(): CapabilityId {
  return newCapabilityId('hcl.projection', 1);
}

/** `hcl.materialization@1` (hcl-v1.json:1153). */
export function capabilityHclMaterialization(): CapabilityId {
  return newCapabilityId('hcl.materialization', 1);
}

/** `hcl.edit@1` (hcl-v1.json:1462). */
export function capabilityHclEdit(): CapabilityId {
  return newCapabilityId('hcl.edit', 1);
}

/** `hcl.limit@1` (hcl-v1.json:1781). */
export function capabilityHclLimit(): CapabilityId {
  return newCapabilityId('hcl.limit', 1);
}

/** `core.query.ordered-results@1` (required by every validated query). */
export function capabilityCoreQueryOrderedResults(): CapabilityId {
  return newCapabilityId('core.query.ordered-results', 1);
}

// ---------------------------------------------------------------------------
// Query domains and materialization style (frozen spellings)
// ---------------------------------------------------------------------------

/** `hcl.native-semantic-query@1` (RFC 0014 §7.1). */
export function hclNativeQueryDomain(): QueryDomain {
  return newQueryDomain('hcl.native-semantic-query', 1);
}

/** `hcl.lossless-syntax-query@1` (RFC 0014 §7.2). */
export function hclLosslessSyntaxQueryDomain(): QueryDomain {
  return newQueryDomain('hcl.lossless-syntax-query', 1);
}

/** `hcl.canonical-document@1` — the frozen canonical materialization style (RFC 0014 §9; materialization.rs:185). */
export function hclCanonicalDocumentStyle(): MaterializationStyleId {
  return new MaterializationStyleId('hcl.canonical-document', 1);
}
