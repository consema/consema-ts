/**
 * TOML 1.0 grammar parser: one complete valid document → the native entity
 * model with byte-exact spans.
 *
 * authority (semantic): RFC 0001 (docs/rfcs/0001-toml-1.0-profile.md) —
 * §2 document/identity model (:20-49): root is always RootTable; tables,
 * inline tables, arrays, and arrays-of-tables are distinct native item
 * categories; dotted keys keep one direct segment per logical entry; §3
 * (:51-62) formation order (source bytes → UTF-8 → TOML 1.0 grammar →
 * limits) and the resource-limit codes. The grammar itself is TOML 1.0.0
 * (RFC 0001 §1 "规范来源：TOML 1.0.0"; profile rejects anything else).
 *
 * authority (structure, byte arbitration): crates/consema-toml/src/parser.rs
 *  - entity build order and spans :84-338: table item reserved before its
 *    keys/children/entries; root table span 0..len (:198-200); standard
 *    table span = header (:201-202); implicit/dotted table span = creating
 *    key segment (:207-211); key entity span = decoded segment (:212-217);
 *    entry span = union of key and child spans (:220-221); array element
 *    span = value span (:292-300); AOT array span = header, element table
 *    span = header (:315-327)
 *  - flavors: Root/Dotted/Implicit/Standard (:232-240)
 *  - node limit applies to every entity, limit name "node_count"
 *    (:92-104); depth limit name "nesting_depth" (:106-116)
 *  - datetime fields truncated to nanoseconds (lib.rs:327-329)
 *  - resource-limit names: "source_bytes", "token_count", "nesting_depth",
 *    "node_count" (parser.rs:22-28, :415-419, :449-452, :95-98)
 *
 * TOML semantic rules implemented (TOML 1.0.0 §4):
 *  - duplicate keys in one table are invalid (vector case
 *    toml.parse.reject-invalid, conformance/fixtures/toml/invalid-
 *    duplicate.toml)
 *  - a table declared by a [header] may not be redeclared, extended via
 *    dotted keys, or replaced by an inline table; dotted-defined tables
 *    may not be header-declared; [x.y] then [x] is invalid; inline tables
 *    are closed; [[a]] appends elements and may not collide with [a];
 *    dotted keys may extend the most recent array-of-tables element
 *  - leap seconds (second = 60) are valid TOML (vector case
 *    toml.projection.reject-leap-second parses and fails only at
 *    projection)
 *  - dates are calendar-validated (TOML 1.0.0 §4.5.2)
 *
 * Design (TypeScript-idiomatic): a code-point scanner over the decoded
 * text carries parallel per-scalar UTF-8 byte widths so every span is an
 * exact raw-byte range (RFC 0001 §2.2). The entity list is built in the
 * Rust order and frozen only after the parse succeeds.
 */

import { DocumentAuthority, Span } from '../document/identity.ts';
import type { ParseLimits } from '../document/formation.ts';
import { TomlFormationFailure } from './errors.ts';

// ---------------------------------------------------------------------------
// Native datum model (lib.rs:307-349)
// ---------------------------------------------------------------------------

/** Parsed TOML date fields (lib.rs:308-316). */
export interface TomlDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** Parsed TOML time fields; fraction truncated to nanoseconds (lib.rs:319-329). */
export interface TomlTime {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly nanosecond: number;
}

/** Parsed TOML UTC offset (lib.rs:331-338). */
export type TomlOffset = { readonly kind: 'Z' } | { readonly kind: 'CustomMinutes'; readonly minutes: number };

/** Complete native TOML date/time datum (lib.rs:340-349). */
export interface TomlDateTime {
  readonly date: TomlDate | null;
  readonly time: TomlTime | null;
  readonly offset: TomlOffset | null;
}

// ---------------------------------------------------------------------------
// Entity model (lib.rs:132-141, 274-305)
// ---------------------------------------------------------------------------

/** Table flavor of a logical table item (lib.rs:232-240). */
export type TomlTableFlavor = 'Root' | 'Dotted' | 'Implicit' | 'Standard';

/** Native item category (lib.rs:274-305). */
export type TomlItemKind =
  | 'String'
  | 'Integer'
  | 'Float'
  | 'Boolean'
  | 'OffsetDateTime'
  | 'LocalDateTime'
  | 'LocalDate'
  | 'LocalTime'
  | 'Array'
  | 'InlineTable'
  | 'RootTable'
  | 'StandardTable'
  | 'ImplicitTable'
  | 'DottedTable'
  | 'ArrayOfTables';

/** Item entity payload (parser.rs InternalItemKind). */
export type ItemEntityKind =
  | { readonly kind: 'String'; readonly value: string }
  | { readonly kind: 'Integer'; readonly value: bigint }
  | { readonly kind: 'Float'; readonly bits: bigint }
  | { readonly kind: 'Boolean'; readonly value: boolean }
  | { readonly kind: 'DateTime'; readonly value: TomlDateTime }
  | { readonly kind: 'Array'; readonly elements: number[] }
  | { readonly kind: 'InlineTable'; readonly entries: number[] }
  | { readonly kind: 'Table'; readonly flavor: TomlTableFlavor; readonly entries: number[] }
  | { readonly kind: 'ArrayOfTables'; readonly elements: number[] };

/** One entity's role and payload (parser.rs EntityKind). */
export type EntityKind =
  | { readonly role: 'Item'; readonly item: ItemEntityKind }
  | { readonly role: 'Key'; readonly name: string }
  | { readonly role: 'Entry'; readonly ordinal: number; readonly key: number; readonly item: number }
  | { readonly role: 'Element'; readonly ordinal: number; readonly item: number };

/** One structural entity bound to the snapshot (parser.rs Entity). */
export interface Entity {
  readonly span: Span;
  readonly kind: EntityKind;
}

/** Complete parse result: the root item index and every entity in build order. */
export interface TomlParseOutput {
  readonly root: number;
  readonly entities: readonly Entity[];
}

// ---------------------------------------------------------------------------
// Code-point source with byte-accurate positions
// ---------------------------------------------------------------------------

