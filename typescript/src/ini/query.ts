/**
 * INI native-semantic and lossless-syntax query execution.
 *
 * authority:
 *  - domains and operator schemas: RFC 0009 §9 (:287-345) —
 *    ini.native-semantic-query@1 with the ten native operators
 *    (document-sections, section-entries, all-entries, entry-section,
 *    section-name-equals, entry-key-equals, entry-value-state-is,
 *    duplicate-group, physical-lines, logical-lines) and
 *    ini.lossless-syntax-query@1 with ini.syntax-kind-is /
 *    ini.syntax-text-equals; `comparison` is exactly OriginalExact or
 *    ProfileEquivalent (:330-335); `state` is exactly Missing, Empty, or
 *    Present; the protocol validator pins the same rows
 *    (typescript/src/protocol/query.ts:349-357, 384-385, 1012-1026)
 *  - operator semantics and match shapes: crates/consema-ini/src/query.rs —
 *    IniMatch (:10-67), IniSyntaxMatch (:81-114), domain checks (:117-128,
 *    :160-171), expression evaluation (Input/Apply/Concat/
 *    StructureOrderMerge :298-368), native operator behavior (:421-625),
 *    syntax operator behavior (:370-419), source order (:627-659),
 *    decoded text comparison (:661-676), selection (:693-710)
 *  - steps/results accounting: query.rs:227-271 (max_steps/max_results →
 *    core.query.resource-limit@1); defaults 100_000 steps / 100_000
 *    results (consema-core/src/query.rs:2974-2981)
 *  - failure codes: crates/consema-protocol/src/error_registry.rs —
 *    core.query.cancelled@1 :141, core.query.cardinality-violation@1 :147,
 *    core.query.resource-limit@1 :183
 *  - the ordered cursor: query.rs:145-157 (OrderedQueryCursor with
 *    cancellation; terminal states Completed | Cancelled)
 *
 * Design (TypeScript-idiomatic): validation and binding live in the
 * protocol domain (validateQuery/bindQuery, typescript/src/protocol/
 * query.ts:546,1388); this module executes a bound ExecutableQuery against
 * one immutable snapshot. Execution-time failures are a closed local class;
 * DomainMismatch reuses the protocol QueryFailure.
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
import type { IniDocument } from './document.ts';
import {
  iniSyntaxKindFromName,
  type IniLogicalLineKind,
  type IniSyntaxKind,
  type IniValueState,
} from './profile.ts';
import { optionxform } from './python_case.ts';

// ---------------------------------------------------------------------------
// Match and failure records
// ---------------------------------------------------------------------------

/** Owned snapshot-bound INI native semantic query match (query.rs:10-67). */
export type IniMatch =
  | { readonly kind: 'Document'; readonly node: NodeRef }
  | {
      readonly kind: 'Section';
      readonly ordinal: number;
      readonly node: NodeRef;
      readonly name: string;
      readonly comparisonName: string;
      readonly isDefault: boolean;
      readonly duplicateGroup: number | null;
    }
  | {
      readonly kind: 'Entry';
      readonly ordinal: number;
      readonly node: NodeRef;
      readonly section: NodeRef;
      readonly key: string;
      readonly comparisonKey: string;
      readonly valueState: IniValueState;
      readonly duplicateGroup: number | null;
    }
  | { readonly kind: 'PhysicalLine'; readonly ordinal: number; readonly node: NodeRef; readonly span: Span }
  | {
      readonly kind: 'LogicalLine';
      readonly ordinal: number;
      readonly node: NodeRef;
      readonly logicalKind: IniLogicalLineKind;
    };

/** Match identity node (query.rs:69-79). */
export function iniMatchIdentity(match: IniMatch): NodeRef {
  return match.node;
}

/** Owned snapshot-bound INI lossless syntax query match (query.rs:81-114). */
export class IniSyntaxMatch {
  readonly #node: NodeRef;
  readonly #span: Span;
  readonly #kind: IniSyntaxKind;
  readonly #ordinal: number;

  constructor(node: NodeRef, span: Span, kind: IniSyntaxKind, ordinal: number) {
    this.#node = node;
    this.#span = span;
    this.#kind = kind;
    this.#ordinal = ordinal;
  }

  /** Process-local syntax-piece identity (query.rs:91-94). */
  nodeRef(): NodeRef {
    return this.#node;
  }

  /** Exact raw source span (query.rs:95-98). */
  span(): Span {
    return this.#span;
  }

  /** Format-specific lossless kind (query.rs:99-102). */
  kind(): IniSyntaxKind {
    return this.#kind;
  }

