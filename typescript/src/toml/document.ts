/**
 * The immutable TOML document snapshot and its native accessors.
 *
 * authority:
 *  - document surface: crates/consema-toml/src/lib.rs:121-259 — parse
 *    (:122-128), Document facts (:144-203: snapshot_identity, source,
 *    render, format_family "toml@1" :163-167, profile, formation_status
 *    Complete :175-179, diagnostics, lossless_structural_index,
 *    lossless_syntax_kinds, parse_limits, root, item), TomlAccessError
 *    (:262-270)
 *  - roles: RFC 0001 §2 (TomlItem/TomlEntry/TomlKey/TomlArrayElement);
 *    NodeRole spellings pinned in crates/consema-document/src/lib.rs:113-251
 *    (TomlItem/TomlEntry/TomlKey/TomlArrayElement/TomlSyntaxPiece)
 *  - item kind spellings: crates/consema-toml/src/lib.rs:274-305
 *  - parse order and resource limits: RFC 0001 §3 (:51-62) and
 *    parser.rs:17-63 — max_source_bytes then UTF-8 then grammar then
 *    limits; every failure is FatalFormationFailure, never truncated
 *  - exact render: parser.rs:157-161 (byte-for-byte identical to source)
 *
 * Design (TypeScript-idiomatic): the document is an immutable class whose
 * accessors return snapshot-bound handle objects; roles are the closed
 * NodeRole spellings from the document domain. Formation never returns a
 * partial document: parseTomlDocument throws TomlFormationFailure.
 */

import {
  DocumentAuthority,
  NodeRef,
  SnapshotIdentity,
  Span,
} from '../document/identity.ts';
import type { NodeRole } from '../document/identity.ts';
import { FormatFamilyId, ProfileId } from '../document/profile.ts';
import type { FormationStatus, ParseLimits } from '../document/formation.ts';
import { LosslessStructuralIndex } from '../document/structural.ts';
import { SourceSnapshot } from '../document/source.ts';
import { SourceError } from '../document/errors.ts';
import type { Diagnostic } from '../document/diagnostic.ts';
import { TomlAccessError, TomlFormationFailure } from './errors.ts';
import type { TomlProfile } from './profile.ts';
import {
  parseTomlText,
} from './parser.ts';
import type {
  Entity,
  ItemEntityKind,
  TomlDateTime,
  TomlItemKind,
  TomlTableFlavor,
} from './parser.ts';
import { tokenizeTomlSource, preflightDelimiterNesting } from './tokenizer.ts';
import type { TomlSyntaxKind } from './tokenizer.ts';

/**
 * Parses one complete immutable TOML 1.0 document snapshot (lib.rs:122-128;
 * parser.rs:17-63 formation order). Throws TomlFormationFailure on any
 * failure — a truncated success never exists (RFC 0001 §3).
 */
export function parseToml(
  sourceBytes: Uint8Array,
  profile: TomlProfile,
  limits: ParseLimits,
): TomlDocument {
  if (sourceBytes.length > limits.maxSourceBytes) {
    throw new TomlFormationFailure('ResourceLimit', {
      limitName: 'source_bytes',
      observed: sourceBytes.length,
      limit: limits.maxSourceBytes,
    });
  }
  let source: SourceSnapshot;
  try {
    source = SourceSnapshot.fromUtf8(sourceBytes);
  } catch (error) {
    if (error instanceof SourceError) {
      throw new TomlFormationFailure('Source', { sourceCode: error.code });
    }
    throw error;
  }
  const authority = DocumentAuthority.fresh();
  const text = source.decodedText()!;
  const { pieces, syntaxKinds } = tokenizeTomlSource(text, authority, limits.maxTokenCount);
  preflightDelimiterNesting(text, pieces, limits.maxNestingDepth);
  const structuralIndex = LosslessStructuralIndex.create(
    authority.identity(),
    source.len(),
    pieces,
  );
  const { root, entities } = parseTomlText(text, authority, limits);
  return new TomlDocument(
    authority,
    source,
    profile,
    structuralIndex,
    syntaxKinds,
    entities,
    root,
    limits,
  );
}

