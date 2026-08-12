/**
 * Typed HCL-family failures with frozen registered codes.
 *
 * authority (frozen codes — the EXACT registry spellings, do not guess):
 *  - crates/consema-hcl/src/lexer.rs:457-487 (codes module) — the thirteen
 *    `hcl.parse.*@1` lexical codes; crates/consema-hcl/src/parser.rs:76-98
 *    (codes module) — hcl.parse.block@1 / label@1 / expression@1 /
 *    directive@1 / newline@1 / separator@1 / duplicate-attribute@1
 *  - crates/consema-hcl/src/lib.rs:300 (hcl.parse.encoding@1, fatal
 *    caller-side encoding conflict), :46-48 (hcl.tfvars.block-not-allowed@1)
 *  - limit codes: the vector suite pins the fatal diagnostics
 *    (conformance/vectors/hcl-v1.json:1781-1970: hcl.limit.expression-
 *    depth@1, hcl.limit.body-depth@1, hcl.limit.number-digits@1,
 *    hcl.limit.attribute-count@1, hcl.limit.block-count@1,
 *    hcl.limit.body-item-count@1, hcl.limit.label-count@1,
 *    hcl.limit.template-len@1, hcl.limit.heredoc-bytes@1,
 *    hcl.limit.tuple-elements@1, hcl.limit.object-entries@1) and
 *    crates/consema-hcl/src/lib.rs:187 (max_template_depth → the
 *    hcl.limit.template-depth@1 spelling)
 *  - projection codes: crates/consema-hcl/src/projection.rs:468-476 —
 *    hcl.projection.incomplete-document@1 / non-literal-expression@1 /
 *    unrepresentable@1 / resource-limit@1 / core-invariant@1
 *  - materialization codes: crates/consema-conformance/src/hcl_v1.rs:1621-
 *    1622 — hcl.materialization.unrepresentable@1 / resource-limit@1
 *  - edit codes: crates/consema-hcl/src/edit.rs:599-611 — the two
 *    hcl.edit.*@1 codes (duplicate-attribute@1, block-in-tfvars@1,
 *    unrepresentable@1) and the core.edit.*@1 mappings (RFC 0004 §17)
 *  - query failure codes: crates/consema-conformance/src/hcl_v1.rs:656-670
 *    — hcl.query.domain-mismatch@1 / unknown-operator@1 /
 *    wrong-argument-type@1 / invalid-argument@1 / invalid-composition@1 /
 *    missing-capability@1 / type-mismatch@1 / cardinality-violation@1 /
 *    resource-limit@1 / cancelled@1 / non-literal@1
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

// Lexical hcl.parse.*@1 codes (lexer.rs:460-486).
export const codeHclParseByteOrderMark = 'hcl.parse.byte-order-mark@1';
export const codeHclParseLoneCr = 'hcl.parse.lone-cr@1';
export const codeHclParseInvalidUtf8 = 'hcl.parse.invalid-utf8@1';
export const codeHclParseIdentifier = 'hcl.parse.identifier@1';
export const codeHclParseInvalidNumber = 'hcl.parse.invalid-number@1';
export const codeHclParseInvalidCharacter = 'hcl.parse.invalid-character@1';
export const codeHclParseInvalidEscape = 'hcl.parse.invalid-escape@1';
export const codeHclParseUnterminatedComment = 'hcl.parse.unterminated-comment@1';
export const codeHclParseUnterminatedString = 'hcl.parse.unterminated-string@1';
export const codeHclParseUnterminatedInterpolation = 'hcl.parse.unterminated-interpolation@1';
export const codeHclParseUnterminatedDirective = 'hcl.parse.unterminated-directive@1';
export const codeHclParseUnterminatedHeredoc = 'hcl.parse.unterminated-heredoc@1';
export const codeHclParseHeredocMarker = 'hcl.parse.heredoc-marker@1';
// Grammar hcl.parse.*@1 codes (parser.rs:77-98).
export const codeHclParseItem = 'hcl.parse.item@1';
export const codeHclParseAttribute = 'hcl.parse.attribute@1';
export const codeHclParseBlock = 'hcl.parse.block@1';
export const codeHclParseLabel = 'hcl.parse.label@1';
export const codeHclParseExpression = 'hcl.parse.expression@1';
export const codeHclParseDirective = 'hcl.parse.directive@1';
export const codeHclParseNewline = 'hcl.parse.newline@1';
export const codeHclParseSeparator = 'hcl.parse.separator@1';
export const codeHclParseDuplicateAttribute = 'hcl.parse.duplicate-attribute@1';
// Caller-side source-contract conflict (lib.rs:300).
export const codeHclParseEncoding = 'hcl.parse.encoding@1';
// Profile restriction (document.rs:46-48).
export const codeHclTfvarsBlockNotAllowed = 'hcl.tfvars.block-not-allowed@1';

// hcl.limit.*@1 codes (hcl-v1.json:1781-1970; lib.rs:187).
export const codeHclLimitExpressionDepth = 'hcl.limit.expression-depth@1';
export const codeHclLimitBodyDepth = 'hcl.limit.body-depth@1';
export const codeHclLimitTemplateDepth = 'hcl.limit.template-depth@1';
export const codeHclLimitNumberDigits = 'hcl.limit.number-digits@1';
export const codeHclLimitAttributeCount = 'hcl.limit.attribute-count@1';
export const codeHclLimitBlockCount = 'hcl.limit.block-count@1';
export const codeHclLimitBodyItemCount = 'hcl.limit.body-item-count@1';
export const codeHclLimitLabelCount = 'hcl.limit.label-count@1';
export const codeHclLimitIdentifierLen = 'hcl.limit.identifier-len@1';
export const codeHclLimitStringLen = 'hcl.limit.string-len@1';
export const codeHclLimitTemplateLen = 'hcl.limit.template-len@1';
export const codeHclLimitTemplateInterpolations = 'hcl.limit.template-interpolations@1';
export const codeHclLimitHeredocLines = 'hcl.limit.heredoc-lines@1';
export const codeHclLimitHeredocBytes = 'hcl.limit.heredoc-bytes@1';
export const codeHclLimitTupleElements = 'hcl.limit.tuple-elements@1';
export const codeHclLimitObjectEntries = 'hcl.limit.object-entries@1';
export const codeHclLimitForExtent = 'hcl.limit.for-extent@1';
export const codeHclLimitRecoveryRegions = 'hcl.limit.recovery-regions@1';
export const codeHclLimitErrorRegions = 'hcl.limit.error-regions@1';
export const codeHclLimitSyntaxPieces = 'hcl.limit.syntax-pieces@1';
export const codeHclLimitReportEvents = 'hcl.limit.report-events@1';

// hcl.projection.*@1 codes (projection.rs:468-476).
export const codeHclProjectionIncompleteDocument = 'hcl.projection.incomplete-document@1';
export const codeHclProjectionNonLiteralExpression = 'hcl.projection.non-literal-expression@1';
export const codeHclProjectionUnrepresentable = 'hcl.projection.unrepresentable@1';
export const codeHclProjectionResourceLimit = 'hcl.projection.resource-limit@1';
export const codeHclProjectionCoreInvariant = 'hcl.projection.core-invariant@1';

// hcl.materialization.*@1 codes (hcl_v1.rs:1621-1622).
export const codeHclMaterializationUnrepresentable = 'hcl.materialization.unrepresentable@1';
export const codeHclMaterializationResourceLimit = 'hcl.materialization.resource-limit@1';

// hcl.edit.*@1 codes (edit.rs:604-607).
export const codeHclEditDuplicateAttribute = 'hcl.edit.duplicate-attribute@1';
export const codeHclEditBlockInTfvars = 'hcl.edit.block-in-tfvars@1';
export const codeHclEditUnrepresentable = 'hcl.edit.unrepresentable@1';

// hcl.query.*@1 codes (hcl_v1.rs:656-670).
export const codeHclQueryDomainMismatch = 'hcl.query.domain-mismatch@1';
export const codeHclQueryUnknownOperator = 'hcl.query.unknown-operator@1';
export const codeHclQueryWrongArgumentType = 'hcl.query.wrong-argument-type@1';
export const codeHclQueryInvalidArgument = 'hcl.query.invalid-argument@1';
export const codeHclQueryInvalidComposition = 'hcl.query.invalid-composition@1';
export const codeHclQueryMissingCapability = 'hcl.query.missing-capability@1';
export const codeHclQueryTypeMismatch = 'hcl.query.type-mismatch@1';
export const codeHclQueryCardinalityViolation = 'hcl.query.cardinality-violation@1';
export const codeHclQueryResourceLimit = 'hcl.query.resource-limit@1';
export const codeHclQueryCancelled = 'hcl.query.cancelled@1';
export const codeHclQueryNonLiteral = 'hcl.query.non-literal@1';

/** Maps one limit field name to its frozen `hcl.limit.*@1` code. */
export function hclLimitCode(limitName: string): string {
  switch (limitName) {
    case 'expression-depth':
      return codeHclLimitExpressionDepth;
    case 'body-depth':
      return codeHclLimitBodyDepth;
    case 'template-depth':
      return codeHclLimitTemplateDepth;
    case 'number-digits':
      return codeHclLimitNumberDigits;
    case 'attribute-count':
      return codeHclLimitAttributeCount;
    case 'block-count':
      return codeHclLimitBlockCount;
    case 'body-item-count':
      return codeHclLimitBodyItemCount;
    case 'label-count':
      return codeHclLimitLabelCount;
    case 'identifier-len':
      return codeHclLimitIdentifierLen;
    case 'string-len':
      return codeHclLimitStringLen;
    case 'template-len':
      return codeHclLimitTemplateLen;
    case 'template-interpolations':
      return codeHclLimitTemplateInterpolations;
    case 'heredoc-lines':
      return codeHclLimitHeredocLines;
    case 'heredoc-bytes':
      return codeHclLimitHeredocBytes;
    case 'tuple-elements':
      return codeHclLimitTupleElements;
    case 'object-entries':
      return codeHclLimitObjectEntries;
    case 'for-extent':
      return codeHclLimitForExtent;
    case 'recovery-regions':
      return codeHclLimitRecoveryRegions;
    case 'error-regions':
      return codeHclLimitErrorRegions;
    case 'syntax-pieces':
      return codeHclLimitSyntaxPieces;
    case 'report-events':
      return codeHclLimitReportEvents;
    default:
      return codeHclLimitReportEvents;
  }
}

