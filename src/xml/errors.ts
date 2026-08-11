/**
 * Typed XML-family failures with frozen registered codes.
 *
 * authority (frozen codes — the EXACT spellings, do not guess):
 *  - RFC 0012 §12 (:422-433): the `xml.*` diagnostic codes are registered
 *    by this RFC and are part of the `xml.1.0-safe@1` contract; they do NOT
 *    enter the consema-protocol core error registry (which covers only
 *    core/protocol and line-format contract codes)
 *  - xml.* formation/recovery/limit code sites (the pinned spellings):
 *    crates/consema-xml/src/parser.rs
 *      xml.source.decoding@1           :44       (Encoding)
 *      xml.profile.encoding@1          :73,106   (Conformance)
 *      xml.profile.unknown@1           :217      (Conformance)
 *      xml.source.span@1               :344 et al (Conformance)
 *      xml.declaration.version@1       :353      (Syntax)
 *      xml.declaration.conflict@1      :371      (Encoding)
 *      xml.declaration.duplicate@1     :389      (Syntax)
 *      xml.pi.target@1                 :514      (Syntax)
 *      xml.limit.pi@1                  :520      (Conformance)
 *      xml.comment.content@1           :590      (Syntax)
 *      xml.limit.comment@1             :596      (Conformance)
 *      xml.dtd.external-subset@1       :659,681  (Conformance)
 *      xml.dtd.name@1                  :700      (Conformance)
 *      xml.dtd.multiple-doctype@1      :727      (Syntax)
 *      xml.limit.qname@1               :734,927  (Conformance)
 *      xml.dtd.parameter-entity@1      :765,806  (Conformance)
 *      xml.dtd.external-entity@1       :775      (Conformance)
 *      xml.limit.entity-replacement@1  :783      (Conformance)
 *      xml.entity.markup@1             :789      (Conformance)
 *      xml.entity.illegal-character@1  :794      (Syntax)
 *      xml.entity.reserved-name@1      :817      (Conformance)
 *      xml.entity.duplicate@1          :828      (Syntax)
 *      xml.limit.dtd@1                 :858      (Conformance)
 *      xml.dtd.conditional-section@1   :900      (Conformance)
 *      xml.dtd.validation-declaration@1:902      (Conformance)
 *      xml.limit.node@1 / xml.limit.element@1 / xml.limit.depth@1
 *                                      :932-938  (Conformance)
 *      xml.syntax.attribute-outside-element@1 :973,1034 (Conformance)
 *      xml.limit.attribute@1           :980      (Conformance)
 *      xml.limit.namespace-uri@1       :1038     (Conformance)
 *      xml.limit.attribute-value@1     :1050     (Conformance)
 *      xml.namespace.unbound-prefix@1 / reserved-prefix@1 /
 *        xml-rebinding@1 / default-xmlns@1      :130-137 (Semantic)
 *      xml.namespace.duplicate-attribute@1 :1148 (Semantic)
 *      xml.tree.mismatched-end-tag@1   :1238     (Syntax)
 *      xml.tree.extra-end-tag@1        :1256     (Syntax)
 *      xml.tree.multiple-roots@1       :1300     (Syntax)
 *      xml.limit.mixed-content@1       :1289,1410 (Conformance)
 *      xml.syntax.text-outside-root@1  :1326     (Syntax)
 *      xml.limit.text@1                :1350     (Conformance)
 *      xml.limit.cdata@1               :1389     (Conformance)
 *      xml.reference.malformed@1       :1511     (Syntax)
 *      xml.reference.invalid-character@1 :1592   (Syntax)
 *      xml.entity.unknown@1            :1612     (Conformance)
 *      xml.entity.cyclic@1             :1638     (Conformance)
 *      xml.entity.limit@1 / xml.entity.amplification@1 :1751-1756 (Conformance)
 *      xml.syntax.well-formedness@1    :1779     (Syntax)
 *      xml.tree.unclosed-element@1     :1796     (Syntax)
 *      xml.tree.missing-root@1         :1806     (Syntax)
 *      xml.tree.root@1                 :1815     (Conformance)
 *      xml.doctype.root-mismatch@1     :1819     (Syntax)
 *      xml.source.coverage@1           :1893     (Conformance)
 *  - xml.projection.* codes: crates/consema-xml/src/projection.rs:459-468
 *    (recovered-document@1, subtree@1, admission@1, collision@1,
 *    resource-limit@1, core-invariant@1)
 *  - xml.edit.* codes: crates/consema-xml/src/edit.rs:388-408 (the XML
 *    edit family's StableFailure mapping; the core.edit.* codes not present
 *    in ErrorCodeRegistry v7 — invalid-qname@1, unbound-prefix@1,
 *    reserved-prefix@1, duplicate-expanded-attribute@1, cannot-remove-root@1,
 *    ancestor-placement@1 — are pinned by this file, per RFC 0012 §12 the
 *    family's own format section handles them)
 *  - core.query.* codes: crates/consema-protocol/src/error_registry.rs:
 *    141-201 (query section), QueryFailure kind mapping :1517-1527
 *  - FatalFormationFailure: crates/consema-document/src/lib.rs:643-761
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

// ---------------------------------------------------------------------------
// XmlAccessError — typed access failure on one immutable snapshot
// ---------------------------------------------------------------------------

/** Stable typed XML access failure (document.rs:268-285 pattern); no registered codes. */
export type XmlAccessErrorKind = 'WrongSnapshot' | 'WrongRole' | 'UnknownNode';

