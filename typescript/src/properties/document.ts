/**
 * The immutable Java Properties document and its typed native handles.
 *
 * authority: crates/consema-properties/src/lib.rs
 *  - Document :590-608 (snapshot identity, source, profile, structural
 *    index, syntax kinds, formation status, diagnostics, natural lines,
 *    logical lines, properties, comments, escapes, error lines, parse
 *    limits, root node), accessors :610-775
 *  - PropertiesNaturalLine :309-342, PropertiesLogicalLine :344-370,
 *    PropertiesComment :372-405, PropertiesEscape :407-455, Property
 *    :457-546, PropertiesErrorLine :548-588
 *  - PropertiesValueState :276-285, PropertiesLogicalLineKind :287-294,
 *    PropertiesEscapeKind :296-307
 *  - NodeRole spellings used by the properties family: consema-document
 *    lib.rs:173-188 ('PropertiesDocument', 'PropertiesNaturalLine',
 *    'PropertiesLogicalLine', 'PropertiesProperty', 'PropertiesComment',
 *    'PropertiesEscape', 'PropertiesErrorLine', 'PropertiesSyntaxPiece')
 *  - RFC 0010 §9 (:236-267) freezes the snapshot-bound native roles and
 *    the lossless facts
 *
 * Design (TypeScript-idiomatic): the document is an immutable class over a
 * flat entity array whose index IS the NodeRef ordinal (issue order), like
 * the json family (json/document.ts:26-31). Typed handles borrow one
 * document and an entity index; resolution validates snapshot, role, and
 * entity kind exactly like the Rust scan (lib.rs:719-774). A compact
 * per-atom decoded boundary table (atom start decoded-UTF-8-byte offset and
 * JS code-unit index) supports exact decoded-span text lookups (the Rust
 * `decoded_span_text`, query.rs:636-651) without re-scanning the source.
 */

import { DocumentAuthority, NodeRef, Span } from '../document/identity.ts';
import type { NodeRole } from '../document/identity.ts';
import { LosslessStructuralIndex } from '../document/structural.ts';
import { FormatFamilyId, ProfileId } from '../document/profile.ts';
import { SourceSnapshot } from '../document/source.ts';
import { PropertiesAccessError } from './errors.ts';
import { JavaString } from './java_string.ts';
import { propertiesProfileId } from './profile.ts';
import type { Diagnostic } from '../document/diagnostic.ts';
import type { FormationStatus } from '../document/formation.ts';
import type { PropertiesProfile } from './profile.ts';
import type { PropertiesSyntaxKind } from './syntax.ts';
import type { PropertiesParseLimits } from './parse_limits.ts';

// ---------------------------------------------------------------------------
// Native vocabulary
// ---------------------------------------------------------------------------

/** Semantic empty/present state with exact separator provenance (lib.rs:276-285). */
export type PropertiesValueState = 'ImplicitEmpty' | 'ExplicitEmpty' | 'Present';

/** Kind of one logical Properties record (lib.rs:287-294). */
export type PropertiesLogicalLineKind = 'Property' | 'Error';

/** Kind of one retained escape occurrence (lib.rs:296-307). */
export type PropertiesEscapeKind = 'Named' | 'Backslash' | 'Unicode' | 'DroppedBackslash';

// ---------------------------------------------------------------------------
// Internal entities
// ---------------------------------------------------------------------------

