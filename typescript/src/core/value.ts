/**
 * The closed fifteen-kind PortableValue model.
 *
 * authority (language-neutral data sources):
 *  - kind registry: consema-rs/consema-core/src/value.rs (PortableValueKind
 *    order: Null, Boolean, Integer, Decimal, BinaryFloat32, BinaryFloat64,
 *    String, Bytes, Date, Time, LocalDateTime, OffsetDateTime, Sequence,
 *    Object, EntryMapping); the kind spellings double as the canonical JSON
 *    transport tags (conformance/vectors/protocol-v1.json, RFC 0016 §4.1)
 *  - decimal normalization: consema-rs/consema-core/src/value.rs
 *  - temporal validation: consema-rs/consema-core/src/value.rs (date),
 *    (time), (offset), is_fraction
 *  - object uniqueness / entry-mapping duplicates:
 *    consema-rs/consema-core/src/value.rs; RFC 0002 object contract
 *
 * Design (TypeScript-idiomatic): the model is a closed discriminated union
 * over the `kind` discriminant. Exhaustive switches on `kind` are checked by
 * the compiler, so an unknown kind cannot be silently accepted (RFC 0016
 * §4.1: "no default that silently accepts unknown kinds"). Values are plain
 * frozen-style objects; every factory validates and normalizes at
 * construction time so a PortableValue is always canonical. Arbitrary
 * precision uses the native `bigint`; bytes are `Uint8Array`; exact
 * IEEE-754 datums are carried as raw bit patterns (BinaryFloat32 as uint32,
 * BinaryFloat64 as uint64) — NaN payloads and the sign of zero survive
 * exactly, as the identity of these kinds is their bit pattern.
 */

import {
  PVCEError,
  codeInvalidValue,
  codeInvalidTemporal,
  codeResourceLimit,
} from './errors.ts';

/** Object key entry: a unique key and its value. */
export interface ObjectEntry {
  readonly key: string;
  readonly value: PortableValue;
}

/** Entry-mapping association: arbitrary key, duplicates allowed. */
export interface EntryMappingEntry {
  readonly key: PortableValue;
  readonly value: PortableValue;
}

export interface NullValue {
  readonly kind: 'Null';
}
export interface BooleanValue {
  readonly kind: 'Boolean';
  readonly value: boolean;
}
export interface StringValue {
  readonly kind: 'String';
  readonly value: string;
}
export interface BytesValue {
  /** Octet sequence; Bytes and String are always different kinds. */
  readonly kind: 'Bytes';
  readonly value: Uint8Array;
}
export interface IntegerValue {
  readonly kind: 'Integer';
  readonly value: bigint;
}
export interface DecimalValue {
  /** Canonical exact finite decimal, coefficient × 10^exponent. */
  readonly kind: 'Decimal';
  readonly coefficient: bigint;
  readonly exponent: bigint;
}
export interface BinaryFloat32Value {
  /** Exact IEEE-754 binary32 bits as an unsigned 32-bit pattern. */
  readonly kind: 'BinaryFloat32';
  readonly bits: number;
}
export interface BinaryFloat64Value {
  /** Exact IEEE-754 binary64 bits as an unsigned 64-bit pattern. */
  readonly kind: 'BinaryFloat64';
  readonly bits: bigint;
}
export interface DateValue {
  /** Proleptic Gregorian date, astronomical year numbering. */
  readonly kind: 'Date';
  readonly year: bigint;
  readonly month: number; // 1-12
  readonly day: number;
}
export interface TimeValue {
  /** Wall-clock time, exact fractional second in [0, 1). */
  readonly kind: 'Time';
  readonly hour: number; // 0-23
  readonly minute: number; // 0-59
  readonly second: number; // 0-59
  readonly fraction: DecimalValue;
}
export interface LocalDateTimeValue {
  readonly kind: 'LocalDateTime';
  readonly date: DateValue;
  readonly time: TimeValue;
}
export interface OffsetDateTimeValue {
  /** Local date-time plus a fixed UTC offset in whole seconds. */
  readonly kind: 'OffsetDateTime';
  readonly local: LocalDateTimeValue;
  readonly offsetSeconds: number;
}
export interface SequenceValue {
  readonly kind: 'Sequence';
  readonly items: readonly PortableValue[];
}
export interface ObjectValue {
  /** Ordered unique-key object; entry order is a language-neutral fact. */
  readonly kind: 'Object';
  readonly entries: readonly ObjectEntry[];
}
export interface EntryMappingValue {
  /** Ordered arbitrary-key mapping; order and duplicates are value facts. */
  readonly kind: 'EntryMapping';
  readonly entries: readonly EntryMappingEntry[];
}