export class XmlAccessError extends Error {
  readonly kind: XmlAccessErrorKind;
  /** No registered error code exists for access failures. */
  readonly code: undefined = undefined;

  constructor(kind: XmlAccessErrorKind) {
    super(`xml access: ${kind}`);
    this.name = 'XmlAccessError';
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// FatalFormationFailure — parse aborted before a document exists
// ---------------------------------------------------------------------------

/** Fatal parse failure: no Document exists (lib.rs:643-645 pattern). */
export class FatalFormationFailure extends Error {
  readonly #diagnostics: readonly Diagnostic[];

  private constructor(diagnostics: readonly Diagnostic[]) {
    super('xml formation failed');
    this.name = 'FatalFormationFailure';
    this.#diagnostics = Object.freeze([...diagnostics]);
  }

  /** Creates a fatal formation failure from one format-specific diagnostic (lib.rs:649-654 pattern). */
  static fromDiagnostic(diagnostic: Diagnostic): FatalFormationFailure {
    return new FatalFormationFailure([diagnostic]);
  }

  /** Invalid UTF-8 source (lib.rs:657-672 pattern; code at error_registry.rs:207). */
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

  /** Converts a source-construction failure into one stable fatal diagnostic (lib.rs:675-761 pattern). */
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

  /**
   * Fatal profile boundary violation with a frozen code
   * (profile_failure pattern, parser.rs:120-128).
   */
  static profile(code: string): FatalFormationFailure {
    return FatalFormationFailure.fromDiagnostic({
      code,
      category: 'Conformance',
      severity: 'Error',
      primary: null,
      related: [],
      arguments: new Map(),
      notes: [],
      occurrence: 0n,
    });
  }

  /** Fatal source/decoding failure with a frozen code (source_failure pattern, parser.rs:110-118). */
  static source(code: string, startByte: number): FatalFormationFailure {
    return FatalFormationFailure.fromDiagnostic({
      code,
      category: 'Encoding',
      severity: 'Error',
      primary:
        startByte >= 0
          ? { snapshot: null, startByte: BigInt(startByte), endByte: BigInt(startByte) }
          : null,
      related: [],
      arguments: new Map(),
      notes: [],
      occurrence: 0n,
    });
  }

  /**
   * Fatal resource-limit failure with the limit's own frozen code
   * (the `Self::limit` profile-failure pattern, parser.rs:2015-2020).
   */
  static limit(code: string, observed: number, limit: number): FatalFormationFailure {
    return FatalFormationFailure.fromDiagnostic({
      code,
      category: 'Conformance',
      severity: 'Error',
      primary: null,
      related: [],
      arguments: new Map([
        ['name', code],
        ['observed', String(observed)],
        ['limit', String(limit)],
      ]),
      notes: [],
      occurrence: 0n,
    });
  }

  /** Ordered fatal diagnostics (lib.rs:644-645 pattern). */
  diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics;
  }
}

// ---------------------------------------------------------------------------
// QueryExecutionFailure — stable query execution failure
// ---------------------------------------------------------------------------

/** Stable query execution failure class (query.rs:3114-3219; query.rs:96-105 pattern). */
export type QueryExecutionFailureKind =
  | 'DomainMismatch'
  | 'ResourceLimitExceeded'
  | 'Cancelled'
  | 'CardinalityViolation'
  | 'TargetUnavailable';

export class QueryExecutionFailure extends Error {
  readonly kind: QueryExecutionFailureKind;
  /** Frozen registered code (error_registry.rs:1517-1527). */
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
    super(`xml query: ${kind}`);
    this.name = 'QueryExecutionFailure';
    this.kind = kind;
    this.code = queryExecutionFailureCode(kind);
    if (options.domain !== undefined) this.domain = options.domain;
    if (options.selection !== undefined) this.selection = options.selection;
    if (options.actual !== undefined) this.actual = options.actual;
  }
}

