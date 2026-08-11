/**
 * HCL native-semantic and lossless-syntax query execution (RFC 0014 §7).
 *
 * authority:
 *  - domains and operator vocabulary: RFC 0014 §7.1 (:452-467) freezes
 *    `hcl.native-semantic-query@1` with the sixteen operators and §7.2
 *    (:483-507) freezes `hcl.lossless-syntax-query@1` with the two syntax
 *    filters; crates/consema-hcl/src/query.rs:558-585 (native dispatch),
 *    :1189-1200 (syntax dispatch)
 *  - operator semantics: query.rs — HclMatch (:10-112, ErrorRegion carries
 *    its zero-based position :104-111), HclSyntaxMatch (:128-137), the
 *    document-level facts (document-body :594-611, error-regions :1125-1149),
 *    body-item selection (:613-790), the typed literal accessor family
 *    (:795-860: as-string/as-integer/as-real/as-boolean-is/as-null-is;
 *    RequiredTypeMismatch → hcl.query.type-mismatch@1, TargetUnavailable →
 *    hcl.query.non-literal@1), block facts (:862-960), expression facts
 *    (:962-1020: kind-is on the closed name set, is-literal, text),
 *    children/parts/elements/entries (:1016-1123), the syntax filters
 *    (kind-is, text-equals :1180-1260)
 *  - failure codes: crates/consema-conformance/src/hcl_v1.rs:656-670 — the
 *    eleven `hcl.query.*@1` spellings; argument decoding follows the
 *    conformance filter builder (:560-611: name/accessor/type/label/kind/
 *    text argument names)
 *  - selection and limits: the core query contract (typescript/src/
 *    protocol/query.ts) — selection kinds, max_steps/max_results defaults
 *
 * Design (TypeScript-idiomatic): validation and binding live in the
 * protocol domain (validateQuery/bindQuery); this module executes a bound
 * ExecutableQuery against one immutable snapshot. Execution-time failures
 * (Cancelled, ResourceLimitExceeded, CardinalityViolation,
 * RequiredTypeMismatch, TargetUnavailable) are a closed local class with
 * the frozen `hcl.query.*@1` codes; DomainMismatch reuses the protocol
 * QueryFailure. Matches are plain discriminated unions over entity
 * indices; expression facts are derived from the snapshot-bound AST.
 */

import { QueryFailure } from '../protocol/query.ts';
import type {
  ExecutableQuery,
  OperatorCall,
  QueryExpression,
  QuerySelection,
} from '../protocol/query.ts';
import { CapabilitySet, newCapabilityId } from '../protocol/registry_descriptor.ts';
import type { NodeRef, Span } from '../document/identity.ts';
import { HclDocument, HclErrorRegion, directChildrenOf } from './document.ts';
import { expressionKindNameFromName, isLiteralComplete, literalValue, expressionKindOf } from './expression.ts';
import { hclSyntaxKindFromName } from './tokenizer.ts';
import type { HclSyntaxKind } from './tokenizer.ts';
import {
  codeHclQueryCancelled,
  codeHclQueryCardinalityViolation,
  codeHclQueryResourceLimit,
  codeHclQueryTypeMismatch,
  codeHclQueryNonLiteral,
} from './errors.ts';

// ---------------------------------------------------------------------------
// Match and failure records
// ---------------------------------------------------------------------------

/** Owned snapshot-bound HCL native semantic query match (query.rs:10-112). */
export type HclMatch =
  | { readonly kind: 'Body'; readonly node: NodeRef; readonly index: number }
  | { readonly kind: 'Attribute'; readonly node: NodeRef; readonly index: number }
  | { readonly kind: 'Block'; readonly node: NodeRef; readonly index: number }
  | { readonly kind: 'BlockLabel'; readonly node: NodeRef; readonly index: number }
  | { readonly kind: 'Expression'; readonly node: NodeRef; readonly index: number }
  | { readonly kind: 'TemplatePart'; readonly node: NodeRef; readonly index: number }
  | {
      readonly kind: 'ErrorRegion';
      readonly node: NodeRef;
      readonly index: number;
      readonly code: string;
      /** Zero-based position within the document's ordered error regions (query.rs:104-111). */
      readonly position: number;
    };

