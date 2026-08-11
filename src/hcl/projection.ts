/**
 * HCL projection: the exact `hcl.projection.body@1` record target with the
 * literal-complete boundary and the `ProjectExpression` policy (RFC 0014
 * §8).
 *
 * authority: crates/consema-hcl/src/projection.rs —
 *  - the record shape (:31-66): `{ "record": "hcl.body@1", "items": [...] }`
 *    with attribute/block items; typed members are core values — string,
 *    integer (BigInteger), real (Decimal), boolean, null, tuple (Sequence),
 *    object (EntryMapping); object keys render as strings (:57-65), a
 *    parenthesized tuple/object key fails with `unrepresentable`
 *    ("object-key")
 *  - the `hcl.expression@1` ExtendedValue (:67-97): `{ "record":
 *    "hcl.expression@1", "kind": <family>, "text": <exact text>,
 *    "fingerprint": <16 hex> }`; the kind family table (:90-96) and the
 *    fingerprint (:98-115, materialization.rs:1507-1516)
 *  - ProjectionTarget :166-171, ExpressionPolicy :173-183,
 *    ProjectionRequest :185-239, ProjectionLimits :241-268 (defaults:
 *    2M source nodes, 2M value nodes, 100k report entries, 4M provenance
 *    units), Fidelity :270-279, ProvenanceRelation :281-292,
 *    SourceOrigin :294-305, ProvenanceEntry :307-315, ProvenanceMap
 *    :317-346, ProjectionEventKind :348-355, ProjectionEvent :357-368,
 *    ProjectionReport :370-399, CompleteProjection :401-412,
 *    FailedProjectionAttempt :414-421, ProjectionResult :423-430,
 *    ProjectionFailure :432-451 (codes :468-476: incomplete-document /
 *    non-literal-expression / unrepresentable / resource-limit /
 *    core-invariant)
 *  - the projection walk (:602-1000): atomic failure, per-item source
 *    order, duplicate keys preserved, canonical decimals
 *
 * Design (TypeScript-idiomatic): the projected record is built with the
 * core domain's PortableValue constructors; the walk is a bounded
 * recursive descent over the snapshot-bound entity arena. Failure is
 * atomic — a recovered source, a derived expression under the default
 * policy, an unrepresentable fact, or a resource limit returns no partial
 * value, provenance, or report (hard gate 4).
 */

import type { NodeRef, Span, SnapshotIdentity } from '../document/identity.ts';
import { diagnostic as makeDiagnostic } from '../document/diagnostic.ts';
import type { Diagnostic } from '../document/diagnostic.ts';
import { ValuePath } from '../document/portable_locations.ts';
import {
  stringValue,
  integerValue,
  decimalValue,
  booleanValue,
  nullValue,
  sequenceValue,
  objectValue,
  entryMappingValue,
} from '../core/value.ts';
import type { PortableValue, EntryMappingEntry } from '../core/value.ts';
import { HclDocument } from './document.ts';
import type { HclExpr } from './expression.ts';
import {
  isLiteralComplete,
  literalValue,
  expressionKindOf,
  kindFamily,
  expressionFingerprintHex,
} from './expression.ts';
import type { HclLiteralValue, HclLiteralKey } from './expression.ts';
import { HclProjectionFailure } from './errors.ts';
import type { HclProjectionFailureKind } from './errors.ts';

// ---------------------------------------------------------------------------
// Request and policy (projection.rs:166-268)
// ---------------------------------------------------------------------------

/** Versioned HCL projection target (projection.rs:166-171). */
export type HclProjectionTarget = 'BodyV1';

/** Derived-expression handling for the body target (projection.rs:173-183). */
export type HclExpressionPolicy = 'Fail' | 'ProjectExpression';

/** Explicit HCL projection request (projection.rs:185-239). */
export class HclProjectionRequest {
  readonly #target: HclProjectionTarget;
  readonly #policy: HclExpressionPolicy;
  readonly #limits: HclProjectionLimits;

