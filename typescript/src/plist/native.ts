/**
 * Native plist value model (RFC 0013 §6).
 *
 * authority: crates/consema-plist/src/native.rs
 *  - PLIST_EPOCH_OFFSET_UNIX :35 (978_307_200.0 — seconds between the Unix
 *    epoch and the plist epoch 2001-01-01T00:00:00Z, RFC 0013 §5.5)
 *  - PlistStringStatus :39-44 (WellFormedUnicode | UnpairedSurrogate,
 *    the `core.java-utf16-string@1` wire pattern, RFC 0011 §7)
 *  - PlistString :56-127 (exact UTF-16 code units; unpaired surrogates are
 *    exact native content, RFC 0013 §5.6/§6)
 *  - PlistKey :134-194, PlistInteger :200-215 (signed 64-bit),
 *    RealWidth :219-224, PlistReal :233-293 (exact bits + width fact;
 *    Float32 keeps only the low 32 bits), PlistBoolean :299-311,
 *    PlistDate :321-355 (exact double seconds, finite only),
 *    PlistData :373-392, PlistUid :399-414 (unsigned 32-bit, binary-only)
 *  - PlistValue/PlistValueKind, the arena, and PlistDocumentBuilder:
 *    native.rs (arena indices equal object indices; shared identity
 *    preserved; cycles rejected at build, RFC 0013 §5.11/§6)
 *  - RFC 0013 §6 (:461-512) freezes the semantics: ordered duplicate-key
 *    dictionaries, exact bits equality (NaN payloads and signed zero are
 *    distinct), 64-bit integer range, exact double dates
 *
 * Design (TypeScript-idiomatic): JS strings ARE UTF-16 code unit
 * sequences, so `PlistString` is a plain JS string plus a computed
 * surrogate status; the code-unit equality of JS strings gives exact
 * value equality. Reals carry exact bit patterns (float64 as bigint,
 * float32 as uint32) and convert through a DataView. The arena is a
 * plain array of node templates with index references, exactly like the
 * Rust arena: shared binary identity survives, and the builder rejects
 * cycles with a visited set.
 */

/**
 * Seconds between the Unix epoch and the plist epoch; the origin of every
 * `PlistDate` value (native.rs:35; RFC 0013 §5.5).
 */
export const PLIST_EPOCH_OFFSET_UNIX = 978_307_200.0;

/** Whether exact UTF-16 code units form Unicode scalar text (native.rs:39-44). */
export type PlistStringStatus = 'WellFormedUnicode' | 'UnpairedSurrogate';

/** Computes the surrogate well-formedness status of one JS string (native.rs:56-127). */
export function classifyPlistString(value: string): PlistStringStatus {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (low >= 0xdc00 && low <= 0xdfff) {
        index += 1;
      } else {
        return 'UnpairedSurrogate';
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return 'UnpairedSurrogate';
    }
  }
  return 'WellFormedUnicode';
}

/** Width fact of one exact IEEE 754 real payload (native.rs:219-224). */
export type RealWidth = 'Float64' | 'Float32';

/** Exact IEEE 754 real with its source width fact (native.rs:233-293). */
export class PlistReal {
  readonly #bits: bigint;
  readonly #width: RealWidth;

  private constructor(bits: bigint, width: RealWidth) {
    this.#bits = bits;
    this.#width = width;
  }

  /** Creates a `Float64` real from an exact double. */
  static double(value: number): PlistReal {
    return new PlistReal(bitsOfFloat64(value), 'Float64');
  }

  /** Creates a `Float32` real from an exact single. */
  static single(value: number): PlistReal {
    return new PlistReal(BigInt(float32Bits(value)), 'Float32');
  }

  /** Creates a real from the exact source-width bit pattern (native.rs:263-271). */
  static fromBits(width: RealWidth, bits: bigint): PlistReal {
    if (width === 'Float64') {
      return new PlistReal(bits & 0xffffffffffffffffn, 'Float64');
    }
    return new PlistReal(bits & 0xffffffffn, 'Float32');
  }