/** Match identity node (query.rs:114-126). */
export function hclMatchIdentity(match: HclMatch): NodeRef {
  return match.node;
}

/** Owned snapshot-bound HCL lossless syntax query match (query.rs:128-137). */
export class HclSyntaxMatch {
  readonly #node: NodeRef;
  readonly #span: Span;
  readonly #kind: HclSyntaxKind;
  readonly #ordinal: number;

  constructor(node: NodeRef, span: Span, kind: HclSyntaxKind, ordinal: number) {
    this.#node = node;
    this.#span = span;
    this.#kind = kind;
    this.#ordinal = ordinal;
  }

  /** Process-local syntax-piece identity. */
  nodeRef(): NodeRef {
    return this.#node;
  }

  /** Exact raw source span. */
  span(): Span {
    return this.#span;
  }

  /** Format-specific lossless kind (RFC 0014 §7.2). */
  kind(): HclSyntaxKind {
    return this.#kind;
  }

  /** Zero-based source-order position. */
  ordinal(): number {
    return this.#ordinal;
  }
}

/** Immutable query execution limits (max_steps/max_results, defaults 100_000). */
export interface HclQueryLimits {
  readonly maxSteps: number;
  readonly maxResults: number;
}

/** The frozen defaults: 100_000 steps, 100_000 results. */
export const DEFAULT_HCL_QUERY_LIMITS: Readonly<HclQueryLimits> = Object.freeze({
  maxSteps: 100_000,
  maxResults: 100_000,
});

/** Cooperative cancellation signal. */
export class HclCancellationToken {
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

/** Complete deterministic query execution. */
export interface HclQueryExecution<M> {
  readonly matches: readonly M[];
}

/**
 * Execution-time query failure (hcl_v1.rs:656-670); the domain-mismatch
 * failure is the protocol QueryFailure.
 */
export type HclQueryExecutionFailureKind =
  | 'Cancelled'
  | 'ResourceLimitExceeded'
  | 'CardinalityViolation'
  | 'RequiredTypeMismatch'
  | 'TargetUnavailable';

export class HclQueryExecutionFailure extends Error {
  readonly kind: HclQueryExecutionFailureKind;
  /** Frozen registered code (hcl_v1.rs:656-670). */
  readonly code: string;
  /** CardinalityViolation: the requested selection and the actual match count. */
  readonly selection?: QuerySelection;
  readonly actual?: number;

  constructor(
    kind: HclQueryExecutionFailureKind,
    options: { selection?: QuerySelection; actual?: number } = {},
  ) {
    super(`hcl query: ${kind}`);
    this.name = 'HclQueryExecutionFailure';
    this.kind = kind;
    this.code = hclQueryExecutionFailureCode(kind);
    if (options.selection !== undefined) this.selection = options.selection;
    if (options.actual !== undefined) this.actual = options.actual;
  }
}

/** Kind→code mapping (hcl_v1.rs:656-670). */
export function hclQueryExecutionFailureCode(kind: HclQueryExecutionFailureKind): string {
  switch (kind) {
    case 'Cancelled':
      return codeHclQueryCancelled;
    case 'ResourceLimitExceeded':
      return codeHclQueryResourceLimit;
    case 'CardinalityViolation':
      return codeHclQueryCardinalityViolation;
    case 'RequiredTypeMismatch':
      return codeHclQueryTypeMismatch;
    case 'TargetUnavailable':
      return codeHclQueryNonLiteral;
  }
}

// ---------------------------------------------------------------------------
// Execution context
// ---------------------------------------------------------------------------

class Context {
  readonly #document: HclDocument;
  readonly #limits: HclQueryLimits;
  readonly #cancellation: HclCancellationToken;
  #steps = 0;

