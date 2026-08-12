/**
 * The closed HCL expression AST, the canonical-decimal contract, the
 * literal-complete boundary, and the structural fingerprint (RFC 0014 §4.3-
 * §4.6, §6, §8).
 *
 * authority: crates/consema-hcl/src/expression.rs —
 *  - HclExpressionKind :200-313 (the closed variant set), kind names
 *    :561-642 (the stable spellings "number"/"boolean"/"null"/"template"/
 *    "function-call"/"variable-ref"/"traversal"/"unary"/"binary"/
 *    "conditional"/"for-tuple"/"for-object"/"tuple"/"object"/
 *    "parenthesized"), UnaryOp :856-884 ("-"/"!"), BinaryOp :886-940,
 *    HeredocMode :1159-1177 ("<<"/"<<-")
 *  - HclNumber :644-717 (span + canonical decimal; equality is
 *    canonical-decimal equality)
 *  - canonical_decimal :737-851 (pure decimal string arithmetic; the
 *    exponent folding is bounded by max_number_digits)
 *  - is_literal_complete :1531-1566, literal_value :1596-1712,
 *    HclLiteralValue :1723-1786 (the typed literal projection), the
 *    `<<-` indentation stripping :1692-1712
 *  - children() :80-87 (ordered direct child expressions in source order)
 *  - the structural fingerprint serialization lives in materialization.rs:
 *    expression_fingerprint_value :1507-1516, write_expression_structure
 *    :1525-1667, write_directive_structure :1671-1685, write_for_intro
 *    :1689-1699, write_traversal_step :1702-1725, write_object_key_structure
 *    :1728-1762, push_text :1765-1768 (FNV-1a 64-bit, offset basis
 *    0xcbf29ce484222325, prime 0x100000001b3)
 *  - the kind family table (projection.rs:1004; RFC 0014 §8.2): variable-ref
 *    and traversal are one family "variable", for-tuple and for-object are
 *    one family "for"
 *
 * Design (TypeScript-idiomatic): the AST is a closed discriminated union of
 * plain immutable records whose children are direct nested references; the
 * document layer assigns every node a pre-order entity index for
 * snapshot-bound handles. Spans are attached to nodes for exact-text
 * derivation; structural equality and the fingerprint never consult spans.
 */

import type { Span } from '../document/identity.ts';

// ---------------------------------------------------------------------------
// Operators and heredoc mode (expression.rs:856-940, 1159-1177)
// ---------------------------------------------------------------------------

/** Unary operator set; exactly `-` and `!` exist (expression.rs:856-861). */
export type UnaryOp = 'Minus' | 'Not';

/** Stable operator spelling (expression.rs:866-871). */
export function unaryOpAsStr(op: UnaryOp): string {
  return op === 'Minus' ? '-' : '!';
}

/** The thirteen binary operators (expression.rs:886-916). */
export type BinaryOp =
  | 'Equal'
  | 'NotEqual'
  | 'Less'
  | 'Greater'
  | 'LessEqual'
  | 'GreaterEqual'
  | 'Add'
  | 'Subtract'
  | 'Multiply'
  | 'Divide'
  | 'Modulo'
  | 'And'
  | 'Or';

/** Stable operator spelling (expression.rs:918-936). */
export function binaryOpAsStr(op: BinaryOp): string {
  switch (op) {
    case 'Equal':
      return '==';
    case 'NotEqual':
      return '!=';
    case 'Less':
      return '<';
    case 'Greater':
      return '>';
    case 'LessEqual':
      return '<=';
    case 'GreaterEqual':
      return '>=';
    case 'Add':
      return '+';
    case 'Subtract':
      return '-';
    case 'Multiply':
      return '*';
    case 'Divide':
      return '/';
    case 'Modulo':
      return '%';
    case 'And':
      return '&&';
    case 'Or':
      return '||';
  }
}

/** Heredoc introducer mode (expression.rs:1159-1165). */
export type HeredocMode = 'Plain' | 'StripIndent';

/** Stable mode spelling (expression.rs:1170-1175). */
export function heredocModeAsStr(mode: HeredocMode): string {
  return mode === 'Plain' ? '<<' : '<<-';
}

/** Heredoc representation facts (RFC 0014 §4.5, §6). */
export interface HeredocFacts {
  readonly mode: HeredocMode;
  /** Bare identifier marker spelling. */
  readonly marker: string;
}

// ---------------------------------------------------------------------------
// The expression AST (expression.rs:200-313)
// ---------------------------------------------------------------------------

/** One exact number literal: span, source spelling, and canonical decimal (expression.rs:644-717). */
export interface HclNumber {
  readonly span: Span;
  /** Exact source spelling derived from the span. */
  readonly spelling: string;
  /** Canonical decimal spelling (expression.rs:694-702). */
  readonly canonical: string;
}

/** One function-call argument with its `...` expansion marker fact (expression.rs:215-224). */
export interface HclCallArg {
  readonly expression: HclExpr;
  readonly expand: boolean;
}

