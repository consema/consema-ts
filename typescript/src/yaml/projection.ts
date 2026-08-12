/**
 * Exact graph and PortableValue projection with complete provenance.
 *
 * authority: crates/consema-yaml/src/projection.rs
 *  - GraphProjectionLimits :17-33 (graph limits + max_provenance_entries
 *    2_000_000), GraphProjectionRequest :35-62, GraphProjectedLocation
 *    :64-92, ProvenanceRelation :94-105 (Direct | Reference | Expanded |
 *    TagStripped), SourceOrigin :107-118, GraphProvenanceEntry :120-127,
 *    GraphProvenanceMap :129-141, CompleteGraphProjection :143-150,
 *    GraphProjectionFailure :152-170, codes :174-183
 *  - SharingPolicy :204-211, TagPolicy :213-220, MappingPolicy :222-231,
 *    ValueProjectionLimits :233-258 (1M nodes, depth 256, 100k report,
 *    2M provenance, amplification 16), ValueProjectionRequest :260-332
 *    (best_exact_v1 :270-279 — Reject / RequireKnownPortableTag /
 *    BestExactObjectOrEntryMapping), Fidelity :334-343,
 *    ProjectedLocation :345-352, ProvenanceEntry :354-361,
 *    ProvenanceMap :363-375, ProjectionEventKind :377-384,
 *    ProjectionEvent :386-405, ProjectionReport :407-419,
 *    CompleteValueProjection :421-432, ValueProjectionFailure :434-476,
 *    codes :480-497
 *  - Document::project_graph_with_provenance :531-554, project_value
 *    :556-603 (amplification :586-592), GraphProvenanceBuilder :605-754
 *    (Root/Node/SequenceElement/MappingKey/MappingValue origins with
 *    Reference alias origins :662-664, :697-699), ValueContext :756-1147
 *    (cycle stack :787-789, sharing reject :790-792, duplication events
 *    :793-804, tag stripping :808-826, scalar lowering :972-1021,
 *    mapping object selection :877-937, object key visits :939-970,
 *    amplification :586-592, provenance units :1105-1139)
 *  - project_scalar :972-1021 (null/bool/int/float with the four frozen
 *    binary64 bit patterns :995-1003, string, binary, timestamp,
 *    custom/tagged → decoded string)
 *  - project_timestamp :1230-1269, decode_base64 :1191-1217,
 *    object_names :1149-1170 (unique str keys only)
 *  - vector-pinned behavior: conformance/vectors/yaml-v1.json
 *    (projection.sharing-policy :71-74, projection.cycle :76-79,
 *    projection.tag-policy :81-84, projection.mapping-policy :86-89,
 *    projection.graph-provenance :91-94, resource.graph-provenance
 *    :131-134, graph.shared-cycle :46-49)
 *
 * Design (TypeScript-idiomatic): projection functions are pure over one
 * immutable YamlDocument; failures throw the typed GraphProjectionFailure
 * or ValueProjectionFailure with frozen codes. Alias edges are provenance
 * `Reference` origins and are never expanded (RFC 0007 §10).
 */

import type { NodeRef, Span } from '../document/identity.ts';
import { AssociationLocation, ValuePath } from '../document/portable_locations.ts';
import {
  booleanValue,
  bytesValue,
  dateValue,
  decimalValue,
  entryMappingValue,
  integerValue,
  nullValue,
  objectValue,
  offsetDateTimeValue,
  sequenceValue,
  stringValue,
  timeValue,
  localDateTimeValue,
} from '../core/value.ts';
import type { PortableValue } from '../core/value.ts';
import { Builder, defaultLimits } from '../graph/graph.ts';
import type { Graph, Limits, NodeID } from '../graph/graph.ts';
import { GraphError } from '../graph/errors.ts';
import { GraphProjectionFailure, ValueProjectionFailure } from './errors.ts';
import type { YamlDocument, InternalMappingEntry } from './document.ts';
import { decodeBase64, TAG_BINARY, TAG_BOOL, TAG_FLOAT, TAG_INT, TAG_MAP, TAG_NULL, TAG_SEQ, TAG_STR, TAG_TIMESTAMP } from './scalar.ts';
import type { YamlScalarKind } from './semantic.ts';

// ---------------------------------------------------------------------------
// Graph projection
// ---------------------------------------------------------------------------

/** Graph projection resource contract (projection.rs:17-33). */
export interface GraphProjectionLimits {
  /** PortableGraph construction and traversal limits. */
  readonly graph: Limits;
  /** Maximum projected-location plus origin records. */
  readonly maxProvenanceEntries: number;
}

/** The frozen defaults (projection.rs:26-32). */
export function defaultGraphProjectionLimits(): GraphProjectionLimits {
  return {
    graph: defaultLimits(),
    maxProvenanceEntries: 2_000_000,
  };
}

/** Immutable `yaml.projection.best-exact-graph@1` request (projection.rs:35-62). */
export class GraphProjectionRequest {
  readonly #limits: GraphProjectionLimits;

  private constructor(limits: GraphProjectionLimits) {
    this.#limits = limits;
  }

  /** Creates the frozen exact graph request with default limits (projection.rs:43-48). */
  static bestExactV1(): GraphProjectionRequest {
    return new GraphProjectionRequest(defaultGraphProjectionLimits());
  }

