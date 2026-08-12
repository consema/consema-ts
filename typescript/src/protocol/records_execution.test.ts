/**
 * Failure-injection and round-trip tests for the protocol execution and
 * value-path records (records_execution.ts, records_value_path.ts).
 *
 * authority: crates/consema-protocol/src/execution.rs (Completion state
 * invariants :40-187, ExecutionPolicy :189-277, CancellationRequest
 * :279-340) and crates/consema-protocol/src/query.rs:441-560 (path_value,
 * parse_path, association_value, parse_association); cross-reference
 * go/protocol/query_exec_test.go's failure-injection style — every invalid
 * state combination and malformed wire shape rejects with the frozen
 * ProtocolError kind/path before any record is constructed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stringValue, integerValue, nullValue } from '../core/value.ts';
import type { PortableValue } from '../core/value.ts';
import { objectValueFrom } from './records.ts';
import { ProtocolError } from './errors.ts';
import { ContractRegistry } from './contract.ts';
import { newContractId } from './contract.ts';
import { validateRegisteredPayload } from './payload_validators.ts';
import { Completion, ExecutionPolicy, CancellationRequest } from './records_execution.ts';
import { ValuePath, AssociationLocation } from './records_value_path.ts';

/** Asserts the call rejects with the InvalidValue protocol error at path. */
function assertInvalid(call: () => unknown, path: string): ProtocolError {
  let thrown: unknown;
  try {
    call();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof ProtocolError, `expected ProtocolError, got ${thrown}`);
  assert.equal(thrown.kind, 'InvalidValue');
  assert.equal(thrown.path, path);
  return thrown;
}

/** Asserts the call rejects with the protocol error kind at path. */
function assertRejects(call: () => unknown, kind: string, path: string): void {
  let thrown: unknown;
  try {
    call();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof ProtocolError, `expected ProtocolError, got ${thrown}`);
  assert.equal(thrown.kind, kind);
  assert.equal(thrown.path, path);
}

/** The registered semantic-model v1 failure code used in valid completions. */
const REGISTERED_CODE = 'core.protocol.invalid-value@1';

// ---------------------------------------------------------------------------
// Completion: the six frozen statuses and the state invariants
// ---------------------------------------------------------------------------

test('completion — all six statuses round-trip through the wire value', () => {
  const cases: Completion[] = [
    Completion.new('Success', 0n, 0n),
    Completion.new('Failed', 3n, 0n, null, REGISTERED_CODE),
    Completion.new('Cancelled', 2n, 1n),
    Completion.new('ResourceLimited', 4n, 2n, 'max-results'),
    Completion.new('Unsupported', 0n, 0n, null, REGISTERED_CODE),
    Completion.new('NotApplicable', 0n, 0n, null, REGISTERED_CODE),
  ];
  for (const completion of cases) {
    const decoded = Completion.fromValue(completion.toValue());
    assert.ok(decoded.equal(completion), `round trip failed for ${completion.status}`);
  }
});

test('completion — Success and Cancelled forbid limit and failure fields', () => {
  for (const status of ['Success', 'Cancelled'] as const) {
    assertInvalid(() => Completion.new(status, 0n, 0n, 'max-results'), '$');
    assertInvalid(() => Completion.new(status, 0n, 0n, null, REGISTERED_CODE), '$');
    assertInvalid(
      () => Completion.new(status, 0n, 0n, 'max-results', REGISTERED_CODE),
      '$',
    );
  }
});

test('completion — ResourceLimited requires a limit name and forbids a failure code', () => {
  assertInvalid(() => Completion.new('ResourceLimited', 0n, 0n), '$');
  assertInvalid(() => Completion.new('ResourceLimited', 0n, 0n, ''), '$');
  assertInvalid(
    () => Completion.new('ResourceLimited', 0n, 0n, 'max-results', REGISTERED_CODE),
    '$',
  );
});

