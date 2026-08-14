/**
 * Typed Java Properties-family failures with frozen registered codes.
 *
 * authority (frozen codes — the EXACT registry spellings, do not guess):
 *  - ErrorCodeRegistry v7: consema-rs/consema-protocol/src/error_registry.rs
 *    java-properties.edit.canonical-fallback@1             :1099 (Edit, 0.8.0)
 *    java-properties.edit.invalid-placement@1              :1105 (Edit, 0.8.0)
 *    java-properties.java-string.invalid-wire@1            :1111 (Encoding, 0.8.0)
 *    java-properties.java-string.non-canonical-wire@1      :1117 (Encoding, 0.8.0)
 *    java-properties.materialization.round-trip-mismatch@1 :1123 (Materialization, 0.8.0)
 *    java-properties.parse.malformed-unicode-escape@1      :1129 (Syntax, 0.8.0)
 *    java-properties.profile.mismatch@1                    :1135 (Conformance, 0.8.0)
 *    java-properties.projection.duplicate-collapsed@1      :1141 (Projection, 0.8.0)
 *    java-properties.projection.incomplete-document@1      :1147 (Projection, 0.8.0)
 *    java-properties.projection.unpaired-surrogate@1       :1153 (Projection, 0.8.0)
 *    java-properties.query.invalid-code-unit-filter@1      :1159 (Query, 0.8.0)
 *    java-properties.source.profile-encoding@1             :1165 (Encoding, 0.8.0)
 *  - kind→code mapping authority: consema-rs/consema-properties/src/
 *    projection.rs (ProjectionFailure), edit.rs
 *    (EditFailure::diagnostic_code), parser.rs (profile failure),
 *    parser.rs (malformed Unicode escape)
 *  - FatalFormationFailure: consema-rs/consema-document/src/lib.rs
 *    (from_diagnostic :649-654, invalid_utf8 :657-672, source_error
 *    (exact-wire 定义); common codes in consema-rs/consema-protocol/src/error_registry.rs
 *    39 (core.parse.resource-limit@1), 207/366/372/399/405 (core.source.*@1)
 *  - QueryExecutionFailure: consema-rs/consema-core/src/query.rs
 *    (ResourceLimitExceeded :3166, Cancelled :3168, CardinalityViolation
 *    :3159-3164; codes :3206-3219) and the Properties executor domain gate
 *    consema-rs/consema-properties/src/query.rs
 *    (DomainMismatch)
 *
 * Design (TypeScript-idiomatic): every kind is a closed string-literal
 * union; `code` is a frozen property of every error instance so the
 * RFC 0016 §6 `Code()` contract holds without a separate method. Message
 * text is human presentation only and never participates in conformance
 * comparison (RFC 0016 §1.1).
 */

import type { Diagnostic } from '../document/diagnostic.ts';
import type { NodeRef } from '../document/identity.ts';
import { SourceError } from '../document/errors.ts';

// ---------------------------------------------------------------------------
// PropertiesAccessError — typed access failure on one immutable snapshot
// ---------------------------------------------------------------------------

/** Stable typed Properties access failure (lib.rs); no registered codes. */
export type PropertiesAccessErrorKind = 'WrongSnapshot' | 'WrongRole' | 'UnknownNode';

export class PropertiesAccessError extends Error {
  readonly kind: PropertiesAccessErrorKind;
  /** No registered error code exists for access failures. */
  readonly code: undefined = undefined;

