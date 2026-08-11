/**
 * Typed graph and PGCE/1 failures with frozen registered codes.
 *
 * authority: the Rust StableFailure mappings
 * (crates/consema-graph/src/lib.rs:230-242 for the builder codes,
 * crates/consema-graph/src/pgce.rs:162-216 for the codec codes). The codes
 * are registered in the error-code registry v5+ (core.graph.invalid@1,
 * core.graph.resource-limit@1, core.pgce.invalid@1, core.pgce.non-
 * canonical@1, core.pgce.resource-limit@1, core.pgce.unsupported-version@1;
 * crates/consema-protocol/src/error_registry.rs:694-724).
 *
 * Design (TypeScript-idiomatic): each failure is a typed Error subclass
 * carrying the frozen `code` property and a closed string-literal `kind`.
 */

/** Closed set of stable graph construction failures (the Rust GraphBuildError). */
export type GraphErrorKind =
  | 'ResourceLimit'
  | 'SizeOverflow'
  | 'UnknownNode'
  | 'WrongGraph'
  | 'DuplicateDefinition'
  | 'UndefinedNode'
  | 'UnreachableNode'
  | 'InvalidTag'
  | 'InvalidUtf8';

export const codeGraphResourceLimit = 'core.graph.resource-limit@1';
export const codeGraphInvalid = 'core.graph.invalid@1';

/** The typed graph construction failure (crates/consema-graph/src/lib.rs:230-242). */
export class GraphError extends Error {
  readonly kind: GraphErrorKind;
  /** Frozen registered code (RFC 0016 §6). */
  readonly code: string;
  /** Resource-limit field name; undefined otherwise. */
  readonly field?: string;
  /** Offending graph-local node ID; undefined for non-node failures. */
  readonly id?: { readonly graph: bigint; readonly index: number };
  readonly observed?: number;
  readonly limit?: number;

  constructor(
    kind: GraphErrorKind,
    options: { field?: string; id?: { readonly graph: bigint; readonly index: number }; observed?: number; limit?: number } = {},
  ) {
    const field = options.field;
    const id = options.id;
    let message: string;
    switch (kind) {
      case 'ResourceLimit':
        message = `graph: resource limit ${field}: observed ${options.observed}, limit ${options.limit}`;
        break;
      case 'SizeOverflow':
        message = 'graph: size overflow';
        break;
      case 'UnknownNode':
        message = `graph: node ${id?.index} was not reserved by this builder`;
        break;
      case 'WrongGraph':
        message = 'graph: node ID belongs to a different builder or completed graph';
        break;
      case 'DuplicateDefinition':
        message = `graph: node ${id?.index} defined more than once`;
        break;
      case 'UndefinedNode':
        message = `graph: node ${id?.index} had no definition at build time`;
        break;
      case 'UnreachableNode':
        message = `graph: node ${id?.index} is not reachable from any root`;
        break;
      case 'InvalidTag':
        message = 'graph: tag is empty or contains ASCII control or whitespace';
        break;
      case 'InvalidUtf8':
        message = 'graph: tag or scalar content is not valid UTF-8';
        break;
    }
    super(message);
    this.name = 'GraphError';
    this.kind = kind;
    this.code =
      kind === 'ResourceLimit' || kind === 'SizeOverflow'
        ? codeGraphResourceLimit
        : codeGraphInvalid;
    if (field !== undefined) {
      this.field = field;
    }
    if (id !== undefined) {
      this.id = id;
    }
    if (options.observed !== undefined) {
      this.observed = options.observed;
    }
    if (options.limit !== undefined) {
      this.limit = options.limit;
    }
  }
}

/** Closed set of strict PGCE/1 failures (the Rust PgceEncode/DecodeError). */
export type PGCEErrorKind =
  | 'InvalidMagic'
  | 'UnsupportedVersion'
  | 'UnexpectedEnd'
  | 'NonMinimalVarint'
  | 'VarintOverflow'
  | 'UnknownNodeKind'
  | 'InvalidUtf8'
  | 'InvalidTag'
  | 'ReferenceOutOfRange'
  | 'NonCanonicalNodeOrder'
  | 'TrailingBytes'
  | 'InvalidGraph'
  | 'NonCanonicalEncoding'
  | 'ResourceLimit'
  | 'InvalidValue';