// ---------------------------------------------------------------------------
// HclFormationFailure — no Document exists (FatalFormationFailure)
// ---------------------------------------------------------------------------

export type HclFormationFailureKind = 'Syntax' | 'ResourceLimit' | 'Source' | 'Encoding';

/**
 * Ordered diagnostics explaining why no HCL Document exists. `kind` is the
 * frozen status spelling the conformance vectors compare
 * ("FatalFormationFailure", hcl-v1.json:419); `code` is the frozen
 * registered code of the first diagnostic.
 *
 * NOTE (integration point): the document domain owns the eventual
 * `FatalFormationFailure` record; until that type is published this
 * family-local class carries the same facts (the toml family precedent,
 * typescript/src/toml/errors.ts:56-66).
 */
export class HclFormationFailure extends Error {
  readonly kind: 'FatalFormationFailure';
  readonly failure: HclFormationFailureKind;
  /** Frozen registered code of the first diagnostic (RFC 0016 §6). */
  readonly code: string;
  /** Ordered diagnostics. */
  readonly diagnostics: readonly Diagnostic[];
  /** Syntax: stable reason for the failure. */
  readonly parserReason?: string;
  /** Syntax: minimal provable error span in original source bytes. */
  readonly startByte?: number;
  readonly endByte?: number;
  /** ResourceLimit: stable limit name, observed amount, configured maximum. */
  readonly limitName?: string;
  readonly observed?: number;
  readonly limit?: number;

