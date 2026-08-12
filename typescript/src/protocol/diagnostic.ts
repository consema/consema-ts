/**
 * The transferable `core.diagnostic@1` record.
 *
 * authority: crates/consema-protocol/src/diagnostic.rs (record shape and the
 * registry-bound code/category validation, diagnostic.rs:336-351);
 * conformance/vectors/protocol-v1.json (protocol.diagnostic.reject-category-
 * registry-mismatch). Construction validates the code against the frozen
 * error registry and the category against the registry record (RFC 0011;
 * RFC 0016 §6: "unknown code or category contradiction is a protocol
 * error").
 */

import { bytesValue } from '../core/value.ts';
import type { PortableValue, ObjectValue } from '../core/value.ts';
import { ErrorCodeRegistry, parseDiagnosticCategory } from './error_registry.ts';
import type { DiagnosticCategory } from './error_registry.ts';
import {
  exactFields,
  schemaFields,
  stringOf,
  sequenceOf,
  unsigned64,
  objectOf,
} from './records.ts';
import { protocolError, invalid } from './errors.ts';
import type { ProtocolError } from './errors.ts';
import { stringMapObject } from './string_map.ts';
import { wireNull } from './canonical.ts';
import { registerPayloadValidator } from './payload_validators.ts';

/** The three frozen presentation severities. */
export type Severity = 'Info' | 'Warning' | 'Error';

/** Parses one canonical severity spelling. */
export function parseSeverity(name: string): Severity {
  switch (name) {
    case 'Info':
    case 'Warning':
    case 'Error':
      return name;
    default:
      throw invalid('$.severity', 'unknown diagnostic severity');
  }
}

/** The three frozen fix applicability classes. */
export type FixApplicability = 'MachineApplicable' | 'MaybeApplicable' | 'Manual';

/** Parses one canonical applicability spelling. */
export function parseFixApplicability(name: string): FixApplicability {
  switch (name) {
    case 'MachineApplicable':
    case 'MaybeApplicable':
    case 'Manual':
      return name;
    default:
      throw invalid('$.fixes[].applicability', 'unknown fix applicability');
  }
}

/** A transferable source location bound to a caller-assigned stable source ID. */
export interface SourceLocation {
  readonly sourceId: string;
  /** Inclusive start byte. */
  readonly startByte: bigint;
  /** Exclusive end byte. */
  readonly endByte: bigint;
}

/** Validates one half-open source range. */
export function newSourceLocation(sourceId: string, startByte: bigint, endByte: bigint): SourceLocation {
  if (sourceId.length === 0 || sourceId.length > 1024 || startByte > endByte) {
    throw invalid('$.location', 'source ID or half-open byte range is invalid');
  }
  return { sourceId, startByte, endByte };
}

/** A related source location with its stable relationship role. */
export interface RelatedSourceLocation {
  readonly role: string;
  readonly location: SourceLocation;
}

/** An explicit source replacement proposal; never an implicit write. */
export interface FixProposal {
  /** The stable namespaced fix ID. */
  readonly id: string;
  readonly applicability: FixApplicability;
  /** The optional target source range. */
  readonly location?: SourceLocation;
  /** The exact replacement bytes. */
  readonly replacement: Uint8Array;
}

/** The full `core.diagnostic@1` record independent from control-flow status (RFC 0016 §6). */
export interface Diagnostic {
  readonly code: string;
  readonly category: DiagnosticCategory;
  readonly severity: Severity;
  readonly primary?: SourceLocation;
  readonly related: readonly RelatedSourceLocation[];
  /** Deterministic arguments; the wire form sorts the names (the Rust BTreeMap ordering). */
  readonly arguments: ReadonlyMap<string, string>;
  readonly notes: readonly string[];
  readonly fixes: readonly FixProposal[];
  readonly occurrence: bigint;
}

