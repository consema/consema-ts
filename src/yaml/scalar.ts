/**
 * Frozen YAML scalar resolution: implicit 1.2 Core / 1.1-compat schemas,
 * explicit standard-tag validation, and canonical content.
 *
 * authority: crates/consema-yaml/src/native.rs
 *  - tag URI constants :17-31 (tag:yaml.org,2002:* — null/bool/int/float/
 *    str/seq/map/timestamp/binary/merge/omap/pairs/set/value/yaml)
 *  - resolve_implicit :675-716, resolve_explicit :655-673
 *  - parse_null :746-748 ("" | "~" | "null" | "Null" | "NULL")
 *  - parse_bool :750-766 (1.2 true/True/TRUE; 1.1 adds y/yes/on/Y/... and
 *    n/no/off/N/...)
 *  - parse_integer :768-801 (0b/0o/0x; 1.1 adds underscores, leading-zero
 *    octal, and base-60 with later fields 0..59)
 *  - parse_float :803-829 (.inf/-.inf/.nan spellings; decimal normalize;
 *    1.1 underscores and base-60)
 *  - normalize_decimal_lexeme :831-846, decimal_canonical :914-920
 *    (coefficient, or "coefficient e exponent"; Decimal::new normalization
 *    crates/consema-core/src/value.rs:277-292, parse_json_number :295-323)
 *  - parse_timestamp :969-1075 (1.1 date/timestamp forms; canonical
 *    "YYYY-MM-DD[T]HH:MM:SS[.fraction]Z|±HH:MM"; no-zone follows the
 *    published 1.1 UTC rule and records Z)
 *  - canonical_base64 :1077-1122 (whitespace-stripped, padding/bit checks)
 *  - RFC 0007 §5 (:115-138) and §6 (:140-165) freeze the schema behavior;
 *    the vector cases profile.yaml12-scalars / profile.yaml11-scalars
 *    (conformance/vectors/yaml-v1.json:4-14) pin the resolution table
 *
 * Design (TypeScript-idiomatic): pure functions over decoded text; integer
 * and decimal arithmetic uses host bigint (arbitrary precision), mirroring
 * the Rust BigInteger/Decimal without a dependency.
 */

import type { YamlProfile } from './profile.ts';
import type { YamlScalarKind, YamlScalarStyle } from './semantic.ts';

/** tag:yaml.org,2002:null (native.rs:17). */
export const TAG_NULL = 'tag:yaml.org,2002:null';
/** tag:yaml.org,2002:bool (native.rs:18). */
export const TAG_BOOL = 'tag:yaml.org,2002:bool';
/** tag:yaml.org,2002:int (native.rs:19). */
export const TAG_INT = 'tag:yaml.org,2002:int';
/** tag:yaml.org,2002:float (native.rs:20). */
export const TAG_FLOAT = 'tag:yaml.org,2002:float';
/** tag:yaml.org,2002:str (native.rs:21). */
export const TAG_STR = 'tag:yaml.org,2002:str';
/** tag:yaml.org,2002:seq (native.rs:22). */
export const TAG_SEQ = 'tag:yaml.org,2002:seq';
/** tag:yaml.org,2002:map (native.rs:23). */
export const TAG_MAP = 'tag:yaml.org,2002:map';
/** tag:yaml.org,2002:timestamp (native.rs:24). */
export const TAG_TIMESTAMP = 'tag:yaml.org,2002:timestamp';
/** tag:yaml.org,2002:binary (native.rs:25). */
export const TAG_BINARY = 'tag:yaml.org,2002:binary';
/** tag:yaml.org,2002:merge (native.rs:26). */
export const TAG_MERGE = 'tag:yaml.org,2002:merge';
/** tag:yaml.org,2002:omap (native.rs:27). */
export const TAG_OMAP = 'tag:yaml.org,2002:omap';
/** tag:yaml.org,2002:pairs (native.rs:28). */
export const TAG_PAIRS = 'tag:yaml.org,2002:pairs';
/** tag:yaml.org,2002:set (native.rs:29). */
export const TAG_SET = 'tag:yaml.org,2002:set';
/** tag:yaml.org,2002:value (native.rs:30). */
export const TAG_VALUE = 'tag:yaml.org,2002:value';
/** tag:yaml.org,2002:yaml (native.rs:31). */
export const TAG_YAML = 'tag:yaml.org,2002:yaml';