  /** Exact `hcl.projection.body@1` request; a derived expression fails atomically. */
  constructor(
    policy: HclExpressionPolicy = 'Fail',
    limits: HclProjectionLimits = DEFAULT_HCL_PROJECTION_LIMITS,
  ) {
    this.#target = 'BodyV1';
    this.#policy = policy;
    this.#limits = limits;
  }

  /** The body request with an explicit derived-expression policy. */
  static bodyWithExpressionPolicy(policy: HclExpressionPolicy): HclProjectionRequest {
    return new HclProjectionRequest(policy);
  }

  /** Applies explicit resource limits. */
  withLimits(limits: HclProjectionLimits): HclProjectionRequest {
    return new HclProjectionRequest(this.#policy, limits);
  }

  /** Projection target. */
  target(): HclProjectionTarget {
    return this.#target;
  }

  /** Derived-expression policy. */
  expressionPolicy(): HclExpressionPolicy {
    return this.#policy;
  }

  /** Resource limits. */
  limits(): HclProjectionLimits {
    return this.#limits;
  }
}

/** HCL projection resource limits (projection.rs:241-268). */
export interface HclProjectionLimits {
  /** Maximum inspected native constructs: every attribute, block, label, and expression node. */
  readonly maxSourceNodes: number;
  /** Maximum produced PortableValue nodes, entry keys included. */
  readonly maxValueNodes: number;
  /** Maximum report events. */
  readonly maxReportEntries: number;
  /** Maximum projected locations plus source origins. */
  readonly maxProvenanceUnits: number;
}

/** The frozen defaults (projection.rs:259-267). */
export const DEFAULT_HCL_PROJECTION_LIMITS: Readonly<HclProjectionLimits> = Object.freeze({
  maxSourceNodes: 2_000_000,
  maxValueNodes: 2_000_000,
  maxReportEntries: 100_000,
  maxProvenanceUnits: 4_000_000,
});

// ---------------------------------------------------------------------------
// Completion algebra (projection.rs:270-430)
// ---------------------------------------------------------------------------

/** Projection fidelity classification (projection.rs:270-279). */
export type HclProjectionFidelity = 'Exact' | 'Transformed' | 'Lossy';

/** Source-to-projection relation (projection.rs:281-292). */
export type HclProvenanceRelation = 'Direct' | 'Derived' | 'Collapsed' | 'ReferenceDerived';

/** One exact source origin (projection.rs:294-305). */
export class HclSourceOrigin {
  readonly #snapshot: SnapshotIdentity;
  readonly #node: NodeRef;
  readonly #span: Span;
  readonly #relation: HclProvenanceRelation;

  constructor(snapshot: SnapshotIdentity, node: NodeRef, span: Span, relation: HclProvenanceRelation) {
    this.#snapshot = snapshot;
    this.#node = node;
    this.#span = span;
    this.#relation = relation;
  }

  /** Source document snapshot. */
  snapshot(): SnapshotIdentity {
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
  relation(): HclProvenanceRelation {
    return this.#relation;
  }
}

/** One many-valued provenance entry (projection.rs:307-315). */
export class HclProvenanceEntry {
  readonly #projected: ValuePath;
  readonly #origins: readonly HclSourceOrigin[];

  constructor(projected: ValuePath, origins: readonly HclSourceOrigin[]) {
    this.#projected = projected;
    this.#origins = Object.freeze([...origins]);
  }

  /** Projected location inside the `hcl.body@1` record. */
  projected(): ValuePath {
    return this.#projected;
  }

  /** Ordered source origins. */
  origins(): readonly HclSourceOrigin[] {
    return this.#origins;
  }
}

/** Immutable many-valued provenance mapping (projection.rs:317-346). */
export class HclProvenanceMap {
  readonly #entries: readonly HclProvenanceEntry[];

  private constructor(entries: readonly HclProvenanceEntry[]) {
    this.#entries = Object.freeze([...entries]);
  }

  static of(entries: readonly HclProvenanceEntry[]): HclProvenanceMap {
    return new HclProvenanceMap(entries);
  }