/** One internal entity; the array index IS the NodeRef ordinal (issue order). */
export type Entity =
  | { readonly kind: 'Document' }
  | {
      readonly kind: 'NaturalLine';
      readonly span: Span;
      readonly contentSpan: Span;
      readonly lineBreakSpan: Span | null;
    }
  | {
      readonly kind: 'LogicalLine';
      readonly recordKind: PropertiesLogicalLineKind;
      readonly naturalLines: readonly number[];
    }
  | {
      readonly kind: 'Property';
      readonly logicalLine: number;
      readonly span: Span;
      readonly keyAnchor: Span;
      readonly valueAnchor: Span;
      readonly keyFragments: readonly Span[];
      readonly valueFragments: readonly Span[];
      readonly key: JavaString;
      readonly value: JavaString;
      readonly valueState: PropertiesValueState;
      readonly escapes: readonly number[];
      readonly duplicateGroup: number | null;
    }
  | {
      readonly kind: 'Comment';
      readonly naturalLine: number;
      readonly span: Span;
      readonly marker: string;
    }
  | {
      readonly kind: 'Escape';
      readonly property: number;
      readonly inKey: boolean;
      readonly escapeKind: PropertiesEscapeKind;
      readonly span: Span;
      readonly outputStart: number;
      readonly outputEnd: number;
    }
  | {
      readonly kind: 'ErrorLine';
      readonly logicalLine: number;
      readonly naturalLines: readonly number[];
      readonly span: Span;
      readonly code: string;
    };

// ---------------------------------------------------------------------------
// PropertiesDocument
// ---------------------------------------------------------------------------

/** Opaque immutable Java Properties document snapshot (lib.rs:590-608). */
export class PropertiesDocument {
  readonly #authority: DocumentAuthority;
  readonly #source: SourceSnapshot;
  readonly #profile: PropertiesProfile;
  readonly #structuralIndex: LosslessStructuralIndex;
  readonly #syntaxKinds: readonly PropertiesSyntaxKind[];
  readonly #formationStatus: FormationStatus;
  readonly #diagnostics: readonly Diagnostic[];
  readonly #entities: readonly Entity[];
  /** Per-atom raw-offset table: raw byte offset at each atom start (terminal entry at the end). */
  readonly #atomRawStarts: Uint32Array;
  /** Per-atom decoded boundary table: decoded UTF-8 byte offset at each atom start (terminal entry at the end). */
  readonly #atomUtf8Bytes: Uint32Array;
  /** Per-atom decoded boundary table: JS code-unit index at each atom start (terminal entry at the end). */
  readonly #atomJsIndexes: Uint32Array;
  readonly #parseLimits: PropertiesParseLimits;
  readonly #root: number;

  /**
   * @internal — construction is only via `parse` (parser.ts); the
   * `@internal` accessors below are consumed by this family's
   * query/projection/edit/materialization modules.
   */
  constructor(
    authority: DocumentAuthority,
    source: SourceSnapshot,
    profile: PropertiesProfile,
    structuralIndex: LosslessStructuralIndex,
    syntaxKinds: readonly PropertiesSyntaxKind[],
    formationStatus: FormationStatus,
    diagnostics: readonly Diagnostic[],
    entities: readonly Entity[],
    atomRawStarts: Uint32Array,
    atomUtf8Bytes: Uint32Array,
    atomJsIndexes: Uint32Array,
    parseLimits: PropertiesParseLimits,
  ) {
    this.#authority = authority;
    this.#source = source;
    this.#profile = profile;
    this.#structuralIndex = structuralIndex;
    this.#syntaxKinds = Object.freeze([...syntaxKinds]);
    this.#formationStatus = formationStatus;
    this.#diagnostics = Object.freeze([...diagnostics]);
    this.#entities = Object.freeze([...entities]);
    this.#atomRawStarts = atomRawStarts;
    this.#atomUtf8Bytes = atomUtf8Bytes;
    this.#atomJsIndexes = atomJsIndexes;
    this.#parseLimits = parseLimits;
    this.#root = 0;
  }

  /** Snapshot identity to which every NodeRef and Span belongs (lib.rs:612-615). */
  snapshotIdentity() {
    return this.#authority.identity();
  }

  /** Exact immutable source snapshot (lib.rs:617-621). */
  source(): SourceSnapshot {
    return this.#source;
  }

  /** Default rendering is byte-for-byte source identity (lib.rs:623-627). */
  render(): Uint8Array {
    return this.#source.bytes();
  }

