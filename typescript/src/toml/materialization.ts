/**
 * Deterministic PortableValue materialization for TOML 1.0.
 *
 * authority:
 *  - request contract: RFC 0004 §3 (:57-94); §4 (:98-127) freezes
 *    `toml.canonical-document@1` (style) and `toml.1.0@1` (target);
 *    §6 (:150-168) TOML representability: root Object (or EntryMapping
 *    under UniqueStringEntriesToObject), Boolean/Integer/BinaryFloat64/
 *    String/Date/Time/LocalDateTime/OffsetDateTime/Sequence/Object
 *    recursively; Integer must fit i64; canonical NaN payloads only;
 *    §7 completion algebra (:170-192)
 *  - writer: crates/consema-toml/src/materialization.rs — requested
 *    contract checks (:81-99), root emission one assignment per root entry
 *    plus one final newline (:211-259), string escaping (:357-380),
 *    float canonical spelling (:382-407: "nan"/"-nan" canonical payloads
 *    only, "inf"/"-inf", else Rust f64 display with ".0" appended when no
 *    '.'/'e'), date/time/offset canonical forms (:409-486), arrays
 *    "[a, b]" (:488-508), nested objects as inline tables "{ k = v, ... }"
 *    (:510-536), limit names "input-nodes"/"input-depth"/"output-bytes"
 *  - provenance: RFC 0004 §8 (:193-218); materialization.rs:613-864
 *    (Value/Association input locations; Direct/Reencoded/Generated
 *    relations; EntryMapping → Reencoded)
 *  - the mapping-transformed event: materialization.rs:159-174
 *    (core.materialization.mapping-transformed@1, arguments from/to/policy)
 *  - completion: materialization.rs:53-79 (parse output under original
 *    limits; failure → core.materialization.formation-failed@1)
 *
 * Design (TypeScript-idiomatic): a bounded byte writer mirrors the Rust
 * writer; the result is the sealed RFC 0004 §7 union
 * CompleteMaterialization | FailedMaterializationAttempt from the
 * document domain.
 */

import {
  MaterializationRequest,
  MaterializationReport,
  FailedMaterializationAttempt,
  CompleteMaterialization,
  MaterializationProvenanceEntry,
  MaterializationProvenanceMap,
  MaterializedOrigin,
  newlineBytes,
} from '../document/materialization.ts';
import type {
  MaterializationFidelity,
  MaterializationInputLocation,
  MaterializationLimits,
  MaterializationRelation,
  MaterializationResult,
} from '../document/materialization.ts';
import { MaterializationFailure } from '../document/errors.ts';
import { diagnostic as makeDiagnostic } from '../document/diagnostic.ts';
import { ValuePath, AssociationLocation } from '../document/portable_locations.ts';
import type { ParseLimits } from '../document/formation.ts';
import type { DecimalValue, EntryMappingEntry, Kind, ObjectEntry, PortableValue } from '../core/value.ts';
import { TomlArrayElement, TomlDocument, TomlEntry, TomlItem, parseToml } from './document.ts';
import { TomlProfile } from './profile.ts';
import { floatFromBits } from './parser.ts';

/** Renders one canonical TOML value fragment for structural editing (materialization.rs:36-45). */
export function canonicalTomlFragment(
  value: PortableValue,
  limits: MaterializationLimits,
): Uint8Array {
  const writer = new TomlWriter('Lf', limits);
  writer.value(value, ValuePath.root(), 0);
  return writer.finish();
}

/**
 * Materializes one complete PortableValue into a new immutable TOML
 * document (materialization.rs:19-34). Returns the sealed RFC 0004 §7
 * union; a failed attempt contains no Document and no partial bytes.
 */
export function materializeToml(
  value: PortableValue,
  request: MaterializationRequest,
): MaterializationResult<TomlDocument> {
  let report = new MaterializationReport([], request.limits());
  let writer: TomlWriter | null = null;
  try {
    requestedContract(request);
    const prepared = prepareRoot(value, request, report);
    report = prepared.report;
    const newline = request.newline();
    if (newline !== 'Lf' && newline !== 'CrLf') {
      throw new MaterializationFailure('UnsupportedNewline');
    }
    writer = new TomlWriter(newline, request.limits());
    writer.root(prepared.root);
    const bytes = writer.finish();
    const document = parseToml(bytes, TomlProfile.TOML_10_V1, parseLimitsFor(request.limits()));
    const provenance = collectProvenance(value, document, request.limits());
    return {
      kind: 'Complete',
      value: new CompleteMaterialization(
        document,
        prepared.fidelity,
        report,
        provenance,
      ),
    };
  } catch (failure) {
    if (!(failure instanceof MaterializationFailure)) {
      throw failure;
    }
    return {
      kind: 'Failed',
      value: new FailedMaterializationAttempt(
        failure,
        report,
        writer === null ? [] : writer.analyzedPaths(),
      ),
    };
  }
}

