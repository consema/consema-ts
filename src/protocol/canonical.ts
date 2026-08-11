/**
 * The canonical tagged JSON transport (`core.portable-value-json@1`).
 *
 * authority: the Rust transport (crates/consema-protocol/src/value_transport.rs)
 * is the byte authority; the envelope and tagged kind shapes are pinned by
 * conformance/vectors/protocol-v1.json (protocol.json.null-vector) and the
 * RFC 0015 §4.4 normative example. Rules:
 *  - the envelope is `{"schema":"core.portable-value-json@1","value":...}`
 *    with no whitespace (value_transport.rs:12-23);
 *  - every PortableValue is a JSON object whose first member is "type",
 *    followed by the fixed member set of the kind;
 *  - canonical bytes: no whitespace, minimal string escapes (only
 *    `\"`, `\\`, `\b`, `\t`, `\n`, `\f`, `\r` and `\uXXXX` for other
 *    control characters), integers and decimals re-emitted in canonical
 *    decimal spelling, hex lowercased;
 *  - the decoder parses strict JSON (no comments, no trailing commas, no
 *    duplicate member names), decodes the record, then re-encodes and
 *    requires byte equality — any valid-but-non-canonical form fails with
 *    core.protocol.non-canonical-json@1 (value_transport.rs:66-73).
 *
 * Design (TypeScript-idiomatic): one strict recursive-descent parser
 * producing a tagged tree, one canonical emitter, and a re-encode
 * canonicality check; limits are enforced through a byte budget for output
 * and depth/node counts for both directions.
 */

import type { PortableValue, DecimalValue } from '../core/value.ts';
import type { ProtocolLimits } from './limits.ts';
import { ProtocolError, protocolError, invalid, resource } from './errors.ts';

/** The canonical tagged JSON transport schema. */
export const PortableValueJSONSchema = 'core.portable-value-json@1';

/** One strict-JSON tree node. */
type JsonNode =
  | { readonly kind: 'Null' }
  | { readonly kind: 'Bool'; readonly truth: boolean }
  | { readonly kind: 'String'; readonly text: string }
  | { readonly kind: 'Number'; readonly text: string }
  | { readonly kind: 'Object'; readonly fields: { key: string; value: JsonNode }[] }
  | { readonly kind: 'Array'; readonly items: JsonNode[] };

// ---------------------------------------------------------------------------
// Strict JSON parsing
// ---------------------------------------------------------------------------

/** Parses one strict JSON document (no comments, no trailing commas). */
export function parseJSONDocument(bytes: Uint8Array, limits: ProtocolLimits): JsonNode {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw protocolError('InvalidJson', '$', 'input is not valid UTF-8');
  }
  const parser = new JsonParser(text, limits);
  const node = parser.value(0, '$');
  parser.skipWhitespace();
  if (!parser.atEnd()) {
    throw protocolError('InvalidJson', '$', 'trailing content');
  }
  return node;
}

class JsonParser {
  private pos = 0;
  private readonly text: string;
  private readonly limits: ProtocolLimits;

  constructor(text: string, limits: ProtocolLimits) {
    this.text = text;
    this.limits = limits;
  }

  atEnd(): boolean {
    return this.pos >= this.text.length;
  }

