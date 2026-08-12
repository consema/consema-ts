/**
 * Deterministic PortableValue materialization for the three INI profiles.
 *
 * authority:
 *  - request contract: RFC 0009 §11 (:387-435) — the canonical styles
 *    ini.portable-canonical@1 / ini.windows-canonical@1 /
 *    ini.python-configparser-canonical@1 (:393-399); portable requires
 *    UTF-8 plus LF, Windows requires UTF-16LE plus BOM or one explicit
 *    registered Windows code page plus CRLF, Python requires one
 *    non-Binary registered text encoding plus LF (:401-406); both levels
 *    consistently nested EntryMapping or Object with every name a String
 *    (:407-415); strict encoding (:406); all styles reparse under the
 *    exact target profile and reproject before success (:431-435)
 *  - writer: crates/consema-ini/src/materialization.rs — requested
 *    contract checks (:91-127), parse-limit derivation (:137-160),
 *    mapping-item extraction (:255-331), section/key validation
 *    (:348-382), canonical entry spellings (:384-453), Python multiline
 *    emission (:423-453), Windows case-collision rejection (:473-487),
 *    closure verification (:489-535), provenance (:537-677), bounded
 *    output and encoding (:679-850: text_budget :724-738, encode_fragment
 *    :770-829, code-page table :831-850, windows_value_needs_quotes
 *    :874-888)
 *  - completion algebra: RFC 0004 §7; a failed attempt contains no
 *    Document and no partial output bytes
 *  - the vector suite pins the three canonical outputs and closure
 *    (conformance/vectors/ini-v1.json:74-87)
 *
 * Design (TypeScript-idiomatic): a bounded text writer mirrors the Rust
 * writer; the result is the sealed RFC 0004 §7 union
 * CompleteMaterialization | FailedMaterializationAttempt from the
 * document domain. Single-byte Windows code pages encode through the
 * frozen decode tables reversed at load time (source contract v2,
 * document/cp_tables.ts); the multi-byte pages 932/936/949/950 remain a
 * recorded L1 divergence (document/source.ts:897-912) and fail with
 * UnsupportedEncoding.
 */

import {
  CompleteMaterialization,
  FailedMaterializationAttempt,
  MaterializationProvenanceEntry,
  MaterializationProvenanceMap,
  MaterializationReport,
  MaterializationRequest,
  MaterializedOrigin,
  type MaterializationInputLocation,
  type MaterializationLimits,
  type MaterializationRelation,
  type MaterializationResult,
} from '../document/materialization.ts';
import { MaterializationFailure } from '../document/errors.ts';
import { ValuePath, AssociationLocation } from '../document/portable_locations.ts';
import { equal } from '../core/equal.ts';
import type { PortableValue } from '../core/value.ts';
import { MALFORMED_BYTE_SENTINEL, singleByteTableFor } from '../document/cp_tables.ts';
import type { SourceEncoding } from '../document/source.ts';
import type { NodeRef, Span } from '../document/identity.ts';
import type { IniDocument, IniEntry } from './document.ts';
import { parseIniDocument } from './document.ts';
import {
  IniProfile,
  explicitSelection,
  profileDefaultSelection,
  type IniEncodingSelection,
  type IniParseLimits,
} from './profile.ts';
import { IniProjectionRequest, projectIni } from './projection.ts';

/**
 * Materializes one complete PortableValue into a new immutable INI
 * document (materialization.rs:27-41). Returns the sealed RFC 0004 §7
 * union; a failed attempt contains no Document and no partial bytes.
 */
