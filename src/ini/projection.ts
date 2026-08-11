/**
 * Explicit INI projection to PortableValue with fidelity, report, and
 * provenance.
 *
 * authority:
 *  - target contract: RFC 0009 §10 (:347-385) —
 *    ini.projection.best-exact-entry-mapping@1 produces an outer
 *    EntryMapping in source section order; RequireObjectV1 requires a
 *    NameComparison of exactly OriginalExact | ProfileEquivalent and a
 *    CollisionPolicy of exactly Reject | First | Last; any authorized
 *    collapse is Transformed with one report event per discarded
 *    association; Recovered documents never project
 *  - structure: crates/consema-ini/src/projection.rs — ProjectionTarget
 *    (:9-16), NameComparison (:18-25), CollisionPolicy (:27-36),
 *    ProjectionRequest (:38-100), ProjectionLimits (:102-124, defaults
 *    2M source associations / 2M value nodes / 100k report / 4M
 *    provenance), Fidelity (:126-135), ProjectedLocation (:137-143),
 *    ProvenanceRelation (:145-158), SourceOrigin/ProvenanceEntry/
 *    ProvenanceMap (:160-195), event kinds (:197-204), ProjectionEvent
 *    (:206-223), ProjectionReport (:225-237), completion records
 *    (:239-268), ProjectionFailure (:270-286), project (:288-314),
 *    exact projection (:428-537), object projection (:539-785),
 *    selection (:787-821), comparison names (:831-846), failure
 *    diagnostics (:852-893)
 *  - the vector suite pins the results end-to-end
 *    (conformance/vectors/ini-v1.json:60-73: fidelity "Exact", section/
 *    entry key order, events, "Transformed", "Main"/"Name"/"one",
 *    "main"/"Other"/"three", ContinuationFragment/QuoteDerived relations)
 *
 * Design (TypeScript-idiomatic): the request is an immutable class with
 * defaults; the completion algebra is a sealed union Complete | Failed
 * (RFC 0004 §7 shape); provenance locations reuse the document-domain
 * ValuePath/AssociationLocation records.
 */

import type { Diagnostic } from '../document/diagnostic.ts';
import { diagnostic as makeDiagnostic } from '../document/diagnostic.ts';
import type { NodeRef, SnapshotIdentity } from '../document/identity.ts';
import { Span } from '../document/identity.ts';
import { AssociationLocation, ValuePath } from '../document/portable_locations.ts';
import { entryMappingValue, objectValue, stringValue, type PortableValue } from '../core/value.ts';
import type { IniDocument, IniEntry } from './document.ts';
import { IniProjectionFailure } from './errors.ts';
import { optionxform } from './python_case.ts';

/** Versioned INI projection target contract (projection.rs:9-16). */
export type IniProjectionTarget = 'BestExactEntryMappingV1' | 'RequireObjectV1';

/** Name comparison used only by `RequireObjectV1` (projection.rs:18-25). */
export type IniNameComparison = 'OriginalExact' | 'ProfileEquivalent';

/** Explicit collision behavior for Object projection (projection.rs:27-36). */
export type IniCollisionPolicy = 'Reject' | 'First' | 'Last';

/** Projection resource limits (projection.rs:102-113). */
export interface IniProjectionLimits {
  /** Maximum source section and entry associations inspected. */
  readonly maxSourceAssociations: number;
  /** Maximum produced PortableValue nodes. */
  readonly maxValueNodes: number;
  /** Maximum report events. */
  readonly maxReportEntries: number;
  /** Maximum projected locations plus source origins. */
  readonly maxProvenanceUnits: number;
}

/** The frozen defaults (projection.rs:115-124). */
export const DEFAULT_INI_PROJECTION_LIMITS: Readonly<IniProjectionLimits> = Object.freeze({
  maxSourceAssociations: 2_000_000,
  maxValueNodes: 2_000_000,
  maxReportEntries: 100_000,
  maxProvenanceUnits: 4_000_000,
});