/** Parallel per-scalar UTF-8 byte width (source.ts:1044-1068 rule). */
function utf8WidthOf(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * The decoded text as code points with exact UTF-8 byte offsets, so parser
 * spans are raw-byte ranges (RFC 0001 §2.2).
 */
class CodePointSource {
  readonly codes: readonly number[];
  readonly byteAt: readonly number[];
  readonly totalBytes: number;

  constructor(text: string) {
    const codes: number[] = [];
    const byteAt: number[] = [0];
    let bytes = 0;
    for (const character of text) {
      const codePoint = character.codePointAt(0)!;
      codes.push(codePoint);
      bytes += utf8WidthOf(codePoint);
      byteAt.push(bytes);
    }
    this.codes = codes;
    this.byteAt = byteAt;
    this.totalBytes = bytes;
  }

  /** Code point at index i, or -1 past the end. */
  at(i: number): number {
    return i < this.codes.length ? this.codes[i] : -1;
  }

  /** Code-point count. */
  get length(): number {
    return this.codes.length;
  }

  /** Byte offset of code point index i (span endpoint at EOF is totalBytes). */
  byte(i: number): number {
    return this.byteAt[Math.min(Math.max(i, 0), this.byteAt.length - 1)];
  }

  /** Decoded substring over code-point indices. */
  slice(start: number, end: number): string {
    let out = '';
    for (let i = start; i < end && i < this.codes.length; i++) {
      out += String.fromCodePoint(this.codes[i]);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

interface Segment {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

type TableState =
  | 'Header'
  | 'Dotted'
  | 'Implicit'
  | 'AotArray'
  | 'Inline'
  | 'Value';

interface TableRecord {
  readonly state: TableState;
  readonly item: number;
  readonly aotElements?: number[];
}

interface MutableEntity {
  span: Span;
  kind: EntityKind;
}

function pathKey(segments: readonly string[]): string {
  return segments.map((segment) => `${segment.length}:${segment}`).join('|');
}

const I64_MIN = -9223372036854775808n;
const I64_MAX = 9223372036854775807n;

const FLOAT_INF_BITS = 0x7ff0000000000000n;
const FLOAT_NEG_INF_BITS = 0xfff0000000000000n;
const FLOAT_NAN_BITS = 0x7ff8000000000000n;
const FLOAT_NEG_NAN_BITS = 0xfff8000000000000n;

class Parser {
  readonly #src: CodePointSource;
  readonly #authority: DocumentAuthority;
  readonly #limits: ParseLimits;
  readonly #entities: MutableEntity[] = [];
  readonly #tables = new Map<string, TableRecord>();
  #pos = 0;
  #rootItem = 0;
  #currentTable = 0;
  #currentPath: string[] = [];
  #currentScope = '';

  constructor(src: CodePointSource, authority: DocumentAuthority, limits: ParseLimits) {
    this.#src = src;
    this.#authority = authority;
    this.#limits = limits;
  }

  // -- entity allocation (parser.rs:92-104 node_count limit) ----------------

  #addEntity(span: Span, kind: EntityKind): number {
    const observed = this.#entities.length + 1;
    if (observed > this.#limits.maxNodeCount) {
      this.#resourceLimit('node_count', observed, this.#limits.maxNodeCount);
    }
    const index = this.#entities.length;
    this.#entities.push({ span, kind });
    return index;
  }

  /** Reserves a container item; its span is fixed by #fixItemSpan after the body parses (parser.rs:182-188). */
  #reserveItem(start: number, kind: ItemEntityKind): number {
    const index = this.#addEntity(this.#span(start, start), { role: 'Item', item: kind });
    return index;
  }

  #fixItemSpan(index: number, start: number, end: number): void {
    this.#entities[index].span = this.#span(start, end);
  }

  #span(start: number, end: number): Span {
    return this.#authority.span(this.#src.byte(start), this.#src.byte(end));
  }

  // -- failures ---------------------------------------------------------------

  #fail(reason: string, start: number, end: number): never {
    throw new TomlFormationFailure('Syntax', {
      parserReason: reason,
      startByte: this.#src.byte(start),
      endByte: this.#src.byte(end),
    });
  }

  #resourceLimit(name: string, observed: number, limit: number): never {
    throw new TomlFormationFailure('ResourceLimit', { limitName: name, observed, limit });
  }

  #checkDepth(depth: number): void {
    if (depth > this.#limits.maxNestingDepth) {
      this.#resourceLimit('nesting_depth', depth, this.#limits.maxNestingDepth);
    }
  }

  // -- trivia -----------------------------------------------------------------

  #skipHorizontalWs(): void {
    while (this.#src.at(this.#pos) === 0x20 || this.#src.at(this.#pos) === 0x09) {
      this.#pos += 1;
    }
  }

  /** Spaces, tabs, and comments (comments stop at a newline). */
  #skipTrivia(): void {
    for (;;) {
      const c = this.#src.at(this.#pos);
      if (c === 0x20 || c === 0x09) {
        this.#pos += 1;
        continue;
      }
      if (c === 0x23) {
        while (this.#pos < this.#src.length) {
          const n = this.#src.at(this.#pos);
          if (n === 0x0a || n === 0x0d) break;
          this.#pos += 1;
        }
        continue;
      }
      break;
    }
  }

  #expectLineEnd(): void {
    this.#skipTrivia();
    const c = this.#src.at(this.#pos);
    if (c < 0) return;
    if (c === 0x0a) {
      this.#pos += 1;
      return;
    }
    if (c === 0x0d) {
      if (this.#src.at(this.#pos + 1) === 0x0a) {
        this.#pos += 2;
        return;
      }
      this.#fail('bare carriage return', this.#pos, this.#pos + 1);
    }
    this.#fail('expected end of line', this.#pos, this.#pos + 1);
  }

  // -- document structure -------------------------------------------------------

  parseDocument(): TomlParseOutput {
    const root = this.#addEntity(this.#span(0, this.#src.length), {
      role: 'Item',
      item: { kind: 'Table', flavor: 'Root', entries: [] },
    });
    this.#rootItem = root;
    this.#currentTable = root;
    for (;;) {
      this.#skipTrivia();
      const c = this.#src.at(this.#pos);
      if (c < 0) break;
      if (c === 0x0a) {
        this.#pos += 1;
        continue;
      }
      if (c === 0x0d) {
        if (this.#src.at(this.#pos + 1) === 0x0a) {
          this.#pos += 2;
          continue;
        }
        this.#fail('bare carriage return', this.#pos, this.#pos + 1);
      }
      if (c === 0x5b) {
        this.#parseHeader();
      } else {
        this.#parseKeyValue();
      }
      this.#expectLineEnd();
    }
    return {
      root,
      entities: this.#entities.map((entity) =>
        Object.freeze({ span: entity.span, kind: entity.kind }),
      ),
    };
  }

  // -- keys --------------------------------------------------------------------

  #parseKeySegment(): Segment {
    this.#skipHorizontalWs();
    const start = this.#pos;
    const c = this.#src.at(this.#pos);
    if (c === 0x22 || c === 0x27) {
      const name = this.#parseQuotedKey();
      return { name, start, end: this.#pos };
    }
    let end = start;
    while (end < this.#src.length && isBareKeyChar(this.#src.at(end))) {
      end += 1;
    }
    if (end === start) {
      this.#fail('expected key', start, Math.min(start + 1, this.#src.length));
    }
    this.#pos = end;
    return { name: this.#src.slice(start, end), start, end };
  }

  #parseKeyPath(): Segment[] {
    const segments = [this.#parseKeySegment()];
    for (;;) {
      this.#skipHorizontalWs();
      if (this.#src.at(this.#pos) !== 0x2e) break;
      this.#pos += 1;
      segments.push(this.#parseKeySegment());
    }
    return segments;
  }

  /** Single-line basic or literal string used as a key (TOML 1.0.0 §4.3.1). */
  #parseQuotedKey(): string {
    const quote = this.#src.at(this.#pos);
    if (this.#src.at(this.#pos + 1) === quote && this.#src.at(this.#pos + 2) === quote) {
      this.#fail('multiline strings are not valid keys', this.#pos, this.#pos + 3);
    }
    return this.#parseSingleLineString(quote);
  }

  // -- key-value pairs -----------------------------------------------------------

  #parseKeyValue(): void {
    const segments = this.#parseKeyPath();
    this.#skipHorizontalWs();
    if (this.#src.at(this.#pos) !== 0x3d) {
      this.#fail('expected "=" after key', this.#pos, this.#pos + 1);
    }
    this.#pos += 1;
    this.#skipHorizontalWs();
    const value = this.#parseValue(1);
    this.#registerKeyValue(segments, value);
  }

  #registerKeyValue(segments: Segment[], valueItem: number): void {
    if (segments.length === 1) {
      const entries = this.#tableEntriesOf(this.#currentTable);
      if (entries.some((entry) => this.#entryNameOf(entry) === segments[0].name)) {
        this.#fail('duplicate key', segments[0].start, segments[0].end);
      }
      this.#linkEntryInto(entries, segments[0], valueItem);
      const key = pathKey([...this.#currentPath, segments[0].name]) + this.#currentScope;
      this.#tables.set(key, { state: 'Value', item: valueItem });
      return;
    }
    let parentItem = this.#currentTable;
    let scope = this.#currentScope;
    const full: string[] = [...this.#currentPath];
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      full.push(segment.name);
      const key = pathKey(full) + scope;
      let record = this.#tables.get(key);
      if (record === undefined && i === 0) {
        // TOML 1.0.0 §4.2: "any reference to an array of tables points to
        // the most recently defined table element of the array". A dotted
        // key whose first part names the enclosing array-of-tables extends
        // that most recent element directly (module header: "dotted keys
        // may extend the most recent array-of-tables element").
        const rootRecord = this.#tables.get(pathKey([segment.name]));
        if (
          rootRecord !== undefined &&
          rootRecord.state === 'AotArray' &&
          parentItem === this.#lastElementOf(rootRecord)
        ) {
          record = rootRecord;
        }
      }
      if (record === undefined) {
        const tableItem = this.#addEntity(this.#span(segment.start, segment.end), {
          role: 'Item',
          item: { kind: 'Table', flavor: 'Dotted', entries: [] },
        });
        this.#linkEntryInto(this.#tableEntriesOf(parentItem), segment, tableItem);
        this.#tables.set(key, { state: 'Dotted', item: tableItem });
        parentItem = tableItem;
      } else if (record.state === 'AotArray') {
        parentItem = this.#lastElementOf(record);
        scope = elementScope(scope, record);
      } else if (record.state === 'Header') {
        // Using dotted keys to extend tables already defined in [table]
        // form is invalid (TOML 1.0.0 §4.4).
        this.#fail('cannot extend a header-defined table via dotted keys', segment.start, segment.end);
      } else if (record.state === 'Implicit' || record.state === 'Dotted') {
        parentItem = record.item;
      } else {
        this.#fail('dotted key extends a non-table value', segment.start, segment.end);
      }
    }
    const last = segments[segments.length - 1];
    const leafKey = pathKey([...full, last.name]) + scope;
    if (this.#tables.has(leafKey)) {
      this.#fail('key already defined as a table', last.start, last.end);
    }
    const parentEntries = this.#tableEntriesOf(parentItem);
    if (parentEntries.some((entry) => this.#entryNameOf(entry) === last.name)) {
      this.#fail('duplicate key', last.start, last.end);
    }
    this.#linkEntryInto(parentEntries, last, valueItem);
    this.#tables.set(leafKey, { state: 'Value', item: valueItem });
  }

  #linkEntryInto(entries: number[], segment: Segment, childItem: number): void {
    const keyIndex = this.#addEntity(this.#span(segment.start, segment.end), {
      role: 'Key',
      name: segment.name,
    });
    const child = this.#entities[childItem].span;
    const keySpan = this.#span(segment.start, segment.end);
    const entryIndex = this.#addEntity(
      this.#authority.span(
        Math.min(keySpan.startByte(), child.startByte()),
        Math.max(keySpan.endByte(), child.endByte()),
      ),
      {
        role: 'Entry',
        ordinal: entries.length,
        key: keyIndex,
        item: childItem,
      },
    );
    entries.push(entryIndex);
  }

  #entryNameOf(entryIndex: number): string {
    const kind = this.#entities[entryIndex].kind;
    if (kind.role !== 'Entry') {
      throw new Error('internal: toml entry entity expected');
    }
    const keyKind = this.#entities[kind.key].kind;
    if (keyKind.role !== 'Key') {
      throw new Error('internal: toml key entity expected');
    }
    return keyKind.name;
  }

  #tableEntriesOf(itemIndex: number): number[] {
    const kind = this.#entities[itemIndex].kind;
    if (kind.role !== 'Item') {
      throw new Error('internal: toml item entity expected');
    }
    if (kind.item.kind === 'Table') return kind.item.entries;
    if (kind.item.kind === 'InlineTable') return kind.item.entries;
    throw new Error('internal: toml table item expected');
  }

  #lastElementOf(record: TableRecord): number {
    const elements = record.aotElements;
    if (elements === undefined || elements.length === 0) {
      throw new Error('internal: array-of-tables record has no elements');
    }
    return elements[elements.length - 1];
  }

  // -- headers --------------------------------------------------------------------

  #parseHeader(): void {
    const start = this.#pos;
    let aot = false;
    if (this.#src.at(this.#pos + 1) === 0x5b) {
      this.#pos += 2;
      aot = true;
    } else {
      this.#pos += 1;
    }
    this.#skipHorizontalWs();
    const segments = this.#parseKeyPath();
    this.#skipHorizontalWs();
    if (aot) {
      if (this.#src.at(this.#pos) !== 0x5d || this.#src.at(this.#pos + 1) !== 0x5d) {
        this.#fail('expected "]]" closing array-of-tables header', this.#pos, this.#pos + 1);
      }
      this.#pos += 2;
    } else {
      if (this.#src.at(this.#pos) !== 0x5d) {
        this.#fail('expected "]" closing table header', this.#pos, this.#pos + 1);
      }
      this.#pos += 1;
    }
    this.#registerHeader(segments, start, this.#pos, aot);
  }

  #registerHeader(segments: Segment[], headerStart: number, headerEnd: number, aot: boolean): void {
    let parentItem = this.#rootItem;
    let scope = '';
    const full: string[] = [];
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      full.push(segment.name);
      const key = pathKey(full) + scope;
      const record = this.#tables.get(key);
      if (record === undefined) {
        this.#checkDepth(i + 1);
        const tableItem = this.#addEntity(this.#span(segment.start, segment.end), {
          role: 'Item',
          item: { kind: 'Table', flavor: 'Implicit', entries: [] },
        });
        this.#linkEntryInto(this.#tableEntriesOf(parentItem), segment, tableItem);
        this.#tables.set(key, { state: 'Implicit', item: tableItem });
        parentItem = tableItem;
      } else if (record.state === 'AotArray') {
        parentItem = this.#lastElementOf(record);
        scope = elementScope(scope, record);
      } else if (record.state === 'Header' || record.state === 'Implicit' || record.state === 'Dotted') {
        parentItem = record.item;
      } else {
        this.#fail('cannot define a table under a value', segment.start, segment.end);
      }
    }
    const last = segments[segments.length - 1];
    const finalKey = pathKey([...full, last.name]) + scope;
    const record = this.#tables.get(finalKey);
    this.#checkDepth(segments.length);
    if (!aot) {
      if (record !== undefined) {
        this.#fail('table already defined', last.start, last.end);
      }
      const tableItem = this.#addEntity(this.#span(headerStart, headerEnd), {
        role: 'Item',
        item: { kind: 'Table', flavor: 'Standard', entries: [] },
      });
      this.#linkEntryInto(this.#tableEntriesOf(parentItem), last, tableItem);
      this.#tables.set(finalKey, { state: 'Header', item: tableItem });
      this.#currentTable = tableItem;
      this.#currentPath = segments.map((segment) => segment.name);
      this.#currentScope = scope;
      return;
    }
    if (record === undefined) {
      const arrayItem = this.#addEntity(this.#span(headerStart, headerEnd), {
        role: 'Item',
        item: { kind: 'ArrayOfTables', elements: [] },
      });
      this.#linkEntryInto(this.#tableEntriesOf(parentItem), last, arrayItem);
      const element = this.#addEntity(this.#span(headerStart, headerEnd), {
        role: 'Item',
        item: { kind: 'Table', flavor: 'Standard', entries: [] },
      });
      const elementEntity = this.#addEntity(this.#span(headerStart, headerEnd), {
        role: 'Element',
        ordinal: 0,
        item: element,
      });
      const arrayKind = this.#entities[arrayItem].kind;
      if (arrayKind.role !== 'Item' || arrayKind.item.kind !== 'ArrayOfTables') {
        throw new Error('internal: toml array-of-tables item expected');
      }
      arrayKind.item.elements.push(elementEntity);
      this.#tables.set(finalKey, { state: 'AotArray', item: arrayItem, aotElements: [element] });
      this.#currentTable = element;
      this.#currentPath = segments.map((segment) => segment.name);
      this.#currentScope = elementScope(scope, { state: 'AotArray', item: arrayItem, aotElements: [element] });
      return;
    }
    if (record.state !== 'AotArray') {
      this.#fail('array-of-tables already defined in another form', last.start, last.end);
    }
    const elements = record.aotElements!;
    const element = this.#addEntity(this.#span(headerStart, headerEnd), {
      role: 'Item',
      item: { kind: 'Table', flavor: 'Standard', entries: [] },
    });
    const elementEntity = this.#addEntity(this.#span(headerStart, headerEnd), {
      role: 'Element',
      ordinal: elements.length,
      item: element,
    });
    const arrayKind = this.#entities[record.item].kind;
    if (arrayKind.role !== 'Item' || arrayKind.item.kind !== 'ArrayOfTables') {
      throw new Error('internal: toml array-of-tables item expected');
    }
    arrayKind.item.elements.push(elementEntity);
    elements.push(element);
    this.#currentTable = element;
    this.#currentPath = segments.map((segment) => segment.name);
    this.#currentScope = elementScope(scope, record);
  }

  // -- values ---------------------------------------------------------------------

  #parseValue(depth: number): number {
    this.#checkDepth(depth);
    const c = this.#src.at(this.#pos);
    if (c === 0x22 || c === 0x27) return this.#parseStringValue();
    if (c === 0x5b) return this.#parseArray(depth);
    if (c === 0x7b) return this.#parseInlineTable(depth);
    if (c < 0 || c === 0x0a || c === 0x0d || c === 0x23 || c === 0x2c || c === 0x5d || c === 0x7d || c === 0x3d) {
      this.#fail('expected value', this.#pos, Math.min(this.#pos + 1, this.#src.length));
    }
    return this.#parseBareValue();
  }

  // -- strings ---------------------------------------------------------------------

  #parseStringValue(): number {
    const start = this.#pos;
    const quote = this.#src.at(this.#pos);
    const triple = this.#src.at(this.#pos + 1) === quote && this.#src.at(this.#pos + 2) === quote;
    const value = triple ? this.#parseMultilineString(quote) : this.#parseSingleLineString(quote);
    return this.#addEntity(this.#span(start, this.#pos), {
      role: 'Item',
      item: { kind: 'String', value },
    });
  }

  #parseSingleLineString(quote: number): string {
    this.#pos += 1;
    let out = '';
    for (;;) {
      const c = this.#src.at(this.#pos);
      if (c < 0 || c === 0x0a || c === 0x0d) {
        this.#fail('unterminated string', this.#pos, Math.min(this.#pos + 1, this.#src.length));
      }
      if (c === quote) {
        this.#pos += 1;
        return out;
      }
      if (quote === 0x22 && c === 0x5c) {
        out += this.#parseEscape();
        continue;
      }
      if (c === 0x09) {
        out += '\t';
        this.#pos += 1;
        continue;
      }
      if (isForbiddenControl(c)) {
        this.#fail('control character must be escaped', this.#pos, this.#pos + 1);
      }
      out += String.fromCodePoint(c);
      this.#pos += 1;
    }
  }

  #parseEscape(): string {
    // at the backslash
    this.#pos += 1;
    const c = this.#src.at(this.#pos);
    switch (c) {
      case 0x62: // \b
        this.#pos += 1;
        return '\b';
      case 0x74: // \t
        this.#pos += 1;
        return '\t';
      case 0x6e: // \n
        this.#pos += 1;
        return '\n';
      case 0x66: // \f
        this.#pos += 1;
        return '\f';
      case 0x72: // \r
        this.#pos += 1;
        return '\r';
      case 0x22: // \"
        this.#pos += 1;
        return '"';
      case 0x5c: // \\
        this.#pos += 1;
        return '\\';
      case 0x75: // \uXXXX
        return this.#parseUnicodeEscape(4);
      case 0x55: // \UXXXXXXXX
        return this.#parseUnicodeEscape(8);
      default:
        this.#fail('invalid escape sequence', this.#pos - 1, this.#pos + 1);
    }
  }

  #parseUnicodeEscape(digits: number): string {
    this.#pos += 1; // past u/U
    let value = 0;
    for (let i = 0; i < digits; i++) {
      const c = this.#src.at(this.#pos);
      const hex = hexValue(c);
      if (hex < 0) {
        this.#fail('invalid unicode escape', this.#pos, Math.min(this.#pos + 1, this.#src.length));
      }
      value = value * 16 + hex;
      this.#pos += 1;
    }
    if (value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
      this.#fail('unicode escape is not a scalar value', this.#pos - digits, this.#pos);
    }
    return String.fromCodePoint(value);
  }

  #parseMultilineString(quote: number): string {
    this.#pos += 3;
    // A newline immediately following the opening delimiter is trimmed (TOML 1.0.0 §4.2.2).
    if (this.#src.at(this.#pos) === 0x0d && this.#src.at(this.#pos + 1) === 0x0a) {
      this.#pos += 2;
    } else if (this.#src.at(this.#pos) === 0x0a) {
      this.#pos += 1;
    }
    let out = '';
    for (;;) {
      const c = this.#src.at(this.#pos);
      if (c < 0) {
        this.#fail('unterminated multiline string', this.#pos, Math.min(this.#pos + 1, this.#src.length));
      }
      if (c === quote && this.#src.at(this.#pos + 1) === quote && this.#src.at(this.#pos + 2) === quote) {
        // The closing delimiter is the first """ not followed by a fourth quote;
        // a fourth quote is content (TOML 1.0.0 §4.2.2 quote sequences).
        if (this.#src.at(this.#pos + 3) !== quote) {
          this.#pos += 3;
          return out;
        }
        out += String.fromCodePoint(quote);
        this.#pos += 1;
        continue;
      }
      if (quote === 0x22 && c === 0x5c) {
        // Line-ending backslash: "\" ws newline trims all following whitespace
        // including newlines up to the next non-whitespace character (TOML 1.0.0 §4.2.2).
        let k = this.#pos + 1;
        while (this.#src.at(k) === 0x20 || this.#src.at(k) === 0x09) {
          k += 1;
        }
        const n = this.#src.at(k);
        if (n === 0x0a) {
          this.#pos = k + 1;
          this.#skipMultilineWs();
          continue;
        }
        if (n === 0x0d && this.#src.at(k + 1) === 0x0a) {
          this.#pos = k + 2;
          this.#skipMultilineWs();
          continue;
        }
        out += this.#parseEscape();
        continue;
      }
      if (c === 0x0a) {
        out += '\n';
        this.#pos += 1;
        continue;
      }
      if (c === 0x0d) {
        if (this.#src.at(this.#pos + 1) === 0x0a) {
          out += '\n';
          this.#pos += 2;
          continue;
        }
        this.#fail('bare carriage return in string', this.#pos, this.#pos + 1);
      }
      if (c === 0x09) {
        out += '\t';
        this.#pos += 1;
        continue;
      }
      if (isForbiddenControl(c)) {
        this.#fail('control character must be escaped', this.#pos, this.#pos + 1);
      }
      out += String.fromCodePoint(c);
      this.#pos += 1;
    }
  }

  #skipMultilineWs(): void {
    for (;;) {
      const c = this.#src.at(this.#pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a) {
        this.#pos += 1;
        continue;
      }
      if (c === 0x0d && this.#src.at(this.#pos + 1) === 0x0a) {
        this.#pos += 2;
        continue;
      }
      break;
    }
  }

  // -- arrays -----------------------------------------------------------------------

  #parseArray(depth: number): number {
    const start = this.#pos;
    this.#pos += 1; // '['
    const itemIndex = this.#reserveItem(start, { kind: 'Array', elements: [] });
    const kind = this.#entities[itemIndex].kind;
    if (kind.role !== 'Item' || kind.item.kind !== 'Array') {
      throw new Error('internal: toml array item expected');
    }
    const elements = kind.item.elements;
    this.#skipArrayTrivia();
    if (this.#src.at(this.#pos) === 0x5d) {
      this.#pos += 1;
      this.#fixItemSpan(itemIndex, start, this.#pos);
      return itemIndex;
    }
    for (;;) {
      const value = this.#parseValue(depth + 1);
      const valueSpan = this.#entities[value].span;
      const elementIndex = this.#addEntity(valueSpan, { role: 'Element', ordinal: elements.length, item: value });
      elements.push(elementIndex);
      this.#skipArrayTrivia();
      const c = this.#src.at(this.#pos);
      if (c === 0x2c) {
        this.#pos += 1;
        this.#skipArrayTrivia();
        if (this.#src.at(this.#pos) === 0x5d) {
          this.#pos += 1;
          this.#fixItemSpan(itemIndex, start, this.#pos);
          return itemIndex;
        }
        continue;
      }
      if (c === 0x5d) {
        this.#pos += 1;
        this.#fixItemSpan(itemIndex, start, this.#pos);
        return itemIndex;
      }
      this.#fail('expected "," or "]" in array', this.#pos, Math.min(this.#pos + 1, this.#src.length));
    }
  }

  #skipArrayTrivia(): void {
    for (;;) {
      const c = this.#src.at(this.#pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a) {
        this.#pos += 1;
        continue;
      }
      if (c === 0x0d) {
        if (this.#src.at(this.#pos + 1) === 0x0a) {
          this.#pos += 2;
          continue;
        }
        this.#fail('bare carriage return in array', this.#pos, this.#pos + 1);
      }
      if (c === 0x23) {
        while (this.#pos < this.#src.length) {
          const n = this.#src.at(this.#pos);
          if (n === 0x0a || n === 0x0d) break;
          this.#pos += 1;
        }
        continue;
      }
      break;
    }
  }

  // -- inline tables ------------------------------------------------------------------

  #parseInlineTable(depth: number): number {
    this.#checkDepth(depth);
    const start = this.#pos;
    this.#pos += 1; // '{'
    const itemIndex = this.#reserveItem(start, { kind: 'InlineTable', entries: [] });
    const kind = this.#entities[itemIndex].kind;
    if (kind.role !== 'Item' || kind.item.kind !== 'InlineTable') {
      throw new Error('internal: toml inline table item expected');
    }
    const entries = kind.item.entries;
    const local = new Map<string, TableRecord>();
    this.#skipInlineWs();
    if (this.#src.at(this.#pos) === 0x7d) {
      this.#pos += 1;
      this.#fixItemSpan(itemIndex, start, this.#pos);
      return itemIndex;
    }
    for (;;) {
      const segments = this.#parseKeyPath();
      this.#skipInlineWs();
      if (this.#src.at(this.#pos) !== 0x3d) {
        this.#fail('expected "=" in inline table', this.#pos, this.#pos + 1);
      }
      this.#pos += 1;
      this.#skipInlineWs();
      const value = this.#parseValue(depth + 1);
      this.#registerInlineEntry(local, entries, segments, value);
      this.#skipInlineWs();
      const c = this.#src.at(this.#pos);
      if (c === 0x2c) {
        this.#pos += 1;
        this.#skipInlineWs();
        if (this.#src.at(this.#pos) === 0x7d) {
          this.#fail('trailing comma in inline table', this.#pos, this.#pos + 1);
        }
        continue;
      }
      if (c === 0x7d) {
        this.#pos += 1;
        this.#fixItemSpan(itemIndex, start, this.#pos);
        return itemIndex;
      }
      this.#fail('expected "," or "}" in inline table', this.#pos, Math.min(this.#pos + 1, this.#src.length));
    }
  }

  #registerInlineEntry(
    local: Map<string, TableRecord>,
    rootEntries: number[],
    segments: Segment[],
    value: number,
  ): void {
    if (segments.length === 1) {
      const key = pathKey([segments[0].name]);
      if (local.has(key)) {
        this.#fail('duplicate key in inline table', segments[0].start, segments[0].end);
      }
      this.#linkEntryInto(rootEntries, segments[0], value);
      local.set(key, { state: 'Value', item: value });
      return;
    }
    let parentEntries = rootEntries;
    const full: string[] = [];
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      full.push(segment.name);
      const key = pathKey(full);
      const record = local.get(key);
      if (record === undefined) {
        const nested = this.#addEntity(this.#span(segment.start, segment.end), {
          role: 'Item',
          item: { kind: 'InlineTable', entries: [] },
        });
        this.#linkEntryInto(parentEntries, segment, nested);
        local.set(key, { state: 'Dotted', item: nested });
        const nestedKind = this.#entities[nested].kind;
        if (nestedKind.role !== 'Item' || nestedKind.item.kind !== 'InlineTable') {
          throw new Error('internal: toml inline table item expected');
        }
        parentEntries = nestedKind.item.entries;
      } else if (record.state === 'Dotted') {
        const recordKind = this.#entities[record.item].kind;
        if (recordKind.role !== 'Item' || recordKind.item.kind !== 'InlineTable') {
          throw new Error('internal: toml inline table item expected');
        }
        parentEntries = recordKind.item.entries;
      } else {
        this.#fail('dotted key extends a value in inline table', segment.start, segment.end);
      }
    }
    const last = segments[segments.length - 1];
    const leafKey = pathKey([...full, last.name]);
    if (local.has(leafKey)) {
      this.#fail('duplicate key in inline table', last.start, last.end);
    }
    if (parentEntries.some((entry) => this.#entryNameOf(entry) === last.name)) {
      this.#fail('duplicate key in inline table', last.start, last.end);
    }
    this.#linkEntryInto(parentEntries, last, value);
    local.set(leafKey, { state: 'Value', item: value });
  }

  #skipInlineWs(): void {
    for (;;) {
      const c = this.#src.at(this.#pos);
      if (c === 0x20 || c === 0x09) {
        this.#pos += 1;
        continue;
      }
      if (c === 0x0a || c === 0x0d) {
        this.#fail('newline in inline table', this.#pos, this.#pos + 1);
      }
      break;
    }
  }

  // -- bare values (numbers, booleans, dates/times) -------------------------------------

  #parseBareValue(): number {
    const start = this.#pos;
    let end = start;
    while (end < this.#src.length) {
      const c = this.#src.at(end);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x23 || c === 0x2c || c === 0x5d || c === 0x7d || c === 0x3d) {
        break;
      }
      end += 1;
    }
    const token = this.#src.slice(start, end);
    this.#pos = end;
    if (token === 'true') {
      return this.#addEntity(this.#span(start, end), { role: 'Item', item: { kind: 'Boolean', value: true } });
    }
    if (token === 'false') {
      return this.#addEntity(this.#span(start, end), { role: 'Item', item: { kind: 'Boolean', value: false } });
    }
    if (token === 'inf' || token === '+inf') {
      return this.#addEntity(this.#span(start, end), { role: 'Item', item: { kind: 'Float', bits: FLOAT_INF_BITS } });
    }
    if (token === '-inf') {
      return this.#addEntity(this.#span(start, end), { role: 'Item', item: { kind: 'Float', bits: FLOAT_NEG_INF_BITS } });
    }
    if (token === 'nan' || token === '+nan') {
      return this.#addEntity(this.#span(start, end), { role: 'Item', item: { kind: 'Float', bits: FLOAT_NAN_BITS } });
    }
    if (token === '-nan') {
      return this.#addEntity(this.#span(start, end), { role: 'Item', item: { kind: 'Float', bits: FLOAT_NEG_NAN_BITS } });
    }
    if (token.includes(':')) {
      const value = this.#parseDateTimeToken(token, start, end);
      return this.#addEntity(this.#span(start, end), { role: 'Item', item: { kind: 'DateTime', value } });
    }
    const dateMatch = DATE_ONLY_RE.exec(token);
    if (dateMatch !== null) {
      let k = end;
      while (this.#src.at(k) === 0x20 || this.#src.at(k) === 0x09) {
        k += 1;
      }
      if (isDigit(this.#src.at(k))) {
        let end2 = k;
        while (end2 < this.#src.length) {
          const c = this.#src.at(end2);
          if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x23 || c === 0x2c || c === 0x5d || c === 0x7d || c === 0x3d) {
            break;
          }
          end2 += 1;
        }
        const token2 = this.#src.slice(k, end2);
        const timeMatch = TIME_OR_OFFSET_RE.exec(token2);
        if (timeMatch !== null) {
          this.#pos = end2;
          const value = this.#buildDateTime(
            dateMatch[1],
            dateMatch[2],
            dateMatch[3],
            timeMatch[1],
            timeMatch[2],
            timeMatch[3],
            timeMatch[4],
            timeMatch[5],
            timeMatch[6],
            timeMatch[7],
            timeMatch[8],
            start,
            end2,
          );
          return this.#addEntity(this.#span(start, end2), { role: 'Item', item: { kind: 'DateTime', value } });
        }
      }
      const value = this.#buildDateTime(
        dateMatch[1], dateMatch[2], dateMatch[3],
        null, null, null, null, null, null, null, null,
        start, end,
      );
      return this.#addEntity(this.#span(start, end), { role: 'Item', item: { kind: 'DateTime', value } });
    }
    const item = this.#parseNumberToken(token, start, end);
    return this.#addEntity(this.#span(start, end), { role: 'Item', item });
  }

  // -- date/time --------------------------------------------------------------------------

  #parseDateTimeToken(token: string, start: number, end: number): TomlDateTime {
    const m = DATE_TIME_RE.exec(token);
    if (m !== null) {
      return this.#buildDateTime(
        m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11],
        start, end,
      );
    }
    // A bare local time (`07:32:00`, TOML 1.0.0 §4.5.2) carries no date.
    const timeMatch = TIME_OR_OFFSET_RE.exec(token);
    if (timeMatch !== null) {
      return this.#buildDateTime(
        null, null, null,
        timeMatch[1], timeMatch[2], timeMatch[3], timeMatch[4],
        timeMatch[5], timeMatch[6], timeMatch[7], timeMatch[8],
        start, end,
      );
    }
    return this.#fail('invalid date-time value', start, end);
  }

  #buildDateTime(
    y: string | null, mo: string | null, d: string | null,
    h: string | null, mi: string | null, s: string | null,
    frac: string | null,
    z: string | null,
    sign: string | null, oh: string | null, om: string | null,
    start: number,
    end: number,
  ): TomlDateTime {
    // Unmatched regex groups are `undefined`, not `null`; normalize so the
    // `=== null` checks below hold.
    y = y ?? null;
    mo = mo ?? null;
    d = d ?? null;
    h = h ?? null;
    mi = mi ?? null;
    s = s ?? null;
    frac = frac ?? null;
    z = z ?? null;
    sign = sign ?? null;
    oh = oh ?? null;
    om = om ?? null;
    let date: TomlDate | null;
    if (y === null) {
      date = null;
    } else {
      const year = parseInt(y, 10);
      const month = parseInt(mo!, 10);
      const day = parseInt(d!, 10);
      if (!calendarDateValid(year, month, day)) {
        this.#fail('invalid calendar date', start, end);
      }
      date = { year, month, day };
    }
    if (h === null) {
      return { date, time: null, offset: null };
    }
    const hour = parseInt(h, 10);
    const minute = parseInt(mi!, 10);
    const second = parseInt(s!, 10);
    if (hour > 23 || minute > 59 || second > 60) {
      // second 60 is a legal TOML leap second (TOML 1.0.0 §4.5.2; the vector
      // case toml.projection.reject-leap-second parses and fails only at
      // projection time).
      this.#fail('invalid time fields', start, end);
    }
    const fraction = frac === null ? null : frac + '000000000';
    const nanosecond = fraction === null ? 0 : parseInt(fraction.slice(0, 9), 10);
    const time: TomlTime = { hour, minute, second, nanosecond };
    if (z === null && sign === null) {
      return { date, time, offset: null };
    }
    let offset: TomlOffset;
    if (z !== null) {
      offset = { kind: 'Z' };
    } else {
      const offsetHour = parseInt(oh!, 10);
      const offsetMinute = parseInt(om!, 10);
      if (offsetHour > 23 || offsetMinute > 59) {
        this.#fail('invalid UTC offset', start, end);
      }
      const minutes = offsetHour * 60 + offsetMinute;
      offset = { kind: 'CustomMinutes', minutes: sign === '-' ? -minutes : minutes };
    }
    return { date, time, offset };
  }

  // -- numbers -------------------------------------------------------------------------------

  #parseNumberToken(token: string, start: number, end: number): ItemEntityKind {
    if (/^0[xX]/.test(token)) {
      const digits = HEX_RE.exec(token);
      if (digits === null) {
        return this.#fail('invalid hexadecimal integer', start, end);
      }
      return this.#integerOrFail('0x', digits[1], start, end);
    }
    if (/^0[oO]/.test(token)) {
      const digits = OCT_RE.exec(token);
      if (digits === null) {
        return this.#fail('invalid octal integer', start, end);
      }
      return this.#integerOrFail('0o', digits[1], start, end);
    }
    if (/^0[bB]/.test(token)) {
      const digits = BIN_RE.exec(token);
      if (digits === null) {
        return this.#fail('invalid binary integer', start, end);
      }
      return this.#integerOrFail('0b', digits[1], start, end);
    }
    if (/^[+-]?0[xXoObB]/.test(token)) {
      return this.#fail('signed base-prefixed integer is invalid', start, end);
    }
    if (token.includes('.') || /[eE]/.test(token)) {
      const match = FLOAT_RE.exec(token);
      if (match === null) {
        return this.#fail('invalid float', start, end);
      }
      const bits = f64ToBits(Number(token.replace(/_/g, '')));
      return { kind: 'Float', bits };
    }
    const digits = DEC_INT_RE.exec(token);
    if (digits === null) {
      return this.#fail('invalid integer', start, end);
    }
    return this.#integerOrFail('', digits[1], start, end);
  }

  /** Builds an i64-bound integer item; `prefix` re-attaches 0x/0o/0b for BigInt parsing. */
  #integerOrFail(prefix: string, digits: string, start: number, end: number): ItemEntityKind {
    const value = BigInt(prefix + digits.replace(/_/g, ''));
    if (value < I64_MIN || value > I64_MAX) {
      return this.#fail('integer out of range', start, end);
    }
    return { kind: 'Integer', value };
  }
}