  skipWhitespace(): void {
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        this.pos++;
      } else {
        return;
      }
    }
  }

  private peek(): string {
    return this.text[this.pos] ?? '';
  }

  value(depth: number, path: string): JsonNode {
    if (depth > this.limits.maxDepth) {
      throw resource(path, 'nesting depth');
    }
    this.skipWhitespace();
    const ch = this.peek();
    if (ch === '{') {
      return this.object(depth, path);
    }
    if (ch === '[') {
      return this.array(depth, path);
    }
    if (ch === '"') {
      return { kind: 'String', text: this.stringToken(path) };
    }
    if (ch === 't') {
      if (this.literal('true')) {
        return { kind: 'Bool', truth: true };
      }
      throw protocolError('InvalidJson', '$', 'expected a value');
    }
    if (ch === 'f') {
      if (this.literal('false')) {
        return { kind: 'Bool', truth: false };
      }
      throw protocolError('InvalidJson', '$', 'expected a value');
    }
    if (ch === 'n') {
      if (this.literal('null')) {
        return { kind: 'Null' };
      }
      throw protocolError('InvalidJson', '$', 'expected a value');
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      return { kind: 'Number', text: this.numberToken() };
    }
    throw protocolError('InvalidJson', '$', 'unexpected character');
  }

  private literal(word: string): boolean {
    if (this.text.startsWith(word, this.pos)) {
      this.pos += word.length;
      return true;
    }
    return false;
  }

  private object(depth: number, path: string): JsonNode {
    this.pos++; // '{'
    const fields: { key: string; value: JsonNode }[] = [];
    const seen = new Set<string>();
    this.skipWhitespace();
    if (this.peek() === '}') {
      this.pos++;
      return { kind: 'Object', fields };
    }
    for (;;) {
      if (this.peek() !== '"') {
        throw protocolError('InvalidJson', '$', "expected '\"");
      }
      const key = this.stringToken(path);
      if (seen.has(key)) {
        throw protocolError('InvalidJson', '$', 'duplicate member name');
      }
      seen.add(key);
      this.skipWhitespace();
      if (this.peek() !== ':') {
        throw protocolError('InvalidJson', '$', "expected ':'");
      }
      this.pos++;
      const value = this.value(depth + 1, path);
      fields.push({ key, value });
      this.skipWhitespace();
      const ch = this.peek();
      if (ch === ',') {
        this.pos++;
        this.skipWhitespace();
        continue;
      }
      if (ch === '}') {
        this.pos++;
        return { kind: 'Object', fields };
      }
      throw protocolError('InvalidJson', '$', "expected ',' or '}'");
    }
  }

  private array(depth: number, path: string): JsonNode {
    this.pos++; // '['
    const items: JsonNode[] = [];
    this.skipWhitespace();
    if (this.peek() === ']') {
      this.pos++;
      return { kind: 'Array', items };
    }
    for (;;) {
      items.push(this.value(depth + 1, path));
      this.skipWhitespace();
      const ch = this.peek();
      if (ch === ',') {
        this.pos++;
        this.skipWhitespace();
        continue;
      }
      if (ch === ']') {
        this.pos++;
        return { kind: 'Array', items };
      }
      throw protocolError('InvalidJson', '$', "expected ',' or ']'");
    }
  }

  /** Parses one JSON string token with escapes and surrogate pairs. */
  private stringToken(path: string): string {
    if (this.peek() !== '"') {
      throw protocolError('InvalidJson', path, 'expected string');
    }
    this.pos++;
    let out = '';
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === undefined) {
        throw protocolError('InvalidJson', path, 'unterminated string');
      }
      if (ch === '"') {
        this.pos++;
        return out;
      }
      if (ch === '\\') {
        this.pos++;
        const esc = this.text[this.pos];
        if (esc === undefined) {
          throw protocolError('InvalidJson', path, 'unterminated escape');
        }
        switch (esc) {
          case '"':
          case '\\':
          case '/':
            out += esc;
            this.pos++;
            break;
          case 'b':
            out += '\b';
            this.pos++;
            break;
          case 'f':
            out += '\f';
            this.pos++;
            break;
          case 'n':
            out += '\n';
            this.pos++;
            break;
          case 'r':
            out += '\r';
            this.pos++;
            break;
          case 't':
            out += '\t';
            this.pos++;
            break;
          case 'u':
            this.pos++;
            out += this.unicodeEscape(path);
            break;
          default:
            throw protocolError('InvalidJson', path, 'invalid escape');
        }
        continue;
      }
      const code = ch.codePointAt(0)!;
      if (code < 0x20) {
        throw protocolError('InvalidJson', path, 'raw control character');
      }
      out += ch;
      this.pos++;
    }
  }

  /** Decodes one \uXXXX escape, combining surrogate pairs. */
  private unicodeEscape(path: string): string {
    const first = this.hexQuad(path);
    if (first >= 0xd800 && first <= 0xdbff) {
      // High surrogate: a following \uXXXX must complete the pair.
      if (this.text.startsWith('\\u', this.pos)) {
        this.pos += 2;
        const second = this.hexQuad(path);
        if (second >= 0xdc00 && second <= 0xdfff) {
          return String.fromCodePoint(0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00));
        }
        throw protocolError('InvalidJson', path, 'invalid surrogate pair');
      }
      throw protocolError('InvalidJson', path, 'lone high surrogate');
    }
    if (first >= 0xdc00 && first <= 0xdfff) {
      throw protocolError('InvalidJson', path, 'lone low surrogate');
    }
    return String.fromCodePoint(first);
  }

  private hexQuad(path: string): number {
    const hex = this.text.slice(this.pos, this.pos + 4);
    if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
      throw protocolError('InvalidJson', path, 'truncated \\u escape');
    }
    this.pos += 4;
    return Number.parseInt(hex, 16);
  }

  /** Parses one strict JSON number token and returns its raw text. */
  private numberToken(): string {
    const start = this.pos;
    if (this.peek() === '-') {
      this.pos++;
    }
    const first = this.peek();
    if (first === '0') {
      this.pos++;
    } else if (first >= '1' && first <= '9') {
      while (this.pos < this.text.length && this.text[this.pos] >= '0' && this.text[this.pos] <= '9') {
        this.pos++;
      }
    } else {
      throw protocolError('InvalidJson', '$', 'invalid number');
    }
    if (this.peek() === '.') {
      this.pos++;
      const fractionStart = this.pos;
      while (this.pos < this.text.length && this.text[this.pos] >= '0' && this.text[this.pos] <= '9') {
        this.pos++;
      }
      if (this.pos === fractionStart) {
        throw protocolError('InvalidJson', '$', 'invalid number fraction');
      }
    }
    const exp = this.peek();
    if (exp === 'e' || exp === 'E') {
      this.pos++;
      const sign = this.peek();
      if (sign === '+' || sign === '-') {
        this.pos++;
      }
      const exponentStart = this.pos;
      while (this.pos < this.text.length && this.text[this.pos] >= '0' && this.text[this.pos] <= '9') {
        this.pos++;
      }
      if (this.pos === exponentStart) {
        throw protocolError('InvalidJson', '$', 'invalid number exponent');
      }
    }
    return this.text.slice(start, this.pos);
  }
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

