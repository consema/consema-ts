/**
 * Native and lossless-syntax query execution over one immutable snapshot.
 *
 * authority: crates/consema-properties/src/query.rs
 *  - PropertiesMatch :12-74, PropertiesSyntaxMatch :88-121
 *  - execute_properties_query :123-150 (domain gate :130-136), cursor
 *    :152-164, execute_properties_syntax_query :166-211 (domain gate
 *    :173-179), syntax cursor :213-225
 *  - Context.step :234-247 (cancellation, max_steps, max_results)
 *  - operator semantics :398-607 (properties.document-properties,
 *    properties.natural-lines, properties.logical-lines,
 *    properties.logical-line-natural-lines, properties.property-key-equals,
 *    properties.property-value-state-is, properties.property-escapes,
 *    properties.duplicate-group, properties.syntax-kind-is,
 *    properties.syntax-text-equals, properties.syntax-raw-bytes-equals,
 *    properties.syntax-utf16be-equals, core.take,
 *    core.distinct-by-identity)
 *  - expression evaluation :326-396 (Input/Apply/Concat/StructureOrderMerge;
 *    native merge sorts by source order :609-634, syntax merge by piece
 *    ordinal :391)
 *  - apply_selection :675-692 (All/First/Last/ZeroOrOne/RequireOne)
 *  - decoded span text :636-651 (raw boundaries resolved to decoded text)
 *  - QueryLimits defaults (max_steps 100_000, max_results 100_000):
 *    crates/consema-core/src/query.rs:2967-2981
 *  - RFC 0010 §10 (:269-308) freezes the query surface: eight native
 *    operators (:272-282), four lossless syntax filters (:287-295), and the
 *    exact UTF-16BE/1 key matching rule (:284-285)
 *  - query definition/operator validation: typescript/src/protocol/query.ts
 *    (the Properties operator table rows :362-369, :388-391; argument
 *    validation :945-951, :994-1011; the syntax-kind vocabulary)
 *
 * Design (TypeScript-idiomatic): execution is eager and deterministic —
 * the complete match list is returned in source order, or a typed
 * `QueryExecutionFailure` with the frozen registered code is thrown. The
 * cursor exposes the Rust `OrderedQueryCursor` behavior (next/terminal
 * state with cooperative cancellation).
 */

import { NodeRef, Span } from '../document/identity.ts';
import { QueryExecutionFailure } from './errors.ts';
import { PropertiesDocument } from './document.ts';
import type { PropertiesEscapeKind, PropertiesLogicalLineKind, PropertiesValueState } from './document.ts';
import { JavaString } from './java_string.ts';
import type { PropertiesSyntaxKind } from './syntax.ts';
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

/** Owned snapshot-bound Java Properties native semantic query match (query.rs:12-74). */
export type PropertiesMatch =
  | {
      readonly kind: 'Document';
      /** Root document identity. */
      readonly node: NodeRef;
    }
  | {
      readonly kind: 'Property';
      /** Zero-based source-order property ordinal. */
      readonly ordinal: number;
      /** Property identity. */
      readonly node: NodeRef;
      /** Owning logical line. */
      readonly logicalLine: NodeRef;
      /** Exact Java UTF-16 key. */
      readonly key: JavaString;
      /** Exact Java UTF-16 value. */
      readonly value: JavaString;
      /** Implicit, explicit-empty, or present state. */
      readonly valueState: PropertiesValueState;
      /** Exact-key duplicate group, when present. */
      readonly duplicateGroup: number | null;
    }
  | {
      readonly kind: 'NaturalLine';
      /** Zero-based source-order natural-line ordinal. */
      readonly ordinal: number;
      /** Natural-line identity. */
      readonly node: NodeRef;
      /** Complete raw line span including its terminator. */
      readonly span: Span;
    }
  | {
      readonly kind: 'LogicalLine';
      /** Zero-based logical-line ordinal. */
      readonly ordinal: number;
      /** Logical-line identity. */
      readonly node: NodeRef;
      /** Logical record kind. */
      readonly recordKind: PropertiesLogicalLineKind;
    }
  | {
      readonly kind: 'Escape';
      /** Zero-based source-order escape ordinal. */
      readonly ordinal: number;
      /** Escape identity. */
      readonly node: NodeRef;
      /** Owning property identity. */
      readonly property: NodeRef;
      /** Whether the output belongs to the property key. */
      readonly inKey: boolean;
      /** Escape behavior. */
      readonly escapeKind: PropertiesEscapeKind;
      /** Complete raw escape range. */
      readonly span: Span;
      /** Half-open Java UTF-16 output range. */
      readonly outputStart: number;
      /** Exclusive Java UTF-16 output boundary. */
      readonly outputEnd: number;
    };

