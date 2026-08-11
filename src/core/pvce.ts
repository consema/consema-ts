/**
 * PVCE/1 — Portable Value Canonical Encoding / 1.
 *
 * authority: the Rust reference codec is the frozen byte authority
 * (crates/consema-pvce/src/lib.rs); the golden byte vectors are pinned by
 * conformance/vectors/v1.json (cases pvce.null-vector, pvce.negative-
 * integer-vector, pvce.object-vector). Wire constants:
 *  - stream magic is the ASCII octets "PVCE" (lib.rs:23)
 *  - version is minimal unsigned LEB128 1 (lib.rs:25)
 *  - integer sign octets are 0 (zero), 1 (positive), 2 (negative)
 *    (lib.rs:9-12, 545-554)
 *  - all unsigned lengths/counts/tags are minimal unsigned LEB128
 *    (lib.rs:11, 616-628)
 *  - record tags: lib.rs:27-43 (NULL 0x00, FALSE 0x01, TRUE 0x02,
 *    INTEGER 0x10, DECIMAL 0x11, FLOAT32 0x12, FLOAT64 0x13, STRING 0x20,
 *    BYTES 0x21, DATE 0x30, TIME 0x31, LOCAL_DATE_TIME 0x32,
 *    OFFSET_DATE_TIME 0x33, SEQUENCE 0x40, OBJECT 0x41, ENTRY_MAPPING 0x42,
 *    EXTENDED 0x7f)
 *  - field framing: integer/date/time/decimal fields are length-prefixed
 *    with the field limits at lib.rs:848-940; object keys encode as full
 *    String records (lib.rs:514-522)
 *  - decode limits: lib.rs:56-82 (64 MiB stream, depth 256, 1,000,000
 *    nodes, 1,000,000 container entries, 1 MiB integer magnitude, 64 MiB
 *    blob)
 *
 * The codec covers the closed fifteen-kind core model plus the formally
 * versioned extension root (TAG_EXTENDED, lib.rs:536-543); nested extended
 * records fail with core.pvce.nested-extended@1 and a core-only decode of an
 * extension root fails with core.pvce.expected-core@1, exactly as in Rust
 * (the Go codec has no ExtendedValue type and rejects 0x7f as unknown-tag —
 * documented reachable-code difference, go/core/errors.go:13-20).
 *
 * Design (TypeScript-idiomatic): a small growable ByteWriter for encoding
 * and an offset Reader over Uint8Array for strict decoding; resource limits
 * are plain readonly objects with a frozen-defaults factory; failures throw
 * the typed PVCEError carrying the frozen code (see errors.ts).
 */

import {
  dateFieldsValid,
  isFraction,
  dateValue,
  timeValue,
  offsetDateTimeValue,
  localDateTimeValue,
  objectValue,
  entryMappingValue,
  invalidValue,
  DuplicateKeyError,
} from './value.ts';
import type {
  PortableValue,
  DecimalValue,
  DateValue,
  TimeValue,
  LocalDateTimeValue,
  OffsetDateTimeValue,
  ObjectValue,
  SequenceValue,
  EntryMappingValue,
} from './value.ts';
import { PVCEError, pvceError } from './errors.ts';

/** PVCE/1 stream magic (ASCII "PVCE"). */
export const MAGIC = new Uint8Array([0x50, 0x56, 0x43, 0x45]);
/** PVCE/1 version. */
export const VERSION = 1n;

/** Record tags (crates/consema-pvce/src/lib.rs:27-43). */
export const TAG_NULL = 0x00n;
export const TAG_FALSE = 0x01n;
export const TAG_TRUE = 0x02n;
export const TAG_INTEGER = 0x10n;
export const TAG_DECIMAL = 0x11n;
export const TAG_FLOAT32 = 0x12n;
export const TAG_FLOAT64 = 0x13n;
export const TAG_STRING = 0x20n;
export const TAG_BYTES = 0x21n;
export const TAG_DATE = 0x30n;
export const TAG_TIME = 0x31n;
export const TAG_LOCAL_DATE_TIME = 0x32n;
export const TAG_OFFSET_DATE_TIME = 0x33n;
export const TAG_SEQUENCE = 0x40n;
export const TAG_OBJECT = 0x41n;
export const TAG_ENTRY_MAPPING = 0x42n;
export const TAG_EXTENDED = 0x7fn;

/** A formally versioned extension root, kept separate from the closed core tree. */
export interface ExtendedValue {
  readonly typeId: string;
  readonly semanticVersion: number; // u32
  readonly payloadCodecId: string;
  readonly canonicalPayload: Uint8Array;
}

/** One PVCE root record. */
export type EncodedValue =
  | { readonly kind: 'Core'; readonly value: PortableValue }
  | { readonly kind: 'Extended'; readonly value: ExtendedValue };

/** Strict decoder resource limits (crates/consema-pvce/src/lib.rs:56-82). */
export interface DecodeLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxContainerEntries: number;
  readonly maxIntegerBytes: number;
  readonly maxBlobBytes: number;
}