  /** Exact source-width bit pattern (native.rs:275-278). */
  bits(): bigint {
    return this.#bits;
  }

  /** Source width fact (native.rs:280-283). */
  width(): RealWidth {
    return this.#width;
  }

  /** Exact double-converted value (native.rs:287-292; RFC 0013 §5.5). */
  asF64(): number {
    if (this.#width === 'Float64') {
      return float64FromBits(this.#bits);
    }
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, Number(this.#bits), false);
    return view.getFloat32(0, false);
  }

  /** Exact bit-pattern equality (distinct NaN payloads are distinct). */
  equals(other: PlistReal): boolean {
    return this.#width === other.#width && this.#bits === other.#bits;
  }
}

function bitsOfFloat64(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  return view.getBigUint64(0, false);
}

function float64FromBits(bits: bigint): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, bits & 0xffffffffffffffffn, false);
  return view.getFloat64(0, false);
}

function float32Bits(value: number): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, false);
  return view.getUint32(0, false);
}

/**
 * Closed native plist value kinds (RFC 0013 §6: string, integer, real,
 * boolean, date, data, uid, array, dict).
 */
export type PlistValueKind =
  | 'String'
  | 'Integer'
  | 'Real'
  | 'Boolean'
  | 'Date'
  | 'Data'
  | 'Uid'
  | 'Array'
  | 'Dict';

/**
 * One native value node. Containers reference children by arena index, so
 * shared identity from the binary object table survives: one source object
 * referenced by several containers is one node with multiple owners.
 */
export type PlistValue =
  | { readonly kind: 'String'; readonly text: string; readonly status: PlistStringStatus }
  | { readonly kind: 'Integer'; readonly value: bigint }
  | { readonly kind: 'Real'; readonly real: PlistReal }
  | { readonly kind: 'Boolean'; readonly value: boolean }
  | { readonly kind: 'Date'; readonly seconds: number; readonly bits: bigint }
  | { readonly kind: 'Data'; readonly bytes: Uint8Array }
  | { readonly kind: 'Uid'; readonly value: number }
  | { readonly kind: 'Array'; readonly elements: readonly number[] }
  | { readonly kind: 'Dict'; readonly entries: readonly PlistDictEntry[] };

/** One ordered dictionary association (RFC 0013 §4.4, §5.9). */
export interface PlistDictEntry {
  /** Exact key text (a JS string holds UTF-16 code units). */
  readonly key: string;
  /** Associated value arena index. */
  readonly value: number;
}

/** Arena reference to one native value node (native.rs:416-431). */
export class PlistValueRef {
  readonly #index: number;

  private constructor(index: number) {
    this.#index = index;
  }

  /** Creates a reference to the arena node at `index`. */
  static fromIndex(index: number): PlistValueRef {
    if (!Number.isInteger(index) || index < 0) {
      throw new RangeError('arena index must be a non-negative integer');
    }
    return new PlistValueRef(index);
  }

  /** Arena ordinal. */
  index(): number {
    return this.#index;
  }

  equals(other: PlistValueRef): boolean {
    return this.#index === other.#index;
  }
}

/** Arena construction failure (native.rs PlistArenaError). */
export type PlistArenaErrorKind =
  | 'ObjectLimitExceeded'
  | 'ContainerDepthLimitExceeded'
  | 'CycleDetected'
  | 'ReferenceOutOfBounds';

export class PlistArenaError extends Error {
  readonly kind: PlistArenaErrorKind;
  readonly node?: number;
  readonly limit?: number;

  constructor(kind: PlistArenaErrorKind, node?: number, limit?: number) {
    super(`plist arena: ${kind}`);
    this.name = 'PlistArenaError';
    this.kind = kind;
    if (node !== undefined) this.node = node;
    if (limit !== undefined) this.limit = limit;
  }
}

/** Native arena limits (lib.rs:196-205). */
export interface PlistArenaLimits {
  readonly maxObjects: number;
  readonly maxContainerDepth: number;
}