/** Traversal root; keyword spellings are dual-read roots (expression.rs:232-240). */
export type HclTraversalRoot =
  | { readonly kind: 'Variable'; readonly name: string }
  | { readonly kind: 'Boolean'; readonly value: boolean }
  | { readonly kind: 'Null' };

/** One traversal step (expression.rs:233-239; GetAttr/Index/AttrSplat/FullSplat). */
export type HclTraversalStep =
  | { readonly kind: 'GetAttr'; readonly name: string }
  | { readonly kind: 'Index'; readonly key: HclExpr }
  | { readonly kind: 'AttrSplat'; readonly steps: readonly HclTraversalStep[] }
  | { readonly kind: 'FullSplat'; readonly steps: readonly HclTraversalStep[] };

/** One `for` introduction (expression.rs:271-292; RFC 0014 §4.6). */
export interface HclForIntro {
  /** Optional key identifier. */
  readonly key: string | null;
  /** Value identifier. */
  readonly value: string;
  /** Collection expression. */
  readonly collection: HclExpr;
}

/** One object-constructor key (RFC 0014 §4.6; expression.rs:1728-1762). */
export type HclObjectKey =
  | { readonly kind: 'Identifier'; readonly name: string }
  | { readonly kind: 'Number'; readonly number: HclNumber }
  | { readonly kind: 'Template'; readonly parts: readonly HclTemplatePart[] }
  | { readonly kind: 'Paren'; readonly inner: HclExpr };

/** One object-constructor entry (expression.rs:301-304). */
export interface HclObjectEntry {
  readonly key: HclObjectKey;
  readonly value: HclExpr;
}

/** One template directive (RFC 0014 §4.4; materialization.rs:1671-1685). */
export type HclDirective =
  | { readonly kind: 'If'; readonly condition: HclExpr }
  | { readonly kind: 'Else' }
  | { readonly kind: 'EndIf' }
  | { readonly kind: 'For'; readonly intro: HclForIntro }
  | { readonly kind: 'EndFor' };

/** One ordered template part (RFC 0014 §6; expression.rs:1788-1803). */
export type HclTemplatePart =
  | { readonly kind: 'Literal'; readonly text: string; readonly span: Span }
  | { readonly kind: 'Interpolation'; readonly expression: HclExpr; readonly span: Span }
  | { readonly kind: 'Directive'; readonly directive: HclDirective; readonly span: Span };

/** Whether a template part is a literal run (expression.rs:1560-1566). */
export function templatePartIsLiteral(part: HclTemplatePart): boolean {
  return part.kind === 'Literal';
}

/** One expression AST node with its exact span (expression.rs:56-88). */
export type HclExpr =
  | { readonly kind: 'Number'; readonly number: HclNumber; readonly span: Span }
  | { readonly kind: 'Boolean'; readonly value: boolean; readonly span: Span }
  | { readonly kind: 'Null'; readonly span: Span }
  | {
      readonly kind: 'Template';
      readonly parts: readonly HclTemplatePart[];
      readonly heredoc: HeredocFacts | null;
      readonly span: Span;
    }
  | { readonly kind: 'FunctionCall'; readonly name: string; readonly args: readonly HclCallArg[]; readonly span: Span }
  | { readonly kind: 'VariableRef'; readonly name: string; readonly span: Span }
  | {
      readonly kind: 'Traversal';
      readonly root: HclTraversalRoot;
      readonly steps: readonly HclTraversalStep[];
      readonly span: Span;
    }
  | { readonly kind: 'Unary'; readonly op: UnaryOp; readonly operand: HclExpr; readonly span: Span }
  | {
      readonly kind: 'Binary';
      readonly op: BinaryOp;
      readonly lhs: HclExpr;
      readonly rhs: HclExpr;
      readonly span: Span;
    }
  | {
      readonly kind: 'Conditional';
      readonly condition: HclExpr;
      readonly then: HclExpr;
      readonly else_: HclExpr;
      readonly span: Span;
    }
  | {
      readonly kind: 'ForTuple';
      readonly intro: HclForIntro;
      readonly value: HclExpr;
      readonly condition: HclExpr | null;
      readonly span: Span;
    }
  | {
      readonly kind: 'ForObject';
      readonly intro: HclForIntro;
      readonly key: HclExpr;
      readonly value: HclExpr;
      readonly grouping: boolean;
      readonly condition: HclExpr | null;
      readonly span: Span;
    }
  | { readonly kind: 'Tuple'; readonly elements: readonly HclExpr[]; readonly span: Span }
  | { readonly kind: 'Object'; readonly entries: readonly HclObjectEntry[]; readonly span: Span }
  | { readonly kind: 'Paren'; readonly inner: HclExpr; readonly span: Span };

/** The closed payload-free expression kind name set (expression.rs:561-595). */
export type HclExpressionKindName =
  | 'Number'
  | 'Boolean'
  | 'Null'
  | 'Template'
  | 'FunctionCall'
  | 'VariableRef'
  | 'Traversal'
  | 'Unary'
  | 'Binary'
  | 'Conditional'
  | 'ForTuple'
  | 'ForObject'
  | 'Tuple'
  | 'Object'
  | 'Parenthesized';

