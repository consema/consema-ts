/**
 * Typed plist-family failures with frozen registered codes.
 *
 * authority (frozen codes — the EXACT registry spellings, do not guess):
 *  - RFC 0013 §12 (:738-752): `plist.parse.*@1` covers XML grammar
 *    diagnostics, `plist.binary.*@1` covers binary structure integrity,
 *    and `plist.limit.*@1` covers resource limits. The `plist.*` codes do
 *    NOT enter the consema-protocol core error registry (RFC 0013 §12),
 *    so their authoritative spellings are the RFC plus the emitting
 *    crates/consema-plist sources:
 *  - parser_xml.rs code spellings: plist.xml.encoding@1 :454,
 *    plist.parse.declaration-version@1 :823, plist.parse.declaration-
 *    conflict@1 :856, plist.parse.pi-target@1 :936, plist.parse.doctype-
 *    subset@1 :1014, plist.parse.doctype@1 :1079, plist.parse.dict-
 *    missing-value@1 :1163/1593/1614, plist.parse.key-outside-dict@1
 *    :1172, plist.parse.dict-key@1 :1192, plist.parse.scalar-content@1
 *    :1209, plist.parse.element-name@1 :1221, plist.parse.root-version@1
 *    :1303/1389/1435, plist.parse.root-attribute@1 :1318, plist.parse.
 *    element-attribute@1 :1320, plist.parse.mismatched-end-tag@1 :1458,
 *    plist.parse.extra-end-tag@1 :1482, plist.parse.empty-value@1 :1656,
 *    plist.parse.integer@1 :1667, plist.parse.real@1 :1692, plist.parse.
 *    date@1 :1720, plist.parse.data@1 :1757, plist.parse.text-outside-
 *    value@1 :1808, plist.parse.boolean-content@1 :1826, plist.parse.
 *    reference@1 :1960, plist.parse.entity@1 :2052, plist.parse.well-
 *    formedness@1 :2141, plist.parse.unclosed-element@1 :2158, plist.parse.
 *    missing-root@1 :2178, plist.parse.root-value-count@1 :2188/2210,
 *    plist.xml.overflow@1 :2777, plist.xml.internal@1 :2787, plist.xml.
 *    coverage@1 :2798, plist.xml.coordinates@1 :2808, plist.limit.*@1
 *    :4146-4300
 *  - parser_binary.rs code spellings: plist.binary.minimum-size@1 :531,
 *    plist.binary.header@1 :548, plist.binary.unproven-top-object@1 :620,
 *    plist.binary.unproven-reference@1 :634, plist.binary.cycle@1 :660,
 *    plist.binary.coverage@1 :753, plist.binary.trailer@1 :785-906,
 *    plist.binary.offset-table@1 :942-1022, plist.binary.marker@1 :1110,
 *    plist.binary.extent@1 :1137, plist.binary.string@1 :1156,
 *    plist.binary.date@1 :1170, plist.binary.uid@1 :1181, plist.binary.
 *    reference@1 :1218, plist.binary.extended-size@1 :1296, plist.binary.
 *    non-string-key@1 :1342, plist.binary.overflow@1 :1604, plist.binary.
 *    internal@1 :1614, plist.binary.encoding@1 (lib.rs:251),
 *    plist.limit.*@1 :2897-3062
 *  - projection codes: crates/consema-plist/src/projection.rs:393-402
 *    (incomplete-document, unpaired-surrogate, collision,
 *    unrepresentable, resource-limit, core-invariant)
 *  - edit codes: crates/consema-plist/src/edit.rs:442-454 (uid-in-xml,
 *    unrepresentable, and the shared core.edit.* codes)
 *  - materialization: the shared MaterializationFailure mapping
 *    crates/consema-plist/src/materialization.rs:78-94 (fractional-date,
 *    unrepresentable, resource-limit; core.materialization.* for the
 *    shared codes), code spelling :149
 *  - query execution: crates/consema-core/src/query.rs:3206-3219
 *    (core.query.*); DomainMismatch precedent json/errors.ts
 *
 * Design (TypeScript-idiomatic): every kind is a closed string-literal
 * union; `code` is a frozen property of every error instance so the
 * RFC 0016 §6 `Code()` contract holds without a separate method. Message
 * text is human presentation only and never participates in conformance
 * comparison.
 */

import type { Diagnostic } from '../document/diagnostic.ts';
import { SourceError } from '../document/errors.ts';

// ---------------------------------------------------------------------------
// PlistAccessError — typed access failure on one immutable snapshot
// ---------------------------------------------------------------------------

