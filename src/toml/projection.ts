/**
 * Explicit TOML projection to PortableValue with fidelity, report, and
 * provenance.
 *
 * authority:
 *  - target contract: RFC 0001 §5 (:78-100) — `toml.best-exact-core@1` and
 *    the exact category mapping (:82-94); tables meet PortableValue Object
 *    only here — the native table model stays distinct (docs/
 *    IMPLEMENTATION.md:102); unrepresentable date-times fail the whole
 *    projection with toml.projection.unrepresentable-datetime@1 (:98);
 *    provenance maps every value and object association back to a
 *    snapshot-bound source origin (:96)
 *  - structure: crates/consema-toml/src/projection.rs — ProjectionTarget
 *    (:9-14), ProjectionRequest (:16-51), ProjectionLimits (:53-75,
 *    defaults 1M/100k/2M/256), Fidelity (:77-86), ProjectedLocation
 *    (:88-95), ProvenanceRelation (:96-104), SourceOrigin (:106-117),
 *    ProvenanceEntry/ProvenanceMap (:119-140), ProjectionReport (:142-156),
 *    CompleteProjection/FailedProjectionAttempt/ProjectionResult
 *    (:158-189), ProjectionFailure (:191-200), project (:202-227),
 *    per-value provenance (:237-331), datetime mapping (:367-408),
 *    failure diagnostics (:410-435: core.projection.resource-limit@1 for
 *    limits, arguments {limit})
 *  - the vector suite pins the results end-to-end
 *    (conformance/vectors/toml-v1.json:54-70: status "Success"/"Failed",
 *    fidelity "Exact", root "Object", provenance facts, diagnostic code)
 *
 * Design (TypeScript-idiomatic): the request is an immutable class with
 * defaults; the completion algebra is a sealed union Complete | Failed
 * (RFC 0004 §7 shape); provenance locations reuse the document-domain
 * ValuePath/AssociationLocation records.
 */

import { diagnostic as makeDiagnostic } from '../document/diagnostic.ts';
import type { Diagnostic } from '../document/diagnostic.ts';
import { NodeRef, SnapshotIdentity, Span } from '../document/identity.ts';
import { ValuePath, AssociationLocation } from '../document/portable_locations.ts';
import {
  integerValue,
  binaryFloat64Value,
  dateValue,
  timeValue,
  localDateTimeValue,
  offsetDateTimeValue,
  objectValue,
  sequenceValue,
  stringValue,
  booleanValue,
  decimalValue,
} from '../core/value.ts';
import type { ObjectEntry, PortableValue } from '../core/value.ts';
import { TomlDocument } from './document.ts';
import type { TomlDateTime } from './parser.ts';
import { TomlProjectionFailure } from './errors.ts';

/** Versioned TOML projection target contract (projection.rs:9-14). */
export type TomlProjectionTarget = 'BestExactCoreV1';

/** Frozen exact-first TOML-to-core mapping (projection.rs:11-13). */
export const TOML_PROJECTION_TARGET_BEST_EXACT_CORE_V1: TomlProjectionTarget = 'BestExactCoreV1';

/** Projection resource limits (projection.rs:53-75). */
export interface TomlProjectionLimits {
  /** Maximum produced PortableValue nodes. */
  readonly maxValueNodes: number;
  /** Maximum report events. */
  readonly maxReportEntries: number;
  /** Maximum provenance locations and origins combined. */
  readonly maxProvenanceEntries: number;
  /** Maximum recursive container depth. */
  readonly maxDepth: number;
}

/** The frozen defaults (projection.rs:66-75): 1M value nodes, 100k report entries, 2M provenance units, depth 256. */
export const DEFAULT_TOML_PROJECTION_LIMITS: Readonly<TomlProjectionLimits> = Object.freeze({
  maxValueNodes: 1_000_000,
  maxReportEntries: 100_000,
  maxProvenanceEntries: 2_000_000,
  maxDepth: 256,
});

/** Immutable explicit projection request (projection.rs:16-51). */
export class TomlProjectionRequest {
  readonly #target: TomlProjectionTarget;
  readonly #limits: TomlProjectionLimits;

  constructor(target: TomlProjectionTarget, limits: TomlProjectionLimits = DEFAULT_TOML_PROJECTION_LIMITS) {
    this.#target = target;
    this.#limits = limits;
  }

  /** Frozen target contract (projection.rs:40-43). */
  target(): TomlProjectionTarget {
    return this.#target;
  }

  /** Projection resource limits (projection.rs:46-50). */
  limits(): TomlProjectionLimits {
    return this.#limits;
  }
}