/** The frozen 15 spellings (expression.rs:600-618). */
export const HCL_EXPRESSION_KIND_SPELLINGS = [
  'number',
  'boolean',
  'null',
  'template',
  'function-call',
  'variable-ref',
  'traversal',
  'unary',
  'binary',
  'conditional',
  'for-tuple',
  'for-object',
  'tuple',
  'object',
  'parenthesized',
] as const;

/** Stable kind spelling (expression.rs:600-618). */
export function expressionKindNameAsStr(kind: HclExpressionKindName): string {
  switch (kind) {
    case 'Number':
      return 'number';
    case 'Boolean':
      return 'boolean';
    case 'Null':
      return 'null';
    case 'Template':
      return 'template';
    case 'FunctionCall':
      return 'function-call';
    case 'VariableRef':
      return 'variable-ref';
    case 'Traversal':
      return 'traversal';
    case 'Unary':
      return 'unary';
    case 'Binary':
      return 'binary';
    case 'Conditional':
      return 'conditional';
    case 'ForTuple':
      return 'for-tuple';
    case 'ForObject':
      return 'for-object';
    case 'Tuple':
      return 'tuple';
    case 'Object':
      return 'object';
    case 'Parenthesized':
      return 'parenthesized';
  }
}

/** Resolves one kind spelling (expression.rs:622-641). */
export function expressionKindNameFromName(name: string): HclExpressionKindName | null {
  switch (name) {
    case 'number':
      return 'Number';
    case 'boolean':
      return 'Boolean';
    case 'null':
      return 'Null';
    case 'template':
      return 'Template';
    case 'function-call':
      return 'FunctionCall';
    case 'variable-ref':
      return 'VariableRef';
    case 'traversal':
      return 'Traversal';
    case 'unary':
      return 'Unary';
    case 'binary':
      return 'Binary';
    case 'conditional':
      return 'Conditional';
    case 'for-tuple':
      return 'ForTuple';
    case 'for-object':
      return 'ForObject';
    case 'tuple':
      return 'Tuple';
    case 'object':
      return 'Object';
    case 'parenthesized':
      return 'Parenthesized';
    default:
      return null;
  }
}

/** The payload-free kind name of one expression node. */
export function expressionKindOf(expression: HclExpr): HclExpressionKindName {
  return expression.kind === 'Paren'
    ? 'Parenthesized'
    : (expression.kind as HclExpressionKindName);
}

/**
 * The kind family table of the `hcl.expression@1` record (projection.rs:
 * 1004; RFC 0014 §8.2): variable and traversal expressions are one family
 * `variable`, for-expressions are one family `for`.
 */
export function kindFamily(kind: HclExpressionKindName): string {
  switch (kind) {
    case 'Number':
      return 'number';
    case 'Boolean':
      return 'boolean';
    case 'Null':
      return 'null';
    case 'Template':
      return 'template';
    case 'FunctionCall':
      return 'function-call';
    case 'VariableRef':
    case 'Traversal':
      return 'variable';
    case 'Unary':
      return 'unary';
    case 'Binary':
      return 'binary';
    case 'Conditional':
      return 'conditional';
    case 'ForTuple':
    case 'ForObject':
      return 'for';
    case 'Tuple':
      return 'tuple';
    case 'Object':
      return 'object';
    case 'Parenthesized':
      return 'parenthesized';
  }
}

/** Whether a spelling is one of the thirteen family spellings. */
export function isKindFamilySpelling(spelling: string): boolean {
  switch (spelling) {
    case 'number':
    case 'boolean':
    case 'null':
    case 'template':
    case 'function-call':
    case 'variable':
    case 'unary':
    case 'binary':
    case 'conditional':
    case 'for':
    case 'tuple':
    case 'object':
    case 'parenthesized':
      return true;
    default:
      return false;
  }
}

