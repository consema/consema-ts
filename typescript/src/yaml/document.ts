/**
 * The immutable YAML stream document and its typed native handles.
 *
 * authority: consema-rs/consema-yaml/src/lib.rs
 *  - Document :322-461 (stream_node_ref :337-341, stream_span :343-349,
 *    snapshot_identity :351-355, source :357-361, render :363-367,
 *    format_family :369-373, profile :375-379, formation_status :381-385
 *    (always Complete), diagnostics :387-391 (always empty),
 *    lossless_structural_index :393-397, lossless_syntax_kinds :399-403,
 *    document :405-415, alias_count :418-421, alias :423-431,
 *    project_graph :433-440, document_count :450-454, parse_limits :456-460)
 *  - YamlDocument :463-501, YamlNode :503-615, YamlScalar :617-647,
 *    YamlSequenceItem :649-689, YamlMappingEntry :691-749, YamlAlias :751-787
 *  - native entities: consema-rs/consema-yaml/src/native.rs NativeStream :33-38,
 *    NativeDocument :40-44, NativeNode :46-53, NativeContent :55-60,
 *    NativeScalar :62-68, NativeSequenceItem :70-76, NativeMappingEntry :78-86,
 *    NativeAlias :88-94
 *  - NodeRole spellings: typescript/src/document/identity.ts:123-130
 *    ('YamlStream' | 'YamlDocument' | 'YamlNode' | 'YamlSequenceElement' |
 *    'YamlMappingEntry' | 'YamlAlias' | 'YamlAnchorDefinition' |
 *    'YamlSyntaxPiece')
 *
 * Design (TypeScript-idiomatic): the document is an immutable class; typed
 * handles (`YamlNode`/`YamlSequenceItem`/`YamlMappingEntry`/`YamlAlias`)
 * borrow one document and an entity index. NodeRef ordinals ARE entity
 * indexes (u64), exactly like the Rust `node_ref(index as u64)` mapping
 * (lib.rs). The `@internal` accessors are consumed only by this
 * family's parser/query/projection/edit modules.
 */

import { FormatFamilyId } from '../document/profile.ts';
import type { DocumentAuthority, NodeRef, NodeRole, Span } from '../document/identity.ts';
import type { LosslessStructuralIndex } from '../document/structural.ts';
import type { ProfileId } from '../document/profile.ts';
import type { ParseLimits, FormationStatus } from '../document/formation.ts';
import type { SourceSnapshot } from '../document/source.ts';
import type { Diagnostic } from '../document/diagnostic.ts';
import { YamlAccessError } from './errors.ts';
import { yamlProfileId } from './profile.ts';
import type { YamlProfile } from './profile.ts';
import type { YamlSyntaxKind } from './syntax.ts';
import type { YamlNodeKind, YamlScalarKind, YamlScalarStyle } from './semantic.ts';

// ---------------------------------------------------------------------------
// Internal entities
// ---------------------------------------------------------------------------

/** One internal native scalar (native.rs NativeScalar :62-68). */
export interface InternalScalar {
  readonly decoded: string;
  readonly canonical: string;
  readonly kind: YamlScalarKind;
  readonly style: YamlScalarStyle;
}

/** One ordered sequence association (native.rs NativeSequenceItem :70-76). */
export interface InternalSequenceItem {
  readonly identity: bigint;
  readonly node: number;
  readonly span: Span;
  /** Alias occurrence ordinal supplying this edge, when present. */
  readonly alias: number | null;
}

/** One ordered mapping association (native.rs NativeMappingEntry :78-86). */
export interface InternalMappingEntry {
  readonly identity: bigint;
  readonly key: number;
  readonly value: number;
  readonly span: Span;
  readonly keyAlias: number | null;
  readonly valueAlias: number | null;
}

/** One alias serialization occurrence (native.rs NativeAlias :88-94). */
export interface InternalAlias {
  readonly identity: bigint;
  readonly name: string;
  readonly target: number;
  readonly span: Span;
}

