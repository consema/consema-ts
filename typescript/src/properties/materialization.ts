/**
 * Canonical PortableValue materialization for exact Java Properties profiles.
 *
 * authority:
 *  - RFC 0010 §12 (docs/rfcs/0010-java-properties-profiles-v1.md:351-381):
 *    canonical styles `java-properties.reader-canonical@1` and
 *    `java-properties.latin1-canonical@1`; associations in input order as
 *    `key=value` with the explicitly selected newline; deterministic
 *    escaping of backslash, control characters, key spaces, leading value
 *    spaces, `#`, `!`, `=`, `:`; uppercase four-digit Unicode escapes per
 *    UTF-16 code unit; Reader emits well-formed non-ASCII scalars directly;
 *    Latin-1 uses named escapes for tab/LF/CR/FF and `\uXXXX` for other code
 *    units below U+0020 or above U+007E (supplementary scalars become
 *    surrogate-pair escapes); no Latin-1 BOM; every result reparses under
 *    the exact target profile and reprojects under the request's policy
 *  - crates/consema-properties/src/materialization.rs — materialize :25-39,
 *    materialize_complete :41-77, requested_profile :79-90,
 *    validate_request :92-122, parse_limits :124-150, Writer :167-346
 *    (document :177-211, mapping_items :213-288, analyze :290-306,
 *    write_string :308-336, write_unicode_scalar :338-346),
 *    verify_closure :348-395, build_provenance :397-448,
 *    BoundedText :470-518, text_budget :520-534, encode_text :536-564,
 *    encode_fragment :566-631
 *  - common materialization contracts: RFC 0004 §3/§7/§8;
 *    typescript/src/document/materialization.ts
 *  - frozen codes: crates/consema-protocol/src/error_registry.rs:556-604
 *    (core.materialization.*@1), :1123-1127
 *    (java-properties.materialization.round-trip-mismatch@1)
 *  - vector-pinned behavior: conformance/vectors/java-properties-v1.json
 *    (materialization.canonical-styles-encodings-and-closure,
 *    materialization.atomic-failures-and-limits)
 *
 * RECORDED DIVERGENCE (blind-write, L2, mirrors the L1 source divergence):
 * Windows code pages 932, 936, 949, 950 are recognized but cannot be
 * encoded by the single-byte tables in typescript/src/document/cp_tables.ts
 * (documented at source.ts:897-912); materialization to those pages fails
 * with `UnsupportedEncoding`. The shared vectors exercise only cp1252.
 *
 * Design (TypeScript-idiomatic): one bounded text writer walks the input
 * mapping once and fails atomically on any limit; the generated text is
 * encoded under the requested source encoding, reparsed under the exact
 * target profile, and closed by an exact projection comparison before any
 * Complete result is published (RFC 0010 §12 :379-381).
 */

import { MaterializationFailure } from '../document/errors.ts';
import {
  CompleteMaterialization,
  FailedMaterializationAttempt,
  MaterializationProvenanceEntry,
  MaterializationProvenanceMap,
  MaterializationReport,
  MaterializationRequest,
  MaterializedOrigin,
} from '../document/materialization.ts';
import type {
  MaterializationInputLocation,
  MaterializationLimits,
  MaterializationRelation,
  MaterializationResult,
  NewlinePolicy,
} from '../document/materialization.ts';
import { AssociationLocation, ValuePath } from '../document/portable_locations.ts';
import type { ValuePathSegment } from '../document/portable_locations.ts';
import { NodeRef, Span } from '../document/identity.ts';
import { WindowsCodePage } from '../document/source.ts';
import type { SourceEncoding } from '../document/source.ts';
import { singleByteTableFor, MALFORMED_BYTE_SENTINEL } from '../document/cp_tables.ts';
import { equal } from '../core/equal.ts';
import type { PortableValue } from '../core/value.ts';
import { parseLatin1, parseReader } from './parser.ts';
import { PropertiesDocument } from './document.ts';
import type { PropertiesProfile } from './profile.ts';
import type { PropertiesParseLimits } from './parse_limits.ts';
import { project } from './projection.ts';
import { DEFAULT_PROJECTION_LIMITS, ProjectionRequest } from './projection.ts';

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Materializes one flat String mapping into a new canonical Properties document (materialization.rs:25-39). */
export function materialize(
  value: PortableValue,
  request: MaterializationRequest,
): MaterializationResult<PropertiesDocument> {
  const analyzed: ValuePath[] = [];
  try {
    return { kind: 'Complete', value: materializeComplete(value, request, analyzed) };
  } catch (error) {
    if (!(error instanceof MaterializationFailure)) {
      throw error;
    }
    return {
      kind: 'Failed',
      value: new FailedMaterializationAttempt(error, new MaterializationReport([], request.limits()), analyzed),
    };
  }
}

