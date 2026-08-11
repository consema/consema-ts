/**
 * Intent documents for YAML native and lossless-syntax query execution.
 *
 * Golden transcriptions from the shared vectors — each test cites its
 * case id in conformance/vectors/yaml-v1.json:
 *  - query.mapping-entries (:51-54), query.alias-target (:56-59),
 *    query.syntax-comments (:61-64), query.resource-limit (:66-69)
 * Domain gating: crates/consema-yaml/src/query.rs:173-177, :220-224.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parse,
  executeYamlQuery,
  executeYamlSyntaxQuery,
  matchNodeRef,
  QueryLimits,
  CancellationToken,
  QueryExecutionFailure,
} from './index.ts';
import { PROFILE_YAML12_CORE } from './index.ts';
import { DEFAULT_PARSE_LIMITS } from '../document/formation.ts';
import {
  domainYAMLNativeV1,
  domainYAMLLosslessSyntaxV1,
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

function apply(id: string, expression: QueryExpression): QueryExpression {
  return { kind: 'Apply', input: expression, operator: newOperatorCall(id, 1) };
}

test('query.mapping-entries — entries in source order (yaml-v1.json:51-54)', () => {
  const document = parse(bytes('{a: 1, b: 2}\n'), PROFILE_YAML12_CORE, DEFAULT_PARSE_LIMITS);
  const query = executable(
    domainYAMLNativeV1(),
    apply(
      'yaml.try-mapping-entries',
      apply('yaml.document-root', apply('yaml.documents', { kind: 'Input' })),
    ),
  );
  const result = executeYamlQuery(query, document, QueryLimits.defaults(), new CancellationToken());
  assert.equal(result.terminal(), 'Completed');
  assert.deepEqual(
    result.matches().map((match) => matchNodeRef(match).role()),
    ['YamlMappingEntry', 'YamlMappingEntry'],
  );
});

test('query.alias-target — the alias resolves to the anchored node (yaml-v1.json:56-59)', () => {
  const document = parse(bytes('[&x {k: v}, *x]\n'), PROFILE_YAML12_CORE, DEFAULT_PARSE_LIMITS);
  const query = executable(
    domainYAMLNativeV1(),
    apply('yaml.alias-target', apply('yaml.alias-occurrences', { kind: 'Input' })),
  );
  const result = executeYamlQuery(query, document, QueryLimits.defaults(), new CancellationToken());
  assert.equal(result.matches().length, 1);
  assert.equal(matchNodeRef(result.matches()[0]).role(), 'YamlNode');
  const anchored = document.document(0)!.root().sequenceItem(0)!.node();
  assert.equal(matchNodeRef(result.matches()[0]).equals(anchored.nodeRef()), true);
});

test('query.syntax-comments — comment ordinals in source order (yaml-v1.json:61-64)', () => {
  const document = parse(bytes('a: 1 # first\nb: 2 # second\n'), PROFILE_YAML12_CORE, DEFAULT_PARSE_LIMITS);
  const operator = withArgument(
    newOperatorCall('yaml.syntax-kind-is', 1),
    'kind',
    stringValue('Comment'),
  );
  const query = executable(domainYAMLLosslessSyntaxV1(), {
    kind: 'Apply',
    input: { kind: 'Input' },
    operator,
  });
  const result = executeYamlSyntaxQuery(query, document, QueryLimits.defaults(), new CancellationToken());
  assert.deepEqual(
    result.matches().map((match) => match.ordinal()),
    [5, 12],
  );
});

test('query.resource-limit — max_results is enforced without a completed prefix (yaml-v1.json:66-69)', () => {
  const document = parse(bytes('[a, b, c]\n'), PROFILE_YAML12_CORE, DEFAULT_PARSE_LIMITS);
  const query = executable(
    domainYAMLNativeV1(),
    apply(
      'yaml.try-sequence-elements',
      apply('yaml.document-root', apply('yaml.documents', { kind: 'Input' })),
    ),
  );
  assert.throws(
    () =>
      executeYamlQuery(
        query,
        document,
        new QueryLimits(100_000, 2),
        new CancellationToken(),
      ),
    (error: unknown) => {
      assert.ok(error instanceof QueryExecutionFailure);
      assert.equal(error.kind, 'ResourceLimitExceeded');
      assert.equal(error.code, 'core.query.resource-limit@1');
      return true;
    },
  );
});

test('domain gate — wrong domains are rejected before execution (query.rs:173-177)', () => {
  const document = parse(bytes('a: 1\n'), PROFILE_YAML12_CORE, DEFAULT_PARSE_LIMITS);
  assert.throws(
    () =>
      executeYamlQuery(
        executable(domainYAMLLosslessSyntaxV1(), { kind: 'Input' }),
        document,
        QueryLimits.defaults(),
        new CancellationToken(),
      ),
    (error: unknown) => {
      assert.ok(error instanceof QueryExecutionFailure);
      assert.equal(error.kind, 'DomainMismatch');
      assert.equal(error.code, 'core.query.domain-mismatch@1');
      return true;
    },
  );
});
