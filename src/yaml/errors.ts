/**
 * Typed YAML-family failures with frozen registered codes.
 *
 * authority (frozen codes — the EXACT registry spellings, do not guess):
 *  - ErrorCodeRegistry v5+: crates/consema-protocol/src/error_registry.rs
 *    yaml.alias.name-mismatch@1                 :730 (Semantic, 0.7.0)
 *    yaml.alias.name-unavailable@1              :736 (Semantic, 0.7.0)
 *    yaml.anchor.name-unavailable@1             :742 (Semantic, 0.7.0)
 *    yaml.anchor.unknown@1                      :748 (Semantic, 0.7.0)
 *    yaml.edit.anchor-dependency@1              :754 (Edit, 0.7.0)
 *    yaml.edit.anchor-not-visible@1             :760 (Edit, 0.7.0)
 *    yaml.edit.canonical-fallback@1             :766 (Edit, 0.7.0)
 *    yaml.edit.invalid-anchor-name@1            :772 (Edit, 0.7.0)
 *    yaml.edit.invalid-placement@1              :778 (Edit, 0.7.0)
 *    yaml.edit.structural-container-conflict@1  :784 (Edit, 0.7.0)
 *    yaml.mapping.missing-value@1               :790 (Semantic, 0.7.0)
 *    yaml.materialization.cross-document-sharing@1 :796 (Materialization, 0.7.0)
 *    yaml.materialization.round-trip-mismatch@1 :802 (Materialization, 0.7.0)
 *    yaml.materialization.tag-kind-mismatch@1   :808 (Materialization, 0.7.0)
 *    yaml.materialization.unsupported-tag@1     :814 (Materialization, 0.7.0)
 *    yaml.native.invalid-source-span@1          :820 (Semantic, 0.7.0)
 *    yaml.native.trailing-events@1              :826 (Semantic, 0.7.0)
 *    yaml.native.trailing-named-occurrence@1    :832 (Semantic, 0.7.0)
 *    yaml.native.unexpected-end@1               :838 (Semantic, 0.7.0)
 *    yaml.native.unexpected-event@1             :844 (Semantic, 0.7.0)
 *    yaml.parse.syntax@1                        :850 (Syntax, 0.7.0)
 *    yaml.profile.version-directive@1           :856 (Conformance, 0.7.0)
 *    yaml.projection.cycle@1                    :862 (Projection, 0.7.0)
 *    yaml.projection.document-cardinality@1     :868 (Projection, 0.7.0)
 *    yaml.projection.graph-invalid@1            :874 (Projection, 0.7.0)
 *    yaml.projection.invalid-canonical-scalar@1 :880 (Projection, 0.7.0)
 *    yaml.projection.mapping-not-object@1       :886 (Projection, 0.7.0)
 *    yaml.projection.provenance-limit@1         :892 (Resource, 0.7.0)
 *    yaml.projection.resource-limit@1           :898 (Resource, 0.7.0)
 *    yaml.projection.sharing@1                  :904 (Projection, 0.7.0)
 *    yaml.projection.unrepresentable-timestamp@1 :910 (Projection, 0.7.0)
 *    yaml.projection.unsupported-tag@1          :916 (Projection, 0.7.0)
 *    yaml.scalar.invalid-explicit-tag@1         :922 (Semantic, 0.7.0)
 *    yaml.tag.kind-mismatch@1                   :928 (Semantic, 0.7.0)
 *  - kind→code mapping authority:
 *    crates/consema-yaml/src/projection.rs:174-183 (graph),
 *    :480-497 (value); crates/consema-yaml/src/edit.rs:318-343 (edit);
 *    crates/consema-yaml/src/materialization.rs:143-151 (graph
 *    materialization); query failures: crates/consema-core/src/query.rs
 *    3114-3219 plus the yaml executor domain gate
 *    crates/consema-yaml/src/query.rs:173-177, :220-224
 *  - FatalFormationFailure: crates/consema-document/src/lib.rs:643-761;
 *    yaml.parse.syntax@1 via backend failure crates/consema-yaml/src/
 *    lib.rs:833-858; the vector case formation.undefined-alias
 *    (conformance/vectors/yaml-v1.json:41-44) pins undefined aliases as
 *    syntax failures
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
import type { MaterializationFailure } from '../document/errors.ts';
import type { GraphError } from '../graph/errors.ts';
import type { Kind } from '../core/value.ts';
import type { YamlNodeKind, YamlScalarKind } from './semantic.ts';

// ---------------------------------------------------------------------------
// YamlAccessError — typed access failure on one immutable snapshot
// ---------------------------------------------------------------------------

/** Stable typed YAML access failure (lib.rs native handles); no registered codes. */
export type YamlAccessErrorKind = 'WrongSnapshot' | 'WrongRole' | 'UnknownNode';

