/**
 * Intent documents for plist query execution (L3).
 *
 * Golden transcriptions from the shared vectors:
 *  - conformance/vectors/plist-v1.json:
 *    plist.query.dict-entries-order (:918-947),
 *    plist.query.typed-accessors (:949-1042, mismatch_code
 *    plist.query.type-mismatch@1),
 *    plist.query.binary-structure (:1044-1089)
 *  - operator vocabulary: RFC 0013 §8.1/§8.2/§8.3; the native domain
 *    operators at crates/consema-plist/src/query.rs:810-1163, the binary
 *    structure operators :1334-1465
 *  - family failure-code mapping: crates/consema-conformance/src/
 *    plist_v1.rs:1141-1153
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDefault,
  executePlistNativeQuery,
  executePlistBinaryQuery,
  QueryLimits,
  CancellationToken,
  QueryExecutionFailure,
} from './index.ts';
import type { PlistBinaryMatch } from './index.ts';
import {
  newQueryDefinition,
  withExpression,
  withSelection,
  validateQuery,
  bindQuery,
} from '../protocol/query.ts';
import { domainPlistNativeV1, domainPlistBinaryStructureV1 } from '../protocol/query.ts';
import { CapabilitySet, newCapabilityId } from '../protocol/registry_descriptor.ts';
import type { ExecutableQuery, QueryExpression, OperatorCall } from '../protocol/query.ts';
import { stringValue } from '../core/value.ts';

function bytes(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index++) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

/** One validated and bound query over one domain. */
function boundQuery(domain: ReturnType<typeof domainPlistNativeV1>, operators: readonly (readonly [string, (readonly [string, string])?])[]): ExecutableQuery {
  let expression: QueryExpression = { kind: 'Input' };
  for (const [operatorId, argument] of operators) {
    expression = {
      kind: 'Apply',
      input: expression,
      operator: operatorOf(operatorId, argument),
    };
  }
  const definition = withSelection(withExpression(newQueryDefinition(domain), expression), 'All');
  const validated = validateQuery(definition);
  if ('failure' in validated) {
    throw new Error(`query validation failed: ${validated.failure.message}`);
  }
  const capabilities = new CapabilitySet();
  capabilities.insert(newCapabilityId('core.query.ordered-results', 1));
  const result = bindQuery(validated.query, capabilities);
  if ('failure' in result) {
    throw new Error(`query binding failed: ${result.failure.message}`);
  }
  return result.query;
}

function operatorOf(id: string, argument?: readonly [string, string]): OperatorCall {
  return {
    id,
    version: 1,
    arguments: new Map(argument === undefined ? [] : [[argument[0], stringValue(argument[1])]]),
  };
}

test('plist.query.dict-entries-order: entries keep source order with duplicates (plist-v1.json:918-947)', () => {
  const document = parseDefault(
    bytes('<plist version="1.0"><dict><key>a</key><integer>1</integer><key>b</key><array><string>x</string></array><key>a</key><integer>2</integer></dict></plist>'),
    'XmlV1',
  );
  const executable = boundQuery(domainPlistNativeV1(), [
    ['plist.document-root'],
    ['plist.dict-entries'],
  ]);
  const result = executePlistNativeQuery(executable, document, QueryLimits.defaults(), new CancellationToken());
  const matches = result.matches();
  assert.equal(result.terminal(), 'Completed');
  const keys = matches.filter((match) => match.kind === 'DictEntry').map((match) => (match as { key: string }).key);
  assert.deepEqual(keys, ['a', 'b', 'a']);
  const kinds = matches
    .filter((match) => match.kind === 'DictEntry')
    .map((match) => (match as { valueKind: string }).valueKind);
  assert.deepEqual(kinds, ['Integer', 'Array', 'Integer']);
});

