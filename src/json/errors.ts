/**
 * Typed JSON-family failures with frozen registered codes.
 *
 * authority (frozen codes — the EXACT registry spellings, do not guess):
 *  - ErrorCodeRegistry v7: crates/consema-protocol/src/error_registry.rs
 *    json.edit.representation-fallback@1         :213 (Edit, 0.1.0)
 *    json.object.duplicate-member@1              :219 (Semantic, 0.1.0)
 *    json.projection.duplicate-keys@1            :225 (Projection, 0.1.0)
 *    json.projection.semantic-unavailable@1      :231 (Projection, 0.1.0)
 *    json.strict.comment-not-allowed@1           :237 (Conformance, 0.1.0)
 *    json.strict.leading-bom@1                   :243 (Conformance, 0.1.0)
 *    json.strict.trailing-comma@1                :249 (Conformance, 0.1.0)
 *    json.syntax.expected-object-key@1           :255 (Syntax, 0.1.0)
 *    json.syntax.expected-value@1                :261 (Syntax, 0.1.0)
 *    json.syntax.invalid-number@1                :267 (Syntax, 0.1.0)
 *    json.syntax.invalid-string-escape@1         :273 (Syntax, 0.1.0)
 *    json.syntax.missing-array-close@1           :279 (Syntax, 0.1.0)
 *    json.syntax.missing-colon@1                 :285 (Syntax, 0.1.0)
 *    json.syntax.missing-comma@1                 :291 (Syntax, 0.1.0)
 *    json.syntax.missing-object-close@1          :297 (Syntax, 0.1.0)
 *    json.syntax.missing-value@1                 :303 (Syntax, 0.1.0)
 *    json.syntax.trailing-content@1              :309 (Syntax, 0.1.0)
 *    json.syntax.unexpected-character@1          :315 (Syntax, 0.1.0)
 *    json.syntax.unexpected-word@1               :321 (Syntax, 0.1.0)
 *    json.syntax.unterminated-block-comment@1    :327 (Syntax, 0.1.0)
 *    json.syntax.unterminated-string@1           :333 (Syntax, 0.1.0)
 *    json.projection.structure-reencoded@1       :610 (Projection, 0.5.0)
 *    json5.string.unescaped-line-separator@1     :649 (Conformance, 0.6.0)
 *    json5.syntax.invalid-identifier@1           :655 (Syntax, 0.6.0)
 *    json.projection.incomplete-document@1       :1332 (Projection, 0.13.0)
 *  - kind→code mapping authority: crates/consema-json/src/projection.rs:
 *    754-765 (ProjectionFailure), crates/consema-json/src/edit.rs:1299-1323
 *    (EditFailure)
 *  - FatalFormationFailure: crates/consema-document/src/lib.rs:643-761
 *    (from_diagnostic :649-654, invalid_utf8 :657-672, source_error
 *    :675-761); the parse limit names "source-bytes" | "token-count" |
 *    "nesting-depth" | "node-count" (parser.rs:78-83, 389-395, 831-837,
 *    1178-1189)
 *  - QueryExecutionFailure: crates/consema-core/src/query.rs:3114-3219
 *    (ResourceLimitExceeded :3166, Cancelled :3168, CardinalityViolation
 *    :3159-3164; codes :3206-3219) and the JSON executor domain gate
 *    crates/consema-json/src/query.rs:96-105 (DomainMismatch)
 *
 * Design (TypeScript-idiomatic): every kind is a closed string-literal
 * union; `code` is a frozen property of every error instance so the
 * RFC 0016 §6 `Code()` contract holds without a separate method. Message
 * text is human presentation only and never participates in conformance
 * comparison (RFC 0016 §1.1).
 */

import type { Diagnostic } from '../document/diagnostic.ts';
import { NodeRef } from '../document/identity.ts';
import { SourceError } from '../document/errors.ts';
import type { Kind } from '../core/value.ts';
import type { SemanticUnavailable } from './semantic.ts';

// ---------------------------------------------------------------------------
// JsonAccessError — typed access failure on one immutable snapshot
// ---------------------------------------------------------------------------

