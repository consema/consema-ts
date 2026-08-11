/**
 * Frozen `hcl.native@1` / `hcl.tfvars@1` formation, structure, recovery,
 * and report limits (RFC 0014 §11).
 *
 * authority: crates/consema-hcl/src/lib.rs:166-273 — HclParseLimits
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

/** One complete HCL formation-limit set (lib.rs:179-234). */
export interface HclParseLimits {
  /** Common source, nesting, token, node, and diagnostic limits (lib.rs:181-184). */
  readonly common: ParseLimits;
  /** Maximum decoded UTF-8 bytes (lib.rs:184-186). */
  readonly maxDecodedUtf8Bytes: number;
  /** Maximum decoded Unicode scalars (lib.rs:187-188). */
  readonly maxDecodedScalars: number;
  /** Maximum body nesting depth; the root body is depth 1 (lib.rs:188-189). */
  readonly maxBodyDepth: number;
  /** Maximum expression depth, shared by structural equality and the literal predicate (lib.rs:192-193). */
  readonly maxExpressionDepth: number;
  /** Maximum template nesting depth (interpolations and directives may contain nested templates) (lib.rs:194-195). */
  readonly maxTemplateDepth: number;
  /** Maximum attributes in one body (lib.rs:196-197). */
  readonly maxAttributeCount: number;
  /** Maximum blocks in one body (lib.rs:198-199). */
  readonly maxBlockCount: number;
  /** Maximum labels on one block (lib.rs:200-201). */
  readonly maxLabelCount: number;
  /** Maximum body items (attributes plus blocks) in one body (lib.rs:202-203). */
  readonly maxBodyItemCount: number;
  /** Maximum identifier byte length (attributes, blocks, labels, variables, functions) (lib.rs:204-205). */
  readonly maxIdentifierLen: number;
  /** Maximum quoted-template byte length (lib.rs:206-207). */
  readonly maxStringLen: number;
  /** Maximum canonical-decimal digit count of one number (lib.rs:208-209). */
  readonly maxNumberDigits: number;
  /** Maximum template (quoted or heredoc content) byte length (lib.rs:210-211). */
  readonly maxTemplateLen: number;
  /** Maximum interpolation or directive sequences in one template (lib.rs:212-213). */
  readonly maxTemplateInterpolations: number;
  /** Maximum lines in one heredoc (lib.rs:214-215). */
  readonly maxHeredocLines: number;
  /** Maximum heredoc bytes; bounds the error region of an unterminated heredoc (lib.rs:216-219). */
  readonly maxHeredocBytes: number;
  /** Maximum elements in one tuple constructor (lib.rs:220-221). */
  readonly maxTupleElements: number;
  /** Maximum entries in one object constructor (lib.rs:222-223). */
  readonly maxObjectEntries: number;
  /** Maximum extent of one for-expression (lib.rs:224-225). */
  readonly maxForExtent: number;
  /** Maximum recovery regions in one document (lib.rs:226-227). */
  readonly maxRecoveryRegions: number;
  /** Maximum error regions in one document (lib.rs:228-229). */
  readonly maxErrorRegions: number;
  /** Maximum lossless syntax pieces in one document (lib.rs:230-231). */
  readonly maxSyntaxPieces: number;
  /** Maximum projection, materialization, or edit report events (lib.rs:232-233). */
  readonly maxReportEvents: number;
}

/** The frozen R-3 defaults (lib.rs:245-272). */
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
