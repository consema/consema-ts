/**
 * Portable-value and portable-graph query execution.
 *
 * authority: the working Python reference implementation
 * python/src/consema/conformance/core_query.py (execute_portable, CoreCursor,
 * _execute_expression, _apply_operator, _apply_one — the operator table and
 * the cursor terminal semantics); the Rust executors
 * crates/consema-core/src/query.rs (execute_portable / execute_portable_cursor
 * :820-2964, the RootCounter root-result accounting :2670-2699, the
 * OrderedQueryCursor terminal semantics :3047-3110, the failure codes
 * :3206-3221) and crates/consema-graph/src/query.rs (the portable-graph
 * executor: the Input roots, graph.reachable-nodes first-discovery
 * traversal, the association operators, and the StructureOrderMerge
 * canonical-rank merge). The failure spellings follow the vectors
 * (queryFailureName, python core_query.py:29-45); the registered codes follow
 * the error registry (src/protocol/error_registry.ts:205-220).
 *
 * Design (TypeScript-idiomatic): the validation-time QueryFailure union of
 * src/protocol/query.ts is closed, so execution-time failures are a separate
 * QueryExecutionFailure class defined here carrying the same vector
 * spellings and the registered codes. The portable-value executor is eager
 * (the Python reference is eager); the ordered-result cursors are lazy over
 * the materialized stream, mirroring the Rust cursor terminal states.
 *
 * Documented deviations: (1) the Rust lazy step counter (max_steps
 * accounting per pull) is not mirrored — execution enforces the expression
 * depth limit 256 and the max_results bounds, which is the observable
 * surface of the published vectors; (2) the Rust try-operators silently
 * drop role-unmatched values while the Python reference raises
 * RequiredTypeMismatch — the Python behavior is kept (the vectors do not
 * exercise the difference); (3) distinct-by-identity over portable values
 * deduplicates by object reference of the match value (the Python id()
 * semantics); scalar primitives have no reference identity in JS and
 * compare by value.
 */

import type { PortableValue } from './value.ts';
import type { QueryExpression, OperatorCall } from '../protocol/query.ts';
import type { Graph, NodeID } from '../graph/graph.ts';
import { nodeAt, canonicalOrder, defaultLimits } from '../graph/graph.ts';

// ---------------------------------------------------------------------------
// Failure model (query.rs:3112-3221; python core_query.py:29-45)
// ---------------------------------------------------------------------------

/** One query failure kind, including the execution-time kinds the
 * validation-time union of src/protocol/query.ts cannot carry. */
export type QueryExecutionFailureKind =
  | 'DomainMismatch'
  | 'UnknownOperator'
  | 'WrongArgumentType'
  | 'InvalidArgument'
  | 'InvalidOperatorComposition'
  | 'MissingCapability'
  | 'RequiredTypeMismatch'
  | 'CardinalityViolation'
  | 'ResourceLimitExceeded'
  | 'Cancelled'
  | 'TargetUnavailable';

/** The registered diagnostic codes (error_registry.ts:205-220; query.rs:3206-3221). */
const EXECUTION_FAILURE_CODES: Record<QueryExecutionFailureKind, string> = {
  DomainMismatch: 'core.query.domain-mismatch@1',
  UnknownOperator: 'core.query.unknown-operator@1',
  WrongArgumentType: 'core.query.wrong-argument-type@1',
  InvalidArgument: 'core.query.invalid-argument@1',
  InvalidOperatorComposition: 'core.query.invalid-composition@1',
  MissingCapability: 'core.query.missing-capability@1',
  RequiredTypeMismatch: 'core.query.required-type-mismatch@1',
  CardinalityViolation: 'core.query.cardinality-violation@1',
  ResourceLimitExceeded: 'core.query.resource-limit@1',
  Cancelled: 'core.query.cancelled@1',
  TargetUnavailable: 'core.query.target-unavailable@1',
};

/** The stable vector spelling of one query failure kind (python core_query.py:29-45). */
export function queryFailureName(kind: QueryExecutionFailureKind): string {
  return kind;
}

/** The registered code of one query failure kind. */
export function queryFailureCode(kind: QueryExecutionFailureKind): string {
  return EXECUTION_FAILURE_CODES[kind];
}

/** One execution-time query failure (the Rust QueryFailure, query.rs:3112-3221). */
export class QueryExecutionFailure extends Error {
  readonly kind: QueryExecutionFailureKind;
  readonly code: string;
  readonly operator: string;
  readonly version: number;
  readonly argument?: string;