/** Ordered direct child expressions in source order (expression.rs:80-87). */
export function expressionChildren(expression: HclExpr): HclExpr[] {
  switch (expression.kind) {
    case 'Number':
    case 'Boolean':
    case 'Null':
    case 'VariableRef':
      return [];
    case 'Template': {
      const children: HclExpr[] = [];
      for (const part of expression.parts) {
        if (part.kind === 'Interpolation') {
          children.push(part.expression);
        } else if (part.kind === 'Directive') {
          const directive = part.directive;
          if (directive.kind === 'If') {
            children.push(directive.condition);
          } else if (directive.kind === 'For') {
            children.push(directive.intro.collection);
          }
        }
      }
      return children;
    }
    case 'FunctionCall':
      return expression.args.map((argument) => argument.expression);
    case 'Traversal': {
      const children: HclExpr[] = [];
      for (const step of expression.steps) {
        if (step.kind === 'Index') {
          children.push(step.key);
        } else if (step.kind === 'AttrSplat' || step.kind === 'FullSplat') {
          for (const inner of step.steps) {
            if (inner.kind === 'Index') {
              children.push(inner.key);
            }
          }
        }
      }
      return children;
    }
    case 'Unary':
      return [expression.operand];
    case 'Binary':
      return [expression.lhs, expression.rhs];
    case 'Conditional':
      return [expression.condition, expression.then, expression.else_];
    case 'ForTuple': {
      const children: HclExpr[] = [expression.intro.collection, expression.value];
      if (expression.condition !== null) {
        children.push(expression.condition);
      }
      return children;
    }
    case 'ForObject': {
      const children: HclExpr[] = [expression.intro.collection, expression.key, expression.value];
      if (expression.condition !== null) {
        children.push(expression.condition);
      }
      return children;
    }
    case 'Tuple':
      return [...expression.elements];
    case 'Object': {
      const children: HclExpr[] = [];
      for (const entry of expression.entries) {
        const key = entry.key;
        if (key.kind === 'Paren') {
          children.push(key.inner);
        } else if (key.kind === 'Template') {
          for (const part of key.parts) {
            if (part.kind === 'Interpolation') {
              children.push(part.expression);
            } else if (part.kind === 'Directive') {
              const directive = part.directive;
              if (directive.kind === 'If') {
                children.push(directive.condition);
              } else if (directive.kind === 'For') {
                children.push(directive.intro.collection);
              }
            }
          }
        }
        children.push(entry.value);
      }
      return children;
    }
    case 'Paren':
      return [expression.inner];
  }
}

// ---------------------------------------------------------------------------
// Canonical decimal (expression.rs:737-851)
// ---------------------------------------------------------------------------

/**
 * Normalizes one decimal number spelling to its canonical form by pure
 * decimal string arithmetic — zero floating-point computation (hard
 * gate 1). Returns `null` for a grammar violation or an exponent that does
 * not fit the bounded representation (RFC 0014 §4.1, §6, §9).
 */
