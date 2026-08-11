/**
 * Contract registry intent tests.
 *
 * These pin the frozen semantic-model v1-v7 contract sets (16/18/25/25/30/38/41
 * records) transcribed from crates/consema-protocol/src/contract.rs:71-273
 * (go/protocol/contract.go:289-473, cross-reference). They run once the
 * toolchain is ready; no gate is claimed before that (§7 START GATE).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ContractRegistry, newContractId, ProtocolMessage, ProtocolMessageSchema } from './contract.ts';
import type { PortableValue } from '../core/value.ts';
import { defaultProtocolLimits } from './limits.ts';
import { Completion } from './records_execution.ts';
import { equal as coreEqual } from '../core/equal.ts';

/** One valid `core.completion@1` payload for the envelope tests. */
function completionPayload(): PortableValue {
  return Completion.new('Success', 0n, 0n, null, null).toValue();
}

const V7 = new ContractRegistry(7);

function ids(version: ContractRegistryVersionLike): string[] {
  return new ContractRegistry(version).contracts().map((descriptor) => `${descriptor.id}@${descriptor.version}`);
}

test('the contract registry pins the v1-v7 counts 16/18/25/25/30/38/41', () => {
  assert.equal(ids(1).length, 16);
  assert.equal(ids(2).length, 18);
  assert.equal(ids(3).length, 25);
  assert.equal(ids(4).length, 25);
  assert.equal(ids(5).length, 30);
  assert.equal(ids(6).length, 38);
  assert.equal(ids(7).length, 41);
});

test('registry records are strictly sorted by (id, version)', () => {
  for (const version of [1, 2, 3, 4, 5, 6, 7] as const) {
    const records = new ContractRegistry(version).contracts();
    for (let i = 1; i < records.length; i++) {
      const previous = records[i - 1];
      const current = records[i];
      const order =
        previous.id !== current.id
          ? previous.id < current.id
            ? -1
            : 1
          : previous.version < current.version
            ? -1
            : previous.version > current.version
              ? 1
              : 0;
      assert.ok(order < 0, `records must be sorted at ${version}`);
    }
  }
});

test('v7 contains the eleven v1 records and the v7 additions', () => {
  const v1 = new Set(ids(1));
  const v7 = new Set(ids(7));
  for (const record of v1) {
    assert.ok(v7.has(record), `v7 must contain ${record}`);
  }
  assert.ok(v7.has('core.cli-output@1'));
  assert.ok(v7.has('core.batch-plan@1'));
  assert.ok(v7.has('core.batch-result@1'));
});

test('the v7 record list matches the frozen sequence', () => {
  // Transcribed verbatim from go/protocol/contract.go:431-473.
  assert.deepEqual(ids(7), [
    'core.batch-plan@1',
    'core.batch-result@1',
    'core.cancellation-request@1',
    'core.capability-declaration@1',
    'core.change-set@1',
    'core.cli-output@1',
    'core.completion@1',
    'core.conversion-report@1',
    'core.diagnostic@1',
    'core.edit-plan@1',
    'core.error-code-registry@1',
    'core.execution-policy@1',
    'core.format-operation-registry@1',
    'core.graph-projection-result@1',
    'core.graph-provenance-map@1',
    'core.graph-query-result@1',
    'core.ini-query-result@1',
    'core.java-properties-query-result@1',
    'core.java-utf16-string@1',
    'core.materialization-provenance-map@1',
    'core.materialization-report@1',
    'core.materialization-request@1',
    'core.materialization-request@2',
    'core.materialization-result@1',
    'core.materialization-result@2',
    'core.portable-graph@1',
    'core.profile-descriptor@1',
    'core.projection-report@1',
    'core.projection-request@1',
    'core.projection-result@1',
    'core.protocol-message@1',
    'core.provenance-map@1',
    'core.query-definition@1',
    'core.query-result@1',
    'core.registry-manifest@1',
    'core.source-encoding@1',
    'core.source-patch@1',
    'core.source-patch@2',
    'core.source-snapshot@1',
    'core.source-snapshot@2',
    'core.yaml-query-result@1',
  ]);
});

test('core.protocol-message@1 is the only Transport contract in v1', () => {
  const transports = new ContractRegistry(1)
    .contracts()
    .filter((descriptor) => descriptor.stability === 'Transport');
  assert.deepEqual(transports.map((descriptor) => descriptor.id), ['core.protocol-message']);
});

test('descriptor lookup and recognition are exact', () => {
  const descriptor = V7.descriptor(newContractId('core.cli-output', 1));
  assert.ok(descriptor);
  assert.equal(descriptor.id, 'core.cli-output');
  assert.equal(descriptor.version, 1);
  assert.equal(descriptor.stability, 'Stable');
  assert.equal(V7.recognizes(newContractId('core.cli-output', 1)), true);
  assert.equal(V7.recognizes(newContractId('core.cli-output', 2)), false);
  assert.equal(V7.recognizes(newContractId('core.nonexistent', 1)), false);
});

test('the protocol envelope round-trips through the value level', () => {
  const message = new ProtocolMessage(newContractId('core.completion', 1), completionPayload(), V7);
  const value = message.toValue();
  const decoded = ProtocolMessage.fromValue(value, V7);
  assert.equal(decoded.contract.id, 'core.completion');
  assert.equal(decoded.contract.version, 1);
  assert.equal(coreEqual(decoded.payload, message.payload), true);
  assert.equal(ProtocolMessageSchema, 'core.protocol-message@1');
});

test('unknown contracts and transport nesting are rejected', () => {
  assert.throws(
    () => new ProtocolMessage(newContractId('core.unknown', 1), { kind: 'Object', entries: [] }, V7),
    (error: unknown) => (error as { code: string }).code === 'core.protocol.unknown-contract@1',
  );
  // The transport envelope itself cannot be a payload contract.
  assert.throws(
    () =>
      new ProtocolMessage(
        newContractId('core.protocol-message', 1),
        { kind: 'Object', entries: [] },
        V7,
      ),
    (error: unknown) => (error as { code: string }).code === 'core.protocol.invalid-value@1',
  );
});

test('the envelope transports through canonical JSON and PVCE', () => {
  const message = new ProtocolMessage(newContractId('core.completion', 1), completionPayload(), V7);
  const limits = defaultProtocolLimits();
  const json = message.toJSON(limits);
  assert.equal(ProtocolMessage.fromJSON(json, limits, V7).contract.id, 'core.completion');
  const pvce = message.toPVCE(limits);
  assert.equal(ProtocolMessage.fromPVCE(pvce, limits, V7).contract.id, 'core.completion');
  // The envelope's contract_version leaf is an Integer.
  const payload = message.toValue();
  assert.equal(payload.entries[2].value.kind, 'Integer');
});

type ContractRegistryVersionLike = 1 | 2 | 3 | 4 | 5 | 6 | 7;
