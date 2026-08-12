/**
 * Plist projection targets and explicit mapping policies (RFC 0013 §9).
 *
 * authority: crates/consema-plist/src/projection.rs
 *  - ProjectionTarget :55-62 (ValueTreeV1 | RequireObjectV1),
 *    UidPolicy :65-71, CollisionPolicy :75-82, ProjectionRequest :86-157
 *    (value_tree :96-103, value_tree_with_uid :107-114, require_object
 *    :119-126, with_limits :130-132)
 *  - ProjectionLimits :164-184 (defaults 2M source nodes, 2M value nodes,
 *    100k report entries, 4M provenance units)
 *  - Fidelity :188-195 (Exact | Transformed | Lossy), ProjectedLocation
 *    :199-204, ProvenanceRelation :208-217 (Direct | Derived | Collapsed |
 *    ReferenceDerived), SourceOrigin :221-230, ProvenanceEntry :234-239,
 *    ProvenanceMap :243-270, ProjectionEventKind :274-278, ProjectionEvent
 *    :282-289, ProjectionReport :293-320, CompleteProjection :324-333,
 *    FailedProjectionAttempt :337-342, ProjectionResult :346-351,
 *    ProjectionFailure :355-403 (codes at :393-402)
 *  - project :412-444 (atomic: a recovered source, an unpaired-surrogate
 *    string, an unrepresentable leaf, or a resource limit returns no
 *    partial value)
 *  - value-tree emission :571-667 (the `plist.value-tree@1` record:
 *    Object { "record": "plist.value-tree@1", "root": <value> };
 *    dict -> EntryMapping, array -> Sequence, string -> String, integer ->
 *    Integer, real -> BinaryFloat64 exact bits, boolean -> Boolean, date ->
 *    Object { epoch: "2001-01-01T00:00:00Z", seconds: BinaryFloat64 },
 *    data -> Bytes, uid -> Object { uid: Integer } under IncludeUid and
 *    fails atomically otherwise — UIDs are never disguised as integers)
 *  - require-object :671-733 (root dict, string/integer/real/boolean
 *    scalars only; date/data/uid fail with a diagnostic; First/Last
 *    collapse emits one AssociationDiscarded event per discarded
 *    association and flips fidelity to Transformed)
 *  - RFC 0013 §9 (:598-632) and the vectors plist.projection.*
 *
 * Design (TypeScript-idiomatic): an immutable request; the projection
 * context walks the native arena once, collecting the complete value,
 * fidelity, report events, and provenance, or fails with a typed
 * `ProjectionFailure` — a failure never contains a partial value.
 */

import { NodeRef, Span } from '../document/identity.ts';
import { AssociationLocation, ValuePath } from '../document/portable_locations.ts';
import type { Diagnostic } from '../document/diagnostic.ts';
import {
  binaryFloat64Value,
  bytesValue,
  entryMappingValue,
  integerValue,
  objectValue,
  sequenceValue,
  stringValue,
} from '../core/value.ts';
import type { EntryMappingEntry, ObjectEntry, PortableValue } from '../core/value.ts';
import { ProjectionFailure } from './errors.ts';
import { PlistDocument } from './document.ts';
import { PlistValueRef } from './native.ts';

/** Fixed XML spelling of the plist epoch (RFC 0013 §5.5, §9; projection.rs:49-51). */
const PLIST_EPOCH_SPELLING = '2001-01-01T00:00:00Z';
/** Versioned value-tree record name (RFC 0013 §9). */
const VALUE_TREE_RECORD = 'plist.value-tree@1';

/** Versioned plist projection target (projection.rs:55-62). */
export type ProjectionTarget = 'ValueTreeV1' | 'RequireObjectV1';

/** UID handling for the value-tree target (projection.rs:65-71). */
export type UidPolicy = 'Exclude' | 'Include';

/** Duplicate-key handling for the require-object target (projection.rs:75-82). */
export type CollisionPolicy = 'Reject' | 'First' | 'Last';

/** Plist projection resource limits (projection.rs:164-173). */
export interface ProjectionLimits {
  /** Maximum inspected native value nodes. */
  readonly maxSourceNodes: number;
  /** Maximum produced PortableValue nodes. */
  readonly maxValueNodes: number;
  /** Maximum report events. */
  readonly maxReportEntries: number;
  /** Maximum projected locations plus source origins. */
  readonly maxProvenanceUnits: number;
}