export function canonicalDecimal(spelling: string, maxDigits: number): string | null {
  let index = 0;
  while (index < spelling.length && spelling.charCodeAt(index) >= 0x30 && spelling.charCodeAt(index) <= 0x39) {
    index += 1;
  }
  const integerLen = index;
  if (integerLen === 0) {
    return null;
  }
  let fractionLen = 0;
  if (index < spelling.length && spelling.charCodeAt(index) === 0x2e) {
    index += 1;
    const fractionStart = index;
    while (index < spelling.length && spelling.charCodeAt(index) >= 0x30 && spelling.charCodeAt(index) <= 0x39) {
      index += 1;
    }
    fractionLen = index - fractionStart;
    if (fractionLen === 0) {
      return null;
    }
  }
  let exponent = 0;
  if (index < spelling.length && (spelling.charCodeAt(index) === 0x65 || spelling.charCodeAt(index) === 0x45)) {
    index += 1;
    let negative = false;
    if (index < spelling.length && (spelling.charCodeAt(index) === 0x2b || spelling.charCodeAt(index) === 0x2d)) {
      negative = spelling.charCodeAt(index) === 0x2d;
      index += 1;
    }
    const exponentStart = index;
    while (index < spelling.length && spelling.charCodeAt(index) >= 0x30 && spelling.charCodeAt(index) <= 0x39) {
      index += 1;
    }
    if (index === exponentStart) {
      return null;
    }
    const magnitude = Number(spelling.slice(exponentStart, index));
    if (!Number.isSafeInteger(magnitude)) {
      return null;
    }
    exponent = negative ? -magnitude : magnitude;
  }
  if (index !== spelling.length) {
    return null;
  }
  // The value is the concatenated digits with the decimal point after
  // `integerLen + exponent` digits.
  let digits = spelling.slice(0, integerLen);
  if (fractionLen > 0) {
    digits += spelling.slice(integerLen + 1, integerLen + 1 + fractionLen);
  }
  const stripped = digits.replace(/^0+/, '');
  const point = integerLen + exponent - (digits.length - stripped.length);
  if (stripped.length === 0) {
    return '0';
  }
  let out = '';
  if (point <= 0) {
    const zeros = -point;
    const trimmed = stripped.replace(/0+$/, '');
    if (zeros + trimmed.length + 1 > maxDigits) {
      return null;
    }
    out = '0.';
    for (let i = 0; i < zeros; i++) {
      out += '0';
    }
    out += stripped;
    while (out.length > 2 && out.endsWith('0')) {
      out = out.slice(0, -1);
    }
  } else {
    if (point >= stripped.length) {
      if (point > maxDigits) {
        return null;
      }
      out = stripped;
      for (let i = 0; i < point - stripped.length; i++) {
        out += '0';
      }
    } else {
      out = stripped.slice(0, point);
      const fraction = stripped.slice(point).replace(/0+$/, '');
      if (fraction.length > 0) {
        out += '.';
        out += fraction;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Literal-complete boundary (RFC 0014 §8.1; expression.rs:1531-1566)
// ---------------------------------------------------------------------------

/** Whether an expression is literal-complete (expression.rs:1531-1548). */
export function isLiteralComplete(expression: HclExpr): boolean {
  switch (expression.kind) {
    case 'Number':
    case 'Boolean':
    case 'Null':
      return true;
    case 'Template':
      return expression.parts.every(templatePartIsLiteral);
    case 'Tuple':
      return expression.elements.every(isLiteralComplete);
    case 'Object':
      return expression.entries.every(
        (entry) => isLiteralComplete(entry.value) && literalCompleteKey(entry.key),
      );
    case 'Unary':
      return expression.op === 'Minus' && expression.operand.kind === 'Number';
    case 'Paren':
      return isLiteralComplete(expression.inner);
    default:
      return false;
  }
}

function literalCompleteKey(key: HclObjectKey): boolean {
  switch (key.kind) {
    case 'Identifier':
    case 'Number':
      return true;
    case 'Template':
      return key.parts.every(templatePartIsLiteral);
    case 'Paren':
      return isLiteralComplete(key.inner);
  }
}

// ---------------------------------------------------------------------------
// Typed literal projection (expression.rs:1596-1712, 1723-1786)
// ---------------------------------------------------------------------------

/** Typed literal projection of a literal-complete expression (expression.rs:1723-1741). */
export type HclLiteralValue =
  | { readonly kind: 'Integer'; readonly canonical: string }
  | { readonly kind: 'Decimal'; readonly canonical: string }
  | { readonly kind: 'String'; readonly text: string }
  | { readonly kind: 'Boolean'; readonly value: boolean }
  | { readonly kind: 'Null' }
  | { readonly kind: 'Tuple'; readonly elements: readonly HclLiteralValue[] }
  | { readonly kind: 'Object'; readonly entries: readonly HclLiteralObjectEntry[] };

/** One ordered object literal entry (expression.rs:1744-1768). */
export interface HclLiteralObjectEntry {
  readonly key: HclLiteralKey;
  readonly value: HclLiteralValue;
}

/** One object-literal key (expression.rs:1777-1786). */
export type HclLiteralKey =
  | { readonly kind: 'Identifier'; readonly name: string }
  | { readonly kind: 'Number'; readonly canonical: string }
  | { readonly kind: 'String'; readonly text: string }
  | { readonly kind: 'Value'; readonly value: HclLiteralValue };

/**
 * Extracts the typed literal value of a literal-complete expression;
 * `null` for a derived expression (expression.rs:1596-1675; RFC 0014 §8.1).
 */
export function literalValue(expression: HclExpr): HclLiteralValue | null {
  switch (expression.kind) {
    case 'Number':
      return numberLiteral(expression.number.canonical);
    case 'Boolean':
      return { kind: 'Boolean', value: expression.value };
    case 'Null':
      return { kind: 'Null' };
    case 'Template': {
      let text = '';
      for (const part of expression.parts) {
        if (part.kind === 'Literal') {
          text += part.text;
        } else {
          return null;
        }
      }
      if (expression.heredoc !== null && expression.heredoc.mode === 'StripIndent') {
        text = stripHeredocIndentation(text);
      }
      return { kind: 'String', text };
    }
    case 'Tuple': {
      const elements: HclLiteralValue[] = [];
      for (const element of expression.elements) {
        const value = literalValue(element);
        if (value === null) {
          return null;
        }
        elements.push(value);
      }
      return { kind: 'Tuple', elements };
    }
    case 'Object': {
      const entries: HclLiteralObjectEntry[] = [];
      for (const entry of expression.entries) {
        const key = literalKey(entry.key);
        if (key === null) {
          return null;
        }
        const value = literalValue(entry.value);
        if (value === null) {
          return null;
        }
        entries.push({ key, value });
      }
      return { kind: 'Object', entries };
    }
    case 'Unary': {
      if (expression.op !== 'Minus' || expression.operand.kind !== 'Number') {
        return null;
      }
      const canonical = expression.operand.number.canonical;
      const value = canonical === '0' ? canonical : `-${canonical}`;
      return numberLiteral(value);
    }
    case 'Paren':
      return literalValue(expression.inner);
    default:
      return null;
  }
}

function numberLiteral(canonical: string): HclLiteralValue {
  return canonical.includes('.')
    ? { kind: 'Decimal', canonical }
    : { kind: 'Integer', canonical };
}

function literalKey(key: HclObjectKey): HclLiteralKey | null {
  switch (key.kind) {
    case 'Identifier':
      return { kind: 'Identifier', name: key.name };
    case 'Number':
      return { kind: 'Number', canonical: key.number.canonical };
    case 'Template': {
      let text = '';
      for (const part of key.parts) {
        if (part.kind === 'Literal') {
          text += part.text;
        } else {
          return null;
        }
      }
      return { kind: 'String', text };
    }
    case 'Paren': {
      const value = literalValue(key.inner);
      return value === null ? null : { kind: 'Value', value };
    }
  }
}

/**
 * Applies the `<<-` indentation stripping: removes the minimum number of
 * leading spaces from each line's leading literal text (expression.rs:
 * 1692-1712).
 */
export function stripHeredocIndentation(text: string): string {
  let minimum: number | null = null;
  for (const line of text.split('\n')) {
    if (line.length === 0) {
      continue;
    }
    let indent = 0;
    while (indent < line.length && line[indent] === ' ') {
      indent += 1;
    }
    minimum = minimum === null ? indent : Math.min(minimum, indent);
  }
  if (minimum === null) {
    return '';
  }
  const out: string[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (index > 0) {
      out.push('\n');
    }
    out.push(lines[index].slice(Math.min(minimum, lines[index].length)));
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// Structural equality (RFC 0014 §6) and the fingerprint (materialization.rs)
// ---------------------------------------------------------------------------

/** Structural equality: recursive over kind and children; never spans (RFC 0014 §6). */
export function expressionsEqual(left: HclExpr, right: HclExpr): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case 'Number':
      return left.number.canonical === (right as typeof left).number.canonical;
    case 'Boolean':
      return left.value === (right as typeof left).value;
    case 'Null':
      return true;
    case 'Template':
      return templatesEqual(left.parts, (right as typeof left).parts) && heredocsEqual(left.heredoc, (right as typeof left).heredoc);
    case 'FunctionCall':
      if (left.name !== (right as typeof left).name) {
        return false;
      }
      return argsEqual(left.args, (right as typeof left).args);
    case 'VariableRef':
      return left.name === (right as typeof left).name;
    case 'Traversal':
      return traversalsEqual(left, right as typeof left);
    case 'Unary':
      return (
        left.op === (right as typeof left).op &&
        expressionsEqual(left.operand, (right as typeof left).operand)
      );
    case 'Binary':
      return (
        left.op === (right as typeof left).op &&
        expressionsEqual(left.lhs, (right as typeof left).lhs) &&
        expressionsEqual(left.rhs, (right as typeof left).rhs)
      );
    case 'Conditional':
      return (
        expressionsEqual(left.condition, (right as typeof left).condition) &&
        expressionsEqual(left.then, (right as typeof left).then) &&
        expressionsEqual(left.else_, (right as typeof left).else_)
      );
    case 'ForTuple':
      return forTupleEqual(left, right as typeof left);
    case 'ForObject':
      return forObjectEqual(left, right as typeof left);
    case 'Tuple':
      return (
        left.elements.length === (right as typeof left).elements.length &&
        left.elements.every((element, index) => expressionsEqual(element, (right as typeof left).elements[index]))
      );
    case 'Object':
      return objectsEqual(left, right as typeof left);
    case 'Paren':
      return expressionsEqual(left.inner, (right as typeof left).inner);
  }
}

function templatesEqual(left: readonly HclTemplatePart[], right: readonly HclTemplatePart[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    const l = left[index];
    const r = right[index];
    if (l.kind !== r.kind) {
      return false;
    }
    if (l.kind === 'Literal') {
      if (l.text !== (r as { text: string }).text) {
        return false;
      }
    } else if (l.kind === 'Interpolation') {
      if (!expressionsEqual(l.expression, (r as { expression: HclExpr }).expression)) {
        return false;
      }
    } else {
      if (!directivesEqual(l.directive, (r as { directive: HclDirective }).directive)) {
        return false;
      }
    }
  }
  return true;
}

function directivesEqual(left: HclDirective, right: HclDirective): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case 'If':
      return expressionsEqual(left.condition, (right as { condition: HclExpr }).condition);
    case 'For':
      return forIntrosEqual(left.intro, (right as { intro: HclForIntro }).intro);
    case 'Else':
    case 'EndIf':
    case 'EndFor':
      return true;
  }
}

function forIntrosEqual(left: HclForIntro, right: HclForIntro): boolean {
  return (
    left.key === right.key &&
    left.value === right.value &&
    expressionsEqual(left.collection, right.collection)
  );
}

function forTupleEqual(left: HclExpr & { kind: 'ForTuple' }, right: HclExpr & { kind: 'ForTuple' }): boolean {
  return (
    forIntrosEqual(left.intro, right.intro) &&
    expressionsEqual(left.value, right.value) &&
    optionalExpressionsEqual(left.condition, right.condition)
  );
}

function forObjectEqual(left: HclExpr & { kind: 'ForObject' }, right: HclExpr & { kind: 'ForObject' }): boolean {
  return (
    forIntrosEqual(left.intro, right.intro) &&
    expressionsEqual(left.key, right.key) &&
    expressionsEqual(left.value, right.value) &&
    left.grouping === right.grouping &&
    optionalExpressionsEqual(left.condition, right.condition)
  );
}

function optionalExpressionsEqual(left: HclExpr | null, right: HclExpr | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return expressionsEqual(left, right);
}

function argsEqual(left: readonly HclCallArg[], right: readonly HclCallArg[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    if (left[index].expand !== right[index].expand) {
      return false;
    }
    if (!expressionsEqual(left[index].expression, right[index].expression)) {
      return false;
    }
  }
  return true;
}

function rootsEqual(left: HclTraversalRoot, right: HclTraversalRoot): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'Variable') {
    return left.name === (right as { name: string }).name;
  }
  if (left.kind === 'Boolean') {
    return left.value === (right as { value: boolean }).value;
  }
  return true;
}

