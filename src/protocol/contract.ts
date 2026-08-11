/**
 * The frozen contract registry and the common protocol envelope.
 *
 * authority: the Rust CONTRACTS_V1..V7 registries
 * (crates/consema-protocol/src/contract.rs:71-273), transcribed verbatim in
 * go/protocol/contract.go:289-473 (cross-reference). The registry pins the
 * semantic-model v1-v7 sets of 16/18/25/25/30/38/41 contracts; the test
 * battery re-pins the counts and sortedness. The envelope
 * `core.protocol-message@1` follows contract.rs:417-521.
 */

import type { PortableValue, ObjectValue } from '../core/value.ts';
import { protocolError, invalid } from './errors.ts';
import type { ContractRegistryVersion, ContractStability } from './registry_types.ts';
import { schemaFields, stringOf, unsigned32, objectValueFrom } from './records.ts';
import type { ProtocolLimits } from './limits.ts';
import { EncodePVCE, DecodePVCE, defaultDecodeLimits } from '../core/pvce.ts';
import { EncodeJSON, DecodeJSON, PortableValueJSONSchema } from './canonical.ts';
import { validateRegisteredPayload } from './payload_validators.ts';
// Side-effect record registrations: every registered payload contract
// validates through its record decoder (payload.rs dispatch).
import './payload_cli_validators.ts';
import './records_execution.ts';
import './records_projection.ts';
import './records_query.ts';
import './records_change_set.ts';
import './records_source.ts';
import './records_materialization.ts';
import './records_graph.ts';
import './records_java_utf16.ts';

/** One static registry record. */
export interface ContractDescriptor {
  readonly id: string;
  readonly version: number;
  readonly stability: ContractStability;
}

/** A stable versioned protocol contract identifier. */
export interface ContractId {
  readonly id: string;
  readonly version: number;
}

/**
 * Validates and creates an identifier: the version must be non-zero and the
 * id must be a dotted lowercase identifier of at most 255 bytes whose
 * segments start with a lowercase letter (contract.rs:18-30, 559-578).
 */
export function newContractId(id: string, version: number): ContractId {
  if (version === 0) {
    throw invalid('$.contract.version', 'version must be non-zero');
  }
  validateIdentifier(id, '$.contract.id');
  return { id, version };
}

/** The canonical `id@version` schema discriminator. */
export function contractSchema(contract: ContractId): string {
  return `${contract.id}@${contract.version}`;
}

/** Orders contract ids by (id, version). */
export function compareContractIds(a: ContractId, b: ContractId): number {
  if (a.id !== b.id) {
    return a.id < b.id ? -1 : 1;
  }
  if (a.version < b.version) {
    return -1;
  }
  if (a.version > b.version) {
    return 1;
  }
  return 0;
}

/** The strict dotted identifier rule (contract.rs:559-578). */
export function validateIdentifier(identifier: string, path: string): void {
  if (identifier.length > 255 || !identifier.includes('.')) {
    throw invalid(path, 'identifier must contain multiple segments and be at most 255 bytes');
  }
  for (const segment of identifier.split('.')) {
    if (segment === '' || !isLower(segment.charCodeAt(0))) {
      throw invalid(path, 'identifier contains an invalid segment');
    }
    for (let i = 1; i < segment.length; i++) {
      const code = segment.charCodeAt(i);
      if (!isLower(code) && (code < 0x30 || code > 0x39) && code !== 0x2d) {
        throw invalid(path, 'identifier contains an invalid segment');
      }
    }
  }
}

/**
 * The profile/capability namespace rule (registry.rs:475-498): at most 255
 * bytes, and when requireDot is set at least two segments; every segment
 * starts with a lowercase letter (or a digit when not the first segment)
 * and continues with lowercase letters, digits, or dashes.
 */
export function validateNamespace(identifier: string, requireDot: boolean, path: string): void {
  if (
    identifier.length === 0 ||
    identifier.length > 255 ||
    (requireDot && !identifier.includes('.'))
  ) {
    throw invalid(path, 'invalid namespaced identifier');
  }
  identifier.split('.').forEach((segment, index) => {
    if (segment === '') {
      throw invalid(path, 'invalid identifier segment');
    }
    const first = segment.charCodeAt(0);
    if (!isLower(first) && !(index !== 0 && first >= 0x30 && first <= 0x39)) {
      throw invalid(path, 'invalid identifier segment');
    }
    for (let offset = 1; offset < segment.length; offset++) {
      const code = segment.charCodeAt(offset);
      if (!isLower(code) && (code < 0x30 || code > 0x39) && code !== 0x2d) {
        throw invalid(path, 'invalid identifier segment');
      }
    }
  });
}

