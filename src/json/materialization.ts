/**
 * Deterministic PortableValue materialization for JSON-family profiles.
 *
 * authority: crates/consema-json/src/materialization.rs
 *  - materialize :18-32, materialize_complete :54-93 (profile gate,
 *    style gate, Utf8-only encoding, pretty newline gate, output reparse
 *    + Complete closure, provenance collection, fidelity Exact)
 *  - JsonStyle :95-111, requested_profile :113-125, requested_style
 *    :127-142 (json.canonical-compact@1 / json.canonical-pretty@1 for
 *    strict+JSONC; json5.canonical-compact@1 / json5.canonical-pretty@1
 *    for JSON5; RFC 0004 §4 :98-127), parse_limits :144-152
 *  - JsonWriter :154-454 (canonical scalars :180-247, decimal
 *    "coefficient e exponent" :257-268, string escaping :270-297,
 *    non-finite bits :299-317, sequence/object/entry-mapping layout
 *    :319-416, limits :418-431, pretty layout :447-453)
 *  - BoundedOutput :456-492 (checked growth)
 *  - ProvenanceBuilder :500-747 (value origins Direct :549-556,
 *    element origins Generated :575-582, object entry/key associations
 *    Direct :600-623, entry-mapping association Direct + key Reencoded
 *    :650-671)
 *  - canonical_fragment :34-52 (used by edit insertions, NewlinePolicy
 *    None)
 *  - representability: RFC 0004 §5 (:131-148) — JSON/JSONC accept exactly
 *    Null Boolean Integer Decimal String Sequence Object EntryMapping;
 *    RFC 0005 §9 (:197-212) — JSON5 canonical styles emit the strict-JSON
 *    subset plus the four frozen BinaryFloat64 spellings
 *  - the materialization request record: typescript/src/document/
 *    materialization.ts (MaterializationRequest, MaterializationLimits,
 *    completion algebra RFC 0004 §7)
 *  - vector-pinned behavior: conformance/vectors/json-family-v2.json
 *    (json5.materialize.canonical-specials, reject-finite-binary,
 *    reject-profile-style-mismatch, json5.convert.*)
 *
 * Design (TypeScript-idiomatic): a bounded writer accumulates exact
 * output bytes; the operation closes only when the output reparses as a
 * Complete document under the requested profile and reprojects to the
 * identical portable value (RFC 0004 §7, RFC 0005 §9).
 */

import {
  CompleteMaterialization,
  FailedMaterializationAttempt,
  MaterializationProvenanceEntry,
  MaterializationProvenanceMap,
  MaterializationReport,
  MaterializationRequest,
  MaterializedOrigin,
  newlineBytes,
} from '../document/materialization.ts';
import type {
  MaterializationFidelity,
  MaterializationInputLocation,
  MaterializationLimits,
  MaterializationRelation,
  MaterializationResult,
  NewlinePolicy,
} from '../document/materialization.ts';
import { MaterializationFailure } from '../document/errors.ts';
import { AssociationLocation, ValuePath } from '../document/portable_locations.ts';
import { ProfileId } from '../document/profile.ts';
import type { SourceEncoding } from '../document/source.ts';
import type { PortableValue } from '../core/value.ts';
import type { ParseLimits } from '../document/formation.ts';
import type { Diagnostic } from '../document/diagnostic.ts';
import { NodeRef, Span } from '../document/identity.ts';
import { isJson5 } from './profile.ts';
import type { JsonProfile } from './profile.ts';
import { JsonDocument, JsonObjectMember, JsonValue } from './document.ts';
import type { JsonValueKind } from './document.ts';
import type { SemanticAvailability } from './semantic.ts';
import { parse } from './parser.ts';
import { ProjectionRequestBuilder, project } from './projection.ts';
import type { ProjectionTarget } from './projection.ts';

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

/** Deterministic generation style of one JSON-family profile (materialization.rs:95-111). */
type JsonStyle = 'Compact' | 'Pretty' | 'Json5Compact' | 'Json5Pretty';

