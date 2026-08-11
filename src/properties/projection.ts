/**
 * Exact-first projection from a complete Properties document to
 * PortableValue.
 *
 * authority: crates/consema-properties/src/projection.rs
 *  - ProjectionTarget :9-16 (BestExactEntryMappingV1 | RequireObjectV1),
 *    DuplicatePolicy :18-27 (RequireUnique | FirstWins | LastWinsJdkTable)
 *  - ProjectionRequest :29-82 (best_exact_entry_mapping :38-46,
 *    require_object :48-56), ProjectionLimits :84-106 (defaults: 2M source
 *    associations, 4_000_001 value nodes, 100k report entries, 8M
 *    provenance units)
 *  - Fidelity :108-117, ProjectedLocation :119-127, ProvenanceRelation
 *    :129-143 (Direct | Derived | KeyFragment | ValueFragment |
 *    EscapeDerived | Collapsed), SourceOrigin :145-156, ProvenanceEntry
 *    :158-165, ProvenanceMap :167-179, ProjectionEvent :181-196,
 *    ProjectionReport :198-210, CompleteProjection :212-224,
 *    FailedProjectionAttempt :226-232, ProjectionResult :234-241,
 *    ProjectionFailure :249-262
 *  - Document::project :264-306 (RecoveredDocument gate :268-270,
 *    max_source_associations :271-276, unpaired-surrogate scan :277-296,
 *    target dispatch :297-300)
 *  - the projection context :308-428 (add_origin :318-362, add_string_origins
 *    :364-404, push_event :406-413, add_root_origin :415-427)
 *  - project_exact :430-497, project_object :499-611, select_indices
 *    :613-648, failure diagnostics :654-711 (reason/component/ordinals/
 *    limit/profile arguments), failure codes :741-752
 *  - frozen codes: crates/consema-protocol/src/error_registry.rs:1141-1157
 *    (java-properties.projection.duplicate-collapsed@1,
 *    java-properties.projection.incomplete-document@1,
 *    java-properties.projection.unpaired-surrogate@1),
 *    :563-567/601-605 (core.projection.target-not-applicable@1 /
 *    resource-limit@1)
 *  - RFC 0010 §11 (:310-349) freezes the projection surface: default
 *    best-exact entry mapping, atomic unpaired-surrogate failure, explicit
 *    RequireUnique/FirstWins/LastWinsJdkTable Object policies, and the
 *    authorizing rules
 *  - vector-pinned behavior: conformance/vectors/java-properties-v1.json
 *    (projection.exact-duplicates-and-fragments,
 *    projection.unpaired-and-recovered-atomic-failure,
 *    projection.explicit-jdk-table-collapse,
 *    resource.projection-limit-matrix)
 *
 * Design (TypeScript-idiomatic): an immutable request with static
 * constructors; the projection context walks the document once, collecting
 * the complete value, fidelity, report events, and provenance, or fails
 * with a typed `ProjectionFailure` — a failure never contains a partial
 * value (RFC 0010 §11 :318-322).
 */

import { NodeRef, Span } from '../document/identity.ts';
import { AssociationLocation, ValuePath } from '../document/portable_locations.ts';
import { diagnostic } from '../document/diagnostic.ts';
import type { Diagnostic } from '../document/diagnostic.ts';
import { entryMappingValue, objectValue, stringValue } from '../core/value.ts';
import type { EntryMappingEntry, ObjectEntry, PortableValue } from '../core/value.ts';
import { ProjectionFailure } from './errors.ts';
import type { ProjectionFailureKind } from './errors.ts';
import { PropertiesDocument, Property } from './document.ts';

// ---------------------------------------------------------------------------
// Targets and policies
// ---------------------------------------------------------------------------

/** Versioned projection target contract (projection.rs:9-16; RFC 0010 §11). */
export type ProjectionTarget = 'BestExactEntryMappingV1' | 'RequireObjectV1';

/** Explicit duplicate behavior for `RequireObjectV1` (projection.rs:18-27; RFC 0010 §11). */
export type DuplicatePolicy = 'RequireUnique' | 'FirstWins' | 'LastWinsJdkTable';

/** Java Properties projection limits (projection.rs:84-95). */
export interface ProjectionLimits {
  /** Maximum source property associations inspected. */
  readonly maxSourceAssociations: number;
  /** Maximum produced PortableValue nodes. */
  readonly maxValueNodes: number;
  /** Maximum report events. */
  readonly maxReportEntries: number;
  /** Maximum projected locations plus source origins. */
  readonly maxProvenanceUnits: number;
}

