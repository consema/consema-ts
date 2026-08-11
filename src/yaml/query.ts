/**
 * Native and lossless-syntax query execution over one immutable snapshot.
 *
 * authority: crates/consema-yaml/src/query.rs
 *  - YamlMatch :12-99 (Stream | Document | Node | MappingEntry |
 *    SequenceElement | AnchorDefinition | AliasOccurrence)
 *  - YamlSyntaxMatch :131-164
 *  - execute_yaml_query :167-197 (domain gate :173-177; the stream is the
 *    first standard result :187-191), execute_yaml_syntax_query :214-255
 *  - Context.step :279-288 (cancellation, max_steps, max_results)
 *  - operator semantics :394-596 (yaml.documents, yaml.document-root,
 *    yaml.where-node-kind, yaml.where-tag, yaml.scalar-canonical-equals,
 *    yaml.try-sequence-elements, yaml.sequence-element-node,
 *    yaml.try-mapping-entries, yaml.mapping-entry-key,
 *    yaml.mapping-entry-value, yaml.anchor-definition, yaml.anchor-node,
 *    yaml.alias-occurrences, yaml.alias-target, core.take,
 *    core.distinct-by-identity), :598-649 (yaml.syntax-kind-is,
 *    yaml.syntax-text-equals)
 *  - expression evaluation :313-392 (Input/Apply/Concat/
 *    StructureOrderMerge; native merge sorts by (span.start, span.end,
 *    role order, index) :340-355, syntax merge by piece ordinal :382-389)
 *  - apply_selection :690-707 (All/First/Last/ZeroOrOne/RequireOne)
 *  - QueryLimits defaults (max_steps 100_000, max_results 100_000):
 *    crates/consema-core/src/query.rs:2967-2981
 *  - query definition/operator validation: typescript/src/protocol/query.ts
 *    (validateQuery/bindQuery; the YAML operator table rows :333-346,
 *    :380-381; the YAML syntax-kind vocabulary :1117-1148)
 *
 * Design (TypeScript-idiomatic): execution is eager and deterministic —
 * the complete match list is returned in source order, or a typed
 * `QueryExecutionFailure` with the frozen registered code is thrown
 * (no partial completed result exists).
 */

import type { NodeRef, Span } from '../document/identity.ts';
import { QueryExecutionFailure } from './errors.ts';
import type { YamlDocument } from './document.ts';
import type { YamlNodeKind } from './semantic.ts';
import type { YamlSyntaxKind } from './syntax.ts';
import type { YamlScalarKind } from './semantic.ts';
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

/** Cooperative cancellation flag (core CancellationToken). */
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

/** Owned snapshot-bound YAML native semantic query match (query.rs:12-99). */
export type YamlMatch =
  | {
      readonly kind: 'Stream';
      /** Stream identity. */
      readonly stream: NodeRef;
      /** Exact raw source span. */
      readonly span: Span;
      /** Number of independent documents. */
      readonly documentCount: number;
    }
  | {
      readonly kind: 'Document';
      /** Zero-based stream ordinal. */
      readonly ordinal: number;
      /** Document identity. */
      readonly document: NodeRef;
      /** Representation root identity. */
      readonly root: NodeRef;
      /** Raw presentation span. */
      readonly span: Span;
    }
  | {
      readonly kind: 'Node';
      /** Representation identity. */
      readonly node: NodeRef;
      /** Scalar, sequence, or mapping. */
      readonly nodeKind: YamlNodeKind;
      /** Resolved global tag URI. */
      readonly tag: string;
      /** Scalar category when the node is scalar. */
      readonly scalarKind: YamlScalarKind | null;
      /** Canonical scalar content when the node is scalar. */
      readonly canonical: string | null;
      /** Defining anchor name, when present. */
      readonly anchor: string | null;
      /** Raw representation span. */
      readonly span: Span;
    }
  | {
      readonly kind: 'MappingEntry';
      /** Zero-based direct association ordinal. */
      readonly ordinal: number;
      /** Association identity. */
      readonly entry: NodeRef;
      /** Arbitrary key representation identity. */
      readonly key: NodeRef;
      /** Value representation identity. */
      readonly value: NodeRef;
      /** Raw association span. */
      readonly span: Span;
    }
  | {
      readonly kind: 'SequenceElement';
      /** Zero-based direct association ordinal. */
      readonly ordinal: number;
      /** Association identity. */
      readonly element: NodeRef;
      /** Referenced representation identity. */
      readonly node: NodeRef;
      /** Raw element occurrence span. */
      readonly span: Span;
    }
  | {
      readonly kind: 'AnchorDefinition';
      /** Exact anchor name without `&`. */
      readonly name: string;
      /** Definition occurrence identity. */
      readonly definition: NodeRef;
      /** Anchored representation identity. */
      readonly node: NodeRef;
      /** Exact raw `&name` span. */
      readonly span: Span;
    }
  | {
      readonly kind: 'AliasOccurrence';
      /** Zero-based serialization-order ordinal. */
      readonly ordinal: number;
      /** Exact alias name without `*`. */
      readonly name: string;
      /** Alias occurrence identity. */
      readonly alias: NodeRef;
      /** Shared target representation identity. */
      readonly target: NodeRef;
      /** Exact raw `*name` span. */
      readonly span: Span;
    };