// -- helpers -------------------------------------------------------------------------

function elementScope(parentScope: string, record: TableRecord): string {
  const elements = record.aotElements;
  if (elements === undefined || elements.length === 0) {
    throw new Error('internal: array-of-tables record has no elements');
  }
  return `${parentScope}#elem${elements.length - 1}`;
}

function isBareKeyChar(c: number): boolean {
  return (
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    (c >= 0x30 && c <= 0x39) ||
    c === 0x5f ||
    c === 0x2d
  );
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return -1;
}

/** Control characters that must be escaped in strings (TOML 1.0.0 §4.2): U+0000-0008, U+000A-001F, U+007F. */
function isForbiddenControl(c: number): boolean {
  return c <= 0x08 || (c >= 0x0a && c <= 0x1f) || c === 0x7f;
}

/** Valid calendar date, proleptic Gregorian (TOML 1.0.0 §4.5.2 requires a valid calendar date). */
function calendarDateValid(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  let maxDay: number;
  switch (month) {
    case 2:
      maxDay = leap ? 29 : 28;
      break;
    case 4:
    case 6:
    case 9:
    case 11:
      maxDay = 30;
      break;
    default:
      maxDay = 31;
  }
  return day >= 1 && day <= maxDay;
}

/** Exact IEEE-754 binary64 bits of one finite or special double (projection.rs:159 uses to_bits). */
export function f64ToBits(value: number): bigint {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  return view.getBigUint64(0, false);
}

