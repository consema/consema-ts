/**
 * Native and lossless-syntax query execution over one immutable snapshot.
 *
 * authority: crates/consema-json/src/query.rs
 *  - JsonMatch :12-43, JsonSyntaxMatch :55-88
 *  - execute_json_query :91-125 (domain gate :97-105 — JSON5 requires
 *    domain v2; the root is the first standard result and must not bypass
 *    result limits :113-116), execute_json_syntax_query :141-183
 *  - Context.step :203-213 (cancellation, max_steps, max_results)
 *  - operator semantics :307-477 (json.try-object-members,
 *    json.member-name-equals, json.member-value, json.try-array-elements,
 *    json.array-element-value, json.syntax-kind-is, json.syntax-text-equals,
 *    core.take, core.distinct-by-identity)
 *  - expression evaluation :230-305 (Input/Apply/Concat/StructureOrderMerge;
 *    native merge sorts by (span.start, span.end, entity index) :252-269,
 *    syntax merge sorts by piece ordinal :295-303)
 *  - apply_selection :479-496 (All/First/Last/ZeroOrOne/RequireOne)
 *  - QueryLimits defaults (max_steps 100_000, max_results 100_000):
 *    crates/consema-core/src/query.rs:2967-2981
 *  - query definition/operator validation: typescript/src/protocol/query.ts
 *    (validateQuery/bindQuery; the JSON operator table rows :318-322,
 *    :371-372; the JSON syntax-kind vocabulary :1066-1088)
 *
 * Design (TypeScript-idiomatic): execution is eager and deterministic —
 * the complete match list is returned in source order, or a typed
 * `QueryExecutionFailure` with the frozen registered code is thrown
 * (no partial completed result exists).
 */

import { NodeRef, Span } from '../document/identity.ts';
import { QueryExecutionFailure } from './errors.ts';
import { JsonArrayElement, JsonDocument, JsonObjectMember, JsonValue } from './document.ts';
import type { JsonValueKind } from './document.ts';
import type { JsonSyntaxKind } from './syntax.ts';
import type { SemanticAvailability } from './semantic.ts';
import type {
  ExecutableQuery,
  OperatorCall,
  QueryExpression,
  QuerySelection,
} from '../protocol/query.ts';

// ---------------------------------------------------------------------------
// Execution limits and cancellation
// ---------------------------------------------------------------------------

/** Immutable query execution limits (query.rs:2967-2981). */
export class QueryLimits {
  readonly #maxSteps: number;
  readonly #maxResults: number;

  constructor(maxSteps: number, maxResults: number) {
    this.#maxSteps = maxSteps;
    this.#maxResults = maxResults;
  }

  /** The frozen defaults: 100_000 steps and 100_000 results (query.rs:2974-2980). */
  static defaults(): QueryLimits {
    return new QueryLimits(100_000, 100_000);
  }

  /** Maximum operator steps (query.rs:2969). */
  maxSteps(): number {
    return this.#maxSteps;
  }

  /** Maximum complete results buffered by an operator (query.rs:2971). */
  maxResults(): number {
    return this.#maxResults;
  }
}

/** Cooperative cancellation flag (query.rs:205-207; consema-core CancellationToken). */
export class CancellationToken {
  #cancelled = false;

  /** Requests cancellation; in-flight and future executions fail with Cancelled. */
  cancel(): void {
    this.#cancelled = true;
  }

  isCancelled(): boolean {
    return this.#cancelled;
  }
}

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------

/** Owned snapshot-bound JSON native semantic query match (query.rs:12-43). */
export type JsonMatch =
  | {
      readonly kind: 'Value';
      /** Exact value identity. */
      readonly node: NodeRef;
      /** Native category when locally available. */
      readonly valueKind: JsonValueKind | null;
    }
  | {
      readonly kind: 'ObjectMember';
      /** Zero-based member ordinal. */
      readonly ordinal: number;
      /** Decoded name when available. */
      readonly name: string | null;
      readonly key: NodeRef;
      readonly value: NodeRef;
      /** Association identity. */
      readonly member: NodeRef;
    }
  | {
      readonly kind: 'ArrayElement';
      /** Zero-based element ordinal. */
      readonly ordinal: number;
      /** Association identity. */
      readonly element: NodeRef;
      readonly value: NodeRef;
    };

/** Owned snapshot-bound JSON lossless syntax query match (query.rs:55-88). */
export class JsonSyntaxMatch {
  readonly #node: NodeRef;
  readonly #span: Span;
  readonly #kind: JsonSyntaxKind;
  readonly #ordinal: number;