  constructor(options: {
    kind: QueryExecutionFailureKind;
    operator?: string;
    version?: number;
    argument?: string;
  }) {
    super(
      options.argument !== undefined
        ? `query execution: ${queryFailureName(options.kind)} (operator ${options.operator ?? ''}, argument ${options.argument})`
        : `query execution: ${queryFailureName(options.kind)}`,
    );
    this.name = 'QueryExecutionFailure';
    this.kind = options.kind;
    this.code = EXECUTION_FAILURE_CODES[options.kind];
    this.operator = options.operator ?? '';
    this.version = options.version ?? 0;
    if (options.argument !== undefined) {
      this.argument = options.argument;
    }
  }
}

// ---------------------------------------------------------------------------
// Execution limits and cancellation (query.rs:2965-3004)
// ---------------------------------------------------------------------------

/** Immutable query execution limits (query.rs:2965-2981). */
export interface QueryExecutionLimits {
  readonly maxSteps: number;
  readonly maxResults: number;
}

/** The frozen defaults (query.rs:2974-2981). */
export function defaultQueryExecutionLimits(): QueryExecutionLimits {
  return { maxSteps: 100_000, maxResults: 100_000 };
}

/** Cooperative cancellation signal (query.rs:2983-3004). */
export interface CancellationTokenLike {
  isCancelled(): boolean;
}

export class CancellationToken implements CancellationTokenLike {
  private cancelled = false;

  /** Requests cancellation. */
  cancel(): void {
    this.cancelled = true;
  }

  /** Tests cancellation state. */
  isCancelled(): boolean {
    return this.cancelled;
  }
}

// ---------------------------------------------------------------------------
// Ordered results and cursors
// ---------------------------------------------------------------------------

/** One ordered result of the portable-value domain (python core_query.py:47-67). */
export interface OrderedResult {
  readonly kind: 'Value' | 'ObjectEntry' | 'EntryMappingEntry';
  readonly ordinal: number;
  readonly value: PortableValue;
  readonly key?: string;
  readonly entry?: { readonly key: PortableValue; readonly value: PortableValue };
}

/** The ordered-result cursor terminal states (RFC 0003; query.rs:3036-3045). */
export type TerminalState = 'Completed' | 'Cancelled' | 'Failed';

/**
 * The ordered cursor over the materialized portable-value stream with a
 * max_results bound (python core_query.py:70-119). The advance that would
 * exceed the bound stops the stream with a Failed terminal; cancellation
 * requested before the next advance stops it with Cancelled.
 */
export class PortableCursor {
  private readonly matches: readonly OrderedResult[];
  private readonly maxResults: number | undefined;
  private readonly cancelled: boolean;
  private readonly mode: TerminalState;
  private index = 0;

  constructor(
    matches: readonly OrderedResult[],
    maxResults?: number,
    cancelled = false,
    mode: TerminalState = 'Completed',
  ) {
    this.matches = matches;
    this.maxResults = maxResults;
    this.cancelled = cancelled;
    this.mode = mode;
  }

  /** Yields the next match, or null at a terminal state. */
  next(): OrderedResult | null {
    if (this.cancelled) {
      return null;
    }
    if (this.maxResults !== undefined && this.index >= this.maxResults) {
      return null;
    }
    if (this.index >= this.matches.length) {
      return null;
    }
    const match = this.matches[this.index];
    this.index += 1;
    return match;
  }

  /** The number of matches yielded so far. */
  yielded(): number {
    return this.index;
  }

  /** The terminal state of the stream (python core_query.py:110-119). */
  terminalState(): TerminalState {
    if (this.cancelled) {
      return 'Cancelled';
    }
    if (this.maxResults !== undefined && this.index >= this.maxResults) {
      if (this.index >= this.matches.length) {
        return this.mode;
      }
      return 'Failed';
    }
    if (this.index >= this.matches.length) {
      return this.mode;
    }
    return 'Completed';
  }
}

/**
 * The ordered cursor over an already-complete result sequence with a
 * declared terminal state (query.rs:3047-3110). Cancellation pre-empts the
 * stream with Cancelled; the declared terminal stays hidden until the stream
 * is exhausted; terminal_state() is undefined while the stream is open.
 */
export class OrderedCursor<T> {
  private readonly remaining: readonly T[];
  private readonly declaredTerminal: TerminalState;
  private readonly cancellation: CancellationTokenLike | undefined;
  private position = 0;
  private terminal: TerminalState | undefined;

