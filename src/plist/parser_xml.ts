/**
 * Lossless `plist.xml@1` formation (RFC 0013 §2.1, §3, §4, §8.2, §12).
 *
 * authority: crates/consema-plist/src/parser_xml.rs
 *  - source contract §2.1: bounded SourceSnapshot, UTF-8/UTF-16 document-
 *    entity table (:365-460, plist.xml.encoding@1 :454)
 *  - element vocabulary and classification :503-586
 *  - frame state and dict association rules :588-666
 *  - token dispatch :688-785 (declaration :787-892, processing
 *    instruction :924-968, comment :970-997, doctype :999-1105 with
 *    validate_doctype :1054-1085, element start :1107-1257, attribute
 *    :1259-1341, tag ends :1352-1477, close frame :1479-1600)
 *  - value grammar: build_value :1603-1779 (integer/real/date/data/
 *    boolean/string), parse_integer :2453-2516, parse_real :2521-2572,
 *    parse_date :2580-2632 (calendar validation :2615-2624,
 *    days_from_civil :2653-2660), decode_base64 :2684-2756, reference
 *    resolution :1925-2060, line-end normalization :2417-2439
 *  - finish :2149-2316 (root-value-count, gap coverage, sorting)
 *  - diagnostic spellings: the `plist.parse.*@1` codes cited in errors.ts
 *  - RFC 0013 §4 (grammar), §8.2 (lossless kinds), §12 (limits)
 *
 * RECORDED DIVERGENCE RISK (blind-write, L3): the Rust parser uses the
 * `xmlparser 0.13.6` tokenizer (RFC 0013 §13). TypeScript has no XML
 * tokenizer in the standard library; this module owns a small XML 1.0
 * tokenizer over the decoded UTF-8 bytes with the same error-resync
 * behavior (jump to the last byte, resume at the next `<`). The vectors
 * exercise only well-formed markup, so conformance is unaffected; a
 * differential tokenization audit is recorded as a follow-up.
 *
 * Design (TypeScript-idiomatic): one deterministic forward pass over the
 * decoded UTF-8 bytes (mapped to raw-byte spans through the SourceSnapshot
 * boundary index); value elements prove independently and contribute to
 * the native arena in close-tag order, exactly like the Rust arena
 * ordinals; recovery never invents a closing tag or value.
 */

import { DocumentAuthority, Span } from '../document/identity.ts';
import { LosslessStructuralIndex, StructuralPiece } from '../document/structural.ts';
import { SourceSnapshot } from '../document/source.ts';
import { diagnostic, sortDiagnostics } from '../document/diagnostic.ts';
import type { Diagnostic } from '../document/diagnostic.ts';
import type { FormationStatus } from '../document/formation.ts';
import {
  classifyPlistElement,
  plistCloseKind,
  plistElementIsScalar,
  plistOpenKind,
} from './syntax.ts';
import type { PlistElementKind, PlistSyntaxKind } from './syntax.ts';
import { FatalFormationFailure } from './errors.ts';
import type { PlistParseLimits } from './profile.ts';
import { PlistDocument } from './document.ts';
import {
  PlistArenaError,
  PlistDocument as PlistNativeDocument,
  PlistDocumentBuilder,
  PlistReal,
  plistBooleanValue,
  plistDataValue,
  plistDateValue,
  plistIntegerValue,
  plistRealValue,
  plistStringValue,
  PLIST_EPOCH_OFFSET_UNIX,
} from './native.ts';
import type { PlistValue } from './native.ts';

/** Byte length of `<!DOCTYPE`. */
const DOCTYPE_OPEN_BYTES = 9;
/** Byte length of `<?xml`. */
const DECLARATION_OPEN_BYTES = 5;
/** Byte length of `<![CDATA[`. */
const CDATA_OPEN_BYTES = 9;
/** Byte length of `<!--`. */
const COMMENT_OPEN_BYTES = 4;
/** Exact plist DOCTYPE identifiers (RFC 0013 §4.1; parser_xml.rs:62-64). */
const PLIST_DOCTYPE_PUBLIC = '-//Apple//DTD PLIST 1.0//EN';
const PLIST_DOCTYPE_SYSTEM = 'http://www.apple.com/DTDs/PropertyList-1.0.dtd';
/** Exact root version value (RFC 0013 §4.2; parser_xml.rs:66). */
const PLIST_VERSION = '1.0';

// ---------------------------------------------------------------------------
// XML 1.0 tokenizer over decoded UTF-8 bytes
// ---------------------------------------------------------------------------

type XmlToken =
  | { readonly kind: 'Declaration'; readonly start: number; readonly end: number; readonly version: string; readonly encoding: string | null }
  | { readonly kind: 'ProcessingInstruction'; readonly start: number; readonly end: number; readonly target: string; readonly content: string | null }
  | { readonly kind: 'Comment'; readonly start: number; readonly end: number; readonly text: string }
  | { readonly kind: 'DtdStart'; readonly start: number; readonly end: number; readonly name: string; readonly external: ExternalId | null }
  | { readonly kind: 'EmptyDtd'; readonly start: number; readonly end: number; readonly name: string; readonly external: ExternalId | null }
  | { readonly kind: 'DtdEnd'; readonly start: number; readonly end: number }
  | { readonly kind: 'ElementStart'; readonly start: number; readonly end: number; readonly prefix: string; readonly local: string; readonly name: string }
  | { readonly kind: 'Attribute'; readonly start: number; readonly end: number; readonly nameEnd: number; readonly prefix: string; readonly local: string; readonly value: string }
  | { readonly kind: 'ElementEnd'; readonly start: number; readonly end: number; readonly empty: boolean; readonly closeName: string | null }
  | { readonly kind: 'Text'; readonly start: number; readonly end: number; readonly text: string }
  | { readonly kind: 'Cdata'; readonly start: number; readonly end: number; readonly text: string };

interface ExternalId {
  readonly kind: 'Public';
  readonly publicId: string;
  readonly systemId: string;
}

/** Scans one XML token at `pos`; `null` marks a tokenizer error (resync at next `<`). */
function nextXmlToken(bytes: Uint8Array, pos: number): { readonly token: XmlToken; readonly next: number } | null {
  if (pos >= bytes.length) {
    return null;
  }
  const byte = bytes[pos];
  if (byte !== 0x3c /* < */) {
    // Text run until the next markup start.
    let end = pos;
    while (end < bytes.length && bytes[end] !== 0x3c) {
      end += 1;
    }
    return {
      token: { kind: 'Text', start: pos, end, text: decodeUtf8Slice(bytes, pos, end) },
      next: end,
    };
  }
  if (startsWith(bytes, pos, '<?')) {
    return scanMarkupTail(bytes, pos, '?>', (end) => {
      const inner = decodeUtf8Slice(bytes, pos + 2, end);
      const targetEnd = inner.search(/[\s?]/);
      const target = targetEnd === -1 ? inner : inner.slice(0, targetEnd);
      if (target === 'xml') {
        return { kind: 'Declaration', start: pos, end: end + 2, version: '', encoding: null };
      }
      const content = targetEnd === -1 ? null : inner.slice(targetEnd);
      return { kind: 'ProcessingInstruction', start: pos, end: end + 2, target, content };
    });
  }
  if (startsWith(bytes, pos, '<!--')) {
    const close = findBytes(bytes, pos + 4, '-->');
    if (close === -1) {
      return null;
    }
    return {
      token: {
        kind: 'Comment',
        start: pos,
        end: close + 3,
        text: decodeUtf8Slice(bytes, pos + 4, close),
      },
      next: close + 3,
    };
  }
  if (startsWith(bytes, pos, '<![CDATA[')) {
    const close = findBytes(bytes, pos + CDATA_OPEN_BYTES, ']]>');
    if (close === -1) {
      return null;
    }
    return {
      token: {
        kind: 'Cdata',
        start: pos,
        end: close + 3,
        text: decodeUtf8Slice(bytes, pos + CDATA_OPEN_BYTES, close),
      },
      next: close + 3,
    };
  }
  if (startsWith(bytes, pos, '<!DOCTYPE')) {
    return scanDoctype(bytes, pos);
  }
  if (startsWith(bytes, pos, '</')) {
    const end = findByte(bytes, pos + 2, 0x3e /* > */);
    if (end === -1) {
      return null;
    }
    const name = decodeUtf8Slice(bytes, pos + 2, end).trim();
    return {
      token: { kind: 'ElementEnd', start: pos, end: end + 1, empty: false, closeName: name },
      next: end + 1,
    };
  }
  if (byte === 0x3c) {
    // Element start: <name ...> or <name .../>.
    let at = pos + 1;
    const nameStart = at;
    while (at < bytes.length && isNameByte(bytes[at])) {
      at += 1;
    }
    if (at === nameStart) {
      return null;
    }
    const fullName = decodeUtf8Slice(bytes, nameStart, at);
    const colon = fullName.indexOf(':');
    const prefix = colon === -1 ? '' : fullName.slice(0, colon);
    const local = colon === -1 ? fullName : fullName.slice(colon + 1);
    let tagEnd = -1;
    let empty = false;
    while (at < bytes.length) {
      if (bytes[at] === 0x3e /* > */) {
        tagEnd = at;
        break;
      }
      if (bytes[at] === 0x2f /* / */ && at + 1 < bytes.length && bytes[at + 1] === 0x3e) {
        tagEnd = at + 1;
        empty = true;
        break;
      }
      // Skip one quoted attribute value so `>` inside quotes is not markup.
      if (bytes[at] === 0x22 /* " */ || bytes[at] === 0x27 /* ' */) {
        const quote = bytes[at];
        at += 1;
        while (at < bytes.length && bytes[at] !== quote) {
          at += 1;
        }
      }
      at += 1;
    }
    if (tagEnd === -1) {
      return null;
    }
    return {
      token: { kind: 'ElementStart', start: pos, end: tagEnd + 1, prefix, local, name: fullName },
      next: tagEnd + 1,
    };
  }
  return null;
}