function stepsEqual(left: readonly HclTraversalStep[], right: readonly HclTraversalStep[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    const l = left[index];
    const r = right[index];
    if (l.kind !== r.kind) {
      return false;
    }
    if (l.kind === 'GetAttr') {
      if (l.name !== (r as { name: string }).name) {
        return false;
      }
    } else if (l.kind === 'Index') {
      if (!expressionsEqual(l.key, (r as { key: HclExpr }).key)) {
        return false;
      }
    } else {
      if (!stepsEqual(l.steps, (r as { steps: readonly HclTraversalStep[] }).steps)) {
        return false;
      }
    }
  }
  return true;
}

function traversalsEqual(left: HclExpr & { kind: 'Traversal' }, right: HclExpr & { kind: 'Traversal' }): boolean {
  return rootsEqual(left.root, right.root) && stepsEqual(left.steps, right.steps);
}

function keysEqual(left: HclObjectKey, right: HclObjectKey): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case 'Identifier':
      return left.name === (right as { name: string }).name;
    case 'Number':
      return left.number.canonical === (right as { number: HclNumber }).number.canonical;
    case 'Template':
      return templatesEqual(left.parts, (right as { parts: readonly HclTemplatePart[] }).parts);
    case 'Paren':
      return expressionsEqual(left.inner, (right as { inner: HclExpr }).inner);
  }
}

