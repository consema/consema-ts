/**
 * Common immutable contracts for creating a new format document.
 *
 * authority:
 *  - RFC 0004 (https://github.com/consema/consema/blob/main/docs/rfcs/0004-materialization-conversion-and-structural-
 *    edit-v1.md): §3 common MaterializationRequest v1 (:57-94) — the exact
 *    request fields and the closed v1 MaterializationLimits; §7 completion
 *    algebra (:170-192); §8 provenance (:193-218); §17 registry codes
 *    (:386-423)
 *  - Rust: consema-rs/consema-document/src/materialization.rs —
 *    MaterializationStyleId :11-39, NewlinePolicy :41-62, MappingPolicy
 *    :64-71, RepresentabilityPolicy :73-78, MaterializationLimits :80-105
 *    (defaults: 1M input nodes, 64 MiB output, depth 256, 100k report
 *    entries, 2M provenance entries), MaterializationRequest :107-203,
 *    MaterializationFidelity :205-212, MaterializationReport :214-237,
 *    input locations :239-247, relations :249-257, origins :259-270,
 *    provenance entries :272-279, provenance map :281-325,
 *    MaterializationFailure :327-351 (codes :379-391), failed attempt
 *    :393-402, completion :404-424
 *  - style/profile spellings frozen by RFC 0004 §4 (:98-127):
 *    json.canonical-compact@1, json.canonical-pretty@1,
 *    toml.canonical-document@1; json.strict@1, jsonc.bounded@1,
 *    toml.1.0@1
 *
 * Design (TypeScript-idiomatic): the request is an immutable builder
 * class with defaults from `new(targetProfile, style)`; policies are
 * closed string-literal unions; the completion algebra is a sealed
 * union of Complete | Failed (RFC 0004 §7).
 */

import { MaterializationFailure } from './errors.ts';
import { NodeRef, SnapshotIdentity, Span } from './identity.ts';
import { ProfileId } from './profile.ts';
import { AssociationLocation, ValuePath } from './portable_locations.ts';
import type { SourceEncoding } from './source.ts';
import type { Diagnostic } from './diagnostic.ts';

/** Versioned format-owned materialization style identifier (materialization.rs). */
export class MaterializationStyleId {
  readonly #id: string;
  readonly #version: number;

  constructor(id: string, version: number) {
    if (version <= 0 || !Number.isInteger(version)) {
      throw new RangeError(`style version must be a positive integer, got ${version}`);
    }
    this.#id = id;
    this.#version = version;
  }

  /** Namespaced style ID without version suffix (materialization.rs). */
  id(): string {
    return this.#id;
  }

  /** Immutable style version (materialization.rs). */
  version(): number {
    return this.#version;
  }

  /** Canonical "id@version" spelling. */
  toString(): string {
    return `${this.#id}@${this.#version}`;
  }

  equals(other: MaterializationStyleId): boolean {
    return this.#id === other.#id && this.#version === other.#version;
  }
}

/** Explicit output newline policy (materialization.rs). */
export type NewlinePolicy = 'None' | 'Lf' | 'CrLf';

/** Exact selected newline bytes (materialization.rs). */
export function newlineBytes(policy: NewlinePolicy): Uint8Array {
  switch (policy) {
    case 'None':
      return new Uint8Array(0);
    case 'Lf':
      return new Uint8Array([0x0a]);
    case 'CrLf':
      return new Uint8Array([0x0d, 0x0a]);
  }
}

/** Explicit treatment of ordered mappings at object-only targets (materialization.rs). */
export type MappingPolicy = 'RequireObject' | 'UniqueStringEntriesToObject';

/** Closed v1 representability policy (materialization.rs; RFC 0004 §3). */
export type RepresentabilityPolicy = 'ExactOnly';

/** Resource limits for one complete materialization (materialization.rs). */
export interface MaterializationLimits {
  /** Maximum input PortableValue nodes visited. */
  readonly maxInputNodes: number;
  /** Maximum raw output bytes. */
  readonly maxOutputBytes: number;
  /** Maximum recursive container depth. */
  readonly maxDepth: number;
  /** Maximum structured report events. */
  readonly maxReportEntries: number;
  /** Maximum provenance entries and origins combined. */
  readonly maxProvenanceEntries: number;
}

/** The frozen defaults (materialization.rs): 1M nodes, 64 MiB, depth 256, 100k report, 2M provenance. */
export const DEFAULT_MATERIALIZATION_LIMITS: Readonly<MaterializationLimits> = Object.freeze({
  maxInputNodes: 1_000_000,
  maxOutputBytes: 64 * 1024 * 1024,
  maxDepth: 256,
  maxReportEntries: 100_000,
  maxProvenanceEntries: 2_000_000,
});

