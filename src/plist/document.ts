/**
 * The immutable plist-family document and its typed native handles.
 *
 * authority: crates/consema-plist/src/parser_xml.rs:282-363 (PlistFormedXml),
 * parser_binary.rs:253-335 (PlistFormedBinary), document.rs (the shared
 * `Document` wrap); RFC 0013 §3
 *  - a `Complete` document covers every admitted source byte under the
 *    Profile's grammar and every configured limit; `Recovered` retains
 *    the immutable source, exhaustive coverage, ordered diagnostics, and
 *    every independently proven construct
 *  - an XML document carries the lossless structural index and parallel
 *    syntax kinds (RFC 0013 §8.2); a binary document carries the
 *    object/offset/reference/trailer facts and the binary structural
 *    index (RFC 0013 §8.3, hard gate 1)
 *  - the native value arena is present exactly when it is provable (the
 *    root value for XML; the top object and every proven reference inside
 *    the proven prefix for binary)
 *  - binary facts: parser_binary.rs:53-251 (BinaryObjectFact,
 *    BinaryOffsetFact, BinaryObjectRefFact, BinaryTrailerFacts,
 *    BinaryFacts) — every object/offset/ref fact carries an exact
 *    half-open raw-byte span
 *  - NodeRole spellings for the plist family: consema-document lib.rs:
 *    215-228 ('PlistDocument', 'PlistDictEntry', 'PlistKey',
 *    'PlistArrayElement', 'PlistValue', 'PlistSyntaxPiece')
 *
 * Design (TypeScript-idiomatic): one immutable document class for both
 * profiles with nullable representation-owned sides (the binary facts
 * exist only for `plist.binary@1`, the lossless index only for
 * `plist.xml@1` — hard gate 1, RFC 0013 §7). Typed handles borrow the
 * document and an arena index; NodeRef ordinals ARE arena indices, like
 * the Rust `node_ref(index as u64)` mapping.
 */

import { DocumentAuthority, NodeRef, Span } from '../document/identity.ts';
import type { NodeRole } from '../document/identity.ts';
import { FormatFamilyId } from '../document/profile.ts';
import { LosslessStructuralIndex, BinaryStructuralIndex } from '../document/structural.ts';
import { ProfileId } from '../document/profile.ts';
import { SourceSnapshot } from '../document/source.ts';
import type { Diagnostic } from '../document/diagnostic.ts';
import type { FormationStatus } from '../document/formation.ts';
import { PlistAccessError } from './errors.ts';
import { plistProfileId } from './profile.ts';
import type { PlistProfile, PlistParseLimits } from './profile.ts';
import type { PlistSyntaxKind } from './syntax.ts';
import {
  PlistDocument as PlistNativeDocument,
  PlistValueRef,
} from './native.ts';
import type { PlistValue, PlistValueKind } from './native.ts';

// ---------------------------------------------------------------------------
// Binary structural facts (parser_binary.rs:53-251)
// ---------------------------------------------------------------------------

/** One proven object-table entry fact (parser_binary.rs:57-89). */
export class BinaryObjectFact {
  readonly #index: number;
  readonly #offset: number;
  readonly #marker: number;
  readonly #span: Span;

  constructor(index: number, offset: number, marker: number, span: Span) {
    this.#index = index;
    this.#offset = offset;
    this.#marker = marker;
    this.#span = span;
  }

  /** Object-table ordinal. */
  index(): number {
    return this.#index;
  }

  /** Marker byte offset (equals the offset-table entry value). */
  offset(): number {
    return this.#offset;
  }

  /** Marker byte; the low nibble preserves non-minimal width facts. */
  marker(): number {
    return this.#marker;
  }

  /** Exact marker-through-payload byte range. */
  span(): Span {
    return this.#span;
  }
}

/** One validated offset-table entry fact (parser_binary.rs:92-117). */
export class BinaryOffsetFact {
  readonly #index: number;
  readonly #offset: number;
  readonly #span: Span;

