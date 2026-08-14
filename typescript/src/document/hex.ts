/**
 * Test-only hex helpers for transcribing conformance vector bytes.
 * Vectors carry raw bytes as lowercase hex strings
 * (conformance/vectors/source-v1.json input.*_hex fields).
 */

export function decodeHex(text: string): Uint8Array {
  if (text.length % 2 !== 0) {
    throw new RangeError(`odd-length hex: ${text}`);
  }
  // Full-character validation before any per-pair parse (W4-22): the old
  // Number.parseInt(pair, 16) + Number.isNaN guard silently accepted pairs
  // that begin with a hex digit and end with a non-hex character ('0g'
  // parsed as 0x00, 'fz' as 0x0f). Aligned with the strict precedents
  // conformance/helpers.ts hexToBytes and plist/materialization.ts decodeHex.
  if (!/^[0-9a-f]*$/.test(text)) {
    throw new RangeError(`invalid hex: ${text}`);
  }
  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
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