/** The frozen defaults (projection.rs:175-184). */
export const DEFAULT_PROJECTION_LIMITS: Readonly<ProjectionLimits> = Object.freeze({
  maxSourceNodes: 2_000_000,
  maxValueNodes: 2_000_000,
  maxReportEntries: 100_000,
  maxProvenanceUnits: 4_000_000,
});

/** Explicit plist projection request; every policy is mandatory (projection.rs:86-157). */
export class ProjectionRequest {
  readonly #target: ProjectionTarget;
  readonly #uidPolicy: UidPolicy;
  readonly #collision: CollisionPolicy;
  readonly #limits: ProjectionLimits;

  private constructor(
    target: ProjectionTarget,
    uidPolicy: UidPolicy,
    collision: CollisionPolicy,
    limits: ProjectionLimits,
  ) {
    this.#target = target;
    this.#uidPolicy = uidPolicy;
    this.#collision = collision;
    this.#limits = limits;
  }

  /** Exact `plist.value-tree@1` record request for the complete document (projection.rs:96-103). */
  static valueTree(): ProjectionRequest {
    return new ProjectionRequest('ValueTreeV1', 'Exclude', 'Reject', DEFAULT_PROJECTION_LIMITS);
  }

  /** Exact `plist.value-tree@1` request with an explicit UID policy (projection.rs:107-114). */
  static valueTreeWithUid(policy: UidPolicy): ProjectionRequest {
    return new ProjectionRequest('ValueTreeV1', policy, 'Reject', DEFAULT_PROJECTION_LIMITS);
  }

  /** Explicit `plist.projection.require-object@1` request with one loss policy (projection.rs:119-126). */
  static requireObject(collision: CollisionPolicy): ProjectionRequest {
    return new ProjectionRequest('RequireObjectV1', 'Exclude', collision, DEFAULT_PROJECTION_LIMITS);
  }

  /** Applies explicit resource limits to this request (projection.rs:130-132). */
  withLimits(limits: ProjectionLimits): ProjectionRequest {
    return new ProjectionRequest(this.#target, this.#uidPolicy, this.#collision, limits);
  }

  /** Projection target. */
  target(): ProjectionTarget {
    return this.#target;
  }

  /** UID policy consumed by the value-tree target. */
  uidPolicy(): UidPolicy {
    return this.#uidPolicy;
  }

  /** Collision policy consumed by the require-object target. */
  collision(): CollisionPolicy {
    return this.#collision;
  }

  /** Resource limits. */
  limits(): ProjectionLimits {
    return this.#limits;
  }
}

/** Projection fidelity classification (projection.rs:188-195). */
export type Fidelity = 'Exact' | 'Transformed' | 'Lossy';

/** Projected value or association location (projection.rs:199-204). */
export type ProjectedLocation =
  | { readonly kind: 'Value'; readonly path: ValuePath }
  | { readonly kind: 'Association'; readonly location: AssociationLocation };

/** Source-to-projection relation (projection.rs:208-217). */
export type ProvenanceRelation = 'Direct' | 'Derived' | 'Collapsed' | 'ReferenceDerived';

/** One exact source origin (projection.rs:221-230). */
export class SourceOrigin {
  readonly #snapshot: ReturnType<PlistDocument['snapshotIdentity']>;
  readonly #node: NodeRef;
  readonly #span: Span;
  readonly #relation: ProvenanceRelation;

  constructor(snapshot: ReturnType<PlistDocument['snapshotIdentity']>, node: NodeRef, span: Span, relation: ProvenanceRelation) {
    this.#snapshot = snapshot;
    this.#node = node;
    this.#span = span;
    this.#relation = relation;
  }

  /** Source document snapshot. */
  snapshot() {
    return this.#snapshot;
  }

  /** Exact structural identity. */
  node(): NodeRef {
    return this.#node;
  }

  /** Exact raw source range. */
  span(): Span {
    return this.#span;
  }