  /** Zero-based source-order position (query.rs:103-106). */
  ordinal(): number {
    return this.#ordinal;
  }
}

/** Immutable query execution limits (consema-core query.rs:2965-2981). */
export interface IniQueryLimits {
  /** Maximum operator steps. */
  readonly maxSteps: number;
  /** Maximum complete results buffered by an operator. */
  readonly maxResults: number;
}

/** The frozen defaults (query.rs:2974-2981): 100_000 steps, 100_000 results. */
export const DEFAULT_INI_QUERY_LIMITS: Readonly<IniQueryLimits> = Object.freeze({
  maxSteps: 100_000,
  maxResults: 100_000,
});

/** Cooperative cancellation signal (consema-core query.rs:2983). */
export class IniCancellationToken {
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

/** Complete deterministic query execution (query.rs:117). */
export interface IniQueryExecution<M> {
  readonly matches: readonly M[];
}

/**
 * Execution-time query failure (error_registry.rs:141,147,183); the
 * domain-mismatch failure is the protocol QueryFailure.
 */
export type IniQueryExecutionFailureKind =
  | 'Cancelled'
  | 'ResourceLimitExceeded'
  | 'CardinalityViolation';

export class IniQueryExecutionFailure extends Error {
  readonly kind: IniQueryExecutionFailureKind;
  /** Frozen registered code (error_registry.rs:141/147/183). */
  readonly code: string;
  /** CardinalityViolation: the requested selection and the actual match count. */
  readonly selection?: QuerySelection;
  readonly actual?: number;

  constructor(
    kind: IniQueryExecutionFailureKind,
    options: { selection?: QuerySelection; actual?: number } = {},
  ) {
    super(`ini query: ${kind}`);
    this.name = 'IniQueryExecutionFailure';
    this.kind = kind;
    this.code = queryExecutionFailureCode(kind);
    if (options.selection !== undefined) this.selection = options.selection;
    if (options.actual !== undefined) this.actual = options.actual;
  }
}

/** Kind→code mapping (consema-core/src/query.rs:1515-1527). */
export function queryExecutionFailureCode(kind: IniQueryExecutionFailureKind): string {
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
  readonly #document: IniDocument;
  readonly #limits: IniQueryLimits;
  readonly #cancellation: IniCancellationToken;
  #steps = 0;

  constructor(document: IniDocument, limits: IniQueryLimits, cancellation: IniCancellationToken) {
    this.#document = document;
    this.#limits = limits;
    this.#cancellation = cancellation;
  }

  step(results: number): void {
    if (this.#cancellation.isCancelled()) {
      throw new IniQueryExecutionFailure('Cancelled');
    }
    this.#steps += 1;
    if (this.#steps > this.#limits.maxSteps || results > this.#limits.maxResults) {
      throw new IniQueryExecutionFailure('ResourceLimitExceeded');
    }
  }

  document(): IniDocument {
    return this.#document;
  }

  sectionMatch(ordinal: number): IniMatch {
    const section = this.#document.sections()[ordinal];
    return {
      kind: 'Section',
      ordinal,
      node: section.nodeRef(),
      name: section.name(),
      comparisonName: section.comparisonName(),
      isDefault: section.isDefault(),
      duplicateGroup: section.duplicateGroup(),
    };
  }

  entryMatch(ordinal: number): IniMatch {
    const entry = this.#document.entries()[ordinal];
    return {
      kind: 'Entry',
      ordinal,
      node: entry.nodeRef(),
      section: entry.section(),
      key: entry.key(),
      comparisonKey: entry.comparisonKey(),
      valueState: entry.valueState(),
      duplicateGroup: entry.duplicateGroup(),
    };
  }
}

// ---------------------------------------------------------------------------
// Native semantic query
// ---------------------------------------------------------------------------

/**
 * Executes a validated INI native semantic query against one immutable
 * snapshot (query.rs:117-143). The input is the root `IniDocument`;
 * domain mismatch is a protocol QueryFailure.
 */
export function executeIniQuery(
  executable: ExecutableQuery,
  document: IniDocument,
  limits: IniQueryLimits,
  cancellation: IniCancellationToken,
): IniQueryExecution<IniMatch> {
  const definition = executable.validated.definition;
  if (definition.domain.id !== 'ini.native-semantic-query' || definition.domain.version !== 1) {
    throw new QueryFailure({
      kind: 'DomainMismatch',
      operator: 'domain',
      domain: definition.domain,
    });
  }
  const context = new Context(document, limits, cancellation);
  context.step(0);
  const input: IniMatch[] = [{ kind: 'Document', node: document.nodeRef() }];
  const matches = executeNativeExpression(definition.expression, input, context);
  const selected = applySelection(matches, definition.selection);
  return { matches: selected };
}

/** Executes a native query and exposes the complete result through a cancellable ordered cursor (query.rs:146-157). */
export function executeIniQueryCursor(
  executable: ExecutableQuery,
  document: IniDocument,
  limits: IniQueryLimits,
  cancellation: IniCancellationToken,
): IniOrderedQueryCursor<IniMatch> {
  const result = executeIniQuery(executable, document, limits, cancellation);
  return IniOrderedQueryCursor.withCancellation(result.matches, cancellation);
}

function executeNativeExpression(
  expression: QueryExpression,
  input: readonly IniMatch[],
  context: Context,
): IniMatch[] {
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
      const output: IniMatch[] = [];
      for (const branch of expression.branches) {
        output.push(...executeNativeExpression(branch, input, context));
        context.step(output.length);
      }
      return output;
    }
    case 'StructureOrderMerge': {
      const output: IniMatch[] = [];
      for (const branch of expression.branches) {
        output.push(...executeNativeExpression(branch, input, context));
      }
      output.sort((left, right) => {
        const [leftStart, leftOrdinal] = sourceOrderOf(left, context.document());
        const [rightStart, rightOrdinal] = sourceOrderOf(right, context.document());
        if (leftStart !== rightStart) {
          return leftStart - rightStart;
        }
        return leftOrdinal - rightOrdinal;
      });
      context.step(output.length);
      return output;
    }
  }
}