  /** Replaces all graph projection limits (projection.rs:50-55). */
  withLimits(limits: GraphProjectionLimits): GraphProjectionRequest {
    return new GraphProjectionRequest(limits);
  }

  /** Exact limits used by the request (projection.rs:57-61). */
  limits(): GraphProjectionLimits {
    return this.#limits;
  }
}

/** One exact projected graph location (projection.rs:64-92). */
export type GraphProjectedLocation =
  | { readonly kind: 'Root'; readonly ordinal: bigint }
  | { readonly kind: 'Node'; readonly node: NodeID }
  | {
      readonly kind: 'SequenceElement';
      readonly parent: NodeID;
      readonly ordinal: bigint;
    }
  | {
      readonly kind: 'MappingKey';
      readonly parent: NodeID;
      readonly ordinal: bigint;
    }
  | {
      readonly kind: 'MappingValue';
      readonly parent: NodeID;
      readonly ordinal: bigint;
    };

/** Source relation shared by graph and tree projection provenance (projection.rs:94-105). */
export type ProvenanceRelation = 'Direct' | 'Reference' | 'Expanded' | 'TagStripped';

/** One exact YAML source origin (projection.rs:107-118). */
export interface SourceOrigin {
  /** Owning source snapshot identity. */
  readonly snapshot: bigint;
  /** Exact structural identity. */
  readonly node: NodeRef;
  /** Exact raw source span. */
  readonly span: Span;
  /** Source-to-result relation. */
  readonly relation: ProvenanceRelation;
}

/** One graph provenance multimap entry (projection.rs:120-127). */
export interface GraphProvenanceEntry {
  /** Projected graph location. */
  readonly projected: GraphProjectedLocation;
  /** One or more exact YAML origins. */
  readonly origins: readonly SourceOrigin[];
}

/** Complete deterministic graph provenance multimap (projection.rs:129-141). */
export class GraphProvenanceMap {
  readonly #entries: readonly GraphProvenanceEntry[];

  private constructor(entries: readonly GraphProvenanceEntry[]) {
    this.#entries = Object.freeze([...entries]);
  }

  static create(entries: readonly GraphProvenanceEntry[]): GraphProvenanceMap {
    return new GraphProvenanceMap(entries);
  }

  /** Entries in root/node/association construction order (projection.rs:136-140). */
  entries(): readonly GraphProvenanceEntry[] {
    return this.#entries;
  }
}

/** Complete exact graph projection (projection.rs:143-150). */
export interface CompleteGraphProjection {
  /** Complete immutable graph. */
  readonly graph: Graph;
  /** Complete native-to-graph provenance. */
  readonly provenance: GraphProvenanceMap;
}

/**
 * Projects all document roots to one exact PortableGraph (lib.rs:433-448;
 * native.rs:143-195). Unknown/custom tags fail instead of being treated as
 * application constructors or untyped strings.
 */
export function projectGraph(document: YamlDocument, limits: Limits = defaultLimits()): Graph {
  const builder = new Builder(limits);
  const nodeCount = document.nodeCount();
  const ids: NodeID[] = [];
  for (let index = 0; index < nodeCount; index++) {
    ids.push(builder.reserveNode());
  }
  for (let index = 0; index < nodeCount; index++) {
    const node = document.nodeAt(index);
    if (!isStandardGraphTag(node.tag)) {
      throw new GraphProjectionFailure('UnsupportedTag', { tag: node.tag });
    }
    switch (node.content.kind) {
      case 'Scalar':
        builder.defineScalar(ids[index], node.tag, node.content.scalar.canonical);
        break;
      case 'Sequence':
        builder.defineSequence(
          ids[index],
          node.tag,
          node.content.items.map((item) => ids[item.node]),
        );
        break;
      case 'Mapping':
        builder.defineMapping(
          ids[index],
          node.tag,
          node.content.entries.map((entry) => ({ key: ids[entry.key], value: ids[entry.value] })),
        );
        break;
    }
  }
  for (const document_ of document.documentsInternal()) {
    builder.pushRoot(ids[document_.root]);
  }
  try {
    return builder.build();
  } catch (error) {
    throw new GraphProjectionFailure('Graph', { error: asGraphError(error) });
  }
}

/** Applies exact graph projection with complete node/edge/alias provenance (projection.rs:531-554). */
export function projectGraphWithProvenance(
  document: YamlDocument,
  request: GraphProjectionRequest,
): CompleteGraphProjection {
  const graph = projectGraph(document, request.limits().graph);
  const ids = canonicalNodeIds(graph);
  const builder = new GraphProvenanceBuilder(document, ids, request.limits().maxProvenanceEntries);
  builder.build();
  return { graph, provenance: builder.map() };
}

// ---------------------------------------------------------------------------
// Value projection
// ---------------------------------------------------------------------------

/** Explicit YAML graph-sharing policy for PortableValue projection (projection.rs:204-211). */
export type SharingPolicy = 'Reject' | 'DuplicateAcyclic';

/** Explicit YAML tag policy for PortableValue projection (projection.rs:213-220). */
export type TagPolicy = 'RequireKnownPortableTag' | 'StripToNodeKind';