function materializeComplete(
  value: PortableValue,
  request: MaterializationRequest,
  analyzed: ValuePath[],
): CompleteMaterialization<PropertiesDocument> {
  const profile = requestedProfile(request);
  validateRequest(request, profile);
  const textLimit = textBudget(request.encoding(), request.limits().maxOutputBytes);
  const writer = new Writer(profile, request.newline(), request.limits(), textLimit, analyzed);
  const inputEntries = writer.document(value, ValuePath.root(), 0);
  const text = writer.output.finish();
  const bytes = encodeText(text, request.encoding(), request.limits().maxOutputBytes);
  let document: PropertiesDocument;
  try {
    document = reparse(bytes, profile, request);
  } catch {
    throw new MaterializationFailure('FormationFailed');
  }
  if (document.formationStatus() !== 'Complete') {
    throw new MaterializationFailure('FormationFailed');
  }
  verifyClosure(value, request, document);
  const provenance = buildProvenance(inputEntries, document, request.limits());
  return new CompleteMaterialization(
    document,
    'Exact',
    new MaterializationReport([], request.limits()),
    provenance,
  );
}

function requestedProfile(request: MaterializationRequest): PropertiesProfile {
  const profile = request.targetProfile();
  if (profile.id() === 'java-properties.reader' && profile.version() === 1) {
    return 'ReaderV1';
  }
  if (profile.id() === 'java-properties.latin1' && profile.version() === 1) {
    return 'Latin1V1';
  }
  throw new MaterializationFailure('UnsupportedProfile');
}

function validateRequest(request: MaterializationRequest, profile: PropertiesProfile): void {
  const styleMatches =
    (profile === 'ReaderV1' &&
      request.style().id() === 'java-properties.reader-canonical' &&
      request.style().version() === 1) ||
    (profile === 'Latin1V1' &&
      request.style().id() === 'java-properties.latin1-canonical' &&
      request.style().version() === 1);
  if (!styleMatches) {
    throw new MaterializationFailure('UnsupportedStyle');
  }
  const newline = request.newline();
  if (newline !== 'Lf' && newline !== 'CrLf') {
    throw new MaterializationFailure('UnsupportedNewline');
  }
  const encoding = request.encoding();
  const encodingValid =
    profile === 'ReaderV1' ? encoding.kind !== 'Binary' : encoding.kind === 'Latin1';
  if (!encodingValid) {
    throw new MaterializationFailure('UnsupportedEncoding');
  }
}

/** Re-parses the generated bytes under the exact target profile (materialization.rs:60-68). */
function reparse(bytes: Uint8Array, profile: PropertiesProfile, request: MaterializationRequest): PropertiesDocument {
  const limits = parseLimitsFor(request.limits());
  if (profile === 'ReaderV1') {
    return parseReader(bytes, request.encoding(), limits);
  }
  return parseLatin1(bytes, limits);
}