  constructor(
    values: readonly T[],
    declaredTerminal: TerminalState = 'Completed',
    cancellation?: CancellationTokenLike,
  ) {
    this.remaining = values;
    this.declaredTerminal = declaredTerminal;
    this.cancellation = cancellation;
  }

  /** Yields the next value, or null at a terminal state (query.rs:3092-3110). */
  next(): T | null {
    if (this.cancellation !== undefined && this.cancellation.isCancelled()) {
      this.terminal = 'Cancelled';
      return null;
    }
    if (this.position >= this.remaining.length) {
      this.terminal = this.declaredTerminal;
      return null;
    }
    const value = this.remaining[this.position];
    this.position += 1;
    return value;
  }

  /** Terminal state; undefined while the stream is still open. */
  terminalState(): TerminalState | undefined {
    return this.terminal;
  }
}

// ---------------------------------------------------------------------------
// The portable-value executor (python core_query.py:122-296; query.rs:2670-2861)
// ---------------------------------------------------------------------------

/** The expression depth limit: a deeper operator tree fails with
 * ResourceLimitExceeded (python core_query.py:161-162). */
const MAX_EXPRESSION_DEPTH = 256;

/**
 * Executes one validated expression over a core value and returns the
 * ordered result stream. The root is the first standard result and may not
 * bypass max_results (the Rust RootCounter, query.rs:2670-2699); a stream
 * longer than max_results fails with ResourceLimitExceeded; cancellation
 * fails with Cancelled.
 */
export function executePortable(
  value: PortableValue,
  expression: QueryExpression,
  limits: QueryExecutionLimits,
  token: CancellationTokenLike,
): OrderedResult[] {
  if (token.isCancelled()) {
    throw new QueryExecutionFailure({ kind: 'Cancelled' });
  }
  if (limits.maxResults < 1) {
    throw new QueryExecutionFailure({ kind: 'ResourceLimitExceeded' });
  }
  const matches = evaluateExpression(value, expression, 0);
  if (matches.length > limits.maxResults) {
    throw new QueryExecutionFailure({ kind: 'ResourceLimitExceeded' });
  }
  return matches;
}

/**
 * Returns a lazy ordered pull cursor over one portable-value query
 * (python core_query.py:470-504; query.rs:834-846). Definition and
 * capability errors are the caller's validation concern; mid-stream the
 * max_results bound surfaces a Failed terminal.
 */
export function executePortableCursor(
  value: PortableValue,
  expression: QueryExpression,
  maxResults?: number,
  cancelled = false,
): PortableCursor {
  const matches = evaluateExpression(value, expression, 0);
  return new PortableCursor(matches, maxResults, cancelled, 'Completed');
}

/** Recursively evaluates an expression tree over one root value
 * (python core_query.py:158-183). */
function evaluateExpression(
  value: PortableValue,
  expression: QueryExpression,
  depth: number,
): OrderedResult[] {
  if (depth > MAX_EXPRESSION_DEPTH) {
    throw new QueryExecutionFailure({ kind: 'ResourceLimitExceeded' });
  }
  switch (expression.kind) {
    case 'Input':
      return [{ kind: 'Value', ordinal: 0, value }];
    case 'Apply': {
      const inputs = evaluateExpression(value, expression.input, depth + 1);
      return applyOperator(expression.operator, inputs);
    }
    case 'Concat': {
      const results: OrderedResult[] = [];
      for (const branch of expression.branches) {
        results.push(...evaluateExpression(value, branch, depth + 1));
      }
      return results;
    }
    case 'StructureOrderMerge': {
      // The structural-identity-order merge of the Python reference:
      // branch-by-branch round-robin over the longest first branch.
      const branches = expression.branches.map((branch) =>
        evaluateExpression(value, branch, depth + 1),
      );
      const merged: OrderedResult[] = [];
      if (branches.length > 0) {
        for (let index = 0; index < branches[0].length; index++) {
          for (const branch of branches) {
            if (index < branch.length) {
              merged.push(branch[index]);
            }
          }
        }
      }
      return merged;
    }
  }
}

/** The domain-agnostic stream operators and the per-match operator table
 * (python core_query.py:186-261; query.rs:2435-2467, 2701-2861). */
