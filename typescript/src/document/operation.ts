/**
 * Versioned discovery contracts for format-owned edit operations.
 *
 * authority: crates/consema-document/src/operation_registry.rs
 *  - FormatOperationId :8-42 (namespaced id + u32 version; Display is
 *    "id@version")
 *  - OperationTargetRoleId :44-72
 *  - OperationArgumentKind :74-89 (closed v1 vocabulary)
 *  - OperationArgumentDescriptor :91-127
 *  - OperationSupport :129-138 (Supported | ExistingTypedCapability |
 *    Unsupported — truthful classification, RFC 0004 §10)
 *  - FormatOperationDescriptor :140-189
 *  - FormatOperationRegistry :191-269 (validation :198-247, canonical
 *    id sort, exact-version descriptor lookup)
 *  - FormatOperationRegistryError :271-305; identifier rules :315-339
 *  - frozen operation ids: RFC 0004 §10 (:247-261)
 *
 * Design (TypeScript-idiomatic): identifiers render "id@version"; the
 * registry is immutable after construction and canonicalizes descriptors
 * by sorting on the exact operation id/version.
 */

import { ProfileId } from './profile.ts';

/** Immutable namespaced operation identifier (operation_registry.rs:8-42). */
export class FormatOperationId {
  readonly #id: string;
  readonly #version: number;

  constructor(id: string, version: number) {
    if (version <= 0 || !Number.isInteger(version)) {
      throw new RangeError(`operation version must be a positive integer, got ${version}`);
    }
    this.#id = id;
    this.#version = version;
  }

  /** Namespaced identifier without its version suffix (operation_registry.rs:26-29). */
  id(): string {
    return this.#id;
  }

  /** Immutable operation version (operation_registry.rs:31-34). */
  version(): number {
    return this.#version;
  }

  /** Canonical "id@version" spelling (operation_registry.rs:38-42). */
  toString(): string {
    return `${this.#id}@${this.#version}`;
  }

  compare(other: FormatOperationId): number {
    if (this.#id !== other.#id) {
      return this.#id < other.#id ? -1 : 1;
    }
    return this.#version - other.#version;
  }

  equals(other: FormatOperationId): boolean {
    return this.#id === other.#id && this.#version === other.#version;
  }
}

/** Versioned semantic role required of an operation target or placement anchor (operation_registry.rs:44-72). */
export class OperationTargetRoleId {
  readonly #id: string;
  readonly #version: number;

  constructor(id: string, version: number) {
    if (version <= 0 || !Number.isInteger(version)) {
      throw new RangeError(`target role version must be a positive integer, got ${version}`);
    }
    this.#id = id;
    this.#version = version;
  }

  /** Namespaced role identifier without its version suffix (operation_registry.rs:62-65). */
  id(): string {
    return this.#id;
  }

  /** Immutable role version (operation_registry.rs:67-70). */
  version(): number {
    return this.#version;
  }

  /** Canonical "id@version" spelling. */
  toString(): string {
    return `${this.#id}@${this.#version}`;
  }
}

/** Closed v1 argument type vocabulary (operation_registry.rs:74-89). */
export type OperationArgumentKind =
  | 'NodeRef'
  | 'String'
  | 'PortableValue'
  | 'Placement'
  | 'ExactBytes'
  | 'RepresentationPolicy';

/** One named field in an operation's immutable argument schema (operation_registry.rs:91-127). */
export class OperationArgumentDescriptor {
  readonly #name: string;
  readonly #kind: OperationArgumentKind;
  readonly #required: boolean;

  constructor(name: string, kind: OperationArgumentKind, required: boolean) {
    this.#name = name;
    this.#kind = kind;
    this.#required = required;
  }

  /** Stable field name (operation_registry.rs:110-114). */
  name(): string {
    return this.#name;
  }

  /** Closed argument kind (operation_registry.rs:116-120). */
  kind(): OperationArgumentKind {
    return this.#kind;
  }

  /** Whether the operation rejects omission of this argument (operation_registry.rs:122-126). */
  required(): boolean {
    return this.#required;
  }
}

/** Truthful implementation support classification (operation_registry.rs:129-138). */
export type OperationSupport = 'Supported' | 'ExistingTypedCapability' | 'Unsupported';

/** One complete discoverable operation contract (operation_registry.rs:140-189). */
export class FormatOperationDescriptor {
  readonly #id: FormatOperationId;
  readonly #targetRole: OperationTargetRoleId;
  readonly #arguments: readonly OperationArgumentDescriptor[];
  readonly #support: OperationSupport;

  constructor(
    id: FormatOperationId,
    targetRole: OperationTargetRoleId,
    arguments_: readonly OperationArgumentDescriptor[],
    support: OperationSupport,
  ) {
    this.#id = id;
    this.#targetRole = targetRole;
    this.#arguments = Object.freeze([...arguments_]);
    this.#support = support;
  }

  /** Immutable operation identifier (operation_registry.rs:166-170). */
  id(): FormatOperationId {
    return this.#id;
  }

  /** Semantic role required of the primary target (operation_registry.rs:172-176). */
  targetRole(): OperationTargetRoleId {
    return this.#targetRole;
  }

  /** Fixed ordered argument schema (operation_registry.rs:178-182). */
  arguments(): readonly OperationArgumentDescriptor[] {
    return this.#arguments;
  }