test('completion — Failed/Unsupported/NotApplicable require a failure code and forbid a limit name', () => {
  for (const status of ['Failed', 'Unsupported', 'NotApplicable'] as const) {
    assertInvalid(() => Completion.new(status, 0n, 0n), '$');
    // The registry check runs before the state invariant (error_registry.rs
    // :1500-1510), so an empty failure code rejects at the code path.
    assertInvalid(() => Completion.new(status, 0n, 0n, null, ''), '$.failure_code');
    assertInvalid(() => Completion.new(status, 0n, 0n, 'max-results', REGISTERED_CODE), '$');
  }
});

test('completion — an unregistered failure code is rejected at the code path', () => {
  assertInvalid(
    () => Completion.new('Failed', 0n, 0n, null, 'core.no-such-code@1'),
    '$.failure_code',
  );
});

test('completion — decode rejects malformed wire shapes', () => {
  const fields = (overrides: Record<string, PortableValue>): PortableValue => {
    const base: { key: string; value: PortableValue }[] = [
      { key: 'schema', value: stringValue('core.completion@1') },
      { key: 'status', value: stringValue('Success') },
      { key: 'processed', value: integerValue(0n) },
      { key: 'produced', value: integerValue(0n) },
      { key: 'limit_name', value: nullValue() },
      { key: 'failure_code', value: nullValue() },
    ];
    for (const [key, value] of Object.entries(overrides)) {
      const index = base.findIndex((entry) => entry.key === key);
      if (index >= 0) {
        base[index] = { key, value };
      } else {
        base.push({ key, value });
      }
    }
    return objectValueFrom(base);
  };

  assertRejects(() => Completion.fromValue(stringValue('not-an-object')), 'WrongType', '$');
  assertRejects(
    () =>
      Completion.fromValue(
        objectValueFrom([
          { key: 'schema', value: stringValue('core.completion@2') },
          { key: 'status', value: stringValue('Success') },
          { key: 'processed', value: integerValue(0n) },
          { key: 'produced', value: integerValue(0n) },
          { key: 'limit_name', value: nullValue() },
          { key: 'failure_code', value: nullValue() },
        ]),
      ),
    'SchemaMismatch',
    '$.schema',
  );
  assertRejects(
    () => Completion.fromValue(fields({ status: stringValue('Running') })),
    'InvalidValue',
    '$.status',
  );
  assertRejects(
    () => Completion.fromValue(fields({ processed: stringValue('1') })),
    'WrongType',
    '$.processed',
  );
  assertRejects(
    () => Completion.fromValue(fields({ processed: integerValue(-1n) })),
    'InvalidValue',
    '$.processed',
  );
  assertRejects(
    () => Completion.fromValue(fields({ extra: stringValue('x') })),
    'UnknownField',
    '$.extra',
  );
  // Status/fields contradiction surfaces through the same invariant.
  assertRejects(
    () => Completion.fromValue(fields({ status: stringValue('ResourceLimited') })),
    'InvalidValue',
    '$',
  );
});

test('completion — the envelope payload validator is registered and strict', () => {
  const registry = new ContractRegistry(1);
  const contract = newContractId('core.completion', 1);
  const valid = Completion.new('ResourceLimited', 5n, 3n, 'max-results');
  validateRegisteredPayload(contract, valid.toValue(), registry);
  assertRejects(
    () => validateRegisteredPayload(contract, Completion.new('Success', 0n, 0n, 'x').toValue(), registry),
    'InvalidValue',
    '$',
  );
  const unregistered = newContractId('core.nonexistent', 1);
  assertRejects(
    () => validateRegisteredPayload(unregistered, valid.toValue(), registry),
    'UnknownContract',
    '$.contract',
  );
});

// ---------------------------------------------------------------------------
// ExecutionPolicy
// ---------------------------------------------------------------------------

test('execution-policy — round trip sorts limit keys on the wire', () => {
  const policy = ExecutionPolicy.new(
    new Map([
      ['max_results', 10n],
      ['max_depth', 4n],
    ]),
    'request-7',
  );
  const decoded = ExecutionPolicy.fromValue(policy.toValue());
  assert.deepEqual(decoded.limits, policy.limits);
  assert.equal(decoded.cancellationRequestId, 'request-7');
  const wire = policy.toValue();
  const limitsObject = wire.entries[1].value;
  assert.equal(limitsObject.kind, 'Object');
  const limitKeys = limitsObject.entries.map((e) => e.key);
  assert.deepEqual(limitKeys, ['max_depth', 'max_results']);
});