function isLower(code: number): boolean {
  return code >= 0x61 && code <= 0x7a;
}

/** A closed, explicitly versioned contract registry. */
export class ContractRegistry {
  private readonly version: ContractRegistryVersion;

  constructor(version: ContractRegistryVersion) {
    this.version = version;
  }

  /** The semantic-model version of this registry. */
  versionOf(): ContractRegistryVersion {
    return this.version;
  }

  /** The sorted immutable descriptors of this version. */
  contracts(): ContractDescriptor[] {
    return [...contractsFor(this.version)];
  }

  /** Reports whether an exact ID/version pair is registered. */
  recognizes(contract: ContractId): boolean {
    return this.descriptor(contract) !== undefined;
  }

  /** Returns the exact registered descriptor, or undefined. */
  descriptor(contract: ContractId): ContractDescriptor | undefined {
    const records = contractsFor(this.version);
    // The records are sorted by (id, version); binary search.
    let low = 0;
    let high = records.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const candidate = records[mid];
      const order = compareContractIds(candidate, contract);
      if (order < 0) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    const found = records[low];
    if (found !== undefined && found.id === contract.id && found.version === contract.version) {
      return found;
    }
    return undefined;
  }
}

function contract(id: string, version: number, stability: ContractStability): ContractDescriptor {
  return { id, version, stability };
}

function stable(id: string): ContractDescriptor {
  return contract(id, 1, 'Stable');
}

function transport(id: string): ContractDescriptor {
  return contract(id, 1, 'Transport');
}

/** The frozen v1 records (16). */
const CONTRACTS_V1: readonly ContractDescriptor[] = [
  stable('core.cancellation-request'),
  stable('core.capability-declaration'),
  stable('core.change-set'),
  stable('core.completion'),
  stable('core.diagnostic'),
  stable('core.error-code-registry'),
  stable('core.execution-policy'),
  stable('core.profile-descriptor'),
  stable('core.projection-report'),
  stable('core.projection-request'),
  stable('core.projection-result'),
  transport('core.protocol-message'),
  stable('core.provenance-map'),
  stable('core.query-definition'),
  stable('core.query-result'),
  stable('core.registry-manifest'),
];

/** The frozen v2 records (18). */
const CONTRACTS_V2: readonly ContractDescriptor[] = [
  ...CONTRACTS_V1,
  stable('core.source-patch'),
  stable('core.source-snapshot'),
];

/** The frozen v3 records (25); v4 is identical. */
const CONTRACTS_V3: readonly ContractDescriptor[] = [
  stable('core.cancellation-request'),
  stable('core.capability-declaration'),
  stable('core.change-set'),
  stable('core.completion'),
  stable('core.conversion-report'),
  stable('core.diagnostic'),
  stable('core.edit-plan'),
  stable('core.error-code-registry'),
  stable('core.execution-policy'),
  stable('core.format-operation-registry'),
  stable('core.materialization-provenance-map'),
  stable('core.materialization-report'),
  stable('core.materialization-request'),
  stable('core.materialization-result'),
  stable('core.profile-descriptor'),
  stable('core.projection-report'),
  stable('core.projection-request'),
  stable('core.projection-result'),
  transport('core.protocol-message'),
  stable('core.provenance-map'),
  stable('core.query-definition'),
  stable('core.query-result'),
  stable('core.registry-manifest'),
  stable('core.source-patch'),
  stable('core.source-snapshot'),
];