/** One resolved native scalar fact (native.rs NativeScalar :62-68 plus its node tag). */
export interface ResolvedScalar {
  readonly tag: string;
  readonly decoded: string;
  readonly canonical: string;
  readonly kind: YamlScalarKind;
  readonly style: YamlScalarStyle;
}

/**
 * Resolves one decoded scalar under the selected profile (native.rs
 * resolve_implicit :675-716). Quoted and block styles always resolve to
 * `tag:yaml.org,2002:str`; plain style applies the frozen schema.
 */
export function resolveImplicit(
  decoded: string,
  style: YamlScalarStyle,
  profile: YamlProfile,
): ResolvedScalar {
  if (style !== 'Plain') {
    return scalar(TAG_STR, decoded, decoded, 'String', style);
  }
  const nullValue = parseNull(decoded);
  if (nullValue !== null) {
    return scalar(TAG_NULL, decoded, nullValue, 'Null', style);
  }
  const boolValue = parseBool(decoded, profile);
  if (boolValue !== null) {
    return scalar(TAG_BOOL, decoded, boolValue, 'Boolean', style);
  }
  const intValue = parseInteger(decoded, profile);
  if (intValue !== null) {
    return scalar(TAG_INT, decoded, intValue, 'Integer', style);
  }
  const floatValue = parseFloat(decoded, profile);
  if (floatValue !== null) {
    return scalar(TAG_FLOAT, decoded, floatValue, 'Float', style);
  }
  if (profile === 'Yaml11CompatV1') {
    const timestamp = parseTimestamp(decoded);
    if (timestamp !== null) {
      return scalar(TAG_TIMESTAMP, decoded, timestamp, 'Timestamp', style);
    }
  }
  return scalar(TAG_STR, decoded, decoded, 'String', style);
}

/**
 * Resolves a scalar with an explicit tag (native.rs resolve_scalar :565-653
 * and resolve_explicit :655-673). Custom tags keep their spelling with the
 * Custom category; retained standard repository tags that have no core-tree
 * lowering (merge/value/yaml) keep the Tagged category. Returns null when
 * the content is invalid for the explicit standard tag
 * (yaml.scalar.invalid-explicit-tag@1, native.rs:671).
 */
export function resolveExplicit(
  decoded: string,
  style: YamlScalarStyle,
  tag: string,
  profile: YamlProfile,
): ResolvedScalar | null {
  if (tag === '!' || tag === TAG_STR) {
    return scalar(tag, decoded, decoded, 'String', style);
  }
  if (tag === TAG_NULL) {
    const canonical = parseNull(decoded);
    return canonical === null
      ? null
      : scalar(TAG_NULL, decoded, canonical, 'Null', style);
  }
  if (tag === TAG_BOOL) {
    const canonical = parseBool(decoded, profile);
    return canonical === null
      ? null
      : scalar(TAG_BOOL, decoded, canonical, 'Boolean', style);
  }
  if (tag === TAG_INT) {
    const canonical = parseInteger(decoded, profile);
    return canonical === null
      ? null
      : scalar(TAG_INT, decoded, canonical, 'Integer', style);
  }
  if (tag === TAG_FLOAT) {
    const canonical = parseFloat(decoded, profile);
    return canonical === null
      ? null
      : scalar(TAG_FLOAT, decoded, canonical, 'Float', style);
  }
  if (tag === TAG_TIMESTAMP) {
    const canonical = parseTimestamp(decoded);
    return canonical === null
      ? null
      : scalar(TAG_TIMESTAMP, decoded, canonical, 'Timestamp', style);
  }
  if (tag === TAG_BINARY) {
    const canonical = canonicalBase64(decoded);
    return canonical === null
      ? null
      : scalar(TAG_BINARY, decoded, canonical, 'Binary', style);
  }
  if (tag === TAG_MERGE || tag === TAG_VALUE || tag === TAG_YAML) {
    return scalar(tag, decoded, decoded, 'Tagged', style);
  }
  return scalar(tag, decoded, decoded, 'Custom', style);
}

