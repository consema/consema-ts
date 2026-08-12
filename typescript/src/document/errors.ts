/**
 * Typed document-domain failures with frozen registered codes.
 *
 * authority (frozen codes — the EXACT registry spellings, do not guess):
 *  - ErrorCodeRegistry v7: crates/consema-protocol/src/error_registry.rs
 *    core.source.invalid-utf8@1            :207 (Lexical, 0.1.0)
 *    core.source.encoding-conflict@1       :366 (Encoding, 0.4.0)
 *    core.source.invalid-sequence@1        :372 (Lexical, 0.4.0)
 *    core.source.patch-base-mismatch@1     :381 (Edit, 0.4.0)
 *    core.source.patch-original-mismatch@1 :387 (Edit, 0.4.0)
 *    core.source.patch-target-mismatch@1   :393 (Edit, 0.4.0)
 *    core.source.resource-limit@1          :399 (Resource, 0.4.0)
 *    core.source.unsupported-bom@1         :405 (Encoding, 0.4.0)
 *    core.source.code-page-required@1      :967 (Encoding, 0.8.0)
 *    core.source.unsupported-code-page@1   :973 (Encoding, 0.8.0)
 *    core.protocol.invalid-value@1         :87  (protocol)
 *    core.parse.resource-limit@1           :39  (parse)
 *  - materialization codes (RFC 0004 §17, ErrorCodeRegistry v3):
 *    core.materialization.invalid-request@1 ... unsupported-style@1
 *    (crates/consema-protocol/src/error_registry.rs:556-604)
 *  - kind→code mapping authority:
 *    SourceError: crates/consema-conformance/src/source_v1.rs:410-421 and
 *      crates/consema-document/src/lib.rs:676-706 (FatalFormationFailure)
 *    SourcePatchError: crates/consema-document/src/source_patch.rs:434-459
 *    MaterializationFailure: crates/consema-document/src/materialization.rs:379-391
 *  - the vector suite pins the codes end-to-end:
 *    conformance/vectors/source-v1.json:57,63,69,75,81,129,135,141,147,153,159,165,171
 *
 * NOTE: there are NO `core.document.*@1` error codes in the v7 registry;
 * the only `core.document.*` frozen name is the capability
 * `core.document.exact-roundtrip@1` (crates/consema-protocol/src/registry.rs:513).
 * Document-domain failures therefore carry `core.source.*@1`,
 * `core.protocol.invalid-value@1`, or `core.materialization.*@1` codes.
 * LocationError has no registered codes at all: the vector suite compares
 * its frozen enum NAME (source_v1.rs:423-436), e.g. "NoDecodedText".
 *
 * Design (TypeScript-idiomatic): every kind is a closed string-literal
 * union; `code` is a frozen property of every error instance, so the
 * RFC 0016 §6 `Code()` contract holds without a separate method. Message
 * text is human presentation only and never participates in conformance
 * comparison (RFC 0016 §1.1).
 */

// ---------------------------------------------------------------------------
// Frozen codes
// ---------------------------------------------------------------------------

export const codeSourceInvalidUtf8 = 'core.source.invalid-utf8@1';
export const codeSourceEncodingConflict = 'core.source.encoding-conflict@1';
export const codeSourceInvalidSequence = 'core.source.invalid-sequence@1';
export const codeSourcePatchBaseMismatch = 'core.source.patch-base-mismatch@1';
export const codeSourcePatchOriginalMismatch = 'core.source.patch-original-mismatch@1';
export const codeSourcePatchTargetMismatch = 'core.source.patch-target-mismatch@1';
export const codeSourceResourceLimit = 'core.source.resource-limit@1';
export const codeSourceUnsupportedBom = 'core.source.unsupported-bom@1';
export const codeSourceCodePageRequired = 'core.source.code-page-required@1';
export const codeSourceUnsupportedCodePage = 'core.source.unsupported-code-page@1';
export const codeProtocolInvalidValue = 'core.protocol.invalid-value@1';
export const codeParseResourceLimit = 'core.parse.resource-limit@1';
import { ValuePath } from './portable_locations.ts';
import type { Kind } from '../core/value.ts';