function requestedContract(request: MaterializationRequest): void {
  const target = request.targetProfile();
  if (target.id() !== 'toml.1.0' || target.version() !== 1) {
    throw new MaterializationFailure('UnsupportedProfile');
  }
  const style = request.style();
  if (style.id() !== 'toml.canonical-document' || style.version() !== 1) {
    throw new MaterializationFailure('UnsupportedStyle');
  }
  const encoding = request.encoding();
  if (encoding.kind !== 'Utf8') {
    throw new MaterializationFailure('UnsupportedEncoding');
  }
  const newline = request.newline();
  if (newline !== 'Lf' && newline !== 'CrLf') {
    throw new MaterializationFailure('UnsupportedNewline');
  }
}

type PreparedRoot =
  | { readonly kind: 'Object'; readonly entries: readonly ObjectEntry[] }
  | { readonly kind: 'Mapping'; readonly entries: readonly EntryMappingEntry[] };

interface PreparedMaterialization {
  readonly root: PreparedRoot;
  readonly fidelity: MaterializationFidelity;
  readonly report: MaterializationReport;
}

function prepareRoot(
  value: PortableValue,
  request: MaterializationRequest,
  baseReport: MaterializationReport,
): PreparedMaterialization {
  if (value.kind === 'Object') {
    return {
      root: { kind: 'Object', entries: value.entries },
      fidelity: 'Exact',
      report: baseReport,
    };
  }
  if (value.kind !== 'EntryMapping') {
    throw new MaterializationFailure('Unrepresentable', {
      path: ValuePath.root(),
      valueKind: value.kind,
    });
  }
  if (request.mappingPolicy() !== 'UniqueStringEntriesToObject') {
    throw new MaterializationFailure('Unrepresentable', {
      path: ValuePath.root(),
      valueKind: 'EntryMapping',
    });
  }
  if (value.entries.length > request.limits().maxInputNodes) {
    throw new MaterializationFailure('ResourceLimit', { reason: 'input-nodes' });
  }
  const seen = new Set<string>();
  for (let index = 0; index < value.entries.length; index++) {
    const entry = value.entries[index];
    const path = ValuePath.root().child({ kind: 'EntryKey', index: BigInt(index) });
    if (entry.key.kind !== 'String') {
      throw new MaterializationFailure('Unrepresentable', {
        path,
        valueKind: entry.key.kind,
      });
    }
    if (seen.has(entry.key.value)) {
      throw new MaterializationFailure('Unrepresentable', {
        path,
        valueKind: 'String',
      });
    }
    seen.add(entry.key.value);
  }
  const event = makeDiagnostic(
    'core.materialization.mapping-transformed@1',
    'Materialization',
    'Info',
    null,
    0n,
    {
      arguments: [
        ['from', 'EntryMapping'],
        ['policy', 'UniqueStringEntriesToObject'],
        ['to', 'Object'],
      ],
    },
  );
  // The report is replaced by the single ordered event (materialization.rs:159-174).
  return {
    root: { kind: 'Mapping', entries: value.entries },
    fidelity: 'Transformed',
    report: new MaterializationReport([event], request.limits()),
  };
}

/** Parse limits derived from the materialization limits (materialization.rs:178-186). */
function parseLimitsFor(limits: MaterializationLimits): ParseLimits {
  return {
    maxSourceBytes: limits.maxOutputBytes,
    maxNestingDepth: limits.maxDepth,
    maxTokenCount: limits.maxOutputBytes,
    maxNodeCount: limits.maxInputNodes * 4,
    maxDiagnostics: limits.maxReportEntries,
  };
}

/** Bounded raw output buffer (materialization.rs:569-605). */
class BoundedOutput {
  readonly #chunks: Uint8Array[] = [];
  #length = 0;
  readonly #max: number;

  constructor(max: number) {
    this.#max = max;
  }

  pushByte(byte: number): void {
    this.pushBytes(Uint8Array.of(byte));
  }