function scalar(
  tag: string,
  decoded: string,
  canonical: string,
  kind: YamlScalarKind,
  style: YamlScalarStyle,
): ResolvedScalar {
  return { tag, decoded, canonical, kind, style };
}

/** parse_null (native.rs:746-748): canonical null content is the empty string. */
export function parseNull(value: string): string | null {
  return value === '' || value === '~' || value === 'null' || value === 'Null' || value === 'NULL'
    ? ''
    : null;
}

/** parse_bool (native.rs:750-766): canonical `true` or `false`. */
export function parseBool(value: string, profile: YamlProfile): string | null {
  switch (value) {
    case 'true':
    case 'True':
    case 'TRUE':
      return 'true';
    case 'false':
    case 'False':
    case 'FALSE':
      return 'false';
    default:
      break;
  }
  if (profile === 'Yaml11CompatV1') {
    switch (value) {
      case 'y':
      case 'Y':
      case 'yes':
      case 'Yes':
      case 'YES':
      case 'on':
      case 'On':
      case 'ON':
        return 'true';
      case 'n':
      case 'N':
      case 'no':
      case 'No':
      case 'NO':
      case 'off':
      case 'Off':
      case 'OFF':
        return 'false';
      default:
        return null;
    }
  }
  return null;
}

/** parse_integer (native.rs:768-801): canonical unbounded base-10 spelling. */
export function parseInteger(value: string, profile: YamlProfile): string | null {
  const split = splitSign(value);
  if (split === null) {
    return null;
  }
  const [sign, unsigned] = split;
  const allowUnderscores = profile === 'Yaml11CompatV1';
  let cleaned: string;
  if (allowUnderscores) {
    if (!validUnderscored(unsigned)) {
      return null;
    }
    cleaned = unsigned.replace(/_/g, '');
  } else if (unsigned.includes('_')) {
    return null;
  } else {
    cleaned = unsigned;
  }
  let base = 10;
  let digits = cleaned;
  if (cleaned.startsWith('0b')) {
    base = 2;
    digits = cleaned.slice(2);
  } else if (cleaned.startsWith('0o')) {
    if (profile === 'Yaml11CompatV1') {
      return null;
    }
    base = 8;
    digits = cleaned.slice(2);
  } else if (cleaned.startsWith('0x')) {
    base = 16;
    digits = cleaned.slice(2);
  } else if (profile === 'Yaml11CompatV1' && cleaned.length > 1 && cleaned.startsWith('0')) {
    base = 8;
    digits = cleaned;
  } else if (profile === 'Yaml11CompatV1' && cleaned.includes(':')) {
    return parseSexagesimalInteger(sign, cleaned);
  }
  const magnitude = parseBaseMagnitude(digits, base);
  if (magnitude === null) {
    return null;
  }
  return (magnitude * BigInt(sign)).toString();
}