/** Immutable explicit projection request (projection.rs:38-100). */
export class IniProjectionRequest {
  readonly #target: IniProjectionTarget;
  readonly #comparison: IniNameComparison;
  readonly #collisionPolicy: IniCollisionPolicy;
  readonly #limits: IniProjectionLimits;

  private constructor(
    target: IniProjectionTarget,
    comparison: IniNameComparison,
    collisionPolicy: IniCollisionPolicy,
    limits: IniProjectionLimits,
  ) {
    this.#target = target;
    this.#comparison = comparison;
    this.#collisionPolicy = collisionPolicy;
    this.#limits = limits;
  }

  /** Exact default that preserves duplicate associations (projection.rs:48-57). */
  static bestExactEntryMapping(): IniProjectionRequest {
    return new IniProjectionRequest('BestExactEntryMappingV1', 'OriginalExact', 'Reject', DEFAULT_INI_PROJECTION_LIMITS);
  }

  /** Explicit unique Object request (projection.rs:59-68). */
  static requireObject(
    comparison: IniNameComparison,
    collisionPolicy: IniCollisionPolicy,
  ): IniProjectionRequest {
    return new IniProjectionRequest('RequireObjectV1', comparison, collisionPolicy, DEFAULT_INI_PROJECTION_LIMITS);
  }

  /** Replaces immutable resource limits (projection.rs:70-75). */
  withLimits(limits: IniProjectionLimits): IniProjectionRequest {
    return new IniProjectionRequest(this.#target, this.#comparison, this.#collisionPolicy, limits);
  }

  /** Frozen target contract (projection.rs:77-81). */
  target(): IniProjectionTarget {
    return this.#target;
  }

  /** Explicit Object-name comparison (projection.rs:83-87). */
  comparison(): IniNameComparison {
    return this.#comparison;
  }

  /** Explicit Object collision policy (projection.rs:89-93). */
  collisionPolicy(): IniCollisionPolicy {
    return this.#collisionPolicy;
  }

  /** Projection resource limits (projection.rs:95-99). */
  limits(): IniProjectionLimits {
    return this.#limits;
  }
}

/** Projection fidelity classification (projection.rs:126-135). */
export type IniProjectionFidelity = 'Exact' | 'Transformed' | 'Lossy';

/** Projected value or association location (projection.rs:137-143). */
export type IniProjectedLocation =
  | { readonly kind: 'Value'; readonly path: ValuePath }
  | { readonly kind: 'Association'; readonly location: AssociationLocation };

/** Source-to-projection relation (projection.rs:145-158). */
export type IniProvenanceRelation =
  | 'Direct'
  | 'Derived'
  | 'ContinuationFragment'
  | 'QuoteDerived'
  | 'Collapsed';

/** One exact source origin (projection.rs:160-172). */
export class IniSourceOrigin {
  readonly #snapshot: SnapshotIdentity;
  readonly #node: NodeRef;
  readonly #span: Span;
  readonly #relation: IniProvenanceRelation;

  constructor(snapshot: SnapshotIdentity, node: NodeRef, span: Span, relation: IniProvenanceRelation) {
    this.#snapshot = snapshot;
    this.#node = node;
    this.#span = span;
    this.#relation = relation;
  }

  /** Source document snapshot (projection.rs:165-168). */
  snapshot(): SnapshotIdentity {
    return this.#snapshot;
  }

  /** Exact structural identity (projection.rs:169-172). */
  node(): NodeRef {
    return this.#node;
  }

  /** Exact source range (projection.rs:173-176). */
  span(): Span {
    return this.#span;
  }

  /** Source relation (projection.rs:177-180). */
  relation(): IniProvenanceRelation {
    return this.#relation;
  }
}

/** One many-valued provenance mapping entry (projection.rs:174-182). */
export class IniProvenanceEntry {
  readonly #projected: IniProjectedLocation;
  readonly #origins: readonly IniSourceOrigin[];

  constructor(projected: IniProjectedLocation, origins: readonly IniSourceOrigin[]) {
    this.#projected = projected;
    this.#origins = Object.freeze([...origins]);
  }