  constructor(node: NodeRef, span: Span, kind: JsonSyntaxKind, ordinal: number) {
    this.#node = node;
    this.#span = span;
    this.#kind = kind;
    this.#ordinal = ordinal;
  }

  /** Process-local syntax-piece identity (query.rs:67-70). */
  nodeRef(): NodeRef {
    return this.#node;
  }

  /** Exact raw source span (query.rs:72-75). */
  span(): Span {
    return this.#span;
  }

  /** Format-specific lossless kind (query.rs:77-80). */
  kind(): JsonSyntaxKind {
    return this.#kind;
  }

  /** Zero-based source-order position (query.rs:82-86). */
  ordinal(): number {
    return this.#ordinal;
  }
}

/** A complete deterministic query result (query.rs:122, 182). */
export class JsonQueryResult<M> {
  readonly #matches: readonly M[];
  readonly #terminal: 'Completed';

  constructor(matches: readonly M[]) {
    this.#matches = Object.freeze([...matches]);
    this.#terminal = 'Completed';
  }

  /** Complete ordered matches. */
  matches(): readonly M[] {
    return this.#matches;
  }

  /** Eager execution always completes; failures throw instead (query.rs:122). */
  terminal(): 'Completed' {
    return this.#terminal;
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface ExecutionContext {
  readonly document: JsonDocument;
  readonly limits: QueryLimits;
  readonly cancellation: CancellationToken;
  steps: number;
}

function step(context: ExecutionContext, results: number): void {
  if (context.cancellation.isCancelled()) {
    throw new QueryExecutionFailure('Cancelled');
  }
  context.steps += 1;
  if (context.steps > context.limits.maxSteps() || results > context.limits.maxResults()) {
    throw new QueryExecutionFailure('ResourceLimitExceeded');
  }
}

/**
 * Executes a validated JSON native semantic query against one immutable
 * snapshot (query.rs:91-125).
 */
export function executeJsonQuery(
  executable: ExecutableQuery,
  document: JsonDocument,
  limits: QueryLimits,
  cancellation: CancellationToken,
): JsonQueryResult<JsonMatch> {
  const definition = executable.validated.definition;
  const domain = definition.domain;
  const version = domain.version;
  if (
    domain.id !== 'json.native-semantic-query' ||
    (version !== 1 && version !== 2) ||
    (document.profileInternal() === 'Json5Standard' && version !== 2)
  ) {
    throw new QueryExecutionFailure('DomainMismatch', { domain });
  }
  const context: ExecutionContext = { document, limits, cancellation, steps: 0 };
  // The root is the first standard result; it must not bypass result limits
  // (query.rs:113-116).
  step(context, 1);
  const root = document.root();
  const input: JsonMatch[] = [
    {
      kind: 'Value',
      node: root.nodeRef(),
      valueKind: matchKind(root.kind()),
    },
  ];
  const matches = executeExpression(definition.expression, input, context);
  const selected = applySelection(matches, definition.selection);
  return new JsonQueryResult(selected);
}

/**
 * Executes a validated JSON lossless syntax query against every source
 * piece in raw order (query.rs:141-183).
 */
export function executeJsonSyntaxQuery(
  executable: ExecutableQuery,
  document: JsonDocument,
  limits: QueryLimits,
  cancellation: CancellationToken,
): JsonQueryResult<JsonSyntaxMatch> {
  const definition = executable.validated.definition;
  const domain = definition.domain;
  const version = domain.version;
  if (
    domain.id !== 'json.lossless-syntax-query' ||
    (version !== 1 && version !== 2) ||
    (document.profileInternal() === 'Json5Standard' && version !== 2)
  ) {
    throw new QueryExecutionFailure('DomainMismatch', { domain });
  }
  const context: ExecutionContext = { document, limits, cancellation, steps: 0 };
  const pieces = document.losslessStructuralIndex().pieces();
  const kinds = document.losslessSyntaxKinds();
  step(context, pieces.length);
  const input: JsonSyntaxMatch[] = pieces.map((piece, ordinal) => {
    return new JsonSyntaxMatch(
      document.nodeRefFor(ordinal, 'JsonSyntaxPiece'),
      piece.span(),
      kinds[ordinal],
      ordinal,
    );
  });
  const matches = executeSyntaxExpression(definition.expression, input, context);
  const selected = applySelection(matches, definition.selection);
  return new JsonQueryResult(selected);
}

function matchKind(kind: SemanticAvailability<JsonValueKind>): JsonValueKind | null {
  switch (kind.kind) {
    case 'Available':
      return kind.value;
    case 'Unavailable':
      return null;
  }
}

function executeExpression(
  expression: QueryExpression,
  input: JsonMatch[],
  context: ExecutionContext,
): JsonMatch[] {
  switch (expression.kind) {
    case 'Input':
      return input;
    case 'Apply': {
      const applied = executeExpression(expression.input, input, context);
      return applyOperator(expression.operator, applied, context);
    }
    case 'Concat': {
      let output: JsonMatch[] = [];
      for (const branch of expression.branches) {
        output = output.concat(executeExpression(branch, input, context));
        step(context, output.length);
      }
      return output;
    }
    case 'StructureOrderMerge': {
      let output: JsonMatch[] = [];
      for (const branch of expression.branches) {
        output = output.concat(executeExpression(branch, input, context));
      }
      output.sort((left, right) => {
        const leftIndex = context.document.resolveEntityIndex(matchIdentity(left), ['Value', 'ObjectMember', 'ArrayElement']);
        const rightIndex = context.document.resolveEntityIndex(matchIdentity(right), ['Value', 'ObjectMember', 'ArrayElement']);
        const leftSpan = context.document.spanOf(leftIndex);
        const rightSpan = context.document.spanOf(rightIndex);
        if (leftSpan.startByte() !== rightSpan.startByte()) {
          return leftSpan.startByte() - rightSpan.startByte();
        }
        if (leftSpan.endByte() !== rightSpan.endByte()) {
          return leftSpan.endByte() - rightSpan.endByte();
        }
        return leftIndex - rightIndex;
      });
      step(context, output.length);
      return output;
    }
  }
}

function executeSyntaxExpression(
  expression: QueryExpression,
  input: JsonSyntaxMatch[],
  context: ExecutionContext,
): JsonSyntaxMatch[] {
  switch (expression.kind) {
    case 'Input':
      return input;
    case 'Apply': {
      const applied = executeSyntaxExpression(expression.input, input, context);
      return applySyntaxOperator(expression.operator, applied, context);
    }
    case 'Concat': {
      let output: JsonSyntaxMatch[] = [];
      for (const branch of expression.branches) {
        output = output.concat(executeSyntaxExpression(branch, input, context));
        step(context, output.length);
      }
      return output;
    }
    case 'StructureOrderMerge': {
      let output: JsonSyntaxMatch[] = [];
      for (const branch of expression.branches) {
        output = output.concat(executeSyntaxExpression(branch, input, context));
      }
      output.sort((left, right) => left.ordinal() - right.ordinal());
      step(context, output.length);
      return output;
    }
  }
}

function applySyntaxOperator(
  operator: OperatorCall,
  input: JsonSyntaxMatch[],
  context: ExecutionContext,
): JsonSyntaxMatch[] {
  let output: JsonSyntaxMatch[];
  switch (operator.id) {
    case 'json.syntax-kind-is': {
      const expected = operator.arguments.get('kind');
      const kind = expected !== undefined && expected.kind === 'String' ? expected.value : '';
      output = input.filter((item) => item.kind() === kind);
      break;
    }
    case 'json.syntax-text-equals': {
      const expected = operator.arguments.get('text');
      const text = expected !== undefined && expected.kind === 'String' ? expected.value : '';
      const bytes = new TextEncoder().encode(text);
      const source = context.document.source().bytes();
      output = input.filter((item) => {
        const span = item.span();
        const start = span.startByte();
        const end = span.endByte();
        if (end - start !== bytes.length) {
          return false;
        }
        for (let i = 0; i < bytes.length; i++) {
          if (source[start + i] !== bytes[i]) {
            return false;
          }
        }
        return true;
      });
      break;
    }
    case 'core.take': {
      const count = takeCount(operator);
      output = input.slice(0, count);
      break;
    }
    case 'core.distinct-by-identity': {
      const seen = new Set<string>();
      output = input.filter((item) => {
        const key = nodeKey(item.nodeRef());
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
      break;
    }
    default:
      throw new Error(`internal: validated JSON syntax operator ${operator.id}`);
  }
  step(context, output.length);
  return output;
}

function applyOperator(
  operator: OperatorCall,
  input: JsonMatch[],
  context: ExecutionContext,
): JsonMatch[] {
  const output: JsonMatch[] = [];
  switch (operator.id) {
    case 'json.try-object-members': {
      for (const item of input) {
        if (item.kind !== 'Value') {
          continue;
        }
        const index = context.document.resolveEntityIndex(item.node, ['Value']);
        const entity = context.document.valueEntityAt(index);
        if (entity.value.kind !== 'Object') {
          continue;
        }
        for (const memberIndex of entity.value.members) {
          const member = new JsonObjectMember(context.document, memberIndex);
          const name = member.name();
          output.push({
            kind: 'ObjectMember',
            ordinal: member.ordinal(),
            name: name.kind === 'Available' ? name.value : null,
            key: member.keyNodeRef(),
            value: member.valueNodeRef(),
            member: member.nodeRef(),
          });
        }
      }
      break;
    }
    case 'json.member-name-equals': {
      const expected = operator.arguments.get('name');
      const name = expected !== undefined && expected.kind === 'String' ? expected.value : '';
      for (const item of input) {
        if (item.kind === 'ObjectMember' && item.name === name) {
          output.push(item);
        }
      }
      break;
    }
    case 'json.member-value': {
      for (const item of input) {
        if (item.kind !== 'ObjectMember') {
          continue;
        }
        const index = context.document.resolveEntityIndex(item.value, ['Value']);
        output.push({
          kind: 'Value',
          node: context.document.nodeRefFor(index, 'Value'),
          valueKind: matchKind(
            new JsonValue(context.document, index).kind(),
          ),
        });
      }
      break;
    }
    case 'json.try-array-elements': {
      for (const item of input) {
        if (item.kind !== 'Value') {
          continue;
        }
        const index = context.document.resolveEntityIndex(item.node, ['Value']);
        const entity = context.document.valueEntityAt(index);
        if (entity.value.kind !== 'Array') {
          continue;
        }
        for (const elementIndex of entity.value.elements) {
          const element = new JsonArrayElement(context.document, elementIndex);
          output.push({
            kind: 'ArrayElement',
            ordinal: element.ordinal(),
            element: element.nodeRef(),
            value: element.valueNodeRef(),
          });
        }
      }
      break;
    }
    case 'json.array-element-value': {
      for (const item of input) {
        if (item.kind !== 'ArrayElement') {
          continue;
        }
        const index = context.document.resolveEntityIndex(item.value, ['Value']);
        output.push({
          kind: 'Value',
          node: context.document.nodeRefFor(index, 'Value'),
          valueKind: matchKind(
            new JsonValue(context.document, index).kind(),
          ),
        });
      }
      break;
    }
    case 'core.take': {
      const count = takeCount(operator);
      for (const item of input.slice(0, count)) {
        output.push(item);
      }
      break;
    }
    case 'core.distinct-by-identity': {
      const seen = new Set<string>();
      for (const item of input) {
        const key = nodeKey(matchIdentity(item));
        if (!seen.has(key)) {
          seen.add(key);
          output.push(item);
        }
      }
      break;
    }
    default:
      throw new Error(`internal: validated JSON operator ${operator.id}`);
  }
  step(context, output.length);
  return output;
}

function takeCount(operator: OperatorCall): number {
  const count = operator.arguments.get('count');
  if (count === undefined || count.kind !== 'Integer' || count.value < 0n) {
    throw new Error('internal: validated take count');
  }
  if (count.value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('internal: take count exceeds safe range');
  }
  return Number(count.value);
}

function matchIdentity(match: JsonMatch): NodeRef {
  switch (match.kind) {
    case 'Value':
      return match.node;
    case 'ObjectMember':
      return match.member;
    case 'ArrayElement':
      return match.element;
  }
}

function nodeKey(node: NodeRef): string {
  return `${node.snapshot().asBigInt().toString()}:${node.index().toString()}:${node.role()}`;
}

/** The five frozen cardinality selections (query.rs:479-496). */
function applySelection<T>(values: T[], selection: QuerySelection): T[] {
  switch (selection) {
    case 'All':
      return values;
    case 'First':
      return values.slice(0, 1);
    case 'Last':
      return values.length === 0 ? [] : [values[values.length - 1]];
    case 'ZeroOrOne':
      if (values.length <= 1) {
        return values;
      }
      throw new QueryExecutionFailure('CardinalityViolation', {
        selection,
        actual: values.length,
      });
    case 'RequireOne':
      if (values.length === 1) {
        return values;
      }
      throw new QueryExecutionFailure('CardinalityViolation', {
        selection,
        actual: values.length,
      });
  }
}