/** Scans attributes of one element open tag (called between the name and the tag end). */
function nextXmlAttribute(
  bytes: Uint8Array,
  from: number,
  tagEnd: number,
): { readonly attr: XmlToken | null; readonly next: number } {
  let at = from;
  while (at < tagEnd && isWsByte(bytes[at])) {
    at += 1;
  }
  if (at >= tagEnd) {
    return { attr: null, next: at };
  }
  const nameStart = at;
  while (at < tagEnd && isNameByte(bytes[at])) {
    at += 1;
  }
  if (at === nameStart) {
    return { attr: null, next: at };
  }
  const name = decodeUtf8Slice(bytes, nameStart, at);
  const colon = name.indexOf(':');
  const prefix = colon === -1 ? '' : name.slice(0, colon);
  const local = colon === -1 ? name : name.slice(colon + 1);
  while (at < tagEnd && isWsByte(bytes[at])) {
    at += 1;
  }
  if (at >= tagEnd || bytes[at] !== 0x3d /* = */) {
    return { attr: null, next: at };
  }
  at += 1;
  while (at < tagEnd && isWsByte(bytes[at])) {
    at += 1;
  }
  if (at >= tagEnd || (bytes[at] !== 0x22 && bytes[at] !== 0x27)) {
    return { attr: null, next: at };
  }
  const quote = bytes[at];
  const valueStart = at + 1;
  let end = valueStart;
  while (end < tagEnd && bytes[end] !== quote) {
    end += 1;
  }
  if (end >= tagEnd) {
    return { attr: null, next: at };
  }
  return {
    attr: {
      kind: 'Attribute',
      start: nameStart,
      end: end + 1,
      nameEnd: at,
      prefix,
      local,
      value: decodeUtf8Slice(bytes, valueStart, end),
    },
    next: end + 1,
  };
}

/** Scans one `<!DOCTYPE ...>` with an optional internal subset. */
function scanDoctype(
  bytes: Uint8Array,
  pos: number,
): { readonly token: XmlToken; readonly next: number } | null {
  let at = pos + DOCTYPE_OPEN_BYTES;
  while (at < bytes.length && isWsByte(bytes[at])) {
    at += 1;
  }
  const nameStart = at;
  while (at < bytes.length && isNameByte(bytes[at])) {
    at += 1;
  }
  const name = decodeUtf8Slice(bytes, nameStart, at);
  let external: ExternalId | null = null;
  while (at < bytes.length && isWsByte(bytes[at])) {
    at += 1;
  }
  if (startsWith(bytes, at, 'SYSTEM')) {
    at += 6;
    const system = scanQuoted(bytes, at);
    if (system === null) {
      return null;
    }
    at = system.next;
  } else if (startsWith(bytes, at, 'PUBLIC')) {
    at += 6;
    const publicId = scanQuoted(bytes, at);
    if (publicId === null) {
      return null;
    }
    at = publicId.next;
    const systemId = scanQuoted(bytes, at);
    if (systemId === null) {
      return null;
    }
    at = systemId.next;
    external = { kind: 'Public', publicId: publicId.value, systemId: systemId.value };
  }
  while (at < bytes.length && isWsByte(bytes[at])) {
    at += 1;
  }
  if (at < bytes.length && bytes[at] === 0x5b /* [ */) {
    // Internal subset: scan to the matching `]` then `>`.
    at += 1;
    while (at < bytes.length && bytes[at] !== 0x5d /* ] */) {
      at += 1;
    }
    if (at >= bytes.length) {
      return null;
    }
    at += 1;
    while (at < bytes.length && isWsByte(bytes[at])) {
      at += 1;
    }
    if (at >= bytes.length || bytes[at] !== 0x3e) {
      return null;
    }
    return {
      token: { kind: 'DtdStart', start: pos, end: at + 1, name, external },
      next: at + 1,
    };
  }
  if (at >= bytes.length || bytes[at] !== 0x3e) {
    return null;
  }
  return {
    token: { kind: 'EmptyDtd', start: pos, end: at + 1, name, external },
    next: at + 1,
  };
}

function scanQuoted(bytes: Uint8Array, at: number): { readonly value: string; readonly next: number } | null {
  while (at < bytes.length && isWsByte(bytes[at])) {
    at += 1;
  }
  if (at >= bytes.length || (bytes[at] !== 0x22 && bytes[at] !== 0x27)) {
    return null;
  }
  const quote = bytes[at];
  const start = at + 1;
  let end = start;
  while (end < bytes.length && bytes[end] !== quote) {
    end += 1;
  }
  if (end >= bytes.length) {
    return null;
  }
  return { value: decodeUtf8Slice(bytes, start, end), next: end + 1 };
}

/** Scans to a closing sequence and builds a token through `build`. */
function scanMarkupTail(
  bytes: Uint8Array,
  pos: number,
  close: string,
  build: (end: number) => XmlToken,
): { readonly token: XmlToken; readonly next: number } | null {
  const end = findBytes(bytes, pos + 2, close);
  if (end === -1) {
    return null;
  }
  return { token: build(end), next: end + close.length };
}

