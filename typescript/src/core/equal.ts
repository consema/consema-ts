/**
 * Strict PortableValue equality and deterministic hashing.
 *
 * authority: RFC 0016 §4.1 (kind identity plus canonical content equality);
 * the FNV-1a-over-PVCE hash contract matches the Go implementation
 * (go/core/equal.go) and the conformance vectors (v1.json:
 * "value.decimal-normalization" pins strict_equal/strict_hash_equal).
 *
 * Design (TypeScript-idiomatic): equality is an exhaustive switch on the
 * `kind` discriminant — the compiler guarantees the switch is total over the
 * closed fifteen kinds, so no unknown-kind fallback can silently accept
 * anything. `hash` is FNV-1a (64-bit, mod 2^64) over the canonical PVCE/1
 * encoding of the value (go/core/equal.go:125-138), so equal values always
 * hash equal and the hash is order- and duplicates-sensitive. BigInt is used
 * for the 64-bit hash arithmetic to avoid signed 32-bit overflow pitfalls.
 */

import type { PortableValue, BytesValue } from './value.ts';
import { EncodePVCE } from './pvce.ts';

/** FNV-1a 64-bit offset basis and prime (the Go hash/fnv constants). */
export const FNV64_OFFSET_BASIS = 0xcbf29ce484222325n;
export const FNV64_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** FNV-1a 64-bit hash of a byte sequence, reduced mod 2^64. */
export function fnv1a64(bytes: Uint8Array): bigint {
  let hash = FNV64_OFFSET_BASIS;
  for (const octet of bytes) {
    hash ^= BigInt(octet);
    hash = (hash * FNV64_PRIME) & MASK64;
  }
  return hash;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
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

/**
 * Strict PortableValue equality (RFC 0016 §4.1): kind identity plus
 * canonical content equality. Objects compare entry-by-entry in stored order
 * (keys and values); entry mappings compare association-by-association in
 * stored order (duplicates included); sequences compare item-by-item in
 * stored order. BinaryFloat32/64 identity is the exact bit pattern, so NaN
 * payloads and the sign of zero compare by bits.
 */
export function equal(a: PortableValue, b: PortableValue): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  switch (a.kind) {
    case 'Null':
      return true;
    case 'Boolean':
      return a.value === (b as typeof a).value;
    case 'String':
      return a.value === (b as typeof a).value;
    case 'Bytes':
      return bytesEqual(a.value, (b as typeof a).value);
    case 'Integer':
      return a.value === (b as typeof a).value;
    case 'Decimal':
      return (
        a.coefficient === (b as typeof a).coefficient &&
        a.exponent === (b as typeof a).exponent
      );
    case 'BinaryFloat32':
      return a.bits === (b as typeof a).bits;
    case 'BinaryFloat64':
      return a.bits === (b as typeof a).bits;
    case 'Date':
      return (
        a.year === (b as typeof a).year &&
        a.month === (b as typeof a).month &&
        a.day === (b as typeof a).day
      );
    case 'Time':
      return (
        a.hour === (b as typeof a).hour &&
        a.minute === (b as typeof a).minute &&
        a.second === (b as typeof a).second &&
        equal(a.fraction, (b as typeof a).fraction)
      );
    case 'LocalDateTime':
      return equal(a.date, (b as typeof a).date) && equal(a.time, (b as typeof a).time);
    case 'OffsetDateTime':
      return (
        equal(a.local, (b as typeof a).local) &&
        a.offsetSeconds === (b as typeof a).offsetSeconds
      );
    case 'Sequence': {
      const other = b as typeof a;
      if (a.items.length !== other.items.length) {
        return false;
      }
      for (let i = 0; i < a.items.length; i++) {
        if (!equal(a.items[i], other.items[i])) {
          return false;
        }
      }
      return true;
    }
    case 'Object': {
      const other = b as typeof a;
      if (a.entries.length !== other.entries.length) {
        return false;
      }
      for (let i = 0; i < a.entries.length; i++) {
        if (
          a.entries[i].key !== other.entries[i].key ||
          !equal(a.entries[i].value, other.entries[i].value)
        ) {
          return false;
        }
      }
      return true;
    }
    case 'EntryMapping': {
      const other = b as typeof a;
      if (a.entries.length !== other.entries.length) {
        return false;
      }
      for (let i = 0; i < a.entries.length; i++) {
        if (
          !equal(a.entries[i].key, other.entries[i].key) ||
          !equal(a.entries[i].value, other.entries[i].value)
        ) {
          return false;
        }
      }
      return true;
    }
  }
}

/**
 * Deterministic 64-bit hash consistent with `equal`: equal values always
 * hash equal. Defined as FNV-1a over the canonical PVCE/1 encoding of the
 * value (go/core/equal.go:125-138), so equal values encode identically and
 * the hash is order- and duplicates-sensitive. Returns 0n for a value the
 * codec rejects (canonical values always encode, so this is unreachable in
 * practice).
 */
export function hash(v: PortableValue): bigint {
  let encoded: Uint8Array;
  try {
    encoded = EncodePVCE(v);
  } catch {
    return 0n;
  }
  return fnv1a64(encoded);
}

/** Narrowing helper for Bytes leaf comparisons. */
export function isBytesValue(v: PortableValue): v is BytesValue {
  return v.kind === 'Bytes';
}