/** Validates the code/category consistency against the error registry and constructs the diagnostic. */
export function newDiagnostic(
  code: string,
  category: DiagnosticCategory,
  severity: Severity,
  primary: SourceLocation | undefined,
  related: readonly RelatedSourceLocation[],
  arguments_: ReadonlyMap<string, string>,
  notes: readonly string[],
  fixes: readonly FixProposal[],
  occurrence: bigint,
  registry: ErrorCodeRegistry,
): Diagnostic {
  validateDiagnosticCode(code, category, registry);
  return {
    code,
    category,
    severity,
    ...(primary !== undefined ? { primary } : {}),
    related: [...related],
    arguments: new Map(arguments_),
    notes: [...notes],
    fixes: fixes.map((fix) => ({ ...fix, replacement: Uint8Array.from(fix.replacement) })),
    occurrence,
  };
}

/** Encodes `core.diagnostic@1` (diagnostic.rs:187-250). */
export function diagnosticToValue(diagnostic: Diagnostic): ObjectValue {
  const related = diagnostic.related.map((item) =>
    objectValue([
      { key: 'role', value: { kind: 'String', value: item.role } },
      { key: 'location', value: locationValue(item.location) },
    ]),
  );
  const fixes = diagnostic.fixes.map((fix) =>
    objectValue([
      { key: 'id', value: { kind: 'String', value: fix.id } },
      { key: 'applicability', value: { kind: 'String', value: fix.applicability } },
      { key: 'location', value: fix.location !== undefined ? locationValue(fix.location) : wireNull() },
      // The wire replacement field is a Bytes leaf with full byte fidelity;
      // an empty replacement encodes as empty Bytes, never Null.
      { key: 'replacement', value: bytesValue(fix.replacement) },
    ]),
  );
  const primary = diagnostic.primary !== undefined ? locationValue(diagnostic.primary) : wireNull();
  return objectValue([
    { key: 'schema', value: { kind: 'String', value: 'core.diagnostic@1' } },
    { key: 'code', value: { kind: 'String', value: diagnostic.code } },
    { key: 'category', value: { kind: 'String', value: diagnostic.category } },
    { key: 'severity', value: { kind: 'String', value: diagnostic.severity } },
    { key: 'primary', value: primary },
    { key: 'related', value: { kind: 'Sequence', items: related } },
    { key: 'arguments', value: stringMapObject(diagnostic.arguments) },
    { key: 'notes', value: { kind: 'Sequence', items: diagnostic.notes.map((note) => ({ kind: 'String', value: note })) } },
    { key: 'fixes', value: { kind: 'Sequence', items: fixes } },
    { key: 'occurrence', value: { kind: 'Integer', value: diagnostic.occurrence } },
  ]);
}

/** Strictly decodes `core.diagnostic@1` under one explicit error registry (diagnostic.rs:252-333). */
export function diagnosticFromValue(value: PortableValue, registry: ErrorCodeRegistry): Diagnostic {
  const fields = schemaFields(
    value,
    'core.diagnostic@1',
    ['code', 'category', 'severity', 'primary', 'related', 'arguments', 'notes', 'fixes', 'occurrence'],
    '$',
  );
  const code = stringOf(fields[0], '$.code');
  const category = parseDiagnosticCategory(stringOf(fields[1], '$.category'));
  const severity = parseSeverity(stringOf(fields[2], '$.severity'));
  let primary: SourceLocation | undefined;
  if (fields[3].kind !== 'Null') {
    primary = parseLocation(fields[3], '$.primary');
  }
  const relatedValues = sequenceOf(fields[4], '$.related');
  const related: RelatedSourceLocation[] = relatedValues.map((item, index) => {
    const entry = exactFields(item, ['role', 'location'], `$.related[${index}]`);
    const role = stringOf(entry[0], `$.related[${index}].role`);
    const location = parseLocation(entry[1], `$.related[${index}].location`);
    return { role, location };
  });
  const arguments_ = stringMapFromObject(fields[5], '$.arguments');
  const noteValues = sequenceOf(fields[6], '$.notes');
  const notes: string[] = noteValues.map((note, index) => stringOf(note, `$.notes[${index}]`));
  const fixValues = sequenceOf(fields[7], '$.fixes');
  const fixes: FixProposal[] = fixValues.map((item, index) => decodeFix(item, `$.fixes[${index}]`));
  const occurrence = unsigned64(fields[8], '$.occurrence');
  return newDiagnostic(
    code,
    category,
    severity,
    primary,
    related,
    arguments_,
    notes,
    fixes,
    occurrence,
    registry,
  );
}

