/**
 * Materialization request/report/provenance/result, conversion report,
 * edit-plan, and format-operation-registry protocol records.
 *
 * authority: crates/consema-protocol/src/materialization.rs, conversion.rs,
 * operation.rs (record shapes and every rejection); the semantic-model v6
 * version-closure cases are pinned by
 * conformance/vectors/semantic-model-v6.json; cross-reference
 * go/protocol/records_materialization.go. The v2 request/result records
 * embed the source-encoding and source-snapshot records of
 * ./records_source.ts.
 *
 * Design (TypeScript-idiomatic): the common request of
 * src/document/materialization.ts is copied into the transferable records;
 * failures are a closed discriminated union carrying their frozen
 * registered code; every record self-registers its strict decoder with the
 * payload dispatch so the common envelope validates it fully.
 */

import type { PortableValue, ObjectValue } from '../core/value.ts';
import {
  exactFields,
  schemaFields,
  stringOf,
  sequenceOf,
  unsigned64,
  unsigned32,
  objectValueFrom,
  wireInteger,
  booleanOf,
} from './records.ts';
import { invalid, protocolError } from './errors.ts';
import { ErrorCodeRegistry } from './error_registry.ts';
import type { Diagnostic } from './diagnostic.ts';
import { diagnosticToValue, diagnosticFromValue } from './diagnostic.ts';
import { ValuePath, AssociationLocation } from './records_value_path.ts';
import { MaterializationRequest, MaterializationStyleId } from '../document/materialization.ts';
import type {
  MaterializationLimits,
  MappingPolicy,
  NewlinePolicy,
  MaterializationFidelity,
} from '../document/materialization.ts';
import { ProfileId } from '../document/profile.ts';
import type { SourceEncoding } from '../document/source.ts';
import { encodingAsStr, DEFAULT_SOURCE_LIMITS } from '../document/source.ts';
import { ContentDigest } from '../document/sha256.ts';
import { SourceReplacement } from '../document/source_patch.ts';
import {
  FormatOperationId,
  FormatOperationRegistry,
  FormatOperationRegistryError,
  FormatOperationDescriptor,
  OperationTargetRoleId,
  OperationArgumentDescriptor,
} from '../document/operation.ts';
import type { OperationArgumentKind, OperationSupport } from '../document/operation.ts';
import { newContractId, validateNamespace } from './contract.ts';
import { ProjectionReportMessage } from './records_projection.ts';
// The v2 request/result records embed the source-family records of
// ./records_source.ts; the snapshot decode validates the complete-branch
// snapshot against the exact source-snapshot wire of that module.
import { SourceSnapshotMessage, SourceSnapshotMessageV2, SourceEncodingMessage } from './records_source.ts';
import { registerPayloadValidator } from './payload_validators.ts';

// ---------------------------------------------------------------------------
// core.materialization-report@1
// ---------------------------------------------------------------------------

/** The ordered `core.materialization-report@1` diagnostics. */
export class MaterializationReportMessage {
  readonly #events: readonly Diagnostic[];

  private constructor(events: readonly Diagnostic[]) {
    this.#events = Object.freeze([...events]);
  }

  /** The empty report. */
  static default(): MaterializationReportMessage {
    return new MaterializationReportMessage([]);
  }

  /** Validates all events against one explicit semantic-model registry (materialization.rs:201-209). */
  static new(events: readonly Diagnostic[], registry: ErrorCodeRegistry): MaterializationReportMessage {
    for (const event of events) {
      // Full revalidation through the diagnostic decoder, exactly like the
      // Rust new_with_registry (materialization.rs:205-208).
      diagnosticFromValue(diagnosticToValue(event), registry);
    }
    return new MaterializationReportMessage(events);
  }

  /** Ordered materialization events. */
  events(): readonly Diagnostic[] {
    return this.#events;
  }

  /** Encodes the fixed report schema (materialization.rs:243-255). */
  toValue(): ObjectValue {
    return objectValueFrom([
      { key: 'schema', value: { kind: 'String', value: 'core.materialization-report@1' } },
      {
        key: 'events',
        value: { kind: 'Sequence', items: this.#events.map((event) => diagnosticToValue(event)) },
      },
    ]);
  }

  /** Strictly decodes events under one explicit semantic-model registry (materialization.rs:263-278). */
  static fromValue(value: PortableValue, registry: ErrorCodeRegistry): MaterializationReportMessage {
    const fields = schemaFields(value, 'core.materialization-report@1', ['events'], '$');
    const events = sequenceOf(fields[0], '$.events').map((event) =>
      diagnosticFromValue(event, registry),
    );
    return MaterializationReportMessage.new(events, registry);
  }
}

// ---------------------------------------------------------------------------
// core.materialization-provenance-map@1
// ---------------------------------------------------------------------------

/** Relationship from portable input to target syntax (materialization.rs:291-299). */
export type MaterializationRelation = 'Direct' | 'Reencoded' | 'Generated';

/** One transferable target origin with caller-stable identities (materialization.rs:302-314). */
export interface MaterializedOrigin {
  readonly targetSourceId: string;
  readonly targetNodeLocator: string;
  readonly startByte: bigint;
  readonly endByte: bigint;
  readonly relation: MaterializationRelation;
}

/** One portable input location and all exact target origins (materialization.rs:317-323). */
export interface MaterializationProvenanceEntry {
  readonly input:
    | { readonly kind: 'ValuePath'; readonly value: ValuePath }
    | { readonly kind: 'AssociationLocation'; readonly value: AssociationLocation };
  readonly outputs: readonly MaterializedOrigin[];
}

/** The transferable `core.materialization-provenance-map@1` record. */
export class MaterializationProvenanceMapMessage {
  readonly #entries: readonly MaterializationProvenanceEntry[];

  private constructor(entries: readonly MaterializationProvenanceEntry[]) {
    this.#entries = Object.freeze([...entries]);
  }

  /** The empty provenance map. */
  static default(): MaterializationProvenanceMapMessage {
    return new MaterializationProvenanceMapMessage([]);
  }

  /** Validates stable identities, non-empty outputs, range order, and locator uniqueness (materialization.rs:333-373). */
  static new(entries: readonly MaterializationProvenanceEntry[]): MaterializationProvenanceMapMessage {
    let sourceId: string | null = null;
    const locatorRanges = new Map<string, { start: bigint; end: bigint }>();
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
      const entry = entries[entryIndex];
      if (entry.outputs.length === 0) {
        throw invalid(`$.entries[${entryIndex}].outputs`, 'provenance entry requires at least one output');
      }
      for (let outputIndex = 0; outputIndex < entry.outputs.length; outputIndex++) {
        const output = entry.outputs[outputIndex];
        const path = `$.entries[${entryIndex}].outputs[${outputIndex}]`;
        if (
          output.targetSourceId === '' ||
          output.targetSourceId.length > 1024 ||
          output.targetNodeLocator === '' ||
          output.targetNodeLocator.length > 4096 ||
          output.startByte > output.endByte
        ) {
          throw invalid(path, 'invalid target origin');
        }
        if (sourceId !== null && sourceId !== output.targetSourceId) {
          throw invalid(path, 'one provenance map must bind one target source');
        }
        sourceId = output.targetSourceId;
        const range = { start: output.startByte, end: output.endByte };
        const previous = locatorRanges.get(output.targetNodeLocator);
        if (previous !== undefined && (previous.start !== range.start || previous.end !== range.end)) {
          throw invalid(path, 'one target node locator cannot identify contradictory ranges');
        }
        locatorRanges.set(output.targetNodeLocator, range);
      }
    }
    return new MaterializationProvenanceMapMessage(entries);
  }

  /** Ordered complete provenance entries. */
  entries(): readonly MaterializationProvenanceEntry[] {
    return this.#entries;
  }