/** Opaque immutable TOML document snapshot (lib.rs:130-142). */
export class TomlDocument {
  readonly #authority: DocumentAuthority;
  readonly #source: SourceSnapshot;
  readonly #profile: TomlProfile;
  readonly #structuralIndex: LosslessStructuralIndex;
  readonly #syntaxKinds: readonly TomlSyntaxKind[];
  readonly #entities: readonly Entity[];
  readonly #root: number;
  readonly #parseLimits: ParseLimits;

  /** @internal — formed via `parseToml`. */
  constructor(
    authority: DocumentAuthority,
    source: SourceSnapshot,
    profile: TomlProfile,
    structuralIndex: LosslessStructuralIndex,
    syntaxKinds: readonly TomlSyntaxKind[],
    entities: readonly Entity[],
    root: number,
    parseLimits: ParseLimits,
  ) {
    this.#authority = authority;
    this.#source = source;
    this.#profile = profile;
    this.#structuralIndex = structuralIndex;
    this.#syntaxKinds = Object.freeze([...syntaxKinds]);
    this.#entities = Object.freeze([...entities]);
    this.#root = root;
    this.#parseLimits = parseLimits;
  }

  /** Snapshot identity to which every native handle and span belongs (lib.rs:146-149). */
  snapshotIdentity(): SnapshotIdentity {
    return this.#authority.identity();
  }

  /** Exact immutable UTF-8 source (lib.rs:152-155). */
  source(): SourceSnapshot {
    return this.#source;
  }

  /** Default rendering is byte-for-byte identical to the source (lib.rs:157-161). */
  render(): Uint8Array {
    return this.#source.bytes();
  }

  /** TOML format family contract (lib.rs:163-167). */
  formatFamily(): FormatFamilyId {
    return new FormatFamilyId('toml', 1);
  }

  /** Exact language profile (lib.rs:169-173). */
  profile(): ProfileId {
    return this.#profile.id();
  }

  /** TOML 0.2 forms only complete valid documents (lib.rs:175-179). */
  formationStatus(): FormationStatus {
    return 'Complete';
  }

  /** Deterministically ordered non-fatal diagnostics; always empty for complete documents (lib.rs:181-185). */
  diagnostics(): readonly Diagnostic[] {
    return [];
  }

  /** Exhaustive token/trivia byte coverage (lib.rs:187-191). */
  losslessStructuralIndex(): LosslessStructuralIndex {
    return this.#structuralIndex;
  }

  /** Format-specific kind for every structural piece, in the same source order (lib.rs:193-197). */
  losslessSyntaxKinds(): readonly TomlSyntaxKind[] {
    return this.#syntaxKinds;
  }

  /** Resource contract used to form this snapshot and any edit successor (lib.rs:199-203). */
  parseLimits(): ParseLimits {
    return this.#parseLimits;
  }