  /** Projected value or association (projection.rs:176-178). */
  projected(): IniProjectedLocation {
    return this.#projected;
  }

  /** One or more exact source origins (projection.rs:179-181). */
  origins(): readonly IniSourceOrigin[] {
    return this.#origins;
  }
}

/** Immutable many-valued provenance mapping (projection.rs:184-195). */
export class IniProvenanceMap {
  readonly #entries: readonly IniProvenanceEntry[];

  private constructor(entries: readonly IniProvenanceEntry[]) {
    this.#entries = Object.freeze([...entries]);
  }

  static create(entries: readonly IniProvenanceEntry[]): IniProvenanceMap {
    return new IniProvenanceMap(entries);
  }

  /** Deterministically generated entries (projection.rs:190-194). */
  entries(): readonly IniProvenanceEntry[] {
    return this.#entries;
  }
}

/** Collision report category (projection.rs:197-204). */
export type IniProjectionEventKind = 'SectionCollisionCollapsed' | 'EntryCollisionCollapsed';

/** One explicit Object collision event (projection.rs:206-223). */
export class IniProjectionEvent {
  readonly #kind: IniProjectionEventKind;
  readonly #policy: IniCollisionPolicy;
  readonly #comparison: IniNameComparison;
  readonly #discarded: NodeRef;
  readonly #retained: NodeRef;
  readonly #projected: AssociationLocation;
  readonly #impact: IniProjectionFidelity;

  constructor(
    kind: IniProjectionEventKind,
    policy: IniCollisionPolicy,
    comparison: IniNameComparison,
    discarded: NodeRef,
    retained: NodeRef,
    projected: AssociationLocation,
    impact: IniProjectionFidelity,
  ) {
    this.#kind = kind;
    this.#policy = policy;
    this.#comparison = comparison;
    this.#discarded = discarded;
    this.#retained = retained;
    this.#projected = projected;
    this.#impact = impact;
  }

  /** Stable event kind (projection.rs:225-227). */
  kind(): IniProjectionEventKind {
    return this.#kind;
  }

  /** Policy that authorized the transformation (projection.rs:228-230). */
  policy(): IniCollisionPolicy {
    return this.#policy;
  }

  /** Comparison mode that formed the collision class (projection.rs:231-233). */
  comparison(): IniNameComparison {
    return this.#comparison;
  }

  /** Discarded source occurrence (projection.rs:234-236). */
  discarded(): NodeRef {
    return this.#discarded;
  }

  /** Retained source occurrence (projection.rs:237-239). */
  retained(): NodeRef {
    return this.#retained;
  }

  /** Association produced from the retained occurrence (projection.rs:240-242). */
  projected(): AssociationLocation {
    return this.#projected;
  }

  /** Fidelity impact (projection.rs:243-245). */
  impact(): IniProjectionFidelity {
    return this.#impact;
  }
}

/** Complete ordered projection report (projection.rs:225-237). */
export class IniProjectionReport {
  readonly #events: readonly IniProjectionEvent[];

  constructor(events: readonly IniProjectionEvent[], limits: IniProjectionLimits) {
    if (events.length > limits.maxReportEntries) {
      throw new IniProjectionFailure('ResourceLimit', { limitName: 'max_report_entries' });
    }
    this.#events = Object.freeze([...events]);
  }

  /** Ordered structured transformation/loss events (projection.rs:232-236). */
  events(): readonly IniProjectionEvent[] {
    return this.#events;
  }
}

/** Complete successful projection; its value is never partial (projection.rs:239-250). */
export class IniCompleteProjection {
  readonly #value: PortableValue;
  readonly #fidelity: IniProjectionFidelity;
  readonly #report: IniProjectionReport;
  readonly #provenance: IniProvenanceMap;

  constructor(
    value: PortableValue,
    fidelity: IniProjectionFidelity,
    report: IniProjectionReport,
    provenance: IniProvenanceMap,
  ) {
    this.#value = value;
    this.#fidelity = fidelity;
    this.#report = report;
    this.#provenance = provenance;
  }