  /** Deterministically ordered projected locations and origins. */
  entries(): readonly HclProvenanceEntry[] {
    return this.#entries;
  }
}

/** Projection report category (projection.rs:348-355). */
export type HclProjectionEventKind = 'ExpressionSubstituted';

/** One explicit transformation event (projection.rs:357-368). */
export class HclProjectionEvent {
  readonly #kind: HclProjectionEventKind;
  readonly #expression: NodeRef;
  readonly #value: ValuePath;
  readonly #impact: HclProjectionFidelity;

  constructor(kind: HclProjectionEventKind, expression: NodeRef, value: ValuePath, impact: HclProjectionFidelity) {
    this.#kind = kind;
    this.#expression = expression;
    this.#value = value;
    this.#impact = impact;
  }

  /** Stable event kind. */
  kind(): HclProjectionEventKind {
    return this.#kind;
  }

  /** Source expression occurrence substituted. */
  expression(): NodeRef {
    return this.#expression;
  }

  /** Projected value location inside the `hcl.body@1` record. */
  value(): ValuePath {
    return this.#value;
  }

  /** Fidelity impact. */
  impact(): HclProjectionFidelity {
    return this.#impact;
  }
}

/** Complete ordered projection report (projection.rs:370-399). */
export class HclProjectionReport {
  readonly #events: readonly HclProjectionEvent[];

  private constructor(events: readonly HclProjectionEvent[]) {
    this.#events = Object.freeze([...events]);
  }

  static of(events: readonly HclProjectionEvent[]): HclProjectionReport {
    return new HclProjectionReport(events);
  }

  /** Events in deterministic source order. */
  events(): readonly HclProjectionEvent[] {
    return this.#events;
  }
}

/** Complete successful projection (projection.rs:401-412). */
export class HclCompleteProjection {
  readonly #value: PortableValue;
  readonly #fidelity: HclProjectionFidelity;
  readonly #report: HclProjectionReport;
  readonly #provenance: HclProvenanceMap;

  constructor(
    value: PortableValue,
    fidelity: HclProjectionFidelity,
    report: HclProjectionReport,
    provenance: HclProvenanceMap,
  ) {
    this.#value = value;
    this.#fidelity = fidelity;
    this.#report = report;
    this.#provenance = provenance;
  }

  /** Complete immutable projected `hcl.body@1` record. */
  value(): PortableValue {
    return this.#value;
  }

  /** Worst operation fidelity. */
  fidelity(): HclProjectionFidelity {
    return this.#fidelity;
  }

  /** Structured transformation report. */
  report(): HclProjectionReport {
    return this.#report;
  }

  /** Value provenance from the body to the record. */
  provenance(): HclProvenanceMap {
    return this.#provenance;
  }
}

/** Failed projection attempt without a partial value (projection.rs:414-421). */
export class HclFailedProjectionAttempt {
  readonly #diagnostics: readonly Diagnostic[];
  readonly #report: HclProjectionReport;

  constructor(diagnostics: readonly Diagnostic[], report: HclProjectionReport) {
    this.#diagnostics = Object.freeze([...diagnostics]);
    this.#report = report;
  }

  /** Stable ordered diagnostics. */
  diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics;
  }