  /** Stable Java Properties format family (lib.rs:629-633). */
  formatFamily(): FormatFamilyId {
    return new FormatFamilyId('java-properties', 1);
  }

  /** Exact selected profile (lib.rs:635-639). */
  profile(): ProfileId {
    return propertiesProfileId(this.#profile);
  }

  /** Concrete selected profile (lib.rs:641-645). */
  selectedProfile(): PropertiesProfile {
    return this.#profile;
  }

  /** Root Properties document identity (lib.rs:647-651). */
  nodeRef(): NodeRef {
    return this.#authority.nodeRef(0n, 'PropertiesDocument');
  }

  /** Complete or explicitly recovered formation state (lib.rs:653-657). */
  formationStatus(): FormationStatus {
    return this.#formationStatus;
  }

  /** Stable ordered diagnostics (lib.rs:659-663). */
  diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics;
  }

  /** Exhaustive ordered source coverage (lib.rs:665-669). */
  losslessStructuralIndex(): LosslessStructuralIndex {
    return this.#structuralIndex;
  }

  /** Format kind aligned with every structural piece (lib.rs:671-675). */
  losslessSyntaxKinds(): readonly PropertiesSyntaxKind[] {
    return this.#syntaxKinds;
  }

  /** Ordered natural source lines (lib.rs:677-681). */
  naturalLines(): readonly PropertiesNaturalLine[] {
    return this.#collectEntities('NaturalLine', (index) => new PropertiesNaturalLine(this, index));
  }

  /** Ordered property/error logical lines (lib.rs:683-687). */
  logicalLines(): readonly PropertiesLogicalLine[] {
    return this.#collectEntities('LogicalLine', (index) => new PropertiesLogicalLine(this, index));
  }

  /** Ordered duplicate-preserving property associations (lib.rs:689-693). */
  properties(): readonly Property[] {
    return this.#collectEntities('Property', (index) => new Property(this, index));
  }

  /** Ordered comment occurrences (lib.rs:695-699). */
  comments(): readonly PropertiesComment[] {
    return this.#collectEntities('Comment', (index) => new PropertiesComment(this, index));
  }

  /** Ordered escape occurrences (lib.rs:701-705). */
  escapes(): readonly PropertiesEscape[] {
    return this.#collectEntities('Escape', (index) => new PropertiesEscape(this, index));
  }

  /** Ordered recovered error lines (lib.rs:707-711). */
  errorLines(): readonly PropertiesErrorLine[] {
    return this.#collectEntities('ErrorLine', (index) => new PropertiesErrorLine(this, index));
  }