/** One composed representation node (native.rs NativeNode :46-53). */
export interface InternalNode {
  readonly tag: string;
  readonly anchor: string | null;
  readonly anchorSpan: Span | null;
  readonly span: Span;
  readonly content: InternalContent;
}

/** Node content union (native.rs NativeContent :55-60). */
export type InternalContent =
  | { readonly kind: 'Scalar'; readonly scalar: InternalScalar }
  | { readonly kind: 'Sequence'; readonly items: readonly InternalSequenceItem[] }
  | { readonly kind: 'Mapping'; readonly entries: readonly InternalMappingEntry[] };

/** One independent document (native.rs NativeDocument :40-44). */
export interface InternalDocument {
  readonly root: number;
  readonly span: Span;
}

// ---------------------------------------------------------------------------
// YamlDocument
// ---------------------------------------------------------------------------

/** Opaque immutable YAML stream snapshot (lib.rs). */
export class YamlDocument {
  readonly #authority: DocumentAuthority;
  readonly #source: SourceSnapshot;
  readonly #profile: YamlProfile;
  readonly #structuralIndex: LosslessStructuralIndex;
  readonly #syntaxKinds: readonly YamlSyntaxKind[];
  readonly #nodes: readonly InternalNode[];
  readonly #documents: readonly InternalDocument[];
  readonly #aliases: readonly InternalAlias[];
  readonly #streamDocuments: number;
  readonly #parseLimits: ParseLimits;

  /**
   * @internal — construction is only via `parse` (parser.ts); the
   * `@internal` accessors below are consumed by this family's
   * query/projection/edit modules.
   */
  constructor(
    authority: DocumentAuthority,
    source: SourceSnapshot,
    profile: YamlProfile,
    structuralIndex: LosslessStructuralIndex,
    syntaxKinds: readonly YamlSyntaxKind[],
    nodes: readonly InternalNode[],
    documents: readonly InternalDocument[],
    aliases: readonly InternalAlias[],
    streamDocuments: number,
    parseLimits: ParseLimits,
  ) {
    this.#authority = authority;
    this.#source = source;
    this.#profile = profile;
    this.#structuralIndex = structuralIndex;
    this.#syntaxKinds = Object.freeze([...syntaxKinds]);
    this.#nodes = Object.freeze([...nodes]);
    this.#documents = Object.freeze([...documents]);
    this.#aliases = Object.freeze([...aliases]);
    this.#streamDocuments = streamDocuments;
    this.#parseLimits = parseLimits;
  }

  /** Snapshot-bound identity of the complete serialization stream (lib.rs). */
  streamNodeRef(): NodeRef {
    return this.#authority.nodeRef(0n, 'YamlStream');
  }

  /** Exact raw span of the complete serialization stream (lib.rs). */
  streamSpan(): Span {
    return this.#authority.span(0, this.#source.len());
  }

  /** Snapshot identity to which future native handles and spans are bound (lib.rs). */
  snapshotIdentity() {
    return this.#authority.identity();
  }

  /** Exact immutable source and decoded-location facts (lib.rs). */
  source(): SourceSnapshot {
    return this.#source;
  }

  /** Default rendering is byte-for-byte identical to the input (lib.rs). */
  render(): Uint8Array {
    return this.#source.bytes();
  }

  /** YAML format-family contract (lib.rs). */
  formatFamily(): FormatFamilyId {
    return new FormatFamilyId('yaml', 1);
  }

