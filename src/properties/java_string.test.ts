/**
 * Intent documents for the exact Java UTF-16 string model.
 *
 * Golden transcriptions from the shared vectors — each test cites its
 * case id:
 *  - conformance/vectors/java-properties-v1.json:
 *    formation.escape-and-java-utf16-matrix (:31-34),
 *    formation.latin1-byte-and-bom-content (:51-54)
 *  - RFC 0010 §4 (:108-131) freezes the JavaString contract
 *  - crates/consema-properties/src/lib.rs:124-206 (JavaString), :814-830
 *    (classify_java_string), :838-848 (exact-unit preservation test)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { JavaString, JavaStringConversionError } from '../properties/java_string.ts';

test('java string preserves exact code units and UTF16BE/1 bytes (lib.rs:838-848)', () => {
  const exact = JavaString.fromCodeUnits([0x0041, 0xd800, 0x0042]);
  assert.deepEqual(exact.codeUnits(), [0x0041, 0xd800, 0x0042]);
  assert.deepEqual(Array.from(exact.utf16beBytes()), [0x00, 0x41, 0xd8, 0x00, 0x00, 0x42]);
  assert.equal(exact.status(), 'UnpairedSurrogate');
  assert.throws(() => exact.toUnicode(), JavaStringConversionError);

  const scalar = JavaString.fromUnicode('😀');
  assert.deepEqual(scalar.codeUnits(), [0xd83d, 0xde00]);
  assert.equal(scalar.toUnicode(), '😀');
  assert.equal(scalar.status(), 'WellFormedUnicode');
});

test('formation.escape-and-java-utf16-matrix: UTF16BE/1 hex and statuses (java-properties-v1.json:32-33)', () => {
  const cases: readonly { hex: string; status: string }[] = [
    { hex: '0009000a000d000c', status: 'WellFormedUnicode' },
    { hex: '005c', status: 'WellFormedUnicode' },
    { hex: '0071', status: 'WellFormedUnicode' },
    { hex: '005c00750030003000340031', status: 'WellFormedUnicode' },
    { hex: 'd83dde00', status: 'WellFormedUnicode' },
    { hex: 'd800', status: 'UnpairedSurrogate' },
    { hex: 'dc00', status: 'UnpairedSurrogate' },
    { hex: 'd8000041', status: 'UnpairedSurrogate' },
    { hex: '0041dc00', status: 'UnpairedSurrogate' },
  ];
  for (const sample of cases) {
    const java = JavaString.fromCodeUnits(hexUnits(sample.hex));
    assert.equal(java.utf16beHex(), sample.hex);
    assert.equal(java.status(), sample.status);
  }
});

test('formation.latin1-byte-and-bom-content: Latin-1 bytes become exact code units (java-properties-v1.json:52-53)', () => {
  // The Latin-1 bytes EF BB BF 6B decode to U+00EF U+00BB U+00BF U+006B —
  // a BOM byte sequence with no BOM meaning (RFC 0010 §3.2).
  const key = JavaString.fromCodeUnits([0x00ef, 0x00bb, 0x00bf, 0x006b]);
  assert.equal(key.utf16beHex(), '00ef00bb00bf006b');
  assert.equal(key.status(), 'WellFormedUnicode');
  const value = JavaString.fromCodeUnits([0x00ff]);
  assert.equal(value.utf16beHex(), '00ff');
});

test('exact equality is over code units, never Unicode normalization (lib.rs:182-194)', () => {
  const composed = JavaString.fromUnicode('é');
  const escaped = JavaString.fromCodeUnits([0x00e9]);
  assert.ok(composed.equals(escaped));
  assert.ok(!composed.equals(JavaString.fromCodeUnits([0x0065, 0x0301])));
});

test('a supplementary scalar round-trips through its surrogate pair (lib.rs:845-847)', () => {
  const emoji = JavaString.fromUnicode('😀');
  assert.equal(emoji.utf16beHex(), 'd83dde00');
  assert.equal(emoji.toUnicode(), '😀');
});

function hexUnits(hex: string): number[] {
  const units: number[] = [];
  for (let index = 0; index < hex.length; index += 4) {
    units.push(Number.parseInt(hex.slice(index, index + 4), 16));
  }
  return units;
}
