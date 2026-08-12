/**
 * TOML native and lossless-syntax query intent tests.
 *
 * These are blind-written intent documents (docs/multi-language-implementation
 * -plan.md §3): they transcribe the language-neutral facts from
 * conformance/vectors/toml-v1.json and crates/consema-toml/src/query.rs
 * and run once the toolchain is ready. Golden cases cited: toml-v1.json
 * case ids are named in each test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  newQueryDefinition,
  withExpression,
  withSelection,
  newOperatorCall,
  withArgument,
  validateQuery,
  bindQuery,
} from '../protocol/query.ts';
import type { QueryExpression } from '../protocol/query.ts';
import { stringValue, integerValue } from '../core/value.ts';
import { DEFAULT_PARSE_LIMITS } from '../document/formation.ts';
import { parseToml } from './document.ts';
import { TomlProfile, tomlNativeQueryDomain, tomlLosslessSyntaxQueryDomain } from './profile.ts';
import {
  executeTomlQuery,
  executeTomlSyntaxQuery,
  DEFAULT_TOML_QUERY_LIMITS,
  TomlCancellationToken,
  tomlQueryRequiredCapabilities,
  TomlQueryExecutionFailure,
} from './query.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../../conformance/fixtures/toml');

function parseFixture(name: string) {
  return parseToml(readFileSync(resolve(FIXTURES, name)), TomlProfile.TOML_10_V1, DEFAULT_PARSE_LIMITS);
}

function parseSource(source: string) {
  return parseToml(new TextEncoder().encode(source), TomlProfile.TOML_10_V1, DEFAULT_PARSE_LIMITS);
}

/** Builds, validates, and binds one query; a validation failure fails the test. */
function executable(expression: QueryExpression, selection: 'All' | 'First' | 'Last' | 'ZeroOrOne' | 'RequireOne' = 'All') {
  const definition = withSelection(withExpression(newQueryDefinition(tomlNativeQueryDomain()), expression), selection);
  const validated = validateQuery(definition);
  assert.ok(!('failure' in validated), 'query definition validates');
  const bound = bindQuery(validated.query, tomlQueryRequiredCapabilities());
  assert.ok(!('failure' in bound), 'query binds');
  return bound.query;
}

function syntaxExecutable(expression: QueryExpression, selection: 'All' | 'First' | 'Last' | 'ZeroOrOne' | 'RequireOne' = 'All') {
  const definition = withSelection(
    withExpression(newQueryDefinition(tomlLosslessSyntaxQueryDomain()), expression),
    selection,
  );
  const validated = validateQuery(definition);
  assert.ok(!('failure' in validated), 'syntax query definition validates');
  const bound = bindQuery(validated.query, tomlQueryRequiredCapabilities());
  assert.ok(!('failure' in bound), 'syntax query binds');
  return bound.query;
}

test('golden toml.query.nested-entry-order: service entries keep source order', () => {
  // conformance/vectors/toml-v1.json:41-46 (path ["service"], expected
  // names ["name", "environment", "listen"]).
  const document = parseFixture('application.toml');
  const expression: QueryExpression = {
    kind: 'Apply',
    input: {
      kind: 'Apply',
      input: {
        kind: 'Apply',
        input: {
          kind: 'Apply',
          input: { kind: 'Input' },
          operator: newOperatorCall('toml.try-table-entries', 1),
        },
        operator: withArgument(
          newOperatorCall('toml.entry-name-equals', 1),
          'name',
          stringValue('service'),
        ),
      },
      operator: newOperatorCall('toml.entry-item', 1),
    },
    operator: newOperatorCall('toml.try-table-entries', 1),
  };
  const result = executeTomlQuery(
    executable(expression),
    document,
    DEFAULT_TOML_QUERY_LIMITS,
    new TomlCancellationToken(),
  );
  const names = result.matches.map((match) => {
    assert.equal(match.kind, 'Entry');
    return match.kind === 'Entry' ? match.name : '';
  });
  assert.deepEqual(names, ['name', 'environment', 'listen']);
});

test('golden toml.query.aot-element-order: upstreams elements have ordinals [0, 1]', () => {
  // conformance/vectors/toml-v1.json:47-52 (expected ordinals [0, 1]).
  const document = parseFixture('application.toml');
  const expression: QueryExpression = {
    kind: 'Apply',
    input: {
      kind: 'Apply',
      input: {
        kind: 'Apply',
        input: {
          kind: 'Apply',
          input: { kind: 'Input' },
          operator: newOperatorCall('toml.try-table-entries', 1),
        },
        operator: withArgument(
          newOperatorCall('toml.entry-name-equals', 1),
          'name',
          stringValue('upstreams'),
        ),
      },
      operator: newOperatorCall('toml.entry-item', 1),
    },
    operator: newOperatorCall('toml.try-array-elements', 1),
  };
  const result = executeTomlQuery(
    executable(expression),
    document,
    DEFAULT_TOML_QUERY_LIMITS,
    new TomlCancellationToken(),
  );
  const ordinals = result.matches.map((match) => {
    assert.equal(match.kind, 'ArrayElement');
    return match.kind === 'ArrayElement' ? match.ordinal : -1;
  });
  assert.deepEqual(ordinals, [0, 1]);
});