function matchIdentity(match: PropertiesMatch): NodeRef {
  return match.node;
}

/** Owned snapshot-bound Java Properties lossless syntax query match (query.rs:88-121). */
export class PropertiesSyntaxMatch {
  readonly #node: NodeRef;
  readonly #span: Span;
  readonly #kind: PropertiesSyntaxKind;
  readonly #ordinal: number;

  constructor(node: NodeRef, span: Span, kind: PropertiesSyntaxKind, ordinal: number) {
    this.#node = node;
    this.#span = span;
    this.#kind = kind;
    this.#ordinal = ordinal;
  }

  /** Process-local syntax-piece identity (query.rs:98-101). */
  nodeRef(): NodeRef {
    return this.#node;
  }

  /** Exact raw source span (query.rs:102-105). */
  span(): Span {
    return this.#span;
  }

  /** Format-specific lossless kind (query.rs:106-109). */
  kind(): PropertiesSyntaxKind {
    return this.#kind;
  }

  /** Zero-based source-order position (query.rs:110-113). */
  ordinal(): number {
    return this.#ordinal;
  }
}

// ---------------------------------------------------------------------------
// Results and cursors
// ---------------------------------------------------------------------------

/** Eager terminal states; a failed execution throws instead of returning. */
export type QueryTerminalState = 'Completed' | 'Cancelled' | 'Failed';

/** A complete deterministic eager query result (query.rs:149). */
export class PropertiesQueryResult<M> {
  readonly #matches: readonly M[];

  constructor(matches: readonly M[]) {
    this.#matches = Object.freeze([...matches]);
  }

  /** Complete ordered matches. */
  matches(): readonly M[] {
    return this.#matches;
  }

  /** Eager execution always completes; failures throw instead (query.rs:149). */
  terminalState(): 'Completed' {
    return 'Completed';
  }
}

/** Ordered cursor over one complete result with cooperative cancellation (query.rs:152-164; query.rs:2967-3010). */
export class PropertiesQueryCursor<M> {
  readonly #matches: readonly M[];
  readonly #cancellation: CancellationToken;
  #index = 0;
  #terminal: QueryTerminalState | null = null;

  constructor(matches: readonly M[], cancellation: CancellationToken) {
    this.#matches = Object.freeze([...matches]);
    this.#cancellation = cancellation;
  }

  /** Yields the next match, or null when exhausted or cancelled (query.rs:2983-2994). */
  next(): M | null {
    if (this.#index < this.#matches.length && !this.#cancellation.isCancelled()) {
      const match = this.#matches[this.#index];
      this.#index += 1;
      return match;
    }
    this.#terminal = this.#cancellation.isCancelled() ? 'Cancelled' : 'Completed';
    return null;
  }