/** The frozen defaults (projection.rs:97-105). */
export const DEFAULT_PROJECTION_LIMITS: Readonly<ProjectionLimits> = Object.freeze({
  maxSourceAssociations: 2_000_000,
  maxValueNodes: 4_000_001,
  maxReportEntries: 100_000,
  maxProvenanceUnits: 8_000_000,
});

/** Immutable explicit Properties projection request (projection.rs:29-82). */
export class ProjectionRequest {
  readonly #target: ProjectionTarget;
  readonly #duplicatePolicy: DuplicatePolicy;
  readonly #limits: ProjectionLimits;

  private constructor(target: ProjectionTarget, duplicatePolicy: DuplicatePolicy, limits: ProjectionLimits) {
    this.#target = target;
    this.#duplicatePolicy = duplicatePolicy;
    this.#limits = limits;
  }

  /** Exact default that preserves every property occurrence (projection.rs:38-46). */
  static bestExactEntryMapping(): ProjectionRequest {
    return new ProjectionRequest('BestExactEntryMappingV1', 'RequireUnique', DEFAULT_PROJECTION_LIMITS);
  }

  /** Explicit unique Object request (projection.rs:48-56). */
  static requireObject(duplicatePolicy: DuplicatePolicy): ProjectionRequest {
    return new ProjectionRequest('RequireObjectV1', duplicatePolicy, DEFAULT_PROJECTION_LIMITS);
  }

  /** Replaces immutable resource limits (projection.rs:58-62). */
  withLimits(limits: ProjectionLimits): ProjectionRequest {
    return new ProjectionRequest(this.#target, this.#duplicatePolicy, limits);
  }

  /** Frozen target contract (projection.rs:64-67). */
  target(): ProjectionTarget {
    return this.#target;
  }

  /** Explicit Object duplicate policy (projection.rs:69-73). */
  duplicatePolicy(): DuplicatePolicy {
    return this.#duplicatePolicy;
  }

  /** Projection resource limits (projection.rs:75-80). */
  limits(): ProjectionLimits {
    return this.#limits;
  }
}

// ---------------------------------------------------------------------------
// Fidelity, provenance, and report facts
// ---------------------------------------------------------------------------

/** Projection fidelity classification (projection.rs:108-117). */
export type Fidelity = 'Exact' | 'Transformed' | 'Lossy';

/** Projected value or association location (projection.rs:119-127). */
export type ProjectedLocation =
  | { readonly kind: 'Value'; readonly path: ValuePath }
  | { readonly kind: 'Association'; readonly location: AssociationLocation };

/** Source-to-projection relation (projection.rs:129-143). */
export type ProvenanceRelation =
  | 'Direct'
  | 'Derived'
  | 'KeyFragment'
  | 'ValueFragment'
  | 'EscapeDerived'
  | 'Collapsed';

/** One exact source origin (projection.rs:145-156). */
export class SourceOrigin {
  readonly #snapshot: bigint;
  readonly #node: NodeRef;
  readonly #span: Span;
  readonly #relation: ProvenanceRelation;

  constructor(snapshot: bigint, node: NodeRef, span: Span, relation: ProvenanceRelation) {
    this.#snapshot = snapshot;
    this.#node = node;
    this.#span = span;
    this.#relation = relation;
  }

  /** Source document snapshot (projection.rs:147-149). */
  snapshot(): bigint {
    return this.#snapshot;
  }

  /** Exact structural identity (projection.rs:150-152). */
  node(): NodeRef {
    return this.#node;
  }

  /** Exact raw source range (projection.rs:153-155). */
  span(): Span {
    return this.#span;
  }

  /** Source relation (projection.rs:156-158). */
  relation(): ProvenanceRelation {
    return this.#relation;
  }
}

/** One many-valued provenance entry (projection.rs:158-165). */
export class ProvenanceEntry {
  readonly #projected: ProjectedLocation;
  readonly #origins: readonly SourceOrigin[];

  constructor(projected: ProjectedLocation, origins: readonly SourceOrigin[]) {
    this.#projected = projected;
    this.#origins = Object.freeze([...origins]);
  }

  /** Projected value or association (projection.rs:160-162). */
  projected(): ProjectedLocation {
    return this.#projected;
  }

  /** Ordered source origins (projection.rs:163-165). */
  origins(): readonly SourceOrigin[] {
    return this.#origins;
  }
}

/** Immutable many-valued provenance mapping (projection.rs:167-179). */
export class ProvenanceMap {
  readonly #entries: readonly ProvenanceEntry[];