  /** Exact selected YAML profile (lib.rs). */
  profile(): ProfileId {
    return yamlProfileId(this.#profile);
  }

  /** Complete valid streams require no recovered semantic claims (lib.rs). */
  formationStatus(): FormationStatus {
    return 'Complete';
  }

  /** Complete YAML formation publishes no recovery diagnostics (lib.rs). */
  diagnostics(): readonly Diagnostic[] {
    return [];
  }

  /** Exhaustive token/trivia byte coverage (lib.rs). */
  losslessStructuralIndex(): LosslessStructuralIndex {
    return this.#structuralIndex;
  }

  /** Format-specific kind for each structural piece in source order (lib.rs). */
  losslessSyntaxKinds(): readonly YamlSyntaxKind[] {
    return this.#syntaxKinds;
  }

  /** Returns one independent YAML document by stream ordinal (lib.rs). */
  document(ordinal: number): YamlDocumentView | null {
    const internal = this.#documents[ordinal];
    if (internal === undefined) {
      return null;
    }
    return new YamlDocumentView(this, ordinal, internal);
  }

  /** Number of alias serialization occurrences; aliases are never expanded (lib.rs). */
  aliasCount(): number {
    return this.#aliases.length;
  }

  /** Returns one alias occurrence in serialization order (lib.rs). */
  alias(ordinal: number): YamlAlias | null {
    const alias = this.#aliases[ordinal];
    if (alias === undefined) {
      return null;
    }
    return new YamlAlias(this, alias);
  }

  /** Number of independent YAML documents in this stream (lib.rs). */
  documentCount(): number {
    return this.#streamDocuments;
  }

  /** Resource contract used to form this stream (lib.rs). */
  parseLimits(): ParseLimits {
    return this.#parseLimits;
  }

  /** @internal */ authorityInternal(): DocumentAuthority {
    return this.#authority;
  }

  /** @internal */ profileInternal(): YamlProfile {
    return this.#profile;
  }

  /** @internal */ nodeAt(index: number): InternalNode {
    return this.#nodes[index];
  }

  /** @internal */ nodeCount(): number {
    return this.#nodes.length;
  }

  /** @internal */ documentInternal(ordinal: number): InternalDocument {
    return this.#documents[ordinal];
  }

  /** @internal */ documentsInternal(): readonly InternalDocument[] {
    return this.#documents;
  }

  /** @internal */ aliasesInternal(): readonly InternalAlias[] {
    return this.#aliases;
  }

  /** @internal */ nodeRefFor(index: number, role: NodeRole): NodeRef {
    return this.#authority.nodeRef(BigInt(index), role);
  }
}

// ---------------------------------------------------------------------------
// Typed native handles
// ---------------------------------------------------------------------------

/** One independent document in a YAML stream (lib.rs). */
export class YamlDocumentView {
  readonly #owner: YamlDocument;
  readonly #ordinal: number;
  readonly #document: InternalDocument;

  constructor(owner: YamlDocument, ordinal: number, document: InternalDocument) {
    this.#owner = owner;
    this.#ordinal = ordinal;
    this.#document = document;
  }

  /** Zero-based stream ordinal (lib.rs). */
  ordinal(): number {
    return this.#ordinal;
  }

  /** Snapshot-bound document identity (lib.rs). */
  nodeRef(): NodeRef {
    return this.#owner.nodeRefFor(this.#ordinal, 'YamlDocument');
  }

  /** Backend-validated raw document presentation span (lib.rs). */
  span(): Span {
    return this.#document.span;
  }

  /** Representation root; alias occurrences already share target identity (lib.rs). */
  root(): YamlNode {
    return new YamlNode(this.#owner, this.#document.root);
  }

  /** @internal */ ownerInternal(): YamlDocument {
    return this.#owner;
  }
}

/** Snapshot-bound YAML representation node (lib.rs). */
export class YamlNode {
  readonly #owner: YamlDocument;
  readonly #index: number;

  constructor(owner: YamlDocument, index: number) {
    this.#owner = owner;
    this.#index = index;
  }

  /** Process-local stable identity within this snapshot (lib.rs). */
  nodeRef(): NodeRef {
    return this.#owner.nodeRefFor(this.#index, 'YamlNode');
  }

  /** Exact raw representation occurrence span (lib.rs). */
  span(): Span {
    return this.#owner.nodeAt(this.#index).span;
  }

  /** Resolved tag identifier (lib.rs). */
  tag(): string {
    return this.#owner.nodeAt(this.#index).tag;
  }

  /** Exact anchor name on the defining occurrence, if present (lib.rs). */
  anchor(): string | null {
    return this.#owner.nodeAt(this.#index).anchor;
  }

