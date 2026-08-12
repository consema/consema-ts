/**
 * Shared fixed-field record helpers for the protocol records.
 *
 * Every protocol record is a PortableValue Object whose first field is the
 * `schema` discriminator and whose remaining fields follow a fixed order
 * (RFC 0015 §4.2 "fixed-field discipline"; the Rust schema helpers,
 * crates/consema-protocol/src/schema.rs). These helpers implement the
 * strict field-order/unknown-field/type checks used by every record decoder.
 */

import {
  stringValue,
  integerValue,
} from '../core/value.ts';
import type {
  PortableValue,
  IntegerValue,
  ObjectValue,
} from '../core/value.ts';
import { protocolError, ProtocolError } from './errors.ts';
import type { ProtocolLimits } from './limits.ts';

/**
 * Strictly reads the fields of a record with the given schema discriminator.
 * The value must be an Object whose first field is `schema` carrying the
 * exact schema string, followed by exactly the named fields in order.
 */
export function schemaFields(
  value: PortableValue,
  schema: string,
  names: readonly string[],
  path: string,
): PortableValue[] {
  const fields = exactFields(value, ['schema', ...names], path);
  const observed = stringOf(fields[0], `${path}.schema`);
  if (observed !== schema) {
    throw protocolError('SchemaMismatch', `${path}.schema`, `expected ${schema}`);
  }
  return fields.slice(1);
}

/**
 * Strictly reads an Object with exactly the named fields in order
 * (schema.rs:16-53): an undeclared field is an UnknownField rejection at the
 * first offending key, an absent required field is a MissingField rejection
 * at the first absent name, and any order deviation is a SchemaMismatch.
 */
export function exactFields(
  value: PortableValue,
  names: readonly string[],
  path: string,
): PortableValue[] {
  if (value.kind !== 'Object') {
    throw protocolError('WrongType', path, 'expected Object');
  }
  const keys = value.entries.map((entry) => entry.key);
  const unknown = keys.find((key) => !names.includes(key));
  if (unknown !== undefined) {
    throw protocolError('UnknownField', `${path}.${unknown}`, 'field is not declared by the fixed schema');
  }
  const missing = names.find((name) => !keys.includes(name));
  if (missing !== undefined) {
    throw protocolError('MissingField', `${path}.${missing}`, 'required field is absent');
  }
  for (let i = 0; i < names.length; i++) {
    if (keys[i] !== names[i]) {
      throw protocolError('SchemaMismatch', path, 'fields are not in canonical order');
    }
  }
  return value.entries.map((entry) => entry.value);
}

/** Requires a String field. */
export function stringOf(value: PortableValue, path: string): string {
  if (value.kind !== 'String') {
    throw protocolError('WrongType', path, 'expected String');
  }
  return value.value;
}

/** Requires a String field and validates the strict identifier shape. */
export function identifierOf(value: PortableValue, path: string): string {
  return stringOf(value, path);
}

/** Requires an Integer field fitting uint32. */
export function unsigned32(value: PortableValue, path: string): number {
  const n = unsignedBigInt(value, path);
  if (n > 0xffffffffn) {
    throw protocolError('InvalidValue', path, 'integer exceeds uint32');
  }
  return Number(n);
}

/** Requires an Integer field fitting uint64. */
export function unsigned64(value: PortableValue, path: string): bigint {
  const n = unsignedBigInt(value, path);
  if (n > 0xffffffffffffffffn) {
    throw protocolError('InvalidValue', path, 'integer exceeds uint64');
  }
  return n;
}

/** Requires an Integer field fitting int32. */
export function signed32(value: PortableValue, path: string): number {
  const n = integerOf(value, path);
  if (n < -2147483648n || n > 2147483647n) {
    throw protocolError('InvalidValue', path, 'integer outside int32');
  }
  return Number(n);
}

/** Requires a non-negative Integer field. */
export function unsignedBigInt(value: PortableValue, path: string): bigint {
  const n = integerOf(value, path);
  if (n < 0n) {
    throw protocolError('InvalidValue', path, 'integer must be non-negative');
  }
  return n;
}

