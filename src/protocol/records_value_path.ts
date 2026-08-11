/**
 * Portable value path and association location wire records.
 *
 * authority: crates/consema-protocol/src/value_transport.rs (records_valuepath
 * and association location codecs; cross-reference go/protocol/
 * records_valuepath.go). The path is an ordered list of typed segments
 * (SequenceElement with an Integer key, or ObjectValue/EntryKey/EntryValue
 * with a String key); association locations bind a path, a u64 ordinal, and
 * one of the three association roles.
 */

import type { ObjectValue, PortableValue } from '../core/value.ts';
import { protocolError, invalid } from './errors.ts';
import { exactFields, schemaFields, sequenceOf, stringOf, unsigned64, objectValueFrom } from './records.ts';

export type ValuePathSegmentKind = 'SequenceElement' | 'ObjectValue' | 'EntryKey' | 'EntryValue';

export type ValuePathSegment = {
  readonly kind: ValuePathSegmentKind;
  readonly key: string | bigint;
};

/** The `core.value-path@1` record (records_valuepath.go). */
export class ValuePath {
  readonly segments: readonly ValuePathSegment[];

  constructor(segments: readonly ValuePathSegment[] = []) {
    this.segments = Object.freeze([...segments]);
  }

  /** The empty root path. */
  static root(): ValuePath {
    return new ValuePath();
  }

  /** Appends one typed segment. */
  append(kind: ValuePathSegmentKind, key: string | bigint): ValuePath {
    return new ValuePath([...this.segments, { kind, key }]);
  }

  /** Encodes `core.value-path@1`. */
  toValue(): ObjectValue {
    const items = this.segments.map((segment) =>
      objectValueFrom([
        { key: 'kind', value: { kind: 'String', value: segment.kind } },
        {
          key: 'key',
          value:
            typeof segment.key === 'bigint'
              ? { kind: 'Integer', value: segment.key }
              : { kind: 'String', value: segment.key },
        },
      ]),
    );
    return objectValueFrom([
      { key: 'schema', value: { kind: 'String', value: 'core.value-path@1' } },
      { key: 'segments', value: { kind: 'Sequence', items } },
    ]);
  }

  /** Strictly decodes `core.value-path@1`. */
  static fromValue(value: PortableValue): ValuePath {
    const fields = schemaFields(value, 'core.value-path@1', ['segments'], '$');
    const segments: ValuePathSegment[] = [];
    for (const item of sequenceOf(fields[0], '$.segments')) {
      const segment = exactFields(item, ['kind', 'key'], '$.segments');
      const kind = stringOf(segment[0], '$.segments.kind') as ValuePathSegmentKind;
      const key = parsePathKey(segment[1], '$.segments.key');
      segments.push({ kind, key });
    }
    return new ValuePath(segments);
  }

  /** Ordered equality over typed segments. */
  equal(other: ValuePath): boolean {
    if (this.segments.length !== other.segments.length) {
      return false;
    }
    return this.segments.every((segment, index) => {
      const that = other.segments[index];
      return segment.kind === that.kind && segment.key === that.key;
    });
  }

  /** The canonical ordering of the record (kind, then key). */
  less(other: ValuePath): boolean {
    const left = this.segments;
    const right = other.segments;
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      if (left[index].kind !== right[index].kind) {
        return left[index].kind < right[index].kind;
      }
      const leftKey = left[index].key;
      const rightKey = right[index].key;
      if (leftKey !== rightKey) {
        if (typeof leftKey === 'bigint' && typeof rightKey === 'bigint') {
          return leftKey < rightKey;
        }
        return String(leftKey) < String(rightKey);
      }
    }
    return left.length < right.length;
  }
}

function parsePathKey(value: PortableValue, path: string): string | bigint {
  if (value.kind === 'Integer') {
    return value.value;
  }
  if (value.kind === 'String') {
    return value.value;
  }
  throw protocolError('WrongType', path, 'expected Integer or String');
}

export type AssociationRole = 'ObjectEntry' | 'ObjectKey' | 'EntryMappingEntry';

/** The `core.association-location@1` record. */
export class AssociationLocation {
  readonly path: ValuePath;
  readonly ordinal: bigint;
  readonly role: AssociationRole;

  constructor(path: ValuePath, ordinal: bigint, role: AssociationRole) {
    this.path = path;
    this.ordinal = ordinal;
    this.role = role;
  }

  /** Encodes `core.association-location@1`. */
  toValue(): ObjectValue {
    return objectValueFrom([
      { key: 'schema', value: { kind: 'String', value: 'core.association-location@1' } },
      { key: 'path', value: this.path.toValue() },
      { key: 'ordinal', value: { kind: 'Integer', value: this.ordinal } },
      { key: 'role', value: { kind: 'String', value: this.role } },
    ]);
  }

  /** Strictly decodes `core.association-location@1`. */
  static fromValue(value: PortableValue): AssociationLocation {
    const fields = schemaFields(value, 'core.association-location@1', ['path', 'ordinal', 'role'], '$');
    const path = ValuePath.fromValue(fields[0]);
    const ordinal = unsigned64(fields[1], '$.ordinal');
    const role = stringOf(fields[2], '$.role');
    if (role !== 'ObjectEntry' && role !== 'ObjectKey' && role !== 'EntryMappingEntry') {
      throw invalid('$.role', 'unknown association role');
    }
    return new AssociationLocation(path, ordinal, role);
  }

  /** Ordered equality over path, ordinal, and role. */
  equal(other: AssociationLocation): boolean {
    return this.path.equal(other.path) && this.ordinal === other.ordinal && this.role === other.role;
  }

  /** The canonical ordering of the record. */
  less(other: AssociationLocation): boolean {
    if (!this.path.equal(other.path)) {
      return this.path.less(other.path);
    }
    if (this.ordinal !== other.ordinal) {
      return this.ordinal < other.ordinal;
    }
    return this.role < other.role;
  }
}
