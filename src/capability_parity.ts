/**
 * Capability-parity assertion (L4; mirror of the Go capability-parity gate,
 * docs/go-implementation-plan.md §6; authority:
 * docs/fc-manifest-0.13.0.json:31 capability_set — "8 families / 16
 * profiles / 21 query domains / 16 operation registries / 187 error
 * codes"; the per-family operation counts at fc-manifest-0.13.0.json F-5
 * ("json 8/toml 7/yaml 8/ini 8/properties 5/xml 8/plist 6/hcl 6"); the
 * contract counts at fc-manifest-0.13.0.json:26 (semantic-model v7:
 * 41 contracts / 187 error codes)).
 *
 * Every mandatory capability must have a TypeScript implementation: the
 * assertion drives each enumerated family/profile/query-domain/operation
 * registry through the root facade (`src/registry.ts`) and each code
 * through the v7 error-code registry, so a "Rust only" capability (one the
 * facade cannot resolve) fails here instead of passing silently.
 */

import { formatFamilies, profiles, queryDomains, formatOperationRegistry } from './registry.ts';
import { ContractRegistry } from './protocol/contract.ts';
import { ErrorCodeRegistry } from './protocol/error_registry.ts';

/** The frozen manifest inventory (fc-manifest-0.13.0.json:31, :26). */
export const MANIFEST_FAMILY_COUNT = 8;
export const MANIFEST_PROFILE_COUNT = 16;
export const MANIFEST_QUERY_DOMAIN_COUNT = 21;
export const MANIFEST_OPERATION_REGISTRY_COUNT = 16;
export const MANIFEST_ERROR_CODE_COUNT = 187;
export const MANIFEST_CONTRACT_COUNT = 41;

/** The per-family frozen operation counts (fc-manifest-0.13.0.json F-5). */
export const MANIFEST_OPERATION_COUNTS: Readonly<Record<string, number>> = Object.freeze({
  json: 8,
  toml: 7,
  yaml: 8,
  ini: 8,
  'java-properties': 5,
  xml: 8,
  plist: 6,
  hcl: 6,
});

/** One failed parity fact. */
export interface ParityFailure {
  readonly fact: string;
  readonly expected: string;
  readonly observed: string;
}

/**
 * Asserts the TS mandatory capability set against the manifest. Returns the
 * list of failures (empty when the TS surface is in parity).
 */
export function capabilityParityFailures(): ParityFailure[] {
  const failures: ParityFailure[] = [];
  const fail = (fact: string, expected: string, observed: string): void => {
    failures.push({ fact, expected, observed });
  };

  // 8 format families, each resolving its profile inventory.
  const families = formatFamilies();
  if (families.length !== MANIFEST_FAMILY_COUNT) {
    fail('families', String(MANIFEST_FAMILY_COUNT), String(families.length));
  }
  const expectedFamilies = ['hcl', 'ini', 'java-properties', 'json', 'plist', 'toml', 'xml', 'yaml'];
  for (const id of expectedFamilies) {
    if (!families.some((family) => family.id() === id)) {
      fail(`family ${id}`, 'registered', 'absent');
    }
  }

  // 16 profiles, each resolving an operation registry (no "Rust only" profile).
  const profileList = profiles();
  if (profileList.length !== MANIFEST_PROFILE_COUNT) {
    fail('profiles', String(MANIFEST_PROFILE_COUNT), String(profileList.length));
  }
  for (const entry of profileList) {
    const registry = formatOperationRegistry(entry.profile());
    if (registry === undefined) {
      fail(`operation registry for ${entry.profile().id()}`, 'registered', 'absent');
    }
  }

  // 21 query domains.
  const domains = queryDomains();
  if (domains.length !== MANIFEST_QUERY_DOMAIN_COUNT) {
    fail('query domains', String(MANIFEST_QUERY_DOMAIN_COUNT), String(domains.length));
  }

  // 16 operation registries (one per profile) and the per-family operation
  // counts of the F-5 evidence ("json 8/toml 7/yaml 8/ini 8/properties
  // 5/xml 8/plist 6/hcl 6"). The manifest count is the family's fullest
  // registry (hcl.native publishes six operations; hcl.tfvars publishes the
  // four tfvars ones, conformance/README.md:23), so each family must expose
  // at least one registry with exactly the manifest count.
  let registryCount = 0;
  const familyMax = new Map<string, number>();
  for (const entry of profileList) {
    const registry = formatOperationRegistry(entry.profile());
    if (registry === undefined) {
      continue;
    }
    registryCount += 1;
    const family = entry.family().id();
    const count = registry.operations().length;
    familyMax.set(family, Math.max(familyMax.get(family) ?? 0, count));
  }
  for (const [family, count] of familyMax) {
    const manifestCount = MANIFEST_OPERATION_COUNTS[family];
    if (manifestCount !== undefined && count !== manifestCount) {
      fail(`operations of family ${family}`, String(manifestCount), String(count));
    }
  }
  if (registryCount !== MANIFEST_OPERATION_REGISTRY_COUNT) {
    fail('operation registries', String(MANIFEST_OPERATION_REGISTRY_COUNT), String(registryCount));
  }

  // 187 error codes under semantic-model v7.
  const codes = new ErrorCodeRegistry(7).codes();
  if (codes.length !== MANIFEST_ERROR_CODE_COUNT) {
    fail('error codes (v7)', String(MANIFEST_ERROR_CODE_COUNT), String(codes.length));
  }

  // 41 contracts under semantic-model v7.
  const contracts = new ContractRegistry(7).contracts();
  if (contracts.length !== MANIFEST_CONTRACT_COUNT) {
    fail('contracts (v7)', String(MANIFEST_CONTRACT_COUNT), String(contracts.length));
  }

  return failures;
}

/**
 * Runs the parity assertion; throws with every failure listed when the TS
 * surface drifts from the manifest.
 */
export function assertCapabilityParity(): void {
  const failures = capabilityParityFailures();
  if (failures.length > 0) {
    const detail = failures
      .map((failure) => `  ${failure.fact}: expected ${failure.expected}, observed ${failure.observed}`)
      .join('\n');
    throw new Error(`capability parity with fc-manifest-0.13.0.json failed:\n${detail}`);
  }
}