/** parse_float (native.rs:803-829): canonical decimal or frozen non-finite spelling. */
export function parseFloat(value: string, profile: YamlProfile): string | null {
  switch (value) {
    case '.inf':
    case '.Inf':
    case '.INF':
    case '+.inf':
    case '+.Inf':
    case '+.INF':
      return '.inf';
    case '-.inf':
    case '-.Inf':
    case '-.INF':
      return '-.inf';
    case '.nan':
    case '.NaN':
    case '.NAN':
      return '.nan';
    default:
      break;
  }
  let cleaned: string;
  if (profile === 'Yaml11CompatV1') {
    if (!validUnderscored(value)) {
      return null;
    }
    cleaned = value.replace(/_/g, '');
  } else if (value.includes('_')) {
    return null;
  } else {
    cleaned = value;
  }
  if (profile === 'Yaml11CompatV1' && cleaned.includes(':')) {
    return parseSexagesimalFloat(cleaned);
  }
  if (!cleaned.includes('.') && !cleaned.includes('e') && !cleaned.includes('E')) {
    return null;
  }
  const normalized = normalizeDecimalLexeme(cleaned);
  const decimal = parseJsonNumber(normalized);
  if (decimal === null) {
    return null;
  }
  return decimalCanonical(decimal);
}

/** normalize_decimal_lexeme (native.rs:831-846): makes a float lexeme JSON-number-shaped. */
export function normalizeDecimalLexeme(value: string): string {
  let result = value;
  if (result.startsWith('+')) {
    result = result.slice(1);
  }
  if (result.startsWith('-.')) {
    result = '-' + '0' + result.slice(1);
  } else if (result.startsWith('.')) {
    result = '0' + result;
  }
  const exponent = exponentIndex(result);
  if (exponent !== result.length && result[exponent - 1] === '.') {
    result = result.slice(0, exponent) + '0' + result.slice(exponent);
  }
  return result;
}

function exponentIndex(value: string): number {
  const e = value.indexOf('e');
  const E = value.indexOf('E');
  if (e === -1) {
    return E === -1 ? value.length : E;
  }
  if (E === -1) {
    return e;
  }
  return Math.min(e, E);
}

/**
 * Decimal::parse_json_number (crates/consema-core/src/value.rs:295-323)
 * with Decimal::new normalization (:277-292): trailing zeros of the
 * coefficient move into the exponent. The explicit exponent accepts an
 * optional sign, exactly like the Rust BigInteger::parse_decimal.
 */
export function parseJsonNumber(text: string): { coefficient: bigint; exponent: bigint } | null {
  const index = exponentIndex(text);
  const mantissa = index === text.length ? text : text.slice(0, index);
  const explicitExponent = index === text.length ? '0' : text.slice(index + 1);
  const signed = explicitExponent.startsWith('+')
    ? explicitExponent.slice(1)
    : explicitExponent;
  if (signed === '' || (signed.startsWith('-') && signed.length === 1)) {
    return null;
  }
  let exponent: bigint;
  try {
    exponent = BigInt(signed);
  } catch {
    return null;
  }
  if (mantissa === '') {
    return null;
  }
  const negative = mantissa.startsWith('-');
  const unsigned = negative ? mantissa.slice(1) : mantissa;
  const dot = unsigned.indexOf('.');
  const whole = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fraction = dot === -1 ? '' : unsigned.slice(dot + 1);
  if (whole === '' || !isAsciiDigits(whole) || !isAsciiDigits(fraction)) {
    return null;
  }
  let coefficient: bigint;
  try {
    coefficient = BigInt((negative ? '-' : '') + whole + fraction);
  } catch {
    return null;
  }
  exponent = exponent - BigInt(fraction.length);
  return normalizeDecimal(coefficient, exponent);
}

/** Decimal::new normalization (value.rs:277-292). */
export function normalizeDecimal(coefficient: bigint, exponent: bigint): {
  coefficient: bigint;
  exponent: bigint;
} {
  if (coefficient === 0n) {
    return { coefficient, exponent: 0n };
  }
  let c = coefficient;
  let e = exponent;
  while (c % 10n === 0n) {
    c /= 10n;
    e += 1n;
  }
  return { coefficient: c, exponent: e };
}