/** YAML mapping-to-tree selection policy (projection.rs:222-231). */
export type MappingPolicy = 'BestExactObjectOrEntryMapping' | 'RequireObject' | 'RequireEntryMapping';

/** PortableValue projection resource contract (projection.rs:233-258). */
export interface ValueProjectionLimits {
  /** Maximum projected native/value node visits. */
  readonly maxValueNodes: number;
  /** Maximum recursive graph depth. */
  readonly maxDepth: number;
  /** Maximum report events. */
  readonly maxReportEntries: number;
  /** Maximum projected-location plus origin records. */
  readonly maxProvenanceEntries: number;
  /** Maximum output-node visits divided by unique native nodes. */
  readonly maxAmplificationRatio: number;
}

/** The frozen defaults (projection.rs:248-257). */
export function defaultValueProjectionLimits(): ValueProjectionLimits {
  return {
    maxValueNodes: 1_000_000,
    maxDepth: 256,
    maxReportEntries: 100_000,
    maxProvenanceEntries: 2_000_000,
    maxAmplificationRatio: 16,
  };
}

/** Immutable `yaml.projection.best-exact-value@1` request (projection.rs:260-332). */
export class ValueProjectionRequest {
  readonly #sharing: SharingPolicy;
  readonly #tags: TagPolicy;
  readonly #mapping: MappingPolicy;
  readonly #limits: ValueProjectionLimits;

  private constructor(
    sharing: SharingPolicy,
    tags: TagPolicy,
    mapping: MappingPolicy,
    limits: ValueProjectionLimits,
  ) {
    this.#sharing = sharing;
    this.#tags = tags;
    this.#mapping = mapping;
    this.#limits = limits;
  }

  /** Frozen default: one document, no sharing/cycles, known tags, exact-first mapping (projection.rs:270-279). */
  static bestExactV1(): ValueProjectionRequest {
    return new ValueProjectionRequest(
      'Reject',
      'RequireKnownPortableTag',
      'BestExactObjectOrEntryMapping',
      defaultValueProjectionLimits(),
    );
  }