  /** Terminal state after exhaustion; null while matches remain (query.rs:2996-3001). */
  terminalState(): QueryTerminalState | null {
    return this.#terminal;
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface ExecutionContext {
  readonly document: PropertiesDocument;
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
 * Executes a validated Properties native semantic query against one
 * immutable snapshot (query.rs:123-150).
 */
export function executePropertiesQuery(
  executable: ExecutableQuery,
  document: PropertiesDocument,
  limits: QueryLimits,
  cancellation: CancellationToken,
): PropertiesQueryResult<PropertiesMatch> {
  const definition = executable.validated.definition;
  const domain = definition.domain;
  if (domain.id !== 'java-properties.native-semantic-query' || domain.version !== 1) {
    throw new QueryExecutionFailure('DomainMismatch', { domain });
  }
  const context: ExecutionContext = { document, limits, cancellation, steps: 0 };
  step(context, 1);
  const input: PropertiesMatch[] = [{ kind: 'Document', node: document.nodeRef() }];
  const matches = executeExpression(definition.expression, input, context);
  const selected = applySelection(matches, definition.selection);
  return new PropertiesQueryResult(selected);
}

/** Executes and exposes a complete Properties native result through an ordered cursor (query.rs:152-164). */
export function executePropertiesQueryCursor(
  executable: ExecutableQuery,
  document: PropertiesDocument,
  limits: QueryLimits,
  cancellation: CancellationToken,
): PropertiesQueryCursor<PropertiesMatch> {
  const result = executePropertiesQuery(executable, document, limits, cancellation);
  return new PropertiesQueryCursor(result.matches(), cancellation);
}

/**
 * Executes a validated Properties lossless syntax query against every
 * source piece in raw order (query.rs:166-211).
 */
export function executePropertiesSyntaxQuery(
  executable: ExecutableQuery,
  document: PropertiesDocument,
  limits: QueryLimits,
  cancellation: CancellationToken,
): PropertiesQueryResult<PropertiesSyntaxMatch> {
  const definition = executable.validated.definition;
  const domain = definition.domain;
  if (domain.id !== 'java-properties.lossless-syntax-query' || domain.version !== 1) {
    throw new QueryExecutionFailure('DomainMismatch', { domain });
  }
  const context: ExecutionContext = { document, limits, cancellation, steps: 0 };
  const pieces = document.losslessStructuralIndex().pieces();
  const kinds = document.losslessSyntaxKinds();
  step(context, pieces.length);
  const input: PropertiesSyntaxMatch[] = pieces.map((piece, ordinal) => {
    return new PropertiesSyntaxMatch(
      document.nodeRefFor(ordinal, 'PropertiesSyntaxPiece'),
      piece.span(),
      kinds[ordinal],
      ordinal,
    );
  });
  const matches = executeSyntaxExpression(definition.expression, input, context);
  const selected = applySelection(matches, definition.selection);
  return new PropertiesQueryResult(selected);
}

/** Executes and exposes a complete Properties syntax result through an ordered cursor (query.rs:213-225). */
export function executePropertiesSyntaxQueryCursor(
  executable: ExecutableQuery,
  document: PropertiesDocument,
  limits: QueryLimits,
  cancellation: CancellationToken,
): PropertiesQueryCursor<PropertiesSyntaxMatch> {
  const result = executePropertiesSyntaxQuery(executable, document, limits, cancellation);
  return new PropertiesQueryCursor(result.matches(), cancellation);
}

function executeExpression(
  expression: QueryExpression,
  input: PropertiesMatch[],
  context: ExecutionContext,
): PropertiesMatch[] {
  switch (expression.kind) {
    case 'Input':
      return input;
    case 'Apply': {
      const applied = executeExpression(expression.input, input, context);
      return applyOperator(expression.operator, applied, context);
    }
    case 'Concat': {
      let output: PropertiesMatch[] = [];
      for (const branch of expression.branches) {
        output = output.concat(executeExpression(branch, input, context));
        step(context, output.length);
      }
      return output;
    }
    case 'StructureOrderMerge': {
      let output: PropertiesMatch[] = [];
      for (const branch of expression.branches) {
        output = output.concat(executeExpression(branch, input, context));
      }
      output.sort((left, right) => {
        const leftOrder = sourceOrder(context.document, left);
        const rightOrder = sourceOrder(context.document, right);
        if (leftOrder[0] !== rightOrder[0]) {
          return leftOrder[0] - rightOrder[0];
        }
        return leftOrder[1] - rightOrder[1];
      });
      step(context, output.length);
      return output;
    }
  }
}

function executeSyntaxExpression(
  expression: QueryExpression,
  input: PropertiesSyntaxMatch[],
  context: ExecutionContext,
): PropertiesSyntaxMatch[] {
  switch (expression.kind) {
    case 'Input':
      return input;
    case 'Apply': {
      const applied = executeSyntaxExpression(expression.input, input, context);
      return applySyntaxOperator(expression.operator, applied, context);
    }
    case 'Concat': {
      let output: PropertiesSyntaxMatch[] = [];
      for (const branch of expression.branches) {
        output = output.concat(executeSyntaxExpression(branch, input, context));
        step(context, output.length);
      }
      return output;
    }
    case 'StructureOrderMerge': {
      let output: PropertiesSyntaxMatch[] = [];
      for (const branch of expression.branches) {
        output = output.concat(executeSyntaxExpression(branch, input, context));
      }
      output.sort((left, right) => left.ordinal() - right.ordinal());
      step(context, output.length);
      return output;
    }
  }
}

/** Native source-order key: (start byte, ordinal) (query.rs:609-634). */
function sourceOrder(document: PropertiesDocument, item: PropertiesMatch): [number, number] {
  switch (item.kind) {
    case 'Document':
      return [0, 0];
    case 'Property':
      return [document.property(item.node).span().startByte(), item.ordinal];
    case 'NaturalLine':
    case 'Escape':
      return [item.span.startByte(), item.ordinal];
    case 'LogicalLine': {
      const logical = document.logicalLine(item.node);
      const first = logical.naturalLines()[0];
      const start = first === undefined ? 0 : first.span().startByte();
      return [start, item.ordinal];
    }
  }
}

function applyOperator(
  operator: OperatorCall,
  input: PropertiesMatch[],
  context: ExecutionContext,
): PropertiesMatch[] {
  const output: PropertiesMatch[] = [];
  switch (operator.id) {
    case 'properties.document-properties': {
      for (const item of input) {
        if (item.kind !== 'Document') {
          continue;
        }
        const properties = context.document.properties();
        for (let ordinal = 0; ordinal < properties.length; ordinal++) {
          push(context, output, propertyMatch(properties[ordinal], ordinal));
        }
      }
      break;
    }
    case 'properties.natural-lines': {
      for (const item of input) {
        if (item.kind !== 'Document') {
          continue;
        }
        const lines = context.document.naturalLines();
        for (let ordinal = 0; ordinal < lines.length; ordinal++) {
          const line = lines[ordinal];
          push(context, output, {
            kind: 'NaturalLine',
            ordinal,
            node: line.nodeRef(),
            span: line.span(),
          });
        }
      }
      break;
    }
    case 'properties.logical-lines': {
      for (const item of input) {
        if (item.kind !== 'Document') {
          continue;
        }
        const lines = context.document.logicalLines();
        for (let ordinal = 0; ordinal < lines.length; ordinal++) {
          const line = lines[ordinal];
          push(context, output, {
            kind: 'LogicalLine',
            ordinal,
            node: line.nodeRef(),
            recordKind: line.kind(),
          });
        }
      }
      break;
    }
    case 'properties.logical-line-natural-lines': {
      for (const item of input) {
        if (item.kind !== 'LogicalLine') {
          continue;
        }
        const logical = context.document.logicalLine(item.node);
        const all = context.document.naturalLines();
        for (const natural of logical.naturalLines()) {
          const ordinal = all.findIndex((candidate) => candidate.nodeRef().equals(natural.nodeRef()));
          push(context, output, {
            kind: 'NaturalLine',
            ordinal,
            node: natural.nodeRef(),
            span: natural.span(),
          });
        }
      }
      break;
    }
    case 'properties.property-key-equals': {
      const expected = operator.arguments.get('key');
      const bytes =
        expected !== undefined && expected.kind === 'Bytes' ? expected.value : new Uint8Array(0);
      for (const item of input) {
        if (item.kind === 'Property' && item.key.equalsUtf16be(bytes)) {
          push(context, output, item);
        }
      }
      break;
    }
    case 'properties.property-value-state-is': {
      const expected = operator.arguments.get('state');
      const state =
        expected !== undefined && expected.kind === 'String' ? expected.value : '';
      for (const item of input) {
        if (item.kind === 'Property' && item.valueState === state) {
          push(context, output, item);
        }
      }
      break;
    }
    case 'properties.property-escapes': {
      for (const item of input) {
        if (item.kind !== 'Property') {
          continue;
        }
        const escapes = context.document.escapes();
        for (let ordinal = 0; ordinal < escapes.length; ordinal++) {
          const escape = escapes[ordinal];
          if (escape.property().nodeRef().equals(item.node)) {
            const range = escape.outputRange();
            push(context, output, {
              kind: 'Escape',
              ordinal,
              node: escape.nodeRef(),
              property: escape.property().nodeRef(),
              inKey: escape.inKey(),
              escapeKind: escape.kind(),
              span: escape.span(),
              outputStart: range.start,
              outputEnd: range.end,
            });
          }
        }
      }
      break;
    }
    case 'properties.duplicate-group': {
      for (const item of input) {
        if (item.kind !== 'Property' || item.duplicateGroup === null) {
          continue;
        }
        const properties = context.document.properties();
        for (let ordinal = 0; ordinal < properties.length; ordinal++) {
          if (properties[ordinal].duplicateGroup() === item.duplicateGroup) {
            push(context, output, propertyMatch(properties[ordinal], ordinal));
          }
        }
      }
      break;
    }
    case 'core.take': {
      const count = takeCount(operator);
      for (const item of input.slice(0, count)) {
        push(context, output, item);
      }
      break;
    }
    case 'core.distinct-by-identity': {
      const seen = new Set<string>();
      for (const item of input) {
        const key = nodeKey(matchIdentity(item));
        if (!seen.has(key)) {
          seen.add(key);
          push(context, output, item);
        }
      }
      break;
    }
    default:
      throw new Error(`internal: validated Properties native operator ${operator.id}`);
  }
  step(context, output.length);
  return output;
}

function applySyntaxOperator(
  operator: OperatorCall,
  input: PropertiesSyntaxMatch[],
  context: ExecutionContext,
): PropertiesSyntaxMatch[] {
  const output: PropertiesSyntaxMatch[] = [];
  switch (operator.id) {
    case 'properties.syntax-kind-is': {
      const expected = operator.arguments.get('kind');
      const kind = expected !== undefined && expected.kind === 'String' ? expected.value : '';
      for (const item of input) {
        if (item.kind() === kind) {
          push(context, output, item);
        }
      }
      break;
    }
    case 'properties.syntax-text-equals': {
      const expected = operator.arguments.get('text');
      const text = expected !== undefined && expected.kind === 'String' ? expected.value : '';
      for (const item of input) {
        if (decodedSpanText(context.document, item.span()) === text) {
          push(context, output, item);
        }
      }
      break;
    }
    case 'properties.syntax-raw-bytes-equals': {
      const expected = operator.arguments.get('bytes');
      const bytes =
        expected !== undefined && expected.kind === 'Bytes' ? expected.value : new Uint8Array(0);
      const source = context.document.source().bytes();
      for (const item of input) {
        const span = item.span();
        const start = span.startByte();
        const end = span.endByte();
        if (end - start !== bytes.length) {
          continue;
        }
        let equal = true;
        for (let i = 0; i < bytes.length; i++) {
          if (source[start + i] !== bytes[i]) {
            equal = false;
            break;
          }
        }
        if (equal) {
          push(context, output, item);
        }
      }
      break;
    }
    case 'properties.syntax-utf16be-equals': {
      const expected = operator.arguments.get('code_units');
      const bytes =
        expected !== undefined && expected.kind === 'Bytes' ? expected.value : new Uint8Array(0);
      for (const item of input) {
        if (unicodeTextEqualsUtf16be(decodedSpanText(context.document, item.span()), bytes)) {
          push(context, output, item);
        }
      }
      break;
    }
    case 'core.take': {
      const count = takeCount(operator);
      for (const item of input.slice(0, count)) {
        push(context, output, item);
      }
      break;
    }
    case 'core.distinct-by-identity': {
      const seen = new Set<string>();
      for (const item of input) {
        const key = nodeKey(item.nodeRef());
        if (!seen.has(key)) {
          seen.add(key);
          push(context, output, item);
        }
      }
      break;
    }
    default:
      throw new Error(`internal: validated Properties syntax operator ${operator.id}`);
  }
  step(context, output.length);
  return output;
}

function propertyMatch(property: ReturnType<PropertiesDocument['properties']>[number], ordinal: number): PropertiesMatch {
  return {
    kind: 'Property',
    ordinal,
    node: property.nodeRef(),
    logicalLine: property.logicalLine().nodeRef(),
    key: property.key(),
    value: property.value(),
    valueState: property.valueState(),
    duplicateGroup: property.duplicateGroup(),
  };
}

function push<T>(context: ExecutionContext, output: T[], value: T): void {
  if (output.length + 1 > context.limits.maxResults()) {
    throw new QueryExecutionFailure('ResourceLimitExceeded');
  }
  output.push(value);
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

function nodeKey(node: NodeRef): string {
  return `${node.snapshot().asBigInt().toString()}:${node.index().toString()}:${node.role()}`;
}

/** Exact decoded text of one syntax piece span (query.rs:636-651). */
function decodedSpanText(document: PropertiesDocument, span: Span): string {
  return document.spanDecodedText(span);
}

/** Exact UTF-16BE/1 byte comparison of one decoded text value (query.rs:662-673). */
function unicodeTextEqualsUtf16be(value: string, expected: Uint8Array): boolean {
  if (value.length * 2 !== expected.length) {
    return false;
  }
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (
      expected[index * 2] !== ((unit >>> 8) & 0xff) ||
      expected[index * 2 + 1] !== (unit & 0xff)
    ) {
      return false;
    }
  }
  return true;
}

/** The five frozen cardinality selections (query.rs:675-692). */
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