/** Projection fidelity classification (projection.rs:77-86). */
export type TomlProjectionFidelity = 'Exact' | 'Transformed' | 'Lossy';

/** Projected value or association location (projection.rs:88-95). */
export type TomlProjectedLocation =
  | { readonly kind: 'Value'; readonly path: ValuePath }
  | { readonly kind: 'Association'; readonly location: AssociationLocation };

/** Source-to-projection relation (projection.rs:96-104). */
export type TomlProvenanceRelation = 'Direct' | 'Derived';

/** One exact source origin (projection.rs:106-117). */
export class TomlSourceOrigin {
  readonly #snapshot: SnapshotIdentity;
  readonly #node: NodeRef;
  readonly #span: Span;
  readonly #relation: TomlProvenanceRelation;

  constructor(snapshot: SnapshotIdentity, node: NodeRef, span: Span, relation: TomlProvenanceRelation) {
    this.#snapshot = snapshot;
    this.#node = node;
    this.#span = span;
    this.#relation = relation;
  }

  /** Source document snapshot (projection.rs:110-113). */
  snapshot(): SnapshotIdentity {
    return this.#snapshot;
  }

  /** Exact structural identity (projection.rs:114-117). */
  node(): NodeRef {
    return this.#node;
  }

  /** Exact source range (projection.rs:118-121). */
  span(): Span {
    return this.#span;
  }

  /** Source relation (projection.rs:122-125). */
  relation(): TomlProvenanceRelation {
    return this.#relation;
  }
}

/** One many-valued provenance mapping entry (projection.rs:119-126). */
export class TomlProvenanceEntry {
  readonly #projected: TomlProjectedLocation;
  readonly #origins: readonly TomlSourceOrigin[];

  constructor(projected: TomlProjectedLocation, origins: readonly TomlSourceOrigin[]) {
    this.#projected = projected;
    this.#origins = Object.freeze([...origins]);
  }

  /** Projected value or association (projection.rs:128-130). */
  projected(): TomlProjectedLocation {
    return this.#projected;
  }

  /** One or more exact source origins (projection.rs:131-133). */
  origins(): readonly TomlSourceOrigin[] {
    return this.#origins;
  }
}

/** Immutable multi-map from projected locations to source origins (projection.rs:128-140). */
export class TomlProvenanceMap {
  readonly #entries: readonly TomlProvenanceEntry[];

  private constructor(entries: readonly TomlProvenanceEntry[]) {
    this.#entries = Object.freeze([...entries]);
  }

  static create(entries: readonly TomlProvenanceEntry[]): TomlProvenanceMap {
    return new TomlProvenanceMap(entries);
  }

  /** Deterministically generated entries (projection.rs:134-139). */
  entries(): readonly TomlProvenanceEntry[] {
    return this.#entries;
  }
}

/** Complete ordered projection report; exact TOML projections emit no events (projection.rs:142-156). */
export class TomlProjectionReport {
  readonly #events: readonly Diagnostic[];

  constructor(events: readonly Diagnostic[], limits: TomlProjectionLimits) {
    if (events.length > limits.maxReportEntries) {
      throw new TomlProjectionFailure('ResourceLimit', 'max_report_entries');
    }
    this.#events = Object.freeze([...events]);
  }

  /** Ordered structured transformation/loss diagnostics (projection.rs:151-155). */
  events(): readonly Diagnostic[] {
    return this.#events;
  }
}

/** Complete successful projection; its value is never partial (projection.rs:158-169). */
export class TomlCompleteProjection {
  readonly #value: PortableValue;
  readonly #fidelity: TomlProjectionFidelity;
  readonly #report: TomlProjectionReport;
  readonly #provenance: TomlProvenanceMap;

  constructor(
    value: PortableValue,
    fidelity: TomlProjectionFidelity,
    report: TomlProjectionReport,
    provenance: TomlProvenanceMap,
  ) {
    this.#value = value;
    this.#fidelity = fidelity;
    this.#report = report;
    this.#provenance = provenance;
  }

  /** Complete immutable public value (projection.rs:162-165). */
  value(): PortableValue {
    return this.#value;
  }

  /** Worst fidelity of the whole operation (projection.rs:166-169). */
  fidelity(): TomlProjectionFidelity {
    return this.#fidelity;
  }

  /** Machine-readable transformation/loss report (projection.rs:170-173). */
  report(): TomlProjectionReport {
    return this.#report;
  }

  /** Value and object-association provenance (projection.rs:174-177). */
  provenance(): TomlProvenanceMap {
    return this.#provenance;
  }
}

