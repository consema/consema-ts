/**
 * Plist three-domain query execution (RFC 0013 §8).
 *
 * authority: crates/consema-plist/src/query.rs
 *  - PlistMatch :60-114, PlistSyntaxMatch :131-162, PlistBinaryMatch
 *    :171-251
 *  - native operators :810-1163 (document-root :853-876, dict-entries
 *    :880-899, dict-entry-key :902-927, dict-entry-value :930-952,
 *    dict-key-equals :956-973 — exact code-unit equality, never case
 *    folded — duplicate-key-group :977-998, array-elements :1002-1034,
 *    value-type-is :1038-1058, value-as-* typed accessors :1063-1082 —
 *    a type mismatch is a query failure, never a null or converted result
 *    — value-as-boolean-is :1087-1119, core.take, core.distinct-by-identity)
 *  - syntax operators :1259-1298 (plist.syntax-kind-is,
 *    plist.syntax-text-equals, core.take, core.distinct-by-identity)
 *  - binary structure operators :1334-1348 (plist.object-table/
 *    plist.top-object :1351-1412, plist.object-offset/plist.offset-table
 *    :1416-1433, plist.object-refs :1437-1456, plist.trailer-facts,
 *    core.take, core.distinct-by-identity); the structure facts are
 *    document-level — every operator projects its fact set once from any
 *    binary-structure input match
 *  - domain gates :271-301 (plist.native-semantic-query@1), :325-369
 *    (plist.lossless-syntax-query@1 — binary documents are rejected with
 *    DomainMismatch, hard gate 1), :392-420 (plist.binary-structure-query@1
 *    — XML documents are rejected the same way)
 *  - family failure-code mapping (vector-facing spellings):
 *    crates/consema-conformance/src/plist_v1.rs:1141-1153
 *  - vector-pinned behavior: conformance/vectors/plist-v1.json
 *    (plist.query.dict-entries-order, plist.query.typed-accessors with
 *    mismatch_code plist.query.type-mismatch@1, plist.query.binary-structure)
 *
 * Design (TypeScript-idiomatic): eager deterministic execution — the
 * complete match list is returned in source order, or a typed
 * `QueryExecutionFailure` with the frozen registered code is thrown
 * (no partial completed result exists). The expression evaluator,
 * selection, limits, and cancellation follow the json family pattern.
 */

import { NodeRef, Span } from '../document/identity.ts';
import { QueryExecutionFailure } from './errors.ts';
import { PlistDocument } from './document.ts';
import { plistSyntaxKindFromName } from './syntax.ts';
import type { PlistSyntaxKind } from './syntax.ts';
import { PlistValueRef } from './native.ts';
import type { PlistValueKind } from './native.ts';
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

  /** The frozen defaults: 100_000 steps and 100_000 results. */
  static defaults(): QueryLimits {
    return new QueryLimits(100_000, 100_000);
  }

  /** Maximum operator steps. */
  maxSteps(): number {
    return this.#maxSteps;
  }

  /** Maximum complete results buffered by an operator. */
  maxResults(): number {
    return this.#maxResults;
  }
}

/** Cooperative cancellation flag. */
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

/** Owned snapshot-bound plist native semantic query match (query.rs:60-114). */
export type PlistMatch =
  | { readonly kind: 'Document'; readonly node: NodeRef }
  | {
      readonly kind: 'Value';
      readonly node: NodeRef;
      readonly value: PlistValueRef;
      readonly valueKind: PlistValueKind;
    }
  | {
      readonly kind: 'DictEntry';
      readonly node: NodeRef;
      readonly dict: PlistValueRef;
      readonly position: number;
      readonly key: string;
      readonly value: PlistValueRef;
      readonly valueKind: PlistValueKind;
    }
  | {
      readonly kind: 'Key';
      readonly node: NodeRef;
      readonly dict: PlistValueRef;
      readonly position: number;
      readonly key: string;
    }
  | {
      readonly kind: 'ArrayElement';
      readonly node: NodeRef;
      readonly array: PlistValueRef;
      readonly position: number;
      readonly value: PlistValueRef;
      readonly valueKind: PlistValueKind;
    };

function matchIdentity(match: PlistMatch): NodeRef {
  return match.node;
}

