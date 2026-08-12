/**
 * Core value-model intent tests.
 *
 * These are blind-written intent documents (docs/multi-language-implementation
 * -plan.md §3): they pin the language-neutral facts from
 * conformance/vectors/v1.json and the Rust kind registry
 * (crates/consema-core/src/value.rs:620-653) and run once the toolchain is
 * ready. No gate is claimed before that (§7 START GATE).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  KINDS,
  nullValue,
  booleanValue,
  stringValue,
  bytesValue,
  integerValue,
  decimalValue,
  binaryFloat32Value,
  binaryFloat64Value,
  dateValue,
  timeValue,
  localDateTimeValue,
  offsetDateTimeValue,
  sequenceValue,
  objectValue,
  entryMappingValue,
  DuplicateKeyError,
  decimalDigits,
} from './value.ts';
import type { PortableValue } from './value.ts';
import { equal, hash, fnv1a64 } from './equal.ts';
import { encode } from './pvce.ts';
import { PVCEError } from './errors.ts';

test('the kind registry is closed at fifteen kinds in the RFC order', () => {
  // crates/consema-core/src/value.rs:620-653 (PortableValueKind order).
  assert.deepEqual(KINDS, [
    'Null',
    'Boolean',
    'Integer',
    'Decimal',
    'BinaryFloat32',
    'BinaryFloat64',
    'String',
    'Bytes',
    'Date',
    'Time',
    'LocalDateTime',
    'OffsetDateTime',
    'Sequence',
    'Object',
    'EntryMapping',
  ]);
});

test('vector value.decimal-normalization: 1.00 == 10e-1, strict equal and hash equal', () => {
  // conformance/vectors/v1.json case value.decimal-normalization.
  // 100 × 10^-2 and 10 × 10^-1 both normalize to the canonical 1 × 10^0.
  assert.equal(equal(decimalValue(100n, -2n), decimalValue(10n, -1n)), true);
  assert.equal(hash(decimalValue(100n, -2n)), hash(decimalValue(10n, -1n)));
});

test('decimal normalization strips trailing zeros into the exponent', () => {
  // crates/consema-core/src/value.rs:277-292.
  assert.deepEqual(decimalValue(10n, 0n), { kind: 'Decimal', coefficient: 1n, exponent: 1n });
  assert.deepEqual(decimalValue(0n, 5n), { kind: 'Decimal', coefficient: 0n, exponent: 0n });
  assert.deepEqual(decimalValue(-100n, 2n), { kind: 'Decimal', coefficient: -1n, exponent: 4n });
});

test('vector value.float-signed-zero: signed zeros are not strictly equal', () => {
  // conformance/vectors/v1.json case value.float-signed-zero.
  const positive = binaryFloat64Value(0x0000000000000000n);
  const negative = binaryFloat64Value(0x8000000000000000n);
  assert.equal(equal(positive, negative), false);
  // The bit identity is the value identity: bits survive the round trip.
  assert.equal(equal(binaryFloat64Value(0x7ff8000000000001n), binaryFloat64Value(0x7ff8000000000001n)), true);
});

test('integer arbitrary precision is exact', () => {
  // conformance/vectors/v1.json case value.integer-arbitrary-precision.
  const value = integerValue(340282366920938463463374607431768211457n);
  assert.equal(value.value, 340282366920938463463374607431768211457n);
  assert.equal(equal(value, integerValue(340282366920938463463374607431768211457n)), true);
});

test('object construction rejects duplicate keys with the typed error', () => {
  // RFC 0002 object contract; crates/consema-core/src/value.rs:959-984.
  assert.throws(
    () =>
      objectValue([
        { key: 'a', value: integerValue(1n) },
        { key: 'a', value: integerValue(2n) },
      ]),
    (error: unknown) => error instanceof DuplicateKeyError && error.key === 'a',
  );
  // The frozen registered code rides on the error.
  try {
    objectValue([
      { key: 'a', value: integerValue(1n) },
      { key: 'a', value: integerValue(2n) },
    ]);
    assert.fail('expected duplicate key rejection');
  } catch (error) {
    assert.equal((error as DuplicateKeyError).code, 'core.pvce.duplicate-object-key@1');
  }
});

test('entry mapping allows duplicate arbitrary keys', () => {
  // crates/consema-core/src/value.rs:973-978.
  const mapping = entryMappingValue([
    { key: booleanValue(true), value: nullValue() },
    { key: booleanValue(true), value: nullValue() },
  ]);
  assert.equal(mapping.entries.length, 2);
});

test('date validation follows the proleptic Gregorian calendar on |year|', () => {
  // crates/consema-core/src/value.rs:429-445; year -400 is a leap year, -100 is not.
  assert.equal(dateValue(-400n, 2, 29).kind, 'Date');
  assert.throws(() => dateValue(-100n, 2, 29), PVCEError);
  assert.throws(() => dateValue(2023n, 2, 29), PVCEError);
  assert.throws(() => dateValue(2024n, 13, 1), PVCEError);
  assert.equal(dateValue(2024n, 2, 29).kind, 'Date');
});

test('time fraction must be an exact finite decimal in [0, 1)', () => {
  // crates/consema-core/src/value.rs:337-352, 475-517.
  assert.equal(timeValue(23, 59, 58, decimalValue(125n, -3n)).kind, 'Time');
  assert.throws(() => timeValue(24, 0, 0, decimalValue(0n, 0n)), PVCEError);
  assert.throws(() => timeValue(0, 0, 0, decimalValue(1n, 0n)), PVCEError); // 1 >= 1
  assert.throws(() => timeValue(0, 0, 0, decimalValue(-1n, -1n)), PVCEError);
});

test('offset magnitude must be less than 24 hours', () => {
  // crates/consema-core/src/value.rs:553-563.
  const local = localDateTimeValue(dateValue(2024n, 1, 1), timeValue(0, 0, 0, decimalValue(0n, 0n)));
  assert.equal(offsetDateTimeValue(local, -23 * 60 * 60).kind, 'OffsetDateTime');
  assert.throws(() => offsetDateTimeValue(local, 24 * 60 * 60), PVCEError);
  assert.throws(() => offsetDateTimeValue(local, -24 * 60 * 60), PVCEError);
});

test('strict equality is kind-identity plus canonical content equality', () => {
  const object = objectValue([
    { key: 'a', value: integerValue(1n) },
    { key: 'b', value: stringValue('中') },
  ]);
  assert.equal(equal(object, object), true);
  // Order is a language-neutral fact.
  const reordered = objectValue([
    { key: 'b', value: stringValue('中') },
    { key: 'a', value: integerValue(1n) },
  ]);
  assert.equal(equal(object, reordered), false);
  // Bytes and String are always different kinds.
  assert.equal(equal(bytesValue(new TextEncoder().encode('x')), stringValue('x')), false);
  // Sequence content order matters.
  assert.equal(
    equal(sequenceValue([integerValue(1n), integerValue(2n)]), sequenceValue([integerValue(2n), integerValue(1n)])),
    false,
  );
});

test('hash is FNV-1a over the canonical PVCE/1 encoding', () => {
  // The hash contract: go/core/equal.go:125-138. Golden FNV-1a check on
  // "PVCE\x01\x00\x00" (the null vector, conformance/vectors/v1.json
  // pvce.null-vector) via the raw FNV-1a function.
  const bytes = encode(nullValue());
  assert.deepEqual([...bytes], [0x50, 0x56, 0x43, 0x45, 0x01, 0x00, 0x00]);
  const expected = fnv1a64(bytes);
  assert.equal(hash(nullValue()), expected);
  // Equal values hash equal; different values differ in practice.
  assert.equal(hash(decimalValue(100n, -2n)), hash(decimalValue(1n, 0n)));
  assert.notEqual(hash(booleanValue(true)), hash(booleanValue(false)));
});

test('the fifteen kinds all construct and round-trip through equality', () => {
  const date = dateValue(-12345n, 2, 28);
  const time = timeValue(23, 59, 58, decimalValue(125n, -3n));
  const local = localDateTimeValue(date, time);
  const all: PortableValue[] = [
    nullValue(),
    booleanValue(false),
    integerValue(123456789012345678901234567890n),
    decimalValue(1n, -999n),
    binaryFloat32Value(0x7fc00001),
    binaryFloat64Value(0x8000000000000000n),
    stringValue('é'),
    bytesValue(Uint8Array.of(0, 255)),
    date,
    time,
    local,
    offsetDateTimeValue(local, -23 * 60 * 60),
    sequenceValue([nullValue(), booleanValue(true)]),
    objectValue([{ key: 'a', value: integerValue(1n) }]),
    entryMappingValue([{ key: booleanValue(true), value: nullValue() }]),
  ];
  assert.equal(all.length, 15);
  for (const value of all) {
    assert.equal(equal(value, value), true);
  }
});

test('decimalDigits counts base-ten digits', () => {
  assert.equal(decimalDigits(0n), 1);
  assert.equal(decimalDigits(12345n), 5);
});
