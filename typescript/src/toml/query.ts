/**
 * TOML native-semantic and lossless-syntax query execution.
 *
 * authority:
 *  - domains: RFC 0001 §4 (:66-76) freezes `toml.native-semantic-query@1`
 *    and the operator registry (try-table-entries, entry-name-equals,
 *    entry-item, try-array-elements, array-element-item); the syntax domain
 *    is `toml.lossless-syntax-query@1` (crates/consema-toml/src/query.rs:
 *    136-137) with toml.syntax-kind-is / toml.syntax-text-equals
 *  - operator semantics and match shapes: crates/consema-toml/src/query.rs
 *    — TomlMatch (:10-41), TomlSyntaxMatch (:53-86), domain checks
 *    (:95-101, :136-141), expression evaluation (Input/Apply/Concat/
 *    StructureOrderMerge :213-288), operator behavior (:290-469),
 *    selection (:471-488)
 *  - steps/results accounting: query.rs:189-199 (max_steps/max_results →
 *    core.query.resource-limit@1); defaults max_steps 100_000 /
 *    max_results 100_000 (consema-core/src/query.rs:2974-2981)
 *  - failure codes: crates/consema-protocol/src/error_registry.rs —
 *    core.query.cancelled@1 :141, core.query.cardinality-violation@1 :147,
 *    core.query.resource-limit@1 :183; the kind→code mapping :1515-1527
 *  - syntax kind names: crates/consema-toml/src/lib.rs:73-88
 *  - argument decoding: PortableValue arguments (consema-core query.rs
 *    operator table; the protocol validator pins the kinds at
 *    typescript/src/protocol/query.ts:324-329, 374-376)
 *
 * Design (TypeScript-idiomatic): validation and binding live in the
 * protocol domain (validateQuery/bindQuery, typescript/src/protocol/
 * query.ts:545,1381); this module executes a bound ExecutableQuery against
 * one immutable snapshot. Execution-time failures (Cancelled,
 * ResourceLimitExceeded, CardinalityViolation) are a closed local class;
 * DomainMismatch reuses the protocol QueryFailure.
 */

import {
  QueryFailure,
} from '../protocol/query.ts';
import type {
  ExecutableQuery,
  OperatorCall,
  QueryExpression,
  QuerySelection,
} from '../protocol/query.ts';
import { CapabilitySet, newCapabilityId } from '../protocol/registry_descriptor.ts';
import { NodeRef, Span } from '../document/identity.ts';
import { TomlDocument } from './document.ts';
import type { TomlItemKind } from './parser.ts';
import { tomlSyntaxKindFromName } from './tokenizer.ts';
import type { TomlSyntaxKind } from './tokenizer.ts';
import { TomlArrayElement, TomlEntry, TomlItem } from './document.ts';

// ---------------------------------------------------------------------------
// Match and failure records
// ---------------------------------------------------------------------------

/** Owned snapshot-bound TOML native semantic query match (query.rs:10-41). */
export type TomlMatch =
  | { readonly kind: 'Item'; readonly node: NodeRef; readonly itemKind: TomlItemKind }
  | {
      readonly kind: 'Entry';
      readonly ordinal: number;
      readonly name: string;
      readonly key: NodeRef;
      readonly item: NodeRef;
      readonly entry: NodeRef;
    }
  | {
      readonly kind: 'ArrayElement';
      readonly ordinal: number;
      readonly element: NodeRef;
      readonly item: NodeRef;
    };

/** Match identity node (query.rs:43-51). */
export function tomlMatchIdentity(match: TomlMatch): NodeRef {
  switch (match.kind) {
    case 'Item':
      return match.node;
    case 'Entry':
      return match.entry;
    case 'ArrayElement':
      return match.element;
  }
}

/** Owned snapshot-bound TOML lossless syntax query match (query.rs:53-86). */
export class TomlSyntaxMatch {
  readonly #node: NodeRef;
  readonly #span: Span;
  readonly #kind: TomlSyntaxKind;
  readonly #ordinal: number;