/** Properties parse limits derived from one materialization budget (materialization.rs:124-150). */
function parseLimitsFor(limits: MaterializationLimits): PropertiesParseLimits {
  return {
    common: {
      maxSourceBytes: limits.maxOutputBytes,
      maxNestingDepth: limits.maxDepth,
      maxTokenCount: limits.maxOutputBytes,
      maxNodeCount: limits.maxOutputBytes * 2 + 1,
      maxDiagnostics: limits.maxReportEntries,
    },
    maxDecodedUtf8Bytes: limits.maxOutputBytes * 3,
    maxDecodedScalars: limits.maxOutputBytes * 2,
    maxNaturalLines: limits.maxInputNodes,
    maxNaturalLineBytes: limits.maxOutputBytes,
    maxNaturalLineScalars: limits.maxOutputBytes,
    maxLogicalLines: limits.maxInputNodes,
    maxLogicalLineNaturalLines: 1,
    maxLogicalLineScalars: limits.maxOutputBytes,
    maxProperties: limits.maxInputNodes,
    maxComments: 0,
    maxEscapes: limits.maxOutputBytes,
    maxUnicodeEscapes: limits.maxOutputBytes,
    maxJavaCodeUnitsPerString: limits.maxOutputBytes,
    maxTotalJavaCodeUnits: limits.maxOutputBytes * 2,
    maxDuplicateGroupMembers: limits.maxInputNodes,
    maxRecoveryRegions: limits.maxReportEntries,
  };
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

interface InputEntry {
  readonly association: MaterializationInputLocation;
  readonly key: MaterializationInputLocation;
  readonly value: MaterializationInputLocation;
}

interface MappingItem {
  readonly key: string;
  readonly value: PortableValue;
  readonly association: MaterializationInputLocation;
  readonly keyLocation: MaterializationInputLocation;
  readonly valuePath: ValuePath;
}

class Writer {
  readonly #profile: PropertiesProfile;
  readonly #newline: NewlinePolicy;
  readonly #limits: MaterializationLimits;
  readonly #analyzed: ValuePath[];
  readonly output: BoundedText;
  #inputNodes = 0;

  constructor(
    profile: PropertiesProfile,
    newline: NewlinePolicy,
    limits: MaterializationLimits,
    textLimit: number,
    analyzed: ValuePath[],
  ) {
    this.#profile = profile;
    this.#newline = newline;
    this.#limits = limits;
    this.#analyzed = analyzed;
    this.output = new BoundedText(textLimit);
  }

  document(value: PortableValue, path: ValuePath, depth: number): InputEntry[] {
    const entries = this.mappingItems(value, path, depth);
    const inputEntries: InputEntry[] = [];
    for (const entry of entries) {
      this.analyze(entry.valuePath, depth + 1);
      if (entry.value.kind !== 'String') {
        throw new MaterializationFailure('Unrepresentable', {
          path: entry.valuePath,
          valueKind: entry.value.kind,
        });
      }
      this.writeString(entry.key, true);
      this.output.pushChar('=');
      this.writeString(entry.value.value, false);
      this.output.pushText(this.#newline === 'CrLf' ? '\r\n' : '\n');
      inputEntries.push({
        association: entry.association,
        key: entry.keyLocation,
        value: { kind: 'Value', path: entry.valuePath },
      });
    }
    return inputEntries;
  }

  mappingItems(value: PortableValue, path: ValuePath, depth: number): MappingItem[] {
    this.analyze(path, depth);
    let items: MappingItem[] = [];
    if (value.kind === 'Object') {
      const entries = value.entries;
      if (entries.length > this.#limits.maxInputNodes) {
        throw new MaterializationFailure('ResourceLimit', { reason: 'input-nodes' });
      }
      items = entries.map((entry, index) => {
        return {
          key: entry.key,
          value: entry.value,
          association: {
            kind: 'Association',
            location: new AssociationLocation(path, BigInt(index), 'ObjectEntry'),
          },
          keyLocation: {
            kind: 'Association',
            location: new AssociationLocation(path, BigInt(index), 'ObjectKey'),
          },
          valuePath: path.child({ kind: 'ObjectValue', name: entry.key }),
        };
      });
    } else if (value.kind === 'EntryMapping') {
      const entries = value.entries;
      if (entries.length > this.#limits.maxInputNodes) {
        throw new MaterializationFailure('ResourceLimit', { reason: 'input-nodes' });
      }
      items = entries.map((entry, index) => {
        const keyPath = path.child({ kind: 'EntryKey', index: BigInt(index) });
        this.analyze(keyPath, depth + 1);
        if (entry.key.kind !== 'String') {
          throw new MaterializationFailure('Unrepresentable', {
            path: keyPath,
            valueKind: entry.key.kind,
          });
        }
        return {
          key: entry.key.value,
          value: entry.value,
          association: {
            kind: 'Association',
            location: new AssociationLocation(path, BigInt(index), 'EntryMappingEntry'),
          },
          keyLocation: { kind: 'Value', path: keyPath },
          valuePath: path.child({ kind: 'EntryValue', index: BigInt(index) }),
        };
      });
    } else {
      throw new MaterializationFailure('Unrepresentable', { path, valueKind: value.kind });
    }
    return items;
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

  writeString(value: string, isKey: boolean): void {
    let leadingValueSpace = !isKey;
    for (const character of value) {
      const codePoint = character.codePointAt(0)!;
      if (character === ' ' && (isKey || leadingValueSpace)) {
        this.output.pushText('\\ ');
      } else if (character === '\t') {
        this.output.pushText('\\t');
      } else if (character === '\n') {
        this.output.pushText('\\n');
      } else if (character === '\r') {
        this.output.pushText('\\r');
      } else if (codePoint === 0x0c) {
        this.output.pushText('\\f');
      } else if (character === '\\') {
        this.output.pushText('\\\\');
      } else if (character === '#' || character === '!' || character === '=' || character === ':') {
        this.output.pushChar('\\');
        this.output.pushChar(character);
      } else if (isControlCodePoint(codePoint)) {
        this.writeUnicodeScalar(character);
      } else if (this.#profile === 'Latin1V1' && !(codePoint >= 0x20 && codePoint <= 0x7e)) {
        this.writeUnicodeScalar(character);
      } else {
        this.output.pushChar(character);
      }
      if (character !== ' ') {
        leadingValueSpace = false;
      }
    }
  }

  writeUnicodeScalar(value: string): void {
    const units = codeUnitsOf(value);
    for (const unit of units) {
      this.output.pushText('\\u');
      this.output.pushHexUnit(unit);
    }
  }
}

/** Rust `char::is_control()`: C0 (U+0000-001F) plus C1 (U+007F-009F) (materialization.rs:322). */
function isControlCodePoint(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function codeUnitsOf(character: string): readonly number[] {
  if (character.length === 1) {
    return [character.charCodeAt(0)];
  }
  return [character.charCodeAt(0), character.charCodeAt(1)];
}

class BoundedText {
  #text = '';
  #utf8Bytes = 0;
  readonly #maxBytes: number;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  pushText(value: string): void {
    const newLength = this.#utf8Bytes + utf8Length(value);
    if (newLength > this.#maxBytes) {
      throw new MaterializationFailure('ResourceLimit', { reason: 'output-bytes' });
    }
    this.#text += value;
    this.#utf8Bytes = newLength;
  }

  pushChar(value: string): void {
    this.pushText(value);
  }

  pushHexUnit(value: number): void {
    const digits = value.toString(16).toUpperCase().padStart(4, '0');
    this.pushText(digits);
  }

  finish(): string {
    return this.#text;
  }
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** Text budget per selected encoding (materialization.rs:520-534). */
function textBudget(encoding: SourceEncoding, maxOutputBytes: number): number {
  switch (encoding.kind) {
    case 'Utf16Le':
    case 'Utf16Be':
    case 'Latin1':
      return maxOutputBytes * 2;
    case 'WindowsCodePage':
      if (encoding.codePage.number() !== 65001) {
        return maxOutputBytes * 3;
      }
      return maxOutputBytes;
    case 'Binary':
      throw new MaterializationFailure('UnsupportedEncoding');
    case 'Utf8':
      return maxOutputBytes;
  }
}

/** Encodes generated text under one selected encoding, emitting the UTF-16 BOM (materialization.rs:536-564). */
function encodeText(text: string, encoding: SourceEncoding, maxOutputBytes: number): Uint8Array {
  const bomBytes = encoding.kind === 'Utf16Le' || encoding.kind === 'Utf16Be' ? 2 : 0;
  const fragmentLimit = maxOutputBytes - bomBytes;
  if (fragmentLimit < 0) {
    throw new MaterializationFailure('ResourceLimit', { reason: 'output-bytes' });
  }
  const fragment = encodeFragment(text, encoding, fragmentLimit);
  if (bomBytes === 0) {
    return fragment;
  }
  const output = new Uint8Array(fragment.length + 2);
  output[0] = encoding.kind === 'Utf16Le' ? 0xff : 0xfe;
  output[1] = encoding.kind === 'Utf16Le' ? 0xfe : 0xff;
  output.set(fragment, 2);
  return output;
}

/** Exact fragment encoding without a BOM (materialization.rs:566-631). */
export function encodeFragment(
  text: string,
  encoding: SourceEncoding,
  maxOutputBytes: number,
): Uint8Array {
  let output: Uint8Array;
  switch (encoding.kind) {
    case 'Utf8':
      output = new TextEncoder().encode(text);
      break;
    case 'Utf16Le':
    case 'Utf16Be': {
      const units = text.length;
      const length = units * 2;
      if (length > maxOutputBytes) {
        throw new MaterializationFailure('ResourceLimit', { reason: 'output-bytes' });
      }
      output = new Uint8Array(length);
      for (let index = 0; index < text.length; index++) {
        const unit = text.charCodeAt(index);
        if (encoding.kind === 'Utf16Le') {
          output[index * 2] = unit & 0xff;
          output[index * 2 + 1] = (unit >>> 8) & 0xff;
        } else {
          output[index * 2] = (unit >>> 8) & 0xff;
          output[index * 2 + 1] = unit & 0xff;
        }
      }
      break;
    }
    case 'Latin1': {
      const scalars = scalarCount(text);
      if (scalars > maxOutputBytes) {
        throw new MaterializationFailure('ResourceLimit', { reason: 'output-bytes' });
      }
      output = new Uint8Array(scalars);
      let index = 0;
      for (const character of text) {
        const codePoint = character.codePointAt(0)!;
        if (codePoint > 0xff) {
          throw new MaterializationFailure('UnsupportedEncoding');
        }
        output[index] = codePoint;
        index += 1;
      }
      break;
    }
    case 'WindowsCodePage': {
      output = encodeCodePage(text, encoding.codePage, maxOutputBytes);
      break;
    }
    case 'Binary':
      throw new MaterializationFailure('UnsupportedEncoding');
  }
  if (output.length > maxOutputBytes) {
    throw new MaterializationFailure('ResourceLimit', { reason: 'output-bytes' });
  }
  return output;
}

/**
 * Strict single-byte code-page encoding; multi-byte pages 932/936/949/950
 * are recognized but cannot be encoded by the frozen single-byte tables
 * (see the RECORDED DIVERGENCE note above).
 */
function encodeCodePage(text: string, page: WindowsCodePage, maxOutputBytes: number): Uint8Array {
  const pageNumber = page.number();
  if (pageNumber === 65001) {
    return new TextEncoder().encode(text);
  }
  const table = singleByteTableFor(pageNumber);
  if (table === null) {
    // 932, 936, 949, 950 (see the RECORDED DIVERGENCE note above).
    throw new MaterializationFailure('UnsupportedEncoding');
  }
  const reverse = new Map<number, number>();
  for (let index = 0; index < table.length; index++) {
    const scalar = table[index];
    if (scalar !== MALFORMED_BYTE_SENTINEL && !reverse.has(scalar)) {
      reverse.set(scalar, 0x80 + index);
    }
  }
  const scalars = scalarCount(text);
  if (scalars > maxOutputBytes) {
    throw new MaterializationFailure('ResourceLimit', { reason: 'output-bytes' });
  }
  const output = new Uint8Array(scalars);
  let index = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    const byte = codePoint < 0x80 ? codePoint : reverse.get(codePoint);
    if (byte === undefined) {
      throw new MaterializationFailure('UnsupportedEncoding');
    }
    output[index] = byte;
    index += 1;
  }
  return output;
}

function scalarCount(text: string): number {
  let count = 0;
  for (const _ of text) {
    count += 1;
  }
  return count;
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint < 0x80) bytes += 1;
    else if (codePoint < 0x800) bytes += 2;
    else if (codePoint < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Closure and provenance
// ---------------------------------------------------------------------------

/** Exact projection closure of the generated document (materialization.rs:348-395). */
function verifyClosure(
  input: PortableValue,
  request: MaterializationRequest,
  document: PropertiesDocument,
): void {
  const projectionLimits = {
    maxSourceAssociations: request.limits().maxInputNodes,
    maxValueNodes: request.limits().maxInputNodes * 2 + 1,
    maxReportEntries: request.limits().maxReportEntries,
    maxProvenanceUnits: request.limits().maxProvenanceEntries,
  };
  const projection = project(
    document,
    input.kind === 'Object'
      ? ProjectionRequest.requireObject('RequireUnique').withLimits(projectionLimits)
      : ProjectionRequest.bestExactEntryMapping().withLimits(projectionLimits),
  );
  switch (projection.kind) {
    case 'Complete':
      if (!equal(projection.value.value(), input)) {
        throw new MaterializationFailure('FormationFailed');
      }
      return;
    case 'Failed': {
      const first = projection.value.diagnostics()[0];
      if (first !== undefined && first.code === 'core.projection.resource-limit@1') {
        const limit = first.arguments.get('limit');
        throw new MaterializationFailure('ResourceLimit', {
          reason: materializationLimitName(limit),
        });
      }
      throw new MaterializationFailure('FormationFailed');
    }
  }
}

function materializationLimitName(limit: string | undefined): string {
  switch (limit) {
    case 'max_source_associations':
    case 'max_value_nodes':
      return 'input-nodes';
    case 'max_report_entries':
      return 'report-entries';
    case 'max_provenance_units':
      return 'provenance-entries';
    default:
      return 'projection';
  }
}

/** Complete input-to-output provenance (materialization.rs:397-448). */
function buildProvenance(
  inputEntries: readonly InputEntry[],
  document: PropertiesDocument,
  limits: MaterializationLimits,
): MaterializationProvenanceMap {
  if (inputEntries.length !== document.properties().length) {
    throw new MaterializationFailure('FormationFailed');
  }
  const entries: MaterializationProvenanceEntry[] = [];
  const rootSpan = document.authorityInternal().span(0, document.source().len());
  entries.push(
    new MaterializationProvenanceEntry(
      { kind: 'Value', path: ValuePath.root() },
      [new MaterializedOrigin(document.snapshotIdentity(), document.nodeRef(), rootSpan, 'Reencoded')],
    ),
  );
  const properties = document.properties();
  for (let index = 0; index < inputEntries.length; index++) {
    const input = inputEntries[index];
    const property = properties[index];
    entries.push(
      provenanceEntry(input.association, property.nodeRef(), [property.span()], document),
    );
    entries.push(
      provenanceEntry(input.key, property.nodeRef(), nonemptySpans(property.keyFragments(), property.keyAnchor()), document),
    );
    entries.push(
      provenanceEntry(input.value, property.nodeRef(), nonemptySpans(property.valueFragments(), property.valueAnchor()), document),
    );
  }
  return MaterializationProvenanceMap.create(entries, document.snapshotIdentity(), limits);
}

function nonemptySpans(fragments: readonly Span[], anchor: Span): readonly Span[] {
  if (fragments.length === 0) {
    return [anchor];
  }
  return fragments;
}

function provenanceEntry(
  input: MaterializationInputLocation,
  node: NodeRef,
  spans: readonly Span[],
  document: PropertiesDocument,
): MaterializationProvenanceEntry {
  return new MaterializationProvenanceEntry(
    input,
    spans.map((span) => {
      return new MaterializedOrigin(document.snapshotIdentity(), node, span, 'Reencoded');
    }),
  );
}
