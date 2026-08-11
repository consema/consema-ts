/**
 * PGCE/1 — Portable Graph Canonical Encoding / 1.
 *
 * authority: the Rust reference codec is the frozen byte authority
 * (crates/consema-graph/src/pgce.rs); the golden byte vectors are pinned by
 * conformance/vectors/portable-graph-v1.json (cases pgce.empty-vector,
 * pgce.scalar-vector, pgce.reject-nonminimal-varint,
 * pgce.reject-noncanonical-node-order). Wire constants:
 *  - stream magic is the ASCII octets "PGCE" (pgce.rs:12)
 *  - version is minimal unsigned LEB128 1 (pgce.rs:14)
 *  - node kind octets are 0x20 (Scalar), 0x40 (Sequence), 0x41 (Mapping)
 *    (pgce.rs:16-18)
 *  - all counts/lengths/references are minimal unsigned LEB128
 *  - root and edge references carry canonical IDs assigned in first-
 *    discovery order (pgce.rs:229-275)
 *  - decoding revalidates canonical node numbering and re-encodes for byte
 *    equality (pgce.rs:497-506)
 *  - limits: pgce.rs:41-54 (64 MiB stream, 1,000,000 roots, 1,000,000
 *    nodes, 2,000,000 edges, 1,000,000 container entries, 1 MiB tag,
 *    64 MiB scalar, depth 256)
 *
 * Design (TypeScript-idiomatic): encoding walks the canonical layout once
 * (after exact size measurement for bounded encodes); decoding reserves all
 * node identities, then defines them in wire order through the Builder so
 * construction invariants are enforced by the same code path as the model.
 * Failures throw the typed PGCEError / GraphError (see errors.ts).
 */

import { Builder, defaultLimits, canonicalOrder } from './graph.ts';
import type { Graph, NodeID, Limits } from './graph.ts';
import { GraphError, PGCEError } from './errors.ts';

/** PGCE/1 stream magic (ASCII "PGCE"). */
export const PGCE_MAGIC = new Uint8Array([0x50, 0x47, 0x43, 0x45]);
/** PGCE/1 version. */
export const PGCE_VERSION = 1n;

/** Node kind octets (crates/consema-graph/src/pgce.rs:16-18). */
export const NODE_SCALAR = 0x20;
export const NODE_SEQUENCE = 0x40;
export const NODE_MAPPING = 0x41;

/** Bounded PGCE encode/decode limits (pgce.rs:21-54). */
export interface PgceLimits {
  readonly maxStreamBytes: number;
  readonly maxRoots: number;
  readonly maxNodes: number;
  readonly maxEdges: number;
  readonly maxContainerEntries: number;
  readonly maxTagBytes: number;
  readonly maxScalarBytes: number;
  readonly maxTraversalDepth: number;
}

/** The frozen defaults (pgce.rs:41-54). */
export function defaultPgceLimits(): PgceLimits {
  return {
    maxStreamBytes: 64 << 20,
    maxRoots: 1_000_000,
    maxNodes: 1_000_000,
    maxEdges: 2_000_000,
    maxContainerEntries: 1_000_000,
    maxTagBytes: 1 << 20,
    maxScalarBytes: 64 << 20,
    maxTraversalDepth: 256,
  };
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

/** Minimal unsigned LEB128 encoding (pgce.rs:398-410). */
function varintBytes(value: bigint): number[] {
  const out: number[] = [];
  let v = value;
  for (;;) {
    let octet = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) {
      octet |= 0x80;
    }
    out.push(octet);
    if (v === 0n) {
      return out;
    }
  }
}

/** Encoded length of one minimal unsigned LEB128 (pgce.rs:412-419). */
function varintSize(value: bigint): number {
  let size = 1;
  let v = value;
  while (v >= 0x80n) {
    v >>= 7n;
    size++;
  }
  return size;
}

/**
 * Encodes one graph as a complete canonical PGCE/1 stream with the default
 * bounded policy (pgce.rs:219-221).
 */
export function encodePGCE(graph: Graph): Uint8Array {
  return encodePGCERecords(graph, defaultPgceLimits());
}

/**
 * Encodes one complete canonical PGCE/1 stream after exact size measurement
 * (pgce.rs:224-275). Exceeding any limit throws the typed resource-limit
 * error with no partial output.
 */