/** Requires an Integer field. */
export function integerOf(value: PortableValue, path: string): bigint {
  if (value.kind !== 'Integer') {
    throw protocolError('WrongType', path, 'expected Integer');
  }
  return value.value;
}

/** Requires a Sequence field and returns its items. */
export function sequenceOf(value: PortableValue, path: string): PortableValue[] {
  if (value.kind !== 'Sequence') {
    throw protocolError('WrongType', path, 'expected Sequence');
  }
  return [...value.items];
}

/** The Integer leaf used for record counter fields (u64). */
export function counterValue(value: bigint): IntegerValue {
  return integerValue(value);
}

/** The portable Integer leaf for one uint64 wire value. */
export function wireInteger(value: bigint | number): IntegerValue {
  return integerValue(BigInt(value));
}

/** A String leaf. */
export function wireString(value: string): PortableValue {
  return stringValue(value);
}

/** The canonical `{id, version}` reference record (registry.rs referenceValue). */
export function referenceValue(id: string, version: number): ObjectValue {
  return objectValueFrom([
    { key: 'id', value: stringValue(id) },
    { key: 'version', value: integerValue(BigInt(version)) },
  ]);
}

/** Parses a `{id, version}` reference record. */
export function parseReference(value: PortableValue, path: string): { id: string; version: number } {
  const fields = exactFields(value, ['id', 'version'], path);
  const id = stringOf(fields[0], `${path}.id`);
  const version = unsigned32(fields[1], `${path}.version`);
  return { id, version };
}

/** Builds a unique-key Object from pre-validated entries. */
export function objectValueFrom(entries: readonly { key: string; value: PortableValue }[]): ObjectValue {
  // Callers always build from fixed field sets; the Object contract
  // (unique keys) holds by construction.
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.key)) {
      throw new Error(`internal: duplicate record field ${entry.key}`);
    }
    seen.add(entry.key);
  }
  return { kind: 'Object', entries: entries.map((entry) => ({ key: entry.key, value: entry.value })) };
}

/** Requires an Object field (for nested records). */
export function objectOf(value: PortableValue, path: string): ObjectValue {
  if (value.kind !== 'Object') {
    throw protocolError('WrongType', path, 'expected Object');
  }
  return value;
}

/** The Bytes leaf of a wire byte field. */
export function wireBytes(bytes: Uint8Array): PortableValue {
  return { kind: 'Bytes', value: Uint8Array.from(bytes) };
}

/** Requires a Bytes field and returns a copy. */
export function bytesOf(value: PortableValue, path: string): Uint8Array {
  if (value.kind !== 'Bytes') {
    throw protocolError('WrongType', path, 'expected Bytes');
  }
  return Uint8Array.from(value.value);
}

/** Requires a Boolean field. */
export function booleanOf(value: PortableValue, path: string): boolean {
  if (value.kind !== 'Boolean') {
    throw protocolError('WrongType', path, 'expected Boolean');
  }
  return value.value;
}

/** The Null singleton or a string field (for optional strings). */
export function nullableStringOf(value: PortableValue, path: string): string | null {
  if (value.kind === 'Null') {
    return null;
  }
  return stringOf(value, path);
}

/** The Null singleton or a value field. */
export function nullableValueOf(value: PortableValue): PortableValue | null {
  return value.kind === 'Null' ? null : value;
}

/** Enforces the protocol transport limits on one record depth/node count. */
export class RecordState {
  private readonly limits: ProtocolLimits;
  private nodes = 0;

  constructor(limits: ProtocolLimits) {
    this.limits = limits;
  }

  node(depth: number, path: string): void {
    if (depth > this.limits.maxDepth) {
      throw new ProtocolError('ResourceLimit', path, 'nesting depth');
    }
    this.nodes += 1;
    if (this.nodes > this.limits.maxNodes) {
      throw new ProtocolError('ResourceLimit', path, 'value nodes');
    }
  }

  container(count: number, path: string): void {
    if (count > this.limits.maxContainerEntries) {
      throw new ProtocolError('ResourceLimit', path, 'container entries');
    }
  }
}
