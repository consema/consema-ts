/**
 * The frozen CLI exit classes and the pure error classification.
 *
 * authority: RFC 0015 §5 (the six exit classes, their codes 0-5, and the
 * stable error-family → class mapping of §5.2); crates/consema-protocol/src/
 * exit_class.rs. ClassifyErrorCode is a pure function (RFC 0016 §6: "the SDK
 * itself never classifies"); the CLI applies the mapped code only.
 */

/** One of the six frozen CLI exit classes (RFC 0015 §5.1). */
export type ExitClass = 'success' | 'usage' | 'data' | 'limit' | 'precondition' | 'internal';

/** The frozen process exit code of one class (RFC 0015 §5.1). */
export function exitCode(exitClass: ExitClass): number {
  switch (exitClass) {
    case 'success':
      return 0;
    case 'usage':
      return 1;
    case 'data':
      return 2;
    case 'limit':
      return 3;
    case 'precondition':
      return 4;
    case 'internal':
      return 5;
  }
}

/** Parses one canonical envelope name into the closed class set. */
export function parseExitClass(name: string): ExitClass | undefined {
  switch (name) {
    case 'success':
    case 'usage':
    case 'data':
    case 'limit':
    case 'precondition':
    case 'internal':
      return name;
    default:
      return undefined;
  }
}

/**
 * Classifies one exit class into its frozen process exit code — the identity
 * table of RFC 0015 §5.1 (success 0, usage 1, data 2, limit 3,
 * precondition 4, internal 5).
 */
export function classify(exitClass: ExitClass): number {
  return exitCode(exitClass);
}

/**
 * Classifies a stable error code into its frozen exit class — the
 * exhaustive family table of RFC 0015 §5.2:
 *  - cli.usage.* -> usage (1)
 *  - cli.data.* and cli.detection.* (ambiguity) -> data (2)
 *  - cli.limit.* and any *-resource-limit@1 (core or format-local) -> limit (3)
 *  - cli.write.*, cli.interrupted.signal@1, the core.source.patch-*-mismatch@1
 *    precondition family, and core.edit.* conflicts -> precondition (4)
 *  - cli.internal.unclassified@1 -> internal (5)
 *  - core.protocol.* strict-decode failures -> data (2), with
 *    core.protocol.resource-limit@1 overridden to limit
 *  - core.source.* diagnostics carried by FatalFormationFailure -> data (2)
 *  - any code outside these frozen families -> data (2)
 *
 * Report-as-result outcomes classify as success (0) at the outcome level,
 * never through error codes.
 */
export function classifyErrorCode(code: string): ExitClass {
  if (code.startsWith('cli.usage.')) {
    return 'usage';
  }
  if (code.startsWith('cli.data.') || code.startsWith('cli.detection.')) {
    return 'data';
  }
  if (code.startsWith('cli.limit.')) {
    return 'limit';
  }
  if (code.startsWith('cli.write.') || code.startsWith('cli.interrupted.')) {
    return 'precondition';
  }
  if (code.startsWith('cli.internal.')) {
    return 'internal';
  }
  if (code.endsWith('.resource-limit@1')) {
    return 'limit';
  }
  if (code.startsWith('core.source.patch-') && code.endsWith('-mismatch@1')) {
    return 'precondition';
  }
  if (code.startsWith('core.edit.')) {
    return 'precondition';
  }
  return 'data';
}