  constructor(index: number, offset: number, span: Span) {
    this.#index = index;
    this.#offset = offset;
    this.#span = span;
  }

  /** Object-table ordinal of this entry. */
  index(): number {
    return this.#index;
  }

  /** Decoded absolute file offset of the object's marker byte. */
  offset(): number {
    return this.#offset;
  }

  /** Exact byte range of this entry inside the offset table. */
  span(): Span {
    return this.#span;
  }
}

/** One decoded object reference of a proven container (parser_binary.rs:120-156). */
export class BinaryObjectRefFact {
  readonly #owner: number;
  readonly #position: number;
  readonly #target: number;
  readonly #span: Span;

  constructor(owner: number, position: number, target: number, span: Span) {
    this.#owner = owner;
    this.#position = position;
    this.#target = target;
    this.#span = span;
  }

  /** Referencing object index. */
  owner(): number {
    return this.#owner;
  }

  /** Ordinal of this reference within the owner's reference block. */
  position(): number {
    return this.#position;
  }

  /** Decoded target object index. */
  target(): number {
    return this.#target;
  }

  /** Exact byte range of this reference inside the owner's payload. */
  span(): Span {
    return this.#span;
  }
}

/** Trailer field facts (parser_binary.rs:158-216; RFC 0013 §5.10). */
export class BinaryTrailerFacts {
  readonly #sortVersion: number;
  readonly #offsetIntSize: number;
  readonly #objectRefSize: number;
  readonly #numObjects: bigint;
  readonly #topObject: bigint;
  readonly #offsetTableOffset: bigint;
  readonly #span: Span;

  constructor(
    sortVersion: number,
    offsetIntSize: number,
    objectRefSize: number,
    numObjects: bigint,
    topObject: bigint,
    offsetTableOffset: bigint,
    span: Span,
  ) {
    this.#sortVersion = sortVersion;
    this.#offsetIntSize = offsetIntSize;
    this.#objectRefSize = objectRefSize;
    this.#numObjects = numObjects;
    this.#topObject = topObject;
    this.#offsetTableOffset = offsetTableOffset;
    this.#span = span;
  }

  /** `sortVersion` byte (0 or 1; canonical materialization writes 0). */
  sortVersion(): number {
    return this.#sortVersion;
  }

  /** `offsetIntSize` byte. */
  offsetIntSize(): number {
    return this.#offsetIntSize;
  }

  /** `objectRefSize` byte. */
  objectRefSize(): number {
    return this.#objectRefSize;
  }

  /** `numObjects` value. */
  numObjects(): bigint {
    return this.#numObjects;
  }

  /** `topObject` value (the native document root when proven). */
  topObject(): bigint {
    return this.#topObject;
  }

  /** `offsetTableOffset` value. */
  offsetTableOffset(): bigint {
    return this.#offsetTableOffset;
  }

  /** Exact byte range of the 32-byte trailer. */
  span(): Span {
    return this.#span;
  }
}

/** Complete binary structure facts of one parse (parser_binary.rs:218-251). */
export class BinaryFacts {
  readonly #objects: readonly BinaryObjectFact[];
  readonly #offsets: readonly BinaryOffsetFact[];
  readonly #refs: readonly BinaryObjectRefFact[];
  readonly #trailer: BinaryTrailerFacts;

  constructor(
    objects: readonly BinaryObjectFact[],
    offsets: readonly BinaryOffsetFact[],
    refs: readonly BinaryObjectRefFact[],
    trailer: BinaryTrailerFacts,
  ) {
    this.#objects = Object.freeze([...objects]);
    this.#offsets = Object.freeze([...offsets]);
    this.#refs = Object.freeze([...refs]);
    this.#trailer = trailer;
  }

  /** Proven object facts in object-table order. */
  objects(): readonly BinaryObjectFact[] {
    return this.#objects;
  }

