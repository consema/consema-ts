/**
 * Exact-first projection from a complete JSON document to PortableValue.
 *
 * authority: crates/consema-json/src/projection.rs
 *  - ProjectionTarget :14-24 (ProjectAsObjectV1 | ProjectAsEntryMappingV1 |
 *    BestExactCoreV1 | Json5BestExactCoreV1)
 *  - DuplicateKeyPolicy :26-35 (Reject | FirstWins | LastWins),
 *    ProjectionPolicyScope :37-44, ProjectionRequest/Builder :52-144
 *    (default global policy Reject :85-93, conflicting equal-precedence
 *    rules rejected :130-137)
 *  - ProjectionLimits :146-168 (defaults 1M value nodes, 100k report
 *    entries, 2M provenance entries, depth 256)
 *  - Fidelity :170-179 (Exact | Transformed | Lossy), ProjectedLocation
 *    :181-188, ProvenanceRelation :190-203, SourceOrigin :205-216,
 *    ProvenanceEntry :218-225, ProvenanceMap :227-239, ProjectionEventKind
 *    :241-256, ProjectionEvent :258-277, ProjectionReport :279-291,
 *    CompleteProjection :293-304, FailedProjectionAttempt :306-315,
 *    ProjectionResult :317-324, ProjectionFailure :326-355
 *  - Document::project :357-429 (RecoveredDocument gate :361-366,
 *    profile-bound targets :367-376, policy target validation :377-399,
 *    root mapping-target gate :400-410)
 *  - the projection context :432-689 (project_value :443-499,
 *    project_object :501-639, duplicate policy selection :641-657,
 *    provenance origins :659-678, report events :680-688)
 *  - duplicate selection :691-726, failure diagnostics :728-765
 *    (kind→code table :754-765)
 *  - frozen codes: crates/consema-protocol/src/error_registry.rs:191-195
 *    (core.projection.*), :221-222, :286 (json.projection.*),
 *    :1332 (json.projection.incomplete-document@1)
 *  - vector-pinned behavior: conformance/vectors/json-family-v2.json
 *    (json5.projection.duplicates-nonfinite, old-target-rejected),
 *    conformance/vectors/v1.json (projection.best-exact-duplicate-mapping,
 *    projection.object-reject-duplicates, projection.object-last-wins,
 *    projection.object-key-provenance)
 *
 * Design (TypeScript-idiomatic): an immutable request built through a
 * builder; the projection context walks the document once, collecting the
 * complete value, fidelity, report events, and provenance, or fails with a
 * typed `ProjectionFailure` — a failure never contains a partial value.
 */

import { NodeRef, Span } from '../document/identity.ts';
import { AssociationLocation, ValuePath } from '../document/portable_locations.ts';
import type { Diagnostic } from '../document/diagnostic.ts';
import {
  binaryFloat64Value,
  booleanValue,
  decimalValue,
  entryMappingValue,
  integerValue,
  nullValue,
  objectValue,
  sequenceValue,
  stringValue,
} from '../core/value.ts';
import type { EntryMappingEntry, ObjectEntry, PortableValue } from '../core/value.ts';
import { ProjectionFailure, projectionFailureCode } from './errors.ts';
import type { ProjectionFailureKind } from './errors.ts';
import { JsonDocument, JsonObjectMember, JsonValue } from './document.ts';

// ---------------------------------------------------------------------------
// Targets and policies
// ---------------------------------------------------------------------------

/**
 * Versioned projection target contract (projection.rs:14-24). The stable
 * names are the Rust enum spellings; the conformance runner maps the
 * vector shorthands ("BestExactCore@1", "ProjectAsObject@1" in v1,
 * "json-best-exact"/"json5-best-exact" in v2).
 */
export type ProjectionTarget =
  | 'ProjectAsObjectV1'
  | 'ProjectAsEntryMappingV1'
  | 'BestExactCoreV1'
  | 'Json5BestExactCoreV1';

/** Explicit duplicate member policy (projection.rs:26-35). */
export type DuplicateKeyPolicy = 'Reject' | 'FirstWins' | 'LastWins';

/** Scope supported by the 0.1.0 projection policy rules (projection.rs:37-44). */
export type ProjectionPolicyScope =
  | { readonly kind: 'Global' }
  | { readonly kind: 'ExactNodeRef'; readonly node: NodeRef };

interface DuplicateRule {
  readonly scope: ProjectionPolicyScope;
  readonly policy: DuplicateKeyPolicy;
}

