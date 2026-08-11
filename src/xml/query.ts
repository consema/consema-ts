/**
 * Native and lossless-syntax query execution over one immutable snapshot.
 *
 * authority: crates/consema-xml/src/query.rs
 *  - XmlReferenceKind :20-29, XmlMatch :31-165 (Document | Declaration |
 *    Doctype | PrologItem | Element | Attribute | NamespaceBinding | Text |
 *    Cdata | Comment | ProcessingInstruction | Reference | ErrorRegion),
 *    XmlSyntaxMatch :187-220
 *  - execute_xml_query :222-249 (domain gate :229-235, root input
 *    :242-246), execute_xml_syntax_query :285-335, apply_selection
 *    :251-269 / :337-355 (All/First/Last/ZeroOrOne/RequireOne)
 *  - Context.step :378-391 (cancellation, max_steps, max_results),
 *    push/append :393-421
 *  - expression evaluation :484-554 (Input/Apply/Concat/
 *    StructureOrderMerge; native merge sorts by node index :556-576,
 *    syntax merge sorts by piece ordinal :543-551)
 *  - operators :578-1260 (xml.document-root :624-638, document-declaration
 *    :640-654, document-doctype :656-670, document-prolog/epilog
 *    :672-695, element-children :696-723, element-child-elements
 *    :774-792, element-child-text :794-812, element-child-cdata :814-832,
 *    element-child-comments :834-852, element-child-pi :854-875,
 *    element-descendants :877-903, element-attributes :905-921,
 *    element-namespace-bindings/in-scope-namespaces :923-959,
 *    content-parent/attribute-element/reference-text :978-1004,
 *    text-references :1006-1053, name-equals :1055-1114,
 *    attribute-value-equals :1116-1132, pi-target-equals :1134-1153,
 *    reference-kind-is :1155-1177, reference-name-equals :1179-1195,
 *    node-kind-is :1197-1228, core.take :1230-1245,
 *    core.distinct-by-identity :1247-1260)
 *  - reference node identity: text_references uses the fragment ordinal
 *    (:1037-1046); element/attribute/binding identities use arena
 *    index / occurrence ordinal
 *  - query definition/operator validation: typescript/src/protocol/query.ts
 *    (the XML operator table rows :404-432)
 *
 * Design (TypeScript-idiomatic): execution is eager and deterministic —
 * the complete match list is returned in source order, or a typed
 * `QueryExecutionFailure` with the frozen registered code is thrown
 * (no partial completed result exists).
 */

import type { NodeRef, Span } from '../document/identity.ts';
import { QueryExecutionFailure } from './errors.ts';
import { XmlDocument, textSemantic } from './document.ts';
import type { XmlAttributeData } from './document.ts';
import type { XmlSyntaxKind } from './syntax.ts';
import { xmlSyntaxKindFromName } from './syntax.ts';
import type {
  ExecutableQuery,
  OperatorCall,
  QueryExpression,
  QuerySelection,
} from '../protocol/query.ts';

// ---------------------------------------------------------------------------
// Execution limits and cancellation
// ---------------------------------------------------------------------------

/** Immutable query execution limits (query.rs:2967-2981 pattern). */
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

  /** Maximum operator steps (query.rs:2969). */
  maxSteps(): number {
    return this.#maxSteps;
  }

  /** Maximum complete results buffered by an operator (query.rs:2971). */
  maxResults(): number {
    return this.#maxResults;
  }
}

/** Cooperative cancellation flag (query.rs:205-207 pattern). */
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

/** One XML reference occurrence kind (query.rs:20-29). */
export type XmlReferenceKind = 'Character' | 'Predefined' | 'General';