/** Failed attempt without a partial PortableValue (projection.rs:171-180). */
export class TomlFailedProjectionAttempt {
  readonly #diagnostics: readonly Diagnostic[];
  readonly #report: TomlProjectionReport;
  readonly #partialAnalysis: readonly string[];

  constructor(
    diagnostics: readonly Diagnostic[],
    report: TomlProjectionReport,
    partialAnalysis: readonly string[],
  ) {
    this.#diagnostics = Object.freeze([...diagnostics]);
    this.#report = report;
    this.#partialAnalysis = Object.freeze([...partialAnalysis]);
  }

  /** Ordered diagnostics explaining the failure (projection.rs:182-185). */
  diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics;
  }

  /** Events discovered before the failed completion check (projection.rs:186-189). */
  report(): TomlProjectionReport {
    return this.#report;
  }

  /** Stable paths locally analyzed before failure (projection.rs:190-193). */
  partialAnalysis(): readonly string[] {
    return this.#partialAnalysis;
  }
}

/** Projection completion algebra (projection.rs:182-189; RFC 0004 §7 shape). */
export type TomlProjectionResult =
  | { readonly kind: 'Complete'; readonly value: TomlCompleteProjection }
  | { readonly kind: 'Failed'; readonly value: TomlFailedProjectionAttempt };

interface MutableProvenanceEntry {
  readonly projected: TomlProjectedLocation;
  readonly origins: TomlSourceOrigin[];
}

class ProjectionContext {
  readonly #document: TomlDocument;
  readonly #limits: TomlProjectionLimits;
  #valueNodes = 0;
  #provenanceUnits = 0;
  readonly #provenance: MutableProvenanceEntry[] = [];

  constructor(document: TomlDocument, limits: TomlProjectionLimits) {
    this.#document = document;
    this.#limits = limits;
  }

  document(): TomlDocument {
    return this.#document;
  }

  /** Mirrors projection.rs:237-250 value-node and depth accounting. */
  enter(depth: number): void {
    if (depth > this.#limits.maxDepth) {
      throw new TomlProjectionFailure('ResourceLimit', 'max_depth');
    }
    this.#valueNodes += 1;
    if (this.#valueNodes > this.#limits.maxValueNodes) {
      throw new TomlProjectionFailure('ResourceLimit', 'max_value_nodes');
    }
  }

  /** Mirrors projection.rs:333-364 provenance-unit accounting. */
  addOrigin(
    projected: TomlProjectedLocation,
    index: number,
    role: 'TomlItem' | 'TomlEntry' | 'TomlKey' | 'TomlArrayElement',
    relation: TomlProvenanceRelation,
  ): void {
    this.#provenanceUnits += 1;
    if (this.#provenanceUnits > this.#limits.maxProvenanceEntries) {
      throw new TomlProjectionFailure('ResourceLimit', 'max_provenance_entries');
    }
    const origin = new TomlSourceOrigin(
      this.#document.snapshotIdentity(),
      this.#document.nodeRef(index, role),
      this.#document.entity(index).span,
      relation,
    );
    const existing = this.#provenance.find((entry) => projectedLocationEquals(entry.projected, projected));
    if (existing !== undefined) {
      existing.origins.push(origin);
    } else {
      this.#provenance.push({ projected, origins: [origin] });
    }
  }

  provenance(): TomlProvenanceMap {
    return TomlProvenanceMap.create(
      this.#provenance.map((entry) => new TomlProvenanceEntry(entry.projected, entry.origins)),
    );
  }
}