/** The frozen v5 records (30). */
const CONTRACTS_V5: readonly ContractDescriptor[] = [
  stable('core.cancellation-request'),
  stable('core.capability-declaration'),
  stable('core.change-set'),
  stable('core.completion'),
  stable('core.conversion-report'),
  stable('core.diagnostic'),
  stable('core.edit-plan'),
  stable('core.error-code-registry'),
  stable('core.execution-policy'),
  stable('core.format-operation-registry'),
  stable('core.graph-projection-result'),
  stable('core.graph-provenance-map'),
  stable('core.graph-query-result'),
  stable('core.materialization-provenance-map'),
  stable('core.materialization-report'),
  stable('core.materialization-request'),
  stable('core.materialization-result'),
  stable('core.portable-graph'),
  stable('core.profile-descriptor'),
  stable('core.projection-report'),
  stable('core.projection-request'),
  stable('core.projection-result'),
  transport('core.protocol-message'),
  stable('core.provenance-map'),
  stable('core.query-definition'),
  stable('core.query-result'),
  stable('core.registry-manifest'),
  stable('core.source-patch'),
  stable('core.source-snapshot'),
  stable('core.yaml-query-result'),
];

/** The frozen v6 records (38). */
const CONTRACTS_V6: readonly ContractDescriptor[] = [
  stable('core.cancellation-request'),
  stable('core.capability-declaration'),
  stable('core.change-set'),
  stable('core.completion'),
  stable('core.conversion-report'),
  stable('core.diagnostic'),
  stable('core.edit-plan'),
  stable('core.error-code-registry'),
  stable('core.execution-policy'),
  stable('core.format-operation-registry'),
  stable('core.graph-projection-result'),
  stable('core.graph-provenance-map'),
  stable('core.graph-query-result'),
  stable('core.ini-query-result'),
  stable('core.java-properties-query-result'),
  stable('core.java-utf16-string'),
  stable('core.materialization-provenance-map'),
  stable('core.materialization-report'),
  stable('core.materialization-request'),
  contract('core.materialization-request', 2, 'Stable'),
  stable('core.materialization-result'),
  contract('core.materialization-result', 2, 'Stable'),
  stable('core.portable-graph'),
  stable('core.profile-descriptor'),
  stable('core.projection-report'),
  stable('core.projection-request'),
  stable('core.projection-result'),
  transport('core.protocol-message'),
  stable('core.provenance-map'),
  stable('core.query-definition'),
  stable('core.query-result'),
  stable('core.registry-manifest'),
  stable('core.source-encoding'),
  stable('core.source-patch'),
  contract('core.source-patch', 2, 'Stable'),
  stable('core.source-snapshot'),
  contract('core.source-snapshot', 2, 'Stable'),
  stable('core.yaml-query-result'),
];

/** The frozen v7 records (41). */
const CONTRACTS_V7: readonly ContractDescriptor[] = [
  stable('core.batch-plan'),
  stable('core.batch-result'),
  stable('core.cancellation-request'),
  stable('core.capability-declaration'),
  stable('core.change-set'),
  stable('core.cli-output'),
  stable('core.completion'),
  stable('core.conversion-report'),
  stable('core.diagnostic'),
  stable('core.edit-plan'),
  stable('core.error-code-registry'),
  stable('core.execution-policy'),
  stable('core.format-operation-registry'),
  stable('core.graph-projection-result'),
  stable('core.graph-provenance-map'),
  stable('core.graph-query-result'),
  stable('core.ini-query-result'),
  stable('core.java-properties-query-result'),
  stable('core.java-utf16-string'),
  stable('core.materialization-provenance-map'),
  stable('core.materialization-report'),
  stable('core.materialization-request'),
  contract('core.materialization-request', 2, 'Stable'),
  stable('core.materialization-result'),
  contract('core.materialization-result', 2, 'Stable'),
  stable('core.portable-graph'),
  stable('core.profile-descriptor'),
  stable('core.projection-report'),
  stable('core.projection-request'),
  stable('core.projection-result'),
  transport('core.protocol-message'),
  stable('core.provenance-map'),
  stable('core.query-definition'),
  stable('core.query-result'),
  stable('core.registry-manifest'),
  stable('core.source-encoding'),
  stable('core.source-patch'),
  contract('core.source-patch', 2, 'Stable'),
  stable('core.source-snapshot'),
  contract('core.source-snapshot', 2, 'Stable'),
  stable('core.yaml-query-result'),
];