  constructor(kind: PropertiesAccessErrorKind) {
    super(`properties access: ${kind}`);
    this.name = 'PropertiesAccessError';
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// FatalFormationFailure — parse aborted before a document exists
// ---------------------------------------------------------------------------

/** Fatal parse failure: no Document exists (lib.rs). */
export class FatalFormationFailure extends Error {
  readonly #diagnostics: readonly Diagnostic[];

  private constructor(diagnostics: readonly Diagnostic[]) {
    super('java-properties formation failed');
    this.name = 'FatalFormationFailure';
    this.#diagnostics = Object.freeze([...diagnostics]);
  }

  /** Creates a fatal formation failure from one format-specific diagnostic (lib.rs). */
  static fromDiagnostic(diagnostic: Diagnostic): FatalFormationFailure {
    return new FatalFormationFailure([diagnostic]);
  }

  /** Invalid UTF-8 source (lib.rs; code at error_registry.rs). */
  static invalidUtf8(validUpTo: number): FatalFormationFailure {
    return new FatalFormationFailure([
      {
        code: 'core.source.invalid-utf8@1',
        category: 'Lexical',
        severity: 'Error',
        primary: {
          snapshot: null,
          startByte: BigInt(validUpTo),
          endByte: BigInt(validUpTo),
        },
        related: [],
        arguments: new Map(),
        notes: [],
        occurrence: 0n,
      },
    ]);
  }

  /** Converts a source-construction failure into one stable fatal diagnostic (lib.rs). */
  static sourceError(error: SourceError): FatalFormationFailure {
    if (error.kind === 'InvalidUtf8') {
      return FatalFormationFailure.invalidUtf8(error.validUpTo ?? 0);
    }
    const code =
      error.kind === 'InvalidSequence'
        ? 'core.source.invalid-sequence@1'
        : error.kind === 'EncodingConflict'
          ? 'core.source.encoding-conflict@1'
          : error.kind === 'UnsupportedBom'
            ? 'core.source.unsupported-bom@1'
            : 'core.source.resource-limit@1';
    const category =
      error.kind === 'InvalidSequence'
        ? 'Lexical'
        : error.kind === 'EncodingConflict' || error.kind === 'UnsupportedBom'
          ? 'Encoding'
          : 'Resource';
    const arguments_ = new Map<string, string>();
    if (error.kind === 'InvalidSequence' && error.encoding !== undefined) {
      arguments_.set('encoding', error.encoding);
    }
    if (error.kind === 'EncodingConflict') {
      if (error.bom !== undefined) arguments_.set('bom', error.bom);
      if (error.declaration !== undefined) arguments_.set('declaration', error.declaration);
      if (error.callerOverride !== undefined) arguments_.set('caller_override', error.callerOverride);
    }
    if (error.kind === 'UnsupportedBom' && error.unsupportedBom !== undefined) {
      arguments_.set('bom', error.unsupportedBom);
    }
    if (error.kind === 'ResourceLimit') {
      if (error.limitName !== undefined) arguments_.set('name', error.limitName);
      if (error.observed !== undefined) arguments_.set('observed', String(error.observed));
      if (error.limit !== undefined) arguments_.set('limit', String(error.limit));
    }
    return new FatalFormationFailure([
      {
        code,
        category,
        severity: 'Error',
        primary:
          error.kind === 'InvalidSequence' && error.byteOffset !== undefined
            ? { snapshot: null, startByte: BigInt(error.byteOffset), endByte: BigInt(error.byteOffset) }
            : null,
        related: [],
        arguments: arguments_,
        notes: [],
        occurrence: 0n,
      },
    ]);
  }

  /** Creates a fatal resource-limit failure (parser.rs). */
  static resourceLimit(name: string, observed: number, limit: number): FatalFormationFailure {
    return FatalFormationFailure.fromDiagnostic({
      code: 'core.parse.resource-limit@1',
      category: 'Resource',
      severity: 'Error',
      primary: null,
      related: [],
      arguments: new Map([
        ['name', name],
        ['observed', String(observed)],
        ['limit', String(limit)],
      ]),
      notes: [],
      occurrence: 0n,
    });
  }

  /** Ordered fatal diagnostics (lib.rs). */
  diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics;
  }
}

// ---------------------------------------------------------------------------
// QueryExecutionFailure — stable query execution failure
// ---------------------------------------------------------------------------

/** Stable query execution failure class (query.rs; query.rs). */
export type QueryExecutionFailureKind =
  | 'DomainMismatch'
  | 'ResourceLimitExceeded'
  | 'Cancelled'
  | 'CardinalityViolation'
  | 'TargetUnavailable';

export class QueryExecutionFailure extends Error {
  readonly kind: QueryExecutionFailureKind;
  /** Frozen registered code (query.rs). */
  readonly code: string;
  /** DomainMismatch: the rejected domain. */
  readonly domain?: { readonly id: string; readonly version: number };
  /** CardinalityViolation: the selection and observed count. */
  readonly selection?: string;
  readonly actual?: number;

