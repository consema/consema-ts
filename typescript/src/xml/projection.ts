/**
 * XML projection targets and explicit mapping policies (RFC 0012 §9).
 *
 * authority: crates/consema-xml/src/projection.rs
 *  - ProjectionTarget :20-29 (ElementTreeV1 | TextContentV1 |
 *    SimpleEntryMappingV1), TextContentInclude :31-38, AttributePolicy
 *    :40-49, TextKeyPolicy :51-58, RepeatedChildPolicy :60-69,
 *    ExpandedNameKeyPolicy :71-81, CollisionPolicy :115-124
 *  - ProjectionRequest :126-213 (element_tree :141-155, simple_entry_mapping
 *    :157-178, text_content :180-194), ProjectionLimits :215-237
 *    (defaults :228-237), Fidelity :239-248, ProjectedLocation :250-257,
 *    ProvenanceRelation :259-270, SourceOrigin :272-283, ProvenanceEntry
 *    :285-292, ProvenanceMap :294-323, ProjectionEventKind :325-346,
 *    ProjectionEvent :348-357, ProjectionReport :359-388, CompleteProjection
 *    :390-401, FailedProjectionAttempt :403-410, ProjectionResult :412-419,
 *    ProjectionFailure :421-441, StableFailure :443-469
 *  - Document::project :471-503 (RecoveredDocument gate :475-478)
 *  - the projection context :505-573, project_element_tree :600-644,
 *    declaration_value :646-667, element_value :669-797, content_value
 *    :799-973, project_text_content :975-1007, collect_text :1009-1095,
 *    project_entry_mapping :1097-1126, entry_ordinal :1144-1200,
 *    commit_entry :1202-1236, map_children :1238-1402, leaf_value
 *    :1404-1457
 *  - frozen codes: crates/consema-xml/src/projection.rs:459-468
 *    (xml.projection.recovered-document@1, subtree@1, admission@1,
 *    collision@1, resource-limit@1, core-invariant@1)
 *  - the exact `xml.element-tree@1` record: projection.rs:600-644,
 *    669-797, 799-973 — declaration facts, admitted internal entity
 *    declarations, one namespace-aware root, ordered namespace
 *    declarations, ordered attributes, ordered mixed content, exact
 *    text/reference fragments, CDATA, comments, and PI
 *  - vector-pinned behavior: conformance/vectors/xml-1-0-safe-v1.json
 *    (xml.projection.element-tree-record, xml.projection.namespace-record,
 *    xml.projection.recovered-never-projects)
 *
 * Design (TypeScript-idiomatic): an immutable request; the projection
 * context walks the document once, collecting the complete value, fidelity,
 * report events, and provenance, or fails with a typed `ProjectionFailure`
 * — a failure never contains a partial value.
 */

import type { NodeRef, Span } from '../document/identity.ts';
import { AssociationLocation, ValuePath } from '../document/portable_locations.ts';
import type { ValuePathSegment } from '../document/portable_locations.ts';
import {
  booleanValue,
  entryMappingValue,
  nullValue,
  objectValue,
  sequenceValue,
  stringValue,
} from '../core/value.ts';
import type { EntryMappingEntry, ObjectEntry, PortableValue } from '../core/value.ts';
import { ProjectionFailure, projectionFailureCode } from './errors.ts';
import type { ProjectionFailureKind } from './errors.ts';
import { XmlDocument, textSemantic } from './document.ts';
import type { ReferenceFragment, XmlContent, XmlElementData, XmlTextData } from './document.ts';

// ---------------------------------------------------------------------------
// Targets and policies
// ---------------------------------------------------------------------------

/** Versioned XML projection target (projection.rs:20-29). */
export type ProjectionTarget =
  | 'ElementTreeV1'
  | 'TextContentV1'
  | 'SimpleEntryMappingV1';

/** Descendant text inclusion for `TextContentV1` (projection.rs:31-38). */
export type TextContentInclude = 'TextAndCdata' | 'TextOnly';

/** Attribute handling for `SimpleEntryMappingV1` (projection.rs:40-49). */
export type AttributePolicy = 'RejectAttributes' | 'IgnoreAttributes' | 'PrefixAttributeKeys';

/** Text child handling for `SimpleEntryMappingV1` (projection.rs:51-58). */
export type TextKeyPolicy = 'RejectText' | 'IgnoreText';

/** Repeated expanded-child-name handling for `SimpleEntryMappingV1` (projection.rs:60-69). */
export type RepeatedChildPolicy = 'Reject' | 'First' | 'Last';

/** Entry-key spelling for `SimpleEntryMappingV1` (projection.rs:71-81). */
export type ExpandedNameKeyPolicy = 'LocalOnly' | 'PrefixedSpelling' | 'UriBracketed';

/** Explicit mapping behavior for `SimpleEntryMappingV1` (projection.rs:115-124). */
export type CollisionPolicy = 'Reject' | 'First' | 'Last';