export class YamlAccessError extends Error {
  readonly kind: YamlAccessErrorKind;
  /** No registered error code exists for access failures. */
  readonly code: undefined = undefined;

  constructor(kind: YamlAccessErrorKind) {
    super(`yaml access: ${kind}`);
    this.name = 'YamlAccessError';
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// FatalFormationFailure — parse aborted before a document exists
// ---------------------------------------------------------------------------

/** Fatal parse failure: no Document exists (consema-document lib.rs:643-645). */
export class FatalFormationFailure extends Error {
  readonly #diagnostics: readonly Diagnostic[];

  private constructor(diagnostics: readonly Diagnostic[]) {
    super('yaml formation failed');
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

  /** Creates a fatal resource-limit failure (lib.rs:614-639 limit names). */
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

  /** Creates a fatal YAML syntax failure at one decoded offset (lib.rs:840-855). */
  static syntaxError(scalarOffset: number, rawByte: number | null): FatalFormationFailure {
    return new FatalFormationFailure([
      {
        code: 'yaml.parse.syntax@1',
        category: 'Syntax',
        severity: 'Error',
        primary:
          rawByte === null
            ? null
            : { snapshot: null, startByte: BigInt(rawByte), endByte: BigInt(rawByte) },
        related: [],
        arguments: new Map([['scalar_offset', String(scalarOffset)]]),
        notes: [],
        occurrence: 0n,
      },
    ]);
  }

  /** Creates a fatal profile-version-directive failure (lib.rs:811-827). */
  static versionDirective(
    selectedProfile: string,
    declaredVersion: string,
    line: number,
  ): FatalFormationFailure {
    return new FatalFormationFailure([
      {
        code: 'yaml.profile.version-directive@1',
        category: 'Conformance',
        severity: 'Error',
        primary: null,
        related: [],
        arguments: new Map([
          ['selected_profile', selectedProfile],
          ['declared_version', declaredVersion],
          ['line', String(line)],
        ]),
        notes: [],
        occurrence: 0n,
      },
    ]);
  }

  /** Creates a fatal native composition failure with a frozen code (native.rs:1148-1157). */
  static nativeFailure(code: YamlNativeCode): FatalFormationFailure {
    return FatalFormationFailure.fromDiagnostic({
      code,
      category: 'Semantic',
      severity: 'Error',
      primary: null,
      related: [],
      arguments: new Map(),
      notes: [],
      occurrence: 0n,
    });
  }

  /** Ordered fatal diagnostics (lib.rs:644-645). */
  diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics;
  }
}

/** Frozen native-composition failure codes (native.rs:1148-1157 uses Semantic category). */
export type YamlNativeCode =
  | 'yaml.native.trailing-events@1'
  | 'yaml.native.trailing-named-occurrence@1'
  | 'yaml.native.unexpected-end@1'
  | 'yaml.native.unexpected-event@1'
  | 'yaml.native.invalid-source-span@1'
  | 'yaml.anchor.unknown@1'
  | 'yaml.alias.name-unavailable@1'
  | 'yaml.alias.name-mismatch@1'
  | 'yaml.anchor.name-unavailable@1'
  | 'yaml.mapping.missing-value@1'
  | 'yaml.scalar.invalid-explicit-tag@1'
  | 'yaml.tag.kind-mismatch@1';

// ---------------------------------------------------------------------------
// QueryExecutionFailure — stable query execution failure
// ---------------------------------------------------------------------------

/** Stable query execution failure class (core query.rs:3114-3219; yaml query.rs:173-177, :220-224). */
export type QueryExecutionFailureKind =
  | 'DomainMismatch'
  | 'ResourceLimitExceeded'
  | 'Cancelled'
  | 'CardinalityViolation'
  | 'TargetUnavailable';

export class QueryExecutionFailure extends Error {
  readonly kind: QueryExecutionFailureKind;
  /** Frozen registered code (core query.rs:3206-3219). */
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
    super(`yaml query: ${kind}`);
    this.name = 'QueryExecutionFailure';
    this.kind = kind;
    this.code = queryExecutionFailureCode(kind);
    if (options.domain !== undefined) this.domain = options.domain;
    if (options.selection !== undefined) this.selection = options.selection;
    if (options.actual !== undefined) this.actual = options.actual;
  }
}

/** Kind→code mapping (core query.rs:3206-3219). */
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
// Graph projection failures
// ---------------------------------------------------------------------------

/** Exact YAML-to-PortableGraph projection error (native.rs:96-109). */
export type GraphProjectionError =
  | { readonly kind: 'UnsupportedTag'; readonly tag: string }
  | { readonly kind: 'Graph'; readonly error: GraphError };

/** Graph projection failure; no graph or provenance is returned (projection.rs:153-161). */
export type GraphProjectionFailureKind =
  | 'UnsupportedTag'
  | 'Graph'
  | 'ProvenanceLimit';

export class GraphProjectionFailure extends Error {
  readonly kind: GraphProjectionFailureKind;
  /** Frozen registered code (projection.rs:174-183). */
  readonly code: string;
  /** UnsupportedTag: the rejected tag. */
  readonly tag?: string;
  /** Graph: the wrapped construction failure. */
  readonly error?: GraphError;