  /** Source relation. */
  relation(): ProvenanceRelation {
    return this.#relation;
  }
}

/** One many-valued provenance entry (projection.rs:234-239). */
export class ProvenanceEntry {
  readonly #projected: ProjectedLocation;
  readonly #origins: readonly SourceOrigin[];

  constructor(projected: ProjectedLocation, origins: readonly SourceOrigin[]) {
    this.#projected = projected;
    this.#origins = Object.freeze([...origins]);
  }

  /** Projected value or association. */
  projected(): ProjectedLocation {
    return this.#projected;
  }

  /** Ordered source origins. */
  origins(): readonly SourceOrigin[] {
    return this.#origins;
  }
}

/** Immutable many-valued provenance mapping (projection.rs:243-270). */
export class ProvenanceMap {
  readonly #entries: readonly ProvenanceEntry[];
  readonly #units: number;

  private constructor(entries: readonly ProvenanceEntry[], units: number) {
    this.#entries = Object.freeze([...entries]);
    this.#units = units;
  }

  static create(entries: readonly ProvenanceEntry[], limits: ProjectionLimits): ProvenanceMap {
    let units = 0;
    for (const entry of entries) {
      units += 1 + entry.origins().length;
      if (units > limits.maxProvenanceUnits) {
        throw new ProjectionFailure('ResourceLimit', { limitName: 'max_provenance_units' });
      }
    }
    return new ProvenanceMap(entries, units);
  }

  /** Deterministically ordered projected locations and origins. */
  entries(): readonly ProvenanceEntry[] {
    return this.#entries;
  }
}

/** One explicit transformation event (projection.rs:282-289). */
export class ProjectionEvent {
  readonly #kind: 'AssociationDiscarded';
  readonly #discarded: NodeRef;
  readonly #impact: Fidelity;

  constructor(kind: 'AssociationDiscarded', discarded: NodeRef, impact: Fidelity) {
    this.#kind = kind;
    this.#discarded = discarded;
    this.#impact = impact;
  }

  /** Stable event kind. */
  kind(): 'AssociationDiscarded' {
    return this.#kind;
  }

  /** Discarded source occurrence. */
  discarded(): NodeRef {
    return this.#discarded;
  }

  /** Fidelity impact. */
  impact(): Fidelity {
    return this.#impact;
  }
}

/** Complete ordered projection report (projection.rs:293-320). */
export class ProjectionReport {
  readonly #events: readonly ProjectionEvent[];

  private constructor(events: readonly ProjectionEvent[]) {
    this.#events = Object.freeze([...events]);
  }

  static create(events: readonly ProjectionEvent[], limits: ProjectionLimits): ProjectionReport {
    if (events.length > limits.maxReportEntries) {
      throw new ProjectionFailure('ResourceLimit', { limitName: 'max_report_entries' });
    }
    return new ProjectionReport(events);
  }

  /** Events in deterministic association order. */
  events(): readonly ProjectionEvent[] {
    return this.#events;
  }
}

/** Complete successful projection (projection.rs:324-333). */
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

  /** Complete immutable projected value. */
  value(): PortableValue {
    return this.#value;
  }

  /** Worst operation fidelity. */
  fidelity(): Fidelity {
    return this.#fidelity;
  }

  /** Structured transformation report. */
  report(): ProjectionReport {
    return this.#report;
  }

  /** Value and association provenance. */
  provenance(): ProvenanceMap {
    return this.#provenance;
  }
}

/** Failed projection attempt without a partial value (projection.rs:337-342). */
export class FailedProjectionAttempt {
  readonly #diagnostics: readonly Diagnostic[];
  readonly #report: ProjectionReport;

  constructor(diagnostics: readonly Diagnostic[], report: ProjectionReport) {
    this.#diagnostics = Object.freeze([...diagnostics]);
    this.#report = report;
  }

  /** Stable ordered diagnostics. */
  diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics;
  }

  /** Empty report: failed projections publish no partial transformation result. */
  report(): ProjectionReport {
    return this.#report;
  }
}

/** Projection completion algebra (projection.rs:346-351). */
export type ProjectionResult =
  | { readonly kind: 'Complete'; readonly value: CompleteProjection }
  | { readonly kind: 'Failed'; readonly value: FailedProjectionAttempt };

/** One retained association of the require-object target. */
interface RetainedOccurrence {
  readonly key: string;
  readonly value: PortableValue;
  readonly entry: NodeRef;
}