/** XML projection resource limits (projection.rs:215-226). */
export interface ProjectionLimits {
  /** Maximum inspected source nodes. */
  readonly maxSourceNodes: number;
  /** Maximum produced PortableValue nodes. */
  readonly maxValueNodes: number;
  /** Maximum report events. */
  readonly maxReportEntries: number;
  /** Maximum projected locations plus source origins. */
  readonly maxProvenanceUnits: number;
}

/** The frozen defaults (projection.rs:228-237). */
export const DEFAULT_PROJECTION_LIMITS: Readonly<ProjectionLimits> = Object.freeze({
  maxSourceNodes: 2_000_000,
  maxValueNodes: 2_000_000,
  maxReportEntries: 100_000,
  maxProvenanceUnits: 4_000_000,
});

/** Immutable explicit XML projection request; every policy is mandatory (projection.rs:126-138). */
export class ProjectionRequest {
  readonly #target: ProjectionTarget;
  readonly #subtree: number | null;
  readonly #include: TextContentInclude;
  readonly #attributes: AttributePolicy;
  readonly #textKey: TextKeyPolicy;
  readonly #repeatedChild: RepeatedChildPolicy;
  readonly #keySpelling: ExpandedNameKeyPolicy;
  readonly #collision: CollisionPolicy;
  readonly #limits: ProjectionLimits;

  /** @internal — construction is via the explicit request constructors below. */
  constructor(
    target: ProjectionTarget,
    subtree: number | null,
    include: TextContentInclude,
    attributes: AttributePolicy,
    textKey: TextKeyPolicy,
    repeatedChild: RepeatedChildPolicy,
    keySpelling: ExpandedNameKeyPolicy,
    collision: CollisionPolicy,
    limits: ProjectionLimits,
  ) {
    this.#target = target;
    this.#subtree = subtree;
    this.#include = include;
    this.#attributes = attributes;
    this.#textKey = textKey;
    this.#repeatedChild = repeatedChild;
    this.#keySpelling = keySpelling;
    this.#collision = collision;
    this.#limits = limits;
  }

  /** Exact `xml.element-tree@1` record request for the document root (projection.rs:141-155). */
  static elementTree(): ProjectionRequest {
    return new ProjectionRequest(
      'ElementTreeV1',
      null,
      'TextAndCdata',
      'RejectAttributes',
      'RejectText',
      'Reject',
      'LocalOnly',
      'Reject',
      DEFAULT_PROJECTION_LIMITS,
    );
  }

  /** Explicit `TextContentV1` request over one subtree (projection.rs:180-194). */
  static textContent(subtree: NodeRef, include: TextContentInclude): ProjectionRequest {
    return new ProjectionRequest(
      'TextContentV1',
      Number(subtree.index()),
      include,
      'RejectAttributes',
      'RejectText',
      'Reject',
      'LocalOnly',
      'Reject',
      DEFAULT_PROJECTION_LIMITS,
    );
  }

  /** Explicit `SimpleEntryMappingV1` request over one subtree (projection.rs:157-178). */
  static simpleEntryMapping(
    subtree: NodeRef,
    attributes: AttributePolicy,
    textKey: TextKeyPolicy,
    repeatedChild: RepeatedChildPolicy,
    keySpelling: ExpandedNameKeyPolicy,
    collision: CollisionPolicy,
  ): ProjectionRequest {
    return new ProjectionRequest(
      'SimpleEntryMappingV1',
      Number(subtree.index()),
      'TextAndCdata',
      attributes,
      textKey,
      repeatedChild,
      keySpelling,
      collision,
      DEFAULT_PROJECTION_LIMITS,
    );
  }

  /** Projection target (projection.rs:196-200). */
  target(): ProjectionTarget {
    return this.#target;
  }

  /** Selected subtree identity, when the request targets a subtree (projection.rs:202-206). */
  subtree(): number | null {
    return this.#subtree;
  }

  /** Resource limits (projection.rs:208-212). */
  limits(): ProjectionLimits {
    return this.#limits;
  }

  /** @internal */ includeInternal(): TextContentInclude {
    return this.#include;
  }

  /** @internal */ attributesInternal(): AttributePolicy {
    return this.#attributes;
  }

  /** @internal */ textKeyInternal(): TextKeyPolicy {
    return this.#textKey;
  }

  /** @internal */ repeatedChildInternal(): RepeatedChildPolicy {
    return this.#repeatedChild;
  }

  /** @internal */ keySpellingInternal(): ExpandedNameKeyPolicy {
    return this.#keySpelling;
  }

  /** @internal */ collisionInternal(): CollisionPolicy {
    return this.#collision;
  }
}

// ---------------------------------------------------------------------------
// Fidelity, provenance, and reports
// ---------------------------------------------------------------------------

/** Projection fidelity classification (projection.rs:239-248). */
export type Fidelity = 'Exact' | 'Transformed' | 'Lossy';

/** Projected value or association location (projection.rs:250-257). */
export type ProjectedLocation =
  | { readonly kind: 'Value'; readonly path: ValuePath }
  | { readonly kind: 'Association'; readonly location: AssociationLocation };