/** Builds an acyclic native document arena (native.rs PlistDocumentBuilder). */
export class PlistDocumentBuilder {
  readonly #limits: PlistArenaLimits;
  readonly #nodes: PlistValue[] = [];

  constructor(limits: PlistArenaLimits) {
    this.#limits = limits;
  }

  /** Adds one value and returns its arena index. */
  add(value: PlistValue): number {
    if (this.#nodes.length >= this.#limits.maxObjects) {
      throw new PlistArenaError('ObjectLimitExceeded', undefined, this.#limits.maxObjects);
    }
    this.#nodes.push(value);
    return this.#nodes.length - 1;
  }

  /** Node count so far. */
  nodeCount(): number {
    return this.#nodes.length;
  }

  /**
   * Closes the arena bound to `root`, rejecting reference cycles and
   * container-depth violations (RFC 0013 §5.11; native.rs build).
   */
  build(root: number): PlistDocument {
    if (root < 0 || root >= this.#nodes.length) {
      throw new PlistArenaError('ReferenceOutOfBounds');
    }
    const visited = new Set<number>();
    const walk = (index: number, depth: number): void => {
      if (visited.has(index)) {
        throw new PlistArenaError('CycleDetected', index);
      }
      if (depth > this.#limits.maxContainerDepth) {
        throw new PlistArenaError('ContainerDepthLimitExceeded', index, this.#limits.maxContainerDepth);
      }
      visited.add(index);
      const node = this.#nodes[index];
      if (node.kind === 'Array') {
        for (const element of node.elements) {
          walk(element, depth + 1);
        }
      } else if (node.kind === 'Dict') {
        for (const entry of node.entries) {
          walk(entry.value, depth + 1);
        }
      }
      visited.delete(index);
    };
    walk(root, 0);
    return new PlistDocument(Object.freeze([...this.#nodes]), root);
  }
}

/** Immutable ordered native value arena of one document (native.rs PlistDocument). */
export class PlistDocument {
  readonly #nodes: readonly PlistValue[];
  readonly #root: number;

  /** @internal — construction is via `PlistDocumentBuilder.build`. */
  constructor(nodes: readonly PlistValue[], root: number) {
    this.#nodes = nodes;
    this.#root = root;
  }

  /** Node count (arena length; indices equal object-table ordinals). */
  nodeCount(): number {
    return this.#nodes.length;
  }

  /** Root value reference. */
  root(): PlistValueRef {
    return PlistValueRef.fromIndex(this.#root);
  }

  /** One arena node; `null` for an out-of-range index. */
  get(reference: PlistValueRef): PlistValue | null {
    const index = reference.index();
    return index >= 0 && index < this.#nodes.length ? this.#nodes[index] : null;
  }

  /** Root value kind. */
  rootKind(): PlistValueKind {
    return this.get(this.root())!.kind;
  }

  /**
   * Whether the reachable value graphs are equal (RFC 0013 §5.12, §7):
   * independent of arena indices, sharing patterns, and unreachable
   * objects. This is the equality the materialization reparse closure and
   * the cross-representation round trip use.
   */
  equals(other: PlistDocument): boolean {
    return nativeGraphEquals(this, this.root(), other, other.root(), new Set());
  }
}

/**
 * Compares two reachable value graphs structurally (native.rs:866-941).
 *
 * The comparison is a pair-memo bisimulation: every (left, right) arena
 * pair is compared at most once, and sharing patterns on either side never
 * affect the outcome — a left node shared by three references compares
 * equal to three distinct right nodes carrying the same values. (The
 * earlier per-side visited-set version was asymmetric under sharing and
 * rejected the canonical materialization closure, whose deduplicated
 * scalar objects are shared on the target side while the record-built
 * arena keeps one node per record value; the normalization-and-conversion
 * vector pins `deduplicated_scalars` and the closure.)
 */
function nativeGraphEquals(
  left: PlistDocument,
  leftRef: PlistValueRef,
  right: PlistDocument,
  rightRef: PlistValueRef,
  memo: Set<string>,
): boolean {
  const leftIndex = leftRef.index();
  const rightIndex = rightRef.index();
  const pair = `${leftIndex}:${rightIndex}`;
  if (memo.has(pair)) {
    // An in-progress or proven pair needs no re-check (the arenas are
    // acyclic, so every pair is compared at most once).
    return true;
  }
  memo.add(pair);
  const a = left.get(leftRef);
  const b = right.get(rightRef);
  if (a === null || b === null || a.kind !== b.kind) {
    return false;
  }
  switch (a.kind) {
    case 'String':
      return a.text === (b as typeof a).text;
    case 'Integer':
      return a.value === (b as typeof a).value;
    case 'Real':
      return a.real.equals((b as typeof a).real);
    case 'Boolean':
      return a.value === (b as typeof a).value;
    case 'Date':
      return a.bits === (b as typeof a).bits;
    case 'Data': {
      const otherBytes = (b as typeof a).bytes;
      if (a.bytes.length !== otherBytes.length) {
        return false;
      }
      for (let index = 0; index < a.bytes.length; index++) {
        if (a.bytes[index] !== otherBytes[index]) {
          return false;
        }
      }
      return true;
    }
    case 'Uid':
      return a.value === (b as typeof a).value;
    case 'Array': {
      const otherElements = (b as typeof a).elements;
      if (a.elements.length !== otherElements.length) {
        return false;
      }
      for (let index = 0; index < a.elements.length; index++) {
        if (
          !nativeGraphEquals(
            left,
            PlistValueRef.fromIndex(a.elements[index]),
            right,
            PlistValueRef.fromIndex(otherElements[index]),
            memo,
          )
        ) {
          return false;
        }
      }
      return true;
    }
    case 'Dict': {
      const otherEntries = (b as typeof a).entries;
      if (a.entries.length !== otherEntries.length) {
        return false;
      }
      for (let index = 0; index < a.entries.length; index++) {
        if (a.entries[index].key !== otherEntries[index].key) {
          return false;
        }
        if (
          !nativeGraphEquals(
            left,
            PlistValueRef.fromIndex(a.entries[index].value),
            right,
            PlistValueRef.fromIndex(otherEntries[index].value),
            memo,
          )
        ) {
          return false;
        }
      }
      return true;
    }
  }
}

/** Creates a native string node from one JS string (native.rs from_code_units). */
export function plistStringValue(text: string): PlistValue {
  return { kind: 'String', text, status: classifyPlistString(text) };
}

/** Creates a native integer node from an exact signed 64-bit bigint. */
export function plistIntegerValue(value: bigint): PlistValue {
  return { kind: 'Integer', value };
}

/** Creates a native real node. */
export function plistRealValue(real: PlistReal): PlistValue {
  return { kind: 'Real', real };
}

/** Creates a native boolean node. */
export function plistBooleanValue(value: boolean): PlistValue {
  return { kind: 'Boolean', value };
}

/** Creates a native date node from exact seconds (finite only; native.rs PlistDate::from_seconds). */
export function plistDateValue(seconds: number): PlistValue {
  if (!Number.isFinite(seconds)) {
    throw new RangeError('plist date seconds must be finite');
  }
  return { kind: 'Date', seconds, bits: bitsOfFloat64(seconds) };
}

/** Creates a native data node from exact bytes. */
export function plistDataValue(bytes: Uint8Array): PlistValue {
  // A fresh copy, not a frozen one: typed arrays cannot be frozen with
  // elements (V8 throws "Cannot freeze array buffer views with elements"),
  // and no caller mutates the arena after build.
  return { kind: 'Data', bytes: Uint8Array.from(bytes) };
}

/** Creates a native UID node from an unsigned 32-bit value (binary-only). */
export function plistUidValue(value: number): PlistValue {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError('plist uid must be an unsigned 32-bit value');
  }
  return { kind: 'Uid', value };
}
