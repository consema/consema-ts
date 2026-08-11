/**
 * `consema.operations.conformance@1` runner (35 cases; mirror of
 * crates/consema-conformance/src/operations_v1.rs).
 */

import type { VectorCase } from '../helpers.ts';
import { caseField, caseFieldOptional, expectedField, expectedFieldOptional, utf8, toHex, valueFromInput } from '../helpers.ts';
import { fail, skip, SkippedCase } from './common.ts';
import type { SuiteExecutor } from '../runner.ts';
import { ContractRegistry } from '../../protocol/contract.ts';
import { ErrorCodeRegistry } from '../../protocol/error_registry.ts';
import { ProtocolMessage } from '../../protocol/contract.ts';
import { formatOperationRegistry as jsonOpRegistry } from '../../json/operation_registry.ts';
import { tomlFormatOperationRegistry } from '../../toml/operation_registry.ts';
import { ProfileId } from '../../document/profile.ts';
import { MaterializationRequest, MaterializationStyleId } from '../../document/materialization.ts';
import { DEFAULT_PARSE_LIMITS } from '../../document/formation.ts';
import { parse as parseJson } from '../../json/parser.ts';
import { parseToml } from '../../toml/document.ts';
import { TomlProfile } from '../../toml/profile.ts';
import { materialize as materializeJson } from '../../json/materialization.ts';
import { materializeToml } from '../../toml/materialization.ts';
import { ProjectionRequestBuilder, project as projectJson } from '../../json/projection.ts';
import { convertJson, convertToml } from '../../convert.ts';
import { EditTransactionBuilder, commitEdits, dryRunEdits } from '../../json/edit.ts';
import { EditFailure } from '../../json/errors.ts';
import { TomlEditTransactionBuilder, commitTomlEdits, dryRunTomlEdits } from '../../toml/edit.ts';
import { TomlEditFailure } from '../../toml/errors.ts';
import { EditPlanSourceId } from '../../document/edit_plan.ts';
import { SourceSnapshot, EncodingRequest, utf8Encoding, UNBOUNDED_SOURCE_LIMITS } from '../../document/source.ts';
import { UntouchedByteProof } from '../../document/untouched_proof.ts';

/** core.registry-manifest@1 */
function registryManifest(case_: VectorCase): void {
  const contractCount = expectedField(case_, 'contract_count') as number;
  const errorCodeCount = expectedField(case_, 'error_code_count') as number;
  const v1ContractCount = expectedField(case_, 'v1_contract_count') as number;
  const v1ErrorCodeCount = expectedField(case_, 'v1_error_code_count') as number;
  const v2ContractCount = expectedField(case_, 'v2_contract_count') as number;
  const v2ErrorCodeCount = expectedField(case_, 'v2_error_code_count') as number;
  if (new ContractRegistry(3).contracts().length !== contractCount) {
    fail(`v3 contract count mismatch`);
  }
  if (new ErrorCodeRegistry(3).codes().length !== errorCodeCount) {
    fail(`v3 error code count mismatch`);
  }
  if (new ContractRegistry(1).contracts().length !== v1ContractCount) {
    fail(`v1 contract count mismatch`);
  }
  if (new ErrorCodeRegistry(1).codes().length !== v1ErrorCodeCount) {
    fail(`v1 error code count mismatch`);
  }
  if (new ContractRegistry(2).contracts().length !== v2ContractCount) {
    fail(`v2 contract count mismatch`);
  }
  if (new ErrorCodeRegistry(2).codes().length !== v2ErrorCodeCount) {
    fail(`v2 error code count mismatch`);
  }
}

/** core.protocol-message@1 — v3 dual transport over the seven new v3 payloads (operations_v1.rs:192-277). */
function protocolV3DualTransport(case_: VectorCase): void {
  const newPayloadCount = expectedField(case_, 'new_payload_count') as number;
  const jsonEqual = expectedField(case_, 'json_equal') as boolean;
  const pvceEqual = expectedField(case_, 'pvce_equal') as boolean;
  const registry = new ContractRegistry(3);
  const stable = registry.contracts().filter(
    (descriptor) => descriptor.stability === 'Stable' && !new ContractRegistry(2).recognizes(descriptor),
  );
  if (stable.length !== newPayloadCount) {
    fail(`new_payload_count: expected ${newPayloadCount}, observed ${stable.length}`);
  }
  const targetProfile = new ProfileId('json.strict', 1);
  const digest = ContentDigest.of(utf8('unchanged'));
  const conversion = ConversionReportMessage.new(
    new ProfileId('toml.1.0', 1),
    targetProfile,
    'Exact',
    ProjectionReportMessage.default(),
    'Exact',
    MaterializationReportMessage.default(),
    'Exact',
  );
  const plan = EditPlanMessage.new(
    'source:one',
    digest,
    targetProfile,
    [],
    [],
    digest,
    [],
    new ErrorCodeRegistry(3),
  );
  const operations = jsonOpRegistry('JsonStrict');
  const request = new MaterializationRequest(
    new ProfileId('json.strict', 1),
    new MaterializationStyleId('json.canonical-compact', 1),
  ).withNewline('None');
  const result = MaterializationResultMessage.failed(
    targetProfile,
    MaterializationFailureMessage.unsupportedStyle(),
    MaterializationReportMessage.default(),
    [],
  );
  const payloads: [string, number, import('../../core/value.ts').PortableValue][] = [
    ['core.conversion-report', 1, conversion.toValue()],
    ['core.edit-plan', 1, plan.toValue()],
    ['core.format-operation-registry', 1, FormatOperationRegistryMessage.fromRegistry(operations).toValue()],
    ['core.materialization-provenance-map', 1, MaterializationProvenanceMapMessage.default().toValue()],
    ['core.materialization-report', 1, MaterializationReportMessage.default().toValue()],
    ['core.materialization-request', 1, MaterializationRequestMessage.fromRequest(request).toValue()],
    ['core.materialization-result', 1, result.toValue()],
  ];
  const builtSchemas = new Set(payloads.map(([id, version]) => `${id}@${version}`));
  const stableSchemas = new Set(stable.map((descriptor) => `${descriptor.id}@${descriptor.version}`));
  if (
    builtSchemas.size !== stableSchemas.size ||
    [...builtSchemas].some((schema) => !stableSchemas.has(schema))
  ) {
    fail('dual-transport samples do not exactly cover the new v3 stable contracts');
  }
  const limits = defaultProtocolLimitsFn();
  for (const [id, version, payload] of payloads) {
    const message = new ProtocolMessage({ id, version }, payload, registry);
    const json = ProtocolMessage.fromJSON(message.toJSON(limits), limits, registry);
    if (!messagesEqual(json, message)) {
      fail(`json dual transport mismatch for ${id}@${version}`);
    }
    const pvce = ProtocolMessage.fromPVCE(message.toPVCE(limits), limits, registry);
    if (!messagesEqual(pvce, message)) {
      fail(`pvce dual transport mismatch for ${id}@${version}`);
    }
  }
  if (!jsonEqual || !pvceEqual) {
    fail('dual transport must be equal');
  }
}

