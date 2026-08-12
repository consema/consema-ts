/**
 * Diagnostic record intent tests.
 *
 * These pin the registry-bound code/category validation of RFC 0016 §6 and
 * conformance/vectors/protocol-v1.json (protocol.diagnostic.reject-category-
 * registry-mismatch). They run once the toolchain is ready; no gate is
 * claimed before that (§7 START GATE).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ErrorCodeRegistry } from './error_registry.ts';
import {
  newDiagnostic,
  diagnosticToValue,
  diagnosticFromValue,
  validateDiagnosticCode,
  newSourceLocation,
} from './diagnostic.ts';
import { ProtocolError } from './errors.ts';

const V7 = new ErrorCodeRegistry(7);

test('a registered code with its registry category constructs', () => {
  const diagnostic = newDiagnostic(
    'core.query.unknown-operator@1',
    'Query',
    'Error',
    undefined,
    [],
    new Map([['operator', 'core.try-sequence-elements@1']]),
    ['note'],
    [],
    0n,
    V7,
  );
  assert.equal(diagnostic.code, 'core.query.unknown-operator@1');
  const value = diagnosticToValue(diagnostic);
  const decoded = diagnosticFromValue(value, V7);
  assert.equal(decoded.code, diagnostic.code);
  assert.equal(decoded.category, 'Query');
  assert.equal(decoded.severity, 'Error');
  assert.equal(decoded.arguments.get('operator'), 'core.try-sequence-elements@1');
});

test('vector protocol.diagnostic.reject-category-registry-mismatch: category contradiction is rejected', () => {
  // conformance/vectors/protocol-v1.json expects core.protocol.invalid-value@1.
  assert.throws(
    () =>
      newDiagnostic('core.query.unknown-operator@1', 'Syntax', 'Error', undefined, [], new Map(), [], [], 0n, V7),
    (error: unknown) => (error as ProtocolError).code === 'core.protocol.invalid-value@1',
  );
});

test('unregistered codes are rejected at construction', () => {
  assert.throws(
    () => newDiagnostic('core.query.not-registered@1', 'Query', 'Error', undefined, [], new Map(), [], [], 0n, V7),
    (error: unknown) => (error as ProtocolError).code === 'core.protocol.invalid-value@1',
  );
  assert.throws(() => validateDiagnosticCode('core.query.not-registered@1', 'Query', V7));
});

test('the wire record carries the fixed field order', () => {
  const diagnostic = newDiagnostic(
    'json.syntax.missing-object-close@1',
    'Syntax',
    'Warning',
    { sourceId: 'app.conf', startByte: 0n, endByte: 6n },
    [{ role: 'related', location: { sourceId: 'app.conf', startByte: 3n, endByte: 6n } }],
    new Map(),
    [],
    [
      {
        id: 'fix-1',
        applicability: 'MachineApplicable',
        location: { sourceId: 'app.conf', startByte: 0n, endByte: 6n },
        replacement: new TextEncoder().encode('{"a":1}'),
      },
    ],
    3n,
    V7,
  );
  const value = diagnosticToValue(diagnostic);
  assert.deepEqual(
    value.entries.map((entry) => entry.key),
    ['schema', 'code', 'category', 'severity', 'primary', 'related', 'arguments', 'notes', 'fixes', 'occurrence'],
  );
  assert.equal((value.entries[0].value as { value: string }).value, 'core.diagnostic@1');
  // primary is a location record; fixes carry Bytes replacement leaves.
  const fixes = value.entries[8].value;
  assert.equal(fixes.kind, 'Sequence');
  const fix = fixes.items[0];
  assert.equal(fix.kind, 'Object');
  assert.equal(fix.entries[3].value.kind, 'Bytes');
});

test('source locations validate the half-open range', () => {
  assert.throws(() => newSourceLocation('', 0n, 1n));
  assert.throws(() => newSourceLocation('app.conf', 5n, 4n));
  assert.doesNotThrow(() => newSourceLocation('app.conf', 0n, 0n));
});