/** Stable typed JSON access failure (lib.rs:612-621); no registered codes. */
export type JsonAccessErrorKind = 'WrongSnapshot' | 'WrongRole' | 'UnknownNode';

export class JsonAccessError extends Error {
  readonly kind: JsonAccessErrorKind;
  /** No registered error code exists for access failures. */
  readonly code: undefined = undefined;

  constructor(kind: JsonAccessErrorKind) {
    super(`json access: ${kind}`);
    this.name = 'JsonAccessError';
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// FatalFormationFailure — parse aborted before a document exists
// ---------------------------------------------------------------------------

/** Fatal parse failure: no Document exists (lib.rs:643-645). */
export class FatalFormationFailure extends Error {
  readonly #diagnostics: readonly Diagnostic[];

  private constructor(diagnostics: readonly Diagnostic[]) {
    super('json formation failed');
    this.name = 'FatalFormationFailure';
    this.#diagnostics = Object.freeze([...diagnostics]);
  }

  /** Creates a fatal formation failure from one format-specific diagnostic (lib.rs:649-654). */
  static fromDiagnostic(diagnostic: Diagnostic): FatalFormationFailure {
    return new FatalFormationFailure([diagnostic]);
  }

  /** Invalid UTF-8 source (lib.rs:657-672; code at error_registry.rs:207). */
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

  /** Converts a source-construction failure into one stable fatal diagnostic (lib.rs:675-761). */
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

  /** Creates a fatal resource-limit failure (parser.rs:78-83, 389-395, 831-837, 1178-1189). */
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

  /** Ordered fatal diagnostics (lib.rs:644-645). */
  diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics;
  }
}

// ---------------------------------------------------------------------------
// QueryExecutionFailure — stable query execution failure
// ---------------------------------------------------------------------------

/** Stable query execution failure class (query.rs:3114-3219; query.rs:96-105). */
export type QueryExecutionFailureKind =
  | 'DomainMismatch'
  | 'ResourceLimitExceeded'
  | 'Cancelled'
  | 'CardinalityViolation'
  | 'TargetUnavailable';

export class QueryExecutionFailure extends Error {
  readonly kind: QueryExecutionFailureKind;
  /** Frozen registered code (query.rs:3206-3219). */
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
    super(`json query: ${kind}`);
    this.name = 'QueryExecutionFailure';
    this.kind = kind;
    this.code = queryExecutionFailureCode(kind);
    if (options.domain !== undefined) this.domain = options.domain;
    if (options.selection !== undefined) this.selection = options.selection;
    if (options.actual !== undefined) this.actual = options.actual;
  }
}

/** Kind→code mapping (query.rs:3206-3219; the json executor's DomainMismatch maps the same code). */
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

/** Stable projection failure category (projection.rs:326-355); codes at projection.rs:754-765. */
export type ProjectionFailureKind =
  | 'RecoveredDocument'
  | 'ConflictingPolicyRules'
  | 'WrongSnapshotPolicy'
  | 'InvalidPolicyTarget'
  | 'TargetNotApplicable'
  | 'DuplicateKeys'
  | 'SemanticUnavailable'
  | 'ResourceLimit';

export class ProjectionFailure extends Error {
  readonly kind: ProjectionFailureKind;
  /** Frozen registered code (projection.rs:754-765). */
  readonly code: string;
  /** DuplicateKeys / SemanticUnavailable / InvalidPolicyTarget: the source identity. */
  readonly node?: NodeRef;
  /** SemanticUnavailable: the stable reason (projection.rs:346-352). */
  readonly reason?: SemanticUnavailable;
  /** ResourceLimit: the stable limit name (projection.rs:353-355). */
  readonly limitName?: string;

  constructor(
    kind: ProjectionFailureKind,
    options: { node?: NodeRef; name?: string; reason?: SemanticUnavailable; limitName?: string } = {},
  ) {
    super(`projection: ${kind}`);
    this.name = 'ProjectionFailure';
    this.kind = kind;
    this.code = projectionFailureCode(kind);
    if (options.node !== undefined) this.node = options.node;
    if (options.name !== undefined) this.name = options.name;
    if (options.reason !== undefined) this.reason = options.reason;
    if (options.limitName !== undefined) this.limitName = options.limitName;
  }
}