  /** Root native item, which is always `RootTable` (lib.rs:205-212). */
  root(): TomlItem {
    return new TomlItem(this, this.#root);
  }

  /** Resolves a snapshot-bound TOML item handle (lib.rs:214-224). */
  item(node: NodeRef): TomlItem {
    const index = this.validateRef(node, 'TomlItem');
    if (this.#entities[index].kind.role !== 'Item') {
      throw new TomlAccessError('WrongRole');
    }
    return new TomlItem(this, index);
  }

  // -- internal accessors (documented integration surface for this family) --

  /** @internal */
  authority(): DocumentAuthority {
    return this.#authority;
  }

  /** @internal */
  entity(index: number): Entity {
    return this.#entities[index];
  }

  /** @internal */
  itemEntity(index: number): ItemEntityKind {
    const kind = this.#entities[index].kind;
    if (kind.role !== 'Item') {
      throw new Error('internal: toml item entity expected');
    }
    return kind.item;
  }

  /** @internal */
  nodeRef(index: number, role: NodeRole): NodeRef {
    return this.#authority.nodeRef(BigInt(index), role);
  }

  /** @internal — mirror of lib.rs:241-258. */
  validateRef(node: NodeRef, role: NodeRole): number {
    this.#authority.verify(node);
    if (node.role() !== role) {
      throw new TomlAccessError('WrongRole');
    }
    const index = Number(this.#authority.resolveIndex(node));
    if (index >= this.#entities.length) {
      throw new TomlAccessError('UnknownNode');
    }
    return index;
  }

  /** @internal — entity index of one snapshot-bound node handle (query.rs:240-247). */
  resolveIndex(node: NodeRef): number {
    return Number(this.#authority.resolveIndex(node));
  }

  /** @internal — total structural entity count (edit preparation scans parents). */
  entityCount(): number {
    return this.#entities.length;
  }

  /** @internal — whether one entity index is an item entity. */
  isItemEntity(index: number): boolean {
    return this.#entities[index].kind.role === 'Item';
  }

  /** @internal — item payload of one index, or null for non-item entities. */
  itemEntityOrNull(index: number): ItemEntityKind | null {
    const kind = this.#entities[index].kind;
    return kind.role === 'Item' ? kind.item : null;
  }
}

/** Borrowed native TOML item bound to one document snapshot (lib.rs:351-369). */
export class TomlItem {
  readonly #document: TomlDocument;
  readonly #index: number;

  constructor(document: TomlDocument, index: number) {
    this.#document = document;
    this.#index = index;
  }

  /** Exact item identity (lib.rs:358-363). */
  nodeRef(): NodeRef {
    return this.#document.nodeRef(this.#index, 'TomlItem');
  }

  /** Exact or contract-authorized logical source span (lib.rs:365-369). */
  span(): Span {
    return this.#document.entity(this.#index).span;
  }

  /** Native item category (lib.rs:274-305). */
  kind(): TomlItemKind {
    return itemKindOf(this.#document.itemEntity(this.#index));
  }

  /** Direct table/inline-table entries, or null for non-table items. */
  tableEntries(): TomlEntry[] | null {
    const kind = this.#document.itemEntity(this.#index);
    if (kind.kind === 'Table' || kind.kind === 'InlineTable') {
      return kind.entries.map((entry) => new TomlEntry(this.#document, entry));
    }
    return null;
  }

  /** Direct array/array-of-tables elements, or null for other items. */
  arrayElements(): TomlArrayElement[] | null {
    const kind = this.#document.itemEntity(this.#index);
    if (kind.kind === 'Array' || kind.kind === 'ArrayOfTables') {
      return kind.elements.map((element) => new TomlArrayElement(this.#document, element));
    }
    return null;
  }

  /** Decoded boolean, or null for non-boolean items. */
  asBoolean(): boolean | null {
    const kind = this.#document.itemEntity(this.#index);
    return kind.kind === 'Boolean' ? kind.value : null;
  }

  /** Decoded signed 64-bit integer, or null for non-integer items. */
  asInteger(): bigint | null {
    const kind = this.#document.itemEntity(this.#index);
    return kind.kind === 'Integer' ? kind.value : null;
  }

  /** Exact IEEE-754 binary64 bit pattern, or null for non-float items. */
  asFloatBits(): bigint | null {
    const kind = this.#document.itemEntity(this.#index);
    return kind.kind === 'Float' ? kind.bits : null;
  }

  /** Decoded string, or null for non-string items. */
  asString(): string | null {
    const kind = this.#document.itemEntity(this.#index);
    return kind.kind === 'String' ? kind.value : null;
  }

  /** Parsed date/time datum, or null for non-temporal items. */
  asDateTime(): TomlDateTime | null {
    const kind = this.#document.itemEntity(this.#index);
    return kind.kind === 'DateTime' ? kind.value : null;
  }

  /** @internal */
  index(): number {
    return this.#index;
  }
}

/** Ordered table or inline-table entry association (RFC 0001 §2). */
export class TomlEntry {
  readonly #document: TomlDocument;
  readonly #index: number;

  constructor(document: TomlDocument, index: number) {
    this.#document = document;
    this.#index = index;
  }

  /** Exact entry identity (NodeRole::TomlEntry). */
  nodeRef(): NodeRef {
    return this.#document.nodeRef(this.#index, 'TomlEntry');
  }

  /** Exact source span (union of the key and item spans). */
  span(): Span {
    return this.#document.entity(this.#index).span;
  }

  /** Zero-based direct entry ordinal in the owning table. */
  ordinal(): number {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'Entry') {
      throw new Error('internal: toml entry entity expected');
    }
    return kind.ordinal;
  }

  /** Decoded direct key segment (RFC 0001 §2.1). */
  name(): string {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'Entry') {
      throw new Error('internal: toml entry entity expected');
    }
    const keyKind = this.#document.entity(kind.key).kind;
    if (keyKind.role !== 'Key') {
      throw new Error('internal: toml key entity expected');
    }
    return keyKind.name;
  }

  /** Key identity. */
  keyNodeRef(): NodeRef {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'Entry') {
      throw new Error('internal: toml entry entity expected');
    }
    return this.#document.nodeRef(kind.key, 'TomlKey');
  }

  /** Key accessor. */
  key(): TomlKey {
    return new TomlKey(this.#document, this.entryKeyIndex());
  }

  /** Associated item identity. */
  itemNodeRef(): NodeRef {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'Entry') {
      throw new Error('internal: toml entry entity expected');
    }
    return this.#document.nodeRef(kind.item, 'TomlItem');
  }

  /** Associated item accessor. */
  item(): TomlItem {
    return new TomlItem(this.#document, this.entryItemIndex());
  }

  /** @internal */
  entryKeyIndex(): number {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'Entry') {
      throw new Error('internal: toml entry entity expected');
    }
    return kind.key;
  }

  /** @internal */
  entryItemIndex(): number {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'Entry') {
      throw new Error('internal: toml entry entity expected');
    }
    return kind.item;
  }

  /** @internal */
  index(): number {
    return this.#index;
  }
}

/** Decoded direct key segment with its source identity (RFC 0001 §2). */
export class TomlKey {
  readonly #document: TomlDocument;
  readonly #index: number;

  constructor(document: TomlDocument, index: number) {
    this.#document = document;
    this.#index = index;
  }

  /** Exact key identity (NodeRole::TomlKey). */
  nodeRef(): NodeRef {
    return this.#document.nodeRef(this.#index, 'TomlKey');
  }

  /** Exact segment source span. */
  span(): Span {
    return this.#document.entity(this.#index).span;
  }

  /** Decoded direct key segment. */
  name(): string {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'Key') {
      throw new Error('internal: toml key entity expected');
    }
    return kind.name;
  }
}

/** Ordered array or array-of-tables element association (RFC 0001 §2). */
export class TomlArrayElement {
  readonly #document: TomlDocument;
  readonly #index: number;

  constructor(document: TomlDocument, index: number) {
    this.#document = document;
    this.#index = index;
  }

  /** Exact element identity (NodeRole::TomlArrayElement). */
  nodeRef(): NodeRef {
    return this.#document.nodeRef(this.#index, 'TomlArrayElement');
  }

  /** Exact source span. */
  span(): Span {
    return this.#document.entity(this.#index).span;
  }

  /** Zero-based direct element ordinal. */
  ordinal(): number {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'Element') {
      throw new Error('internal: toml element entity expected');
    }
    return kind.ordinal;
  }

  /** Associated item identity. */
  itemNodeRef(): NodeRef {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'Element') {
      throw new Error('internal: toml element entity expected');
    }
    return this.#document.nodeRef(kind.item, 'TomlItem');
  }

  /** Associated item accessor. */
  item(): TomlItem {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'Element') {
      throw new Error('internal: toml element entity expected');
    }
    return new TomlItem(this.#document, kind.item);
  }

  /** @internal */
  elementItemIndex(): number {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'Element') {
      throw new Error('internal: toml element entity expected');
    }
    return kind.item;
  }