/** Primary process-local identity for one match (query.rs:102-113). */
export function matchNodeRef(match: YamlMatch): NodeRef {
  switch (match.kind) {
    case 'Stream':
      return match.stream;
    case 'Document':
      return match.document;
    case 'Node':
      return match.node;
    case 'MappingEntry':
      return match.entry;
    case 'SequenceElement':
      return match.element;
    case 'AnchorDefinition':
      return match.definition;
    case 'AliasOccurrence':
      return match.alias;
  }
}

/** Exact raw source span associated with one match (query.rs:116-128). */
export function matchSpan(match: YamlMatch): Span {
  return match.span;
}

/** Owned snapshot-bound YAML lossless syntax query match (query.rs:131-138). */
export class YamlSyntaxMatch {
  readonly #node: NodeRef;
  readonly #span: Span;
  readonly #kind: YamlSyntaxKind;
  readonly #ordinal: number;

  constructor(node: NodeRef, span: Span, kind: YamlSyntaxKind, ordinal: number) {
    this.#node = node;
    this.#span = span;
    this.#kind = kind;
    this.#ordinal = ordinal;
  }

  /** Process-local syntax-piece identity (query.rs:141-146). */
  nodeRef(): NodeRef {
    return this.#node;
  }

  /** Exact raw source span (query.rs:148-151). */
  span(): Span {
    return this.#span;
  }

  /** Format-specific lossless kind (query.rs:153-156). */
  kind(): YamlSyntaxKind {
    return this.#kind;
  }

  /** Zero-based source-order position (query.rs:158-163). */
  ordinal(): number {
    return this.#ordinal;
  }
}

/** A complete deterministic query result. */
export class YamlQueryResult<M> {
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