/** Kind→code mapping (error_registry.rs:1517-1527). */
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

/** Stable projection failure category (projection.rs:421-441); codes at projection.rs:459-468. */
export type ProjectionFailureKind =
  | 'RecoveredDocument'
  | 'SubtreeNotElement'
  | 'MappingAdmission'
  | 'Collision'
  | 'ResourceLimit'
  | 'CoreInvariant';

export class ProjectionFailure extends Error {
  readonly kind: ProjectionFailureKind;
  /** Frozen registered code (projection.rs:459-468). */
  readonly code: string;
  /** MappingAdmission: the stable admission reason. */
  readonly reason?: string;
  /** Collision: the colliding child element. */
  readonly child?: NodeRef;
  /** Collision: the entry key that collided. */
  readonly key?: string;
  /** ResourceLimit: the stable limit name. */
  readonly limitName?: string;

  constructor(
    kind: ProjectionFailureKind,
    options: { reason?: string; child?: NodeRef; key?: string; limitName?: string } = {},
  ) {
    super(`projection: ${kind}`);
    this.name = 'ProjectionFailure';
    this.kind = kind;
    this.code = projectionFailureCode(kind);
    if (options.reason !== undefined) this.reason = options.reason;
    if (options.child !== undefined) this.child = options.child;
    if (options.key !== undefined) this.key = options.key;
    if (options.limitName !== undefined) this.limitName = options.limitName;
  }
}

/** Kind→code mapping (projection.rs:459-468). */
export function projectionFailureCode(kind: ProjectionFailureKind): string {
  switch (kind) {
    case 'RecoveredDocument':
      return 'xml.projection.recovered-document@1';
    case 'SubtreeNotElement':
      return 'xml.projection.subtree@1';
    case 'MappingAdmission':
      return 'xml.projection.admission@1';
    case 'Collision':
      return 'xml.projection.collision@1';
    case 'ResourceLimit':
      return 'xml.projection.resource-limit@1';
    case 'CoreInvariant':
      return 'xml.projection.core-invariant@1';
  }
}

// ---------------------------------------------------------------------------
// EditFailure — stable edit validation or commit failure
// ---------------------------------------------------------------------------

/** Stable edit validation or commit failure (edit.rs:319-360); codes at edit.rs:388-408. */
export type EditFailureKind =
  | 'WrongSnapshot'
  | 'WrongRole'
  | 'TargetNotFound'
  | 'IncompleteTarget'
  | 'InvalidQName'
  | 'UnboundPrefix'
  | 'ReservedPrefix'
  | 'DuplicateExpandedAttribute'
  | 'CannotRemoveRoot'
  | 'AncestorPlacement'
  | 'ConflictingEdits'
  | 'OverlappingOwnership'
  | 'AncestorDescendantConflict'
  | 'PlacementAnchorModified'
  | 'ResourceLimit'
  | 'NewDocumentFormationFailed';

export class EditFailure extends Error {
  readonly kind: EditFailureKind;
  /** Frozen registered code (edit.rs:388-408). */
  readonly code: string;
  /** UnboundPrefix / ReservedPrefix: the prefix spelling. */
  readonly prefix?: string;
  /** ResourceLimit: the stable limit name. */
  readonly limitName?: string;

  constructor(
    kind: EditFailureKind,
    options: { prefix?: string; limitName?: string } = {},
  ) {
    super(`edit: ${kind}`);
    this.name = 'EditFailure';
    this.kind = kind;
    this.code = editFailureCode(kind);
    if (options.prefix !== undefined) this.prefix = options.prefix;
    if (options.limitName !== undefined) this.limitName = options.limitName;
  }
}

/** Kind→code mapping (edit.rs:388-408). */
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
    case 'InvalidQName':
      return 'core.edit.invalid-qname@1';
    case 'UnboundPrefix':
      return 'core.edit.unbound-prefix@1';
    case 'ReservedPrefix':
      return 'core.edit.reserved-prefix@1';
    case 'DuplicateExpandedAttribute':
      return 'core.edit.duplicate-expanded-attribute@1';
    case 'CannotRemoveRoot':
      return 'core.edit.cannot-remove-root@1';
    case 'AncestorPlacement':
      return 'core.edit.ancestor-placement@1';
    case 'ConflictingEdits':
    case 'OverlappingOwnership':
    case 'AncestorDescendantConflict':
    case 'PlacementAnchorModified':
      return 'core.edit.conflicting-edits@1';
    case 'ResourceLimit':
      return 'core.edit.resource-limit@1';
    case 'NewDocumentFormationFailed':
      return 'core.edit.formation-failed@1';
  }
}