function applyOperator(operator: OperatorCall, inputs: OrderedResult[]): OrderedResult[] {
  if (operator.id === 'core.take') {
    return inputs.slice(0, integerArgument(operator, 'count'));
  }
  if (operator.id === 'core.distinct-by-identity') {
    // Domain-agnostic identity deduplication over the stream: the Python
    // reference deduplicates by id() of the match value (object reference).
    const seen = new Set<PortableValue>();
    const distinct: OrderedResult[] = [];
    for (const match of inputs) {
      if (seen.has(match.value)) {
        continue;
      }
      seen.add(match.value);
      distinct.push(match);
    }
    return distinct;
  }
  const results: OrderedResult[] = [];
  for (const match of inputs) {
    results.push(...applyOne(operator, match));
  }
  return results;
}

/** One operator applied to one match (python core_query.py:207-261). */
function applyOne(operator: OperatorCall, match: OrderedResult): OrderedResult[] {
  switch (operator.id) {
    case 'core.try-object-entries': {
      if (match.value.kind !== 'Object') {
        throw requiredTypeMismatch(operator, 'Object');
      }
      return match.value.entries.map((entry, ordinal) => ({
        kind: 'ObjectEntry',
        ordinal,
        value: entry.value,
        key: entry.key,
      }));
    }
    case 'core.object-entry-value': {
      requireRole(match, 'ObjectEntry', operator);
      return [{ kind: 'Value', ordinal: 0, value: match.value }];
    }
    case 'core.object-entry-name-equals': {
      requireRole(match, 'ObjectEntry', operator);
      const name = stringArgument(operator, 'name');
      return match.key === name ? [match] : [];
    }
    case 'core.try-entry-mapping-entries': {
      if (match.value.kind !== 'EntryMapping') {
        throw requiredTypeMismatch(operator, 'EntryMapping');
      }
      return match.value.entries.map((entry, ordinal) => ({
        kind: 'EntryMappingEntry',
        ordinal,
        value: entry.value,
        entry,
      }));
    }
    case 'core.entry-key': {
      requireRole(match, 'EntryMappingEntry', operator);
      return [{ kind: 'Value', ordinal: 0, value: match.entry!.key }];
    }
    case 'core.entry-value': {
      requireRole(match, 'EntryMappingEntry', operator);
      return [{ kind: 'Value', ordinal: 0, value: match.entry!.value }];
    }
    case 'core.try-sequence-elements': {
      if (match.value.kind !== 'Sequence') {
        throw requiredTypeMismatch(operator, 'Sequence');
      }
      return match.value.items.map((element, ordinal) => ({
        kind: 'Value',
        ordinal,
        value: element,
      }));
    }
    case 'core.where-type': {
      const kind = stringArgument(operator, 'kind');
      return match.value.kind === kind ? [match] : [];
    }
    case 'core.require-type': {
      const kind = stringArgument(operator, 'kind');
      if (match.value.kind !== kind) {
        throw new QueryExecutionFailure({
          kind: 'RequiredTypeMismatch',
          operator: operator.id,
          argument: kind,
        });
      }
      return [match];
    }
    default:
      throw new QueryExecutionFailure({
        kind: 'UnknownOperator',
        operator: operator.id,
        version: operator.version,
      });
  }
}

/** The RequiredTypeMismatch failure of the kind-guarded operators
 * (python core_query.py:264-270). */
function requiredTypeMismatch(operator: OperatorCall, kind: string): QueryExecutionFailure {
  return new QueryExecutionFailure({
    kind: 'RequiredTypeMismatch',
    operator: operator.id,
    argument: kind,
  });
}

/** Role composition guard (python core_query.py:273-278). */
function requireRole(
  match: OrderedResult,
  role: 'ObjectEntry' | 'EntryMappingEntry',
  operator: OperatorCall,
): void {
  if (match.kind !== role) {
    throw new QueryExecutionFailure({ kind: 'InvalidOperatorComposition', operator: operator.id });
  }
}

/** The required string operator argument (python core_query.py:281-287). */
function stringArgument(operator: OperatorCall, name: string): string {
  const value = operator.arguments.get(name);
  if (value === undefined || value.kind !== 'String') {
    throw new QueryExecutionFailure({
      kind: 'WrongArgumentType',
      operator: operator.id,
      argument: name,
    });
  }
  return value.value;
}

/** The required integer operator argument (python core_query.py:290-296). */
function integerArgument(operator: OperatorCall, name: string): number {
  const value = operator.arguments.get(name);
  if (value === undefined || value.kind !== 'Integer') {
    throw new QueryExecutionFailure({
      kind: 'WrongArgumentType',
      operator: operator.id,
      argument: name,
    });
  }
  return Number(value.value);
}