interface DiscardedOccurrence {
  readonly key: string;
  readonly entry: NodeRef;
}

class Context {
  readonly #document: PlistDocument;
  readonly #limits: ProjectionLimits;
  readonly #report: ProjectionEvent[] = [];
  readonly #provenance: ProvenanceEntry[] = [];
  #sourceNodes = 0;
  #valueNodes = 0;
  readonly #span: Span;

  constructor(document: PlistDocument, limits: ProjectionLimits) {
    this.#document = document;
    this.#limits = limits;
    const length = document.render().length;
    this.#span = document.authorityInternal().span(0, length);
  }

  step(): void {
    this.#sourceNodes += 1;
    if (this.#sourceNodes > this.#limits.maxSourceNodes) {
      throw new ProjectionFailure('ResourceLimit', { limitName: 'max_source_nodes' });
    }
  }

  reserveValue(count: number): void {
    this.#valueNodes += count;
    if (this.#valueNodes > this.#limits.maxValueNodes) {
      throw new ProjectionFailure('ResourceLimit', { limitName: 'max_value_nodes' });
    }
  }

  event(discarded: NodeRef): void {
    this.#report.push(new ProjectionEvent('AssociationDiscarded', discarded, 'Transformed'));
    if (this.#report.length > this.#limits.maxReportEntries) {
      throw new ProjectionFailure('ResourceLimit', { limitName: 'max_report_entries' });
    }
  }

  /** Ordered transformation events accumulated so far. */
  report(): readonly ProjectionEvent[] {
    return this.#report;
  }

  /** Provenance entries accumulated so far. */
  provenance(): readonly ProvenanceEntry[] {
    return this.#provenance;
  }

  origin(projected: ProjectedLocation, node: NodeRef, relation: ProvenanceRelation): void {
    this.#provenance.push(
      new ProvenanceEntry(projected, [
        new SourceOrigin(this.#document.snapshotIdentity(), node, this.#span, relation),
      ]),
    );
    const units = this.#provenance.length + 1;
    if (units > this.#limits.maxProvenanceUnits) {
      throw new ProjectionFailure('ResourceLimit', { limitName: 'max_provenance_units' });
    }
  }

  valueNodeRef(index: number): NodeRef {
    return this.#document.nodeRefFor(index, 'PlistValue');
  }

  entryNodeRef(dictIndex: number): NodeRef {
    return this.#document.nodeRefFor(dictIndex, 'PlistDictEntry');
  }

  keyNodeRef(dictIndex: number): NodeRef {
    return this.#document.nodeRefFor(dictIndex, 'PlistKey');
  }

  elementNodeRef(arrayIndex: number): NodeRef {
    return this.#document.nodeRefFor(arrayIndex, 'PlistArrayElement');
  }

  /** Exact `plist.value-tree@1` record for the document root (projection.rs:572-586). */
  projectValueTree(uidPolicy: UidPolicy): PortableValue {
    const native = this.#document.document();
    if (native === null) {
      throw new ProjectionFailure('IncompleteDocument');
    }
    const rootPath = ValuePath.root().child({ kind: 'ObjectValue', name: 'root' });
    const rootValue = this.valueOf(native.root(), rootPath, uidPolicy);
    this.reserveValue(1);
    return objectValue([
      { key: 'record', value: stringValue(VALUE_TREE_RECORD) },
      { key: 'root', value: rootValue },
    ]);
  }