/** Source-to-projection relation (projection.rs:259-270). */
export type ProvenanceRelation = 'Direct' | 'Derived' | 'Collapsed' | 'ReferenceDerived';

/** One exact source origin (projection.rs:272-283). */
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

  /** Source document snapshot. */
  snapshot(): bigint {
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

/** One many-valued provenance entry (projection.rs:285-292). */
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

/** Immutable many-valued provenance mapping (projection.rs:294-299). */
export class ProvenanceMap {
  readonly #entries: readonly ProvenanceEntry[];

  /** @internal — construction is via `empty`/`append` and the context. */
  constructor(entries: readonly ProvenanceEntry[]) {
    this.#entries = Object.freeze([...entries]);
  }

  /** Creates an empty provenance map. */
  static empty(): ProvenanceMap {
    return new ProvenanceMap([]);
  }

  /** @internal — appends one entry under the configured limit (projection.rs:307-322). */
  static append(
    entries: readonly ProvenanceEntry[],
    entry: ProvenanceEntry,
    limits: ProjectionLimits,
  ): readonly ProvenanceEntry[] {
    if (entries.length + 1 > limits.maxProvenanceUnits) {
      throw new ProjectionFailure('ResourceLimit', { limitName: 'max_provenance_units' });
    }
    return entries.concat([entry]);
  }

  /** Deterministically ordered projected locations and origins (projection.rs:300-306). */
  entries(): readonly ProvenanceEntry[] {
    return this.#entries;
  }
}

/** Projection report category (projection.rs:325-346). */
export type ProjectionEventKind =
  | 'ElementDiscarded'
  | 'AttributeDiscarded'
  | 'TextDiscarded'
  | 'CdataDiscarded'
  | 'CommentDiscarded'
  | 'ProcessingInstructionDiscarded'
  | 'ReferenceCollapsed'
  | 'ChildCollapsed'
  | 'NamespaceCollapsed';

/** One explicit transformation event (projection.rs:348-357). */
export class ProjectionEvent {
  readonly #kind: ProjectionEventKind;
  readonly #discarded: NodeRef;
  readonly #impact: Fidelity;

  constructor(kind: ProjectionEventKind, discarded: NodeRef, impact: Fidelity) {
    this.#kind = kind;
    this.#discarded = discarded;
    this.#impact = impact;
  }

  /** Stable event kind. */
  kind(): ProjectionEventKind {
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

/** Complete ordered projection report (projection.rs:359-364). */
export class ProjectionReport {
  readonly #events: readonly ProjectionEvent[];

  /** @internal — construction is via `empty`/`append` and the context. */
  constructor(events: readonly ProjectionEvent[]) {
    this.#events = Object.freeze([...events]);
  }

  /** Creates an empty report. */
  static empty(): ProjectionReport {
    return new ProjectionReport([]);
  }

  /** @internal — appends one event under the configured limit (projection.rs:372-387). */
  static append(
    events: readonly ProjectionEvent[],
    event: ProjectionEvent,
    limits: ProjectionLimits,
  ): readonly ProjectionEvent[] {
    if (events.length + 1 > limits.maxReportEntries) {
      throw new ProjectionFailure('ResourceLimit', { limitName: 'max_report_entries' });
    }
    return events.concat([event]);
  }

  /** Events in deterministic document order (projection.rs:365-371). */
  events(): readonly ProjectionEvent[] {
    return this.#events;
  }
}

/** Complete successful projection (projection.rs:390-401). */
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

/** Failed projection attempt without a partial value (projection.rs:403-410). */
export class FailedProjectionAttempt {
  readonly #failure: ProjectionFailure;
  readonly #report: ProjectionReport;

  constructor(failure: ProjectionFailure, report: ProjectionReport) {
    this.#failure = failure;
    this.#report = report;
  }

  /** Stable failure. */
  failure(): ProjectionFailure {
    return this.#failure;
  }

  /** Empty report: failed projections publish no partial transformation result. */
  report(): ProjectionReport {
    return this.#report;
  }
}

/** Projection completion algebra (projection.rs:412-419). */
export type ProjectionResult =
  | { readonly kind: 'Complete'; readonly projection: CompleteProjection }
  | { readonly kind: 'Failed'; readonly attempt: FailedProjectionAttempt };

// ---------------------------------------------------------------------------
// Entry mapping internals
// ---------------------------------------------------------------------------

/** Collision resolution direction shared by both entry policies (projection.rs:83-89). */
type KeepPolicy = 'Reject' | 'First' | 'Last';

/** Ordered mapping entries with their expanded-name identities (projection.rs:91-113). */
class EntrySet {
  readonly ordered: { key: string; value: PortableValue }[] = [];
  readonly seen = new Map<string, { ordinal: number; expanded: ExpandedNameFact | null }>();

  intoOrdered(): { key: string; value: PortableValue }[] {
    return this.ordered;
  }
}

/** One retained expanded-name fact for repeated-child detection. */
interface ExpandedNameFact {
  readonly namespace: string | null;
  readonly local: string;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/** Projects one immutable snapshot under one explicit target and policy contract (projection.rs:471-503). */
export function project(document: XmlDocument, request: ProjectionRequest): ProjectionResult {
  if (document.formationStatus() !== 'Complete') {
    return failed(new ProjectionFailure('RecoveredDocument'));
  }
  const context = new ProjectionContext(document, request.limits());
  try {
    let value: PortableValue;
    let fidelity: Fidelity;
    switch (request.target()) {
      case 'ElementTreeV1':
        ({ value, fidelity } = context.projectElementTree());
        break;
      case 'TextContentV1':
        ({ value, fidelity } = context.projectTextContent(request));
        break;
      case 'SimpleEntryMappingV1':
        ({ value, fidelity } = context.projectEntryMapping(request));
        break;
    }
    return {
      kind: 'Complete',
      projection: new CompleteProjection(
        value,
        fidelity,
        context.report(),
        context.provenance(),
      ),
    };
  } catch (error) {
    if (error instanceof ProjectionFailure) {
      return failed(error);
    }
    throw error;
  }
}

/** Builds a failed attempt with its stable diagnostic (projection.rs:1460-1475). */
function failed(failure: ProjectionFailure): ProjectionResult {
  return {
    kind: 'Failed',
    attempt: new FailedProjectionAttempt(failure, ProjectionReport.empty()),
  };
}

class ProjectionContext {
  readonly #document: XmlDocument;
  readonly #limits: ProjectionLimits;
  #events: readonly ProjectionEvent[] = [];
  #provenance: readonly ProvenanceEntry[] = [];
  #sourceNodes = 0;
  #valueNodes = 0;

  constructor(document: XmlDocument, limits: ProjectionLimits) {
    this.#document = document;
    this.#limits = limits;
  }

  report(): ProjectionReport {
    return new ProjectionReport(this.#events);
  }

  provenance(): ProvenanceMap {
    return new ProvenanceMap(this.#provenance);
  }

  #step(): void {
    this.#sourceNodes += 1;
    if (this.#sourceNodes > this.#limits.maxSourceNodes) {
      throw new ProjectionFailure('ResourceLimit', { limitName: 'max_source_nodes' });
    }
  }

  #reserveValue(count: number): void {
    this.#valueNodes += count;
    if (this.#valueNodes > this.#limits.maxValueNodes) {
      throw new ProjectionFailure('ResourceLimit', { limitName: 'max_value_nodes' });
    }
  }

  #event(kind: ProjectionEventKind, discarded: NodeRef, impact: Fidelity): void {
    this.#events = ProjectionReport.append(
      this.#events,
      new ProjectionEvent(kind, discarded, impact),
      this.#limits,
    );
  }

  #origin(
    projected: ProjectedLocation,
    node: NodeRef,
    span: Span,
    relation: ProvenanceRelation,
  ): void {
    this.#provenance = ProvenanceMap.append(
      this.#provenance,
      new ProvenanceEntry(projected, [
        new SourceOrigin(this.#document.snapshotIdentity().asBigInt(), node, span, relation),
      ]),
      this.#limits,
    );
  }

  /** Exact `xml.element-tree@1` record for the document root (projection.rs:600-644). */
  projectElementTree(): { value: PortableValue; fidelity: Fidelity } {
    const root = this.#document.root();
    if (root === null) {
      throw new ProjectionFailure('MappingAdmission', { reason: 'missing root' });
    }
    const entries: ObjectEntry[] = [
      { key: 'record', value: stringValue('xml.element-tree@1') },
    ];
    const declared = this.#document.declaration();
    if (declared !== null) {
      const declarationEntries: ObjectEntry[] = [
        { key: 'version', value: stringValue(declared.version) },
      ];
      if (declared.encoding !== null) {
        declarationEntries.push({ key: 'encoding', value: stringValue(declared.encoding.value) });
      }
      if (declared.standalone !== null) {
        declarationEntries.push({
          key: 'standalone',
          value: booleanValue(declared.standalone.value),
        });
      }
      entries.push({ key: 'declaration', value: objectValue(declarationEntries) });
    }
    const doctype = this.#document.doctype();
    if (doctype !== null && doctype.entities.length > 0) {
      const entityList: PortableValue[] = doctype.entities.map((entity) => {
        return objectValue([
          { key: 'name', value: stringValue(entity.name) },
          { key: 'replacement', value: stringValue(entity.replacement) },
        ]);
      });
      entries.push({ key: 'entities', value: sequenceValue(entityList) });
    }
    const rootPath = ValuePath.root().child({ kind: 'ObjectValue', name: 'root' });
    const { value: rootValue } = this.#elementValue(root.rawIndex(), rootPath);
    entries.push({ key: 'root', value: rootValue });
    return { value: objectValue(entries), fidelity: 'Exact' };
  }

  /** Recursive element record; `path` is the location of this element record (projection.rs:669-797). */
  #elementValue(index: number, path: ValuePath): { value: PortableValue; index: number } {
    this.#step();
    const data = this.#elementData(index);
    const span = data.span;
    const entries: ObjectEntry[] = [];
    const [namespace, local] = expandedNameParts(data);
    entries.push({
      key: 'expanded-name',
      value: objectValue([
        { key: 'namespace', value: namespace === null ? nullValue() : stringValue(namespace) },
        { key: 'local', value: stringValue(local) },
      ]),
    });
    if (data.namespaces.length > 0) {
      const list: PortableValue[] = [];
      for (let item = 0; item < data.namespaces.length; item++) {
        const binding = data.namespaces[item];
        list.push(
          objectValue([
            {
              key: 'prefix',
              value: binding.prefix === null ? nullValue() : stringValue(binding.prefix),
            },
            { key: 'uri', value: stringValue(binding.uri) },
          ]),
        );
        this.#origin(
          { kind: 'Value', path: itemPath(path, 'namespaces', item) },
          this.#document.occurrenceNodeRef(binding.ordinal, 'XmlNamespaceBinding'),
          binding.span,
          'Direct',
        );
      }
      entries.push({ key: 'namespaces', value: sequenceValue(list) });
    }
    if (data.attributes.length > 0) {
      const list: PortableValue[] = [];
      for (let item = 0; item < data.attributes.length; item++) {
        const attribute = data.attributes[item];
        const [attrNamespace, attrLocal] = expandedNameParts(attribute);
        list.push(
          objectValue([
            {
              key: 'expanded-name',
              value: objectValue([
                {
                  key: 'namespace',
                  value: attrNamespace === null ? nullValue() : stringValue(attrNamespace),
                },
                { key: 'local', value: stringValue(attrLocal) },
              ]),
            },
            { key: 'value', value: stringValue(attribute.normalizedValue) },
          ]),
        );
        this.#origin(
          { kind: 'Value', path: itemPath(path, 'attributes', item) },
          this.#document.occurrenceNodeRef(attribute.ordinal, 'XmlAttribute'),
          attribute.span,
          'Direct',
        );
      }
      entries.push({ key: 'attributes', value: sequenceValue(list) });
    }
    if (data.children.length > 0) {
      const list: PortableValue[] = [];
      for (let item = 0; item < data.children.length; item++) {
        const { value } = this.#contentValue(data.children[item], itemPath(path, 'content', item));
        list.push(value);
      }
      entries.push({ key: 'content', value: sequenceValue(list) });
    }
    this.#reserveValue(1);
    this.#origin(
      { kind: 'Value', path },
      this.#document.nodeRefFor(index, 'XmlElement'),
      span,
      'Direct',
    );
    return { value: objectValue(entries), index };
  }

  /** One ordered content item record (projection.rs:799-973). */
  #contentValue(index: number, path: ValuePath): { value: PortableValue; index: number } {
    this.#step();
    const node = this.#document.nodeAt(index);
    switch (node.kind) {
      case 'Element':
        return this.#elementValue(index, path);
      case 'Text': {
        const fragments: PortableValue[] = [];
        for (let item = 0; item < node.data.fragments.length; item++) {
          const fragment = node.data.fragments[item];
          fragments.push(fragmentRecord(fragment));
          this.#origin(
            { kind: 'Value', path: itemPath(path, 'fragments', item) },
            this.#document.occurrenceNodeRef(node.data.ordinal, 'XmlEntityReference'),
            fragment.span,
            'ReferenceDerived',
          );
        }
        const value = objectValue([
          { key: 'kind', value: stringValue('text') },
          { key: 'fragments', value: sequenceValue(fragments) },
        ]);
        this.#reserveValue(1);
        this.#origin(
          { kind: 'Value', path },
          this.#document.occurrenceNodeRef(node.data.ordinal, 'XmlText'),
          node.data.span,
          'Direct',
        );
        return { value, index };
      }
      case 'Cdata': {
        const value = objectValue([
          { key: 'kind', value: stringValue('cdata') },
          { key: 'text', value: stringValue(node.data.text) },
        ]);
        this.#reserveValue(1);
        this.#origin(
          { kind: 'Value', path },
          this.#document.occurrenceNodeRef(node.data.ordinal, 'XmlCdata'),
          node.data.span,
          'Direct',
        );
        return { value, index };
      }
      case 'Comment': {
        const value = objectValue([
          { key: 'kind', value: stringValue('comment') },
          { key: 'text', value: stringValue(node.data.text) },
        ]);
        this.#reserveValue(1);
        this.#origin(
          { kind: 'Value', path },
          this.#document.occurrenceNodeRef(node.data.ordinal, 'XmlComment'),
          node.data.span,
          'Direct',
        );
        return { value, index };
      }
      case 'ProcessingInstruction': {
        const entries: ObjectEntry[] = [
          { key: 'kind', value: stringValue('processing-instruction') },
          { key: 'target', value: stringValue(node.data.target) },
        ];
        if (node.data.content !== null) {
          entries.push({ key: 'content', value: stringValue(node.data.content.text) });
        }
        const value = objectValue(entries);
        this.#reserveValue(1);
        this.#origin(
          { kind: 'Value', path },
          this.#document.occurrenceNodeRef(node.data.ordinal, 'XmlProcessingInstruction'),
          node.data.span,
          'Direct',
        );
        return { value, index };
      }
      case 'ErrorRegion': {
        const value = objectValue([{ key: 'kind', value: stringValue('error-region') }]);
        this.#reserveValue(1);
        this.#origin(
          { kind: 'Value', path },
          this.#document.occurrenceNodeRef(node.data.ordinal, 'XmlErrorRegion'),
          node.data.span,
          'Direct',
        );
        return { value, index };
      }
    }
  }

  /** Always-transformed descendant text content (projection.rs:975-1007). */
  projectTextContent(request: ProjectionRequest): { value: PortableValue; fidelity: Fidelity } {
    const root = this.#document.root();
    if (root === null) {
      throw new ProjectionFailure('MappingAdmission', { reason: 'missing root' });
    }
    const start = request.subtree() ?? root.rawIndex();
    const node = this.#document.nodeAt(start);
    if (node.kind !== 'Element') {
      throw new ProjectionFailure('SubtreeNotElement');
    }
    const out = this.#collectText(start, request.includeInternal());
    this.#reserveValue(1);
    this.#origin(
      { kind: 'Value', path: ValuePath.root() },
      this.#document.nodeRefFor(start, 'XmlElement'),
      node.data.span,
      'Derived',
    );
    return { value: stringValue(out), fidelity: 'Transformed' };
  }

  /** Descendant text collection with discard events (projection.rs:1009-1095). */
  #collectText(index: number, include: TextContentInclude): string {
    const data = this.#elementData(index);
    let out = '';
    for (const child of data.children) {
      const node = this.#document.nodeAt(child);
      switch (node.kind) {
        case 'Element': {
          this.#event('ElementDiscarded', this.#document.nodeRefFor(child, 'XmlElement'), 'Transformed');
          for (const attribute of node.data.attributes) {
            this.#event(
              'AttributeDiscarded',
              this.#document.occurrenceNodeRef(attribute.ordinal, 'XmlAttribute'),
              'Transformed',
            );
          }
          out += this.#collectText(child, include);
          break;
        }
        case 'Text': {
          for (const fragment of node.data.fragments) {
            if (fragment.kind !== 'Literal') {
              this.#event(
                'ReferenceCollapsed',
                this.#document.occurrenceNodeRef(node.data.ordinal, 'XmlEntityReference'),
                'Transformed',
              );
            }
          }
          out += textSemantic(node.data);
          break;
        }
        case 'Cdata':
          if (include === 'TextAndCdata') {
            out += node.data.text;
          } else {
            this.#event(
              'CdataDiscarded',
              this.#document.occurrenceNodeRef(node.data.ordinal, 'XmlCdata'),
              'Transformed',
            );
          }
          break;
        case 'Comment':
          this.#event(
            'CommentDiscarded',
            this.#document.occurrenceNodeRef(node.data.ordinal, 'XmlComment'),
            'Transformed',
          );
          break;
        case 'ProcessingInstruction':
          this.#event(
            'ProcessingInstructionDiscarded',
            this.#document.occurrenceNodeRef(node.data.ordinal, 'XmlProcessingInstruction'),
            'Transformed',
          );
          break;
        case 'ErrorRegion':
          break;
      }
    }
    return out;
  }

  /** Explicit-policy entry mapping of one selected subtree (projection.rs:1097-1126). */
  projectEntryMapping(request: ProjectionRequest): { value: PortableValue; fidelity: Fidelity } {
    const root = this.#document.root();
    if (root === null) {
      throw new ProjectionFailure('MappingAdmission', { reason: 'missing root' });
    }
    const start = request.subtree() ?? root.rawIndex();
    const node = this.#document.nodeAt(start);
    if (node.kind !== 'Element') {
      throw new ProjectionFailure('SubtreeNotElement');
    }
    const entries = new EntrySet();
    this.#mapChildren(start, ValuePath.root(), entries, request);
    const mapping = entryMappingValue(
      entries.intoOrdered().map((entry) => {
        return { key: stringValue(entry.key), value: entry.value };
      }),
    );
    this.#reserveValue(1);
    return { value: mapping, fidelity: 'Transformed' };
  }

  /** Maps one element's children into the ordered entry set (projection.rs:1238-1402). */
  #mapChildren(
    element: number,
    container: ValuePath,
    entries: EntrySet,
    request: ProjectionRequest,
  ): void {
    const data = this.#elementData(element);
    if (data.namespaces.length > 0) {
      throw new ProjectionFailure('MappingAdmission', {
        reason: 'namespace declarations on the mapped element',
      });
    }
    for (const attribute of data.attributes) {
      const origin = this.#document.occurrenceNodeRef(attribute.ordinal, 'XmlAttribute');
      switch (request.attributesInternal()) {
        case 'RejectAttributes':
          throw new ProjectionFailure('MappingAdmission', {
            reason: 'attributes present under RejectAttributes',
          });
        case 'IgnoreAttributes':
          this.#event('AttributeDiscarded', origin, 'Transformed');
          continue;
        case 'PrefixAttributeKeys':
          break;
      }
      const key = `@${attribute.qname.local}`;
      const ordinal = this.#entryOrdinal(
        entries,
        key,
        null,
        request,
        origin,
        'AttributeDiscarded',
      );
      this.#commitEntry(
        entries,
        key,
        stringValue(attribute.normalizedValue),
        ordinal,
        { node: origin, span: attribute.span },
        container,
      );
    }
    for (const child of data.children) {
      const childNode = this.#document.nodeAt(child);
      if (childNode.kind !== 'Element') {
        const origin = this.#document.nodeRefFor(child, childRole(childNode));
        switch (childNode.kind) {
          case 'Text':
            if (request.textKeyInternal() === 'RejectText') {
              if (textSemantic(childNode.data).trim().length > 0) {
                throw new ProjectionFailure('MappingAdmission', {
                  reason: 'text content under RejectText',
                });
              }
              // Whitespace-only text is admitted and silently ignored.
            } else {
              this.#event('TextDiscarded', origin, 'Transformed');
            }
            break;
          case 'Cdata':
            if (request.textKeyInternal() === 'RejectText') {
              throw new ProjectionFailure('MappingAdmission', {
                reason: 'CDATA content under RejectText',
              });
            }
            this.#event('CdataDiscarded', origin, 'Transformed');
            break;
          case 'Comment':
            this.#event('CommentDiscarded', origin, 'Transformed');
            break;
          case 'ProcessingInstruction':
            this.#event('ProcessingInstructionDiscarded', origin, 'Transformed');
            break;
          case 'ErrorRegion':
            break;
        }
        continue;
      }
      const [namespace, local] = expandedNameParts(childNode.data);
      const key = entryKeyFor(childNode.data, request.keySpellingInternal(), namespace, local);
      const origin = this.#document.nodeRefFor(child, 'XmlElement');
      const ordinal = this.#entryOrdinal(
        entries,
        key,
        childNode.data.expanded,
        request,
        origin,
        'ChildCollapsed',
      );
      const hasElementChildren = childNode.data.children.some((grandchild) => {
        return this.#document.nodeAt(grandchild).kind === 'Element';
      });
      const childValue = hasElementChildren
        ? (() => {
            const nestedContainer = container.child({ kind: 'EntryValue', index: BigInt(ordinal) });
            const nested = new EntrySet();
            this.#mapChildren(child, nestedContainer, nested, request);
            return entryMappingValue(
              nested.intoOrdered().map((entry) => {
                return { key: stringValue(entry.key), value: entry.value };
              }),
            );
          })()
        : this.#leafValue(child, request);
      this.#commitEntry(
        entries,
        key,
        childValue,
        ordinal,
        { node: origin, span: childNode.data.span },
        container,
      );
    }
  }

  /** The leaf value of one element without element children (projection.rs:1404-1457). */
  #leafValue(element: number, request: ProjectionRequest): PortableValue {
    const data = this.#elementData(element);
    let text = '';
    for (const child of data.children) {
      const node = this.#document.nodeAt(child);
      switch (node.kind) {
        case 'Text':
          text += textSemantic(node.data);
          break;
        case 'Cdata':
          if (request.textKeyInternal() === 'RejectText') {
            throw new ProjectionFailure('MappingAdmission', {
              reason: 'CDATA content under RejectText',
            });
          }
          this.#event(
            'CdataDiscarded',
            this.#document.occurrenceNodeRef(node.data.ordinal, 'XmlCdata'),
            'Transformed',
          );
          break;
        case 'Comment':
          this.#event(
            'CommentDiscarded',
            this.#document.occurrenceNodeRef(node.data.ordinal, 'XmlComment'),
            'Transformed',
          );
          break;
        case 'ProcessingInstruction':
          this.#event(
            'ProcessingInstructionDiscarded',
            this.#document.occurrenceNodeRef(node.data.ordinal, 'XmlProcessingInstruction'),
            'Transformed',
          );
          break;
        case 'Element':
        case 'ErrorRegion':
          break;
      }
    }
    return stringValue(text);
  }

  /** Resolves the entry ordinal under the explicit request policies (projection.rs:1144-1200). */
  #entryOrdinal(
    entries: EntrySet,
    key: string,
    candidate: ExpandedNameFact | null,
    request: ProjectionRequest,
    origin: NodeRef,
    collapse: ProjectionEventKind,
  ): number {
    const keepRepeated = request.repeatedChildInternal();
    const keepCollision = request.collisionInternal();
    const existing = entries.seen.get(key);
    if (existing === undefined) {
      const ordinal = entries.ordered.length;
      entries.seen.set(key, { ordinal, expanded: candidate });
      return ordinal;
    }
    // A repeated *expanded name* is governed by `repeated_child`; a key
    // collision after key spelling (distinct expanded names folding to one
    // key, or an attribute key meeting an existing key) is governed by
    // `collision` (projection.rs:1144-1200).
    const repeated =
      existing.expanded !== null &&
      candidate !== null &&
      existing.expanded.namespace === candidate.namespace &&
      existing.expanded.local === candidate.local;
    const keep: KeepPolicy = repeated ? keepRepeated : keepCollision;
    switch (keep) {
      case 'Reject':
        throw new ProjectionFailure('Collision', { child: origin, key });
      case 'First':
      case 'Last': {
        const eventKind = repeated ? collapse : 'NamespaceCollapsed';
        this.#event(eventKind, origin, 'Transformed');
        return existing.ordinal;
      }
    }
  }

  /** Records one committed entry and its value/association provenance (projection.rs:1202-1236). */
  #commitEntry(
    entries: EntrySet,
    key: string,
    value: PortableValue,
    ordinal: number,
    source: { node: NodeRef; span: Span },
    container: ValuePath,
  ): void {
    if (entries.ordered[ordinal] !== undefined) {
      entries.ordered[ordinal] = { key, value };
    } else {
      entries.ordered.push({ key, value });
    }
    this.#reserveValue(1);
    this.#origin(
      {
        kind: 'Association',
        location: new AssociationLocation(container, BigInt(ordinal), 'ObjectEntry'),
      },
      source.node,
      source.span,
      'Direct',
    );
    this.#origin(
      {
        kind: 'Value',
        path: container.child({ kind: 'EntryValue', index: BigInt(ordinal) }),
      },
      source.node,
      source.span,
      'Direct',
    );
  }

  #elementData(index: number): XmlElementData {
    const node = this.#document.nodeAt(index);
    if (node.kind !== 'Element') {
      throw new ProjectionFailure('CoreInvariant');
    }
    return node.data;
  }
}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