function projectedLocationEquals(
  left: TomlProjectedLocation,
  right: TomlProjectedLocation,
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
 * Applies an immutable explicit projection request (projection.rs:202-227).
 * Exact TOML projections always report fidelity Exact with an empty report.
 */
export function projectToml(
  document: TomlDocument,
  request: TomlProjectionRequest,
): TomlProjectionResult {
  const context = new ProjectionContext(document, request.limits());
  try {
    const value = projectItem(context, document.root().index(), ValuePath.root(), 0);
    return {
      kind: 'Complete',
      value: new TomlCompleteProjection(
        value,
        'Exact',
        new TomlProjectionReport([], request.limits()),
        context.provenance(),
      ),
    };
  } catch (failure) {
    if (!(failure instanceof TomlProjectionFailure)) {
      throw failure;
    }
    return {
      kind: 'Failed',
      value: new TomlFailedProjectionAttempt(
        [failureDiagnostic(document, failure)],
        new TomlProjectionReport([], request.limits()),
        [],
      ),
    };
  }
}

function projectItem(
  context: ProjectionContext,
  index: number,
  path: ValuePath,
  depth: number,
): PortableValue {
  context.enter(depth);
  const document = context.document();
  const item = document.itemEntity(index);
  let value: PortableValue;
  switch (item.kind) {
    case 'String':
      value = stringValue(item.value);
      break;
    case 'Integer':
      value = integerValue(item.value);
      break;
    case 'Float':
      value = binaryFloat64Value(item.bits);
      break;
    case 'Boolean':
      value = booleanValue(item.value);
      break;
    case 'DateTime':
      value = projectDateTime(item.value);
      break;
    case 'Array':
    case 'ArrayOfTables': {
      const items: PortableValue[] = [];
      for (const elementIndex of item.elements) {
        const element = document.entity(elementIndex).kind;
        if (element.role !== 'Element') {
          throw new Error('internal: typed TOML element');
        }
        const childPath = path.child({ kind: 'SequenceElement', index: BigInt(element.ordinal) });
        items.push(projectItem(context, element.item, childPath, depth + 1));
        context.addOrigin(
          { kind: 'Value', path: childPath },
          elementIndex,
          'TomlArrayElement',
          'Direct',
        );
      }
      value = sequenceValue(items);
      break;
    }
    case 'InlineTable':
    case 'Table': {
      const entries: ObjectEntry[] = [];
      for (const entryIndex of item.entries) {
        const entry = document.entity(entryIndex).kind;
        if (entry.role !== 'Entry') {
          throw new Error('internal: typed TOML entry');
        }
        const key = document.entity(entry.key).kind;
        if (key.role !== 'Key') {
          throw new Error('internal: typed TOML key');
        }
        const childPath = path.child({ kind: 'ObjectValue', name: key.name });
        const child = projectItem(context, entry.item, childPath, depth + 1);
        entries.push({ key: key.name, value: child });
        const ordinal = BigInt(entry.ordinal);
        context.addOrigin(
          { kind: 'Association', location: new AssociationLocation(path, ordinal, 'ObjectEntry') },
          entryIndex,
          'TomlEntry',
          'Direct',
        );
        context.addOrigin(
          { kind: 'Association', location: new AssociationLocation(path, ordinal, 'ObjectKey') },
          entry.key,
          'TomlKey',
          'Direct',
        );
      }
      try {
        value = objectValue(entries);
      } catch (error) {
        // A valid TOML table cannot duplicate a logical key (RFC 0001 §5);
        // reaching here violates the core unique-key invariant.
        throw new TomlProjectionFailure('CoreInvariant');
      }
      break;
    }
  }
  context.addOrigin({ kind: 'Value', path }, index, 'TomlItem', 'Direct');
  return value;
}

/** TOML date/time → PortableValue v1 (projection.rs:367-408). */
function projectDateTime(datetime: TomlDateTime): PortableValue {
  const { date, time, offset } = datetime;
  try {
    if (date !== null && time === null && offset === null) {
      return dateValue(BigInt(date.year), date.month, date.day);
    }
    if (date === null && time !== null && offset === null) {
      return timeValue(time.hour, time.minute, time.second, decimalValue(BigInt(time.nanosecond), -9n));
    }
    if (date !== null && time !== null && offset === null) {
      return localDateTimeValue(
        dateValue(BigInt(date.year), date.month, date.day),
        timeValue(time.hour, time.minute, time.second, decimalValue(BigInt(time.nanosecond), -9n)),
      );
    }
    if (date !== null && time !== null && offset !== null) {
      const offsetSeconds = offset.kind === 'Z' ? 0 : offset.minutes * 60;
      return offsetDateTimeValue(
        localDateTimeValue(
          dateValue(BigInt(date.year), date.month, date.day),
          timeValue(time.hour, time.minute, time.second, decimalValue(BigInt(time.nanosecond), -9n)),
        ),
        offsetSeconds,
      );
    }
  } catch {
    throw new TomlProjectionFailure('UnrepresentableDateTime');
  }
  throw new TomlProjectionFailure('UnrepresentableDateTime');
}

function failureDiagnostic(
  document: TomlDocument,
  failure: TomlProjectionFailure,
): Diagnostic {
  const code = failure.code;
  const category: 'Projection' | 'Resource' = failure.kind === 'ResourceLimit' ? 'Resource' : 'Projection';
  const primary =
    failure.kind === 'UnrepresentableDateTime'
      ? document.root().span().diagnosticLocation()
      : null;
  const entries: (readonly [string, string])[] =
    failure.limitName !== undefined ? [['limit', failure.limitName]] : [];
  return makeDiagnostic(code, category, 'Error', primary, 0n, { arguments: entries });
}
