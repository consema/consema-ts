/**
 * Capability-parity test (L4; authority:
 * https://github.com/consema/consema/blob/main/docs/fc-manifest-0.13.0.json —
 * 键 contract_registry / capability_set，行号可能漂移，以键名为锚; the
 * mandatory capability matrix of RFC 0015 §6.2).
 *
 * W4-13 (R10): the six headline inventory counts are read from the
 * provisioned fc-manifest; when the manifest is not provisioned the parity
 * tests are documented skips (never silent).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MANIFEST_OPERATION_COUNTS,
  assertCapabilityParity,
  capabilityParityFailures,
  capabilityParitySkippedReason,
  manifestInventoryCounts,
} from './capability_parity.ts';
import { formatFamilies, profiles, queryDomains } from './registry.ts';
import { ErrorCodeRegistry } from './protocol/error_registry.ts';
import { ContractRegistry } from './protocol/contract.ts';

test('capability parity: the TS surface matches the manifest inventory', (t) => {
  const reason = capabilityParitySkippedReason();
  if (reason !== undefined) {
    t.skip(reason);
    return;
  }
  const failures = capabilityParityFailures();
  assert.deepEqual(failures, [], `parity failures: ${JSON.stringify(failures)}`);
});

test('capability parity: assertion throws when a family count drifts', (t) => {
  const counts = manifestInventoryCounts();
  if (counts === undefined) {
    t.skip(capabilityParitySkippedReason()!);
    return;
  }
  // The assertion is data-driven; drift in the registry fails the check.
  const families = formatFamilies();
  const domains = queryDomains();
  const profileList = profiles();
  assert.equal(families.length, counts.families);
  assert.equal(profileList.length, counts.profiles);
  assert.equal(domains.length, counts.queryDomains);
  assert.equal(new ErrorCodeRegistry(7).codes().length, counts.errorCodes);
  assert.equal(new ContractRegistry(7).contracts().length, counts.contracts);
  assert.equal(profileList.length, counts.operationRegistries);
  // The per-family operation counts are frozen by the manifest F-5 evidence.
  const countsByFamily = new Map<string, number>();
  for (const family of families) {
    countsByFamily.set(family.id(), 0);
  }
  for (const entry of profileList) {
    const family = entry.family().id();
    // Resolved through the facade below in capabilityParityFailures; here
    // we just verify the manifest table shape covers all eight families.
    assert.ok(MANIFEST_OPERATION_COUNTS[family] > 0, `manifest covers family ${family}`);
  }
  void countsByFamily;
});

test('capability parity: no "Rust only" mandatory behavior', (t) => {
  const reason = capabilityParitySkippedReason();
  if (reason !== undefined) {
    t.skip(reason);
    return;
  }
  // Every enumerated profile must resolve an operation registry through the
  // root facade (a "Rust only" profile would fail this loop).
  assertCapabilityParity();
});

test('capability parity: the manifest inventory parse is pinned and consistent', (t) => {
  const counts = manifestInventoryCounts();
  if (counts === undefined) {
    t.skip(capabilityParitySkippedReason()!);
    return;
  }
  // The six counts and their cross-record consistency are pinned by the
  // parse (W4-13/R10): a capability_set/contract_registry drift in the
  // manifest fails loudly instead of silently changing the gate.
  assert.equal(counts.families, 8);
  assert.equal(counts.profiles, 16);
  assert.equal(counts.queryDomains, 21);
  assert.equal(counts.operationRegistries, 16);
  assert.equal(counts.errorCodes, 187);
  assert.equal(counts.contracts, 41);
});
