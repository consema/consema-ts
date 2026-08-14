/**
 * Capability-parity assertion (L4; mirror of the Go capability-parity gate,
 * https://github.com/consema/consema/blob/main/docs/go-implementation-plan.md §6; authority:
 * https://github.com/consema/consema/blob/main/docs/fc-manifest-0.13.0.json — 键 capability_set（"8 families / 16
 * profiles / 21 query domains / 16 operation registries / 187 error
 * codes"；行号可能漂移，以键名为锚）；the per-family operation counts at
 * fc-manifest-0.13.0.json F-5 evidence
 * ("json 8/toml 7/yaml 8/ini 8/properties 5/xml 8/plist 6/hcl 6"); the
 * contract counts at 键 contract_registry（semantic-model v7:
 * 41 contracts / 187 error codes)).
 *
 * Every mandatory capability must have a TypeScript implementation: the
 * assertion drives each enumerated family/profile/query-domain/operation
 * registry through the root facade (`src/registry.ts`) and each code
 * through the v7 error-code registry, so a "Rust only" capability (one the
 * facade cannot resolve) fails here instead of passing silently.
 *
 * W4-13 (R10): the six headline inventory counts are read from the
 * provisioned fc-manifest (conformance/fc-manifest-0.13.0.json,
 * provisioned beside the vectors) at assertion time — the manifest is the
 * single authority. A hardcoded literal snapshot would go unnoticed when
 * the manifest inventory changes (the exact failure mode this gate exists
 * to catch). When the manifest is not provisioned the test is a documented
 * skip (never silent); a present-but-malformed manifest fails loudly.
 */

import { formatFamilies, profiles, queryDomains, formatOperationRegistry } from './registry.ts';
import { ContractRegistry } from './protocol/contract.ts';
import { ErrorCodeRegistry } from './protocol/error_registry.ts';
import { loadManifestRecord } from './conformance/runner.ts';

/** The frozen manifest inventory counts (fc-manifest-0.13.0.json — 键
 * capability_set / contract_registry, parsed from the pinned value
 * spellings). */
export interface ManifestInventoryCounts {
  readonly families: number;
  readonly profiles: number;
  readonly queryDomains: number;
  readonly operationRegistries: number;
  readonly errorCodes: number;
  readonly contracts: number;
}

/**
 * Reads the six frozen inventory counts from the provisioned fc-manifest.
 * Returns undefined when the manifest is not provisioned (documented skip);
 * a present-but-malformed manifest, or a value spelling that no longer
 * matches the pinned parse, fails loudly — never silently.
 */
export function manifestInventoryCounts(): ManifestInventoryCounts | undefined {
  const manifest = loadManifestRecord();
  if (manifest === undefined) {
    return undefined;
  }
  const digests = manifest.digests as {
    capability_set?: { value?: unknown };
    contract_registry?: { value?: unknown };
  };
  const capability = digests?.capability_set;
  const contracts = digests?.contract_registry;
  const capabilityText = capability?.value;
  const contractText = contracts?.value;
  if (typeof capabilityText !== 'string' || typeof contractText !== 'string') {
    throw new Error('fc-manifest-0.13.0.json: capability_set / contract_registry value records missing or malformed');
  }
  const capabilityMatch =
    /^(\d+) families \/ (\d+) profiles \/ (\d+) query domains \/ (\d+) operation registries \/ (\d+) error codes$/.exec(
      capabilityText,
    );
  const contractMatch = /^semantic-model v\d+：(\d+) 条 contract \/ (\d+) 个 error code$/.exec(contractText);
  if (capabilityMatch === null || contractMatch === null) {
    throw new Error(
      'fc-manifest-0.13.0.json: capability_set / contract_registry value spelling changed (the parse is pinned to the frozen spelling; update the pin with the manifest)',
    );
  }
  const errorCodes = Number(capabilityMatch[5]);
  if (errorCodes !== Number(contractMatch[2])) {
    throw new Error(
      `fc-manifest-0.13.0.json: capability_set error codes (${errorCodes}) disagree with contract_registry (${contractMatch[2]})`,
    );
  }
  return {
    families: Number(capabilityMatch[1]),
    profiles: Number(capabilityMatch[2]),
    queryDomains: Number(capabilityMatch[3]),
    operationRegistries: Number(capabilityMatch[4]),
    errorCodes,
    contracts: Number(contractMatch[1]),
  };
}