function objectsEqual(left: HclExpr & { kind: 'Object' }, right: HclExpr & { kind: 'Object' }): boolean {
  if (left.entries.length !== right.entries.length) {
    return false;
  }
  for (let index = 0; index < left.entries.length; index++) {
    if (
      !keysEqual(left.entries[index].key, right.entries[index].key) ||
      !expressionsEqual(left.entries[index].value, right.entries[index].value)
    ) {
      return false;
    }
  }
  return true;
}

function heredocsEqual(left: HeredocFacts | null, right: HeredocFacts | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.mode === right.mode && left.marker === right.marker;
}

// ---------------------------------------------------------------------------
// Structural fingerprint (materialization.rs:1507-1768)
// ---------------------------------------------------------------------------

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

/** FNV-1a 64-bit over the canonical structural serialization (materialization.rs:1507-1516). */
export function expressionFingerprint(expression: HclExpr): bigint {
  const bytes = expressionStructureBytes(expression);
  let hash = FNV_OFFSET;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & 0xffffffffffffffffn;
  }
  return hash;
}

/** The 16-lowercase-hex-digit spelling of the fingerprint (materialization.rs:1518-1522). */
export function expressionFingerprintHex(expression: HclExpr): string {
  return expressionFingerprint(expression).toString(16).padStart(16, '0');
}

/** Appends one length-prefixed byte run (materialization.rs:1765-1768). */
function pushText(out: number[], text: string): void {
  const bytes = new TextEncoder().encode(text);
  const length = BigInt(bytes.length);
  for (let shift = 0; shift < 64; shift += 8) {
    out.push(Number((length >> BigInt(shift)) & 0xffn));
  }
  out.push(...bytes);
}

/** The canonical structural serialization of one expression (materialization.rs:1525-1667). */
function expressionStructureBytes(expression: HclExpr): number[] {
  const out: number[] = [];
  writeExpressionStructure(expression, out);
  return out;
}

