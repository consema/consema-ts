/**
 * Shared helpers of the TS conformance runner (mirror of the Rust runner
 * helpers, crates/consema-conformance/src/lib.rs:195-458).
 *
 * The vectors are strict JSON; inputs use string spellings for arbitrary
 * precision and wire bytes. These helpers convert between the vector
 * spellings and the implementation's PortableValue/bytes, and implement the
 * expectation comparison (codes, bytes, strict_equal, counts).
 */

import { createHash } from 'node:crypto';
import type { PortableValue, ObjectEntry } from '../core/value.ts';
import {
  binaryFloat64Value,
  decimalValue,
  entryMappingValue,
  integerValue,
  nullValue,
  objectValue,
  sequenceValue,
  stringValue,
} from '../core/value.ts';
import { ProfileId } from '../document/profile.ts';
import { parseDocument, Document } from '../registry.ts';

// ---------------------------------------------------------------------------
// Byte and text spellings
// ---------------------------------------------------------------------------

/** UTF-8 bytes of one text string. */
export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** UTF-8 text of one byte buffer. */
export function text(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/** Lowercase hex of one byte buffer. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const octet of bytes) {
    out += octet.toString(16).padStart(2, '0');
  }
  return out;
}

/** One byte buffer from a lowercase hex spelling. */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    throw new Error(`invalid hex spelling: ${hex}`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** SHA-256 hex digest of one byte buffer (node:crypto, a Node builtin). */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// Expectation checking
// ---------------------------------------------------------------------------

/** Fails the current case with a message. */
export function fail(message: string): never {
  throw new ConformanceFailure(message);
}

/** Asserts one boolean fact. */
export function expect(condition: boolean, message: string): void {
  if (!condition) {
    fail(message);
  }
}

/** Asserts deep equality between two plain-JS vector facts. */
export function expectEqual(actual: unknown, expected: unknown, label: string): void {
  if (!deepEqual(actual, expected)) {
    fail(`${label}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`);
  }
}

/** Asserts one byte buffer equals one vector string (or byte buffer). */
export function expectBytes(actual: Uint8Array, expected: string | Uint8Array, label: string): void {
  const expectedBytes = typeof expected === 'string' ? utf8(expected) : expected;
  if (!bytesEqual(actual, expectedBytes)) {
    fail(
      `${label}: expected ${JSON.stringify(typeof expected === 'string' ? expected : toHex(expected))}, observed ${JSON.stringify(text(actual))}`,
    );
  }
}

/** Asserts an error carries the exact frozen code. */
export function expectCode(error: unknown, code: string): void {
  const observed = (error as { code?: unknown } | null)?.code;
  if (observed !== code) {
    fail(`expected code ${code}, observed ${JSON.stringify(observed)} (${String(error)})`);
  }
}

/** Asserts the formation status name. */
export function expectFormation(status: FormationStatusName, expected: string, label = 'formation'): void {
  if (status !== expected) {
    fail(`${label}: expected ${expected}, observed ${status}`);
  }
}

/** One case-level failure carrying a stable description. */
export class ConformanceFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConformanceFailure';
  }
}

export type FormationStatusName = 'Complete' | 'Recovered' | 'FatalFormationFailure';