/** Owned snapshot-bound XML native semantic query match (query.rs:31-165). */
export type XmlMatch =
  | {
      readonly kind: 'Document';
      /** Document identity. */
      readonly node: NodeRef;
    }
  | {
      readonly kind: 'Declaration';
      readonly node: NodeRef;
      readonly version: string;
      readonly encoding: string | null;
      readonly standalone: boolean | null;
    }
  | {
      readonly kind: 'Doctype';
      readonly node: NodeRef;
      /** Root-name spelling. */
      readonly name: string;
    }
  | {
      readonly kind: 'PrologItem';
      readonly node: NodeRef;
      /** Kind: `processing-instruction` or `comment`. */
      readonly kindName: string;
    }
  | {
      readonly kind: 'Element';
      readonly node: NodeRef;
      /** Owning element, when present. */
      readonly parent: NodeRef | null;
      /** Original prefix spelling, when present. */
      readonly prefix: string | null;
      readonly local: string;
      /** Resolved namespace URI, when provable. */
      readonly namespace: string | null;
      /** Whether a namespace error kept the name unprovable. */
      readonly namespaceError: boolean;
    }
  | {
      readonly kind: 'Attribute';
      readonly node: NodeRef;
      readonly element: NodeRef;
      readonly prefix: string | null;
      readonly local: string;
      readonly namespace: string | null;
      /** CDATA-normalized semantic value. */
      readonly value: string;
    }
  | {
      readonly kind: 'NamespaceBinding';
      readonly node: NodeRef;
      readonly element: NodeRef;
      /** Bound prefix; `null` is the default namespace. */
      readonly prefix: string | null;
      readonly uri: string;
    }
  | {
      readonly kind: 'Text';
      readonly node: NodeRef;
      readonly parent: NodeRef | null;
      /** Line-end-normalized semantic content. */
      readonly semantic: string;
    }
  | {
      readonly kind: 'Cdata';
      readonly node: NodeRef;
      readonly parent: NodeRef | null;
      readonly text: string;
    }
  | {
      readonly kind: 'Comment';
      readonly node: NodeRef;
      readonly parent: NodeRef | null;
      readonly text: string;
    }
  | {
      readonly kind: 'ProcessingInstruction';
      readonly node: NodeRef;
      readonly parent: NodeRef | null;
      readonly target: string;
      readonly content: string | null;
    }
  | {
      readonly kind: 'Reference';
      readonly node: NodeRef;
      /** Owning text occurrence. */
      readonly text: NodeRef;
      readonly parent: NodeRef | null;
      readonly kindName: XmlReferenceKind;
      /** Entity or reference name. */
      readonly name: string;
      /** Fully resolved character data. */
      readonly resolved: string;
    }
  | {
      readonly kind: 'ErrorRegion';
      readonly node: NodeRef;
      readonly span: Span;
    };

/** Owned snapshot-bound XML lossless syntax query match (query.rs:187-220). */
export class XmlSyntaxMatch {
  readonly #node: NodeRef;
  readonly #span: Span;
  readonly #kind: XmlSyntaxKind;
  readonly #ordinal: number;

  constructor(node: NodeRef, span: Span, kind: XmlSyntaxKind, ordinal: number) {
    this.#node = node;
    this.#span = span;
    this.#kind = kind;
    this.#ordinal = ordinal;
  }

  /** Process-local syntax-piece identity (query.rs:196-200). */
  nodeRef(): NodeRef {
    return this.#node;
  }

  /** Exact raw source span (query.rs:202-206). */
  span(): Span {
    return this.#span;
  }

  /** Format-specific lossless kind (query.rs:208-212). */
  kind(): XmlSyntaxKind {
    return this.#kind;
  }

  /** Zero-based source-order position (query.rs:214-218). */
  ordinal(): number {
    return this.#ordinal;
  }
}