/** decimal_canonical (native.rs:914-920). */
export function decimalCanonical(value: { coefficient: bigint; exponent: bigint }): string {
  if (value.exponent === 0n) {
    return value.coefficient.toString();
  }
  return `${value.coefficient}e${value.exponent}`;
}

/** parse_timestamp (native.rs:969-1075): 1.1 date/timestamp forms only. */
export function parseTimestamp(value: string): string | null {
  if (value.length >= 10 && isAscii(value) && validDate(value.slice(0, 10))) {
    if (value.length === 10) {
      return value;
    }
    return canonicalTimestamp(value);
  }
  return null;
}

function validDate(value: string): boolean {
  if (value.length !== 10 || value[4] !== '-' || value[7] !== '-') {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  let maxDay: number;
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      maxDay = 31;
      break;
    case 4:
    case 6:
    case 9:
    case 11:
      maxDay = 30;
      break;
    case 2:
      maxDay = leap ? 29 : 28;
      break;
    default:
      return false;
  }
  return day !== 0 && day <= maxDay;
}

function canonicalTimestamp(value: string): string | null {
  let rest = value.slice(10);
  while (
    rest.length > 0 &&
    (rest[0] === ' ' || rest[0] === '\t' || rest[0] === 'T' || rest[0] === 't')
  ) {
    rest = rest.slice(1);
  }
  const hourPair = takeOneOrTwoDigits(rest);
  if (hourPair === null) {
    return null;
  }
  const [hour, afterHour] = hourPair;
  if (!afterHour.startsWith(':')) {
    return null;
  }
  const minutePair = takeTwoDigits(afterHour.slice(1));
  if (minutePair === null) {
    return null;
  }
  const [minute, afterMinute] = minutePair;
  if (!afterMinute.startsWith(':')) {
    return null;
  }
  const secondPair = takeTwoDigits(afterMinute.slice(1));
  if (secondPair === null) {
    return null;
  }
  const [second, afterSecond] = secondPair;
  if (hour > 23 || minute > 59 || second > 60) {
    return null;
  }
  let fraction = '';
  let tail = afterSecond;
  if (tail.startsWith('.')) {
    const digits = tail.slice(1);
    let length = 0;
    while (length < digits.length && isAsciiDigit(digits[length])) {
      length += 1;
    }
    if (length === 0) {
      return null;
    }
    fraction = digits.slice(0, length);
    tail = digits.slice(length);
  }
  while (tail.length > 0 && (tail[0] === ' ' || tail[0] === '\t')) {
    tail = tail.slice(1);
  }
  let zone: string;
  if (tail === '' || tail === 'Z' || tail === 'z') {
    zone = 'Z';
  } else {
    const canonical = canonicalZone(tail);
    if (canonical === null) {
      return null;
    }
    zone = canonical;
  }
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${value.slice(0, 10)}T${pad(hour)}:${pad(minute)}:${pad(second)}${
    fraction === '' ? '' : `.${fraction}`
  }${zone}`;
}

function canonicalZone(value: string): string | null {
  const sign = value[0];
  if (sign !== '+' && sign !== '-') {
    return null;
  }
  const rest = value.slice(1);
  const hourPair = takeOneOrTwoDigits(rest);
  if (hourPair === null) {
    return null;
  }
  const [hour, tail] = hourPair;
  const stripped = tail.startsWith(':') ? tail.slice(1) : tail;
  let minute = 0;
  if (stripped !== '') {
    const minutePair = takeTwoDigits(stripped);
    if (minutePair === null) {
      return null;
    }
    minute = minutePair[0];
    if (minutePair[1] !== '') {
      return null;
    }
  }
  if (hour > 23 || minute > 59) {
    return null;
  }
  return `${sign}${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
}

function takeTwoDigits(value: string): [number, string] | null {
  if (value.length < 2 || !isAsciiDigits(value.slice(0, 2))) {
    return null;
  }
  return [Number(value.slice(0, 2)), value.slice(2)];
}

function takeOneOrTwoDigits(value: string): [number, string] | null {
  let count = 0;
  while (count < 2 && count < value.length && isAsciiDigit(value[count])) {
    count += 1;
  }
  if (count === 0) {
    return null;
  }
  return [Number(value.slice(0, count)), value.slice(count)];
}

/** canonical_base64 (native.rs:1077-1122): whitespace-stripped with padding and unused-bit checks. */
export function canonicalBase64(value: string): string | null {
  const cleaned = value.replace(/\s+/g, '');
  let padding = 0;
  for (let index = cleaned.length - 1; index >= 0 && cleaned[index] === '='; index--) {
    padding += 1;
  }
  if (
    cleaned.length % 4 !== 0 ||
    !allChars(
      cleaned,
      (item) => isAsciiAlphanumeric(item) || item === '+' || item === '/' || item === '=',
    ) ||
    allChars(cleaned.slice(0, Math.max(0, cleaned.length - 2)), (item) => item === '=') ||
    padding > 2
  ) {
    return null;
  }
  if (padding > 0) {
    const last = base64Value(cleaned.charCodeAt(cleaned.length - padding - 1));
    if (last === null) {
      return null;
    }
    const unusedMask = padding === 1 ? 0b0000_0011 : 0b0000_1111;
    if ((last & unusedMask) !== 0) {
      return null;
    }
  }
  return cleaned;
}

/** Decodes canonical base64 bytes (projection.rs:1191-1217). */
export function decodeBase64(value: string): Uint8Array | null {
  const bytes = new TextEncoder().encode(value);
  const output: number[] = [];
  for (let index = 0; index + 3 < bytes.length; index += 4) {
    const a = base64Value(bytes[index]);
    const b = base64Value(bytes[index + 1]);
    const c = bytes[index + 2] === 0x3d ? 0 : base64Value(bytes[index + 2]);
    const d = bytes[index + 3] === 0x3d ? 0 : base64Value(bytes[index + 3]);
    if (a === null || b === null || c === null || d === null) {
      return null;
    }
    const combined = (a << 18) | (b << 12) | (c << 6) | d;
    output.push((combined >> 16) & 0xff);
    if (bytes[index + 2] !== 0x3d) {
      output.push((combined >> 8) & 0xff);
    }
    if (bytes[index + 3] !== 0x3d) {
      output.push(combined & 0xff);
    }
  }
  return Uint8Array.from(output);
}

/** Encodes bytes as canonical base64 (materialization.rs:1574-1609). */
export function encodeBase64(value: Uint8Array): string {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < value.length; index += 3) {
    const first = value[index];
    const second = index + 1 < value.length ? value[index + 1] : 0;
    const third = index + 2 < value.length ? value[index + 2] : 0;
    output += ALPHABET[first >> 2];
    output += ALPHABET[((first & 0x03) << 4) | (second >> 4)];
    output += index + 1 < value.length ? ALPHABET[((second & 0x0f) << 2) | (third >> 6)] : '=';
    output += index + 2 < value.length ? ALPHABET[third & 0x3f] : '=';
  }
  return output;
}