/** Requires the code to be registered and its category to match the registry record (diagnostic.rs:336-351). */
export function validateDiagnosticCode(
  code: string,
  category: DiagnosticCategory,
  registry: ErrorCodeRegistry,
): void {
  const descriptor = registry.descriptor(code);
  if (descriptor === undefined) {
    throw invalid('$.code', `unregistered public code: ${code}`);
  }
  if (descriptor.category !== category) {
    throw invalid('$.category', 'diagnostic category contradicts the error-code registry');
  }
}

/** Encodes one source location. */
function locationValue(location: SourceLocation): ObjectValue {
  return objectValue([
    { key: 'source_id', value: { kind: 'String', value: location.sourceId } },
    { key: 'start_byte', value: { kind: 'Integer', value: location.startByte } },
    { key: 'end_byte', value: { kind: 'Integer', value: location.endByte } },
  ]);
}

/** Strictly decodes one source location (diagnostic.rs:386-393). */
function parseLocation(value: PortableValue, path: string): SourceLocation {
  const fields = exactFields(value, ['source_id', 'start_byte', 'end_byte'], path);
  const sourceId = stringOf(fields[0], `${path}.source_id`);
  const startByte = unsigned64(fields[1], `${path}.start_byte`);
  const endByte = unsigned64(fields[2], `${path}.end_byte`);
  return newSourceLocation(sourceId, startByte, endByte);
}

/** Strictly decodes one fix proposal (diagnostic.rs:395-431). */
function decodeFix(value: PortableValue, path: string): FixProposal {
  const fields = exactFields(value, ['id', 'applicability', 'location', 'replacement'], path);
  const id = stringOf(fields[0], `${path}.id`);
  const applicability = parseFixApplicability(stringOf(fields[1], `${path}.applicability`));
  let location: SourceLocation | undefined;
  if (fields[2].kind !== 'Null') {
    location = parseLocation(fields[2], `${path}.location`);
  }
  if (fields[3].kind !== 'Bytes') {
    throw protocolError('WrongType', `${path}.replacement`, 'expected Bytes');
  }
  return {
    id,
    applicability,
    ...(location !== undefined ? { location } : {}),
    replacement: Uint8Array.from(fields[3].value),
  };
}

/** Builds a unique-key Object from pre-validated ordered entries. */
function objectValue(entries: { key: string; value: PortableValue }[]): ObjectValue {
  return { kind: 'Object', entries: entries.map((entry) => ({ key: entry.key, value: entry.value })) };
}

/** Decodes a deterministic sorted Object<String, String> into a Map. */
function stringMapFromObject(value: PortableValue, path: string): Map<string, string> {
  const object = objectOf(value, path);
  const output = new Map<string, string>();
  for (const entry of object.entries) {
    const text = stringOf(entry.value, `${path}.${entry.key}`);
    output.set(entry.key, text);
  }
  return output;
}

/** Narrowing helper for severity leaves. */
export function isSeverity(value: string): value is Severity {
  return value === 'Info' || value === 'Warning' || value === 'Error';
}

/**
 * The frozen process-local-handle rejection at the externalization boundary
 * (protocol_records.py:43-49; diagnostic.rs:353-365 bind_location). A
 * process-local identity that cannot be replaced by a stable caller
 * locator/source binding is rejected with this fixed code.
 */
export function processLocalError(path: string): ProtocolError {
  return protocolError(
    'ProcessLocalHandle',
    path,
    'process-local handle must be externalized to a stable caller identity',
  );
}

// The core.diagnostic@1 payload dispatch (payload.rs:52-55): the envelope
// validates every diagnostic payload through the strict decoder under the
// envelope registry at module load.
registerPayloadValidator('core.diagnostic', 1, (payload, registry) => {
  diagnosticFromValue(payload, new ErrorCodeRegistry(registry.versionOf()));
});