test('execution-policy — invalid limit names and cancellation IDs are rejected', () => {
  assertInvalid(
    () => ExecutionPolicy.new(new Map([['', 1n]])),
    '$.limits',
  );
  assertInvalid(
    () => ExecutionPolicy.new(new Map([['Max-Results', 1n]])),
    '$.limits',
  );
  assertInvalid(
    () => ExecutionPolicy.new(new Map([['has space', 1n]])),
    '$.limits',
  );
  assertInvalid(
    () => ExecutionPolicy.new(new Map([['max_results', 1n]]), ''),
    '$.cancellation_request_id',
  );
  assertInvalid(
    () => ExecutionPolicy.new(new Map([['max_results', 1n]]), 'x'.repeat(1025)),
    '$.cancellation_request_id',
  );
});

test('execution-policy — decode rejects malformed wire shapes', () => {
  const payload = (limits: PortableValue): PortableValue =>
    objectValueFrom([
      { key: 'schema', value: stringValue('core.execution-policy@1') },
      { key: 'limits', value: limits },
      { key: 'cancellation_request_id', value: nullValue() },
    ]);
  assertRejects(() => ExecutionPolicy.fromValue(payload(stringValue('x'))), 'WrongType', '$.limits');
  assertRejects(
    () =>
      ExecutionPolicy.fromValue(
        payload(objectValueFrom([{ key: 'max_results', value: integerValue(-1n) }])),
      ),
    'InvalidValue',
    '$.limits.max_results',
  );
  assertRejects(
    () =>
      ExecutionPolicy.fromValue(
        payload(objectValueFrom([{ key: 'max_results', value: stringValue('10') }])),
      ),
    'WrongType',
    '$.limits.max_results',
  );
});

// ---------------------------------------------------------------------------
// CancellationRequest
// ---------------------------------------------------------------------------

test('cancellation-request — round trip and id validation', () => {
  const request = CancellationRequest.new('request-9', 'timeout');
  const decoded = CancellationRequest.fromValue(request.toValue());
  assert.equal(decoded.requestId, 'request-9');
  assert.equal(decoded.reason, 'timeout');
  assert.equal(CancellationRequest.fromValue(CancellationRequest.new('r').toValue()).reason, null);
  assertInvalid(() => CancellationRequest.new(''), '$.request_id');
  assertInvalid(() => CancellationRequest.new('x'.repeat(1025)), '$.request_id');
});

// ---------------------------------------------------------------------------
// ValuePath
// ---------------------------------------------------------------------------

test('value-path — root and mixed paths round trip with equality and ordering', () => {
  const root = ValuePath.root();
  assert.ok(root.equal(ValuePath.fromValue(root.toValue())));
  const path = root
    .append('ObjectValue', 'owner')
    .append('SequenceElement', 0n)
    .append('EntryKey', 1n)
    .append('EntryValue', 2n)
    .append('ObjectValue', 'name');
  const decoded = ValuePath.fromValue(path.toValue());
  assert.ok(decoded.equal(path));
  assert.ok(!decoded.equal(root));
  assert.ok(root.less(path));
  // Kind ordering is canonical: EntryKey < EntryValue < ObjectValue <
  // SequenceElement.
  assert.ok(ValuePath.root().append('EntryKey', 0n).less(ValuePath.root().append('EntryValue', 0n)));
  assert.ok(
    ValuePath.root().append('EntryValue', 0n).less(ValuePath.root().append('ObjectValue', 'a')),
  );
  assert.ok(
    ValuePath.root().append('ObjectValue', 'a').less(ValuePath.root().append('SequenceElement', 0n)),
  );
  assert.ok(
    ValuePath.root()
      .append('ObjectValue', 'a')
      .less(ValuePath.root().append('ObjectValue', 'a').append('EntryKey', 0n)),
  );
});