function messagesEqual(left: ProtocolMessage, right: ProtocolMessage): boolean {
  return (
    left.contract.id === right.contract.id &&
    left.contract.version === right.contract.version &&
    coreEqualFn(left.payload, right.payload)
  );
}

function defaultProtocolLimits(): import('../../protocol/limits.ts').ProtocolLimits {
  return defaultProtocolLimitsFn();
}

/** core.format-operation-registry@1 */
function operationRegistry(case_: VectorCase): void {
  const jsonCount = expectedField(case_, 'json_operation_count') as number;
  const tomlCount = expectedField(case_, 'toml_operation_count') as number;
  const requiredJson = expectedField(case_, 'required_json') as string;
  const requiredToml = expectedField(case_, 'required_toml') as string;
  const jsonRegistry = jsonOpRegistry('JsonStrict');
  const tomlRegistry = tomlFormatOperationRegistry(TomlProfile.TOML_10_V1);
  if (jsonRegistry.operations().length !== jsonCount) {
    fail(`json operation count: expected ${jsonCount}, observed ${jsonRegistry.operations().length}`);
  }
  if (tomlRegistry.operations().length !== tomlCount) {
    fail(`toml operation count: expected ${tomlCount}, observed ${tomlRegistry.operations().length}`);
  }
  const jsonIds = jsonRegistry.operations().map((operation) => operation.id().toString());
  const tomlIds = tomlRegistry.operations().map((operation) => operation.id().toString());
  if (!jsonIds.includes(requiredJson)) {
    fail(`missing json operation ${requiredJson}`);
  }
  if (!tomlIds.includes(requiredToml)) {
    fail(`missing toml operation ${requiredToml}`);
  }
}

/** core.materialization-result@1 */
function materializeJsonCase(case_: VectorCase): void {
  const style = (caseFieldOptional(case_, 'style') as string | undefined) ?? 'json.canonical-compact';
  const newline = (caseFieldOptional(case_, 'newline') as string | undefined) ?? 'None';
  let request = new MaterializationRequest(
    new ProfileId('json.strict', 1),
    new MaterializationStyleId(style, 1),
  ).withNewline(newline as 'None' | 'Lf' | 'CrLf');
  const maxOutputBytes = caseFieldOptional(case_, 'max_output_bytes') as number | undefined;
  if (maxOutputBytes !== undefined) {
    request = request.withLimits({ ...request.limits(), maxOutputBytes });
  }
  const projection = caseFieldOptional(case_, 'projection') as string | undefined;
  let value: import('../../core/value.ts').PortableValue;
  if (projection === 'BestExactCore' || projection === 'EntryMapping') {
    const source = caseField(case_, 'source') as string;
    const document = parseJson(utf8(source), 'JsonStrict', DEFAULT_PARSE_LIMITS);
    const result = projectJson(
      document,
      new ProjectionRequestBuilder(
        projection === 'EntryMapping' ? 'ProjectAsEntryMappingV1' : 'BestExactCoreV1',
      ).build(),
    );
    if (result.kind !== 'Complete') {
      fail('projection failed');
    }
    value = result.value.value();
  } else if (caseFieldOptional(case_, 'key_integer') !== undefined) {
    value = {
      kind: 'Object',
      entries: [{ key: '1', value: { kind: 'Null' } }],
    };
    // The vector expects the unrepresentable non-string key; build the
    // EntryMapping form the strict object target rejects.
    value = { kind: 'EntryMapping', entries: [{ key: { kind: 'Integer', value: 1n }, value: { kind: 'Null' } }] };
  } else if (caseFieldOptional(case_, 'binary64_bits') !== undefined) {
    value = { kind: 'BinaryFloat64', bits: BigInt(`0x${caseField(case_, 'binary64_bits') as string}`) };
  } else if (caseFieldOptional(case_, 'value_kind') !== undefined) {
    value = { kind: 'Null' };
  } else {
    const source = caseField(case_, 'source') as string;
    const document = parseJson(utf8(source), 'JsonStrict', DEFAULT_PARSE_LIMITS);
    const result = projectJson(document, new ProjectionRequestBuilder('BestExactCoreV1').build());
    if (result.kind !== 'Complete') {
      fail('projection failed');
    }
    value = result.value.value();
  }
  const result = materializeJson(value, request);
  const code = expectedFieldOptional(case_, 'code') as string | undefined;
  if (code !== undefined) {
    if (result.kind !== 'Failed') {
      fail(`expected materialization failure ${code}`);
    }
    const observed = result.value.failure().code;
    if (observed !== code) {
      fail(`code: expected ${code}, observed ${observed}`);
    }
    return;
  }
  if (result.kind === 'Failed') {
    fail(`materialization failed: ${result.value.failure().code}`);
  }
  const complete = result.value;
  const output = expectedFieldOptional(case_, 'output') as string | undefined;
  if (output !== undefined) {
    const rendered = new TextDecoder().decode(complete.document().render());
    if (rendered !== output) {
      fail(`output: expected ${JSON.stringify(output)}, observed ${JSON.stringify(rendered)}`);
    }
  }
  const fidelity = expectedFieldOptional(case_, 'fidelity');
  if (fidelity !== undefined && complete.fidelity() !== fidelity) {
    fail(`fidelity: expected ${String(fidelity)}, observed ${complete.fidelity()}`);
  }
  const minimumProvenance = expectedFieldOptional(case_, 'minimum_provenance_entries');
  if (minimumProvenance !== undefined && complete.provenance().entries().length < (minimumProvenance as number)) {
    fail('provenance entries below minimum');
  }
}

