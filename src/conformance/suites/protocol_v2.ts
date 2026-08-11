/**
 * `consema.protocol.conformance@2` runner (11 cases; mirror of
 * crates/consema-conformance/src/protocol_v2.rs).
 *
 * The transferable snapshot/patch cases exercise the wire records
 * (src/protocol/records_source.ts, mirror of
 * crates/consema-protocol/src/source.rs) through the v2 envelope closure:
 * ProtocolMessage toJSON/fromJSON and toPVCE/fromPVCE, with message equality
 * over contract + payload. The forged-fact and resource-limit cases decode
 * the record directly with tightened limits, exactly like the Rust runner
 * (protocol_v2.rs:239-297).
 */

import type { VectorCase } from '../helpers.ts';
import { bytesEqual, caseField, expectedFieldOptional, hexToBytes, toHex } from '../helpers.ts';
import { fail } from './common.ts';
import type { SuiteExecutor } from '../runner.ts';
import { ContractRegistry, ProtocolMessage } from '../../protocol/contract.ts';
import { ErrorCodeRegistry } from '../../protocol/error_registry.ts';
import { ProtocolError } from '../../protocol/errors.ts';
import { defaultProtocolLimits } from '../../protocol/limits.ts';
import { newRegistryManifest, registryManifestToValue } from '../../protocol/registry_descriptor.ts';
import { EncodeJSON } from '../../protocol/canonical.ts';
import { DecodePVCE, EncodePVCE, defaultDecodeLimits } from '../../core/pvce.ts';
import { stringValue } from '../../core/value.ts';
import type { PortableValue, ObjectValue } from '../../core/value.ts';
import { objectValueFrom } from '../../protocol/records.ts';
import {
  SourcePatchMessage,
  SourceSnapshotMessage,
} from '../../protocol/records_source.ts';
import {
  SourcePatch,
  SourceReplacement,
  DEFAULT_SOURCE_PATCH_LIMITS,
} from '../../document/source_patch.ts';
import type { SourcePatchLimits } from '../../document/source_patch.ts';
import {
  SourceSnapshot,
  EncodingRequest,
  utf8Encoding,
  utf16LeEncoding,
  utf16BeEncoding,
  latin1Encoding,
  binaryEncoding,
  DEFAULT_SOURCE_LIMITS,
} from '../../document/source.ts';
import type { SourceEncoding, SourceLimits } from '../../document/source.ts';
import { SourcePatchError } from '../../document/errors.ts';

const LIMITS = defaultProtocolLimits();

function expectRejected(operation: () => unknown, case_: VectorCase, code: string): void {
  try {
    operation();
  } catch (error) {
    const observed = error instanceof ProtocolError ? error.code : (error as { code?: unknown } | null)?.code;
    if (observed !== code) {
      fail(`code: expected ${code}, observed ${JSON.stringify(observed)} (${String(error)})`);
    }
    return;
  }
  fail(`expected rejection with code ${code}`);
}

/** Deep PortableValue equality through the canonical tagged-JSON closure. */
function payloadsEqual(left: PortableValue, right: PortableValue): boolean {
  return bytesEqual(EncodeJSON(left, LIMITS), EncodeJSON(right, LIMITS));
}

/** Envelope equality is contract + payload (the Rust ProtocolMessage Eq). */
function messageEqual(left: ProtocolMessage, right: ProtocolMessage): boolean {
  return (
    left.contract.id === right.contract.id &&
    left.contract.version === right.contract.version &&
    payloadsEqual(left.payload, right.payload)
  );
}

/** Rebuilds one field of an Object with a forged replacement (protocol_v2.rs:364-384). */
function replaceObjectField(
  value: PortableValue,
  name: string,
  replacement: PortableValue,
): ObjectValue {
  if (value.kind !== 'Object') {
    throw new Error('value must be Object');
  }
  let found = false;
  const entries = value.entries.map((entry) => {
    if (entry.key === name) {
      found = true;
      return { key: entry.key, value: replacement };
    }
    return entry;
  });
  if (!found) {
    throw new Error(`field ${name} is absent`);
  }
  return objectValueFrom(entries);
}

/** The forged digest wire record used by the tampering cases (protocol_v2.rs:244-247). */
function forgedDigestValue(hexText: string): ObjectValue {
  return objectValueFrom([
    { key: 'algorithm', value: stringValue('sha256') },
    { key: 'hex', value: stringValue(hexText) },
  ]);
}