  /** Explicitly replaces the sharing policy (projection.rs:281-287). */
  withSharing(sharing: SharingPolicy): ValueProjectionRequest {
    return new ValueProjectionRequest(sharing, this.#tags, this.#mapping, this.#limits);
  }

  /** Explicitly replaces the tag policy (projection.rs:288-293). */
  withTags(tags: TagPolicy): ValueProjectionRequest {
    return new ValueProjectionRequest(this.#sharing, tags, this.#mapping, this.#limits);
  }

  /** Explicitly replaces the mapping policy (projection.rs:294-299). */
  withMapping(mapping: MappingPolicy): ValueProjectionRequest {
    return new ValueProjectionRequest(this.#sharing, this.#tags, mapping, this.#limits);
  }

  /** Replaces all value projection limits (projection.rs:300-307). */
  withLimits(limits: ValueProjectionLimits): ValueProjectionRequest {
    return new ValueProjectionRequest(this.#sharing, this.#tags, this.#mapping, limits);
  }

  /** Selected sharing policy (projection.rs:309-313). */
  sharing(): SharingPolicy {
    return this.#sharing;
  }

  /** Selected tag policy (projection.rs:315-319). */
  tags(): TagPolicy {
    return this.#tags;
  }

  /** Selected mapping policy (projection.rs:321-325). */
  mapping(): MappingPolicy {
    return this.#mapping;
  }

  /** Exact limits (projection.rs:327-331). */
  limits(): ValueProjectionLimits {
    return this.#limits;
  }
}

/** Projection fidelity classification (projection.rs:334-343). */
export type Fidelity = 'Exact' | 'Transformed' | 'Lossy';

/** One PortableValue or association location (projection.rs:345-352). */
export type ProjectedLocation =
  | { readonly kind: 'Value'; readonly path: ValuePath }
  | { readonly kind: 'Association'; readonly location: AssociationLocation };

/** One PortableValue provenance entry (projection.rs:354-361). */
export interface ProvenanceEntry {
  /** Projected tree location. */
  readonly projected: ProjectedLocation;
  /** One or more exact YAML origins. */
  readonly origins: readonly SourceOrigin[];
}

/** Complete deterministic PortableValue provenance multimap (projection.rs:363-375). */
export class ProvenanceMap {
  readonly #entries: readonly ProvenanceEntry[];

  private constructor(entries: readonly ProvenanceEntry[]) {
    this.#entries = Object.freeze([...entries]);
  }

  static create(entries: readonly ProvenanceEntry[]): ProvenanceMap {
    return new ProvenanceMap(entries);
  }

  /** Entries in deterministic projection order (projection.rs:370-374). */
  entries(): readonly ProvenanceEntry[] {
    return this.#entries;
  }
}

/** Structured YAML value projection event category (projection.rs:377-384). */
export type ProjectionEventKind = 'SharingDuplicated' | 'TagStripped';

/** One machine-readable projection transformation/loss event (projection.rs:386-405). */
export interface ProjectionEvent {
  readonly kind: ProjectionEventKind;
  /** Policy that authorized the event. */
  readonly policy: string;
  /** Exact source identity. */
  readonly source: NodeRef;
  /** Projected value location. */
  readonly projected: ValuePath;
  /** Stable old semantic category. */
  readonly oldCategory: string;
  /** Stable new semantic category. */
  readonly newCategory: string;
  /** Whether output plus contract can recover the fact. */
  readonly reversible: boolean;
  /** Fidelity impact. */
  readonly loss: Fidelity;
}

/** Complete ordered value projection report (projection.rs:407-419). */
export class ProjectionReport {
  readonly #events: readonly ProjectionEvent[];

  private constructor(events: readonly ProjectionEvent[]) {
    this.#events = Object.freeze([...events]);
  }

  static create(events: readonly ProjectionEvent[]): ProjectionReport {
    return new ProjectionReport(events);
  }

  /** Events in deterministic traversal order (projection.rs:414-418). */
  events(): readonly ProjectionEvent[] {
    return this.#events;
  }
}

/** Complete successful PortableValue projection (projection.rs:421-432). */
export interface CompleteValueProjection {
  /** Complete immutable tree value. */
  readonly value: PortableValue;
  /** Worst fidelity of the complete operation. */
  readonly fidelity: Fidelity;
  /** Explicit transformation/loss report. */
  readonly report: ProjectionReport;
  /** Complete source-to-tree provenance. */
  readonly provenance: ProvenanceMap;
}

/** Complete-or-failed PortableValue projection algebra (projection.rs:522-529). */
export type ValueProjectionResult =
  | { readonly kind: 'Complete'; readonly complete: CompleteValueProjection }
  | { readonly kind: 'Failed'; readonly failure: ValueProjectionFailure };

/**
 * Applies explicit YAML-to-PortableValue tree projection and returns the
 * complete algebra (projection.rs:556-603).
 */
export function projectValueComplete(
  document: YamlDocument,
  request: ValueProjectionRequest,
): ValueProjectionResult {
  if (document.documentCount() !== 1) {
    return {
      kind: 'Failed',
      failure: new ValueProjectionFailure('DocumentCardinality'),
    };
  }
  if (request.limits().maxAmplificationRatio === 0) {
    return {
      kind: 'Failed',
      failure: new ValueProjectionFailure('ResourceLimit', {
        limitName: 'max_amplification_ratio',
      }),
    };
  }
  const context = new ValueContext(document, request);
  const root = document.documentInternal(0).root;
  let value: PortableValue;
  try {
    value = context.projectNode(root, ValuePath.root(), 0, null);
  } catch (failure) {
    if (failure instanceof ValueProjectionFailure) {
      return { kind: 'Failed', failure };
    }
    throw failure;
  }
  const maximum = context.seenCount() * request.limits().maxAmplificationRatio;
  if (context.visits() > maximum) {
    return {
      kind: 'Failed',
      failure: new ValueProjectionFailure('ResourceLimit', {
        limitName: 'max_amplification_ratio',
      }),
    };
  }
  return {
    kind: 'Complete',
    complete: {
      value,
      fidelity: context.fidelity(),
      report: context.report(),
      provenance: context.provenance(),
    },
  };
}

// ---------------------------------------------------------------------------
// Internal: graph provenance builder
// ---------------------------------------------------------------------------

class GraphProvenanceBuilder {
  readonly #document: YamlDocument;
  readonly #ids: readonly NodeID[];
  readonly #maxEntries: number;
  #units = 0;
  #entries: GraphProvenanceEntry[] = [];
  readonly #index = new Map<string, number>();

  constructor(document: YamlDocument, ids: readonly NodeID[], maxEntries: number) {
    this.#document = document;
    this.#ids = ids;
    this.#maxEntries = maxEntries;
  }

  build(): void {
    const documents = this.#document.documentsInternal();
    for (let ordinal = 0; ordinal < documents.length; ordinal++) {
      this.#add(
        { kind: 'Root', ordinal: BigInt(ordinal) },
        {
          snapshot: this.#document.snapshotIdentity().asBigInt(),
          node: this.#document.authorityInternal().nodeRef(BigInt(ordinal), 'YamlDocument'),
          span: documents[ordinal].span,
          relation: 'Direct',
        },
      );
    }
    const nodeCount = this.#document.nodeCount();
    for (let index = 0; index < nodeCount; index++) {
      const node = this.#document.nodeAt(index);
      this.#add(
        { kind: 'Node', node: this.#ids[index] },
        {
          snapshot: this.#document.snapshotIdentity().asBigInt(),
          node: this.#document.authorityInternal().nodeRef(BigInt(index), 'YamlNode'),
          span: node.span,
          relation: 'Direct',
        },
      );
      switch (node.content.kind) {
        case 'Scalar':
          break;
        case 'Sequence':
          for (let ordinal = 0; ordinal < node.content.items.length; ordinal++) {
            const item = node.content.items[ordinal];
            const location: GraphProjectedLocation = {
              kind: 'SequenceElement',
              parent: this.#ids[index],
              ordinal: BigInt(ordinal),
            };
            this.#add(location, {
              snapshot: this.#document.snapshotIdentity().asBigInt(),
              node: this.#document
                .authorityInternal()
                .nodeRef(item.identity, 'YamlSequenceElement'),
              span: item.span,
              relation: 'Direct',
            });
            if (item.alias !== null) {
              this.#addAlias(location, item.alias, 'Reference');
            }
          }
          break;
        case 'Mapping':
          for (let ordinal = 0; ordinal < node.content.entries.length; ordinal++) {
            const entry = node.content.entries[ordinal];
            const locations: [GraphProjectedLocation, number | null][] = [
              [
                { kind: 'MappingKey', parent: this.#ids[index], ordinal: BigInt(ordinal) },
                entry.keyAlias,
              ],
              [
                { kind: 'MappingValue', parent: this.#ids[index], ordinal: BigInt(ordinal) },
                entry.valueAlias,
              ],
            ];
            for (const [location, alias] of locations) {
              this.#add(location, {
                snapshot: this.#document.snapshotIdentity().asBigInt(),
                node: this.#document.authorityInternal().nodeRef(entry.identity, 'YamlMappingEntry'),
                span: entry.span,
                relation: 'Direct',
              });
              if (alias !== null) {
                this.#addAlias(location, alias, 'Reference');
              }
            }
          }
          break;
      }
    }
  }

  map(): GraphProvenanceMap {
    return GraphProvenanceMap.create(this.#entries);
  }

  #addAlias(location: GraphProjectedLocation, ordinal: number, relation: ProvenanceRelation): void {
    const alias = this.#document.aliasesInternal()[ordinal];
    this.#add(location, {
      snapshot: this.#document.snapshotIdentity().asBigInt(),
      node: this.#document.authorityInternal().nodeRef(alias.identity, 'YamlAlias'),
      span: alias.span,
      relation,
    });
  }

  #add(location: GraphProjectedLocation, origin: SourceOrigin): void {
    const key = locationKey(location);
    const existing = this.#index.get(key);
    const observed = this.#units + (existing === undefined ? 2 : 1);
    if (observed > this.#maxEntries) {
      throw new GraphProjectionFailure('ProvenanceLimit');
    }
    this.#units = observed;
    if (existing !== undefined) {
      const prior = this.#entries[existing];
      this.#entries[existing] = { projected: prior.projected, origins: [...prior.origins, origin] };
    } else {
      this.#index.set(key, this.#entries.length);
      this.#entries.push({ projected: location, origins: [origin] });
    }
  }
}

