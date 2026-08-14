/**
 * Immutable source snapshots, structural locations, and change facts —
 * the process-local identity surface of the document domain.
 *
 * authority: consema-rs/consema-document/src/lib.rs（:N-M 区间引用，
 * 行号可能漂移，以符号名为锚）
 *  - SnapshotIdentity: :41-51 (opaque u64 identity of exactly one
 *    immutable document snapshot; never serialized, RFC 0003 §3)
 *  - DocumentAuthority: :53-110 (fresh identities, node/span issuance,
 *    snapshot verification)
 *  - NodeRole: :113-251 (the complete frozen role set — every family's
 *    roles are pinned here so no later family agent edits this file)
 *  - NodeRef: :253-292 (opaque handle: snapshot + ordinal + role)
 *  - AssociationPlacement: :262-272
 *  - Span: :294-342 (half-open [start_byte, end_byte) over original raw
 *    bytes, RFC 0003 §5)
 *
 * Design (TypeScript-idiomatic): identities are classes with readonly
 * fields and value semantics (`equals`); the u64 ordinal/identity values
 * are bigints because JS numbers cannot represent the full u64 range.
 * NodeRole is a closed string-literal union, so an exhaustive switch on a
 * role is compiler-checked (RFC 0016 §4.1 "no default that silently
 * accepts unknown kinds" applied to roles).
 */

import { LocationError } from './errors.ts';

/** Opaque identity of exactly one immutable document snapshot (lib.rs). */
export class SnapshotIdentity {
  readonly #value: bigint;

  private constructor(value: bigint) {
    this.#value = value;
  }

  static of(value: bigint): SnapshotIdentity {
    if (value <= 0n) {
      throw new RangeError('snapshot identity must be positive');
    }
    return new SnapshotIdentity(value);
  }

  /** Stable process-local representation for protocol diagnostics (lib.rs). */
  asBigInt(): bigint {
    return this.#value;
  }

  equals(other: SnapshotIdentity): boolean {
    return this.#value === other.#value;
  }
}

/** Authority owned by one document implementation for issuing snapshot-bound handles (lib.rs). */
export class DocumentAuthority {
  readonly #identity: SnapshotIdentity;
  static #next: bigint = 1n;

  private constructor() {
    this.#identity = SnapshotIdentity.of(DocumentAuthority.#next);
    DocumentAuthority.#next += 1n;
  }

  /** Allocates a fresh snapshot identity (lib.rs). */
  static fresh(): DocumentAuthority {
    return new DocumentAuthority();
  }

  /** Snapshot identity (lib.rs). */
  identity(): SnapshotIdentity {
    return this.#identity;
  }