  constructor(
    failure: HclFormationFailureKind,
    options: {
      parserReason?: string;
      startByte?: number;
      endByte?: number;
      limitName?: string;
      observed?: number;
      limit?: number;
    } = {},
  ) {
    const code =
      failure === 'Syntax'
        ? options.parserReason !== undefined && options.parserReason.startsWith('hcl.parse.')
          ? options.parserReason
          : codeHclParseInvalidCharacter
        : failure === 'Encoding'
          ? codeHclParseEncoding
          : failure === 'Source'
            ? codeHclParseInvalidUtf8
            : hclLimitCode(options.limitName ?? 'report-events');
    super(
      `hcl formation: ${failure}` +
        (options.parserReason !== undefined ? ` (${options.parserReason})` : '') +
        (options.limitName !== undefined ? ` (${options.limitName})` : ''),
    );
    this.name = 'HclFormationFailure';
    this.kind = 'FatalFormationFailure';
    this.failure = failure;
    this.code = code;
    this.diagnostics = Object.freeze([buildFormationDiagnostic(failure, code, options)]);
    if (options.parserReason !== undefined) this.parserReason = options.parserReason;
    if (options.startByte !== undefined) this.startByte = options.startByte;
    if (options.endByte !== undefined) this.endByte = options.endByte;
    if (options.limitName !== undefined) this.limitName = options.limitName;
    if (options.observed !== undefined) this.observed = options.observed;
    if (options.limit !== undefined) this.limit = options.limit;
  }
}