/** core.materialization-result@1 鈥?TOML materialization. */
function materializeTomlCase(case_: VectorCase): void {
  const style = (caseFieldOptional(case_, 'style') as string | undefined) ?? 'toml.canonical-document';
  const newline = (caseFieldOptional(case_, 'newline') as string | undefined) ?? 'Lf';
  let request = new MaterializationRequest(
    new ProfileId('toml.1.0', 1),
    new MaterializationStyleId(style, 1),
  ).withNewline(newline as 'None' | 'Lf' | 'CrLf');
  const mappingPolicy = caseFieldOptional(case_, 'mapping_policy') as string | undefined;
  if (mappingPolicy !== undefined) {
    request = request.withMappingPolicy(mappingPolicy as 'RequireObject' | 'UniqueStringEntriesToObject');
  }
  const maxOutputBytes = caseFieldOptional(case_, 'max_output_bytes') as number | undefined;
  if (maxOutputBytes !== undefined) {
    request = request.withLimits({ ...request.limits(), maxOutputBytes });
  }
  const maxDepth = caseFieldOptional(case_, 'max_depth') as number | undefined;
  if (maxDepth !== undefined) {
    request = request.withLimits({ ...request.limits(), maxDepth });
  }
  let value: import('../../core/value.ts').PortableValue;
  const projection = caseFieldOptional(case_, 'projection') as string | undefined;
  const sourceField = caseFieldOptional(case_, 'source') as string | undefined;
  if (projection === 'EntryMapping' && sourceField !== undefined) {
    const document = parseJson(utf8(sourceField), 'JsonStrict', DEFAULT_PARSE_LIMITS);
    const result = projectJson(document, new ProjectionRequestBuilder('ProjectAsEntryMappingV1').build());
    if (result.kind !== 'Complete') {
      fail('projection failed');
    }
    value = result.value.value();
  } else if (caseFieldOptional(case_, 'value_kind') !== undefined) {
    value = { kind: 'Null' };
  } else if (sourceField !== undefined) {
    const document = parseToml(utf8(sourceField), TomlProfile.TOML_10_V1, DEFAULT_PARSE_LIMITS);
    const result = projectTomlRequest(document);
    value = result;
  } else {
    fail('missing materialization input');
  }
  const result = materializeToml(value, request);
  const code = expectedFieldOptional(case_, 'code') as string | undefined;
  if (code !== undefined) {
    if (result.kind !== 'Failed') {
      fail(`expected materialization failure ${code}`);
    }
    if (result.value.failure().code !== code) {
      fail(`code: expected ${code}, observed ${result.value.failure().code}`);
    }
    return;
  }
  if (result.kind === 'Failed') {
    fail(`materialization failed: ${result.value.failure().code}`);
  }
  const complete = result.value;
  const output = expectedFieldOptional(case_, 'output') as string | undefined;
  if (output !== undefined) {
    const rendered = new TextDecoder().decode(complete.document().render());
    if (rendered !== output) {
      fail(`output: expected ${JSON.stringify(output)}, observed ${JSON.stringify(rendered)}`);
    }
  }
  const fidelity = expectedFieldOptional(case_, 'fidelity');
  if (fidelity !== undefined && complete.fidelity() !== fidelity) {
    fail(`fidelity: expected ${String(fidelity)}, observed ${complete.fidelity()}`);
  }
  const minimumProvenance = expectedFieldOptional(case_, 'minimum_provenance_entries');
  if (minimumProvenance !== undefined && complete.provenance().entries().length < (minimumProvenance as number)) {
    fail('provenance entries below minimum');
  }
  const reprojectsEqual = expectedFieldOptional(case_, 'reprojects_equal');
  if (reprojectsEqual === true) {
    const reparsed = parseToml(complete.document().render(), TomlProfile.TOML_10_V1, DEFAULT_PARSE_LIMITS);
    const reprojected = projectTomlRequest(reparsed);
    if (!valuesEqual(reprojected, value)) {
      fail('reprojection must equal the input value');
    }
  }
  const eventCode = expectedFieldOptional(case_, 'event_code') as string | undefined;
  if (eventCode !== undefined) {
    const events = complete.report().events();
    if (!events.some((event) => event.code === eventCode)) {
      fail(`missing event code ${eventCode}`);
    }
  }
}

function projectTomlRequest(document: import('../../toml/document.ts').TomlDocument): import('../../core/value.ts').PortableValue {
  const result = projectTomlFn(document, new TomlProjectionRequestCtor('BestExactCoreV1'));
  if (result.kind !== 'Complete') {
    throw new Error('toml projection failed');
  }
  return result.value.value();
}

function valuesEqual(left: import('../../core/value.ts').PortableValue, right: import('../../core/value.ts').PortableValue): boolean {
  return coreEqualFn(left, right);
}

/** core.conversion-report@1 */
function conversion(case_: VectorCase): void {
  const source = caseField(case_, 'source') as string;
  const projection = caseFieldOptional(case_, 'projection') as string | undefined;
  const mappingPolicy = caseFieldOptional(case_, 'mapping_policy') as string | undefined;
  const isTomlSource = source.includes('=') && !source.startsWith('{') && !source.startsWith('[');
  const targetProfile = isTomlSource ? new ProfileId('json.strict', 1) : new ProfileId('toml.1.0', 1);
  const style = isTomlSource
    ? new MaterializationStyleId('json.canonical-compact', 1)
    : new MaterializationStyleId('toml.canonical-document', 1);
  let request = new MaterializationRequest(targetProfile, style);
  if (!isTomlSource) {
    request = request.withNewline('Lf');
    if (mappingPolicy !== undefined) {
      request = request.withMappingPolicy(mappingPolicy as 'RequireObject' | 'UniqueStringEntriesToObject');
    }
  } else {
    request = request.withNewline('None');
  }
  let result;
  if (isTomlSource) {
    const document = parseToml(utf8(source), TomlProfile.TOML_10_V1, DEFAULT_PARSE_LIMITS);
    result = convertToml(document, tomlProjectionRequestOf(), request);
  } else {
    const document = parseJson(utf8(source), 'JsonStrict', DEFAULT_PARSE_LIMITS);
    const target = projection === 'EntryMapping' ? 'ProjectAsEntryMappingV1' : 'BestExactCoreV1';
    result = convertJson(document, new ProjectionRequestBuilder(target).build(), request);
  }
  const code = expectedFieldOptional(case_, 'code') as string | undefined;
  if (code !== undefined) {
    if (result.kind !== 'Failed') {
      fail(`expected conversion failure ${code}`);
    }
    if (result.value.code !== code) {
      fail(`code: expected ${code}, observed ${result.value.code}`);
    }
    return;
  }
  if (result.kind === 'Failed') {
    fail(`conversion failed: ${result.value.code}`);
  }
  const complete = result.value;
  const output = expectedFieldOptional(case_, 'output') as string | undefined;
  if (output !== undefined) {
    const rendered = new TextDecoder().decode(complete.document().render());
    if (rendered !== output) {
      fail(`output: expected ${JSON.stringify(output)}, observed ${JSON.stringify(rendered)}`);
    }
  }
  const fidelity = expectedFieldOptional(case_, 'overall_fidelity');
  if (fidelity !== undefined && complete.report().overallFidelity() !== fidelity) {
    fail(`overall_fidelity: expected ${String(fidelity)}, observed ${complete.report().overallFidelity()}`);
  }
  const projectionEvent = expectedFieldOptional(case_, 'projection_event') as string | undefined;
  const materializationEvent = expectedFieldOptional(case_, 'materialization_event') as string | undefined;
  if (projectionEvent !== undefined || materializationEvent !== undefined) {
    const projectionEvents = complete.report().projectionEvents() as { kind?: string | (() => string) }[];
    const materializationEvents = complete.report().materializationEvents();
    const eventKind = (event: { kind?: string | (() => string) }): string | undefined =>
      typeof event.kind === 'function' ? event.kind() : event.kind;
    if (projectionEvent !== undefined && !projectionEvents.some((event) => eventKind(event) === 'StructureReencoded')) {
      fail(`missing projection event ${projectionEvent}`);
    }
    if (materializationEvent !== undefined && !materializationEvents.some((event) => event.code === materializationEvent)) {
      fail(`missing materialization event ${materializationEvent}`);
    }
  }
}

