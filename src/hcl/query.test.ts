/**
 * HCL query intent tests — golden transcriptions from the shared vector
 * suite (RFC 0014 §7).
 *
 * Blind-written intent documents (docs/multi-language-implementation
 * -plan.md §3); no gate is claimed before the §7 START GATE.
 *
 * Golden cases cited: hcl-v1.json case ids are named in each test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateQuery,
  bindQuery,
  newQueryDefinition,
  newOperatorCall,
  withArgument,
  withExpression,
  withSelection,
} from '../protocol/query.ts';
import type { QueryExpression } from '../protocol/query.ts';
import { stringValue } from '../core/value.ts';
import { expressionKindNameAsStr, isLiteralComplete } from './expression.ts';
import {
  executeHclNativeQuery,
  executeHclSyntaxQuery,
  HclQueryExecutionFailure,
  DEFAULT_HCL_QUERY_LIMITS,
  HclCancellationToken,
  hclQueryRequiredCapabilities,
} from './query.ts';
import type { HclMatch, HclSyntaxMatch } from './query.ts';
import { parseHcl, profileDefaultEncoding } from './document.ts';
import type { HclDocument } from './document.ts';
import { HclProfile, hclNativeQueryDomain, hclLosslessSyntaxQueryDomain } from './profile.ts';
import { hclParseLimits } from './limits.ts';
import { expressionKindOf } from './expression.ts';

function parse(text: string, profile: HclProfile = HclProfile.NATIVE_V1): HclDocument {
  return parseHcl(new TextEncoder().encode(text), profile, profileDefaultEncoding(), hclParseLimits());
}

interface Filter {
  readonly operator: string;
  readonly argument?: string;
}

/** The frozen argument name of one operator (hcl_v1.rs:586-606). */
function argumentNameFor(id: string): string {
  switch (id) {
    case 'hcl.attribute-name-equals':
      return 'name';
    case 'hcl.attribute-literal-value':
      return 'accessor';
    case 'hcl.body-block-type-equals':
    case 'hcl.block-type-equals':
      return 'type';
    case 'hcl.block-label-equals':
      return 'label';
    case 'hcl.expression-kind-is':
    case 'hcl.syntax-kind-is':
      return 'kind';
    case 'hcl.syntax-text-equals':
      return 'text';
    default:
      return 'argument';
  }
}

function buildExpression(filters: readonly Filter[]): QueryExpression {
  let expression: QueryExpression = { kind: 'Input' };
  for (const filter of filters) {
    const at = filter.operator.lastIndexOf('@');
    const id = filter.operator.slice(0, at);
    const version = Number(filter.operator.slice(at + 1));
    let operator = newOperatorCall(id, version);
    if (filter.argument !== undefined) {
      operator = withArgument(operator, argumentNameFor(id), stringValue(filter.argument));
    }
    expression = { kind: 'Apply', input: expression, operator };
  }
  return expression;
}

function runNative(document: HclDocument, filters: readonly Filter[]): readonly HclMatch[] {
  const definition = withSelection(
    withExpression(newQueryDefinition(hclNativeQueryDomain()), buildExpression(filters)),
    'All',
  );
  const validated = validateQuery(definition);
  assert.ok('query' in validated, `query validation failed: ${JSON.stringify(validated)}`);
  const bound = bindQuery(validated.query, hclQueryRequiredCapabilities());
  assert.ok('query' in bound, 'query binding failed');
  return executeHclNativeQuery(
    bound.query,
    document,
    DEFAULT_HCL_QUERY_LIMITS,
    new HclCancellationToken(),
  ).matches;
}

function runSyntax(document: HclDocument, filters: readonly Filter[]): readonly HclSyntaxMatch[] {
  const definition = withSelection(
    withExpression(newQueryDefinition(hclLosslessSyntaxQueryDomain()), buildExpression(filters)),
    'All',
  );
  const validated = validateQuery(definition);
  assert.ok('query' in validated, 'query validation failed');
  const bound = bindQuery(validated.query, hclQueryRequiredCapabilities());
  assert.ok('query' in bound, 'query binding failed');
  return executeHclSyntaxQuery(
    bound.query,
    document,
    DEFAULT_HCL_QUERY_LIMITS,
    new HclCancellationToken(),
  ).matches;
}