function encodingOf(name: string): SourceEncoding {
  switch (name) {
    case 'utf-8':
      return utf8Encoding();
    case 'utf-16le':
      return utf16LeEncoding();
    case 'utf-16be':
      return utf16BeEncoding();
    case 'latin-1':
      return latin1Encoding();
    case 'binary':
      return binaryEncoding();
    default:
      fail(`unknown encoding ${name}`);
  }
}

/** Builds the input snapshot exactly like the Rust runner (protocol_v2.rs:321-328). */
function snapshotFromCase(case_: VectorCase, field: string): SourceSnapshot {
  const raw = hexToBytes(caseField(case_, field) as string);
  const encoding = encodingOf(caseField(case_, 'encoding') as string);
  return SourceSnapshot.fromRaw(raw, EncodingRequest.create(encoding), DEFAULT_SOURCE_LIMITS);
}

/** Builds the input replacement set exactly like the Rust runner (protocol_v2.rs:330-344). */
function replacementsFromCase(case_: VectorCase): SourceReplacement[] {
  return (
    caseField(case_, 'replacements') as {
      old_start: number;
      old_end: number;
      original_hex: string;
      replacement_hex: string;
    }[]
  ).map(
    (replacement) =>
      new SourceReplacement(
        replacement.old_start,
        replacement.old_end,
        hexToBytes(replacement.original_hex),
        hexToBytes(replacement.replacement_hex),
      ),
  );
}