// ---------------------------------------------------------------------------
// Internal: value context
// ---------------------------------------------------------------------------

class ValueContext {
  readonly #document: YamlDocument;
  readonly #request: ValueProjectionRequest;
  readonly #seen = new Set<number>();
  readonly #stack = new Set<number>();
  #visits = 0;
  #provenanceUnits = 0;
  #reportEvents: ProjectionEvent[] = [];
  #provenanceEntries: ProvenanceEntry[] = [];
  readonly #provenanceIndex = new Map<string, number>();
  #fidelity: Fidelity = 'Exact';

  constructor(document: YamlDocument, request: ValueProjectionRequest) {
    this.#document = document;
    this.#request = request;
  }

  seenCount(): number {
    return this.#seen.size;
  }

  visits(): number {
    return this.#visits;
  }

  fidelity(): Fidelity {
    return this.#fidelity;
  }

  report(): ProjectionReport {
    return ProjectionReport.create(this.#reportEvents);
  }

  provenance(): ProvenanceMap {
    return ProvenanceMap.create(this.#provenanceEntries);
  }

  projectNode(
    index: number,
    path: ValuePath,
    depth: number,
    incomingAlias: number | null,
  ): PortableValue {
    if (depth > this.#request.limits().maxDepth) {
      throw new ValueProjectionFailure('ResourceLimit', { limitName: 'max_depth' });
    }
    this.#visits += 1;
    if (this.#visits > this.#request.limits().maxValueNodes) {
      throw new ValueProjectionFailure('ResourceLimit', { limitName: 'max_value_nodes' });
    }
    const nodeRef = this.#document.authorityInternal().nodeRef(BigInt(index), 'YamlNode');
    if (this.#stack.has(index)) {
      throw new ValueProjectionFailure('Cycle', { node: nodeRef });
    }
    if (this.#seen.has(index)) {
      if (this.#request.sharing() === 'Reject') {
        throw new ValueProjectionFailure('Sharing', { node: nodeRef });
      }
      this.#event(
        'SharingDuplicated',
        'DuplicateAcyclicSharing@1',
        incomingAlias === null ? nodeRef : this.#aliasRef(incomingAlias),
        path,
        'SharedGraphNode',
        'DuplicatedTreeValue',
        false,
        'Transformed',
      );
    }
    this.#seen.add(index);
    this.#stack.add(index);
    const node = this.#document.nodeAt(index);
    const supportedTag = isPortableTag(node.tag, node.content.kind);
    if (!supportedTag) {
      if (this.#request.tags() === 'RequireKnownPortableTag') {
        throw new ValueProjectionFailure('UnsupportedTag', { node: nodeRef, tag: node.tag });
      }
      this.#event(
        'TagStripped',
        'StripToNodeKind@1',
        nodeRef,
        path,
        node.tag,
        node.content.kind,
        false,
        'Lossy',
      );
    }
    let value: PortableValue;
    switch (node.content.kind) {
      case 'Scalar':
        value = this.#projectScalar(index, node.content.scalar, supportedTag);
        break;
      case 'Sequence': {
        const items: PortableValue[] = [];
        for (let ordinal = 0; ordinal < node.content.items.length; ordinal++) {
          const item = node.content.items[ordinal];
          const child = path.child({ kind: 'SequenceElement', index: BigInt(ordinal) });
          items.push(this.projectNode(item.node, child, depth + 1, item.alias));
          this.#addOrigin(
            { kind: 'Value', path: child },
            this.#document.authorityInternal().nodeRef(item.identity, 'YamlSequenceElement'),
            item.span,
            'Direct',
          );
        }
        value = sequenceValue(items);
        break;
      }
      case 'Mapping':
        value = this.#projectMapping(index, node.content.entries, path, depth);
        break;
    }
    this.#stack.delete(index);
    this.#addOrigin(
      { kind: 'Value', path },
      nodeRef,
      node.span,
      supportedTag ? 'Direct' : 'TagStripped',
    );
    if (incomingAlias !== null) {
      const alias = this.#document.aliasesInternal()[incomingAlias];
      this.#addOrigin(
        { kind: 'Value', path },
        this.#document.authorityInternal().nodeRef(alias.identity, 'YamlAlias'),
        alias.span,
        'Expanded',
      );
    }
    return value;
  }

  #projectMapping(
    index: number,
    entries: readonly import('./document.ts').InternalMappingEntry[],
    path: ValuePath,
    depth: number,
  ): PortableValue {
    const names = objectNames(this.#document, entries);
    let useObject: boolean;
    switch (this.#request.mapping()) {
      case 'BestExactObjectOrEntryMapping':
        useObject = names !== null;
        break;
      case 'RequireObject':
        if (names === null) {
          throw new ValueProjectionFailure('MappingNotObject', {
            node: this.#document.authorityInternal().nodeRef(BigInt(index), 'YamlNode'),
          });
        }
        useObject = true;
        break;
      case 'RequireEntryMapping':
        useObject = false;
        break;
    }
    if (useObject) {
      const objectEntries: { key: string; value: PortableValue }[] = [];
      for (let ordinal = 0; ordinal < entries.length; ordinal++) {
        const entry = entries[ordinal];
        this.#visitObjectKey(entry.key, entry.keyAlias, path);
        const child = path.child({ kind: 'ObjectValue', name: names![ordinal] });
        objectEntries.push({
          key: names![ordinal],
          value: this.projectNode(entry.value, child, depth + 1, entry.valueAlias),
        });
        this.#addMappingOrigins(path, ordinal, entry, true);
      }
      return objectValue(objectEntries);
    }
    const mappingEntries: { key: PortableValue; value: PortableValue }[] = [];
    for (let ordinal = 0; ordinal < entries.length; ordinal++) {
      const entry = entries[ordinal];
      const keyPath = path.child({ kind: 'EntryKey', index: BigInt(ordinal) });
      const valuePath = path.child({ kind: 'EntryValue', index: BigInt(ordinal) });
      const key = this.projectNode(entry.key, keyPath, depth + 1, entry.keyAlias);
      const value = this.projectNode(entry.value, valuePath, depth + 1, entry.valueAlias);
      mappingEntries.push({ key, value });
      this.#addMappingOrigins(path, ordinal, entry, false);
    }
    return entryMappingValue(mappingEntries);
  }

  #visitObjectKey(index: number, alias: number | null, path: ValuePath): void {
    const nodeRef = this.#document.authorityInternal().nodeRef(BigInt(index), 'YamlNode');
    if (this.#stack.has(index)) {
      throw new ValueProjectionFailure('Cycle', { node: nodeRef });
    }
    if (this.#seen.has(index)) {
      if (this.#request.sharing() === 'Reject') {
        throw new ValueProjectionFailure('Sharing', { node: nodeRef });
      }
      this.#event(
        'SharingDuplicated',
        'DuplicateAcyclicSharing@1',
        alias === null ? nodeRef : this.#aliasRef(alias),
        path,
        'SharedGraphNode',
        'DuplicatedObjectKey',
        false,
        'Transformed',
      );
    }
    this.#seen.add(index);
    this.#visits += 1;
    if (this.#visits > this.#request.limits().maxValueNodes) {
      throw new ValueProjectionFailure('ResourceLimit', { limitName: 'max_value_nodes' });
    }
  }

  #projectScalar(
    index: number,
    scalar: { readonly decoded: string; readonly canonical: string; readonly kind: YamlScalarKind },
    supportedTag: boolean,
  ): PortableValue {
    const invalid = (): ValueProjectionFailure =>
      new ValueProjectionFailure('InvalidCanonicalScalar', {
        node: this.#document.authorityInternal().nodeRef(BigInt(index), 'YamlNode'),
      });
    if (!supportedTag) {
      return stringValue(scalar.decoded);
    }
    switch (scalar.kind) {
      case 'Null':
        return nullValue();
      case 'Boolean':
        if (scalar.canonical === 'true') {
          return booleanValue(true);
        }
        if (scalar.canonical === 'false') {
          return booleanValue(false);
        }
        throw invalid();
      case 'Integer':
        try {
          return integerValue(BigInt(scalar.canonical));
        } catch {
          throw invalid();
        }
      case 'Float': {
        switch (scalar.canonical) {
          case '.inf':
            return binaryFloat64(0x7ff0000000000000n);
          case '-.inf':
            return binaryFloat64(0xfff0000000000000n);
          case '.nan':
            return binaryFloat64(0x7ff8000000000000n);
          default:
            break;
        }
        const decimal = parseDecimalCanonical(scalar.canonical);
        if (decimal === null) {
          throw invalid();
        }
        return decimalValue(decimal.coefficient, decimal.exponent);
      }
      case 'String':
        return stringValue(scalar.canonical);
      case 'Binary': {
        const bytes = decodeBase64(scalar.canonical);
        if (bytes === null) {
          throw invalid();
        }
        return bytesValue(bytes);
      }
      case 'Timestamp': {
        const projected = projectTimestamp(scalar.canonical);
        if (projected === null) {
          throw new ValueProjectionFailure('UnrepresentableTimestamp', {
            node: this.#document.authorityInternal().nodeRef(BigInt(index), 'YamlNode'),
          });
        }
        return projected;
      }
      case 'Custom':
      case 'Tagged':
        return stringValue(scalar.decoded);
    }
  }

  #addMappingOrigins(path: ValuePath, ordinal: number, entry: InternalMappingEntry, object: boolean): void {
    const association = new AssociationLocation(
      path,
      BigInt(ordinal),
      object ? 'ObjectEntry' : 'EntryMappingEntry',
    );
    this.#addOrigin(
      { kind: 'Association', location: association },
      this.#document.authorityInternal().nodeRef(entry.identity, 'YamlMappingEntry'),
      entry.span,
      'Direct',
    );
    if (object) {
      const keyLocation = new AssociationLocation(path, BigInt(ordinal), 'ObjectKey');
      const key = this.#document.nodeAt(entry.key);
      this.#addOrigin(
        { kind: 'Association', location: keyLocation },
        this.#document.authorityInternal().nodeRef(BigInt(entry.key), 'YamlNode'),
        key.span,
        'Direct',
      );
      if (entry.keyAlias !== null) {
        const alias = this.#document.aliasesInternal()[entry.keyAlias];
        this.#addOrigin(
          { kind: 'Association', location: keyLocation },
          this.#document.authorityInternal().nodeRef(alias.identity, 'YamlAlias'),
          alias.span,
          'Expanded',
        );
      }
    }
  }

  #event(
    kind: ProjectionEventKind,
    policy: string,
    source: NodeRef,
    path: ValuePath,
    oldCategory: string,
    newCategory: string,
    reversible: boolean,
    loss: Fidelity,
  ): void {
    const observed = this.#reportEvents.length + 1;
    if (observed > this.#request.limits().maxReportEntries) {
      throw new ValueProjectionFailure('ResourceLimit', { limitName: 'max_report_entries' });
    }
    this.#reportEvents.push({
      kind,
      policy,
      source,
      projected: path,
      oldCategory,
      newCategory,
      reversible,
      loss,
    });
    if (loss === 'Transformed' && this.#fidelity === 'Exact') {
      this.#fidelity = 'Transformed';
    } else if (loss === 'Lossy') {
      this.#fidelity = 'Lossy';
    }
  }

  #addOrigin(
    projected: ProjectedLocation,
    node: NodeRef,
    span: Span,
    relation: ProvenanceRelation,
  ): void {
    const key = projectedLocationKey(projected);
    const existing = this.#provenanceIndex.get(key);
    const observed = this.#provenanceUnits + (existing === undefined ? 2 : 1);
    if (observed > this.#request.limits().maxProvenanceEntries) {
      throw new ValueProjectionFailure('ResourceLimit', {
        limitName: 'max_provenance_entries',
      });
    }
    this.#provenanceUnits = observed;
    const origin: SourceOrigin = {
      snapshot: this.#document.snapshotIdentity().asBigInt(),
      node,
      span,
      relation,
    };
    if (existing !== undefined) {
      const prior = this.#provenanceEntries[existing];
      this.#provenanceEntries[existing] = {
        projected: prior.projected,
        origins: [...prior.origins, origin],
      };
    } else {
      this.#provenanceIndex.set(key, this.#provenanceEntries.length);
      this.#provenanceEntries.push({ projected, origins: [origin] });
    }
  }

  #aliasRef(ordinal: number): NodeRef {
    const alias = this.#document.aliasesInternal()[ordinal];
    return this.#document.authorityInternal().nodeRef(alias.identity, 'YamlAlias');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function binaryFloat64(bits: bigint): PortableValue {
  return { kind: 'BinaryFloat64', bits };
}