function startsWith(bytes: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > bytes.length) {
    return false;
  }
  for (let index = 0; index < text.length; index++) {
    if (bytes[at + index] !== text.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

function findBytes(bytes: Uint8Array, from: number, text: string): number {
  outer: for (let at = from; at + text.length <= bytes.length; at++) {
    for (let index = 0; index < text.length; index++) {
      if (bytes[at + index] !== text.charCodeAt(index)) {
        continue outer;
      }
    }
    return at;
  }
  return -1;
}

function findByte(bytes: Uint8Array, from: number, byte: number): number {
  for (let at = from; at < bytes.length; at++) {
    if (bytes[at] === byte) {
      return at;
    }
  }
  return -1;
}

function isNameByte(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    (byte >= 0x30 && byte <= 0x39) ||
    byte === 0x2d ||
    byte === 0x2e ||
    byte === 0x5f ||
    byte === 0x3a
  );
}

function isWsByte(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function isWsChar(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r';
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function decodeUtf8Slice(bytes: Uint8Array, start: number, end: number): string {
  return utf8Decoder.decode(bytes.slice(start, end));
}

// ---------------------------------------------------------------------------
// Value grammar helpers (parser_xml.rs:2451-2767)
// ---------------------------------------------------------------------------

/** Signed 64-bit integer grammar (RFC 0013 §4.5). */
export function parsePlistInteger(content: string): bigint | null {
  const bytes = content.trim().split('').filter((c) => !isWsChar(c));
  let index = 0;
  let negative = false;
  if (bytes[0] === '-' || bytes[0] === '+') {
    negative = bytes[0] === '-';
    index = 1;
  }
  while (index < bytes.length && isWsChar(bytes[index])) {
    index += 1;
  }
  const hex =
    bytes[index] === '0' && (bytes[index + 1] === 'x' || bytes[index + 1] === 'X');
  const start = hex ? index + 2 : index;
  let end = start;
  while (
    end < bytes.length &&
    (hex ? /[0-9a-fA-F]/.test(bytes[end]) : /[0-9]/.test(bytes[end]))
  ) {
    end += 1;
  }
  if (end === start) {
    return null;
  }
  while (end < bytes.length && isWsChar(bytes[end])) {
    end += 1;
  }
  if (end !== bytes.length) {
    return null;
  }
  const digits = bytes.slice(start, end).join('');
  let magnitude: bigint;
  try {
    magnitude = BigInt(hex ? `0x${digits}` : digits);
  } catch {
    return null;
  }
  if (negative) {
    if (magnitude > 1n << 63n) {
      return null;
    }
    return magnitude === 1n << 63n ? -(1n << 63n) : -magnitude;
  }
  if (magnitude > (1n << 63n) - 1n) {
    return null;
  }
  return magnitude;
}

/** Real grammar (RFC 0013 §4.6). */
export function parsePlistReal(content: string): number | null {
  const trimmed = content.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'nan') return Number.NaN;
  if (lower === 'inf' || lower === '+inf' || lower === 'infinity' || lower === '+infinity') return Infinity;
  if (lower === '-inf' || lower === '-infinity') return -Infinity;
  if (!/^[+-]?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * Date grammar (RFC 0013 §4.7): `[-]YYYY-MM-DDTHH:MM:SSZ` with calendar
 * validation; the value is the exact double seconds since the plist epoch
 * (parser_xml.rs:2580-2632).
 */
export function parsePlistDate(content: string): number | null {
  const match = /^(-?)([0-9]+)-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z$/.exec(content);
  if (match === null) {
    return null;
  }
  const negative = match[1] === '-';
  const yearText = match[2];
  if (BigInt(yearText) > 0xffffffffn) {
    return null;
  }
  const year = negative ? -Number(yearText) : Number(yearText);
  const month = Number(match[3]);
  const day = Number(match[4]);
  const hour = Number(match[5]);
  const minute = Number(match[6]);
  const second = Number(match[7]);
  if (month < 1 || month > 12) {
    return null;
  }
  if (day === 0 || day > daysInMonth(year, month)) {
    return null;
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const days = daysFromCivil(year, month, day);
  const time = hour * 3600 + minute * 60 + second;
  const unix = days * 86400 + time;
  return unix - PLIST_EPOCH_OFFSET_UNIX;
}

/** Proleptic Gregorian calendar days since the Unix epoch (Hinnant's `days_from_civil`). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = y >= 0 ? y : y - 399;
  const eraFloor = Math.floor(era / 400);
  const yearOfEra = y - eraFloor * 400;
  const dayOfYear = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return eraFloor * 146097 + dayOfEra - 719468;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

/** Strict base64 decoding with the standard alphabet (RFC 0013 §4.8). */
export function decodePlistBase64(content: string): Uint8Array | null {
  const compact: number[] = [];
  for (const character of content) {
    if (!isWsChar(character)) {
      compact.push(character.charCodeAt(0));
    }
  }
  const len = compact.length;
  if (len === 0) {
    return new Uint8Array(0);
  }
  if (len % 4 === 1) {
    return null;
  }
  let end = len;
  let padding = 0;
  while (end > 0 && compact[end - 1] === 0x3d /* = */) {
    end -= 1;
    padding += 1;
  }
  if (padding > 2) {
    return null;
  }
  if (compact.slice(0, end).includes(0x3d)) {
    return null;
  }
  const validPadding =
    padding === 0 ? end % 4 === 0 : padding === 1 ? end % 4 === 3 : padding === 2 ? end % 4 === 2 : false;
  if (!validPadding) {
    return null;
  }
  const outLen =
    Math.floor(end / 4) * 3 + (padding === 1 ? 2 : padding === 2 ? 1 : 0);
  const out = new Uint8Array(outLen);
  let at = 0;
  let written = 0;
  while (at + 4 <= end) {
    const s = [base64Value(compact[at])!, base64Value(compact[at + 1])!, base64Value(compact[at + 2])!, base64Value(compact[at + 3])!];
    if (s.some((value) => value === null)) {
      return null;
    }
    out[written] = (s[0] << 2) | (s[1] >> 4);
    out[written + 1] = ((s[1] & 0x0f) << 4) | (s[2] >> 2);
    out[written + 2] = ((s[2] & 0x03) << 6) | s[3];
    written += 3;
    at += 4;
  }
  if (at < end) {
    const s0 = base64Value(compact[at]);
    const s1 = base64Value(compact[at + 1]);
    const s2 = at + 2 < end ? base64Value(compact[at + 2]) : 0;
    if (s0 === null || s1 === null || s2 === null) {
      return null;
    }
    out[written] = (s0 << 2) | (s1 >> 4);
    written += 1;
    if (at + 2 < end) {
      out[written] = ((s1 & 0x0f) << 4) | (s2 >> 2);
    }
  }
  return out;
}

function base64Value(byte: number): number | null {
  if (byte >= 0x41 && byte <= 0x5a) return byte - 0x41;
  if (byte >= 0x61 && byte <= 0x7a) return byte - 0x61 + 26;
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30 + 52;
  if (byte === 0x2b) return 62;
  if (byte === 0x2f) return 63;
  return null;
}

/** XML 1.0 `Char` production (parser_xml.rs:2442-2449). */
function isXmlCharCode(code: number): boolean {
  return (
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

// ---------------------------------------------------------------------------
// Frame and parser state
// ---------------------------------------------------------------------------

/** Ordered association state of one open `<dict>` (parser_xml.rs:588-595). */
interface DictState {
  readonly entries: Array<{ readonly key: string; readonly value: number }>;
  readonly groups: Map<string, number>;
  pendingKey: string | null;
  expectValue: boolean;
}

type FrameValue =
  | { readonly kind: 'None' }
  | { readonly kind: 'Root' }
  | { readonly kind: 'Dict'; readonly state: DictState }
  | { readonly kind: 'Array'; readonly elements: number[] };

/** One open element frame (parser_xml.rs:610-628). */
interface Frame {
  readonly kind: PlistElementKind | null;
  readonly name: string;
  readonly openStart: number;
  openEnd: number;
  tagCursor: number;
  unknownSubtreeStart: number | null;
  valueAllowed: boolean;
  value: FrameValue;
  content: string;
  scalarUnproven: boolean;
  rootVersion: string | null;
  selfClosing: boolean;
}

type TextPosition = 'Outside' | 'Container' | 'Boolean' | 'Scalar';

/** Bounded ordered diagnostic recording with the house truncation marker. */
class DiagnosticSink {
  readonly #diagnostics: Diagnostic[] = [];
  readonly #max: number;
  #occurrence = 0n;
  #truncated = false;

  constructor(max: number) {
    this.#max = max;
  }

  push(d: Diagnostic): void {
    const withOccurrence = { ...d, occurrence: this.#occurrence };
    this.#occurrence += 1n;
    if (this.#diagnostics.length < this.#max) {
      this.#diagnostics.push(withOccurrence);
    } else if (!this.#truncated) {
      this.#truncated = true;
      this.#diagnostics.push({
        code: 'core.diagnostic.truncated@1',
        category: 'Resource',
        severity: 'Warning',
        primary: null,
        related: [],
        arguments: new Map(),
        notes: [],
        occurrence: this.#occurrence,
      });
    }
  }

  finish(): readonly Diagnostic[] {
    return sortDiagnostics(this.#diagnostics);
  }
}

/** One pending syntax piece (span in raw bytes + kind). */
interface Piece {
  readonly start: number;
  readonly end: number;
  readonly kind: PlistSyntaxKind;
  readonly structural: 'Token' | 'Trivia' | 'ErrorRegion';
}

/** Formation state for one XML source (parser_xml.rs:648-665). */
class Parser {
  readonly #source: SourceSnapshot;
  readonly #decoded: Uint8Array;
  readonly #authority: DocumentAuthority;
  readonly #limits: PlistParseLimits;
  readonly #sink: DiagnosticSink;
  #recovered = false;
  readonly #pieces: Piece[] = [];
  readonly #stack: Frame[] = [];
  #unknownDepth = 0;
  #doctypeBodyStart: number | null = null;
  #anyTopLevel = false;
  #plistRootSeen = false;
  #rootValueCount = 0;
  #rootValueRef: number | null = null;
  readonly #arena: PlistDocumentBuilder;
  #errorRegionCount = 0;

  constructor(source: SourceSnapshot, decoded: Uint8Array, limits: PlistParseLimits) {
    this.#source = source;
    this.#decoded = decoded;
    this.#authority = DocumentAuthority.fresh();
    this.#limits = limits;
    this.#sink = new DiagnosticSink(limits.common.maxDiagnostics);
    this.#arena = new PlistDocumentBuilder({
      maxObjects: limits.maxObjectCount,
      maxContainerDepth: limits.maxContainerDepth,
    });
  }

  // -- helpers ---------------------------------------------------------------

  /** Whether no element is open (prolog/epilog positions). */
  stackEmpty(): boolean {
    return this.#stack.length === 0;
  }

  rawSpan(start: number, end: number): Span {
    const rawStart = this.#source.rawByteAt({ kind: 'Utf8Byte', value: start });
    const rawEnd = this.#source.rawByteAt({ kind: 'Utf8Byte', value: end });
    return this.#authority.span(rawStart, rawEnd);
  }

  pushPiece(
    start: number,
    end: number,
    kind: PlistSyntaxKind,
    structural: 'Token' | 'Trivia' | 'ErrorRegion',
  ): void {
    if (this.#pieces.length >= this.#limits.maxSyntaxPieces) {
      throw FatalFormationFailure.resourceLimit(
        'syntax-pieces',
        this.#pieces.length,
        this.#limits.maxSyntaxPieces,
      );
    }
    this.#pieces.push({ start, end, kind, structural });
    if (structural === 'ErrorRegion') {
      this.#errorRegionCount += 1;
      if (this.#errorRegionCount > this.#limits.maxRecoveryRegions) {
        throw FatalFormationFailure.resourceLimit(
          'recovery-regions',
          this.#errorRegionCount,
          this.#limits.maxRecoveryRegions,
        );
      }
    }
  }

  recover(
    code: string,
    category: Diagnostic['category'],
    start: number,
    end: number,
    arguments_: ReadonlyArray<readonly [string, string]> = [],
  ): void {
    this.#recovered = true;
    this.#sink.push(
      diagnostic(code, category, 'Error', this.rawSpan(start, end).diagnosticLocation(), 0n, {
        arguments: arguments_,
      }),
    );
  }

  recoverNoLocation(
    code: string,
    category: Diagnostic['category'],
    arguments_: ReadonlyArray<readonly [string, string]> = [],
  ): void {
    this.#recovered = true;
    this.#sink.push(
      diagnostic(code, category, 'Error', null, 0n, { arguments: arguments_ }),
    );
  }

  /** One tokenizer-error region plus the well-formedness diagnostic (parser_xml.rs:2118-2147). */
  recoverErrorRegion(start: number, end: number): void {
    this.#recovered = true;
    if (this.#unknownDepth === 0) {
      this.pushPiece(start, end, 'error-region', 'ErrorRegion');
    }
    this.recover('plist.parse.well-formedness@1', 'Syntax', start, end);
  }

  // -- top-level token dispatch ----------------------------------------------

  token(token: XmlToken): void {
    switch (token.kind) {
      case 'Declaration':
        this.declaration(token);
        break;
      case 'ProcessingInstruction':
        this.processingInstruction(token);
        break;
      case 'Comment':
        this.comment(token);
        break;
      case 'DtdStart':
        this.doctypeStart(token, true);
        break;
      case 'EmptyDtd':
        this.doctypeStart(token, false);
        break;
      case 'DtdEnd':
        break;
      case 'ElementStart':
        this.elementStart(token);
        break;
      case 'Attribute':
        this.attribute(token);
        break;
      case 'ElementEnd':
        this.elementEnd(token);
        break;
      case 'Text':
        this.text(token);
        break;
      case 'Cdata':
        this.cdata(token);
        break;
    }
  }

  // -- prolog and epilog handlers ---------------------------------------------

  declaration(token: Extract<XmlToken, { kind: 'Declaration' }>): void {
    if (this.#unknownDepth > 0) {
      return;
    }
    this.pushPiece(token.start, token.start + DECLARATION_OPEN_BYTES, 'declaration-open', 'Token');
    const text = decodeUtf8Slice(this.#decoded, token.start, token.end);
    let rel = DECLARATION_OPEN_BYTES;
    rel = skipDeclarationSpaces(text, rel);
    let versionValue: string | null = null;
    if (text.slice(rel).startsWith('version')) {
      this.pushPiece(token.start + rel, token.start + rel + 7, 'declaration-name', 'Token');
      const quoted = scanQuotedInText(text, rel + 7);
      if (quoted !== null) {
        this.pushPiece(token.start + quoted.start, token.start + quoted.end, 'declaration-value', 'Token');
        versionValue = quoted.value;
        rel = quoted.end + 1;
      }
    }
    if (versionValue !== null && versionValue !== '1.0') {
      this.recover('plist.parse.declaration-version@1', 'Syntax', token.start, token.end, [
        ['version', versionValue],
      ]);
    }
    rel = skipDeclarationSpaces(text, rel);
    if (text.slice(rel).startsWith('encoding')) {
      this.pushPiece(token.start + rel, token.start + rel + 8, 'declaration-name', 'Token');
      const quoted = scanQuotedInText(text, rel + 8);
      if (quoted !== null) {
        this.pushPiece(token.start + quoted.start, token.start + quoted.end, 'declaration-value', 'Token');
        const declared = quoted.value.toUpperCase();
        const selected = this.#source.encodingFacts().selected();
        const agrees =
          selected.kind === 'Utf8'
            ? declared === 'UTF-8'
            : selected.kind === 'Utf16Le'
              ? declared === 'UTF-16' || declared === 'UTF-16LE'
              : selected.kind === 'Utf16Be'
                ? declared === 'UTF-16' || declared === 'UTF-16BE'
                : false;
        if (!agrees) {
          this.recover('plist.parse.declaration-conflict@1', 'Encoding', token.start, token.end, [
            ['declared', quoted.value],
            ['selected', this.#source.encodingFacts().selected().kind],
          ]);
        }
        rel = quoted.end + 1;
      }
    }
    rel = skipDeclarationSpaces(text, rel);
    if (text.slice(rel).startsWith('standalone')) {
      this.pushPiece(token.start + rel, token.start + rel + 10, 'declaration-name', 'Token');
    }
    if (text.endsWith('?>')) {
      this.pushPiece(token.end - 2, token.end, 'declaration-close', 'Token');
    }
  }

  processingInstruction(token: Extract<XmlToken, { kind: 'ProcessingInstruction' }>): void {
    if (this.#doctypeBodyStart !== null || this.#unknownDepth > 0) {
      return;
    }
    if (token.target.toLowerCase() === 'xml') {
      this.recover('plist.parse.pi-target@1', 'Syntax', token.start, token.end);
    }
    this.pushPiece(token.start, token.start + 2, 'processing-instruction-open', 'Trivia');
    const targetEnd = token.start + 2 + token.target.length;
    this.pushPiece(token.start + 2, targetEnd, 'processing-instruction-target', 'Trivia');
    if (token.content !== null) {
      this.pushPiece(targetEnd, token.end - 2, 'processing-instruction-content', 'Trivia');
    }
    this.pushPiece(token.end - 2, token.end, 'processing-instruction-close', 'Trivia');
  }

  comment(token: Extract<XmlToken, { kind: 'Comment' }>): void {
    if (this.#doctypeBodyStart !== null || this.#unknownDepth > 0) {
      return;
    }
    const textStart = token.start + COMMENT_OPEN_BYTES;
    const textEnd = token.end - 3;
    this.pushPiece(token.start, textStart, 'comment-open', 'Trivia');
    this.pushPiece(textStart, textEnd, 'comment-text', 'Trivia');
    this.pushPiece(textEnd, token.end, 'comment-close', 'Trivia');
  }

  doctypeStart(token: Extract<XmlToken, { kind: 'DtdStart' | 'EmptyDtd' }>, hasSubset: boolean): void {
    this.pushPiece(token.start, token.start + DOCTYPE_OPEN_BYTES, 'doctype-open', 'Token');
    this.validateDoctype(token);
    if (hasSubset) {
      // Any internal subset is a profile violation (RFC 0013 §4.1).
      this.recoverNoLocation('plist.parse.doctype-subset@1', 'Syntax');
      this.#doctypeBodyStart = token.start + DOCTYPE_OPEN_BYTES;
      return;
    }
    const bodyEnd = token.end - 1;
    this.pushPiece(token.start + DOCTYPE_OPEN_BYTES, bodyEnd, 'doctype-body', 'Token');
    this.pushPiece(bodyEnd, token.end, 'doctype-close', 'Token');
  }

  /** Validates the exact Apple plist DOCTYPE identity (RFC 0013 §4.1). */
  validateDoctype(token: Extract<XmlToken, { kind: 'DtdStart' | 'EmptyDtd' }>): void {
    const identifiersOk =
      token.external !== null &&
      token.external.kind === 'Public' &&
      token.external.publicId === PLIST_DOCTYPE_PUBLIC &&
      token.external.systemId === PLIST_DOCTYPE_SYSTEM;
    if (token.name !== 'plist' || !identifiersOk) {
      const arguments_: Array<readonly [string, string]> = [['name', token.name]];
      if (token.external !== null) {
        arguments_.push(['public', token.external.publicId]);
        arguments_.push(['system', token.external.systemId]);
      }
      this.recover('plist.parse.doctype@1', 'Syntax', token.start, token.end, arguments_);
    }
  }

  /** Closes the DOCTYPE body at the closing `>` of a subset DOCTYPE. */
  doctypeBodyEnd(end: number): void {
    const bodyEnd = end - 1;
    const bodyStart = this.#doctypeBodyStart ?? end - 1;
    this.pushPiece(bodyStart, bodyEnd, 'doctype-body', 'Token');
    this.pushPiece(bodyEnd, end, 'doctype-close', 'Token');
    this.#doctypeBodyStart = null;
  }

  // -- element handlers --------------------------------------------------------

  elementStart(token: Extract<XmlToken, { kind: 'ElementStart' }>): void {
    if (this.#stack.length >= this.#limits.common.maxNestingDepth) {
      throw FatalFormationFailure.resourceLimit(
        'nesting-depth',
        this.#stack.length + 1,
        this.#limits.common.maxNestingDepth,
      );
    }
    const kind = classifyPlistElement(token.prefix, token.local);
    const topLevel = this.#stack.length === 0;
    const admittedRoot = topLevel && !this.#plistRootSeen && kind === 'Plist';
    const isUnknown = topLevel ? !admittedRoot : kind === null || kind === 'Plist';
    if (topLevel) {
      this.#anyTopLevel = true;
    }
    const frameValue: FrameValue =
      kind === 'Plist'
        ? { kind: 'Root' }
        : kind === 'Dict'
          ? {
              kind: 'Dict',
              state: {
                entries: [],
                groups: new Map(),
                pendingKey: null,
                expectValue: false,
              },
            }
          : kind === 'Array'
            ? { kind: 'Array', elements: [] }
            : { kind: 'None' };
    let valueAllowed = !isUnknown;
    let scalarViolation = false;
    if (!isUnknown) {
      const parent = this.#stack[this.#stack.length - 1];
      const parentKind = parent?.kind ?? null;
      const parentAllowed = parent === undefined || parent.valueAllowed;
      const parentExpectValue =
        parent?.value.kind === 'Dict' && parent.value.state.expectValue;
      const parentScalar = parent?.kind !== undefined && parent.kind !== null && plistElementIsScalar(parent.kind);
      valueAllowed = parentAllowed;
      switch (kind) {
        case 'Plist':
        case null:
          break;
        case 'Key':
          if (parentKind === 'Dict') {
            if (parentAllowed && parentExpectValue) {
              this.recover('plist.parse.dict-missing-value@1', 'Syntax', token.start, token.end);
            }
          } else if (parentKind === 'Plist' || parentKind === 'Array') {
            this.recover('plist.parse.key-outside-dict@1', 'Syntax', token.start, token.end, [
              ['name', token.name],
            ]);
          } else if (parentKind !== undefined && parentKind !== null) {
            scalarViolation = true;
          }
          break;
        case 'Dict':
        case 'Array':
          if (parentScalar) {
            scalarViolation = true;
          }
          break;
        default:
          if (parentKind === 'Dict') {
            if (parentAllowed && !parentExpectValue) {
              this.recover('plist.parse.dict-key@1', 'Syntax', token.start, token.end, [
                ['element', token.name],
              ]);
            }
          } else if (parentKind === 'Plist' || parentKind === 'Array') {
            // admitted value position
          } else if (parentKind !== undefined && parentKind !== null) {
            scalarViolation = true;
          }
          break;
      }
    }
    if (scalarViolation) {
      this.recover('plist.parse.scalar-content@1', 'Syntax', token.start, token.end, [
        ['element', token.name],
      ]);
      const parent = this.#stack[this.#stack.length - 1];
      if (parent !== undefined) {
        parent.scalarUnproven = true;
      }
      valueAllowed = false;
    }
    if (isUnknown && this.#unknownDepth === 0) {
      this.recover('plist.parse.element-name@1', 'Syntax', token.start, token.end, [
        ['name', token.name],
      ]);
    }
    if (this.#unknownDepth === 0 && !isUnknown) {
      // The open-tag name piece only (the attribute pieces and the closing
      // `>` follow separately, RFC 0013 §8.2).
      this.pushPiece(token.start, token.start + 1 + token.name.length, plistOpenKind(kind!), 'Token');
    }
    const unknownMarker =
      isUnknown && this.#unknownDepth === 0 ? token.start : null;
    this.#stack.push({
      kind,
      name: token.name,
      openStart: token.start,
      openEnd: token.end,
      tagCursor: token.start + 1 + token.name.length,
      unknownSubtreeStart: unknownMarker,
      valueAllowed,
      value: frameValue,
      content: '',
      scalarUnproven: false,
      rootVersion: null,
      selfClosing: false,
    });
    if (isUnknown) {
      this.#unknownDepth += 1;
    }
    if (admittedRoot) {
      this.#plistRootSeen = true;
    }
  }

  attribute(token: Extract<XmlToken, { kind: 'Attribute' }>): void {
    if (this.#unknownDepth > 0) {
      return;
    }
    const frame = this.#stack[this.#stack.length - 1];
    if (frame === undefined) {
      return;
    }
    const isRoot = frame.kind === 'Plist' && this.#stack.length === 1;
    const versionUnset = frame.rootVersion === null;
    this.pushWhitespacePieces(frame.tagCursor, token.start);
    const isVersion = isRoot && versionUnset && token.prefix === '' && token.local === 'version';
    if (isVersion) {
      // The name piece ends at the `=` and the value piece runs from the
      // `=` through the closing quote (parser_xml.rs:1291-1299). The
      // scanner's nameEnd is the quote position, so the `=` is the last
      // non-space byte before it (a forward search would find a LATER
      // attribute's `=`).
      let eqAt = token.nameEnd - 1;
      while (eqAt > token.start && isWsByte(this.#decoded[eqAt])) {
        eqAt -= 1;
      }
      this.pushPiece(token.start, eqAt, 'plist-version-name', 'Token');
      this.pushPiece(eqAt, token.end, 'plist-version-value', 'Token');
      const normalized = normalizeAttributeValue(token.value);
      if (normalized !== PLIST_VERSION) {
        this.recover('plist.parse.root-version@1', 'Syntax', eqAt, token.end, [
          ['version', normalized],
        ]);
      }
      frame.rootVersion = normalized;
    } else {
      this.pushPiece(token.start, token.end, 'error-region', 'ErrorRegion');
      const code = isRoot ? 'plist.parse.root-attribute@1' : 'plist.parse.element-attribute@1';
      const nameText = token.prefix === '' ? token.local : `${token.prefix}:${token.local}`;
      this.recover(code, 'Syntax', token.start, token.end, [['name', nameText]]);
    }
    frame.tagCursor = token.end;
  }

  elementEnd(token: Extract<XmlToken, { kind: 'ElementEnd' }>): void {
    const frame = this.#stack[this.#stack.length - 1];
    if (token.empty) {
      // Self-closing `/>`.
      const isPlist = frame?.kind === 'Plist' && this.#stack.length === 1;
      if (this.#unknownDepth === 0) {
        if (frame !== undefined) {
          this.pushWhitespacePieces(frame.tagCursor, token.start);
          this.pushPiece(token.start, token.end, plistCloseKind(frame.kind!), 'Token');
        }
      }
      if (isPlist && frame!.rootVersion === null) {
        this.recover('plist.parse.root-version@1', 'Syntax', token.start, token.end, [
          ['version', '<missing>'],
        ]);
      }
      if (frame !== undefined) {
        frame.selfClosing = true;
        if (this.#unknownDepth === 0) {
          frame.openEnd = token.end;
        }
      }
      this.closeFrame(token.end);
      return;
    }
    if (token.closeName !== null) {
      // `</name>`: name matching, one close-tag piece, then the frame closes.
      if (frame !== undefined && frame.name !== token.closeName) {
        this.recover('plist.parse.mismatched-end-tag@1', 'Syntax', token.start, token.end, [
          ['expected', frame.name],
          ['found', token.closeName],
        ]);
      }
      if (this.#unknownDepth === 0) {
        if (frame !== undefined) {
          this.pushPiece(token.start, token.end, plistCloseKind(frame.kind!), 'Token');
        }
      }
      this.closeFrame(token.end);
      return;
    }
    // `>` of an open tag: separator walk, tag-end piece, root finalize.
    const isPlist = frame?.kind === 'Plist' && this.#stack.length === 1;
    if (this.#unknownDepth === 0) {
      if (frame !== undefined) {
        this.pushWhitespacePieces(frame.tagCursor, token.start);
        this.pushPiece(token.start, token.end, plistOpenKind(frame.kind!), 'Token');
      }
    }
    if (isPlist && frame!.rootVersion === null) {
      this.recover('plist.parse.root-version@1', 'Syntax', token.start, token.end, [
        ['version', '<missing>'],
      ]);
    }
    if (frame !== undefined) {
      if (this.#unknownDepth === 0) {
        frame.openEnd = token.end;
      }
      frame.tagCursor = token.end;
    }
  }

  closeFrame(end: number): void {
    const frame = this.#stack.pop();
    if (frame === undefined) {
      this.recover('plist.parse.extra-end-tag@1', 'Syntax', Math.max(0, end - 1), end);
      return;
    }
    if (frame.unknownSubtreeStart !== null) {
      this.pushPiece(frame.unknownSubtreeStart, end, 'error-region', 'ErrorRegion');
    }
    if (frame.kind === null) {
      this.#unknownDepth -= 1;
      return;
    }
    if (frame.kind === 'Key') {
      if (frame.valueAllowed) {
        const pending = frame.scalarUnproven
          ? null
          : frame.content;
        const parent = this.#stack[this.#stack.length - 1];
        if (parent !== undefined && parent.valueAllowed && parent.value.kind === 'Dict') {
          parent.value.state.pendingKey = pending;
          parent.value.state.expectValue = true;
        }
      }
      return;
    }
    const valueRef = frame.valueAllowed ? this.buildValue(frame, end) : null;
    const parent = this.#stack[this.#stack.length - 1];
    if (parent === undefined) {
      return;
    }
    switch (parent.value.kind) {
      case 'Root': {
        this.#rootValueCount += 1;
        if (valueRef !== null && this.#rootValueRef === null) {
          this.#rootValueRef = valueRef;
        }
        break;
      }
      case 'Dict': {
        const state = parent.value.state;
        if (state.expectValue) {
          state.expectValue = false;
          const key = state.pendingKey;
          state.pendingKey = null;
          if (key !== null && valueRef !== null) {
            const group = (state.groups.get(key) ?? 0) + 1;
            if (group > this.#limits.maxDuplicateKeyGroupMembers) {
              throw FatalFormationFailure.resourceLimit(
                'duplicate-key-group',
                group,
                this.#limits.maxDuplicateKeyGroupMembers,
              );
            }
            if (state.entries.length >= this.#limits.maxDictEntries) {
              throw FatalFormationFailure.resourceLimit(
                'dict-entries',
                state.entries.length + 1,
                this.#limits.maxDictEntries,
              );
            }
            state.groups.set(key, group);
            state.entries.push({ key, value: valueRef });
          } else {
            this.recover('plist.parse.dict-missing-value@1', 'Syntax', Math.max(0, end - 1), end);
          }
        }
        break;
      }
      case 'Array': {
        if (valueRef !== null) {
          const elements = parent.value.elements;
          if (elements.length >= this.#limits.maxArrayElements) {
            throw FatalFormationFailure.resourceLimit(
              'array-elements',
              elements.length + 1,
              this.#limits.maxArrayElements,
            );
          }
          elements.push(valueRef);
        }
        break;
      }
      case 'None':
        break;
    }
  }

  /** Parses one closing element's native value and adds it to the arena. */
  buildValue(frame: Frame, end: number): number | null {
    const limits = this.#limits;
    switch (frame.kind) {
      case 'Dict': {
        if (frame.value.kind === 'Dict') {
          if (frame.value.state.expectValue) {
            this.recover('plist.parse.dict-missing-value@1', 'Syntax', Math.max(0, end - 1), end);
          }
          const entries = frame.value.state.entries;
          return this.arenaAdd({
            kind: 'Dict',
            entries: Object.freeze([...entries]),
          });
        }
        throw FatalFormationFailure.fromDiagnostic(
          diagnostic('plist.xml.internal@1', 'Resource', 'Error', null, 0n),
        );
      }
      case 'Array': {
        if (frame.value.kind === 'Array') {
          return this.arenaAdd({
            kind: 'Array',
            elements: Object.freeze([...frame.value.elements]),
          });
        }
        throw FatalFormationFailure.fromDiagnostic(
          diagnostic('plist.xml.internal@1', 'Resource', 'Error', null, 0n),
        );
      }
      case 'String': {
        if (frame.scalarUnproven) {
          return null;
        }
        if (frame.content.length > limits.maxStringCodeUnits) {
          throw FatalFormationFailure.resourceLimit(
            'string-code-units',
            frame.content.length,
            limits.maxStringCodeUnits,
          );
        }
        return this.arenaAdd(plistStringValue(frame.content));
      }
      case 'Integer': {
        if (frame.scalarUnproven) {
          return null;
        }
        if (frame.content === '') {
          this.recover('plist.parse.empty-value@1', 'Syntax', Math.max(0, end - 1), end, [
            ['element', 'integer'],
          ]);
          return null;
        }
        const value = parsePlistInteger(frame.content);
        if (value !== null) {
          return this.arenaAdd(plistIntegerValue(value));
        }
        this.recover('plist.parse.integer@1', 'Syntax', Math.max(0, end - 1), end);
        return null;
      }
      case 'Real': {
        if (frame.scalarUnproven) {
          return null;
        }
        if (frame.content === '') {
          this.recover('plist.parse.empty-value@1', 'Syntax', Math.max(0, end - 1), end, [
            ['element', 'real'],
          ]);
          return null;
        }
        const value = parsePlistReal(frame.content);
        if (value !== null) {
          return this.arenaAdd(plistRealValue(PlistReal.double(value)));
        }
        this.recover('plist.parse.real@1', 'Syntax', Math.max(0, end - 1), end);
        return null;
      }
      case 'Date': {
        if (frame.scalarUnproven) {
          return null;
        }
        if (frame.content === '') {
          this.recover('plist.parse.empty-value@1', 'Syntax', Math.max(0, end - 1), end, [
            ['element', 'date'],
          ]);
          return null;
        }
        const seconds = parsePlistDate(frame.content);
        if (seconds !== null) {
          return this.arenaAdd(plistDateValue(seconds));
        }
        this.recover('plist.parse.date@1', 'Syntax', Math.max(0, end - 1), end);
        return null;
      }
      case 'Data': {
        if (frame.content === '') {
          if (frame.selfClosing) {
            this.recover('plist.parse.empty-value@1', 'Syntax', Math.max(0, end - 1), end, [
              ['element', 'data'],
            ]);
            return null;
          }
          return this.arenaAdd(plistDataValue(new Uint8Array(0)));
        }
        if (frame.scalarUnproven) {
          return null;
        }
        const bytes = decodePlistBase64(frame.content);
        if (bytes !== null) {
          if (bytes.length > limits.maxDataBytes) {
            throw FatalFormationFailure.resourceLimit(
              'data-bytes',
              bytes.length,
              limits.maxDataBytes,
            );
          }
          return this.arenaAdd(plistDataValue(bytes));
        }
        this.recover('plist.parse.data@1', 'Syntax', Math.max(0, end - 1), end);
        return null;
      }
      case 'True':
      case 'False': {
        if (frame.scalarUnproven) {
          return null;
        }
        return this.arenaAdd(plistBooleanValue(frame.kind === 'True'));
      }
      case 'Plist':
      case 'Key':
        return null;
    }
    // `frame.kind` is `PlistElementKind | null`; a null kind is not a
    // value element and contributes no arena node.
    return null;
  }

  arenaAdd(value: PlistValue): number {
    try {
      return this.#arena.add(value);
    } catch (error) {
      if (error instanceof PlistArenaError && error.kind === 'ObjectLimitExceeded') {
        throw FatalFormationFailure.resourceLimit(
          'object-count',
          this.#arena.nodeCount(),
          this.#limits.maxObjectCount,
        );
      }
      throw error;
    }
  }

  // -- character data ----------------------------------------------------------

  textPosition(): TextPosition {
    const frame = this.#stack[this.#stack.length - 1];
    if (frame === undefined) {
      return 'Outside';
    }
    switch (frame.kind) {
      case 'Plist':
      case 'Dict':
      case 'Array':
        return 'Container';
      case 'True':
      case 'False':
        return 'Boolean';
      default:
        return 'Scalar';
    }
  }

  text(token: Extract<XmlToken, { kind: 'Text' }>): void {
    if (this.#unknownDepth > 0) {
      return;
    }
    const position = this.textPosition();
    const textValue = token.text;
    const allWhitespace = [...textValue].every(isWsChar);
    if (position === 'Outside' || position === 'Container') {
      if (allWhitespace) {
        this.pushWhitespacePieces(token.start, token.end);
      } else {
        this.pushPiece(token.start, token.end, 'error-region', 'ErrorRegion');
        this.recover('plist.parse.text-outside-value@1', 'Syntax', token.start, token.end);
      }
      return;
    }
    if (position === 'Boolean') {
      if (allWhitespace) {
        this.pushWhitespacePieces(token.start, token.end);
      } else {
        this.pushPiece(token.start, token.end, 'error-region', 'ErrorRegion');
        this.recover('plist.parse.boolean-content@1', 'Syntax', token.start, token.end);
        const frame = this.#stack[this.#stack.length - 1];
        if (frame !== undefined) {
          frame.scalarUnproven = true;
        }
      }
      return;
    }
    const resolved = this.resolveFragments(token.start, token.end, textValue, 'Text', true);
    const frame = this.#stack[this.#stack.length - 1];
    if (frame !== undefined) {
      frame.content += resolved;
    }
  }

  cdata(token: Extract<XmlToken, { kind: 'Cdata' }>): void {
    if (this.#unknownDepth > 0) {
      return;
    }
    const position = this.textPosition();
    if (position === 'Outside' || position === 'Container') {
      this.pushPiece(token.start, token.end, 'error-region', 'ErrorRegion');
      this.recover('plist.parse.text-outside-value@1', 'Syntax', token.start, token.end);
      return;
    }
    if (position === 'Boolean') {
      this.pushPiece(token.start, token.end, 'error-region', 'ErrorRegion');
      this.recover('plist.parse.boolean-content@1', 'Syntax', token.start, token.end);
      const frame = this.#stack[this.#stack.length - 1];
      if (frame !== undefined) {
        frame.scalarUnproven = true;
      }
      return;
    }
    const textStart = token.start + CDATA_OPEN_BYTES;
    const textEnd = token.end - 3;
    this.pushPiece(token.start, textStart, 'cdata-open', 'Token');
    this.pushPiece(textStart, textEnd, 'cdata-text', 'Token');
    this.pushPiece(textEnd, token.end, 'cdata-close', 'Token');
    const frame = this.#stack[this.#stack.length - 1];
    if (frame !== undefined) {
      frame.content += appendNormalized(token.text, 'Text');
    }
  }

  /**
   * Splits one text run into Text/CharacterReference/EntityReference pieces
   * and returns the resolved normalized content (parser_xml.rs:1925-1995).
   */
  resolveFragments(start: number, end: number, text: string, mode: 'Text' | 'Attribute', emitPieces: boolean): string {
    let content = '';
    if (!text.includes('&')) {
      if (emitPieces) {
        this.pushPiece(start, end, 'text', 'Token');
      }
      return appendNormalized(text, mode);
    }
    let cursor = 0;
    let index = 0;
    while (index < text.length) {
      const at = text.indexOf('&', index);
      if (at === -1) {
        break;
      }
      if (at > cursor) {
        if (emitPieces) {
          this.pushPiece(start + cursor, start + at, 'text', 'Token');
        }
        content += appendNormalized(text.slice(cursor, at), mode);
      }
      const semi = text.indexOf(';', at + 1);
      if (semi === -1) {
        this.recover('plist.parse.reference@1', 'Syntax', start + at, end);
        if (emitPieces) {
          this.pushPiece(start + at, end, 'text', 'Token');
        }
        content += appendNormalized(text.slice(at), mode);
        return content;
      }
      const body = text.slice(at + 1, semi);
      const resolved = this.resolveReference(body, start + at, start + semi + 1);
      if (resolved !== null) {
        if (emitPieces) {
          const kind: PlistSyntaxKind = body.startsWith('#') ? 'character-reference' : 'entity-reference';
          this.pushPiece(start + at, start + semi + 1, kind, 'Token');
        }
        content += resolved;
      }
      cursor = semi + 1;
      index = semi + 1;
    }
    if (cursor < text.length) {
      if (emitPieces) {
        this.pushPiece(start + cursor, end, 'text', 'Token');
      }
      content += appendNormalized(text.slice(cursor), mode);
    }
    return content;
  }

  /** Resolves one `&…;` reference body; `null` is a recovered failure. */
  resolveReference(body: string, start: number, end: number): string | null {
    if (body.startsWith('#')) {
      const digits = body.slice(1);
      const hex = digits.startsWith('x') || digits.startsWith('X');
      const valueText = hex ? digits.slice(1) : digits;
      const valid = valueText.length > 0 && [...valueText].every((c) => (hex ? /[0-9a-fA-F]/.test(c) : /[0-9]/.test(c)));
      const value = valid ? Number.parseInt(valueText, hex ? 16 : 10) : Number.NaN;
      const character = Number.isInteger(value) ? String.fromCodePoint(value) : '';
      if (character !== '' && [...character].every((c) => isXmlCharCode(c.codePointAt(0)!))) {
        return character;
      }
      this.recover('plist.parse.reference@1', 'Syntax', start, end);
      return null;
    }
    if (body === '') {
      this.recover('plist.parse.reference@1', 'Syntax', start, end);
      return null;
    }
    switch (body) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      case 'apos':
        return "'";
      case 'quot':
        return '"';
      default:
        this.recover('plist.parse.entity@1', 'Conformance', start, end, [['name', body]]);
        return null;
    }
  }

  /** Splits one whitespace-only run into Whitespace and LineBreak trivia pieces. */
  pushWhitespacePieces(start: number, end: number): void {
    let cursor = start;
    while (cursor < end) {
      const byte = this.#decoded[cursor];
      if (!isWsByte(byte)) {
        const runStart = cursor;
        while (cursor < end && !isWsByte(this.#decoded[cursor])) {
          cursor += 1;
        }
        this.pushPiece(runStart, cursor, 'error-region', 'ErrorRegion');
        continue;
      }
      const lineBreak = byte === 0x0a || byte === 0x0d;
      const runStart = cursor;
      cursor += byte === 0x0d && cursor + 1 < end && this.#decoded[cursor + 1] === 0x0a ? 2 : 1;
      while (cursor < end && (this.#decoded[cursor] === 0x0a || this.#decoded[cursor] === 0x0d) === lineBreak) {
        cursor += 1;
      }
      this.pushPiece(
        runStart,
        cursor,
        lineBreak ? 'line-break' : 'whitespace',
        'Trivia',
      );
    }
  }

  // -- finish --------------------------------------------------------------------

  finish(): PlistDocument {
    const unclosed = this.#stack[this.#stack.length - 1];
    if (unclosed !== undefined) {
      this.recover('plist.parse.unclosed-element@1', 'Syntax', unclosed.openStart, unclosed.openEnd, [
        ['element', unclosed.name],
      ]);
    }
    const unknownTail = this.#stack.find((frame) => frame.unknownSubtreeStart !== null);
    if (unknownTail !== undefined) {
      this.pushPiece(unknownTail.unknownSubtreeStart!, this.#decoded.length, 'error-region', 'ErrorRegion');
    }
    if (!this.#anyTopLevel) {
      this.recoverNoLocation('plist.parse.missing-root@1', 'Syntax');
    }
    let native: PlistNativeDocument | null = null;
    if (this.#plistRootSeen) {
      if (this.#rootValueCount === 1 && this.#rootValueRef !== null) {
        try {
          native = this.#arena.build(this.#rootValueRef);
        } catch (error) {
          if (error instanceof PlistArenaError && error.kind === 'ContainerDepthLimitExceeded') {
            throw FatalFormationFailure.resourceLimit(
              'container-depth',
              error.node ?? 0,
              this.#limits.maxContainerDepth,
            );
          }
          throw FatalFormationFailure.fromDiagnostic(
            diagnostic('plist.xml.internal@1', 'Resource', 'Error', null, 0n),
          );
        }
      } else {
        this.recoverNoLocation('plist.parse.root-value-count@1', 'Syntax', [
          ['count', String(this.#rootValueCount)],
        ]);
      }
    }
    const status: FormationStatus = this.#recovered ? 'Recovered' : 'Complete';
    // Sort pieces and close any gaps (parser_xml.rs:2226-2314).
    const sorted = [...this.#pieces].sort((left, right) => left.start - right.start);
    const finalPieces: Piece[] = [];
    let next = 0;
    for (const piece of sorted) {
      if (piece.start > next) {
        finalPieces.push({
          start: next,
          end: piece.start,
          kind: this.#recovered ? 'error-region' : 'whitespace',
          structural: this.#recovered ? 'ErrorRegion' : 'Trivia',
        });
      }
      next = piece.end;
      finalPieces.push(piece);
    }
    if (next < this.#decoded.length) {
      finalPieces.push({
        start: next,
        end: this.#decoded.length,
        kind: this.#recovered ? 'error-region' : 'whitespace',
        structural: this.#recovered ? 'ErrorRegion' : 'Trivia',
      });
    }
    const structural = finalPieces.map(
      (piece) =>
        new StructuralPiece(
          this.rawSpan(piece.start, piece.end),
          piece.structural,
        ),
    );
    const index = LosslessStructuralIndex.create(
      this.#authority.identity(),
      this.#source.len(),
      structural,
    );
    const syntaxKinds = finalPieces.map((piece) => piece.kind);
    return new PlistDocument(
      this.#authority,
      this.#source,
      'XmlV1',
      status,
      this.#sink.finish(),
      index,
      syntaxKinds,
      null,
      null,
      native,
      this.#limits,
    );
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Forms one `plist.xml@1` document from raw bytes (RFC 0013 §2.1, §3).
 * The source contract follows RFC 0013 §2.1: no-BOM source defaults to
 * UTF-8, a BOM or an explicit caller choice is evidence that never
 * contradicts the other.
 */
export function parseXml(
  source: SourceSnapshot,
  limits: PlistParseLimits,
): PlistDocument {
  const decodedText = source.decodedText();
  if (decodedText === null) {
    throw FatalFormationFailure.fromDiagnostic(
      diagnostic('plist.xml.encoding@1', 'Encoding', 'Error', null, 0n),
    );
  }
  const decoded = new TextEncoder().encode(decodedText);
  const parser = new Parser(source, decoded, limits);
  let pos = 0;
  for (;;) {
    if (pos >= decoded.length) {
      break;
    }
    const scanned = nextXmlToken(decoded, pos);
    if (scanned === null) {
      // Tokenizer error: deterministic error region at the last byte, then
      // resume at the next `<` (parser_xml.rs:697-715).
      const end = Math.min(pos + 1, decoded.length);
      const start = Math.max(0, end - 1);
      if (end > 0) {
        parser.recoverErrorRegion(start, end);
      }
      const next = findByte(decoded, end, 0x3c /* < */);
      if (next === -1) {
        break;
      }
      pos = next;
      continue;
    }
    const { token, next } = scanned;
    if (token.kind === 'Text' && token.text === '') {
      pos = next;
      continue;
    }
    if (token.kind === 'Text' && parser.stackEmpty() && ![...token.text].every(isWsChar)) {
      // Non-whitespace text in the prolog or epilog is an XML 1.0
      // well-formedness violation; the xmlparser backend reports it as a
      // tokenizer error (parser_xml.rs:697-715), so the diagnostic is
      // plist.parse.well-formedness@1 (vector: plist.xml-formation.
      // trailing-content).
      const end = Math.min(token.start + 1, decoded.length);
      parser.recoverErrorRegion(Math.max(0, end - 1), end);
      pos = next;
      continue;
    }
    if (token.kind === 'ElementStart') {
      parser.token(token);
      // Attributes of the open tag run from the name end to the tag end.
      const nameEnd = token.start + 1 + token.name.length;
      const tagEnd = token.end - 1; // position of `>` (or of `/>`)
      let at = nameEnd;
      for (;;) {
        const attr = nextXmlAttribute(decoded, at, tagEnd);
        if (attr.attr === null) {
          at = attr.next;
          break;
        }
        parser.token(attr.attr);
        at = attr.next;
      }
      const empty = decoded[tagEnd - 1] === 0x2f;
      const endStart = empty ? tagEnd - 1 : tagEnd;
      parser.token({ kind: 'ElementEnd', start: endStart, end: tagEnd + 1, empty, closeName: null });
      pos = tagEnd + 1;
      continue;
    }
    if (token.kind === 'DtdStart') {
      parser.token(token);
      // The subset body closes at the `>`; mirror doctype_body_end.
      parser.doctypeBodyEnd(token.end);
      pos = next;
      continue;
    }
    parser.token(token);
    pos = next;
  }
  return parser.finish();
}

/** Skips XML declaration spaces (parser_xml.rs:2396-2405). */
function skipDeclarationSpaces(text: string, rel: number): number {
  while (rel < text.length && isWsChar(text[rel])) {
    rel += 1;
  }
  return rel;
}

/** Scans one quoted value inside declaration text; offsets relative to `text`. */
function scanQuotedInText(text: string, rel: number): { readonly value: string; readonly start: number; readonly end: number } | null {
  rel = skipDeclarationSpaces(text, rel);
  if (rel >= text.length || (text[rel] !== '"' && text[rel] !== "'")) {
    return null;
  }
  const quote = text[rel];
  const valueStart = rel + 1;
  const valueEnd = text.indexOf(quote, valueStart);
  if (valueEnd === -1) {
    return null;
  }
  return { value: text.slice(valueStart, valueEnd), start: rel, end: valueEnd + 1 };
}

/** Appends literal text with XML line-end normalization (parser_xml.rs:2417-2439). */
function appendNormalized(text: string, mode: 'Text' | 'Attribute'): string {
  let out = '';
  const chars = [...text];
  for (let index = 0; index < chars.length; index++) {
    let c = chars[index];
    if (c === '\r') {
      if (chars[index + 1] === '\n') {
        index += 1;
      }
      c = '\n';
    }
    out +=
      mode === 'Attribute' && (c === ' ' || c === '\t' || c === '\n') ? ' ' : c;
  }
  return out;
}

/** XML attribute value normalization: line ends then whitespace to one space. */
function normalizeAttributeValue(value: string): string {
  return appendNormalized(value, 'Attribute');
}