export const codeMaterializationInvalidRequest = 'core.materialization.invalid-request@1';
export const codeMaterializationUnsupportedProfile = 'core.materialization.unsupported-profile@1';
export const codeMaterializationUnsupportedStyle = 'core.materialization.unsupported-style@1';
export const codeMaterializationUnsupportedEncoding = 'core.materialization.unsupported-encoding@1';
export const codeMaterializationUnsupportedNewline = 'core.materialization.unsupported-newline@1';
export const codeMaterializationUnrepresentable = 'core.materialization.unrepresentable@1';
export const codeMaterializationResourceLimit = 'core.materialization.resource-limit@1';
export const codeMaterializationFormationFailed = 'core.materialization.formation-failed@1';

// ---------------------------------------------------------------------------
// SourceError — stable source construction failure (source.rs:668-708)
// ---------------------------------------------------------------------------

/** Recognized but unsupported Unicode marker (source.rs:718-725). */
export type UnsupportedBomKind = 'Utf32Le' | 'Utf32Be';

export type SourceErrorKind =
  | 'InvalidUtf8'
  | 'InvalidSequence'
  | 'EncodingConflict'
  | 'UnsupportedBom'
  | 'ResourceLimit'
  | 'OffsetOverflow';

/** Stable source construction failure (crates/consema-document/src/source.rs:668-708). */
export class SourceError extends Error {
  readonly kind: SourceErrorKind;
  /** Frozen registered code (kind→code: conformance source_v1.rs:410-421; lib.rs:676-706). */
  readonly code: string;
  /** InvalidUtf8: prefix length that was valid UTF-8. */
  readonly validUpTo?: number;
  /** InvalidSequence: the encoding whose sequence failed; the first bad byte offset. */
  readonly encoding?: string;
  readonly byteOffset?: number;
  /** EncodingConflict: the three conflicting assertions, when present. */
  readonly bom?: string;
  readonly declaration?: string;
  readonly callerOverride?: string;
  /** UnsupportedBom: the rejected marker. */
  readonly unsupportedBom?: UnsupportedBomKind;
  /** ResourceLimit: stable limit name, observed amount, configured maximum. */
  readonly limitName?: string;
  readonly observed?: number;
  readonly limit?: number;

  constructor(
    kind: SourceErrorKind,
    options: {
      validUpTo?: number;
      encoding?: string;
      byteOffset?: number;
      bom?: string;
      declaration?: string;
      callerOverride?: string;
      unsupportedBom?: UnsupportedBomKind;
      limitName?: string;
      observed?: number;
      limit?: number;
    } = {},
  ) {
    const code = sourceErrorCode(kind);
    super(
      `source: ${kind}${options.limitName !== undefined ? ` (${options.limitName})` : ''}`,
    );
    this.name = 'SourceError';
    this.kind = kind;
    this.code = code;
    if (options.validUpTo !== undefined) this.validUpTo = options.validUpTo;
    if (options.encoding !== undefined) this.encoding = options.encoding;
    if (options.byteOffset !== undefined) this.byteOffset = options.byteOffset;
    if (options.bom !== undefined) this.bom = options.bom;
    if (options.declaration !== undefined) this.declaration = options.declaration;
    if (options.callerOverride !== undefined) this.callerOverride = options.callerOverride;
    if (options.unsupportedBom !== undefined) this.unsupportedBom = options.unsupportedBom;
    if (options.limitName !== undefined) this.limitName = options.limitName;
    if (options.observed !== undefined) this.observed = options.observed;
    if (options.limit !== undefined) this.limit = options.limit;
  }
}

/**
 * Kind→code mapping (conformance source_v1.rs:410-421; the `from_utf8`
 * compat path additionally maps InvalidUtf8 to core.source.invalid-utf8@1
 * per crates/consema-document/src/lib.rs:676-679).
 */
export function sourceErrorCode(kind: SourceErrorKind): string {
  switch (kind) {
    case 'InvalidUtf8':
      return codeSourceInvalidUtf8;
    case 'InvalidSequence':
      return codeSourceInvalidSequence;
    case 'EncodingConflict':
      return codeSourceEncodingConflict;
    case 'UnsupportedBom':
      return codeSourceUnsupportedBom;
    case 'ResourceLimit':
    case 'OffsetOverflow':
      return codeSourceResourceLimit;
  }
}

// ---------------------------------------------------------------------------
// LocationError — span, identity, or coverage failure (lib.rs:581-604)
// ---------------------------------------------------------------------------

/**
 * Span, identity, or coverage failure.
 *
 * Frozen names: the vector suite compares these exact spellings
 * (conformance/vectors/source-v1.json:99,117 "NoDecodedText",
 * "IncompleteStructuralCoverage"; the full name table is the conformance
 * runner crates/consema-conformance/src/source_v1.rs:423-436). There is no
 * registered error code for any location failure.
 */