/** object_names (projection.rs:1149-1170): unique str keys only. */
function objectNames(
  document: YamlDocument,
  entries: readonly { key: number }[],
): string[] | null {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of entries) {
    const key = document.nodeAt(entry.key);
    if (key.content.kind !== 'Scalar' || key.tag !== TAG_STR) {
      return null;
    }
    const name = key.content.scalar.canonical;
    if (seen.has(name)) {
      return null;
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** is_portable_tag (projection.rs:1172-1181). */
function isPortableTag(tag: string, contentKind: 'Scalar' | 'Sequence' | 'Mapping'): boolean {
  switch (contentKind) {
    case 'Scalar':
      return (
        tag === TAG_NULL ||
        tag === TAG_BOOL ||
        tag === TAG_INT ||
        tag === TAG_FLOAT ||
        tag === TAG_STR ||
        tag === TAG_TIMESTAMP ||
        tag === TAG_BINARY
      );
    case 'Sequence':
      return tag === TAG_SEQ;
    case 'Mapping':
      return tag === TAG_MAP;
  }
}

function isStandardGraphTag(tag: string): boolean {
  return (
    tag === TAG_SEQ ||
    tag === TAG_MAP ||
    tag === 'tag:yaml.org,2002:omap' ||
    tag === 'tag:yaml.org,2002:pairs' ||
    tag === 'tag:yaml.org,2002:set' ||
    tag === TAG_NULL ||
    tag === TAG_BOOL ||
    tag === TAG_INT ||
    tag === TAG_FLOAT ||
    tag === TAG_STR ||
    tag === TAG_TIMESTAMP ||
    tag === TAG_BINARY ||
    tag === 'tag:yaml.org,2002:merge' ||
    tag === 'tag:yaml.org,2002:value' ||
    tag === 'tag:yaml.org,2002:yaml'
  );
}

/** Parses one canonical decimal spelling "coefficient" or "coefficient e exponent". */
function parseDecimalCanonical(value: string): { coefficient: bigint; exponent: bigint } | null {
  const e = value.indexOf('e');
  const E = value.indexOf('E');
  const index = e === -1 ? (E === -1 ? -1 : E) : E === -1 ? e : Math.min(e, E);
  try {
    if (index === -1) {
      return { coefficient: BigInt(value), exponent: 0n };
    }
    return {
      coefficient: BigInt(value.slice(0, index)),
      exponent: BigInt(value.slice(index + 1)),
    };
  } catch {
    return null;
  }
}

/** project_timestamp (projection.rs:1230-1269). */
function projectTimestamp(value: string): PortableValue | null {
  try {
    const year = BigInt(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    const date = dateValue(year, month, day);
    if (value.length === 10) {
      return { kind: 'Date', year, month, day };
    }
    const timeStart = 11;
    const hour = Number(value.slice(timeStart, timeStart + 2));
    const minute = Number(value.slice(timeStart + 3, timeStart + 5));
    const second = Number(value.slice(timeStart + 6, timeStart + 8));
    const tail = value.slice(timeStart + 8);
    const zoneIndex = tail.search(/[Z+-]/);
    if (zoneIndex === -1) {
      return null;
    }
    const parsed =
      zoneIndex === 0
        ? { coefficient: 0n, exponent: 0n }
        : parseDecimalCanonical('0' + tail.slice(0, zoneIndex));
    if (parsed === null) {
      return null;
    }
    const fraction = decimalValue(parsed.coefficient, parsed.exponent);
    const time = timeValue(hour, minute, second, fraction);
    const local = localDateTimeValue(date, time);
    const zone = tail.slice(zoneIndex);
    let offset: number;
    if (zone === 'Z') {
      offset = 0;
    } else {
      const sign = zone.startsWith('-') ? -1 : 1;
      const hours = Number(zone.slice(1, 3));
      const minutes = Number(zone.slice(4, 6));
      offset = sign * (hours * 3600 + minutes * 60);
    }
    return offsetDateTimeValue(local, offset);
  } catch {
    return null;
  }
}

function locationKey(location: GraphProjectedLocation): string {
  switch (location.kind) {
    case 'Root':
      return `root:${location.ordinal}`;
    case 'Node':
      return `node:${location.node.graph}:${location.node.index}`;
    case 'SequenceElement':
      return `seq:${location.parent.graph}:${location.parent.index}:${location.ordinal}`;
    case 'MappingKey':
      return `key:${location.parent.graph}:${location.parent.index}:${location.ordinal}`;
    case 'MappingValue':
      return `val:${location.parent.graph}:${location.parent.index}:${location.ordinal}`;
  }
}

function projectedLocationKey(location: ProjectedLocation): string {
  switch (location.kind) {
    case 'Value':
      return `value:${pathKey(location.path)}`;
    case 'Association':
      return `assoc:${pathKey(location.location.container())}:${location.location.ordinal()}:${location.location.role()}`;
  }
}

function pathKey(path: ValuePath): string {
  return path
    .segments()
    .map((segment) => {
      switch (segment.kind) {
        case 'ObjectValue':
          return `o:${segment.name}`;
        case 'SequenceElement':
          return `s:${segment.index}`;
        case 'EntryKey':
          return `k:${segment.index}`;
        case 'EntryValue':
          return `v:${segment.index}`;
      }
    })
    .join('/');
}

/** Resolves the canonical node IDs of a built graph (its node array order). */
function canonicalNodeIds(graph: Graph): NodeID[] {
  return graph.nodes.map((_, index) => ({ graph: graph.identity, index }));
}

function asGraphError(error: unknown): GraphError {
  if (error instanceof GraphError) {
    return error;
  }
  throw error;
}
