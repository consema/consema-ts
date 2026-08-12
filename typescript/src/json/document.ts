/**
 * The immutable JSON-family document and its typed native handles.
 *
 * authority: crates/consema-json/src/lib.rs
 *  - Document :171-286 (snapshot_identity :187-191, source :192-197,
 *    render :198-202, format_family :204-208, profile :210-215,
 *    formation_status :216-220, diagnostics :222-226,
 *    lossless_structural_index :228-233, lossless_syntax_kinds :234-238,
 *    root :240-247, validate_ref :268-285)
 *  - JsonValueKind :322-340 (Null | Boolean | Integer | Decimal |
 *    BinaryFloat64 | String | Array | Object)
 *  - JsonValue :343-493 (node_ref :351-354, span :356-359, kind :362-386,
 *    as_boolean :389-398, as_integer :400-410, as_decimal :412-422,
 *    as_binary_float64 :424-436, as_string :438-448, array_elements
 *    :450-468, object_members :470-488)
 *  - JsonObjectMember :496-561 (ordinal :510-515, node_ref :516-520,
 *    key_node_ref :522-527, value_node_ref :529-534, span :535-539,
 *    name :541-551, value :553-561)
 *  - JsonArrayElement :563-610 (ordinal :578-583, node_ref :584-589,
 *    value_node_ref :590-595, span :596-600, value :602-609)
 *  - NodeRole spellings used by the json family: consema-document
 *    lib.rs:120-124 ('ObjectMember', 'ObjectKey', 'ArrayElement',
 *    'Value', 'JsonSyntaxPiece')
 *
 * Design (TypeScript-idiomatic): the document is an immutable class; typed
 * handles (`JsonValue`/`JsonObjectMember`/`JsonArrayElement`) borrow one
 * document and an entity index. NodeRef ordinals ARE entity indexes
 * (u64), exactly like the Rust `node_ref(index as u64)` mapping
 * (lib.rs:260-262). The `@internal` accessors are consumed only by this
 * family's parser/query/projection/edit modules.
 */

import { DocumentAuthority, NodeRef, Span } from '../document/identity.ts';
import type { NodeRole } from '../document/identity.ts';
import { LosslessStructuralIndex } from '../document/structural.ts';
import { FormatFamilyId, ProfileId } from '../document/profile.ts';
import type { ParseLimits } from '../document/formation.ts';
import { SourceSnapshot } from '../document/source.ts';
import type { Diagnostic } from '../document/diagnostic.ts';
import type { FormationStatus } from '../document/formation.ts';
import { JsonAccessError } from './errors.ts';
import { jsonProfileId } from './profile.ts';
import type { JsonProfile } from './profile.ts';
import type { JsonSyntaxKind } from './syntax.ts';
import { available, mapSemantic, unavailable } from './semantic.ts';
import type { SemanticAvailability, SemanticUnavailable } from './semantic.ts';

// ---------------------------------------------------------------------------
// Native value categories
// ---------------------------------------------------------------------------

/** Native JSON value category, preserving integer-form versus decimal-form numbers (lib.rs:322-340). */
export type JsonValueKind =
  | 'Null'
  | 'Boolean'
  | /** Number without decimal point or exponent. */
  'Integer'
  | /** Number with decimal point or exponent. */
  'Decimal'
  | /** Exact frozen IEEE-754 binary64 bits for a JSON5 non-finite literal. */
  'BinaryFloat64'
  | 'String'
  | 'Array'
  | 'Object';

// ---------------------------------------------------------------------------
// Internal entities
// ---------------------------------------------------------------------------

/** Exact arbitrary-precision integer or exact normalized decimal (lib.rs:649-659). */
export type InternalValueKind =
  | { readonly kind: 'Null' }
  | { readonly kind: 'Boolean'; readonly value: boolean }
  | { readonly kind: 'Integer'; readonly value: bigint }
  | { readonly kind: 'Decimal'; readonly coefficient: bigint; readonly exponent: bigint }
  | { readonly kind: 'BinaryFloat64'; readonly bits: bigint }
  | { readonly kind: 'String'; readonly value: string }
  | { readonly kind: 'Array'; readonly elements: readonly number[] }
  | { readonly kind: 'Object'; readonly members: readonly number[] }
  | { readonly kind: 'Unavailable'; readonly reason: SemanticUnavailable };

