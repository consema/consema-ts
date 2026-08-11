/**
 * Typed INI-family failures with frozen registered codes.
 *
 * authority (frozen codes — the EXACT registry spellings, do not guess;
 * ErrorCodeRegistry v6, crates/consema-protocol/src/error_registry.rs):
 *  - ini.edit.canonical-fallback@1               :979  (Edit, 0.8.0)
 *  - ini.edit.case-collision@1                   :985  (Edit, 0.8.0)
 *  - ini.edit.invalid-name@1                     :991  (Edit, 0.8.0)
 *  - ini.edit.invalid-placement@1                :997  (Edit, 0.8.0)
 *  - ini.formation.case-collision@1              :1003 (Semantic, 0.8.0)
 *  - ini.formation.duplicate-entry@1             :1009 (Semantic, 0.8.0)
 *  - ini.formation.duplicate-section@1           :1015 (Semantic, 0.8.0)
 *  - ini.materialization.round-trip-mismatch@1   :1021 (Materialization, 0.8.0)
 *  - ini.parse.invalid-character@1               :1027 (Syntax, 0.8.0)
 *  - ini.parse.invalid-continuation@1            :1033 (Syntax, 0.8.0)
 *  - ini.parse.malformed-line@1                  :1039 (Syntax, 0.8.0)
 *  - ini.parse.malformed-section@1               :1045 (Syntax, 0.8.0)
 *  - ini.parse.missing-delimiter@1               :1051 (Syntax, 0.8.0)
 *  - ini.parse.missing-section@1                 :1057 (Conformance, 0.8.0)
 *  - ini.profile.encoding@1                      :1063 (Encoding, 0.8.0)
 *  - ini.profile.mismatch@1                      :1069 (Conformance, 0.8.0)
 *  - ini.projection.collision@1                  :1075 (Projection, 0.8.0)
 *  - ini.projection.duplicate-collapsed@1        :1081 (Projection, 0.8.0)
 *  - ini.projection.incomplete-document@1        :1087 (Projection, 0.8.0)
 *  - ini.query.invalid-name-mode@1               :1093 (Query, 0.8.0)
 *  - shared common codes used by the family: core.parse.resource-limit@1
 *    (:39), core.source.*@1 (document/errors.ts), core.edit.*@1 and
 *    core.materialization.*@1 (RFC 0004 §17; document/errors.ts)
 *  - fatal formation shapes: crates/consema-document/src/lib.rs:643-798
 *    (FatalFormationFailure: from_diagnostic :650-654, invalid_utf8
 *    :656-672, source_error :674-767, resource_limit :769-791) and the
 *    ini profile failure (crates/consema-ini/src/parser.rs:96-104)
 *  - edit failure kinds and the kind→code mapping:
 *    crates/consema-ini/src/edit.rs:258-303 and :1754-1779
 *  - projection failure kinds and the kind→code mapping:
 *    crates/consema-ini/src/projection.rs:270-286 and :886-893
 *
 * Design (TypeScript-idiomatic): every kind is a closed string-literal
 * union; `code` is a frozen property of every error instance, so the
 * RFC 0016 §6 `Code()` contract holds without a separate method. Message
 * text is human presentation only and never participates in conformance
 * comparison (RFC 0016 §1.1).
 */

import {
  diagnostic as makeDiagnostic,
  type Diagnostic,
  type DiagnosticCategory,
  type DiagnosticLocation,
} from '../document/diagnostic.ts';
import { SourceError } from '../document/errors.ts';

// ---------------------------------------------------------------------------
// Frozen codes
// ---------------------------------------------------------------------------

export const codeIniProfileEncoding = 'ini.profile.encoding@1';
export const codeIniProfileMismatch = 'ini.profile.mismatch@1';
export const codeIniParseMalformedSection = 'ini.parse.malformed-section@1';
export const codeIniParseMissingDelimiter = 'ini.parse.missing-delimiter@1';
export const codeIniParseMissingSection = 'ini.parse.missing-section@1';
export const codeIniParseInvalidCharacter = 'ini.parse.invalid-character@1';
export const codeIniParseInvalidContinuation = 'ini.parse.invalid-continuation@1';
export const codeIniParseMalformedLine = 'ini.parse.malformed-line@1';
export const codeIniFormationDuplicateSection = 'ini.formation.duplicate-section@1';
export const codeIniFormationDuplicateEntry = 'ini.formation.duplicate-entry@1';
export const codeIniFormationCaseCollision = 'ini.formation.case-collision@1';
export const codeIniProjectionIncompleteDocument = 'ini.projection.incomplete-document@1';
export const codeIniProjectionCollision = 'ini.projection.collision@1';
export const codeIniProjectionDuplicateCollapsed = 'ini.projection.duplicate-collapsed@1';
export const codeIniEditCanonicalFallback = 'ini.edit.canonical-fallback@1';
export const codeIniEditCaseCollision = 'ini.edit.case-collision@1';
export const codeIniEditInvalidName = 'ini.edit.invalid-name@1';
export const codeIniEditInvalidPlacement = 'ini.edit.invalid-placement@1';
export const codeIniQueryInvalidNameMode = 'ini.query.invalid-name-mode@1';
export const codeParseResourceLimit = 'core.parse.resource-limit@1';