  /**
   * @internal — construction is normally via `project`; failed attempts
   * publish the empty mapping (projection.rs:170-172).
   */
  constructor(entries: readonly ProvenanceEntry[]) {
    this.#entries = Object.freeze([...entries]);
  }

  /** Deterministically ordered projected locations and origins (projection.rs:173-178). */
  entries(): readonly ProvenanceEntry[] {
    return this.#entries;
  }
}

/** One explicit duplicate-collapse event (projection.rs:181-196). */
export class ProjectionEvent {
  readonly #code: string;
  readonly #policy: DuplicatePolicy;
  readonly #discarded: NodeRef;
  readonly #retained: NodeRef;
  readonly #projected: AssociationLocation;
  readonly #impact: Fidelity;

  constructor(
    code: string,
    policy: DuplicatePolicy,
    discarded: NodeRef,
    retained: NodeRef,
    projected: AssociationLocation,
    impact: Fidelity,
  ) {
    this.#code = code;
    this.#policy = policy;
    this.#discarded = discarded;
    this.#retained = retained;
    this.#projected = projected;
    this.#impact = impact;
  }

  /** Stable event code (projection.rs:183-185). */
  code(): string {
    return this.#code;
  }

  /** Policy that authorized the transformation (projection.rs:186-188). */
  policy(): DuplicatePolicy {
    return this.#policy;
  }

  /** Discarded source occurrence (projection.rs:189-191). */
  discarded(): NodeRef {
    return this.#discarded;
  }

  /** Retained source occurrence (projection.rs:192-194). */
  retained(): NodeRef {
    return this.#retained;
  }

  /** Association produced from the retained occurrence (projection.rs:195-197). */
  projected(): AssociationLocation {
    return this.#projected;
  }

  /** Fidelity impact (projection.rs:198-200). */
  impact(): Fidelity {
    return this.#impact;
  }
}

/** Complete ordered projection report (projection.rs:198-210). */
export class ProjectionReport {
  readonly #events: readonly ProjectionEvent[];

  /**
   * @internal — construction is normally via `project`; failed attempts
   * publish the empty report (projection.rs:200-202).
   */
  constructor(events: readonly ProjectionEvent[]) {
    this.#events = Object.freeze([...events]);
  }

  /** Events in deterministic discarded-source order (projection.rs:205-209). */
  events(): readonly ProjectionEvent[] {
    return this.#events;
  }
}

/** Complete successful projection (projection.rs:212-224). */
export class CompleteProjection {
  readonly #value: PortableValue;
  readonly #fidelity: Fidelity;
  readonly #report: ProjectionReport;
  readonly #provenance: ProvenanceMap;

  constructor(value: PortableValue, fidelity: Fidelity, report: ProjectionReport, provenance: ProvenanceMap) {
    this.#value = value;
    this.#fidelity = fidelity;
    this.#report = report;
    this.#provenance = provenance;
  }

  /** Complete immutable mapping (projection.rs:214-216). */
  value(): PortableValue {
    return this.#value;
  }

  /** Worst operation fidelity (projection.rs:217-219). */
  fidelity(): Fidelity {
    return this.#fidelity;
  }

  /** Structured duplicate-collapse report (projection.rs:220-222). */
  report(): ProjectionReport {
    return this.#report;
  }

  /** Value and association provenance (projection.rs:223-225). */
  provenance(): ProvenanceMap {
    return this.#provenance;
  }
}

/** Failed projection attempt without a partial value (projection.rs:226-232). */
export class FailedProjectionAttempt {
  readonly #diagnostics: readonly Diagnostic[];
  readonly #report: ProjectionReport;

  constructor(diagnostics: readonly Diagnostic[], report: ProjectionReport) {
    this.#diagnostics = Object.freeze([...diagnostics]);
    this.#report = report;
  }

  /** Stable ordered diagnostics (projection.rs:228-230). */
  diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics;
  }

  /** Empty report: failed projections publish no partial transformation (projection.rs:231). */
  report(): ProjectionReport {
    return this.#report;
  }
}

/** Projection completion algebra (projection.rs:234-241). */
export type ProjectionResult =
  | { readonly kind: 'Complete'; readonly value: CompleteProjection }
  | { readonly kind: 'Failed'; readonly value: FailedProjectionAttempt };

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