/** Exact double of one IEEE-754 binary64 bit pattern (inverse of f64ToBits). */
export function floatFromBits(bits: bigint): number {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setBigUint64(0, bits, false);
  return view.getFloat64(0, false);
}

// -- frozen token patterns (TOML 1.0.0 §4.5 grammar) ----------------------------------------

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** time or time+offset used after a space-separated date. */
const TIME_OR_OFFSET_RE = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))?$/;
const DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))?$/;
const HEX_RE = /^0[xX]([0-9A-Fa-f](?:_?[0-9A-Fa-f])*)$/;
const OCT_RE = /^0[oO]([0-7](?:_?[0-7])*)$/;
const BIN_RE = /^0[bB]([01](?:_?[01])*)$/;
const DEC_INT_RE = /^([+-]?(?:0|[1-9](?:_?[0-9])*))$/;
const FLOAT_RE =
  /^[+-]?(?:0|[1-9](?:_?[0-9])*)(?:\.([0-9](?:_?[0-9])*))?(?:[eE][+-]?[0-9](?:_?[0-9])*)?$/;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parses one complete TOML 1.0 document into the native entity model
 * (parser.rs:17-63 order: limits, UTF-8, tokenize, preflight, grammar,
 * entity build). Throws TomlFormationFailure on any failure — never a
 * truncated success (RFC 0001 §3).
 */
export function parseTomlText(
  text: string,
  authority: DocumentAuthority,
  limits: ParseLimits,
): TomlParseOutput {
  const src = new CodePointSource(text);
  const parser = new Parser(src, authority, limits);
  return parser.parseDocument();
}
