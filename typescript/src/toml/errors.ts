/**
 * Typed TOML-family failures with frozen registered codes.
 *
 * authority (frozen codes — the EXACT registry spellings, do not guess;
 * ErrorCodeRegistry v7):
 *  - crates/consema-protocol/src/error_registry.rs
 *    toml.edit.representation-fallback@1              :339 (Edit, 0.2.0)
 *    toml.parse.syntax@1                              :345 (Syntax, 0.2.0)
 *    toml.projection.core-invariant@1                 :351 (Projection, 0.2.0)
 *    toml.projection.unrepresentable-datetime@1       :357 (Projection, 0.2.0)
 *  - the shared resource-limit code is registered once for all families:
 *    core.parse.resource-limit@1                      :39  (Resource, 0.1.0)
 *  - formation status spelling: the vectors compare the frozen enum NAME
 *    "FatalFormationFailure" (conformance/vectors/toml-v1.json:87 "status";
 *    crates/consema-document/src/lib.rs FatalFormationFailure)
 *  - resource-limit diagnostic shape: FatalFormationFailure::resource_limit
 *    (crates/consema-document/src/lib.rs:771-791) — code, category
 *    Resource, severity Error, primary None, arguments {limit, name,
 *    observed}
 *  - syntax diagnostic shape: crates/consema-toml/src/parser.rs:65-82 —
 *    code toml.parse.syntax@1, category Syntax, severity Error, primary =
 *    minimal span, argument "parser_reason"
 *  - projection failure categories: crates/consema-toml/src/projection.rs:
 *    191-200 and the failure→code mapping :410-435
 *  - edit failure categories: crates/consema-toml/src/edit.rs:243-279 and
 *    the diagnostic_code mapping :1308-1331 (core.edit.* codes, RFC 0004
 *    §17); the vector compares the frozen NAME "UnsupportedSemanticValue"
 *    (conformance/vectors/toml-v1.json:81)
 *  - native handle failure: crates/consema-toml/src/lib.rs:262-270
 *    (TomlAccessError — no registered codes, like LocationError)
 *
 * Design (TypeScript-idiomatic): every kind is a closed string-literal
 * union; `code` is a frozen property of every error instance, so the
 * RFC 0016 §6 `Code()` contract holds without a separate method. Message
 * text is human presentation only and never participates in conformance
 * comparison (RFC 0016 §1.1).
 */

import { diagnostic as makeDiagnostic } from '../document/diagnostic.ts';
import type { Diagnostic } from '../document/diagnostic.ts';

// ---------------------------------------------------------------------------
// Frozen codes
// ---------------------------------------------------------------------------

export const codeTomlParseSyntax = 'toml.parse.syntax@1';
export const codeTomlProjectionUnrepresentableDatetime = 'toml.projection.unrepresentable-datetime@1';
export const codeTomlProjectionCoreInvariant = 'toml.projection.core-invariant@1';
export const codeTomlEditRepresentationFallback = 'toml.edit.representation-fallback@1';
export const codeParseResourceLimit = 'core.parse.resource-limit@1';

// ---------------------------------------------------------------------------
// TomlFormationFailure — no Document exists (lib.rs FatalFormationFailure)
// ---------------------------------------------------------------------------

export type TomlFormationFailureKind = 'Syntax' | 'ResourceLimit' | 'Source';

/**
 * Ordered diagnostics explaining why no TOML Document exists. `kind` is the
 * frozen status spelling the conformance vectors compare ("FatalFormationFailure",
 * toml-v1.json:87/93); `code` is the frozen registered code of the first
 * diagnostic.
 *
 * NOTE (integration point): the document domain owns the eventual
 * `FatalFormationFailure` record (document/errors.ts references it); until
 * that type is published this family-local class carries the same facts.
 */
export class TomlFormationFailure extends Error {
  readonly kind: 'FatalFormationFailure';
  readonly failure: TomlFormationFailureKind;
  /** Frozen registered code of the first diagnostic (RFC 0016 §6). */
  readonly code: string;
  /** Ordered diagnostics (exactly one today: syntax, resource limit, or source). */
  readonly diagnostics: readonly Diagnostic[];
  /** Syntax: stable backend reason (parser.rs:79-80). */
  readonly parserReason?: string;
  /** Syntax: minimal provable error span in original source bytes. */
  readonly startByte?: number;
  readonly endByte?: number;
  /** ResourceLimit: stable limit name, observed amount, configured maximum. */
  readonly limitName?: string;
  readonly observed?: number;
  readonly limit?: number;
  /** Source: the wrapped frozen source-error code (core.source.invalid-utf8@1, …). */
  readonly sourceCode?: string;

