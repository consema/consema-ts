/**
 * Document formation: status and parse resource limits.
 *
 * authority:
 *  - FormationStatus: crates/consema-document/src/lib.rs:404-411 (closed
 *    two-value enum Complete | Recovered); RFC 0016 §5.1 (docs/rfcs/
 *    0016-go-api-mapping-v1.md:174 — the 0.13.0 review's F10 disposition:
 *    only the `formation_status` equivalent, no `status` alias)
 *  - ParseLimits fields and defaults: crates/consema-document/src/lib.rs:
 *    614-639 — max_source_bytes 64 MiB, max_nesting_depth 256,
 *    max_token_count 2_000_000, max_node_count 1_000_000,
 *    max_diagnostics 10_000 (cross-checked by go/document/limits.go:5-29)
 *
 * Design (TypeScript-idiomatic): FormationStatus is a closed string-literal
 * union — the compiler proves closure on any exhaustive switch. ParseLimits
 * is a plain record plus a frozen default instance; limits are plain
 * numbers because they are host-size usizes in the Rust authority.
 */

/**
 * Successful document formation state — the closed two-value set
 * (lib.rs:404-411). `Complete`: entire syntax was formed without recovery.
 * `Recovered`: a complete snapshot with explicit recovery structure.
 */
export type FormationStatus = 'Complete' | 'Recovered';

/** Parse resource limits; exceeding one is a fatal formation failure (lib.rs:614-627). */
export interface ParseLimits {
  /** Maximum source bytes. */
  readonly maxSourceBytes: number;
  /** Maximum syntax nesting. */
  readonly maxNestingDepth: number;
  /** Maximum tokens plus trivia/error regions. */
  readonly maxTokenCount: number;
  /** Maximum format syntax nodes. */
  readonly maxNodeCount: number;
  /** Maximum diagnostics before an explicit truncation marker. */
  readonly maxDiagnostics: number;
}

/** The frozen defaults (lib.rs:629-639; go/document/limits.go:21-28). */
export const DEFAULT_PARSE_LIMITS: Readonly<ParseLimits> = Object.freeze({
  maxSourceBytes: 64 * 1024 * 1024,
  maxNestingDepth: 256,
  maxTokenCount: 2_000_000,
  maxNodeCount: 1_000_000,
  maxDiagnostics: 10_000,
});