  /** Empty report: failed projections publish no partial transformation result. */
  report(): HclProjectionReport {
    return this.#report;
  }
}

/** Projection completion algebra (projection.rs:423-430). */
export type HclProjectionResult =
  | { readonly kind: 'Complete'; readonly value: HclCompleteProjection }
  | { readonly kind: 'Failed'; readonly value: HclFailedProjectionAttempt };

// ---------------------------------------------------------------------------
// Projection execution
// ---------------------------------------------------------------------------

const HCL_BODY_RECORD = 'hcl.body@1';
const HCL_EXPRESSION_RECORD = 'hcl.expression@1';

/** The canonical payload envelope of one `hcl.expression@1` record. */
export interface HclExpressionPayload {
  readonly kind: string;
  readonly text: string;
  readonly fingerprint: string;
}

/** Extracts the canonical payload of one expression (projection.rs:536-579). */
export function hclExpressionPayload(document: HclDocument, expression: HclExpr): HclExpressionPayload {
  const span = expression.span;
  const decoded = document.source().decodedText() ?? '';
  const start = document.source().decodedPosition(span.startByte()).utf16CodeUnitOffset;
  const end = document.source().decodedPosition(span.endByte()).utf16CodeUnitOffset;
  const text = decoded.slice(start, end);
  return {
    kind: kindFamily(expressionKindOf(expression)),
    text,
    fingerprint: expressionFingerprintHex(expression),
  };
}

/** Projects one complete HCL document under the explicit target and policy (RFC 0014 §8). */
export function projectHcl(
  document: HclDocument,
  request: HclProjectionRequest,
): HclProjectionResult {
  const limits = request.limits();
  const report: HclProjectionEvent[] = [];
  const provenance: HclProvenanceEntry[] = [];
  const fail = (kind: HclProjectionFailureKind, options: { text?: string; fact?: string; limitName?: string; span?: Span } = {}): HclProjectionResult => {
    const primary =
      options.span !== undefined
        ? { snapshot: null, startByte: BigInt(options.span.startByte()), endByte: BigInt(options.span.endByte()) }
        : null;
    const failure = new HclProjectionFailure(kind, options);
    return {
      kind: 'Failed',
      value: new HclFailedProjectionAttempt(
        [makeDiagnostic(failure.code, 'Projection', 'Error', primary, 0n)],
        HclProjectionReport.of([]),
      ),
    };
  };
  if (document.formationStatus() !== 'Complete') {
    return fail('IncompleteDocument');
  }
  const items: PortableValue[] = [];
  const rootPath = ValuePath.root();
  try {
    projectBodyItems(document, document.root().index(), items, rootPath, {
      limits,
      report,
      provenance,
      policy: request.expressionPolicy(),
      counts: { sourceNodes: 0, valueNodes: 0 },
    });
  } catch (failure) {
    if (failure instanceof HclProjectionFailure) {
      return fail(
        failure.kind,
        failure.kind === 'NonLiteralExpression'
          ? { text: failure.text }
          : failure.kind === 'Unrepresentable'
            ? { fact: failure.fact }
            : { limitName: failure.limitName },
      );
    }
    throw failure;
  }
  const record = objectValue([
    { key: 'record', value: stringValue(HCL_BODY_RECORD) },
    { key: 'items', value: sequenceValue(items) },
  ]);
  const fidelity = report.length > 0 ? 'Transformed' : 'Exact';
  return {
    kind: 'Complete',
    value: new HclCompleteProjection(
      record,
      fidelity,
      HclProjectionReport.of(report),
      HclProvenanceMap.of(provenance),
    ),
  };
}

interface ProjectState {
  readonly limits: HclProjectionLimits;
  readonly report: HclProjectionEvent[];
  readonly provenance: HclProvenanceEntry[];
  readonly policy: HclExpressionPolicy;
  readonly counts: { sourceNodes: number; valueNodes: number };
}

function noteSource(state: ProjectState, amount: number): void {
  state.counts.sourceNodes += amount;
  if (state.counts.sourceNodes > state.limits.maxSourceNodes) {
    throw new HclProjectionFailure('ResourceLimit', { limitName: 'max_source_nodes' });
  }
}

function noteValue(state: ProjectState, amount: number): void {
  state.counts.valueNodes += amount;
  if (state.counts.valueNodes > state.limits.maxValueNodes) {
    throw new HclProjectionFailure('ResourceLimit', { limitName: 'max_value_nodes' });
  }
}

function noteProvenance(state: ProjectState, units: number): void {
  if (state.provenance.length + units > state.limits.maxProvenanceUnits) {
    throw new HclProjectionFailure('ResourceLimit', { limitName: 'max_provenance_units' });
  }
}

function noteReport(state: ProjectState, events: number): void {
  if (state.report.length + events > state.limits.maxReportEntries) {
    throw new HclProjectionFailure('ResourceLimit', { limitName: 'max_report_entries' });
  }
}

/** Projects one body's items in source order (projection.rs:602-1000). */
function projectBodyItems(
  document: HclDocument,
  bodyIndex: number,
  items: PortableValue[],
  path: ValuePath,
  state: ProjectState,
): void {
  const body = document.bodyEntity(bodyIndex);
  noteSource(state, 1);
  for (let ordinal = 0; ordinal < body.items.length; ordinal++) {
    const itemIndex = body.items[ordinal];
    const entity = document.entity(itemIndex);
    const itemPath = path.child({ kind: 'SequenceElement', index: BigInt(ordinal) });
    if (entity.role === 'Attribute') {
      noteSource(state, 1);
      const valuePath = itemPath.child({ kind: 'ObjectValue', name: 'value' });
      const value = projectExpression(document, entity.expression, valuePath, state);
      const item = objectValue([
        { key: 'kind', value: stringValue('attribute') },
        { key: 'name', value: stringValue(entity.name) },
        { key: 'value', value },
      ]);
      noteValue(state, 3 + recordDepth(value));
      items.push(item);
      noteProvenance(state, 2);
      const expressionEntity = document.expressionEntity(entity.expression);
      state.provenance.push(
        new HclProvenanceEntry(
          valuePath,
          [
            new HclSourceOrigin(
              document.snapshotIdentity(),
              document.nodeRef(entity.expression, 'HclExpression'),
              expressionEntity.span,
              'Direct',
            ),
          ],
        ),
      );
    } else if (entity.role === 'Block') {
      noteSource(state, 1 + entity.labels.length + 1);
      const nestedItems: PortableValue[] = [];
      const bodyPath = itemPath.child({ kind: 'ObjectValue', name: 'body' });
      projectBodyItems(document, entity.body, nestedItems, bodyPath, state);
      const labels: PortableValue[] = [];
      for (const label of entity.labels) {
        labels.push(stringValue(document.blockLabelEntity(label).text));
        noteValue(state, 1);
      }
      const item = objectValue([
        { key: 'kind', value: stringValue('block') },
        { key: 'type', value: stringValue(entity.type) },
        { key: 'labels', value: sequenceValue(labels) },
        { key: 'body', value: objectValue([
          { key: 'record', value: stringValue(HCL_BODY_RECORD) },
          { key: 'items', value: sequenceValue(nestedItems) },
        ]) },
      ]);
      noteValue(state, 4 + labels.length);
      items.push(item);
      noteProvenance(state, 2);
      state.provenance.push(
        new HclProvenanceEntry(
          bodyPath,
          [
            new HclSourceOrigin(
              document.snapshotIdentity(),
              document.nodeRef(itemIndex, 'HclBlock'),
              entity.span,
              'Direct',
            ),
          ],
        ),
      );
    }
  }
}

/** Projects one attribute value expression (RFC 0014 §8.1-§8.2). */
function projectExpression(
  document: HclDocument,
  expressionIndex: number,
  path: ValuePath,
  state: ProjectState,
): PortableValue {
  const entity = document.expressionEntity(expressionIndex);
  noteSource(state, 1);
  if (isLiteralComplete(entity.kind)) {
    const literal = literalValue(entity.kind);
    if (literal === null) {
      throw new HclProjectionFailure('CoreInvariant');
    }
    const value = projectLiteral(literal, path, state);
    return value;
  }
  if (state.policy !== 'ProjectExpression') {
    const span = entity.span;
    const decoded = document.source().decodedText() ?? '';
    const text = decoded.slice(
      document.source().decodedPosition(span.startByte()).utf16CodeUnitOffset,
      document.source().decodedPosition(span.endByte()).utf16CodeUnitOffset,
    );
    throw new HclProjectionFailure('NonLiteralExpression', { text });
  }
  // The authorized `hcl.expression@1` ExtendedValue (RFC 0014 §8.2).
  const payload = hclExpressionPayload(document, entity.kind);
  const record = objectValue([
    { key: 'record', value: stringValue(HCL_EXPRESSION_RECORD) },
    { key: 'kind', value: stringValue(payload.kind) },
    { key: 'text', value: stringValue(payload.text) },
    { key: 'fingerprint', value: stringValue(payload.fingerprint) },
  ]);
  noteValue(state, 5);
  noteReport(state, 1);
  state.report.push(
    new HclProjectionEvent('ExpressionSubstituted', document.nodeRef(expressionIndex, 'HclExpression'), path, 'Transformed'),
  );
  noteProvenance(state, 2);
  state.provenance.push(
    new HclProvenanceEntry(
      path,
      [
        new HclSourceOrigin(
          document.snapshotIdentity(),
          document.nodeRef(expressionIndex, 'HclExpression'),
          entity.span,
          'Direct',
        ),
      ],
    ),
  );
  return record;
}

/** Maps one typed literal to the record member (projection.rs:51-66). */
function projectLiteral(literal: HclLiteralValue, path: ValuePath, state: ProjectState): PortableValue {
  switch (literal.kind) {
    case 'String':
      noteValue(state, 1);
      return stringValue(literal.text);
    case 'Integer':
      noteValue(state, 1);
      return integerValue(BigInt(literal.canonical));
    case 'Decimal':
      noteValue(state, 1);
      return decimalValueFromCanonical(literal.canonical);
    case 'Boolean':
      noteValue(state, 1);
      return booleanValue(literal.value);
    case 'Null':
      noteValue(state, 1);
      return nullValue();
    case 'Tuple': {
      const elements: PortableValue[] = [];
      for (let index = 0; index < literal.elements.length; index++) {
        elements.push(
          projectLiteral(literal.elements[index], path.child({ kind: 'SequenceElement', index: BigInt(index) }), state),
        );
      }
      noteValue(state, 1);
      return sequenceValue(elements);
    }
    case 'Object': {
      const entries: EntryMappingEntry[] = [];
      for (let index = 0; index < literal.entries.length; index++) {
        const entry = literal.entries[index];
        const key = literalKeyString(entry.key, state);
        entries.push({
          key: stringValue(key),
          value: projectLiteral(entry.value, path.child({ kind: 'EntryValue', index: BigInt(index) }), state),
        });
      }
      noteValue(state, 1);
      return entryMappingValue(entries);
    }
  }
}

/** The canonical string spelling of one literal key (projection.rs:57-65). */
function literalKeyString(key: HclLiteralKey, state: ProjectState): string {
  switch (key.kind) {
    case 'Identifier':
      return key.name;
    case 'Number':
      return key.canonical;
    case 'String':
      return key.text;
    case 'Value': {
      const value = key.value;
      if (value.kind === 'String') return value.text;
      if (value.kind === 'Integer') return value.canonical;
      if (value.kind === 'Decimal') return value.canonical;
      if (value.kind === 'Boolean') return value.value ? 'true' : 'false';
      if (value.kind === 'Null') return 'null';
      throw new HclProjectionFailure('Unrepresentable', { fact: 'object-key' });
    }
  }
}

/** One `Decimal` member from a canonical decimal spelling (coefficient × 10^exponent). */
export function decimalValueFromCanonical(canonical: string): PortableValue {
  const negative = canonical.startsWith('-');
  const unsigned = negative ? canonical.slice(1) : canonical;
  const dot = unsigned.indexOf('.');
  if (dot < 0) {
    return decimalValue(BigInt(negative ? `-${unsigned}` : unsigned), 0n);
  }
  const digits = unsigned.slice(0, dot) + unsigned.slice(dot + 1);
  const fraction = unsigned.length - dot - 1;
  return decimalValue(BigInt(negative ? `-${digits}` : digits), BigInt(-fraction));
}

/** Depth of one produced record (limit accounting; keys included). */
function recordDepth(value: PortableValue): number {
  if (value.kind === 'Sequence') {
    return 1 + value.items.reduce((sum, item) => sum + recordDepth(item), 0);
  }
  if (value.kind === 'Object' || value.kind === 'EntryMapping') {
    const entries = value.kind === 'Object' ? value.entries : value.entries;
    return 1 + entries.reduce((sum, entry) => sum + recordDepth(entry.value), 0);
  }
  return 1;
}
