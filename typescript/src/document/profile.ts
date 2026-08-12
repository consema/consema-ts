/**
 * Stable namespaced identifiers: profiles and format families.
 *
 * authority: crates/consema-document/src/lib.rs
 *  - FormatFamilyId: :344-372 (namespaced format family contract)
 *  - ProfileId: :374-402 (immutable named language profile)
 *  - profile spellings frozen by RFC 0004 §4 ("json.strict@1",
 *    "jsonc.bounded@1", "toml.1.0@1") and RFC 0005/0007 family profiles
 *
 * Design (TypeScript-idiomatic): both identifiers are the same shape
 * (namespaced id + immutable u32 version); `toString()` renders the
 * canonical "id@version" spelling used by the wire contracts.
 */

/** Stable namespaced format family contract (lib.rs:344-372). */
export class FormatFamilyId {
  readonly #id: string;
  readonly #version: number;

  constructor(id: string, version: number) {
    if (version <= 0 || !Number.isInteger(version)) {
      throw new RangeError(`format family version must be a positive integer, got ${version}`);
    }
    this.#id = id;
    this.#version = version;
  }

  /** Namespace (lib.rs:361-364). */
  id(): string {
    return this.#id;
  }

  /** Version (lib.rs:366-370). */
  version(): number {
    return this.#version;
  }

  /** Canonical "id@version" spelling. */
  toString(): string {
    return `${this.#id}@${this.#version}`;
  }

  equals(other: FormatFamilyId): boolean {
    return this.#id === other.#id && this.#version === other.#version;
  }
}

/** Immutable named language profile (lib.rs:374-402). */
export class ProfileId {
  readonly #id: string;
  readonly #version: number;

  constructor(id: string, version: number) {
    if (version <= 0 || !Number.isInteger(version)) {
      throw new RangeError(`profile version must be a positive integer, got ${version}`);
    }
    this.#id = id;
    this.#version = version;
  }

  /** Namespace (lib.rs:392-395). */
  id(): string {
    return this.#id;
  }

  /** Version (lib.rs:397-401). */
  version(): number {
    return this.#version;
  }

  /** Canonical "id@version" spelling. */
  toString(): string {
    return `${this.#id}@${this.#version}`;
  }

  equals(other: ProfileId): boolean {
    return this.#id === other.#id && this.#version === other.#version;
  }
}