  /** Snapshot-bound anchor-definition identity, when this node defines one (lib.rs). */
  anchorNodeRef(): NodeRef | null {
    const node = this.#owner.nodeAt(this.#index);
    return node.anchor === null
      ? null
      : this.#owner.nodeRefFor(this.#index, 'YamlAnchorDefinition');
  }

  /** Exact raw `&name` span, when this node defines an anchor (lib.rs). */
  anchorSpan(): Span | null {
    return this.#owner.nodeAt(this.#index).anchorSpan;
  }

  /** Native node kind (lib.rs). */
  kind(): YamlNodeKind {
    switch (this.#owner.nodeAt(this.#index).content.kind) {
      case 'Scalar':
        return 'Scalar';
      case 'Sequence':
        return 'Sequence';
      case 'Mapping':
        return 'Mapping';
    }
  }

  /** Scalar facts, when this is a scalar node (lib.rs). */
  scalar(): YamlScalar | null {
    const content = this.#owner.nodeAt(this.#index).content;
    return content.kind === 'Scalar' ? new YamlScalar(content.scalar) : null;
  }

  /** Ordered sequence association count (lib.rs). */
  sequenceLen(): number | null {
    const content = this.#owner.nodeAt(this.#index).content;
    return content.kind === 'Sequence' ? content.items.length : null;
  }