  /** One recursive value mapping (projection.rs:590-667). */
  valueOf(node: PlistValueRef, path: ValuePath, uidPolicy: UidPolicy): PortableValue {
    const native = this.#document.document();
    if (native === null) {
      throw new ProjectionFailure('IncompleteDocument');
    }
    this.step();
    this.reserveValue(1);
    const value = native.get(node);
    if (value === null) {
      throw new ProjectionFailure('CoreInvariant');
    }
    let projected: PortableValue;
    switch (value.kind) {
      case 'Dict': {
        const entries: EntryMappingEntry[] = [];
        for (let ordinal = 0; ordinal < value.entries.length; ordinal++) {
          const entry = value.entries[ordinal];
          this.origin(
            {
              kind: 'Association',
              location: new AssociationLocation(path, BigInt(ordinal), 'EntryMappingEntry'),
            },
            this.entryNodeRef(node.index()),
            'Direct',
          );
          this.origin(
            { kind: 'Value', path: path.child({ kind: 'EntryKey', index: BigInt(ordinal) }) },
            this.keyNodeRef(node.index()),
            'Direct',
          );
          const child = this.valueOf(
            PlistValueRef.fromIndex(entry.value),
            path.child({ kind: 'EntryValue', index: BigInt(ordinal) }),
            uidPolicy,
          );
          entries.push({ key: stringValue(entry.key), value: child });
        }
        projected = entryMappingValue(entries);
        break;
      }
      case 'Array': {
        const elements: PortableValue[] = [];
        for (let ordinal = 0; ordinal < value.elements.length; ordinal++) {
          this.origin(
            { kind: 'Value', path: path.child({ kind: 'SequenceElement', index: BigInt(ordinal) }) },
            this.elementNodeRef(node.index()),
            'Direct',
          );
          elements.push(
            this.valueOf(
              PlistValueRef.fromIndex(value.elements[ordinal]),
              path.child({ kind: 'SequenceElement', index: BigInt(ordinal) }),
              uidPolicy,
            ),
          );
        }
        projected = sequenceValue(elements);
        break;
      }
      case 'String': {
        // Unpaired-surrogate strings fail ordinary projection atomically
        // (RFC 0013 §9; projection.rs:644).
        if (value.status === 'UnpairedSurrogate') {
          throw new ProjectionFailure('UnpairedSurrogate');
        }
        projected = stringValue(value.text);
        break;
      }
      case 'Integer':
        projected = integerValue(value.value);
        break;
      case 'Real': {
        projected = binaryFloat64Value(bitsOfFloat64(value.real.asF64()));
        break;
      }
      case 'Boolean':
        projected = { kind: 'Boolean', value: value.value };
        break;
      case 'Date':
        projected = objectValue([
          { key: 'epoch', value: stringValue(PLIST_EPOCH_SPELLING) },
          { key: 'seconds', value: binaryFloat64Value(bitsOfFloat64(value.seconds)) },
        ]);
        break;
      case 'Data':
        projected = bytesValue(value.bytes);
        break;
      case 'Uid': {
        if (uidPolicy === 'Exclude') {
          throw new ProjectionFailure('Unrepresentable', { reason: 'uid' });
        }
        projected = objectValue([{ key: 'uid', value: integerValue(BigInt(value.value)) }]);
        break;
      }
    }
    this.origin({ kind: 'Value', path }, this.valueNodeRef(node.index()), 'Direct');
    return projected;
  }