  /** Complete immutable nested mapping (projection.rs:243-246). */
  value(): PortableValue {
    return this.#value;
  }

  /** Worst fidelity of the whole operation (projection.rs:247-249). */
  fidelity(): IniProjectionFidelity {
    return this.#fidelity;
  }

  /** Machine-readable collision report (projection.rs:250-252). */
  report(): IniProjectionReport {
    return this.#report;
  }

  /** Value and association provenance (projection.rs:253-255). */
  provenance(): IniProvenanceMap {
    return this.#provenance;
  }
}

/** Failed attempt without a partial PortableValue (projection.rs:252-259). */
export class IniFailedProjectionAttempt {
  readonly #diagnostics: readonly Diagnostic[];
  readonly #report: IniProjectionReport;

  constructor(diagnostics: readonly Diagnostic[], report: IniProjectionReport) {
    this.#diagnostics = Object.freeze([...diagnostics]);
    this.#report = report;
  }

  /** Ordered diagnostics explaining the failure (projection.rs:262-265). */
  diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics;
  }

  /** Empty report: failed projections publish no partial transformation result (projection.rs:266-268). */
  report(): IniProjectionReport {
    return this.#report;
  }
}

/** Projection completion algebra (projection.rs:261-268; RFC 0004 §7 shape). */
export type IniProjectionResult =
  | { readonly kind: 'Complete'; readonly value: IniCompleteProjection }
  | { readonly kind: 'Failed'; readonly value: IniFailedProjectionAttempt };

interface MutableProvenanceEntry {
  readonly projected: IniProjectedLocation;
  readonly origins: IniSourceOrigin[];
}

class ProjectionContext {
  readonly #document: IniDocument;
  readonly #request: IniProjectionRequest;
  readonly #provenance: MutableProvenanceEntry[] = [];
  readonly #events: IniProjectionEvent[] = [];
  #provenanceUnits = 0;

  constructor(document: IniDocument, request: IniProjectionRequest) {
    this.#document = document;
    this.#request = request;
  }

  document(): IniDocument {
    return this.#document;
  }

  /** Mirrors projection.rs:326-370 provenance-unit accounting and origin insertion. */
  addOrigin(
    projected: IniProjectedLocation,
    node: NodeRef,
    span: Span,
    relation: IniProvenanceRelation,
  ): void {
    const existing = this.#provenance.find((entry) =>
      projectedLocationEquals(entry.projected, projected),
    );
    const increment = existing === undefined ? 2 : 1;
    this.#provenanceUnits += increment;
    if (this.#provenanceUnits > this.#request.limits().maxProvenanceUnits) {
      throw new IniProjectionFailure('ResourceLimit', { limitName: 'max_provenance_units' });
    }
    const origin = new IniSourceOrigin(this.#document.snapshotIdentity(), node, span, relation);
    if (existing !== undefined) {
      if (relation === 'Direct') {
        existing.origins.unshift(origin);
      } else {
        existing.origins.push(origin);
      }
    } else {
      this.#provenance.push({ projected, origins: [origin] });
    }
  }

  /** Mirrors projection.rs:372-379 event accounting and fidelity elevation. */
  pushEvent(event: IniProjectionEvent): void {
    if (this.#events.length >= this.#request.limits().maxReportEntries) {
      throw new IniProjectionFailure('ResourceLimit', { limitName: 'max_report_entries' });
    }
    this.#events.push(event);
  }