/** The documented-skip reason when the fc-manifest is not provisioned
 * (W4-13/R10); undefined when the parity check can run. */
export function capabilityParitySkippedReason(): string | undefined {
  if (loadManifestRecord() === undefined) {
    return 'fc-manifest-0.13.0.json is not provisioned (run the conformance provision step): capability parity is a documented skip';
  }
  return undefined;
}

/** The per-family frozen operation counts (fc-manifest-0.13.0.json F-5
 * evidence prose — not machine-readable in the manifest; transcribed
 * verbatim, drift of these counts fails here). */
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
 * list of failures (empty when the TS surface is in parity). Throws when
 * the fc-manifest is not provisioned — the caller must check
 * capabilityParitySkippedReason() first (documented skip, never silent).
 */
export function capabilityParityFailures(): ParityFailure[] {
  const counts = manifestInventoryCounts();
  if (counts === undefined) {
    throw new Error(
      'capability parity: fc-manifest-0.13.0.json is not provisioned — this check must be a documented skip (never silent)',
    );
  }
  const failures: ParityFailure[] = [];
  const fail = (fact: string, expected: string, observed: string): void => {
    failures.push({ fact, expected, observed });
  };

  // 8 format families, each resolving its profile inventory.
  const families = formatFamilies();
  if (families.length !== counts.families) {
    fail('families', String(counts.families), String(families.length));
  }
  const expectedFamilies = ['hcl', 'ini', 'java-properties', 'json', 'plist', 'toml', 'xml', 'yaml'];
  for (const id of expectedFamilies) {
    if (!families.some((family) => family.id() === id)) {
      fail(`family ${id}`, 'registered', 'absent');
    }
  }

  // 16 profiles, each resolving an operation registry (no "Rust only" profile).
  const profileList = profiles();
  if (profileList.length !== counts.profiles) {
    fail('profiles', String(counts.profiles), String(profileList.length));
  }
  for (const entry of profileList) {
    const registry = formatOperationRegistry(entry.profile());
    if (registry === undefined) {
      fail(`operation registry for ${entry.profile().id()}`, 'registered', 'absent');
    }
  }

  // 21 query domains.
  const domains = queryDomains();
  if (domains.length !== counts.queryDomains) {
    fail('query domains', String(counts.queryDomains), String(domains.length));
  }

  // 16 operation registries (one per profile) and the per-family operation
  // counts of the F-5 evidence ("json 8/toml 7/yaml 8/ini 8/properties
  // 5/xml 8/plist 6/hcl 6"). The manifest count is the family's fullest
  // registry (hcl.native publishes six operations; hcl.tfvars publishes the
  // four tfvars ones, conformance/README.md hcl-v1.json 套件条目「六类
  // （tfvars 四类）edit」——行号可能漂移，以套件条目为锚), so each family
  // must expose at least one registry with exactly the manifest count.
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
  if (registryCount !== counts.operationRegistries) {
    fail('operation registries', String(counts.operationRegistries), String(registryCount));
  }

  // 187 error codes under semantic-model v7.
  const codes = new ErrorCodeRegistry(7).codes();
  if (codes.length !== counts.errorCodes) {
    fail('error codes (v7)', String(counts.errorCodes), String(codes.length));
  }

  // 41 contracts under semantic-model v7.
  const contracts = new ContractRegistry(7).contracts();
  if (contracts.length !== counts.contracts) {
    fail('contracts (v7)', String(counts.contracts), String(contracts.length));
  }

  return failures;
}

/**
 * Runs the parity assertion; throws with every failure listed when the TS
 * surface drifts from the manifest (or when the manifest is not
 * provisioned — check capabilityParitySkippedReason() first).
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