export function encodePGCERecords(graph: Graph, limits: PgceLimits): Uint8Array {
  validateGraphLimits(graph, limits);
  const layout = layoutOf(graph);
  const size = measure(graph, layout.canonicalIDs, layout.order, limits);
  if (size > limits.maxStreamBytes) {
    throw new PGCEError('ResourceLimit', { field: 'stream-bytes' });
  }
  const out: number[] = [...PGCE_MAGIC];
  out.push(...varintBytes(PGCE_VERSION));
  out.push(...varintBytes(BigInt(graph.roots.length)));
  out.push(...varintBytes(BigInt(graph.nodes.length)));
  for (const root of graph.roots) {
    out.push(...varintBytes(BigInt(canonicalId(layout.canonicalIDs, root))));
  }
  for (const index of layout.order) {
    const node = graph.nodes[index];
    switch (node.kind) {
      case 'Scalar':
        out.push(NODE_SCALAR);
        writeBlob(out, textBytes(node.tag));
        writeBlob(out, textBytes(node.content));
        break;
      case 'Sequence':
        out.push(NODE_SEQUENCE);
        writeBlob(out, textBytes(node.tag));
        out.push(...varintBytes(BigInt(node.items.length)));
        for (const item of node.items) {
          out.push(...varintBytes(BigInt(canonicalId(layout.canonicalIDs, item))));
        }
        break;
      case 'Mapping':
        out.push(NODE_MAPPING);
        writeBlob(out, textBytes(node.tag));
        out.push(...varintBytes(BigInt(node.entries.length)));
        for (const entry of node.entries) {
          out.push(...varintBytes(BigInt(canonicalId(layout.canonicalIDs, entry.key))));
          out.push(...varintBytes(BigInt(canonicalId(layout.canonicalIDs, entry.value))));
        }
        break;
    }
  }
  return Uint8Array.from(out);
}

function writeBlob(out: number[], bytes: Uint8Array): void {
  out.push(...varintBytes(BigInt(bytes.length)));
  out.push(...bytes);
}

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** The canonical first-discovery layout of a completed graph. */
function layoutOf(graph: Graph): { order: number[]; canonicalIDs: number[] } {
  // Completed graphs traverse cleanly; a failure is an internal invariant
  // violation (pgce.rs:521-533).
  return canonicalOrder(graph.nodes, graph.roots, -1);
}

function canonicalId(canonicalIDs: number[], id: NodeID): number {
  const value = canonicalIDs[id.index];
  if (value === undefined) {
    throw new PGCEError('InvalidValue');
  }
  return value;
}

/** Encode-side limit validation (pgce.rs:277-284). */
function validateGraphLimits(graph: Graph, limits: PgceLimits): void {
  checkEncodeLimit('graph-roots', graph.roots.length, limits.maxRoots);
  checkEncodeLimit('graph-nodes', graph.nodes.length, limits.maxNodes);
  checkEncodeLimit('graph-edges', graph.edgeCount, limits.maxEdges);
  try {
    canonicalOrder(graph.nodes, graph.roots, limits.maxTraversalDepth);
  } catch (error) {
    throw mapBuildToEncode(error as GraphError);
  }
}

function checkEncodeLimit(name: string, observed: number, limit: number): void {
  if (observed > limit) {
    throw new PGCEError('ResourceLimit', { field: name });
  }
}