/** Expression facts of one expression match: kind name, exact text, literal predicate. */
function expressionFacts(document: HclDocument, match: HclMatch): { kind: string; text: string; literal: boolean } {
  assert.equal(match.kind, 'Expression');
  const expression = document.expression(match.node);
  return {
    kind: expressionKindNameAsStr(expressionKindOf(expression.node())),
    text: expression.text(),
    literal: isLiteralComplete(expression.node()),
  };
}

// ---------------------------------------------------------------------------
// Golden transcriptions (hcl.query@1)
// ---------------------------------------------------------------------------

test('golden hcl.query.native-body-walk: the attribute chain yields kind/text/literal facts', () => {
  // conformance/vectors/hcl-v1.json:566-608 (id hcl.query.native-body-walk;
  // domain hcl.native-semantic-query@1; expected terminal Completed, one
  // match {kind number, text "3", literal true}).
  const document = parse('region = "us-east-1"\nserver "web" {\n  port = 8080\n}\ncount = 3\n');
  const matches = runNative(document, [
    { operator: 'hcl.document-body@1' },
    { operator: 'hcl.body-attributes@1' },
    { operator: 'hcl.attribute-name-equals@1', argument: 'count' },
    { operator: 'hcl.attribute-expression@1' },
    { operator: 'hcl.expression-is-literal@1' },
    { operator: 'hcl.expression-kind-is@1', argument: 'number' },
    { operator: 'hcl.expression-text@1' },
  ]);
  assert.equal(matches.length, 1);
  const facts = expressionFacts(document, matches[0]);
  assert.equal(facts.kind, 'number');
  assert.equal(facts.text, '3');
  assert.equal(facts.literal, true);
});

test('golden hcl.query.blocks-and-labels: label and nested-body chains', () => {
  // conformance/vectors/hcl-v1.json:610-688 (id hcl.query.blocks-and-labels;
  // label_matches [{text "web", quoted true}], nested_matches
  // [{kind number, text "8080"}]).
  const document = parse('region = "us-east-1"\nserver "web" {\n  port = 8080\n}\ncount = 3\n');
  const labelMatches = runNative(document, [
    { operator: 'hcl.document-body@1' },
    { operator: 'hcl.body-blocks@1' },
    { operator: 'hcl.block-type-equals@1', argument: 'server' },
    { operator: 'hcl.block-labels@1' },
    { operator: 'hcl.block-label-equals@1', argument: 'web' },
  ]);
  assert.equal(labelMatches.length, 1);
  assert.equal(labelMatches[0].kind, 'BlockLabel');
  if (labelMatches[0].kind === 'BlockLabel') {
    const label = document.blockLabel(labelMatches[0].node);
    assert.equal(label.text(), 'web');
    assert.equal(label.quoted(), true);
  }
  const nested = runNative(document, [
    { operator: 'hcl.document-body@1' },
    { operator: 'hcl.body-blocks@1' },
    { operator: 'hcl.block-type-equals@1', argument: 'server' },
    { operator: 'hcl.block-nested-body@1' },
    { operator: 'hcl.body-attributes@1' },
    { operator: 'hcl.attribute-name-equals@1', argument: 'port' },
    { operator: 'hcl.attribute-expression@1' },
    { operator: 'hcl.expression-text@1' },
  ]);
  assert.equal(nested.length, 1);
  const facts = expressionFacts(document, nested[0]);
  assert.equal(facts.kind, 'number');
  assert.equal(facts.text, '8080');
});