  /** One exact sequence association (lib.rs). */
  sequenceItem(ordinal: number): YamlSequenceItem | null {
    const content = this.#owner.nodeAt(this.#index).content;
    if (content.kind !== 'Sequence') {
      return null;
    }
    const item = content.items[ordinal];
    return item === undefined ? null : new YamlSequenceItem(this.#owner, item);
  }

  /** Ordered mapping association count (lib.rs). */
  mappingLen(): number | null {
    const content = this.#owner.nodeAt(this.#index).content;
    return content.kind === 'Mapping' ? content.entries.length : null;
  }

  /** One exact arbitrary key/value association (lib.rs). */
  mappingEntry(ordinal: number): YamlMappingEntry | null {
    const content = this.#owner.nodeAt(this.#index).content;
    if (content.kind !== 'Mapping') {
      return null;
    }
    const entry = content.entries[ordinal];
    return entry === undefined ? null : new YamlMappingEntry(this.#owner, entry);
  }

  /** @internal */ indexInternal(): number {
    return this.#index;
  }

  /** @internal */ ownerInternal(): YamlDocument {
    return this.#owner;
  }
}

/** Native scalar facts with exact decoded and canonical content (lib.rs). */
export class YamlScalar {
  readonly #scalar: InternalScalar;

  constructor(scalar: InternalScalar) {
    this.#scalar = scalar;
  }

  /** Decoded YAML scalar content before schema canonicalization (lib.rs). */
  decoded(): string {
    return this.#scalar.decoded;
  }

  /** Profile-defined canonical scalar content (lib.rs). */
  canonical(): string {
    return this.#scalar.canonical;
  }

  /** Resolved scalar category (lib.rs). */
  kind(): YamlScalarKind {
    return this.#scalar.kind;
  }

  /** Source presentation style (lib.rs). */
  style(): YamlScalarStyle {
    return this.#scalar.style;
  }
}

/** One ordered sequence association (lib.rs). */
export class YamlSequenceItem {
  readonly #owner: YamlDocument;
  readonly #item: InternalSequenceItem;

  constructor(owner: YamlDocument, item: InternalSequenceItem) {
    this.#owner = owner;
    this.#item = item;
  }

  /** Snapshot-bound association identity (lib.rs). */
  nodeRef(): NodeRef {
    return this.#owner.nodeRefFor(Number(this.#item.identity), 'YamlSequenceElement');
  }

  /** Exact raw element occurrence span, including an alias spelling when used (lib.rs). */
  span(): Span {
    return this.#item.span;
  }

  /** Referenced representation node (lib.rs). */
  node(): YamlNode {
    return new YamlNode(this.#owner, this.#item.node);
  }

  /** Alias occurrence that supplied this element edge, when present (lib.rs). */
  alias(): YamlAlias | null {
    if (this.#item.alias === null) {
      return null;
    }
    const alias = this.#owner.aliasesInternal()[this.#item.alias];
    return alias === undefined ? null : new YamlAlias(this.#owner, alias);
  }

  /** @internal */ aliasOrdinalInternal(): number | null {
    return this.#item.alias;
  }
}

/** One ordered YAML mapping association with an arbitrary key node (lib.rs). */
export class YamlMappingEntry {
  readonly #owner: YamlDocument;
  readonly #entry: InternalMappingEntry;

  constructor(owner: YamlDocument, entry: InternalMappingEntry) {
    this.#owner = owner;
    this.#entry = entry;
  }

  /** Snapshot-bound association identity (lib.rs). */
  nodeRef(): NodeRef {
    return this.#owner.nodeRefFor(Number(this.#entry.identity), 'YamlMappingEntry');
  }

  /** Raw span from the key occurrence through the value occurrence (lib.rs). */
  span(): Span {
    return this.#entry.span;
  }

  /** Arbitrary key node (lib.rs). */
  key(): YamlNode {
    return new YamlNode(this.#owner, this.#entry.key);
  }

  /** Value node (lib.rs). */
  value(): YamlNode {
    return new YamlNode(this.#owner, this.#entry.value);
  }

  /** Alias occurrence that supplied the key edge, when present (lib.rs). */
  keyAlias(): YamlAlias | null {
    return this.#aliasAt(this.#entry.keyAlias);
  }

  /** Alias occurrence that supplied the value edge, when present (lib.rs). */
  valueAlias(): YamlAlias | null {
    return this.#aliasAt(this.#entry.valueAlias);
  }

  /** @internal */ keyAliasOrdinalInternal(): number | null {
    return this.#entry.keyAlias;
  }

  /** @internal */ valueAliasOrdinalInternal(): number | null {
    return this.#entry.valueAlias;
  }

  #aliasAt(ordinal: number | null): YamlAlias | null {
    if (ordinal === null) {
      return null;
    }
    const alias = this.#owner.aliasesInternal()[ordinal];
    return alias === undefined ? null : new YamlAlias(this.#owner, alias);
  }
}

/** One alias serialization occurrence pointing at an existing representation node (lib.rs). */
export class YamlAlias {
  readonly #owner: YamlDocument;
  readonly #alias: InternalAlias;

  constructor(owner: YamlDocument, alias: InternalAlias) {
    this.#owner = owner;
    this.#alias = alias;
  }

  /** Snapshot-bound occurrence identity (lib.rs). */
  nodeRef(): NodeRef {
    return this.#owner.nodeRefFor(Number(this.#alias.identity), 'YamlAlias');
  }

  /** Exact raw `*name` occurrence span (lib.rs). */
  span(): Span {
    return this.#alias.span;
  }

  /** Exact alias name without `*` (lib.rs). */
  name(): string {
    return this.#alias.name;
  }

  /** Shared target representation node; no expansion occurs (lib.rs). */
  target(): YamlNode {
    return new YamlNode(this.#owner, this.#alias.target);
  }

  /** @internal */ targetIndexInternal(): number {
    return this.#alias.target;
  }
}

/** Resolves one NodeRef to its entity index with role checking (lib.rs analog). */
export function resolveNodeIndex(
  document: YamlDocument,
  node: NodeRef,
  role: NodeRole,
): number {
  const authority = document.authorityInternal();
  try {
    authority.verify(node);
  } catch {
    throw new YamlAccessError('WrongSnapshot');
  }
  if (node.role() !== role) {
    throw new YamlAccessError('WrongRole');
  }
  const index = authority.resolveIndex(node);
  if (index > BigInt(Number.MAX_SAFE_INTEGER) || index >= BigInt(document.nodeCount())) {
    throw new YamlAccessError('UnknownNode');
  }
  return Number(index);
}