  constructor(
    failure: TomlFormationFailureKind,
    options: {
      parserReason?: string;
      startByte?: number;
      endByte?: number;
      limitName?: string;
      observed?: number;
      limit?: number;
      sourceCode?: string;
    } = {},
  ) {
    const code = failure === 'Syntax' ? codeTomlParseSyntax : failure === 'Source' ? options.sourceCode! : codeParseResourceLimit;
    super(
      `toml formation: ${failure === 'Syntax' ? 'syntax' : failure === 'Source' ? 'source' : 'resource limit'}` +
        (options.parserReason !== undefined ? ` (${options.parserReason})` : '') +
        (options.limitName !== undefined ? ` (${options.limitName})` : ''),
    );
    this.name = 'TomlFormationFailure';
    this.kind = 'FatalFormationFailure';
    this.failure = failure;
    this.code = code;
    this.diagnostics = Object.freeze([buildDiagnostic(failure, options)]);
    if (options.parserReason !== undefined) this.parserReason = options.parserReason;
    if (options.startByte !== undefined) this.startByte = options.startByte;
    if (options.endByte !== undefined) this.endByte = options.endByte;
    if (options.limitName !== undefined) this.limitName = options.limitName;
    if (options.observed !== undefined) this.observed = options.observed;
    if (options.limit !== undefined) this.limit = options.limit;
    if (options.sourceCode !== undefined) this.sourceCode = options.sourceCode;
  }
}

function buildDiagnostic(
  failure: TomlFormationFailureKind,
  options: {
    parserReason?: string;
    startByte?: number;
    endByte?: number;
    limitName?: string;
    observed?: number;
    limit?: number;
    sourceCode?: string;
  },
): Diagnostic {
  if (failure === 'Syntax') {
    return makeDiagnostic(
      codeTomlParseSyntax,
      'Syntax',
      'Error',
      options.startByte !== undefined && options.endByte !== undefined
        ? { snapshot: null, startByte: BigInt(options.startByte), endByte: BigInt(options.endByte) }
        : null,
      0n,
      { arguments: options.parserReason !== undefined ? [['parser_reason', options.parserReason]] : [] },
    );
  }
  if (failure === 'Source') {
    return makeDiagnostic(options.sourceCode ?? codeTomlParseSyntax, 'Lexical', 'Error', null, 0n);
  }
  const entries: (readonly [string, string])[] = [];
  if (options.limit !== undefined) entries.push(['limit', String(options.limit)]);
  if (options.limitName !== undefined) entries.push(['name', options.limitName]);
  if (options.observed !== undefined) entries.push(['observed', String(options.observed)]);
  return makeDiagnostic(codeParseResourceLimit, 'Resource', 'Error', null, 0n, {
    arguments: entries,
  });
}

// ---------------------------------------------------------------------------
// TomlProjectionFailure — explicit projection failure category
// ---------------------------------------------------------------------------

/**
 * Stable projection failure category (projection.rs:191-200); the
 * failure→code mapping is projection.rs:410-435.
 */
export type TomlProjectionFailureKind =
  | 'UnrepresentableDateTime'
  | 'ResourceLimit'
  | 'CoreInvariant';

/** Explicit projection failure carrying the frozen registered code (RFC 0016 §6). */
export class TomlProjectionFailure extends Error {
  readonly kind: TomlProjectionFailureKind;
  readonly code: string;
  /** ResourceLimit: the exceeded limit name ("max_depth", "max_value_nodes", "max_provenance_entries"). */
  readonly limitName?: string;

  constructor(kind: TomlProjectionFailureKind, limitName?: string) {
    super(`toml projection: ${kind}${limitName !== undefined ? ` (${limitName})` : ''}`);
    this.name = 'TomlProjectionFailure';
    this.kind = kind;
    this.code = projectionFailureCode(kind);
    if (limitName !== undefined) this.limitName = limitName;
  }
}

/** Kind→code mapping (projection.rs:410-435; core.projection.resource-limit@1 at error_registry.rs:57). */
export function projectionFailureCode(kind: TomlProjectionFailureKind): string {
  switch (kind) {
    case 'UnrepresentableDateTime':
      return codeTomlProjectionUnrepresentableDatetime;
    case 'ResourceLimit':
      return 'core.projection.resource-limit@1';
    case 'CoreInvariant':
      return codeTomlProjectionCoreInvariant;
  }
}