function writeExpressionStructure(expression: HclExpr, out: number[]): void {
  switch (expression.kind) {
    case 'Number':
      out.push(0x4e); // 'N'
      pushText(out, expression.number.canonical);
      break;
    case 'Boolean':
      out.push(0x42); // 'B'
      out.push(expression.value ? 1 : 0);
      break;
    case 'Null':
      out.push(0x5a); // 'Z'
      break;
    case 'Template': {
      out.push(0x54); // 'T'
      const heredoc = expression.heredoc;
      if (heredoc !== null) {
        out.push(0x48); // 'H'
        pushText(out, heredocModeAsStr(heredoc.mode));
        pushText(out, heredoc.marker);
      } else {
        out.push(0x51); // 'Q'
      }
      for (const part of expression.parts) {
        if (part.kind === 'Literal') {
          out.push(0x4c); // 'L'
          pushText(out, part.text);
        } else if (part.kind === 'Interpolation') {
          out.push(0x49); // 'I'
          writeExpressionStructure(part.expression, out);
        } else {
          out.push(0x44); // 'D'
          writeDirectiveStructure(part.directive, out);
        }
      }
      break;
    }
    case 'FunctionCall': {
      out.push(0x46); // 'F'
      pushText(out, expression.name);
      for (const argument of expression.args) {
        out.push(argument.expand ? 0x58 : 0x78); // 'X' | 'x'
        writeExpressionStructure(argument.expression, out);
      }
      break;
    }
    case 'VariableRef': {
      out.push(0x56); // 'V'
      pushText(out, expression.name);
      break;
    }
    case 'Traversal': {
      out.push(0x52); // 'R'
      const root = expression.root;
      if (root.kind === 'Variable') {
        out.push(0x76); // 'v'
        pushText(out, root.name);
      } else if (root.kind === 'Boolean') {
        out.push(0x62); // 'b'
        out.push(root.value ? 1 : 0);
      } else {
        out.push(0x6e); // 'n'
      }
      for (const step of expression.steps) {
        writeTraversalStep(step, out);
      }
      break;
    }
    case 'Unary': {
      out.push(0x55); // 'U'
      pushText(out, unaryOpAsStr(expression.op));
      writeExpressionStructure(expression.operand, out);
      break;
    }
    case 'Binary': {
      out.push(0x57); // 'W'
      pushText(out, binaryOpAsStr(expression.op));
      writeExpressionStructure(expression.lhs, out);
      writeExpressionStructure(expression.rhs, out);
      break;
    }
    case 'Conditional': {
      out.push(0x43); // 'C'
      writeExpressionStructure(expression.condition, out);
      writeExpressionStructure(expression.then, out);
      writeExpressionStructure(expression.else_, out);
      break;
    }
    case 'ForTuple': {
      out.push(0x50); // 'P'
      writeForIntro(expression.intro, out);
      writeExpressionStructure(expression.value, out);
      if (expression.condition !== null) {
        out.push(0x63); // 'c'
        writeExpressionStructure(expression.condition, out);
      } else {
        out.push(0x6e); // 'n'
      }
      break;
    }
    case 'ForObject': {
      out.push(0x4f); // 'O'
      writeForIntro(expression.intro, out);
      writeExpressionStructure(expression.key, out);
      writeExpressionStructure(expression.value, out);
      out.push(expression.grouping ? 0x67 : 0x6e); // 'g' | 'n'
      if (expression.condition !== null) {
        out.push(0x63); // 'c'
        writeExpressionStructure(expression.condition, out);
      } else {
        out.push(0x6e); // 'n'
      }
      break;
    }
    case 'Tuple': {
      out.push(0x4c); // 'L'
      for (const element of expression.elements) {
        writeExpressionStructure(element, out);
      }
      break;
    }
    case 'Object': {
      out.push(0x4d); // 'M'
      for (const entry of expression.entries) {
        writeObjectKeyStructure(entry.key, out);
        writeExpressionStructure(entry.value, out);
      }
      break;
    }
    case 'Paren': {
      out.push(0x28); // '('
      writeExpressionStructure(expression.inner, out);
      break;
    }
  }
}

function writeDirectiveStructure(directive: HclDirective, out: number[]): void {
  switch (directive.kind) {
    case 'If': {
      out.push(0x66); // 'f'
      writeExpressionStructure(directive.condition, out);
      break;
    }
    case 'Else':
      out.push(0x65); // 'e'
      break;
    case 'EndIf':
      out.push(0x45); // 'E'
      break;
    case 'For': {
      out.push(0x6f); // 'o'
      writeForIntro(directive.intro, out);
      break;
    }
    case 'EndFor':
      out.push(0x67); // 'g'
      break;
  }
}

function writeForIntro(intro: HclForIntro, out: number[]): void {
  if (intro.key !== null) {
    out.push(0x6b); // 'k'
    pushText(out, intro.key);
  } else {
    out.push(0x6e); // 'n'
  }
  pushText(out, intro.value);
  writeExpressionStructure(intro.collection, out);
}

function writeTraversalStep(step: HclTraversalStep, out: number[]): void {
  switch (step.kind) {
    case 'GetAttr': {
      out.push(0x61); // 'a'
      pushText(out, step.name);
      break;
    }
    case 'Index': {
      out.push(0x69); // 'i'
      writeExpressionStructure(step.key, out);
      break;
    }
    case 'AttrSplat': {
      out.push(0x73); // 's'
      for (const inner of step.steps) {
        writeTraversalStep(inner, out);
      }
      break;
    }
    case 'FullSplat': {
      out.push(0x53); // 'S'
      for (const inner of step.steps) {
        writeTraversalStep(inner, out);
      }
      break;
    }
  }
}

function writeObjectKeyStructure(key: HclObjectKey, out: number[]): void {
  switch (key.kind) {
    case 'Identifier': {
      out.push(0x4b); // 'K'
      pushText(out, key.name);
      break;
    }
    case 'Number': {
      out.push(0x6b); // 'k'
      pushText(out, key.number.canonical);
      break;
    }
    case 'Template': {
      out.push(0x74); // 't'
      for (const part of key.parts) {
        if (part.kind === 'Literal') {
          out.push(0x6c); // 'l'
          pushText(out, part.text);
        } else if (part.kind === 'Interpolation') {
          out.push(0x69); // 'i'
          writeExpressionStructure(part.expression, out);
        } else {
          out.push(0x64); // 'd'
          writeDirectiveStructure(part.directive, out);
        }
      }
      break;
    }
    case 'Paren': {
      out.push(0x70); // 'p'
      writeExpressionStructure(key.inner, out);
      break;
    }
  }
}