test('plist.query.typed-accessors: integer and date accessors complete, a string accessor on an integer fails (plist-v1.json:949-1042)', () => {
  const document = parseDefault(
    bytes('<plist version="1.0"><dict><key>count</key><integer>42</integer><key>created</key><date>2023-01-01T00:00:00Z</date><key>name</key><string>x</string></dict></plist>'),
    'XmlV1',
  );
  const run = (typed: string, key: string): readonly { kind: string; valueKind: string }[] => {
    const executable = boundQuery(domainPlistNativeV1(), [
      ['plist.document-root'],
      ['plist.dict-entries'],
      ['plist.dict-key-equals', ['key', key]],
      ['plist.dict-entry-value'],
      [typed],
    ]);
    const result = executePlistNativeQuery(executable, document, QueryLimits.defaults(), new CancellationToken());
    return result.matches().map((match) => ({ kind: match.kind, valueKind: (match as { valueKind: string }).valueKind }));
  };
  // The vector selects 'count' (integer) and 'created' (date) per sample;
  // a string accessor on the integer 'count' fails with type-mismatch.
  const integer = run('plist.value-as-integer', 'count');
  assert.deepEqual(integer, [{ kind: 'Value', valueKind: 'Integer' }]);
  const date = run('plist.value-as-date', 'created');
  assert.deepEqual(date, [{ kind: 'Value', valueKind: 'Date' }]);
  assert.throws(() => run('plist.value-as-string', 'count'), (error: unknown) => {
    assert.ok(error instanceof QueryExecutionFailure);
    assert.equal(error.code, 'plist.query.type-mismatch@1');
    return true;
  });
});

test('plist.query.binary-structure: object/offset/trailer/top facts (plist-v1.json:1044-1089)', () => {
  const document = parseDefault(
    hexBytes('62706c6973743030d1010251611001080b0d000000000000010100000000000000030000000000000000000000000000000f'),
    'BinaryV1',
  );
  // The vector's structure facts are document-level: every operator
  // projects its fact set from any binary-structure input, so each filter
  // is also executed standalone and its facts collected (RFC 0013 §8.3;
  // plist_v1.rs run_binary_structure_query).
  const matches: PlistBinaryMatch[] = [];
  for (const id of ['plist.object-table', 'plist.offset-table', 'plist.trailer-facts', 'plist.top-object']) {
    const executable = boundQuery(domainPlistBinaryStructureV1(), [[id]]);
    const result = executePlistBinaryQuery(executable, document, QueryLimits.defaults(), new CancellationToken());
    assert.equal(result.terminal(), 'Completed');
    matches.push(...result.matches());
  }
  const objects = matches.filter((match) => match.kind === 'Object');
  const offsets = matches.filter((match) => match.kind === 'Offset');
  const trailers = matches.filter((match) => match.kind === 'Trailer');
  const tops = matches.filter((match) => match.kind === 'TopObject');
  assert.equal(objects.length, 3);
  assert.deepEqual(objects.map((match) => (match as { offset: number }).offset), [8, 11, 13]);
  assert.deepEqual(objects.map((match) => (match as { marker: number }).marker), [0xd1, 0x51, 0x10]);
  assert.equal(offsets.length, 3);
  assert.equal(trailers.length, 1);
  const trailer = trailers[0] as { sortVersion: number; offsetIntSize: number; objectRefSize: number; numObjects: bigint; topObject: bigint; offsetTableOffset: bigint };
  assert.equal(trailer.sortVersion, 0);
  assert.equal(trailer.offsetIntSize, 1);
  assert.equal(trailer.objectRefSize, 1);
  assert.equal(trailer.numObjects, 3n);
  assert.equal(trailer.topObject, 0n);
  assert.equal(trailer.offsetTableOffset, 15n);
  assert.equal(tops.length, 1);
  const top = tops[0] as { marker: number; refs: readonly { position: number; target: number }[] };
  assert.equal(top.marker, 0xd1);
  assert.deepEqual(top.refs.map((reference) => reference.target), [1, 2]);
});

test('domain gate: the native domain rejects another domain (query.rs:271-302)', () => {
  const document = parseDefault(bytes('<plist version="1.0"><string>x</string></plist>'), 'XmlV1');
  const executable = boundQuery(domainPlistNativeV1(), [['plist.document-root']]);
  assert.throws(() => {
    executePlistBinaryQuery(executable, document, QueryLimits.defaults(), new CancellationToken());
  }, (error: unknown) => {
    assert.ok(error instanceof QueryExecutionFailure);
    assert.equal(error.code, 'plist.query.domain-mismatch@1');
    return true;
  });
});

test('hard gate 1: the binary structure domain rejects an XML document (RFC 0013 §7)', () => {
  const document = parseDefault(bytes('<plist version="1.0"><string>x</string></plist>'), 'XmlV1');
  const executable = boundQuery(domainPlistBinaryStructureV1(), [['plist.object-table']]);
  assert.throws(() => {
    executePlistBinaryQuery(executable, document, QueryLimits.defaults(), new CancellationToken());
  }, (error: unknown) => {
    assert.ok(error instanceof QueryExecutionFailure);
    assert.equal(error.code, 'plist.query.domain-mismatch@1');
    return true;
  });
});
