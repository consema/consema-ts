/**
 * Deterministic sorted Object<String, String> wire records.
 *
 * authority: the Rust BTreeMap ordering of string maps in protocol records
 * (diagnostic.rs arguments; registry.rs preconditions); go/protocol/
 * diagnostic.go:406-418 (cross-reference).
 */

import type { ObjectValue, PortableValue } from '../core/value.ts';
import { stringOf, objectOf } from './records.ts';

/** Encodes a deterministic sorted Object<String, String>. */
export function stringMapObject(values: ReadonlyMap<string, string>): ObjectValue {
  const keys = [...values.keys()].sort();
  return {
    kind: 'Object',
    entries: keys.map((key) => ({ key, value: { kind: 'String', value: values.get(key)! } })),
  };
}

/** Decodes an Object<String, String>. */
export function stringMapFromObject(value: PortableValue, path: string): Map<string, string> {
  const object = objectOf(value, path);
  const output = new Map<string, string>();
  for (const entry of object.entries) {
    output.set(entry.key, stringOf(entry.value, `${path}.${entry.key}`));
  }
  return output;
}