/** One internal entity (lib.rs:623-674). */
export type Entity =
  | {
      readonly kind: 'Value';
      readonly span: Span;
      readonly literalSpan: Span | null;
      readonly complete: boolean;
      readonly value: InternalValueKind;
    }
  | {
      readonly kind: 'Member';
      readonly span: Span;
      readonly key: number;
      readonly value: number;
      readonly ordinal: number;
    }
  | {
      readonly kind: 'Element';
      readonly span: Span;
      readonly value: number;
      readonly ordinal: number;
    };

// ---------------------------------------------------------------------------
// JsonDocument
// ---------------------------------------------------------------------------

/** Opaque immutable JSON-family document snapshot (lib.rs:171-183). */
export class JsonDocument {
  readonly #authority: DocumentAuthority;
  readonly #source: SourceSnapshot;
  readonly #profile: JsonProfile;
  readonly #structuralIndex: LosslessStructuralIndex;
  readonly #syntaxKinds: readonly JsonSyntaxKind[];
  readonly #formationStatus: FormationStatus;
  readonly #diagnostics: readonly Diagnostic[];
  readonly #entities: readonly Entity[];
  readonly #root: number;
  readonly #parseLimits: ParseLimits;

  /**
   * @internal — construction is only via `parse` (parser.ts); the
   * `@internal` accessors below are consumed by this family's
   * query/projection/edit modules.
   */
  constructor(
    authority: DocumentAuthority,
    source: SourceSnapshot,
    profile: JsonProfile,
    structuralIndex: LosslessStructuralIndex,
    syntaxKinds: readonly JsonSyntaxKind[],
    formationStatus: FormationStatus,
    diagnostics: readonly Diagnostic[],
    entities: readonly Entity[],
    root: number,
    parseLimits: ParseLimits,
  ) {
    this.#authority = authority;
    this.#source = source;
    this.#profile = profile;
    this.#structuralIndex = structuralIndex;
    this.#syntaxKinds = Object.freeze([...syntaxKinds]);
    this.#formationStatus = formationStatus;
    this.#diagnostics = Object.freeze([...diagnostics]);
    this.#entities = Object.freeze([...entities]);
    this.#root = root;
    this.#parseLimits = parseLimits;
  }

  /** Snapshot identity to which every NodeRef and Span belongs (lib.rs:187-191). */
  snapshotIdentity() {
    return this.#authority.identity();
  }

  /** Exact immutable source (lib.rs:192-197). */
  source(): SourceSnapshot {
    return this.#source;
  }

  /** Default rendering is the exact current source bytes (lib.rs:198-202). */
  render(): Uint8Array {
    return this.#source.bytes();
  }

  /** JSON format family contract (lib.rs:204-208). */
  formatFamily(): FormatFamilyId {
    return new FormatFamilyId('json', 1);
  }

  /** Exact language profile (lib.rs:210-215). */
  profile(): ProfileId {
    return jsonProfileId(this.#profile);
  }

  /** Whether recovery structure was required (lib.rs:216-220). */
  formationStatus(): FormationStatus {
    return this.#formationStatus;
  }

  /** Deterministically ordered document diagnostics (lib.rs:222-226). */
  diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics;
  }

  /** Exhaustive token/trivia/error-region byte coverage (lib.rs:228-233). */
  losslessStructuralIndex(): LosslessStructuralIndex {
    return this.#structuralIndex;
  }

  /** Format-specific kind for every structural piece, in the same source order (lib.rs:234-238). */
  losslessSyntaxKinds(): readonly JsonSyntaxKind[] {
    return this.#syntaxKinds;
  }

