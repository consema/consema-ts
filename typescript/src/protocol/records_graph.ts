/**
 * PortableGraph, graph query-result, provenance, projection, and
 * line-format query-result protocol records.
 *
 * authority: crates/consema-protocol/src/portable_graph.rs,
 * graph_query.rs, graph_projection.rs, yaml_query.rs, line_query.rs (the
 * record shapes, canonical node IDs, and every rejection); the transport
 * digests and rejection codes are pinned by
 * conformance/vectors/semantic-model-v5.json and semantic-model-v6.json;
 * cross-reference go/protocol/records_graph.go and records_line_query.go.
 *
 * Design (TypeScript-idiomatic): graphs are the immutable `Graph` values of
 * src/graph/graph.ts; canonical wire node IDs are assigned by the canonical
 * first-discovery layout (RFC 0006 §4) and every match/location is bound to
 * the complete graph carried by the record. All records self-register their
 * strict decoders with the payload dispatch so the common envelope
 * validates them fully.
 */

import type { PortableValue, ObjectValue } from '../core/value.ts';
import { Builder, canonicalOrder } from '../graph/graph.ts';
import type { Graph, NodeID, Limits } from '../graph/graph.ts';
import { encodePGCERecords, decodePGCE, defaultPgceLimits } from '../graph/pgce.ts';
import type { PgceLimits } from '../graph/pgce.ts';
import { equal as graphEqual } from '../graph/equal.ts';
import { GraphError, PGCEError } from '../graph/errors.ts';
import type { QueryDomain } from './query.ts';
import { newQueryDomain } from './query.ts';
import { Completion } from './records_execution.ts';
import { ErrorCodeRegistry } from './error_registry.ts';
import type { Diagnostic } from './diagnostic.ts';
import { diagnosticToValue, diagnosticFromValue } from './diagnostic.ts';
import type { NodeRef } from '../document/identity.ts';
import {
  exactFields,
  schemaFields,
  stringOf,
  sequenceOf,
  unsigned64,
  unsigned32,
  objectValueFrom,
  wireInteger,
} from './records.ts';
import { invalid, protocolError, resource } from './errors.ts';
import { registerPayloadValidator } from './payload_validators.ts';

// ---------------------------------------------------------------------------
// core.portable-graph@1
// ---------------------------------------------------------------------------

/** The `core.portable-graph@1` readable graph plus exact PGCE/1 bytes. */
export class PortableGraphMessage {
  readonly #graph: Graph;
  readonly #pgce: Uint8Array;

  private constructor(graph: Graph, pgce: Uint8Array) {
    this.#graph = graph;
    this.#pgce = pgce;
  }

  /** Canonically encodes one complete graph under explicit PGCE limits (portable_graph.rs:24-27). */
  static fromGraph(graph: Graph, limits: PgceLimits): PortableGraphMessage {
    let pgce: Uint8Array;
    try {
      pgce = encodePGCERecords(graph, limits);
    } catch (error) {
      throw encodeError(error as PGCEError);
    }
    return new PortableGraphMessage(graph, pgce);
  }

  /** Exact canonical PGCE/1 bytes; logically immutable. */
  pgce(): Uint8Array {
    return this.#pgce;
  }

  /** Complete immutable graph. */
  graph(): Graph {
    return this.#graph;
  }