/** Stable typed plist access failure (document.rs:181-185 precedent). */
export type PlistAccessErrorKind = 'WrongSnapshot' | 'WrongRole' | 'UnknownNode';

export class PlistAccessError extends Error {
  readonly kind: PlistAccessErrorKind;
  /** No registered error code exists for access failures. */
  readonly code: undefined = undefined;

  constructor(kind: PlistAccessErrorKind) {
    super(`plist access: ${kind}`);
    this.name = 'PlistAccessError';
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// FatalFormationFailure — parse aborted before a document exists
// ---------------------------------------------------------------------------

/** Fatal parse failure: no Document exists (RFC 0013 §3). */
export class FatalFormationFailure extends Error {
  readonly #diagnostics: readonly Diagnostic[];

  private constructor(diagnostics: readonly Diagnostic[]) {
    super('plist formation failed');
    this.name = 'FatalFormationFailure';
    this.#diagnostics = Object.freeze([...diagnostics]);
  }

  /** Creates a fatal formation failure from one format-specific diagnostic (lib.rs:643-654 precedent). */
  static fromDiagnostic(diagnostic: Diagnostic): FatalFormationFailure {
    return new FatalFormationFailure([diagnostic]);
  }

  /** Converts a source-construction failure into one stable fatal diagnostic (json/errors.ts precedent). */
  static sourceError(error: SourceError): FatalFormationFailure {
    if (error.kind === 'InvalidUtf8') {
      return FatalFormationFailure.fromDiagnostic({
        code: 'core.source.invalid-utf8@1',
        category: 'Lexical',
        severity: 'Error',
        primary: {
          snapshot: null,
          startByte: BigInt(error.validUpTo ?? 0),
          endByte: BigInt(error.validUpTo ?? 0),
        },
        related: [],
        arguments: new Map(),
        notes: [],
        occurrence: 0n,
      });
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

  /** Fatal `plist.limit.<name>@1` resource-limit failure (parser_binary.rs:1648-1664). */
  static resourceLimit(name: string, observed: number, limit: number): FatalFormationFailure {
    return FatalFormationFailure.fromDiagnostic({
      code: `plist.limit.${name}@1`,
      category: 'Resource',
      severity: 'Error',
      primary: null,
      related: [],
      arguments: new Map([
        ['limit', String(limit)],
        ['observed', String(observed)],
      ]),
      notes: [],
      occurrence: 0n,
    });
  }

  /** Ordered fatal diagnostics. */
  diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics;
  }
}

// ---------------------------------------------------------------------------
// QueryExecutionFailure — stable query execution failure
// ---------------------------------------------------------------------------

/** Stable query execution failure (query.rs:3114-3219; plist-family codes). */
export type QueryExecutionFailureKind =
  | 'DomainMismatch'
  | 'UnknownOperator'
  | 'WrongArgumentType'
  | 'InvalidArgument'
  | 'InvalidOperatorComposition'
  | 'MissingRequiredCapability'
  | 'RequiredTypeMismatch'
  | 'ResourceLimitExceeded'
  | 'Cancelled'
  | 'CardinalityViolation'
  | 'TargetUnavailable';

export class QueryExecutionFailure extends Error {
  readonly kind: QueryExecutionFailureKind;
  /** Frozen registered code (plist_v1.rs:1141-1153 mapping). */
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
    super(`plist query: ${kind}`);
    this.name = 'QueryExecutionFailure';
    this.kind = kind;
    this.code = queryExecutionFailureCode(kind);
    if (options.domain !== undefined) this.domain = options.domain;
    if (options.selection !== undefined) this.selection = options.selection;
    if (options.actual !== undefined) this.actual = options.actual;
  }
}

/**
 * Kind→code mapping — the plist-family spellings the conformance suite pins
 * (crates/consema-conformance/src/plist_v1.rs:1141-1153; the underlying
 * core codes are the query.rs:3206-3219 registry entries).
 */
export function queryExecutionFailureCode(kind: QueryExecutionFailureKind): string {
  switch (kind) {
    case 'DomainMismatch':
      return 'plist.query.domain-mismatch@1';
    case 'UnknownOperator':
      return 'plist.query.unknown-operator@1';
    case 'WrongArgumentType':
      return 'plist.query.wrong-argument-type@1';
    case 'InvalidArgument':
      return 'plist.query.invalid-argument@1';
    case 'InvalidOperatorComposition':
      return 'plist.query.invalid-composition@1';
    case 'MissingRequiredCapability':
      return 'plist.query.missing-capability@1';
    case 'RequiredTypeMismatch':
      return 'plist.query.type-mismatch@1';
    case 'ResourceLimitExceeded':
      return 'plist.query.resource-limit@1';
    case 'Cancelled':
      return 'plist.query.cancelled@1';
    case 'CardinalityViolation':
      return 'plist.query.cardinality-violation@1';
    case 'TargetUnavailable':
      return 'plist.query.target-unavailable@1';
  }
}

// ---------------------------------------------------------------------------
// ProjectionFailure — stable projection failure category
// ---------------------------------------------------------------------------

/** Stable projection failure kind (projection.rs:353-375); codes at projection.rs:393-402. */
export type ProjectionFailureKind =
  | 'IncompleteDocument'
  | 'UnpairedSurrogate'
  | 'Collision'
  | 'Unrepresentable'
  | 'ResourceLimit'
  | 'CoreInvariant';

export class ProjectionFailure extends Error {
  readonly kind: ProjectionFailureKind;
  /** Frozen registered code (projection.rs:393-402). */
  readonly code: string;
  /** Collision: the collided key. */
  readonly key?: string;
  /** Unrepresentable: the blocking native fact. */
  readonly reason?: string;
  /** ResourceLimit: the stable limit name. */
  readonly limitName?: string;

  constructor(
    kind: ProjectionFailureKind,
    options: { key?: string; reason?: string; limitName?: string } = {},
  ) {
    super(`projection: ${kind}`);
    this.name = 'ProjectionFailure';
    this.kind = kind;
    this.code = projectionFailureCode(kind);
    if (options.key !== undefined) this.key = options.key;
    if (options.reason !== undefined) this.reason = options.reason;
    if (options.limitName !== undefined) this.limitName = options.limitName;
  }
}

/** Kind→code mapping (projection.rs:393-402). */
export function projectionFailureCode(kind: ProjectionFailureKind): string {
  switch (kind) {
    case 'IncompleteDocument':
      return 'plist.projection.incomplete-document@1';
    case 'UnpairedSurrogate':
      return 'plist.projection.unpaired-surrogate@1';
    case 'Collision':
      return 'plist.projection.collision@1';
    case 'Unrepresentable':
      return 'plist.projection.unrepresentable@1';
    case 'ResourceLimit':
      return 'plist.projection.resource-limit@1';
    case 'CoreInvariant':
      return 'plist.projection.core-invariant@1';
  }
}

// ---------------------------------------------------------------------------
// EditFailure — stable edit validation or commit failure
// ---------------------------------------------------------------------------

/** Stable edit validation or commit failure kind (edit.rs:389-420); codes at edit.rs:442-454. */
export type EditFailureKind =
  | 'WrongSnapshot'
  | 'WrongRole'
  | 'TargetNotFound'
  | 'IncompleteTarget'
  | 'ConflictingEdits'
  | 'OverlappingOwnership'
  | 'UidInXml'
  | 'UnrepresentableValue'
  | 'ResourceLimit'
  | 'NewDocumentFormationFailed';

export class EditFailure extends Error {
  readonly kind: EditFailureKind;
  /** Frozen registered code (edit.rs:442-454). */
  readonly code: string;
  /** UnrepresentableValue: the blocking native fact. */
  readonly reason?: string;
  /** ResourceLimit: the stable limit name. */
  readonly limitName?: string;

  constructor(
    kind: EditFailureKind,
    options: { reason?: string; limitName?: string } = {},
  ) {
    super(`edit: ${kind}`);
    this.name = 'EditFailure';
    this.kind = kind;
    this.code = editFailureCode(kind);
    if (options.reason !== undefined) this.reason = options.reason;
    if (options.limitName !== undefined) this.limitName = options.limitName;
  }
}

/** Kind→code mapping (edit.rs:442-454). */
export function editFailureCode(kind: EditFailureKind): string {
  switch (kind) {
    case 'WrongSnapshot':
      return 'core.edit.wrong-snapshot@1';
    case 'WrongRole':
      return 'core.edit.wrong-role@1';
    case 'TargetNotFound':
      return 'core.edit.target-not-found@1';
    case 'IncompleteTarget':
      return 'core.edit.incomplete-target@1';
    case 'ConflictingEdits':
    case 'OverlappingOwnership':
      return 'core.edit.conflicting-edits@1';
    case 'UidInXml':
      return 'plist.edit.uid-in-xml@1';
    case 'UnrepresentableValue':
      return 'plist.edit.unrepresentable@1';
    case 'ResourceLimit':
      return 'core.edit.resource-limit@1';
    case 'NewDocumentFormationFailed':
      return 'core.edit.formation-failed@1';
  }
}