  /** Root native semantic value (lib.rs:240-247). */
  root(): JsonValue {
    return new JsonValue(this, this.#root);
  }

  /** Parse limits under which the document was formed (lib.rs:181-183). */
  parseLimits(): ParseLimits {
    return this.#parseLimits;
  }

  /** @internal */ authorityInternal(): DocumentAuthority {
    return this.#authority;
  }

  /** @internal */ profileInternal(): JsonProfile {
    return this.#profile;
  }

  /** @internal */ entityAt(index: number): Entity {
    return this.#entities[index];
  }

  /** @internal */ entityCount(): number {
    return this.#entities.length;
  }

  /** @internal */ valueEntityAt(index: number) {
    const entity = this.#entities[index];
    if (entity.kind !== 'Value') {
      throw new JsonAccessError('WrongRole');
    }
    return entity;
  }

  /** @internal */ spanOf(index: number): Span {
    return this.#entities[index].span;
  }

  /** @internal */ nodeRefFor(index: number, role: NodeRole): NodeRef {
    return this.#authority.nodeRef(BigInt(index), role);
  }

  /** @internal — resolves one NodeRef to its entity index (lib.rs:268-285). */
  resolveEntityIndex(node: NodeRef, roles: readonly NodeRole[]): number {
    try {
      this.#authority.verify(node);
    } catch {
      throw new JsonAccessError('WrongSnapshot');
    }
    if (!roles.includes(node.role())) {
      throw new JsonAccessError('WrongRole');
    }
    const index = this.#authority.resolveIndex(node);
    if (index > BigInt(Number.MAX_SAFE_INTEGER) || index >= BigInt(this.#entities.length)) {
      throw new JsonAccessError('UnknownNode');
    }
    return Number(index);
  }
}

// ---------------------------------------------------------------------------
// Typed native handles
// ---------------------------------------------------------------------------

/** Borrowed typed native semantic value bound to one Document snapshot (lib.rs:343-345). */
export class JsonValue {
  readonly #document: JsonDocument;
  readonly #index: number;

  constructor(document: JsonDocument, index: number) {
    this.#document = document;
    this.#index = index;
  }

  /** Exact value node handle (lib.rs:351-354). */
  nodeRef(): NodeRef {
    return this.#document.nodeRefFor(this.#index, 'Value');
  }

  /** Exact syntax span, possibly zero-width for a missing recovered node (lib.rs:356-359). */
  span(): Span {
    return this.#document.spanOf(this.#index);
  }

  /** Native semantic category when available (lib.rs:362-386). */
  kind(): SemanticAvailability<JsonValueKind> {
    const value = this.#document.valueEntityAt(this.#index).value;
    switch (value.kind) {
      case 'Null':
        return available('Null');
      case 'Boolean':
        return available('Boolean');
      case 'Integer':
        return available('Integer');
      case 'Decimal':
        return available('Decimal');
      case 'BinaryFloat64':
        return available('BinaryFloat64');
      case 'String':
        return available('String');
      case 'Array':
        return available('Array');
      case 'Object':
        return available('Object');
      case 'Unavailable':
        return unavailable(value.reason);
    }
  }

  /** Boolean value (lib.rs:389-398). */
  asBoolean(): SemanticAvailability<boolean | null> {
    const value = this.#document.valueEntityAt(this.#index).value;
    switch (value.kind) {
      case 'Boolean':
        return available(value.value);
      case 'Unavailable':
        return unavailable(value.reason);
      default:
        return available(null);
    }
  }

  /** Exact arbitrary-precision integer (lib.rs:400-410). */
  asInteger(): SemanticAvailability<bigint | null> {
    const value = this.#document.valueEntityAt(this.#index).value;
    switch (value.kind) {
      case 'Integer':
        return available(value.value);
      case 'Unavailable':
        return unavailable(value.reason);
      default:
        return available(null);
    }
  }

  /** Exact normalized decimal (lib.rs:412-422). */
  asDecimal(): SemanticAvailability<{ coefficient: bigint; exponent: bigint } | null> {
    const value = this.#document.valueEntityAt(this.#index).value;
    switch (value.kind) {
      case 'Decimal':
        return available({ coefficient: value.coefficient, exponent: value.exponent });
      case 'Unavailable':
        return unavailable(value.reason);
      default:
        return available(null);
    }
  }

  /** Exact IEEE-754 binary64 datum used by JSON5 non-finite literals (lib.rs:424-436). */
  asBinaryFloat64(): SemanticAvailability<bigint | null> {
    const value = this.#document.valueEntityAt(this.#index).value;
    switch (value.kind) {
      case 'BinaryFloat64':
        return available(value.bits);
      case 'Unavailable':
        return unavailable(value.reason);
      default:
        return available(null);
    }
  }

  /** Decoded Unicode string without normalization (lib.rs:438-448). */
  asString(): SemanticAvailability<string | null> {
    const value = this.#document.valueEntityAt(this.#index).value;
    switch (value.kind) {
      case 'String':
        return available(value.value);
      case 'Unavailable':
        return unavailable(value.reason);
      default:
        return available(null);
    }
  }

  /** Ordered array elements (lib.rs:450-468). */
  arrayElements(): SemanticAvailability<readonly JsonArrayElement[] | null> {
    const value = this.#document.valueEntityAt(this.#index).value;
    switch (value.kind) {
      case 'Array':
        return available(
          Object.freeze(value.elements.map((index) => new JsonArrayElement(this.#document, index))),
        );
      case 'Unavailable':
        return unavailable(value.reason);
      default:
        return available(null);
    }
  }

  /** Ordered object members without duplicate collapse (lib.rs:470-488). */
  objectMembers(): SemanticAvailability<readonly JsonObjectMember[] | null> {
    const value = this.#document.valueEntityAt(this.#index).value;
    switch (value.kind) {
      case 'Object':
        return available(
          Object.freeze(value.members.map((index) => new JsonObjectMember(this.#document, index))),
        );
      case 'Unavailable':
        return unavailable(value.reason);
      default:
        return available(null);
    }
  }

  /** @internal */ rawIndex(): number {
    return this.#index;
  }

  /** @internal */ documentInternal(): JsonDocument {
    return this.#document;
  }
}

/** Borrowed JSON object member association (lib.rs:496-497). */
export class JsonObjectMember {
  readonly #document: JsonDocument;
  readonly #index: number;

  constructor(document: JsonDocument, index: number) {
    this.#document = document;
    this.#index = index;
  }

  /** Zero-based structural member ordinal (lib.rs:510-515). */
  ordinal(): number {
    return this.#memberEntity().ordinal;
  }

  /** Member association identity (lib.rs:516-520). */
  nodeRef(): NodeRef {
    return this.#document.nodeRefFor(this.#index, 'ObjectMember');
  }

  /** Key node identity (lib.rs:522-527). */
  keyNodeRef(): NodeRef {
    return this.#document.nodeRefFor(this.#memberEntity().key, 'ObjectKey');
  }

  /** Value node identity (lib.rs:529-534). */
  valueNodeRef(): NodeRef {
    return this.#document.nodeRefFor(this.#memberEntity().value, 'Value');
  }

  /** Whole member source span (lib.rs:535-539). */
  span(): Span {
    return this.#document.spanOf(this.#index);
  }

  /** Decoded member name (lib.rs:541-551). */
  name(): SemanticAvailability<string> {
    const value = this.#document.valueEntityAt(this.#memberEntity().key).value;
    switch (value.kind) {
      case 'String':
        return available(value.value);
      case 'Unavailable':
        return unavailable(value.reason);
      default:
        return unavailable('InvalidLiteral');
    }
  }

  /** Associated value (lib.rs:553-561). */
  value(): JsonValue {
    return new JsonValue(this.#document, this.#memberEntity().value);
  }

  /** @internal */ entityIndex(): number {
    return this.#index;
  }

  #memberEntity() {
    const entity = this.#document.entityAt(this.#index);
    if (entity.kind !== 'Member') {
      throw new JsonAccessError('WrongRole');
    }
    return entity;
  }
}

/** Borrowed JSON array element association (lib.rs:563-566). */
export class JsonArrayElement {
  readonly #document: JsonDocument;
  readonly #index: number;

  constructor(document: JsonDocument, index: number) {
    this.#document = document;
    this.#index = index;
  }

  /** Zero-based structural index (lib.rs:578-583). */
  ordinal(): number {
    return this.#elementEntity().ordinal;
  }

  /** Element association identity (lib.rs:584-589). */
  nodeRef(): NodeRef {
    return this.#document.nodeRefFor(this.#index, 'ArrayElement');
  }

  /** Associated value identity (lib.rs:590-595). */
  valueNodeRef(): NodeRef {
    return this.#document.nodeRefFor(this.#elementEntity().value, 'Value');
  }

  /** Whole element span (lib.rs:596-600). */
  span(): Span {
    return this.#document.spanOf(this.#index);
  }

  /** Element value (lib.rs:602-609). */
  value(): JsonValue {
    return new JsonValue(this.#document, this.#elementEntity().value);
  }

  /** @internal */ entityIndex(): number {
    return this.#index;
  }

  #elementEntity() {
    const entity = this.#document.entityAt(this.#index);
    if (entity.kind !== 'Element') {
      throw new JsonAccessError('WrongRole');
    }
    return entity;
  }
}

/** Maps an available handle value while preserving unavailability (lib.rs:297-305). */
export function mapJsonValue<T, U>(
  result: SemanticAvailability<T>,
  map: (value: T) => U,
): SemanticAvailability<U> {
  return mapSemantic(result, map);
}