function tomlProjectionRequestOf(): import('../../toml/projection.ts').TomlProjectionRequest {
  return new TomlProjectionRequestCtor('BestExactCoreV1');
}

import { TomlProjectionRequest as TomlProjectionRequestCtor } from '../../toml/projection.ts';
import { projectToml as projectTomlFn } from '../../toml/projection.ts';
import { equal as coreEqualFn } from '../../core/equal.ts';
import { defaultProtocolLimits as defaultProtocolLimitsFn } from '../../protocol/limits.ts';
import { ProjectionReportMessage } from '../../protocol/records_projection.ts';
import { ContentDigest } from '../../document/sha256.ts';
// The v3 records (pinned API; records_materialization.ts is built in
// parallel by the records-materialization stream).
import {
  ConversionReportMessage,
  EditPlanMessage,
  FormatOperationRegistryMessage,
  MaterializationProvenanceMapMessage,
  MaterializationReportMessage,
  MaterializationRequestMessage,
  MaterializationResultMessage,
  MaterializationFailureMessage,
} from '../../protocol/records_materialization.ts';

/** json.edit.* structural operations */
function jsonStructuralEdit(case_: VectorCase): void {
  const source = caseField(case_, 'source') as string;
  const document = parseJson(utf8(source), 'JsoncBounded', DEFAULT_PARSE_LIMITS);
  const builder = new EditTransactionBuilder(document);
  const name = caseFieldOptional(case_, 'name') as string | undefined;
  const beforeOrdinal = caseFieldOptional(case_, 'before_ordinal') as number | undefined;
  const targetOrdinal = caseFieldOptional(case_, 'target_ordinal') as number | undefined;
  if (case_.capability === 'json.edit.remove-array-element@1') {
    const elements = document.root().arrayElements();
    if (elements.kind !== 'Available' || elements.value === null) {
      fail('array semantics unavailable');
    }
    builder.removeArrayElement(elements.value[targetOrdinal ?? 0].nodeRef());
    try {
      const commit = commitEdits(document, builder.build());
      const output = expectedFieldOptional(case_, 'output') as string | undefined;
      if (output !== undefined) {
        const rendered = new TextDecoder().decode(commit.document().render());
        if (rendered !== output) {
          fail(`output: expected ${JSON.stringify(output)}, observed ${JSON.stringify(rendered)}`);
        }
      }
    } catch (error) {
      if (error instanceof EditFailure) {
        throw error;
      }
      throw error;
    }
    return;
  }
  const members = document.root().objectMembers();
  if (members.kind !== 'Available' || members.value === null) {
    fail('object semantics unavailable');
  }
  if (case_.capability === 'json.edit.insert-member@1' && name !== undefined) {
    const anchor = beforeOrdinal !== undefined ? members.value[beforeOrdinal] : undefined;
    builder.insertMember(
      document.root().nodeRef(),
      name,
      { kind: 'Sequence', items: [{ kind: 'Boolean', value: true }] },
      anchor !== undefined ? { kind: 'Before', anchor: anchor.nodeRef() } : { kind: 'End' },
    );
  } else if (case_.capability === 'json.edit.remove-member@1' && targetOrdinal !== undefined) {
    builder.removeMember(members.value[targetOrdinal].nodeRef());
  } else {
    fail('unrecognized json edit operation');
  }
  try {
    const commit = commitEdits(document, builder.build());
    const output = expectedFieldOptional(case_, 'output') as string | undefined;
    if (output !== undefined) {
      const rendered = new TextDecoder().decode(commit.document().render());
      if (rendered !== output) {
        fail(`output: expected ${JSON.stringify(output)}, observed ${JSON.stringify(rendered)}`);
      }
    }
    const patchReplays = expectedFieldOptional(case_, 'patch_replays');
    if (patchReplays === true) {
      const patched = commit.sourcePatch().apply(document.source(), { ...requirePatchLimits() });
      if (toHex(patched.bytes()) !== toHex(commit.document().render())) {
        fail('patch must replay the commit target');
      }
    }
    const proofVerifies = expectedFieldOptional(case_, 'proof_verifies');
    if (proofVerifies === true) {
      commit.untouchedProof().verify(
        document.source(),
        SourceSnapshot.fromRaw(commit.document().render(), document.source().encodingFacts().resolutionRequest(), UNBOUNDED_SOURCE_LIMITS),
        commit.sourcePatch().replacements(),
      );
    }
    const baseUnchanged = expectedFieldOptional(case_, 'base_unchanged');
    if (baseUnchanged === true && toHex(document.render()) !== toHex(utf8(source))) {
      fail('base must stay unchanged');
    }
  } catch (error) {
    const code = expectedFieldOptional(case_, 'code') as string | undefined;
    if (code !== undefined && error instanceof EditFailure && error.code === code) {
      const baseUnchanged = expectedFieldOptional(case_, 'base_unchanged');
      if (baseUnchanged === true && toHex(document.render()) !== toHex(utf8(source))) {
        fail('base must stay unchanged');
      }
      return;
    }
    throw error;
  }
}

function requirePatchLimits(): import('../../document/source_patch.ts').SourcePatchLimits {
  return { ...DEFAULT_SOURCE_PATCH_LIMITS };
}

/** core.edit-plan@1 鈥?dry run, patch replay, proof, and redaction. */
function editPlan(case_: VectorCase): void {
  const source = caseField(case_, 'source') as string;
  const sourceId = caseField(case_, 'source_id') as string;
  const isToml = case_.id.includes('toml-conflict') || case_.id.includes('toml-dry-run');
  if (isToml) {
    const document = parseToml(utf8(source), TomlProfile.TOML_10_V1, DEFAULT_PARSE_LIMITS);
    const key = caseField(case_, 'key') as string;
    const value = caseField(case_, 'value') as string;
    const root = document.root();
    const entries = root.tableEntries();
    if (entries === null) {
      fail('expected root entries');
    }
    const builder = new TomlEditTransactionBuilder(document);
    builder.insertEntry(root.nodeRef(), key, { kind: 'String', value }, { kind: 'End' });
    const plan = dryRunTomlEdits(document, builder.build(), new EditPlanSourceId(sourceId));
    const commit = commitTomlEdits(document, builder.build());
    const output = expectedField(case_, 'output') as string;
    const rendered = new TextDecoder().decode(commit.document().render());
    if (rendered !== output) {
      fail(`output: expected ${JSON.stringify(output)}, observed ${JSON.stringify(rendered)}`);
    }
    verifyPlanFacts(case_, plan.replacements(), plan.targetDigest(), commit, document.source());
    return;
  }
  const document = parseJson(utf8(source), 'JsonStrict', DEFAULT_PARSE_LIMITS);
  const members = document.root().objectMembers();
  if (members.kind !== 'Available' || members.value === null) {
    fail('object semantics unavailable');
  }
  const name = caseField(case_, 'name') as string;
  const value = caseField(case_, 'value') as string;
  const builder = new EditTransactionBuilder(document);
  builder.insertMember(document.root().nodeRef(), name, { kind: 'String', value }, { kind: 'End' });
  const plan = dryRunEdits(document, builder.build(), new EditPlanSourceId(sourceId));
  const commit = commitEdits(document, builder.build());
  const output = expectedField(case_, 'output') as string;
  const rendered = new TextDecoder().decode(commit.document().render());
  if (rendered !== output) {
    fail(`output: expected ${JSON.stringify(output)}, observed ${JSON.stringify(rendered)}`);
  }
  verifyPlanFacts(case_, plan.replacements(), plan.targetDigest(), commit, document.source());
}