/** Bounded encoder resource limits (crates/consema-pvce/src/lib.rs:111-138). */
export type EncodeLimits = DecodeLimits;

/** The frozen defaults (64 MiB stream, depth 256, 1,000,000 nodes, 1,000,000 container entries, 1 MiB integer magnitude, 64 MiB blob). */
export function defaultDecodeLimits(): DecodeLimits {
  return {
    maxBytes: 64 << 20,
    maxDepth: 256,
    maxNodes: 1_000_000,
    maxContainerEntries: 1_000_000,
    maxIntegerBytes: 1 << 20,
    maxBlobBytes: 64 << 20,
  };
}

/** The frozen bounded-encode defaults, identical to the decode defaults. */
export function defaultEncodeLimits(): EncodeLimits {
  return defaultDecodeLimits();
}

/** The minimal big-endian magnitude octets of a bigint (empty for zero). */
export function bigintMagnitude(value: bigint): Uint8Array {
  const n = value < 0n ? -value : value;
  if (n === 0n) {
    return new Uint8Array(0);
  }
  let hex = n.toString(16);
  if (hex.length % 2 === 1) {
    hex = '0' + hex;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Rebuilds the unsigned bigint from minimal big-endian magnitude octets. */
export function bigintFromMagnitude(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const octet of bytes) {
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

/** Number of octets of the minimal unsigned LEB128 encoding of value. */
export function varintSize(value: bigint): number {
  let size = 1;
  let v = value;
  while (v >= 0x80n) {
    v >>= 7n;
    size++;
  }
  return size;
}

/** Growable byte builder for encoding. */
class ByteWriter {
  private readonly out: number[] = [];

  push(octet: number): void {
    this.out.push(octet & 0xff);
  }

  pushAll(bytes: Uint8Array): void {
    for (const octet of bytes) {
      this.out.push(octet);
    }
  }

  varint(value: bigint): void {
    let v = value;
    for (;;) {
      let octet = Number(v & 0x7fn);
      v >>= 7n;
      if (v !== 0n) {
        octet |= 0x80;
      }
      this.out.push(octet);
      if (v === 0n) {
        return;
      }
    }
  }

  result(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

/**
 * Encodes one core value as a complete canonical PVCE/1 stream
 * (crates/consema-pvce/src/lib.rs:86-101).
 */
export function encode(value: PortableValue): Uint8Array {
  return encodeValue({ kind: 'Core', value });
}

/** Encodes one core or extension root as a complete canonical PVCE/1 stream. */
export function encodeValue(root: EncodedValue): Uint8Array {
  const output = new ByteWriter();
  output.pushAll(MAGIC);
  output.varint(VERSION);
  if (root.kind === 'Core') {
    writeRecord(output, root.value);
  } else {
    writeExtendedRecord(output, root.value);
  }
  return output.result();
}

/**
 * Encodes one core value after exact size measurement against explicit
 * resource limits; never truncates — exceeding any limit throws the typed
 * resource-limit error with no partial output (lib.rs:150-156).
 */
export function encodeBounded(value: PortableValue, limits: EncodeLimits): Uint8Array {
  return encodeValueBounded({ kind: 'Core', value }, limits);
}

/** Bounded encode for a core or extension root (lib.rs:159-168). */
export function encodeValueBounded(root: EncodedValue, limits: EncodeLimits): Uint8Array {
  const sizer = new Sizer(limits);
  let record: number;
  if (root.kind === 'Core') {
    record = sizer.recordSize(root.value, 0);
  } else {
    record = sizer.extendedSize(root.value);
  }
  const total = MAGIC.length + 1 + record;
  if (total > limits.maxBytes) {
    throw pvceError('ResourceLimit', { field: 'stream-bytes' });
  }
  return encodeValue(root);
}

/** Writes one tag-length-prefixed record (lib.rs:610-614). */
function writeRecord(output: ByteWriter, value: PortableValue): void {
  const tag = tagOf(value);
  const payload = encodePayload(value);
  output.varint(tag);
  output.varint(BigInt(payload.length));
  output.pushAll(payload);
}

function writeExtendedRecord(output: ByteWriter, value: ExtendedValue): void {
  const payload = new ByteWriter();
  encodeBlob(payload, textBytes(value.typeId));
  payload.varint(BigInt(value.semanticVersion >>> 0));
  encodeBlob(payload, textBytes(value.payloadCodecId));
  encodeBlob(payload, value.canonicalPayload);
  const bytes = payload.result();
  output.varint(TAG_EXTENDED);
  output.varint(BigInt(bytes.length));
  output.pushAll(bytes);
}

/** Returns the record tag of a core value. */
function tagOf(value: PortableValue): bigint {
  switch (value.kind) {
    case 'Null':
      return TAG_NULL;
    case 'Boolean':
      return value.value ? TAG_TRUE : TAG_FALSE;
    case 'Integer':
      return TAG_INTEGER;
    case 'Decimal':
      return TAG_DECIMAL;
    case 'BinaryFloat32':
      return TAG_FLOAT32;
    case 'BinaryFloat64':
      return TAG_FLOAT64;
    case 'String':
      return TAG_STRING;
    case 'Bytes':
      return TAG_BYTES;
    case 'Date':
      return TAG_DATE;
    case 'Time':
      return TAG_TIME;
    case 'LocalDateTime':
      return TAG_LOCAL_DATE_TIME;
    case 'OffsetDateTime':
      return TAG_OFFSET_DATE_TIME;
    case 'Sequence':
      return TAG_SEQUENCE;
    case 'Object':
      return TAG_OBJECT;
    case 'EntryMapping':
      return TAG_ENTRY_MAPPING;
  }
}

/** Builds the payload of one record; booleans and null carry an empty payload. */
function encodePayload(value: PortableValue): Uint8Array {
  const payload = new ByteWriter();
  switch (value.kind) {
    case 'Null':
    case 'Boolean':
      return new Uint8Array(0);
    case 'Integer':
      encodeIntegerPayload(payload, value.value);
      break;
    case 'Decimal':
      encodeIntegerField(payload, value.coefficient);
      encodeIntegerField(payload, value.exponent);
      break;
    case 'BinaryFloat32':
      payload.pushAll(float32Bytes(value.bits));
      break;
    case 'BinaryFloat64':
      payload.pushAll(float64Bytes(value.bits));
      break;
    case 'String':
      encodeBlob(payload, textBytes(value.value));
      break;
    case 'Bytes':
      encodeBlob(payload, value.value);
      break;
    case 'Date':
      ensureDateValid(value);
      encodeIntegerField(payload, value.year);
      payload.push(value.month);
      payload.push(value.day);
      break;
    case 'Time':
      ensureTimeValid(value);
      payload.push(value.hour);
      payload.push(value.minute);
      payload.push(value.second);
      encodeDecimalField(payload, value.fraction);
      break;
    case 'LocalDateTime':
      ensureLocalValid(value);
      encodeDateField(payload, value.date);
      encodeTimeField(payload, value.time);
      break;
    case 'OffsetDateTime':
      ensureLocalValid(value.local);
      encodeDateField(payload, value.local.date);
      encodeTimeField(payload, value.local.time);
      encodeIntegerField(payload, BigInt(value.offsetSeconds));
      break;
    case 'Sequence':
      encodeContainer(payload, value);
      break;
    case 'Object':
      encodeObject(payload, value);
      break;
    case 'EntryMapping':
      encodeEntryMapping(payload, value);
      break;
  }
  return payload.result();
}

/** Sequence payload: varint count, then one record per item (lib.rs:506-513). */
function encodeContainer(payload: ByteWriter, value: SequenceValue): void {
  payload.varint(BigInt(value.items.length));
  for (const item of value.items) {
    writeRecord(payload, item);
  }
}

/** Object payload: varint count, then (String record, value record) pairs (lib.rs:514-522). */
function encodeObject(payload: ByteWriter, value: ObjectValue): void {
  payload.varint(BigInt(value.entries.length));
  for (const entry of value.entries) {
    writeRecord(payload, { kind: 'String', value: entry.key });
    writeRecord(payload, entry.value);
  }
}

/** Entry-mapping payload: varint count, then (key record, value record) pairs (lib.rs:523-531). */
function encodeEntryMapping(payload: ByteWriter, value: EntryMappingValue): void {
  payload.varint(BigInt(value.entries.length));
  for (const entry of value.entries) {
    writeRecord(payload, entry.key);
    writeRecord(payload, entry.value);
  }
}

/** Sign octet (0 zero, 1 positive, 2 negative), magnitude length varint, magnitude octets (lib.rs:545-554). */
function encodeIntegerPayload(payload: ByteWriter, value: bigint): void {
  if (value < 0n) {
    payload.push(2);
  } else if (value === 0n) {
    payload.push(0);
  } else {
    payload.push(1);
  }
  const magnitude = bigintMagnitude(value);
  payload.varint(BigInt(magnitude.length));
  payload.pushAll(magnitude);
}

/** Length-prefixed integer payload (lib.rs:556-561). */
function encodeIntegerField(payload: ByteWriter, value: bigint): void {
  const field = new ByteWriter();
  encodeIntegerPayload(field, value);
  const bytes = field.result();
  payload.varint(BigInt(bytes.length));
  payload.pushAll(bytes);
}

/** Length-prefixed decimal payload (lib.rs:568-573). */
function encodeDecimalField(payload: ByteWriter, value: PortableValue & { readonly kind: 'Decimal' }): void {
  const field = new ByteWriter();
  encodeIntegerField(field, value.coefficient);
  encodeIntegerField(field, value.exponent);
  const bytes = field.result();
  payload.varint(BigInt(bytes.length));
  payload.pushAll(bytes);
}

/** Length-prefixed date payload (lib.rs:586-591). */
function encodeDateField(payload: ByteWriter, value: DateValue): void {
  const field = new ByteWriter();
  encodeIntegerField(field, value.year);
  field.push(value.month);
  field.push(value.day);
  const bytes = field.result();
  payload.varint(BigInt(bytes.length));
  payload.pushAll(bytes);
}

/** Length-prefixed time payload (lib.rs:598-603). */
function encodeTimeField(payload: ByteWriter, value: TimeValue): void {
  const field = new ByteWriter();
  field.push(value.hour);
  field.push(value.minute);
  field.push(value.second);
  encodeDecimalField(field, value.fraction);
  const bytes = field.result();
  payload.varint(BigInt(bytes.length));
  payload.pushAll(bytes);
}

/** Length-prefixed octet string (lib.rs:575-578). */
function encodeBlob(payload: ByteWriter, bytes: Uint8Array): void {
  payload.varint(BigInt(bytes.length));
  payload.pushAll(bytes);
}

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** The exact IEEE-754 binary32 big-endian octets. */
export function float32Bytes(bits: number): Uint8Array {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, bits >>> 0, false);
  return new Uint8Array(view.buffer);
}

/** The exact IEEE-754 binary64 big-endian octets. */
export function float64Bytes(bits: bigint): Uint8Array {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, bits & 0xffffffffffffffffn, false);
  return new Uint8Array(view.buffer);
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/** Strictly decodes a core PortableValue stream (lib.rs:104-108). */
export function decode(stream: Uint8Array, limits: DecodeLimits): PortableValue {
  const root = decodeValue(stream, limits);
  if (root.kind !== 'Core') {
    throw pvceError('ExpectedCore');
  }
  return root.value;
}

/** Strictly decodes a core or extension root (lib.rs:404-426). */
export function decodeValue(stream: Uint8Array, limits: DecodeLimits): EncodedValue {
  if (stream.length > limits.maxBytes) {
    throw pvceError('ResourceLimit', { field: 'stream-bytes' });
  }
  const reader = new Reader(stream, limits);
  if (!byteArraysEqual(reader.take(MAGIC.length), MAGIC)) {
    throw pvceError('InvalidMagic');
  }
  const version = reader.varint();
  if (version !== VERSION) {
    throw pvceError('UnsupportedVersion', { value: version });
  }
  const [tag, payload] = reader.record();
  let root: EncodedValue;
  if (tag === TAG_EXTENDED) {
    root = { kind: 'Extended', value: decodeExtended(payload, reader) };
  } else {
    root = { kind: 'Core', value: decodeCoreRecord(tag, payload, reader, 0) };
  }
  if (!reader.isEmpty()) {
    throw pvceError('TrailingBytes');
  }
  return root;
}

/** Strict streaming reader over one stream or payload (lib.rs:630-723). */
class Reader {
  private readonly bytes: Uint8Array;
  private offset = 0;
  readonly limits: DecodeLimits;
  private nodes = 0;

  constructor(bytes: Uint8Array, limits: DecodeLimits) {
    this.bytes = bytes;
    this.limits = limits;
  }

  /** Consumes n octets or throws unexpected-end (lib.rs:648-659). */
  take(length: number): Uint8Array {
    if (this.offset + length > this.bytes.length) {
      throw pvceError('UnexpectedEnd');
    }
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  octet(): number {
    return this.take(1)[0];
  }

  /** Reads one unsigned varint, rejecting non-minimal encodings and 64-bit overflow (lib.rs:665-683). */
  varint(): bigint {
    const start = this.offset;
    let value = 0n;
    for (let shift = 0n; shift <= 63n; shift += 7n) {
      const octet = this.octet();
      const low = BigInt(octet & 0x7f);
      if (shift === 63n && low > 1n) {
        throw pvceError('VarintOverflow');
      }
      value |= low << shift;
      if ((octet & 0x80) === 0) {
        if (this.offset - start > 1 && low === 0n) {
          throw pvceError('NonCanonicalVarint');
        }
        return value;
      }
    }
    throw pvceError('VarintOverflow');
  }

  /** Reads one varint length and enforces the named limit (lib.rs:685-691). */
  length(limit: number, name: string): number {
    const value = this.varint();
    if (value > BigInt(limit)) {
      throw pvceError('ResourceLimit', { field: name });
    }
    return Number(value);
  }

  /** Reads one tag-length-prefixed record; payload length is bounded by maxBytes ("record-bytes", lib.rs:693-697). */
  record(): [bigint, Uint8Array] {
    const tag = this.varint();
    const n = this.length(this.limits.maxBytes, 'record-bytes');
    return [tag, this.take(n)];
  }

  isEmpty(): boolean {
    return this.offset === this.bytes.length;
  }

  /** A sub-reader over a delimited payload sharing the limits and node count (lib.rs:703-710). */
  child(payload: Uint8Array): Reader {
    const child = new Reader(payload, this.limits);
    child.nodes = this.nodes;
    return child;
  }

  /** Propagates the child node count back to the parent (lib.rs:712-714). */
  absorb(child: Reader): void {
    this.nodes = child.nodes;
  }

  /** Counts one core record and enforces maxNodes (lib.rs:716-722). */
  countNode(): void {
    this.nodes += 1;
    if (this.nodes > this.limits.maxNodes) {
      throw pvceError('ResourceLimit', { field: 'value-nodes' });
    }
  }
}

/** Decodes one delimited core record (lib.rs:725-833). */
function decodeCoreRecord(
  tag: bigint,
  payload: Uint8Array,
  parent: Reader,
  depth: number,
): PortableValue {
  if (depth > parent.limits.maxDepth) {
    throw pvceError('ResourceLimit', { field: 'nesting-depth' });
  }
  parent.countNode();
  const reader = parent.child(payload);
  let value: PortableValue;
  switch (tag) {
    case TAG_NULL:
      if (payload.length !== 0) {
        throw pvceError('InvalidPayload', { value: tag });
      }
      value = { kind: 'Null' };
      break;
    case TAG_FALSE:
      if (payload.length !== 0) {
        throw pvceError('InvalidPayload', { value: tag });
      }
      value = { kind: 'Boolean', value: false };
      break;
    case TAG_TRUE:
      if (payload.length !== 0) {
        throw pvceError('InvalidPayload', { value: tag });
      }
      value = { kind: 'Boolean', value: true };
      break;
    case TAG_INTEGER:
      value = { kind: 'Integer', value: decodeIntegerPayload(reader) };
      break;
    case TAG_DECIMAL:
      value = { kind: 'Decimal', ...decodeDecimalPayload(reader) };
      break;
    case TAG_FLOAT32:
      if (payload.length !== 4) {
        throw pvceError('InvalidPayload', { value: tag });
      }
      value = {
        kind: 'BinaryFloat32',
        bits: dataViewOf(reader.take(4)).getUint32(0, false),
      };
      break;
    case TAG_FLOAT64:
      if (payload.length !== 8) {
        throw pvceError('InvalidPayload', { value: tag });
      }
      value = {
        kind: 'BinaryFloat64',
        bits: dataViewOf(reader.take(8)).getBigUint64(0, false),
      };
      break;
    case TAG_STRING: {
      const bytes = decodeBlob(reader);
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw pvceError('InvalidUtf8');
      }
      value = { kind: 'String', value: text };
      break;
    }
    case TAG_BYTES:
      // The decoded Bytes never alias the input stream (NewBytes copies).
      value = { kind: 'Bytes', value: Uint8Array.from(decodeBlob(reader)) };
      break;
    case TAG_DATE: {
      const { year, month, day } = decodeDatePayload(reader);
      try {
        value = dateValue(year, month, day);
      } catch {
        throw pvceError('InvalidTemporal');
      }
      break;
    }
    case TAG_TIME: {
      const { hour, minute, second, fraction } = decodeTimePayload(reader);
      try {
        value = timeValue(hour, minute, second, fraction);
      } catch {
        throw pvceError('InvalidTemporal');
      }
      break;
    }
    case TAG_LOCAL_DATE_TIME:
      value = localDateTimeValue(
        decodeDateField(reader),
        decodeTimeField(reader),
      );
      break;
    case TAG_OFFSET_DATE_TIME: {
      const local = localDateTimeValue(decodeDateField(reader), decodeTimeField(reader));
      const offset = decodeIntegerField(reader);
      if (offset < -2147483648n || offset > 2147483647n) {
        throw pvceError('InvalidTemporal');
      }
      try {
        value = offsetDateTimeValue(local, Number(offset));
      } catch {
        throw pvceError('InvalidTemporal');
      }
      break;
    }
    case TAG_SEQUENCE: {
      const count = reader.length(reader.limits.maxContainerEntries, 'container-entries');
      const items: PortableValue[] = [];
      for (let i = 0; i < count; i++) {
        const [childTag, childPayload] = reader.record();
        if (childTag === TAG_EXTENDED) {
          throw pvceError('NestedExtended');
        }
        items.push(decodeCoreRecord(childTag, childPayload, reader, depth + 1));
      }
      value = { kind: 'Sequence', items };
      break;
    }
    case TAG_OBJECT: {
      const count = reader.length(reader.limits.maxContainerEntries, 'container-entries');
      const entries: { key: string; value: PortableValue }[] = [];
      for (let i = 0; i < count; i++) {
        const [keyTag, keyPayload] = reader.record();
        if (keyTag !== TAG_STRING) {
          throw pvceError('ObjectKeyNotString');
        }
        const keyValue = decodeCoreRecord(keyTag, keyPayload, reader, depth + 1);
        const [valueTag, valuePayload] = reader.record();
        if (valueTag === TAG_EXTENDED) {
          throw pvceError('NestedExtended');
        }
        const item = decodeCoreRecord(valueTag, valuePayload, reader, depth + 1);
        entries.push({ key: (keyValue as { value: string }).value, value: item });
      }
      try {
        value = objectValue(entries);
      } catch (error) {
        if (error instanceof DuplicateKeyError) {
          throw pvceError('DuplicateObjectKey');
        }
        throw error;
      }
      break;
    }
    case TAG_ENTRY_MAPPING: {
      const count = reader.length(reader.limits.maxContainerEntries, 'container-entries');
      const entries: { key: PortableValue; value: PortableValue }[] = [];
      for (let i = 0; i < count; i++) {
        const [keyTag, keyPayload] = reader.record();
        const key = decodeCoreRecord(keyTag, keyPayload, reader, depth + 1);
        const [valueTag, valuePayload] = reader.record();
        const item = decodeCoreRecord(valueTag, valuePayload, reader, depth + 1);
        entries.push({ key, value: item });
      }
      value = entryMappingValue(entries);
      break;
    }
    case TAG_EXTENDED:
      throw pvceError('NestedExtended');
    default:
      throw pvceError('UnknownCoreTag', { value: tag });
  }
  if (!reader.isEmpty()) {
    throw pvceError('TrailingPayload', { value: tag });
  }
  parent.absorb(reader);
  return value;
}

/** Integer payload: sign octet, magnitude length varint, magnitude octets (lib.rs:835-846). */
function decodeIntegerPayload(reader: Reader): bigint {
  const sign = reader.octet();
  const n = reader.length(reader.limits.maxIntegerBytes, 'integer-bytes');
  const magnitude = reader.take(n);
  if (sign === 0) {
    if (magnitude.length === 0) {
      return 0n;
    }
    throw pvceError('NonCanonicalInteger');
  }
  if (sign !== 1 && sign !== 2) {
    throw pvceError('InvalidIntegerSign', { value: BigInt(sign) });
  }
  if (magnitude.length === 0 || magnitude[0] === 0) {
    throw pvceError('NonCanonicalInteger');
  }
  const value = bigintFromMagnitude(magnitude);
  return sign === 2 ? -value : value;
}

/** Length-prefixed integer field with the +16 slack limit (lib.rs:848-860). */
function decodeIntegerField(reader: Reader): bigint {
  const n = reader.length(reader.limits.maxIntegerBytes + 16, 'integer-field');
  const payload = reader.take(n);
  const field = reader.child(payload);
  const value = decodeIntegerPayload(field);
  if (!field.isEmpty()) {
    throw pvceError('TrailingField');
  }
  reader.absorb(field);
  return value;
}

/** Decimal payload with renormalization rejection (lib.rs:862-870). */
function decodeDecimalPayload(reader: Reader): { coefficient: bigint; exponent: bigint } {
  const coefficient = decodeIntegerField(reader);
  const exponent = decodeIntegerField(reader);
  const normalized = normalizeDecimal(coefficient, exponent);
  if (normalized.coefficient !== coefficient || normalized.exponent !== exponent) {
    throw pvceError('NonCanonicalDecimal');
  }
  return normalized;
}

function normalizeDecimal(coefficient: bigint, exponent: bigint): { coefficient: bigint; exponent: bigint } {
  if (coefficient === 0n) {
    return { coefficient: 0n, exponent: 0n };
  }
  let c = coefficient;
  let e = exponent;
  while (c % 10n === 0n) {
    c /= 10n;
    e += 1n;
  }
  return { coefficient: c, exponent: e };
}

/** Length-prefixed decimal field with the *2+32 slack limit (lib.rs:872-888). */
function decodeDecimalField(reader: Reader): { coefficient: bigint; exponent: bigint } {
  const n = reader.length(reader.limits.maxIntegerBytes * 2 + 32, 'decimal-field');
  const payload = reader.take(n);
  const field = reader.child(payload);
  const value = decodeDecimalPayload(field);
  if (!field.isEmpty()) {
    throw pvceError('TrailingField');
  }
  reader.absorb(field);
  return value;
}

/** Length-prefixed octet string (lib.rs:890-893). */
function decodeBlob(reader: Reader): Uint8Array {
  const n = reader.length(reader.limits.maxBlobBytes, 'blob-bytes');
  return reader.take(n);
}

/** Date payload: year field plus month/day octets (lib.rs:895-900). */
function decodeDatePayload(reader: Reader): { year: bigint; month: number; day: number } {
  const year = decodeIntegerField(reader);
  const month = reader.octet();
  const day = reader.octet();
  return { year, month, day };
}

/** Length-prefixed date field with the +32 slack limit (lib.rs:902-914). */
function decodeDateField(reader: Reader): DateValue {
  const n = reader.length(reader.limits.maxIntegerBytes + 32, 'date-field');
  const payload = reader.take(n);
  const field = reader.child(payload);
  const { year, month, day } = decodeDatePayload(field);
  if (!field.isEmpty()) {
    throw pvceError('TrailingField');
  }
  reader.absorb(field);
  try {
    return dateValue(year, month, day);
  } catch {
    throw pvceError('InvalidTemporal');
  }
}

/** Time payload: hour/minute/second octets plus the fraction field (lib.rs:916-922). */
function decodeTimePayload(reader: Reader): {
  hour: number;
  minute: number;
  second: number;
  fraction: DecimalValue;
} {
  const hour = reader.octet();
  const minute = reader.octet();
  const second = reader.octet();
  const fraction: DecimalValue = { kind: 'Decimal', ...decodeDecimalField(reader) };
  return { hour, minute, second, fraction };
}

/** Length-prefixed time field with the *2+64 slack limit (lib.rs:924-940). */
function decodeTimeField(reader: Reader): TimeValue {
  const n = reader.length(reader.limits.maxIntegerBytes * 2 + 64, 'time-field');
  const payload = reader.take(n);
  const field = reader.child(payload);
  const { hour, minute, second, fraction } = decodeTimePayload(field);
  if (!field.isEmpty()) {
    throw pvceError('TrailingField');
  }
  reader.absorb(field);
  try {
    return timeValue(hour, minute, second, fraction);
  } catch {
    throw pvceError('InvalidTemporal');
  }
}

/** Extension root payload (lib.rs:949-969). */
function decodeExtended(payload: Uint8Array, parent: Reader): ExtendedValue {
  const reader = parent.child(payload);
  let typeId: string;
  let codecId: string;
  try {
    typeId = new TextDecoder('utf-8', { fatal: true }).decode(decodeBlob(reader));
  } catch {
    throw pvceError('InvalidUtf8');
  }
  const semanticVersionValue = reader.varint();
  if (semanticVersionValue > 0xffffffffn) {
    throw pvceError('LengthOverflow');
  }
  try {
    codecId = new TextDecoder('utf-8', { fatal: true }).decode(decodeBlob(reader));
  } catch {
    throw pvceError('InvalidUtf8');
  }
  const canonicalPayload = decodeBlob(reader);
  if (!reader.isEmpty()) {
    throw pvceError('TrailingPayload', { value: TAG_EXTENDED });
  }
  parent.absorb(reader);
  return {
    typeId,
    semanticVersion: Number(semanticVersionValue),
    payloadCodecId: codecId,
    canonicalPayload: Uint8Array.from(canonicalPayload),
  };
}

function byteArraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** A DataView over exactly the given subarray, honoring its byte offset. */
function dataViewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
}

// ---------------------------------------------------------------------------
// Bounded-encode size measurement
// ---------------------------------------------------------------------------

/** Measures the canonical PVCE/1 size of a value without producing bytes (lib.rs:170-364). */
class Sizer {
  private readonly limits: EncodeLimits;
  private nodes = 0;

  constructor(limits: EncodeLimits) {
    this.limits = limits;
  }

  recordSize(value: PortableValue, depth: number): number {
    if (depth > this.limits.maxDepth) {
      throw pvceError('ResourceLimit', { field: 'nesting-depth' });
    }
    this.nodes += 1;
    if (this.nodes > this.limits.maxNodes) {
      throw pvceError('ResourceLimit', { field: 'value-nodes' });
    }
    let tag: bigint;
    let payload: number;
    switch (value.kind) {
      case 'Null':
        tag = TAG_NULL;
        payload = 0;
        break;
      case 'Boolean':
        tag = value.value ? TAG_TRUE : TAG_FALSE;
        payload = 0;
        break;
      case 'Integer': {
        tag = TAG_INTEGER;
        const magnitude = bigintMagnitude(value.value);
        if (magnitude.length > this.limits.maxIntegerBytes) {
          throw pvceError('ResourceLimit', { field: 'integer-bytes' });
        }
        payload = 1 + varintSize(BigInt(magnitude.length)) + magnitude.length;
        break;
      }
      case 'Decimal': {
        tag = TAG_DECIMAL;
        payload =
          this.integerFieldSize(value.coefficient) + this.integerFieldSize(value.exponent);
        break;
      }
      case 'BinaryFloat32':
        tag = TAG_FLOAT32;
        payload = 4;
        break;
      case 'BinaryFloat64':
        tag = TAG_FLOAT64;
        payload = 8;
        break;
      case 'String':
        tag = TAG_STRING;
        payload = this.blobSize(textBytes(value.value).length);
        break;
      case 'Bytes':
        tag = TAG_BYTES;
        payload = this.blobSize(value.value.length);
        break;
      case 'Date':
        ensureDateValid(value);
        tag = TAG_DATE;
        payload = this.integerFieldSize(value.year) + 2;
        break;
      case 'Time':
        ensureTimeValid(value);
        tag = TAG_TIME;
        payload = 3 + this.decimalFieldSize(value.fraction);
        break;
      case 'LocalDateTime':
        ensureLocalValid(value);
        tag = TAG_LOCAL_DATE_TIME;
        payload = this.dateFieldSize(value.date) + this.timeFieldSize(value.time);
        break;
      case 'OffsetDateTime':
        ensureLocalValid(value.local);
        tag = TAG_OFFSET_DATE_TIME;
        payload =
          this.dateFieldSize(value.local.date) +
          this.timeFieldSize(value.local.time) +
          this.integerFieldSize(BigInt(value.offsetSeconds));
        break;
      case 'Sequence': {
        tag = TAG_SEQUENCE;
        payload = this.containerSize(value.items.length, value.items, depth);
        break;
      }
      case 'Object': {
        tag = TAG_OBJECT;
        if (value.entries.length > this.limits.maxContainerEntries) {
          throw pvceError('ResourceLimit', { field: 'container-entries' });
        }
        payload = varintSize(BigInt(value.entries.length));
        for (const entry of value.entries) {
          // Keys encode as String records and count as nodes (lib.rs:332-341).
          payload += this.recordSize({ kind: 'String', value: entry.key }, depth + 1);
          payload += this.recordSize(entry.value, depth + 1);
        }
        break;
      }
      case 'EntryMapping': {
        tag = TAG_ENTRY_MAPPING;
        if (value.entries.length > this.limits.maxContainerEntries) {
          throw pvceError('ResourceLimit', { field: 'container-entries' });
        }
        payload = varintSize(BigInt(value.entries.length));
        for (const entry of value.entries) {
          payload += this.recordSize(entry.key, depth + 1);
          payload += this.recordSize(entry.value, depth + 1);
        }
        break;
      }
    }
    return varintSize(tag) + varintSize(BigInt(payload)) + payload;
  }

  extendedSize(value: ExtendedValue): number {
    const payload =
      this.blobSize(textBytes(value.typeId).length) +
      varintSize(BigInt(value.semanticVersion >>> 0)) +
      this.blobSize(textBytes(value.payloadCodecId).length) +
      this.blobSize(value.canonicalPayload.length);
    return varintSize(TAG_EXTENDED) + varintSize(BigInt(payload)) + payload;
  }

  private containerSize(
    count: number,
    values: readonly PortableValue[],
    depth: number,
  ): number {
    if (count > this.limits.maxContainerEntries) {
      throw pvceError('ResourceLimit', { field: 'container-entries' });
    }
    let payload = varintSize(BigInt(count));
    for (const value of values) {
      payload += this.recordSize(value, depth + 1);
    }
    return payload;
  }

  private blobSize(length: number): number {
    if (length > this.limits.maxBlobBytes) {
      throw pvceError('ResourceLimit', { field: 'blob-bytes' });
    }
    return varintSize(BigInt(length)) + length;
  }

  private integerFieldSize(value: bigint): number {
    const magnitude = bigintMagnitude(value);
    if (magnitude.length > this.limits.maxIntegerBytes) {
      throw pvceError('ResourceLimit', { field: 'integer-bytes' });
    }
    const payload = 1 + varintSize(BigInt(magnitude.length)) + magnitude.length;
    return varintSize(BigInt(payload)) + payload;
  }

  private decimalFieldSize(value: { readonly coefficient: bigint; readonly exponent: bigint }): number {
    const payload =
      this.integerFieldSize(value.coefficient) + this.integerFieldSize(value.exponent);
    return varintSize(BigInt(payload)) + payload;
  }

  private dateFieldSize(value: DateValue): number {
    const payload = this.integerFieldSize(value.year) + 2;
    return varintSize(BigInt(payload)) + payload;
  }

  private timeFieldSize(value: TimeValue): number {
    const payload = 3 + this.decimalFieldSize(value.fraction);
    return varintSize(BigInt(payload)) + payload;
  }
}

/** Encode-time revalidation of structurally constructed dates (go/core/pvce.go). */
function ensureDateValid(value: DateValue): void {
  if (!dateFieldsValid(value.year, value.month, value.day)) {
    throw invalidValue();
  }
}

/** Encode-time revalidation of structurally constructed times. */
function ensureTimeValid(value: TimeValue): void {
  if (value.hour > 23 || value.minute > 59 || value.second > 59 || !isFraction(value.fraction)) {
    throw invalidValue();
  }
}

/** Encode-time revalidation of local date-times (the date part must be valid). */
function ensureLocalValid(value: LocalDateTimeValue): void {
  ensureDateValid(value.date);
}

/** Narrowing helper for offset date-time locals. */
export function isOffsetDateTimeValue(v: PortableValue): v is OffsetDateTimeValue {
  return v.kind === 'OffsetDateTime';
}

// The frozen API names of RFC 0016 §4.2 (EncodePVCE/DecodePVCE), kept as
// aliases of the idiomatic lowercase entry points.
export const EncodePVCE = encode;
export const DecodePVCE = decode;
export const EncodePVCEBounded = encodeBounded;
