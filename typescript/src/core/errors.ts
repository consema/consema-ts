/**
 * Typed PVCE/1 codec failures with frozen registered codes.
 *
 * authority: the Rust StableFailure mapping, crates/consema-pvce/src/lib.rs:
 * 1062-1087 (decode) and 1102-1107 (encode). Every kind maps to exactly one
 * frozen `core.pvce.*@1` code. Note: these codes are the codec's stable
 * diagnostic surface; they are not entries of the 187-code error registry
 * (the registry pins core.graph.*@1 and core.pgce.*@1 only — verified in
 * crates/consema-protocol/src/error_registry.rs and both registries agree).
 *
 * The Rust codec additionally defines the extended-record kinds
 * NestedExtendedValue ("core.pvce.nested-extended@1") and ExpectedCoreValue
 * ("core.pvce.expected-core@1"); TypeScript represents the extension root
 * (a plain record), so both kinds are reachable here. The Go implementation
 * has no ExtendedValue type and rejects 0x7f as unknown-tag (documented
 * reachable-code difference; go/core/errors.go:13-20).
 *
 * Design (TypeScript-idiomatic): the kind is a closed string-literal union;
 * `code` is a frozen property of every error instance, so the RFC 0016 §6
 * Code() contract holds without a separate method.
 */

/** Closed set of strict PVCE/1 failure kinds. */
export type PVCEErrorKind =
  | 'InvalidMagic'
  | 'UnsupportedVersion'
  | 'UnexpectedEnd'
  | 'TrailingBytes'
  | 'TrailingPayload'
  | 'TrailingField'
  | 'NonCanonicalVarint'
  | 'VarintOverflow'
  | 'LengthOverflow'
  | 'ResourceLimit'
  | 'UnknownCoreTag'
  | 'InvalidPayload'
  | 'InvalidIntegerSign'
  | 'NonCanonicalInteger'
  | 'NonCanonicalDecimal'
  | 'InvalidUtf8'
  | 'ObjectKeyNotString'
  | 'DuplicateObjectKey'
  | 'InvalidValue'
  | 'InvalidTemporal'
  | 'NestedExtended'
  | 'ExpectedCore';

/** The frozen registered codes (crates/consema-pvce/src/lib.rs:1062-1087). */
export const codeInvalidMagic = 'core.pvce.invalid-magic@1';
export const codeUnsupportedVersion = 'core.pvce.unsupported-version@1';
export const codeUnexpectedEnd = 'core.pvce.unexpected-end@1';
export const codeTrailingBytes = 'core.pvce.trailing-bytes@1';
export const codeTrailingPayload = 'core.pvce.trailing-payload@1';
export const codeTrailingField = 'core.pvce.trailing-field@1';
export const codeNonCanonicalVarint = 'core.pvce.non-canonical-varint@1';
export const codeVarintOverflow = 'core.pvce.varint-overflow@1';
export const codeLengthOverflow = 'core.pvce.length-overflow@1';
export const codeResourceLimit = 'core.pvce.resource-limit@1';
export const codeUnknownTag = 'core.pvce.unknown-tag@1';
export const codeInvalidPayload = 'core.pvce.invalid-payload@1';
export const codeInvalidIntegerSign = 'core.pvce.invalid-integer-sign@1';
export const codeNonCanonicalInteger = 'core.pvce.non-canonical-integer@1';
export const codeNonCanonicalDecimal = 'core.pvce.non-canonical-decimal@1';
export const codeInvalidUtf8 = 'core.pvce.invalid-utf8@1';
export const codeObjectKeyNotString = 'core.pvce.object-key-not-string@1';
export const codeDuplicateObjectKey = 'core.pvce.duplicate-object-key@1';
export const codeInvalidTemporal = 'core.pvce.invalid-temporal@1';
export const codeInvalidValue = 'core.pvce.invalid-value@1';
export const codeNestedExtended = 'core.pvce.nested-extended@1';
export const codeExpectedCore = 'core.pvce.expected-core@1';

