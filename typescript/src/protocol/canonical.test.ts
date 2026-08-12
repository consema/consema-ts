/**
 * Canonical tagged JSON transport intent tests.
 *
 * The golden bytes are pinned by conformance/vectors/protocol-v1.json
 * (protocol.json.null-vector) and the RFC 0015 搂4.4 envelope example; the
 * all-kinds round trip follows protocol.json.all-kinds-roundtrip. They run
 * once the toolchain is ready; no gate is claimed before that (搂7 START GATE).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EncodeJSON, DecodeJSON, PortableValueJSONSchema } from './canonical.ts';
import { defaultProtocolLimits } from './limits.ts';
import {
  nullValue,
  booleanValue,
  stringValue,
  integerValue,
  decimalValue,
  binaryFloat32Value,
  binaryFloat64Value,
  bytesValue,
  dateValue,
  timeValue,
  localDateTimeValue,
  offsetDateTimeValue,
  sequenceValue,
  objectValue,
  entryMappingValue,
} from '../core/value.ts';
import type { PortableValue } from '../core/value.ts';
import { equal } from '../core/equal.ts';
import { ProtocolError } from './errors.ts';

const LIMITS = defaultProtocolLimits();

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

test('vector protocol.json.null-vector: null encodes to the frozen envelope bytes', () => {
  // conformance/vectors/protocol-v1.json.
  assert.equal(
    text(EncodeJSON(nullValue(), LIMITS)),
    '{"schema":"core.portable-value-json@1","value":{"type":"Null"}}',
  );
  assert.equal(PortableValueJSONSchema, 'core.portable-value-json@1');
  const decoded = DecodeJSON(new TextEncoder().encode('{"schema":"core.portable-value-json@1","value":{"type":"Null"}}'), LIMITS);
  assert.equal(equal(decoded, nullValue()), true);
});

test('all fifteen kinds round-trip byte-exactly', () => {
  const date = dateValue(-12345n, 2, 28);
  const time = timeValue(23, 59, 58, decimalValue(125n, -3n));
  const local = localDateTimeValue(date, time);
  const values: PortableValue[] = [
    nullValue(),
    booleanValue(true),
    stringValue('涓?'),
    integerValue(123456789012345678901234567890n),
    decimalValue(1n, -999n),
    binaryFloat32Value(0x7fc00001),
    binaryFloat64Value(0x8000000000000000n),
    bytesValue(Uint8Array.of(0, 255, 16)),
    date,
    time,
    local,
    offsetDateTimeValue(local, -23 * 60 * 60),
    sequenceValue([stringValue('a'), nullValue()]),
    objectValue([{ key: 'a', value: integerValue(1n) }]),
    entryMappingValue([{ key: booleanValue(true), value: bytesValue(Uint8Array.of(1)) }]),
  ];
  for (const value of values) {
    const bytes = EncodeJSON(value, LIMITS);
    const decoded = DecodeJSON(bytes, LIMITS);
    assert.equal(equal(decoded, value), true, `JSON round trip failed for ${value.kind}`);
    assert.deepEqual(EncodeJSON(decoded, LIMITS), bytes, `JSON re-encode changed bytes for ${value.kind}`);
  }
});

test('vector protocol.json.reject-whitespace: whitespace is not canonical', () => {
  // conformance/vectors/protocol-v1.json.
  const input = '{"schema":"core.portable-value-json@1", "value":{"type":"Null"}}';
  assert.throws(
    () => DecodeJSON(new TextEncoder().encode(input), LIMITS),
    (error: unknown) => (error as ProtocolError).code === 'core.protocol.non-canonical-json@1',
  );
});

test('vector protocol.json.reject-alternate-escape: alternate escapes are not canonical', () => {
  // conformance/vectors/protocol-v1.json.
  const input = '{"schema":"core.portable-value-json@1","value":{"type":"String","value":"\\u0041"}}';
  assert.throws(
    () => DecodeJSON(new TextEncoder().encode(input), LIMITS),
    (error: unknown) => (error as ProtocolError).code === 'core.protocol.non-canonical-json@1',
  );
});

test('vector protocol.json.reject-unknown-field: unknown fields are rejected', () => {
  // conformance/vectors/protocol-v1.json.
  const input = '{"schema":"core.portable-value-json@1","value":{"type":"Null"},"extra":1}';
  assert.throws(
    () => DecodeJSON(new TextEncoder().encode(input), LIMITS),
    (error: unknown) => (error as ProtocolError).code === 'core.protocol.unknown-field@1',
  );
});

test('invalid JSON, duplicate members, and schema mismatches are rejected', () => {
  assert.throws(
    () => DecodeJSON(new TextEncoder().encode('{"schema":"core.portable-value-json@1","value":}'), LIMITS),
    (error: unknown) => (error as ProtocolError).code === 'core.protocol.invalid-json@1',
  );
  assert.throws(
    () =>
      DecodeJSON(
        new TextEncoder().encode(
          '{"schema":"core.portable-value-json@1","schema":"core.portable-value-json@1","value":{"type":"Null"}}',
        ),
        LIMITS,
      ),
    (error: unknown) => (error as ProtocolError).code === 'core.protocol.invalid-json@1',
  );
  assert.throws(
    () =>
      DecodeJSON(
        new TextEncoder().encode('{"schema":"core.portable-value-json@2","value":{"type":"Null"}}'),
        LIMITS,
      ),
    (error: unknown) => (error as ProtocolError).code === 'core.protocol.schema-mismatch@1',
  );
});

test('documented divergence (Rust wins): non-canonical decimals are rejected via normalization', () => {
  // The Rust decoder re-encodes the decoded VALUE (value_transport.rs:66-73),
  // so {"coefficient":"10","exponent":"0"} normalizes to 1e1 and the
  // re-encode differs from the input. The Go implementation re-encodes the
  // parse tree and would accept this input (go/protocol/canonical.go:487-512);
  // TypeScript follows Rust. Recorded for the parity review.
  const input =
    '{"schema":"core.portable-value-json@1","value":{"type":"Decimal","coefficient":"10","exponent":"0"}}';
  assert.throws(
    () => DecodeJSON(new TextEncoder().encode(input), LIMITS),
    (error: unknown) => (error as ProtocolError).code === 'core.protocol.non-canonical-json@1',
  );
});

test('uppercase hex and non-minimal integers are not canonical', () => {
  const upper = '{"schema":"core.portable-value-json@1","value":{"type":"Bytes","hex":"00FF"}}';
  assert.throws(() => DecodeJSON(new TextEncoder().encode(upper), LIMITS), (error: unknown) =>
    (error as ProtocolError).code === 'core.protocol.non-canonical-json@1',
  );
  const padded = '{"schema":"core.portable-value-json@1","value":{"type":"Integer","value":"007"}}';
  assert.throws(() => DecodeJSON(new TextEncoder().encode(padded), LIMITS), (error: unknown) =>
    (error as ProtocolError).code === 'core.protocol.non-canonical-json@1',
  );
  // Lowercase hex is canonical.
  const lower = '{"schema":"core.portable-value-json@1","value":{"type":"Bytes","hex":"00ff"}}';
  assert.doesNotThrow(() => DecodeJSON(new TextEncoder().encode(lower), LIMITS));
});

test('the RFC 0015 搂4.4 envelope shape is the transport form', () => {
  // The envelope record is an Object whose first field is schema; the
  // tagged payload is the second field (RFC 0015 搂4.4).
  const bytes = EncodeJSON(nullValue(), LIMITS);
  const asText = text(bytes);
  assert.ok(asText.startsWith('{"schema":"core.portable-value-json@1","value":'));
  assert.ok(asText.endsWith('}'));
  assert.equal(asText.includes(' '), false);
});

test('transport limits apply on both directions', () => {
  const small = { ...LIMITS, maxBytes: 40 };
  const bytes = EncodeJSON(nullValue(), LIMITS);
  assert.throws(() => DecodeJSON(bytes, small), (error: unknown) =>
    (error as ProtocolError).code === 'core.protocol.resource-limit@1',
  );
  const deep = sequenceValue([sequenceValue([nullValue()])]);
  const deepLimits = { ...LIMITS, maxDepth: 1 };
  assert.throws(() => EncodeJSON(deep, deepLimits), (error: unknown) =>
    (error as ProtocolError).code === 'core.protocol.resource-limit@1',
  );
});

test('surrogate pair escapes decode and re-encode canonically', () => {
  // U+1F600 must combine into one scalar, but the escaped surrogate spelling
  // is non-canonical: the canonical form carries the raw scalar, so the
  // re-encode check rejects the escaped input (value_transport.rs:66-73;
  // the same rule as vector protocol.json.reject-alternate-escape).
  const escaped =
    '{"schema":"core.portable-value-json@1","value":{"type":"String","value":"\\uD83D\\uDE00"}}';
  assert.throws(
    () => DecodeJSON(new TextEncoder().encode(escaped), LIMITS),
    (error: unknown) => (error as ProtocolError).code === 'core.protocol.non-canonical-json@1',
  );
  // The canonical form carries the raw scalar.
  const canonical = '{"schema":"core.portable-value-json@1","value":{"type":"String","value":"\u{1F600}"}}';
  const decoded = DecodeJSON(new TextEncoder().encode(canonical), LIMITS);
  assert.equal(decoded.kind, 'String');
  assert.equal(decoded.value, '\u{1F600}');
});

test('control characters escape as \\uXXXX in strings', () => {
  const value = stringValue('a' + String.fromCharCode(1) + 'b');
  const bytes = EncodeJSON(value, LIMITS);
  assert.ok(text(bytes).includes('\\u0001'));
  assert.equal(equal(DecodeJSON(bytes, LIMITS), value), true);
});
