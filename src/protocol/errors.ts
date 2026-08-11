/**
 * Typed protocol failures with frozen registered codes.
 *
 * authority: the Rust ProtocolErrorKind mapping (crates/consema-protocol/src/
 * error.rs); the codes are registered in the semantic-model v1 error
 * registry (core.protocol.*@1; crates/consema-protocol/src/error_registry.rs,
 * transcribed into go/protocol/errors.go for cross-reference).
 *
 * Design (TypeScript-idiomatic): a typed Error subclass with a closed
 * string-literal `kind`, the frozen `code` property, and a JSON-pointer-ish
 * `path` naming the failing record location (mirroring the Rust error paths
 * so the shared vectors' error_path facts match).
 */

/** Closed set of strict protocol failures (the Rust ProtocolErrorKind). */
export type ProtocolErrorKind =
  | 'InvalidJson'
  | 'NonCanonicalJson'
  | 'InvalidPvce'
  | 'UnknownContract'
  | 'SchemaMismatch'
  | 'UnknownField'
  | 'MissingField'
  | 'WrongType'
  | 'InvalidValue'
  | 'ResourceLimit'
  | 'ProcessLocalHandle';

export const codeInvalidJson = 'core.protocol.invalid-json@1';
export const codeNonCanonicalJson = 'core.protocol.non-canonical-json@1';
export const codeInvalidPvce = 'core.protocol.invalid-pvce@1';
export const codeUnknownContract = 'core.protocol.unknown-contract@1';
export const codeSchemaMismatch = 'core.protocol.schema-mismatch@1';
export const codeUnknownField = 'core.protocol.unknown-field@1';
export const codeMissingField = 'core.protocol.missing-field@1';
export const codeWrongType = 'core.protocol.wrong-type@1';
// Package-private like go/protocol/errors.go (unexported consts): the
// core/pvce family owns the public `codeInvalidValue`/`codeResourceLimit`
// names at the package root (index.ts re-exports both modules).
const codeInvalidValue = 'core.protocol.invalid-value@1';
const codeResourceLimit = 'core.protocol.resource-limit@1';
export const codeProcessLocalHandle = 'core.protocol.process-local-handle@1';

const CODES: Record<ProtocolErrorKind, string> = {
  InvalidJson: codeInvalidJson,
  NonCanonicalJson: codeNonCanonicalJson,
  InvalidPvce: codeInvalidPvce,
  UnknownContract: codeUnknownContract,
  SchemaMismatch: codeSchemaMismatch,
  UnknownField: codeUnknownField,
  MissingField: codeMissingField,
  WrongType: codeWrongType,
  InvalidValue: codeInvalidValue,
  ResourceLimit: codeResourceLimit,
  ProcessLocalHandle: codeProcessLocalHandle,
};

/** The typed protocol failure (transport or record level). */
export class ProtocolError extends Error {
  readonly kind: ProtocolErrorKind;
  /** Frozen registered code (RFC 0016 §6). */
  readonly code: string;
  /** Failing record location, e.g. "$.files[0].source_digest". */
  readonly path: string;
  /** Human-facing explanation; never part of conformance comparison. */
  readonly detail: string;

  constructor(kind: ProtocolErrorKind, path: string, detail: string) {
    super(`protocol: ${CODES[kind]} at ${path}: ${detail}`);
    this.name = 'ProtocolError';
    this.kind = kind;
    this.code = CODES[kind];
    this.path = path;
    this.detail = detail;
  }
}

/** The InvalidValue protocol error (the schema::invalid convention). */
export function invalid(path: string, detail: string): ProtocolError {
  return new ProtocolError('InvalidValue', path, detail);
}

/** The ResourceLimit protocol error. */
export function resource(path: string, detail: string): ProtocolError {
  return new ProtocolError('ResourceLimit', path, detail);
}

/** Builds an error with an explicit kind. */
export function protocolError(kind: ProtocolErrorKind, path: string, detail: string): ProtocolError {
  return new ProtocolError(kind, path, detail);
}