  constructor(
    kind: GraphProjectionFailureKind,
    options: { tag?: string; error?: GraphError } = {},
  ) {
    super(`yaml graph projection: ${kind}`);
    this.name = 'GraphProjectionFailure';
    this.kind = kind;
    this.code = graphProjectionFailureCode(kind, options.error);
    if (options.tag !== undefined) this.tag = options.tag;
    if (options.error !== undefined) this.error = options.error;
  }
}

/** Kind→code mapping (projection.rs:174-183). */
export function graphProjectionFailureCode(
  kind: GraphProjectionFailureKind,
  error?: GraphError,
): string {
  switch (kind) {
    case 'UnsupportedTag':
      return 'yaml.projection.unsupported-tag@1';
    case 'Graph':
      return error !== undefined && (error.kind === 'ResourceLimit' || error.kind === 'SizeOverflow')
        ? 'yaml.projection.resource-limit@1'
        : 'yaml.projection.graph-invalid@1';
    case 'ProvenanceLimit':
      return 'yaml.projection.provenance-limit@1';
  }
}

// ---------------------------------------------------------------------------
// Value projection failures
// ---------------------------------------------------------------------------

/** Stable YAML-to-PortableValue projection failure category (projection.rs:436-476). */
export type ValueProjectionFailureKind =
  | 'DocumentCardinality'
  | 'Cycle'
  | 'Sharing'
  | 'UnsupportedTag'
  | 'MappingNotObject'
  | 'InvalidCanonicalScalar'
  | 'UnrepresentableTimestamp'
  | 'ResourceLimit';

export class ValueProjectionFailure extends Error {
  readonly kind: ValueProjectionFailureKind;
  /** Frozen registered code (projection.rs:480-497). */
  readonly code: string;
  /** The source representation identity involved, when present. */
  readonly node?: NodeRef;
  /** UnsupportedTag: the resolved unsupported tag. */
  readonly tag?: string;
  /** ResourceLimit: the stable limit name (projection.rs:475). */
  readonly limitName?: string;

  constructor(
    kind: ValueProjectionFailureKind,
    options: { node?: NodeRef; tag?: string; limitName?: string } = {},
  ) {
    super(`yaml value projection: ${kind}`);
    this.name = 'ValueProjectionFailure';
    this.kind = kind;
    this.code = valueProjectionFailureCode(kind);
    if (options.node !== undefined) this.node = options.node;
    if (options.tag !== undefined) this.tag = options.tag;
    if (options.limitName !== undefined) this.limitName = options.limitName;
  }
}

/** Kind→code mapping (projection.rs:480-497). */
export function valueProjectionFailureCode(kind: ValueProjectionFailureKind): string {
  switch (kind) {
    case 'DocumentCardinality':
      return 'yaml.projection.document-cardinality@1';
    case 'Cycle':
      return 'yaml.projection.cycle@1';
    case 'Sharing':
      return 'yaml.projection.sharing@1';
    case 'UnsupportedTag':
      return 'yaml.projection.unsupported-tag@1';
    case 'MappingNotObject':
      return 'yaml.projection.mapping-not-object@1';
    case 'InvalidCanonicalScalar':
      return 'yaml.projection.invalid-canonical-scalar@1';
    case 'UnrepresentableTimestamp':
      return 'yaml.projection.unrepresentable-timestamp@1';
    case 'ResourceLimit':
      return 'yaml.projection.resource-limit@1';
  }
}

// ---------------------------------------------------------------------------
// Graph materialization failures
// ---------------------------------------------------------------------------

/** Stable PortableGraph-to-YAML materialization failure (materialization.rs:86-111). */
export type GraphMaterializationFailureKind =
  | 'Materialization'
  | 'UnsupportedTag'
  | 'TagKindMismatch'
  | 'CrossDocumentSharing'
  | 'RoundTripMismatch';

export class GraphMaterializationFailure extends Error {
  readonly kind: GraphMaterializationFailureKind;
  /** Frozen registered code (materialization.rs:143-151). */
  readonly code: string;
  /** Materialization: the wrapped common failure. */
  readonly failure?: MaterializationFailure;
  /** The graph node involved, when present. */
  readonly node?: { readonly graph: bigint; readonly index: number };
  /** UnsupportedTag / TagKindMismatch: the exact tag. */
  readonly tag?: string;

