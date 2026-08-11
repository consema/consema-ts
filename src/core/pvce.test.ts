/**
 * PVCE/1 codec intent tests with golden bytes.
 *
 * The golden vectors are transcribed from conformance/vectors/v1.json
 * (cases pvce.null-vector, pvce.negative-integer-vector, pvce.object-vector,
 * pvce.reject-nonminimal-varint) and cross-checked against the Rust frozen
 * vectors (crates/consema-pvce/src/lib.rs:1336-1342). They run once the
 * toolchain is ready; no gate is claimed before that (§7 START GATE).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  encode,
  decode,
  decodeValue,
  encodeBounded,
  defaultDecodeLimits,
  defaultEncodeLimits,
} from './pvce.ts';
import type { DecodeLimits, EncodeLimits } from './pvce.ts';
import {
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
} from './value.ts';
import type { PortableValue } from './value.ts';
import { equal } from './equal.ts';
import { PVCEError, pvceError } from './errors.ts';

function hex(bytes: Uint8Array): string {
  return [...bytes].map((octet) => octet.toString(16).padStart(2, '0')).join('');
}

function unhex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const LIMITS: DecodeLimits = defaultDecodeLimits();

test('vector pvce.null-vector: null encodes to the frozen bytes', () => {
  // conformance/vectors/v1.json; crates/consema-pvce/src/lib.rs:1337.
  assert.equal(hex(encode(nullValue())), '50564345010000');
  assert.equal(equal(decode(unhex('50564345010000'), LIMITS), nullValue()), true);
});

test('vector pvce.negative-integer-vector: -256 encodes to the frozen bytes', () => {
  // conformance/vectors/v1.json; crates/consema-pvce/src/lib.rs:1338-1341.
  assert.equal(hex(encode(integerValue(-256n))), '5056434501100402020100');
  assert.equal(equal(decode(unhex('5056434501100402020100'), LIMITS), integerValue(-256n)), true);
});

test('vector pvce.object-vector: {"a": 1} encodes to the frozen bytes', () => {
  // conformance/vectors/v1.json; crates/consema-pvce/src/lib.rs:1192-1201.
  const value = objectValue([{ key: 'a', value: integerValue(1n) }]);
  assert.equal(hex(encode(value)), '5056434501410a01200201611003010101');
  const decoded = decode(unhex('5056434501410a01200201611003010101'), LIMITS);
  assert.equal(equal(decoded, value), true);
});

test('vector pvce.reject-nonminimal-varint: non-minimal varint fails', () => {
  // conformance/vectors/v1.json; the expected failure name is
  // NonCanonicalVarint with code core.pvce.non-canonical-varint@1.
  assert.throws(
    () => decode(unhex('5056434581000000'), LIMITS),
    (e: unknown) =>
      (e as PVCEError).kind === 'NonCanonicalVarint' &&
      (e as PVCEError).code === 'core.pvce.non-canonical-varint@1',
  );
});

test('every core kind round-trips byte-exactly', () => {
  const date = dateValue(-12345n, 2, 28);
  const time = timeValue(23, 59, 58, decimalValue(125n, -3n));
  const local = localDateTimeValue(date, time);
  const mapping = entryMappingValue([
    { key: booleanValue(true), value: nullValue() },
  ]);
  const object = objectValue([
    { key: 'a', value: integerValue(1n) },
    { key: 'b', value: stringValue('中') },
  ]);
  const values: PortableValue[] = [
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
    sequenceValue(valuesOf()),
    object,
    mapping,
  ];
  for (const value of values) {
    const bytes = encode(value);
    const decoded = decode(bytes, LIMITS);
    assert.equal(equal(decoded, value), true, `round trip failed for ${value.kind}`);
    assert.deepEqual(encode(decoded), bytes, `re-encode changed bytes for ${value.kind}`);
  }
});

function valuesOf(): PortableValue[] {
  return [
    nullValue(),
    booleanValue(false),
    integerValue(1n),
    decimalValue(1n, -999n),
    stringValue('é'),
  ];
}

test('integer sign octets are 0/1/2 and magnitudes are minimal', () => {
  // crates/consema-pvce/src/lib.rs:545-554; zero has sign 0 and empty magnitude.
  assert.equal(hex(encode(integerValue(0n))), '505643450110020000');
  assert.equal(hex(encode(integerValue(256n))), '5056434501100401020100');
});

test('decimal canonicality is enforced on decode', () => {
  // A decimal with a trailing-zero coefficient (10 × 10^0) is non-canonical.
  // coefficient field = 03 01 01 0a (len 3: sign 1, mag len 1, byte 0x0a);
  // exponent field = 02 00 00 (len 2: sign 0, empty magnitude).
  const payload = [
    ...varintBytes(3n), 0x01, 0x01, 0x0a, // integer field: coefficient 10
    ...varintBytes(2n), 0x00, 0x00, // integer field: exponent 0
  ];
  const stream = streamForRecord(0x11, payload);
  assert.throws(
    () => decode(stream, LIMITS),
    (e: unknown) =>
      (e as PVCEError).kind === 'NonCanonicalDecimal' &&
      (e as PVCEError).code === 'core.pvce.non-canonical-decimal@1',
  );
});

/** Builds one complete stream whose root record has the given tag and payload. */
function streamForRecord(tag: number, payload: number[]): Uint8Array {
  return Uint8Array.from([
    0x50, 0x56, 0x43, 0x45, 0x01, tag, ...varintBytes(BigInt(payload.length)), ...payload,
  ]);
}

