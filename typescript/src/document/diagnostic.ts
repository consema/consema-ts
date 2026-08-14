/**
 * Structured deterministic diagnostics (provisional document-domain record).
 *
 * authority: consema-rs/consema-core/src/diagnostic.rs — category
 * vocabulary (:7-30), severity (:33-41), DiagnosticLocation (:44-52),
 * RelatedLocation (:55-61), Diagnostic fields (:64-82), and the
 * deterministic sort (:106-123).
 *
 * NOTE (home): `Diagnostic` is the document-domain record. The L0 core
 * module (`typescript/src/core/`) does not publish a Diagnostic of its
 * own; the document domain record lives here and is consumed by
 * MaterializationReport, EditPlan.report, and ChangeSet diagnostics
 * (there is no pending re-export to perform).
 *
 * Design (TypeScript-idiomatic): category and severity are closed
 * string-literal unions; `arguments` is a key-sorted Map so iteration
 * order is deterministic (the Rust BTreeMap invariant, diagnostic.rs);
 * `occurrence` is a bigint (u64 on the wire, diagnostic.rs).
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

/** A snapshot-neutral location used by common protocols (diagnostic.rs). */
export interface DiagnosticLocation {
  /** Optional snapshot identity encoded by a document implementation. */
  readonly snapshot: bigint | null;
  /** Half-open byte start. */
  readonly startByte: bigint;
  /** Half-open byte end. */
  readonly endByte: bigint;
}

/** A related diagnostic location and its stable role (diagnostic.rs). */
export interface RelatedLocation {
  /** Stable namespaced relationship label. */
  readonly role: string;
  /** Related location. */
  readonly location: DiagnosticLocation;
}

/** Machine-readable diagnostic (diagnostic.rs). */
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

/** Creates a minimal diagnostic (diagnostic.rs). */
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
 * (diagnostic.rs). Returns a new array; the input is untouched.
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
