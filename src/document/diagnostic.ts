/**
 * Structured deterministic diagnostics (provisional document-domain record).
 *
 * authority: crates/consema-core/src/diagnostic.rs:5-124 — category
 * vocabulary (:7-30), severity (:33-41), DiagnosticLocation (:44-52),
 * RelatedLocation (:55-61), Diagnostic fields (:64-82), and the
 * deterministic sort (:106-123).
 *
 * NOTE (provisional home): `Diagnostic` is core-domain (it lives in
 * consema-core, not consema-document). The L0 core agent owns
 * `typescript/src/core/` and its Diagnostic is not yet published at
 * blind-write time; the document domain needs a diagnostic record for
 * MaterializationReport, EditPlan.report, and ChangeSet diagnostics, so a
 * faithful local mirror lives here until the core module lands and this
 * module re-exports it (documentation of the pending integration point).
 *
 * Design (TypeScript-idiomatic): category and severity are closed
 * string-literal unions; `arguments` is a key-sorted Map so iteration
 * order is deterministic (the Rust BTreeMap invariant, diagnostic.rs:77);
 * `occurrence` is a bigint (u64 on the wire, diagnostic.rs:81).
 */

export type DiagnosticCategory =
  | 'Lexical'
  | 'Syntax'
  | 'Conformance'
  | 'Semantic'
  | 'Query'
  | 'Projection'
  | 'Materialization'
  | 'Conversion'
  | 'Edit'
  | 'Resource'
  | 'Encoding';

export type DiagnosticSeverity = 'Info' | 'Warning' | 'Error';

/** A snapshot-neutral location used by common protocols (diagnostic.rs:44-52). */
export interface DiagnosticLocation {
  /** Optional snapshot identity encoded by a document implementation. */
  readonly snapshot: bigint | null;
  /** Half-open byte start. */
  readonly startByte: bigint;
  /** Half-open byte end. */
  readonly endByte: bigint;
}

/** A related diagnostic location and its stable role (diagnostic.rs:55-61). */
export interface RelatedLocation {
  /** Stable namespaced relationship label. */
  readonly role: string;
  /** Related location. */
  readonly location: DiagnosticLocation;
}

/** Machine-readable diagnostic (diagnostic.rs:64-82). */
export interface Diagnostic {
  /** Stable namespaced code. */
  readonly code: string;
  /** Stable category. */
  readonly category: DiagnosticCategory;
  /** Presentation severity. */
  readonly severity: DiagnosticSeverity;
  /** Primary location when one exists. */
  readonly primary: DiagnosticLocation | null;
  /** Related locations in stable order. */
  readonly related: readonly RelatedLocation[];
  /** Structured arguments sorted by key. */
  readonly arguments: ReadonlyMap<string, string>;
  /** Stable note identifiers or localized fallback text. */
  readonly notes: readonly string[];
  /** Occurrence ordinal used as the final stable ordering key. */
  readonly occurrence: bigint;
}

/** Creates a minimal diagnostic (diagnostic.rs:85-104). */
export function diagnostic(
  code: string,
  category: DiagnosticCategory,
  severity: DiagnosticSeverity,
  primary: DiagnosticLocation | null,
  occurrence: bigint,
  options: {
    related?: readonly RelatedLocation[];
    arguments?: ReadonlyMap<string, string> | readonly (readonly [string, string])[];
    notes?: readonly string[];
  } = {},
): Diagnostic {
  const entries =
    options.arguments instanceof Map
      ? [...options.arguments.entries()]
      : [...(options.arguments ?? [])];
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return {
    code,
    category,
    severity,
    primary,
    related: options.related ?? [],
    arguments: new Map(entries),
    notes: options.notes ?? [],
    occurrence,
  };
}

/**
 * Sorts diagnostics by source order, then category, code, and occurrence
 * (diagnostic.rs:106-123). Returns a new array; the input is untouched.
 */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((left, right) => {
    const leftStart = left.primary?.startByte ?? BigInt(Number.MAX_SAFE_INTEGER);
    const rightStart = right.primary?.startByte ?? BigInt(Number.MAX_SAFE_INTEGER);
    if (leftStart !== rightStart) {
      return leftStart < rightStart ? -1 : 1;
    }
    if (left.category !== right.category) {
      return left.category < right.category ? -1 : 1;
    }
    if (left.code !== right.code) {
      return left.code < right.code ? -1 : 1;
    }
    if (left.occurrence !== right.occurrence) {
      return left.occurrence < right.occurrence ? -1 : 1;
    }
    return 0;
  });
}
