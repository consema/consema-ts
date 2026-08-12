/**
 * The PortableGraph model (RFC 0006; RFC 0016 §4.1:144-146).
 *
 * authority: RFC 0006 §2 (immutable rooted, directed, ordered, tagged graphs
 * with graph-local node identity, sharing and cycles); the Rust reference
 * crate (crates/consema-graph/src/lib.rs); the golden PGCE vectors
 * (conformance/vectors/portable-graph-v1.json). The graph layer introduces
 * no value kinds of its own — scalar nodes carry resolved tag identifiers
 * and canonical content strings (RFC 0006 §2).
 *
 * Design (TypeScript-idiomatic): the node model is a closed discriminated
 * union over `kind` ('Scalar' | 'Sequence' | 'Mapping'). A graph is an
 * immutable value; the Builder is the mutable reserve/define/root lifecycle
 * (RFC 0006 §3). Graph-local identity pairs a per-process builder counter
 * with a builder-local index; numeric IDs are never part of equality or
 * canonical encoding (RFC 0006 §4). Failures throw the typed GraphError
 * (see errors.ts).
 */

import { GraphError } from './errors.ts';

/** The three stable node kinds, in the RFC 0006 §2 order. */
export type NodeKind = 'Scalar' | 'Sequence' | 'Mapping';

/** A graph-local node identity assigned by one Builder (RFC 0006 §2). */
export interface NodeID {
  /** Identity of the owning builder; the zero value never identifies a builder. */
  readonly graph: bigint;
  /** Builder-local index of the reserved slot. */
  readonly index: number;
}

/** One ordered mapping association with arbitrary graph-node key and value (RFC 0006 §2). */
export interface MappingEntry {
  readonly key: NodeID;
  readonly value: NodeID;
}

/** One immutable tagged graph node (the Rust GraphNode, lib.rs:94-157). */
export type Node =
  | {
      readonly kind: 'Scalar';
      readonly tag: string;
      /** The producer's canonical content for the tag (RFC 0006 §2). */
      readonly content: string;
    }
  | {
      readonly kind: 'Sequence';
      readonly tag: string;
      readonly items: readonly NodeID[];
    }
  | {
      readonly kind: 'Mapping';
      readonly tag: string;
      readonly entries: readonly MappingEntry[];
    };

/** Resource bounds for graph construction and traversal (RFC 0006 §6). */
export interface Limits {
  readonly maxRoots: number;
  readonly maxNodes: number;
  readonly maxEdges: number;
  readonly maxContainerEntries: number;
  readonly maxTagBytes: number;
  readonly maxScalarBytes: number;
  readonly maxTraversalDepth: number;
}

/** The frozen defaults (crates/consema-graph/src/lib.rs:178-190). */
export function defaultLimits(): Limits {
  return {
    maxRoots: 1_000_000,
    maxNodes: 1_000_000,
    maxEdges: 2_000_000,
    maxContainerEntries: 1_000_000,
    maxTagBytes: 1 << 20,
    maxScalarBytes: 64 << 20,
    maxTraversalDepth: 256,
  };
}

/** Per-process builder identity; identities start at 1 (lib.rs:22). */
let nextGraphIdentity = 1n;

/** One immutable rooted, directed, ordered, tagged graph value (PortableGraph; RFC 0006 §2). */
export interface Graph {
  readonly identity: bigint;
  readonly roots: readonly NodeID[];
  readonly nodes: readonly Node[];
  readonly edgeCount: number;
}

/** The RFC 0006 contract name of the immutable graph value; aliases Graph so the API freezes the same vocabulary across languages (RFC 0006 §2; the Go `type PortableGraph = Graph` and Kotlin `typealias PortableGraph = Graph` counterparts). */
export type PortableGraph = Graph;

/** Resolves one graph-local node ID; undefined when the ID belongs elsewhere or is out of range. */
export function nodeAt(graph: Graph, id: NodeID): Node | undefined {
  if (id.graph !== graph.identity) {
    return undefined;
  }
  if (id.index < 0 || id.index >= graph.nodes.length) {
    return undefined;
  }
  return graph.nodes[id.index];
}