/** The document formation status name, including the fatal spelling. */
export function formationStatusName(document: Document): FormationStatusName {
  return document.formationStatus();
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

/** Plain-JS deep equality over JSON-able values. */
export function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (typeof left === 'object' && left !== null && typeof right === 'object' && right !== null) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      deepEqual(leftKeys, rightKeys) &&
      leftKeys.every((key) => deepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Vector value descriptors → PortableValue
// ---------------------------------------------------------------------------

/**
 * Builds a PortableValue from the compact vector descriptors: `"Null"`,
 * booleans, strings, `{"integer": "..."}`, `{"decimal": "..."}`,
 * `{"string": "..."}`, `{"binary64_bits": "..."}`, `{"sequence": [...]}`,
 * `{"object": {...}}`, and bare objects (Rust value_from_input,
 * lib.rs:989-1049).
 */
export function valueFromInput(input: unknown): PortableValue {
  if (input === null) {
    return nullValue();
  }
  if (typeof input === 'boolean' || typeof input === 'string') {
    return input === 'Null' ? nullValue() : typeof input === 'boolean' ? { kind: 'Boolean', value: input } : stringValue(input);
  }
  if (typeof input === 'number') {
    return integerValue(BigInt(input));
  }
  if (typeof input === 'object' && Array.isArray(input)) {
    return sequenceValue(input.map((item) => valueFromInput(item)));
  }
  const record = input as Record<string, unknown>;
  if ('integer' in record && typeof record.integer === 'string') {
    return integerValue(BigInt(record.integer));
  }
  if ('decimal' in record && typeof record.decimal === 'string') {
    const parsed = parseJsonNumber(record.decimal);
    if (parsed === null) {
      throw new Error(`unrepresentable decimal ${record.decimal}`);
    }
    return parsed;
  }
  if ('string' in record && typeof record.string === 'string') {
    return stringValue(record.string);
  }
  if ('binary64_bits' in record && typeof record.binary64_bits === 'string') {
    return binaryFloat64Value(BigInt(`0x${record.binary64_bits}`));
  }
  if ('sequence' in record) {
    const elements = record.sequence;
    if (Array.isArray(elements)) {
      return sequenceValue(elements.map((item) => valueFromInput(item)));
    }
  }
  if ('object' in record && typeof record.object === 'object' && record.object !== null) {
    return objectValueFromRecord(record.object as Record<string, unknown>);
  }
  // Bare object descriptor without a wrapping key.
  return objectValueFromRecord(record);
}

/** One unique-key Object from a plain descriptor. */
function objectValueFromRecord(record: Record<string, unknown>): PortableValue {
  const entries: ObjectEntry[] = [];
  for (const key of Object.keys(record)) {
    entries.push({ key, value: valueFromInput(record[key]) });
  }
  return objectValue(entries);
}

/** Parses one decimal JSON spelling to the canonical Decimal. */
export function parseJsonNumber(text: string): PortableValue | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (match === null) {
    return null;
  }
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = match[2];
  const fraction = match[3] ?? '';
  const exponent = BigInt(match[4] ?? '0');
  const digits = whole + fraction;
  const coefficient = sign * BigInt(digits);
  const scale = exponent - BigInt(fraction.length);
  return decimalValue(coefficient, scale);
}

/** Entry-mapping descriptor: an array of [key, value] pairs. */
export function entryMappingFromPairs(pairs: readonly (readonly [unknown, unknown])[]): PortableValue {
  return entryMappingValue(
    pairs.map(([key, value]) => ({ key: valueFromInput(key), value: valueFromInput(value) })),
  );
}

// ---------------------------------------------------------------------------
// Vector case accessors
// ---------------------------------------------------------------------------

export interface VectorCase {
  readonly id: string;
  readonly capability?: string;
  readonly contract?: string;
  readonly input?: unknown;
  readonly expected: Record<string, unknown>;
}

/** One input field of a case. */
export function caseField(case_: VectorCase, name: string): unknown {
  const input = case_.input;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`missing input.${name}`);
  }
  const value = (input as Record<string, unknown>)[name];
  if (value === undefined) {
    throw new Error(`missing input.${name}`);
  }
  return value;
}

/** One optional input field of a case. */
export function caseFieldOptional(case_: VectorCase, name: string): unknown {
  const input = case_.input;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return undefined;
  }
  return (input as Record<string, unknown>)[name];
}

/** One expected field of a case. */
export function expectedField(case_: VectorCase, name: string): unknown {
  const value = case_.expected[name];
  if (value === undefined) {
    throw new Error(`missing expected.${name}`);
  }
  return value;
}

/** One optional expected field of a case. */
export function expectedFieldOptional(case_: VectorCase, name: string): unknown {
  return case_.expected[name];
}

/** The input `source` string. */
export function sourceOf(case_: VectorCase): string {
  return caseField(case_, 'source') as string;
}

// ---------------------------------------------------------------------------
// Facade parsing by vector profile id
// ---------------------------------------------------------------------------

/** Parses one snapshot under a vector profile id ("json.strict@1"). */
export function parseProfile(source: string | Uint8Array, profileId: string): Document {
  const bytes = typeof source === 'string' ? utf8(source) : source;
  const [id] = profileId.split('@');
  return parseDocument(bytes, new ProfileId(id, 1));
}
