/**
 * Shared test helpers for the YAML family (test-only module).
 *
 * The golden transcriptions in this family's tests are transcribed from
 * conformance/vectors/yaml-v1.json (the language-neutral machine-readable
 * authority), not from any other implementation's tests.
 */

/** Encodes one text as UTF-8 bytes. */
export function textToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Encodes one text as UTF-16LE bytes preceded by the UTF-16LE BOM. */
export function utf16LeBytes(text: string): Uint8Array {
  const units: number[] = [0xff, 0xfe];
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    units.push(code & 0xff, code >> 8);
  }
  return Uint8Array.from(units);
}

/** Decodes one UTF-16LE byte sequence (BOM optional) back to text. */
export function utf16LeText(bytes: Uint8Array): string {
  let offset = bytes[0] === 0xff && bytes[1] === 0xfe ? 2 : 0;
  let text = '';
  while (offset + 1 < bytes.length) {
    text += String.fromCharCode(bytes[offset] | (bytes[offset + 1] << 8));
    offset += 2;
  }
  return text;
}

/** Hex-encodes one byte sequence. */
export function toHex(bytes: Uint8Array): string {
  let output = '';
  for (const byte of bytes) {
    output += byte.toString(16).padStart(2, '0');
  }
  return output;
}