/** Value path of one item inside an ordered record array (projection.rs:593-598). */
function itemPath(container: ValuePath, field: string, index: number): ValuePath {
  return container
    .child({ kind: 'ObjectValue', name: field })
    .child({ kind: 'SequenceElement', index: BigInt(index) });
}

/** Expanded name parts of one element or attribute (projection.rs:683-689, 735-741). */
function expandedNameParts(data: {
  readonly expanded: { readonly namespace: string | null; readonly local: string } | null;
  readonly qname: { readonly local: string };
}): [string | null, string] {
  return data.expanded === null
    ? [null, data.qname.local]
    : [data.expanded.namespace, data.expanded.local];
}

/** One fragment record (projection.rs:814-877). */
function fragmentRecord(fragment: ReferenceFragment): PortableValue {
  switch (fragment.kind) {
    case 'Literal':
      return objectValue([
        { key: 'kind', value: stringValue('literal') },
        { key: 'text', value: stringValue(fragment.text) },
      ]);
    case 'CharacterReference':
      return objectValue([
        { key: 'kind', value: stringValue('character-reference') },
        { key: 'resolved', value: stringValue(fragment.resolved) },
      ]);
    case 'PredefinedEntity':
      return objectValue([
        { key: 'kind', value: stringValue('predefined-entity') },
        { key: 'name', value: stringValue(fragment.name) },
        { key: 'resolved', value: stringValue(fragment.resolved) },
      ]);
    case 'GeneralEntity':
      return objectValue([
        { key: 'kind', value: stringValue('general-entity') },
        { key: 'name', value: stringValue(fragment.name) },
        { key: 'resolved', value: stringValue(fragment.resolved) },
      ]);
  }
}

function childRole(
  node: XmlContent,
): 'XmlElement' | 'XmlText' | 'XmlCdata' | 'XmlComment' | 'XmlProcessingInstruction' | 'XmlErrorRegion' {
  switch (node.kind) {
    case 'Element':
      return 'XmlElement';
    case 'Text':
      return 'XmlText';
    case 'Cdata':
      return 'XmlCdata';
    case 'Comment':
      return 'XmlComment';
    case 'ProcessingInstruction':
      return 'XmlProcessingInstruction';
    case 'ErrorRegion':
      return 'XmlErrorRegion';
  }
}

/** Entry-key spelling under the explicit key policy (projection.rs:1301-1307). */
function entryKeyFor(
  data: XmlElementData,
  policy: ExpandedNameKeyPolicy,
  namespace: string | null,
  local: string,
): string {
  switch (policy) {
    case 'LocalOnly':
      return local;
    case 'PrefixedSpelling':
      return data.qname.prefix === null ? data.qname.local : `${data.qname.prefix}:${data.qname.local}`;
    case 'UriBracketed':
      return `{${namespace ?? ''}}${local}`;
  }
}

/** Kind鈫抍ode mapping helper for stable failure externalization. */
export { projectionFailureCode };
export type { ProjectionFailureKind };