  /** Eager execution always completes; failures throw instead. */
  terminal(): 'Completed' {
    return this.#terminal;
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface ExecutionContext {
  readonly document: YamlDocument;
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
 * Executes a validated YAML native semantic query against one immutable
 * stream (query.rs:167-197). The stream is the first standard result and
 * must not bypass result limits.
 */
export function executeYamlQuery(
  executable: ExecutableQuery,
  document: YamlDocument,
  limits: QueryLimits,
  cancellation: CancellationToken,
): YamlQueryResult<YamlMatch> {
  const definition = executable.validated.definition;
  const domain = definition.domain;
  if (domain.id !== 'yaml.native-semantic-query' || domain.version !== 1) {
    throw new QueryExecutionFailure('DomainMismatch', { domain });
  }
  const context: ExecutionContext = { document, limits, cancellation, steps: 0 };
  step(context, 1);
  const input: YamlMatch[] = [
    {
      kind: 'Stream',
      stream: document.streamNodeRef(),
      span: document.streamSpan(),
      documentCount: document.documentCount(),
    },
  ];
  const matches = executeExpression(definition.expression, input, context);
  const selected = applySelection(matches, definition.selection);
  return new YamlQueryResult(selected);
}

/**
 * Executes a validated YAML lossless syntax query against every source
 * piece in raw order (query.rs:214-255).
 */
export function executeYamlSyntaxQuery(
  executable: ExecutableQuery,
  document: YamlDocument,
  limits: QueryLimits,
  cancellation: CancellationToken,
): YamlQueryResult<YamlSyntaxMatch> {
  const definition = executable.validated.definition;
  const domain = definition.domain;
  if (domain.id !== 'yaml.lossless-syntax-query' || domain.version !== 1) {
    throw new QueryExecutionFailure('DomainMismatch', { domain });
  }
  const context: ExecutionContext = { document, limits, cancellation, steps: 0 };
  const pieces = document.losslessStructuralIndex().pieces();
  const kinds = document.losslessSyntaxKinds();
  step(context, pieces.length);
  const input: YamlSyntaxMatch[] = pieces.map((piece, ordinal) => {
    return new YamlSyntaxMatch(
      document.authorityInternal().nodeRef(BigInt(ordinal), 'YamlSyntaxPiece'),
      piece.span(),
      kinds[ordinal],
      ordinal,
    );
  });
  const matches = executeSyntaxExpression(definition.expression, input, context);
  const selected = applySelection(matches, definition.selection);
  return new YamlQueryResult(selected);
}

function executeExpression(
  expression: QueryExpression,
  input: YamlMatch[],
  context: ExecutionContext,
): YamlMatch[] {
  switch (expression.kind) {
    case 'Input':
      return input;
    case 'Apply': {
      const applied = executeExpression(expression.input, input, context);
      return applyOperator(expression.operator, applied, context);
    }
    case 'Concat': {
      let output: YamlMatch[] = [];
      for (const branch of expression.branches) {
        output = output.concat(executeExpression(branch, input, context));
        step(context, output.length);
      }
      return output;
    }
    case 'StructureOrderMerge': {
      let output: YamlMatch[] = [];
      for (const branch of expression.branches) {
        output = output.concat(executeExpression(branch, input, context));
      }
      output.sort((left, right) => {
        const leftSpan = matchSpan(left);
        const rightSpan = matchSpan(right);
        if (leftSpan.startByte() !== rightSpan.startByte()) {
          return leftSpan.startByte() - rightSpan.startByte();
        }
        if (leftSpan.endByte() !== rightSpan.endByte()) {
          return leftSpan.endByte() - rightSpan.endByte();
        }
        const leftRole = roleOrder(matchNodeRef(left).role());
        const rightRole = roleOrder(matchNodeRef(right).role());
        if (leftRole !== rightRole) {
          return leftRole - rightRole;
        }
        return Number(matchNodeRef(left).index() - matchNodeRef(right).index());
      });
      step(context, output.length);
      return output;
    }
  }
}

function executeSyntaxExpression(
  expression: QueryExpression,
  input: YamlSyntaxMatch[],
  context: ExecutionContext,
): YamlSyntaxMatch[] {
  switch (expression.kind) {
    case 'Input':
      return input;
    case 'Apply': {
      const applied = executeSyntaxExpression(expression.input, input, context);
      return applySyntaxOperator(expression.operator, applied, context);
    }
    case 'Concat': {
      let output: YamlSyntaxMatch[] = [];
      for (const branch of expression.branches) {
        output = output.concat(executeSyntaxExpression(branch, input, context));
        step(context, output.length);
      }
      return output;
    }
    case 'StructureOrderMerge': {
      let output: YamlSyntaxMatch[] = [];
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
  input: YamlSyntaxMatch[],
  context: ExecutionContext,
): YamlSyntaxMatch[] {
  let output: YamlSyntaxMatch[];
  switch (operator.id) {
    case 'yaml.syntax-kind-is': {
      const expected = stringArgument(operator, 'kind');
      output = input.filter((item) => item.kind() === expected);
      break;
    }
    case 'yaml.syntax-text-equals': {
      const expected = stringArgument(operator, 'text');
      const bytes = new TextEncoder().encode(expected);
      const source = context.document.source().bytes();
      output = input.filter((item) => {
        const span = item.span();
        const start = span.startByte();
        const end = span.endByte();
        if (end - start !== bytes.length) {
          return false;
        }
        for (let index = 0; index < bytes.length; index++) {
          if (source[start + index] !== bytes[index]) {
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
      throw new Error(`internal: validated YAML syntax operator ${operator.id}`);
  }
  step(context, output.length);
  return output;
}

function applyOperator(
  operator: OperatorCall,
  input: YamlMatch[],
  context: ExecutionContext,
): YamlMatch[] {
  const output: YamlMatch[] = [];
  switch (operator.id) {
    case 'yaml.documents': {
      for (const item of input) {
        if (item.kind !== 'Stream') {
          continue;
        }
        for (let ordinal = 0; ordinal < context.document.documentCount(); ordinal++) {
          const document = context.document.documentInternal(ordinal);
          output.push({
            kind: 'Document',
            ordinal,
            document: context.document.authorityInternal().nodeRef(BigInt(ordinal), 'YamlDocument'),
            root: context.document.authorityInternal().nodeRef(BigInt(document.root), 'YamlNode'),
            span: document.span,
          });
        }
      }
      break;
    }
    case 'yaml.document-root': {
      for (const item of input) {
        if (item.kind !== 'Document') {
          continue;
        }
        const index = Number(context.document.authorityInternal().resolveIndex(item.root));
        output.push(nodeMatch(context, index));
      }
      break;
    }
    case 'yaml.where-node-kind': {
      const expected = stringArgument(operator, 'kind');
      for (const item of input) {
        if (item.kind === 'Node' && item.nodeKind === expected) {
          output.push(item);
        }
      }
      break;
    }
    case 'yaml.where-tag': {
      const expected = stringArgument(operator, 'tag');
      for (const item of input) {
        if (item.kind === 'Node' && item.tag === expected) {
          output.push(item);
        }
      }
      break;
    }
    case 'yaml.scalar-canonical-equals': {
      const expected = stringArgument(operator, 'canonical');
      for (const item of input) {
        if (item.kind === 'Node' && item.canonical === expected) {
          output.push(item);
        }
      }
      break;
    }
    case 'yaml.try-sequence-elements': {
      for (const item of input) {
        if (item.kind !== 'Node') {
          continue;
        }
        const index = resolveNodeIndex(context, item.node);
        const content = context.document.nodeAt(index).content;
        if (content.kind !== 'Sequence') {
          continue;
        }
        for (let ordinal = 0; ordinal < content.items.length; ordinal++) {
          const item_ = content.items[ordinal];
          output.push({
            kind: 'SequenceElement',
            ordinal,
            element: context.document.authorityInternal().nodeRef(item_.identity, 'YamlSequenceElement'),
            node: context.document.authorityInternal().nodeRef(BigInt(item_.node), 'YamlNode'),
            span: item_.span,
          });
        }
      }
      break;
    }
    case 'yaml.sequence-element-node': {
      for (const item of input) {
        if (item.kind !== 'SequenceElement') {
          continue;
        }
        output.push(nodeMatch(context, resolveNodeIndex(context, item.node)));
      }
      break;
    }
    case 'yaml.try-mapping-entries': {
      for (const item of input) {
        if (item.kind !== 'Node') {
          continue;
        }
        const index = resolveNodeIndex(context, item.node);
        const content = context.document.nodeAt(index).content;
        if (content.kind !== 'Mapping') {
          continue;
        }
        for (let ordinal = 0; ordinal < content.entries.length; ordinal++) {
          const entry = content.entries[ordinal];
          output.push({
            kind: 'MappingEntry',
            ordinal,
            entry: context.document.authorityInternal().nodeRef(entry.identity, 'YamlMappingEntry'),
            key: context.document.authorityInternal().nodeRef(BigInt(entry.key), 'YamlNode'),
            value: context.document.authorityInternal().nodeRef(BigInt(entry.value), 'YamlNode'),
            span: entry.span,
          });
        }
      }
      break;
    }
    case 'yaml.mapping-entry-key':
    case 'yaml.mapping-entry-value': {
      const takeKey = operator.id === 'yaml.mapping-entry-key';
      for (const item of input) {
        if (item.kind !== 'MappingEntry') {
          continue;
        }
        output.push(
          nodeMatch(context, resolveNodeIndex(context, takeKey ? item.key : item.value)),
        );
      }
      break;
    }
    case 'yaml.anchor-definition': {
      for (const item of input) {
        if (item.kind !== 'Node') {
          continue;
        }
        const index = resolveNodeIndex(context, item.node);
        const node = context.document.nodeAt(index);
        if (node.anchor !== null && node.anchorSpan !== null) {
          output.push({
            kind: 'AnchorDefinition',
            name: node.anchor,
            definition: context.document
              .authorityInternal()
              .nodeRef(BigInt(index), 'YamlAnchorDefinition'),
            node: item.node,
            span: node.anchorSpan,
          });
        }
      }
      break;
    }
    case 'yaml.anchor-node': {
      for (const item of input) {
        if (item.kind !== 'AnchorDefinition') {
          continue;
        }
        output.push(nodeMatch(context, resolveNodeIndex(context, item.node)));
      }
      break;
    }
    case 'yaml.alias-occurrences': {
      for (const item of input) {
        if (item.kind !== 'Stream') {
          continue;
        }
        const aliases = context.document.aliasesInternal();
        for (let ordinal = 0; ordinal < aliases.length; ordinal++) {
          const alias = aliases[ordinal];
          output.push({
            kind: 'AliasOccurrence',
            ordinal,
            name: alias.name,
            alias: context.document.authorityInternal().nodeRef(alias.identity, 'YamlAlias'),
            target: context.document.authorityInternal().nodeRef(BigInt(alias.target), 'YamlNode'),
            span: alias.span,
          });
        }
      }
      break;
    }
    case 'yaml.alias-target': {
      for (const item of input) {
        if (item.kind !== 'AliasOccurrence') {
          continue;
        }
        output.push(nodeMatch(context, resolveNodeIndex(context, item.target)));
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
        const key = nodeKey(matchNodeRef(item));
        if (!seen.has(key)) {
          seen.add(key);
          output.push(item);
        }
      }
      break;
    }
    default:
      throw new Error(`internal: validated YAML native operator ${operator.id}`);
  }
  step(context, output.length);
  return output;
}

function nodeMatch(context: ExecutionContext, index: number): YamlMatch {
  const node = context.document.nodeAt(index);
  const content = node.content;
  let nodeKind: YamlNodeKind;
  let scalarKind: YamlScalarKind | null = null;
  let canonical: string | null = null;
  switch (content.kind) {
    case 'Scalar':
      nodeKind = 'Scalar';
      scalarKind = content.scalar.kind;
      canonical = content.scalar.canonical;
      break;
    case 'Sequence':
      nodeKind = 'Sequence';
      break;
    case 'Mapping':
      nodeKind = 'Mapping';
      break;
  }
  return {
    kind: 'Node',
    node: context.document.authorityInternal().nodeRef(BigInt(index), 'YamlNode'),
    nodeKind,
    tag: node.tag,
    scalarKind,
    canonical,
    anchor: node.anchor,
    span: node.span,
  };
}

function resolveNodeIndex(context: ExecutionContext, node: NodeRef): number {
  return Number(context.document.authorityInternal().resolveIndex(node));
}

function roleOrder(role: string): number {
  switch (role) {
    case 'YamlStream':
      return 0;
    case 'YamlDocument':
      return 1;
    case 'YamlMappingEntry':
    case 'YamlSequenceElement':
      return 2;
    case 'YamlAnchorDefinition':
      return 3;
    case 'YamlAlias':
      return 4;
    case 'YamlNode':
      return 5;
    default:
      return 6;
  }
}

function stringArgument(operator: OperatorCall, name: string): string {
  const value = operator.arguments.get(name);
  if (value === undefined || value.kind !== 'String') {
    throw new Error(`internal: validated ${name} argument`);
  }
  return value.value;
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

/** The five frozen cardinality selections (query.rs:690-707). */
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