/** Complete immutable request for creating one new target document (materialization.rs). */
export class MaterializationRequest {
  readonly #targetProfile: ProfileId;
  readonly #style: MaterializationStyleId;
  // Not `readonly`: the immutable-builder pattern reassigns these on the
  // private copy in the with*/#copy methods; the copy is never published,
  // so logical immutability of completed requests is preserved.
  #encoding: SourceEncoding;
  #newline: NewlinePolicy;
  #mappingPolicy: MappingPolicy;
  #representability: RepresentabilityPolicy;
  #limits: MaterializationLimits;

  /** Creates a strict request with UTF-8, LF, Object-only, and ExactOnly defaults (materialization.rs). */
  constructor(targetProfile: ProfileId, style: MaterializationStyleId) {
    this.#targetProfile = targetProfile;
    this.#style = style;
    this.#encoding = { kind: 'Utf8' };
    this.#newline = 'Lf';
    this.#mappingPolicy = 'RequireObject';
    this.#representability = 'ExactOnly';
    this.#limits = DEFAULT_MATERIALIZATION_LIMITS;
  }

  /** Selects an explicit output encoding (materialization.rs). */
  withEncoding(encoding: SourceEncoding): MaterializationRequest {
    const copy = this.#copy();
    copy.#encoding = encoding;
    return copy;
  }

  /** Selects an explicit newline policy (materialization.rs). */
  withNewline(newline: NewlinePolicy): MaterializationRequest {
    const copy = this.#copy();
    copy.#newline = newline;
    return copy;
  }

  /** Selects explicit ordered-mapping behavior (materialization.rs). */
  withMappingPolicy(policy: MappingPolicy): MaterializationRequest {
    const copy = this.#copy();
    copy.#mappingPolicy = policy;
    return copy;
  }

  /** Replaces immutable materialization limits (materialization.rs). */
  withLimits(limits: MaterializationLimits): MaterializationRequest {
    const copy = this.#copy();
    copy.#limits = limits;
    return copy;
  }

  #copy(): MaterializationRequest {
    const copy = new MaterializationRequest(this.#targetProfile, this.#style);
    copy.#encoding = this.#encoding;
    copy.#newline = this.#newline;
    copy.#mappingPolicy = this.#mappingPolicy;
    copy.#representability = this.#representability;
    copy.#limits = this.#limits;
    return copy;
  }

  /** Exact target Profile (materialization.rs). */
  targetProfile(): ProfileId {
    return this.#targetProfile;
  }

  /** Exact versioned target style (materialization.rs). */
  style(): MaterializationStyleId {
    return this.#style;
  }

  /** Selected output encoding (materialization.rs). */
  encoding(): SourceEncoding {
    return this.#encoding;
  }

  /** Selected newline behavior (materialization.rs). */
  newline(): NewlinePolicy {
    return this.#newline;
  }

  /** Ordered-mapping behavior (materialization.rs). */
  mappingPolicy(): MappingPolicy {
    return this.#mappingPolicy;
  }

  /** Representability behavior (materialization.rs). */
  representability(): RepresentabilityPolicy {
    return this.#representability;
  }

  /** Resource limits (materialization.rs). */
  limits(): MaterializationLimits {
    return this.#limits;
  }
}

/** Whole-operation semantic fidelity (materialization.rs). */
export type MaterializationFidelity = 'Exact' | 'Transformed';

/** Complete ordered materialization report (materialization.rs). */
export class MaterializationReport {
  readonly #events: readonly Diagnostic[];

  /** Creates a report after enforcing its configured event limit (materialization.rs). */
  constructor(events: readonly Diagnostic[], limits: MaterializationLimits) {
    if (events.length > limits.maxReportEntries) {
      throw new MaterializationFailure('ResourceLimit', { reason: 'report-entries' });
    }
    this.#events = Object.freeze([...events]);
  }

  /** Ordered structured events (materialization.rs). */
  events(): readonly Diagnostic[] {
    return this.#events;
  }
}

/** Portable input value or association location (materialization.rs; RFC 0004 §8). */
export type MaterializationInputLocation =
  | { readonly kind: 'Value'; readonly path: ValuePath }
  | { readonly kind: 'Association'; readonly location: AssociationLocation };

/** Relationship from portable input fact to generated target syntax (materialization.rs). */
export type MaterializationRelation = 'Direct' | 'Reencoded' | 'Generated';

/** One exact output origin in the newly materialized snapshot (materialization.rs). */
export class MaterializedOrigin {
  readonly #snapshot: SnapshotIdentity;
  readonly #node: NodeRef;
  readonly #span: Span;
  readonly #relation: MaterializationRelation;

  constructor(snapshot: SnapshotIdentity, node: NodeRef, span: Span, relation: MaterializationRelation) {
    this.#snapshot = snapshot;
    this.#node = node;
    this.#span = span;
    this.#relation = relation;
  }

  /** Target snapshot identity (materialization.rs). */
  snapshot(): SnapshotIdentity {
    return this.#snapshot;
  }