function buildFormationDiagnostic(
  failure: HclFormationFailureKind,
  code: string,
  options: {
    parserReason?: string;
    startByte?: number;
    endByte?: number;
    limitName?: string;
    observed?: number;
    limit?: number;
  },
): Diagnostic {
  if (failure === 'ResourceLimit') {
    const entries: (readonly [string, string])[] = [];
    if (options.limit !== undefined) entries.push(['limit', String(options.limit)]);
    if (options.limitName !== undefined) entries.push(['name', options.limitName]);
    if (options.observed !== undefined) entries.push(['observed', String(options.observed)]);
    return makeDiagnostic(code, 'Resource', 'Error', null, 0n, { arguments: entries });
  }
  const category = failure === 'Encoding' ? 'Encoding' : failure === 'Source' ? 'Lexical' : 'Syntax';
  const primary =
    options.startByte !== undefined && options.endByte !== undefined
      ? { snapshot: null, startByte: BigInt(options.startByte), endByte: BigInt(options.endByte) }
      : null;
  return makeDiagnostic(code, category, 'Error', primary, 0n, {
    arguments: options.parserReason !== undefined ? [['parser_reason', options.parserReason]] : [],
  });
}

// ---------------------------------------------------------------------------
// HclAccessError — native handle failure (no registered codes)
// ---------------------------------------------------------------------------

export type HclAccessErrorKind = 'WrongSnapshot' | 'WrongRole' | 'UnknownNode';

/** Stable native handle failure; the vector suite compares the frozen NAME. */
export class HclAccessError extends Error {
  readonly kind: HclAccessErrorKind;
  readonly code: undefined = undefined;