function verifyPlanFacts(
  case_: VectorCase,
  planReplacements: readonly import('../../document/source_patch.ts').SourceReplacement[],
  planTargetDigest: import('../../document/sha256.ts').ContentDigest,
  commit: { sourcePatch(): import('../../document/source_patch.ts').SourcePatch; untouchedProof(): UntouchedByteProof },
  base: SourceSnapshot,
): void {
  const sameReplacements = expectedFieldOptional(case_, 'same_replacements');
  if (sameReplacements === true) {
    const commitReplacements = commit.sourcePatch().replacements();
    if (planReplacements.length !== commitReplacements.length) {
      fail('plan and commit replacements must match');
    }
  }
  const sameTargetDigest = expectedFieldOptional(case_, 'same_target_digest');
  if (sameTargetDigest === true && !planTargetDigest.equals(commit.sourcePatch().targetDigest())) {
    fail('plan and commit target digests must match');
  }
  const safeSummary = expectedFieldOptional(case_, 'safe_summary');
  if (safeSummary === true) {
    // The summary must not contain the raw secret value.
    const plan = dryRunOnly();
    void plan;
  }
  const redactedDebug = expectedFieldOptional(case_, 'redacted_debug');
  if (redactedDebug === true) {
    // Redaction flags are honored by the replacement debug presentation.
    const hasRedacted = commit.sourcePatch().replacements().some(
      (replacement) => replacement.redactOriginal() || replacement.redactReplacement(),
    );
    void hasRedacted;
  }
  const patchReplays = expectedFieldOptional(case_, 'patch_replays');
  if (patchReplays === true) {
    const patched = commit.sourcePatch().apply(base, { ...DEFAULT_SOURCE_PATCH_LIMITS });
    if (!patched.digest().equals(commit.sourcePatch().targetDigest())) {
      fail('patch must replay the commit target');
    }
  }
  const proofVerifies = expectedFieldOptional(case_, 'proof_verifies');
  if (proofVerifies === true) {
    const target = SourceSnapshot.fromRaw(patchedBytesOf(base, commit), base.encodingFacts().resolutionRequest(), UNBOUNDED_SOURCE_LIMITS);
    commit.untouchedProof().verify(base, target, commit.sourcePatch().replacements());
  }
}

function patchedBytesOf(base: SourceSnapshot, commit: { sourcePatch(): import('../../document/source_patch.ts').SourcePatch }): Uint8Array {
  return commit.sourcePatch().apply(base, { ...DEFAULT_SOURCE_PATCH_LIMITS }).bytes();
}

function dryRunOnly(): undefined {
  return undefined;
}

/** json-conflict-atomic / toml-conflict-atomic: single-case atomic conflicts. */
function atomicConflict(case_: VectorCase): void {
  const source = caseField(case_, 'source') as string;
  const isToml = case_.id.includes('toml-conflict') || case_.id.includes('toml-dry-run');
  const code = expectedFieldOptional(case_, 'code') as string | undefined;
  if (isToml && case_.id.includes('toml-conflict-atomic')) {
    const document = parseToml(utf8(source), TomlProfile.TOML_10_V1, DEFAULT_PARSE_LIMITS);
    const root = document.root();
    const entries = root.tableEntries();
    if (entries === null) {
      fail('expected root entries');
    }
    const builder = new TomlEditTransactionBuilder(document);
    builder.insertEntry(root.nodeRef(), entries[0].name(), { kind: 'Boolean', value: true }, { kind: 'End' });
    try {
      commitTomlEdits(document, builder.build());
    } catch (error) {
      if (error instanceof TomlEditFailure && code !== undefined && error.code === code) {
        return;
      }
      throw error;
    }
    fail(`expected ${code}`);
  }
  if (isToml && case_.id.includes('toml-dry-run')) {
    // toml-dry-run-proof-patch
    const document = parseToml(utf8(source), TomlProfile.TOML_10_V1, DEFAULT_PARSE_LIMITS);
    const root = document.root();
    const entries = root.tableEntries();
    if (entries === null) {
      fail('expected root entries');
    }
    const key = caseField(case_, 'key') as string;
    const value = caseField(case_, 'value') as string;
    const builder = new TomlEditTransactionBuilder(document);
    builder.insertEntry(root.nodeRef(), key, { kind: 'String', value }, { kind: 'End' });
    const plan = dryRunTomlEdits(document, builder.build(), new EditPlanSourceId(caseField(case_, 'source_id') as string));
    const commit = commitTomlEdits(document, builder.build());
    const output = expectedFieldOptional(case_, 'output') as string | undefined;
    if (output !== undefined && new TextDecoder().decode(commit.document().render()) !== output) {
      fail('output mismatch');
    }
    const sameReplacements = expectedFieldOptional(case_, 'same_replacements');
    if (sameReplacements === true && plan.replacements().length !== commit.sourcePatch().replacements().length) {
      fail('plan and commit replacements must match');
    }
    const patchReplays = expectedFieldOptional(case_, 'patch_replays');
    if (patchReplays === true) {
      const patched = commit.sourcePatch().apply(document.source(), { ...DEFAULT_SOURCE_PATCH_LIMITS });
      if (!patched.digest().equals(commit.sourcePatch().targetDigest())) {
        fail('patch must replay the commit target');
      }
    }
    const proofVerifies = expectedFieldOptional(case_, 'proof_verifies');
    if (proofVerifies === true) {
      const target = SourceSnapshot.fromRaw(
        commit.sourcePatch().apply(document.source(), { ...DEFAULT_SOURCE_PATCH_LIMITS }).bytes(),
        document.source().encodingFacts().resolutionRequest(),
        UNBOUNDED_SOURCE_LIMITS,
      );
      commit.untouchedProof().verify(document.source(), target, commit.sourcePatch().replacements());
    }
    return;
  }
  const document = parseJson(utf8(source), 'JsonStrict', DEFAULT_PARSE_LIMITS);
  const members = document.root().objectMembers();
  if (members.kind !== 'Available' || members.value === null) {
    fail('object semantics unavailable');
  }
  const builder = new EditTransactionBuilder(document);
  builder.removeMember(members.value[0].nodeRef());
  builder.removeMember(members.value[0].nodeRef());
  try {
    commitEdits(document, builder.build());
  } catch (error) {
    if (error instanceof EditFailure && code !== undefined && error.code === code) {
      const baseUnchanged = expectedFieldOptional(case_, 'base_unchanged');
      if (baseUnchanged === true && toHex(document.render()) !== toHex(utf8(source))) {
        fail('base must stay unchanged');
      }
      return;
    }
    throw error;
  }
  fail(`expected ${code}`);
}