  /** Adds every value origin of one entry, including continuation fragments (projection.rs:381-425). */
  addEntryValueOrigins(projected: IniProjectedLocation, entry: IniEntry): void {
    const document = this.#document;
    this.addOrigin(
      projected,
      entry.nodeRef(),
      entry.valueSpan(),
      entry.quoteStyle() === 'None' ? 'Direct' : 'QuoteDerived',
    );
    const entryEntity = document.entity(entry.index());
    if (entryEntity.kind.role !== 'Entry') {
      throw new Error('internal: ini entry entity expected');
    }
    const logical = document.entity(entryEntity.kind.logicalLine);
    if (logical.kind.role !== 'LogicalLine') {
      throw new Error('internal: ini logical-line entity expected');
    }
    const pieces = document.losslessStructuralIndex().pieces();
    const kinds = document.losslessSyntaxKinds();
    for (let physical = 1; physical < logical.kind.physicalLines.length; physical++) {
      const physicalEntity = document.entity(logical.kind.physicalLines[physical]);
      if (physicalEntity.kind.role !== 'PhysicalLine') {
        throw new Error('internal: ini physical-line entity expected');
      }
      const content = physicalEntity.kind.contentSpan;
      let start = 0;
      while (start < pieces.length && pieces[start].span().endByte() <= content.startByte()) {
        start += 1;
      }
      for (let ordinal = start; ordinal < pieces.length; ordinal++) {
        const span = pieces[ordinal].span();
        if (span.startByte() >= content.endByte()) {
          break;
        }
        if (kinds[ordinal] === 'EntryValue') {
          this.addOrigin(projected, entry.nodeRef(), span, 'ContinuationFragment');
        }
      }
    }
  }

  provenance(): IniProvenanceMap {
    return IniProvenanceMap.create(
      this.#provenance.map((entry) => new IniProvenanceEntry(entry.projected, entry.origins)),
    );
  }

  report(): IniProjectionReport {
    return new IniProjectionReport(this.#events, this.#request.limits());
  }

  fidelity(): IniProjectionFidelity {
    return this.#events.length === 0 ? 'Exact' : 'Transformed';
  }
}

function projectedLocationEquals(
  left: IniProjectedLocation,
  right: IniProjectedLocation,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'Value' && right.kind === 'Value') {
    return left.path.equals(right.path);
  }
  if (left.kind === 'Association' && right.kind === 'Association') {
    const a = left.location;
    const b = right.location;
    return a.container().equals(b.container()) && a.ordinal() === b.ordinal() && a.role() === b.role();
  }
  return false;
}

/**
 * Applies an immutable explicit projection request (projection.rs:288-314).
 * Recovered documents always fail with ini.projection.incomplete-document@1.
 */
export function projectIni(
  document: IniDocument,
  request: IniProjectionRequest,
): IniProjectionResult {
  if (document.formationStatus() !== 'Complete') {
    return failed(document, new IniProjectionFailure('RecoveredDocument'));
  }
  const sourceAssociations = document.sections().length + document.entries().length;
  if (sourceAssociations > request.limits().maxSourceAssociations) {
    return failed(document, new IniProjectionFailure('ResourceLimit', { limitName: 'max_source_associations' }));
  }
  try {
    const complete =
      request.target() === 'BestExactEntryMappingV1'
        ? projectExact(document, request)
        : projectObject(document, request);
    return { kind: 'Complete', value: complete };
  } catch (failure) {
    if (!(failure instanceof IniProjectionFailure)) {
      throw failure;
    }
    return failed(document, failure);
  }
}

// ---------------------------------------------------------------------------
// Exact EntryMapping projection (projection.rs:428-537)
// ---------------------------------------------------------------------------