  /** Encodes the fixed provenance schema (materialization.rs:470-504). */
  toValue(): ObjectValue {
    return objectValueFrom([
      { key: 'schema', value: { kind: 'String', value: 'core.materialization-provenance-map@1' } },
      {
        key: 'entries',
        value: {
          kind: 'Sequence',
          items: this.#entries.map((entry) =>
            objectValueFrom([
              { key: 'input', value: inputLocationValue(entry.input) },
              {
                key: 'outputs',
                value: {
                  kind: 'Sequence',
                  items: entry.outputs.map((output) =>
                    objectValueFrom([
                      { key: 'target_source_id', value: { kind: 'String', value: output.targetSourceId } },
                      {
                        key: 'target_node_locator',
                        value: { kind: 'String', value: output.targetNodeLocator },
                      },
                      { key: 'start_byte', value: wireInteger(output.startByte) },
                      { key: 'end_byte', value: wireInteger(output.endByte) },
                      { key: 'relation', value: { kind: 'String', value: output.relation } },
                    ]),
                  ),
                },
              },
            ]),
          ),
        },
      },
    ]);
  }

  /** Strictly decodes external identities and complete ordered mappings (materialization.rs:507-534). */
  static fromValue(value: PortableValue): MaterializationProvenanceMapMessage {
    const fields = schemaFields(value, 'core.materialization-provenance-map@1', ['entries'], '$');
    const entries = sequenceOf(fields[0], '$.entries').map((entry, entryIndex) => {
      const path = `$.entries[${entryIndex}]`;
      const entryFields = exactFields(entry, ['input', 'outputs'], path);
      const outputs = sequenceOf(entryFields[1], `${path}.outputs`).map((output, outputIndex) =>
        parseMaterializedOrigin(output, `${path}.outputs[${outputIndex}]`),
      );
      return {
        input: parseInputLocation(entryFields[0], `${path}.input`),
        outputs,
      };
    });
    return MaterializationProvenanceMapMessage.new(entries);
  }
}

/** Encodes one portable input location (materialization.rs:1487-1498). */
function inputLocationValue(input: MaterializationProvenanceEntry['input']): ObjectValue {
  switch (input.kind) {
    case 'ValuePath':
      return objectValueFrom([
        { key: 'kind', value: { kind: 'String', value: 'Value' } },
        { key: 'value', value: input.value.toValue() },
      ]);
    case 'AssociationLocation':
      return objectValueFrom([
        { key: 'kind', value: { kind: 'String', value: 'Association' } },
        { key: 'value', value: input.value.toValue() },
      ]);
  }
}

/** Strictly decodes one portable input location (materialization.rs:1500-1512). */
function parseInputLocation(value: PortableValue, path: string): MaterializationProvenanceEntry['input'] {
  const fields = exactFields(value, ['kind', 'value'], path);
  switch (stringOf(fields[0], `${path}.kind`)) {
    case 'Value':
      return { kind: 'ValuePath', value: ValuePath.fromValue(fields[1]) };
    case 'Association':
      return { kind: 'AssociationLocation', value: AssociationLocation.fromValue(fields[1]) };
    default:
      throw invalid(path, 'unknown input location kind');
  }
}

/** Strictly decodes one target origin (materialization.rs:1537-1559). */
function parseMaterializedOrigin(value: PortableValue, path: string): MaterializedOrigin {
  const fields = exactFields(
    value,
    ['target_source_id', 'target_node_locator', 'start_byte', 'end_byte', 'relation'],
    path,
  );
  const relation = stringOf(fields[4], `${path}.relation`);
  if (relation !== 'Direct' && relation !== 'Reencoded' && relation !== 'Generated') {
    throw invalid(path, 'unknown materialization relation');
  }
  return {
    targetSourceId: stringOf(fields[0], `${path}.target_source_id`),
    targetNodeLocator: stringOf(fields[1], `${path}.target_node_locator`),
    startByte: unsigned64(fields[2], `${path}.start_byte`),
    endByte: unsigned64(fields[3], `${path}.end_byte`),
    relation,
  };
}

// ---------------------------------------------------------------------------
// core.materialization-failure@1 (nested record of the result outcomes)
// ---------------------------------------------------------------------------

/** The stable transferable materialization failure, without partial target bytes. */
export class MaterializationFailureMessage {
  readonly kind:
    | 'InvalidRequest'
    | 'UnsupportedProfile'
    | 'UnsupportedStyle'
    | 'UnsupportedEncoding'
    | 'UnsupportedNewline'
    | 'Unrepresentable'
    | 'ResourceLimit'
    | 'FormationFailed';
  /** InvalidRequest detail or ResourceLimit limit. */
  readonly detail: string | null;
  /** Unrepresentable input path. */
  readonly path: ValuePath | null;
  /** Unrepresentable core value kind. */
  readonly valueKind: string | null;

  private constructor(
    kind: MaterializationFailureMessage['kind'],
    detail: string | null,
    path: ValuePath | null,
    valueKind: string | null,
  ) {
    this.kind = kind;
    this.detail = detail;
    this.path = path;
    this.valueKind = valueKind;
  }

  /** Request fields contradict the target contract. */
  static invalidRequest(detail: string): MaterializationFailureMessage {
    if (detail === '' || detail.length > 4096) {
      throw invalid('$', 'invalid failure detail');
    }
    return new MaterializationFailureMessage('InvalidRequest', detail, null, null);
  }

  /** Target profile is unavailable. */
  static unsupportedProfile(): MaterializationFailureMessage {
    return new MaterializationFailureMessage('UnsupportedProfile', null, null, null);
  }

  /** Style is unavailable for the target profile. */
  static unsupportedStyle(): MaterializationFailureMessage {
    return new MaterializationFailureMessage('UnsupportedStyle', null, null, null);
  }

  /** Encoding is unavailable for the target profile. */
  static unsupportedEncoding(): MaterializationFailureMessage {
    return new MaterializationFailureMessage('UnsupportedEncoding', null, null, null);
  }

  /** Newline policy is unavailable for the selected style. */
  static unsupportedNewline(): MaterializationFailureMessage {
    return new MaterializationFailureMessage('UnsupportedNewline', null, null, null);
  }

  /** One complete input value cannot be represented. */
  static unrepresentable(path: ValuePath, kind: string): MaterializationFailureMessage {
    parseValueKind(kind, '$');
    return new MaterializationFailureMessage('Unrepresentable', null, path, kind);
  }

  /** A configured limit was reached. */
  static resourceLimit(limit: string): MaterializationFailureMessage {
    if (limit === '' || limit.length > 256 || !/^[a-z0-9-]+$/.test(limit)) {
      throw invalid('$', 'invalid resource limit ID');
    }
    return new MaterializationFailureMessage('ResourceLimit', limit, null, null);
  }

  /** Generated bytes did not form a target document. */
  static formationFailed(): MaterializationFailureMessage {
    return new MaterializationFailureMessage('FormationFailed', null, null, null);
  }

  /** Exact public error code registered by semantic-model v3 (materialization.rs:588-599). */
  code(): string {
    switch (this.kind) {
      case 'InvalidRequest':
        return 'core.materialization.invalid-request@1';
      case 'UnsupportedProfile':
        return 'core.materialization.unsupported-profile@1';
      case 'UnsupportedStyle':
        return 'core.materialization.unsupported-style@1';
      case 'UnsupportedEncoding':
        return 'core.materialization.unsupported-encoding@1';
      case 'UnsupportedNewline':
        return 'core.materialization.unsupported-newline@1';
      case 'Unrepresentable':
        return 'core.materialization.unrepresentable@1';
      case 'ResourceLimit':
        return 'core.materialization.resource-limit@1';
      case 'FormationFailed':
        return 'core.materialization.formation-failed@1';
    }
  }

  /** Encodes the closed variant record (materialization.rs:1118-1159). */
  toValue(): ObjectValue {
    switch (this.kind) {
      case 'InvalidRequest':
        return objectValueFrom([
          { key: 'kind', value: { kind: 'String', value: 'InvalidRequest' } },
          { key: 'code', value: { kind: 'String', value: this.code() } },
          { key: 'detail', value: { kind: 'String', value: this.detail! } },
        ]);
      case 'Unrepresentable':
        return objectValueFrom([
          { key: 'kind', value: { kind: 'String', value: 'Unrepresentable' } },
          { key: 'code', value: { kind: 'String', value: this.code() } },
          { key: 'path', value: this.path!.toValue() },
          { key: 'value_kind', value: { kind: 'String', value: this.valueKind! } },
        ]);
      case 'ResourceLimit':
        return objectValueFrom([
          { key: 'kind', value: { kind: 'String', value: 'ResourceLimit' } },
          { key: 'code', value: { kind: 'String', value: this.code() } },
          { key: 'limit', value: { kind: 'String', value: this.detail! } },
        ]);
      default:
        return objectValueFrom([
          { key: 'kind', value: { kind: 'String', value: this.kind } },
          { key: 'code', value: { kind: 'String', value: this.code() } },
        ]);
    }
  }