  /** Unique-key Object over the root dictionary under one collision policy (projection.rs:671-733). */
  projectRequireObject(collision: CollisionPolicy): { readonly value: PortableValue; readonly fidelity: Fidelity } {
    const native = this.#document.document();
    if (native === null) {
      throw new ProjectionFailure('IncompleteDocument');
    }
    this.step();
    this.reserveValue(1);
    const root = native.get(native.root());
    if (root?.kind !== 'Dict') {
      throw new ProjectionFailure('Unrepresentable', { reason: 'root-not-dict' });
    }
    const seen = new Map<string, number>();
    const retained: Array<RetainedOccurrence | null> = [];
    const discards: Array<Array<DiscardedOccurrence>> = [];
    let fidelity: Fidelity = 'Exact';
    for (const entry of root.entries) {
      this.step();
      this.reserveValue(1);
      const valueNode = native.get(PlistValueRef.fromIndex(entry.value));
      if (valueNode === null) {
        throw new ProjectionFailure('CoreInvariant');
      }
      let scalar: PortableValue;
      switch (valueNode.kind) {
        case 'String': {
          if (valueNode.status === 'UnpairedSurrogate') {
            throw new ProjectionFailure('UnpairedSurrogate');
          }
          scalar = stringValue(valueNode.text);
          break;
        }
        case 'Integer':
          scalar = integerValue(valueNode.value);
          break;
        case 'Real':
          scalar = binaryFloat64Value(bitsOfFloat64(valueNode.real.asF64()));
          break;
        case 'Boolean':
          scalar = { kind: 'Boolean', value: valueNode.value };
          break;
        default:
          // Date, data, and UID leaves fail this target rather than being
          // rendered as strings (hard gate 3; RFC 0013 §9).
          throw new ProjectionFailure('Unrepresentable', { reason: 'leaf-not-scalar' });
      }
      const prior = seen.get(entry.key);
      if (prior === undefined) {
        seen.set(entry.key, retained.length);
        retained.push({ key: entry.key, value: scalar, entry: this.entryNodeRef(native.root().index()) });
        discards.push([]);
      } else if (collision === 'Reject') {
        throw new ProjectionFailure('Collision', { key: entry.key });
      } else if (collision === 'First') {
        discards[prior].push({ key: entry.key, entry: this.entryNodeRef(native.root().index()) });
        fidelity = 'Transformed';
      } else {
        // Last: the earlier occurrence is discarded, the current one wins.
        const earlier = retained[prior];
        if (earlier !== null) {
          discards[prior].push({ key: earlier.key, entry: earlier.entry });
          retained[prior] = { key: entry.key, value: scalar, entry: this.entryNodeRef(native.root().index()) };
          fidelity = 'Transformed';
        }
      }
    }
    // Report events and provenance for every discarded occurrence.
    for (let index = 0; index < retained.length; index++) {
      const occurrence = retained[index];
      if (occurrence === null) {
        continue;
      }
      this.origin(
        { kind: 'Value', path: ValuePath.root().child({ kind: 'ObjectValue', name: occurrence.key }) },
        occurrence.entry,
        'Direct',
      );
      for (const discarded of discards[index]) {
        this.event(discarded.entry);
        this.origin(
          { kind: 'Value', path: ValuePath.root().child({ kind: 'ObjectValue', name: discarded.key }) },
          discarded.entry,
          'Collapsed',
        );
      }
    }
    const entries: ObjectEntry[] = retained
      .filter((occurrence): occurrence is RetainedOccurrence => occurrence !== null)
      .map((occurrence) => ({ key: occurrence.key, value: occurrence.value }));
    return { value: { kind: 'Object', entries }, fidelity };
  }
}

function bitsOfFloat64(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  return view.getBigUint64(0, false);
}

/** Projects one complete plist document under one explicit target and policy contract (RFC 0013 §9). */
export function project(document: PlistDocument, request: ProjectionRequest): ProjectionResult {
  if (document.formationStatus() !== 'Complete' || document.document() === null) {
    return failed(new ProjectionFailure('IncompleteDocument'));
  }
  const context = new Context(document, request.limits());
  try {
    const result =
      request.target() === 'ValueTreeV1'
        ? { value: context.projectValueTree(request.uidPolicy()), fidelity: 'Exact' as const }
        : context.projectRequireObject(request.collision());
    const report = ProjectionReport.create(context.report(), request.limits());
    const provenance = ProvenanceMap.create(context.provenance(), request.limits());
    return {
      kind: 'Complete',
      value: new CompleteProjection(result.value, result.fidelity, report, provenance),
    };
  } catch (error) {
    if (!(error instanceof ProjectionFailure)) {
      throw error;
    }
    return failed(error);
  }
}

function failed(failure: ProjectionFailure): ProjectionResult {
  return {
    kind: 'Failed',
    value: new FailedProjectionAttempt(
      [failureDiagnostic(failure)],
      ProjectionReport.create([], DEFAULT_PROJECTION_LIMITS),
    ),
  };
}


/** One stable projection failure diagnostic (projection.rs:353-403). */
function failureDiagnostic(failure: ProjectionFailure): Diagnostic {
  const arguments_ = new Map<string, string>();
  if (failure.kind === 'Collision' && failure.key !== undefined) {
    arguments_.set('key', failure.key);
  }
  if (failure.kind === 'Unrepresentable' && failure.reason !== undefined) {
    arguments_.set('reason', failure.reason);
  }
  if (failure.kind === 'ResourceLimit' && failure.limitName !== undefined) {
    arguments_.set('name', failure.limitName);
  }
  return {
    code: failure.code,
    category: 'Projection',
    severity: 'Error',
    primary: null,
    related: [],
    arguments: arguments_,
    notes: [],
    occurrence: 0n,
  };
}
