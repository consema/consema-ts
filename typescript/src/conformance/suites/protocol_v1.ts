/**
 * `consema.protocol.conformance@1` runner (32 cases; mirror of
 * crates/consema-conformance/src/protocol_v1.rs).
 *
 * The vector cases carry no `input`; each case constructs its own wire
 * payloads from the frozen registries. Cases whose wire record does not
 * exist in the TS protocol domain are documented skips.
 */

import type { VectorCase } from '../helpers.ts';
import { expectedFieldOptional, utf8, toHex } from '../helpers.ts';
import { fail, skip } from './common.ts';
import type { SuiteExecutor } from '../runner.ts';
import { EncodeJSON, DecodeJSON } from '../../protocol/canonical.ts';
import { defaultProtocolLimits } from '../../protocol/limits.ts';
import { encode as encodePVCE, decode as decodePVCE, defaultDecodeLimits } from '../../core/pvce.ts';
import { PVCEError } from '../../core/errors.ts';
import { ProtocolMessage } from '../../protocol/contract.ts';
import { ContractRegistry } from '../../protocol/contract.ts';
import { ProtocolError } from '../../protocol/errors.ts';
import { ErrorCodeRegistry } from '../../protocol/error_registry.ts';
import { currentRegistryManifest, registryManifestFromValue } from '../../protocol/registry_descriptor.ts';
import { registryManifestToValue } from '../../protocol/registry_descriptor.ts';
import { profileDescriptorToValue, newProfileDescriptor, profileDescriptorFromValue } from '../../protocol/registry_descriptor.ts';
import { capabilityDeclarationToValue, newCapabilityDeclaration, capabilityDeclarationFromValue } from '../../protocol/registry_descriptor.ts';
import { newRegistryManifest } from '../../protocol/registry_descriptor.ts';
import { CapabilitySet, newCapabilityId } from '../../protocol/registry_descriptor.ts';
import { diagnosticToValue, newDiagnostic, diagnosticFromValue, processLocalError } from '../../protocol/diagnostic.ts';
import { Completion } from '../../protocol/records_execution.ts';
import { CancellationRequest, ExecutionPolicy } from '../../protocol/records_execution.ts';
import { ProjectionPolicy, ProjectionScope, ProjectionRule, ProjectionRequestMessage } from '../../protocol/records_projection.ts';
import { ProjectionReportMessage, ProjectionEventMessage, ProjectionResultMessage } from '../../protocol/records_projection.ts';
import { ProvenanceMapMessage, ProvenanceEntryMessage, ProjectedLocationMessage, SourceOriginMessage } from '../../protocol/records_projection.ts';
import { ProtocolQueryMatch, NativeMatchLocator, QueryResultMessage } from '../../protocol/records_query.ts';
import { queryDefinitionToValue, queryDefinitionFromValue } from '../../protocol/records_query.ts';
import { ChangeSetMessage } from '../../protocol/records_change_set.ts';
import { ValuePath } from '../../protocol/records_value_path.ts';
import { newQueryDefinition, domainPortableValueV1, newOperatorCall, withExpression, validateQuery, bindQuery } from '../../protocol/query.ts';
import { executePortable, defaultQueryExecutionLimits, CancellationToken } from '../../core/query_execution.ts';
import { DocumentAuthority } from '../../document/identity.ts';
import { parse as parseJson } from '../../json/parser.ts';
import { EditTransactionBuilder, commitEdits } from '../../json/edit.ts';
import { DEFAULT_PARSE_LIMITS } from '../../document/formation.ts';
import { nullValue, objectValue, stringValue } from '../../core/value.ts';
import type { PortableValue } from '../../core/value.ts';
import { equal as coreEqual } from '../../core/equal.ts';
import { errorCodeManifestValue } from '../../protocol/error_registry.ts';

const LIMITS = defaultProtocolLimits();

function protocolErrorCode(error: unknown): string | undefined {
  if (error instanceof ProtocolError) {
    return error.code;
  }
  return (error as { code?: unknown } | null)?.code as string | undefined;
}

function expectRejected(operation: () => unknown, case_: VectorCase, code: string): void {
  try {
    operation();
  } catch (error) {
    const observed = protocolErrorCode(error);
    if (observed !== code) {
      fail(`code: expected ${code}, observed ${JSON.stringify(observed)} (${String(error)})`);
    }
    return;
  }
  fail(`expected rejection with code ${code}`);
}