  /** Strictly decodes one failure (materialization.rs:1161-1242). */
  static fromValue(value: PortableValue, path: string): MaterializationFailureMessage {
    const kind = kindEntryOf(value, path);
    let failure: MaterializationFailureMessage;
    switch (kind) {
      case 'InvalidRequest': {
        const fields = exactFields(value, ['kind', 'code', 'detail'], path);
        const detail = stringOf(fields[2], `${path}.detail`);
        if (detail === '' || detail.length > 4096) {
          throw invalid(path, 'invalid failure detail');
        }
        failure = MaterializationFailureMessage.invalidRequest(detail);
        break;
      }
      case 'UnsupportedProfile':
        exactFields(value, ['kind', 'code'], path);
        failure = MaterializationFailureMessage.unsupportedProfile();
        break;
      case 'UnsupportedStyle':
        exactFields(value, ['kind', 'code'], path);
        failure = MaterializationFailureMessage.unsupportedStyle();
        break;
      case 'UnsupportedEncoding':
        exactFields(value, ['kind', 'code'], path);
        failure = MaterializationFailureMessage.unsupportedEncoding();
        break;
      case 'UnsupportedNewline':
        exactFields(value, ['kind', 'code'], path);
        failure = MaterializationFailureMessage.unsupportedNewline();
        break;
      case 'Unrepresentable': {
        const fields = exactFields(value, ['kind', 'code', 'path', 'value_kind'], path);
        const valueKind = stringOf(fields[3], `${path}.value_kind`);
        failure = MaterializationFailureMessage.unrepresentable(
          ValuePath.fromValue(fields[2]),
          parseValueKind(valueKind, path),
        );
        break;
      }
      case 'ResourceLimit': {
        const fields = exactFields(value, ['kind', 'code', 'limit'], path);
        const limit = stringOf(fields[2], `${path}.limit`);
        if (limit === '' || limit.length > 256 || !/^[a-z0-9-]+$/.test(limit)) {
          throw invalid(path, 'invalid resource limit ID');
        }
        failure = MaterializationFailureMessage.resourceLimit(limit);
        break;
      }
      case 'FormationFailed':
        exactFields(value, ['kind', 'code'], path);
        failure = MaterializationFailureMessage.formationFailed();
        break;
      default:
        throw invalid(path, 'unknown materialization failure');
    }
    // The wire code must be registered and must match the kind
    // (materialization.rs:1229-1240).
    const code = codeEntryOf(value, path);
    const codePath = `${path}.code`;
    const descriptor = new ErrorCodeRegistry(3).descriptor(code);
    if (descriptor === undefined) {
      throw invalid(codePath, `unregistered public code: ${code}`);
    }
    if (code !== failure.code()) {
      throw invalid(codePath, 'failure kind contradicts its registered code');
    }
    return failure;
  }
}

/** Reads the `kind` field of a variant record at any position (materialization.rs:1166-1172). */
function kindEntryOf(value: PortableValue, path: string): string {
  const entry = (value as { entries?: { key: string; value: PortableValue }[] }).entries?.find(
    (candidate) => candidate.key === 'kind',
  );
  if (entry === undefined) {
    throw invalid(path, 'missing kind');
  }
  return stringOf(entry.value, `${path}.kind`);
}

/** Reads the `code` field of a variant record at any position (materialization.rs:1229-1232). */
function codeEntryOf(value: PortableValue, path: string): string {
  const entry = (value as { entries?: { key: string; value: PortableValue }[] }).entries?.find(
    (candidate) => candidate.key === 'code',
  );
  if (entry === undefined) {
    throw invalid(path, 'missing code');
  }
  return stringOf(entry.value, `${path}.code`);
}

/** The closed portable value kind vocabulary (materialization.rs:1322-1341). */
function parseValueKind(value: string, path: string): string {
  switch (value) {
    case 'Null':
    case 'Boolean':
    case 'Integer':
    case 'Decimal':
    case 'BinaryFloat32':
    case 'BinaryFloat64':
    case 'String':
    case 'Bytes':
    case 'Date':
    case 'Time':
    case 'LocalDateTime':
    case 'OffsetDateTime':
    case 'Sequence':
    case 'Object':
    case 'EntryMapping':
      return value;
    default:
      throw invalid(path, 'unknown portable value kind');
  }
}

// ---------------------------------------------------------------------------
// core.materialization-request@1 and @2
// ---------------------------------------------------------------------------

/** The transferable `core.materialization-request@1` record. */
export class MaterializationRequestMessage {
  readonly #request: MaterializationRequest;

  private constructor(request: MaterializationRequest) {
    this.#request = request;
  }

  /** Copies one validated common request. */
  static fromRequest(request: MaterializationRequest): MaterializationRequestMessage {
    return new MaterializationRequestMessage(request);
  }

  /** Exact common request. */
  request(): MaterializationRequest {
    return this.#request;
  }