/** One String record for the given text: tag, blob length, then the length-prefixed bytes (lib.rs:1192-1201). */
function stringRecord(text: string): number[] {
  const bytes = new TextEncoder().encode(text);
  return [0x20, ...varintBytes(BigInt(bytes.length + 1)), ...varintBytes(BigInt(bytes.length)), ...bytes];
}

/** One Integer record for the given value. */
function integerRecord(value: bigint): number[] {
  return [0x10, ...varintBytes(BigInt(3n)), 0x01, 0x01, 0x01]; // sign 1, mag len 1, byte 1
}

test('decode rejects trailing bytes, bad magic, and unsupported versions', () => {
  assert.throws(() => decode(unhex('5056434501000000'), LIMITS), (e: unknown) =>
    (e as PVCEError).kind === 'TrailingBytes',
  );
  assert.throws(() => decode(unhex('50584345010000'), LIMITS), (e: unknown) =>
    (e as PVCEError).kind === 'InvalidMagic',
  );
  assert.throws(() => decode(unhex('50564345020100'), LIMITS), (e: unknown) =>
    (e as PVCEError).kind === 'UnsupportedVersion',
  );
});

test('decode rejects non-canonical zero integer and invalid sign octets', () => {
  // crates/consema-pvce/src/lib.rs:1327-1333: PVCE 1 TAG_INTEGER len 3 sign 1 mag-len 1 0x00.
  assert.throws(() => decode(unhex('50564345011003010100'), LIMITS), (e: unknown) =>
    (e as PVCEError).kind === 'NonCanonicalInteger',
  );
  assert.throws(() => decode(unhex('50564345011003030100'), LIMITS), (e: unknown) =>
    (e as PVCEError).kind === 'InvalidIntegerSign',
  );
});

test('object keys must be String records and duplicates are rejected', () => {
  // Key record is an Integer instead of a String record.
  const badKey = streamForRecord(0x41, [0x01, ...integerRecord(1n)]);
  assert.throws(() => decode(badKey, LIMITS), (e: unknown) =>
    (e as PVCEError).kind === 'ObjectKeyNotString',
  );
  // Two identical string keys "a" in one object.
  const duplicate = streamForRecord(0x41, [
    0x02,
    ...stringRecord('a'),
    ...integerRecord(1n),
    ...stringRecord('a'),
    ...integerRecord(1n),
  ]);
  assert.throws(
    () => decode(duplicate, LIMITS),
    (e: unknown) =>
      (e as PVCEError).kind === 'DuplicateObjectKey' &&
      (e as PVCEError).code === 'core.pvce.duplicate-object-key@1',
  );
});

test('string records must be valid UTF-8', () => {
  // TAG_STRING with a lone 0xff octet.
  const invalid = unhex('5056434501200201ff');
  assert.throws(() => decode(invalid, LIMITS), (e: unknown) =>
    (e as PVCEError).kind === 'InvalidUtf8',
  );
});

test('extended roots decode opaquely and core-only decode rejects them', () => {
  // crates/consema-pvce/src/lib.rs:1287-1314.
  const value = {
    typeId: 'example.uuid',
    semanticVersion: 1,
    payloadCodecId: 'example.raw@1',
    canonicalPayload: Uint8Array.of(1, 2, 3),
  };
  const bytes = encodeExtendedForTest(value);
  const root = decodeValue(bytes, LIMITS);
  assert.equal(root.kind, 'Extended');
  assert.deepEqual(root.value, value);
  assert.throws(() => decode(bytes, LIMITS), (e: unknown) =>
    (e as PVCEError).kind === 'ExpectedCore',
  );
});

