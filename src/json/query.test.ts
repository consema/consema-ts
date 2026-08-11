/**
 * Intent documents for JSON native and lossless-syntax query execution.
 *
 * Golden transcriptions from the shared vectors — each test cites its
 * case id:
 *  - conformance/vectors/json-family-v2.json: json5.query.syntax-v2-
 *    identifier (:114-118), json5.query.native-v2-binary (:120-124)
 *  - conformance/vectors/v1.json: query.json-duplicate-order (:77-81),
 *    query.root-result-limit (:143-147)
 *  - domain gating and the v2 extended kinds: RFC 0005 §7 (:151-173);
 *    crates/consema-json/src/query.rs:96-105
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parse,
  executeJsonQuery,
  executeJsonSyntaxQuery,
  QueryLimits,
  CancellationToken,
  QueryExecutionFailure,
} from '../json/index.ts';
import type { JsonMatch } from '../json/index.ts';
import { PROFILE_JSON5_STANDARD, PROFILE_JSON_STRICT } from '../json/index.ts';
import { DEFAULT_PARSE_LIMITS } from '../document/formation.ts';
import {
  domainJSONNativeV1,
  domainJSONNativeV2,
  domainJSONLosslessSyntaxV1,
  domainJSONLosslessSyntaxV2,
  newOperatorCall,
  newQueryDefinition,
  validateQuery,
  bindQuery,
  withArgument,
  withExpression,
} from '../protocol/query.ts';
import { CapabilitySet } from '../protocol/registry_descriptor.ts';
import { stringValue } from '../core/value.ts';
import type { QueryExpression } from '../protocol/query.ts';

function bytes(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

function capabilities(): CapabilitySet {
  const set = new CapabilitySet();
  set.insert({ namespace: 'core.query.ordered-results', version: 1 });
  return set;
}

function executable(domain: { id: string; version: number }, expression: QueryExpression) {
  const definition = withExpression(newQueryDefinition(domain), expression);
  const validated = validateQuery(definition);
  assert.ok('query' in validated, 'query must validate');
  const bound = bindQuery(validated.query, capabilities());
  assert.ok('query' in bound, 'query must bind');
  return bound.query;
}

test('json5.query.syntax-v2-identifier: Identifier pieces in source order (json-family-v2.json:114-118)', () => {
  const document = parse(bytes('{key:1,true:2}'), PROFILE_JSON5_STANDARD, DEFAULT_PARSE_LIMITS);
  const query = executable(domainJSONLosslessSyntaxV2(), {
    kind: 'Apply',
    input: { kind: 'Input' },
    operator: withArgument(newOperatorCall('json.syntax-kind-is', 1), 'kind', stringValue('Identifier')),
  });
  const result = executeJsonSyntaxQuery(query, document, QueryLimits.defaults(), new CancellationToken());
  assert.equal(result.terminal(), 'Completed');
  assert.equal(result.matches().length, 2);
  const source = document.source().bytes();
  const texts = result.matches().map((match) => {
    const span = match.span();
    return new TextDecoder().decode(source.slice(span.startByte(), span.endByte()));
  });
  assert.deepEqual(texts, ['key', 'true']);
  assert.ok(result.matches()[0].ordinal() < result.matches()[1].ordinal());
});

test('json5.query.syntax-v2-identifier: domain v1 rejects the Identifier kind and JSON5 documents (json-family-v2.json:117)', () => {
  const document = parse(bytes('{key:1,true:2}'), PROFILE_JSON5_STANDARD, DEFAULT_PARSE_LIMITS);
  const v1 = executable(domainJSONLosslessSyntaxV1(), { kind: 'Input' });
  assert.throws(
    () => executeJsonSyntaxQuery(v1, document, QueryLimits.defaults(), new CancellationToken()),
    (error: unknown) => {
      assert.ok(error instanceof QueryExecutionFailure);
      assert.equal(error.kind, 'DomainMismatch');
      assert.equal(error.code, 'core.query.domain-mismatch@1');
      return true;
    },
  );
  // The v1 vocabulary also rejects the Identifier kind at validation time
  // (typescript/src/protocol/query.ts:1066-1088).
  const rejected = validateQuery(
    withExpression(newQueryDefinition(domainJSONLosslessSyntaxV1()), {
      kind: 'Apply',
      input: { kind: 'Input' },
      operator: withArgument(newOperatorCall('json.syntax-kind-is', 1), 'kind', stringValue('Identifier')),
    }),
  );
  assert.ok('failure' in rejected);
});

test('json5.query.native-v2-binary: BinaryFloat64 native kind (json-family-v2.json:120-124)', () => {
  const document = parse(bytes('-Infinity'), PROFILE_JSON5_STANDARD, DEFAULT_PARSE_LIMITS);
  const query = executable(domainJSONNativeV2(), { kind: 'Input' });
  const result = executeJsonQuery(query, document, QueryLimits.defaults(), new CancellationToken());
  assert.equal(result.matches().length, 1);
  const match = result.matches()[0];
  if (match.kind !== 'Value') {
    throw new Error('expected a Value match');
  }
  assert.equal(match.valueKind, 'BinaryFloat64');
  assert.throws(
    () =>
      executeJsonQuery(
        executable(domainJSONNativeV1(), { kind: 'Input' }),
        document,
        QueryLimits.defaults(),
        new CancellationToken(),
      ),
    (error: unknown) => {
      assert.ok(error instanceof QueryExecutionFailure);
      assert.equal(error.kind, 'DomainMismatch');
      return true;
    },
  );
});

test('query.json-duplicate-order: duplicate members keep source order and identity (v1.json:77-81)', () => {
  const document = parse(bytes('{"a":1,"a":2,"b":3}'), PROFILE_JSON_STRICT, DEFAULT_PARSE_LIMITS);
  const query = executable(domainJSONNativeV1(), {
    kind: 'Apply',
    input: {
      kind: 'Apply',
      input: { kind: 'Input' },
      operator: newOperatorCall('json.try-object-members', 1),
    },
    operator: withArgument(newOperatorCall('json.member-name-equals', 1), 'name', stringValue('a')),
  });
  const result = executeJsonQuery(query, document, QueryLimits.defaults(), new CancellationToken());
  assert.equal(result.terminal(), 'Completed');
  const members = result.matches().filter(
    (match): match is Extract<JsonMatch, { kind: 'ObjectMember' }> => match.kind === 'ObjectMember',
  );
  assert.equal(members.length, 2);
  assert.deepEqual(
    members.map((member) => member.ordinal),
    [0, 1],
  );
  assert.ok(!members[0].member.equals(members[1].member));
});

test('query.root-result-limit: the root is the first standard result and may not bypass max_results (v1.json:143-147)', () => {
  const document = parse(bytes('{"a":1}'), PROFILE_JSON_STRICT, DEFAULT_PARSE_LIMITS);
  const query = executable(domainJSONNativeV1(), { kind: 'Input' });
  assert.throws(
    () => executeJsonQuery(query, document, new QueryLimits(100_000, 0), new CancellationToken()),
    (error: unknown) => {
      assert.ok(error instanceof QueryExecutionFailure);
      assert.equal(error.kind, 'ResourceLimitExceeded');
      assert.equal(error.code, 'core.query.resource-limit@1');
      return true;
    },
  );
});

test('query.cancellation fails without a completed result (query.rs:203-213)', () => {
  const document = parse(bytes('[1,2,3]'), PROFILE_JSON_STRICT, DEFAULT_PARSE_LIMITS);
  const query = executable(domainJSONNativeV1(), {
    kind: 'Apply',
    input: { kind: 'Input' },
    operator: newOperatorCall('json.try-array-elements', 1),
  });
  const cancellation = new CancellationToken();
  cancellation.cancel();
  assert.throws(
    () => executeJsonQuery(query, document, QueryLimits.defaults(), cancellation),
    (error: unknown) => {
      assert.ok(error instanceof QueryExecutionFailure);
      assert.equal(error.kind, 'Cancelled');
      assert.equal(error.code, 'core.query.cancelled@1');
      return true;
    },
  );
});