  constructor(
    kind: QueryExecutionFailureKind,
    options: {
      domain?: { readonly id: string; readonly version: number };
      selection?: string;
      actual?: number;
    } = {},
  ) {
    super(`java-properties query: ${kind}`);
    this.name = 'QueryExecutionFailure';
    this.kind = kind;
    this.code = queryExecutionFailureCode(kind);
    if (options.domain !== undefined) this.domain = options.domain;
    if (options.selection !== undefined) this.selection = options.selection;
    if (options.actual !== undefined) this.actual = options.actual;
  }
}

/** Kind→code mapping (query.rs; the Properties executor's DomainMismatch maps the same code). */
export function queryExecutionFailureCode(kind: QueryExecutionFailureKind): string {
  switch (kind) {
    case 'DomainMismatch':
      return 'core.query.domain-mismatch@1';
    case 'ResourceLimitExceeded':
      return 'core.query.resource-limit@1';
    case 'Cancelled':
      return 'core.query.cancelled@1';
    case 'CardinalityViolation':
      return 'core.query.cardinality-violation@1';
    case 'TargetUnavailable':
      return 'core.query.target-unavailable@1';
  }
}

// ---------------------------------------------------------------------------
// ProjectionFailure — stable projection failure category
// ---------------------------------------------------------------------------

/** Stable projection failure category (projection.rs); codes at projection.rs. */
export type ProjectionFailureKind =
  | 'RecoveredDocument'
  | 'UnpairedSurrogate'
  | 'DuplicateKey'
  | 'ResourceLimit'
  | 'CoreInvariant';

export class ProjectionFailure extends Error {
  readonly kind: ProjectionFailureKind;
  /** Frozen registered code (projection.rs). */
  readonly code: string;
  /** UnpairedSurrogate / DuplicateKey: the involved property identity. */
  readonly property?: NodeRef;
  /** UnpairedSurrogate: whether the unpaired content belongs to the key. */
  readonly inKey?: boolean;
  /** DuplicateKey: the retained property identity. */
  readonly retained?: NodeRef;
  /** DuplicateKey: the duplicate property identity. */
  readonly duplicate?: NodeRef;
  /** ResourceLimit: the stable limit name (projection.rs). */
  readonly limitName?: string;

  constructor(
    kind: ProjectionFailureKind,
    options: {
      property?: NodeRef;
      inKey?: boolean;
      retained?: NodeRef;
      duplicate?: NodeRef;
      limitName?: string;
    } = {},
  ) {
    super(`java-properties projection: ${kind}`);
    this.name = 'ProjectionFailure';
    this.kind = kind;
    this.code = projectionFailureCode(kind);
    if (options.property !== undefined) this.property = options.property;
    if (options.inKey !== undefined) this.inKey = options.inKey;
    if (options.retained !== undefined) this.retained = options.retained;
    if (options.duplicate !== undefined) this.duplicate = options.duplicate;
    if (options.limitName !== undefined) this.limitName = options.limitName;
  }
}

/** Kind→code mapping (projection.rs). */
export function projectionFailureCode(kind: ProjectionFailureKind): string {
  switch (kind) {
    case 'RecoveredDocument':
      return 'java-properties.projection.incomplete-document@1';
    case 'UnpairedSurrogate':
      return 'java-properties.projection.unpaired-surrogate@1';
    case 'DuplicateKey':
    case 'CoreInvariant':
      return 'core.projection.target-not-applicable@1';
    case 'ResourceLimit':
      return 'core.projection.resource-limit@1';
  }
}

// ---------------------------------------------------------------------------
// EditFailure — stable edit validation or commit failure
// ---------------------------------------------------------------------------

/** Stable edit validation or commit failure (edit.rs); codes at edit.rs. */
export type EditFailureKind =
  | 'RecoveredDocument'
  | 'WrongSnapshot'
  | 'WrongRole'
  | 'DuplicateTarget'
  | 'OverlappingOwnership'
  | 'InvalidPlacement'
  | 'PlacementAnchorRemoved'
  | 'TargetNotFound'
  | 'EncodingUnrepresentable'
  | 'InvalidLiteral'
  | 'ResourceLimit'
  | 'NewDocumentFormationFailed';

export class EditFailure extends Error {
  readonly kind: EditFailureKind;
  /** Frozen registered code (edit.rs). */
  readonly code: string;
  /** ResourceLimit: the stable limit name (edit.rs). */
  readonly limitName?: string;

  constructor(kind: EditFailureKind, options: { limitName?: string } = {}) {
    super(`java-properties edit: ${kind}`);
    this.name = 'EditFailure';
    this.kind = kind;
    this.code = editFailureCode(kind);
    if (options.limitName !== undefined) this.limitName = options.limitName;
  }
}

/** Kind→code mapping (edit.rs). */
export function editFailureCode(kind: EditFailureKind): string {
  switch (kind) {
    case 'RecoveredDocument':
      return 'core.edit.incomplete-target@1';
    case 'WrongSnapshot':
      return 'core.edit.wrong-snapshot@1';
    case 'WrongRole':
      return 'core.edit.wrong-role@1';
    case 'DuplicateTarget':
    case 'OverlappingOwnership':
    case 'PlacementAnchorRemoved':
      return 'core.edit.conflicting-edits@1';
    case 'InvalidPlacement':
      return 'java-properties.edit.invalid-placement@1';
    case 'TargetNotFound':
      return 'core.edit.target-not-found@1';
    case 'EncodingUnrepresentable':
      return 'core.edit.representation-incompatible@1';
    case 'InvalidLiteral':
      return 'core.edit.invalid-literal@1';
    case 'ResourceLimit':
      return 'core.edit.resource-limit@1';
    case 'NewDocumentFormationFailed':
      return 'core.edit.formation-failed@1';
  }
}