  /** Target structural identity (materialization.rs). */
  node(): NodeRef {
    return this.#node;
  }

  /** Exact target raw span (materialization.rs). */
  span(): Span {
    return this.#span;
  }

  /** Input-to-output relationship (materialization.rs). */
  relation(): MaterializationRelation {
    return this.#relation;
  }
}

/** One input location mapped to one or more target origins (materialization.rs). */
export class MaterializationProvenanceEntry {
  readonly #input: MaterializationInputLocation;
  readonly #outputs: readonly MaterializedOrigin[];

  constructor(input: MaterializationInputLocation, outputs: readonly MaterializedOrigin[]) {
    this.#input = input;
    this.#outputs = Object.freeze([...outputs]);
  }

  /** Portable input location (materialization.rs). */
  input(): MaterializationInputLocation {
    return this.#input;
  }

  /** One or more target origins (materialization.rs). */
  outputs(): readonly MaterializedOrigin[] {
    return this.#outputs;
  }
}

/** Complete input-to-output provenance map (materialization.rs). */
export class MaterializationProvenanceMap {
  readonly #entries: readonly MaterializationProvenanceEntry[];

  private constructor(entries: readonly MaterializationProvenanceEntry[]) {
    this.#entries = Object.freeze([...entries]);
  }

  /** Validates snapshot binding, non-empty outputs, and configured size (materialization.rs). */
  static create(
    entries: readonly MaterializationProvenanceEntry[],
    target: SnapshotIdentity,
    limits: MaterializationLimits,
  ): MaterializationProvenanceMap {
    let units = entries.length;
    for (const entry of entries) {
      if (entry.outputs().length === 0) {
        throw new MaterializationFailure('InvalidRequest', {
          reason: 'provenance entry has no output',
        });
      }
      units += entry.outputs().length;
      if (units > limits.maxProvenanceEntries) {
        throw new MaterializationFailure('ResourceLimit', { reason: 'provenance-entries' });
      }
      for (const origin of entry.outputs()) {
        if (
          !origin.snapshot().equals(target) ||
          !origin.node().snapshot().equals(target) ||
          !origin.span().snapshot().equals(target)
        ) {
          throw new MaterializationFailure('InvalidRequest', {
            reason: 'provenance origin uses another snapshot',
          });
        }
      }
    }
    return new MaterializationProvenanceMap(entries);
  }

  /** Deterministically ordered provenance entries (materialization.rs). */
  entries(): readonly MaterializationProvenanceEntry[] {
    return this.#entries;
  }
}

/** Failed attempt without a Document or partial output bytes (materialization.rs; RFC 0004 §7). */
export class FailedMaterializationAttempt {
  readonly #failure: MaterializationFailure;
  readonly #report: MaterializationReport;
  readonly #analyzedInputPaths: readonly ValuePath[];

  constructor(
    failure: MaterializationFailure,
    report: MaterializationReport,
    analyzedInputPaths: readonly ValuePath[],
  ) {
    this.#failure = failure;
    this.#report = report;
    this.#analyzedInputPaths = Object.freeze([...analyzedInputPaths]);
  }

  /** Stable failure (materialization.rs). */
  failure(): MaterializationFailure {
    return this.#failure;
  }

  /** Events discovered before failure (materialization.rs). */
  report(): MaterializationReport {
    return this.#report;
  }

  /** Stable input paths analyzed before failure (materialization.rs). */
  analyzedInputPaths(): readonly ValuePath[] {
    return this.#analyzedInputPaths;
  }
}

/** Complete successful materialization; its document and audit facts are never partial (materialization.rs). */
export class CompleteMaterialization<D> {
  readonly #document: D;
  readonly #fidelity: MaterializationFidelity;
  readonly #report: MaterializationReport;
  readonly #provenance: MaterializationProvenanceMap;

  constructor(
    document: D,
    fidelity: MaterializationFidelity,
    report: MaterializationReport,
    provenance: MaterializationProvenanceMap,
  ) {
    this.#document = document;
    this.#fidelity = fidelity;
    this.#report = report;
    this.#provenance = provenance;
  }

  /** Newly formed immutable target document (materialization.rs). */
  document(): D {
    return this.#document;
  }

  /** Worst fidelity of the whole operation (materialization.rs). */
  fidelity(): MaterializationFidelity {
    return this.#fidelity;
  }

  /** Complete ordered transformation report (materialization.rs). */
  report(): MaterializationReport {
    return this.#report;
  }

  /** Complete portable-input-to-target provenance (materialization.rs). */
  provenance(): MaterializationProvenanceMap {
    return this.#provenance;
  }
}

/** Closed materialization completion algebra (materialization.rs; RFC 0004 §7). */
export type MaterializationResult<D> =
  | { readonly kind: 'Complete'; readonly value: CompleteMaterialization<D> }
  | { readonly kind: 'Failed'; readonly value: FailedMaterializationAttempt };