function styleIsPretty(style: JsonStyle): boolean {
  return style === 'Pretty' || style === 'Json5Pretty';
}

function styleIsJson5(style: JsonStyle): boolean {
  return style === 'Json5Compact' || style === 'Json5Pretty';
}

function requestedProfile(
  request: MaterializationRequest,
): JsonProfile | MaterializationFailure {
  const profile = request.targetProfile();
  if (profile.id() === 'json.strict' && profile.version() === 1) {
    return 'JsonStrict';
  }
  if (profile.id() === 'jsonc.bounded' && profile.version() === 1) {
    return 'JsoncBounded';
  }
  if (profile.id() === 'json5.standard' && profile.version() === 1) {
    return 'Json5Standard';
  }
  return new MaterializationFailure('UnsupportedProfile');
}

function requestedStyle(
  request: MaterializationRequest,
  profile: JsonProfile,
): JsonStyle | MaterializationFailure {
  const style = request.style();
  if (profile === 'Json5Standard') {
    if (style.id() === 'json5.canonical-compact' && style.version() === 1) {
      return 'Json5Compact';
    }
    if (style.id() === 'json5.canonical-pretty' && style.version() === 1) {
      return 'Json5Pretty';
    }
  } else {
    if (style.id() === 'json.canonical-compact' && style.version() === 1) {
      return 'Compact';
    }
    if (style.id() === 'json.canonical-pretty' && style.version() === 1) {
      return 'Pretty';
    }
  }
  return new MaterializationFailure('UnsupportedStyle');
}

/** Parse limits derived from one materialization request (materialization.rs:144-152). */
function parseLimitsFor(limits: MaterializationLimits): ParseLimits {
  return {
    maxSourceBytes: limits.maxOutputBytes,
    maxNestingDepth: limits.maxDepth,
    maxTokenCount: limits.maxOutputBytes,
    maxNodeCount: limits.maxInputNodes * 3,
    maxDiagnostics: limits.maxReportEntries,
  };
}

// ---------------------------------------------------------------------------
// Bounded output
// ---------------------------------------------------------------------------

/** Bounded output buffer with checked growth (materialization.rs:456-492). */
class BoundedOutput {
  #bytes: Uint8Array;
  #length = 0;
  readonly #max: number;

  constructor(max: number) {
    this.#bytes = new Uint8Array(Math.min(max, 4096));
    this.#max = max;
  }

  pushByte(byte: number): void {
    if (this.#length >= this.#max) {
      throw new MaterializationFailure('ResourceLimit', { reason: 'output-bytes' });
    }
    this.#ensure(1);
    this.#bytes[this.#length] = byte;
    this.#length += 1;
  }

  pushBytes(bytes: Uint8Array): void {
    if (this.#length + bytes.length > this.#max) {
      throw new MaterializationFailure('ResourceLimit', { reason: 'output-bytes' });
    }
    this.#ensure(bytes.length);
    this.#bytes.set(bytes, this.#length);
    this.#length += bytes.length;
  }

  pushText(text: string): void {
    this.pushBytes(new TextEncoder().encode(text));
  }