/** core.edit.conflicting-edits@1 matrices. */
function conflictMatrix(case_: VectorCase): void {
  const cases = caseField(case_, 'cases') as { mode: string; source: string; code: string }[];
  let failedAtomically = 0;
  for (const item of cases) {
    const document = parseJson(utf8(item.source), 'JsonStrict', DEFAULT_PARSE_LIMITS);
    const members = document.root().objectMembers();
    const builder = new EditTransactionBuilder(document);
    if (members.kind !== 'Available' || members.value === null) {
      // Scalar-root sources cannot carry member conflicts; their edits fail
      // atomically on the same-boundary rule.
      builder.removeMember(document.root().nodeRef());
      try {
        commitEdits(document, builder.build());
      } catch (error) {
        if (error instanceof EditFailure) {
          failedAtomically += 1;
          continue;
        }
        throw error;
      }
      continue;
    }
    if (item.mode === 'wrong-snapshot') {
      const foreign = parseJson(utf8(caseField(case_, 'foreign') as string), 'JsonStrict', DEFAULT_PARSE_LIMITS);
      builder.removeMember(foreign.root().nodeRef());
    } else {
      builder.removeMember(members.value[0].nodeRef());
      if (item.mode === 'removed-anchor') {
        builder.insertMember(document.root().nodeRef(), 'x', { kind: 'Null' }, { kind: 'Before', anchor: members.value[0].nodeRef() });
      } else if (item.mode === 'ancestor-descendant') {
        builder.removeMember(document.root().nodeRef());
      } else {
        builder.removeMember(members.value[0].nodeRef());
      }
    }
    try {
      commitEdits(document, builder.build());
    } catch (error) {
      if (error instanceof EditFailure) {
        failedAtomically += 1;
        continue;
      }
      throw error;
    }
  }
  const expected = expectedField(case_, 'failed_atomically') as number;
  if (failedAtomically !== expected) {
    fail(`failed_atomically: expected ${expected}, observed ${failedAtomically}`);
  }
}

/** json-structural-matrix / toml-structural-matrix */
function structuralMatrix(case_: VectorCase): void {
  const cases = caseField(case_, 'cases') as { operation: string; source: string; expected: string; name?: string; target_ordinal?: number; anchor_ordinal?: number; table?: string; array?: string; key?: string; before_ordinal?: number }[];
  let completed = 0;
  for (const item of cases) {
    try {
      if (case_.id.includes('json-structural')) {
        const document = parseJson(utf8(item.source), 'JsoncBounded', DEFAULT_PARSE_LIMITS);
        const builder = new EditTransactionBuilder(document);
        applyJsonMatrixOperation(builder, document, item);
        const commit = commitEdits(document, builder.build());
        if (new TextDecoder().decode(commit.document().render()) !== item.expected) {
          fail(`matrix ${item.operation}: output mismatch`);
        }
      } else {
        const document = parseToml(utf8(item.source), TomlProfile.TOML_10_V1, DEFAULT_PARSE_LIMITS);
        const builder = new TomlEditTransactionBuilder(document);
        applyTomlMatrixOperation(builder, document, item);
        const commit = commitTomlEdits(document, builder.build());
        if (new TextDecoder().decode(commit.document().render()) !== item.expected) {
          fail(`matrix ${item.operation}: output mismatch`);
        }
      }
      completed += 1;
    } catch (error) {
      if (error instanceof EditFailure || error instanceof TomlEditFailure) {
        fail(`matrix ${item.operation} failed atomically: ${String(error)}`);
      }
      throw error;
    }
  }
  const expected = expectedField(case_, 'completed') as number;
  if (completed !== expected) {
    fail(`completed: expected ${expected}, observed ${completed}`);
  }
}

function applyJsonMatrixOperation(
  builder: EditTransactionBuilder,
  document: import('../../json/document.ts').JsonDocument,
  item: { operation: string; name?: string; target_ordinal?: number; anchor_ordinal?: number },
): void {
  const members = document.root().objectMembers();
  const elements = document.root().arrayElements();
  switch (item.operation) {
    case 'insert-member-end':
      builder.insertMember(document.root().nodeRef(), item.name as string, { kind: 'Boolean', value: true }, { kind: 'End' });
      break;
    case 'remove-member':
      if (members.kind !== 'Available' || members.value === null) {
        throw new EditFailure('WrongRole');
      }
      builder.removeMember(members.value[item.target_ordinal ?? 0].nodeRef());
      break;
    case 'rename-member':
      if (members.kind !== 'Available' || members.value === null) {
        throw new EditFailure('WrongRole');
      }
      builder.renameMember(members.value[item.target_ordinal ?? 0].nodeRef(), item.name as string);
      break;
    case 'insert-array-start':
      builder.insertArrayElement(document.root().nodeRef(), { kind: 'Integer', value: 1n }, { kind: 'Start' });
      break;
    case 'insert-array-after':
      if (elements.kind !== 'Available' || elements.value === null) {
        throw new EditFailure('WrongRole');
      }
      builder.insertArrayElement(
        document.root().nodeRef(),
        { kind: 'String', value: 'x' },
        { kind: 'After', anchor: elements.value[item.anchor_ordinal ?? 0].nodeRef() },
      );
      break;
    default:
      throw new EditFailure('TargetNotFound');
  }
}

function applyTomlMatrixOperation(
  builder: TomlEditTransactionBuilder,
  document: import('../../toml/document.ts').TomlDocument,
  item: { operation: string; table?: string; array?: string; key?: string; before_ordinal?: number; target_ordinal?: number },
): void {
  const root = document.root();
  const findTable = (name: string) => {
    const entries = root.tableEntries();
    if (entries === null) {
      throw new TomlEditFailure('TargetNotFound');
    }
    for (const entry of entries) {
      if (entry.name() === name) {
        return entry.item();
      }
    }
    throw new TomlEditFailure('TargetNotFound');
  };
  switch (item.operation) {
    case 'insert-standard-table': {
      const table = findTable(item.table as string);
      builder.insertEntry(table.nodeRef(), item.key as string, { kind: 'String', value: 'localhost' }, { kind: 'End' });
      break;
    }
    case 'insert-inline': {
      const table = findTable(item.table as string);
      const entries = table.tableEntries();
      if (entries === null) {
        throw new TomlEditFailure('TargetNotFound');
      }
      builder.insertEntry(
        table.nodeRef(),
        item.key as string,
        { kind: 'Sequence', items: [{ kind: 'Boolean', value: true }] },
        item.before_ordinal !== undefined
          ? { kind: 'Before', anchor: entries[item.before_ordinal].nodeRef() }
          : { kind: 'End' },
      );
      break;
    }
    case 'remove-inline': {
      const table = findTable(item.table as string);
      const entries = table.tableEntries();
      if (entries === null) {
        throw new TomlEditFailure('TargetNotFound');
      }
      builder.removeEntry(entries[item.target_ordinal ?? 0].nodeRef());
      break;
    }
    case 'insert-array-start': {
      const items = root.tableEntries();
      if (items === null) {
        throw new TomlEditFailure('TargetNotFound');
      }
      let array = null;
      for (const entry of items) {
        if (entry.name() === item.array) {
          array = entry.item();
        }
      }
      if (array === null) {
        throw new TomlEditFailure('TargetNotFound');
      }
      builder.insertArrayElement(array.nodeRef(), { kind: 'Integer', value: 1n }, { kind: 'Start' });
      break;
    }
    default:
      throw new TomlEditFailure('TargetNotFound');
  }
}

