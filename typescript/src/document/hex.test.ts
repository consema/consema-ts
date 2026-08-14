/**
 * Test-only hex helpers (document/hex.ts). The strict decode path is
 * aligned with the same-family strict precedents (conformance/helpers.ts
 * hexToBytes, plist/materialization.ts decodeHex); W4-22 locks the
 * full-character rejection ('0g' / 'fz' must not be silently truncated).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeHex, encodeHex } from './hex.ts';

test('hex: decodeHex round-trips through encodeHex', () => {
  const bytes = Uint8Array.from([0x00, 0x61, 0x42, 0xff, 0x10]);
  assert.deepEqual(decodeHex(encodeHex(bytes)), bytes);
  assert.deepEqual(decodeHex(''), new Uint8Array(0));
  assert.deepEqual(decodeHex('616263'), Uint8Array.from([0x61, 0x62, 0x63]));
});

test('hex: decodeHex rejects a pair with a hex digit followed by a non-hex character', () => {
  // Number.parseInt('0g', 16) === 0 and Number.parseInt('fz', 16) === 15
  // (silent truncation) — the full-character check must reject both.
  assert.throws(() => decodeHex('0g'), RangeError, '0g must be rejected');
  assert.throws(() => decodeHex('fz'), RangeError, 'fz must be rejected');
  assert.throws(() => decodeHex('6z'), RangeError, '6z must be rejected');
});

test('hex: decodeHex rejects odd length and non-hex characters', () => {
  assert.throws(() => decodeHex('abc'), RangeError, 'odd length');
  assert.throws(() => decodeHex('zz'), RangeError, 'non-hex pair');
  assert.throws(() => decodeHex('61 62'), RangeError, 'space is not hex');
  assert.throws(() => decodeHex('GG'), RangeError, 'uppercase non-hex');
});