// ---------------------------------------------------------------------------
// The portable-graph executor (crates/consema-graph/src/query.rs:11-412)
// ---------------------------------------------------------------------------

/** One portable-graph query match (query.rs:13-39). */
export type GraphOrderedResult =
  | { readonly kind: 'GraphNode'; readonly node: NodeID }
  | {
      readonly kind: 'GraphSequenceElement';
      readonly parent: NodeID;
      readonly ordinal: number;
      readonly node: NodeID;
    }
  | {
      readonly kind: 'GraphMappingEntry';
      readonly parent: NodeID;
      readonly ordinal: number;
      readonly key: NodeID;
      readonly value: NodeID;
    };

/** Executes one validated portable-graph expression over a built graph
 * (query.rs:142-174): the Input expression yields one Node match per root in
 * root order, then the operator chain runs with the max_results bound. */
export function executeGraph(
  graph: Graph,
  expression: QueryExpression,
  limits: QueryExecutionLimits,
  token: CancellationTokenLike,
): GraphOrderedResult[] {
  if (token.isCancelled()) {
    throw new QueryExecutionFailure({ kind: 'Cancelled' });
  }
  const roots = graph.roots.map((node): GraphOrderedResult => ({ kind: 'GraphNode', node }));
  if (roots.length > limits.maxResults) {
    throw new QueryExecutionFailure({ kind: 'ResourceLimitExceeded' });
  }
  const matches = evaluateGraphExpression(graph, expression, roots, 0);
  if (matches.length > limits.maxResults) {
    throw new QueryExecutionFailure({ kind: 'ResourceLimitExceeded' });
  }
  return matches;
}

/** Recursively evaluates a graph expression over the root matches
 * (query.rs:177-212). */
function evaluateGraphExpression(
  graph: Graph,
  expression: QueryExpression,
  inputs: GraphOrderedResult[],
  depth: number,
): GraphOrderedResult[] {
  if (depth > MAX_EXPRESSION_DEPTH) {
    throw new QueryExecutionFailure({ kind: 'ResourceLimitExceeded' });
  }
  switch (expression.kind) {
    case 'Input':
      return [...inputs];
    case 'Apply': {
      const values = evaluateGraphExpression(graph, expression.input, inputs, depth + 1);
      return applyGraphOperator(graph, expression.operator, values);
    }
    case 'Concat': {
      const output: GraphOrderedResult[] = [];
      for (const branch of expression.branches) {
        output.push(...evaluateGraphExpression(graph, branch, inputs, depth + 1));
      }
      return output;
    }
    case 'StructureOrderMerge': {
      // The Rust merge sorts the branch union by canonical node rank and
      // deduplicates by match identity (query.rs:200-210).
      const output: GraphOrderedResult[] = [];
      for (const branch of expression.branches) {
        output.push(...evaluateGraphExpression(graph, branch, inputs, depth + 1));
      }
      const canonical = canonicalOrder(graph.nodes, graph.roots, defaultLimits().maxTraversalDepth);
      const rank = (match: GraphOrderedResult): [number, number, number] => {
        switch (match.kind) {
          case 'GraphNode':
            return [canonical.canonicalIDs[match.node.index], 0, 0];
          case 'GraphSequenceElement':
            return [canonical.canonicalIDs[match.parent.index], 1, match.ordinal];
          case 'GraphMappingEntry':
            return [canonical.canonicalIDs[match.parent.index], 2, match.ordinal];
        }
      };
      output.sort((left, right) => compareTuple(rank(left), rank(right)));
      const seen = new Set<string>();
      return output.filter((value) => {
        const key = graphMatchIdentity(value);
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
    }
  }
}

function compareTuple(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      return left[index] < right[index] ? -1 : 1;
    }
  }
  return 0;
}