function encodeExtendedForTest(value: {
  typeId: string;
  semanticVersion: number;
  payloadCodecId: string;
  canonicalPayload: Uint8Array;
}): Uint8Array {
  const encoder = new TextEncoder();
  const parts: number[] = [0x50, 0x56, 0x43, 0x45, 0x01, 0x7f];
  const blob = (bytes: Uint8Array): void => {
    parts.push(...varintBytes(BigInt(bytes.length)));
    parts.push(...bytes);
  };
  const typeId = encoder.encode(value.typeId);
  const codecId = encoder.encode(value.payloadCodecId);
  const payload: number[] = [];
  const payloadBlob = (bytes: Uint8Array): void => {
    payload.push(...varintBytes(BigInt(bytes.length)));
    payload.push(...bytes);
  };
  payloadBlob(typeId);
  payload.push(...varintBytes(BigInt(value.semanticVersion)));
  payloadBlob(codecId);
  payloadBlob(value.canonicalPayload);
  parts.push(...varintBytes(BigInt(payload.length)));
  parts.push(...payload);
  return Uint8Array.from(parts);
}

function varintBytes(value: bigint): number[] {
  const out: number[] = [];
  let v = value;
  for (;;) {
    let octet = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) {
      octet |= 0x80;
    }
    out.push(octet);
    if (v === 0n) {
      return out;
    }
  }
}

test('bounded encode enforces each resource limit atomically', () => {
  const value = sequenceValue([
    stringValue('12345'),
    stringValue('67890'),
    stringValue('abcde'),
  ]);
  const base = defaultEncodeLimits();
  assert.throws(
    () => encodeBounded(value, { ...base, maxBytes: 4 }),
    (e: unknown) => (e as PVCEError).field === 'stream-bytes',
  );
  assert.throws(
    () => encodeBounded(value, { ...base, maxNodes: 2 }),
    (e: unknown) => (e as PVCEError).field === 'value-nodes',
  );
  assert.throws(
    () => encodeBounded(value, { ...base, maxContainerEntries: 2 }),
    (e: unknown) => (e as PVCEError).field === 'container-entries',
  );
  assert.throws(
    () => encodeBounded(stringValue('12345'), { ...base, maxBlobBytes: 4 }),
    (e: unknown) => (e as PVCEError).field === 'blob-bytes',
  );
  assert.throws(
    () => encodeBounded(integerValue(0x0102n), { ...base, maxIntegerBytes: 1 }),
    (e: unknown) => (e as PVCEError).field === 'integer-bytes',
  );
  let nested: PortableValue = nullValue();
  for (let i = 0; i < 3; i++) {
    nested = sequenceValue([nested]);
  }
  assert.throws(
    () => encodeBounded(nested, { ...base, maxDepth: 2 }),
    (e: unknown) => (e as PVCEError).field === 'nesting-depth',
  );
  // The same limit names and defaults as the Rust decoder
  // (crates/consema-pvce/src/lib.rs:71-82).
  const limits: EncodeLimits = defaultEncodeLimits();
  assert.equal(limits.maxDepth, 256);
  assert.equal(limits.maxNodes, 1_000_000);
});

test('decode resource limits reject oversized streams', () => {
  assert.throws(
    () => decode(encode(stringValue('x')), { ...LIMITS, maxBytes: 6 }),
    (e: unknown) =>
      (e as PVCEError).kind === 'ResourceLimit' &&
      (e as PVCEError).field === 'stream-bytes',
  );
});

test('varint overflow beyond 64 bits is rejected', () => {
  // Version varint with 10 continuation octets overflows.
  const stream = Uint8Array.from([
    0x50, 0x56, 0x43, 0x45, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
  ]);
  assert.throws(() => decode(stream, LIMITS), (e: unknown) =>
    (e as PVCEError).kind === 'VarintOverflow',
  );
});

test('encode rejects structurally invalid dates with invalid-value', () => {
  const invalid: PortableValue = { kind: 'Date', year: 0n, month: 0, day: 0 };
  assert.throws(() => encode(invalid), (e: unknown) =>
    (e as PVCEError).kind === 'InvalidValue',
  );
});

test('pvceError builds typed errors carrying the frozen code', () => {
  const error = pvceError('ResourceLimit', { field: 'nesting-depth' });
  assert.equal(error.code, 'core.pvce.resource-limit@1');
  assert.equal(error.kind, 'ResourceLimit');
  assert.equal(error.field, 'nesting-depth');
  assert.ok(error instanceof Error);
});