/** The frozen records of one semantic-model version (16/18/25/25/30/38/41). */
function contractsFor(version: ContractRegistryVersion): readonly ContractDescriptor[] {
  switch (version) {
    case 1:
      return CONTRACTS_V1;
    case 2:
      return CONTRACTS_V2;
    case 3:
    case 4:
      return CONTRACTS_V3;
    case 5:
      return CONTRACTS_V5;
    case 6:
      return CONTRACTS_V6;
    case 7:
      return CONTRACTS_V7;
  }
}

/** The protocol envelope schema. */
export const ProtocolMessageSchema = 'core.protocol-message@1';

/**
 * One validated protocol payload in the common envelope (contract.rs:417-521).
 * Construction validates a recognized contract, rejects transport envelopes
 * as nested payload contracts, and checks the payload schema discriminator.
 */
export class ProtocolMessage {
  readonly contract: ContractId;
  readonly payload: PortableValue;

  constructor(contract: ContractId, payload: PortableValue, registry: ContractRegistry) {
    const descriptor = registry.descriptor(contract);
    if (descriptor === undefined) {
      throw protocolError('UnknownContract', '$.contract', contractSchema(contract));
    }
    if (descriptor.stability === 'Transport') {
      throw invalid('$.contract', 'transport envelopes cannot be nested as payload contracts');
    }
    validateContractPayloadSchema(payload, contract);
    validateRegisteredPayload(contract, payload, registry);
    this.contract = contract;
    this.payload = payload;
  }

  /** Encodes the fixed envelope as a PortableValue tree. */
  toValue(): ObjectValue {
    return objectValueFrom([
      { key: 'schema', value: { kind: 'String', value: ProtocolMessageSchema } },
      { key: 'contract_id', value: { kind: 'String', value: this.contract.id } },
      { key: 'contract_version', value: { kind: 'Integer', value: BigInt(this.contract.version) } },
      { key: 'payload', value: this.payload },
    ]);
  }

  /** Strictly decodes the envelope and validates the selected payload contract. */
  static fromValue(value: PortableValue, registry: ContractRegistry): ProtocolMessage {
    const fields = schemaFields(
      value,
      ProtocolMessageSchema,
      ['contract_id', 'contract_version', 'payload'],
      '$',
    );
    const id = stringOf(fields[0], '$.contract_id');
    const version = unsigned32(fields[1], '$.contract_version');
    return new ProtocolMessage(newContractId(id, version), fields[2], registry);
  }

  /** Encodes the envelope through canonical tagged JSON. */
  toJSON(limits: ProtocolLimits): Uint8Array {
    return EncodeJSON(this.toValue(), limits);
  }

  /** Decodes canonical tagged JSON and validates the registry contract. */
  static fromJSON(bytes: Uint8Array, limits: ProtocolLimits, registry: ContractRegistry): ProtocolMessage {
    return ProtocolMessage.fromValue(DecodeJSON(bytes, limits), registry);
  }

  /** Encodes the envelope through canonical PVCE/1. */
  toPVCE(limits: ProtocolLimits): Uint8Array {
    return EncodePVCE(this.toValue());
  }

  /** Decodes canonical PVCE/1 and validates the registry contract. */
  static fromPVCE(bytes: Uint8Array, limits: ProtocolLimits, registry: ContractRegistry): ProtocolMessage {
    return ProtocolMessage.fromValue(DecodePVCE(bytes, defaultDecodeLimits()), registry);
  }
}

/** Requires the payload to be an Object whose first field is the exact contract schema (contract.rs:523-557). */
export function validateContractPayloadSchema(payload: PortableValue, contract: ContractId): void {
  if (payload.kind !== 'Object') {
    throw protocolError('WrongType', '$.payload', 'payload must be an Object');
  }
  const entries = payload.entries;
  if (entries.length === 0) {
    throw protocolError('MissingField', '$.payload.schema', 'payload schema is absent');
  }
  if (entries[0].key !== 'schema') {
    throw protocolError('SchemaMismatch', '$.payload', 'schema must be the first field');
  }
  const observed = stringOf(entries[0].value, '$.payload.schema');
  if (observed !== contractSchema(contract)) {
    throw protocolError('SchemaMismatch', '$.payload.schema', `expected ${contractSchema(contract)}`);
  }
}

/** Kept for API completeness: the semantic-model v7 is the current registry. */
export const CURRENT_CONTRACT_REGISTRY_VERSION: ContractRegistryVersion = 7;