test('golden hcl.query.literal-accessors: typed accessors validate before returning', () => {
  // conformance/vectors/hcl-v1.json:690-812 (id hcl.query.literal-accessors;
  // as-integer on 42 completes, as-integer on "x" fails with
  // hcl.query.type-mismatch@1, as-string on var.name fails with
  // hcl.query.non-literal@1, as-boolean-is on true completes).
  const integer = runNative(parse('count = 42\n'), [
    { operator: 'hcl.document-body@1' },
    { operator: 'hcl.body-attributes@1' },
    { operator: 'hcl.attribute-name-equals@1', argument: 'count' },
    { operator: 'hcl.attribute-expression@1' },
    { operator: 'hcl.attribute-literal-value@1', argument: 'as-integer' },
  ]);
  assert.equal(integer.length, 1);
  const boolean = runNative(parse('enabled = true\n'), [
    { operator: 'hcl.document-body@1' },
    { operator: 'hcl.body-attributes@1' },
    { operator: 'hcl.attribute-name-equals@1', argument: 'enabled' },
    { operator: 'hcl.attribute-expression@1' },
    { operator: 'hcl.attribute-literal-value@1', argument: 'as-boolean-is' },
  ]);
  assert.equal(boolean.length, 1);
  const typeMismatch = () =>
    runNative(parse('name = "x"\n'), [
      { operator: 'hcl.document-body@1' },
      { operator: 'hcl.body-attributes@1' },
      { operator: 'hcl.attribute-name-equals@1', argument: 'name' },
      { operator: 'hcl.attribute-expression@1' },
      { operator: 'hcl.attribute-literal-value@1', argument: 'as-integer' },
    ]);
  assert.throws(typeMismatch, (error: unknown) => {
    return error instanceof HclQueryExecutionFailure && error.code === 'hcl.query.type-mismatch@1';
  });
  const nonLiteral = () =>
    runNative(parse('name = var.name\n'), [
      { operator: 'hcl.document-body@1' },
      { operator: 'hcl.body-attributes@1' },
      { operator: 'hcl.attribute-name-equals@1', argument: 'name' },
      { operator: 'hcl.attribute-expression@1' },
      { operator: 'hcl.attribute-literal-value@1', argument: 'as-string' },
    ]);
  assert.throws(nonLiteral, (error: unknown) => {
    return error instanceof HclQueryExecutionFailure && error.code === 'hcl.query.non-literal@1';
  });
});

test('golden hcl.query.lossless-kind-filter: syntax pieces carry kind, text, and ordinal', () => {
  // conformance/vectors/hcl-v1.json:814-861 (id hcl.query.lossless-kind-
  // filter; domain hcl.lossless-syntax-query@1; the LineComment piece is
  // "# c" at ordinal 0, the StringContent piece is "us-east-1" at ordinal 7).
  const document = parse('# c\nregion = "us-east-1"\n');
  const comments = runSyntax(document, [{ operator: 'hcl.syntax-kind-is@1', argument: 'LineComment' }]);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].kind(), 'LineComment');
  assert.equal(comments[0].ordinal(), 0);
  const decoded = document.source().decodedText()!;
  const span = comments[0].span();
  const text = decoded.slice(
    document.source().decodedPosition(span.startByte()).utf16CodeUnitOffset,
    document.source().decodedPosition(span.endByte()).utf16CodeUnitOffset,
  );
  assert.equal(text, '# c');
  const contents = runSyntax(document, [{ operator: 'hcl.syntax-kind-is@1', argument: 'StringContent' }]);
  assert.equal(contents.length, 1);
  assert.equal(contents[0].kind(), 'StringContent');
  assert.equal(contents[0].ordinal(), 7);
  const contentSpan = contents[0].span();
  assert.equal(
    decoded.slice(
      document.source().decodedPosition(contentSpan.startByte()).utf16CodeUnitOffset,
      document.source().decodedPosition(contentSpan.endByte()).utf16CodeUnitOffset,
    ),
    'us-east-1',
  );
});

test('golden hcl.query.error-regions: a Recovered document exposes its ordered error regions', () => {
  // conformance/vectors/hcl-v1.json:863-887 (id hcl.query.error-regions;
  // expected one region {code hcl.parse.block@1, position 0}).
  const document = parse('a = 1\nb {\n');
  assert.equal(document.formationStatus(), 'Recovered');
  const matches = runNative(document, [
    { operator: 'hcl.document-body@1' },
    { operator: 'hcl.error-regions@1' },
  ]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].kind, 'ErrorRegion');
  if (matches[0].kind === 'ErrorRegion') {
    assert.equal(matches[0].code, 'hcl.parse.block@1');
    assert.equal(matches[0].position, 0);
  }
});