// ---------------------------------------------------------------------------
// IniFormationFailure — no Document exists (lib.rs FatalFormationFailure)
// ---------------------------------------------------------------------------

/** Fatal formation failure category; `kind` is the frozen status spelling the vectors compare ("Fatal"). */
export type IniFormationFailureKind = 'Source' | 'ResourceLimit' | 'Profile';

/**
 * Ordered diagnostics explaining why no INI Document exists. `failure` is
 * the stable category; `code` is the frozen registered code of the first
 * diagnostic (RFC 0016 §6).
 */
export class IniFormationFailure extends Error {
  readonly kind: 'FatalFormationFailure';
  readonly failure: IniFormationFailureKind;
  /** Frozen registered code of the first diagnostic. */
  readonly code: string;
  /** Ordered diagnostics (exactly one today). */
  readonly diagnostics: readonly Diagnostic[];

  private constructor(
    failure: IniFormationFailureKind,
    code: string,
    diagnostics: readonly Diagnostic[],
    message: string,
  ) {
    super(message);
    this.name = 'IniFormationFailure';
    this.kind = 'FatalFormationFailure';
    this.failure = failure;
    this.code = code;
    this.diagnostics = Object.freeze([...diagnostics]);
  }

  /** Profile/encoding conflict (parser.rs:96-104; ini.profile.encoding@1). */
  static profile(): IniFormationFailure {
    return new IniFormationFailure(
      'Profile',
      codeIniProfileEncoding,
      [
        makeDiagnostic(codeIniProfileEncoding, 'Encoding', 'Error', null, 0n),
      ],
      'ini formation: profile encoding conflict',
    );
  }

  /** Source snapshot construction failure (lib.rs:674-767). */
  static source(error: SourceError): IniFormationFailure {
    const location =
      error.kind === 'InvalidSequence' && error.byteOffset !== undefined
        ? primaryAt(error.byteOffset)
        : error.kind === 'InvalidUtf8' && error.validUpTo !== undefined
          ? primaryAt(error.validUpTo)
          : null;
    const arguments_: (readonly [string, string])[] =
      error.kind === 'InvalidSequence' && error.encoding !== undefined
        ? [['encoding', error.encoding]]
        : error.kind === 'ResourceLimit'
          ? [
              ['name', error.limitName ?? ''],
              ['observed', String(error.observed ?? 0)],
              ['limit', String(error.limit ?? 0)],
            ]
          : error.kind === 'OffsetOverflow'
            ? [['name', 'coordinate-overflow']]
            : [];
    return new IniFormationFailure(
      'Source',
      error.code,
      [makeDiagnostic(error.code, sourceCategory(error), 'Error', location, 0n, { arguments: arguments_ })],
      `ini formation: source (${error.code})`,
    );
  }

  /** Parser resource-limit failure (lib.rs:769-791; core.parse.resource-limit@1). */
  static resourceLimit(name: string, observed: number, limit: number): IniFormationFailure {
    return new IniFormationFailure(
      'ResourceLimit',
      codeParseResourceLimit,
      [
        makeDiagnostic(codeParseResourceLimit, 'Resource', 'Error', null, 0n, {
          arguments: [
            ['limit', String(limit)],
            ['name', name],
            ['observed', String(observed)],
          ],
        }),
      ],
      `ini formation: resource limit (${name})`,
    );
  }
}

function primaryAt(byte: number): DiagnosticLocation {
  return {
    snapshot: null,
    startByte: BigInt(byte),
    endByte: BigInt(byte),
  };
}

function sourceCategory(error: SourceError): DiagnosticCategory {
  switch (error.kind) {
    case 'InvalidUtf8':
    case 'InvalidSequence':
      return 'Lexical';
    case 'EncodingConflict':
    case 'UnsupportedBom':
      return 'Encoding';
    case 'ResourceLimit':
    case 'OffsetOverflow':
      return 'Resource';
  }
}

// ---------------------------------------------------------------------------
// IniProjectionFailure — explicit projection failure category
// ---------------------------------------------------------------------------

/** Stable projection failure category (projection.rs:270-286). */
export type IniProjectionFailureKind =
  | 'RecoveredDocument'
  | 'Collision'
  | 'ResourceLimit'
  | 'CoreInvariant';

/** Explicit projection failure carrying the frozen registered code (projection.rs:886-893). */
export class IniProjectionFailure extends Error {
  readonly kind: IniProjectionFailureKind;
  readonly code: string;
  /** Collision: the colliding section or entry container. */
  readonly container?: string;
  /** ResourceLimit: the exceeded limit name. */
  readonly limitName?: string;