  /** Truthful implementation support (operation_registry.rs:184-188). */
  support(): OperationSupport {
    return this.#support;
  }
}

/** Registry construction failure before an invalid discovery surface is published (operation_registry.rs:271-305). */
export type FormatOperationRegistryErrorKind =
  | 'InvalidProfile'
  | 'InvalidOperationId'
  | 'InvalidTargetRole'
  | 'InvalidArgumentName'
  | 'DuplicateArgument'
  | 'DuplicateOperation';

export class FormatOperationRegistryError extends Error {
  readonly kind: FormatOperationRegistryErrorKind;
  readonly operationIndex?: number;
  readonly argumentIndex?: number;

  constructor(kind: FormatOperationRegistryErrorKind, operationIndex?: number, argumentIndex?: number) {
    super(
      `operation registry: ${kind}` +
        (operationIndex !== undefined ? ` operation ${operationIndex}` : '') +
        (argumentIndex !== undefined ? ` argument ${argumentIndex}` : ''),
    );
    this.name = 'FormatOperationRegistryError';
    this.kind = kind;
    if (operationIndex !== undefined) this.operationIndex = operationIndex;
    if (argumentIndex !== undefined) this.argumentIndex = argumentIndex;
  }
}

/** Deterministically ordered operation contracts for one exact profile (operation_registry.rs:191-269). */
export class FormatOperationRegistry {
  readonly #profile: ProfileId;
  readonly #operations: readonly FormatOperationDescriptor[];

  private constructor(profile: ProfileId, operations: readonly FormatOperationDescriptor[]) {
    this.#profile = profile;
    this.#operations = Object.freeze([...operations]);
  }

  /** Validates and canonicalizes all descriptors before publishing the registry (operation_registry.rs:198-247). */
  static create(
    profile: ProfileId,
    operations: readonly FormatOperationDescriptor[],
  ): FormatOperationRegistry {
    if (!validNamespacedId(profile.id()) || profile.version() === 0) {
      throw new FormatOperationRegistryError('InvalidProfile');
    }
    for (let operationIndex = 0; operationIndex < operations.length; operationIndex++) {
      const operation = operations[operationIndex];
      if (!validNamespacedId(operation.id().id()) || operation.id().version() === 0) {
        throw new FormatOperationRegistryError('InvalidOperationId', operationIndex);
      }
      if (!validNamespacedId(operation.targetRole().id()) || operation.targetRole().version() === 0) {
        throw new FormatOperationRegistryError('InvalidTargetRole', operationIndex);
      }
      const names = new Set<string>();
      for (let argumentIndex = 0; argumentIndex < operation.arguments().length; argumentIndex++) {
        const argument = operation.arguments()[argumentIndex];
        if (!validArgumentName(argument.name())) {
          throw new FormatOperationRegistryError('InvalidArgumentName', operationIndex, argumentIndex);
        }
        if (names.has(argument.name())) {
          throw new FormatOperationRegistryError('DuplicateArgument', operationIndex, argumentIndex);
        }
        names.add(argument.name());
      }
    }

    const sorted = [...operations].sort((left, right) => left.id().compare(right.id()));
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i - 1].id().equals(sorted[i].id())) {
        throw new FormatOperationRegistryError('DuplicateOperation', i);
      }
    }
    return new FormatOperationRegistry(profile, sorted);
  }

  /** Exact profile whose behavior the registry describes (operation_registry.rs:249-253). */
  profile(): ProfileId {
    return this.#profile;
  }

  /** Canonically ordered operation descriptors (operation_registry.rs:255-259). */
  operations(): readonly FormatOperationDescriptor[] {
    return this.#operations;
  }

  /** Finds one exact operation ID/version (operation_registry.rs:261-268). */
  descriptor(id: FormatOperationId): FormatOperationDescriptor | null {
    let low = 0;
    let high = this.#operations.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const candidate = this.#operations[mid];
      const comparison = candidate.id().compare(id);
      if (comparison === 0) {
        return candidate;
      }
      if (comparison < 0) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return null;
  }
}

/** Dot-separated lowercase/digit/hyphen identifier rule (operation_registry.rs:315-331). */
function validNamespacedId(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  return value.split('.').every((segment) => {
    if (segment.length === 0) {
      return false;
    }
    for (let i = 0; i < segment.length; i++) {
      const code = segment.charCodeAt(i);
      const isLower = code >= 0x61 && code <= 0x7a;
      const isDigit = code >= 0x30 && code <= 0x39;
      const isHyphen = code === 0x2d;
      if (!isLower && !isDigit && !isHyphen) {
        return false;
      }
    }
    const first = segment.charCodeAt(0);
    const last = segment.charCodeAt(segment.length - 1);
    const firstOk = (first >= 0x61 && first <= 0x7a) || (first >= 0x30 && first <= 0x39);
    const lastOk = (last >= 0x61 && last <= 0x7a) || (last >= 0x30 && last <= 0x39);
    return firstOk && lastOk;
  });
}

/** Lower snake case argument-name rule (operation_registry.rs:333-339). */
function validArgumentName(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  const first = value.charCodeAt(0);
  if (!(first >= 0x61 && first <= 0x7a)) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const isLower = code >= 0x61 && code <= 0x7a;
    const isDigit = code >= 0x30 && code <= 0x39;
    const isUnderscore = code === 0x5f;
    if (!isLower && !isDigit && !isUnderscore) {
      return false;
    }
  }
  return true;
}