function base64Value(value: number): number | null {
  if (value >= 0x41 && value <= 0x5a) {
    return value - 0x41;
  }
  if (value >= 0x61 && value <= 0x7a) {
    return value - 0x61 + 26;
  }
  if (value >= 0x30 && value <= 0x39) {
    return value - 0x30 + 52;
  }
  if (value === 0x2b) {
    return 62;
  }
  if (value === 0x2f) {
    return 63;
  }
  return null;
}

/** parse_sexagesimal_integer (native.rs:848-870): base-60 with later fields 0..59. */
export function parseSexagesimalInteger(sign: number, value: string): string | null {
  const parts = value.split(':');
  const first = parts[0];
  if (first === '' || !allChars(first, isAsciiDigit)) {
    return null;
  }
  let magnitude = parseBaseMagnitude(first, 10);
  if (magnitude === null) {
    return null;
  }
  let count = 0;
  for (let index = 1; index < parts.length; index++) {
    const part = parts[index];
    if (part === '' || part.length > 2 || !isAsciiDigits(part)) {
      return null;
    }
    const component = Number(part);
    if (component > 59) {
      return null;
    }
    magnitude = magnitude * 60n + BigInt(component);
    count += 1;
  }
  if (count === 0) {
    return null;
  }
  return (magnitude * BigInt(sign)).toString();
}