test('array-element-item and core.take compose with Last selection', () => {
  const document = parseSource('values = [1, 2, 3]\n');
  const expression: QueryExpression = {
    kind: 'Apply',
    input: {
      kind: 'Apply',
      input: {
        kind: 'Apply',
        input: {
          kind: 'Apply',
          input: { kind: 'Input' },
          operator: newOperatorCall('toml.try-table-entries', 1),
        },
        operator: newOperatorCall('toml.entry-item', 1),
      },
      operator: newOperatorCall('toml.try-array-elements', 1),
    },
    operator: newOperatorCall('toml.array-element-item', 1),
  };
  const result = executeTomlQuery(
    executable(expression, 'Last'),
    document,
    DEFAULT_TOML_QUERY_LIMITS,
    new TomlCancellationToken(),
  );
  assert.equal(result.matches.length, 1);
  const match = result.matches[0];
  if (match.kind !== 'Item') {
    throw new Error(`expected an Item match, got ${match.kind}`);
  }
  assert.deepEqual(match, { kind: 'Item', node: match.node, itemKind: 'Integer' });

  const taken = executeTomlQuery(
    executable({
      kind: 'Apply',
      input: expression,
      operator: withArgument(newOperatorCall('core.take', 1), 'count', integerValue(2n)),
    }),
    document,
    DEFAULT_TOML_QUERY_LIMITS,
    new TomlCancellationToken(),
  );
  assert.equal(taken.matches.length, 2);
});

test('try-table-entries on a scalar is empty; non-table items yield no entries', () => {
  const document = parseSource('value = 1\n');
  const expression: QueryExpression = {
    kind: 'Apply',
    input: {
      kind: 'Apply',
      input: {
        kind: 'Apply',
        input: { kind: 'Input' },
        operator: newOperatorCall('toml.try-table-entries', 1),
      },
      operator: newOperatorCall('toml.entry-item', 1),
    },
    operator: newOperatorCall('toml.try-table-entries', 1),
  };
  const result = executeTomlQuery(
    executable(expression),
    document,
    DEFAULT_TOML_QUERY_LIMITS,
    new TomlCancellationToken(),
  );
  assert.equal(result.matches.length, 0);
});

test('cancellation and step limits are execution failures with frozen codes', () => {
  const document = parseSource('a = 1\n');
  const expression: QueryExpression = { kind: 'Input' };

  const cancelled = new TomlCancellationToken();
  cancelled.cancel();
  assert.throws(
    () =>
      executeTomlQuery(
        executable(expression),
        document,
        DEFAULT_TOML_QUERY_LIMITS,
        cancelled,
      ),
    (failure: TomlQueryExecutionFailure) => {
      assert.equal(failure.kind, 'Cancelled');
      assert.equal(failure.code, 'core.query.cancelled@1');
      return true;
    },
  );

  assert.throws(
    () =>
      executeTomlQuery(
        executable(expression),
        document,
        { maxSteps: 0, maxResults: 100 },
        new TomlCancellationToken(),
      ),
    (failure: TomlQueryExecutionFailure) => {
      assert.equal(failure.kind, 'ResourceLimitExceeded');
      assert.equal(failure.code, 'core.query.resource-limit@1');
      return true;
    },
  );
});

test('lossless syntax query: toml.syntax-kind-is and syntax-text-equals preserve piece order', () => {
  // query.rs:598-651 test shape: pieces of "a = 1 # note\nb = 2\n" with a
  // StructureOrderMerge of newline kinds and a comment text.
  const document = parseSource('a = 1 # note\nb = 2\n');
  const newlines: QueryExpression = {
    kind: 'Apply',
    input: { kind: 'Input' },
    operator: withArgument(
      newOperatorCall('toml.syntax-kind-is', 1),
      'kind',
      stringValue('Newline'),
    ),
  };
  const comment: QueryExpression = {
    kind: 'Apply',
    input: { kind: 'Input' },
    operator: withArgument(
      newOperatorCall('toml.syntax-text-equals', 1),
      'text',
      stringValue('# note'),
    ),
  };
  const result = executeTomlSyntaxQuery(
    syntaxExecutable({ kind: 'StructureOrderMerge', branches: [newlines, comment] }),
    document,
    DEFAULT_TOML_QUERY_LIMITS,
    new TomlCancellationToken(),
  );
  assert.deepEqual(
    result.matches.map((match) => match.kind()),
    ['Comment', 'Newline', 'Newline'],
  );
  assert.equal(result.matches[0].nodeRef().role(), 'TomlSyntaxPiece');
  assert.ok(result.matches[0].ordinal() < result.matches[1].ordinal());
  const span = result.matches[0].span();
  assert.equal(
    new TextDecoder().decode(document.source().bytes().subarray(span.startByte(), span.endByte())),
    '# note',
  );
});

test('domain mismatch is a protocol QueryFailure', () => {
  const definition = withExpression(
    newQueryDefinition({ id: 'other.domain', version: 1 }),
    { kind: 'Input' },
  );
  const validated = validateQuery(definition);
  assert.ok('failure' in validated, 'unknown domain fails validation');
});
