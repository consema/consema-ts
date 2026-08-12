/**
 * Exact Java UTF-16 code-unit strings (`core.java-utf16-string@1`).
 *
 * authority: crates/consema-protocol/src/java_utf16.rs (the exact record
 * shape, the resource limits, the canonical 4-digit uppercase unit
 * spellings, and the surrogate well-formedness classification); the
 * canonical JSON/PVCE envelope bytes of this record are pinned by
 * conformance/vectors/semantic-model-v6.json
 * (protocol.new-contract-canonical-bytes). Construction and wire decoding
 * enforce the same container/blob limits so no exact string can enter the
 * record through a path that bypasses them.
 */

import type { ObjectValue, PortableValue } from '../core/value.ts';
import { equal as valueEqual } from '../core/equal.ts';
import { defaultProtocolLimits } from './limits.ts';
import type { ProtocolLimits } from './limits.ts';
import { schemaFields, stringOf, sequenceOf, objectValueFrom } from './records.ts';
import { invalid, protocolError, resource } from './errors.ts';
import { registerPayloadValidator } from './payload_validators.ts';

/** Whether an exact Java UTF-16 string is also well-formed Unicode. */
export type JavaUnicodeStatus = 'WellFormedUnicode' | 'UnpairedSurrogate';

/** Exact Java string content transported as canonical big-endian UTF-16 units. */
export class JavaUtf16String {
  readonly #codeUnits: readonly number[];
  readonly #bytes: Uint8Array;
  readonly #unicodeStatus: JavaUnicodeStatus;

  private constructor(codeUnits: readonly number[], bytes: Uint8Array, unicodeStatus: JavaUnicodeStatus) {
    this.#codeUnits = Object.freeze([...codeUnits]);
    this.#bytes = bytes;
    this.#unicodeStatus = unicodeStatus;
  }

  /** Builds an exact string while enforcing the same limits as wire decoding (java_utf16.rs:27-52). */
  static new(units: readonly number[], limits: ProtocolLimits): JavaUtf16String {
    for (const unit of units) {
      if (!Number.isInteger(unit) || unit < 0 || unit > 0xffff) {
        throw invalid('$.code_units', 'code unit must fit u16');
      }
    }
    checkUnitCount(units.length, limits);
    const byteLen = units.length * 2;
    if (byteLen > limits.maxBlobBytes) {
      throw resource('$.bytes', 'UTF-16 bytes exceed the configured blob limit');
    }
    const bytes = new Uint8Array(byteLen);
    for (let index = 0; index < units.length; index++) {
      bytes[index * 2] = (units[index] >> 8) & 0xff;
      bytes[index * 2 + 1] = units[index] & 0xff;
    }
    return new JavaUtf16String(units, bytes, classify(units));
  }

  /** Exact ordered UTF-16 code units. */
  codeUnits(): readonly number[] {
    return this.#codeUnits;
  }

  /** The same units as BOM-free, big-endian bytes; logically immutable. */
  bytes(): Uint8Array {
    return this.#bytes;
  }

  /** Recomputed Unicode well-formedness classification. */
  unicodeStatus(): JavaUnicodeStatus {
    return this.#unicodeStatus;
  }