  #collectEntities<T>(kind: Entity['kind'], handle: (index: number) => T): readonly T[] {
    const output: T[] = [];
    for (let index = 0; index < this.#entities.length; index++) {
      if (this.#entities[index].kind === kind) {
        output.push(handle(index));
      }
    }
    return Object.freeze(output);
  }

  /** Resource contract used to form this snapshot (lib.rs:713-717). */
  parseLimits(): PropertiesParseLimits {
    return this.#parseLimits;
  }

  /** Resolves one property handle only within this snapshot (lib.rs:719-729). */
  property(node: NodeRef): Property {
    const index = this.#resolveEntityIndex(node, 'PropertiesProperty', 'Property');
    return new Property(this, index);
  }

  /** Resolves one natural-line handle only within this snapshot (lib.rs:731-744). */
  naturalLine(node: NodeRef): PropertiesNaturalLine {
    const index = this.#resolveEntityIndex(node, 'PropertiesNaturalLine', 'NaturalLine');
    return new PropertiesNaturalLine(this, index);
  }

  /** Resolves one logical-line handle only within this snapshot (lib.rs:746-759). */
  logicalLine(node: NodeRef): PropertiesLogicalLine {
    const index = this.#resolveEntityIndex(node, 'PropertiesLogicalLine', 'LogicalLine');
    return new PropertiesLogicalLine(this, index);
  }

  /** Resolves one escape handle only within this snapshot (lib.rs:761-774). */
  escape(node: NodeRef): PropertiesEscape {
    const index = this.#resolveEntityIndex(node, 'PropertiesEscape', 'Escape');
    return new PropertiesEscape(this, index);
  }

  #resolveEntityIndex(node: NodeRef, role: NodeRole, entityKind: Entity['kind']): number {
    try {
      this.#authority.verify(node);
    } catch {
      throw new PropertiesAccessError('WrongSnapshot');
    }
    if (node.role() !== role) {
      throw new PropertiesAccessError('WrongRole');
    }
    const index = this.#authority.resolveIndex(node);
    if (index > BigInt(Number.MAX_SAFE_INTEGER) || index >= BigInt(this.#entities.length)) {
      throw new PropertiesAccessError('UnknownNode');
    }
    const entity = this.#entities[Number(index)];
    if (entity.kind !== entityKind) {
      throw new PropertiesAccessError('WrongRole');
    }
    return Number(index);
  }

  /** @internal */ authorityInternal(): DocumentAuthority {
    return this.#authority;
  }

  /** @internal */ profileInternal(): PropertiesProfile {
    return this.#profile;
  }

  /** @internal */ entityAt(index: number): Entity {
    return this.#entities[index];
  }

  /** @internal */ entityCount(): number {
    return this.#entities.length;
  }

  /** @internal — creates a NodeRef with the given role for any ordinal (lib.rs: query syntax pieces). */
  nodeRefFor(index: number, role: NodeRole): NodeRef {
    return this.#authority.nodeRef(BigInt(index), role);
  }

  /** @internal — exact decoded text of one atom-aligned span (query.rs:636-651). */
  spanDecodedText(span: Span): string {
    const decodedText = this.#source.decodedText();
    if (decodedText === null) {
      throw new PropertiesAccessError('UnknownNode');
    }
    const startJs = this.#atomJsIndexAtRaw(span.startByte());
    const endJs = this.#atomJsIndexAtRaw(span.endByte());
    return decodedText.slice(startJs, endJs);
  }

  /** @internal — JS code-unit index of one exact raw byte boundary. */
  rawBoundaryJsIndex(rawByte: number): number {
    return this.#atomJsIndexAtRaw(rawByte);
  }

  /** Resolves one atom-aligned raw boundary to its JS code-unit index. */
  #atomJsIndexAtRaw(rawByte: number): number {
    let low = 0;
    let high = this.#atomRawStarts.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.#atomRawStarts[mid] < rawByte) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    if (low >= this.#atomRawStarts.length || this.#atomRawStarts[low] !== rawByte) {
      throw new PropertiesAccessError('UnknownNode');
    }
    return this.#atomJsIndexes[low];
  }
}

// ---------------------------------------------------------------------------
// Typed native handles
// ---------------------------------------------------------------------------

function entityOf<K extends Entity['kind']>(
  document: PropertiesDocument,
  index: number,
  kind: K,
): Extract<Entity, { kind: K }> {
  const entity = document.entityAt(index);
  if (entity.kind !== kind) {
    throw new PropertiesAccessError('WrongRole');
  }
  return entity as Extract<Entity, { kind: K }>;
}

/** One exact natural source line (lib.rs:309-342). */
export class PropertiesNaturalLine {
  readonly #document: PropertiesDocument;
  readonly #index: number;

  constructor(document: PropertiesDocument, index: number) {
    this.#document = document;
    this.#index = index;
  }

  /** Snapshot-bound natural-line identity (lib.rs:319-322). */
  nodeRef(): NodeRef {
    return this.#document.nodeRefFor(this.#index, 'PropertiesNaturalLine');
  }

  /** Complete source span including the terminator (lib.rs:324-327). */
  span(): Span {
    return this.#entity().span;
  }