/**
 * The closed fifteen-kind PortableValue (RFC 0016 §4.1; the Rust
 * PortableValueKind registry, consema-rs/consema-core/src/value.rs).
 * The `kind` discriminant spells the canonical kind name, which is also the
 * canonical JSON transport tag.
 */
export type PortableValue =
  | NullValue
  | BooleanValue
  | StringValue
  | BytesValue
  | IntegerValue
  | DecimalValue
  | BinaryFloat32Value
  | BinaryFloat64Value
  | DateValue
  | TimeValue
  | LocalDateTimeValue
  | OffsetDateTimeValue
  | SequenceValue
  | ObjectValue
  | EntryMappingValue;

/**
 * The fifteen kind names in the closed registry order. Matches the JSON
 * transport tags byte-for-byte (conformance/vectors/protocol-v1.json).
 */
export const KINDS = [
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
] as const;

export type Kind = (typeof KINDS)[number];

/** Singleton Null. */
export function nullValue(): NullValue {
  return { kind: 'Null' };
}

export function booleanValue(value: boolean): BooleanValue {
  return { kind: 'Boolean', value };
}

export function stringValue(value: string): StringValue {
  return { kind: 'String', value };
}

/** Wraps a copy of the octet sequence; the result never aliases input. */
export function bytesValue(value: Uint8Array): BytesValue {
  return { kind: 'Bytes', value: Uint8Array.from(value) };
}

export function integerValue(value: bigint): IntegerValue {
  return { kind: 'Integer', value };
}

/**
 * Frozen default maximum decimal digits of one parsed number literal —
 * coefficient digits and exponent digits alike (the wave-4 magnitude
 * cap, aligned with the HCL number-digits precedent, hcl/limits.ts:95
 * maxNumberDigits 100_000). Exceeding it is a resource-limit failure,
 * never a crash or a silent truncation.
 */
export const MAX_NUMBER_DIGITS = 100_000;

/** Counts the ASCII decimal digit characters of `text` (signs, dots, exponent markers and underscores are skipped). */
export function decimalDigitCount(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0x30 && code <= 0x39) {
      count += 1;
    }
  }
  return count;
}

/**
 * Builds the canonical decimal. A zero coefficient is normalized to
 * exponent zero, and trailing decimal zeros of the coefficient are stripped
 * into the exponent (10 × 10^0 → 1 × 10^1); the Rust Decimal::new
 * normalization, consema-rs/consema-core/src/value.rs.
 *
 * A coefficient over MAX_NUMBER_DIGITS digits fails with the core
 * ResourceLimit error before any strip work — the parse-side magnitude
 * checks (json/yaml/toml) fire earlier, this guard covers direct
 * construction.
 */
export function decimalValue(coefficient: bigint, exponent: bigint): DecimalValue {
  if (coefficient === 0n) {
    return { kind: 'Decimal', coefficient: 0n, exponent: 0n };
  }
  const digits = coefficient.toString();
  const digitCount = digits.startsWith('-') ? digits.length - 1 : digits.length;
  if (digitCount > MAX_NUMBER_DIGITS) {
    throw new PVCEError('ResourceLimit', codeResourceLimit, { field: 'number-digits' });
  }
  // Efficient trailing-zero strip: one decimal pass and one bounded
  // re-parse instead of the O(digits) modulo/divide loop (each iteration
  // of which is O(digit-count) itself — quadratic on large coefficients).
  let end = digits.length;
  while (end > 1 && digits.charCodeAt(end - 1) === 0x30) {
    end -= 1;
  }
  const stripped = digits.length - end;
  if (stripped > 0) {
    return {
      kind: 'Decimal',
      coefficient: BigInt(digits.slice(0, end)),
      exponent: exponent + BigInt(stripped),
    };
  }
  return { kind: 'Decimal', coefficient, exponent };
}

/** Exact IEEE-754 binary32 datum from its raw uint32 bit pattern. */
export function binaryFloat32Value(bits: number): BinaryFloat32Value {
  return { kind: 'BinaryFloat32', bits: bits >>> 0 };
}

/** Exact IEEE-754 binary64 datum from its raw uint64 bit pattern. */
export function binaryFloat64Value(bits: bigint): BinaryFloat64Value {
  return { kind: 'BinaryFloat64', bits: bits & 0xffffffffffffffffn };
}

/**
 * Constructs and validates a date. The leap rule operates on the absolute
 * magnitude of the year (so year -400 is a leap year and year -100 is not);
 * the Rust Date::new checks, consema-rs/consema-core/src/value.rs.
 * Throws the typed invalid-temporal PVCE error on invalid fields.
 */
