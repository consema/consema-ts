/**
 * Exact Java UTF-16 string content: immutable code units, well-formedness,
 * and canonical UTF16BE/1 bytes.
 *
 * authority:
 *  - RFC 0010 §4 (docs/rfcs/0010-java-properties-profiles-v1.md:108-131):
 *    a Java `String` is an ordered sequence of UTF-16 code units; escape
 *    processing can produce an unpaired surrogate such as `\uD800`, and
 *    rejecting or replacing it would be silent corruption; the native
 *    `JavaString` value provides strict equality over exact code units, a
 *    bounded `WellFormedUnicode | UnpairedSurrogate` status, conversion to
 *    a Unicode string only when well formed, and canonical `UTF16BE/1`
 *    bytes (even-length big-endian code units, no BOM, no normalization)
 *  - crates/consema-properties/src/lib.rs:124-131 (JavaStringStatus),
 *    :133-204 (JavaString), :196-206 (JavaStringConversionError),
 *    :814-830 (classify_java_string)
 *  - exact-wire failure codes: crates/consema-protocol/src/error_registry.rs:
 *    :1111-1121 (java-properties.java-string.invalid-wire@1,
 *    java-properties.java-string.non-canonical-wire@1) — reserved by the
 *    wire layer; this module carries no registered codes itself
 *
 * Design (TypeScript-idiomatic): an immutable class over a frozen code-unit
 * array (host JS strings cannot represent unpaired surrogates faithfully as
 * scalars, so exact Java content lives in its own unit array). Strict
 * equality compares code units exactly. `utf16beBytes` renders the canonical
 * wire form; `toUnicode` throws the typed conversion error when the content
 * is not well-formed Unicode.
 */

/** Whether exact Java UTF-16 units form Unicode scalar text (lib.rs:124-131; RFC 0010 §4). */
export type JavaStringStatus = 'WellFormedUnicode' | 'UnpairedSurrogate';

/** An exact Java string cannot enter a Unicode-only host string (lib.rs:196-206). */
export class JavaStringConversionError extends Error {
  constructor() {
    super('Java UTF-16 string contains an unpaired surrogate');
    this.name = 'JavaStringConversionError';
  }
}

/** Exact Java string content represented as immutable UTF-16 code units (lib.rs:133-139). */
export class JavaString {
  readonly #codeUnits: readonly number[];
  readonly #status: JavaStringStatus;

  private constructor(codeUnits: readonly number[], status: JavaStringStatus) {
    this.#codeUnits = Object.freeze([...codeUnits]);
    this.#status = status;
  }

  /** Creates exact Java content and computes surrogate well-formedness (lib.rs:141-147). */
  static fromCodeUnits(codeUnits: readonly number[]): JavaString {
    return new JavaString(codeUnits, classifyJavaString(codeUnits));
  }

  /** Converts one valid Unicode scalar string to its exact UTF-16 units (lib.rs:149-153). */
  static fromUnicode(value: string): JavaString {
    const units: number[] = [];
    for (let index = 0; index < value.length; index++) {
      units.push(value.charCodeAt(index));
    }
    return JavaString.fromCodeUnits(units);
  }

  /** Exact ordered Java UTF-16 code units (lib.rs:155-159); the returned array is frozen. */
  codeUnits(): readonly number[] {
    return this.#codeUnits;
  }

  /** Canonical BOM-free big-endian `UTF16BE/1` bytes (lib.rs:161-168; RFC 0010 §4). */
  utf16beBytes(): Uint8Array {
    const bytes = new Uint8Array(this.#codeUnits.length * 2);
    for (let index = 0; index < this.#codeUnits.length; index++) {
      const unit = this.#codeUnits[index];
      bytes[index * 2] = (unit >>> 8) & 0xff;
      bytes[index * 2 + 1] = unit & 0xff;
    }
    return bytes;
  }

  /** Canonical lowercase-hex `UTF16BE/1` rendering for tests and diagnostics. */
  utf16beHex(): string {
    let output = '';
    for (const byte of this.utf16beBytes()) {
      output += byte.toString(16).padStart(2, '0');
    }
    return output;
  }

  /** Exact surrogate pairing status (lib.rs:170-174). */
  status(): JavaStringStatus {
    return this.#status;
  }

  /** Converts only well-formed Java content to a Unicode string (lib.rs:176-179). */
  toUnicode(): string {
    let output = '';
    for (const unit of this.#codeUnits) {
      output += String.fromCharCode(unit);
    }
    if (this.#status === 'UnpairedSurrogate') {
      throw new JavaStringConversionError();
    }
    return output;
  }

  /** Strict equality over exact UTF-16 code units (lib.rs:182-194). */
  equals(other: JavaString): boolean {
    if (this.#codeUnits.length !== other.#codeUnits.length) {
      return false;
    }
    for (let index = 0; index < this.#codeUnits.length; index++) {
      if (this.#codeUnits[index] !== other.#codeUnits[index]) {
        return false;
      }
    }
    return true;
  }

  /** Exact code-unit equality against canonical UTF16BE/1 wire bytes (query.rs:653-660). */
  equalsUtf16be(expected: Uint8Array): boolean {
    if (this.#codeUnits.length * 2 !== expected.length) {
      return false;
    }
    for (let index = 0; index < this.#codeUnits.length; index++) {
      const unit = this.#codeUnits[index];
      if (
        expected[index * 2] !== ((unit >>> 8) & 0xff) ||
        expected[index * 2 + 1] !== (unit & 0xff)
      ) {
        return false;
      }
    }
    return true;
  }
}

/** Classifies surrogate pairing (lib.rs:814-830): high+low pairs pass, any other surrogate is unpaired. */
function classifyJavaString(units: readonly number[]): JavaStringStatus {
  let index = 0;
  while (index < units.length) {
    const unit = units[index];
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = units[index + 1];
      if (next !== undefined && next >= 0xdc00 && next <= 0xdfff) {
        index += 2;
        continue;
      }
      return 'UnpairedSurrogate';
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      return 'UnpairedSurrogate';
    }
    index += 1;
  }
  return 'WellFormedUnicode';
}
