/**
 * Test-only hex helpers for transcribing conformance vector bytes.
 * Vectors carry raw bytes as lowercase hex strings
 * (conformance/vectors/source-v1.json input.*_hex fields).
 */

export function decodeHex(text: string): Uint8Array {
  if (text.length % 2 !== 0) {
    throw new RangeError(`odd-length hex: ${text}`);
  }
  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const pair = text.slice(i * 2, i * 2 + 2);
    const value = Number.parseInt(pair, 16);
    if (Number.isNaN(value)) {
      throw new RangeError(`invalid hex: ${pair}`);
    }
    bytes[i] = value;
  }
  return bytes;
}

export function encodeHex(bytes: Uint8Array): string {
  let output = '';
  for (const byte of bytes) {
    output += byte.toString(16).padStart(2, '0');
  }
  return output;
}