  constructor(node: NodeRef, span: Span, kind: TomlSyntaxKind, ordinal: number) {
    this.#node = node;
    this.#span = span;
    this.#kind = kind;
    this.#ordinal = ordinal;
  }

  /** Process-local syntax-piece identity (query.rs:62-65). */
  nodeRef(): NodeRef {
    return this.#node;
  }

  /** Exact raw source span (query.rs:66-69). */
  span(): Span {
    return this.#span;
  }

  /** Format-specific lossless kind (query.rs:70-73). */
  kind(): TomlSyntaxKind {
    return this.#kind;
  }

  /** Zero-based source-order position (query.rs:74-77). */
  ordinal(): number {
    return this.#ordinal;
  }
}

/** Immutable query execution limits (consema-core query.rs:2965-2981). */
export interface TomlQueryLimits {
  /** Maximum operator steps. */
  readonly maxSteps: number;
  /** Maximum complete results buffered by an operator. */
  readonly maxResults: number;
}

/** The frozen defaults (query.rs:2974-2981): 100_000 steps, 100_000 results. */
export const DEFAULT_TOML_QUERY_LIMITS: Readonly<TomlQueryLimits> = Object.freeze({
  maxSteps: 100_000,
  maxResults: 100_000,
});

/** Cooperative cancellation signal (consema-core query.rs:2983). */
export class TomlCancellationToken {
  #cancelled = false;

  /** Requests cancellation. */
  cancel(): void {
    this.#cancelled = true;
  }

  /** Whether cancellation was requested. */
  isCancelled(): boolean {
    return this.#cancelled;
  }
}

/** Complete deterministic query execution (query.rs:112). */
export interface TomlQueryExecution<M> {
  readonly matches: readonly M[];
}

/**
 * Execution-time query failure (error_registry.rs:141,147,183; the
 * domain-mismatch failure is the protocol QueryFailure).
 */
export type TomlQueryExecutionFailureKind =
  | 'Cancelled'
  | 'ResourceLimitExceeded'
  | 'CardinalityViolation';

export class TomlQueryExecutionFailure extends Error {
  readonly kind: TomlQueryExecutionFailureKind;
  /** Frozen registered code (error_registry.rs:141/147/183; query.rs:1515-1527). */
  readonly code: string;
  /** CardinalityViolation: the requested selection and the actual match count. */
  readonly selection?: QuerySelection;
  readonly actual?: number;

  constructor(
    kind: TomlQueryExecutionFailureKind,
    options: { selection?: QuerySelection; actual?: number } = {},
  ) {
    super(`toml query: ${kind}`);
    this.name = 'TomlQueryExecutionFailure';
    this.kind = kind;
    this.code = queryExecutionFailureCode(kind);
    if (options.selection !== undefined) this.selection = options.selection;
    if (options.actual !== undefined) this.actual = options.actual;
  }
}

/** Kind→code mapping (consema-core/src/query.rs:1515-1527). */
export function queryExecutionFailureCode(kind: TomlQueryExecutionFailureKind): string {
  switch (kind) {
    case 'Cancelled':
      return 'core.query.cancelled@1';
    case 'ResourceLimitExceeded':
      return 'core.query.resource-limit@1';
    case 'CardinalityViolation':
      return 'core.query.cardinality-violation@1';
  }
}

// ---------------------------------------------------------------------------
// Execution context
// ---------------------------------------------------------------------------

class Context {
  readonly #document: TomlDocument;
  readonly #limits: TomlQueryLimits;
  readonly #cancellation: TomlCancellationToken;
  #steps = 0;

  constructor(document: TomlDocument, limits: TomlQueryLimits, cancellation: TomlCancellationToken) {
    this.#document = document;
    this.#limits = limits;
    this.#cancellation = cancellation;
  }