/** Kind→code mapping (projection.rs:754-765). */
export function projectionFailureCode(kind: ProjectionFailureKind): string {
  switch (kind) {
    case 'RecoveredDocument':
      return 'json.projection.incomplete-document@1';
    case 'ConflictingPolicyRules':
      return 'core.projection.conflicting-policy@1';
    case 'WrongSnapshotPolicy':
      return 'core.projection.wrong-snapshot-policy@1';
    case 'InvalidPolicyTarget':
      return 'core.projection.invalid-policy-target@1';
    case 'TargetNotApplicable':
      return 'core.projection.target-not-applicable@1';
    case 'DuplicateKeys':
      return 'json.projection.duplicate-keys@1';
    case 'SemanticUnavailable':
      return 'json.projection.semantic-unavailable@1';
    case 'ResourceLimit':
      return 'core.projection.resource-limit@1';
  }
}

// ---------------------------------------------------------------------------
// EditFailure — stable edit validation or commit failure
// ---------------------------------------------------------------------------

/** Stable edit validation or commit failure (edit.rs:259-299); codes at edit.rs:1299-1323. */
export type EditFailureKind =
  | 'RecoveredDocument'
  | 'WrongSnapshot'
  | 'WrongRole'
  | 'IncompleteTarget'
  | 'SemanticUnavailable'
  | 'UnsupportedSemanticValue'
  | 'InvalidLiteral'
  | 'RepresentationIncompatible'
  | 'ExactLiteralRequiresLiteralOperation'
  | 'ConflictingEdits'
  | 'DuplicateTarget'
  | 'OverlappingOwnership'
  | 'AncestorDescendantConflict'
  | 'PlacementAnchorRemoved'
  | 'PlacementAnchorModified'
  | 'TargetNotFound'
  | 'UnrepresentableValue'
  | 'ResourceLimit'
  | 'NewDocumentFormationFailed';

export class EditFailure extends Error {
  readonly kind: EditFailureKind;
  /** Frozen registered code (edit.rs:1299-1323). */
  readonly code: string;
  /** UnsupportedSemanticValue / UnrepresentableValue: the rejected core kind (edit.rs:272, 294). */
  readonly valueKind?: Kind;
  /** ResourceLimit: the stable limit name (edit.rs:296). */
  readonly limitName?: string;

  constructor(
    kind: EditFailureKind,
    options: { valueKind?: Kind; limitName?: string } = {},
  ) {
    super(`edit: ${kind}`);
    this.name = 'EditFailure';
    this.kind = kind;
    this.code = editFailureCode(kind);
    if (options.valueKind !== undefined) this.valueKind = options.valueKind;
    if (options.limitName !== undefined) this.limitName = options.limitName;
  }
}

/** Kind→code mapping (edit.rs:1299-1323). */
export function editFailureCode(kind: EditFailureKind): string {
  switch (kind) {
    case 'RecoveredDocument':
    case 'IncompleteTarget':
      return 'core.edit.incomplete-target@1';
    case 'WrongSnapshot':
      return 'core.edit.wrong-snapshot@1';
    case 'WrongRole':
      return 'core.edit.wrong-role@1';
    case 'SemanticUnavailable':
      return 'core.edit.semantic-unavailable@1';
    case 'UnsupportedSemanticValue':
    case 'UnrepresentableValue':
      return 'core.edit.unsupported-value@1';
    case 'InvalidLiteral':
      return 'core.edit.invalid-literal@1';
    case 'RepresentationIncompatible':
      return 'core.edit.representation-incompatible@1';
    case 'ExactLiteralRequiresLiteralOperation':
      return 'core.edit.exact-literal-requires-literal@1';
    case 'ConflictingEdits':
    case 'DuplicateTarget':
    case 'OverlappingOwnership':
    case 'AncestorDescendantConflict':
    case 'PlacementAnchorRemoved':
    case 'PlacementAnchorModified':
      return 'core.edit.conflicting-edits@1';
    case 'TargetNotFound':
      return 'core.edit.target-not-found@1';
    case 'ResourceLimit':
      return 'core.edit.resource-limit@1';
    case 'NewDocumentFormationFailed':
      return 'core.edit.formation-failed@1';
  }
}