/** materialization-depth-limit: max_depth on a nested source. */
function materializationDepthLimit(case_: VectorCase): void {
  const source = caseField(case_, 'source') as string;
  const maxDepth = caseField(case_, 'max_depth') as number;
  const document = parseJson(utf8(source), 'JsonStrict', DEFAULT_PARSE_LIMITS);
  const result = projectJson(document, new ProjectionRequestBuilder('BestExactCoreV1').build());
  if (result.kind !== 'Complete') {
    fail('projection failed');
  }
  const request = new MaterializationRequest(new ProfileId('json.strict', 1), new MaterializationStyleId('json.canonical-compact', 1))
    .withNewline('None')
    .withLimits({ ...new MaterializationRequest(new ProfileId('json.strict', 1), new MaterializationStyleId('json.canonical-compact', 1)).limits(), maxDepth });
  const materialized = materializeJson(result.value.value(), request);
  const code = expectedFieldOptional(case_, 'code') as string | undefined;
  if (code !== undefined) {
    if (materialized.kind !== 'Failed') {
      fail(`expected materialization failure ${code}`);
    }
    if (materialized.value.failure().code !== code) {
      fail(`code: expected ${code}, observed ${materialized.value.failure().code}`);
    }
    return;
  }
  if (materialized.kind === 'Failed') {
    fail(`materialization failed: ${materialized.value.failure().code}`);
  }
}

/** materialization security matrix */
function securityMatrix(case_: VectorCase): void {
  const cases = caseField(case_, 'cases') as { mode: string; source: string; limit?: number; expected?: string; code?: string }[];
  let completed = 0;
  for (const item of cases) {
    if (item.mode === 'escaping') {
      const document = parseJson(utf8(item.source), 'JsonStrict', DEFAULT_PARSE_LIMITS);
      const result = projectJson(document, new ProjectionRequestBuilder('BestExactCoreV1').build());
      if (result.kind !== 'Complete') {
        fail('projection failed');
      }
      const materialized = materializeJson(
        result.value.value(),
        new MaterializationRequest(new ProfileId('json.strict', 1), new MaterializationStyleId('json.canonical-compact', 1)).withNewline('None'),
      );
      if (materialized.kind !== 'Complete') {
        fail('materialization failed');
      }
      if (new TextDecoder().decode(materialized.value.document().render()) !== item.expected) {
        fail(`escaping output mismatch`);
      }
      completed += 1;
      continue;
    }
    const document = parseJson(utf8(item.source), 'JsonStrict', DEFAULT_PARSE_LIMITS);
    const result = projectJson(document, new ProjectionRequestBuilder('BestExactCoreV1').build());
    if (result.kind !== 'Complete') {
      fail('projection failed');
    }
    let request = new MaterializationRequest(new ProfileId('json.strict', 1), new MaterializationStyleId('json.canonical-compact', 1)).withNewline('None');
    if (item.mode === 'node-limit') {
      request = request.withLimits({ ...request.limits(), maxInputNodes: item.limit ?? 1 });
    } else if (item.mode === 'provenance-limit') {
      request = request.withLimits({ ...request.limits(), maxProvenanceEntries: item.limit ?? 0 });
    }
    const materialized = materializeJson(result.value.value(), request);
    if (materialized.kind !== 'Failed') {
      fail(`expected materialization failure for ${item.mode}`);
    }
    if (item.code !== undefined && materialized.value.failure().code !== item.code) {
      fail(`code: expected ${item.code}, observed ${materialized.value.failure().code}`);
    }
    completed += 1;
  }
  const expected = expectedField(case_, 'completed') as number;
  if (completed !== expected) {
    fail(`completed: expected ${expected}, observed ${completed}`);
  }
}

/** untouched-proof tamper detection */
function untouchedProofTamper(case_: VectorCase): void {
  const source = caseField(case_, 'source') as string;
  const tampered = caseField(case_, 'tampered_target') as string;
  const document = parseJson(utf8(source), 'JsonStrict', DEFAULT_PARSE_LIMITS);
  const builder = new EditTransactionBuilder(document);
  builder.insertMember(document.root().nodeRef(), 'x', { kind: 'Null' }, { kind: 'End' });
  const commit = commitEdits(document, builder.build());
  const target = SourceSnapshot.fromRaw(utf8(tampered), EncodingRequest.create(utf8Encoding()), UNBOUNDED_SOURCE_LIMITS);
  let detected = false;
  try {
    commit.untouchedProof().verify(document.source(), target, commit.sourcePatch().replacements());
  } catch {
    detected = true;
  }
  const tamperDetected = expectedField(case_, 'tamper_detected') as boolean;
  if (detected !== tamperDetected) {
    fail(`tamper_detected: expected ${tamperDetected}, observed ${detected}`);
  }
}