/** Requires an Object with exactly the named members in order. */
function jsonObjectExact(node: JsonNode, names: readonly string[], path: string): JsonNode[] {
  if (node.kind !== 'Object') {
    throw protocolError('WrongType', path, 'expected JSON object');
  }
  const fields = node.fields;
  if (fields.length !== names.length) {
    if (fields.length > names.length) {
      throw protocolError('UnknownField', `${path}.${fields[names.length].key}`, 'unknown field');
    }
    throw protocolError('MissingField', path, 'missing field');
  }
  for (let i = 0; i < names.length; i++) {
    if (fields[i].key !== names[i]) {
      throw protocolError('SchemaMismatch', `${path}.${fields[i].key}`, `expected ${names[i]}`);
    }
  }
  return fields.map((field) => field.value);
}

function jsonStringOf(node: JsonNode, path: string): string {
  if (node.kind !== 'String') {
    throw protocolError('WrongType', path, 'expected String');
  }
  return node.text;
}

function jsonBooleanOf(node: JsonNode, path: string): boolean {
  if (node.kind !== 'Bool') {
    throw protocolError('WrongType', path, 'expected Boolean');
  }
  return node.truth;
}

function jsonParseU8(node: JsonNode, path: string): number {
  const text = jsonStringOf(node, path);
  const value = Number(text);
  if (!/^\d+$/.test(text) || value < 0 || value > 255) {
    throw protocolError('InvalidValue', path, 'invalid uint8');
  }
  return value;
}

function jsonParseI32(node: JsonNode, path: string): number {
  const text = jsonStringOf(node, path);
  const value = Number(text);
  if (!/^-?\d+$/.test(text) || value < -2147483648 || value > 2147483647) {
    throw protocolError('InvalidValue', path, 'invalid int32');
  }
  return value;
}