/** core.registry-manifest@1 */
function registryManifest(case_: VectorCase): void {
  switch (case_.id) {
    case 'protocol.v2.registry-manifest': {
      const manifest = currentRegistryManifestOf(2);
      const contractCount = expectedFieldOptional(case_, 'contract_count') as number | undefined;
      const errorCodeCount = expectedFieldOptional(case_, 'error_code_count') as number | undefined;
      const recognizesSourceSnapshot = expectedFieldOptional(case_, 'recognizes_source_snapshot');
      const isCurrent = expectedFieldOptional(case_, 'is_current');
      if (contractCount !== undefined && manifest.contracts.length !== contractCount) {
        fail(`contract_count: expected ${contractCount}, observed ${manifest.contracts.length}`);
      }
      if (errorCodeCount !== undefined && manifest.errorCodes.length !== errorCodeCount) {
        fail(`error_code_count: expected ${errorCodeCount}, observed ${manifest.errorCodes.length}`);
      }
      if (recognizesSourceSnapshot === true) {
        const snapshot = manifest.contracts.find((entry) => entry.contract.id === 'core.source-snapshot');
        if (snapshot === undefined) {
          fail('v2 must register core.source-snapshot');
        }
      }
      if (isCurrent === true && manifest.semanticModel.version !== 2) {
        fail('v2 manifest must be the current model at v2');
      }
      return;
    }
    case 'protocol.v2.registry-v1-frozen': {
      const manifest = currentRegistryManifestOf(1);
      const contractCount = expectedFieldOptional(case_, 'contract_count') as number | undefined;
      const errorCodeCount = expectedFieldOptional(case_, 'error_code_count') as number | undefined;
      const recognizesSourceSnapshot = expectedFieldOptional(case_, 'recognizes_source_snapshot');
      const isCurrent = expectedFieldOptional(case_, 'is_current');
      if (contractCount !== undefined && manifest.contracts.length !== contractCount) {
        fail(`contract_count: expected ${contractCount}, observed ${manifest.contracts.length}`);
      }
      if (errorCodeCount !== undefined && manifest.errorCodes.length !== errorCodeCount) {
        fail(`error_code_count: expected ${errorCodeCount}, observed ${manifest.errorCodes.length}`);
      }
      if (recognizesSourceSnapshot === false) {
        const snapshot = manifest.contracts.find((entry) => entry.contract.id === 'core.source-snapshot');
        if (snapshot !== undefined) {
          fail('v1 must not register core.source-snapshot');
        }
      }
      if (isCurrent === false && manifest.semanticModel.version !== 1) {
        fail('v1 manifest must be frozen at model 1');
      }
      return;
    }
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

function currentRegistryManifestOf(version: 1 | 2): ReturnType<typeof newRegistryManifest> {
  return newRegistryManifest(version, new ContractRegistry(version), new ErrorCodeRegistry(version));
}

/** core.error-code-registry@1 */
function errorCodeManifest(case_: VectorCase): void {
  const errorCodeCount = expectedFieldOptional(case_, 'error_code_count') as number | undefined;
  const requiredCode = expectedFieldOptional(case_, 'required_code') as string | undefined;
  const registry = new ErrorCodeRegistry(2);
  if (errorCodeCount !== undefined && registry.codes().length !== errorCodeCount) {
    fail(`error_code_count: expected ${errorCodeCount}, observed ${registry.codes().length}`);
  }
  if (requiredCode !== undefined && !registry.contains(requiredCode)) {
    fail(`missing code ${requiredCode}`);
  }
}

/** core.protocol-message@1 */
function protocolMessage(case_: VectorCase): void {
  const registry = new ContractRegistry(1);
  expectRejected(
    () =>
      new ProtocolMessage(
        { id: 'core.source-snapshot', version: 1 },
        { kind: 'Object', entries: [{ key: 'schema', value: { kind: 'String', value: 'core.source-snapshot@1' } }] },
        registry,
      ),
    case_,
    'core.protocol.unknown-contract@1',
  );
}

/** core.source-snapshot@1 — dual transport and tampering cases (protocol_v2.rs:155-187, 239-283). */
function sourceSnapshotWire(case_: VectorCase): void {
  switch (case_.id) {
    case 'protocol.v2.snapshot-dual-transport': {
      const snapshot = snapshotFromCase(case_, 'raw_hex');
      const payload = SourceSnapshotMessage.fromSnapshot(snapshot).toValue();
      const registry = new ContractRegistry(2);
      const envelope = new ProtocolMessage(
        { id: 'core.source-snapshot', version: 1 },
        payload,
        registry,
      );
      const json = ProtocolMessage.fromJSON(envelope.toJSON(LIMITS), LIMITS, registry);
      const pvce = ProtocolMessage.fromPVCE(envelope.toPVCE(LIMITS), LIMITS, registry);
      if (expectedFieldOptional(case_, 'json_equal') !== true || expectedFieldOptional(case_, 'pvce_equal') !== true) {
        fail('unexpected expectation facts');
      }
      if (!messageEqual(json, envelope)) {
        fail('json transport did not close the envelope');
      }
      if (!messageEqual(pvce, envelope)) {
        fail('pvce transport did not close the envelope');
      }
      const digest = expectedFieldOptional(case_, 'digest') as string | undefined;
      if (digest !== undefined && snapshot.digest().toHex() !== digest) {
        fail(`digest: expected ${digest}, observed ${snapshot.digest().toHex()}`);
      }
      const decoded = SourceSnapshotMessage.fromValue(json.payload, DEFAULT_SOURCE_LIMITS);
      if (
        !bytesEqual(decoded.snapshot().bytes(), snapshot.bytes()) ||
        !decoded.snapshot().encodingFacts().equals(snapshot.encodingFacts())
      ) {
        fail('decoded snapshot differs');
      }
      return;
    }
    case 'protocol.v2.reject-forged-digest': {
      const snapshot = snapshotFromCase(case_, 'raw_hex');
      const value = SourceSnapshotMessage.fromSnapshot(snapshot).toValue();
      const forged = replaceObjectField(value, 'digest', forgedDigestValue('00'.repeat(32)));
      expectRejected(
        () => SourceSnapshotMessage.fromValue(forged, DEFAULT_SOURCE_LIMITS),
        case_,
        'core.protocol.invalid-value@1',
      );
      return;
    }
    case 'protocol.v2.reject-forged-encoding': {
      const snapshot = snapshotFromCase(case_, 'raw_hex');
      const value = SourceSnapshotMessage.fromSnapshot(snapshot).toValue();
      const forgedSelected = caseField(case_, 'forged_selected') as string;
      const encodingField = value.entries.find((entry) => entry.key === 'encoding')?.value;
      if (encodingField === undefined || encodingField.kind !== 'Object') {
        fail('encoding field missing');
      }
      const forgedEncoding = replaceObjectField(
        encodingField,
        'selected',
        stringValue(forgedSelected),
      );
      const forged = replaceObjectField(value, 'encoding', forgedEncoding);
      expectRejected(
        () => SourceSnapshotMessage.fromValue(forged, DEFAULT_SOURCE_LIMITS),
        case_,
        'core.protocol.invalid-value@1',
      );
      return;
    }
    case 'protocol.v2.snapshot-resource-limit': {
      const snapshot = snapshotFromCase(case_, 'raw_hex');
      const value = SourceSnapshotMessage.fromSnapshot(snapshot).toValue();
      const maxRawBytes = caseField(case_, 'max_raw_bytes') as number;
      const limits: SourceLimits = { ...DEFAULT_SOURCE_LIMITS, maxRawBytes };
      expectRejected(
        () => SourceSnapshotMessage.fromValue(value, limits),
        case_,
        'core.protocol.resource-limit@1',
      );
      return;
    }
    default:
      fail(`runner does not recognize published case ${case_.id} (capability core.source-snapshot@1)`);
  }
}

/** core.source-patch@1 — dual transport, resource limit, and the wire-transported stale base (protocol_v2.rs:189-224, 285-319). */
function sourcePatchWire(case_: VectorCase): void {
  switch (case_.id) {
    case 'protocol.v2.patch-dual-transport': {
      const base = snapshotFromCase(case_, 'base_hex');
      const patch = SourcePatch.create(
        base,
        replacementsFromCase(case_),
        new Map([['actor', 'protocol-v2']]),
        DEFAULT_SOURCE_PATCH_LIMITS,
      );
      const payload = SourcePatchMessage.fromPatch(patch).toValue();
      const registry = new ContractRegistry(2);
      const envelope = new ProtocolMessage({ id: 'core.source-patch', version: 1 }, payload, registry);
      const json = ProtocolMessage.fromJSON(envelope.toJSON(LIMITS), LIMITS, registry);
      const pvce = ProtocolMessage.fromPVCE(envelope.toPVCE(LIMITS), LIMITS, registry);
      if (expectedFieldOptional(case_, 'json_equal') !== true || expectedFieldOptional(case_, 'pvce_equal') !== true) {
        fail('unexpected expectation facts');
      }
      if (!messageEqual(json, envelope)) {
        fail('json transport did not close the envelope');
      }
      if (!messageEqual(pvce, envelope)) {
        fail('pvce transport did not close the envelope');
      }
      const targetHex = expectedFieldOptional(case_, 'target_hex') as string | undefined;
      const decoded = SourcePatchMessage.fromValue(json.payload, DEFAULT_SOURCE_PATCH_LIMITS);
      const target = decoded.patch().apply(base, DEFAULT_SOURCE_PATCH_LIMITS);
      if (targetHex !== undefined && toHex(target.bytes()) !== targetHex) {
        fail(`target_hex: expected ${targetHex}, observed ${toHex(target.bytes())}`);
      }
      return;
    }
    case 'protocol.v2.patch-resource-limit': {
      const base = snapshotFromCase(case_, 'base_hex');
      const patch = SourcePatch.create(
        base,
        replacementsFromCase(case_),
        new Map(),
        DEFAULT_SOURCE_PATCH_LIMITS,
      );
      const value = SourcePatchMessage.fromPatch(patch).toValue();
      const maxReplacements = caseField(case_, 'max_replacements') as number;
      const limits: SourcePatchLimits = { ...DEFAULT_SOURCE_PATCH_LIMITS, maxReplacements };
      expectRejected(
        () => SourcePatchMessage.fromValue(value, limits),
        case_,
        'core.protocol.resource-limit@1',
      );
      return;
    }
    case 'protocol.v2.patch-stale-after-wire': {
      const base = snapshotFromCase(case_, 'base_hex');
      const stale = snapshotFromCase(case_, 'stale_hex');
      const patch = SourcePatch.create(
        base,
        replacementsFromCase(case_),
        new Map(),
        DEFAULT_SOURCE_PATCH_LIMITS,
      );
      const value = SourcePatchMessage.fromPatch(patch).toValue();
      // The Rust runner transports the record value through PVCE and decodes
      // it before applying to the stale base (protocol_v2.rs:305-312).
      const transported = DecodePVCE(EncodePVCE(value), defaultDecodeLimits());
      const decoded = SourcePatchMessage.fromValue(transported, DEFAULT_SOURCE_PATCH_LIMITS);
      expectRejected(
        () => decoded.patch().apply(stale, DEFAULT_SOURCE_PATCH_LIMITS),
        case_,
        'core.source.patch-base-mismatch@1',
      );
      return;
    }
    default:
      fail(`runner does not recognize published case ${case_.id} (capability core.source-patch@1)`);
  }
}

export const runProtocolV2: SuiteExecutor = {
  runCase(case_: VectorCase): void {
    switch (case_.capability) {
      case 'core.registry-manifest@1':
        registryManifest(case_);
        return;
      case 'core.error-code-registry@1':
        errorCodeManifest(case_);
        return;
      case 'core.protocol-message@1':
        protocolMessage(case_);
        return;
      case 'core.source-snapshot@1':
        sourceSnapshotWire(case_);
        return;
      case 'core.source-patch@1':
        sourcePatchWire(case_);
        return;
      default:
        fail(`runner does not recognize published case ${case_.id} (capability ${case_.capability})`);
    }
  },
};

void registryManifestToValue;
