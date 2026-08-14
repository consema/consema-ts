/**
 * Frozen `hcl.native@1` / `hcl.tfvars@1` formation, structure, recovery,
 * and report limits (RFC 0014 §11).
 *
 * authority: consema-rs/consema-hcl/src/lib.rs — HclParseLimits
 *  (:179-234) and the frozen R-3 defaults (:236-273). The common limits
 *  (`ParseLimits` from the document domain) bound source bytes, generic
 *  nesting, token and node counts, and diagnostics; the flat fields bound
 *  the HCL-specific facts. Every limit failure is a fatal formation failure
 *  or an atomic operation failure, never a truncated success (RFC 0014 §11,
 *  hard gate 4).
 *
 * The vector suite pins the limit names exercised by conformance:
 * conformance/vectors/hcl-v1.json — max_expression_depth (:1786),
 * max_body_depth (:1816), max_number_digits (:1830, :1845),
 * max_attribute_count (:1857), max_block_count (:1871),
 * max_body_item_count (:1887), max_label_count (:1901),
 * max_template_len (:1917), max_heredoc_bytes (:1931),
 * max_tuple_elements (:1945), max_object_entries (:1959).
 *
 * Design (TypeScript-idiomatic): a plain record plus a frozen default
 * instance; the conformance helper `hclParseLimits` merges partial
 * overrides over the defaults so vector cases can set one bound at a time.
 */

import { DEFAULT_PARSE_LIMITS } from '../document/formation.ts';
import type { ParseLimits } from '../document/formation.ts';

/** One complete HCL formation-limit set (lib.rs). */
export interface HclParseLimits {
  /** Common source, nesting, token, node, and diagnostic limits (lib.rs). */
  readonly common: ParseLimits;
  /** Maximum decoded UTF-8 bytes (lib.rs). */
  readonly maxDecodedUtf8Bytes: number;
  /** Maximum decoded Unicode scalars (lib.rs). */
  readonly maxDecodedScalars: number;
  /** Maximum body nesting depth; the root body is depth 1 (lib.rs). */
  readonly maxBodyDepth: number;
  /** Maximum expression depth, shared by structural equality and the literal predicate (lib.rs). */
  readonly maxExpressionDepth: number;
  /** Maximum template nesting depth (interpolations and directives may contain nested templates) (lib.rs). */
  readonly maxTemplateDepth: number;
  /** Maximum attributes in one body (lib.rs). */
  readonly maxAttributeCount: number;
  /** Maximum blocks in one body (lib.rs). */
  readonly maxBlockCount: number;
  /** Maximum labels on one block (lib.rs). */
  readonly maxLabelCount: number;
  /** Maximum body items (attributes plus blocks) in one body (lib.rs). */
  readonly maxBodyItemCount: number;
  /** Maximum identifier byte length (attributes, blocks, labels, variables, functions) (lib.rs). */
  readonly maxIdentifierLen: number;
  /** Maximum quoted-template byte length (lib.rs). */
  readonly maxStringLen: number;
  /** Maximum canonical-decimal digit count of one number (lib.rs). */
  readonly maxNumberDigits: number;
  /** Maximum template (quoted or heredoc content) byte length (lib.rs). */
  readonly maxTemplateLen: number;
  /** Maximum interpolation or directive sequences in one template (lib.rs). */
  readonly maxTemplateInterpolations: number;
  /** Maximum lines in one heredoc (lib.rs). */
  readonly maxHeredocLines: number;
  /** Maximum heredoc bytes; bounds the error region of an unterminated heredoc (lib.rs). */
  readonly maxHeredocBytes: number;
  /** Maximum elements in one tuple constructor (lib.rs). */
  readonly maxTupleElements: number;
  /** Maximum entries in one object constructor (lib.rs). */
  readonly maxObjectEntries: number;
  /** Maximum extent of one for-expression (lib.rs). */
  readonly maxForExtent: number;
  /** Maximum recovery regions in one document (lib.rs). */
  readonly maxRecoveryRegions: number;
  /** Maximum error regions in one document (lib.rs). */
  readonly maxErrorRegions: number;
  /** Maximum lossless syntax pieces in one document (lib.rs). */
  readonly maxSyntaxPieces: number;
  /** Maximum projection, materialization, or edit report events (lib.rs). */
  readonly maxReportEvents: number;
}

/** The frozen R-3 defaults (lib.rs). */
export const DEFAULT_HCL_PARSE_LIMITS: Readonly<HclParseLimits> = Object.freeze({
  common: DEFAULT_PARSE_LIMITS,
  maxDecodedUtf8Bytes: 128 * 1024 * 1024,
  maxDecodedScalars: 64 * 1024 * 1024,
  maxBodyDepth: 128,
  maxExpressionDepth: 24,
  maxTemplateDepth: 256,
  maxAttributeCount: 1_000_000,
  maxBlockCount: 1_000_000,
  maxLabelCount: 1_000_000,
  maxBodyItemCount: 1_000_000,
  maxIdentifierLen: 1024,
  maxStringLen: 16 * 1024 * 1024,
  maxNumberDigits: 100_000,
  maxTemplateLen: 16 * 1024 * 1024,
  maxTemplateInterpolations: 1_000_000,
  maxHeredocLines: 1_000_000,
  maxHeredocBytes: 16 * 1024 * 1024,
  maxTupleElements: 1_000_000,
  maxObjectEntries: 1_000_000,
  maxForExtent: 1_000_000,
  maxRecoveryRegions: 100_000,
  maxErrorRegions: 100_000,
  maxSyntaxPieces: 2_000_000,
  maxReportEvents: 100_000,
});

/**
 * Merges partial vector overrides over the frozen defaults; the vector
 * limit names map one-to-one to the camelCase fields
 * (hcl-v1.json limit cases, :1781-1970).
 */
export function hclParseLimits(overrides: Partial<HclParseLimits> = {}): HclParseLimits {
  return { ...DEFAULT_HCL_PARSE_LIMITS, ...overrides };
}