/** Source-order key of one native match (query.rs:627-659). */
function sourceOrderOf(match: IniMatch, document: IniDocument): [number, number] {
  switch (match.kind) {
    case 'Document':
      return [0, 0];
    case 'Section':
    case 'Entry':
      return [document.entity(Number(match.node.index())).span.startByte(), match.ordinal];
    case 'PhysicalLine':
      return [match.span.startByte(), match.ordinal];
    case 'LogicalLine': {
      const kind = document.entity(Number(match.node.index())).kind;
      if (kind.role !== 'LogicalLine') {
        throw new Error('internal: ini logical-line entity expected');
      }
      const first = document.entity(kind.physicalLines[0]);
      return [first.span.startByte(), match.ordinal];
    }
  }
}

function applyNativeOperator(
  input: readonly IniMatch[],
  operator: OperatorCall,
  context: Context,
): IniMatch[] {
  const output: IniMatch[] = [];
  const document = context.document();
  switch (operator.id) {
    case 'ini.document-sections': {
      const sections = document.sections();
      for (const match of input) {
        if (match.kind === 'Document') {
          for (let ordinal = 0; ordinal < sections.length; ordinal++) {
            output.push(context.sectionMatch(ordinal));
          }
        }
      }
      break;
    }
    case 'ini.section-entries': {
      for (const match of input) {
        if (match.kind !== 'Section') {
          continue;
        }
        const section = match.node;
        document.entries().forEach((entry, ordinal) => {
          if (entry.section().equals(section)) {
            output.push(context.entryMatch(ordinal));
          }
        });
      }
      break;
    }
    case 'ini.all-entries': {
      for (const match of input) {
        if (match.kind === 'Document') {
          for (let ordinal = 0; ordinal < document.entries().length; ordinal++) {
            output.push(context.entryMatch(ordinal));
          }
        }
      }
      break;
    }
    case 'ini.entry-section': {
      for (const match of input) {
        if (match.kind !== 'Entry') {
          continue;
        }
        const ordinal = document
          .sections()
          .findIndex((candidate) => candidate.nodeRef().equals(match.section));
        if (ordinal >= 0) {
          output.push(context.sectionMatch(ordinal));
        }
      }
      break;
    }
    case 'ini.section-name-equals': {
      const expected = stringArgument(operator, 'name');
      const comparison = stringArgument(operator, 'comparison');
      const equivalent = sectionComparison(document.profile().toString(), expected);
      for (const match of input) {
        if (match.kind !== 'Section') {
          continue;
        }
        const matches =
          comparison === 'OriginalExact'
            ? match.name === expected
            : match.comparisonName === equivalent;
        if (matches) {
          output.push(match);
        }
      }
      break;
    }
    case 'ini.entry-key-equals': {
      const expected = stringArgument(operator, 'key');
      const comparison = stringArgument(operator, 'comparison');
      const equivalent = keyComparison(document.profile().toString(), expected);
      for (const match of input) {
        if (match.kind !== 'Entry') {
          continue;
        }
        const matches =
          comparison === 'OriginalExact'
            ? match.key === expected
            : match.comparisonKey === equivalent;
        if (matches) {
          output.push(match);
        }
      }
      break;
    }
    case 'ini.entry-value-state-is': {
      const expected = stringArgument(operator, 'state') as IniValueState;
      for (const match of input) {
        if (match.kind === 'Entry' && match.valueState === expected) {
          output.push(match);
        }
      }
      break;
    }
    case 'ini.duplicate-group': {
      for (const match of input) {
        if (match.kind === 'Section' && match.duplicateGroup !== null) {
          document.sections().forEach((section, ordinal) => {
            if (section.duplicateGroup() === match.duplicateGroup) {
              output.push(context.sectionMatch(ordinal));
            }
          });
        } else if (match.kind === 'Entry' && match.duplicateGroup !== null) {
          document.entries().forEach((entry, ordinal) => {
            if (entry.duplicateGroup() === match.duplicateGroup) {
              output.push(context.entryMatch(ordinal));
            }
          });
        }
      }
      break;
    }
    case 'ini.physical-lines': {
      for (const match of input) {
        if (match.kind === 'Document') {
          document.physicalLines().forEach((line, ordinal) => {
            output.push({
              kind: 'PhysicalLine',
              ordinal,
              node: line.nodeRef(),
              span: line.span(),
            });
          });
        }
      }
      break;
    }
    case 'ini.logical-lines': {
      for (const match of input) {
        if (match.kind === 'Document') {
          document.logicalLines().forEach((line, ordinal) => {
            output.push({
              kind: 'LogicalLine',
              ordinal,
              node: line.nodeRef(),
              logicalKind: line.kind(),
            });
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
        const identity = iniMatchIdentity(match);
        if (!seen.has(identity)) {
          seen.add(identity);
          output.push(match);
        }
      }
      break;
    }
    default:
      throw new Error(`internal: validated INI native operator ${operator.id}`);
  }
  context.step(output.length);
  return output;
}

// ---------------------------------------------------------------------------
// Lossless syntax query
// ---------------------------------------------------------------------------

/**
 * Executes a validated INI lossless syntax query against every source
 * piece in raw order (query.rs:160-204).
 */
export function executeIniSyntaxQuery(
  executable: ExecutableQuery,
  document: IniDocument,
  limits: IniQueryLimits,
  cancellation: IniCancellationToken,
): IniQueryExecution<IniSyntaxMatch> {
  const definition = executable.validated.definition;
  if (definition.domain.id !== 'ini.lossless-syntax-query' || definition.domain.version !== 1) {
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
  const input: IniSyntaxMatch[] = pieces.map((piece, ordinal) => {
    const span = piece.span();
    return new IniSyntaxMatch(
      document.authority().nodeRef(BigInt(ordinal), 'IniSyntaxPiece'),
      span,
      kinds[ordinal],
      ordinal,
    );
  });
  const matches = executeSyntaxExpression(definition.expression, input, context);
  const selected = applySelection(matches, definition.selection);
  return { matches: selected };
}

/** Executes a syntax query and exposes its complete result as a cancellable cursor (query.rs:207-218). */
export function executeIniSyntaxQueryCursor(
  executable: ExecutableQuery,
  document: IniDocument,
  limits: IniQueryLimits,
  cancellation: IniCancellationToken,
): IniOrderedQueryCursor<IniSyntaxMatch> {
  const result = executeIniSyntaxQuery(executable, document, limits, cancellation);
  return IniOrderedQueryCursor.withCancellation(result.matches, cancellation);
}

function executeSyntaxExpression(
  expression: QueryExpression,
  input: readonly IniSyntaxMatch[],
  context: Context,
): IniSyntaxMatch[] {
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
      const output: IniSyntaxMatch[] = [];
      for (const branch of expression.branches) {
        output.push(...executeSyntaxExpression(branch, input, context));
        context.step(output.length);
      }
      return output;
    }
    case 'StructureOrderMerge': {
      const output: IniSyntaxMatch[] = [];
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
  input: readonly IniSyntaxMatch[],
  operator: OperatorCall,
  context: Context,
): IniSyntaxMatch[] {
  const output: IniSyntaxMatch[] = [];
  const document = context.document();
  switch (operator.id) {
    case 'ini.syntax-kind-is': {
      const expected = iniSyntaxKindFromName(stringArgument(operator, 'kind'));
      if (expected === null) {
        throw new Error('internal: validated syntax kind argument');
      }
      for (const match of input) {
        if (match.kind() === expected) {
          output.push(match);
        }
      }
      break;
    }
    case 'ini.syntax-text-equals': {
      const expected = stringArgument(operator, 'text');
      for (const match of input) {
        if (decodedSpanText(document, match.span()) === expected) {
          output.push(match);
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
        if (!seen.has(match.nodeRef())) {
          seen.add(match.nodeRef());
          output.push(match);
        }
      }
      break;
    }
    default:
      throw new Error(`internal: validated INI syntax operator ${operator.id}`);
  }
  context.step(output.length);
  return output;
}

/**
 * Decoded Unicode scalar text of one exact piece span (query.rs:661-676):
 * raw spans are mapped through the source's decoded boundary index so
 * UTF-8, UTF-16LE, and explicit Windows-code-page queries are semantically
 * identical while their raw spans remain distinct (RFC 0009 §9:339-341).
 */
function decodedSpanText(document: IniDocument, span: Span): string {
  const source = document.source();
  // The Rust reference slices a &str (UTF-8 bytes); the TypeScript mirror
  // stores a JS string (UTF-16 code units), so slice by the UTF-16 offset
  // — decodedUtf8Byte drifts for non-ASCII scalars and the BOM.
  const start = source.decodedPosition(span.startByte()).utf16CodeUnitOffset;
  const end = source.decodedPosition(span.endByte()).utf16CodeUnitOffset;
  return (source.decodedText() ?? '').slice(start, end);
}

// ---------------------------------------------------------------------------
// Ordered cursor (query.rs:145-157)
// ---------------------------------------------------------------------------

/** Terminal state of an ordered query cursor. */
export type IniQueryTerminalState = 'Completed' | 'Cancelled' | 'Failed';

/** Complete in-memory result iterated with cooperative cancellation (query.rs:146-157). */
export class IniOrderedQueryCursor<M> {
  readonly #matches: readonly M[];
  readonly #cancellation: IniCancellationToken;
  #position = 0;
  #terminal: IniQueryTerminalState = 'Completed';

  private constructor(matches: readonly M[], cancellation: IniCancellationToken) {
    this.#matches = matches;
    this.#cancellation = cancellation;
  }

  /** Creates a cancellable cursor over one complete result (query.rs:152-156). */
  static withCancellation<M>(
    matches: readonly M[],
    cancellation: IniCancellationToken,
  ): IniOrderedQueryCursor<M> {
    return new IniOrderedQueryCursor(matches, cancellation);
  }

  /** Yields the next match in order, or null when exhausted or cancelled. */
  next(): M | null {
    if (this.#cancellation.isCancelled()) {
      this.#terminal = 'Cancelled';
      return null;
    }
    if (this.#position >= this.#matches.length) {
      this.#terminal = 'Completed';
      return null;
    }
    return this.#matches[this.#position++];
  }

  /** Stable terminal state once iteration stops. */
  terminalState(): IniQueryTerminalState {
    return this.#terminal;
  }
}

// ---------------------------------------------------------------------------
// Argument decoding, selection, comparison helpers
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
      throw new IniQueryExecutionFailure('CardinalityViolation', {
        selection: 'ZeroOrOne',
        actual: values.length,
      });
    case 'RequireOne':
      if (values.length === 1) return [...values];
      throw new IniQueryExecutionFailure('CardinalityViolation', {
        selection: 'RequireOne',
        actual: values.length,
      });
    default:
      throw new Error(`internal: validated query selection ${selection}`);
  }
}

/** Profile-specific section comparison of one caller name (query.rs:678-683). */
function sectionComparison(profileId: string, name: string): string {
  if (profileId === 'ini.windows@1') {
    return name.toLowerCase();
  }
  return name;
}

/** Profile-specific key comparison of one caller name (query.rs:685-691). */
function keyComparison(profileId: string, key: string): string {
  if (profileId === 'ini.windows@1') {
    return key.toLowerCase();
  }
  if (profileId === 'ini.python-configparser@1') {
    return optionxform(key);
  }
  return key;
}

// ---------------------------------------------------------------------------
// Capability helper
// ---------------------------------------------------------------------------

/** The required capability set of every validated query (protocol/query.ts:554-560). */
export function iniQueryRequiredCapabilities(): CapabilitySet {
  const capabilities = new CapabilitySet();
  capabilities.insert(newCapabilityId('core.query.ordered-results', 1));
  return capabilities;
}