// ---------------------------------------------------------------------------
// TomlEditFailure — atomic edit validation/commit failure
// ---------------------------------------------------------------------------

/**
 * Stable edit failure category (edit.rs:243-279); the kind NAME is the
 * frozen fact the vectors compare (toml-v1.json:81 "UnsupportedSemanticValue"),
 * the CODE mapping is edit.rs:1308-1331 (RFC 0004 §17).
 */
export type TomlEditFailureKind =
  | 'WrongSnapshot'
  | 'WrongRole'
  | 'UnsupportedSemanticValue'
  | 'InvalidLiteral'
  | 'RepresentationIncompatible'
  | 'ExactLiteralRequiresLiteralOperation'
  | 'ConflictingEdits'
  | 'DuplicateTarget'
  | 'OverlappingOwnership'
  | 'AncestorDescendantConflict'
  | 'PlacementAnchorRemoved'
  | 'TargetNotFound'
  | 'DuplicateKey'
  | 'UnsupportedOperation'
  | 'UnrepresentableValue'
  | 'ResourceLimit'
  | 'NewDocumentFormationFailed';

/** Atomic edit failure carrying the frozen registered code (edit.rs:1308-1331). */
export class TomlEditFailure extends Error {
  readonly kind: TomlEditFailureKind;
  readonly code: string;
  /** UnsupportedSemanticValue / UnrepresentableValue: the rejected core kind name. */
  readonly valueKind?: string;
  /** ResourceLimit: the exceeded limit name. */
  readonly limitName?: string;

  constructor(kind: TomlEditFailureKind, options: { valueKind?: string; limitName?: string } = {}) {
    super(`toml edit: ${kind}${options.valueKind !== undefined ? ` (${options.valueKind})` : ''}`);
    this.name = 'TomlEditFailure';
    this.kind = kind;
    this.code = editFailureCode(kind);
    if (options.valueKind !== undefined) this.valueKind = options.valueKind;
    if (options.limitName !== undefined) this.limitName = options.limitName;
  }
}

/** Kind→code mapping (edit.rs:1308-1331). */
export function editFailureCode(kind: TomlEditFailureKind): string {
  switch (kind) {
    case 'WrongSnapshot':
      return 'core.edit.wrong-snapshot@1';
    case 'WrongRole':
      return 'core.edit.wrong-role@1';
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
      return 'core.edit.conflicting-edits@1';
    case 'TargetNotFound':
      return 'core.edit.target-not-found@1';
    case 'DuplicateKey':
      return 'core.edit.duplicate-key@1';
    case 'UnsupportedOperation':
      return 'core.edit.operation-unsupported@1';
    case 'ResourceLimit':
      return 'core.edit.resource-limit@1';
    case 'NewDocumentFormationFailed':
      return 'core.edit.formation-failed@1';
  }
}

/** The frozen 64-bit integer kind name used by operation summaries (edit.rs:1260-1278). */
export function valueKindName(kind: string): string {
  switch (kind) {
    case 'Null':
      return 'null';
    case 'Boolean':
      return 'boolean';
    case 'Integer':
      return 'integer';
    case 'Decimal':
      return 'decimal';
    case 'BinaryFloat32':
      return 'binary-float32';
    case 'BinaryFloat64':
      return 'binary-float64';
    case 'String':
      return 'string';
    case 'Bytes':
      return 'bytes';
    case 'Date':
      return 'date';
    case 'Time':
      return 'time';
    case 'LocalDateTime':
      return 'local-date-time';
    case 'OffsetDateTime':
      return 'offset-date-time';
    case 'Sequence':
      return 'sequence';
    case 'Object':
      return 'object';
    case 'EntryMapping':
      return 'entry-mapping';
    default:
      return kind;
  }
}

// ---------------------------------------------------------------------------
// TomlAccessError — native handle failure (lib.rs:262-270; no registered codes)
// ---------------------------------------------------------------------------

export type TomlAccessErrorKind = 'WrongSnapshot' | 'WrongRole' | 'UnknownNode';

/** Stable native handle failure (lib.rs:262-270); the vector suite compares the frozen NAME. */
export class TomlAccessError extends Error {
  readonly kind: TomlAccessErrorKind;
  readonly code: undefined = undefined;

  constructor(kind: TomlAccessErrorKind) {
    super(`toml: ${kind}`);
    this.name = 'TomlAccessError';
    this.kind = kind;
  }
}