  constructor(document: HclDocument, limits: HclQueryLimits, cancellation: HclCancellationToken) {
    this.#document = document;
    this.#limits = limits;
    this.#cancellation = cancellation;
  }

  step(results: number): void {
    if (this.#cancellation.isCancelled()) {
      throw new HclQueryExecutionFailure('Cancelled');
    }
    this.#steps += 1;
    if (this.#steps > this.#limits.maxSteps || results > this.#limits.maxResults) {
      throw new HclQueryExecutionFailure('ResourceLimitExceeded');
    }
  }

  document(): HclDocument {
    return this.#document;
  }
}

// ---------------------------------------------------------------------------
// Native semantic query
// ---------------------------------------------------------------------------

/**
 * Executes a validated HCL native semantic query against one immutable
 * snapshot (RFC 0014 §7.1). The input is the document's root body;
 * domain mismatch is a protocol QueryFailure.
 */
export function executeHclNativeQuery(
  executable: ExecutableQuery,
  document: HclDocument,
  limits: HclQueryLimits,
  cancellation: HclCancellationToken,
): HclQueryExecution<HclMatch> {
  const definition = executable.validated.definition;
  if (definition.domain.id !== 'hcl.native-semantic-query' || definition.domain.version !== 1) {
    throw new QueryFailure({
      kind: 'DomainMismatch',
      operator: 'domain',
      domain: definition.domain,
    });
  }
  const context = new Context(document, limits, cancellation);
  context.step(0);
  const rootIndex = document.root().index();
  const input: HclMatch[] = [{ kind: 'Body', node: document.nodeRef(rootIndex, 'HclBody'), index: rootIndex }];
  const matches = executeNativeExpression(definition.expression, input, context);
  const selected = applySelection(matches, definition.selection, context);
  return { matches: selected };
}

function executeNativeExpression(
  expression: QueryExpression,
  input: readonly HclMatch[],
  context: Context,
): HclMatch[] {
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
      const output: HclMatch[] = [];
      for (const branch of expression.branches) {
        output.push(...executeNativeExpression(branch, input, context));
        context.step(output.length);
      }
      return output;
    }
    case 'StructureOrderMerge': {
      const output: HclMatch[] = [];
      for (const branch of expression.branches) {
        output.push(...executeNativeExpression(branch, input, context));
      }
      output.sort((left, right) => rankMatch(left, context) - rankMatch(right, context));
      context.step(output.length);
      return output;
    }
  }
}

/** Deterministic source-order rank of one native match (query.rs:400-423). */
function rankMatch(match: HclMatch, context: Context): number {
  const document = context.document();
  if (match.kind === 'ErrorRegion') {
    return document.entityCount() + match.position;
  }
  const span = entitySpan(document, match.index);
  return span.startByte() * 2 + (span.endByte() - span.startByte());
}

function entitySpan(document: HclDocument, index: number): Span {
  return document.entity(index).span;
}