function projectExact(document: IniDocument, request: IniProjectionRequest): IniCompleteProjection {
  const requiredNodes = document.sections().length * 2 + document.entries().length * 2 + 1;
  if (requiredNodes > request.limits().maxValueNodes) {
    throw new IniProjectionFailure('ResourceLimit', { limitName: 'max_value_nodes' });
  }
  const context = new ProjectionContext(document, request);
  const root = ValuePath.root();
  const sections = document.sections();
  const entriesBySection = groupEntries(document);
  const outer: { key: string; value: PortableValue }[] = [];
  for (let sectionOrdinal = 0; sectionOrdinal < sections.length; sectionOrdinal++) {
    const section = sections[sectionOrdinal];
    const sectionPath = root.child({ kind: 'EntryValue', index: BigInt(sectionOrdinal) });
    const outerOrdinal = BigInt(sectionOrdinal);
    context.addOrigin(
      { kind: 'Association', location: new AssociationLocation(root, outerOrdinal, 'EntryMappingEntry') },
      section.nodeRef(),
      section.span(),
      'Direct',
    );
    context.addOrigin(
      { kind: 'Value', path: root.child({ kind: 'EntryKey', index: outerOrdinal }) },
      section.nodeRef(),
      section.nameSpan(),
      'Direct',
    );
    context.addOrigin(
      { kind: 'Value', path: sectionPath },
      section.nodeRef(),
      section.span(),
      'Derived',
    );
    const inner: { key: string; value: PortableValue }[] = [];
    const owned = entriesBySection.get(section.index()) ?? [];
    for (let localOrdinal = 0; localOrdinal < owned.length; localOrdinal++) {
      const entry = owned[localOrdinal];
      const ordinal = BigInt(localOrdinal);
      context.addOrigin(
        { kind: 'Association', location: new AssociationLocation(sectionPath, ordinal, 'EntryMappingEntry') },
        entry.nodeRef(),
        entry.span(),
        'Direct',
      );
      context.addOrigin(
        { kind: 'Value', path: sectionPath.child({ kind: 'EntryKey', index: ordinal }) },
        entry.nodeRef(),
        entry.keySpan(),
        'Direct',
      );
      const valuePath = sectionPath.child({ kind: 'EntryValue', index: ordinal });
      context.addEntryValueOrigins({ kind: 'Value', path: valuePath }, entry);
      inner.push({ key: entry.key(), value: stringValue(entry.value()) });
    }
    outer.push({ key: section.name(), value: entryMappingValue(inner.map(entryMappingItem)) });
  }
  const rootSpan = document.authority().span(0, document.source().len());
  context.addOrigin({ kind: 'Value', path: root }, document.nodeRef(), rootSpan, 'Derived');
  return new IniCompleteProjection(
    entryMappingValue(outer.map(entryMappingItem)),
    context.fidelity(),
    context.report(),
    context.provenance(),
  );
}

function entryMappingItem(item: { key: string; value: PortableValue }) {
  return { key: stringValue(item.key), value: item.value };
}

// ---------------------------------------------------------------------------
// Explicit Object projection (projection.rs:539-785)
// ---------------------------------------------------------------------------

interface SelectedSection {
  readonly sourceIndex: number;
  readonly allEntries: IniEntry[];
  readonly entries: IniEntry[];
}