/**
 * The mutable reservation/definition lifecycle for one immutable Graph
 * (RFC 0006 §3): reserve node identities, define each exactly once, add
 * ordered roots, then `build()` validates references, reachability, and
 * traversal depth before freezing the graph. A build failure returns no
 * partial graph.
 */
export class Builder {
  private readonly identity: bigint;
  private readonly nodes: (Node | undefined)[];
  private readonly roots: NodeID[];
  private edges = 0;
  private readonly limits: Limits;

  constructor(limits: Limits) {
    this.identity = nextGraphIdentity++;
    this.nodes = [];
    this.roots = [];
    this.limits = limits;
  }

  /** Reserves one graph-local identity for later exact definition (lib.rs:270-283). */
  reserveNode(): NodeID {
    const observed = this.nodes.length + 1;
    this.checkLimit('graph-nodes', observed, this.limits.maxNodes);
    const id: NodeID = { graph: this.identity, index: this.nodes.length };
    this.nodes.push(undefined);
    return id;
  }

  /** Appends one ordered graph root (lib.rs:286-297). */
  pushRoot(id: NodeID): void {
    this.requireReserved(id);
    const observed = this.roots.length + 1;
    this.checkLimit('graph-roots', observed, this.limits.maxRoots);
    this.roots.push(id);
  }

  /** Defines one reserved scalar node exactly once (RFC 0006 §2). */
  defineScalar(id: NodeID, tag: string, canonicalContent: string): void {
    this.validateTag(tag);
    if (!isValidUtf8(canonicalContent)) {
      throw new GraphError('InvalidUtf8');
    }
    this.checkLimit('scalar-bytes', utf8Length(canonicalContent), this.limits.maxScalarBytes);
    this.define(id, { kind: 'Scalar', tag, content: canonicalContent }, 0);
  }

  /** Defines one reserved ordered sequence node exactly once; items are copied. */
  defineSequence(id: NodeID, tag: string, items: readonly NodeID[]): void {
    this.validateTag(tag);
    this.checkLimit('container-entries', items.length, this.limits.maxContainerEntries);
    for (const item of items) {
      this.requireReserved(item);
    }
    this.define(id, { kind: 'Sequence', tag, items: [...items] }, items.length);
  }

  /** Defines one reserved ordered mapping node exactly once; entries are copied. */
  defineMapping(id: NodeID, tag: string, entries: readonly MappingEntry[]): void {
    this.validateTag(tag);
    this.checkLimit('container-entries', entries.length, this.limits.maxContainerEntries);
    for (const entry of entries) {
      this.requireReserved(entry.key);
      this.requireReserved(entry.value);
    }
    // A mapping association contributes a key and a value edge.
    this.define(id, { kind: 'Mapping', tag, entries: [...entries] }, entries.length * 2);
  }

  /**
   * Validates definitions, reachability, and traversal depth, then freezes
   * the graph (lib.rs:413-445). Throws on undefined or unreachable nodes;
   * no partial graph is returned.
   */
  build(): Graph {
    const nodes: Node[] = [];
    for (let index = 0; index < this.nodes.length; index++) {
      const defined = this.nodes[index];
      if (defined === undefined) {
        throw new GraphError('UndefinedNode', {
          id: { graph: this.identity, index },
        });
      }
      nodes.push(defined);
    }
    const { order } = canonicalOrder(nodes, this.roots, this.limits.maxTraversalDepth);
    if (order.length !== nodes.length) {
      const reachable = new Array<boolean>(nodes.length).fill(false);
      for (const index of order) {
        reachable[index] = true;
      }
      const missing = reachable.indexOf(false);
      throw new GraphError('UnreachableNode', {
        id: { graph: this.identity, index: missing },
      });
    }
    return {
      identity: this.identity,
      roots: [...this.roots],
      nodes,
      edgeCount: this.edges,
    };
  }

  private define(id: NodeID, node: Node, newEdges: number): void {
    const index = this.requireReserved(id);
    if (this.nodes[index] !== undefined) {
      throw new GraphError('DuplicateDefinition', { id });
    }
    this.edges += newEdges;
    this.checkLimit('graph-edges', this.edges, this.limits.maxEdges);
    this.nodes[index] = node;
  }