export function dateValue(year: bigint, month: number, day: number): DateValue {
  if (!dateFieldsValid(year, month, day)) {
    throw invalidTemporal();
  }
  return { kind: 'Date', year, month, day };
}

/**
 * Constructs and validates a time. The fractional second must be an exact
 * finite decimal in [0, 1) (the Rust is_fraction rule,
 * consema-rs/consema-core/src/value.rs). Throws the typed invalid-
 * temporal PVCE error on invalid fields.
 */
export function timeValue(
  hour: number,
  minute: number,
  second: number,
  fraction: DecimalValue,
): TimeValue {
  if (hour > 23 || minute > 59 || second > 59 || !isFraction(fraction)) {
    throw invalidTemporal();
  }
  return { kind: 'Time', hour, minute, second, fraction };
}

export function localDateTimeValue(date: DateValue, time: TimeValue): LocalDateTimeValue {
  return { kind: 'LocalDateTime', date, time };
}

/**
 * Constructs and validates an offset date-time; the offset magnitude must be
 * less than 24 * 60 * 60 seconds (value.rs). Throws the typed
 * invalid-temporal PVCE error otherwise.
 */
export function offsetDateTimeValue(
  local: LocalDateTimeValue,
  offsetSeconds: number,
): OffsetDateTimeValue {
  if (offsetSeconds >= 86400 || offsetSeconds <= -86400) {
    throw invalidTemporal();
  }
  return { kind: 'OffsetDateTime', local, offsetSeconds };
}

export function sequenceValue(items: readonly PortableValue[]): SequenceValue {
  return { kind: 'Sequence', items: [...items] };
}

/**
 * Constructs an ordered unique-key object, rejecting duplicate keys at
 * construction time (the RFC 0002 object contract; the Rust ObjectBuilder
 * uniqueness invariant, value.rs). Throws the typed duplicate-key
 * error on a repeated key.
 */
export function objectValue(entries: readonly ObjectEntry[]): ObjectValue {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.key)) {
      throw duplicateKey(entry.key);
    }
    seen.add(entry.key);
  }
  return { kind: 'Object', entries: [...entries] };
}

/**
 * Constructs an ordered arbitrary-key mapping; keys may be any value and
 * may repeat (the Rust EntryMappingBuilder::push semantics,
 * value.rs).
 */
export function entryMappingValue(entries: readonly EntryMappingEntry[]): EntryMappingValue {
  return { kind: 'EntryMapping', entries: [...entries] };
}

/** Reports whether the canonical decimal represents a value in [0, 1). */
export function isFraction(d: DecimalValue): boolean {
  if (d.coefficient < 0n) {
    return false;
  }
  if (d.coefficient === 0n) {
    return true;
  }
  if (d.exponent >= 0n) {
    return false;
  }
  const digits = decimalDigits(d.coefficient);
  return d.exponent + BigInt(digits) <= 0n;
}

/** Reports whether the fields form a valid proleptic Gregorian date. */
export function dateFieldsValid(year: bigint, month: number, day: number): boolean {
  if (month < 1 || month > 12) {
    return false;
  }
  const magnitude = year < 0n ? -year : year;
  const leap =
    magnitude % 4n === 0n && (magnitude % 100n !== 0n || magnitude % 400n === 0n);
  let maxDay: number;
  if (month === 2) {
    maxDay = leap ? 29 : 28;
  } else if (month === 4 || month === 6 || month === 9 || month === 11) {
    maxDay = 30;
  } else {
    maxDay = 31;
  }
  return day >= 1 && day <= maxDay;
}

/** Counts the base-ten digits of a non-negative bigint. */
export function decimalDigits(n: bigint): number {
  return n.toString().length;
}

function invalidTemporal(): PVCEError {
  return new PVCEError('InvalidTemporal', codeInvalidTemporal);
}

/**
 * Duplicate object key at construction time (the RFC 0002 object contract;
 * RFC 0016 §4.1 maps it to a constructor error). Carries the frozen
 * `core.pvce.duplicate-object-key@1` code (lib.rs).
 */
export class DuplicateKeyError extends Error {
  readonly key: string;
  readonly code = 'core.pvce.duplicate-object-key@1';
  constructor(key: string) {
    super(`core: duplicate object key: ${key}`);
    this.name = 'DuplicateKeyError';
    this.key = key;
  }
}

function duplicateKey(key: string): DuplicateKeyError {
  return new DuplicateKeyError(key);
}

/** Used by builders to reject a nil (undefined) value slot. */
export function invalidValue(): PVCEError {
  return new PVCEError('InvalidValue', codeInvalidValue);
}
