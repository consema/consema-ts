/**
 * The transferable Profile and Capability registry records.
 *
 * authority: crates/consema-protocol/src/registry.rs (profile-descriptor@1,
 * capability-declaration@1, registry-manifest@1); the namespace rule at
 * registry.rs:475-498; consema-core capability.rs:7-96 (CapabilityId,
 * ImplementationSupport, VerificationStatus). The vectors pin the records in
 * conformance/vectors/protocol-v1.json (protocol.profile.roundtrip,
 * protocol.capability.conditional-roundtrip,
 * protocol.capability.reject-contradiction).
 */

import type { PortableValue, ObjectValue } from '../core/value.ts';
import { validateIdentifier, validateNamespace } from './contract.ts';
import {
  exactFields,
  schemaFields,
  stringOf,
  unsigned32,
  sequenceOf,
  referenceValue,
  parseReference,
} from './records.ts';
import { invalid } from './errors.ts';
import { stringMapObject, stringMapFromObject } from './string_map.ts';
import { wireNull } from './canonical.ts';
import type { ContractRegistryVersion } from './registry_types.ts';
import { ContractRegistry } from './contract.ts';
import { ErrorCodeRegistry } from './error_registry.ts';
import type { DiagnosticCategory } from './error_registry.ts';

/** A versioned reference to a Profile, whose ID may be a single namespace. */
export interface ProfileReference {
  readonly id: string;
  readonly version: number;
}

/** Validates and creates a profile reference. */
export function newProfileReference(id: string, version: number): ProfileReference {
  if (version === 0) {
    throw invalid('$.version', 'version must be non-zero');
  }
  validateNamespace(id, false, '$.id');
  return { id, version };
}

/** An immutable language profile registry descriptor (registry.rs:48-250). */
export interface ProfileDescriptor {
  readonly formatFamilyId: string;
  readonly formatFamilyVersion: number;
  readonly profileId: string;
  readonly profileVersion: number;
  readonly baseProfile?: ProfileReference;
  /** Sorted stable difference identifiers. */
  readonly differences: readonly string[];
  /** Sorted required capabilities. */
  readonly requiredCapabilities: readonly CapabilityId[];
}

/** Creates a normalized descriptor and rejects malformed or duplicate facts (registry.rs:60-114). */
export function newProfileDescriptor(
  formatFamilyId: string,
  formatFamilyVersion: number,
  profileId: string,
  profileVersion: number,
  baseProfile: ProfileReference | undefined,
  differences: readonly string[],
  requiredCapabilities: readonly CapabilityId[],
): ProfileDescriptor {
  validateNamespace(formatFamilyId, false, '$.format_family_id');
  validateNamespace(profileId, true, '$.profile_id');
  if (formatFamilyVersion === 0 || profileVersion === 0) {
    throw invalid('$', 'family and profile versions must be non-zero');
  }
  for (const difference of differences) {
    validateNamespace(difference, true, '$.differences');
  }
  for (const capability of requiredCapabilities) {
    validateIdentifier(capability.namespace, '$.required_capabilities');
  }
  const sortedDifferences = [...differences].sort();
  for (let i = 1; i < sortedDifferences.length; i++) {
    if (sortedDifferences[i - 1] === sortedDifferences[i]) {
      throw invalid('$.differences', 'difference IDs must be unique');
    }
  }
  const sortedCapabilities = [...requiredCapabilities].sort(compareCapabilityIds);
  for (let i = 1; i < sortedCapabilities.length; i++) {
    if (compareCapabilityIds(sortedCapabilities[i - 1], sortedCapabilities[i]) === 0) {
      throw invalid('$.required_capabilities', 'capability IDs must be unique');
    }
  }
  return {
    formatFamilyId,
    formatFamilyVersion,
    profileId,
    profileVersion,
    ...(baseProfile !== undefined ? { baseProfile } : {}),
    differences: sortedDifferences,
    requiredCapabilities: sortedCapabilities,
  };
}