test('value-path — decode rejects malformed wire shapes', () => {
  const segment = (fields: [string, PortableValue][]): PortableValue =>
    objectValueFrom(fields.map(([key, value]) => ({ key, value })));
  const payload = (segments: PortableValue[]): PortableValue =>
    objectValueFrom([{ key: 'segments', value: { kind: 'Sequence', items: segments } }]);

  assertRejects(() => ValuePath.fromValue(stringValue('x')), 'WrongType', '$');
  assertRejects(() => ValuePath.fromValue(objectValueFrom([])), 'MissingField', '$.segments');
  assertRejects(
    () => ValuePath.fromValue(objectValueFrom([{ key: 'segments', value: stringValue('x') }])),
    'WrongType',
    '$.segments',
  );
  assertRejects(
    () => ValuePath.fromValue(objectValueFrom([{ key: 'other', value: nullValue() }])),
    'UnknownField',
    '$.other',
  );
  // A segment whose first entry is not the `kind` discriminator.
  assertRejects(
    () => ValuePath.fromValue(payload([segment([['key', stringValue('a')]])])),
    'InvalidValue',
    '$.segments[0]',
  );
  // Unknown segment kind.
  assertRejects(
    () =>
      ValuePath.fromValue(
        payload([segment([['kind', stringValue('ObjectKey')]])]),
      ),
    'InvalidValue',
    '$.segments[0]',
  );
  // ObjectValue segment missing its key.
  assertRejects(
    () =>
      ValuePath.fromValue(
        payload([segment([['kind', stringValue('ObjectValue')]])]),
      ),
    'MissingField',
    '$.segments[0].key',
  );
  // SequenceElement segment with a string index.
  assertRejects(
    () =>
      ValuePath.fromValue(
        payload([segment([['kind', stringValue('SequenceElement')], ['index', stringValue('0')]])]),
      ),
    'WrongType',
    '$.segments[0].index',
  );
  // Negative ordinal index.
  assertRejects(
    () =>
      ValuePath.fromValue(
        payload([segment([['kind', stringValue('EntryKey')], ['index', integerValue(-1n)]])]),
      ),
    'InvalidValue',
    '$.segments[0].index',
  );
  // Undeclared field inside a segment.
  assertRejects(
    () =>
      ValuePath.fromValue(
        payload([
          segment([
            ['kind', stringValue('ObjectValue')],
            ['key', stringValue('a')],
            ['extra', stringValue('x')],
          ]),
        ]),
      ),
    'UnknownField',
    '$.segments[0].extra',
  );
});

// ---------------------------------------------------------------------------
// AssociationLocation
// ---------------------------------------------------------------------------

test('association-location — round trip and role validation', () => {
  const location = new AssociationLocation(
    ValuePath.root().append('ObjectValue', 'a').append('EntryKey', 0n),
    3n,
    'EntryMappingEntry',
  );
  const decoded = AssociationLocation.fromValue(location.toValue());
  assert.ok(decoded.equal(location));
  assert.ok(!decoded.less(location) && !location.less(decoded));
  const other = new AssociationLocation(ValuePath.root(), 0n, 'ObjectEntry');
  assert.ok(other.less(location));

  assertRejects(
    () =>
      AssociationLocation.fromValue(
        objectValueFrom([
          { key: 'container', value: ValuePath.root().toValue() },
          { key: 'ordinal', value: integerValue(0n) },
          { key: 'role', value: stringValue('ObjectValue') },
        ]),
      ),
    'InvalidValue',
    '$.role',
  );
  assertRejects(
    () =>
      AssociationLocation.fromValue(
        objectValueFrom([
          { key: 'container', value: ValuePath.root().toValue() },
          { key: 'ordinal', value: integerValue(-1n) },
          { key: 'role', value: stringValue('ObjectEntry') },
        ]),
      ),
    'InvalidValue',
    '$.ordinal',
  );
});