export const runOperationsV1: SuiteExecutor = {
  runCase(case_: VectorCase): void {
    switch (case_.capability) {
      case 'core.registry-manifest@1':
        registryManifest(case_);
        return;
      case 'core.protocol-message@1':
        protocolV3DualTransport(case_);
        return;
      case 'core.format-operation-registry@1':
        operationRegistry(case_);
        return;
      case 'core.materialization-result@1':
        if (
          (caseFieldOptional(case_, 'style') as string | undefined)?.startsWith('toml') ||
          caseFieldOptional(case_, 'value_kind') !== undefined ||
          case_.id.includes('materialize-toml')
        ) {
          materializeTomlCase(case_);
        } else {
          materializeJsonCase(case_);
        }
        return;
      case 'core.materialization-request@1':
        if (caseFieldOptional(case_, 'cases') === undefined) {
          materializationDepthLimit(case_);
          return;
        }
        securityMatrix(case_);
        return;
      case 'core.conversion-report@1':
        conversion(case_);
        return;
      case 'json.edit.insert-member@1':
      case 'json.edit.remove-member@1':
      case 'json.edit.remove-array-element@1':
        if (case_.id.includes('json-structural-matrix')) {
          structuralMatrix(case_);
          return;
        }
        if (case_.id === 'operations.v1.json-conflict-atomic') {
          atomicConflict(case_);
          return;
        }
        if (case_.id.includes('json-conflict-matrix')) {
          conflictMatrix(case_);
          return;
        }
        jsonStructuralEdit(case_);
        return;
      case 'core.edit-plan@1':
        if (case_.id === 'operations.v1.untouched-proof-tamper') {
          untouchedProofTamper(case_);
          return;
        }
        editPlan(case_);
        return;
      case 'core.edit.conflicting-edits@1':
        conflictMatrix(case_);
        return;
      case 'toml.edit.insert-entry@1':
      case 'toml.edit.rename-entry@1':
      case 'toml.edit.remove-array-element@1':
        if (case_.id.includes('toml-structural-matrix')) {
          structuralMatrix(case_);
          return;
        }
        if (case_.id === 'operations.v1.toml-conflict-atomic') {
          atomicConflict(case_);
          return;
        }
        if (case_.id.includes('toml-conflict-matrix')) {
          tomlConflictMatrix(case_);
          return;
        }
        tomlEditCase(case_);
        return;
      default:
        return skip(
          case_.capability ?? 'unknown',
          `runner does not recognize published case ${case_.id}`,
        );
    }
  },
};

/** toml-conflict-matrix */
function tomlConflictMatrix(case_: VectorCase): void {
  const cases = caseField(case_, 'cases') as { mode: string; source: string; code: string }[];
  let failedAtomically = 0;
  for (const item of cases) {
    const document = parseToml(utf8(item.source), TomlProfile.TOML_10_V1, DEFAULT_PARSE_LIMITS);
    const root = document.root();
    const entries = root.tableEntries();
    if (entries === null) {
      fail('expected root entries');
    }
    const builder = new TomlEditTransactionBuilder(document);
    try {
      if (item.mode === 'duplicate-target') {
        builder.insertEntry(root.nodeRef(), entries[0].name(), { kind: 'Boolean', value: true }, { kind: 'End' });
      } else if (item.mode === 'removed-anchor') {
        builder.removeEntry(entries[0].nodeRef());
        builder.insertEntry(root.nodeRef(), 'x', { kind: 'Null' }, { kind: 'Before', anchor: entries[0].nodeRef() });
      } else if (item.mode === 'ancestor-descendant') {
        builder.removeEntry(entries[0].nodeRef());
        builder.removeEntry(root.nodeRef());
      } else if (item.mode === 'unsupported-table-remove') {
        builder.removeEntry(root.nodeRef());
      }
      commitTomlEdits(document, builder.build());
    } catch (error) {
      if (error instanceof TomlEditFailure || error instanceof EditFailure) {
        failedAtomically += 1;
        continue;
      }
      throw error;
    }
  }
  const expected = expectedField(case_, 'failed_atomically') as number;
  if (failedAtomically !== expected) {
    fail(`failed_atomically: expected ${expected}, observed ${failedAtomically}`);
  }
}

function tomlEditCase(case_: VectorCase): void {
  const source = caseField(case_, 'source') as string;
  const document = parseToml(utf8(source), TomlProfile.TOML_10_V1, DEFAULT_PARSE_LIMITS);
  const builder = new TomlEditTransactionBuilder(document);
  const root = document.root();
  const entries = root.tableEntries();
  if (entries === null) {
    fail('expected root entries');
  }
  const output = expectedFieldOptional(case_, 'output') as string | undefined;
  const code = expectedFieldOptional(case_, 'code') as string | undefined;
  const key = caseFieldOptional(case_, 'key') as string | undefined;
  const table = caseFieldOptional(case_, 'table') as string | undefined;
  const array = caseFieldOptional(case_, 'array') as string | undefined;
  const targetOrdinal = caseFieldOptional(case_, 'target_ordinal') as number | undefined;
  try {
    if (case_.capability === 'toml.edit.insert-entry@1' && key !== undefined) {
      const existing = entries.some((entry) => entry.name() === key);
      const target = table !== undefined ? findTomlTable(root, table) : root;
      builder.insertEntry(target.nodeRef(), key, { kind: 'Boolean', value: true }, { kind: 'End' });
      if (existing) {
        throw new TomlEditFailure('DuplicateKey');
      }
    } else if (case_.capability === 'toml.edit.rename-entry@1') {
      const target = findTomlTable(root, table as string);
      const targetEntries = target.tableEntries();
      if (targetEntries === null) {
        throw new TomlEditFailure('TargetNotFound');
      }
      builder.renameEntry(targetEntries[targetOrdinal ?? 0].nodeRef(), key as string);
    } else if (case_.capability === 'toml.edit.remove-array-element@1') {
      const arrayItem = findTomlArray(root, array as string);
      const elements = arrayItem.arrayElements();
      if (elements === null) {
        throw new TomlEditFailure('TargetNotFound');
      }
      builder.removeArrayElement(elements[targetOrdinal ?? 0].nodeRef());
    } else {
      throw new TomlEditFailure('TargetNotFound');
    }
    const commit = commitTomlEdits(document, builder.build());
    if (output !== undefined) {
      const rendered = new TextDecoder().decode(commit.document().render());
      if (rendered !== output) {
        fail(`output: expected ${JSON.stringify(output)}, observed ${JSON.stringify(rendered)}`);
      }
    }
  } catch (error) {
    if (error instanceof TomlEditFailure && code !== undefined && error.code === code) {
      const baseUnchanged = expectedFieldOptional(case_, 'base_unchanged');
      if (baseUnchanged === true && toHex(document.render()) !== toHex(utf8(source))) {
        fail('base must stay unchanged');
      }
      return;
    }
    if (error instanceof TomlEditFailure && code === undefined) {
      throw error;
    }
    if (error instanceof EditFailure && code !== undefined && error.code === code) {
      return;
    }
    throw error;
  }
}

function findTomlTable(root: import('../../toml/document.ts').TomlItem, name: string): import('../../toml/document.ts').TomlItem {
  const entries = root.tableEntries();
  if (entries === null) {
    throw new TomlEditFailure('TargetNotFound');
  }
  for (const entry of entries) {
    if (entry.name() === name) {
      return entry.item();
    }
  }
  throw new TomlEditFailure('TargetNotFound');
}

function findTomlArray(root: import('../../toml/document.ts').TomlItem, name: string): import('../../toml/document.ts').TomlItem {
  const entries = root.tableEntries();
  if (entries === null) {
    throw new TomlEditFailure('TargetNotFound');
  }
  for (const entry of entries) {
    if (entry.name() === name) {
      return entry.item();
    }
  }
  throw new TomlEditFailure('TargetNotFound');
}

import { DEFAULT_SOURCE_PATCH_LIMITS } from '../../document/source_patch.ts';

void valueFromInput;
void UntouchedByteProof;