  /** Content span excluding the terminator (lib.rs:329-334). */
  contentSpan(): Span {
    return this.#entity().contentSpan;
  }

  /** LF, CR, or CRLF span; absent for an EOF line (lib.rs:336-341). */
  lineBreakSpan(): Span | null {
    return this.#entity().lineBreakSpan;
  }

  /** @internal */ entityIndex(): number {
    return this.#index;
  }

  #entity() {
    return entityOf(this.#document, this.#index, 'NaturalLine');
  }
}

/** One property/error logical line and its natural-line constituents (lib.rs:344-370). */
export class PropertiesLogicalLine {
  readonly #document: PropertiesDocument;
  readonly #index: number;

  constructor(document: PropertiesDocument, index: number) {
    this.#document = document;
    this.#index = index;
  }

  /** Snapshot-bound logical-line identity (lib.rs:353-356). */
  nodeRef(): NodeRef {
    return this.#document.nodeRefFor(this.#index, 'PropertiesLogicalLine');
  }

  /** Property or recovered-error classification (lib.rs:358-361). */
  kind(): PropertiesLogicalLineKind {
    return this.#entity().recordKind;
  }

  /** Ordered natural-line constituents (lib.rs:363-368). */
  naturalLines(): readonly PropertiesNaturalLine[] {
    return this.#entity().naturalLines.map((index) => new PropertiesNaturalLine(this.#document, index));
  }

  /** @internal */ entityIndex(): number {
    return this.#index;
  }

  #entity() {
    return entityOf(this.#document, this.#index, 'LogicalLine');
  }
}

/** One comment natural line (lib.rs:372-405). */
export class PropertiesComment {
  readonly #document: PropertiesDocument;
  readonly #index: number;

  constructor(document: PropertiesDocument, index: number) {
    this.#document = document;
    this.#index = index;
  }

  /** Snapshot-bound comment identity (lib.rs:381-384). */
  nodeRef(): NodeRef {
    return this.#document.nodeRefFor(this.#index, 'PropertiesComment');
  }

  /** Owning natural line (lib.rs:386-391). */
  naturalLine(): PropertiesNaturalLine {
    return new PropertiesNaturalLine(this.#document, this.#entity().naturalLine);
  }

  /** Complete comment content span excluding its line break (lib.rs:393-397). */
  span(): Span {
    return this.#entity().span;
  }

  /** Exact comment marker (lib.rs:399-404). */
  marker(): string {
    return this.#entity().marker;
  }

  /** @internal */ entityIndex(): number {
    return this.#index;
  }

  #entity() {
    return entityOf(this.#document, this.#index, 'Comment');
  }
}

/** One source escape and its exact Java-string output range (lib.rs:407-455). */
export class PropertiesEscape {
  readonly #document: PropertiesDocument;
  readonly #index: number;

  constructor(document: PropertiesDocument, index: number) {
    this.#document = document;
    this.#index = index;
  }

  /** Snapshot-bound escape identity (lib.rs:419-422). */
  nodeRef(): NodeRef {
    return this.#document.nodeRefFor(this.#index, 'PropertiesEscape');
  }