/** One graph operator applied to the whole input stream (query.rs:218-384). */
function applyGraphOperator(
  graph: Graph,
  operator: OperatorCall,
  inputs: GraphOrderedResult[],
): GraphOrderedResult[] {
  const output: GraphOrderedResult[] = [];
  switch (operator.id) {
    case 'core.take': {
      const count = integerArgument(operator, 'count');
      return inputs.slice(0, count);
    }
    case 'core.distinct-by-identity': {
      const seen = new Set<string>();
      for (const match of inputs) {
        const key = graphMatchIdentity(match);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        output.push(match);
      }
      return output;
    }
    case 'graph.reachable-nodes': {
      // The canonical first-discovery traversal with one shared visited set
      // over all inputs (query.rs:242-265; portable_graph_v1.py:391-402).
      const seen = new Set<string>();
      for (const match of inputs) {
        requireGraphNode(match, operator);
        const stack: NodeID[] = [match.node];
        while (stack.length > 0) {
          const node = stack.pop()!;
          const key = nodeIdentityKey(node);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          output.push({ kind: 'GraphNode', node });
          stack.push(...outgoingReverse(graph, node));
        }
      }
      return output;
    }
    case 'graph.where-kind': {
      const expected = stringArgument(operator, 'kind');
      for (const match of inputs) {
        requireGraphNode(match, operator);
        const node = nodeAt(graph, match.node);
        if (node !== undefined && node.kind === expected) {
          output.push(match);
        }
      }
      return output;
    }
    case 'graph.where-tag': {
      const expected = stringArgument(operator, 'tag');
      for (const match of inputs) {
        requireGraphNode(match, operator);
        const node = nodeAt(graph, match.node);
        if (node !== undefined && node.tag === expected) {
          output.push(match);
        }
      }
      return output;
    }
    case 'graph.try-sequence-elements': {
      for (const match of inputs) {
        requireGraphNode(match, operator);
        const node = nodeAt(graph, match.node);
        if (node !== undefined && node.kind === 'Sequence') {
          node.items.forEach((item, ordinal) => {
            output.push({ kind: 'GraphSequenceElement', parent: match.node, ordinal, node: item });
          });
        }
      }
      return output;
    }
    case 'graph.sequence-element-node': {
      for (const match of inputs) {
        if (match.kind !== 'GraphSequenceElement') {
          throw new QueryExecutionFailure({ kind: 'InvalidOperatorComposition', operator: operator.id });
        }
        output.push({ kind: 'GraphNode', node: match.node });
      }
      return output;
    }
    case 'graph.try-mapping-entries': {
      for (const match of inputs) {
        requireGraphNode(match, operator);
        const node = nodeAt(graph, match.node);
        if (node !== undefined && node.kind === 'Mapping') {
          node.entries.forEach((entry, ordinal) => {
            output.push({
              kind: 'GraphMappingEntry',
              parent: match.node,
              ordinal,
              key: entry.key,
              value: entry.value,
            });
          });
        }
      }
      return output;
    }
    case 'graph.mapping-entry-key':
    case 'graph.mapping-entry-value': {
      const key = operator.id === 'graph.mapping-entry-key';
      for (const match of inputs) {
        if (match.kind !== 'GraphMappingEntry') {
          throw new QueryExecutionFailure({ kind: 'InvalidOperatorComposition', operator: operator.id });
        }
        output.push({ kind: 'GraphNode', node: key ? match.key : match.value });
      }
      return output;
    }
    default:
      throw new QueryExecutionFailure({
        kind: 'UnknownOperator',
        operator: operator.id,
        version: operator.version,
      });
  }
}

/** The GraphNode role guard (portable_graph_v1.py:345-352). */
function requireGraphNode(
  match: GraphOrderedResult,
  operator: OperatorCall,
): asserts match is Extract<GraphOrderedResult, { kind: 'GraphNode' }> {
  if (match.kind !== 'GraphNode') {
    throw new QueryExecutionFailure({ kind: 'InvalidOperatorComposition', operator: operator.id });
  }
}

/** Match identity for distinct-by-identity (query.rs:65-83). */
function graphMatchIdentity(match: GraphOrderedResult): string {
  switch (match.kind) {
    case 'GraphNode':
      return `node:${nodeIdentityKey(match.node)}`;
    case 'GraphSequenceElement':
      return `element:${nodeIdentityKey(match.parent)}:${match.ordinal}`;
    case 'GraphMappingEntry':
      return `entry:${nodeIdentityKey(match.parent)}:${match.ordinal}`;
  }
}

function nodeIdentityKey(node: NodeID): string {
  return `${node.graph}:${node.index}`;
}

/** Children in reverse order so the DFS pop visits them forward
 * (query.rs:256-262; portable_graph_v1.py:284-298). */
function outgoingReverse(graph: Graph, id: NodeID): NodeID[] {
  const node = nodeAt(graph, id);
  if (node === undefined) {
    return [];
  }
  if (node.kind === 'Sequence') {
    return [...node.items].reverse();
  }
  if (node.kind === 'Mapping') {
    const outgoing: NodeID[] = [];
    for (let index = node.entries.length - 1; index >= 0; index--) {
      outgoing.push(node.entries[index].value, node.entries[index].key);
    }
    return outgoing;
  }
  return [];
}
