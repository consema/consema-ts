/**
 * Pure TypeScript SHA-256 (FIPS 180-4) and the frozen content digest.
 *
 * authority:
 *  - RFC 0003 §3: the v1 content digest is SHA-256 over the complete
 *    original byte sequence with no decoding, BOM removal, newline
 *    normalization, or metadata mixed in; `algorithm` is exactly "sha256"
 *    and `hex` is exactly 64 lowercase hexadecimal characters
 *    (docs/rfcs/0003-source-syntax-query-and-patch-v1.md:47-54)
 *  - vector digests: conformance/vectors/source-v1.json:6-16
 *    ("source.digest.sha256-empty", "source.digest.sha256-abc")
 *  - Rust: crates/consema-document/src/source.rs:15-54 (ContentDigest)
 *
 * Design (TypeScript-idiomatic): a zero-dependency FIPS 180-4
 * implementation operating on Uint8Array; the 64 constant words and the
 * initial hash state are the standard FIPS 180-4 §4.2.2 / §5.3.3 tables.
 * ContentDigest is an immutable value type: the underlying 32 bytes are
 * frozen at construction, and `toHex()` is the canonical 64-lowercase-hex
 * presentation required by the source contract.
 */

/** FIPS 180-4 §4.2.2: first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** FIPS 180-4 §5.3.3: first 32 bits of the fractional parts of the square roots of the first 8 primes. */
const H0: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
];

function rotr(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

/** FIPS 180-4 SHA-256 over exact raw bytes; returns the 32 digest bytes. */
export function sha256(bytes: Uint8Array): Uint8Array {
  const length = bytes.length;
  const bitLength = BigInt(length) * 8n;
  // Padding: 0x80, zero bytes until length ≡ 56 (mod 64), then the 64-bit
  // big-endian bit length (FIPS 180-4 §5.1.1).
  const paddedLength = (length + 9 + 63) & ~63;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[length] = 0x80;
  const high = Number(bitLength >> 32n) & 0xffffffff;
  const low = Number(bitLength & 0xffffffffn);
  padded[paddedLength - 8] = (high >>> 24) & 0xff;
  padded[paddedLength - 7] = (high >>> 16) & 0xff;
  padded[paddedLength - 6] = (high >>> 8) & 0xff;
  padded[paddedLength - 5] = high & 0xff;
  padded[paddedLength - 4] = (low >>> 24) & 0xff;
  padded[paddedLength - 3] = (low >>> 16) & 0xff;
  padded[paddedLength - 2] = (low >>> 8) & 0xff;
  padded[paddedLength - 1] = low & 0xff;

  let h0 = H0[0];
  let h1 = H0[1];
  let h2 = H0[2];
  let h3 = H0[3];
  let h4 = H0[4];
  let h5 = H0[5];
  let h6 = H0[6];
  let h7 = H0[7];

  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] =
        (padded[j] << 24) |
        (padded[j + 1] << 16) |
        (padded[j + 2] << 8) |
        padded[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const bigS1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + bigS1 + ch + K[i] + w[i]) >>> 0;
      const bigS0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (bigS0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return Uint8Array.from([
    (h0 >>> 24) & 0xff, (h0 >>> 16) & 0xff, (h0 >>> 8) & 0xff, h0 & 0xff,
    (h1 >>> 24) & 0xff, (h1 >>> 16) & 0xff, (h1 >>> 8) & 0xff, h1 & 0xff,
    (h2 >>> 24) & 0xff, (h2 >>> 16) & 0xff, (h2 >>> 8) & 0xff, h2 & 0xff,
    (h3 >>> 24) & 0xff, (h3 >>> 16) & 0xff, (h3 >>> 8) & 0xff, h3 & 0xff,
    (h4 >>> 24) & 0xff, (h4 >>> 16) & 0xff, (h4 >>> 8) & 0xff, h4 & 0xff,
    (h5 >>> 24) & 0xff, (h5 >>> 16) & 0xff, (h5 >>> 8) & 0xff, h5 & 0xff,
    (h6 >>> 24) & 0xff, (h6 >>> 16) & 0xff, (h6 >>> 8) & 0xff, h6 & 0xff,
    (h7 >>> 24) & 0xff, (h7 >>> 16) & 0xff, (h7 >>> 8) & 0xff, h7 & 0xff,
  ]);
}

/** Stable SHA-256 identity of exact raw source bytes (source.rs:15-54). */
export class ContentDigest {
  readonly #bytes: Uint8Array;

  private constructor(bytes: Uint8Array) {
    // V8 forbids Object.freeze on non-empty typed arrays (TypeError: Cannot
    // freeze array buffer views with elements); immutability is logical —
    // the digest owns its private copy and bytes() is read-only by contract.
    this.#bytes = bytes;
  }

  /** Computes the digest of exact raw bytes (source.rs:20-24). */
  static of(bytes: Uint8Array): ContentDigest {
    return new ContentDigest(sha256(bytes));
  }

  /** Constructs a digest value from an already decoded 32-byte record (source.rs:38-42). */
  static fromBytes(bytes: Uint8Array): ContentDigest {
    if (bytes.length !== 32) {
      throw new RangeError(`content digest must be exactly 32 bytes, got ${bytes.length}`);
    }
    return new ContentDigest(Uint8Array.from(bytes));
  }

  /** Digest algorithm identifier frozen by the v1 source contract (source.rs:27-29). */
  algorithm(): string {
    return 'sha256';
  }

  /** Exact 32 digest bytes; logically immutable (source.rs:32-36) — treat the returned buffer as read-only. */
  bytes(): Uint8Array {
    return this.#bytes;
  }

  /** Lowercase hexadecimal representation (source.rs:45-53). */
  toHex(): string {
    let output = '';
    for (const byte of this.#bytes) {
      output += byte.toString(16).padStart(2, '0');
    }
    return output;
  }

  /** Byte-for-byte digest equality. */
  equals(other: ContentDigest): boolean {
    const left = this.#bytes;
    const right = other.#bytes;
    for (let i = 0; i < 32; i++) {
      if (left[i] !== right[i]) {
        return false;
      }
    }
    return true;
  }
}