  /** Encodes the fixed readable graph plus PGCE schema (portable_graph.rs:43-104). */
  toValue(): ObjectValue {
    const layout = canonicalLayoutOf(this.#graph);
    const ids = layout.canonicalIDs;
    const roots = this.#graph.roots.map((root) => wireInteger(BigInt(ids[root.index])));
    const nodes = layout.order.map((index, wireId) => {
      const node = this.#graph.nodes[index];
      switch (node.kind) {
        case 'Scalar':
          return objectValueFrom([
            { key: 'id', value: wireInteger(BigInt(wireId)) },
            { key: 'kind', value: { kind: 'String', value: 'Scalar' } },
            { key: 'tag', value: { kind: 'String', value: node.tag } },
            { key: 'canonical_content', value: { kind: 'String', value: node.content } },
          ]);
        case 'Sequence':
          return objectValueFrom([
            { key: 'id', value: wireInteger(BigInt(wireId)) },
            { key: 'kind', value: { kind: 'String', value: 'Sequence' } },
            { key: 'tag', value: { kind: 'String', value: node.tag } },
            {
              key: 'items',
              value: {
                kind: 'Sequence',
                items: node.items.map((item) => wireInteger(BigInt(ids[item.index]))),
              },
            },
          ]);
        case 'Mapping':
          return objectValueFrom([
            { key: 'id', value: wireInteger(BigInt(wireId)) },
            { key: 'kind', value: { kind: 'String', value: 'Mapping' } },
            { key: 'tag', value: { kind: 'String', value: node.tag } },
            {
              key: 'entries',
              value: {
                kind: 'Sequence',
                items: node.entries.map((entry) =>
                  objectValueFrom([
                    { key: 'key', value: wireInteger(BigInt(ids[entry.key.index])) },
                    { key: 'value', value: wireInteger(BigInt(ids[entry.value.index])) },
                  ]),
                ),
              },
            },
          ]);
      }
    });
    return objectValueFrom([
      { key: 'schema', value: { kind: 'String', value: 'core.portable-graph@1' } },
      { key: 'encoding', value: { kind: 'String', value: 'PGCE/1' } },
      { key: 'roots', value: { kind: 'Sequence', items: roots } },
      { key: 'nodes', value: { kind: 'Sequence', items: nodes } },
      { key: 'pgce', value: { kind: 'Bytes', value: Uint8Array.from(this.#pgce) } },
    ]);
  }

  /** Strictly decodes and cross-validates the readable graph and PGCE/1 forms (portable_graph.rs:107-173). */
  static fromValue(value: PortableValue, limits: PgceLimits): PortableGraphMessage {
    const fields = schemaFields(
      value,
      'core.portable-graph@1',
      ['encoding', 'roots', 'nodes', 'pgce'],
      '$',
    );
    if (stringOf(fields[0], '$.encoding') !== 'PGCE/1') {
      throw invalid('$.encoding', 'expected PGCE/1');
    }
    const rootValues = sequenceOf(fields[1], '$.roots');
    const nodeValues = sequenceOf(fields[2], '$.nodes');
    checkCount('$.roots', rootValues.length, limits.maxRoots);
    checkCount('$.nodes', nodeValues.length, limits.maxNodes);
    const pgceValue = fields[3];
    if (pgceValue.kind !== 'Bytes') {
      throw protocolError('WrongType', '$.pgce', 'expected Bytes');
    }
    checkCount('$.pgce', pgceValue.value.length, limits.maxStreamBytes);

    const builder = new Builder(graphLimitsOf(limits));
    const ids: NodeID[] = [];
    for (let index = 0; index < nodeValues.length; index++) {
      ids.push(builder.reserveNode());
    }
    for (let index = 0; index < nodeValues.length; index++) {
      defineRecord(builder, ids, index, nodeValues[index], limits);
    }
    for (let index = 0; index < rootValues.length; index++) {
      const path = `$.roots[${index}]`;
      const root = resolveId(ids, unsigned64(rootValues[index], path), path);
      try {
        builder.pushRoot(root);
      } catch (error) {
        throw buildError(error as GraphError);
      }
    }
    let graph: Graph;
    try {
      graph = builder.build();
    } catch (error) {
      throw buildError(error as GraphError);
    }
    // Node records must already be in canonical first-discovery order
    // (portable_graph.rs:152-157).
    const order = canonicalLayoutOf(graph).order;
    if (!order.every((original, index) => original === index)) {
      throw invalid('$.nodes', 'node records are not in canonical first-discovery order');
    }
    let decoded: Graph;
    try {
      decoded = decodePGCE(pgceValue.value, limits);
    } catch (error) {
      throw decodeError(error as PGCEError);
    }
    if (!graphEqual(graph, decoded)) {
      throw invalid('$', 'readable graph and PGCE graph are not strictly equal');
    }
    let canonical: Uint8Array;
    try {
      canonical = encodePGCERecords(graph, limits);
    } catch (error) {
      throw encodeError(error as PGCEError);
    }
    if (!byteArraysEqual(canonical, pgceValue.value)) {
      throw invalid('$.pgce', 'PGCE bytes disagree with readable graph');
    }
    return new PortableGraphMessage(graph, canonical);
  }
}

/** The canonical first-discovery layout of one completed graph (RFC 0006 §4). */
function canonicalLayoutOf(graph: Graph): { order: number[]; canonicalIDs: number[] } {
  // Completed graphs always traverse cleanly (build validated reachability
  // and depth); a failure here is an internal invariant violation.
  return canonicalOrder(graph.nodes, graph.roots, -1);
}

/** Resolves a canonical wire node ID to its graph-local node index. */
function resolveCanonical(layout: { readonly order: readonly number[] }, value: bigint, path: string): number {
  const index = Number(value);
  if (BigInt(index) !== value || index < 0 || index >= layout.order.length) {
    throw invalid(path, 'canonical node ID is out of range');
  }
  return layout.order[index];
}

/** The graph-construction limits implied by PGCE limits (pgce.rs:56-68). */
function graphLimitsOf(limits: PgceLimits): Limits {
  return {
    maxRoots: limits.maxRoots,
    maxNodes: limits.maxNodes,
    maxEdges: limits.maxEdges,
    maxContainerEntries: limits.maxContainerEntries,
    maxTagBytes: limits.maxTagBytes,
    maxScalarBytes: limits.maxScalarBytes,
    maxTraversalDepth: limits.maxTraversalDepth,
  };
}

/** Defines one wire node record exactly as portable_graph.rs:240-331. */
function defineRecord(
  builder: Builder,
  ids: readonly NodeID[],
  index: number,
  value: PortableValue,
  limits: PgceLimits,
): void {
  const path = `$.nodes[${index}]`;
  const kind = kindOf(value, path);
  switch (kind) {
    case 'Scalar': {
      const fields = exactFields(value, ['id', 'kind', 'tag', 'canonical_content'], path);
      validateRecordId(fields[0], index, path);
      try {
        builder.defineScalar(
          ids[index],
          stringOf(fields[2], `${path}.tag`),
          stringOf(fields[3], `${path}.canonical_content`),
        );
      } catch (error) {
        throw buildError(error as GraphError);
      }
      break;
    }
    case 'Sequence': {
      const fields = exactFields(value, ['id', 'kind', 'tag', 'items'], path);
      validateRecordId(fields[0], index, path);
      const values = sequenceOf(fields[3], `${path}.items`);
      checkCount(`${path}.items`, values.length, limits.maxContainerEntries);
      const items = values.map((item, ordinal) =>
        resolveId(ids, unsigned64(item, `${path}.items[${ordinal}]`), `${path}.items[${ordinal}]`),
      );
      try {
        builder.defineSequence(ids[index], stringOf(fields[2], `${path}.tag`), items);
      } catch (error) {
        throw buildError(error as GraphError);
      }
      break;
    }
    case 'Mapping': {
      const fields = exactFields(value, ['id', 'kind', 'tag', 'entries'], path);
      validateRecordId(fields[0], index, path);
      const values = sequenceOf(fields[3], `${path}.entries`);
      checkCount(`${path}.entries`, values.length, limits.maxContainerEntries);
      const entries = values.map((entry, ordinal) => {
        const entryPath = `${path}.entries[${ordinal}]`;
        const entryFields = exactFields(entry, ['key', 'value'], entryPath);
        const keyPath = `${entryPath}.key`;
        const valuePath = `${entryPath}.value`;
        return {
          key: resolveId(ids, unsigned64(entryFields[0], keyPath), keyPath),
          value: resolveId(ids, unsigned64(entryFields[1], valuePath), valuePath),
        };
      });
      try {
        builder.defineMapping(ids[index], stringOf(fields[2], `${path}.tag`), entries);
      } catch (error) {
        throw buildError(error as GraphError);
      }
      break;
    }
  }
}

/** Reads the kind of one node record (the second String field, portable_graph.rs:247-255). */
function kindOf(value: PortableValue, path: string): 'Scalar' | 'Sequence' | 'Mapping' {
  if (value.kind !== 'Object') {
    throw protocolError('WrongType', path, 'expected graph node Object');
  }
  const kind = value.entries[1];
  if (kind === undefined || kind.key !== 'kind' || kind.value.kind !== 'String') {
    throw invalid(path, 'kind must be the second String field');
  }
  switch (kind.value.value) {
    case 'Scalar':
    case 'Sequence':
    case 'Mapping':
      return kind.value.value;
    default:
      throw invalid(`${path}.kind`, 'unknown graph node kind');
  }
}

/** Requires the record id to equal its canonical array index (portable_graph.rs:333-348). */
function validateRecordId(value: PortableValue, index: number, path: string): void {
  const observed = unsigned64(value, `${path}.id`);
  if (observed !== BigInt(index)) {
    throw invalid(`${path}.id`, 'node ID must equal its canonical array index');
  }
}

/** Resolves one canonical node ID to a graph-local identity (portable_graph.rs:350-355). */
function resolveId(ids: readonly NodeID[], value: bigint, path: string): NodeID {
  const index = Number(value);
  const id = ids[index];
  if (id === undefined || BigInt(index) !== value) {
    throw invalid(path, 'canonical node ID is out of range');
  }
  return id;
}

function checkCount(path: string, observed: number, limit: number): void {
  if (observed > limit) {
    throw resource(path, `count ${observed} exceeds ${limit}`);
  }
}

function buildError(error: GraphError): Error {
  if (error.kind === 'ResourceLimit' || error.kind === 'SizeOverflow') {
    return resource('$', `graph construction: ${error.message}`);
  }
  return invalid('$', `invalid graph: ${error.message}`);
}

function encodeError(error: PGCEError): Error {
  return resource('$.pgce', `PGCE encoding failed: ${error.message}`);
}

function decodeError(error: PGCEError): Error {
  if (error.kind === 'ResourceLimit' || error.kind === 'VarintOverflow') {
    return resource('$.pgce', `PGCE decoding failed: ${error.message}`);
  }
  return invalid('$.pgce', `invalid PGCE: ${error.message}`);
}

function byteArraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// core.graph-query-result@1
// ---------------------------------------------------------------------------

/** One graph match expressed only with canonical wire node IDs (graph_query.rs:16-43). */
export class GraphQueryMatchMessage {
  readonly kind: 'Node' | 'SequenceElement' | 'MappingEntry';
  readonly node: bigint;
  readonly parent: bigint;
  readonly ordinal: bigint;
  readonly key: bigint;
  readonly value: bigint;

  private constructor(
    kind: 'Node' | 'SequenceElement' | 'MappingEntry',
    node: bigint,
    parent: bigint,
    ordinal: bigint,
    key: bigint,
    value: bigint,
  ) {
    this.kind = kind;
    this.node = node;
    this.parent = parent;
    this.ordinal = ordinal;
    this.key = key;
    this.value = value;
  }

  /** One graph node. */
  static node(node: bigint): GraphQueryMatchMessage {
    return new GraphQueryMatchMessage('Node', node, 0n, 0n, 0n, 0n);
  }

  /** One direct sequence association. */
  static sequenceElement(parent: bigint, ordinal: bigint, node: bigint): GraphQueryMatchMessage {
    return new GraphQueryMatchMessage('SequenceElement', node, parent, ordinal, 0n, 0n);
  }

  /** One direct mapping association. */
  static mappingEntry(parent: bigint, ordinal: bigint, key: bigint, value: bigint): GraphQueryMatchMessage {
    return new GraphQueryMatchMessage('MappingEntry', 0n, parent, ordinal, key, value);
  }

  /** The exact graph role of this match. */
  role(): 'GraphNode' | 'GraphSequenceElement' | 'GraphMappingEntry' {
    switch (this.kind) {
      case 'Node':
        return 'GraphNode';
      case 'SequenceElement':
        return 'GraphSequenceElement';
      case 'MappingEntry':
        return 'GraphMappingEntry';
    }
  }

  /** Encodes one match (graph_query.rs:342-371). */
  toValue(): ObjectValue {
    switch (this.kind) {
      case 'Node':
        return objectValueFrom([
          { key: 'kind', value: { kind: 'String', value: 'Node' } },
          { key: 'node', value: wireInteger(this.node) },
        ]);
      case 'SequenceElement':
        return objectValueFrom([
          { key: 'kind', value: { kind: 'String', value: 'SequenceElement' } },
          { key: 'parent', value: wireInteger(this.parent) },
          { key: 'ordinal', value: wireInteger(this.ordinal) },
          { key: 'node', value: wireInteger(this.node) },
        ]);
      case 'MappingEntry':
        return objectValueFrom([
          { key: 'kind', value: { kind: 'String', value: 'MappingEntry' } },
          { key: 'parent', value: wireInteger(this.parent) },
          { key: 'ordinal', value: wireInteger(this.ordinal) },
          { key: 'key', value: wireInteger(this.key) },
          { key: 'value', value: wireInteger(this.value) },
        ]);
    }
  }

  /** Strictly decodes one graph match (graph_query.rs:373-408). */
  static fromValue(value: PortableValue, path: string): GraphQueryMatchMessage {
    const kind = firstKindOf(value, path);
    switch (kind) {
      case 'Node': {
        const fields = exactFields(value, ['kind', 'node'], path);
        return GraphQueryMatchMessage.node(unsigned64(fields[1], `${path}.node`));
      }
      case 'SequenceElement': {
        const fields = exactFields(value, ['kind', 'parent', 'ordinal', 'node'], path);
        return GraphQueryMatchMessage.sequenceElement(
          unsigned64(fields[1], `${path}.parent`),
          unsigned64(fields[2], `${path}.ordinal`),
          unsigned64(fields[3], `${path}.node`),
        );
      }
      case 'MappingEntry': {
        const fields = exactFields(value, ['kind', 'parent', 'ordinal', 'key', 'value'], path);
        return GraphQueryMatchMessage.mappingEntry(
          unsigned64(fields[1], `${path}.parent`),
          unsigned64(fields[2], `${path}.ordinal`),
          unsigned64(fields[3], `${path}.key`),
          unsigned64(fields[4], `${path}.value`),
        );
      }
      default:
        throw invalid(path, 'unknown graph query match kind');
    }
  }
}

/** The complete or explicitly non-complete `core.graph-query-result@1` record. */
export class GraphQueryResultMessage {
  readonly #domain: QueryDomain;
  readonly #role: 'GraphNode' | 'GraphSequenceElement' | 'GraphMappingEntry';
  readonly #graph: PortableGraphMessage;
  readonly #matches: readonly GraphQueryMatchMessage[];
  readonly #completion: Completion;
  readonly #diagnostics: readonly Diagnostic[];

  private constructor(
    domain: QueryDomain,
    role: 'GraphNode' | 'GraphSequenceElement' | 'GraphMappingEntry',
    graph: PortableGraphMessage,
    matches: readonly GraphQueryMatchMessage[],
    completion: Completion,
    diagnostics: readonly Diagnostic[],
  ) {
    this.#domain = domain;
    this.#role = role;
    this.#graph = graph;
    this.#matches = matches;
    this.#completion = completion;
    this.#diagnostics = diagnostics;
  }

  /** Validates graph binding, uniform match roles, associations, and counts (graph_query.rs:68-99). */
  static new(
    domain: QueryDomain,
    role: 'GraphNode' | 'GraphSequenceElement' | 'GraphMappingEntry',
    graph: Graph,
    matches: readonly GraphQueryMatchMessage[],
    completion: Completion,
    diagnostics: readonly Diagnostic[],
  ): GraphQueryResultMessage {
    if (domain.id !== 'core.portable-graph-query' || domain.version !== 1 || !isGraphRole(role)) {
      throw invalid('$', 'graph result requires core.portable-graph-query@1 and a graph role');
    }
    const produced = BigInt(matches.length);
    if (completion.produced !== produced || matches.some((item) => item.role() !== role)) {
      throw invalid('$', 'completion count or graph match role is inconsistent');
    }
    const message = PortableGraphMessage.fromGraph(graph, defaultPgceLimits());
    validateGraphMatches(message, matches);
    return new GraphQueryResultMessage(domain, role, message, matches, completion, diagnostics);
  }

  /** Exact query domain. */
  domain(): QueryDomain {
    return this.#domain;
  }

  /** Uniform result role. */
  role(): 'GraphNode' | 'GraphSequenceElement' | 'GraphMappingEntry' {
    return this.#role;
  }

  /** The complete graph message that gives every canonical ID meaning. */
  graph(): PortableGraphMessage {
    return this.#graph;
  }

  /** Ordered graph matches. */
  matches(): readonly GraphQueryMatchMessage[] {
    return this.#matches;
  }

  /** Explicit terminal state. */
  completion(): Completion {
    return this.#completion;
  }

  /** Ordered diagnostics. */
  diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics;
  }

  /** Encodes `core.graph-query-result@1` (graph_query.rs:191-213). */
  toValue(): ObjectValue {
    return objectValueFrom([
      { key: 'schema', value: { kind: 'String', value: 'core.graph-query-result@1' } },
      { key: 'domain_id', value: { kind: 'String', value: this.#domain.id } },
      { key: 'domain_version', value: wireInteger(BigInt(this.#domain.version)) },
      { key: 'role', value: { kind: 'String', value: this.#role } },
      { key: 'graph', value: this.#graph.toValue() },
      {
        key: 'matches',
        value: { kind: 'Sequence', items: this.#matches.map((item) => item.toValue()) },
      },
      { key: 'completion', value: this.#completion.toValue() },
      {
        key: 'diagnostics',
        value: {
          kind: 'Sequence',
          items: this.#diagnostics.map((item) => diagnosticToValue(item)),
        },
      },
    ]);
  }

  /** Strictly decodes with explicit graph limits and semantic-model registry (graph_query.rs:229-269). */
  static fromValue(
    value: PortableValue,
    limits: PgceLimits,
    registry: ErrorCodeRegistry,
  ): GraphQueryResultMessage {
    const fields = schemaFields(
      value,
      'core.graph-query-result@1',
      ['domain_id', 'domain_version', 'role', 'graph', 'matches', 'completion', 'diagnostics'],
      '$',
    );
    const domain = newQueryDomain(stringOf(fields[0], '$.domain_id'), unsigned32(fields[1], '$.domain_version'));
    const role = parseGraphRole(stringOf(fields[2], '$.role'));
    const graph = PortableGraphMessage.fromValue(fields[3], limits);
    const matches = sequenceOf(fields[4], '$.matches').map((item, index) =>
      GraphQueryMatchMessage.fromValue(item, `$.matches[${index}]`),
    );
    const completion = Completion.fromValueWithRegistry(fields[5], registry);
    const diagnostics = sequenceOf(fields[6], '$.diagnostics').map((item) =>
      diagnosticFromValue(item, registry),
    );
    return GraphQueryResultMessage.new(domain, role, graph.graph(), matches, completion, diagnostics);
  }
}

/** Validates every match against the exact graph (graph_query.rs:272-329). */
function validateGraphMatches(
  message: PortableGraphMessage,
  matches: readonly GraphQueryMatchMessage[],
): void {
  const layout = canonicalLayoutOf(message.graph());
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const path = `$.matches[${index}]`;
    switch (match.kind) {
      case 'Node':
        resolveCanonical(layout, match.node, `${path}.node`);
        break;
      case 'SequenceElement': {
        const parent = resolveCanonical(layout, match.parent, `${path}.parent`);
        const child = resolveCanonical(layout, match.node, `${path}.node`);
        const node = message.graph().nodes[parent];
        if (node.kind !== 'Sequence') {
          throw invalid(path, 'sequence element parent is not a sequence');
        }
        const item = ordinalItem(node.items, match.ordinal);
        if (item === undefined || item.index !== child) {
          throw invalid(path, 'sequence association does not match graph');
        }
        break;
      }
      case 'MappingEntry': {
        const parent = resolveCanonical(layout, match.parent, `${path}.parent`);
        const key = resolveCanonical(layout, match.key, `${path}.key`);
        const value = resolveCanonical(layout, match.value, `${path}.value`);
        const node = message.graph().nodes[parent];
        if (node.kind !== 'Mapping') {
          throw invalid(path, 'mapping entry parent is not a mapping');
        }
        const entry = ordinalItem(node.entries, match.ordinal);
        if (entry === undefined || entry.key.index !== key || entry.value.index !== value) {
          throw invalid(path, 'mapping association does not match graph');
        }
        break;
      }
    }
  }
}

/** The item at one ordinal within an ordered edge list. */
function ordinalItem<T>(items: readonly T[], ordinal: bigint): T | undefined {
  const index = Number(ordinal);
  if (BigInt(index) !== ordinal || index < 0) {
    return undefined;
  }
  return items[index];
}

function isGraphRole(role: string): boolean {
  return role === 'GraphNode' || role === 'GraphSequenceElement' || role === 'GraphMappingEntry';
}

function parseGraphRole(value: string): 'GraphNode' | 'GraphSequenceElement' | 'GraphMappingEntry' {
  switch (value) {
    case 'GraphNode':
    case 'GraphSequenceElement':
    case 'GraphMappingEntry':
      return value;
    default:
      throw invalid('$.role', 'unknown graph query match role');
  }
}

// ---------------------------------------------------------------------------
// core.graph-provenance-map@1
// ---------------------------------------------------------------------------

/** One projected PortableGraph location expressed with canonical node IDs (graph_projection.rs:17-43). */
export class GraphProjectedLocationMessage {
  readonly kind: 'Root' | 'Node' | 'SequenceElement' | 'MappingKey' | 'MappingValue';
  readonly ordinal: bigint;
  readonly node: bigint;
  readonly parent: bigint;

  private constructor(
    kind: 'Root' | 'Node' | 'SequenceElement' | 'MappingKey' | 'MappingValue',
    ordinal: bigint,
    node: bigint,
    parent: bigint,
  ) {
    this.kind = kind;
    this.ordinal = ordinal;
    this.node = node;
    this.parent = parent;
  }

  /** Ordered root occurrence. */
  static root(ordinal: bigint): GraphProjectedLocationMessage {
    return new GraphProjectedLocationMessage('Root', ordinal, 0n, 0n);
  }

  /** One graph node. */
  static node(node: bigint): GraphProjectedLocationMessage {
    return new GraphProjectedLocationMessage('Node', 0n, node, 0n);
  }

  /** One ordered sequence edge. */
  static sequenceElement(parent: bigint, ordinal: bigint): GraphProjectedLocationMessage {
    return new GraphProjectedLocationMessage('SequenceElement', ordinal, 0n, parent);
  }

  /** One ordered mapping key edge. */
  static mappingKey(parent: bigint, ordinal: bigint): GraphProjectedLocationMessage {
    return new GraphProjectedLocationMessage('MappingKey', ordinal, 0n, parent);
  }

  /** One ordered mapping value edge. */
  static mappingValue(parent: bigint, ordinal: bigint): GraphProjectedLocationMessage {
    return new GraphProjectedLocationMessage('MappingValue', ordinal, 0n, parent);
  }

  /** The canonical wire ordering: Root < Node < SequenceElement < MappingKey < MappingValue. */
  less(other: GraphProjectedLocationMessage): boolean {
    if (this.kind !== other.kind) {
      return locationRank(this.kind) < locationRank(other.kind);
    }
    switch (this.kind) {
      case 'Root':
        return this.ordinal < other.ordinal;
      case 'Node':
        return this.node < other.node;
      case 'SequenceElement':
      case 'MappingKey':
      case 'MappingValue':
        if (this.parent !== other.parent) {
          return this.parent < other.parent;
        }
        return this.ordinal < other.ordinal;
    }
  }

  /** Encodes one projected location (graph_projection.rs:411-437). */
  toValue(): ObjectValue {
    switch (this.kind) {
      case 'Root':
        return objectValueFrom([
          { key: 'kind', value: { kind: 'String', value: 'Root' } },
          { key: 'ordinal', value: wireInteger(this.ordinal) },
        ]);
      case 'Node':
        return objectValueFrom([
          { key: 'kind', value: { kind: 'String', value: 'Node' } },
          { key: 'node', value: wireInteger(this.node) },
        ]);
      case 'SequenceElement':
      case 'MappingKey':
      case 'MappingValue':
        return objectValueFrom([
          { key: 'kind', value: { kind: 'String', value: this.kind } },
          { key: 'parent', value: wireInteger(this.parent) },
          { key: 'ordinal', value: wireInteger(this.ordinal) },
        ]);
    }
  }

  /** Strictly decodes one projected location (graph_projection.rs:439-480). */
  static fromValue(value: PortableValue, path: string): GraphProjectedLocationMessage {
    const kind = firstKindOf(value, path);
    switch (kind) {
      case 'Root': {
        const fields = exactFields(value, ['kind', 'ordinal'], path);
        return GraphProjectedLocationMessage.root(unsigned64(fields[1], `${path}.ordinal`));
      }
      case 'Node': {
        const fields = exactFields(value, ['kind', 'node'], path);
        return GraphProjectedLocationMessage.node(unsigned64(fields[1], `${path}.node`));
      }
      case 'SequenceElement':
      case 'MappingKey':
      case 'MappingValue': {
        const fields = exactFields(value, ['kind', 'parent', 'ordinal'], path);
        const parent = unsigned64(fields[1], `${path}.parent`);
        const ordinal = unsigned64(fields[2], `${path}.ordinal`);
        switch (kind) {
          case 'SequenceElement':
            return GraphProjectedLocationMessage.sequenceElement(parent, ordinal);
          case 'MappingKey':
            return GraphProjectedLocationMessage.mappingKey(parent, ordinal);
          default:
            return GraphProjectedLocationMessage.mappingValue(parent, ordinal);
        }
      }
      default:
        throw invalid(path, 'unknown graph projected location');
    }
  }
}

/** The closed variant order of the projected graph locations. */
function locationRank(kind: string): number {
  switch (kind) {
    case 'Root':
      return 0;
    case 'Node':
      return 1;
    case 'SequenceElement':
      return 2;
    case 'MappingKey':
      return 3;
    case 'MappingValue':
      return 4;
    default:
      return 5;
  }
}

/** Transferable graph origin with caller-assigned identities (graph_projection.rs:56-67). */
export class GraphSourceOriginMessage {
  readonly sourceId: string;
  readonly nodeLocator: string | null;
  readonly startByte: bigint;
  readonly endByte: bigint;
  readonly relation: 'Direct' | 'Reference';

  private constructor(
    sourceId: string,
    nodeLocator: string | null,
    startByte: bigint,
    endByte: bigint,
    relation: 'Direct' | 'Reference',
  ) {
    this.sourceId = sourceId;
    this.nodeLocator = nodeLocator;
    this.startByte = startByte;
    this.endByte = endByte;
    this.relation = relation;
  }

  /** Validates one externalized graph origin (graph_projection.rs:71-98). */
  static new(
    sourceId: string,
    nodeLocator: string | null,
    startByte: bigint,
    endByte: bigint,
    relation: 'Direct' | 'Reference',
  ): GraphSourceOriginMessage {
    if (
      sourceId === '' ||
      sourceId.length > 1024 ||
      startByte > endByte ||
      (nodeLocator !== null && (nodeLocator === '' || nodeLocator.length > 4096))
    ) {
      throw invalid('$.origin', 'invalid source identity, locator, or half-open range');
    }
    if (relation !== 'Direct' && relation !== 'Reference') {
      throw invalid('$.origin', 'unknown graph provenance relation');
    }
    return new GraphSourceOriginMessage(sourceId, nodeLocator, startByte, endByte, relation);
  }

  /** Encodes one graph origin (graph_projection.rs:482-502). */
  toValue(): ObjectValue {
    return objectValueFrom([
      { key: 'source_id', value: { kind: 'String', value: this.sourceId } },
      {
        key: 'node_locator',
        value: this.nodeLocator === null ? { kind: 'Null' } : { kind: 'String', value: this.nodeLocator },
      },
      { key: 'start_byte', value: wireInteger(this.startByte) },
      { key: 'end_byte', value: wireInteger(this.endByte) },
      { key: 'relation', value: { kind: 'String', value: this.relation } },
    ]);
  }

  /** Strictly decodes one graph origin (graph_projection.rs:504-530). */
  static fromValue(value: PortableValue, path: string): GraphSourceOriginMessage {
    const fields = exactFields(
      value,
      ['source_id', 'node_locator', 'start_byte', 'end_byte', 'relation'],
      path,
    );
    let nodeLocator: string | null = null;
    if (fields[1].kind !== 'Null') {
      nodeLocator = stringOf(fields[1], `${path}.node_locator`);
    }
    const relation = stringOf(fields[4], `${path}.relation`);
    if (relation !== 'Direct' && relation !== 'Reference') {
      throw invalid(`${path}.relation`, 'unknown graph provenance relation');
    }
    return GraphSourceOriginMessage.new(
      stringOf(fields[0], `${path}.source_id`),
      nodeLocator,
      unsigned64(fields[2], `${path}.start_byte`),
      unsigned64(fields[3], `${path}.end_byte`),
      relation,
    );
  }
}

/** One graph location and all ordered source origins (graph_projection.rs:111-117). */
export interface GraphProvenanceEntryMessage {
  readonly projected: GraphProjectedLocationMessage;
  readonly origins: readonly GraphSourceOriginMessage[];
}

/** The sorted unique `core.graph-provenance-map@1` record (graph_projection.rs:120-123). */
export class GraphProvenanceMapMessage {
  readonly #entries: readonly GraphProvenanceEntryMessage[];

  private constructor(entries: readonly GraphProvenanceEntryMessage[]) {
    this.#entries = entries;
  }

  /** Validates canonical location order, uniqueness, and non-empty origins (graph_projection.rs:127-139). */
  static new(entries: readonly GraphProvenanceEntryMessage[]): GraphProvenanceMapMessage {
    for (const entry of entries) {
      if (entry.origins.length === 0) {
        throw invalid('$.entries', 'graph provenance locations must be sorted, unique, and have origins');
      }
    }
    for (let index = 1; index < entries.length; index++) {
      if (!entries[index - 1].projected.less(entries[index].projected)) {
        throw invalid('$.entries', 'graph provenance locations must be sorted, unique, and have origins');
      }
    }
    return new GraphProvenanceMapMessage(Object.freeze([...entries]));
  }

  /** Sorted provenance entries. */
  entries(): readonly GraphProvenanceEntryMessage[] {
    return this.#entries;
  }

  /** Encodes `core.graph-provenance-map@1` (graph_projection.rs:163-182). */
  toValue(): ObjectValue {
    return objectValueFrom([
      { key: 'schema', value: { kind: 'String', value: 'core.graph-provenance-map@1' } },
      {
        key: 'entries',
        value: {
          kind: 'Sequence',
          items: this.#entries.map((entry) =>
            objectValueFrom([
              { key: 'projected', value: entry.projected.toValue() },
              {
                key: 'origins',
                value: { kind: 'Sequence', items: entry.origins.map((origin) => origin.toValue()) },
              },
            ]),
          ),
        },
      },
    ]);
  }

  /** Strictly decodes one graph provenance map (graph_projection.rs:185-211). */
  static fromValue(value: PortableValue): GraphProvenanceMapMessage {
    const fields = schemaFields(value, 'core.graph-provenance-map@1', ['entries'], '$');
    const entries = sequenceOf(fields[0], '$.entries').map((entry, index) => {
      const path = `$.entries[${index}]`;
      const entryFields = exactFields(entry, ['projected', 'origins'], path);
      const origins = sequenceOf(entryFields[1], `${path}.origins`).map((origin, originIndex) =>
        GraphSourceOriginMessage.fromValue(origin, `${path}.origins[${originIndex}]`),
      );
      return {
        projected: GraphProjectedLocationMessage.fromValue(entryFields[0], `${path}.projected`),
        origins,
      };
    });
    return GraphProvenanceMapMessage.new(entries);
  }
}

/** Validates every projected location against one exact graph message (graph_projection.rs:351-398). */
function validateGraphLocations(
  message: PortableGraphMessage,
  entries: readonly GraphProvenanceEntryMessage[],
): void {
  const graph = message.graph();
  const layout = canonicalLayoutOf(graph);
  for (let index = 0; index < entries.length; index++) {
    const location = entries[index].projected;
    const path = `$.entries[${index}].projected`;
    switch (location.kind) {
      case 'Root':
        if (location.ordinal >= BigInt(graph.roots.length)) {
          throw invalid(path, 'root ordinal is out of range');
        }
        break;
      case 'Node':
        resolveCanonical(layout, location.node, `${path}.node`);
        break;
      case 'SequenceElement': {
        const parent = resolveCanonical(layout, location.parent, `${path}.parent`);
        const node = graph.nodes[parent];
        if (node.kind !== 'Sequence' || location.ordinal >= BigInt(node.items.length)) {
          throw invalid(path, 'sequence location does not exist');
        }
        break;
      }
      case 'MappingKey':
      case 'MappingValue': {
        const parent = resolveCanonical(layout, location.parent, `${path}.parent`);
        const node = graph.nodes[parent];
        if (node.kind !== 'Mapping' || location.ordinal >= BigInt(node.entries.length)) {
          throw invalid(path, 'mapping location does not exist');
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// core.graph-projection-result@1
// ---------------------------------------------------------------------------

/** The atomic exact `core.graph-projection-result@1` record (graph_projection.rs:215-221). */
export class GraphProjectionResultMessage {
  readonly #completion: Completion;
  readonly #graph: PortableGraphMessage | null;
  readonly #provenance: GraphProvenanceMapMessage;
  readonly #diagnostics: readonly Diagnostic[];

  private constructor(
    completion: Completion,
    graph: PortableGraphMessage | null,
    provenance: GraphProvenanceMapMessage,
    diagnostics: readonly Diagnostic[],
  ) {
    this.#completion = completion;
    this.#graph = graph;
    this.#provenance = provenance;
    this.#diagnostics = diagnostics;
  }

  /** Validates atomic success, produced count, and complete graph provenance (graph_projection.rs:225-255). */
  static new(
    completion: Completion,
    graph: Graph | null,
    provenance: GraphProvenanceMapMessage,
    diagnostics: readonly Diagnostic[],
  ): GraphProjectionResultMessage {
    const success = completion.status === 'Success';
    if (
      success !== (graph !== null) ||
      (success && completion.produced !== 1n) ||
      (!success && completion.produced !== 0n)
    ) {
      throw invalid('$', 'only successful single-result projection may carry a graph');
    }
    const message = graph !== null ? PortableGraphMessage.fromGraph(graph, defaultPgceLimits()) : null;
    if (message !== null) {
      validateGraphLocations(message, provenance.entries());
    } else if (provenance.entries().length !== 0) {
      throw invalid('$.provenance', 'failed projection cannot claim completed provenance');
    }
    return new GraphProjectionResultMessage(completion, message, provenance, diagnostics);
  }

  /** Explicit terminal state. */
  completion(): Completion {
    return this.#completion;
  }

  /** Complete graph only on success. */
  graph(): PortableGraphMessage | null {
    return this.#graph;
  }

  /** Complete provenance only on success. */
  provenance(): GraphProvenanceMapMessage {
    return this.#provenance;
  }

  /** Ordered diagnostics. */
  diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics;
  }

  /** Encodes `core.graph-projection-result@1` (graph_projection.rs:283-305). */
  toValue(): ObjectValue {
    return objectValueFrom([
      { key: 'schema', value: { kind: 'String', value: 'core.graph-projection-result@1' } },
      { key: 'completion', value: this.#completion.toValue() },
      {
        key: 'graph',
        value:
          this.#graph === null
            ? { kind: 'Null' }
            : objectValueFrom([{ key: 'portable_graph', value: this.#graph.toValue() }]),
      },
      { key: 'provenance', value: this.#provenance.toValue() },
      {
        key: 'diagnostics',
        value: {
          kind: 'Sequence',
          items: this.#diagnostics.map((item) => diagnosticToValue(item)),
        },
      },
    ]);
  }

  /** Strictly decodes with explicit graph limits and semantic-model registry (graph_projection.rs:321-348). */
  static fromValue(
    value: PortableValue,
    limits: PgceLimits,
    registry: ErrorCodeRegistry,
  ): GraphProjectionResultMessage {
    const fields = schemaFields(
      value,
      'core.graph-projection-result@1',
      ['completion', 'graph', 'provenance', 'diagnostics'],
      '$',
    );
    const completion = Completion.fromValueWithRegistry(fields[0], registry);
    let graph: PortableGraphMessage | null = null;
    if (fields[1].kind !== 'Null') {
      const graphFields = exactFields(fields[1], ['portable_graph'], '$.graph');
      graph = PortableGraphMessage.fromValue(graphFields[0], limits);
    }
    const provenance = GraphProvenanceMapMessage.fromValue(fields[2]);
    const diagnostics = sequenceOf(fields[3], '$.diagnostics').map((item) =>
      diagnosticFromValue(item, registry),
    );
    return GraphProjectionResultMessage.new(
      completion,
      graph === null ? null : graph.graph(),
      provenance,
      diagnostics,
    );
  }
}

// ---------------------------------------------------------------------------
// core.yaml-query-result@1
// ---------------------------------------------------------------------------

/** One YAML match after caller externalization of its process-local handle (yaml_query.rs:11-17). */
export class YamlMatchLocator {
  readonly sourceId: string;
  readonly nodeLocator: string;
  readonly role: string;
  readonly ordinal: bigint;

  private constructor(sourceId: string, nodeLocator: string, role: string, ordinal: bigint) {
    this.sourceId = sourceId;
    this.nodeLocator = nodeLocator;
    this.role = role;
    this.ordinal = ordinal;
  }

  /** Validates stable identities, a YAML role, and its result ordinal (yaml_query.rs:21-46). */
  static new(sourceId: string, nodeLocator: string, role: string, ordinal: bigint): YamlMatchLocator {
    if (
      sourceId === '' ||
      sourceId.length > 1024 ||
      nodeLocator === '' ||
      nodeLocator.length > 4096 ||
      !isYamlRole(role)
    ) {
      throw invalid('$.yaml_match', 'invalid source, locator, or YAML role');
    }
    return new YamlMatchLocator(sourceId, nodeLocator, role, ordinal);
  }

  /** Explicitly refuses a raw process-local YAML node handle (yaml_query.rs:49-55). */
  static fromProcessLocal(_node: NodeRef): never {
    throw protocolError(
      'ProcessLocalHandle',
      '$.yaml_match.node',
      'NodeRef requires a stable caller locator',
    );
  }

  /** Encodes one YAML match locator (yaml_query.rs:163-173). */
  toValue(): ObjectValue {
    return objectValueFrom([
      { key: 'source_id', value: { kind: 'String', value: this.sourceId } },
      { key: 'node_locator', value: { kind: 'String', value: this.nodeLocator } },
      { key: 'role', value: { kind: 'String', value: this.role } },
      { key: 'ordinal', value: wireInteger(this.ordinal) },
    ]);
  }

  /** Strictly decodes one YAML match locator. */
  static fromValue(value: PortableValue, path: string): YamlMatchLocator {
    const fields = exactFields(value, ['source_id', 'node_locator', 'role', 'ordinal'], path);
    return YamlMatchLocator.new(
      stringOf(fields[0], `${path}.source_id`),
      stringOf(fields[1], `${path}.node_locator`),
      parseYamlRole(stringOf(fields[2], `${path}.role`)),
      unsigned64(fields[3], `${path}.ordinal`),
    );
  }
}

/** The complete or explicitly non-complete `core.yaml-query-result@1` record. */
export class YamlQueryResultMessage {
  readonly #domain: QueryDomain;
  readonly #role: string;
  readonly #matches: readonly YamlMatchLocator[];
  readonly #completion: Completion;
  readonly #diagnostics: readonly Diagnostic[];

  private constructor(
    domain: QueryDomain,
    role: string,
    matches: readonly YamlMatchLocator[],
    completion: Completion,
    diagnostics: readonly Diagnostic[],
  ) {
    this.#domain = domain;
    this.#role = role;
    this.#matches = matches;
    this.#completion = completion;
    this.#diagnostics = diagnostics;
  }

  /** Validates domain/role binding, match ordering, and produced count (yaml_query.rs:94-127). */
  static new(
    domain: QueryDomain,
    role: string,
    locators: readonly YamlMatchLocator[],
    completion: Completion,
    diagnostics: readonly Diagnostic[],
  ): YamlQueryResultMessage {
    if (!yamlDomainAcceptsRole(domain, role)) {
      throw invalid('$', 'YAML query domain and result role are inconsistent');
    }
    const produced = BigInt(locators.length);
    if (
      completion.produced !== produced ||
      locators.some((locator) => locator.role !== role) ||
      locators.some((locator, index) => index > 0 && locator.ordinal <= locators[index - 1].ordinal)
    ) {
      throw invalid('$', 'completion count, role, or YAML match ordinals are inconsistent');
    }
    return new YamlQueryResultMessage(domain, role, locators, completion, diagnostics);
  }

  /** Exact YAML query domain. */
  domain(): QueryDomain {
    return this.#domain;
  }

  /** Uniform result role. */
  role(): string {
    return this.#role;
  }

  /** Ordered external match locators. */
  matches(): readonly YamlMatchLocator[] {
    return this.#matches;
  }

  /** Explicit terminal state. */
  completion(): Completion {
    return this.#completion;
  }

  /** Ordered diagnostics. */
  diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics;
  }

  /** Encodes `core.yaml-query-result@1` (yaml_query.rs:161-190). */
  toValue(): ObjectValue {
    return objectValueFrom([
      { key: 'schema', value: { kind: 'String', value: 'core.yaml-query-result@1' } },
      { key: 'domain_id', value: { kind: 'String', value: this.#domain.id } },
      { key: 'domain_version', value: wireInteger(BigInt(this.#domain.version)) },
      { key: 'role', value: { kind: 'String', value: this.#role } },
      {
        key: 'matches',
        value: { kind: 'Sequence', items: this.#matches.map((locator) => locator.toValue()) },
      },
      { key: 'completion', value: this.#completion.toValue() },
      {
        key: 'diagnostics',
        value: {
          kind: 'Sequence',
          items: this.#diagnostics.map((item) => diagnosticToValue(item)),
        },
      },
    ]);
  }

  /** Strictly decodes one externalized YAML query result (yaml_query.rs:198-248). */
  static fromValue(value: PortableValue, registry: ErrorCodeRegistry): YamlQueryResultMessage {
    const fields = schemaFields(
      value,
      'core.yaml-query-result@1',
      ['domain_id', 'domain_version', 'role', 'matches', 'completion', 'diagnostics'],
      '$',
    );
    const domain = newQueryDomain(stringOf(fields[0], '$.domain_id'), unsigned32(fields[1], '$.domain_version'));
    const role = parseYamlRole(stringOf(fields[2], '$.role'));
    const locators = sequenceOf(fields[3], '$.matches').map((item, index) =>
      YamlMatchLocator.fromValue(item, `$.matches[${index}]`),
    );
    const completion = Completion.fromValueWithRegistry(fields[4], registry);
    const diagnostics = sequenceOf(fields[5], '$.diagnostics').map((item) =>
      diagnosticFromValue(item, registry),
    );
    return YamlQueryResultMessage.new(domain, role, locators, completion, diagnostics);
  }
}

const YAML_NATIVE_ROLES = [
  'YamlStream',
  'YamlDocument',
  'YamlNode',
  'YamlMappingEntry',
  'YamlSequenceElement',
  'YamlAnchorDefinition',
  'YamlAliasOccurrence',
] as const;

function isYamlRole(role: string): boolean {
  return (YAML_NATIVE_ROLES as readonly string[]).includes(role) || role === 'YamlSyntaxPiece';
}

function yamlDomainAcceptsRole(domain: QueryDomain, role: string): boolean {
  if (domain.id === 'yaml.native-semantic-query' && domain.version === 1) {
    return (YAML_NATIVE_ROLES as readonly string[]).includes(role);
  }
  if (domain.id === 'yaml.lossless-syntax-query' && domain.version === 1) {
    return role === 'YamlSyntaxPiece';
  }
  return false;
}

function parseYamlRole(value: string): string {
  if (isYamlRole(value)) {
    return value;
  }
  throw invalid('$.role', 'unknown YAML query match role');
}

// ---------------------------------------------------------------------------
// core.ini-query-result@1 and core.java-properties-query-result@1
// ---------------------------------------------------------------------------

/** One INI match after caller externalization of its process-local handle (line_query.rs:17-27). */
export class IniMatchLocator {
  readonly sourceId: string;
  readonly nodeLocator: string;
  readonly role: string;
  readonly ordinal: bigint;

  private constructor(sourceId: string, nodeLocator: string, role: string, ordinal: bigint) {
    this.sourceId = sourceId;
    this.nodeLocator = nodeLocator;
    this.role = role;
    this.ordinal = ordinal;
  }

  /** Validates stable identities, an exact INI role, and its result ordinal (line_query.rs:28-38). */
  static new(sourceId: string, nodeLocator: string, role: string, ordinal: bigint): IniMatchLocator {
    if (
      sourceId === '' ||
      sourceId.length > 1024 ||
      nodeLocator === '' ||
      nodeLocator.length > 4096 ||
      !isIniRole(role)
    ) {
      throw invalid('$.matches', 'invalid source, locator, or line-format role');
    }
    return new IniMatchLocator(sourceId, nodeLocator, role, ordinal);
  }

  /** Explicitly refuses a raw process-local INI node handle (line_query.rs:39-43). */
  static fromProcessLocal(_node: NodeRef): never {
    throw protocolError(
      'ProcessLocalHandle',
      '$.matches.node',
      'INI NodeRef requires a stable caller locator',
    );
  }

  /** Encodes one INI match locator (line_query.rs:447-456). */
  toValue(): ObjectValue {
    return objectValueFrom([
      { key: 'source_id', value: { kind: 'String', value: this.sourceId } },
      { key: 'node_locator', value: { kind: 'String', value: this.nodeLocator } },
      { key: 'role', value: { kind: 'String', value: this.role } },
      { key: 'ordinal', value: wireInteger(this.ordinal) },
    ]);
  }

  /** Strictly decodes one INI match locator. */
  static fromValue(value: PortableValue, path: string): IniMatchLocator {
    const fields = exactFields(value, ['source_id', 'node_locator', 'role', 'ordinal'], path);
    return IniMatchLocator.new(
      stringOf(fields[0], `${path}.source_id`),
      stringOf(fields[1], `${path}.node_locator`),
      parseIniRole(stringOf(fields[2], `${path}.role`)),
      unsigned64(fields[3], `${path}.ordinal`),
    );
  }
}

/** The complete or explicitly non-complete `core.ini-query-result@1` record. */
export class IniQueryResultMessage {
  readonly #domain: QueryDomain;
  readonly #role: string;
  readonly #matches: readonly IniMatchLocator[];
  readonly #completion: Completion;
  readonly #diagnostics: readonly Diagnostic[];

  private constructor(
    domain: QueryDomain,
    role: string,
    matches: readonly IniMatchLocator[],
    completion: Completion,
    diagnostics: readonly Diagnostic[],
  ) {
    this.#domain = domain;
    this.#role = role;
    this.#matches = matches;
    this.#completion = completion;
    this.#diagnostics = diagnostics;
  }

  /** Validates the exact INI domain/role matrix, ordering, and produced count (line_query.rs:73-94). */
  static new(
    domain: QueryDomain,
    role: string,
    matches: readonly IniMatchLocator[],
    completion: Completion,
    diagnostics: readonly Diagnostic[],
  ): IniQueryResultMessage {
    if (!iniDomainAcceptsRole(domain, role)) {
      throw invalid('$', 'line-format query domain and result role are inconsistent');
    }
    const produced = BigInt(matches.length);
    if (
      completion.produced !== produced ||
      matches.some((locator) => locator.role !== role) ||
      matches.some((locator, index) => index > 0 && locator.ordinal <= matches[index - 1].ordinal)
    ) {
      throw invalid('$', 'completion count, role, or match ordinals are inconsistent');
    }
    return new IniQueryResultMessage(domain, role, matches, completion, diagnostics);
  }

  /** Exact INI query domain. */
  domain(): QueryDomain {
    return this.#domain;
  }

  /** Uniform result role. */
  role(): string {
    return this.#role;
  }

  /** Ordered external INI match locators. */
  matches(): readonly IniMatchLocator[] {
    return this.#matches;
  }

  /** Explicit terminal state. */
  completion(): Completion {
    return this.#completion;
  }

  /** Ordered diagnostics. */
  diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics;
  }

  /** Encodes `core.ini-query-result@1` (line_query.rs:462-474). */
  toValue(): ObjectValue {
    return objectValueFrom([
      { key: 'schema', value: { kind: 'String', value: 'core.ini-query-result@1' } },
      { key: 'domain_id', value: { kind: 'String', value: this.#domain.id } },
      { key: 'domain_version', value: wireInteger(BigInt(this.#domain.version)) },
      { key: 'role', value: { kind: 'String', value: this.#role } },
      {
        key: 'matches',
        value: { kind: 'Sequence', items: this.#matches.map((locator) => locator.toValue()) },
      },
      { key: 'completion', value: this.#completion.toValue() },
      {
        key: 'diagnostics',
        value: {
          kind: 'Sequence',
          items: this.#diagnostics.map((item) => diagnosticToValue(item)),
        },
      },
    ]);
  }

  /** Strictly decodes one externalized INI query result (line_query.rs:157-177). */
  static fromValue(value: PortableValue, registry: ErrorCodeRegistry): IniQueryResultMessage {
    const fields = schemaFields(
      value,
      'core.ini-query-result@1',
      ['domain_id', 'domain_version', 'role', 'matches', 'completion', 'diagnostics'],
      '$',
    );
    const domain = newQueryDomain(stringOf(fields[0], '$.domain_id'), unsigned32(fields[1], '$.domain_version'));
    const role = parseIniRole(stringOf(fields[2], '$.role'));
    const matches = sequenceOf(fields[3], '$.matches').map((item, index) =>
      IniMatchLocator.fromValue(item, `$.matches[${index}]`),
    );
    const completion = Completion.fromValueWithRegistry(fields[4], registry);
    const diagnostics = sequenceOf(fields[5], '$.diagnostics').map((item) =>
      diagnosticFromValue(item, registry),
    );
    return IniQueryResultMessage.new(domain, role, matches, completion, diagnostics);
  }
}

const INI_NATIVE_ROLES = [
  'IniDocument',
  'IniPhysicalLine',
  'IniLogicalLine',
  'IniSection',
  'IniDefaultSection',
  'IniEntry',
  'IniErrorLine',
] as const;

function isIniRole(role: string): boolean {
  return (INI_NATIVE_ROLES as readonly string[]).includes(role) || role === 'IniSyntaxPiece';
}

function iniDomainAcceptsRole(domain: QueryDomain, role: string): boolean {
  if (domain.id === 'ini.native-semantic-query' && domain.version === 1) {
    return (INI_NATIVE_ROLES as readonly string[]).includes(role);
  }
  if (domain.id === 'ini.lossless-syntax-query' && domain.version === 1) {
    return role === 'IniSyntaxPiece';
  }
  return false;
}

function parseIniRole(value: string): string {
  if (isIniRole(value)) {
    return value;
  }
  throw invalid('$.role', 'unknown INI query match role');
}

/** One Java Properties match after externalization of its process-local handle (line_query.rs:181-191). */
export class JavaPropertiesMatchLocator {
  readonly sourceId: string;
  readonly nodeLocator: string;
  readonly role: string;
  readonly ordinal: bigint;

  private constructor(sourceId: string, nodeLocator: string, role: string, ordinal: bigint) {
    this.sourceId = sourceId;
    this.nodeLocator = nodeLocator;
    this.role = role;
    this.ordinal = ordinal;
  }

  /** Validates stable identities, an exact Properties role, and its result ordinal (line_query.rs:192-202). */
  static new(
    sourceId: string,
    nodeLocator: string,
    role: string,
    ordinal: bigint,
  ): JavaPropertiesMatchLocator {
    if (
      sourceId === '' ||
      sourceId.length > 1024 ||
      nodeLocator === '' ||
      nodeLocator.length > 4096 ||
      !isPropertiesRole(role)
    ) {
      throw invalid('$.matches', 'invalid source, locator, or line-format role');
    }
    return new JavaPropertiesMatchLocator(sourceId, nodeLocator, role, ordinal);
  }

  /** Explicitly refuses a raw process-local Properties node handle (line_query.rs:203-207). */
  static fromProcessLocal(_node: NodeRef): never {
    throw protocolError(
      'ProcessLocalHandle',
      '$.matches.node',
      'Java Properties NodeRef requires a stable caller locator',
    );
  }

  /** Encodes one Java Properties match locator (line_query.rs:447-456). */
  toValue(): ObjectValue {
    return objectValueFrom([
      { key: 'source_id', value: { kind: 'String', value: this.sourceId } },
      { key: 'node_locator', value: { kind: 'String', value: this.nodeLocator } },
      { key: 'role', value: { kind: 'String', value: this.role } },
      { key: 'ordinal', value: wireInteger(this.ordinal) },
    ]);
  }

  /** Strictly decodes one Java Properties match locator. */
  static fromValue(value: PortableValue, path: string): JavaPropertiesMatchLocator {
    const fields = exactFields(value, ['source_id', 'node_locator', 'role', 'ordinal'], path);
    return JavaPropertiesMatchLocator.new(
      stringOf(fields[0], `${path}.source_id`),
      stringOf(fields[1], `${path}.node_locator`),
      parsePropertiesRole(stringOf(fields[2], `${path}.role`)),
      unsigned64(fields[3], `${path}.ordinal`),
    );
  }
}

/** The complete or explicitly non-complete `core.java-properties-query-result@1` record. */
export class JavaPropertiesQueryResultMessage {
  readonly #domain: QueryDomain;
  readonly #role: string;
  readonly #matches: readonly JavaPropertiesMatchLocator[];
  readonly #completion: Completion;
  readonly #diagnostics: readonly Diagnostic[];

  private constructor(
    domain: QueryDomain,
    role: string,
    matches: readonly JavaPropertiesMatchLocator[],
    completion: Completion,
    diagnostics: readonly Diagnostic[],
  ) {
    this.#domain = domain;
    this.#role = role;
    this.#matches = matches;
    this.#completion = completion;
    this.#diagnostics = diagnostics;
  }

  /** Validates the exact Properties domain/role matrix, ordering, and produced count (line_query.rs:238-259). */
  static new(
    domain: QueryDomain,
    role: string,
    matches: readonly JavaPropertiesMatchLocator[],
    completion: Completion,
    diagnostics: readonly Diagnostic[],
  ): JavaPropertiesQueryResultMessage {
    if (!propertiesDomainAcceptsRole(domain, role)) {
      throw invalid('$', 'line-format query domain and result role are inconsistent');
    }
    const produced = BigInt(matches.length);
    if (
      completion.produced !== produced ||
      matches.some((locator) => locator.role !== role) ||
      matches.some((locator, index) => index > 0 && locator.ordinal <= matches[index - 1].ordinal)
    ) {
      throw invalid('$', 'completion count, role, or match ordinals are inconsistent');
    }
    return new JavaPropertiesQueryResultMessage(domain, role, matches, completion, diagnostics);
  }

  /** Exact Java Properties query domain. */
  domain(): QueryDomain {
    return this.#domain;
  }

  /** Uniform result role. */
  role(): string {
    return this.#role;
  }

  /** Ordered external Java Properties match locators. */
  matches(): readonly JavaPropertiesMatchLocator[] {
    return this.#matches;
  }

  /** Explicit terminal state. */
  completion(): Completion {
    return this.#completion;
  }

  /** Ordered diagnostics. */
  diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics;
  }

  /** Encodes `core.java-properties-query-result@1` (line_query.rs:462-474). */
  toValue(): ObjectValue {
    return objectValueFrom([
      { key: 'schema', value: { kind: 'String', value: 'core.java-properties-query-result@1' } },
      { key: 'domain_id', value: { kind: 'String', value: this.#domain.id } },
      { key: 'domain_version', value: wireInteger(BigInt(this.#domain.version)) },
      { key: 'role', value: { kind: 'String', value: this.#role } },
      {
        key: 'matches',
        value: { kind: 'Sequence', items: this.#matches.map((locator) => locator.toValue()) },
      },
      { key: 'completion', value: this.#completion.toValue() },
      {
        key: 'diagnostics',
        value: {
          kind: 'Sequence',
          items: this.#diagnostics.map((item) => diagnosticToValue(item)),
        },
      },
    ]);
  }

  /** Strictly decodes one externalized Java Properties query result (line_query.rs:322-346). */
  static fromValue(
    value: PortableValue,
    registry: ErrorCodeRegistry,
  ): JavaPropertiesQueryResultMessage {
    const fields = schemaFields(
      value,
      'core.java-properties-query-result@1',
      ['domain_id', 'domain_version', 'role', 'matches', 'completion', 'diagnostics'],
      '$',
    );
    const domain = newQueryDomain(stringOf(fields[0], '$.domain_id'), unsigned32(fields[1], '$.domain_version'));
    const role = parsePropertiesRole(stringOf(fields[2], '$.role'));
    const matches = sequenceOf(fields[3], '$.matches').map((item, index) =>
      JavaPropertiesMatchLocator.fromValue(item, `$.matches[${index}]`),
    );
    const completion = Completion.fromValueWithRegistry(fields[4], registry);
    const diagnostics = sequenceOf(fields[5], '$.diagnostics').map((item) =>
      diagnosticFromValue(item, registry),
    );
    return JavaPropertiesQueryResultMessage.new(domain, role, matches, completion, diagnostics);
  }
}

const PROPERTIES_NATIVE_ROLES = [
  'PropertiesDocument',
  'PropertiesNaturalLine',
  'PropertiesLogicalLine',
  'PropertiesProperty',
  'PropertiesComment',
  'PropertiesEscape',
  'PropertiesErrorLine',
] as const;

function isPropertiesRole(role: string): boolean {
  return (PROPERTIES_NATIVE_ROLES as readonly string[]).includes(role) || role === 'PropertiesSyntaxPiece';
}

function propertiesDomainAcceptsRole(domain: QueryDomain, role: string): boolean {
  if (domain.id === 'java-properties.native-semantic-query' && domain.version === 1) {
    return (PROPERTIES_NATIVE_ROLES as readonly string[]).includes(role);
  }
  if (domain.id === 'java-properties.lossless-syntax-query' && domain.version === 1) {
    return role === 'PropertiesSyntaxPiece';
  }
  return false;
}

function parsePropertiesRole(value: string): string {
  if (isPropertiesRole(value)) {
    return value;
  }
  throw invalid('$.role', 'unknown Java Properties query match role');
}

/** Reads the first `kind` String field of a kind-first record. */
function firstKindOf(value: PortableValue, path: string): string {
  if (value.kind !== 'Object') {
    throw protocolError('WrongType', path, 'expected Object');
  }
  const first = value.entries[0];
  if (first === undefined || first.key !== 'kind' || first.value.kind !== 'String') {
    throw invalid(path, 'kind must be the first String field');
  }
  return first.value.value;
}

// ---------------------------------------------------------------------------
// payload dispatch
// ---------------------------------------------------------------------------

// Full envelope payload validation (payload.rs): every v5/v6 graph record
// decodes its payload through these strict decoders under the registry of
// the semantic-model version that owns the envelope.
registerPayloadValidator('core.portable-graph', 1, (payload) => {
  PortableGraphMessage.fromValue(payload, defaultPgceLimits());
});
registerPayloadValidator('core.graph-query-result', 1, (payload, registry) => {
  GraphQueryResultMessage.fromValue(
    payload,
    defaultPgceLimits(),
    new ErrorCodeRegistry(registry.versionOf()),
  );
});
registerPayloadValidator('core.graph-provenance-map', 1, (payload) => {
  GraphProvenanceMapMessage.fromValue(payload);
});
registerPayloadValidator('core.graph-projection-result', 1, (payload, registry) => {
  GraphProjectionResultMessage.fromValue(
    payload,
    defaultPgceLimits(),
    new ErrorCodeRegistry(registry.versionOf()),
  );
});
registerPayloadValidator('core.yaml-query-result', 1, (payload, registry) => {
  YamlQueryResultMessage.fromValue(payload, new ErrorCodeRegistry(registry.versionOf()));
});
registerPayloadValidator('core.ini-query-result', 1, (payload, registry) => {
  IniQueryResultMessage.fromValue(payload, new ErrorCodeRegistry(registry.versionOf()));
});
registerPayloadValidator('core.java-properties-query-result', 1, (payload, registry) => {
  JavaPropertiesQueryResultMessage.fromValue(payload, new ErrorCodeRegistry(registry.versionOf()));
});