  private requireReserved(id: NodeID): number {
    if (id.graph !== this.identity) {
      throw new GraphError('WrongGraph', { id });
    }
    if (id.index < 0 || id.index >= this.nodes.length) {
      throw new GraphError('UnknownNode', { id });
    }
    return id.index;
  }

  private validateTag(tag: string): void {
    if (tag === '' || hasInvalidTagChar(tag)) {
      throw new GraphError('InvalidTag');
    }
    if (!isValidUtf8(tag)) {
      throw new GraphError('InvalidUtf8');
    }
    this.checkLimit('tag-bytes', utf8Length(tag), this.limits.maxTagBytes);
  }

  private checkLimit(name: string, observed: number, limit: number): void {
    if (observed > limit) {
      throw new GraphError('ResourceLimit', { field: name, observed, limit });
    }
  }
}

/** Reports one ASCII control or whitespace character (lib.rs:447-456). */
export function hasInvalidTagChar(tag: string): boolean {
  for (const ch of tag) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\f' || ch === '\r') {
      return true;
    }
  }
  return false;
}

/**
 * Reports whether the string is a valid Unicode scalar sequence (no lone
 * surrogates). TextEncoder silently replaces lone surrogates with U+FFFD,
 * so validity must be checked structurally; a valid scalar sequence encodes
 * to valid UTF-8 exactly (RFC 0016 §4.1: String is a Unicode scalar
 * sequence; the Arc<str> invariant of the Rust graph, lib.rs:94-157).
 */
export function isValidUtf8(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdfff) {
      if (code >= 0xd800 && code <= 0xdbff) {
        // High surrogate: valid only as the first half of a pair.
        const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
        if (next >= 0xdc00 && next <= 0xdfff) {
          i++;
          continue;
        }
      }
      return false;
    }
  }
  return true;
}

/** UTF-8 byte length of a string. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Assigns canonical IDs by deterministic depth-first pre-order (RFC 0006
 * §4): visit roots in root order; when a node is first encountered assign
 * the next ID; for a sequence visit items in order; for a mapping visit each
 * association in order, key before value; an already assigned node is a
 * reference and is not traversed again (lib.rs:542-578). `maxDepth` is the
 * first-visit depth limit; a negative value disables it.
 */
export function canonicalOrder(
  nodes: readonly Node[],
  roots: readonly NodeID[],
  maxDepth: number,
): { order: number[]; canonicalIDs: number[] } {
  const order: number[] = [];
  const canonicalIDs = new Array<number>(nodes.length).fill(0);
  const visited = new Array<boolean>(nodes.length).fill(false);
  const stack: { index: number; depth: number }[] = [];
  // Push in reverse so the first root pops first (lib.rs:550-553).
  for (let i = roots.length - 1; i >= 0; i--) {
    stack.push({ index: roots[i].index, depth: 0 });
  }
  let next = 0;
  while (stack.length > 0) {
    const top = stack.pop()!;
    if (visited[top.index]) {
      continue;
    }
    if (maxDepth >= 0 && top.depth > maxDepth) {
      throw new GraphError('ResourceLimit', {
        field: 'traversal-depth',
        observed: top.depth,
        limit: maxDepth,
      });
    }
    visited[top.index] = true;
    order.push(top.index);
    canonicalIDs[top.index] = next;
    next++;
    const node = nodes[top.index];
    const childDepth = top.depth + 1;
    switch (node.kind) {
      case 'Sequence':
        // Push reversed so items pop in stored order (lib.rs:145-156).
        for (let i = node.items.length - 1; i >= 0; i--) {
          stack.push({ index: node.items[i].index, depth: childDepth });
        }
        break;
      case 'Mapping':
        // Push value then key per association, all reversed, so associations
        // pop in stored order with key before value.
        for (let i = node.entries.length - 1; i >= 0; i--) {
          stack.push({ index: node.entries[i].value.index, depth: childDepth });
          stack.push({ index: node.entries[i].key.index, depth: childDepth });
        }
        break;
    }
  }
  return { order, canonicalIDs };
}