  constructor(
    kind: GraphMaterializationFailureKind,
    options: {
      failure?: MaterializationFailure;
      node?: { readonly graph: bigint; readonly index: number };
      tag?: string;
    } = {},
  ) {
    super(`yaml graph materialization: ${kind}`);
    this.name = 'GraphMaterializationFailure';
    this.kind = kind;
    this.code = graphMaterializationFailureCode(kind, options.failure);
    if (options.failure !== undefined) this.failure = options.failure;
    if (options.node !== undefined) this.node = options.node;
    if (options.tag !== undefined) this.tag = options.tag;
  }
}

/** Kind→code mapping (materialization.rs:143-151). */
export function graphMaterializationFailureCode(
  kind: GraphMaterializationFailureKind,
  failure?: MaterializationFailure,
): string {
  switch (kind) {
    case 'Materialization':
      return failure !== undefined ? failure.code : 'core.materialization.formation-failed@1';
    case 'UnsupportedTag':
      return 'yaml.materialization.unsupported-tag@1';
    case 'TagKindMismatch':
      return 'yaml.materialization.tag-kind-mismatch@1';
    case 'CrossDocumentSharing':
      return 'yaml.materialization.cross-document-sharing@1';
    case 'RoundTripMismatch':
      return 'yaml.materialization.round-trip-mismatch@1';
  }
}

// ---------------------------------------------------------------------------
// EditFailure — stable edit validation or commit failure
// ---------------------------------------------------------------------------

/** Stable edit validation or commit failure (edit.rs:275-314); codes at edit.rs:318-343. */
export type EditFailureKind =
  | 'WrongSnapshot'
  | 'WrongRole'
  | 'TargetNotFound'
  | 'IncompleteTarget'
  | 'UnsupportedSemanticValue'
  | 'InvalidLiteral'
  | 'RepresentationIncompatible'
  | 'ExactLiteralRequiresLiteralOperation'
  | 'InvalidAnchorName'
  | 'InvalidPlacement'
  | 'AnchorNotVisible'
  | 'AnchorDependency'
  | 'UnsupportedInsertedValue'
  | 'StructuralContainerConflict'
  | 'DuplicateTarget'
  | 'OverlappingOwnership'
  | 'AncestorDescendantConflict'
  | 'ResourceLimit'
  | 'NewDocumentFormationFailed';

export class EditFailure extends Error {
  readonly kind: EditFailureKind;
  /** Frozen registered code (edit.rs:318-343). */
  readonly code: string;
  /** UnsupportedSemanticValue / UnsupportedInsertedValue: the rejected core kind (edit.rs:285, 301). */
  readonly valueKind?: Kind;
  /** ResourceLimit: the stable limit name (edit.rs:310). */
  readonly limitName?: string;

  constructor(
    kind: EditFailureKind,
    options: { valueKind?: Kind; limitName?: string } = {},
  ) {
    super(`yaml edit: ${kind}`);
    this.name = 'EditFailure';
    this.kind = kind;
    this.code = editFailureCode(kind);
    if (options.valueKind !== undefined) this.valueKind = options.valueKind;
    if (options.limitName !== undefined) this.limitName = options.limitName;
  }
}

/** Kind→code mapping (edit.rs:318-343). */
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
    case 'UnsupportedSemanticValue':
    case 'UnsupportedInsertedValue':
      return 'core.edit.unsupported-value@1';
    case 'InvalidLiteral':
      return 'core.edit.invalid-literal@1';
    case 'RepresentationIncompatible':
      return 'core.edit.representation-incompatible@1';
    case 'ExactLiteralRequiresLiteralOperation':
      return 'core.edit.exact-literal-requires-literal@1';
    case 'InvalidAnchorName':
      return 'yaml.edit.invalid-anchor-name@1';
    case 'InvalidPlacement':
      return 'yaml.edit.invalid-placement@1';
    case 'AnchorNotVisible':
      return 'yaml.edit.anchor-not-visible@1';
    case 'AnchorDependency':
      return 'yaml.edit.anchor-dependency@1';
    case 'StructuralContainerConflict':
      return 'yaml.edit.structural-container-conflict@1';
    case 'DuplicateTarget':
    case 'OverlappingOwnership':
    case 'AncestorDescendantConflict':
      return 'core.edit.conflicting-edits@1';
    case 'ResourceLimit':
      return 'core.edit.resource-limit@1';
    case 'NewDocumentFormationFailed':
      return 'core.edit.formation-failed@1';
  }
}

/** Stable node kind name for projection events (projection.rs:1183-1189). */
export function nodeKindName(kind: YamlNodeKind): string {
  return kind;
}

/** Stable scalar kind name for projection events. */
export function scalarKindName(kind: YamlScalarKind): string {
  return kind;
}