  /** Owning property occurrence (lib.rs:424-429). */
  property(): Property {
    return new Property(this.#document, this.#entity().property);
  }

  /** Whether the output range belongs to the decoded key (lib.rs:431-435). */
  inKey(): boolean {
    return this.#entity().inKey;
  }

  /** Exact escape kind (lib.rs:437-441). */
  kind(): PropertiesEscapeKind {
    return this.#entity().escapeKind;
  }

  /** Complete raw escape spelling (lib.rs:443-447). */
  span(): Span {
    return this.#entity().span;
  }

  /** Half-open output code-unit range in the owning key or value (lib.rs:449-455). */
  outputRange(): { readonly start: number; readonly end: number } {
    return { start: this.#entity().outputStart, end: this.#entity().outputEnd };
  }

  /** @internal */ entityIndex(): number {
    return this.#index;
  }

  #entity() {
    return entityOf(this.#document, this.#index, 'Escape');
  }
}

/** One distinct source-ordered property association (lib.rs:457-546). */
export class Property {
  readonly #document: PropertiesDocument;
  readonly #index: number;

  constructor(document: PropertiesDocument, index: number) {
    this.#document = document;
    this.#index = index;
  }

  /** Snapshot-bound property association identity (lib.rs:474-477). */
  nodeRef(): NodeRef {
    return this.#document.nodeRefFor(this.#index, 'PropertiesProperty');
  }

  /** Owning logical line (lib.rs:479-483). */
  logicalLine(): PropertiesLogicalLine {
    return new PropertiesLogicalLine(this.#document, this.#entity().logicalLine);
  }

  /** Complete first-to-last property source range (lib.rs:485-491). */
  span(): Span {
    return this.#entity().span;
  }

  /** Zero-width source anchor at the start of the decoded key (lib.rs:493-497). */
  keyAnchor(): Span {
    return this.#entity().keyAnchor;
  }

  /** Zero-width source anchor at the start of the decoded value (lib.rs:499-503). */
  valueAnchor(): Span {
    return this.#entity().valueAnchor;
  }

  /** Ordered raw source fragments contributing to the key (lib.rs:505-509). */
  keyFragments(): readonly Span[] {
    return this.#entity().keyFragments;
  }

  /** Ordered raw source fragments contributing to the value (lib.rs:511-515). */
  valueFragments(): readonly Span[] {
    return this.#entity().valueFragments;
  }

  /** Exact decoded Java UTF-16 key (lib.rs:517-521). */
  key(): JavaString {
    return this.#entity().key;
  }

  /** Exact decoded Java UTF-16 element (lib.rs:523-527). */
  value(): JavaString {
    return this.#entity().value;
  }

  /** Implicit, explicit empty, or present source state (lib.rs:529-533). */
  valueState(): PropertiesValueState {
    return this.#entity().valueState;
  }

  /** Ordered escape identities in key-then-value decode order (lib.rs:535-539). */
  escapes(): readonly PropertiesEscape[] {
    return this.#entity().escapes.map((index) => new PropertiesEscape(this.#document, index));
  }

  /** Deterministic exact-code-unit duplicate group (lib.rs:541-545). */
  duplicateGroup(): number | null {
    return this.#entity().duplicateGroup;
  }

  /** @internal */ entityIndex(): number {
    return this.#index;
  }

  #entity() {
    return entityOf(this.#document, this.#index, 'Property');
  }
}

/** One recovered malformed logical line (lib.rs:548-588). */
export class PropertiesErrorLine {
  readonly #document: PropertiesDocument;
  readonly #index: number;

  constructor(document: PropertiesDocument, index: number) {
    this.#document = document;
    this.#index = index;
  }

  /** Snapshot-bound error identity (lib.rs:558-561). */
  nodeRef(): NodeRef {
    return this.#document.nodeRefFor(this.#index, 'PropertiesErrorLine');
  }

  /** Owning recovered logical line (lib.rs:563-567). */
  logicalLine(): PropertiesLogicalLine {
    return new PropertiesLogicalLine(this.#document, this.#entity().logicalLine);
  }

  /** Natural lines retained by this recovery record (lib.rs:569-574). */
  naturalLines(): readonly PropertiesNaturalLine[] {
    return this.#entity().naturalLines.map((index) => new PropertiesNaturalLine(this.#document, index));
  }

  /** Complete recovered source range (lib.rs:576-580). */
  span(): Span {
    return this.#entity().span;
  }

  /** Stable diagnostic code (lib.rs:582-587). */
  code(): string {
    return this.#entity().code;
  }

  /** @internal */ entityIndex(): number {
    return this.#index;
  }

  #entity() {
    return entityOf(this.#document, this.#index, 'ErrorLine');
  }
}