  /** Encodes `core.java-utf16-string@1` in canonical field order (java_utf16.rs:74-89). */
  toValue(): ObjectValue {
    return objectValueFrom([
      { key: 'schema', value: { kind: 'String', value: 'core.java-utf16-string@1' } },
      { key: 'encoding', value: { kind: 'String', value: 'UTF16BE/1' } },
      {
        key: 'code_units',
        value: {
          kind: 'Sequence',
          items: this.#codeUnits.map((unit) => ({
            kind: 'String',
            value: unit.toString(16).toUpperCase().padStart(4, '0'),
          })),
        },
      },
      { key: 'bytes', value: { kind: 'Bytes', value: Uint8Array.from(this.#bytes) } },
      { key: 'unicode_status', value: { kind: 'String', value: this.#unicodeStatus } },
    ]);
  }

  /** Strictly decodes and canonically re-verifies one exact Java string (java_utf16.rs:93-168). */
  static fromValue(value: PortableValue, limits: ProtocolLimits): JavaUtf16String {
    const fields = schemaFields(
      value,
      'core.java-utf16-string@1',
      ['encoding', 'code_units', 'bytes', 'unicode_status'],
      '$',
    );
    if (stringOf(fields[0], '$.encoding') !== 'UTF16BE/1') {
      throw invalid('$.encoding', 'expected exact encoding UTF16BE/1');
    }
    const encodedUnits = sequenceOf(fields[1], '$.code_units');
    checkUnitCount(encodedUnits.length, limits);
    const bytes = fields[2];
    if (bytes.kind !== 'Bytes') {
      throw protocolError('WrongType', '$.bytes', 'expected Bytes');
    }
    if (bytes.value.length > limits.maxBlobBytes) {
      throw resource('$.bytes', 'UTF-16 bytes exceed the configured blob limit');
    }
    if (bytes.value.length % 2 !== 0) {
      throw invalid('$.bytes', 'UTF-16 byte length must be even');
    }
    if (bytes.value.length !== encodedUnits.length * 2) {
      throw invalid('$.bytes', 'byte count does not equal two bytes per code unit');
    }
    const codeUnits: number[] = [];
    for (let index = 0; index < encodedUnits.length; index++) {
      const path = `$.code_units[${index}]`;
      const text = stringOf(encodedUnits[index], path);
      const unit = parseUnit(text);
      if (unit === undefined) {
        throw invalid(path, 'code unit must be exactly four uppercase hexadecimal digits');
      }
      if (bytes.value[index * 2] !== (unit >> 8) || bytes.value[index * 2 + 1] !== (unit & 0xff)) {
        throw invalid(path, 'code unit and byte representation differ');
      }
      codeUnits.push(unit);
    }
    const status = parseStatus(stringOf(fields[3], '$.unicode_status'));
    const decoded = JavaUtf16String.new(codeUnits, limits);
    if (decoded.unicodeStatus() !== status) {
      throw invalid('$.unicode_status', 'status does not match exact surrogate pairing');
    }
    if (!valueEqual(decoded.toValue(), value)) {
      throw invalid('$', 'Java UTF-16 string is not canonically encoded');
    }
    return decoded;
  }
}

/** The container-entry limit on the unit list (java_utf16.rs:171-179). */
function checkUnitCount(count: number, limits: ProtocolLimits): void {
  if (count > limits.maxContainerEntries) {
    throw resource('$.code_units', 'code-unit count exceeds the configured container limit');
  }
}

/** Parses one exactly-four-digit uppercase hexadecimal unit (java_utf16.rs:181-190). */
function parseUnit(value: string): number | undefined {
  if (value.length !== 4 || !/^[0-9A-F]{4}$/.test(value)) {
    return undefined;
  }
  return Number.parseInt(value, 16);
}

/** Classifies surrogate pairing (java_utf16.rs:192-208). */
function classify(units: readonly number[]): JavaUnicodeStatus {
  let index = 0;
  while (index < units.length) {
    const unit = units[index];
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = units[index + 1];
      if (next !== undefined && next >= 0xdc00 && next <= 0xdfff) {
        index += 2;
        continue;
      }
      return 'UnpairedSurrogate';
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      return 'UnpairedSurrogate';
    }
    index += 1;
  }
  return 'WellFormedUnicode';
}

/** Parses one canonical status spelling (java_utf16.rs:217-223). */
function parseStatus(value: string): JavaUnicodeStatus {
  switch (value) {
    case 'WellFormedUnicode':
      return 'WellFormedUnicode';
    case 'UnpairedSurrogate':
      return 'UnpairedSurrogate';
    default:
      throw invalid('$.unicode_status', 'unknown Unicode status');
  }
}

// Full envelope payload validation (payload.rs): the common envelope
// decodes every `core.java-utf16-string@1` payload through this decoder.
registerPayloadValidator('core.java-utf16-string', 1, (payload) => {
  JavaUtf16String.fromValue(payload, defaultProtocolLimits());
});