  constructor(
    kind: IniProjectionFailureKind,
    options: { container?: string; name?: string; limitName?: string } = {},
  ) {
    super(`ini projection: ${kind}${options.limitName !== undefined ? ` (${options.limitName})` : ''}`);
    this.name = 'IniProjectionFailure';
    this.kind = kind;
    this.code = projectionFailureCode(kind);
    if (options.container !== undefined) this.container = options.container;
    if (options.name !== undefined) this.name = options.name;
    if (options.limitName !== undefined) this.limitName = options.limitName;
  }
}

/** Kind→code mapping (projection.rs:886-893). */
export function projectionFailureCode(kind: IniProjectionFailureKind): string {
  switch (kind) {
    case 'RecoveredDocument':
      return codeIniProjectionIncompleteDocument;
    case 'Collision':
      return codeIniProjectionCollision;
    case 'ResourceLimit':
      return 'core.projection.resource-limit@1';
    case 'CoreInvariant':
      return 'core.projection.target-not-applicable@1';
  }
}

// ---------------------------------------------------------------------------
// IniEditFailure — atomic edit validation/commit failure
// ---------------------------------------------------------------------------

/**
 * Stable edit failure category (edit.rs:258-303); the CODE mapping is
 * edit.rs:1754-1779 (RFC 0004 §17).
 */
export type IniEditFailureKind =
  | 'RecoveredDocument'
  | 'WrongSnapshot'
  | 'WrongRole'
  | 'DuplicateTarget'
  | 'OverlappingOwnership'
  | 'AncestorDescendantConflict'
  | 'PlacementAnchorRemoved'
  | 'TargetNotFound'
  | 'InvalidPlacement'
  | 'InvalidName'
  | 'NameCollision'
  | 'InvalidKey'
  | 'DuplicateKey'
  | 'KeyCollision'
  | 'RepresentationIncompatible'
  | 'ExactLiteralRequiresLiteralOperation'
  | 'UnrepresentableValue'
  | 'EncodingUnrepresentable'
  | 'InvalidLiteral'
  | 'ResourceLimit'
  | 'NewDocumentFormationFailed';

/** Atomic edit failure carrying the frozen registered code (edit.rs:1754-1779). */
export class IniEditFailure extends Error {
  readonly kind: IniEditFailureKind;
  readonly code: string;
  /** ResourceLimit: the exceeded limit name. */
  readonly limitName?: string;

  constructor(kind: IniEditFailureKind, options: { limitName?: string } = {}) {
    super(`ini edit: ${kind}${options.limitName !== undefined ? ` (${options.limitName})` : ''}`);
    this.name = 'IniEditFailure';
    this.kind = kind;
    this.code = editFailureCode(kind);
    if (options.limitName !== undefined) this.limitName = options.limitName;
  }
}

/** Kind→code mapping (edit.rs:1754-1779). */
export function editFailureCode(kind: IniEditFailureKind): string {
  switch (kind) {
    case 'RecoveredDocument':
      return 'core.edit.incomplete-target@1';
    case 'WrongSnapshot':
      return 'core.edit.wrong-snapshot@1';
    case 'WrongRole':
      return 'core.edit.wrong-role@1';
    case 'DuplicateTarget':
    case 'OverlappingOwnership':
    case 'AncestorDescendantConflict':
    case 'PlacementAnchorRemoved':
      return 'core.edit.conflicting-edits@1';
    case 'TargetNotFound':
      return 'core.edit.target-not-found@1';
    case 'InvalidPlacement':
      return codeIniEditInvalidPlacement;
    case 'InvalidName':
    case 'InvalidKey':
      return codeIniEditInvalidName;
    case 'NameCollision':
    case 'DuplicateKey':
      return 'core.edit.duplicate-key@1';
    case 'KeyCollision':
      return codeIniEditCaseCollision;
    case 'RepresentationIncompatible':
    case 'EncodingUnrepresentable':
      return 'core.edit.representation-incompatible@1';
    case 'ExactLiteralRequiresLiteralOperation':
      return 'core.edit.exact-literal-requires-literal@1';
    case 'UnrepresentableValue':
      return 'core.edit.unsupported-value@1';
    case 'InvalidLiteral':
      return 'core.edit.invalid-literal@1';
    case 'ResourceLimit':
      return 'core.edit.resource-limit@1';
    case 'NewDocumentFormationFailed':
      return 'core.edit.formation-failed@1';
  }
}

// ---------------------------------------------------------------------------
// IniAccessError — native handle failure (no registered codes)
// ---------------------------------------------------------------------------

export type IniAccessErrorKind = 'WrongSnapshot' | 'WrongRole' | 'UnknownNode';

/** Stable native handle failure; the vector suite compares the frozen NAME. */
export class IniAccessError extends Error {
  readonly kind: IniAccessErrorKind;
  readonly code: undefined = undefined;

  constructor(kind: IniAccessErrorKind) {
    super(`ini: ${kind}`);
    this.name = 'IniAccessError';
    this.kind = kind;
  }
}