function jsonParseInteger(node: JsonNode, path: string, limits: ProtocolLimits): bigint {
  const text = jsonStringOf(node, path);
  if (!/^-?\d+$/.test(text)) {
    throw protocolError('InvalidValue', path, 'invalid integer');
  }
  const magnitude = text.replace('-', '');
  if (magnitude.length > limits.maxIntegerBytes * 2) {
    throw resource(path, 'integer bytes');
  }
  try {
    return BigInt(text);
  } catch {
    throw protocolError('InvalidValue', path, 'invalid integer');
  }
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

/** Counts the UTF-8 bytes of a string without allocating. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
        continue;
      }
    }
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

class JsonEncoderState {
  private readonly limits: ProtocolLimits;
  private nodes = 0;
  private byteCount = 0;
  private readonly parts: string[] = [];

  constructor(limits: ProtocolLimits) {
    this.limits = limits;
  }

  push(text: string): void {
    this.byteCount += utf8ByteLength(text);
    if (this.byteCount > this.limits.maxBytes) {
      throw resource('$', 'transport bytes');
    }
    this.parts.push(text);
  }

  node(depth: number, path: string): void {
    if (depth > this.limits.maxDepth) {
      throw resource(path, 'nesting depth');
    }
    this.nodes += 1;
    if (this.nodes > this.limits.maxNodes) {
      throw resource(path, 'value nodes');
    }
  }

  container(count: number, path: string): void {
    if (count > this.limits.maxContainerEntries) {
      throw resource(path, 'container entries');
    }
  }

  result(): Uint8Array {
    return new TextEncoder().encode(this.parts.join(''));
  }

  /** Emits one quoted string with the canonical minimal escapes. */
  quoted(value: string, path: string): void {
    if (utf8ByteLength(value) > this.limits.maxBlobBytes) {
      throw resource(path, 'string bytes');
    }
    this.push('"');
    for (const ch of value) {
      switch (ch) {
        case '"':
          this.push('\\"');
          break;
        case '\\':
          this.push('\\\\');
          break;
        case '\b':
          this.push('\\b');
          break;
        case '\t':
          this.push('\\t');
          break;
        case '\n':
          this.push('\\n');
          break;
        case '\f':
          this.push('\\f');
          break;
        case '\r':
          this.push('\\r');
          break;
        default:
          if (ch.charCodeAt(0) < 0x20) {
            this.push(`\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
          } else {
            this.push(ch);
          }
      }
    }
    this.push('"');
  }

  /** Emits one bigint as a quoted canonical decimal string (Rust integer(), value_transport.rs:350-355). */
  integer(value: bigint): void {
    this.push('"');
    this.push(value.toString());
    this.push('"');
  }
}

/** Converts a core value into the tagged tree form (an object whose first member is "type"). */
export function valueToNode(value: PortableValue): JsonNode {
  const tagged = (type: string, fields: { key: string; value: JsonNode }[]): JsonNode => ({
    kind: 'Object',
    fields: [{ key: 'type', value: { kind: 'String', text: type } }, ...fields],
  });
  switch (value.kind) {
    case 'Null':
      return tagged('Null', []);
    case 'Boolean':
      return tagged('Boolean', [{ key: 'value', value: { kind: 'Bool', truth: value.value } }]);
    case 'String':
      return tagged('String', [{ key: 'value', value: { kind: 'String', text: value.value } }]);
    case 'Integer':
      return tagged('Integer', [{ key: 'value', value: { kind: 'String', text: value.value.toString() } }]);
    case 'Decimal':
      return tagged('Decimal', [
        { key: 'coefficient', value: { kind: 'String', text: value.coefficient.toString() } },
        { key: 'exponent', value: { kind: 'String', text: value.exponent.toString() } },
      ]);
    case 'BinaryFloat32':
      return tagged('BinaryFloat32', [
        { key: 'bits', value: { kind: 'String', text: value.bits.toString(16).padStart(8, '0') } },
      ]);
    case 'BinaryFloat64':
      return tagged('BinaryFloat64', [
        { key: 'bits', value: { kind: 'String', text: value.bits.toString(16).padStart(16, '0') } },
      ]);
    case 'Bytes':
      return tagged('Bytes', [
        { key: 'hex', value: { kind: 'String', text: hexOf(value.value) } },
      ]);
    case 'Date':
      return tagged('Date', [
        { key: 'year', value: { kind: 'String', text: value.year.toString() } },
        { key: 'month', value: { kind: 'String', text: value.month.toString() } },
        { key: 'day', value: { kind: 'String', text: value.day.toString() } },
      ]);
    case 'Time':
      return tagged('Time', [
        { key: 'hour', value: { kind: 'String', text: value.hour.toString() } },
        { key: 'minute', value: { kind: 'String', text: value.minute.toString() } },
        { key: 'second', value: { kind: 'String', text: value.second.toString() } },
        { key: 'fraction', value: valueToNode(value.fraction) },
      ]);
    case 'LocalDateTime':
      return tagged('LocalDateTime', [
        { key: 'date', value: valueToNode(value.date) },
        { key: 'time', value: valueToNode(value.time) },
      ]);
    case 'OffsetDateTime':
      return tagged('OffsetDateTime', [
        { key: 'local', value: valueToNode(value.local) },
        { key: 'offset_seconds', value: { kind: 'String', text: value.offsetSeconds.toString() } },
      ]);
    case 'Sequence':
      return tagged('Sequence', [
        { key: 'items', value: { kind: 'Array', items: value.items.map(valueToNode) } },
      ]);
    case 'Object':
      return tagged('Object', [
        {
          key: 'entries',
          value: {
            kind: 'Array',
            items: value.entries.map((entry) => ({
              kind: 'Object',
              fields: [
                { key: 'key', value: { kind: 'String', text: entry.key } },
                { key: 'value', value: valueToNode(entry.value) },
              ],
            })),
          },
        },
      ]);
    case 'EntryMapping':
      return tagged('EntryMapping', [
        {
          key: 'entries',
          value: {
            kind: 'Array',
            items: value.entries.map((entry) => ({
              kind: 'Object',
              fields: [
                { key: 'key', value: valueToNode(entry.key) },
                { key: 'value', value: valueToNode(entry.value) },
              ],
            })),
          },
        },
      ]);
  }
}

function hexOf(bytes: Uint8Array): string {
  let out = '';
  for (const octet of bytes) {
    out += octet.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Encodes a PortableValue as canonical `core.portable-value-json@1` bytes,
 * byte-identical to the Rust encoder (value_transport.rs:12-23).
 */
export function EncodeJSON(value: PortableValue, limits: ProtocolLimits): Uint8Array {
  const state = new JsonEncoderState(limits);
  state.push(`{"schema":"${PortableValueJSONSchema}","value":`);
  emitValue(state, valueToNode(value), 0, '$.value');
  state.push('}');
  return state.result();
}

/** The canonical tagged-value emitter (the Rust JsonEncoder::value). */
function emitValue(state: JsonEncoderState, node: JsonNode, depth: number, path: string): void {
  state.node(depth, path);
  if (node.kind !== 'Object' || node.fields.length === 0 || node.fields[0].key !== 'type') {
    throw invalid(path, 'unrepresentable value');
  }
  const kind = node.fields[0].value;
  if (kind.kind !== 'String') {
    throw protocolError('WrongType', `${path}.type`, 'expected String');
  }
  const member = (name: string): JsonNode | undefined =>
    node.fields.find((field) => field.key === name)?.value;
  switch (kind.text) {
    case 'Null':
      state.push('{"type":"Null"}');
      return;
    case 'Boolean': {
      const value = member('value');
      if (value === undefined || value.kind !== 'Bool') {
        throw invalid(path, 'unrepresentable value');
      }
      state.push(value.truth ? '{"type":"Boolean","value":true}' : '{"type":"Boolean","value":false}');
      return;
    }
    case 'String': {
      const text = jsonStringOf(requireMember(member('value'), path, 'value'), `${path}.value`);
      state.push('{"type":"String","value":');
      state.quoted(text, path);
      state.push('}');
      return;
    }
    case 'Integer': {
      const text = jsonStringOf(requireMember(member('value'), path, 'value'), `${path}.value`);
      const bigint = parseBigIntText(text, `${path}.value`);
      state.push('{"type":"Integer","value":');
      state.integer(bigint);
      state.push('}');
      return;
    }
    case 'Decimal': {
      const coefficient = parseBigIntText(
        jsonStringOf(requireMember(member('coefficient'), path, 'coefficient'), `${path}.coefficient`),
        `${path}.coefficient`,
      );
      const exponent = parseBigIntText(
        jsonStringOf(requireMember(member('exponent'), path, 'exponent'), `${path}.exponent`),
        `${path}.exponent`,
      );
      state.push('{"type":"Decimal","coefficient":');
      state.integer(coefficient);
      state.push(',"exponent":');
      state.integer(exponent);
      state.push('}');
      return;
    }
    case 'BinaryFloat32': {
      const bits = jsonStringOf(requireMember(member('bits'), path, 'bits'), `${path}.bits`);
      state.push('{"type":"BinaryFloat32","bits":');
      state.quoted(bits.toLowerCase(), path);
      state.push('}');
      return;
    }
    case 'BinaryFloat64': {
      const bits = jsonStringOf(requireMember(member('bits'), path, 'bits'), `${path}.bits`);
      state.push('{"type":"BinaryFloat64","bits":');
      state.quoted(bits.toLowerCase(), path);
      state.push('}');
      return;
    }
    case 'Bytes': {
      const hex = jsonStringOf(requireMember(member('hex'), path, 'hex'), `${path}.hex`);
      state.push('{"type":"Bytes","hex":');
      state.quoted(hex.toLowerCase(), path);
      state.push('}');
      return;
    }
    case 'Date': {
      const year = parseBigIntText(
        jsonStringOf(requireMember(member('year'), path, 'year'), `${path}.year`),
        `${path}.year`,
      );
      const month = jsonParseU8(requireMember(member('month'), path, 'month'), `${path}.month`);
      const day = jsonParseU8(requireMember(member('day'), path, 'day'), `${path}.day`);
      state.push('{"type":"Date","year":');
      state.integer(year);
      state.push(`,"month":`);
      state.quoted(month.toString(), path);
      state.push(`,"day":`);
      state.quoted(day.toString(), path);
      state.push('}');
      return;
    }
    case 'Time': {
      const hour = jsonParseU8(requireMember(member('hour'), path, 'hour'), `${path}.hour`);
      const minute = jsonParseU8(requireMember(member('minute'), path, 'minute'), `${path}.minute`);
      const second = jsonParseU8(requireMember(member('second'), path, 'second'), `${path}.second`);
      const fraction = requireMember(member('fraction'), path, 'fraction');
      state.push('{"type":"Time","hour":');
      state.quoted(hour.toString(), path);
      state.push(',"minute":');
      state.quoted(minute.toString(), path);
      state.push(',"second":');
      state.quoted(second.toString(), path);
      state.push(',"fraction":');
      emitValue(state, fraction, depth + 1, path);
      state.push('}');
      return;
    }
    case 'LocalDateTime': {
      const date = requireMember(member('date'), path, 'date');
      const time = requireMember(member('time'), path, 'time');
      state.push('{"type":"LocalDateTime","date":');
      emitValue(state, date, depth + 1, path);
      state.push(',"time":');
      emitValue(state, time, depth + 1, path);
      state.push('}');
      return;
    }
    case 'OffsetDateTime': {
      const local = requireMember(member('local'), path, 'local');
      const offset = jsonParseI32(
        requireMember(member('offset_seconds'), path, 'offset_seconds'),
        `${path}.offset_seconds`,
      );
      state.push('{"type":"OffsetDateTime","local":');
      emitValue(state, local, depth + 1, path);
      state.push(',"offset_seconds":');
      state.quoted(offset.toString(), path);
      state.push('}');
      return;
    }
    case 'Sequence': {
      const items = member('items');
      if (items === undefined || items.kind !== 'Array') {
        throw protocolError('WrongType', `${path}.items`, 'expected JSON array');
      }
      state.container(items.items.length, path);
      state.push('{"type":"Sequence","items":[');
      items.items.forEach((item, index) => {
        if (index !== 0) {
          state.push(',');
        }
        emitValue(state, item, depth + 1, `${path}.items[${index}]`);
      });
      state.push(']}');
      return;
    }
    case 'Object':
    case 'EntryMapping': {
      const entries = member('entries');
      if (entries === undefined || entries.kind !== 'Array') {
        throw protocolError('WrongType', `${path}.entries`, 'expected JSON array');
      }
      state.container(entries.items.length, path);
      state.push(`{"type":"${kind.text}","entries":[`);
      entries.items.forEach((item, index) => {
        if (index !== 0) {
          state.push(',');
        }
        const entryPath = `${path}.entries[${index}]`;
        const entryFields = jsonObjectExact(item, ['key', 'value'], entryPath);
        state.push('{"key":');
        if (kind.text === 'Object') {
          const key = jsonStringOf(entryFields[0], `${entryPath}.key`);
          state.quoted(key, `${entryPath}.key`);
        } else {
          emitValue(state, entryFields[0], depth + 1, `${entryPath}.key`);
        }
        state.push(',"value":');
        emitValue(state, entryFields[1], depth + 1, `${entryPath}.value`);
        state.push('}');
      });
      state.push(']}');
      return;
    }
  }
  throw invalid(`${path}.type`, 'unknown value type');
}

function requireMember(node: JsonNode | undefined, path: string, name: string): JsonNode {
  if (node === undefined) {
    throw protocolError('MissingField', `${path}.${name}`, 'missing member');
  }
  return node;
}

function parseBigIntText(text: string, path: string): bigint {
  if (!/^-?\d+$/.test(text)) {
    throw protocolError('InvalidValue', path, 'invalid integer');
  }
  try {
    return BigInt(text);
  } catch {
    throw protocolError('InvalidValue', path, 'invalid integer');
  }
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

class DecodeState {
  readonly limits: ProtocolLimits;
  private nodes = 0;

  constructor(limits: ProtocolLimits) {
    this.limits = limits;
  }

  node(depth: number, path: string): void {
    if (depth > this.limits.maxDepth) {
      throw resource(path, 'nesting depth');
    }
    this.nodes += 1;
    if (this.nodes > this.limits.maxNodes) {
      throw resource(path, 'value nodes');
    }
  }

  container(count: number, path: string): void {
    if (count > this.limits.maxContainerEntries) {
      throw resource(path, 'container entries');
    }
  }
}

/** Decodes a tagged tree node into a core value (the Rust decode_value, value_transport.rs:392-617). */
export function nodeToValue(node: JsonNode, depth: number, path: string, state: DecodeState): PortableValue {
  state.node(depth, path);
  if (node.kind !== 'Object') {
    throw protocolError('WrongType', path, 'expected JSON object');
  }
  if (node.fields.length === 0) {
    throw protocolError('MissingField', `${path}.type`, 'missing value type');
  }
  if (node.fields[0].key !== 'type') {
    throw protocolError('SchemaMismatch', path, 'type must be the first field');
  }
  const kind = jsonStringOf(node.fields[0].value, `${path}.type`);
  // Member values only (the 'type' member is excluded), mirroring the Rust
  // decoder's `fields[1..]` indexing (value_transport.rs:421-448).
  const exact = (names: readonly string[]): JsonNode[] =>
    jsonObjectExact(node, ['type', ...names], path).slice(1);
  switch (kind) {
    case 'Null':
      exact([]);
      return { kind: 'Null' };
    case 'Boolean': {
      const [value] = exact(['value']);
      return { kind: 'Boolean', value: jsonBooleanOf(value, `${path}.value`) };
    }
    case 'String': {
      const [value] = exact(['value']);
      return { kind: 'String', value: jsonStringOf(value, `${path}.value`) };
    }
    case 'Integer': {
      const [value] = exact(['value']);
      return { kind: 'Integer', value: jsonParseInteger(value, `${path}.value`, state.limits) };
    }
    case 'Decimal': {
      const [coefficient, exponent] = exact(['coefficient', 'exponent']);
      const c = jsonParseInteger(coefficient, `${path}.coefficient`, state.limits);
      const e = jsonParseInteger(exponent, `${path}.exponent`, state.limits);
      // Normalize exactly as Decimal::new / NewDecimal do; the re-encode
      // canonicality check then rejects non-canonical spellings.
      return normalizeDecimal(c, e);
    }
    case 'BinaryFloat32': {
      const [bits] = exact(['bits']);
      const text = jsonStringOf(bits, `${path}.bits`);
      if (!/^[0-9a-fA-F]{1,8}$/.test(text)) {
        throw protocolError('InvalidValue', `${path}.bits`, 'invalid hex');
      }
      return { kind: 'BinaryFloat32', bits: Number.parseInt(text, 16) >>> 0 };
    }
    case 'BinaryFloat64': {
      const [bits] = exact(['bits']);
      const text = jsonStringOf(bits, `${path}.bits`);
      if (!/^[0-9a-fA-F]{1,16}$/.test(text)) {
        throw protocolError('InvalidValue', `${path}.bits`, 'invalid hex');
      }
      return { kind: 'BinaryFloat64', bits: BigInt(`0x${text}`) & 0xffffffffffffffffn };
    }
    case 'Bytes': {
      const [hex] = exact(['hex']);
      const text = jsonStringOf(hex, `${path}.hex`);
      if (!/^[0-9a-fA-F]*$/.test(text) || text.length % 2 !== 0) {
        throw protocolError('InvalidValue', `${path}.hex`, 'invalid hex');
      }
      return { kind: 'Bytes', value: hexBytes(text) };
    }
    case 'Date': {
      const [year, month, day] = exact(['year', 'month', 'day']);
      const y = jsonParseInteger(year, `${path}.year`, state.limits);
      const m = jsonParseU8(month, `${path}.month`);
      const d = jsonParseU8(day, `${path}.day`);
      if (!dateFieldsValid(y, m, d)) {
        throw protocolError('InvalidValue', path, 'invalid date');
      }
      return { kind: 'Date', year: y, month: m, day: d };
    }
    case 'Time': {
      const [hour, minute, second, fraction] = exact(['hour', 'minute', 'second', 'fraction']);
      const h = jsonParseU8(hour, `${path}.hour`);
      const mi = jsonParseU8(minute, `${path}.minute`);
      const s = jsonParseU8(second, `${path}.second`);
      const fractionValue = nodeToValue(fraction, depth + 1, `${path}.fraction`, state);
      if (fractionValue.kind !== 'Decimal') {
        throw protocolError('WrongType', `${path}.fraction`, 'expected Decimal');
      }
      if (h > 23 || mi > 59 || s > 59 || !fractionInRange(fractionValue)) {
        throw protocolError('InvalidValue', path, 'invalid time');
      }
      return { kind: 'Time', hour: h, minute: mi, second: s, fraction: fractionValue };
    }
    case 'LocalDateTime': {
      const [date, time] = exact(['date', 'time']);
      const dateValue = nodeToValue(date, depth + 1, `${path}.date`, state);
      const timeValue = nodeToValue(time, depth + 1, `${path}.time`, state);
      if (dateValue.kind !== 'Date' || timeValue.kind !== 'Time') {
        throw protocolError('WrongType', path, 'expected Date and Time');
      }
      return { kind: 'LocalDateTime', date: dateValue, time: timeValue };
    }
    case 'OffsetDateTime': {
      const [local, offsetSeconds] = exact(['local', 'offset_seconds']);
      const localValue = nodeToValue(local, depth + 1, `${path}.local`, state);
      if (localValue.kind !== 'LocalDateTime') {
        throw protocolError('WrongType', `${path}.local`, 'expected LocalDateTime');
      }
      const offset = jsonParseI32(offsetSeconds, `${path}.offset_seconds`);
      if (offset >= 86400 || offset <= -86400) {
        throw protocolError('InvalidValue', `${path}.offset_seconds`, 'invalid offset');
      }
      return { kind: 'OffsetDateTime', local: localValue, offsetSeconds: offset };
    }
    case 'Sequence': {
      const [items] = exact(['items']);
      if (items.kind !== 'Array') {
        throw protocolError('WrongType', `${path}.items`, 'expected JSON array');
      }
      state.container(items.items.length, path);
      const values = items.items.map((item, index) =>
        nodeToValue(item, depth + 1, `${path}.items[${index}]`, state),
      );
      return { kind: 'Sequence', items: values };
    }
    case 'Object': {
      const [entries] = exact(['entries']);
      if (entries.kind !== 'Array') {
        throw protocolError('WrongType', `${path}.entries`, 'expected JSON array');
      }
      state.container(entries.items.length, path);
      const result: { key: string; value: PortableValue }[] = [];
      const seen = new Set<string>();
      entries.items.forEach((item, index) => {
        const entryPath = `${path}.entries[${index}]`;
        const [key, value] = jsonObjectExact(item, ['key', 'value'], entryPath);
        const keyText = jsonStringOf(key, `${entryPath}.key`);
        if (seen.has(keyText)) {
          throw protocolError('InvalidValue', entryPath, 'duplicate object key');
        }
        seen.add(keyText);
        result.push({ key: keyText, value: nodeToValue(value, depth + 1, `${entryPath}.value`, state) });
      });
      return { kind: 'Object', entries: result };
    }
    case 'EntryMapping': {
      const [entries] = exact(['entries']);
      if (entries.kind !== 'Array') {
        throw protocolError('WrongType', `${path}.entries`, 'expected JSON array');
      }
      state.container(entries.items.length, path);
      const result: { key: PortableValue; value: PortableValue }[] = [];
      entries.items.forEach((item, index) => {
        const entryPath = `${path}.entries[${index}]`;
        const [key, value] = jsonObjectExact(item, ['key', 'value'], entryPath);
        result.push({
          key: nodeToValue(key, depth + 1, `${entryPath}.key`, state),
          value: nodeToValue(value, depth + 1, `${entryPath}.value`, state),
        });
      });
      return { kind: 'EntryMapping', entries: result };
    }
    default:
      throw invalid(`${path}.type`, 'unknown value type');
  }
}

/** The canonical decimal normalization (Decimal::new; crates/consema-core/src/value.rs:277-292). */
function normalizeDecimal(coefficient: bigint, exponent: bigint): { kind: 'Decimal'; coefficient: bigint; exponent: bigint } {
  if (coefficient === 0n) {
    return { kind: 'Decimal', coefficient: 0n, exponent: 0n };
  }
  let c = coefficient;
  let e = exponent;
  while (c % 10n === 0n) {
    c /= 10n;
    e += 1n;
  }
  return { kind: 'Decimal', coefficient: c, exponent: e };
}

function dateFieldsValid(year: bigint, month: number, day: number): boolean {
  if (month < 1 || month > 12) {
    return false;
  }
  const magnitude = year < 0n ? -year : year;
  const leap = magnitude % 4n === 0n && (magnitude % 100n !== 0n || magnitude % 400n === 0n);
  let maxDay: number;
  if (month === 2) {
    maxDay = leap ? 29 : 28;
  } else if (month === 4 || month === 6 || month === 9 || month === 11) {
    maxDay = 30;
  } else {
    maxDay = 31;
  }
  return day >= 1 && day <= maxDay;
}

function fractionInRange(fraction: DecimalValue): boolean {
  if (fraction.coefficient < 0n) {
    return false;
  }
  if (fraction.coefficient === 0n) {
    return true;
  }
  if (fraction.exponent >= 0n) {
    return false;
  }
  const digits = fraction.coefficient.toString().length;
  return fraction.exponent + BigInt(digits) <= 0n;
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Strictly decodes canonical `core.portable-value-json@1` bytes and returns
 * the transported PortableValue (value_transport.rs:26-75). The record
 * decode runs before the canonicality re-encode check, matching the Rust
 * ordering (a resource-limit or field error is reported before a
 * non-canonical form).
 *
 * Documented divergence note (Rust wins, per the language-neutral parity
 * rule): the Rust decoder re-encodes the DECODED VALUE and compares it to
 * the input bytes (value_transport.rs:66-73). The Go implementation
 * re-encodes the parse tree instead (go/protocol/canonical.go:487-512),
 * which accepts non-canonical decimal spellings (e.g.
 * {"coefficient":"10","exponent":"0"}) that Rust rejects after decimal
 * normalization. TypeScript follows Rust: the decoded decimal is normalized
 * and the re-encoded value must equal the input bytes.
 */
export function DecodeJSON(bytes: Uint8Array, limits: ProtocolLimits): PortableValue {
  if (bytes.length > limits.maxBytes) {
    throw resource('$', 'transport bytes');
  }
  const node = parseJSONDocument(bytes, limits);
  const fields = jsonObjectExact(node, ['schema', 'value'], '$');
  const schema = jsonStringOf(fields[0], '$.schema');
  if (schema !== PortableValueJSONSchema) {
    throw protocolError('SchemaMismatch', '$.schema', 'unexpected transport schema');
  }
  const state = new DecodeState(limits);
  const value = nodeToValue(fields[1], 0, '$.value', state);
  const canonical = EncodeJSON(value, limits);
  if (!byteArraysEqual(canonical, bytes)) {
    throw protocolError('NonCanonicalJson', '$', 'input is valid but not the canonical JSON byte form');
  }
  return value;
}

function byteArraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** Narrowing helpers used by record encoders. */
export function wireNull(): PortableValue {
  return { kind: 'Null' };
}

export function wireBoolean(value: boolean): PortableValue {
  return { kind: 'Boolean', value };
}

export function wireBytesLeaf(bytes: Uint8Array): PortableValue {
  return { kind: 'Bytes', value: Uint8Array.from(bytes) };
}