/** Encodes `core.profile-descriptor@1` (registry.rs:158-201). */
export function profileDescriptorToValue(descriptor: ProfileDescriptor): ObjectValue {
  const baseProfile = descriptor.baseProfile !== undefined
    ? referenceValue(descriptor.baseProfile.id, descriptor.baseProfile.version)
    : wireNull();
  return objectValueFrom([
    { key: 'schema', value: { kind: 'String', value: 'core.profile-descriptor@1' } },
    { key: 'format_family_id', value: { kind: 'String', value: descriptor.formatFamilyId } },
    { key: 'format_family_version', value: { kind: 'Integer', value: BigInt(descriptor.formatFamilyVersion) } },
    { key: 'profile_id', value: { kind: 'String', value: descriptor.profileId } },
    { key: 'profile_version', value: { kind: 'Integer', value: BigInt(descriptor.profileVersion) } },
    { key: 'base_profile', value: baseProfile },
    {
      key: 'differences',
      value: { kind: 'Sequence', items: descriptor.differences.map((d) => ({ kind: 'String', value: d })) },
    },
    {
      key: 'required_capabilities',
      value: {
        kind: 'Sequence',
        items: descriptor.requiredCapabilities.map((c) => referenceValue(c.namespace, c.version)),
      },
    },
  ]);
}

/** Strictly decodes `core.profile-descriptor@1` (registry.rs:203-249). */
export function profileDescriptorFromValue(value: PortableValue): ProfileDescriptor {
  const fields = schemaFields(
    value,
    'core.profile-descriptor@1',
    ['format_family_id', 'format_family_version', 'profile_id', 'profile_version', 'base_profile', 'differences', 'required_capabilities'],
    '$',
  );
  const formatFamilyId = stringOf(fields[0], '$.format_family_id');
  const formatFamilyVersion = unsigned32(fields[1], '$.format_family_version');
  const profileId = stringOf(fields[2], '$.profile_id');
  const profileVersion = unsigned32(fields[3], '$.profile_version');
  let baseProfile: ProfileReference | undefined;
  if (fields[4].kind !== 'Null') {
    baseProfile = parseProfileReference(fields[4], '$.base_profile');
  }
  const differenceValues = sequenceOf(fields[5], '$.differences');
  const differences = differenceValues.map((item, index) => stringOf(item, `$.differences[${index}]`));
  const capabilityValues = sequenceOf(fields[6], '$.required_capabilities');
  const capabilities = capabilityValues.map((item, index) => {
    const parsed = parseReference(item, `$.required_capabilities[${index}]`);
    return newCapabilityId(parsed.id, parsed.version);
  });
  return newProfileDescriptor(
    formatFamilyId,
    formatFamilyVersion,
    profileId,
    profileVersion,
    baseProfile,
    differences,
    capabilities,
  );
}

function parseProfileReference(value: PortableValue, path: string): ProfileReference {
  const fields = exactFields(value, ['id', 'version'], path);
  const id = stringOf(fields[0], `${path}.id`);
  const version = unsigned32(fields[1], `${path}.version`);
  return newProfileReference(id, version);
}

/** A stable namespaced capability contract (consema-core capability.rs:7-28). */
export interface CapabilityId {
  readonly namespace: string;
  readonly version: number;
}

export function newCapabilityId(namespace: string, version: number): CapabilityId {
  return { namespace, version };
}

/** Orders capability ids by (namespace, version). */
export function compareCapabilityIds(a: CapabilityId, b: CapabilityId): number {
  if (a.namespace !== b.namespace) {
    return a.namespace < b.namespace ? -1 : 1;
  }
  if (a.version < b.version) {
    return -1;
  }
  if (a.version > b.version) {
    return 1;
  }
  return 0;
}

/** A deterministic set of capabilities available to an operation (capability.rs:59-96). */
export class CapabilitySet {
  private readonly capabilities = new Map<string, CapabilityId>();