  constructor(kind: HclAccessErrorKind) {
    super(`hcl: ${kind}`);
    this.name = 'HclAccessError';
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// HclProjectionFailure — explicit projection failure category
// ---------------------------------------------------------------------------

/**
 * Stable projection failure category (projection.rs:432-451); the
 * failure→code mapping is projection.rs:468-476.
 */
export type HclProjectionFailureKind =
  | 'IncompleteDocument'
  | 'NonLiteralExpression'
  | 'Unrepresentable'
  | 'ResourceLimit'
  | 'CoreInvariant';

/** Explicit projection failure carrying the frozen registered code (RFC 0016 §6). */
export class HclProjectionFailure extends Error {
  readonly kind: HclProjectionFailureKind;
  readonly code: string;
  /** NonLiteralExpression: exact source text of the first derived expression. */
  readonly text?: string;
  /** Unrepresentable: the blocking native fact. */
  readonly fact?: string;
  /** ResourceLimit: the exceeded limit name. */
  readonly limitName?: string;

  constructor(
    kind: HclProjectionFailureKind,
    options: { text?: string; fact?: string; limitName?: string } = {},
  ) {
    super(
      `hcl projection: ${kind}` +
        (options.text !== undefined ? ` (${options.text})` : '') +
        (options.fact !== undefined ? ` (${options.fact})` : '') +
        (options.limitName !== undefined ? ` (${options.limitName})` : ''),
    );
    this.name = 'HclProjectionFailure';
    this.kind = kind;
    this.code = projectionFailureCode(kind);
    if (options.text !== undefined) this.text = options.text;
    if (options.fact !== undefined) this.fact = options.fact;
    if (options.limitName !== undefined) this.limitName = options.limitName;
  }
}

/** Kind→code mapping (projection.rs:468-476). */
export function projectionFailureCode(kind: HclProjectionFailureKind): string {
  switch (kind) {
    case 'IncompleteDocument':
      return codeHclProjectionIncompleteDocument;
    case 'NonLiteralExpression':
      return codeHclProjectionNonLiteralExpression;
    case 'Unrepresentable':
      return codeHclProjectionUnrepresentable;
    case 'ResourceLimit':
      return codeHclProjectionResourceLimit;
    case 'CoreInvariant':
      return codeHclProjectionCoreInvariant;
  }
}

// ---------------------------------------------------------------------------
// HclMaterializationFailure — atomic materialization failure
// ---------------------------------------------------------------------------

export type HclMaterializationFailureKind = 'Unrepresentable' | 'ResourceLimit';

/** Atomic materialization failure (hcl_v1.rs:1621-1622; RFC 0014 §9). */
export class HclMaterializationFailure extends Error {
  readonly kind: HclMaterializationFailureKind;
  readonly code: string;
  /** Unrepresentable: the blocking native fact. */
  readonly fact?: string;
  /** ResourceLimit: the exceeded limit name. */
  readonly limitName?: string;

  constructor(kind: HclMaterializationFailureKind, options: { fact?: string; limitName?: string } = {}) {
    super(
      `hcl materialization: ${kind}` +
        (options.fact !== undefined ? ` (${options.fact})` : '') +
        (options.limitName !== undefined ? ` (${options.limitName})` : ''),
    );
    this.name = 'HclMaterializationFailure';
    this.kind = kind;
    this.code =
      kind === 'Unrepresentable' ? codeHclMaterializationUnrepresentable : codeHclMaterializationResourceLimit;
    if (options.fact !== undefined) this.fact = options.fact;
    if (options.limitName !== undefined) this.limitName = options.limitName;
  }
}

// ---------------------------------------------------------------------------
// HclEditFailure — atomic edit validation/commit failure
// ---------------------------------------------------------------------------

/**
 * Stable edit failure category (edit.rs:547-578); the kind NAME is the
 * frozen fact the vectors compare, the CODE mapping is edit.rs:599-611
 * (RFC 0004 §17).
 */
export type HclEditFailureKind =
  | 'WrongSnapshot'
  | 'WrongRole'
  | 'IncompleteTarget'
  | 'DuplicateAttribute'
  | 'BlockInTfvars'
  | 'ConflictingEdits'
  | 'OverlappingOwnership'
  | 'UnrepresentableValue'
  | 'ResourceLimit'
  | 'NewDocumentFormationFailed';

/** Atomic edit failure carrying the frozen registered code (edit.rs:599-611). */
export class HclEditFailure extends Error {
  readonly kind: HclEditFailureKind;
  readonly code: string;
  /** UnrepresentableValue: the blocking native fact. */
  readonly fact?: string;
  /** ResourceLimit: the exceeded limit name. */
  readonly limitName?: string;

  constructor(kind: HclEditFailureKind, options: { fact?: string; limitName?: string } = {}) {
    super(
      `hcl edit: ${kind}` +
        (options.fact !== undefined ? ` (${options.fact})` : '') +
        (options.limitName !== undefined ? ` (${options.limitName})` : ''),
    );
    this.name = 'HclEditFailure';
    this.kind = kind;
    this.code = editFailureCode(kind);
    if (options.fact !== undefined) this.fact = options.fact;
    if (options.limitName !== undefined) this.limitName = options.limitName;
  }
}

/** Kind→code mapping (edit.rs:599-611). */
export function editFailureCode(kind: HclEditFailureKind): string {
  switch (kind) {
    case 'WrongSnapshot':
      return 'core.edit.wrong-snapshot@1';
    case 'WrongRole':
      return 'core.edit.wrong-role@1';
    case 'IncompleteTarget':
      return 'core.edit.incomplete-target@1';
    case 'DuplicateAttribute':
      return codeHclEditDuplicateAttribute;
    case 'BlockInTfvars':
      return codeHclEditBlockInTfvars;
    case 'ConflictingEdits':
    case 'OverlappingOwnership':
      return 'core.edit.conflicting-edits@1';
    case 'UnrepresentableValue':
      return codeHclEditUnrepresentable;
    case 'ResourceLimit':
      return 'core.edit.resource-limit@1';
    case 'NewDocumentFormationFailed':
      return 'core.edit.formation-failed@1';
  }
}