/** A complete deterministic query result (query.rs:248 pattern). */
export class XmlQueryResult<M> {
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
  readonly document: XmlDocument;
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

function push<T>(context: ExecutionContext, output: T[], value: T): void {
  if (output.length + 1 > context.limits.maxResults()) {
    throw new QueryExecutionFailure('ResourceLimitExceeded');
  }
  output.push(value);
}

/**
 * Executes a validated XML native semantic query against one immutable
 * snapshot (query.rs:222-249).
 */
export function executeXmlQuery(
  executable: ExecutableQuery,
  document: XmlDocument,
  limits: QueryLimits,
  cancellation: CancellationToken,
): XmlQueryResult<XmlMatch> {
  const definition = executable.validated.definition;
  const domain = definition.domain;
  if (domain.id !== 'xml.native-semantic-query' || domain.version !== 1) {
    throw new QueryExecutionFailure('DomainMismatch', { domain });
  }
  const context: ExecutionContext = { document, limits, cancellation, steps: 0 };
  step(context, 1);
  const input: XmlMatch[] = [
    { kind: 'Document', node: document.nodeRef() },
  ];
  const matches = executeExpression(definition.expression, input, context);
  const selected = applySelection(matches, definition.selection);
  return new XmlQueryResult(selected);
}

/**
 * Executes a validated XML lossless syntax query against every source
 * piece in raw order (query.rs:285-335).
 */
export function executeXmlSyntaxQuery(
  executable: ExecutableQuery,
  document: XmlDocument,
  limits: QueryLimits,
  cancellation: CancellationToken,
): XmlQueryResult<XmlSyntaxMatch> {
  const definition = executable.validated.definition;
  const domain = definition.domain;
  if (domain.id !== 'xml.lossless-syntax-query' || domain.version !== 1) {
    throw new QueryExecutionFailure('DomainMismatch', { domain });
  }
  const index = document.losslessStructuralIndex();
  if (index === null) {
    throw new QueryExecutionFailure('DomainMismatch', { domain });
  }
  const context: ExecutionContext = { document, limits, cancellation, steps: 0 };
  const pieces = index.pieces();
  const kinds = document.losslessSyntaxKinds();
  step(context, pieces.length);
  const input: XmlSyntaxMatch[] = pieces.map((piece, ordinal) => {
    return new XmlSyntaxMatch(
      document.occurrenceNodeRef(ordinal, 'XmlSyntaxPiece'),
      piece.span(),
      kinds[ordinal],
      ordinal,
    );
  });
  const matches = executeSyntaxExpression(definition.expression, input, context);
  const selected = applySelection(matches, definition.selection);
  return new XmlQueryResult(selected);
}

function applySelection<M>(values: M[], selection: QuerySelection): M[] {
  switch (selection) {
    case 'All':
      return values;
    case 'First':
      return values.slice(0, 1);
    case 'Last':
      return values.slice(-1);
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

function executeExpression(
  expression: QueryExpression,
  input: XmlMatch[],
  context: ExecutionContext,
): XmlMatch[] {
  switch (expression.kind) {
    case 'Input':
      return input;
    case 'Apply': {
      const applied = executeExpression(expression.input, input, context);
      return applyOperator(expression.operator, applied, context);
    }
    case 'Concat': {
      let output: XmlMatch[] = [];
      for (const branch of expression.branches) {
        output = output.concat(executeExpression(branch, input, context));
        step(context, output.length);
      }
      return output;
    }
    case 'StructureOrderMerge': {
      let output: XmlMatch[] = [];
      for (const branch of expression.branches) {
        output = output.concat(executeExpression(branch, input, context));
      }
      output.sort((left, right) => sourceOrder(left) - sourceOrder(right));
      step(context, output.length);
      return output;
    }
  }
}

function executeSyntaxExpression(
  expression: QueryExpression,
  input: XmlSyntaxMatch[],
  context: ExecutionContext,
): XmlSyntaxMatch[] {
  switch (expression.kind) {
    case 'Input':
      return input;
    case 'Apply': {
      const applied = executeSyntaxExpression(expression.input, input, context);
      return applySyntaxOperator(expression.operator, applied, context);
    }
    case 'Concat': {
      let output: XmlSyntaxMatch[] = [];
      for (const branch of expression.branches) {
        output = output.concat(executeSyntaxExpression(branch, input, context));
        step(context, output.length);
      }
      return output;
    }
    case 'StructureOrderMerge': {
      let output: XmlSyntaxMatch[] = [];
      for (const branch of expression.branches) {
        output = output.concat(executeSyntaxExpression(branch, input, context));
      }
      output.sort((left, right) => left.ordinal() - right.ordinal());
      step(context, output.length);
      return output;
    }
  }
}

/** Source-order key of one native match (query.rs:556-576). */
function sourceOrder(item: XmlMatch): number {
  switch (item.kind) {
    case 'Document':
      return 0;
    case 'ErrorRegion':
      return Number(item.span.startByte());
    default:
      return Number(item.node.index());
  }
}

// ---------------------------------------------------------------------------
// Native operators (query.rs:578-1260)
// ---------------------------------------------------------------------------

function applyOperator(
  operator: OperatorCall,
  input: XmlMatch[],
  context: ExecutionContext,
): XmlMatch[] {
  const output: XmlMatch[] = [];
  switch (operator.id) {
    case 'xml.document-root':
      documentRoot(input, context, output);
      break;
    case 'xml.document-declaration':
      documentDeclaration(input, context, output);
      break;
    case 'xml.document-doctype':
      documentDoctype(input, context, output);
      break;
    case 'xml.document-prolog':
    case 'xml.document-epilog':
      documentPrologEpilog(operator.id, input, context, output);
      break;
    case 'xml.element-children':
      elementChildren(input, context, output);
      break;
    case 'xml.element-child-elements':
      elementChildElements(input, context, output);
      break;
    case 'xml.element-child-text':
      elementChildText(input, context, output);
      break;
    case 'xml.element-child-cdata':
      elementChildCdata(input, context, output);
      break;
    case 'xml.element-child-comments':
      elementChildComments(input, context, output);
      break;
    case 'xml.element-child-pi':
      elementChildPi(input, context, output);
      break;
    case 'xml.element-descendants':
      elementDescendants(input, context, output);
      break;
    case 'xml.element-attributes':
      elementAttributes(input, context, output);
      break;
    case 'xml.element-namespace-bindings':
    case 'xml.element-in-scope-namespaces':
      namespaceBindings(operator.id, input, context, output);
      break;
    case 'xml.content-parent':
    case 'xml.attribute-element':
    case 'xml.reference-text':
      contentParent(input, context, output);
      break;
    case 'xml.text-references':
      textReferences(input, context, output);
      break;
    case 'xml.name-equals':
      nameEquals(operator, input, context, output);
      break;
    case 'xml.attribute-value-equals':
      attributeValueEquals(operator, input, context, output);
      break;
    case 'xml.pi-target-equals':
      piTargetEquals(operator, input, context, output);
      break;
    case 'xml.reference-kind-is':
      referenceKindIs(operator, input, context, output);
      break;
    case 'xml.reference-name-equals':
      referenceNameEquals(operator, input, context, output);
      break;
    case 'xml.node-kind-is':
      nodeKindIs(operator, input, context, output);
      break;
    case 'core.take':
      take(operator, input, context, output);
      break;
    case 'core.distinct-by-identity':
      distinctByIdentity(input, context, output);
      break;
    default:
      throw new QueryExecutionFailure('DomainMismatch', {
        domain: { id: 'xml.native-semantic-query', version: 1 },
      });
  }
  step(context, output.length);
  return output;
}

/** `xml.document-root`: the one document element, when formation proved it (query.rs:624-638). */
function documentRoot(input: XmlMatch[], context: ExecutionContext, output: XmlMatch[]): void {
  const root = context.document.root();
  if (root === null) {
    return;
  }
  for (const item of input) {
    if (item.kind === 'Document') {
      push(context, output, elementMatch(context, root.rawIndex()));
    }
  }
}

/** `xml.document-declaration`: the XML declaration, when present (query.rs:640-654). */
function documentDeclaration(input: XmlMatch[], context: ExecutionContext, output: XmlMatch[]): void {
  const declared = context.document.declaration();
  if (declared === null) {
    return;
  }
  for (const item of input) {
    if (item.kind === 'Document') {
      push(context, output, {
        kind: 'Declaration',
        node: context.document.occurrenceNodeRef(1, 'XmlDeclaration'),
        version: declared.version,
        encoding: declared.encoding === null ? null : declared.encoding.value,
        standalone: declared.standalone === null ? null : declared.standalone.value,
      });
    }
  }
}

/** `xml.document-doctype`: the DOCTYPE occurrence, when present (query.rs:656-670). */
function documentDoctype(input: XmlMatch[], context: ExecutionContext, output: XmlMatch[]): void {
  const doctype = context.document.doctype();
  if (doctype === null) {
    return;
  }
  for (const item of input) {
    if (item.kind === 'Document') {
      push(context, output, {
        kind: 'Doctype',
        node: context.document.occurrenceNodeRef(2, 'XmlDoctype'),
        name: doctype.name.prefix === null ? doctype.name.local : `${doctype.name.prefix}:${doctype.name.local}`,
      });
    }
  }
}

/** `xml.document-prolog` / `xml.document-epilog`: ordered prolog or epilog occurrences (query.rs:672-695). */
function documentPrologEpilog(
  id: string,
  input: XmlMatch[],
  context: ExecutionContext,
  output: XmlMatch[],
): void {
  const items = id === 'xml.document-prolog' ? context.document.prolog() : context.document.epilog();
  for (const item of input) {
    if (item.kind === 'Document') {
      for (const prologItem of items) {
        if (prologItem.kind === 'ProcessingInstruction') {
          push(context, output, {
            kind: 'PrologItem',
            node: context.document.occurrenceNodeRef(
              prologItem.data.ordinal,
              'XmlProcessingInstruction',
            ),
            kindName: 'processing-instruction',
          });
        } else if (prologItem.kind === 'Comment') {
          push(context, output, {
            kind: 'PrologItem',
            node: context.document.occurrenceNodeRef(prologItem.data.ordinal, 'XmlComment'),
            kindName: 'comment',
          });
        }
      }
    }
  }
}

/** `xml.element-children`: every child content occurrence, mixed order (query.rs:696-723). */
function elementChildren(input: XmlMatch[], context: ExecutionContext, output: XmlMatch[]): void {
  for (const item of input) {
    if (item.kind !== 'Element') {
      continue;
    }
    const index = nodeToIndex(item.node);
    if (index === null) {
      continue;
    }
    const element = context.document.nodeAt(index);
    if (element.kind !== 'Element') {
      continue;
    }
    for (const child of element.data.children) {
      push(context, output, contentMatch(context, child, item.node));
    }
  }
}

/** One child content match (query.rs:706-716). */
function contentMatch(context: ExecutionContext, index: number, parent: NodeRef): XmlMatch {
  const node = context.document.nodeAt(index);
  switch (node.kind) {
    case 'Element':
      return elementMatch(context, index);
    case 'Text':
      return {
        kind: 'Text',
        node: context.document.nodeRefFor(index, 'XmlText'),
        parent,
        semantic: textSemantic(node.data),
      };
    case 'Cdata':
      return {
        kind: 'Cdata',
        node: context.document.nodeRefFor(index, 'XmlCdata'),
        parent,
        text: node.data.text,
      };
    case 'Comment':
      return {
        kind: 'Comment',
        node: context.document.nodeRefFor(index, 'XmlComment'),
        parent,
        text: node.data.text,
      };
    case 'ProcessingInstruction':
      return {
        kind: 'ProcessingInstruction',
        node: context.document.nodeRefFor(index, 'XmlProcessingInstruction'),
        parent,
        target: node.data.target,
        content: node.data.content === null ? null : node.data.content.text,
      };
    case 'ErrorRegion':
      return {
        kind: 'ErrorRegion',
        node: context.document.nodeRefFor(index, 'XmlErrorRegion'),
        span: node.data.span,
      };
  }
}

/** One element match from its arena index (query.rs:430-444). */
function elementMatch(context: ExecutionContext, index: number): XmlMatch {
  const node = context.document.nodeAt(index);
  if (node.kind !== 'Element') {
    throw new QueryExecutionFailure('DomainMismatch', {
      domain: { id: 'xml.native-semantic-query', version: 1 },
    });
  }
  const data = node.data;
  return {
    kind: 'Element',
    node: context.document.nodeRefFor(index, 'XmlElement'),
    parent: parentElementRef(context, index),
    prefix: data.qname.prefix,
    local: data.qname.local,
    namespace: data.expanded === null ? null : data.expanded.namespace,
    namespaceError: data.namespaceError !== null,
  };
}

/** The owning element's NodeRef of one arena index (query.rs:446-450). */
function parentElementRef(context: ExecutionContext, index: number): NodeRef | null {
  const parent = context.document.parentOfInternal(index);
  return parent === null ? null : context.document.nodeRefFor(parent, 'XmlElement');
}

/** `xml.element-child-elements`: child element occurrences only (query.rs:774-792). */
function elementChildElements(input: XmlMatch[], context: ExecutionContext, output: XmlMatch[]): void {
  for (const item of input) {
    if (item.kind !== 'Element') {
      continue;
    }
    const index = nodeToIndex(item.node);
    if (index === null) {
      continue;
    }
    const element = context.document.nodeAt(index);
    if (element.kind !== 'Element') {
      continue;
    }
    for (const child of element.data.children) {
      if (context.document.nodeAt(child).kind === 'Element') {
        push(context, output, elementMatch(context, child));
      }
    }
  }
}

/** `xml.element-child-text`: child text occurrences only (query.rs:794-812). */
function elementChildText(input: XmlMatch[], context: ExecutionContext, output: XmlMatch[]): void {
  for (const item of input) {
    if (item.kind !== 'Element') {
      continue;
    }
    const index = nodeToIndex(item.node);
    if (index === null) {
      continue;
    }
    const element = context.document.nodeAt(index);
    if (element.kind !== 'Element') {
      continue;
    }
    for (const child of element.data.children) {
      if (context.document.nodeAt(child).kind === 'Text') {
        push(context, output, contentMatch(context, child, item.node));
      }
    }
  }
}

/** `xml.element-child-cdata`: child CDATA occurrences only (query.rs:814-832). */
function elementChildCdata(input: XmlMatch[], context: ExecutionContext, output: XmlMatch[]): void {
  for (const item of input) {
    if (item.kind !== 'Element') {
      continue;
    }
    const index = nodeToIndex(item.node);
    if (index === null) {
      continue;
    }
    const element = context.document.nodeAt(index);
    if (element.kind !== 'Element') {
      continue;
    }
    for (const child of element.data.children) {
      if (context.document.nodeAt(child).kind === 'Cdata') {
        push(context, output, contentMatch(context, child, item.node));
      }
    }
  }
}

/** `xml.element-child-comments`: child comment occurrences only (query.rs:834-852). */
function elementChildComments(input: XmlMatch[], context: ExecutionContext, output: XmlMatch[]): void {
  for (const item of input) {
    if (item.kind !== 'Element') {
      continue;
    }
    const index = nodeToIndex(item.node);
    if (index === null) {
      continue;
    }
    const element = context.document.nodeAt(index);
    if (element.kind !== 'Element') {
      continue;
    }
    for (const child of element.data.children) {
      if (context.document.nodeAt(child).kind === 'Comment') {
        push(context, output, contentMatch(context, child, item.node));
      }
    }
  }
}

/** `xml.element-child-pi`: child processing-instruction occurrences only (query.rs:854-875). */
function elementChildPi(input: XmlMatch[], context: ExecutionContext, output: XmlMatch[]): void {
  for (const item of input) {
    if (item.kind !== 'Element') {
      continue;
    }
    const index = nodeToIndex(item.node);
    if (index === null) {
      continue;
    }
    const element = context.document.nodeAt(index);
    if (element.kind !== 'Element') {
      continue;
    }
    for (const child of element.data.children) {
      if (context.document.nodeAt(child).kind === 'ProcessingInstruction') {
        push(context, output, contentMatch(context, child, item.node));
      }
    }
  }
}

/** `xml.element-descendants`: bounded pre-order traversal (query.rs:877-903). */
function elementDescendants(input: XmlMatch[], context: ExecutionContext, output: XmlMatch[]): void {
  for (const item of input) {
    if (item.kind !== 'Element') {
      continue;
    }
    const index = nodeToIndex(item.node);
    if (index === null) {
      continue;
    }
    const stack: number[] = [index];
    while (stack.length > 0) {
      const current = stack.pop()!;
      const element = context.document.nodeAt(current);
      if (element.kind === 'Element') {
        const children = element.data.children;
        for (let at = children.length - 1; at >= 0; at--) {
          if (context.document.nodeAt(children[at]).kind === 'Element') {
            stack.push(children[at]);
          }
        }
        if (current !== index) {
          push(context, output, elementMatch(context, current));
        }
      }
    }
  }
}

/** `xml.element-attributes`: ordered attributes, excluding declarations (query.rs:905-921). */
function elementAttributes(input: XmlMatch[], context: ExecutionContext, output: XmlMatch[]): void {
  for (const item of input) {
    if (item.kind !== 'Element') {
      continue;
    }
    const index = nodeToIndex(item.node);
    if (index === null) {
      continue;
    }
    const element = context.document.nodeAt(index);
    if (element.kind !== 'Element') {
      continue;
    }
    for (const attribute of element.data.attributes) {
      push(context, output, attributeMatch(attribute, item.node, context));
    }
  }
}

/** `xml.element-namespace-bindings` / `xml.element-in-scope-namespaces` (query.rs:923-959). */
function namespaceBindings(
  id: string,
  input: XmlMatch[],
  context: ExecutionContext,
  output: XmlMatch[],
): void {
  for (const item of input) {
    if (item.kind !== 'Element') {
      continue;
    }
    const index = nodeToIndex(item.node);
    if (index === null) {
      continue;
    }
    const element = context.document.nodeAt(index);
    if (element.kind !== 'Element') {
      continue;
    }
    if (id === 'xml.element-in-scope-namespaces') {
      // Ancestry-derived in-scope bindings, oldest declaration first, each
      // with its true origin (query.rs:934-949).
      const chain: number[] = [];
      let current: number | null = index;
      while (current !== null) {
        chain.push(current);
        current = context.document.parentOfInternal(current);
      }
      for (let at = chain.length - 1; at >= 0; at--) {
        const ancestor = context.document.nodeAt(chain[at]);
        if (ancestor.kind !== 'Element') {
          continue;
        }
        const elementRef = context.document.nodeRefFor(chain[at], 'XmlElement');
        for (const binding of ancestor.data.namespaces) {
          push(context, output, namespaceBindingMatch(binding, elementRef, context));
        }
      }
    } else {
      for (const binding of element.data.namespaces) {
        push(context, output, namespaceBindingMatch(binding, item.node, context));
      }
    }
  }
}

/** One namespace binding match on one owning element (query.rs:961-976). */
function namespaceBindingMatch(
  binding: { readonly ordinal: number; readonly prefix: string | null; readonly uri: string },
  element: NodeRef,
  context: ExecutionContext,
): XmlMatch {
  return {
    kind: 'NamespaceBinding',
    node: context.document.occurrenceNodeRef(binding.ordinal, 'XmlNamespaceBinding'),
    element,
    prefix: binding.prefix,
    uri: binding.uri,
  };
}

/** `xml.content-parent` / `xml.attribute-element` / `xml.reference-text` (query.rs:978-1004). */
function contentParent(input: XmlMatch[], context: ExecutionContext, output: XmlMatch[]): void {
  for (const item of input) {
    switch (item.kind) {
      case 'Attribute':
      case 'NamespaceBinding':
        push(context, output, elementFromNode(context, item.element));
        break;
      case 'Text':
      case 'Cdata':
      case 'Comment':
      case 'ProcessingInstruction':
      case 'Element':
      case 'Reference':
        if (item.parent !== null) {
          push(context, output, elementFromNode(context, item.parent));
        }
        break;
      default:
        break;
    }
  }
}

/** `xml.text-references`: the ordered reference occurrences of one text (query.rs:1006-1053). */
function textReferences(input: XmlMatch[], context: ExecutionContext, output: XmlMatch[]): void {
  for (const item of input) {
    if (item.kind !== 'Text') {
      continue;
    }
    const index = nodeToIndex(item.node);
    if (index === null) {
      continue;
    }
    const node = context.document.nodeAt(index);
    if (node.kind !== 'Text') {
      continue;
    }
    for (let ordinal = 0; ordinal < node.data.fragments.length; ordinal++) {
      const fragment = node.data.fragments[ordinal];
      let kindName: XmlReferenceKind;
      let name: string;
      let resolved: string;
      switch (fragment.kind) {
        case 'Literal':
          continue;
        case 'CharacterReference':
          kindName = 'Character';
          name = `&#x${fragment.resolved.codePointAt(0)!.toString(16).toUpperCase()};`;
          resolved = fragment.resolved;
          break;
        case 'PredefinedEntity':
          kindName = 'Predefined';
          name = fragment.name;
          resolved = fragment.resolved;
          break;
        case 'GeneralEntity':
          kindName = 'General';
          name = fragment.name;
          resolved = fragment.resolved;
          break;
      }
      push(context, output, {
        kind: 'Reference',
        node: context.document.occurrenceNodeRef(ordinal, 'XmlEntityReference'),
        text: item.node,
        parent: item.parent,
        kindName,
        name,
        resolved,
      });
    }
  }
}

/** `xml.name-equals`: original-spelling or expanded-name comparison (query.rs:1055-1114). */
function nameEquals(
  operator: OperatorCall,
  input: XmlMatch[],
  context: ExecutionContext,
  output: XmlMatch[],
): void {
  const expectedPrefix = stringArgument(operator, 'prefix');
  const expectedLocal = stringArgument(operator, 'local');
  const expectedNamespace = stringArgument(operator, 'namespace');
  const comparison = stringArgument(operator, 'comparison');
  for (const item of input) {
    let matches = false;
    switch (item.kind) {
      case 'Element':
        if (comparison === 'OriginalExact') {
          matches = (item.prefix ?? '') === expectedPrefix && item.local === expectedLocal;
        } else if (comparison === 'Expanded' && !item.namespaceError) {
          matches = (item.namespace ?? '') === expectedNamespace && item.local === expectedLocal;
        }
        break;
      case 'Attribute':
        if (comparison === 'OriginalExact') {
          matches = (item.prefix ?? '') === expectedPrefix && item.local === expectedLocal;
        } else if (comparison === 'Expanded') {
          matches = (item.namespace ?? '') === expectedNamespace && item.local === expectedLocal;
        }
        break;
      default:
        break;
    }
    if (matches) {
      push(context, output, item);
    }
  }
}

/** `xml.attribute-value-equals`: CDATA-normalized value equality (query.rs:1116-1132). */
function attributeValueEquals(
  operator: OperatorCall,
  input: XmlMatch[],
  context: ExecutionContext,
  output: XmlMatch[],
): void {
  const expected = stringArgument(operator, 'value');
  for (const item of input) {
    if (item.kind === 'Attribute' && item.value === expected) {
      push(context, output, item);
    }
  }
}

/** `xml.pi-target-equals`: processing-instruction target equality (query.rs:1134-1153). */
function piTargetEquals(
  operator: OperatorCall,
  input: XmlMatch[],
  context: ExecutionContext,
  output: XmlMatch[],
): void {
  const expected = stringArgument(operator, 'target');
  for (const item of input) {
    if (item.kind === 'ProcessingInstruction' && item.target === expected) {
      push(context, output, item);
    }
  }
}

/** `xml.reference-kind-is`: reference kind equality (query.rs:1155-1177). */
function referenceKindIs(
  operator: OperatorCall,
  input: XmlMatch[],
  context: ExecutionContext,
  output: XmlMatch[],
): void {
  const expected = stringArgument(operator, 'kind');
  const kindName = expected === 'Character' || expected === 'Predefined' || expected === 'General'
    ? (expected as XmlReferenceKind)
    : null;
  if (kindName === null) {
    throw new QueryExecutionFailure('DomainMismatch', {
      domain: { id: 'xml.native-semantic-query', version: 1 },
    });
  }
  for (const item of input) {
    if (item.kind === 'Reference' && item.kindName === kindName) {
      push(context, output, item);
    }
  }
}

/** `xml.reference-name-equals`: reference name equality (query.rs:1179-1195). */
function referenceNameEquals(
  operator: OperatorCall,
  input: XmlMatch[],
  context: ExecutionContext,
  output: XmlMatch[],
): void {
  const expected = stringArgument(operator, 'name');
  for (const item of input) {
    if (item.kind === 'Reference' && item.name === expected) {
      push(context, output, item);
    }
  }
}

/** `xml.node-kind-is`: match-kind filter over mixed output (query.rs:1197-1228). */
function nodeKindIs(
  operator: OperatorCall,
  input: XmlMatch[],
  context: ExecutionContext,
  output: XmlMatch[],
): void {
  const expected = stringArgument(operator, 'kind');
  for (const item of input) {
    const kind = matchKindName(item);
    if (kind === expected) {
      push(context, output, item);
    }
  }
}

/** Stable node-kind name of one match (query.rs:1208-1222). */
function matchKindName(item: XmlMatch): string {
  switch (item.kind) {
    case 'Document':
      return 'document';
    case 'Declaration':
      return 'declaration';
    case 'Doctype':
      return 'doctype';
    case 'PrologItem':
      return 'prolog-item';
    case 'Element':
      return 'element';
    case 'Attribute':
      return 'attribute';
    case 'NamespaceBinding':
      return 'namespace-binding';
    case 'Text':
      return 'text';
    case 'Cdata':
      return 'cdata';
    case 'Comment':
      return 'comment';
    case 'ProcessingInstruction':
      return 'processing-instruction';
    case 'Reference':
      return 'reference';
    case 'ErrorRegion':
      return 'error-region';
  }
}

/** `core.take`: the first `count` input items (query.rs:1230-1245). */
function take(
  operator: OperatorCall,
  input: XmlMatch[],
  context: ExecutionContext,
  output: XmlMatch[],
): void {
  const count = operator.arguments.get('count');
  if (count === undefined || count.kind !== 'Integer' || count.value < 0n) {
    throw new QueryExecutionFailure('DomainMismatch', {
      domain: { id: 'xml.native-semantic-query', version: 1 },
    });
  }
  const limit = count.value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(count.value);
  for (let index = 0; index < input.length && index < limit; index++) {
    push(context, output, input[index]);
  }
}

/** `core.distinct-by-identity`: first occurrence of every identity (query.rs:1247-1260). */
function distinctByIdentity(input: XmlMatch[], context: ExecutionContext, output: XmlMatch[]): void {
  const seen = new Set<string>();
  for (const item of input) {
    const key = `${item.node.role()}:${item.node.index()}`;
    if (!seen.has(key)) {
      seen.add(key);
      push(context, output, item);
    }
  }
}

function elementFromNode(context: ExecutionContext, node: NodeRef): XmlMatch {
  const index = nodeToIndex(node);
  if (index !== null) {
    return elementMatch(context, index);
  }
  const root = context.document.root();
  if (root !== null) {
    return elementMatch(context, root.rawIndex());
  }
  return { kind: 'Document', node: context.document.nodeRef() };
}

function attributeMatch(
  attribute: XmlAttributeData,
  element: NodeRef,
  context: ExecutionContext,
): XmlMatch {
  return {
    kind: 'Attribute',
    node: context.document.occurrenceNodeRef(attribute.ordinal, 'XmlAttribute'),
    element,
    prefix: attribute.qname.prefix,
    local: attribute.qname.local,
    namespace: attribute.expanded === null ? null : attribute.expanded.namespace,
    value: attribute.normalizedValue,
  };
}

function nodeToIndex(node: NodeRef): number | null {
  const index = node.index();
  return index > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(index);
}

function stringArgument(operator: OperatorCall, name: string): string {
  const value = operator.arguments.get(name);
  if (value === undefined || value.kind !== 'String') {
    throw new QueryExecutionFailure('DomainMismatch', {
      domain: { id: 'xml.native-semantic-query', version: 1 },
    });
  }
  return value.value;
}

// ---------------------------------------------------------------------------
// Syntax operators (query.rs:1327-1400)
// ---------------------------------------------------------------------------

function applySyntaxOperator(
  operator: OperatorCall,
  input: XmlSyntaxMatch[],
  context: ExecutionContext,
): XmlSyntaxMatch[] {
  const output: XmlSyntaxMatch[] = [];
  switch (operator.id) {
    case 'xml.syntax-kind-is': {
      const expected = stringArgument(operator, 'kind');
      const kind = xmlSyntaxKindFromName(expected);
      if (kind === null) {
        throw new QueryExecutionFailure('DomainMismatch', {
          domain: { id: 'xml.lossless-syntax-query', version: 1 },
        });
      }
      for (const item of input) {
        if (item.kind() === kind) {
          push(context, output, item);
        }
      }
      break;
    }
    case 'xml.syntax-text-equals': {
      const expected = stringArgument(operator, 'text');
      for (const item of input) {
        const span = item.span();
        const text = new TextDecoder().decode(
          context.document.render().slice(Number(span.startByte()), Number(span.endByte())),
        );
        if (text === expected) {
          push(context, output, item);
        }
      }
      break;
    }
    case 'core.take': {
      const count = operator.arguments.get('count');
      if (count === undefined || count.kind !== 'Integer' || count.value < 0n) {
        throw new QueryExecutionFailure('DomainMismatch', {
          domain: { id: 'xml.lossless-syntax-query', version: 1 },
        });
      }
      const limit = count.value > BigInt(Number.MAX_SAFE_INTEGER)
        ? Number.MAX_SAFE_INTEGER
        : Number(count.value);
      for (let index = 0; index < input.length && index < limit; index++) {
        push(context, output, input[index]);
      }
      break;
    }
    case 'core.distinct-by-identity': {
      const seen = new Set<string>();
      for (const item of input) {
        const node = item.nodeRef();
        const key = `${node.role()}:${node.index()}`;
        if (!seen.has(key)) {
          seen.add(key);
          push(context, output, item);
        }
      }
      break;
    }
    default:
      throw new QueryExecutionFailure('DomainMismatch', {
        domain: { id: 'xml.lossless-syntax-query', version: 1 },
      });
  }
  step(context, output.length);
  return output;
}