  /** Adds a capability and reports whether it was newly added. */
  insert(capability: CapabilityId): boolean {
    const key = `${capability.namespace}@${capability.version}`;
    if (this.capabilities.has(key)) {
      return false;
    }
    this.capabilities.set(key, capability);
    return true;
  }

  /** Reports whether a capability is available. */
  contains(capability: CapabilityId): boolean {
    return this.capabilities.has(`${capability.namespace}@${capability.version}`);
  }

  /** Visits the capabilities in stable identifier order. */
  iterate(visit: (capability: CapabilityId) => void): void {
    const sorted = [...this.capabilities.values()].sort(compareCapabilityIds);
    for (const capability of sorted) {
      visit(capability);
    }
  }
}

/** The closed support kind of one capability (capability.rs:30-43). */
export type SupportKind = 'Conformant' | 'Conditional' | 'Unsupported';

/** One machine-readable conditional-support precondition. */
export interface Precondition {
  readonly key: string;
  readonly value: string;
}

/** The declared support state of one capability. */
export interface ImplementationSupport {
  readonly kind: SupportKind;
  /** The preconditions of Conditional support, in sorted key order. */
  readonly preconditions: readonly Precondition[];
}

/** How capability support was verified (capability.rs:45-56). */
export type VerificationStatus = 'Verified' | 'SelfDeclared' | 'Unverified';

/** Parses one canonical verification spelling. */
export function parseVerificationStatus(name: string): VerificationStatus {
  switch (name) {
    case 'Verified':
    case 'SelfDeclared':
    case 'Unverified':
      return name;
    default:
      throw invalid('$.verification', 'unknown verification status');
  }
}

/** One implementation's support and verification claim for a capability (registry.rs:252-439). */
export interface CapabilityDeclaration {
  readonly capability: CapabilityId;
  readonly support: ImplementationSupport;
  readonly verification: VerificationStatus;
  readonly suiteId?: string;
}

/** Validates the cross-field support and verification invariants (registry.rs:262-315). */
export function newCapabilityDeclaration(
  capability: CapabilityId,
  support: ImplementationSupport,
  verification: VerificationStatus,
  suiteId: string | undefined,
): CapabilityDeclaration {
  validateIdentifier(capability.namespace, '$');
  if (support.kind === 'Conditional' && support.preconditions.length === 0) {
    throw invalid('$.preconditions', 'Conditional support requires preconditions');
  }
  if (support.kind !== 'Conditional' && support.preconditions.length !== 0) {
    throw invalid('$.preconditions', 'only Conditional support may carry preconditions');
  }
  const seen = new Set<string>();
  for (const precondition of support.preconditions) {
    if (seen.has(precondition.key)) {
      throw invalid('$.preconditions', 'precondition keys must be unique');
    }
    seen.add(precondition.key);
  }
  if (verification === 'Verified') {
    if (suiteId === undefined) {
      throw invalid('$.suite_id', 'Verified requires a suite ID');
    }
    validateNamespace(suiteId, true, '$.suite_id');
  } else if (suiteId !== undefined) {
    throw invalid('$.suite_id', 'only Verified may name a suite');
  }
  return {
    capability,
    support: { kind: support.kind, preconditions: [...support.preconditions] },
    verification,
    ...(suiteId !== undefined ? { suiteId } : {}),
  };
}

/** Encodes `core.capability-declaration@1` (registry.rs:341-379). */
export function capabilityDeclarationToValue(declaration: CapabilityDeclaration): ObjectValue {
  const preconditions = new Map<string, string>();
  if (declaration.support.kind === 'Conditional') {
    for (const precondition of declaration.support.preconditions) {
      preconditions.set(precondition.key, precondition.value);
    }
  }
  return objectValueFrom([
    { key: 'schema', value: { kind: 'String', value: 'core.capability-declaration@1' } },
    { key: 'capability_id', value: { kind: 'String', value: declaration.capability.namespace } },
    { key: 'capability_version', value: { kind: 'Integer', value: BigInt(declaration.capability.version) } },
    { key: 'support', value: { kind: 'String', value: declaration.support.kind } },
    { key: 'preconditions', value: stringMapObject(preconditions) },
    { key: 'verification', value: { kind: 'String', value: declaration.verification } },
    {
      key: 'suite_id',
      value: declaration.suiteId !== undefined
        ? { kind: 'String', value: declaration.suiteId }
        : wireNull(),
    },
  ]);
}