function applyNativeOperator(
  input: readonly HclMatch[],
  operator: OperatorCall,
  context: Context,
): HclMatch[] {
  const output: HclMatch[] = [];
  const document = context.document();
  switch (operator.id) {
    case 'hcl.document-body': {
      // A document-level fact emitted once from any non-empty input.
      if (input.length > 0) {
        const rootIndex = document.root().index();
        output.push({ kind: 'Body', node: document.nodeRef(rootIndex, 'HclBody'), index: rootIndex });
      }
      break;
    }
    case 'hcl.body-items': {
      for (const match of input) {
        if (match.kind !== 'Body') continue;
        const items = document.bodyEntity(match.index).items;
        for (const itemIndex of items) {
          const entity = document.entity(itemIndex);
          if (entity.role === 'Attribute') {
            output.push({ kind: 'Attribute', node: document.nodeRef(itemIndex, 'HclAttribute'), index: itemIndex });
          } else {
            output.push({ kind: 'Block', node: document.nodeRef(itemIndex, 'HclBlock'), index: itemIndex });
          }
        }
      }
      break;
    }
    case 'hcl.body-attributes': {
      for (const match of input) {
        if (match.kind !== 'Body') continue;
        const items = document.bodyEntity(match.index).items;
        for (const itemIndex of items) {
          if (document.entity(itemIndex).role === 'Attribute') {
            output.push({ kind: 'Attribute', node: document.nodeRef(itemIndex, 'HclAttribute'), index: itemIndex });
          }
        }
      }
      break;
    }
    case 'hcl.body-blocks': {
      for (const match of input) {
        if (match.kind !== 'Body') continue;
        const items = document.bodyEntity(match.index).items;
        for (const itemIndex of items) {
          if (document.entity(itemIndex).role === 'Block') {
            output.push({ kind: 'Block', node: document.nodeRef(itemIndex, 'HclBlock'), index: itemIndex });
          }
        }
      }
      break;
    }
    case 'hcl.body-block-type-equals': {
      const expected = stringArgument(operator, 'type');
      for (const match of input) {
        if (match.kind !== 'Block') continue;
        if (document.blockEntity(match.index).type === expected) {
          output.push(match);
        }
      }
      break;
    }
    case 'hcl.attribute-name': {
      for (const match of input) {
        if (match.kind === 'Attribute') {
          output.push(match);
        }
      }
      break;
    }
    case 'hcl.attribute-name-equals': {
      const expected = stringArgument(operator, 'name');
      for (const match of input) {
        if (match.kind === 'Attribute' && document.attributeEntity(match.index).name === expected) {
          output.push(match);
        }
      }
      break;
    }
    case 'hcl.attribute-expression': {
      for (const match of input) {
        if (match.kind !== 'Attribute') continue;
        const expressionIndex = document.attributeEntity(match.index).expression;
        output.push({ kind: 'Expression', node: document.nodeRef(expressionIndex, 'HclExpression'), index: expressionIndex });
      }
      break;
    }
    case 'hcl.attribute-literal-value': {
      const accessor = stringArgument(operator, 'accessor');
      for (const match of input) {
        // The accessor accepts a plain expression match or an attribute's
        // value expression (query.rs:838-846 expression_payload).
        let expressionIndex: number;
        if (match.kind === 'Attribute') {
          expressionIndex = document.attributeEntity(match.index).expression;
        } else if (match.kind === 'Expression') {
          expressionIndex = match.index;
        } else {
          continue;
        }
        const node = document.expressionEntity(expressionIndex).kind;
        const literal = literalValue(node);
        if (literal === null) {
          throw new HclQueryExecutionFailure('TargetUnavailable');
        }
        if (!accessorAccepts(accessor, literal)) {
          throw new HclQueryExecutionFailure('RequiredTypeMismatch');
        }
        output.push({ kind: 'Expression', node: document.nodeRef(expressionIndex, 'HclExpression'), index: expressionIndex });
      }
      break;
    }
    case 'hcl.block-type': {
      for (const match of input) {
        if (match.kind === 'Block') {
          output.push(match);
        }
      }
      break;
    }
    case 'hcl.block-type-equals': {
      const expected = stringArgument(operator, 'type');
      for (const match of input) {
        if (match.kind === 'Block' && document.blockEntity(match.index).type === expected) {
          output.push(match);
        }
      }
      break;
    }
    case 'hcl.block-labels': {
      for (const match of input) {
        if (match.kind !== 'Block') continue;
        for (const labelIndex of document.blockEntity(match.index).labels) {
          output.push({ kind: 'BlockLabel', node: document.nodeRef(labelIndex, 'HclBlockLabel'), index: labelIndex });
        }
      }
      break;
    }
    case 'hcl.block-label-equals': {
      const expected = stringArgument(operator, 'label');
      for (const match of input) {
        if (match.kind !== 'BlockLabel') continue;
        if (document.blockLabelEntity(match.index).text === expected) {
          output.push(match);
        }
      }
      break;
    }
    case 'hcl.block-nested-body': {
      for (const match of input) {
        if (match.kind !== 'Block') continue;
        const bodyIndex = document.blockEntity(match.index).body;
        output.push({ kind: 'Body', node: document.nodeRef(bodyIndex, 'HclBody'), index: bodyIndex });
      }
      break;
    }
    case 'hcl.expression-kind-is': {
      const expected = expressionKindNameFromName(stringArgument(operator, 'kind'));
      if (expected === null) {
        throw new Error('internal: validated expression kind argument');
      }
      for (const match of input) {
        if (match.kind !== 'Expression') continue;
        const node = document.expressionEntity(match.index).kind;
        if (expressionKindOf(node) === expected) {
          output.push(match);
        }
      }
      break;
    }
    case 'hcl.expression-is-literal': {
      for (const match of input) {
        if (match.kind !== 'Expression') continue;
        const node = document.expressionEntity(match.index).kind;
        if (isLiteralComplete(node)) {
          output.push(match);
        }
      }
      break;
    }
    case 'hcl.expression-text': {
      for (const match of input) {
        if (match.kind === 'Expression') {
          output.push(match);
        }
      }
      break;
    }
    case 'hcl.expression-children': {
      for (const match of input) {
        if (match.kind !== 'Expression') continue;
        const node = document.expressionEntity(match.index).kind;
        for (const child of directChildrenOf(node)) {
          const childIndex = document.indexOf(child);
          output.push({ kind: 'Expression', node: document.nodeRef(childIndex, 'HclExpression'), index: childIndex });
        }
      }
      break;
    }
    case 'hcl.template-parts': {
      for (const match of input) {
        if (match.kind !== 'Expression') continue;
        const node = document.expressionEntity(match.index).kind;
        if (node.kind !== 'Template') continue;
        for (const part of node.parts) {
          const partIndex = document.indexOf(part);
          output.push({ kind: 'TemplatePart', node: document.nodeRef(partIndex, 'HclTemplatePart'), index: partIndex });
        }
      }
      break;
    }
    case 'hcl.tuple-elements': {
      for (const match of input) {
        if (match.kind !== 'Expression') continue;
        const node = document.expressionEntity(match.index).kind;
        if (node.kind !== 'Tuple') continue;
        for (const element of node.elements) {
          const elementIndex = document.indexOf(element);
          output.push({ kind: 'Expression', node: document.nodeRef(elementIndex, 'HclExpression'), index: elementIndex });
        }
      }
      break;
    }
    case 'hcl.object-entries': {
      for (const match of input) {
        if (match.kind !== 'Expression') continue;
        const node = document.expressionEntity(match.index).kind;
        if (node.kind !== 'Object') continue;
        for (const entry of node.entries) {
          const valueIndex = document.indexOf(entry.value);
          output.push({ kind: 'Expression', node: document.nodeRef(valueIndex, 'HclExpression'), index: valueIndex });
        }
      }
      break;
    }
    case 'hcl.error-regions': {
      // A document-level fact set emitted once from any non-empty input
      // (query.rs:1125-1149).
      if (input.length > 0) {
        const regions = document.errorRegions();
        for (let position = 0; position < regions.length; position++) {
          const region: HclErrorRegion = regions[position];
          output.push({
            kind: 'ErrorRegion',
            node: region.nodeRef(),
            index: region.index(),
            code: region.code(),
            position,
          });
        }
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
        const identity = hclMatchIdentity(match);
        if (!seen.has(identity)) {
          seen.add(identity);
          output.push(match);
        }
      }
      break;
    }
    default:
      throw new Error(`internal: validated HCL native operator ${operator.id}`);
  }
  context.step(output.length);
  return output;
}