/** Exact stream size measurement (pgce.rs:286-339). */
function measure(
  graph: Graph,
  canonicalIDs: number[],
  order: number[],
  limits: PgceLimits,
): number {
  let size = PGCE_MAGIC.length;
  size += varintSize(PGCE_VERSION);
  size += varintSize(BigInt(graph.roots.length));
  size += varintSize(BigInt(graph.nodes.length));
  for (const root of graph.roots) {
    size += varintSize(BigInt(canonicalId(canonicalIDs, root)));
  }
  for (const index of order) {
    const node = graph.nodes[index];
    checkEncodeLimit('tag-bytes', textBytes(node.tag).length, limits.maxTagBytes);
    size += 1;
    size += blobSize(node.tag);
    switch (node.kind) {
      case 'Scalar':
        checkEncodeLimit('scalar-bytes', textBytes(node.content).length, limits.maxScalarBytes);
        size += blobSize(node.content);
        break;
      case 'Sequence':
        checkEncodeLimit('container-entries', node.items.length, limits.maxContainerEntries);
        size += varintSize(BigInt(node.items.length));
        for (const item of node.items) {
          size += varintSize(BigInt(canonicalId(canonicalIDs, item)));
        }
        break;
      case 'Mapping':
        checkEncodeLimit('container-entries', node.entries.length, limits.maxContainerEntries);
        size += varintSize(BigInt(node.entries.length));
        for (const entry of node.entries) {
          size += varintSize(BigInt(canonicalId(canonicalIDs, entry.key)));
          size += varintSize(BigInt(canonicalId(canonicalIDs, entry.value)));
        }
        break;
    }
  }
  return size;
}

function blobSize(text: string): number {
  const length = textBytes(text).length;
  return varintSize(BigInt(length)) + length;
}