const CODES: Record<PVCEErrorKind, string> = {
  InvalidMagic: codeInvalidMagic,
  UnsupportedVersion: codeUnsupportedVersion,
  UnexpectedEnd: codeUnexpectedEnd,
  TrailingBytes: codeTrailingBytes,
  TrailingPayload: codeTrailingPayload,
  TrailingField: codeTrailingField,
  NonCanonicalVarint: codeNonCanonicalVarint,
  VarintOverflow: codeVarintOverflow,
  LengthOverflow: codeLengthOverflow,
  ResourceLimit: codeResourceLimit,
  UnknownCoreTag: codeUnknownTag,
  InvalidPayload: codeInvalidPayload,
  InvalidIntegerSign: codeInvalidIntegerSign,
  NonCanonicalInteger: codeNonCanonicalInteger,
  NonCanonicalDecimal: codeNonCanonicalDecimal,
  InvalidUtf8: codeInvalidUtf8,
  ObjectKeyNotString: codeObjectKeyNotString,
  DuplicateObjectKey: codeDuplicateObjectKey,
  InvalidValue: codeInvalidValue,
  InvalidTemporal: codeInvalidTemporal,
  NestedExtended: codeNestedExtended,
  ExpectedCore: codeExpectedCore,
};

/**
 * The typed PVCE/1 codec failure (encode or decode). `code` is always the
 * frozen registered code, so cross-language error-code parity holds
 * (RFC 0016 §6). The message text is human presentation only.
 */
export class PVCEError extends Error {
  readonly kind: PVCEErrorKind;
  /** Frozen registered code (RFC 0016 §6). */
  readonly code: string;
  /** Resource-limit field name ("stream-bytes", "nesting-depth", ...); undefined otherwise. */
  readonly field?: string;
  /** Offending tag, version, or sign octet; undefined otherwise. */
  readonly value?: bigint;

  constructor(
    kind: PVCEErrorKind,
    code: string,
    options: { field?: string; value?: bigint } = {},
  ) {
    const field = options.field;
    const value = options.value;
    let message: string;
    switch (kind) {
      case 'InvalidMagic':
        message = 'core: PVCE/1 stream magic did not match "PVCE"';
        break;
      case 'UnsupportedVersion':
        message = `core: PVCE/1 unsupported version ${value} (want 1)`;
        break;
      case 'UnexpectedEnd':
        message = 'core: PVCE/1 input ended inside a required field';
        break;
      case 'TrailingBytes':
        message = 'core: PVCE/1 trailing bytes after the root record';
        break;
      case 'TrailingPayload':
        message = `core: PVCE/1 trailing payload bytes after record tag 0x${value?.toString(16)}`;
        break;
      case 'TrailingField':
        message = 'core: PVCE/1 trailing bytes after a nested field';
        break;
      case 'NonCanonicalVarint':
        message = 'core: PVCE/1 non-canonical (non-minimal) unsigned varint';
        break;
      case 'VarintOverflow':
        message = 'core: PVCE/1 unsigned varint exceeded 64 bits';
        break;
      case 'LengthOverflow':
        message = 'core: PVCE/1 length overflow';
        break;
      case 'ResourceLimit':
        message = `core: PVCE/1 resource limit: ${field}`;
        break;
      case 'UnknownCoreTag':
        message = `core: PVCE/1 unknown core tag 0x${value?.toString(16)}`;
        break;
      case 'InvalidPayload':
        message = `core: PVCE/1 invalid payload for record tag 0x${value?.toString(16)}`;
        break;
      case 'InvalidIntegerSign':
        message = `core: PVCE/1 invalid integer sign octet ${value}`;
        break;
      case 'NonCanonicalInteger':
        message = 'core: PVCE/1 non-canonical integer representation';
        break;
      case 'NonCanonicalDecimal':
        message = 'core: PVCE/1 non-canonical decimal representation';
        break;
      case 'InvalidUtf8':
        message = 'core: PVCE/1 string bytes are not valid UTF-8';
        break;
      case 'ObjectKeyNotString':
        message = 'core: PVCE/1 object key record is not a String record';
        break;
      case 'DuplicateObjectKey':
        message = 'core: PVCE/1 object contains a duplicate key';
        break;
      case 'InvalidValue':
        message = 'core: PVCE/1 invalid value';
        break;
      case 'InvalidTemporal':
        message = 'core: PVCE/1 date, time, or offset fields are outside the supported ranges';
        break;
      case 'NestedExtended':
        message = 'core: PVCE/1 extended record cannot be nested in the core tree';
        break;
      case 'ExpectedCore':
        message = 'core: PVCE/1 core-only call encountered an extension root';
        break;
    }
    super(message);
    this.name = 'PVCEError';
    this.kind = kind;
    this.code = code;
    if (field !== undefined) {
      this.field = field;
    }
    if (value !== undefined) {
      this.value = value;
    }
  }
}

/** Builds the typed error for one kind with its frozen code. */
export function pvceError(
  kind: PVCEErrorKind,
  options: { field?: string; value?: bigint } = {},
): PVCEError {
  return new PVCEError(kind, CODES[kind], options);
}