  /** Issues one opaque node handle (lib.rs). */
  nodeRef(index: bigint, role: NodeRole): NodeRef {
    if (index < 0n) {
      throw new RangeError('node index must be non-negative');
    }
    return new NodeRef(this.#identity, index, role);
  }

  /** Creates a snapshot-bound span after range validation (lib.rs). */
  span(startByte: number, endByte: number): Span {
    if (startByte > endByte) {
      throw new LocationError('InvertedSpan');
    }
    return new Span(this.#identity, startByte, endByte);
  }

  /** Verifies that a node handle belongs to this snapshot (lib.rs). */
  verify(node: NodeRef): void {
    if (!node.snapshot().equals(this.#identity)) {
      throw new LocationError('WrongSnapshot');
    }
  }

  /** Resolves an index only for the authority that issued the handle (lib.rs). */
  resolveIndex(node: NodeRef): bigint {
    this.verify(node);
    return node.index();
  }
}

/**
 * Semantic role of a document structural identity — the complete frozen
 * set (lib.rs). The per-family roles are pinned here exactly once;
 * later family milestones consume these spellings.
 */
export type NodeRole =
  // Generic roles.
  | 'SyntaxNode'
  | 'Token'
  | 'ObjectMember'
  | 'ObjectKey'
  | 'ArrayElement'
  | 'Value'
  | 'TomlItem'
  | 'TomlEntry'
  | 'TomlKey'
  | 'TomlArrayElement'
  | 'BinaryRegion'
  | 'JsonSyntaxPiece'
  | 'TomlSyntaxPiece'
  // YAML (lib.rs).
  | 'YamlStream'
  | 'YamlDocument'
  | 'YamlNode'
  | 'YamlSequenceElement'
  | 'YamlMappingEntry'
  | 'YamlAlias'
  | 'YamlAnchorDefinition'
  | 'YamlSyntaxPiece'
  // INI (lib.rs).
  | 'IniDocument'
  | 'IniPhysicalLine'
  | 'IniLogicalLine'
  | 'IniSection'
  | 'IniDefaultSection'
  | 'IniEntry'
  | 'IniErrorLine'
  | 'IniSyntaxPiece'
  // Java Properties (lib.rs).
  | 'PropertiesDocument'
  | 'PropertiesNaturalLine'
  | 'PropertiesLogicalLine'
  | 'PropertiesProperty'
  | 'PropertiesComment'
  | 'PropertiesEscape'
  | 'PropertiesErrorLine'
  | 'PropertiesSyntaxPiece'
  // XML (lib.rs).
  | 'XmlDocument'
  | 'XmlDeclaration'
  | 'XmlDoctype'
  | 'XmlElement'
  | 'XmlAttribute'
  | 'XmlNamespaceBinding'
  | 'XmlText'
  | 'XmlCdata'
  | 'XmlComment'
  | 'XmlProcessingInstruction'
  | 'XmlEntityReference'
  | 'XmlErrorRegion'
  | 'XmlSyntaxPiece'
  // plist (lib.rs, RFC 0013 §8.1/§8.2).
  | 'PlistDocument'
  | 'PlistDictEntry'
  | 'PlistKey'
  | 'PlistArrayElement'
  | 'PlistValue'
  | 'PlistSyntaxPiece'
  // HCL (lib.rs, RFC 0014 §7.1/§7.2).
  | 'HclDocument'
  | 'HclBody'
  | 'HclAttribute'
  | 'HclBlock'
  | 'HclBlockLabel'
  | 'HclExpression'
  | 'HclTemplatePart'
  | 'HclErrorRegion'
  | 'HclSyntaxPiece';

/** Opaque handle to one structural identity in exactly one snapshot (lib.rs). */
export class NodeRef {
  readonly #snapshot: SnapshotIdentity;
  readonly #index: bigint;
  readonly #role: NodeRole;

  constructor(snapshot: SnapshotIdentity, index: bigint, role: NodeRole) {
    this.#snapshot = snapshot;
    this.#index = index;
    this.#role = role;
  }

  /** Owning snapshot (lib.rs). */
  snapshot(): SnapshotIdentity {
    return this.#snapshot;
  }

  /** Structural role (lib.rs). */
  role(): NodeRole {
    return this.#role;
  }

  /** Process-local ordinal within the owning snapshot (lib.rs). */
  index(): bigint {
    return this.#index;
  }

  equals(other: NodeRef): boolean {
    return (
      this.#snapshot.equals(other.#snapshot) &&
      this.#index === other.#index &&
      this.#role === other.#role
    );
  }
}

/** Placement of a new association relative to one container or exact anchor (lib.rs). */
export type AssociationPlacement =
  | { readonly kind: 'Start' }
  | { readonly kind: 'End' }
  | { readonly kind: 'Before'; readonly anchor: NodeRef }
  | { readonly kind: 'After'; readonly anchor: NodeRef };

/** Half-open byte range bound to one snapshot (lib.rs). */
export class Span {
  readonly #snapshot: SnapshotIdentity;
  readonly #startByte: number;
  readonly #endByte: number;

  constructor(snapshot: SnapshotIdentity, startByte: number, endByte: number) {
    this.#snapshot = snapshot;
    this.#startByte = startByte;
    this.#endByte = endByte;
  }

  /** Owning snapshot (lib.rs). */
  snapshot(): SnapshotIdentity {
    return this.#snapshot;
  }

  /** Inclusive start byte (lib.rs). */
  startByte(): number {
    return this.#startByte;
  }

  /** Exclusive end byte (lib.rs). */
  endByte(): number {
    return this.#endByte;
  }

  /** Byte length (lib.rs). */
  len(): number {
    return this.#endByte - this.#startByte;
  }

  /** Whether the range is an insertion point (lib.rs). */
  isEmpty(): boolean {
    return this.#startByte === this.#endByte;
  }

  /** Common diagnostic representation (lib.rs). */
  diagnosticLocation() {
    return {
      snapshot: this.#snapshot.asBigInt(),
      startByte: BigInt(this.#startByte),
      endByte: BigInt(this.#endByte),
    };
  }

  equals(other: Span): boolean {
    return (
      this.#snapshot.equals(other.#snapshot) &&
      this.#startByte === other.#startByte &&
      this.#endByte === other.#endByte
    );
  }
}
