/**
 * Consema document domain (L1) — immutable source snapshots, structural
 * locations, formation, materialization requests, raw-byte patches,
 * untouched-byte proofs, and dry-run edit plans.
 *
 * authority and scope: docs/multi-language-implementation-plan.md §2 L1
 * (document, mirror of Go G1.1); RFC 0016 §3.2 (consema/document package
 * surface); RFC 0003 (source/patch), RFC 0004 (materialization/edit).
 * See each module header for its exact authority citations.
 */

// Errors with frozen registered codes.
export * from './errors.ts';

// Core identity surface.
export { SnapshotIdentity, DocumentAuthority, NodeRef, Span } from './identity.ts';
export type { NodeRole, AssociationPlacement } from './identity.ts';

// Profiles and formation.
export { ProfileId, FormatFamilyId } from './profile.ts';
export { DEFAULT_PARSE_LIMITS } from './formation.ts';
export type { FormationStatus, ParseLimits } from './formation.ts';

// Raw source and encodings.
export {
  WindowsCodePage,
  SourceSnapshot,
  EncodingRequest,
  EncodingFacts,
  binaryEncoding,
  utf8Encoding,
  utf16LeEncoding,
  utf16BeEncoding,
  latin1Encoding,
  windowsCodePageEncoding,
  encodingAsStr,
  encodingIsText,
  bomKindEncoding,
  DEFAULT_SOURCE_LIMITS,
  UNBOUNDED_SOURCE_LIMITS,
  utf8ByteOffset,
  unicodeScalarOffset,
  utf16CodeUnitOffset,
  decodedPositionEquals,
} from './source.ts';
export type {
  SourceEncoding,
  BomPolicy,
  BomKind,
  SourceLimits,
  DecodedPosition,
  DecodedOffset,
} from './source.ts';

// Content identity.
export { ContentDigest, sha256 } from './sha256.ts';

// Structural coverage.
export { StructuralPiece, LosslessStructuralIndex, BinaryRegion, BinaryStructuralIndex } from './structural.ts';
export type { StructuralPieceKind } from './structural.ts';

// Change facts.
export { SourceEdit, NodeMapping, ChangeSet } from './change_set.ts';
export type { NodeMappingStatus } from './change_set.ts';

// Patches and proofs.
export {
  SourceReplacement,
  SourcePatch,
  DEFAULT_SOURCE_PATCH_LIMITS,
} from './source_patch.ts';
export type { SourcePatchLimits } from './source_patch.ts';
export { UntouchedByteRegion, UntouchedByteProof } from './untouched_proof.ts';

// Materialization.
export {
  MaterializationStyleId,
  MaterializationRequest,
  MaterializationReport,
  MaterializedOrigin,
  MaterializationProvenanceEntry,
  MaterializationProvenanceMap,
  FailedMaterializationAttempt,
  CompleteMaterialization,
  newlineBytes,
  DEFAULT_MATERIALIZATION_LIMITS,
} from './materialization.ts';
export type {
  NewlinePolicy,
  MappingPolicy,
  RepresentabilityPolicy,
  MaterializationLimits,
  MaterializationFidelity,
  MaterializationInputLocation,
  MaterializationRelation,
  MaterializationResult,
} from './materialization.ts';

// Operation discovery and edit plans.
export {
  FormatOperationId,
  OperationTargetRoleId,
  OperationArgumentDescriptor,
  FormatOperationDescriptor,
  FormatOperationRegistry,
  FormatOperationRegistryError,
} from './operation.ts';
export type { OperationArgumentKind, OperationSupport, FormatOperationRegistryErrorKind } from './operation.ts';
export { EditPlanSourceId, EditOperationSummary, EditPlan } from './edit_plan.ts';

// Provisional core mirrors (see module headers).
export { ValuePath, AssociationLocation } from './portable_locations.ts';
export type { ValuePathSegment, AssociationRole } from './portable_locations.ts';

// Provisional diagnostic record (core owns the final home).
export { diagnostic, sortDiagnostics } from './diagnostic.ts';
export type { Diagnostic, DiagnosticCategory, DiagnosticSeverity, DiagnosticLocation, RelatedLocation } from './diagnostic.ts';