  pushBytes(bytes: Uint8Array): void {
    const next = this.#length + bytes.length;
    if (next > this.#max) {
      throw new MaterializationFailure('ResourceLimit', { reason: 'output-bytes' });
    }
    this.#chunks.push(bytes);
    this.#length = next;
  }

  pushText(text: string): void {
    this.pushBytes(new TextEncoder().encode(text));
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.#length);
    let offset = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

/** Canonical TOML 1.0 writer (materialization.rs:188-547). */
class TomlWriter {
  readonly #newline: 'Lf' | 'CrLf';
  readonly #limits: MaterializationLimits;
  #inputNodes = 0;
  readonly #output: BoundedOutput;
  readonly #analyzed: ValuePath[] = [];

  constructor(newline: 'Lf' | 'CrLf', limits: MaterializationLimits) {
    this.#newline = newline;
    this.#limits = limits;
    this.#output = new BoundedOutput(limits.maxOutputBytes);
  }

  analyzedPaths(): readonly ValuePath[] {
    return this.#analyzed;
  }

  root(prepared: PreparedRoot): void {
    const newline = newlineBytes(this.#newline);
    this.analyze(ValuePath.root(), 0);
    if (prepared.kind === 'Object') {
      for (const entry of prepared.entries) {
        this.writeKey(entry.key);
        this.#output.pushBytes(Uint8Array.of(0x20, 0x3d, 0x20)); // " = "
        this.value(
          entry.value,
          ValuePath.root().child({ kind: 'ObjectValue', name: entry.key }),
          1,
        );
        this.#output.pushBytes(newline);
      }
    } else {
      for (let index = 0; index < prepared.entries.length; index++) {
        const entry = prepared.entries[index];
        const key = (entry.key as { kind: 'String'; value: string }).value;
        this.writeKey(key);
        this.#output.pushBytes(Uint8Array.of(0x20, 0x3d, 0x20)); // " = "
        this.value(
          entry.value,
          ValuePath.root().child({ kind: 'EntryValue', index: BigInt(index) }),
          1,
        );
        this.#output.pushBytes(newline);
      }
    }
    if (prepared.entries.length === 0) {
      this.#output.pushBytes(newline);
    }
  }

  value(value: PortableValue, path: ValuePath, depth: number): void {
    this.analyze(path, depth);
    switch (value.kind) {
      case 'Boolean':
        this.#output.pushText(value.value ? 'true' : 'false');
        break;
      case 'Integer':
        if (value.value < -9223372036854775808n || value.value > 9223372036854775807n) {
          this.unrepresentable(path, 'Integer');
        }
        this.#output.pushText(value.value.toString());
        break;
      case 'BinaryFloat64':
        this.writeFloat(value.bits, path);
        break;
      case 'String':
        this.writeString(value.value);
        break;
      case 'Date':
        this.writeDate(value.year, value.month, value.day, path);
        break;
      case 'Time':
        this.writeTime(value.hour, value.minute, value.second, value.fraction, path);
        break;
      case 'LocalDateTime':
        this.writeDate(value.date.year, value.date.month, value.date.day, path);
        this.#output.pushByte(0x54); // T
        this.writeTime(value.time.hour, value.time.minute, value.time.second, value.time.fraction, path);
        break;
      case 'OffsetDateTime':
        this.writeDate(value.local.date.year, value.local.date.month, value.local.date.day, path);
        this.#output.pushByte(0x54); // T
        this.writeTime(
          value.local.time.hour,
          value.local.time.minute,
          value.local.time.second,
          value.local.time.fraction,
          path,
        );
        this.writeOffset(value.offsetSeconds, path);
        break;
      case 'Sequence':
        this.writeSequence(value.items, path, depth);
        break;
      case 'Object':
        this.writeInlineObject(value.entries, path, depth);
        break;
      case 'Null':
      case 'Decimal':
      case 'BinaryFloat32':
      case 'Bytes':
      case 'EntryMapping':
        this.unrepresentable(path, value.kind);
        break;
    }
  }

  analyze(path: ValuePath, depth: number): void {
    if (depth > this.#limits.maxDepth) {
      throw new MaterializationFailure('ResourceLimit', { reason: 'input-depth' });
    }
    this.#inputNodes += 1;
    if (this.#inputNodes > this.#limits.maxInputNodes) {
      throw new MaterializationFailure('ResourceLimit', { reason: 'input-nodes' });
    }
    this.#analyzed.push(path);
  }

  writeKey(key: string): void {
    this.writeString(key);
  }

  /** Deterministic string escaping (materialization.rs:357-380). */
  writeString(value: string): void {
    this.#output.pushByte(0x22); // "
    for (const character of value) {
      const codePoint = character.codePointAt(0)!;
      switch (codePoint) {
        case 0x08:
          this.#output.pushText('\\b');
          break;
        case 0x09:
          this.#output.pushText('\\t');
          break;
        case 0x0a:
          this.#output.pushText('\\n');
          break;
        case 0x0c:
          this.#output.pushText('\\f');
          break;
        case 0x0d:
          this.#output.pushText('\\r');
          break;
        case 0x22:
          this.#output.pushText('\\"');
          break;
        case 0x5c:
          this.#output.pushText('\\\\');
          break;
        default:
          if (codePoint <= 0x1f || codePoint === 0x7f) {
            this.#output.pushText(`\\u${codePoint.toString(16).toUpperCase().padStart(4, '0')}`);
          } else {
            this.#output.pushText(character);
          }
      }
    }
    this.#output.pushByte(0x22); // "
  }

  /** Canonical float spelling (materialization.rs:382-407). */
  writeFloat(bits: bigint, path: ValuePath): void {
    const float = floatFromBits(bits);
    if (Number.isNaN(float)) {
      if (bits === 0x7ff8000000000000n) {
        this.#output.pushText('nan');
        return;
      }
      if (bits === 0xfff8000000000000n) {
        this.#output.pushText('-nan');
        return;
      }
      this.unrepresentable(path, 'BinaryFloat64');
      return;
    }
    if (float === Infinity) {
      this.#output.pushText('inf');
      return;
    }
    if (float === -Infinity) {
      this.#output.pushText('-inf');
      return;
    }
    let text = float.toString();
    if (!text.includes('.') && !text.includes('e') && !text.includes('E')) {
      text += '.0';
    }
    this.#output.pushText(text);
  }

  writeDate(year: bigint, month: number, day: number, path: ValuePath): void {
    if (year < 0n || year > 9999n) {
      this.unrepresentable(path, 'Date');
    }
    this.#output.pushText(year.toString().padStart(4, '0'));
    this.#output.pushByte(0x2d); // -
    this.#output.pushText(month.toString().padStart(2, '0'));
    this.#output.pushByte(0x2d); // -
    this.#output.pushText(day.toString().padStart(2, '0'));
  }

  writeTime(hour: number, minute: number, second: number, fraction: DecimalValue, path: ValuePath): void {
    const nanoseconds = exactNanoseconds(fraction, path);
    this.#output.pushText(hour.toString().padStart(2, '0'));
    this.#output.pushByte(0x3a); // :
    this.#output.pushText(minute.toString().padStart(2, '0'));
    this.#output.pushByte(0x3a); // :
    this.#output.pushText(second.toString().padStart(2, '0'));
    if (nanoseconds !== 0) {
      let width = 9;
      let value = nanoseconds;
      while (value % 10 === 0) {
        value /= 10;
        width -= 1;
      }
      this.#output.pushByte(0x2e); // .
      this.#output.pushText(value.toString().padStart(width, '0'));
    }
  }

  writeOffset(offsetSeconds: number, path: ValuePath): void {
    if (offsetSeconds === 0) {
      this.#output.pushByte(0x5a); // Z
      return;
    }
    if (offsetSeconds % 60 !== 0) {
      this.unrepresentable(path, 'OffsetDateTime');
    }
    const minutes = offsetSeconds / 60;
    if (Math.abs(minutes) >= 24 * 60) {
      this.unrepresentable(path, 'OffsetDateTime');
    }
    const sign = minutes < 0 ? 0x2d : 0x2b; // - / +
    const magnitude = Math.abs(minutes);
    this.#output.pushByte(sign);
    this.#output.pushText(Math.floor(magnitude / 60).toString().padStart(2, '0'));
    this.#output.pushByte(0x3a); // :
    this.#output.pushText((magnitude % 60).toString().padStart(2, '0'));
  }

  writeSequence(values: readonly PortableValue[], path: ValuePath, depth: number): void {
    this.#output.pushByte(0x5b); // [
    for (let index = 0; index < values.length; index++) {
      if (index !== 0) {
        this.#output.pushBytes(Uint8Array.of(0x2c, 0x20)); // ", "
      }
      this.value(
        values[index],
        path.child({ kind: 'SequenceElement', index: BigInt(index) }),
        depth + 1,
      );
    }
    this.#output.pushByte(0x5d); // ]
  }

  writeInlineObject(entries: readonly ObjectEntry[], path: ValuePath, depth: number): void {
    this.#output.pushByte(0x7b); // {
    if (entries.length !== 0) {
      this.#output.pushByte(0x20); // ' '
    }
    for (let index = 0; index < entries.length; index++) {
      if (index !== 0) {
        this.#output.pushBytes(Uint8Array.of(0x2c, 0x20)); // ", "
      }
      this.writeKey(entries[index].key);
      this.#output.pushBytes(Uint8Array.of(0x20, 0x3d, 0x20)); // " = "
      this.value(
        entries[index].value,
        path.child({ kind: 'ObjectValue', name: entries[index].key }),
        depth + 1,
      );
    }
    if (entries.length !== 0) {
      this.#output.pushByte(0x20); // ' '
    }
    this.#output.pushByte(0x7d); // }
  }

  unrepresentable<T = never>(path: ValuePath, kind: Kind): T {
    throw new MaterializationFailure('Unrepresentable', { path, valueKind: kind });
  }

  finish(): Uint8Array {
    return this.#output.finish();
  }
}

/** Exact nanosecond fraction in [0, 1) (materialization.rs:549-567). */
function exactNanoseconds(fraction: DecimalValue, path: ValuePath): number {
  if (fraction.coefficient === 0n) {
    return 0;
  }
  const exponent = Number(fraction.exponent);
  if (exponent < -9 || exponent >= 0) {
    throw new MaterializationFailure('Unrepresentable', { path, valueKind: 'Time' });
  }
  const coefficient = Number(fraction.coefficient);
  if (coefficient < 0) {
    throw new MaterializationFailure('Unrepresentable', { path, valueKind: 'Time' });
  }
  const nanoseconds = coefficient * 10 ** (exponent + 9);
  if (!Number.isSafeInteger(nanoseconds) || nanoseconds >= 1_000_000_000) {
    throw new MaterializationFailure('Unrepresentable', { path, valueKind: 'Time' });
  }
  return nanoseconds;
}

// ---------------------------------------------------------------------------
// Provenance (materialization.rs:613-864)
// ---------------------------------------------------------------------------

function collectProvenance(
  input: PortableValue,
  document: TomlDocument,
  limits: MaterializationLimits,
): MaterializationProvenanceMap {
  const builder = new ProvenanceBuilder(document, limits);
  builder.collect(input, ValuePath.root(), document.root());
  return MaterializationProvenanceMap.create(builder.entries(), document.snapshotIdentity(), limits);
}

class ProvenanceBuilder {
  readonly #document: TomlDocument;
  readonly #limits: MaterializationLimits;
  #units = 0;
  readonly #entries: { input: MaterializationInputLocation; outputs: MaterializedOrigin[] }[] = [];

  constructor(document: TomlDocument, limits: MaterializationLimits) {
    this.#document = document;
    this.#limits = limits;
  }

  entries(): MaterializationProvenanceEntry[] {
    return this.#entries.map((entry) => new MaterializationProvenanceEntry(entry.input, entry.outputs));
  }

  collect(input: PortableValue, path: ValuePath, output: TomlItem): void {
    const relation: MaterializationRelation = input.kind === 'EntryMapping' ? 'Reencoded' : 'Direct';
    this.pushOrigin(
      { kind: 'Value', path },
      this.origin(output.index(), 'TomlItem', relation),
    );
    switch (input.kind) {
      case 'Sequence': {
        const elements = output.arrayElements();
        if (elements === null || elements.length !== input.items.length) {
          throw new MaterializationFailure('FormationFailed');
        }
        for (let index = 0; index < input.items.length; index++) {
          const childPath = path.child({ kind: 'SequenceElement', index: BigInt(index) });
          this.collect(input.items[index], childPath, elements[index].item());
          this.addOutput(
            { kind: 'Value', path: childPath },
            this.origin(elements[index].index(), 'TomlArrayElement', 'Generated'),
          );
        }
        break;
      }
      case 'Object': {
        const entries = output.tableEntries();
        if (entries === null || entries.length !== input.entries.length) {
          throw new MaterializationFailure('FormationFailed');
        }
        for (let index = 0; index < input.entries.length; index++) {
          const entry = entries[index];
          if (entry.name() !== input.entries[index].key) {
            throw new MaterializationFailure('FormationFailed');
          }
          const ordinal = BigInt(index);
          this.pushOrigin(
            { kind: 'Association', location: new AssociationLocation(path, ordinal, 'ObjectEntry') },
            this.origin(entry.index(), 'TomlEntry', 'Direct'),
          );
          this.pushOrigin(
            { kind: 'Association', location: new AssociationLocation(path, ordinal, 'ObjectKey') },
            this.origin(entry.entryKeyIndex(), 'TomlKey', 'Direct'),
          );
          this.collect(
            input.entries[index].value,
            path.child({ kind: 'ObjectValue', name: input.entries[index].key }),
            entry.item(),
          );
        }
        break;
      }
      case 'EntryMapping': {
        const entries = output.tableEntries();
        if (entries === null || entries.length !== input.entries.length) {
          throw new MaterializationFailure('FormationFailed');
        }
        for (let index = 0; index < input.entries.length; index++) {
          const entry = entries[index];
          const key = input.entries[index].key;
          if (key.kind !== 'String' || key.value !== entry.name()) {
            throw new MaterializationFailure('FormationFailed');
          }
          const ordinal = BigInt(index);
          this.pushOrigin(
            { kind: 'Association', location: new AssociationLocation(path, ordinal, 'EntryMappingEntry') },
            this.origin(entry.index(), 'TomlEntry', 'Reencoded'),
          );
          this.pushOrigin(
            { kind: 'Value', path: path.child({ kind: 'EntryKey', index: ordinal }) },
            this.origin(entry.entryKeyIndex(), 'TomlKey', 'Reencoded'),
          );
          this.collect(
            input.entries[index].value,
            path.child({ kind: 'EntryValue', index: ordinal }),
            entry.item(),
          );
        }
        break;
      }
      default:
        if (!scalarKindMatches(input.kind, output.kind())) {
          throw new MaterializationFailure('FormationFailed');
        }
    }
  }

  origin(
    index: number,
    role: 'TomlItem' | 'TomlEntry' | 'TomlKey' | 'TomlArrayElement',
    relation: MaterializationRelation,
  ): MaterializedOrigin {
    return new MaterializedOrigin(
      this.#document.snapshotIdentity(),
      this.#document.nodeRef(index, role),
      this.#document.entity(index).span,
      relation,
    );
  }

  pushOrigin(input: MaterializationInputLocation, output: MaterializedOrigin): void {
    this.#units += 2;
    if (this.#units > this.#limits.maxProvenanceEntries) {
      throw new MaterializationFailure('ResourceLimit', { reason: 'provenance-entries' });
    }
    this.#entries.push({ input, outputs: [output] });
  }

  addOutput(input: MaterializationInputLocation, output: MaterializedOrigin): void {
    this.#units += 1;
    if (this.#units > this.#limits.maxProvenanceEntries) {
      throw new MaterializationFailure('ResourceLimit', { reason: 'provenance-entries' });
    }
    const entry = this.#entries.find((candidate) => inputLocationEquals(candidate.input, input));
    if (entry === undefined) {
      throw new MaterializationFailure('FormationFailed');
    }
    entry.outputs.push(output);
  }
}

function inputLocationEquals(left: MaterializationInputLocation, right: MaterializationInputLocation): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'Value' && right.kind === 'Value') {
    return left.path.equals(right.path);
  }
  if (left.kind === 'Association' && right.kind === 'Association') {
    const a = left.location;
    const b = right.location;
    return a.container().equals(b.container()) && a.ordinal() === b.ordinal() && a.role() === b.role();
  }
  return false;
}

/** Kind match between a portable scalar and its generated item (materialization.rs:866-884). */
function scalarKindMatches(input: string, output: string): boolean {
  switch (input) {
    case 'String':
      return output === 'String';
    case 'Integer':
      return output === 'Integer';
    case 'BinaryFloat64':
      return output === 'Float';
    case 'Boolean':
      return output === 'Boolean';
    case 'Date':
      return output === 'LocalDate';
    case 'Time':
      return output === 'LocalTime';
    case 'LocalDateTime':
      return output === 'LocalDateTime';
    case 'OffsetDateTime':
      return output === 'OffsetDateTime';
    default:
      return false;
  }
}