class Context {
  readonly #document: PropertiesDocument;
  readonly #request: ProjectionRequest;
  readonly #entries: ProvenanceEntry[] = [];
  #provenanceUnits = 0;
  readonly #events: ProjectionEvent[] = [];
  #fidelity: Fidelity = 'Exact';

  constructor(document: PropertiesDocument, request: ProjectionRequest) {
    this.#document = document;
    this.#request = request;
  }

  addOrigin(
    projected: ProjectedLocation,
    node: NodeRef,
    span: Span,
    relation: ProvenanceRelation,
  ): void {
    const existing = this.#entries.find((entry) => locationsEqual(entry.projected(), projected));
    const newLocation = existing === undefined;
    const increment = newLocation ? 2 : 1;
    this.#provenanceUnits += increment;
    if (this.#provenanceUnits > this.#request.limits().maxProvenanceUnits) {
      throw new ProjectionFailure('ResourceLimit', { limitName: 'max_provenance_units' });
    }
    const origin = new SourceOrigin(this.#document.snapshotIdentity().asBigInt(), node, span, relation);
    if (existing !== undefined) {
      const merged =
        relation === 'Direct'
          ? [origin, ...existing.origins()]
          : [...existing.origins(), origin];
      this.#entries[this.#entries.indexOf(existing)] = new ProvenanceEntry(projected, merged);
    } else {
      this.#entries.push(new ProvenanceEntry(projected, [origin]));
    }
  }

  addStringOrigins(projected: ProjectedLocation, property: Property, inKey: boolean): void {
    const fragments = inKey ? property.keyFragments() : property.valueFragments();
    const relation: ProvenanceRelation = inKey ? 'KeyFragment' : 'ValueFragment';
    if (fragments.length === 0) {
      const anchor = inKey ? property.keyAnchor() : property.valueAnchor();
      this.addOrigin(projected, property.nodeRef(), anchor, relation);
    } else {
      for (const span of fragments) {
        this.addOrigin(projected, property.nodeRef(), span, relation);
      }
    }
    for (const escape of property.escapes()) {
      if (escape.inKey() === inKey) {
        this.addOrigin(projected, escape.nodeRef(), escape.span(), 'EscapeDerived');
      }
    }
  }

  pushEvent(event: ProjectionEvent): void {
    if (this.#events.length >= this.#request.limits().maxReportEntries) {
      throw new ProjectionFailure('ResourceLimit', { limitName: 'max_report_entries' });
    }
    this.#fidelity = fidelityMax(this.#fidelity, event.impact());
    this.#events.push(event);
  }

  addRootOrigin(): void {
    const rootSpan = this.#document.authorityInternal().span(0, this.#document.source().len());
    this.addOrigin(
      { kind: 'Value', path: ValuePath.root() },
      this.#document.nodeRef(),
      rootSpan,
      'Derived',
    );
  }

  document(): PropertiesDocument {
    return this.#document;
  }

  request(): ProjectionRequest {
    return this.#request;
  }

  fidelity(): Fidelity {
    return this.#fidelity;
  }

  report(): ProjectionReport {
    return new ProjectionReport(this.#events);
  }

  provenance(): ProvenanceMap {
    return new ProvenanceMap(this.#entries);
  }
}

function locationsEqual(left: ProjectedLocation, right: ProjectedLocation): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'Value' && right.kind === 'Value') {
    return left.path.equals(right.path);
  }
  if (left.kind === 'Association' && right.kind === 'Association') {
    return (
      left.location.container().equals(right.location.container()) &&
      left.location.ordinal() === right.location.ordinal() &&
      left.location.role() === right.location.role()
    );
  }
  return false;
}

function fidelityMax(left: Fidelity, right: Fidelity): Fidelity {
  if (left === 'Lossy' || right === 'Lossy') return 'Lossy';
  if (left === 'Transformed' || right === 'Transformed') return 'Transformed';
  return 'Exact';
}

/**
 * Projects one snapshot under one explicit target and duplicate contract
 * (projection.rs:264-306). Returns the completion algebra; a failure never
 * contains a partial value.
 */
export function project(document: PropertiesDocument, request: ProjectionRequest): ProjectionResult {
  if (document.formationStatus() !== 'Complete') {
    return failed(document, new ProjectionFailure('RecoveredDocument'));
  }
  const properties = document.properties();
  if (properties.length > request.limits().maxSourceAssociations) {
    return failed(document, new ProjectionFailure('ResourceLimit', { limitName: 'max_source_associations' }));
  }
  for (const property of properties) {
    if (property.key().status() === 'UnpairedSurrogate') {
      return failed(
        document,
        new ProjectionFailure('UnpairedSurrogate', { property: property.nodeRef(), inKey: true }),
      );
    }
    if (property.value().status() === 'UnpairedSurrogate') {
      return failed(
        document,
        new ProjectionFailure('UnpairedSurrogate', { property: property.nodeRef(), inKey: false }),
      );
    }
  }
  try {
    const complete =
      request.target() === 'BestExactEntryMappingV1'
        ? projectExact(document, request)
        : projectObject(document, request);
    return { kind: 'Complete', value: complete };
  } catch (error) {
    if (!(error instanceof ProjectionFailure)) {
      throw error;
    }
    return failed(document, error);
  }
}

function projectExact(document: PropertiesDocument, request: ProjectionRequest): CompleteProjection {
  const properties = document.properties();
  const requiredNodes = properties.length * 2 + 1;
  if (requiredNodes > request.limits().maxValueNodes) {
    throw new ProjectionFailure('ResourceLimit', { limitName: 'max_value_nodes' });
  }
  const context = new Context(document, request);
  const root = ValuePath.root();
  const entries: EntryMappingEntry[] = [];
  for (let ordinal = 0; ordinal < properties.length; ordinal++) {
    const property = properties[ordinal];
    const association = new AssociationLocation(root, BigInt(ordinal), 'EntryMappingEntry');
    context.addOrigin(
      { kind: 'Association', location: association },
      property.nodeRef(),
      property.span(),
      'Direct',
    );
    context.addStringOrigins(
      { kind: 'Value', path: root.child({ kind: 'EntryKey', index: BigInt(ordinal) }) },
      property,
      true,
    );
    context.addStringOrigins(
      { kind: 'Value', path: root.child({ kind: 'EntryValue', index: BigInt(ordinal) }) },
      property,
      false,
    );
    entries.push({
      key: stringValue(property.key().toUnicode()),
      value: stringValue(property.value().toUnicode()),
    });
  }
  context.addRootOrigin();
  return new CompleteProjection(
    entryMappingValue(entries),
    context.fidelity(),
    context.report(),
    context.provenance(),
  );
}

function projectObject(document: PropertiesDocument, request: ProjectionRequest): CompleteProjection {
  const properties = document.properties();
  const keys: string[] = properties.map((property) => property.key().toUnicode());
  const retained = selectIndices(document, keys, request.duplicatePolicy());
  const requiredNodes = retained.length + 1;
  if (requiredNodes > request.limits().maxValueNodes) {
    throw new ProjectionFailure('ResourceLimit', { limitName: 'max_value_nodes' });
  }
  const context = new Context(document, request);
  const root = ValuePath.root();
  const retainedSet = new Set(retained);
  const retainedByKey = new Map<string, number>();
  for (const index of retained) {
    retainedByKey.set(keys[index], index);
  }
  const projectedOrdinal = new Map<number, number>();
  retained.forEach((source, projected) => projectedOrdinal.set(source, projected));

  for (let sourceIndex = 0; sourceIndex < properties.length; sourceIndex++) {
    if (retainedSet.has(sourceIndex)) {
      continue;
    }
    const retainedIndex = retainedByKey.get(keys[sourceIndex])!;
    const ordinal = projectedOrdinal.get(retainedIndex)!;
    const location = new AssociationLocation(root, BigInt(ordinal), 'ObjectEntry');
    context.pushEvent(
      new ProjectionEvent(
        'java-properties.projection.duplicate-collapsed@1',
        request.duplicatePolicy(),
        properties[sourceIndex].nodeRef(),
        properties[retainedIndex].nodeRef(),
        location,
        'Lossy',
      ),
    );
    context.addOrigin(
      { kind: 'Association', location },
      properties[sourceIndex].nodeRef(),
      properties[sourceIndex].span(),
      'Collapsed',
    );
  }

  const objectEntries: ObjectEntry[] = [];
  retained.forEach((propertyIndex, projected) => {
    const property = properties[propertyIndex];
    const association = new AssociationLocation(root, BigInt(projected), 'ObjectEntry');
    context.addOrigin(
      { kind: 'Association', location: association },
      property.nodeRef(),
      property.span(),
      'Direct',
    );
    context.addStringOrigins(
      { kind: 'Association', location: new AssociationLocation(root, BigInt(projected), 'ObjectKey') },
      property,
      true,
    );
    context.addStringOrigins(
      { kind: 'Value', path: root.child({ kind: 'ObjectValue', name: keys[propertyIndex] }) },
      property,
      false,
    );
    objectEntries.push({
      key: keys[propertyIndex],
      value: stringValue(property.value().toUnicode()),
    });
  });
  context.addRootOrigin();
  return new CompleteProjection(
    objectValue(objectEntries),
    context.fidelity(),
    context.report(),
    context.provenance(),
  );
}

function selectIndices(
  document: PropertiesDocument,
  keys: readonly string[],
  policy: DuplicatePolicy,
): number[] {
  const properties = document.properties();
  const firstByKey = new Map<string, number>();
  for (let index = 0; index < keys.length; index++) {
    const first = firstByKey.get(keys[index]);
    if (first !== undefined) {
      if (policy === 'RequireUnique') {
        throw new ProjectionFailure('DuplicateKey', {
          retained: properties[first].nodeRef(),
          duplicate: properties[index].nodeRef(),
        });
      }
    } else {
      firstByKey.set(keys[index], index);
    }
  }
  switch (policy) {
    case 'RequireUnique':
    case 'FirstWins': {
      const seen = new Set<string>();
      const retained: number[] = [];
      for (let index = 0; index < keys.length; index++) {
        if (!seen.has(keys[index])) {
          seen.add(keys[index]);
          retained.push(index);
        }
      }
      return retained;
    }
    case 'LastWinsJdkTable': {
      const seen = new Set<string>();
      const retained: number[] = [];
      for (let index = keys.length - 1; index >= 0; index--) {
        if (!seen.has(keys[index])) {
          seen.add(keys[index]);
          retained.push(index);
        }
      }
      retained.reverse();
      return retained;
    }
  }
}

function failed(document: PropertiesDocument, failure: ProjectionFailure): ProjectionResult {
  const reason = failureReason(failure.kind);
  const arguments_ = new Map<string, string>([['reason', reason]]);
  let primary: Diagnostic['primary'] = null;
  const properties = document.properties();
  switch (failure.kind) {
    case 'UnpairedSurrogate': {
      if (failure.property !== undefined) {
        primary = spanLocation(propertySpan(document, failure.property));
        const ordinal = properties.findIndex((property) => property.nodeRef().equals(failure.property!));
        if (ordinal >= 0) {
          arguments_.set('property_ordinal', String(ordinal));
        }
      }
      arguments_.set('component', failure.inKey === true ? 'key' : 'value');
      break;
    }
    case 'DuplicateKey': {
      if (failure.duplicate !== undefined) {
        primary = spanLocation(propertySpan(document, failure.duplicate));
      }
      insertPropertyOrdinal(arguments_, properties, 'retained_ordinal', failure.retained);
      insertPropertyOrdinal(arguments_, properties, 'duplicate_ordinal', failure.duplicate);
      break;
    }
    case 'ResourceLimit':
      if (failure.limitName !== undefined) {
        arguments_.set('limit', failure.limitName);
      }
      break;
    case 'RecoveredDocument':
    case 'CoreInvariant':
      break;
  }
  const profile = document.profile();
  arguments_.set('profile', profile.toString());
  return {
    kind: 'Failed',
    value: new FailedProjectionAttempt(
      [
        diagnostic(failure.code, 'Projection', 'Error', primary, 0n, {
          arguments: arguments_,
        }),
      ],
      new ProjectionReport([]),
    ),
  };
}

function failureReason(kind: ProjectionFailureKind): string {
  switch (kind) {
    case 'RecoveredDocument':
      return 'incomplete-document';
    case 'UnpairedSurrogate':
      return 'unpaired-surrogate';
    case 'DuplicateKey':
      return 'duplicate-key';
    case 'ResourceLimit':
      return 'resource-limit';
    case 'CoreInvariant':
      return 'target-not-applicable';
  }
}

function insertPropertyOrdinal(
  arguments_: Map<string, string>,
  properties: readonly Property[],
  name: string,
  node: NodeRef | undefined,
): void {
  if (node === undefined) {
    return;
  }
  const ordinal = properties.findIndex((property) => property.nodeRef().equals(node));
  if (ordinal >= 0) {
    arguments_.set(name, String(ordinal));
  }
}

function propertySpan(document: PropertiesDocument, node: NodeRef): Span {
  try {
    return document.property(node).span();
  } catch {
    return document.authorityInternal().span(0, document.source().len());
  }
}

function spanLocation(span: Span): Diagnostic['primary'] {
  return {
    snapshot: span.snapshot().asBigInt(),
    startByte: BigInt(span.startByte()),
    endByte: BigInt(span.endByte()),
  };
}
