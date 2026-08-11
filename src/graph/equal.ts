/**
 * Strict PortableGraph equality and deterministic hashing.
 *
 * authority: RFC 0006 §4 (root-preserving ordered graph isomorphism; builder
 * numbering is not semantic); the canonical numbering (lib.rs:542-578); the
 * vectors (conformance/vectors/portable-graph-v1.json:
 * graph.isomorphic-builder-numbering, graph.sharing-is-not-duplication).
 *
 * Design (TypeScript-idiomatic): `equal` compares canonical layouts without
 * recursion through edges, so shared and cyclic graphs are safe (RFC 0006
 * §4: "Consema computes this without recursive expansion"). `hash` is FNV-1a
 * over the canonical PGCE/1 encoding, so equal graphs always hash equal and
 * the hash is identity-order-sensitive and cycle-safe.
 */

import { canonicalOrder } from './graph.ts';
import type { Graph, Node } from './graph.ts';
import { encodePGCE } from './pgce.ts';

// The graph package is independent of the core package (mirroring go/graph,
// which imports only the standard library). FNV-1a 64-bit is reimplemented
// here exactly as Go's hash/fnv provides it for the core package.
const FNV64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** FNV-1a 64-bit hash of a byte sequence, reduced mod 2^64. */
function fnv1a64(bytes: Uint8Array): bigint {
  let hash = FNV64_OFFSET_BASIS;
  for (const octet of bytes) {
    hash ^= BigInt(octet);
    hash = (hash * FNV64_PRIME) & MASK64;
  }
  return hash;
}

/** The canonical numbering of one graph (RFC 0006 §4). */
interface Layout {
  /** Original node indices in deterministic depth-first pre-order. */
  readonly order: number[];
  /** Canonical ID of every original index. */
  readonly canonicalIDs: number[];
}

function layoutOf(graph: Graph): Layout {
  // Completed graphs always traverse cleanly (build validated reachability
  // and depth); a failure here is an internal invariant violation.
  const { order, canonicalIDs } = canonicalOrder(graph.nodes, graph.roots, -1);
  return { order, canonicalIDs };
}

/**
 * Strict PortableGraph equality (RFC 0006 §4): two graphs are equal when
 * there is a root-preserving ordered graph isomorphism preserving root
 * order, node kind, exact resolved tag, exact canonical scalar content,
 * sequence edge order, mapping association order (including duplicates),
 * key/value edge roles, and shared-reference and cycle topology.
 */
export function equal(a: Graph, b: Graph): boolean {
  if (a.roots.length !== b.roots.length || a.nodes.length !== b.nodes.length || a.edgeCount !== b.edgeCount) {
    return false;
  }
  const left = layoutOf(a);
  const right = layoutOf(b);
  for (let i = 0; i < a.roots.length; i++) {
    if (left.canonicalIDs[a.roots[i].index] !== right.canonicalIDs[b.roots[i].index]) {
      return false;
    }
  }
  for (let i = 0; i < left.order.length; i++) {
    if (!canonicalNodeEqual(a.nodes[left.order[i]], left.canonicalIDs, b.nodes[right.order[i]], right.canonicalIDs)) {
      return false;
    }
  }
  return true;
}

/** Compares two nodes under their canonical ID mappings (lib.rs:634-661). */
function canonicalNodeEqual(
  left: Node,
  leftIDs: number[],
  right: Node,
  rightIDs: number[],
): boolean {
  if (left.kind !== right.kind || left.tag !== right.tag) {
    return false;
  }
  switch (left.kind) {
    case 'Scalar':
      return left.content === (right as typeof left).content;
    case 'Sequence':
      if (left.items.length !== (right as typeof left).items.length) {
        return false;
      }
      for (let i = 0; i < left.items.length; i++) {
        if (leftIDs[left.items[i].index] !== rightIDs[(right as typeof left).items[i].index]) {
          return false;
        }
      }
      return true;
    case 'Mapping':
      if (left.entries.length !== (right as typeof left).entries.length) {
        return false;
      }
      for (let i = 0; i < left.entries.length; i++) {
        if (
          leftIDs[left.entries[i].key.index] !== rightIDs[(right as typeof left).entries[i].key.index] ||
          leftIDs[left.entries[i].value.index] !== rightIDs[(right as typeof left).entries[i].value.index]
        ) {
          return false;
        }
      }
      return true;
  }
}

/**
 * Deterministic 64-bit hash consistent with `equal` (RFC 0006 §4): FNV-1a
 * over the canonical PGCE/1 encoding of the graph, so equal graphs hash
 * equal exactly when their encoded bytes are identical.
 */
export function hash(graph: Graph): bigint {
  let encoded: Uint8Array;
  try {
    encoded = encodePGCE(graph);
  } catch {
    return 0n;
  }
  return fnv1a64(encoded);
}

/** Narrowing helper for sequence nodes. */
export function isSequenceNode(node: Node): node is Extract<Node, { readonly kind: 'Sequence' }> {
  return node.kind === 'Sequence';
}

/** Narrowing helper for mapping nodes. */
export function isMappingNode(node: Node): node is Extract<Node, { readonly kind: 'Mapping' }> {
  return node.kind === 'Mapping';
}

/** Narrowing helper for scalar nodes. */
export function isScalarNode(node: Node): node is Extract<Node, { readonly kind: 'Scalar' }> {
  return node.kind === 'Scalar';
}