/** Strictly decodes `core.capability-declaration@1` (registry.rs:381-438). */
export function capabilityDeclarationFromValue(value: PortableValue): CapabilityDeclaration {
  const fields = schemaFields(
    value,
    'core.capability-declaration@1',
    ['capability_id', 'capability_version', 'support', 'preconditions', 'verification', 'suite_id'],
    '$',
  );
  const capabilityId = stringOf(fields[0], '$.capability_id');
  const capabilityVersion = unsigned32(fields[1], '$.capability_version');
  const supportText = stringOf(fields[2], '$.support');
  if (supportText !== 'Conformant' && supportText !== 'Conditional' && supportText !== 'Unsupported') {
    throw invalid('$.support', 'unknown support kind');
  }
  const preconditionsMap = stringMapFromObject(fields[3], '$.preconditions');
  const preconditions: Precondition[] = [...preconditionsMap.entries()].map(([key, value]) => ({ key, value }));
  const verification = parseVerificationStatus(stringOf(fields[4], '$.verification'));
  let suiteId: string | undefined;
  if (fields[5].kind !== 'Null') {
    suiteId = stringOf(fields[5], '$.suite_id');
  }
  return newCapabilityDeclaration(
    newCapabilityId(capabilityId, capabilityVersion),
    { kind: supportText, preconditions },
    verification,
    suiteId,
  );
}

/** One contract entry of a `core.registry-manifest@1` record. */
export interface ContractManifestEntry {
  readonly contract: ContractIdLike;
  readonly stability: 'Stable' | 'Transport';
}

/** Minimal contract-identity shape used by manifest entries. */
export interface ContractIdLike {
  readonly id: string;
  readonly version: number;
}

/** One error-code entry of a `core.registry-manifest@1` record. */
export interface ErrorCodeManifestEntry {
  readonly code: string;
  readonly category: DiagnosticCategory;
  readonly introduced: string;
  readonly description: string;
}

/** The `core.registry-manifest@1` record of one semantic model (registry.rs). */
export interface RegistryManifest {
  readonly semanticModel: ContractIdLike;
  readonly contracts: readonly ContractManifestEntry[];
  readonly errorCodes: readonly ErrorCodeManifestEntry[];
}

/** Builds a manifest from one semantic-model version. */
export function newRegistryManifest(
  semanticModelVersion: number,
  contractRegistry: ContractRegistry,
  errorCodeRegistry: ErrorCodeRegistry,
): RegistryManifest {
  const semanticModel = {
    id: 'core.semantic-model',
    version: semanticModelVersion,
  };
  const contracts: ContractManifestEntry[] = contractRegistry.contracts().map((descriptor) => ({
    contract: { id: descriptor.id, version: descriptor.version },
    stability: descriptor.stability,
  }));
  const errorCodes: ErrorCodeManifestEntry[] = errorCodeRegistry.codes().map((descriptor) => ({
    code: descriptor.code,
    category: descriptor.category,
    introduced: descriptor.introduced,
    description: descriptor.description,
  }));
  return { semanticModel, contracts, errorCodes };
}

/** The current semantic-model v7 manifest. */
export function currentRegistryManifest(): RegistryManifest {
  return newRegistryManifest(7, new ContractRegistry(7), new ErrorCodeRegistry(7));
}