  #ensure(extra: number): void {
    if (this.#length + extra <= this.#bytes.length) {
      return;
    }
    const next = Math.min(this.#max, Math.max(this.#bytes.length * 2, this.#length + extra));
    const grown = new Uint8Array(next);
    grown.set(this.#bytes.subarray(0, this.#length));
    this.#bytes = grown;
  }

  finish(): Uint8Array {
    // Typed-array views cannot be frozen in V8 ("Cannot freeze array buffer
    // views with elements"); slice already detaches a fresh buffer copy.
    return this.#bytes.slice(0, this.#length);
  }
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

interface WriterState {
  readonly style: JsonStyle;
  readonly newline: NewlinePolicy;
  readonly limits: MaterializationLimits;
  readonly output: BoundedOutput;
  readonly analyzed: ValuePath[];
  inputNodes: number;
}

function analyze(state: WriterState, path: ValuePath, depth: number): void {
  if (depth > state.limits.maxDepth) {
    throw new MaterializationFailure('ResourceLimit', { reason: 'input-depth' });
  }
  state.inputNodes += 1;
  if (state.inputNodes > state.limits.maxInputNodes) {
    throw new MaterializationFailure('ResourceLimit', { reason: 'input-nodes' });
  }
  state.analyzed.push(path);
}

function writeValue(
  state: WriterState,
  value: PortableValue,
  path: ValuePath,
  depth: number,
): void {
  analyze(state, path, depth);
  switch (value.kind) {
    case 'Null':
      state.output.pushBytes(new Uint8Array([0x6e, 0x75, 0x6c, 0x6c])); // null
      break;
    case 'Boolean':
      state.output.pushBytes(
        new Uint8Array(value.value ? [0x74, 0x72, 0x75, 0x65] : [0x66, 0x61, 0x6c, 0x73, 0x65]),
      );
      break;
    case 'Integer':
      state.output.pushText(value.value.toString());
      break;
    case 'Decimal':
      state.output.pushText(`${value.coefficient}e${value.exponent}`);
      break;
    case 'BinaryFloat64':
      if (!styleIsJson5(state.style)) {
        throw new MaterializationFailure('Unrepresentable', {
          path,
          valueKind: 'BinaryFloat64',
        });
      }
      writeBinaryFloat64(state, value.bits, path);
      break;
    case 'String':
      writeString(state, value.value);
      break;
    case 'Sequence':
      writeSequence(state, value.items, path, depth);
      break;
    case 'Object':
      writeObject(state, value.entries, path, depth);
      break;
    case 'EntryMapping':
      writeEntryMapping(state, value.entries, path, depth);
      break;
    default:
      throw new MaterializationFailure('Unrepresentable', { path, valueKind: value.kind });
  }
}

/** Exact frozen IEEE-754 spellings only (materialization.rs:299-317; RFC 0005 §9). */
function writeBinaryFloat64(
  state: WriterState,
  bits: bigint,
  path: ValuePath,
): void {
  let spelling: string;
  switch (bits) {
    case 0x7ff0000000000000n:
      spelling = 'Infinity';
      break;
    case 0xfff0000000000000n:
      spelling = '-Infinity';
      break;
    case 0x7ff8000000000000n:
      spelling = 'NaN';
      break;
    case 0xfff8000000000000n:
      spelling = '-NaN';
      break;
    default:
      throw new MaterializationFailure('Unrepresentable', {
        path,
        valueKind: 'BinaryFloat64',
      });
  }
  state.output.pushText(spelling);
}

/** Deterministic JSON escaping (materialization.rs:270-297). */
function writeString(state: WriterState, value: string): void {
  state.output.pushByte(0x22); // "
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    switch (character) {
      case '"':
        state.output.pushText('\\"');
        break;
      case '\\':
        state.output.pushText('\\\\');
        break;
      case '\b':
        state.output.pushText('\\b');
        break;
      case '\f':
        state.output.pushText('\\f');
        break;
      case '\n':
        state.output.pushText('\\n');
        break;
      case '\r':
        state.output.pushText('\\r');
        break;
      case '\t':
        state.output.pushText('\\t');
        break;
      default:
        if (codePoint <= 0x1f) {
          state.output.pushText(`\\u${codePoint.toString(16).padStart(4, '0')}`);
        } else if ((codePoint === 0x2028 || codePoint === 0x2029) && styleIsJson5(state.style)) {
          state.output.pushText(`\\u${codePoint.toString(16).padStart(4, '0')}`);
        } else {
          state.output.pushText(character);
        }
        break;
    }
  }
  state.output.pushByte(0x22); // "
}

function writeSequence(
  state: WriterState,
  values: readonly PortableValue[],
  path: ValuePath,
  depth: number,
): void {
  state.output.pushByte(0x5b); // [
  if (values.length > 0 && styleIsPretty(state.style)) {
    layoutNewline(state, depth + 1);
  }
  for (let index = 0; index < values.length; index++) {
    if (index !== 0) {
      state.output.pushByte(0x2c); // ,
      if (styleIsPretty(state.style)) {
        layoutNewline(state, depth + 1);
      }
    }
    writeValue(
      state,
      values[index],
      path.child({ kind: 'SequenceElement', index: BigInt(index) }),
      depth + 1,
    );
  }
  if (values.length > 0 && styleIsPretty(state.style)) {
    layoutNewline(state, depth);
  }
  state.output.pushByte(0x5d); // ]
}

function writeObject(
  state: WriterState,
  entries: readonly { readonly key: string; readonly value: PortableValue }[],
  path: ValuePath,
  depth: number,
): void {
  state.output.pushByte(0x7b); // {
  if (entries.length > 0 && styleIsPretty(state.style)) {
    layoutNewline(state, depth + 1);
  }
  for (let index = 0; index < entries.length; index++) {
    memberSeparator(state, index, depth);
    writeString(state, entries[index].key);
    state.output.pushByte(0x3a); // :
    if (styleIsPretty(state.style)) {
      state.output.pushByte(0x20); // ' '
    }
    writeValue(
      state,
      entries[index].value,
      path.child({ kind: 'ObjectValue', name: entries[index].key }),
      depth + 1,
    );
  }
  if (entries.length > 0 && styleIsPretty(state.style)) {
    layoutNewline(state, depth);
  }
  state.output.pushByte(0x7d); // }
}

function writeEntryMapping(
  state: WriterState,
  entries: readonly { readonly key: PortableValue; readonly value: PortableValue }[],
  path: ValuePath,
  depth: number,
): void {
  state.output.pushByte(0x7b); // {
  if (entries.length > 0 && styleIsPretty(state.style)) {
    layoutNewline(state, depth + 1);
  }
  for (let index = 0; index < entries.length; index++) {
    memberSeparator(state, index, depth);
    const ordinal = BigInt(index);
    const keyPath = path.child({ kind: 'EntryKey', index: ordinal });
    analyze(state, keyPath, depth + 1);
    const key = entries[index].key;
    if (key.kind !== 'String') {
      throw new MaterializationFailure('Unrepresentable', {
        path: keyPath,
        valueKind: key.kind,
      });
    }
    writeString(state, key.value);
    state.output.pushByte(0x3a); // :
    if (styleIsPretty(state.style)) {
      state.output.pushByte(0x20); // ' '
    }
    writeValue(
      state,
      entries[index].value,
      path.child({ kind: 'EntryValue', index: ordinal }),
      depth + 1,
    );
  }
  if (entries.length > 0 && styleIsPretty(state.style)) {
    layoutNewline(state, depth);
  }
  state.output.pushByte(0x7d); // }
}

function memberSeparator(state: WriterState, index: number, depth: number): void {
  if (index !== 0) {
    state.output.pushByte(0x2c); // ,
    if (styleIsPretty(state.style)) {
      layoutNewline(state, depth + 1);
    }
  }
}

/** Newline bytes plus two ASCII spaces per level (materialization.rs:447-453; RFC 0004 §4). */
function layoutNewline(state: WriterState, depth: number): void {
  state.output.pushBytes(newlineBytes(state.newline));
  for (let level = 0; level < depth; level++) {
    state.output.pushBytes(new Uint8Array([0x20, 0x20]));
  }
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

interface ProvenanceState {
  readonly document: JsonDocument;
  readonly limits: MaterializationLimits;
  units: number;
  entries: MaterializationProvenanceEntry[];
}

function origin(
  state: ProvenanceState,
  node: NodeRef,
  span: Span,
  relation: MaterializationRelation,
): MaterializedOrigin {
  return new MaterializedOrigin(state.document.snapshotIdentity(), node, span, relation);
}

function pushOrigin(
  state: ProvenanceState,
  input: MaterializationInputLocation,
  output: MaterializedOrigin,
): void {
  state.units += 2;
  if (state.units > state.limits.maxProvenanceEntries) {
    throw new MaterializationFailure('ResourceLimit', { reason: 'provenance-entries' });
  }
  state.entries.push(new MaterializationProvenanceEntry(input, [output]));
}

function addOutput(
  state: ProvenanceState,
  input: MaterializationInputLocation,
  output: MaterializedOrigin,
): void {
  state.units += 1;
  if (state.units > state.limits.maxProvenanceEntries) {
    throw new MaterializationFailure('ResourceLimit', { reason: 'provenance-entries' });
  }
  const entry = state.entries.find((candidate) => inputLocationEquals(candidate.input(), input));
  if (entry === undefined) {
    throw new MaterializationFailure('FormationFailed');
  }
  state.entries[state.entries.indexOf(entry)] = new MaterializationProvenanceEntry(input, [
    ...entry.outputs(),
    output,
  ]);
}

function inputLocationEquals(
  left: MaterializationInputLocation,
  right: MaterializationInputLocation,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'Value') {
    return left.path.equals((right as { kind: 'Value'; path: ValuePath }).path);
  }
  const rightLocation = (right as { kind: 'Association'; location: AssociationLocation }).location;
  return (
    left.location.container().equals(rightLocation.container()) &&
    left.location.ordinal() === rightLocation.ordinal() &&
    left.location.role() === rightLocation.role()
  );
}

function collectProvenance(
  state: ProvenanceState,
  input: PortableValue,
  path: ValuePath,
  output: JsonValue,
): void {
  const expectedKind = expectedOutputKind(input);
  if (expectedKind === null || !outputKindMatches(output.kind(), expectedKind)) {
    throw new MaterializationFailure('FormationFailed');
  }
  if (input.kind === 'BinaryFloat64') {
    const parsed = output.asBinaryFloat64();
    if (parsed.kind !== 'Available' || parsed.value !== input.bits) {
      throw new MaterializationFailure('FormationFailed');
    }
  }
  pushOrigin(
    state,
    { kind: 'Value', path },
    origin(state, output.nodeRef(), output.span(), 'Direct'),
  );
  switch (input.kind) {
    case 'Sequence': {
      const elements = output.arrayElements();
      if (elements.kind !== 'Available' || elements.value === null || elements.value.length !== input.items.length) {
        throw new MaterializationFailure('FormationFailed');
      }
      for (let index = 0; index < input.items.length; index++) {
        const ordinal = BigInt(index);
        const childPath = path.child({ kind: 'SequenceElement', index: ordinal });
        collectProvenance(state, input.items[index], childPath, elements.value[index].value());
        addOutput(
          state,
          { kind: 'Value', path: childPath },
          origin(state, elements.value[index].nodeRef(), elements.value[index].span(), 'Generated'),
        );
      }
      break;
    }
    case 'Object': {
      const members = availableMembers(output);
      if (members === null || members.length !== input.entries.length) {
        throw new MaterializationFailure('FormationFailed');
      }
      for (let index = 0; index < input.entries.length; index++) {
        const entry = input.entries[index];
        const member = members[index];
        const memberName = member.name();
        if (memberName.kind !== 'Available' || memberName.value !== entry.key) {
          throw new MaterializationFailure('FormationFailed');
        }
        const ordinal = BigInt(index);
        pushOrigin(
          state,
          {
            kind: 'Association',
            location: new AssociationLocation(path, ordinal, 'ObjectEntry'),
          },
          origin(state, member.nodeRef(), member.span(), 'Direct'),
        );
        pushOrigin(
          state,
          {
            kind: 'Association',
            location: new AssociationLocation(path, ordinal, 'ObjectKey'),
          },
          origin(state, member.keyNodeRef(), keySpanOf(state.document, member.entityIndex()), 'Direct'),
        );
        collectProvenance(
          state,
          entry.value,
          path.child({ kind: 'ObjectValue', name: entry.key }),
          member.value(),
        );
      }
      break;
    }
    case 'EntryMapping': {
      const members = availableMembers(output);
      if (members === null || members.length !== input.entries.length) {
        throw new MaterializationFailure('FormationFailed');
      }
      for (let index = 0; index < input.entries.length; index++) {
        const entry = input.entries[index];
        const member = members[index];
        const ordinal = BigInt(index);
        if (entry.key.kind !== 'String') {
          throw new MaterializationFailure('FormationFailed');
        }
        const memberName = member.name();
        if (memberName.kind !== 'Available' || memberName.value !== entry.key.value) {
          throw new MaterializationFailure('FormationFailed');
        }
        pushOrigin(
          state,
          {
            kind: 'Association',
            location: new AssociationLocation(path, ordinal, 'EntryMappingEntry'),
          },
          origin(state, member.nodeRef(), member.span(), 'Direct'),
        );
        pushOrigin(
          state,
          { kind: 'Value', path: path.child({ kind: 'EntryKey', index: ordinal }) },
          origin(state, member.keyNodeRef(), keySpanOf(state.document, member.entityIndex()), 'Reencoded'),
        );
        collectProvenance(
          state,
          entry.value,
          path.child({ kind: 'EntryValue', index: ordinal }),
          member.value(),
        );
      }
      break;
    }
    default:
      break;
  }
}

function expectedOutputKind(input: PortableValue): JsonValueKind | null {
  switch (input.kind) {
    case 'Null':
      return 'Null';
    case 'Boolean':
      return 'Boolean';
    case 'Integer':
      return 'Integer';
    case 'Decimal':
      return 'Decimal';
    case 'BinaryFloat64':
      return 'BinaryFloat64';
    case 'String':
      return 'String';
    case 'Sequence':
      return 'Array';
    case 'Object':
    case 'EntryMapping':
      return 'Object';
    default:
      return null;
  }
}

function outputKindMatches(
  actual: SemanticAvailability<JsonValueKind>,
  expected: JsonValueKind,
): boolean {
  return actual.kind === 'Available' && actual.value === expected;
}

function availableMembers(output: JsonValue): readonly JsonObjectMember[] | null {
  const members = output.objectMembers();
  if (members.kind !== 'Available' || members.value === null) {
    return null;
  }
  return members.value;
}

/** The exact key literal span (materialization.rs:618-622). */
function keySpanOf(document: JsonDocument, memberIndex: number): Span {
  const entity = document.entityAt(memberIndex);
  return document.spanOf(entity.kind === 'Member' ? entity.key : memberIndex);
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Materializes one complete PortableValue into a new immutable JSON or
 * JSONC document (materialization.rs:18-32).
 */
export function materialize(
  value: PortableValue,
  request: MaterializationRequest,
): MaterializationResult<JsonDocument> {
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
): CompleteMaterialization<JsonDocument> {
  const profileResult = requestedProfile(request);
  if (profileResult instanceof MaterializationFailure) {
    throw profileResult;
  }
  const profile = profileResult;
  const styleResult = requestedStyle(request, profile);
  if (styleResult instanceof MaterializationFailure) {
    throw styleResult;
  }
  const style = styleResult;
  if (!encodingIsUtf8(request.encoding())) {
    throw new MaterializationFailure('UnsupportedEncoding');
  }
  if (styleIsPretty(style) && request.newline() === 'None') {
    throw new MaterializationFailure('UnsupportedNewline');
  }

  const state: WriterState = {
    style,
    newline: request.newline(),
    limits: request.limits(),
    output: new BoundedOutput(request.limits().maxOutputBytes),
    analyzed,
    inputNodes: 0,
  };
  writeValue(state, value, ValuePath.root(), 0);
  if (request.newline() !== 'None') {
    state.output.pushBytes(newlineBytes(request.newline()));
  }
  const bytes = state.output.finish();

  let document: JsonDocument;
  try {
    document = parse(bytes, profile, parseLimitsFor(request.limits()));
  } catch {
    throw new MaterializationFailure('FormationFailed');
  }
  if (document.formationStatus() !== 'Complete') {
    throw new MaterializationFailure('FormationFailed');
  }

  const provenanceState: ProvenanceState = {
    document,
    limits: request.limits(),
    units: 0,
    entries: [],
  };
  collectProvenance(provenanceState, value, ValuePath.root(), document.root());
  const provenance = MaterializationProvenanceMap.create(
    provenanceState.entries,
    document.snapshotIdentity(),
    request.limits(),
  );
  return new CompleteMaterialization(
    document,
    'Exact',
    new MaterializationReport([], request.limits()),
    provenance,
  );
}

function encodingIsUtf8(encoding: SourceEncoding): boolean {
  return encoding.kind === 'Utf8';
}

/**
 * Canonical fragment for one value under the exact profile (used by edit
 * insertions; materialization.rs:34-52).
 */
export function canonicalFragment(
  value: PortableValue,
  profile: JsonProfile,
  limits: MaterializationLimits,
): Uint8Array {
  const style: JsonStyle = isJson5(profile) ? 'Json5Compact' : 'Compact';
  const analyzed: ValuePath[] = [];
  const state: WriterState = {
    style,
    newline: 'None',
    limits,
    output: new BoundedOutput(limits.maxOutputBytes),
    analyzed,
    inputNodes: 0,
  };
  writeValue(state, value, ValuePath.root(), 0);
  return state.output.finish();
}

// ---------------------------------------------------------------------------
// Dialect conversion composition (RFC 0004 §9)
// ---------------------------------------------------------------------------

/** Exact default projection target of one profile (RFC 0005 §8). */
function defaultTarget(profile: JsonProfile): ProjectionTarget {
  return isJson5(profile) ? 'Json5BestExactCoreV1' : 'BestExactCoreV1';
}

/**
 * JSON-family dialect conversion: audited Projection-to-Materialization
 * composition (RFC 0004 §9 :219-242; RFC 0005 §9 :213-218). The report
 * always exposes exact source/target ProfileIds and both stages; a
 * spelling/profile change with the same portable semantics is Exact, and
 * non-finite JSON5 to strict JSON fails rather than being rounded.
 */
export type JsonConversionResult =
  | {
      readonly kind: 'Complete';
      readonly document: JsonDocument;
      readonly overallFidelity: MaterializationFidelity;
    }
  | { readonly kind: 'Failed'; readonly failure: MaterializationFailure | Diagnostic };

export function convertJsonDocument(
  source: JsonDocument,
  targetProfile: ProfileId,
  request: MaterializationRequest,
): JsonConversionResult {
  if (!request.targetProfile().equals(targetProfile)) {
    return {
      kind: 'Failed',
      failure: new MaterializationFailure('InvalidRequest', { reason: 'target-profile-mismatch' }),
    };
  }
  const projectionResult = project(
    source,
    new ProjectionRequestBuilder(defaultTarget(source.profileInternal())).build(),
  );
  if (projectionResult.kind === 'Failed') {
    const diagnostics = projectionResult.value.diagnostics();
    return {
      kind: 'Failed',
      failure: diagnostics.length > 0 ? diagnostics[0] : new MaterializationFailure('FormationFailed'),
    };
  }
  const projected = projectionResult.value;
  const materializationResult = materialize(projected.value(), request);
  if (materializationResult.kind === 'Failed') {
    return { kind: 'Failed', failure: materializationResult.value.failure() };
  }
  const materialized = materializationResult.value;
  return {
    kind: 'Complete',
    document: materialized.document(),
    overallFidelity: 'Exact',
  };
}