function mapBuildToEncode(error: GraphError): PGCEError {
  return new PGCEError('ResourceLimit', { field: error.field });
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Strictly decodes one canonical PGCE/1 stream (pgce.rs:422-507).
 */
export function decodePGCE(stream: Uint8Array, limits: PgceLimits): Graph {
  if (stream.length > limits.maxStreamBytes) {
    throw new PGCEError('ResourceLimit', { field: 'stream-bytes' });
  }
  const decoder = new PgceDecoder(stream, limits);
  if (!magicEqual(decoder.take(PGCE_MAGIC.length))) {
    throw new PGCEError('InvalidMagic');
  }
  const version = decoder.varint();
  if (version !== PGCE_VERSION) {
    throw new PGCEError('UnsupportedVersion', { value: version });
  }
  const rootCount = decoder.count('graph-roots', limits.maxRoots);
  const nodeCount = decoder.count('graph-nodes', limits.maxNodes);

  const builder = new Builder(graphLimitsOf(limits));
  const ids: NodeID[] = [];
  for (let i = 0; i < nodeCount; i++) {
    ids.push(builder.reserveNode());
  }

  const rootIndices: number[] = [];
  for (let i = 0; i < rootCount; i++) {
    rootIndices.push(decoder.reference(nodeCount));
  }
  for (const index of rootIndices) {
    builder.pushRoot(ids[index]);
  }

  for (let index = 0; index < nodeCount; index++) {
    const kind = decoder.byte();
    const tag = decoder.string('tag-bytes', limits.maxTagBytes);
    switch (kind) {
      case NODE_SCALAR: {
        const content = decoder.string('scalar-bytes', limits.maxScalarBytes);
        try {
          builder.defineScalar(ids[index], tag, content);
        } catch (error) {
          throw mapBuildToDecode(error as GraphError);
        }
        break;
      }
      case NODE_SEQUENCE: {
        const count = decoder.count('container-entries', limits.maxContainerEntries);
        decoder.addEdges(count);
        const items: NodeID[] = [];
        for (let i = 0; i < count; i++) {
          items.push(ids[decoder.reference(nodeCount)]);
        }
        try {
          builder.defineSequence(ids[index], tag, items);
        } catch (error) {
          throw mapBuildToDecode(error as GraphError);
        }
        break;
      }
      case NODE_MAPPING: {
        const count = decoder.count('container-entries', limits.maxContainerEntries);
        const edges = count * 2;
        decoder.addEdges(edges);
        const entries: { key: NodeID; value: NodeID }[] = [];
        for (let i = 0; i < count; i++) {
          const key = ids[decoder.reference(nodeCount)];
          const value = ids[decoder.reference(nodeCount)];
          entries.push({ key, value });
        }
        try {
          builder.defineMapping(ids[index], tag, entries);
        } catch (error) {
          throw mapBuildToDecode(error as GraphError);
        }
        break;
      }
      default:
        throw new PGCEError('UnknownNodeKind', { value: BigInt(kind) });
    }
  }
  if (!decoder.isEmpty()) {
    throw new PGCEError('TrailingBytes');
  }
  let graph: Graph;
  try {
    graph = builder.build();
  } catch (error) {
    throw mapBuildToDecode(error as GraphError);
  }
  // Canonical node-numbering revalidation (pgce.rs:497-501).
  const layout = layoutOf(graph);
  for (let i = 0; i < layout.order.length; i++) {
    if (layout.order[i] !== i) {
      throw new PGCEError('NonCanonicalNodeOrder');
    }
  }
  // Byte-identity re-encode check (pgce.rs:502-505).
  let encoded: Uint8Array;
  try {
    encoded = encodePGCERecords(graph, limits);
  } catch (error) {
    throw mapEncodeToDecode(error as PGCEError);
  }
  if (!byteArraysEqual(encoded, stream)) {
    throw new PGCEError('NonCanonicalEncoding');
  }
  return graph;
}

function mapBuildToDecode(error: GraphError): PGCEError {
  switch (error.kind) {
    case 'ResourceLimit':
      return new PGCEError('ResourceLimit', { field: error.field });
    case 'InvalidTag':
      return new PGCEError('InvalidTag');
    default:
      return new PGCEError('InvalidGraph', { cause: error });
  }
}

function mapEncodeToDecode(error: PGCEError): PGCEError {
  if (error.kind === 'ResourceLimit') {
    return new PGCEError('ResourceLimit', { field: error.field });
  }
  return new PGCEError('VarintOverflow');
}

function magicEqual(bytes: Uint8Array): boolean {
  return byteArraysEqual(bytes, PGCE_MAGIC);
}

function byteArraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** Strict streaming decoder over one PGCE/1 stream (pgce.rs:509-595). */
class PgceDecoder {
  private readonly bytes: Uint8Array;
  private offset = 0;
  private readonly limits: PgceLimits;
  private edges = 0;

  constructor(bytes: Uint8Array, limits: PgceLimits) {
    this.bytes = bytes;
    this.limits = limits;
  }

  byte(): number {
    const octet = this.bytes[this.offset];
    if (octet === undefined) {
      throw new PGCEError('UnexpectedEnd');
    }
    this.offset += 1;
    return octet;
  }

  take(count: number): Uint8Array {
    if (this.offset + count > this.bytes.length) {
      throw new PGCEError('UnexpectedEnd');
    }
    const value = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return value;
  }

  /** Reads one unsigned varint, rejecting non-minimal forms and 64-bit overflow (pgce.rs:539-557). */
  varint(): bigint {
    const start = this.offset;
    let value = 0n;
    for (let shift = 0n; shift <= 63n; shift += 7n) {
      const octet = this.byte();
      const payload = BigInt(octet & 0x7f);
      if (shift === 63n && payload > 1n) {
        throw new PGCEError('VarintOverflow');
      }
      value |= payload << shift;
      if ((octet & 0x80) === 0) {
        if (this.offset - start !== varintSize(value)) {
          throw new PGCEError('NonMinimalVarint');
        }
        return value;
      }
    }
    throw new PGCEError('VarintOverflow');
  }

  /** Reads one varint count and enforces the named limit (pgce.rs:559-564). */
  count(name: string, limit: number): number {
    const value = this.varint();
    if (value > BigInt(limit)) {
      throw new PGCEError('ResourceLimit', { field: name });
    }
    return Number(value);
  }

  /** Reads one node reference within node_count (pgce.rs:566-574). */
  reference(nodeCount: number): number {
    const value = this.varint();
    if (value >= BigInt(nodeCount)) {
      throw new PGCEError('ReferenceOutOfRange', { value });
    }
    return Number(value);
  }

  /** Reads one length-delimited string with the named limit and UTF-8 validation (pgce.rs:576-586). */
  string(limitName: string, limit: number): string {
    const length = this.count(limitName, limit);
    const bytes = this.take(length);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new PGCEError('InvalidUtf8');
    }
  }

  /** Counts edges and enforces maxEdges (pgce.rs:588-594). */
  addEdges(count: number): void {
    this.edges += count;
    if (this.edges > this.limits.maxEdges) {
      throw new PGCEError('ResourceLimit', { field: 'graph-edges' });
    }
  }

  isEmpty(): boolean {
    return this.offset === this.bytes.length;
  }
}

/** Narrowing helpers for tests and consumers. */
export function emptyGraph(): Graph {
  return new Builder(defaultLimits()).build();
}
