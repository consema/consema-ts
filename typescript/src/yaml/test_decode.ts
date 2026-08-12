/**
 * Test-only UTF-8 decode helper for golden byte comparisons.
 */

/** Decodes one UTF-8 byte sequence (replacement for invalid bytes). */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}
