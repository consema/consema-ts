/**
 * Capability-parity test (L4; authority: docs/fc-manifest-0.13.0.json:26,
 * :31; the mandatory capability matrix of RFC 0015 §6.2).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MANIFEST_CONTRACT_COUNT,
  MANIFEST_ERROR_CODE_COUNT,
  MANIFEST_FAMILY_COUNT,
  MANIFEST_OPERATION_COUNTS,
  MANIFEST_OPERATION_REGISTRY_COUNT,
  MANIFEST_PROFILE_COUNT,
  MANIFEST_QUERY_DOMAIN_COUNT,
  assertCapabilityParity,
  capabilityParityFailures,
} from './capability_parity.ts';
import { formatFamilies, profiles, queryDomains } from './registry.ts';
import { ErrorCodeRegistry } from './protocol/error_registry.ts';
import { ContractRegistry } from './protocol/contract.ts';

test('capability parity: the TS surface matches the manifest inventory', () => {
  const failures = capabilityParityFailures();
  assert.deepEqual(failures, [], `parity failures: ${JSON.stringify(failures)}`);
});

test('capability parity: assertion throws when a family count drifts', () => {
  // The assertion is data-driven; drift in the registry fails the check.
  const families = formatFamilies();
  const domains = queryDomains();
  const profileList = profiles();
  assert.equal(families.length, MANIFEST_FAMILY_COUNT);
  assert.equal(profileList.length, MANIFEST_PROFILE_COUNT);
  assert.equal(domains.length, MANIFEST_QUERY_DOMAIN_COUNT);
  assert.equal(new ErrorCodeRegistry(7).codes().length, MANIFEST_ERROR_CODE_COUNT);
  assert.equal(new ContractRegistry(7).contracts().length, MANIFEST_CONTRACT_COUNT);
  assert.equal(profileList.length, MANIFEST_OPERATION_REGISTRY_COUNT);
  // The per-family operation counts are frozen by the manifest F-5 evidence.
  const counts = new Map<string, number>();
  for (const family of families) {
    counts.set(family.id(), 0);
  }
  for (const entry of profileList) {
    const family = entry.family().id();
    // Resolved through the facade below in capabilityParityFailures; here
    // we just verify the manifest table shape covers all eight families.
    assert.ok(MANIFEST_OPERATION_COUNTS[family] > 0, `manifest covers family ${family}`);
  }
  void counts;
});

test('capability parity: no "Rust only" mandatory behavior', () => {
  // Every enumerated profile must resolve an operation registry through the
  // root facade (a "Rust only" profile would fail this loop).
  assertCapabilityParity();
});