  /** Validated offset-table entry facts in object-table order. */
  offsets(): readonly BinaryOffsetFact[] {
    return this.#offsets;
  }

  /** Proven reference facts ordered by owner then position. */
  refs(): readonly BinaryObjectRefFact[] {
    return this.#refs;
  }

  /** Trailer field facts. */
  trailer(): BinaryTrailerFacts {
    return this.#trailer;
  }
}

// ---------------------------------------------------------------------------
// PlistDocument
// ---------------------------------------------------------------------------

/**
 * Opaque immutable plist document snapshot shared by both profiles
 * (RFC 0013 §3). The representation-owned sides are nullable: the
 * lossless index exists only for `plist.xml@1`, the binary facts only
 * for `plist.binary@1` (hard gate 1).
 */
export class PlistDocument {
  readonly #authority: DocumentAuthority;
  readonly #source: SourceSnapshot;
  readonly #profile: PlistProfile;
  readonly #formationStatus: FormationStatus;
  readonly #diagnostics: readonly Diagnostic[];
  readonly #structuralIndex: LosslessStructuralIndex | null;
  readonly #syntaxKinds: readonly PlistSyntaxKind[] | null;
  readonly #binaryIndex: BinaryStructuralIndex | null;
  readonly #facts: BinaryFacts | null;
  readonly #native: PlistNativeDocument | null;
  readonly #parseLimits: PlistParseLimits;

  /**
   * @internal — construction is only via `parse` (parser.ts); the
   * `@internal` accessors are consumed by this family's
   * query/projection/edit modules.
   */
  constructor(
    authority: DocumentAuthority,
    source: SourceSnapshot,
    profile: PlistProfile,
    formationStatus: FormationStatus,
    diagnostics: readonly Diagnostic[],
    structuralIndex: LosslessStructuralIndex | null,
    syntaxKinds: readonly PlistSyntaxKind[] | null,
    binaryIndex: BinaryStructuralIndex | null,
    facts: BinaryFacts | null,
    native: PlistNativeDocument | null,
    parseLimits: PlistParseLimits,
  ) {
    this.#authority = authority;
    this.#source = source;
    this.#profile = profile;
    this.#formationStatus = formationStatus;
    this.#diagnostics = Object.freeze([...diagnostics]);
    this.#structuralIndex = structuralIndex;
    this.#syntaxKinds = syntaxKinds === null ? null : Object.freeze([...syntaxKinds]);
    this.#binaryIndex = binaryIndex;
    this.#facts = facts;
    this.#native = native;
    this.#parseLimits = parseLimits;
  }

  /** Snapshot identity to which every NodeRef and Span belongs. */
  snapshotIdentity() {
    return this.#authority.identity();
  }

  /** Exact immutable source. */
  source(): SourceSnapshot {
    return this.#source;
  }

  /** Default rendering is the exact current source bytes. */
  render(): Uint8Array {
    return this.#source.bytes();
  }

  /** Plist format family contract. */
  formatFamily(): FormatFamilyId {
    return new FormatFamilyId('plist', 1);
  }

  /** Exact language profile (`plist.xml@1` or `plist.binary@1`). */
  profile(): ProfileId {
    return plistProfileId(this.#profile);
  }

  /** Whether recovery structure was required (RFC 0013 §3). */
  formationStatus(): FormationStatus {
    return this.#formationStatus;
  }

  /** Deterministically ordered document diagnostics. */
  diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics;
  }

  /** Exhaustive lossless piece coverage; `null` for the binary profile (hard gate 1). */
  losslessStructuralIndex(): LosslessStructuralIndex | null {
    return this.#structuralIndex;
  }

  /** Parallel lossless syntax kinds; `null` for the binary profile. */
  losslessSyntaxKinds(): readonly PlistSyntaxKind[] | null {
    return this.#syntaxKinds;
  }