function projectObject(document: IniDocument, request: IniProjectionRequest): IniCompleteProjection {
  const sections = document.sections();
  const profileId = document.profile().id();
  const sectionNames = sections.map((section) =>
    comparisonName(profileId, section.name(), request.comparison(), false),
  );
  const retainedSections = selectIndices(sectionNames, request.collisionPolicy(), document.nodeRef());
  const entriesBySection = groupEntries(document);
  const selected: SelectedSection[] = [];
  for (const sectionIndex of retainedSections) {
    const section = sections[sectionIndex];
    const allEntries = entriesBySection.get(section.index()) ?? [];
    const entryNames = allEntries.map((entry) =>
      comparisonName(profileId, entry.key(), request.comparison(), true),
    );
    const retainedLocal = selectIndices(entryNames, request.collisionPolicy(), section.nodeRef());
    selected.push({
      sourceIndex: sectionIndex,
      allEntries,
      entries: retainedLocal.map((local) => allEntries[local]),
    });
  }
  let retainedEntries = 0;
  for (const item of selected) {
    retainedEntries += item.entries.length;
  }
  const requiredNodes = retainedEntries + selected.length + 1;
  if (requiredNodes > request.limits().maxValueNodes) {
    throw new IniProjectionFailure('ResourceLimit', { limitName: 'max_value_nodes' });
  }
  const context = new ProjectionContext(document, request);
  const root = ValuePath.root();
  const projectedSectionOrdinal = new Map<number, number>();
  selected.forEach((item, projected) => projectedSectionOrdinal.set(item.sourceIndex, projected));
  const retainedBySectionName = new Map<string, number>();
  selected.forEach((item) => retainedBySectionName.set(sectionNames[item.sourceIndex], item.sourceIndex));

  for (let sourceIndex = 0; sourceIndex < sections.length; sourceIndex++) {
    const retained = retainedBySectionName.get(sectionNames[sourceIndex])!;
    if (retained === sourceIndex) {
      continue;
    }
    const location = new AssociationLocation(root, BigInt(projectedSectionOrdinal.get(retained)!), 'ObjectEntry');
    context.pushEvent(
      new IniProjectionEvent(
        'SectionCollisionCollapsed',
        request.collisionPolicy(),
        request.comparison(),
        sections[sourceIndex].nodeRef(),
        sections[retained].nodeRef(),
        location,
        'Transformed',
      ),
    );
    context.addOrigin(
      { kind: 'Association', location },
      sections[sourceIndex].nodeRef(),
      sections[sourceIndex].span(),
      'Collapsed',
    );
  }

  const outer: { key: string; value: PortableValue }[] = [];
  for (const item of selected) {
    const section = sections[item.sourceIndex];
    const sectionPath = root.child({ kind: 'ObjectValue', name: section.name() });
    const outerOrdinal = BigInt(projectedSectionOrdinal.get(item.sourceIndex)!);
    context.addOrigin(
      { kind: 'Association', location: new AssociationLocation(root, outerOrdinal, 'ObjectEntry') },
      section.nodeRef(),
      section.span(),
      'Direct',
    );
    context.addOrigin(
      { kind: 'Association', location: new AssociationLocation(root, outerOrdinal, 'ObjectKey') },
      section.nodeRef(),
      section.nameSpan(),
      'Direct',
    );
    context.addOrigin({ kind: 'Value', path: sectionPath }, section.nodeRef(), section.span(), 'Derived');

    const retainedOrdinal = new Map<number, number>();
    const retainedByName = new Map<string, IniEntry>();
    item.entries.forEach((entry, projected) => {
      retainedOrdinal.set(entry.index(), projected);
      retainedByName.set(comparisonName(profileId, entry.key(), request.comparison(), true), entry);
    });
    for (const entry of item.allEntries) {
      if (retainedOrdinal.has(entry.index())) {
        continue;
      }
      const name = comparisonName(profileId, entry.key(), request.comparison(), true);
      const retained = retainedByName.get(name)!;
      const projectedOrdinal = retainedOrdinal.get(retained.index())!;
      const location = new AssociationLocation(sectionPath, BigInt(projectedOrdinal), 'ObjectEntry');
      context.pushEvent(
        new IniProjectionEvent(
          'EntryCollisionCollapsed',
          request.collisionPolicy(),
          request.comparison(),
          entry.nodeRef(),
          retained.nodeRef(),
          location,
          'Transformed',
        ),
      );
      context.addOrigin(
        { kind: 'Association', location },
        entry.nodeRef(),
        entry.span(),
        'Collapsed',
      );
    }

    const inner: { key: string; value: PortableValue }[] = [];
    for (let projected = 0; projected < item.entries.length; projected++) {
      const entry = item.entries[projected];
      const ordinal = BigInt(projected);
      context.addOrigin(
        { kind: 'Association', location: new AssociationLocation(sectionPath, ordinal, 'ObjectEntry') },
        entry.nodeRef(),
        entry.span(),
        'Direct',
      );
      context.addOrigin(
        { kind: 'Association', location: new AssociationLocation(sectionPath, ordinal, 'ObjectKey') },
        entry.nodeRef(),
        entry.keySpan(),
        'Direct',
      );
      context.addEntryValueOrigins(
        { kind: 'Value', path: sectionPath.child({ kind: 'ObjectValue', name: entry.key() }) },
        entry,
      );
      inner.push({ key: entry.key(), value: stringValue(entry.value()) });
    }
    outer.push({ key: section.name(), value: objectValueOf(inner) });
  }
  const rootSpan = document.authority().span(0, document.source().len());
  context.addOrigin({ kind: 'Value', path: root }, document.nodeRef(), rootSpan, 'Derived');
  return new IniCompleteProjection(
    objectValueOf(outer),
    context.fidelity(),
    context.report(),
    context.provenance(),
  );
}

