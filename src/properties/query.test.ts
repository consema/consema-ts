/**
 * Intent documents for Java Properties native and lossless-syntax queries.
 *
 * Golden transcriptions from the shared vectors — each test cites its
 * case id:
 *  - conformance/vectors/java-properties-v1.json:
 *    query.native-duplicates-and-escape-ownership (:61-64),
 *    query.logical-and-syntax-order (:66-69),
 *    query.validation-limit-cancellation (:71-74)
 *  - RFC 0010 §10 (:269-308) freezes the query surface
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PROPERTIES_PARSE_LIMITS } from '../properties/parse_limits.ts';
import { parseReader } from '../properties/parser.ts';
import {
  executePropertiesQuery,
  executePropertiesQueryCursor,
  executePropertiesSyntaxQuery,
  QueryLimits,
  CancellationToken,
} from '../properties/query.ts';
import { QueryExecutionFailure } from '../properties/errors.ts';
import type { PropertiesMatch } from '../properties/query.ts';
import {
  domainJavaPropertiesNativeV1,
  domainJavaPropertiesLosslessSyntaxV1,
  newOperatorCall,
  newQueryDefinition,
  validateQuery,
  bindQuery,
  withArgument,
  withExpression,
} from '../protocol/query.ts';
import type { QueryExpression } from '../protocol/query.ts';
import { CapabilitySet } from '../protocol/registry_descriptor.ts';
import { bytesValue, integerValue, stringValue } from '../core/value.ts';
import { utf8Encoding } from '../document/source.ts';

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

function parse(source: string) {
  return parseReader(bytes(source), utf8Encoding(), DEFAULT_PROPERTIES_PARSE_LIMITS);
}

test('query.native-duplicates-and-escape-ownership: exact-key duplicates and escapes (java-properties-v1.json:61-64)', () => {
  const document = parse('a\\ key=one\\u0021\na\\ key=two\nempty\n');
  const duplicates = executable(domainJavaPropertiesNativeV1(), {
    kind: 'Apply',
    input: {
      kind: 'Apply',
      input: {
        kind: 'Apply',
        input: {
          kind: 'Apply',
          input: { kind: 'Input' },
          operator: newOperatorCall('properties.document-properties', 1),
        },
        operator: withArgument(
          newOperatorCall('properties.property-key-equals', 1),
          'key',
          bytesValue(Uint8Array.from(decodeHex('00610020006b00650079'))),
        ),
      },
      operator: withArgument(newOperatorCall('core.take', 1), 'count', integerValue(1n)),
    },
    operator: newOperatorCall('properties.duplicate-group', 1),
  });
  const duplicateResult = executePropertiesQuery(
    duplicates,
    document,
    QueryLimits.defaults(),
    new CancellationToken(),
  );
  assert.equal(duplicateResult.matches().length, 2);
  assert.ok(
    duplicateResult
      .matches()
      .every((item) => item.kind === 'Property' && item.duplicateGroup !== null),
  );
  assert.equal(duplicateResult.terminalState(), 'Completed');

  const escapes = executable(domainJavaPropertiesNativeV1(), {
    kind: 'Apply',
    input: {
      kind: 'Apply',
      input: {
        kind: 'Apply',
        input: { kind: 'Input' },
        operator: newOperatorCall('properties.document-properties', 1),
      },
      operator: withArgument(newOperatorCall('core.take', 1), 'count', integerValue(1n)),
    },
    operator: newOperatorCall('properties.property-escapes', 1),
  });
  const escapeResult = executePropertiesQuery(
    escapes,
    document,
    QueryLimits.defaults(),
    new CancellationToken(),
  );
  assert.equal(escapeResult.matches().length, 2);
  assert.ok(escapeResult.matches().every((item) => item.kind === 'Escape'));
});

test('query.logical-and-syntax-order: natural constituents and the three syntax filters (java-properties-v1.json:66-69)', () => {
  const logical = parse('k=one\\\r\n two\n');
  const logicalQuery = executable(domainJavaPropertiesNativeV1(), {
    kind: 'Apply',
    input: {
      kind: 'Apply',
      input: { kind: 'Input' },
      operator: newOperatorCall('properties.logical-lines', 1),
    },
    operator: newOperatorCall('properties.logical-line-natural-lines', 1),
  });
  const logicalResult = executePropertiesQuery(
    logicalQuery,
    logical,
    QueryLimits.defaults(),
    new CancellationToken(),
  );
  assert.deepEqual(
    logicalResult.matches().map((item) => (item.kind === 'NaturalLine' ? item.ordinal : -1)),
    [0, 1],
  );

  const syntax = parse('键=值\n');
  const text = {
    kind: 'Apply' as const,
    input: { kind: 'Input' as const },
    operator: withArgument(newOperatorCall('properties.syntax-text-equals', 1), 'text', stringValue('值')),
  };
  const raw = {
    kind: 'Apply' as const,
    input: { kind: 'Input' as const },
    operator: withArgument(
      newOperatorCall('properties.syntax-raw-bytes-equals', 1),
      'bytes',
      bytesValue(Uint8Array.from(decodeHex('e994ae'))),
    ),
  };
  const utf16 = {
    kind: 'Apply' as const,
    input: { kind: 'Input' as const },
    operator: withArgument(
      newOperatorCall('properties.syntax-utf16be-equals', 1),
      'code_units',
      bytesValue(Uint8Array.from(decodeHex('503c'))),
    ),
  };
  const syntaxQuery = executable(domainJavaPropertiesLosslessSyntaxV1(), {
    kind: 'StructureOrderMerge',
    branches: [raw, text, utf16],
  });
  const syntaxResult = executePropertiesSyntaxQuery(
    syntaxQuery,
    syntax,
    QueryLimits.defaults(),
    new CancellationToken(),
  );
  assert.deepEqual(
    syntaxResult.matches().map((item) => item.kind()),
    ['Key', 'Value', 'Value'],
  );
  assert.ok(syntaxResult.matches().every((item) => item.nodeRef().role() === 'PropertiesSyntaxPiece'));
  assert.equal(syntaxResult.matches().length, 3);
  // StructureOrderMerge keeps piece order; the two Value matches share an ordinal.
  const ordinals = syntaxResult.matches().map((item) => item.ordinal());
  assert.ok(!ordinals.every((value, index) => index === 0 || value > ordinals[index - 1]));
});

test('query.validation-limit-cancellation: invalid argument, result limit, cursor cancellation (java-properties-v1.json:71-74)', () => {
  // The odd-length key bytes fail operator validation with InvalidArgument(key)
  // (typescript/src/protocol/query.ts:994-1003).
  const invalid = validateQuery(
    withExpression(newQueryDefinition(domainJavaPropertiesNativeV1()), {
      kind: 'Apply',
      input: {
        kind: 'Apply',
        input: { kind: 'Input' },
        operator: newOperatorCall('properties.document-properties', 1),
      },
      operator: withArgument(
        newOperatorCall('properties.property-key-equals', 1),
        'key',
        bytesValue(Uint8Array.from([0])),
      ),
    }),
  );
  assert.ok('failure' in invalid);
  if ('failure' in invalid) {
    assert.equal(invalid.failure.argument, 'key');
  }

  const document = parse('a=1\nb=2\n');
  const all = executable(domainJavaPropertiesNativeV1(), {
    kind: 'Apply',
    input: { kind: 'Input' },
    operator: newOperatorCall('properties.document-properties', 1),
  });
  assert.throws(
    () =>
      executePropertiesQuery(
        all,
        document,
        new QueryLimits(100, 1),
        new CancellationToken(),
      ),
    (error: unknown) => {
      assert.ok(error instanceof QueryExecutionFailure);
      assert.equal(error.kind, 'ResourceLimitExceeded');
      assert.equal(error.code, 'core.query.resource-limit@1');
      return true;
    },
  );

  const cancellation = new CancellationToken();
  const cursor = executePropertiesQueryCursor(
    all,
    document,
    QueryLimits.defaults(),
    cancellation,
  );
  assert.ok(cursor.next() !== null);
  cancellation.cancel();
  assert.equal(cursor.next(), null);
  assert.equal(cursor.terminalState(), 'Cancelled');
});

test('native operators: natural lines, logical lines, and value-state filters', () => {
  const document = parse('# c\na=1\n\nb=\n');
  const natural = executable(domainJavaPropertiesNativeV1(), {
    kind: 'Apply',
    input: { kind: 'Input' },
    operator: newOperatorCall('properties.natural-lines', 1),
  });
  const naturalResult = executePropertiesQuery(natural, document, QueryLimits.defaults(), new CancellationToken());
  assert.equal(naturalResult.matches().length, 4);
  assert.ok(naturalResult.matches().every((item) => item.kind === 'NaturalLine'));

  const states = executable(domainJavaPropertiesNativeV1(), {
    kind: 'Apply',
    input: {
      kind: 'Apply',
      input: { kind: 'Input' },
      operator: newOperatorCall('properties.document-properties', 1),
    },
    operator: withArgument(
      newOperatorCall('properties.property-value-state-is', 1),
      'state',
      stringValue('ExplicitEmpty'),
    ),
  });
  const stateResult = executePropertiesQuery(states, document, QueryLimits.defaults(), new CancellationToken());
  assert.equal(stateResult.matches().length, 1);
  const match = stateResult.matches()[0] as Extract<PropertiesMatch, { kind: 'Property' }>;
  assert.equal(match.valueState, 'ExplicitEmpty');
});

function decodeHex(value: string): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 2) {
    bytes.push(Number.parseInt(value.slice(index, index + 2), 16));
  }
  return bytes;
}