/** Projection resource limits (projection.rs:146-157). */
export interface ProjectionLimits {
  /** Maximum produced PortableValue nodes. */
  readonly maxValueNodes: number;
  /** Maximum report events. */
  readonly maxReportEntries: number;
  /** Maximum provenance locations. */
  readonly maxProvenanceEntries: number;
  /** Maximum recursion depth. */
  readonly maxDepth: number;
}

/** The frozen defaults (projection.rs:159-168). */
export const DEFAULT_PROJECTION_LIMITS: Readonly<ProjectionLimits> = Object.freeze({
  maxValueNodes: 1_000_000,
  maxReportEntries: 100_000,
  maxProvenanceEntries: 2_000_000,
  maxDepth: 256,
});

/** Immutable versioned projection request (projection.rs:52-72). */
export class ProjectionRequest {
  readonly #target: ProjectionTarget;
  readonly #duplicateRules: readonly DuplicateRule[];
  readonly #limits: ProjectionLimits;

  /** @internal — construction is via `ProjectionRequestBuilder.build`. */
  constructor(
    target: ProjectionTarget,
    duplicateRules: readonly DuplicateRule[],
    limits: ProjectionLimits,
  ) {
    this.#target = target;
    this.#duplicateRules = Object.freeze([...duplicateRules]);
    this.#limits = limits;
  }

  /** Target contract (projection.rs:62-66). */
  target(): ProjectionTarget {
    return this.#target;
  }

  /** Ordered policy rules; exact-node scopes precede the global rule (projection.rs:641-657). */
  duplicateRules(): readonly { readonly scope: ProjectionPolicyScope; readonly policy: DuplicateKeyPolicy }[] {
    return this.#duplicateRules;
  }

  /** Projection resource limits (projection.rs:68-71). */
  limits(): ProjectionLimits {
    return this.#limits;
  }
}

/** Builder that rejects conflicting equal-precedence rules (projection.rs:74-144). */
export class ProjectionRequestBuilder {
  readonly #target: ProjectionTarget;
  #duplicateRules: DuplicateRule[];
  #limits: ProjectionLimits;

  /** Starts with `ExactOrReject` behavior (projection.rs:83-94). */
  constructor(target: ProjectionTarget) {
    this.#target = target;
    this.#duplicateRules = [{ scope: { kind: 'Global' }, policy: 'Reject' }];
    this.#limits = DEFAULT_PROJECTION_LIMITS;
  }