export function materializeIni(
  value: PortableValue,
  request: MaterializationRequest,
): MaterializationResult<IniDocument> {
  let report = new MaterializationReport([], request.limits());
  let writer: IniWriter | null = null;
  try {
    const profile = requestedProfile(request);
    validateRequest(request, profile);
    const utf8Budget = textBudget(request.encoding(), request.limits().maxOutputBytes);
    writer = new IniWriter(profile, request.limits(), utf8Budget);
    const sections = writer.document(value, ValuePath.root(), 0);
    const text = writer.finish();
    const bytes = encodeText(text, request.encoding(), request.limits().maxOutputBytes);
    const selection = parseEncodingSelection(profile, request.encoding());
    let document: IniDocument;
    try {
      document = parseIniDocument(bytes, profile, selection, parseLimitsFor(request.limits()));
    } catch {
      throw new MaterializationFailure('FormationFailed');
    }
    if (document.formationStatus() !== 'Complete') {
      throw new MaterializationFailure('FormationFailed');
    }
    verifyClosure(value, request, document);
    const provenance = buildProvenance(value, sections, document, request.limits());
    return {
      kind: 'Complete',
      value: new CompleteMaterialization(document, 'Exact', report, provenance),
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

function requestedProfile(request: MaterializationRequest): IniProfile {
  const target = request.targetProfile();
  switch (target.toString()) {
    case 'ini.portable@1':
      return IniProfile.PORTABLE_V1;
    case 'ini.windows@1':
      return IniProfile.WINDOWS_V1;
    case 'ini.python-configparser@1':
      return IniProfile.PYTHON_CONFIGPARSER_V1;
    default:
      throw new MaterializationFailure('UnsupportedProfile');
  }
}

function validateRequest(request: MaterializationRequest, profile: IniProfile): void {
  const style = request.style();
  const styleMatches =
    (profile.tag() === 'PortableV1' && style.id() === 'ini.portable-canonical' && style.version() === 1) ||
    (profile.tag() === 'WindowsV1' && style.id() === 'ini.windows-canonical' && style.version() === 1) ||
    (profile.tag() === 'PythonConfigParserV1' &&
      style.id() === 'ini.python-configparser-canonical' &&
      style.version() === 1);
  if (!styleMatches) {
    throw new MaterializationFailure('UnsupportedStyle');
  }
  const expectedNewline = profile.tag() === 'WindowsV1' ? 'CrLf' : 'Lf';
  if (request.newline() !== expectedNewline) {
    throw new MaterializationFailure('UnsupportedNewline');
  }
  const encoding = request.encoding();
  const encodingValid =
    profile.tag() === 'PortableV1'
      ? encoding.kind === 'Utf8'
      : profile.tag() === 'WindowsV1'
        ? encoding.kind === 'Utf16Le' || encoding.kind === 'WindowsCodePage'
        : encoding.kind !== 'Binary';
  if (!encodingValid) {
    throw new MaterializationFailure('UnsupportedEncoding');
  }
}

function parseEncodingSelection(profile: IniProfile, encoding: SourceEncoding): IniEncodingSelection {
  if (
    (profile.tag() === 'PortableV1' || profile.tag() === 'PythonConfigParserV1') &&
    encoding.kind === 'Utf8'
  ) {
    return profileDefaultSelection();
  }
  if (profile.tag() === 'WindowsV1' && encoding.kind === 'Utf16Le') {
    return profileDefaultSelection();
  }
  return explicitSelection(encoding);
}

/** Parse limits derived from the materialization limits (materialization.rs:137-160). */
function parseLimitsFor(limits: MaterializationLimits): IniParseLimits {
  return {
    common: {
      maxSourceBytes: limits.maxOutputBytes,
      maxNestingDepth: limits.maxDepth,
      maxTokenCount: limits.maxOutputBytes,
      maxNodeCount: limits.maxOutputBytes,
      maxDiagnostics: limits.maxReportEntries,
    },
    maxDecodedUtf8Bytes: limits.maxOutputBytes * 3,
    maxDecodedScalars: limits.maxOutputBytes,
    maxPhysicalLines: limits.maxOutputBytes,
    maxPhysicalLineBytes: limits.maxOutputBytes,
    maxPhysicalLineScalars: limits.maxOutputBytes,
    maxLogicalLines: limits.maxInputNodes,
    maxLogicalLineBytes: limits.maxOutputBytes,
    maxLogicalLineScalars: limits.maxOutputBytes,
    maxContinuationLines: limits.maxOutputBytes,
    maxSections: limits.maxInputNodes,
    maxEntries: limits.maxInputNodes,
    maxDuplicateGroupMembers: limits.maxInputNodes,
    maxRecoveryRegions: limits.maxReportEntries,
  };
}

// ---------------------------------------------------------------------------
// Writer (materialization.rs:162-461)
// ---------------------------------------------------------------------------

type MappingShape = 'Object' | 'EntryMapping';

interface InputEntry {
  readonly association: MaterializationInputLocation;
  readonly key: MaterializationInputLocation;
  readonly value: MaterializationInputLocation;
}

interface InputSection {
  readonly association: MaterializationInputLocation;
  readonly key: MaterializationInputLocation;
  readonly value: MaterializationInputLocation;
  readonly entries: readonly InputEntry[];
}

interface MappingItem {
  readonly key: string;
  readonly value: PortableValue;
  readonly association: MaterializationInputLocation;
  readonly keyLocation: MaterializationInputLocation;
  readonly valuePath: ValuePath;
}

class IniWriter {
  readonly #profile: IniProfile;
  readonly #limits: MaterializationLimits;
  readonly #output: BoundedText;
  readonly #analyzed: ValuePath[] = [];
  #inputNodes = 0;

  constructor(profile: IniProfile, limits: MaterializationLimits, utf8Budget: number) {
    this.#profile = profile;
    this.#limits = limits;
    this.#output = new BoundedText(utf8Budget);
  }

  analyzedPaths(): readonly ValuePath[] {
    return this.#analyzed;
  }

  document(value: PortableValue, path: ValuePath, depth: number): InputSection[] {
    const [shape, outer] = this.mappingItems(value, path, depth);
    if (shape === 'Object' && this.#profile.tag() === 'WindowsV1') {
      rejectCaseEquivalentObjectNames(outer);
    }
    const sections: InputSection[] = [];
    for (const section of outer) {
      this.validateSectionName(section.key);
      this.#output.pushText('[');
      this.#output.pushText(section.key);
      this.#output.pushText(']');
      this.newline();
      const [entryShape, entries] = this.mappingItems(section.value, section.valuePath, depth + 1);
      if (entryShape === 'Object' && this.#profile.tag() === 'WindowsV1') {
        rejectCaseEquivalentObjectNames(entries);
      }
      const inputEntries: InputEntry[] = [];
      for (const entry of entries) {
        this.validateKey(entry.key);
        this.analyze(entry.valuePath, depth + 2);
        if (entry.value.kind !== 'String') {
          throw new MaterializationFailure('Unrepresentable', {
            path: entry.valuePath,
            valueKind: entry.value.kind,
          });
        }
        this.writeEntry(entry.key, entry.value.value);
        inputEntries.push({
          association: entry.association,
          key: entry.keyLocation,
          value: { kind: 'Value', path: entry.valuePath },
        });
      }
      sections.push({
        association: section.association,
        key: section.keyLocation,
        value: { kind: 'Value', path: section.valuePath },
        entries: inputEntries,
      });
    }
    return sections;
  }

  mappingItems(value: PortableValue, path: ValuePath, depth: number): [MappingShape, MappingItem[]] {
    this.analyze(path, depth);
    let length: number;
    if (value.kind === 'Object') {
      length = value.entries.length;
    } else if (value.kind === 'EntryMapping') {
      length = value.entries.length;
    } else {
      throw new MaterializationFailure('Unrepresentable', { path, valueKind: value.kind });
    }
    if (length > this.#limits.maxInputNodes) {
      throw new MaterializationFailure('ResourceLimit', { reason: 'input-nodes' });
    }
    const items: MappingItem[] = [];
    if (value.kind === 'Object') {
      value.entries.forEach((entry, index) => {
        const ordinal = BigInt(index);
        items.push({
          key: entry.key,
          value: entry.value,
          association: {
            kind: 'Association',
            location: new AssociationLocation(path, ordinal, 'ObjectEntry'),
          },
          keyLocation: {
            kind: 'Association',
            location: new AssociationLocation(path, ordinal, 'ObjectKey'),
          },
          valuePath: path.child({ kind: 'ObjectValue', name: entry.key }),
        });
      });
      return ['Object', items];
    }
    value.entries.forEach((entry, index) => {
      const ordinal = BigInt(index);
      const keyPath = path.child({ kind: 'EntryKey', index: ordinal });
      this.analyze(keyPath, depth + 1);
      if (entry.key.kind !== 'String') {
        throw new MaterializationFailure('Unrepresentable', { path: keyPath, valueKind: entry.key.kind });
      }
      items.push({
        key: entry.key.value,
        value: entry.value,
        association: {
          kind: 'Association',
          location: new AssociationLocation(path, ordinal, 'EntryMappingEntry'),
        },
        keyLocation: { kind: 'Value', path: keyPath },
        valuePath: path.child({ kind: 'EntryValue', index: ordinal }),
      });
    });
    return ['EntryMapping', items];
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

  validateSectionName(value: string): void {
    const valid =
      this.#profile.tag() === 'PortableV1'
        ? value.length > 0 && allBytes(value, isPortableName)
        : this.#profile.tag() === 'WindowsV1'
          ? value.length > 0 && allBytes(value, isWindowsName)
          : value.length > 0 && !value.includes('\0') && !value.includes('\r') && !value.includes('\n');
    if (!valid) {
      throw new MaterializationFailure('InvalidRequest', { reason: 'section name is not representable' });
    }
  }

  validateKey(value: string): void {
    const valid =
      this.#profile.tag() === 'PortableV1'
        ? value.length > 0 && allBytes(value, isPortableName)
        : this.#profile.tag() === 'WindowsV1'
          ? value.length > 0 && allBytes(value, isWindowsName)
          : value.length > 0 &&
            !value.includes('\0') &&
            !value.includes('\r') &&
            !value.includes('\n') &&
            !value.includes('=') &&
            !value.includes(':') &&
            value.trim().length === value.length;
    if (!valid) {
      throw new MaterializationFailure('InvalidRequest', { reason: 'entry key is not representable' });
    }
  }

  writeEntry(key: string, value: string): void {
    switch (this.#profile.tag()) {
      case 'PortableV1':
        if (!allBytes(value, isPortableValue)) {
          throw new MaterializationFailure('InvalidRequest', { reason: 'portable value is not representable' });
        }
        this.#output.pushText(key);
        this.#output.pushText('=');
        this.#output.pushText(value);
        this.newline();
        break;
      case 'WindowsV1':
        if (value.includes('\0') || value.includes('\r') || value.includes('\n')) {
          throw new MaterializationFailure('InvalidRequest', { reason: 'Windows value is not representable' });
        }
        this.#output.pushText(key);
        this.#output.pushText('=');
        if (iniWindowsValueNeedsQuotes(value)) {
          const quote = value.startsWith('"') && value.endsWith('"') ? '\'' : '"';
          this.#output.pushText(quote);
          this.#output.pushText(value);
          this.#output.pushText(quote);
        } else {
          this.#output.pushText(value);
        }
        this.newline();
        break;
      case 'PythonConfigParserV1':
        this.writePythonEntry(key, value);
        break;
    }
  }

  writePythonEntry(key: string, value: string): void {
    if (value.includes('\0') || value.includes('\r')) {
      throw new MaterializationFailure('InvalidRequest', { reason: 'Python value is not representable' });
    }
    if (value.endsWith('\n')) {
      throw new MaterializationFailure('InvalidRequest', { reason: 'trailing empty Python value line is not representable' });
    }
    const lines = value.split('\n');
    const first = lines[0];
    validatePythonValueLine(first);
    this.#output.pushText(key);
    this.#output.pushText(' =');
    if (first.length > 0) {
      this.#output.pushText(' ');
      this.#output.pushText(first);
    }
    this.newline();
    for (let index = 1; index < lines.length; index++) {
      const line = lines[index];
      validatePythonValueLine(line);
      if (line.length > 0) {
        this.#output.pushText('    ');
        this.#output.pushText(line);
      }
      this.newline();
    }
  }

  newline(): void {
    this.#output.pushText(this.#profile.tag() === 'WindowsV1' ? '\r\n' : '\n');
  }

  finish(): string {
    return this.#output.finish();
  }
}

function validatePythonValueLine(line: string): void {
  if (line.trim().length !== line.length) {
    throw new MaterializationFailure('InvalidRequest', { reason: 'Python value line edge whitespace is not representable' });
  }
}

function rejectCaseEquivalentObjectNames(entries: readonly MappingItem[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const lowered = entry.key.toLowerCase();
    if (seen.has(lowered)) {
      throw new MaterializationFailure('InvalidRequest', {
        reason: 'Object cannot fabricate Windows case-equivalent collisions',
      });
    }
    seen.add(lowered);
  }
}

// ---------------------------------------------------------------------------
// Closure and provenance (materialization.rs:489-677)
// ---------------------------------------------------------------------------

function verifyClosure(
  input: PortableValue,
  request: MaterializationRequest,
  document: IniDocument,
): void {
  const limits = request.limits();
  const projectionLimits = {
    maxSourceAssociations: limits.maxInputNodes,
    maxValueNodes: limits.maxInputNodes,
    maxReportEntries: limits.maxReportEntries,
    maxProvenanceUnits: limits.maxProvenanceEntries,
  };
  const projection = projectIni(
    document,
    input.kind === 'Object'
      ? IniProjectionRequest.requireObject('OriginalExact', 'Reject').withLimits(projectionLimits)
      : IniProjectionRequest.bestExactEntryMapping().withLimits(projectionLimits),
  );
  if (projection.kind === 'Complete' && equal(projection.value.value(), input)) {
    return;
  }
  if (projection.kind === 'Failed') {
    const first = projection.value.diagnostics()[0];
    if (first.code === 'core.projection.resource-limit@1') {
      const limit = first.arguments.get('limit');
      const mapped =
        limit === 'max_source_associations' || limit === 'max_value_nodes'
          ? 'input-nodes'
          : limit === 'max_report_entries'
            ? 'report-entries'
            : limit === 'max_provenance_units'
              ? 'provenance-entries'
              : 'projection';
      throw new MaterializationFailure('ResourceLimit', { reason: mapped });
    }
  }
  throw new MaterializationFailure('FormationFailed');
}

function buildProvenance(
  input: PortableValue,
  sections: readonly InputSection[],
  document: IniDocument,
  limits: MaterializationLimits,
): MaterializationProvenanceMap {
  const entries: MaterializationProvenanceEntry[] = [];
  const rootSpan = document.authority().span(0, document.source().len());
  entries.push(
    provenanceEntry(
      { kind: 'Value', path: ValuePath.root() },
      document.nodeRef(),
      rootSpan,
      document,
      'Reencoded',
    ),
  );
  let entryOffset = 0;
  const documentSections = document.sections();
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
    const inputSection = sections[sectionIndex];
    const section = documentSections[sectionIndex];
    entries.push(
      provenanceEntry(inputSection.association, section.nodeRef(), section.span(), document, 'Reencoded'),
    );
    entries.push(
      provenanceEntry(inputSection.key, section.nodeRef(), section.nameSpan(), document, 'Reencoded'),
    );
    entries.push(
      provenanceEntry(inputSection.value, section.nodeRef(), section.span(), document, 'Generated'),
    );
    for (const inputEntry of inputSection.entries) {
      const entry = document.entries()[entryOffset];
      if (!entry.section().equals(section.nodeRef())) {
        throw new MaterializationFailure('FormationFailed');
      }
      entries.push(
        provenanceEntry(inputEntry.association, entry.nodeRef(), entry.span(), document, 'Reencoded'),
      );
      entries.push(
        provenanceEntry(inputEntry.key, entry.nodeRef(), entry.keySpan(), document, 'Reencoded'),
      );
      const outputs: MaterializedOrigin[] = [
        new MaterializedOrigin(document.snapshotIdentity(), entry.nodeRef(), entry.valueSpan(), 'Reencoded'),
      ];
      appendContinuationOutputs(document, entry, outputs);
      entries.push(new MaterializationProvenanceEntry(inputEntry.value, outputs));
      entryOffset += 1;
    }
  }
  if (entryOffset !== document.entries().length) {
    throw new MaterializationFailure('FormationFailed');
  }
  return MaterializationProvenanceMap.create(entries, document.snapshotIdentity(), limits);
}

function appendContinuationOutputs(
  document: IniDocument,
  entry: IniEntry,
  outputs: MaterializedOrigin[],
): void {
  const entryEntity = document.entity(entry.index());
  if (entryEntity.kind.role !== 'Entry') {
    throw new Error('internal: ini entry entity expected');
  }
  const logical = document.entity(entryEntity.kind.logicalLine);
  if (logical.kind.role !== 'LogicalLine') {
    throw new Error('internal: ini logical-line entity expected');
  }
  const pieces = document.losslessStructuralIndex().pieces();
  const kinds = document.losslessSyntaxKinds();
  for (let physical = 1; physical < logical.kind.physicalLines.length; physical++) {
    const physicalEntity = document.entity(logical.kind.physicalLines[physical]);
    if (physicalEntity.kind.role !== 'PhysicalLine') {
      throw new Error('internal: ini physical-line entity expected');
    }
    const content = physicalEntity.kind.contentSpan;
    let start = 0;
    while (start < pieces.length && pieces[start].span().endByte() <= content.startByte()) {
      start += 1;
    }
    for (let ordinal = start; ordinal < pieces.length; ordinal++) {
      const span = pieces[ordinal].span();
      if (span.startByte() >= content.endByte()) {
        break;
      }
      if (kinds[ordinal] === 'EntryValue') {
        outputs.push(new MaterializedOrigin(document.snapshotIdentity(), entry.nodeRef(), span, 'Reencoded'));
      }
    }
  }
}

function provenanceEntry(
  input: MaterializationInputLocation,
  node: NodeRef,
  span: Span,
  document: IniDocument,
  relation: MaterializationRelation,
): MaterializationProvenanceEntry {
  return new MaterializationProvenanceEntry(input, [
    new MaterializedOrigin(document.snapshotIdentity(), node, span, relation),
  ]);
}

// ---------------------------------------------------------------------------
// Encoding (materialization.rs:679-888)
// ---------------------------------------------------------------------------

/** UTF-8 budget for the text writer (materialization.rs:724-738). */
function textBudget(encoding: SourceEncoding, maxOutputBytes: number): number {
  switch (encoding.kind) {
    case 'Utf16Le':
    case 'Utf16Be':
    case 'Latin1':
      return maxOutputBytes * 2;
    case 'WindowsCodePage':
      return encoding.codePage.number() === 65001 ? maxOutputBytes : maxOutputBytes * 3;
    case 'Binary':
      throw new MaterializationFailure('UnsupportedEncoding');
    case 'Utf8':
      return maxOutputBytes;
  }
}

class BoundedText {
  readonly #chunks: string[] = [];
  #length = 0;
  readonly #max: number;

  constructor(max: number) {
    this.#max = max;
  }

  pushText(value: string): void {
    // The budget is a UTF-8 byte budget of the generated text (materialization.rs:
    // 692-716); the final encoded byte limit is enforced by encodeText.
    const next = this.#length + new TextEncoder().encode(value).length;
    if (next > this.#max) {
      throw new MaterializationFailure('ResourceLimit', { reason: 'output-bytes' });
    }
    this.#chunks.push(value);
    this.#length = next;
  }

  finish(): string {
    return this.#chunks.join('');
  }
}

/** Encodes one complete text into the requested source encoding with BOM (materialization.rs:740-768). */
function encodeText(text: string, encoding: SourceEncoding, maxOutputBytes: number): Uint8Array {
  const bomBytes = encoding.kind === 'Utf16Le' || encoding.kind === 'Utf16Be' ? 2 : 0;
  const fragmentLimit = maxOutputBytes - bomBytes;
  if (fragmentLimit < 0) {
    throw new MaterializationFailure('ResourceLimit', { reason: 'output-bytes' });
  }
  const fragment = iniEncodeFragment(text, encoding, fragmentLimit);
  if (bomBytes === 0) {
    return fragment;
  }
  const output = new Uint8Array(fragment.length + 2);
  output[0] = encoding.kind === 'Utf16Le' ? 0xff : 0xfe;
  output[1] = encoding.kind === 'Utf16Le' ? 0xfe : 0xff;
  output.set(fragment, 2);
  return output;
}

/**
 * Encodes one text fragment strictly (materialization.rs:770-829). Used by
 * the edit module for value/key replacements in the base source encoding.
 */
export function iniEncodeFragment(
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
      const units = utf16Units(text);
      const length = units.length * 2;
      if (length > maxOutputBytes) {
        throw new MaterializationFailure('ResourceLimit', { reason: 'output-bytes' });
      }
      const bytes = new Uint8Array(length);
      for (let index = 0; index < units.length; index++) {
        const unit = units[index];
        bytes[index * 2] = encoding.kind === 'Utf16Le' ? unit & 0xff : (unit >> 8) & 0xff;
        bytes[index * 2 + 1] = encoding.kind === 'Utf16Le' ? (unit >> 8) & 0xff : unit & 0xff;
      }
      output = bytes;
      break;
    }
    case 'Latin1': {
      const scalars = [...text];
      if (scalars.length > maxOutputBytes) {
        throw new MaterializationFailure('ResourceLimit', { reason: 'output-bytes' });
      }
      const bytes = new Uint8Array(scalars.length);
      for (let index = 0; index < scalars.length; index++) {
        const code = scalars[index].codePointAt(0)!;
        if (code > 0xff) {
          throw new MaterializationFailure('UnsupportedEncoding');
        }
        bytes[index] = code;
      }
      output = bytes;
      break;
    }
    case 'WindowsCodePage': {
      if (encoding.codePage.number() === 65001) {
        output = new TextEncoder().encode(text);
        break;
      }
      const encoder = codePageEncoder(encoding.codePage.number());
      if (encoder === null) {
        // 932, 936, 949, 950: recognized but not encodable at L1 (see the
        // module header; document/source.ts:897-912).
        throw new MaterializationFailure('UnsupportedEncoding');
      }
      const bytes: number[] = [];
      for (const character of text) {
        const code = character.codePointAt(0)!;
        const byte = code < 0x80 ? code : encoder.get(code);
        if (byte === undefined) {
          throw new MaterializationFailure('UnsupportedEncoding');
        }
        bytes.push(byte);
      }
      if (bytes.length > maxOutputBytes) {
        throw new MaterializationFailure('ResourceLimit', { reason: 'output-bytes' });
      }
      output = Uint8Array.from(bytes);
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

function utf16Units(text: string): number[] {
  const units: number[] = [];
  for (let index = 0; index < text.length; index++) {
    units.push(text.charCodeAt(index));
  }
  return units;
}

/** Reverse (scalar → byte) map of one frozen single-byte code page (materialization.rs:831-850). */
function codePageEncoder(pageNumber: number): Map<number, number> | null {
  const table = singleByteTableFor(pageNumber);
  if (table === null) {
    return null;
  }
  const encoder = new Map<number, number>();
  for (let index = 0; index < table.length; index++) {
    const scalar = table[index];
    if (scalar !== MALFORMED_BYTE_SENTINEL && !encoder.has(scalar)) {
      encoder.set(scalar, 0x80 + index);
    }
  }
  return encoder;
}

/** Deterministic quoting decision for Windows canonical values (materialization.rs:874-888). */
export function iniWindowsValueNeedsQuotes(value: string): boolean {
  const first = value.charCodeAt(0);
  const last = value.charCodeAt(value.length - 1);
  return (
    first === 0x20 || first === 0x09 || last === 0x20 || last === 0x09 ||
    (value.length >= 2 &&
      ((first === 0x27 && last === 0x27) || (first === 0x22 && last === 0x22)))
  );
}

// ---------------------------------------------------------------------------
// Character classes (materialization.rs:856-872)
// ---------------------------------------------------------------------------

function allBytes(value: string, predicate: (byte: number) => boolean): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code > 0x7f || !predicate(code)) {
      return false;
    }
  }
  return true;
}

function isPortableName(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    byte === 0x5f ||
    byte === 0x2d ||
    byte === 0x2e
  );
}

function isPortableValue(byte: number): boolean {
  return (
    (byte >= 0x21 && byte <= 0x7e &&
      byte !== 0x27 && byte !== 0x22 && byte !== 0x5c && byte !== 0x3a && byte !== 0x23 && byte !== 0x3b) ||
    byte === 0x20
  );
}

function isWindowsName(byte: number): boolean {
  return (
    (byte >= 0x21 && byte <= 0x7e) || byte === 0x20
  ) && !(byte === 0x5b || byte === 0x5d || byte === 0x3d);
}