  /** Encodes the fixed-field request schema (materialization.rs:44-57). */
  toValue(): ObjectValue {
    if (this.#request.encoding().kind === 'WindowsCodePage') {
      throw invalid('$.encoding', 'core.materialization-request@1 does not support Windows code pages');
    }
    return materializationRequestValue(
      this.#request,
      'core.materialization-request@1',
      { kind: 'String', value: encodingAsStr(this.#request.encoding()) },
    );
  }

  /** Strictly decodes every request policy and bound (materialization.rs:59-67). */
  static fromValue(value: PortableValue): MaterializationRequestMessage {
    return new MaterializationRequestMessage(
      materializationRequestFromValue(value, 'core.materialization-request@1', (field, path) =>
        parseV1Encoding(stringOf(field, path), path),
      ),
    );
  }
}

/** The transferable `core.materialization-request@2` record. */
export class MaterializationRequestMessageV2 {
  readonly #request: MaterializationRequest;

  private constructor(request: MaterializationRequest) {
    this.#request = request;
  }

  /** Copies one validated common request. */
  static fromRequest(request: MaterializationRequest): MaterializationRequestMessageV2 {
    return new MaterializationRequestMessageV2(request);
  }

  /** Exact common request. */
  request(): MaterializationRequest {
    return this.#request;
  }

  /** Encodes the exact materialization-request v2 schema (materialization.rs:91-98). */
  toValue(): ObjectValue {
    return materializationRequestValue(
      this.#request,
      'core.materialization-request@2',
      SourceEncodingMessage.fromEncoding(this.#request.encoding()).toValue(),
    );
  }

  /** Strictly decodes every v2 request policy and bound (materialization.rs:100-107). */
  static fromValue(value: PortableValue): MaterializationRequestMessageV2 {
    return new MaterializationRequestMessageV2(
      materializationRequestFromValue(value, 'core.materialization-request@2', (field, path) =>
        SourceEncodingMessage.fromValue(field).encoding(),
      ),
    );
  }
}

/** Encodes the shared request field set (materialization.rs:110-137). */
function materializationRequestValue(
  request: MaterializationRequest,
  schema: string,
  encoding: PortableValue,
): ObjectValue {
  const limits = request.limits();
  return objectValueFrom([
    { key: 'schema', value: { kind: 'String', value: schema } },
    { key: 'target_profile', value: profileValue(request.targetProfile()) },
    { key: 'style', value: referenceValue(request.style().id(), request.style().version()) },
    { key: 'encoding', value: encoding },
    { key: 'newline', value: { kind: 'String', value: request.newline() } },
    { key: 'mapping_policy', value: { kind: 'String', value: request.mappingPolicy() } },
    { key: 'representability', value: { kind: 'String', value: request.representability() } },
    {
      key: 'limits',
      value: objectValueFrom([
        { key: 'max_input_nodes', value: wireInteger(BigInt(limits.maxInputNodes)) },
        { key: 'max_output_bytes', value: wireInteger(BigInt(limits.maxOutputBytes)) },
        { key: 'max_depth', value: wireInteger(BigInt(limits.maxDepth)) },
        { key: 'max_report_entries', value: wireInteger(BigInt(limits.maxReportEntries)) },
        { key: 'max_provenance_entries', value: wireInteger(BigInt(limits.maxProvenanceEntries)) },
      ]),
    },
  ]);
}

/** Strictly decodes the shared request field set (materialization.rs:139-179). */
function materializationRequestFromValue(
  value: PortableValue,
  schema: string,
  parseEncoding: (value: PortableValue, path: string) => SourceEncoding,
): MaterializationRequest {
  const fields = schemaFields(
    value,
    schema,
    ['target_profile', 'style', 'encoding', 'newline', 'mapping_policy', 'representability', 'limits'],
    '$',
  );
  const targetProfile = parseProfile(fields[0], '$.target_profile');
  const style = parseReference(fields[1], '$.style');
  const encoding = parseEncoding(fields[2], '$.encoding');
  const newline = parseNewline(stringOf(fields[3], '$.newline'));
  const mappingPolicy = parseMappingPolicy(stringOf(fields[4], '$.mapping_policy'));
  if (stringOf(fields[5], '$.representability') !== 'ExactOnly') {
    throw invalid('$.representability', 'requires ExactOnly');
  }
  return new MaterializationRequest(targetProfile, new MaterializationStyleId(style.id, style.version))
    .withEncoding(encoding)
    .withNewline(newline)
    .withMappingPolicy(mappingPolicy)
    .withLimits(parseMaterializationLimits(fields[6], '$.limits'));
}

/** The v1 encoding IDs (materialization.rs:1476-1485). */
function parseV1Encoding(value: string, path: string): SourceEncoding {
  switch (value) {
    case 'binary':
      return { kind: 'Binary' };
    case 'utf-8':
      return { kind: 'Utf8' };
    case 'utf-16le':
      return { kind: 'Utf16Le' };
    case 'utf-16be':
      return { kind: 'Utf16Be' };
    case 'latin-1':
      return { kind: 'Latin1' };
    default:
      throw invalid(path, 'unknown source encoding');
  }
}

/** The closed newline policy spellings (materialization.rs:1446-1453). */
function parseNewline(value: string): NewlinePolicy {
  switch (value) {
    case 'None':
    case 'Lf':
    case 'CrLf':
      return value;
    default:
      throw invalid('$.newline', 'unknown newline policy');
  }
}

/** The closed mapping policy spellings (materialization.rs:1462-1468). */
function parseMappingPolicy(value: string): MappingPolicy {
  switch (value) {
    case 'RequireObject':
    case 'UniqueStringEntriesToObject':
      return value;
    default:
      throw invalid('$.mapping_policy', 'unknown mapping policy');
  }
}

/** Strictly decodes the five fixed materialization limits (materialization.rs:1412-1431). */
function parseMaterializationLimits(value: PortableValue, path: string): MaterializationLimits {
  const fields = exactFields(
    value,
    ['max_input_nodes', 'max_output_bytes', 'max_depth', 'max_report_entries', 'max_provenance_entries'],
    path,
  );
  return {
    maxInputNodes: usizeValue(fields[0], `${path}.max_input_nodes`),
    maxOutputBytes: usizeValue(fields[1], `${path}.max_output_bytes`),
    maxDepth: usizeValue(fields[2], `${path}.max_depth`),
    maxReportEntries: usizeValue(fields[3], `${path}.max_report_entries`),
    maxProvenanceEntries: usizeValue(fields[4], `${path}.max_provenance_entries`),
  };
}

/** Requires a u64 that fits the host number range (materialization.rs:1433-1436). */
function usizeValue(value: PortableValue, path: string): number {
  const n = unsigned64(value, path);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw invalid(path, 'value exceeds host range');
  }
  return Number(n);
}

// ---------------------------------------------------------------------------
// core.materialization-result@1 and @2
// ---------------------------------------------------------------------------

/** The snapshot surface the result outcomes need (the records_source records). */
interface SourceSnapshotLike {
  snapshot(): { bytes(): Uint8Array };
  toValue(): ObjectValue;
}

/** The complete branch of a materialization outcome. */
export type MaterializationOutcome =
  | {
      readonly kind: 'Complete';
      readonly targetSourceId: string;
      readonly snapshot: SourceSnapshotLike;
      readonly fidelity: MaterializationFidelity;
      readonly report: MaterializationReportMessage;
      readonly provenance: MaterializationProvenanceMapMessage;
    }
  | {
      readonly kind: 'Failed';
      readonly failure: MaterializationFailureMessage;
      readonly report: MaterializationReportMessage;
      readonly analyzedInputPaths: readonly ValuePath[];
    };

/** The transferable `core.materialization-result@1` record. */
export class MaterializationResultMessage {
  readonly #targetProfile: ProfileId;
  readonly #outcome: MaterializationOutcome;

  private constructor(targetProfile: ProfileId, outcome: MaterializationOutcome) {
    this.#targetProfile = targetProfile;
    this.#outcome = outcome;
  }

  /** Validates a complete result and binds every target fact to one stable source ID (materialization.rs:638-656). */
  static complete(
    targetProfile: ProfileId,
    targetSourceId: string,
    snapshot: SourceSnapshotMessage,
    fidelity: MaterializationFidelity,
    report: MaterializationReportMessage,
    provenance: MaterializationProvenanceMapMessage,
  ): MaterializationResultMessage {
    return new MaterializationResultMessage(
      targetProfile,
      completeOutcome(targetSourceId, snapshot, fidelity, report, provenance),
    );
  }

  /** Validates a failed result which cannot carry target bytes or provenance (materialization.rs:659-673). */
  static failed(
    targetProfile: ProfileId,
    failure: MaterializationFailureMessage,
    report: MaterializationReportMessage,
    analyzedInputPaths: readonly ValuePath[],
  ): MaterializationResultMessage {
    return new MaterializationResultMessage(targetProfile, failedOutcome(failure, report, analyzedInputPaths));
  }

  /** Exact target Profile. */
  targetProfile(): ProfileId {
    return this.#targetProfile;
  }

  /** Complete or explicitly failed outcome. */
  outcome(): MaterializationOutcome {
    return this.#outcome;
  }

  /** Encodes the fixed, explicitly tagged completion schema (materialization.rs:719-728). */
  toValue(): ObjectValue {
    return objectValueFrom([
      { key: 'schema', value: { kind: 'String', value: 'core.materialization-result@1' } },
      { key: 'target_profile', value: profileValue(this.#targetProfile) },
      { key: 'outcome', value: outcomeValue(this.#outcome) },
    ]);
  }

  /** Strictly decodes and revalidates snapshot, report, provenance, and failure facts (materialization.rs:736-802). */
  static fromValue(value: PortableValue, registry: ErrorCodeRegistry): MaterializationResultMessage {
    const fields = schemaFields(value, 'core.materialization-result@1', ['target_profile', 'outcome'], '$');
    const targetProfile = parseProfile(fields[0], '$.target_profile');
    const outcome = parseOutcome(fields[1], '$.outcome', registry, false);
    return new MaterializationResultMessage(targetProfile, outcome);
  }
}

/** The transferable `core.materialization-result@2` record. */
export class MaterializationResultMessageV2 {
  readonly #targetProfile: ProfileId;
  readonly #outcome: MaterializationOutcome;

  private constructor(targetProfile: ProfileId, outcome: MaterializationOutcome) {
    this.#targetProfile = targetProfile;
    this.#outcome = outcome;
  }

  /** Validates a complete source-v2 result and every target binding (materialization.rs:841-859). */
  static complete(
    targetProfile: ProfileId,
    targetSourceId: string,
    snapshot: SourceSnapshotMessageV2,
    fidelity: MaterializationFidelity,
    report: MaterializationReportMessage,
    provenance: MaterializationProvenanceMapMessage,
  ): MaterializationResultMessageV2 {
    return new MaterializationResultMessageV2(
      targetProfile,
      completeOutcome(targetSourceId, snapshot, fidelity, report, provenance),
    );
  }

  /** Validates a failed result which cannot carry target bytes or provenance (materialization.rs:861-876). */
  static failed(
    targetProfile: ProfileId,
    failure: MaterializationFailureMessage,
    report: MaterializationReportMessage,
    analyzedInputPaths: readonly ValuePath[],
  ): MaterializationResultMessageV2 {
    return new MaterializationResultMessageV2(targetProfile, failedOutcome(failure, report, analyzedInputPaths));
  }

  /** Exact target Profile. */
  targetProfile(): ProfileId {
    return this.#targetProfile;
  }

  /** Complete or explicitly failed outcome. */
  outcome(): MaterializationOutcome {
    return this.#outcome;
  }

  /** Encodes the fixed, explicitly tagged result-v2 schema (materialization.rs:920-929). */
  toValue(): ObjectValue {
    return objectValueFrom([
      { key: 'schema', value: { kind: 'String', value: 'core.materialization-result@2' } },
      { key: 'target_profile', value: profileValue(this.#targetProfile) },
      { key: 'outcome', value: outcomeValue(this.#outcome) },
    ]);
  }

  /** Strictly decodes reports under one explicit semantic-model registry (materialization.rs:932-998). */
  static fromValueWithRegistry(value: PortableValue, registry: ErrorCodeRegistry): MaterializationResultMessageV2 {
    const fields = schemaFields(value, 'core.materialization-result@2', ['target_profile', 'outcome'], '$');
    const targetProfile = parseProfile(fields[0], '$.target_profile');
    const outcome = parseOutcome(fields[1], '$.outcome', registry, true);
    return new MaterializationResultMessageV2(targetProfile, outcome);
  }
}

/** Validates and builds the complete-outcome invariants (materialization.rs:1001-1034). */
function completeOutcome(
  targetSourceId: string,
  snapshot: SourceSnapshotLike,
  fidelity: MaterializationFidelity,
  report: MaterializationReportMessage,
  provenance: MaterializationProvenanceMapMessage,
): MaterializationOutcome {
  const snapshotLen = snapshot.snapshot().bytes().length;
  if (targetSourceId === '' || targetSourceId.length > 1024) {
    throw invalid('$.outcome.target_source_id', 'invalid source ID');
  }
  validateReportSource(report, targetSourceId);
  const outputLen = BigInt(snapshotLen);
  for (let entryIndex = 0; entryIndex < provenance.entries().length; entryIndex++) {
    const entry = provenance.entries()[entryIndex];
    for (let outputIndex = 0; outputIndex < entry.outputs.length; outputIndex++) {
      const output = entry.outputs[outputIndex];
      if (output.targetSourceId !== targetSourceId || output.endByte > outputLen) {
        throw invalid(
          `$.outcome.provenance.entries[${entryIndex}].outputs[${outputIndex}]`,
          'provenance target binding or range contradicts the snapshot',
        );
      }
    }
  }
  if (
    fidelity === 'Transformed' &&
    !report.events().some((event) => event.code === 'core.materialization.mapping-transformed@1')
  ) {
    throw invalid('$.outcome.report', 'Transformed fidelity requires an explicit transformation event');
  }
  return { kind: 'Complete', targetSourceId, snapshot, fidelity, report, provenance };
}

/** Validates and builds the failed-outcome invariants (materialization.rs:1036-1040). */
function failedOutcome(
  failure: MaterializationFailureMessage,
  report: MaterializationReportMessage,
  analyzedInputPaths: readonly ValuePath[],
): MaterializationOutcome {
  // A failed result cannot claim target bytes, so its report events must
  // carry no source locations at all (materialization.rs:1251-1282).
  validateReportSource(report, null);
  return { kind: 'Failed', failure, report, analyzedInputPaths };
}

/** Requires every report location to bind the expected source (or none for failed outcomes) (materialization.rs:1251-1282). */
function validateReportSource(report: MaterializationReportMessage, expected: string | null): void {
  for (let index = 0; index < report.events().length; index++) {
    const event = report.events()[index];
    const sourceIds: string[] = [];
    if (event.primary !== undefined) {
      sourceIds.push(event.primary.sourceId);
    }
    for (const related of event.related) {
      sourceIds.push(related.location.sourceId);
    }
    for (const fix of event.fixes) {
      if (fix.location !== undefined) {
        sourceIds.push(fix.location.sourceId);
      }
    }
    if (sourceIds.some((sourceId) => expected !== sourceId)) {
      throw invalid(
        `$.outcome.report.events[${index}].location.source_id`,
        'report location contradicts the materialization outcome',
      );
    }
  }
}

/** Encodes one outcome (materialization.rs:1042-1077). */
function outcomeValue(outcome: MaterializationOutcome): ObjectValue {
  switch (outcome.kind) {
    case 'Complete':
      return objectValueFrom([
        { key: 'kind', value: { kind: 'String', value: 'Complete' } },
        { key: 'target_source_id', value: { kind: 'String', value: outcome.targetSourceId } },
        { key: 'snapshot', value: outcome.snapshot.toValue() },
        { key: 'fidelity', value: { kind: 'String', value: outcome.fidelity } },
        { key: 'report', value: outcome.report.toValue() },
        { key: 'provenance', value: outcome.provenance.toValue() },
      ]);
    case 'Failed':
      return objectValueFrom([
        { key: 'kind', value: { kind: 'String', value: 'Failed' } },
        { key: 'failure', value: outcome.failure.toValue() },
        { key: 'report', value: outcome.report.toValue() },
        {
          key: 'analyzed_input_paths',
          value: {
            kind: 'Sequence',
            items: outcome.analyzedInputPaths.map((path) => path.toValue()),
          },
        },
      ]);
  }
}

/** Strictly decodes one outcome branch (materialization.rs:742-802 / 943-998). */
function parseOutcome(
  value: PortableValue,
  path: string,
  registry: ErrorCodeRegistry,
  v2: boolean,
): MaterializationOutcome {
  const kind = kindEntryOf(value, path);
  switch (kind) {
    case 'Complete': {
      const fields = exactFields(
        value,
        ['kind', 'target_source_id', 'snapshot', 'fidelity', 'report', 'provenance'],
        path,
      );
      const targetSourceId = stringOf(fields[1], `${path}.target_source_id`);
      const fidelity = parseMaterializationFidelity(stringOf(fields[3], `${path}.fidelity`));
      const report = MaterializationReportMessage.fromValue(fields[4], registry);
      const provenance = MaterializationProvenanceMapMessage.fromValue(fields[5]);
      const snapshot: SourceSnapshotLike = v2
        ? SourceSnapshotMessageV2.fromValue(fields[2], DEFAULT_SOURCE_LIMITS)
        : SourceSnapshotMessage.fromValue(fields[2], DEFAULT_SOURCE_LIMITS);
      return completeOutcome(targetSourceId, snapshot, fidelity, report, provenance);
    }
    case 'Failed': {
      const fields = exactFields(value, ['kind', 'failure', 'report', 'analyzed_input_paths'], path);
      const failure = MaterializationFailureMessage.fromValue(fields[1], `${path}.failure`);
      const report = MaterializationReportMessage.fromValue(fields[2], registry);
      const analyzedInputPaths = sequenceOf(fields[3], `${path}.analyzed_input_paths`).map((item) =>
        ValuePath.fromValue(item),
      );
      return failedOutcome(failure, report, analyzedInputPaths);
    }
    default:
      throw invalid(`${path}.kind`, 'unknown materialization outcome');
  }
}

/** The closed materialization fidelity spellings (materialization.rs:1291-1300). */
function parseMaterializationFidelity(value: string): MaterializationFidelity {
  switch (value) {
    case 'Exact':
    case 'Transformed':
      return value;
    default:
      throw invalid('$.outcome.fidelity', 'unknown materialization fidelity');
  }
}

// ---------------------------------------------------------------------------
// core.conversion-report@1
// ---------------------------------------------------------------------------

/** Whole-conversion semantic fidelity (conversion.rs:11-20). */
export type ConversionFidelity = 'Exact' | 'Transformed' | 'Lossy';

/** The worst of two stage fidelities (Exact < Transformed < Lossy). */
function maxFidelity(left: ConversionFidelity, right: ConversionFidelity): ConversionFidelity {
  const rank = (fidelity: ConversionFidelity): number =>
    fidelity === 'Exact' ? 0 : fidelity === 'Transformed' ? 1 : 2;
  return rank(left) >= rank(right) ? left : right;
}

/** The transferable `core.conversion-report@1` with both stages intact. */
export class ConversionReportMessage {
  readonly #sourceProfile: ProfileId;
  readonly #targetProfile: ProfileId;
  readonly #projectionFidelity: ConversionFidelity;
  readonly #projectionReport: ProjectionReportMessage;
  readonly #materializationFidelity: MaterializationFidelity;
  readonly #materializationReport: MaterializationReportMessage;
  readonly #overallFidelity: ConversionFidelity;

  private constructor(
    sourceProfile: ProfileId,
    targetProfile: ProfileId,
    projectionFidelity: ConversionFidelity,
    projectionReport: ProjectionReportMessage,
    materializationFidelity: MaterializationFidelity,
    materializationReport: MaterializationReportMessage,
    overallFidelity: ConversionFidelity,
  ) {
    this.#sourceProfile = sourceProfile;
    this.#targetProfile = targetProfile;
    this.#projectionFidelity = projectionFidelity;
    this.#projectionReport = projectionReport;
    this.#materializationFidelity = materializationFidelity;
    this.#materializationReport = materializationReport;
    this.#overallFidelity = overallFidelity;
  }

  /** Validates stage fidelity against complete reports and recomputes the overall result (conversion.rs:36-98). */
  static new(
    sourceProfile: ProfileId,
    targetProfile: ProfileId,
    projectionFidelity: ConversionFidelity,
    projectionReport: ProjectionReportMessage,
    materializationFidelity: MaterializationFidelity,
    materializationReport: MaterializationReportMessage,
    overallFidelity: ConversionFidelity,
  ): ConversionReportMessage {
    const events = projectionReport.events;
    const hasReversible = events.some((event) => event.lossClassification === 'Reversible');
    const hasLoss = events.some((event) => event.lossClassification === 'Lossy');
    const projectionValid =
      projectionFidelity === 'Exact'
        ? !hasReversible && !hasLoss
        : projectionFidelity === 'Transformed'
          ? hasReversible && !hasLoss
          : hasLoss;
    if (!projectionValid) {
      throw invalid('$.projection_report', 'projection fidelity contradicts its complete event report');
    }
    const hasMaterializationTransform = materializationReport
      .events()
      .some((event) => event.code === 'core.materialization.mapping-transformed@1');
    if ((materializationFidelity === 'Transformed') !== hasMaterializationTransform) {
      throw invalid('$.materialization_report', 'materialization fidelity contradicts its complete event report');
    }
    const materializationOverall: ConversionFidelity =
      materializationFidelity === 'Exact' ? 'Exact' : 'Transformed';
    if (overallFidelity !== maxFidelity(projectionFidelity, materializationOverall)) {
      throw invalid('$.overall_fidelity', 'overall fidelity is not the worst complete stage fidelity');
    }
    return new ConversionReportMessage(
      sourceProfile,
      targetProfile,
      projectionFidelity,
      projectionReport,
      materializationFidelity,
      materializationReport,
      overallFidelity,
    );
  }

  /** Exact source Profile. */
  sourceProfile(): ProfileId {
    return this.#sourceProfile;
  }

  /** Exact target Profile. */
  targetProfile(): ProfileId {
    return this.#targetProfile;
  }

  /** Projection-stage fidelity. */
  projectionFidelity(): ConversionFidelity {
    return this.#projectionFidelity;
  }

  /** Complete ordered projection report. */
  projectionReport(): ProjectionReportMessage {
    return this.#projectionReport;
  }

  /** Materialization-stage fidelity. */
  materializationFidelity(): MaterializationFidelity {
    return this.#materializationFidelity;
  }

  /** Complete ordered materialization report. */
  materializationReport(): MaterializationReportMessage {
    return this.#materializationReport;
  }

  /** Worst fidelity across both stages. */
  overallFidelity(): ConversionFidelity {
    return this.#overallFidelity;
  }

  /** Encodes the fixed two-stage report schema (conversion.rs:144-167). */
  toValue(): ObjectValue {
    return objectValueFrom([
      { key: 'schema', value: { kind: 'String', value: 'core.conversion-report@1' } },
      { key: 'source_profile', value: profileValue(this.#sourceProfile) },
      { key: 'target_profile', value: profileValue(this.#targetProfile) },
      { key: 'projection_fidelity', value: { kind: 'String', value: this.#projectionFidelity } },
      { key: 'projection_report', value: this.#projectionReport.toValue() },
      { key: 'materialization_fidelity', value: { kind: 'String', value: this.#materializationFidelity } },
      { key: 'materialization_report', value: this.#materializationReport.toValue() },
      { key: 'overall_fidelity', value: { kind: 'String', value: this.#overallFidelity } },
    ]);
  }

  /** Strictly decodes both stage reports under one semantic-model registry (conversion.rs:175-209). */
  static fromValue(value: PortableValue, registry: ErrorCodeRegistry): ConversionReportMessage {
    const fields = schemaFields(
      value,
      'core.conversion-report@1',
      [
        'source_profile',
        'target_profile',
        'projection_fidelity',
        'projection_report',
        'materialization_fidelity',
        'materialization_report',
        'overall_fidelity',
      ],
      '$',
    );
    return ConversionReportMessage.new(
      parseProfile(fields[0], '$.source_profile'),
      parseProfile(fields[1], '$.target_profile'),
      parseConversionFidelity(stringOf(fields[2], '$.projection_fidelity'), '$.projection_fidelity'),
      ProjectionReportMessage.fromValueWithRegistry(fields[3], registry),
      parseMaterializationFidelity(stringOf(fields[4], '$.materialization_fidelity')),
      MaterializationReportMessage.fromValue(fields[5], registry),
      parseConversionFidelity(stringOf(fields[6], '$.overall_fidelity'), '$.overall_fidelity'),
    );
  }
}

/** The closed conversion fidelity spellings (conversion.rs:238-245). */
function parseConversionFidelity(value: string, path: string): ConversionFidelity {
  switch (value) {
    case 'Exact':
    case 'Transformed':
    case 'Lossy':
      return value;
    default:
      throw invalid(path, 'unknown conversion fidelity');
  }
}

// ---------------------------------------------------------------------------
// core.edit-plan@1
// ---------------------------------------------------------------------------

/** One transferable content-free edit operation summary (operation.rs:102-109). */
export interface EditOperationSummary {
  readonly operation: FormatOperationId;
  readonly summary: ReadonlyMap<string, string>;
}

/** The transferable `core.edit-plan@1` dry-run facts (operation.rs:111-121). */
export class EditPlanMessage {
  readonly #sourceId: string;
  readonly #baseDigest: ContentDigest;
  readonly #profile: ProfileId;
  readonly #operations: readonly EditOperationSummary[];
  readonly #replacements: readonly SourceReplacement[];
  readonly #targetDigest: ContentDigest;
  readonly #report: readonly Diagnostic[];

  private constructor(
    sourceId: string,
    baseDigest: ContentDigest,
    profile: ProfileId,
    operations: readonly EditOperationSummary[],
    replacements: readonly SourceReplacement[],
    targetDigest: ContentDigest,
    report: readonly Diagnostic[],
  ) {
    this.#sourceId = sourceId;
    this.#baseDigest = baseDigest;
    this.#profile = profile;
    this.#operations = operations;
    this.#replacements = replacements;
    this.#targetDigest = targetDigest;
    this.#report = report;
  }

  /** Validates all external dry-run fields and replacement preconditions (operation.rs:187-246). */
  static new(
    sourceId: string,
    baseDigest: ContentDigest,
    profile: ProfileId,
    operations: readonly EditOperationSummary[],
    replacements: readonly SourceReplacement[],
    targetDigest: ContentDigest,
    report: readonly Diagnostic[],
    registry: ErrorCodeRegistry,
  ): EditPlanMessage {
    if (sourceId === '' || sourceId.length > 1024) {
      throw invalid('$.source_id', 'invalid source ID');
    }
    for (let index = 0; index < operations.length; index++) {
      const operation = operations[index];
      // The exact operation ID must be a registered contract identifier
      // (operation.rs:201-203).
      newContractId(operation.operation.id(), operation.operation.version());
      if (
        operation.summary.size > 64 ||
        [...operation.summary.entries()].some(
          ([name, value]) => !validSummaryName(name) || value === '' || value.length > 1024,
        )
      ) {
        throw invalid(`$.operations[${index}]`, 'invalid operation summary');
      }
    }
    validateReplacements(replacements);
    if (replacements.length === 0 && !baseDigest.equals(targetDigest)) {
      throw invalid('$.target_digest', 'an empty replacement set cannot change the content digest');
    }
    for (const event of report) {
      diagnosticFromValue(diagnosticToValue(event), registry);
      const sourceIds: string[] = [];
      if (event.primary !== undefined) {
        sourceIds.push(event.primary.sourceId);
      }
      for (const related of event.related) {
        sourceIds.push(related.location.sourceId);
      }
      for (const fix of event.fixes) {
        if (fix.location !== undefined) {
          sourceIds.push(fix.location.sourceId);
        }
      }
      if (sourceIds.some((locationSource) => locationSource !== sourceId)) {
        throw invalid('$.report.location.source_id', 'all edit report locations must bind the plan source');
      }
    }
    return new EditPlanMessage(
      sourceId,
      baseDigest,
      profile,
      operations,
      replacements,
      targetDigest,
      report,
    );
  }

  /** Caller-stable source ID. */
  sourceId(): string {
    return this.#sourceId;
  }

  /** Required base digest. */
  baseDigest(): ContentDigest {
    return this.#baseDigest;
  }

  /** Exact edit profile. */
  profile(): ProfileId {
    return this.#profile;
  }

  /** Ordered operation summaries. */
  operations(): readonly EditOperationSummary[] {
    return this.#operations;
  }

  /** Exact replacement facts. */
  replacements(): readonly SourceReplacement[] {
    return this.#replacements;
  }

  /** Precomputed target digest. */
  targetDigest(): ContentDigest {
    return this.#targetDigest;
  }

  /** Ordered edit report. */
  report(): readonly Diagnostic[] {
    return this.#report;
  }

  /** Encodes the fixed dry-run plan schema (operation.rs:291-326). */
  toValue(): ObjectValue {
    const operations = this.#operations.map((operation) =>
      objectValueFrom([
        {
          key: 'operation',
          value: referenceValue(operation.operation.id(), operation.operation.version()),
        },
        { key: 'summary', value: summaryObject(operation.summary) },
      ]),
    );
    const replacements = this.#replacements.map((replacement) => replacementValue(replacement));
    return objectValueFrom([
      { key: 'schema', value: { kind: 'String', value: 'core.edit-plan@1' } },
      { key: 'source_id', value: { kind: 'String', value: this.#sourceId } },
      { key: 'base_digest', value: digestValue(this.#baseDigest) },
      { key: 'profile', value: profileValue(this.#profile) },
      { key: 'operations', value: { kind: 'Sequence', items: operations } },
      { key: 'replacements', value: { kind: 'Sequence', items: replacements } },
      { key: 'target_digest', value: digestValue(this.#targetDigest) },
      {
        key: 'report',
        value: {
          kind: 'Sequence',
          items: this.#report.map((event) => diagnosticToValue(event)),
        },
      },
    ]);
  }

  /** Strictly decodes and revalidates a dry-run plan (operation.rs:334-381). */
  static fromValue(value: PortableValue, registry: ErrorCodeRegistry): EditPlanMessage {
    const fields = schemaFields(
      value,
      'core.edit-plan@1',
      ['source_id', 'base_digest', 'profile', 'operations', 'replacements', 'target_digest', 'report'],
      '$',
    );
    const operations = sequenceOf(fields[3], '$.operations').map((operation, index) =>
      parseOperationSummary(operation, `$.operations[${index}]`),
    );
    const replacements = sequenceOf(fields[4], '$.replacements').map((replacement, index) =>
      parseReplacement(replacement, `$.replacements[${index}]`),
    );
    const report = sequenceOf(fields[6], '$.report').map((event) => diagnosticFromValue(event, registry));
    return EditPlanMessage.new(
      stringOf(fields[0], '$.source_id'),
      parseDigest(fields[1], '$.base_digest'),
      parseProfile(fields[2], '$.profile'),
      operations,
      replacements,
      parseDigest(fields[5], '$.target_digest'),
      report,
      registry,
    );
  }
}

/** The safe summary-name rule (edit_plan.rs:221-227). */
function validSummaryName(name: string): boolean {
  return name !== '' && name.length <= 64 && /^[a-z0-9_]+$/.test(name);
}

/** Validates ordered non-overlapping replacement facts (operation.rs:505-534). */
function validateReplacements(replacements: readonly SourceReplacement[]): void {
  let previous: SourceReplacement | null = null;
  for (let index = 0; index < replacements.length; index++) {
    const replacement = replacements[index];
    if (
      replacement.oldStart() > replacement.oldEnd() ||
      replacement.original().length !== replacement.oldEnd() - replacement.oldStart()
    ) {
      throw invalid(`$.replacements[${index}]`, 'replacement range and original bytes disagree');
    }
    if (previous !== null) {
      const duplicateInsertion =
        replacement.oldStart() === replacement.oldEnd() &&
        previous.oldStart() === previous.oldEnd() &&
        replacement.oldStart() === previous.oldStart();
      const pairNotGreater =
        replacement.oldStart() < previous.oldStart() ||
        (replacement.oldStart() === previous.oldStart() && replacement.oldEnd() <= previous.oldEnd());
      if (duplicateInsertion || pairNotGreater || replacement.oldStart() < previous.oldEnd()) {
        throw invalid('$.replacements', 'replacements are not canonically ordered and non-overlapping');
      }
    }
    previous = replacement;
  }
}

/** Encodes one replacement (operation.rs:449-475). */
function replacementValue(replacement: SourceReplacement): ObjectValue {
  return objectValueFrom([
    { key: 'old_start', value: wireInteger(BigInt(replacement.oldStart())) },
    { key: 'old_end', value: wireInteger(BigInt(replacement.oldEnd())) },
    { key: 'original', value: { kind: 'Bytes', value: Uint8Array.from(replacement.original()) } },
    { key: 'replacement', value: { kind: 'Bytes', value: Uint8Array.from(replacement.replacement()) } },
    { key: 'redact_original', value: { kind: 'Boolean', value: replacement.redactOriginal() } },
    { key: 'redact_replacement', value: { kind: 'Boolean', value: replacement.redactReplacement() } },
  ]);
}

/** Strictly decodes one replacement (operation.rs:477-503). */
function parseReplacement(value: PortableValue, path: string): SourceReplacement {
  const fields = exactFields(
    value,
    ['old_start', 'old_end', 'original', 'replacement', 'redact_original', 'redact_replacement'],
    path,
  );
  const oldStart = usizeValue(fields[0], `${path}.old_start`);
  const oldEnd = usizeValue(fields[1], `${path}.old_end`);
  if (fields[2].kind !== 'Bytes' || fields[3].kind !== 'Bytes') {
    throw protocolError('WrongType', path, 'expected Bytes');
  }
  return new SourceReplacement(
    oldStart,
    oldEnd,
    Uint8Array.from(fields[2].value),
    Uint8Array.from(fields[3].value),
  )
    .withOriginalRedacted(booleanOf(fields[4], `${path}.redact_original`))
    .withReplacementRedacted(booleanOf(fields[5], `${path}.redact_replacement`));
}

/** Strictly decodes one operation summary (operation.rs:421-447). */
function parseOperationSummary(value: PortableValue, path: string): EditOperationSummary {
  const fields = exactFields(value, ['operation', 'summary'], path);
  const reference = parseReference(fields[0], `${path}.operation`);
  const summary = new Map<string, string>();
  for (const entry of objectEntriesOf(fields[1], `${path}.summary`)) {
    summary.set(entry.key, stringOf(entry.value, `${path}.summary.${entry.key}`));
  }
  return { operation: new FormatOperationId(reference.id, reference.version), summary };
}

/** The entries of one Object field. */
function objectEntriesOf(value: PortableValue, path: string): { key: string; value: PortableValue }[] {
  if (value.kind !== 'Object') {
    throw protocolError('WrongType', path, 'expected Object');
  }
  return [...value.entries];
}

/** Encodes one sorted Object<String, String> summary. */
function summaryObject(summary: ReadonlyMap<string, string>): ObjectValue {
  const keys = [...summary.keys()].sort();
  return {
    kind: 'Object',
    entries: keys.map((key) => ({ key, value: { kind: 'String', value: summary.get(key)! } })),
  };
}

/** Encodes one content digest (operation.rs:568-573). */
function digestValue(digest: ContentDigest): ObjectValue {
  return objectValueFrom([
    { key: 'algorithm', value: { kind: 'String', value: digest.algorithm() } },
    { key: 'hex', value: { kind: 'String', value: digest.toHex() } },
  ]);
}

/** Strictly decodes one sha256 digest (operation.rs:575-594). */
function parseDigest(value: PortableValue, path: string): ContentDigest {
  const fields = exactFields(value, ['algorithm', 'hex'], path);
  if (stringOf(fields[0], `${path}.algorithm`) !== 'sha256') {
    throw invalid(path, 'expected sha256');
  }
  const hex = stringOf(fields[1], `${path}.hex`);
  if (hex.length !== 64 || !/^[0-9a-f]{64}$/.test(hex)) {
    throw invalid(path, 'invalid lowercase sha256');
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return ContentDigest.fromBytes(bytes);
}

// ---------------------------------------------------------------------------
// core.format-operation-registry@1
// ---------------------------------------------------------------------------

/** The transferable `core.format-operation-registry@1` record. */
export class FormatOperationRegistryMessage {
  readonly #registry: FormatOperationRegistry;

  private constructor(registry: FormatOperationRegistry) {
    this.#registry = registry;
  }

  /** Copies one already validated registry. */
  static fromRegistry(registry: FormatOperationRegistry): FormatOperationRegistryMessage {
    return new FormatOperationRegistryMessage(registry);
  }

  /** Validated operation registry. */
  registry(): FormatOperationRegistry {
    return this.#registry;
  }

  /** Encodes the fixed discovery schema (operation.rs:39-80). */
  toValue(): ObjectValue {
    const operations = this.#registry.operations().map((operation) =>
      objectValueFrom([
        {
          key: 'operation',
          value: referenceValue(operation.id().id(), operation.id().version()),
        },
        {
          key: 'target_role',
          value: referenceValue(operation.targetRole().id(), operation.targetRole().version()),
        },
        {
          key: 'arguments',
          value: {
            kind: 'Sequence',
            items: operation.arguments().map((argument) =>
              objectValueFrom([
                { key: 'name', value: { kind: 'String', value: argument.name() } },
                { key: 'kind', value: { kind: 'String', value: argument.kind() } },
                { key: 'required', value: { kind: 'Boolean', value: argument.required() } },
              ]),
            ),
          },
        },
        { key: 'support', value: { kind: 'String', value: operation.support() } },
      ]),
    );
    return objectValueFrom([
      { key: 'schema', value: { kind: 'String', value: 'core.format-operation-registry@1' } },
      { key: 'profile', value: profileValue(this.#registry.profile()) },
      { key: 'operations', value: { kind: 'Sequence', items: operations } },
    ]);
  }

  /** Strictly decodes and revalidates IDs, schemas, order, and uniqueness (operation.rs:83-99). */
  static fromValue(value: PortableValue): FormatOperationRegistryMessage {
    const fields = schemaFields(value, 'core.format-operation-registry@1', ['profile', 'operations'], '$');
    const profile = parseProfile(fields[0], '$.profile');
    const descriptors = sequenceOf(fields[1], '$.operations').map((operation, index) =>
      parseOperationDescriptor(operation, `$.operations[${index}]`),
    );
    let registry: FormatOperationRegistry;
    try {
      registry = FormatOperationRegistry.create(profile, descriptors);
    } catch (error) {
      throw invalid('$.operations', (error as FormatOperationRegistryError).message);
    }
    return new FormatOperationRegistryMessage(registry);
  }
}

/** Strictly decodes one operation descriptor (operation.rs:384-407). */
function parseOperationDescriptor(value: PortableValue, path: string): FormatOperationDescriptor {
  const fields = exactFields(value, ['operation', 'target_role', 'arguments', 'support'], path);
  const operation = parseReference(fields[0], `${path}.operation`);
  const targetRole = parseReference(fields[1], `${path}.target_role`);
  const arguments_ = sequenceOf(fields[2], `${path}.arguments`).map((argument, index) =>
    parseArgumentDescriptor(argument, `${path}.arguments[${index}]`),
  );
  return new FormatOperationDescriptor(
    new FormatOperationId(operation.id, operation.version),
    new OperationTargetRoleId(targetRole.id, targetRole.version),
    arguments_,
    parseOperationSupport(stringOf(fields[3], `${path}.support`), path),
  );
}

/** Strictly decodes one argument descriptor (operation.rs:409-419). */
function parseArgumentDescriptor(value: PortableValue, path: string): OperationArgumentDescriptor {
  const fields = exactFields(value, ['name', 'kind', 'required'], path);
  return new OperationArgumentDescriptor(
    stringOf(fields[0], `${path}.name`),
    parseArgumentKind(stringOf(fields[1], `${path}.kind`), path),
    booleanOf(fields[2], `${path}.required`),
  );
}

/** The closed argument-kind vocabulary (operation.rs:614-627). */
function parseArgumentKind(value: string, path: string): OperationArgumentKind {
  switch (value) {
    case 'NodeRef':
    case 'String':
    case 'PortableValue':
    case 'Placement':
    case 'ExactBytes':
    case 'RepresentationPolicy':
      return value;
    default:
      throw invalid(path, 'unknown operation argument kind');
  }
}

/** The closed support vocabulary (operation.rs:637-644). */
function parseOperationSupport(value: string, path: string): OperationSupport {
  switch (value) {
    case 'Supported':
    case 'ExistingTypedCapability':
    case 'Unsupported':
      return value;
    default:
      throw invalid(path, 'unknown operation support');
  }
}

// ---------------------------------------------------------------------------
// shared record helpers
// ---------------------------------------------------------------------------

/** The canonical `{id, version}` reference record. */
function referenceValue(id: string, version: number): ObjectValue {
  return objectValueFrom([
    { key: 'id', value: { kind: 'String', value: id } },
    { key: 'version', value: wireInteger(BigInt(version)) },
  ]);
}

/** The canonical `{id, version}` profile record. */
function profileValue(profile: ProfileId): ObjectValue {
  return referenceValue(profile.id(), profile.version());
}

/** Strictly decodes one `{id, version}` reference (materialization.rs:1357-1364). */
function parseReference(value: PortableValue, path: string): { id: string; version: number } {
  const fields = exactFields(value, ['id', 'version'], path);
  const id = stringOf(fields[0], `${path}.id`);
  const version = unsigned32(fields[1], `${path}.version`);
  const contract = newContractId(id, version);
  return { id: contract.id, version: contract.version };
}

/** Strictly decodes one profile reference (registry.rs ProfileReference::new:23-33). */
function parseProfile(value: PortableValue, path: string): ProfileId {
  const fields = exactFields(value, ['id', 'version'], path);
  const id = stringOf(fields[0], `${path}.id`);
  const version = unsigned32(fields[1], `${path}.version`);
  validateNamespace(id, true, `${path}.id`);
  if (version === 0) {
    throw invalid(`${path}.version`, 'version must be non-zero');
  }
  return new ProfileId(id, version);
}

// ---------------------------------------------------------------------------
// payload dispatch
// ---------------------------------------------------------------------------

// Full envelope payload validation (payload.rs): every materialization and
// operation record decodes its payload through these strict decoders under
// the registry of the semantic-model version that owns the envelope.
registerPayloadValidator('core.materialization-report', 1, (payload, registry) => {
  MaterializationReportMessage.fromValue(payload, new ErrorCodeRegistry(registry.versionOf()));
});
registerPayloadValidator('core.materialization-provenance-map', 1, (payload) => {
  MaterializationProvenanceMapMessage.fromValue(payload);
});
registerPayloadValidator('core.materialization-request', 1, (payload) => {
  MaterializationRequestMessage.fromValue(payload);
});
registerPayloadValidator('core.materialization-request', 2, (payload) => {
  MaterializationRequestMessageV2.fromValue(payload);
});
registerPayloadValidator('core.materialization-result', 1, (payload, registry) => {
  MaterializationResultMessage.fromValue(payload, new ErrorCodeRegistry(registry.versionOf()));
});
registerPayloadValidator('core.materialization-result', 2, (payload, registry) => {
  MaterializationResultMessageV2.fromValueWithRegistry(payload, new ErrorCodeRegistry(registry.versionOf()));
});
registerPayloadValidator('core.conversion-report', 1, (payload, registry) => {
  ConversionReportMessage.fromValue(payload, new ErrorCodeRegistry(registry.versionOf()));
});
registerPayloadValidator('core.edit-plan', 1, (payload, registry) => {
  EditPlanMessage.fromValue(payload, new ErrorCodeRegistry(registry.versionOf()));
});
registerPayloadValidator('core.format-operation-registry', 1, (payload) => {
  FormatOperationRegistryMessage.fromValue(payload);
});