  /** Replaces the global duplicate policy (projection.rs:96-106). */
  withGlobalDuplicatePolicy(policy: DuplicateKeyPolicy): ProjectionRequestBuilder {
    const builder = this.#copy();
    builder.#duplicateRules = [
      ...builder.#duplicateRules.filter((rule) => rule.scope.kind !== 'Global'),
      { scope: { kind: 'Global' }, policy },
    ];
    return builder;
  }

  /** Adds an exact-node override (projection.rs:108-120). */
  withExactNodeDuplicatePolicy(
    node: NodeRef,
    policy: DuplicateKeyPolicy,
  ): ProjectionRequestBuilder {
    const builder = this.#copy();
    builder.#duplicateRules = [
      ...builder.#duplicateRules,
      { scope: { kind: 'ExactNodeRef', node }, policy },
    ];
    return builder;
  }

  /** Sets immutable resource limits (projection.rs:122-127). */
  withLimits(limits: ProjectionLimits): ProjectionRequestBuilder {
    const builder = this.#copy();
    builder.#limits = limits;
    return builder;
  }

  /** Validates rule precedence and completes the request (projection.rs:129-143). */
  build(): ProjectionRequest {
    for (let index = 0; index < this.#duplicateRules.length; index++) {
      for (let other = index + 1; other < this.#duplicateRules.length; other++) {
        if (sameScope(this.#duplicateRules[index].scope, this.#duplicateRules[other].scope)) {
          if (this.#duplicateRules[index].policy !== this.#duplicateRules[other].policy) {
            throw new ProjectionFailure('ConflictingPolicyRules');
          }
        }
      }
    }
    return new ProjectionRequest(this.#target, this.#duplicateRules, this.#limits);
  }

  #copy(): ProjectionRequestBuilder {
    const copy = new ProjectionRequestBuilder(this.#target);
    copy.#duplicateRules = [...this.#duplicateRules];
    copy.#limits = this.#limits;
    return copy;
  }
}

function sameScope(left: ProjectionPolicyScope, right: ProjectionPolicyScope): boolean {
  if (left.kind === 'Global' && right.kind === 'Global') {
    return true;
  }
  if (left.kind === 'ExactNodeRef' && right.kind === 'ExactNodeRef') {
    return left.node.equals(right.node);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Fidelity, report, and provenance records
// ---------------------------------------------------------------------------

/** Projection fidelity classification (projection.rs:170-179). */
export type Fidelity = 'Exact' | 'Transformed' | 'Lossy';

/** Projected value or association location (projection.rs:181-188). */
export type ProjectedLocation =
  | { readonly kind: 'Value'; readonly path: ValuePath }
  | { readonly kind: 'Association'; readonly location: AssociationLocation };

/** Source-to-projection relation (projection.rs:190-203). */
export type ProvenanceRelation = 'Direct' | 'Derived' | 'Expanded' | 'Merged' | 'Generated';

/** One exact source origin (projection.rs:205-216). */
export class SourceOrigin {
  readonly #snapshot: ReturnType<JsonDocument['snapshotIdentity']>;
  readonly #node: NodeRef;
  readonly #span: Span;
  readonly #relation: ProvenanceRelation;

  constructor(
    snapshot: ReturnType<JsonDocument['snapshotIdentity']>,
    node: NodeRef,
    span: Span,
    relation: ProvenanceRelation,
  ) {
    this.#snapshot = snapshot;
    this.#node = node;
    this.#span = span;
    this.#relation = relation;
  }

  /** Source document snapshot (projection.rs:207-210). */
  snapshot() {
    return this.#snapshot;
  }

  /** Exact structural identity (projection.rs:211-213). */
  node(): NodeRef {
    return this.#node;
  }

  /** Exact source range (projection.rs:214-216). */
  span(): Span {
    return this.#span;
  }

  /** Source relation (projection.rs:217-219). */
  relation(): ProvenanceRelation {
    return this.#relation;
  }
}

/** One many-valued provenance mapping entry (projection.rs:218-225). */
export class ProvenanceEntry {
  readonly #projected: ProjectedLocation;
  readonly #origins: readonly SourceOrigin[];

  constructor(projected: ProjectedLocation, origins: readonly SourceOrigin[]) {
    this.#projected = projected;
    this.#origins = Object.freeze([...origins]);
  }

  /** Projected value or association (projection.rs:221-223). */
  projected(): ProjectedLocation {
    return this.#projected;
  }

  /** Zero or more source origins (projection.rs:224-226). */
  origins(): readonly SourceOrigin[] {
    return this.#origins;
  }
}

/** Immutable multi-map from projected locations to source origins (projection.rs:227-239). */
export class ProvenanceMap {
  readonly #entries: readonly ProvenanceEntry[];

  private constructor(entries: readonly ProvenanceEntry[]) {
    this.#entries = Object.freeze([...entries]);
  }

  /** @internal — built by the projection context. */
  static fromEntries(entries: readonly ProvenanceEntry[]): ProvenanceMap {
    return new ProvenanceMap(entries);
  }

  /** Deterministically generated entries (projection.rs:233-238). */
  entries(): readonly ProvenanceEntry[] {
    return this.#entries;
  }
}

/** Machine-readable projection event category (projection.rs:241-256). */
export type ProjectionEventKind =
  | 'StructureReencoded'
  | 'TypeMapped'
  | 'DuplicateCollapsed'
  | 'KeyStringified'
  | 'ValueRounded'
  | 'FieldDropped';

/** One structured projection report event (projection.rs:258-277). */
export class ProjectionEvent {
  readonly #kind: ProjectionEventKind;
  readonly #policy: DuplicateKeyPolicy | null;
  readonly #source: NodeRef;
  readonly #projected: ProjectedLocation | null;
  readonly #oldCategory: string;
  readonly #newCategory: string;
  readonly #reversible: boolean;
  readonly #loss: Fidelity;

  constructor(options: {
    kind: ProjectionEventKind;
    policy: DuplicateKeyPolicy | null;
    source: NodeRef;
    projected: ProjectedLocation | null;
    oldCategory: string;
    newCategory: string;
    reversible: boolean;
    loss: Fidelity;
  }) {
    this.#kind = options.kind;
    this.#policy = options.policy;
    this.#source = options.source;
    this.#projected = options.projected;
    this.#oldCategory = options.oldCategory;
    this.#newCategory = options.newCategory;
    this.#reversible = options.reversible;
    this.#loss = options.loss;
  }

  /** Stable event kind (projection.rs:262-264). */
  kind(): ProjectionEventKind {
    return this.#kind;
  }

  /** Policy rule that authorized it (projection.rs:265-267). */
  policy(): DuplicateKeyPolicy | null {
    return this.#policy;
  }

  /** Exact source identity (projection.rs:268-269). */
  source(): NodeRef {
    return this.#source;
  }

  /** Result location when one exists (projection.rs:270-272). */
  projected(): ProjectedLocation | null {
    return this.#projected;
  }

  /** Stable old semantic category (projection.rs:273-274). */
  oldCategory(): string {
    return this.#oldCategory;
  }

  /** Stable new semantic category (projection.rs:275-276). */
  newCategory(): string {
    return this.#newCategory;
  }

  /** Whether the source fact can be recovered from output plus contract (projection.rs:277-278). */
  reversible(): boolean {
    return this.#reversible;
  }

  /** Fidelity impact (projection.rs:279-280). */
  loss(): Fidelity {
    return this.#loss;
  }
}

/** Complete ordered projection report (projection.rs:279-291). */
export class ProjectionReport {
  readonly #events: readonly ProjectionEvent[];

  private constructor(events: readonly ProjectionEvent[]) {
    this.#events = Object.freeze([...events]);
  }

  static empty(): ProjectionReport {
    return new ProjectionReport([]);
  }

  /** @internal — built by the projection context. */
  static fromEvents(events: readonly ProjectionEvent[]): ProjectionReport {
    return new ProjectionReport(events);
  }

  /** Events in source/operation order (projection.rs:285-290). */
  events(): readonly ProjectionEvent[] {
    return this.#events;
  }
}

/** Complete successful projection; its value is never partial (projection.rs:293-304). */
export class CompleteProjection {
  readonly #value: PortableValue;
  readonly #fidelity: Fidelity;
  readonly #report: ProjectionReport;
  readonly #provenance: ProvenanceMap;

  constructor(
    value: PortableValue,
    fidelity: Fidelity,
    report: ProjectionReport,
    provenance: ProvenanceMap,
  ) {
    this.#value = value;
    this.#fidelity = fidelity;
    this.#report = report;
    this.#provenance = provenance;
  }

  /** Complete immutable value (projection.rs:296-299). */
  value(): PortableValue {
    return this.#value;
  }

  /** Worst fidelity of the whole operation (projection.rs:300-302). */
  fidelity(): Fidelity {
    return this.#fidelity;
  }

  /** Machine-readable transformation/loss report (projection.rs:303-305). */
  report(): ProjectionReport {
    return this.#report;
  }

  /** Basic value and association provenance (projection.rs:306-308). */
  provenance(): ProvenanceMap {
    return this.#provenance;
  }
}

/** Failed attempt without a partial PortableValue (projection.rs:306-315). */
export class FailedProjectionAttempt {
  readonly #diagnostics: readonly Diagnostic[];
  readonly #report: ProjectionReport;
  readonly #partialAnalysis: readonly string[];

  constructor(
    diagnostics: readonly Diagnostic[],
    report: ProjectionReport,
    partialAnalysis: readonly string[],
  ) {
    this.#diagnostics = Object.freeze([...diagnostics]);
    this.#report = report;
    this.#partialAnalysis = Object.freeze([...partialAnalysis]);
  }

  /** Ordered operation diagnostics (projection.rs:309-311). */
  diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics;
  }

  /** Events discovered before the failed completion check (projection.rs:312-313). */
  report(): ProjectionReport {
    return this.#report;
  }

  /** Stable path descriptions of locally analyzed regions (projection.rs:314-315). */
  partialAnalysis(): readonly string[] {
    return this.#partialAnalysis;
  }
}

/** Projection completion algebra (projection.rs:317-324). */
export type ProjectionResult =
  | { readonly kind: 'Complete'; readonly value: CompleteProjection }
  | { readonly kind: 'Failed'; readonly value: FailedProjectionAttempt };

// ---------------------------------------------------------------------------
// Projection context
// ---------------------------------------------------------------------------

interface ProjectionContextState {
  readonly document: JsonDocument;
  readonly request: ProjectionRequest;
  report: ProjectionEvent[];
  provenance: ProvenanceEntry[];
  fidelity: Fidelity;
  valueNodes: number;
  partialAnalysis: string[];
}

/**
 * Applies an immutable request. A failure never contains a partial value
 * (projection.rs:357-429).
 */
export function project(
  document: JsonDocument,
  request: ProjectionRequest,
): ProjectionResult {
  if (document.formationStatus() !== 'Complete') {
    return failed(new ProjectionFailure('RecoveredDocument'), ProjectionReport.empty(), []);
  }
  if (
    (request.target() === 'Json5BestExactCoreV1' && document.profileInternal() !== 'Json5Standard') ||
    (request.target() === 'BestExactCoreV1' && document.profileInternal() === 'Json5Standard')
  ) {
    return failed(new ProjectionFailure('TargetNotApplicable'), ProjectionReport.empty(), []);
  }
  for (const rule of request.duplicateRules()) {
    if (rule.scope.kind !== 'ExactNodeRef') {
      continue;
    }
    const node = rule.scope.node;
    if (!node.snapshot().equals(document.snapshotIdentity())) {
      return failed(new ProjectionFailure('WrongSnapshotPolicy'), ProjectionReport.empty(), []);
    }
    let index: number;
    try {
      index = document.resolveEntityIndex(node, ['Value']);
    } catch {
      return failed(new ProjectionFailure('InvalidPolicyTarget'), ProjectionReport.empty(), []);
    }
    if (document.valueEntityAt(index).value.kind !== 'Object') {
      return failed(new ProjectionFailure('InvalidPolicyTarget'), ProjectionReport.empty(), []);
    }
  }
  const rootKind = document.root().kind();
  if (
    (request.target() === 'ProjectAsObjectV1' || request.target() === 'ProjectAsEntryMappingV1') &&
    (rootKind.kind !== 'Available' || rootKind.value !== 'Object')
  ) {
    return failed(new ProjectionFailure('TargetNotApplicable'), ProjectionReport.empty(), []);
  }
  const state: ProjectionContextState = {
    document,
    request,
    report: [],
    provenance: [],
    fidelity: 'Exact',
    valueNodes: 0,
    partialAnalysis: [],
  };
  try {
    const value = projectValue(state, document.root(), ValuePath.root(), 0);
    return {
      kind: 'Complete',
      value: new CompleteProjection(
        value,
        state.fidelity,
        ProjectionReport.fromEvents(state.report),
        ProvenanceMap.fromEntries(state.provenance),
      ),
    };
  } catch (error) {
    if (!(error instanceof ProjectionFailure)) {
      throw error;
    }
    return failed(error, ProjectionReport.fromEvents(state.report), state.partialAnalysis);
  }
}

function projectValue(
  state: ProjectionContextState,
  value: JsonValue,
  path: ValuePath,
  depth: number,
): PortableValue {
  if (depth > state.request.limits().maxDepth) {
    throw new ProjectionFailure('ResourceLimit', { limitName: 'projection-depth' });
  }
  state.valueNodes += 1;
  if (state.valueNodes > state.request.limits().maxValueNodes) {
    throw new ProjectionFailure('ResourceLimit', { limitName: 'projected-value-nodes' });
  }
  state.partialAnalysis.push(`${pathText(path)}:Projectable`);
  addOrigin(state, { kind: 'Value', path }, value.nodeRef(), value.span());
  const entity = state.document.valueEntityAt(value.rawIndex());
  switch (entity.value.kind) {
    case 'Null':
      return nullValue();
    case 'Boolean':
      return booleanValue(entity.value.value);
    case 'Integer':
      return integerValue(entity.value.value);
    case 'Decimal':
      return decimalValue(entity.value.coefficient, entity.value.exponent);
    case 'BinaryFloat64':
      return binaryFloat64Value(entity.value.bits);
    case 'String':
      return stringValue(entity.value.value);
    case 'Array': {
      const items: PortableValue[] = [];
      for (let index = 0; index < entity.value.elements.length; index++) {
        const element = entity.value.elements[index];
        // `elements` holds Element-entity indexes; the value entity is the
        // element's `value` (document.ts JsonArrayElement).
        const elementEntity = state.document.entityAt(element);
        if (elementEntity.kind !== 'Element') {
          throw new Error('internal: json element entity expected');
        }
        const elementValue = new JsonValue(state.document, elementEntity.value);
        items.push(
          projectValue(
            state,
            elementValue,
            path.child({ kind: 'SequenceElement', index: BigInt(index) }),
            depth + 1,
          ),
        );
      }
      return sequenceValue(items);
    }
    case 'Object': {
      const members = entity.value.members.map((index) => new JsonObjectMember(state.document, index));
      return projectObject(state, value, members, path, depth);
    }
    case 'Unavailable':
      throw new ProjectionFailure('SemanticUnavailable', {
        node: value.nodeRef(),
        reason: entity.value.reason,
      });
  }
}

function projectObject(
  state: ProjectionContextState,
  object: JsonValue,
  members: readonly JsonObjectMember[],
  path: ValuePath,
  depth: number,
): PortableValue {
  const names: string[] = [];
  for (const member of members) {
    const name = member.name();
    if (name.kind === 'Unavailable') {
      throw new ProjectionFailure('SemanticUnavailable', {
        node: member.keyNodeRef(),
        reason: name.reason,
      });
    }
    names.push(name.value);
  }
  const seen = new Set<string>();
  const hasDuplicates = names.some((name) => {
    if (seen.has(name)) {
      return true;
    }
    seen.add(name);
    return false;
  });
  const useMapping =
    state.request.target() === 'ProjectAsEntryMappingV1' ||
    ((state.request.target() === 'BestExactCoreV1' || state.request.target() === 'Json5BestExactCoreV1') &&
      hasDuplicates);
  if (useMapping) {
    if (state.request.target() !== 'ProjectAsObjectV1') {
      state.fidelity = maxFidelity(state.fidelity, 'Transformed');
      pushEvent(state, new ProjectionEvent({
        kind: 'StructureReencoded',
        policy: null,
        source: object.nodeRef(),
        projected: { kind: 'Value', path },
        oldCategory: 'JsonObject',
        newCategory: 'EntryMapping',
        reversible: true,
        loss: 'Transformed',
      }));
    }
    const entries: EntryMappingEntry[] = [];
    for (let ordinal = 0; ordinal < members.length; ordinal++) {
      const member = members[ordinal];
      const keyPath = path.child({ kind: 'EntryKey', index: BigInt(ordinal) });
      const valuePath = path.child({ kind: 'EntryValue', index: BigInt(ordinal) });
      const association = new AssociationLocation(
        path,
        BigInt(ordinal),
        'EntryMappingEntry',
      );
      addOrigin(state, { kind: 'Association', location: association }, member.nodeRef(), member.span());
      addOrigin(state, { kind: 'Value', path: keyPath }, member.keyNodeRef(), keySpan(state, member));
      const projected = projectValue(state, member.value(), valuePath, depth + 1);
      entries.push({ key: stringValue(names[ordinal]), value: projected });
    }
    return entryMappingValue(entries);
  }

  const policy = duplicatePolicy(state, object.nodeRef());
  const retained = selectMembers(members, names, policy, object.nodeRef());
  if (retained.length !== members.length) {
    state.fidelity = 'Lossy';
  }
  const retainedSet = new Set(retained);
  const projectedOrdinals = new Map<number, number>();
  retained.forEach((sourceOrdinal, ordinal) => projectedOrdinals.set(sourceOrdinal, ordinal));
  for (let sourceOrdinal = 0; sourceOrdinal < members.length; sourceOrdinal++) {
    if (!retainedSet.has(sourceOrdinal)) {
      const name = names[sourceOrdinal];
      const retainedSource = retained.find((index) => names[index] === name)!;
      const projectedOrdinal = projectedOrdinals.get(retainedSource)!;
      pushEvent(state, new ProjectionEvent({
        kind: 'DuplicateCollapsed',
        policy,
        source: members[sourceOrdinal].nodeRef(),
        projected: {
          kind: 'Association',
          location: new AssociationLocation(path, BigInt(projectedOrdinal), 'ObjectEntry'),
        },
        oldCategory: 'JsonObjectMember',
        newCategory: 'Collapsed',
        reversible: false,
        loss: 'Lossy',
      }));
    }
  }
  const entries: ObjectEntry[] = [];
  retained.forEach((sourceOrdinal, projectedOrdinal) => {
    const member = members[sourceOrdinal];
    const name = names[sourceOrdinal];
    const valuePath = path.child({ kind: 'ObjectValue', name });
    addOrigin(
      state,
      { kind: 'Association', location: new AssociationLocation(path, BigInt(projectedOrdinal), 'ObjectEntry') },
      member.nodeRef(),
      member.span(),
    );
    addOrigin(
      state,
      { kind: 'Association', location: new AssociationLocation(path, BigInt(projectedOrdinal), 'ObjectKey') },
      member.keyNodeRef(),
      keySpan(state, member),
    );
    const value = projectValue(state, member.value(), valuePath, depth + 1);
    entries.push({ key: name, value });
  });
  return objectValue(entries);
}

/** The exact key literal span (projection.rs:624-631). */
function keySpan(state: ProjectionContextState, member: JsonObjectMember): Span {
  const entity = state.document.entityAt(member.entityIndex());
  return state.document.spanOf(entity.kind === 'Member' ? entity.key : member.entityIndex());
}

function duplicatePolicy(state: ProjectionContextState, node: NodeRef): DuplicateKeyPolicy {
  for (const rule of state.request.duplicateRules()) {
    if (rule.scope.kind === 'ExactNodeRef' && rule.scope.node.equals(node)) {
      return rule.policy;
    }
  }
  for (const rule of state.request.duplicateRules()) {
    if (rule.scope.kind === 'Global') {
      return rule.policy;
    }
  }
  return 'Reject';
}

function selectMembers(
  members: readonly JsonObjectMember[],
  names: readonly string[],
  policy: DuplicateKeyPolicy,
  node: NodeRef,
): number[] {
  const counts = new Map<string, number>();
  for (const name of names) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (policy === 'Reject') {
    for (let index = 0; index < names.length; index++) {
      if ((counts.get(names[index]) ?? 0) > 1) {
        throw new ProjectionFailure('DuplicateKeys', { node, name: names[index] });
      }
    }
  }
  if (policy === 'Reject' || policy === 'FirstWins') {
    const kept = new Set<string>();
    const retained: number[] = [];
    for (let index = 0; index < members.length; index++) {
      if (!kept.has(names[index])) {
        kept.add(names[index]);
        retained.push(index);
      }
    }
    return retained;
  }
  const kept = new Set<string>();
  const reversed: number[] = [];
  for (let index = members.length - 1; index >= 0; index--) {
    if (!kept.has(names[index])) {
      kept.add(names[index]);
      reversed.push(index);
    }
  }
  reversed.reverse();
  return reversed;
}

function addOrigin(
  state: ProjectionContextState,
  projected: ProjectedLocation,
  node: NodeRef,
  span: Span,
): void {
  if (state.provenance.length >= state.request.limits().maxProvenanceEntries) {
    throw new ProjectionFailure('ResourceLimit', { limitName: 'provenance-entries' });
  }
  state.provenance.push(
    new ProvenanceEntry(projected, [
      new SourceOrigin(state.document.snapshotIdentity(), node, span, 'Direct'),
    ]),
  );
}

function pushEvent(state: ProjectionContextState, event: ProjectionEvent): void {
  if (state.report.length >= state.request.limits().maxReportEntries) {
    throw new ProjectionFailure('ResourceLimit', { limitName: 'projection-report-entries' });
  }
  state.report.push(event);
}

function maxFidelity(left: Fidelity, right: Fidelity): Fidelity {
  const order: Record<Fidelity, number> = { Exact: 0, Transformed: 1, Lossy: 2 };
  return order[left] >= order[right] ? left : right;
}

function failed(
  error: ProjectionFailure,
  report: ProjectionReport,
  partialAnalysis: readonly string[],
): ProjectionResult {
  const failureKind: ProjectionFailureKind = error.kind;
  const arguments_ = new Map<string, string>([['failure', failureKind]]);
  return {
    kind: 'Failed',
    value: new FailedProjectionAttempt(
      [
        {
          code: projectionFailureCode(failureKind),
          category: 'Projection',
          severity: 'Error',
          primary: null,
          related: [],
          arguments: arguments_,
          notes: [],
          occurrence: 0n,
        },
      ],
      report,
      partialAnalysis,
    ),
  };
}

/** Human-readable path description for partial analysis (presentation only, projection.rs:456). */
function pathText(path: ValuePath): string {
  const segments = path
    .segments()
    .map((segment) => {
      switch (segment.kind) {
        case 'ObjectValue':
          return `.${segment.name}`;
        case 'SequenceElement':
          return `[${segment.index}]`;
        case 'EntryKey':
          return `(key ${segment.index})`;
        case 'EntryValue':
          return `(value ${segment.index})`;
      }
    })
    .join('');
  return `root${segments}`;
}