  /** Exhaustive binary region coverage; `null` for the XML profile. */
  binaryStructuralIndex(): BinaryStructuralIndex | null {
    return this.#binaryIndex;
  }

  /** Binary object/offset/reference/trailer facts; `null` for the XML profile. */
  binaryFacts(): BinaryFacts | null {
    return this.#facts;
  }

  /** Native value arena, when provable (RFC 0013 §3). */
  document(): PlistNativeDocument | null {
    return this.#native;
  }

  /** Parse limits under which the document was formed. */
  parseLimits(): PlistParseLimits {
    return this.#parseLimits;
  }

  /** @internal */ authorityInternal(): DocumentAuthority {
    return this.#authority;
  }

  /** @internal */ profileInternal(): PlistProfile {
    return this.#profile;
  }

  /** @internal */ nodeRefFor(index: number, role: NodeRole): NodeRef {
    return this.#authority.nodeRef(BigInt(index), role);
  }

  /** @internal — resolves one NodeRef to its native arena index. */
  resolveNativeIndex(node: NodeRef, roles: readonly NodeRole[]): number {
    try {
      this.#authority.verify(node);
    } catch {
      throw new PlistAccessError('WrongSnapshot');
    }
    if (!roles.includes(node.role())) {
      throw new PlistAccessError('WrongRole');
    }
    const index = this.#authority.resolveIndex(node);
    if (index > BigInt(Number.MAX_SAFE_INTEGER) || this.#native === null || index >= BigInt(this.#native.nodeCount())) {
      throw new PlistAccessError('UnknownNode');
    }
    return Number(index);
  }

  /** @internal — validates a handle without resolving it (query path). */
  verifyHandle(node: NodeRef): void {
    try {
      this.#authority.verify(node);
    } catch {
      throw new PlistAccessError('WrongSnapshot');
    }
  }
}

// ---------------------------------------------------------------------------
// Typed native handles
// ---------------------------------------------------------------------------

/** Borrowed typed native semantic value bound to one document snapshot (RFC 0013 §6). */
export class PlistValueHandle {
  readonly #document: PlistDocument;
  readonly #index: number;

  constructor(document: PlistDocument, index: number) {
    this.#document = document;
    this.#index = index;
  }

  /** Exact value node handle. */
  nodeRef(): NodeRef {
    return this.#document.nodeRefFor(this.#index, 'PlistValue');
  }

  /** Native value kind; `null` when the arena is unproven. */
  kind(): PlistValueKind | null {
    return this.#value()?.kind ?? null;
  }

  /** Exact raw value; `null` when the arena is unproven. */
  raw(): PlistValue | null {
    return this.#value();
  }