/** Encodes the `core.registry-manifest@1` record. */
export function registryManifestToValue(manifest: RegistryManifest): ObjectValue {
  const contracts = manifest.contracts.map((entry) =>
    objectValueFrom([
      { key: 'id', value: { kind: 'String', value: entry.contract.id } },
      { key: 'version', value: { kind: 'Integer', value: BigInt(entry.contract.version) } },
      { key: 'stability', value: { kind: 'String', value: entry.stability } },
    ]),
  );
  const errorCodes = manifest.errorCodes.map((entry) =>
    objectValueFrom([
      { key: 'code', value: { kind: 'String', value: entry.code } },
      { key: 'category', value: { kind: 'String', value: entry.category } },
      { key: 'introduced', value: { kind: 'String', value: entry.introduced } },
      { key: 'stability', value: { kind: 'String', value: 'Stable' } },
      { key: 'description', value: { kind: 'String', value: entry.description } },
    ]),
  );
  return objectValueFrom([
    { key: 'schema', value: { kind: 'String', value: 'core.registry-manifest@1' } },
    { key: 'semantic_model', value: referenceValue(manifest.semanticModel.id, manifest.semanticModel.version) },
    { key: 'contracts', value: { kind: 'Sequence', items: contracts } },
    { key: 'error_codes', value: { kind: 'Sequence', items: errorCodes } },
  ]);
}

/** Strictly decodes the `core.registry-manifest@1` record. */
export function registryManifestFromValue(value: PortableValue): RegistryManifest {
  const fields = schemaFields(
    value,
    'core.registry-manifest@1',
    ['semantic_model', 'contracts', 'error_codes'],
    '$',
  );
  const semanticModel = parseReference(fields[0], '$.semantic_model');
  const contractValues = sequenceOf(fields[1], '$.contracts');
  const contracts: ContractManifestEntry[] = contractValues.map((item, index) => {
    const entry = exactFields(item, ['id', 'version', 'stability'], `$.contracts[${index}]`);
    const id = stringOf(entry[0], `$.contracts[${index}].id`);
    const version = unsigned32(entry[1], `$.contracts[${index}].version`);
    const stability = stringOf(entry[2], `$.contracts[${index}].stability`);
    if (stability !== 'Stable' && stability !== 'Transport') {
      throw invalid(`$.contracts[${index}].stability`, 'unknown contract stability');
    }
    return { contract: { id, version }, stability };
  });
  const codeValues = sequenceOf(fields[2], '$.error_codes');
  const errorCodes: ErrorCodeManifestEntry[] = codeValues.map((item, index) => {
    const entry = exactFields(
      item,
      ['code', 'category', 'introduced', 'stability', 'description'],
      `$.error_codes[${index}]`,
    );
    const code = stringOf(entry[0], `$.error_codes[${index}].code`);
    const category = parseDiagnosticCategorySafe(stringOf(entry[1], `$.error_codes[${index}].category`));
    const introduced = stringOf(entry[2], `$.error_codes[${index}].introduced`);
    const stability = stringOf(entry[3], `$.error_codes[${index}].stability`);
    const description = stringOf(entry[4], `$.error_codes[${index}].description`);
    if (stability !== 'Stable') {
      throw invalid(`$.error_codes[${index}].stability`, 'unknown error-code stability');
    }
    return { code, category, introduced, description };
  });
  return { semanticModel, contracts, errorCodes };
}

function parseDiagnosticCategorySafe(name: string): DiagnosticCategory {
  switch (name) {
    case 'Lexical':
    case 'Syntax':
    case 'Conformance':
    case 'Semantic':
    case 'Query':
    case 'Projection':
    case 'Materialization':
    case 'Conversion':
    case 'Edit':
    case 'Resource':
    case 'Encoding':
      return name;
    default:
      throw invalid('$.error_codes[].category', 'unknown error-code category');
  }
}

/** Builds a unique-key Object from pre-validated entries. */
function objectValueFrom(entries: { key: string; value: PortableValue }[]): ObjectValue {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.key)) {
      throw new Error(`internal: duplicate record field ${entry.key}`);
    }
    seen.add(entry.key);
  }
  return { kind: 'Object', entries: entries.map((entry) => ({ key: entry.key, value: entry.value })) };
}

/** Narrowing helper for registry version selection. */
export function isContractRegistryVersion(version: number): version is ContractRegistryVersion {
  return version >= 1 && version <= 7;
}
