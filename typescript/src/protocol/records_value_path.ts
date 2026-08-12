/**
 * Portable value path and association location wire records.
 *
 * authority: crates/consema-protocol/src/query.rs:441-560 (path_value,
 * parse_path, association_value, parse_association); cross-reference
 * go/protocol/records_valuepath.go (pathValue/parsePath:145-225,
 * associationValue/parseAssociation:227-260). The path is a schema-less
 * `{"segments":[...]}` record of typed segments (ObjectValue with a String
 * key, or SequenceElement/EntryKey/EntryValue with a u64 index); association
 * locations are the schema-less `{"container","ordinal","role"}` record.
 */

import type { ObjectValue, PortableValue } from '../core/value.ts';
import { invalid } from './errors.ts';
import { exactFields, sequenceOf, stringOf, unsigned64, objectValueFrom, objectOf } from './records.ts';

export type ValuePathSegmentKind = 'SequenceElement' | 'ObjectValue' | 'EntryKey' | 'EntryValue';

export type ValuePathSegment =
  | { readonly kind: 'ObjectValue'; readonly key: string }
  | { readonly kind: 'SequenceElement' | 'EntryKey' | 'EntryValue'; readonly index: bigint };

/** The schema-less `{"segments": [...]}` value-path record (query.rs:441-464). */
export class ValuePath {
  readonly segments: readonly ValuePathSegment[];

  constructor(segments: readonly ValuePathSegment[] = []) {
    this.segments = Object.freeze([...segments]);
  }

  /** The empty root path. */
  static root(): ValuePath {
    return new ValuePath();
  }

  /** Appends one typed segment (ObjectValue key, or ordinal index). */
  append(kind: 'ObjectValue', key: string): ValuePath;
  append(kind: 'SequenceElement' | 'EntryKey' | 'EntryValue', index: bigint): ValuePath;
  append(kind: ValuePathSegmentKind, keyOrIndex: string | bigint): ValuePath {
    if (kind === 'ObjectValue') {
      return new ValuePath([...this.segments, { kind, key: keyOrIndex as string }]);
    }
    return new ValuePath([...this.segments, { kind, index: keyOrIndex as bigint }]);
  }

  /** Encodes the schema-less path record (query.rs:441-464). */
  toValue(): ObjectValue {
    const items = this.segments.map((segment) =>
      segment.kind === 'ObjectValue'
        ? objectValueFrom([
            { key: 'kind', value: { kind: 'String', value: segment.kind } },
            { key: 'key', value: { kind: 'String', value: segment.key } },
          ])
        : objectValueFrom([
            { key: 'kind', value: { kind: 'String', value: segment.kind } },
            { key: 'index', value: { kind: 'Integer', value: segment.index } },
          ]),
    );
    return objectValueFrom([{ key: 'segments', value: { kind: 'Sequence', items } }]);
  }

  /** Strictly decodes the schema-less path record (query.rs:466-512). */
  static fromValue(value: PortableValue): ValuePath {
    const fields = exactFields(value, ['segments'], '$');
    const segments: ValuePathSegment[] = [];
    sequenceOf(fields[0], '$.segments').forEach((segment, index) => {
      const segmentPath = `$.segments[${index}]`;
      const segmentObject = objectOf(segment, segmentPath);
      const kindEntry = segmentObject.entries[0];
      if (
        kindEntry === undefined ||
        kindEntry.key !== 'kind' ||
        kindEntry.value.kind !== 'String'
      ) {
        throw invalid(segmentPath, 'missing segment kind');
      }
      switch (kindEntry.value.value) {
        case 'ObjectValue': {
          const fields = exactFields(segment, ['kind', 'key'], segmentPath);
          segments.push({ kind: 'ObjectValue', key: stringOf(fields[1], `${segmentPath}.key`) });
          break;
        }
        case 'SequenceElement':
        case 'EntryKey':
        case 'EntryValue': {
          const fields = exactFields(segment, ['kind', 'index'], segmentPath);
          segments.push({
            kind: kindEntry.value.value,
            index: unsigned64(fields[1], `${segmentPath}.index`),
          });
          break;
        }
        default:
          throw invalid(segmentPath, 'unknown path segment');
      }
    });
    return new ValuePath(segments);
  }

  /** Ordered equality over typed segments. */
  equal(other: ValuePath): boolean {
    if (this.segments.length !== other.segments.length) {
      return false;
    }
    return this.segments.every((segment, index) => segmentEqual(segment, other.segments[index]));
  }

  /** The canonical ordering of the record (kind, then key or index). */
  less(other: ValuePath): boolean {
    const left = this.segments;
    const right = other.segments;
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      if (!segmentEqual(left[index], right[index])) {
        return segmentLess(left[index], right[index]);
      }
    }
    return left.length < right.length;
  }
}

/** Ordered equality of two typed segments. */
function segmentEqual(left: ValuePathSegment, right: ValuePathSegment): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'ObjectValue') {
    return right.kind === 'ObjectValue' && left.key === right.key;
  }
  return right.kind !== 'ObjectValue' && left.index === right.index;
}

/** The canonical ordering of two segments (kind, then key or index). */
function segmentLess(left: ValuePathSegment, right: ValuePathSegment): boolean {
  if (left.kind !== right.kind) {
    return left.kind < right.kind;
  }
  if (left.kind === 'ObjectValue') {
    return right.kind === 'ObjectValue' && left.key < right.key;
  }
  return right.kind !== 'ObjectValue' && left.index < right.index;
}

export type AssociationRole = 'ObjectEntry' | 'ObjectKey' | 'EntryMappingEntry';

/** The schema-less `{"container","ordinal","role"}` association location record (query.rs:514-553). */
export class AssociationLocation {
  readonly container: ValuePath;
  readonly ordinal: bigint;
  readonly role: AssociationRole;

  constructor(container: ValuePath, ordinal: bigint, role: AssociationRole) {
    this.container = container;
    this.ordinal = ordinal;
    this.role = role;
  }

  /** Encodes the association location (query.rs:514-523). */
  toValue(): ObjectValue {
    return objectValueFrom([
      { key: 'container', value: this.container.toValue() },
      { key: 'ordinal', value: { kind: 'Integer', value: this.ordinal } },
      { key: 'role', value: { kind: 'String', value: this.role } },
    ]);
  }

  /** Strictly decodes the association location (query.rs:525-553). */
  static fromValue(value: PortableValue): AssociationLocation {
    const fields = exactFields(value, ['container', 'ordinal', 'role'], '$');
    const container = ValuePath.fromValue(fields[0]);
    const ordinal = unsigned64(fields[1], '$.ordinal');
    const role = stringOf(fields[2], '$.role');
    if (role !== 'ObjectEntry' && role !== 'ObjectKey' && role !== 'EntryMappingEntry') {
      throw invalid('$.role', 'unknown association role');
    }
    return new AssociationLocation(container, ordinal, role);
  }

  /** Ordered equality over container, ordinal, and role. */
  equal(other: AssociationLocation): boolean {
    return (
      this.container.equal(other.container) && this.ordinal === other.ordinal && this.role === other.role
    );
  }

  /** The canonical ordering of the record. */
  less(other: AssociationLocation): boolean {
    if (!this.container.equal(other.container)) {
      return this.container.less(other.container);
    }
    if (this.ordinal !== other.ordinal) {
      return this.ordinal < other.ordinal;
    }
    return this.role < other.role;
  }
}