/** Unique-key Object construction; a duplicate key is a core invariant failure (projection.rs:729-767). */
function objectValueOf(entries: readonly { key: string; value: PortableValue }[]): PortableValue {
  try {
    return objectValue(entries.map((entry) => ({ key: entry.key, value: entry.value })));
  } catch {
    throw new IniProjectionFailure('CoreInvariant');
  }
}

// ---------------------------------------------------------------------------
// Selection and comparison (projection.rs:787-846)
// ---------------------------------------------------------------------------

function selectIndices(
  names: readonly string[],
  policy: IniCollisionPolicy,
  container: NodeRef,
): number[] {
  const counts = new Map<string, number>();
  for (const name of names) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (policy === 'Reject') {
    for (let index = 0; index < names.length; index++) {
      if ((counts.get(names[index]) ?? 0) > 1) {
        throw new IniProjectionFailure('Collision', { container: container.role(), name: names[index] });
      }
    }
  }
  if (policy === 'Reject' || policy === 'First') {
    const seen = new Set<string>();
    const retained: number[] = [];
    for (let index = 0; index < names.length; index++) {
      if (!seen.has(names[index])) {
        seen.add(names[index]);
        retained.push(index);
      }
    }
    return retained;
  }
  const seen = new Set<string>();
  const reversed: number[] = [];
  for (let index = names.length - 1; index >= 0; index--) {
    if (!seen.has(names[index])) {
      seen.add(names[index]);
      reversed.push(index);
    }
  }
  reversed.reverse();
  return reversed;
}

function comparisonName(
  profileId: string,
  value: string,
  comparison: IniNameComparison,
  isKey: boolean,
): string {
  if (comparison === 'OriginalExact') {
    return value;
  }
  switch (profileId) {
    case 'ini.windows':
      return value.toLowerCase();
    case 'ini.python-configparser':
      return isKey ? optionxform(value) : value;
    case 'ini.portable':
      return value;
    default:
      return value;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Entries grouped by owning section entity index, in entry order (projection.rs:823-829). */
function groupEntries(document: IniDocument): Map<number, IniEntry[]> {
  const groups = new Map<number, IniEntry[]>();
  for (const entry of document.entries()) {
    const kind = document.entity(entry.index()).kind;
    if (kind.role !== 'Entry') {
      throw new Error('internal: ini entry entity expected');
    }
    const list = groups.get(kind.section);
    if (list === undefined) {
      groups.set(kind.section, [entry]);
    } else {
      list.push(entry);
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Failure records (projection.rs:852-893)
// ---------------------------------------------------------------------------

function failed(document: IniDocument, failure: IniProjectionFailure): IniProjectionResult {
  const reason =
    failure.kind === 'RecoveredDocument'
      ? 'incomplete-document'
      : failure.kind === 'Collision'
        ? 'collision'
        : failure.kind === 'ResourceLimit'
          ? 'resource-limit'
          : 'target-not-applicable';
  const category = failure.kind === 'ResourceLimit' ? 'Resource' : 'Projection';
  const arguments_: (readonly [string, string])[] = [['reason', reason]];
  if (failure.kind === 'ResourceLimit' && failure.limitName !== undefined) {
    arguments_.push(['limit', failure.limitName]);
  }
  const profile = document.profile();
  arguments_.push(['profile', `${profile.id()}@${profile.version()}`]);
  return {
    kind: 'Failed',
    value: new IniFailedProjectionAttempt(
      [makeDiagnostic(failure.code, category, 'Error', null, 0n, { arguments: arguments_ })],
      new IniProjectionReport([], DEFAULT_INI_PROJECTION_LIMITS),
    ),
  };
}