  /** Exact value node; throws PlistAccessError when unproven. */
  #value(): PlistValue | null {
    const native = this.#document.document();
    if (native === null) {
      throw new PlistAccessError('UnknownNode');
    }
    return native.get(PlistValueRef.fromIndex(this.#index));
  }

  /** Exact string text (RFC 0013 §6). */
  asString(): string | null {
    const value = this.#value();
    return value?.kind === 'String' ? value.text : null;
  }

  /** Exact signed 64-bit integer. */
  asInteger(): bigint | null {
    const value = this.#value();
    return value?.kind === 'Integer' ? value.value : null;
  }

  /** Exact real with its width fact. */
  asReal(): { readonly bits: bigint; readonly width: 'Float64' | 'Float32' } | null {
    const value = this.#value();
    return value?.kind === 'Real' ? { bits: value.real.bits(), width: value.real.width() } : null;
  }

  /** Exact boolean. */
  asBoolean(): boolean | null {
    const value = this.#value();
    return value?.kind === 'Boolean' ? value.value : null;
  }

  /** Exact double seconds since the plist epoch. */
  asDate(): number | null {
    const value = this.#value();
    return value?.kind === 'Date' ? value.seconds : null;
  }

  /** Exact bytes. */
  asData(): Uint8Array | null {
    const value = this.#value();
    return value?.kind === 'Data' ? value.bytes : null;
  }

  /** Exact unsigned 32-bit UID value (binary-only). */
  asUid(): number | null {
    const value = this.#value();
    return value?.kind === 'Uid' ? value.value : null;
  }

  /** Ordered dictionary associations (RFC 0013 §4.4). */
  dictEntries(): readonly PlistDictEntryHandle[] {
    const value = this.#value();
    if (value?.kind !== 'Dict') {
      return Object.freeze([]);
    }
    return Object.freeze(
      value.entries.map((entry, position) => new PlistDictEntryHandle(this.#document, this.#index, position)),
    );
  }

  /** Ordered array elements. */
  arrayElements(): readonly PlistArrayElementHandle[] {
    const value = this.#value();
    if (value?.kind !== 'Array') {
      return Object.freeze([]);
    }
    return Object.freeze(
      value.elements.map((element, position) => new PlistArrayElementHandle(this.#document, this.#index, position)),
    );
  }

  /** @internal */ rawIndex(): number {
    return this.#index;
  }

  /** @internal */ documentInternal(): PlistDocument {
    return this.#document;
  }
}

/** Borrowed plist dictionary association (RFC 0013 §4.4, §5.9). */
export class PlistDictEntryHandle {
  readonly #document: PlistDocument;
  readonly #dict: number;
  readonly #position: number;

  constructor(document: PlistDocument, dict: number, position: number) {
    this.#document = document;
    this.#dict = dict;
    this.#position = position;
  }

  /** Association identity. */
  nodeRef(): NodeRef {
    return this.#document.nodeRefFor(this.#dict, 'PlistDictEntry');
  }

  /** Key identity. */
  keyNodeRef(): NodeRef {
    return this.#document.nodeRefFor(this.#dict, 'PlistKey');
  }

  /** Exact key text of this physical occurrence. */
  key(): string | null {
    const value = this.#entry()?.key ?? null;
    return value;
  }

  /** Association position within the dictionary, in source order. */
  position(): number {
    return this.#position;
  }

  /** Associated value. */
  value(): PlistValueHandle {
    const entry = this.#entry();
    if (entry === null) {
      throw new PlistAccessError('UnknownNode');
    }
    return new PlistValueHandle(this.#document, entry.value);
  }

  /** @internal */ entry(): { readonly key: string; readonly value: number } | null {
    return this.#entry();
  }

  #entry(): { readonly key: string; readonly value: number } | null {
    const native = this.#document.document();
    if (native === null) {
      throw new PlistAccessError('UnknownNode');
    }
    const value = native.get(PlistValueRef.fromIndex(this.#dict));
    if (value?.kind !== 'Dict' || this.#position >= value.entries.length) {
      throw new PlistAccessError('UnknownNode');
    }
    return value.entries[this.#position];
  }
}

/** Borrowed plist array element association. */
export class PlistArrayElementHandle {
  readonly #document: PlistDocument;
  readonly #array: number;
  readonly #position: number;

  constructor(document: PlistDocument, array: number, position: number) {
    this.#document = document;
    this.#array = array;
    this.#position = position;
  }

  /** Element association identity. */
  nodeRef(): NodeRef {
    return this.#document.nodeRefFor(this.#array, 'PlistArrayElement');
  }

  /** Element position within the array, in source order. */
  position(): number {
    return this.#position;
  }

  /** Element value. */
  value(): PlistValueHandle {
    const native = this.#document.document();
    if (native === null) {
      throw new PlistAccessError('UnknownNode');
    }
    const value = native.get(PlistValueRef.fromIndex(this.#array));
    if (value?.kind !== 'Array' || this.#position >= value.elements.length) {
      throw new PlistAccessError('UnknownNode');
    }
    return new PlistValueHandle(this.#document, value.elements[this.#position]);
  }
}