  step(results: number): void {
    if (this.#cancellation.isCancelled()) {
      throw new TomlQueryExecutionFailure('Cancelled');
    }
    this.#steps += 1;
    if (this.#steps > this.#limits.maxSteps || results > this.#limits.maxResults) {
      throw new TomlQueryExecutionFailure('ResourceLimitExceeded');
    }
  }

  document(): TomlDocument {
    return this.#document;
  }

  itemMatch(index: number): TomlMatch {
    const item = new TomlItem(this.#document, index);
    return { kind: 'Item', node: item.nodeRef(), itemKind: item.kind() };
  }
}

// ---------------------------------------------------------------------------
// Native semantic query
// ---------------------------------------------------------------------------

/**
 * Executes a validated TOML native semantic query against one immutable
 * snapshot (query.rs:89-113). The input is the root `TomlItem`; domain
 * mismatch is a protocol QueryFailure.
 */
export function executeTomlQuery(
  executable: ExecutableQuery,
  document: TomlDocument,
  limits: TomlQueryLimits,
  cancellation: TomlCancellationToken,
): TomlQueryExecution<TomlMatch> {
  const definition = executable.validated.definition;
  if (definition.domain.id !== 'toml.native-semantic-query' || definition.domain.version !== 1) {
    throw new QueryFailure({
      kind: 'DomainMismatch',
      operator: 'domain',
      domain: definition.domain,
    });
  }
  const context = new Context(document, limits, cancellation);
  context.step(0);
  const input = [context.itemMatch(document.root().index())];
  const matches = executeNativeExpression(definition.expression, input, context);
  const selected = applySelection(matches, definition.selection);
  return { matches: selected };
}

function executeNativeExpression(
  expression: QueryExpression,
  input: readonly TomlMatch[],
  context: Context,
): TomlMatch[] {
  switch (expression.kind) {
    case 'Input':
      return [...input];
    case 'Apply':
      return applyNativeOperator(
        executeNativeExpression(expression.input, input, context),
        expression.operator,
        context,
      );
    case 'Concat': {
      const output: TomlMatch[] = [];
      for (const branch of expression.branches) {
        output.push(...executeNativeExpression(branch, input, context));
        context.step(output.length);
      }
      return output;
    }
    case 'StructureOrderMerge': {
      const output: TomlMatch[] = [];
      for (const branch of expression.branches) {
        output.push(...executeNativeExpression(branch, input, context));
      }
      output.sort((left, right) => {
        const leftIndex = entityIndexFor(left, context);
        const rightIndex = entityIndexFor(right, context);
        const leftSpan = context.document().entity(leftIndex).span;
        const rightSpan = context.document().entity(rightIndex).span;
        if (leftSpan.startByte() !== rightSpan.startByte()) {
          return leftSpan.startByte() - rightSpan.startByte();
        }
        if (leftSpan.endByte() !== rightSpan.endByte()) {
          return leftSpan.endByte() - rightSpan.endByte();
        }
        return leftIndex - rightIndex;
      });
      context.step(output.length);
      return output;
    }
  }
}

/** Entity index of one match's identity node (query.rs:240-247). */
function entityIndexFor(match: TomlMatch, context: Context): number {
  return context.document().resolveIndex(tomlMatchIdentity(match));
}

function applyNativeOperator(
  input: readonly TomlMatch[],
  operator: OperatorCall,
  context: Context,
): TomlMatch[] {
  const output: TomlMatch[] = [];
  const document = context.document();
  switch (operator.id) {
    case 'toml.try-table-entries': {
      for (const match of input) {
        if (match.kind !== 'Item') continue;
        const item = document.item(match.node);
        const entries = item.tableEntries();
        if (entries === null) continue;
        for (const entry of entries) {
          output.push(entryMatch(entry));
        }
      }
      break;
    }
    case 'toml.entry-name-equals': {
      const expected = stringArgument(operator, 'name');
      for (const match of input) {
        if (match.kind === 'Entry' && match.name === expected) {
          output.push(match);
        }
      }
      break;
    }
    case 'toml.entry-item': {
      for (const match of input) {
        if (match.kind !== 'Entry') continue;
        const item = document.item(match.item);
        output.push({ kind: 'Item', node: item.nodeRef(), itemKind: item.kind() });
      }
      break;
    }
    case 'toml.try-array-elements': {
      for (const match of input) {
        if (match.kind !== 'Item') continue;
        const item = document.item(match.node);
        const elements = item.arrayElements();
        if (elements === null) continue;
        for (const element of elements) {
          output.push(elementMatch(element));
        }
      }
      break;
    }
    case 'toml.array-element-item': {
      for (const match of input) {
        if (match.kind !== 'ArrayElement') continue;
        const item = document.item(match.item);
        output.push({ kind: 'Item', node: item.nodeRef(), itemKind: item.kind() });
      }
      break;
    }
    case 'core.take': {
      const count = integerArgument(operator, 'count');
      output.push(...input.slice(0, count));
      break;
    }
    case 'core.distinct-by-identity': {
      const seen = new Set<NodeRef>();
      for (const match of input) {
        const identity = tomlMatchIdentity(match);
        if (!seen.has(identity)) {
          seen.add(identity);
          output.push(match);
        }
      }
      break;
    }
    default:
      throw new Error(`internal: validated TOML native operator ${operator.id}`);
  }
  context.step(output.length);
  return output;
}

function entryMatch(entry: TomlEntry): TomlMatch {
  return {
    kind: 'Entry',
    ordinal: entry.ordinal(),
    name: entry.name(),
    key: entry.keyNodeRef(),
    item: entry.itemNodeRef(),
    entry: entry.nodeRef(),
  };
}

function elementMatch(element: TomlArrayElement): TomlMatch {
  return {
    kind: 'ArrayElement',
    ordinal: element.ordinal(),
    element: element.nodeRef(),
    item: element.itemNodeRef(),
  };
}

// ---------------------------------------------------------------------------
// Lossless syntax query
// ---------------------------------------------------------------------------

/**
 * Executes a validated TOML lossless syntax query against every source
 * piece in raw order (query.rs:130-169).
 */
export function executeTomlSyntaxQuery(
  executable: ExecutableQuery,
  document: TomlDocument,
  limits: TomlQueryLimits,
  cancellation: TomlCancellationToken,
): TomlQueryExecution<TomlSyntaxMatch> {
  const definition = executable.validated.definition;
  if (definition.domain.id !== 'toml.lossless-syntax-query' || definition.domain.version !== 1) {
    throw new QueryFailure({
      kind: 'DomainMismatch',
      operator: 'domain',
      domain: definition.domain,
    });
  }
  const context = new Context(document, limits, cancellation);
  const pieces = document.losslessStructuralIndex().pieces();
  const kinds = document.losslessSyntaxKinds();
  context.step(pieces.length);
  const input: TomlSyntaxMatch[] = pieces.map((piece, ordinal) => {
    const span = piece.span();
    return new TomlSyntaxMatch(
      document.nodeRef(ordinal, 'TomlSyntaxPiece'),
      span,
      kinds[ordinal],
      ordinal,
    );
  });
  const matches = executeSyntaxExpression(definition.expression, input, context);
  const selected = applySelection(matches, definition.selection);
  return { matches: selected };
}

function executeSyntaxExpression(
  expression: QueryExpression,
  input: readonly TomlSyntaxMatch[],
  context: Context,
): TomlSyntaxMatch[] {
  switch (expression.kind) {
    case 'Input':
      return [...input];
    case 'Apply':
      return applySyntaxOperator(
        executeSyntaxExpression(expression.input, input, context),
        expression.operator,
        context,
      );
    case 'Concat': {
      const output: TomlSyntaxMatch[] = [];
      for (const branch of expression.branches) {
        output.push(...executeSyntaxExpression(branch, input, context));
        context.step(output.length);
      }
      return output;
    }
    case 'StructureOrderMerge': {
      const output: TomlSyntaxMatch[] = [];
      for (const branch of expression.branches) {
        output.push(...executeSyntaxExpression(branch, input, context));
      }
      output.sort((left, right) => left.ordinal() - right.ordinal());
      context.step(output.length);
      return output;
    }
  }
}

function applySyntaxOperator(
  input: readonly TomlSyntaxMatch[],
  operator: OperatorCall,
  context: Context,
): TomlSyntaxMatch[] {
  const output: TomlSyntaxMatch[] = [];
  const document = context.document();
  const text = document.source().decodedText() ?? '';
  switch (operator.id) {
    case 'toml.syntax-kind-is': {
      const expected = tomlSyntaxKindFromName(stringArgument(operator, 'kind'));
      if (expected === null) {
        throw new Error('internal: validated syntax kind argument');
      }
      for (const match of input) {
        if (match.kind() === expected) output.push(match);
      }
      break;
    }
    case 'toml.syntax-text-equals': {
      const expected = stringArgument(operator, 'text');
      for (const match of input) {
        const span = match.span();
        if (text.slice(span.startByte(), span.endByte()) === expected) output.push(match);
      }
      break;
    }
    case 'core.take': {
      const count = integerArgument(operator, 'count');
      output.push(...input.slice(0, count));
      break;
    }
    case 'core.distinct-by-identity': {
      const seen = new Set<NodeRef>();
      for (const match of input) {
        if (!seen.has(match.nodeRef())) {
          seen.add(match.nodeRef());
          output.push(match);
        }
      }
      break;
    }
    default:
      throw new Error(`internal: validated TOML syntax operator ${operator.id}`);
  }
  context.step(output.length);
  return output;
}

// ---------------------------------------------------------------------------
// Argument decoding and selection
// ---------------------------------------------------------------------------

/** Decodes a validated String argument (protocol validation guarantees the kind). */
function stringArgument(operator: OperatorCall, name: string): string {
  const value = operator.arguments.get(name);
  if (value === undefined || value.kind !== 'String') {
    throw new Error(`internal: validated string argument ${name}`);
  }
  return value.value;
}

/** Decodes a validated Integer argument (protocol validation guarantees the kind). */
function integerArgument(operator: OperatorCall, name: string): number {
  const value = operator.arguments.get(name);
  if (value === undefined || value.kind !== 'Integer') {
    throw new Error(`internal: validated integer argument ${name}`);
  }
  return Number(value.value);
}

function applySelection<T>(values: readonly T[], selection: QuerySelection): T[] {
  switch (selection) {
    case 'All':
      return [...values];
    case 'First':
      return values.slice(0, 1);
    case 'Last':
      return values.length === 0 ? [] : [values[values.length - 1]];
    case 'ZeroOrOne':
      if (values.length <= 1) return [...values];
      throw new TomlQueryExecutionFailure('CardinalityViolation', {
        selection: 'ZeroOrOne',
        actual: values.length,
      });
    case 'RequireOne':
      if (values.length === 1) return [...values];
      throw new TomlQueryExecutionFailure('CardinalityViolation', {
        selection: 'RequireOne',
        actual: values.length,
      });
    default:
      throw new Error(`internal: validated query selection ${selection}`);
  }
}

// ---------------------------------------------------------------------------
// Capability helper
// ---------------------------------------------------------------------------

/** The required capability set of every validated query (protocol/query.ts:554-560). */
export function tomlQueryRequiredCapabilities(): CapabilitySet {
  const capabilities = new CapabilitySet();
  capabilities.insert(newCapabilityId('core.query.ordered-results', 1));
  return capabilities;
}