/** Whether one typed literal satisfies one accessor (query.rs:795-860). */
function accessorAccepts(accessor: string, literal: NonNullable<ReturnType<typeof literalValue>>): boolean {
  switch (accessor) {
    case 'as-string':
      return literal.kind === 'String';
    case 'as-integer':
      return literal.kind === 'Integer';
    case 'as-real':
      return literal.kind === 'Decimal';
    case 'as-boolean-is':
      return literal.kind === 'Boolean';
    case 'as-null-is':
      return literal.kind === 'Null';
    default:
      throw new Error(`internal: validated literal accessor ${accessor}`);
  }
}

// ---------------------------------------------------------------------------
// Lossless syntax query
// ---------------------------------------------------------------------------

/**
 * Executes a validated HCL lossless syntax query against every source
 * piece in raw order (RFC 0014 §7.2).
 */
export function executeHclSyntaxQuery(
  executable: ExecutableQuery,
  document: HclDocument,
  limits: HclQueryLimits,
  cancellation: HclCancellationToken,
): HclQueryExecution<HclSyntaxMatch> {
  const definition = executable.validated.definition;
  if (definition.domain.id !== 'hcl.lossless-syntax-query' || definition.domain.version !== 1) {
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
  const input: HclSyntaxMatch[] = pieces.map((piece, ordinal) => {
    const span = piece.span();
    return new HclSyntaxMatch(
      document.nodeRef(ordinal, 'HclSyntaxPiece'),
      span,
      kinds[ordinal],
      ordinal,
    );
  });
  const matches = executeSyntaxExpression(definition.expression, input, context);
  const selected = applySelection(matches, definition.selection, context);
  return { matches: selected };
}

function executeSyntaxExpression(
  expression: QueryExpression,
  input: readonly HclSyntaxMatch[],
  context: Context,
): HclSyntaxMatch[] {
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
      const output: HclSyntaxMatch[] = [];
      for (const branch of expression.branches) {
        output.push(...executeSyntaxExpression(branch, input, context));
        context.step(output.length);
      }
      return output;
    }
    case 'StructureOrderMerge': {
      const output: HclSyntaxMatch[] = [];
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
  input: readonly HclSyntaxMatch[],
  operator: OperatorCall,
  context: Context,
): HclSyntaxMatch[] {
  const output: HclSyntaxMatch[] = [];
  const document = context.document();
  const decoded = document.source().decodedText() ?? '';
  switch (operator.id) {
    case 'hcl.syntax-kind-is': {
      const expected = hclSyntaxKindFromName(stringArgument(operator, 'kind'));
      if (expected === null) {
        throw new Error('internal: validated syntax kind argument');
      }
      for (const match of input) {
        if (match.kind() === expected) output.push(match);
      }
      break;
    }
    case 'hcl.syntax-text-equals': {
      const expected = stringArgument(operator, 'text');
      for (const match of input) {
        const span = match.span();
        const text = decoded.slice(
          document.source().decodedPosition(span.startByte()).utf16CodeUnitOffset,
          document.source().decodedPosition(span.endByte()).utf16CodeUnitOffset,
        );
        if (text === expected) output.push(match);
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
      throw new Error(`internal: validated HCL syntax operator ${operator.id}`);
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

function applySelection<T>(values: readonly T[], selection: QuerySelection, context: Context): T[] {
  switch (selection) {
    case 'All':
      return [...values];
    case 'First':
      return values.slice(0, 1);
    case 'Last':
      return values.length === 0 ? [] : [values[values.length - 1]];
    case 'ZeroOrOne':
      if (values.length <= 1) return [...values];
      throw new HclQueryExecutionFailure('CardinalityViolation', {
        selection: 'ZeroOrOne',
        actual: values.length,
      });
    case 'RequireOne':
      if (values.length === 1) return [...values];
      throw new HclQueryExecutionFailure('CardinalityViolation', {
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

/** The required capability set of every validated query. */
export function hclQueryRequiredCapabilities(): CapabilitySet {
  const capabilities = new CapabilitySet();
  capabilities.insert(newCapabilityId('core.query.ordered-results', 1));
  return capabilities;
}