/** Owned snapshot-bound plist XML lossless syntax query match (query.rs:131-162). */
export class PlistSyntaxMatch {
  readonly #node: NodeRef;
  readonly #span: Span;
  readonly #kind: PlistSyntaxKind;
  readonly #ordinal: number;

  constructor(node: NodeRef, span: Span, kind: PlistSyntaxKind, ordinal: number) {
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

  /** Format-specific lossless kind. */
  kind(): PlistSyntaxKind {
    return this.#kind;
  }

  /** Zero-based source-order position. */
  ordinal(): number {
    return this.#ordinal;
  }
}

/** Owned snapshot-bound plist binary structure query match (query.rs:171-251). */
export type PlistBinaryMatch =
  | { readonly kind: 'Structure'; readonly node: NodeRef }
  | {
      readonly kind: 'Object';
      readonly node: NodeRef;
      readonly index: number;
      readonly offset: number;
      readonly marker: number;
      readonly span: Span;
    }
  | {
      readonly kind: 'Offset';
      readonly node: NodeRef;
      readonly index: number;
      readonly offset: number;
      readonly span: Span;
    }
  | {
      readonly kind: 'Ref';
      readonly node: NodeRef;
      readonly index: number;
      readonly owner: number;
      readonly position: number;
      readonly target: number;
      readonly span: Span;
    }
  | {
      readonly kind: 'Trailer';
      readonly node: NodeRef;
      readonly sortVersion: number;
      readonly offsetIntSize: number;
      readonly objectRefSize: number;
      readonly numObjects: bigint;
      readonly topObject: bigint;
      readonly offsetTableOffset: bigint;
      readonly span: Span;
    }
  | {
      readonly kind: 'TopObject';
      readonly node: NodeRef;
      readonly index: number;
      readonly offset: number;
      readonly marker: number;
      readonly span: Span;
      readonly refs: readonly { readonly position: number; readonly target: number; readonly span: Span }[];
    };

function binaryMatchIdentity(match: PlistBinaryMatch): NodeRef {
  return match.node;
}

/** A complete deterministic query result (json/query.ts:154-173 pattern). */
export class PlistQueryResult<M> {
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
  readonly document: PlistDocument;
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

/** Executes a validated plist native semantic query (query.rs:271-302). */
export function executePlistNativeQuery(
  executable: ExecutableQuery,
  document: PlistDocument,
  limits: QueryLimits,
  cancellation: CancellationToken,
): PlistQueryResult<PlistMatch> {
  const definition = executable.validated.definition;
  const domain = definition.domain;
  if (domain.id !== 'plist.native-semantic-query' || domain.version !== 1) {
    throw new QueryExecutionFailure('DomainMismatch', { domain });
  }
  const context: ExecutionContext = { document, limits, cancellation, steps: 0 };
  step(context, 1);
  const input: PlistMatch[] = [
    { kind: 'Document', node: document.nodeRefFor(0, 'PlistDocument') },
  ];
  const matches = executeNativeExpression(definition.expression, input, context);
  const selected = applySelection(matches, definition.selection);
  return new PlistQueryResult(selected);
}

/** Executes a validated plist lossless syntax query (query.rs:325-369). */
export function executePlistSyntaxQuery(
  executable: ExecutableQuery,
  document: PlistDocument,
  limits: QueryLimits,
  cancellation: CancellationToken,
): PlistQueryResult<PlistSyntaxMatch> {
  const definition = executable.validated.definition;
  const domain = definition.domain;
  if (domain.id !== 'plist.lossless-syntax-query' || domain.version !== 1) {
    throw new QueryExecutionFailure('DomainMismatch', { domain });
  }
  const index = document.losslessStructuralIndex();
  const kinds = document.losslessSyntaxKinds();
  if (index === null || kinds === null) {
    // A binary document has no text, whitespace, or token fiction (RFC 0013
    // §7, hard gate 1).
    throw new QueryExecutionFailure('DomainMismatch', { domain });
  }
  const context: ExecutionContext = { document, limits, cancellation, steps: 0 };
  const pieces = index.pieces();
  step(context, pieces.length);
  const input: PlistSyntaxMatch[] = pieces.map((piece, ordinal) => {
    return new PlistSyntaxMatch(
      document.nodeRefFor(ordinal, 'PlistSyntaxPiece'),
      piece.span(),
      kinds[ordinal],
      ordinal,
    );
  });
  const matches = executeSyntaxExpression(definition.expression, input, context);
  const selected = applySelection(matches, definition.selection);
  return new PlistQueryResult(selected);
}

/** Executes a validated plist binary structure query (query.rs:392-420). */
export function executePlistBinaryQuery(
  executable: ExecutableQuery,
  document: PlistDocument,
  limits: QueryLimits,
  cancellation: CancellationToken,
): PlistQueryResult<PlistBinaryMatch> {
  const definition = executable.validated.definition;
  const domain = definition.domain;
  if (domain.id !== 'plist.binary-structure-query' || domain.version !== 1) {
    throw new QueryExecutionFailure('DomainMismatch', { domain });
  }
  const facts = document.binaryFacts();
  if (facts === null) {
    // The structure facts exist only for the binary representation (hard
    // gate 1).
    throw new QueryExecutionFailure('DomainMismatch', { domain });
  }
  const context: ExecutionContext = { document, limits, cancellation, steps: 0 };
  step(context, 1);
  const input: PlistBinaryMatch[] = [
    { kind: 'Structure', node: document.nodeRefFor(0, 'PlistDocument') },
  ];
  const matches = executeBinaryExpression(definition.expression, input, context, facts);
  const selected = applySelection(matches, definition.selection);
  return new PlistQueryResult(selected);
}

// ---------------------------------------------------------------------------
// Expression evaluation
// ---------------------------------------------------------------------------

function executeNativeExpression(
  expression: QueryExpression,
  input: PlistMatch[],
  context: ExecutionContext,
): PlistMatch[] {
  switch (expression.kind) {
    case 'Input':
      return input;
    case 'Apply': {
      const applied = executeNativeExpression(expression.input, input, context);
      return applyNativeOperator(expression.operator, applied, context);
    }
    case 'Concat': {
      let output: PlistMatch[] = [];
      for (const branch of expression.branches) {
        output = output.concat(executeNativeExpression(branch, input, context));
        step(context, output.length);
      }
      return output;
    }
    case 'StructureOrderMerge': {
      let output: PlistMatch[] = [];
      for (const branch of expression.branches) {
        output = output.concat(executeNativeExpression(branch, input, context));
      }
      // Native merge: pre-order rank of the value arena (query.rs:252-269
      // precedent); the arena ordinals ARE the pre-order ranks here.
      output.sort((left, right) => rankOf(left) - rankOf(right));
      step(context, output.length);
      return output;
    }
  }
}

/** Arena ordinal of one native match, used as the merge rank (arena indices equal object ordinals). */
function rankOf(match: PlistMatch): number {
  switch (match.kind) {
    case 'Document':
      return 0;
    case 'Value':
      return match.value.index();
    case 'DictEntry':
      return match.dict.index();
    case 'Key':
      return match.dict.index();
    case 'ArrayElement':
      return match.array.index();
  }
}

function executeSyntaxExpression(
  expression: QueryExpression,
  input: PlistSyntaxMatch[],
  context: ExecutionContext,
): PlistSyntaxMatch[] {
  switch (expression.kind) {
    case 'Input':
      return input;
    case 'Apply': {
      const applied = executeSyntaxExpression(expression.input, input, context);
      return applySyntaxOperator(expression.operator, applied, context);
    }
    case 'Concat': {
      let output: PlistSyntaxMatch[] = [];
      for (const branch of expression.branches) {
        output = output.concat(executeSyntaxExpression(branch, input, context));
        step(context, output.length);
      }
      return output;
    }
    case 'StructureOrderMerge': {
      let output: PlistSyntaxMatch[] = [];
      for (const branch of expression.branches) {
        output = output.concat(executeSyntaxExpression(branch, input, context));
      }
      output.sort((left, right) => left.ordinal() - right.ordinal());
      step(context, output.length);
      return output;
    }
  }
}

function executeBinaryExpression(
  expression: QueryExpression,
  input: PlistBinaryMatch[],
  context: ExecutionContext,
  facts: NonNullable<ReturnType<PlistDocument['binaryFacts']>>,
): PlistBinaryMatch[] {
  switch (expression.kind) {
    case 'Input':
      return input;
    case 'Apply': {
      const applied = executeBinaryExpression(expression.input, input, context, facts);
      return applyBinaryOperator(expression.operator, applied, context, facts);
    }
    case 'Concat': {
      let output: PlistBinaryMatch[] = [];
      for (const branch of expression.branches) {
        output = output.concat(executeBinaryExpression(branch, input, context, facts));
        step(context, output.length);
      }
      return output;
    }
    case 'StructureOrderMerge': {
      let output: PlistBinaryMatch[] = [];
      for (const branch of expression.branches) {
        output = output.concat(executeBinaryExpression(branch, input, context, facts));
      }
      output.sort((left, right) => binaryRank(left) - binaryRank(right));
      step(context, output.length);
      return output;
    }
  }
}

function binaryRank(match: PlistBinaryMatch): number {
  switch (match.kind) {
    case 'Structure':
      return -1;
    case 'Object':
      return match.index;
    case 'Offset':
      return match.index;
    case 'Ref':
      return match.index;
    case 'Trailer':
      return Number.MAX_SAFE_INTEGER;
    case 'TopObject':
      return match.index;
  }
}

// ---------------------------------------------------------------------------
// Native operators (query.rs:810-1163)
// ---------------------------------------------------------------------------

function applyNativeOperator(
  operator: OperatorCall,
  input: PlistMatch[],
  context: ExecutionContext,
): PlistMatch[] {
  const output: PlistMatch[] = [];
  const native = context.document.document();
  switch (operator.id) {
    case 'plist.document-root': {
      if (native === null) {
        break;
      }
      for (const item of input) {
        if (item.kind === 'Document') {
          const root = native.root();
          output.push({
            kind: 'Value',
            node: context.document.nodeRefFor(root.index(), 'PlistValue'),
            value: root,
            valueKind: native.get(root)!.kind,
          });
        }
      }
      break;
    }
    case 'plist.dict-entries': {
      if (native === null) {
        break;
      }
      for (const item of input) {
        if (item.kind !== 'Value') {
          continue;
        }
        const node = native.get(item.value);
        if (node?.kind !== 'Dict') {
          continue;
        }
        for (let position = 0; position < node.entries.length; position++) {
          const entry = node.entries[position];
          output.push(entryMatch(context, item.value, position, entry, native));
        }
      }
      break;
    }
    case 'plist.dict-entry-key': {
      for (const item of input) {
        if (item.kind === 'DictEntry') {
          output.push({
            kind: 'Key',
            node: context.document.nodeRefFor(item.position, 'PlistKey'),
            dict: item.dict,
            position: item.position,
            key: item.key,
          });
        }
      }
      break;
    }
    case 'plist.dict-entry-value': {
      if (native === null) {
        break;
      }
      for (const item of input) {
        if (item.kind !== 'DictEntry') {
          continue;
        }
        const node = native.get(item.value);
        if (node === null) {
          continue;
        }
        output.push({
          kind: 'Value',
          node: context.document.nodeRefFor(item.value.index(), 'PlistValue'),
          value: item.value,
          valueKind: node.kind,
        });
      }
      break;
    }
    case 'plist.dict-key-equals': {
      const expected = operator.arguments.get('key');
      const key = expected !== undefined && expected.kind === 'String' ? expected.value : '';
      for (const item of input) {
        if (item.kind === 'DictEntry' && item.key === key) {
          output.push(item);
        }
      }
      break;
    }
    case 'plist.duplicate-key-group': {
      if (native === null) {
        break;
      }
      for (const item of input) {
        if (item.kind !== 'DictEntry') {
          continue;
        }
        const node = native.get(item.dict);
        if (node?.kind !== 'Dict') {
          continue;
        }
        for (let position = 0; position < node.entries.length; position++) {
          const entry = node.entries[position];
          if (entry.key === item.key) {
            output.push(entryMatch(context, item.dict, position, entry, native));
          }
        }
      }
      break;
    }
    case 'plist.array-elements': {
      if (native === null) {
        break;
      }
      for (const item of input) {
        if (item.kind !== 'Value') {
          continue;
        }
        const node = native.get(item.value);
        if (node?.kind !== 'Array') {
          continue;
        }
        for (let position = 0; position < node.elements.length; position++) {
          const element = node.elements[position];
          const elementNode = native.get(PlistValueRef.fromIndex(element));
          output.push({
            kind: 'ArrayElement',
            node: context.document.nodeRefFor(position, 'PlistArrayElement'),
            array: item.value,
            position,
            value: PlistValueRef.fromIndex(element),
            valueKind: elementNode?.kind ?? 'String',
          });
        }
      }
      break;
    }
    case 'plist.value-type-is': {
      const expected = operator.arguments.get('kind');
      const kindName = expected !== undefined && expected.kind === 'String' ? expected.value : '';
      const expectedKind = plistKindFromName(kindName);
      for (const item of input) {
        const payload = valuePayload(item);
        if (payload !== null && payload.kind === expectedKind) {
          output.push(item);
        }
      }
      break;
    }
    case 'plist.value-as-integer':
    case 'plist.value-as-real':
    case 'plist.value-as-string':
    case 'plist.value-as-data':
    case 'plist.value-as-date':
    case 'plist.value-as-uid': {
      const target = typedAccessorKind(operator.id);
      for (const item of input) {
        const payload = valuePayload(item);
        if (payload === null) {
          continue;
        }
        if (payload.kind !== target) {
          throw new QueryExecutionFailure('RequiredTypeMismatch');
        }
        output.push(item);
      }
      break;
    }
    case 'plist.value-as-boolean-is': {
      const expected = operator.arguments.get('value');
      const expectedValue = expected !== undefined && expected.kind === 'Boolean' ? expected.value : false;
      if (native === null) {
        break;
      }
      for (const item of input) {
        const payload = valuePayload(item);
        if (payload === null) {
          continue;
        }
        if (payload.kind !== 'Boolean') {
          throw new QueryExecutionFailure('RequiredTypeMismatch');
        }
        const node = native.get(payload.value);
        if (node?.kind === 'Boolean' && node.value === expectedValue) {
          output.push(item);
        }
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
      throw new QueryExecutionFailure('UnknownOperator', { domain: { id: 'plist.native-semantic-query', version: 1 } });
  }
  step(context, output.length);
  return output;
}

/** One dictionary association match in its owning dictionary (query.rs:1166-1184). */
function entryMatch(
  context: ExecutionContext,
  dict: PlistValueRef,
  position: number,
  entry: { readonly key: string; readonly value: number },
  native: NonNullable<ReturnType<PlistDocument['document']>>,
): PlistMatch {
  const valueRef = PlistValueRef.fromIndex(entry.value);
  const valueNode = native.get(valueRef);
  return {
    kind: 'DictEntry',
    node: context.document.nodeRefFor(dict.index(), 'PlistDictEntry'),
    dict,
    position,
    key: entry.key,
    value: valueRef,
    valueKind: valueNode?.kind ?? 'String',
  };
}

/** Value payload of one value-bearing match (query.rs:1123-1131). */
function valuePayload(item: PlistMatch): { readonly value: PlistValueRef; readonly kind: PlistValueKind } | null {
  switch (item.kind) {
    case 'Value':
      return { value: item.value, kind: item.valueKind };
    case 'ArrayElement':
      return { value: item.value, kind: item.valueKind };
    default:
      return null;
  }
}

/** The closed native kind named by the `plist.value-type-is` argument. */
function plistKindFromName(name: string): PlistValueKind | null {
  switch (name) {
    case 'string':
      return 'String';
    case 'integer':
      return 'Integer';
    case 'real':
      return 'Real';
    case 'boolean':
      return 'Boolean';
    case 'date':
      return 'Date';
    case 'data':
      return 'Data';
    case 'uid':
      return 'Uid';
    case 'array':
      return 'Array';
    case 'dict':
      return 'Dict';
    default:
      return null;
  }
}

/** The typed accessor's target kind (query.rs:825-842). */
function typedAccessorKind(id: string): PlistValueKind {
  switch (id) {
    case 'plist.value-as-integer':
      return 'Integer';
    case 'plist.value-as-real':
      return 'Real';
    case 'plist.value-as-string':
      return 'String';
    case 'plist.value-as-data':
      return 'Data';
    case 'plist.value-as-date':
      return 'Date';
    default:
      return 'Uid';
  }
}

// ---------------------------------------------------------------------------
// Syntax operators (query.rs:1259-1298)
// ---------------------------------------------------------------------------

function applySyntaxOperator(
  operator: OperatorCall,
  input: PlistSyntaxMatch[],
  context: ExecutionContext,
): PlistSyntaxMatch[] {
  let output: PlistSyntaxMatch[];
  switch (operator.id) {
    case 'plist.syntax-kind-is': {
      const expected = operator.arguments.get('kind');
      const kindName = expected !== undefined && expected.kind === 'String' ? expected.value : '';
      const kind = plistSyntaxKindFromName(kindName);
      output = input.filter((item) => item.kind() === kind);
      break;
    }
    case 'plist.syntax-text-equals': {
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
      throw new QueryExecutionFailure('UnknownOperator', { domain: { id: 'plist.lossless-syntax-query', version: 1 } });
  }
  step(context, output.length);
  return output;
}

// ---------------------------------------------------------------------------
// Binary structure operators (query.rs:1334-1348)
// ---------------------------------------------------------------------------

function applyBinaryOperator(
  operator: OperatorCall,
  input: PlistBinaryMatch[],
  context: ExecutionContext,
  facts: NonNullable<ReturnType<PlistDocument['binaryFacts']>>,
): PlistBinaryMatch[] {
  const output: PlistBinaryMatch[] = [];
  switch (operator.id) {
    case 'plist.object-table': {
      if (input.length === 0) {
        break;
      }
      for (const fact of facts.objects()) {
        output.push({
          kind: 'Object',
          node: context.document.nodeRefFor(fact.index(), 'PlistValue'),
          index: fact.index(),
          offset: fact.offset(),
          marker: fact.marker(),
          span: fact.span(),
        });
      }
      break;
    }
    case 'plist.top-object': {
      if (input.length === 0) {
        break;
      }
      const top = Number(facts.trailer().topObject());
      const fact = facts.objects().find((candidate) => candidate.index() === top);
      if (fact === undefined) {
        break;
      }
      const refs = facts
        .refs()
        .filter((reference) => reference.owner() === top)
        .map((reference) => ({
          position: reference.position(),
          target: reference.target(),
          span: reference.span(),
        }));
      output.push({
        kind: 'TopObject',
        node: context.document.nodeRefFor(fact.index(), 'PlistValue'),
        index: fact.index(),
        offset: fact.offset(),
        marker: fact.marker(),
        span: fact.span(),
        refs,
      });
      break;
    }
    case 'plist.object-offset':
    case 'plist.offset-table': {
      if (input.length === 0) {
        break;
      }
      for (const fact of facts.offsets()) {
        output.push({
          kind: 'Offset',
          node: context.document.nodeRefFor(fact.index(), 'PlistValue'),
          index: fact.index(),
          offset: fact.offset(),
          span: fact.span(),
        });
      }
      break;
    }
    case 'plist.object-refs': {
      if (input.length === 0) {
        break;
      }
      for (let index = 0; index < facts.refs().length; index++) {
        const fact = facts.refs()[index];
        output.push({
          kind: 'Ref',
          node: context.document.nodeRefFor(index, 'PlistValue'),
          index,
          owner: fact.owner(),
          position: fact.position(),
          target: fact.target(),
          span: fact.span(),
        });
      }
      break;
    }
    case 'plist.trailer-facts': {
      if (input.length === 0) {
        break;
      }
      const trailer = facts.trailer();
      output.push({
        kind: 'Trailer',
        node: context.document.nodeRefFor(0, 'PlistDocument'),
        sortVersion: trailer.sortVersion(),
        offsetIntSize: trailer.offsetIntSize(),
        objectRefSize: trailer.objectRefSize(),
        numObjects: trailer.numObjects(),
        topObject: trailer.topObject(),
        offsetTableOffset: trailer.offsetTableOffset(),
        span: trailer.span(),
      });
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
        const key = nodeKey(binaryMatchIdentity(item));
        if (!seen.has(key)) {
          seen.add(key);
          output.push(item);
        }
      }
      break;
    }
    default:
      throw new QueryExecutionFailure('UnknownOperator', { domain: { id: 'plist.binary-structure-query', version: 1 } });
  }
  step(context, output.length);
  return output;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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
      return values.length > 1
        ? (() => {
            throw new QueryExecutionFailure('CardinalityViolation', {
              selection,
              actual: values.length,
            });
          })()
        : values;
    case 'RequireOne':
      return values.length === 0
        ? (() => {
            throw new QueryExecutionFailure('CardinalityViolation', {
              selection,
              actual: 0,
            });
          })()
        : values.length > 1
          ? (() => {
              throw new QueryExecutionFailure('CardinalityViolation', {
                selection,
                actual: values.length,
              });
            })()
          : values;
  }
}