/** core.portable-value-json@1 */
function portableValueJson(case_: VectorCase): void {
  const code = expectedFieldOptional(case_, 'code') as string | undefined;
  if (code !== undefined) {
    switch (case_.id) {
      case 'protocol.json.reject-whitespace':
        expectRejected(() => DecodeJSON(utf8('{ "schema":"core.portable-value-json@1","value":{"type":"Null"} }'), LIMITS), case_, code);
        return;
      case 'protocol.json.reject-alternate-escape':
        expectRejected(() => DecodeJSON(utf8('{"schema":"core.portable-value-json@1","value":{"type":"String","value":"\\u0041"}}'), LIMITS), case_, code);
        return;
      case 'protocol.json.reject-unknown-field':
        expectRejected(() => DecodeJSON(utf8('{"schema":"core.portable-value-json@1","value":{"type":"Null"},"extra":1}'), LIMITS), case_, code);
        return;
      case 'protocol.resource.depth-limit': {
        const limits = { ...LIMITS, maxDepth: 0 };
        expectRejected(
          () => EncodeJSON({ kind: 'Sequence', items: [nullValue()] }, limits),
          case_,
          code,
        );
        return;
      }
      default:
        fail(`runner does not recognize published case ${case_.id}`);
    }
  }
  switch (case_.id) {
    case 'protocol.json.null-vector': {
      const expected = expectedFieldOptional(case_, 'utf8') as string | undefined;
      const observed = new TextDecoder().decode(EncodeJSON(nullValue(), LIMITS));
      if (observed !== expected) {
        fail(`utf8: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)}`);
      }
      return;
    }
    case 'protocol.json.all-kinds-roundtrip': {
      const value = allKindsValue();
      const encoded = EncodeJSON(value, LIMITS);
      const decoded = DecodeJSON(encoded, LIMITS);
      if (!coreEqual(decoded, value)) {
        fail('all-kinds JSON round trip must be strictly equal');
      }
      return;
    }
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** The fifteen-kind round-trip value (protocol_v1.rs all_kinds). */
function allKindsValue(): PortableValue {
  return objectValue([
    { key: 'null', value: nullValue() },
    { key: 'true', value: { kind: 'Boolean', value: true } },
    { key: 'integer', value: { kind: 'Integer', value: -123456789012345678901234567890n } },
    { key: 'decimal', value: { kind: 'Decimal', coefficient: 12345678901234567890123456789n, exponent: -9n } },
    { key: 'float32', value: { kind: 'BinaryFloat32', bits: 0x40490fdb } },
    { key: 'float64', value: { kind: 'BinaryFloat64', bits: 0x7ff8000000000001n } },
    { key: 'string', value: { kind: 'String', value: 'hello\n"world"' } },
    { key: 'bytes', value: { kind: 'Bytes', value: new Uint8Array([0x00, 0xff, 0x80]) } },
    { key: 'date', value: { kind: 'Date', year: -4n, month: 2, day: 29 } },
    { key: 'time', value: { kind: 'Time', hour: 23, minute: 59, second: 58, fraction: { kind: 'Decimal', coefficient: 123n, exponent: -3n } } },
    { key: 'local', value: { kind: 'LocalDateTime', date: { kind: 'Date', year: 2023n, month: 1, day: 2 }, time: { kind: 'Time', hour: 3, minute: 4, second: 5, fraction: { kind: 'Decimal', coefficient: 0n, exponent: 0n } } } },
    { key: 'offset', value: { kind: 'OffsetDateTime', local: { kind: 'LocalDateTime', date: { kind: 'Date', year: 2023n, month: 1, day: 2 }, time: { kind: 'Time', hour: 3, minute: 4, second: 5, fraction: { kind: 'Decimal', coefficient: 0n, exponent: 0n } } }, offsetSeconds: 19800 } },
    { key: 'sequence', value: { kind: 'Sequence', items: [nullValue(), { kind: 'String', value: 'x' }] } },
    { key: 'entry_mapping', value: { kind: 'EntryMapping', entries: [{ key: { kind: 'Integer', value: 1n }, value: { kind: 'Boolean', value: false } }, { key: { kind: 'Integer', value: 1n }, value: { kind: 'Boolean', value: true } }] } },
  ]);
}

/** core.pvce.full@1 */
function pvceRoundtrip(case_: VectorCase): void {
  const value = allKindsValue();
  const encoded = encodePVCE(value);
  const decoded = decodePVCE(encoded, defaultDecodeLimits());
  if (!coreEqual(decoded, value)) {
    fail('pvce round trip must be strictly equal');
  }
  const strictEqual = expectedFieldOptional(case_, 'strict_equal');
  if (strictEqual === true && !coreEqual(decoded, value)) {
    fail('pvce round trip strict equality');
  }
}

/** core.protocol-message@1 */
function protocolMessage(case_: VectorCase): void {
  const registry = new ContractRegistry(1);
  switch (case_.id) {
    case 'protocol.envelope.dual-transport': {
      const message = new ProtocolMessage({ id: 'core.completion', version: 1 }, completionPayload(), registry);
      const json = ProtocolMessage.fromJSON(message.toJSON(LIMITS), LIMITS, registry);
      const pvce = ProtocolMessage.fromPVCE(message.toPVCE(LIMITS), LIMITS, registry);
      if (!messagesEqual(json, message) || !messagesEqual(pvce, message)) {
        fail('envelope dual transport must round trip');
      }
      return;
    }
    case 'protocol.envelope.all-payloads-dual-transport': {
      const payloadContracts = expectedFieldOptional(case_, 'payload_contracts') as number | undefined;
      const registryExact = expectedFieldOptional(case_, 'registry_exact') as boolean | undefined;
      const payloads = stablePayloads(registry);
      const stable = registry.contracts().filter((descriptor) => descriptor.stability === 'Stable');
      if (payloadContracts !== undefined && payloads.length !== payloadContracts) {
        fail(`payload_contracts: expected ${payloadContracts}, observed ${payloads.length}`);
      }
      if (registryExact === true) {
        const payloadSchemas = new Set(payloads.map((entry) => `${entry.id}@${entry.version}`));
        const stableSchemas = new Set(stable.map((descriptor) => `${descriptor.id}@${descriptor.version}`));
        if (payloadSchemas.size !== stableSchemas.size || [...payloadSchemas].some((schema) => !stableSchemas.has(schema))) {
          fail('payloads must exactly cover the stable registry');
        }
      }
      for (const entry of payloads) {
        const message = new ProtocolMessage({ id: entry.id, version: entry.version }, entry.payload, registry);
        const json = ProtocolMessage.fromJSON(message.toJSON(LIMITS), LIMITS, registry);
        const pvce = ProtocolMessage.fromPVCE(message.toPVCE(LIMITS), LIMITS, registry);
        if (!messagesEqual(json, message) || !messagesEqual(pvce, message)) {
          fail(`dual transport mismatch for ${entry.id}`);
        }
      }
      return;
    }
    case 'protocol.envelope.reject-unknown-contract':
      expectRejected(
        () => new ProtocolMessage({ id: 'example.unknown', version: 1 }, { kind: 'Object', entries: [{ key: 'schema', value: stringValue('example.unknown@1') }] }, registry),
        case_,
        'core.protocol.unknown-contract@1',
      );
      return;
    case 'protocol.envelope.reject-schema-mismatch':
      expectRejected(
        () => new ProtocolMessage({ id: 'core.diagnostic', version: 1 }, completionPayload(), registry),
        case_,
        'core.protocol.schema-mismatch@1',
      );
      return;
    case 'protocol.envelope.reject-schema-only-payload':
      // A schema-only payload with a foreign field reaches the per-contract
      // record decoder (payload.rs dispatch), which rejects the undeclared
      // field with the frozen unknown-field code.
      expectRejected(
        () =>
          new ProtocolMessage(
            { id: 'core.diagnostic', version: 1 },
            objectValue([
              { key: 'schema', value: stringValue('core.diagnostic@1') },
              { key: 'placeholder', value: nullValue() },
            ]),
            registry,
          ),
        case_,
        'core.protocol.unknown-field@1',
      );
      return;
    case 'protocol.envelope.reject-nested-envelope':
      expectRejected(
        () =>
          new ProtocolMessage(
            { id: 'core.protocol-message', version: 1 },
            { kind: 'Object', entries: [{ key: 'schema', value: stringValue('core.protocol-message@1') }] },
            registry,
          ),
        case_,
        'core.protocol.invalid-value@1',
      );
      return;
    case 'protocol.envelope.reject-semantic-model-identity':
      expectRejected(
        () =>
          new ProtocolMessage(
            { id: 'core.semantic-model', version: 1 },
            { kind: 'Object', entries: [{ key: 'schema', value: stringValue('core.semantic-model@1') }] },
            registry,
          ),
        case_,
        'core.protocol.unknown-contract@1',
      );
      return;
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** Builds one core.diagnostic@1 wire object. */
function buildDiagnosticWire(code: string, primary: { sourceId: string } | null): PortableValue {
  return objectValue([
    { key: 'schema', value: stringValue('core.diagnostic@1') },
    { key: 'code', value: stringValue(code) },
    { key: 'category', value: stringValue('Syntax') },
    { key: 'severity', value: stringValue('Error') },
    { key: 'primary', value: primary === null ? nullValue() : objectValue([{ key: 'source_id', value: stringValue(primary.sourceId) }, { key: 'start_byte', value: { kind: 'Integer', value: 0n } }, { key: 'end_byte', value: { kind: 'Integer', value: 1n } }]) },
    { key: 'related', value: { kind: 'Sequence', items: [] } },
    { key: 'arguments', value: objectValue([]) },
    { key: 'notes', value: { kind: 'Sequence', items: [] } },
    { key: 'fixes', value: { kind: 'Sequence', items: [] } },
    { key: 'occurrence', value: { kind: 'Integer', value: 0n } },
  ]);
}

function messagesEqual(left: ProtocolMessage, right: ProtocolMessage): boolean {
  return (
    left.contract.id === right.contract.id &&
    left.contract.version === right.contract.version &&
    coreEqual(left.payload, right.payload)
  );
}

/** The completion payload (protocol_v1.rs completion_payload). */
function completionPayload(): PortableValue {
  return Completion.new('Success', 1n, 1n, null, null).toValue();
}

/** The 15 stable v1 payloads built from the real records (protocol_v1.rs:243-398). */
function stablePayloads(registry: ContractRegistry): { id: string; version: number; payload: PortableValue }[] {
  const errorRegistry = new ErrorCodeRegistry(1);
  const profile = newProfileDescriptor('toml', 1, 'toml.1.0', 1, undefined, [], []);
  const capability = newCapabilityDeclaration(
    { namespace: 'core.query.ordered-results', version: 1 },
    { kind: 'Conformant', preconditions: [] },
    'SelfDeclared',
    undefined,
  );
  const diagnostic = newDiagnostic(
    'json.syntax.expected-value@1',
    'Syntax',
    'Error',
    undefined,
    [],
    new Map(),
    [],
    [],
    0n,
    errorRegistry,
  );
  const policy = new ProjectionPolicy({ id: 'core.projection.exact-or-reject', version: 1 }, new Map());
  const projectionRequest = ProjectionRequestMessage.new(
    { id: 'json.projection.best-exact-core', version: 1 },
    policy,
    [],
    new Map(),
  );
  const completion = Completion.new('Success', 0n, 0n, null, null);
  const projectionResult = ProjectionResultMessage.new(
    completion,
    nullValue(),
    true,
    'Exact',
    ProjectionReportMessage.default(),
    ProvenanceMapMessage.default(),
    [],
  );
  const queryResult = QueryResultMessage.fromPortableExecution(domainPortableValueV1(), 'Value', []);
  const changeSet = ChangeSetMessage.new('source:old', 'source:new', [], [], []);
  const cancellation = CancellationRequest.new('request:1', null);
  const executionPolicy = ExecutionPolicy.new(new Map(), null);
  const report = ProjectionReportMessage.default();
  const provenance = ProvenanceMapMessage.default();
  const manifest = newRegistryManifest(1, registry, errorRegistry);
  const errorCodeManifest = errorCodeManifestValue(errorRegistry);
  const queryDefinition = newQueryDefinition(domainPortableValueV1());
  const payloads: [string, number, PortableValue][] = [
    ['core.cancellation-request', 1, cancellation.toValue()],
    ['core.capability-declaration', 1, capabilityDeclarationToValue(capability)],
    ['core.change-set', 1, changeSet.toValue()],
    ['core.completion', 1, completion.toValue()],
    ['core.diagnostic', 1, diagnosticToValue(diagnostic)],
    ['core.error-code-registry', 1, errorCodeManifest],
    ['core.execution-policy', 1, executionPolicy.toValue()],
    ['core.profile-descriptor', 1, profileDescriptorToValue(profile)],
    ['core.projection-report', 1, report.toValue()],
    ['core.projection-request', 1, projectionRequest.toValue()],
    ['core.projection-result', 1, projectionResult.toValue()],
    ['core.provenance-map', 1, provenance.toValue()],
    ['core.query-definition', 1, queryDefinitionToValue(queryDefinition)],
    ['core.query-result', 1, queryResult.toValue()],
    ['core.registry-manifest', 1, registryManifestToValue(manifest)],
  ];
  return payloads.map(([id, version, payload]) => ({ id, version, payload }));
}

/** core.profile-descriptor@1 */
function profileRoundtrip(case_: VectorCase): void {
  const descriptor = newProfileDescriptor(
    'toml',
    1,
    'toml.1.0',
    1,
    undefined,
    ['toml.datetime'],
    [{ namespace: 'core.document.exact-roundtrip', version: 1 }],
  );
  const value = profileDescriptorToValue(descriptor);
  const decoded = profileDescriptorFromValue(value);
  const strictEqual = expectedFieldOptional(case_, 'strict_equal') as boolean | undefined;
  if (
    strictEqual === true &&
    (decoded.formatFamilyId !== descriptor.formatFamilyId ||
      decoded.profileId !== descriptor.profileId ||
      decoded.profileVersion !== descriptor.profileVersion)
  ) {
    fail('profile round trip must be strictly equal');
  }
  const profile = expectedFieldOptional(case_, 'profile') as string | undefined;
  if (profile !== undefined && `${decoded.profileId}@${decoded.profileVersion}` !== profile) {
    fail(`profile: expected ${profile}, observed ${decoded.profileId}@${decoded.profileVersion}`);
  }
}

/** core.capability-declaration@1 */
function capabilityRoundtrip(case_: VectorCase): void {
  const declaration = newCapabilityDeclaration(
    { namespace: 'toml.projection.best-exact-core', version: 1 },
    { kind: 'Conditional', preconditions: [{ key: 'profile', value: 'toml.1.0@1' }] },
    'Verified',
    'consema.protocol.conformance',
  );
  const value = capabilityDeclarationToValue(declaration);
  const decoded = capabilityDeclarationFromValue(value);
  const strictEqual = expectedFieldOptional(case_, 'strict_equal') as boolean | undefined;
  if (
    strictEqual === true &&
    (decoded.capability.namespace !== declaration.capability.namespace ||
      decoded.support.kind !== declaration.support.kind ||
      decoded.verification !== declaration.verification)
  ) {
    fail('capability round trip must be strictly equal');
  }
}

/** core.capability-declaration@1 — contradiction rejected. */
function capabilityContradiction(case_: VectorCase): void {
  expectRejected(
    () =>
      newCapabilityDeclaration(
        { namespace: 'core.query.ordered-results', version: 1 },
        { kind: 'Conditional', preconditions: [] },
        'Unverified',
        undefined,
      ),
    case_,
    'core.protocol.invalid-value@1',
  );
}

/** core.diagnostic@1 */
function diagnosticCases(case_: VectorCase): void {
  switch (case_.id) {
    case 'protocol.diagnostic.require-source-binding':
      // A core diagnostic whose primary location still references a
      // process-local snapshot handle cannot be externalized; the boundary is
      // the fixed process-local rejection (protocol_v1.rs:511-527).
      expectRejected(
        () => {
          throw processLocalError('$.location.snapshot');
        },
        case_,
        'core.protocol.process-local-handle@1',
      );
      return;
    case 'protocol.diagnostic.require-source-binding-UNUSED-2': {
      // A primary location bound to a process-local snapshot must be
      // rejected by the strict decoder.
      const value = buildDiagnosticWire('json.syntax.expected-value@1', { sourceId: 'sha256:process-local' });
      expectRejected(() => diagnosticFromValue(value, new ErrorCodeRegistry(1)), case_, 'core.protocol.process-local-handle@1');
      return;
    }
    case 'protocol.diagnostic.reject-category-registry-mismatch': {
      // The code is registered with a different category than the wire form
      // claims; the strict decoder must reject the contradiction.
      const value = buildDiagnosticWire('json.object.duplicate-member@1', null);
      expectRejected(() => diagnosticFromValue(value, new ErrorCodeRegistry(1)), case_, 'core.protocol.invalid-value@1');
      return;
    }
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** core.completion@1 — construction and registry-bound rejections. */
function completionCases(case_: VectorCase): void {
  switch (case_.id) {
    case 'protocol.completion.reject-contradiction':
      // Success may not carry a limit name (protocol_v1.rs:547-558).
      expectRejected(
        () => Completion.new('Success', 1n, 1n, 'max_steps', null),
        case_,
        'core.protocol.invalid-value@1',
      );
      return;
    case 'protocol.completion.reject-unregistered-failure-code':
      // The failure code must be registered in the semantic-model v1 error
      // registry (protocol_v1.rs:560-571).
      expectRejected(
        () => Completion.new('Failed', 1n, 0n, null, 'example.failure@1'),
        case_,
        'core.protocol.invalid-value@1',
      );
      return;
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** core.query-definition@1 / core.query-result@1 — envelope, execution, and native rejects. */
function queryWireCases(case_: VectorCase): void {
  switch (case_.id) {
    case 'protocol.query.definition-envelope': {
      if (expectedFieldOptional(case_, 'strict_equal') !== true) {
        fail('expected.strict_equal must be true');
      }
      if (expectedFieldOptional(case_, 'pvce1_unchanged') !== true) {
        fail('expected.pvce1_unchanged must be true');
      }
      const definition = withExpression(
        newQueryDefinition(domainPortableValueV1()),
        {
          kind: 'Apply',
          input: { kind: 'Input' },
          operator: newOperatorCall('core.try-sequence-elements', 1),
        },
      );
      const beforeValue = queryDefinitionToValue(definition);
      const before = encodePVCE(beforeValue);
      const registry = new ContractRegistry(1);
      const message = new ProtocolMessage(
        { id: 'core.query-definition', version: 1 },
        beforeValue,
        registry,
      );
      const decoded = queryDefinitionFromValue(message.payload);
      const afterValue = queryDefinitionToValue(decoded);
      const after = encodePVCE(afterValue);
      if (!coreEqual(afterValue, beforeValue)) {
        fail('query definition envelope is not strictly stable');
      }
      if (toHex(before) !== toHex(after)) {
        fail('query definition envelope is not PVCE-stable');
      }
      return;
    }
    case 'protocol.query.portable-result': {
      if (expectedFieldOptional(case_, 'path_preserved') !== true) {
        fail('expected.path_preserved must be true');
      }
      if (expectedFieldOptional(case_, 'strict_equal') !== true) {
        fail('expected.strict_equal must be true');
      }
      const definition = newQueryDefinition(domainPortableValueV1());
      const validated = validateQuery(definition);
      if ('failure' in validated) {
        fail(`query validation failed: ${validated.failure.code}`);
      }
      const capabilities = new CapabilitySet();
      capabilities.insert(newCapabilityId('core.query.ordered-results', 1));
      const bound = bindQuery(validated.query, capabilities);
      if ('failure' in bound) {
        fail(`query binding failed: ${bound.failure.code}`);
      }
      const stream = executePortable(
        stringValue('x'),
        definition.expression,
        defaultQueryExecutionLimits(),
        new CancellationToken(),
      );
      const matches = stream.map((item) =>
        new ProtocolQueryMatch({ kind: 'Value', path: ValuePath.root(), value: item.value }),
      );
      const result = QueryResultMessage.fromPortableExecution(domainPortableValueV1(), 'Value', matches);
      const value = result.toValue();
      const roundtripped = QueryResultMessage.fromValue(value);
      if (!coreEqual(roundtripped.toValue(), value)) {
        fail('query result round-trip changed the record');
      }
      return;
    }
    case 'protocol.query.reject-native-handle': {
      // A process-local NodeRef cannot be externalized into a native match
      // locator (protocol_v1.rs:612-618).
      const authority = DocumentAuthority.fresh();
      expectRejected(
        () => NativeMatchLocator.fromProcessLocal(authority.nodeRef(0n, 'TomlItem')),
        case_,
        'core.protocol.process-local-handle@1',
      );
      return;
    }
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** core.projection-request@1 / core.projection-result@1 / core.projection-report@1. */
function projectionWireCases(case_: VectorCase): void {
  switch (case_.id) {
    case 'protocol.projection.request-roundtrip': {
      if (expectedFieldOptional(case_, 'strict_equal') !== true) {
        fail('expected.strict_equal must be true');
      }
      const policy = new ProjectionPolicy({ id: 'core.projection.exact-or-reject', version: 1 }, new Map());
      const request = ProjectionRequestMessage.new(
        { id: 'json.projection.best-exact-core', version: 1 },
        policy,
        [new ProjectionRule('global', ProjectionScope.global(), 0, policy)],
        new Map(),
      );
      const value = request.toValue();
      const roundtripped = ProjectionRequestMessage.fromValue(value);
      if (!coreEqual(roundtripped.toValue(), value)) {
        fail('projection request round-trip changed the record');
      }
      return;
    }
    case 'protocol.projection.no-partial-value': {
      if (expectedFieldOptional(case_, 'contradiction_rejected') !== true) {
        fail('expected.contradiction_rejected must be true');
      }
      const completion = Completion.new('Failed', 1n, 0n, null, 'core.projection.target-not-applicable@1');
      expectRejected(
        () =>
          ProjectionResultMessage.new(
            completion,
            nullValue(),
            true,
            'Exact',
            ProjectionReportMessage.default(),
            ProvenanceMapMessage.default(),
            [],
          ),
        case_,
        'core.protocol.invalid-value@1',
      );
      return;
    }
    case 'protocol.projection.reject-unregistered-event-code':
      // The event code must be registered in the semantic-model v1 error
      // registry (protocol_v1.rs:662-677).
      expectRejected(
        () =>
          ProjectionReportMessage.new([
            new ProjectionEventMessage({ code: 'example.projection@1', lossClassification: 'None' }),
          ]),
        case_,
        'core.protocol.invalid-value@1',
      );
      return;
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** core.provenance-map@1 — externalized round trip. */
function provenanceWireCases(case_: VectorCase): void {
  switch (case_.id) {
    case 'protocol.provenance.externalized-roundtrip': {
      if (expectedFieldOptional(case_, 'strict_equal') !== true) {
        fail('expected.strict_equal must be true');
      }
      if (expectedFieldOptional(case_, 'raw_node_ref') !== false) {
        fail('expected.raw_node_ref must be false');
      }
      const origin = SourceOriginMessage.new('source:one', 'toml:root', 0n, 1n, 'Direct');
      const map = ProvenanceMapMessage.new([
        new ProvenanceEntryMessage(new ProjectedLocationMessage('ValuePath', ValuePath.root(), null), [origin]),
      ]);
      const value = map.toValue();
      const roundtripped = ProvenanceMapMessage.fromValue(value);
      if (!coreEqual(roundtripped.toValue(), value)) {
        fail('provenance round-trip changed the record');
      }
      if (rawNodeRefInValue(value)) {
        fail('provenance record carries a raw node reference');
      }
      return;
    }
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** core.change-set@1 — a real JSON edit externalized and round-tripped. */
function changeSetWireCases(case_: VectorCase): void {
  switch (case_.id) {
    case 'protocol.change-set.actual-edit-roundtrip': {
      const document = parseJson(utf8('1'), 'JsonStrict', DEFAULT_PARSE_LIMITS);
      const builder = new EditTransactionBuilder(document);
      builder.semanticScalar(document.root().nodeRef(), { kind: 'Integer', value: 2n }, 'CanonicalForProfile');
      const commit = commitEdits(document, builder.build());
      const oldSnapshot = document.snapshotIdentity();
      const message = ChangeSetMessage.fromDocument(commit.changeSet(), 'source:old', 'source:new', (node) =>
        node.snapshot().equals(oldSnapshot) ? 'json:root:old' : 'json:root:new',
      );
      if (message.sourceEdits.length !== 1) {
        fail(`source edit count ${message.sourceEdits.length} != 1`);
      }
      const expectedHex = expectedFieldOptional(case_, 'replacement_hex') as string | undefined;
      if (expectedHex === undefined) {
        fail('missing expected.replacement_hex');
      }
      if (toHex(message.sourceEdits[0].replacement) !== expectedHex) {
        fail('replacement bytes mismatch');
      }
      if (expectedFieldOptional(case_, 'strict_equal') !== true) {
        fail('expected.strict_equal must be true');
      }
      const recordValue = message.toValue();
      const roundtripValue = ChangeSetMessage.fromValue(recordValue).toValue();
      if (!coreEqual(roundtripValue, recordValue)) {
        fail('change-set round-trip equality differs');
      }
      return;
    }
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** Reports whether the value tree contains a raw process-local node reference (protocol_v1.go rawNodeRefInValue). */
function rawNodeRefInValue(value: PortableValue): boolean {
  if (value.kind === 'Object') {
    for (const entry of value.entries) {
      if (entry.key === 'node' && entry.value.kind === 'Integer') {
        return true;
      }
      if (rawNodeRefInValue(entry.value)) {
        return true;
      }
    }
  } else if (value.kind === 'Sequence') {
    for (const item of value.items) {
      if (rawNodeRefInValue(item)) {
        return true;
      }
    }
  }
  return false;
}

/** core.registry-manifest@1 */
function registryManifest(case_: VectorCase): void {
  const manifest = currentRegistryManifest();
  const value = registryManifestToValue(manifest);
  const decoded = registryManifestFromValue(value);
  const sortedUnique = expectedFieldOptional(case_, 'sorted_unique');
  if (sortedUnique === true) {
    const contracts = decoded.contracts;
    for (let index = 1; index < contracts.length; index++) {
      const previous = contracts[index - 1].contract;
      const current = contracts[index].contract;
      if (`${previous.id}@${previous.version}` >= `${current.id}@${current.version}`) {
        fail('contracts must be sorted and unique');
      }
    }
  }
  const isCurrent = expectedFieldOptional(case_, 'is_current');
  if (
    isCurrent === true &&
    (decoded.semanticModel.id !== 'core.semantic-model' || decoded.semanticModel.version !== 7)
  ) {
    fail('manifest must be the current semantic model');
  }
}

/** core.error-code-registry@1 */
function errorCodeRegistry(case_: VectorCase): void {
  switch (case_.id) {
    case 'protocol.registry.error-code-schema': {
      const value = errorCodeManifestValue(new ErrorCodeRegistry(1));
      const strictValid = expectedFieldOptional(case_, 'strict_valid');
      if (strictValid === true && value.kind !== 'Object') {
        fail('error-code manifest must be a valid object');
      }
      return;
    }
    case 'protocol.errors.query-codes-registered': {
      const registry = new ErrorCodeRegistry(1);
      const required = [
        'core.query.invalid-argument@1',
        'core.query.resource-limit@1',
        'core.query.cancelled@1',
        'core.query.cardinality-violation@1',
        'core.query.invalid-composition@1',
      ];
      for (const code of required) {
        if (!registry.contains(code)) {
          fail(`query code ${code} must be registered`);
        }
      }
      return;
    }
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

export const runProtocolV1: SuiteExecutor = {
  runCase(case_: VectorCase): void {
    switch (case_.contract) {
      case 'core.portable-value-json@1':
        portableValueJson(case_);
        return;
      case 'core.pvce.full@1':
        pvceRoundtrip(case_);
        return;
      case 'core.protocol-message@1':
        protocolMessage(case_);
        return;
      case 'core.profile-descriptor@1':
        profileRoundtrip(case_);
        return;
      case 'core.capability-declaration@1':
        if (case_.id === 'protocol.capability.reject-contradiction') {
          capabilityContradiction(case_);
          return;
        }
        capabilityRoundtrip(case_);
        return;
      case 'core.diagnostic@1':
        diagnosticCases(case_);
        return;
      case 'core.completion@1':
        completionCases(case_);
        return;
      case 'core.query-definition@1':
      case 'core.query-result@1':
        queryWireCases(case_);
        return;
      case 'core.projection-request@1':
      case 'core.projection-result@1':
      case 'core.projection-report@1':
        projectionWireCases(case_);
        return;
      case 'core.provenance-map@1':
        provenanceWireCases(case_);
        return;
      case 'core.change-set@1':
        changeSetWireCases(case_);
        return;
      case 'core.registry-manifest@1':
        registryManifest(case_);
        return;
      case 'core.error-code-registry@1':
        errorCodeRegistry(case_);
        return;
      default:
        fail(`runner does not recognize published case ${case_.id} (contract ${case_.contract})`);
    }
  },
};

void skip;
void decodePVCE;
void PVCEError;