export type LocationErrorKind =
  | 'InvertedSpan'
  | 'WrongSnapshot'
  | 'IncompleteStructuralCoverage'
  | 'OutOfBounds'
  | 'NoDecodedText'
  | 'NotDecodedBoundary'
  | 'DecodedOffsetNotBoundary'
  | 'WrongRole'
  | 'InvalidBinaryRegionKind'
  | 'DuplicateStructuralIdentity';

export class LocationError extends Error {
  readonly kind: LocationErrorKind;
  /** The frozen enum name the vector suite compares (source_v1.rs:423-436). */
  readonly name: LocationErrorKind;
  /** No registered error code exists for location failures. */
  readonly code: undefined = undefined;

  constructor(kind: LocationErrorKind) {
    super(`location: ${kind}`);
    this.name = kind;
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// SourcePatchError — patch construction or application failure
// ---------------------------------------------------------------------------

export type SourcePatchErrorKind =
  | 'ChangeSetMismatch'
  | 'InvalidReplacement'
  | 'ReplacementOrder'
  | 'DuplicateInsertion'
  | 'BaseMismatch'
  | 'OriginalMismatch'
  | 'TargetMismatch'
  | 'EncodingMismatch'
  | 'ResourceLimit'
  | 'Source';

/** Stable source patch construction or application failure (source_patch.rs:387-432). */
export class SourcePatchError extends Error {
  readonly kind: SourcePatchErrorKind;
  /** Frozen registered code (kind→code: source_patch.rs:434-459). */
  readonly code: string;
  /** Zero-based replacement/position index for positional kinds. */
  readonly index?: number;
  /** ResourceLimit / wrapped SourceError: stable limit name, observed, limit. */
  readonly limitName?: string;
  readonly observed?: number;
  readonly limit?: number;
  /** Source: the wrapped source construction failure. */
  readonly source?: SourceError;

  constructor(
    kind: SourcePatchErrorKind,
    options: { index?: number; limitName?: string; observed?: number; limit?: number; source?: SourceError } = {},
  ) {
    super(`source patch: ${kind}${options.index !== undefined ? ` at ${options.index}` : ''}`);
    this.name = 'SourcePatchError';
    this.kind = kind;
    this.code = sourcePatchErrorCode(kind, options.source);
    if (options.index !== undefined) this.index = options.index;
    if (options.limitName !== undefined) this.limitName = options.limitName;
    if (options.observed !== undefined) this.observed = options.observed;
    if (options.limit !== undefined) this.limit = options.limit;
    if (options.source !== undefined) this.source = options.source;
  }
}

/** Kind→code mapping (crates/consema-document/src/source_patch.rs:434-459). */
function sourcePatchErrorCode(kind: SourcePatchErrorKind, source?: SourceError): string {
  switch (kind) {
    case 'BaseMismatch':
      return codeSourcePatchBaseMismatch;
    case 'OriginalMismatch':
      return codeSourcePatchOriginalMismatch;
    case 'TargetMismatch':
      return codeSourcePatchTargetMismatch;
    case 'EncodingMismatch':
      // EncodingMismatch and Source(EncodingConflict) both carry
      // core.source.encoding-conflict@1 (source_patch.rs:442-444).
      return codeSourceEncodingConflict;
    case 'ResourceLimit':
      return codeSourceResourceLimit;
    case 'Source':
      return sourceErrorCode(source?.kind ?? 'ResourceLimit');
    case 'InvalidReplacement':
    case 'ReplacementOrder':
    case 'DuplicateInsertion':
    case 'ChangeSetMismatch':
      return codeProtocolInvalidValue;
  }
}

// ---------------------------------------------------------------------------
// SourcePatchRedactionError — review-redaction selection failure
// ---------------------------------------------------------------------------

/** Review-redaction selection failure; patch bytes and application facts are unchanged (source_patch.rs:367-377). */
export type SourcePatchRedactionErrorKind = 'AllocationFailed' | 'UnknownReplacement';

export class SourcePatchRedactionError extends Error {
  readonly kind: SourcePatchRedactionErrorKind;
  readonly index?: number;

  constructor(kind: SourcePatchRedactionErrorKind, index?: number) {
    super(`source patch redaction: ${kind}${index !== undefined ? ` at ${index}` : ''}`);
    this.name = 'SourcePatchRedactionError';
    this.kind = kind;
    if (index !== undefined) this.index = index;
  }
}

// ---------------------------------------------------------------------------
// UntouchedByteProofError — proof construction or verification failure
// ---------------------------------------------------------------------------

export type UntouchedByteProofErrorKind =
  | 'EncodingMismatch'
  | 'InvalidReplacement'
  | 'ReplacementOrder'
  | 'DuplicateInsertion'
  | 'OriginalMismatch'
  | 'TargetMismatch'
  | 'CoordinateOverflow'
  | 'InvalidRegion'
  | 'DigestMismatch'
  | 'ProofMismatch';

/** Proof construction or verification failure (untouched_proof.rs:134-172); no registered codes. */
export class UntouchedByteProofError extends Error {
  readonly kind: UntouchedByteProofErrorKind;
  readonly index?: number;
  readonly code: undefined = undefined;

  constructor(kind: UntouchedByteProofErrorKind, index?: number) {
    super(`untouched-byte proof: ${kind}${index !== undefined ? ` at ${index}` : ''}`);
    this.name = 'UntouchedByteProofError';
    this.kind = kind;
    if (index !== undefined) this.index = index;
  }
}

// ---------------------------------------------------------------------------
// EditPlanError — edit-plan construction failure (edit_plan.rs:199-211)
// ---------------------------------------------------------------------------

export type EditPlanErrorKind = 'InvalidSourceId' | 'InvalidOperationSummary' | 'OperationMetadataMismatch';

/** Edit-plan construction failure before a transferable plan exists (edit_plan.rs:199-211); no registered codes. */
export class EditPlanError extends Error {
  readonly kind: EditPlanErrorKind;
  readonly index?: number;
  readonly code: undefined = undefined;

  constructor(kind: EditPlanErrorKind, index?: number) {
    super(`edit plan: ${kind}${index !== undefined ? ` at ${index}` : ''}`);
    this.name = 'EditPlanError';
    this.kind = kind;
    if (index !== undefined) this.index = index;
  }
}

// ---------------------------------------------------------------------------
// MaterializationFailure — stable materialization failure category
// ---------------------------------------------------------------------------

export type MaterializationFailureKind =
  | 'InvalidRequest'
  | 'UnsupportedProfile'
  | 'UnsupportedStyle'
  | 'UnsupportedEncoding'
  | 'UnsupportedNewline'
  | 'Unrepresentable'
  | 'ResourceLimit'
  | 'FormationFailed';

/** Stable materialization failure category (materialization.rs:327-351); codes at materialization.rs:379-391. */
export class MaterializationFailure extends Error {
  readonly kind: MaterializationFailureKind;
  /** Frozen registered code (materialization.rs:379-391; RFC 0004 §17). */
  readonly code: string;
  /** InvalidRequest / ResourceLimit: the stable reason or limit name. */
  readonly reason?: string;
  /** Unrepresentable: stable portable input path and unrepresentable core kind (materialization.rs:340-347). */
  readonly path?: ValuePath;
  readonly valueKind?: Kind;

  constructor(
    kind: MaterializationFailureKind,
    options: { reason?: string; path?: ValuePath; valueKind?: Kind } = {},
  ) {
    super(
      `materialization: ${kind}${options.reason !== undefined ? ` (${options.reason})` : ''}`,
    );
    this.name = 'MaterializationFailure';
    this.kind = kind;
    this.code = materializationFailureCode(kind);
    if (options.reason !== undefined) this.reason = options.reason;
    if (options.path !== undefined) this.path = options.path;
    if (options.valueKind !== undefined) this.valueKind = options.valueKind;
  }
}

/** Kind→code mapping (crates/consema-document/src/materialization.rs:379-391). */
export function materializationFailureCode(kind: MaterializationFailureKind): string {
  switch (kind) {
    case 'InvalidRequest':
      return codeMaterializationInvalidRequest;
    case 'UnsupportedProfile':
      return codeMaterializationUnsupportedProfile;
    case 'UnsupportedStyle':
      return codeMaterializationUnsupportedStyle;
    case 'UnsupportedEncoding':
      return codeMaterializationUnsupportedEncoding;
    case 'UnsupportedNewline':
      return codeMaterializationUnsupportedNewline;
    case 'Unrepresentable':
      return codeMaterializationUnrepresentable;
    case 'ResourceLimit':
      return codeMaterializationResourceLimit;
    case 'FormationFailed':
      return codeMaterializationFormationFailed;
  }
}