  /** @internal */
  index(): number {
    return this.#index;
  }
}

/** Item-kind mapping (lib.rs:613-636). */
export function itemKindOf(item: ItemEntityKind): TomlItemKind {
  switch (item.kind) {
    case 'String':
    case 'Integer':
    case 'Float':
    case 'Boolean':
    case 'Array':
    case 'InlineTable':
      return item.kind;
    case 'DateTime':
      // lib.rs:619-625 — the public kind follows the parsed fields.
      if (item.value.date !== null && item.value.time !== null && item.value.offset !== null) {
        return 'OffsetDateTime';
      }
      if (item.value.date !== null && item.value.time !== null) {
        return 'LocalDateTime';
      }
      if (item.value.date !== null) {
        return 'LocalDate';
      }
      return 'LocalTime';
    case 'Table':
      return tableFlavorKind(item.flavor);
    case 'ArrayOfTables':
      return 'ArrayOfTables';
  }
}

/** Table flavor → public kind (lib.rs:232-240, 274-305). */
export function tableFlavorKind(flavor: TomlTableFlavor): TomlItemKind {
  switch (flavor) {
    case 'Root':
      return 'RootTable';
    case 'Dotted':
      return 'DottedTable';
    case 'Implicit':
      return 'ImplicitTable';
    case 'Standard':
      return 'StandardTable';
  }
}