/** parse_sexagesimal_float (native.rs:872-912). */
export function parseSexagesimalFloat(value: string): string | null {
  const split = splitSign(value);
  if (split === null) {
    return null;
  }
  const [sign, unsigned] = split;
  const parts = unsigned.split(':');
  const last = parts.pop();
  if (last === undefined) {
    return null;
  }
  const dot = last.indexOf('.');
  if (dot === -1) {
    return null;
  }
  const wholeText = last.slice(0, dot);
  const fraction = last.slice(dot + 1);
  if (fraction === '' || !allChars(fraction, isAsciiDigit)) {
    return null;
  }
  if (parts.length === 0) {
    return null;
  }
  let magnitude = parseBaseMagnitude(parts[0], 10);
  if (magnitude === null) {
    return null;
  }
  for (let index = 1; index < parts.length; index++) {
    const part = parts[index];
    if (part === '' || !isAsciiDigits(part)) {
      return null;
    }
    const component = Number(part);
    if (component > 59) {
      return null;
    }
    magnitude = magnitude * 60n + BigInt(component);
  }
  if (wholeText === '' || !isAsciiDigits(wholeText)) {
    return null;
  }
  const whole = Number(wholeText);
  if (whole > 59) {
    return null;
  }
  magnitude = magnitude * 60n + BigInt(whole);
  const coefficient = BigInt((sign < 0 ? '-' : '') + magnitude.toString() + fraction);
  return decimalCanonical(normalizeDecimal(coefficient, BigInt(-fraction.length)));
}

function parseBaseMagnitude(value: string, base: number): bigint | null {
  if (value === '') {
    return null;
  }
  let magnitude = 0n;
  for (const character of value) {
    const digit = parseInt(character, base);
    if (Number.isNaN(digit)) {
      return null;
    }
    magnitude = magnitude * BigInt(base) + BigInt(digit);
  }
  return magnitude;
}

function splitSign(value: string): [number, string] | null {
  if (value === '') {
    return null;
  }
  if (value.startsWith('-')) {
    return [-1, value.slice(1)];
  }
  if (value.startsWith('+')) {
    return [1, value.slice(1)];
  }
  return [1, value];
}

/** valid_underscored (native.rs:930-943): 1.1 underscore placement rules. */
export function validUnderscored(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (
      value[index] === '_' &&
      (index === 0 ||
        index + 1 === value.length ||
        !isAsciiAlphanumeric(value[index - 1]) ||
        !isAsciiAlphanumeric(value[index + 1]))
    ) {
      return false;
    }
  }
  return true;
}

function isAsciiDigits(value: string): boolean {
  return allChars(value, isAsciiDigit);
}

function allChars(value: string, predicate: (character: string) => boolean): boolean {
  for (const character of value) {
    if (!predicate(character)) {
      return false;
    }
  }
  return true;
}

function isAsciiDigit(character: string): boolean {
  return character >= '0' && character <= '9';
}

function isAsciiAlphanumeric(character: string): boolean {
  return (
    (character >= '0' && character <= '9') ||
    (character >= 'a' && character <= 'z') ||
    (character >= 'A' && character <= 'Z')
  );
}

function isAscii(value: string): boolean {
  for (const character of value) {
    if (character.charCodeAt(0) > 0x7f) {
      return false;
    }
  }
  return true;
}
