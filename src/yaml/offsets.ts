/**
 * One-pass decoded-scalar to raw-byte offset resolution.
 *
 * authority: crates/consema-yaml/src/offsets.rs (the exact single-pass walk
 * semantics :16-80). The YAML parse resolves every lexeme and node boundary
 * in non-decreasing order; a single forward walk with constant-width
 * per-scalar raw advances reproduces the exact same offsets as
 * `SourceSnapshot.rawByteAt(UnicodeScalar)` in O(source + lookups) total.
 *
 * Design (TypeScript-idiomatic): a mutable cursor class; lookups may be
 * repeated and need not be sorted (a lookup behind the cursor restarts the
 * walk, exactly like offsets.rs:57-62).
 */

import { SourceSnapshot } from '../document/source.ts';
import type { SourceEncoding } from '../document/source.ts';

/** Resolves decoded Unicode scalar offsets to exact raw byte offsets (offsets.rs:16-22). */
export class RawByteResolver {
  readonly #text: string;
  readonly #encoding: SourceEncoding;
  #scalar = 0;
  #rawByte = 0;
  #utf8Byte = 0;

  constructor(source: SourceSnapshot) {
    const text = source.decodedText();
    if (text === null) {
      throw new Error('internal: YAML sources always decode to text');
    }
    this.#text = text;
    this.#encoding = source.encodingFacts().selected();
  }

  /** Exact raw byte offset of one decoded scalar boundary (offsets.rs:43-46). */
  resolve(scalar: number): number {
    this.#advanceTo(scalar);
    return this.#rawByte;
  }

  /** Decoded-text byte offset of one decoded scalar boundary (offsets.rs:52-55). */
  decodedByteAt(scalar: number): number {
    this.#advanceTo(scalar);
    return this.#utf8Byte;
  }

  #advanceTo(scalar: number): void {
    if (scalar < this.#scalar) {
      this.#scalar = 0;
      this.#rawByte = 0;
      this.#utf8Byte = 0;
    }
    let remaining = scalar - this.#scalar;
    let seen = 0;
    // The skip target is the cursor captured BEFORE the loop: `#scalar`
    // grows as we advance, so comparing `seen` against the live field would
    // skip every other character.
    const initialScalar = this.#scalar;
    // Walk the text one code point at a time: JS string indices are code
    // units, not UTF-8 bytes, so a slice by `#utf8Byte` would under-advance
    // whenever the decoded text contains non-ASCII characters (e.g. a BOM).
    for (const character of this.#text) {
      if (seen < initialScalar) {
        seen += 1;
        continue;
      }
      if (remaining === 0) {
        break;
      }
      this.#rawByte +=
        this.#encoding.kind === 'Utf8'
          ? utf8Length(character)
          : character.length * 2;
      this.#utf8Byte += utf8Length(character);
      this.#scalar += 1;
      remaining -= 1;
    }
  }
}

/** UTF-8 byte length of one code point string. */
function utf8Length(character: string): number {
  const code = character.codePointAt(0)!;
  if (code <= 0x7f) {
    return 1;
  }
  if (code <= 0x7ff) {
    return 2;
  }
  if (code <= 0xffff) {
    return 3;
  }
  return 4;
}