export const codePGCEInvalid = 'core.pgce.invalid@1';
export const codePGCEResourceLimit = 'core.pgce.resource-limit@1';
export const codePGCENonCanonical = 'core.pgce.non-canonical@1';
export const codePGCEUnsupportedVersion = 'core.pgce.unsupported-version@1';

/** The typed PGCE/1 codec failure (crates/consema-graph/src/pgce.rs:162-216). */
export class PGCEError extends Error {
  readonly kind: PGCEErrorKind;
  /** Frozen registered code (RFC 0016 §6). */
  readonly code: string;
  /** Resource-limit field name; undefined otherwise. */
  readonly field?: string;
  /** Offending version, node-kind octet, or reference; undefined otherwise. */
  readonly value?: bigint;
  /** The wrapped graph construction failure for InvalidGraph; undefined otherwise. */
  readonly cause?: GraphError;

  constructor(
    kind: PGCEErrorKind,
    options: { field?: string; value?: bigint; cause?: GraphError } = {},
  ) {
    const field = options.field;
    const value = options.value;
    let message: string;
    switch (kind) {
      case 'InvalidMagic':
        message = 'graph: PGCE/1 stream magic did not match "PGCE"';
        break;
      case 'UnsupportedVersion':
        message = `graph: PGCE/1 unsupported version ${value} (want 1)`;
        break;
      case 'UnexpectedEnd':
        message = 'graph: PGCE/1 input ended inside a required field';
        break;
      case 'NonMinimalVarint':
        message = 'graph: PGCE/1 non-canonical (non-minimal) unsigned varint';
        break;
      case 'VarintOverflow':
        message = 'graph: PGCE/1 varint or host-size conversion overflowed';
        break;
      case 'UnknownNodeKind':
        message = `graph: PGCE/1 unknown node record octet 0x${value?.toString(16)}`;
        break;
      case 'InvalidUtf8':
        message = 'graph: PGCE/1 string bytes are not valid UTF-8';
        break;
      case 'InvalidTag':
        message = 'graph: PGCE/1 tag is empty or contains ASCII control or whitespace';
        break;
      case 'ReferenceOutOfRange':
        message = `graph: PGCE/1 node reference ${value} is outside node_count`;
        break;
      case 'NonCanonicalNodeOrder':
        message = 'graph: PGCE/1 node records are not ordered by canonical first discovery';
        break;
      case 'TrailingBytes':
        message = 'graph: PGCE/1 trailing bytes after the one complete graph';
        break;
      case 'InvalidGraph':
        message = `graph: PGCE/1 invalid graph: ${options.cause?.message}`;
        break;
      case 'NonCanonicalEncoding':
        message = 'graph: PGCE/1 re-encoding produced different bytes';
        break;
      case 'ResourceLimit':
        message = `graph: PGCE/1 resource limit: ${field}`;
        break;
      case 'InvalidValue':
        message = 'graph: PGCE/1 invalid value';
        break;
    }
    super(message);
    this.name = 'PGCEError';
    this.kind = kind;
    this.code = pgceCode(kind, options.cause);
    if (field !== undefined) {
      this.field = field;
    }
    if (value !== undefined) {
      this.value = value;
    }
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** The frozen code mapping (crates/consema-graph/src/pgce.rs:162-216). */
function pgceCode(kind: PGCEErrorKind, cause?: GraphError): string {
  switch (kind) {
    case 'ResourceLimit':
      return codePGCEResourceLimit;
    case 'UnsupportedVersion':
      return codePGCEUnsupportedVersion;
    case 'NonMinimalVarint':
    case 'NonCanonicalNodeOrder':
    case 'NonCanonicalEncoding':
      return codePGCENonCanonical;
    case 'InvalidGraph':
      return cause !== undefined && (cause.kind === 'ResourceLimit' || cause.kind === 'SizeOverflow')
        ? codePGCEResourceLimit
        : codePGCEInvalid;
    default:
      return codePGCEInvalid;
  }
}
