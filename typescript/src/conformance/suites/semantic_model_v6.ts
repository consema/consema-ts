/**
 * `consema.semantic-model-v6.conformance@1` runner (25 cases; mirror of
 * crates/consema-conformance/src/semantic_model_v6.rs).
 *
 * The source-v2, materialization-v2, Java UTF-16, and line-query cases
 * exercise the v6 wire records (src/protocol/records_source.ts,
 * records_materialization.ts, records_java_utf16.ts, records_graph.ts,
 * records_execution.ts) through the v6 envelope closure exactly like the
 * Rust runner.
 */

import type { VectorCase } from '../helpers.ts';
import { bytesEqual, caseField, expectedFieldOptional, hexToBytes, toHex, utf8 } from '../helpers.ts';
import { expectedCode, fail, skip } from './common.ts';
import type { SuiteExecutor } from '../runner.ts';
import { ContractRegistry, ProtocolMessage, newContractId } from '../../protocol/contract.ts';
import type { ContractId } from '../../protocol/contract.ts';
import type { ContractRegistryVersion } from '../../protocol/registry_types.ts';
import { ErrorCodeRegistry } from '../../protocol/error_registry.ts';
import { ProtocolError } from '../../protocol/errors.ts';
import { defaultProtocolLimits } from '../../protocol/limits.ts';
import { EncodeJSON } from '../../protocol/canonical.ts';
import { equal } from '../../core/equal.ts';
import type { PortableValue, ObjectValue } from '../../core/value.ts';
import { bytesValue, integerValue, nullValue, sequenceValue, stringValue } from '../../core/value.ts';
import { objectValueFrom } from '../../protocol/records.ts';
import { Completion } from '../../protocol/records_execution.ts';
import {
  SourceEncodingMessage,
  SourcePatchMessageV2,
  SourceSnapshotMessage,
  SourceSnapshotMessageV2,
} from '../../protocol/records_source.ts';
import {
  MaterializationProvenanceMapMessage,
  MaterializationReportMessage,
  MaterializationRequestMessageV2,
  MaterializationResultMessageV2,
} from '../../protocol/records_materialization.ts';
import { JavaUtf16String } from '../../protocol/records_java_utf16.ts';
import {
  IniMatchLocator,
  IniQueryResultMessage,
  JavaPropertiesMatchLocator,
  JavaPropertiesQueryResultMessage,
} from '../../protocol/records_graph.ts';
import {
  DEFAULT_SOURCE_LIMITS,
  EncodingRequest,
  latin1Encoding,
  SourceSnapshot,
  WindowsCodePage,
  unicodeScalarOffset,
  windowsCodePageEncoding,
} from '../../document/source.ts';
import {
  DEFAULT_SOURCE_PATCH_LIMITS,
  SourcePatch,
  SourceReplacement,
} from '../../document/source_patch.ts';
import { MaterializationRequest, MaterializationStyleId } from '../../document/materialization.ts';
import { ProfileId } from '../../document/profile.ts';
import { DocumentAuthority } from '../../document/identity.ts';
import type { NodeRole } from '../../document/identity.ts';
import { SourcePatchError } from '../../document/errors.ts';
import {
  domainINILosslessSyntaxV1,
  domainININativeV1,
  domainJavaPropertiesLosslessSyntaxV1,
  domainJavaPropertiesNativeV1,
} from '../../protocol/query.ts';
import type { MatchRole, QueryDomain } from '../../protocol/query.ts';

const LIMITS = defaultProtocolLimits();
const V6 = new ContractRegistry(6);

/** Asserts one operation rejects with the exact frozen code. */
function expectRejected(operation: () => unknown, code: string): void {
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

/** Asserts one operation rejects with the pinned code and the pinned error path when the vector pins one. */
function expectRejectedAt(operation: () => unknown, case_: VectorCase, code: string): void {
  try {
    operation();
  } catch (error) {
    const observed = error instanceof ProtocolError ? error.code : (error as { code?: unknown } | null)?.code;
    if (observed !== code) {
      fail(`code: expected ${code}, observed ${JSON.stringify(observed)} (${String(error)})`);
    }
    const pinnedPath = expectedFieldOptional(case_, 'path') as string | undefined;
    if (pinnedPath !== undefined) {
      const observedPath = error instanceof ProtocolError ? error.path : (error as { path?: unknown } | null)?.path;
      if (observedPath !== pinnedPath) {
        fail(`path: expected ${pinnedPath}, observed ${JSON.stringify(observedPath)}`);
      }
    }
    return;
  }
  fail(`expected rejection with code ${code}`);
}

/** Deep PortableValue equality through the canonical tagged-JSON closure. */
function payloadsEqual(left: PortableValue, right: PortableValue): boolean {
  return bytesEqual(EncodeJSON(left, LIMITS), EncodeJSON(right, LIMITS));
}

/** Proves JSON/PVCE transport identity of one payload under the v6 registry (dual_roundtrip, semantic_model_v6.rs:903-924). */
function dualRoundtrip(contract: ContractId, payload: PortableValue): void {
  const message = new ProtocolMessage(contract, payload, V6);
  const json = message.toJSON(LIMITS);
  const pvce = message.toPVCE(LIMITS);
  const fromJson = ProtocolMessage.fromJSON(json, LIMITS, V6);
  const fromPvce = ProtocolMessage.fromPVCE(pvce, LIMITS, V6);
  if (!payloadsEqual(fromJson.payload, message.payload)) {
    fail('JSON transport did not close');
  }
  if (!payloadsEqual(fromPvce.payload, message.payload)) {
    fail('PVCE transport did not close');
  }
}

/** Replaces one existing field of an Object with a forged replacement. */
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

/** Appends one new trailing field of an Object. */
function appendObjectField(value: PortableValue, name: string, appended: PortableValue): ObjectValue {
  if (value.kind !== 'Object') {
    throw new Error('value must be Object');
  }
  return objectValueFrom([...value.entries, { key: name, value: appended }]);
}

/** One frozen Windows code page encoding (code_page_encoding, semantic_model_v6.rs:926-930). */
function codePageEncoding(number: number) {
  const page = WindowsCodePage.fromNumber(number);
  if (page === null) {
    fail(`unsupported code page ${number}`);
  }
  return windowsCodePageEncoding(page);
}

/** One code-page snapshot under TreatAsContent (code_page_snapshot, semantic_model_v6.rs:932-940). */
function codePageSnapshot(number: number, bytes: Uint8Array): SourceSnapshot {
  return SourceSnapshot.fromRaw(
    bytes,
    EncodingRequest.create(codePageEncoding(number)).withBomPolicy('TreatAsContent'),
    DEFAULT_SOURCE_LIMITS,
  );
}

/** One input role spelling → the closed INI role (parse_ini_role, semantic_model_v6.rs:957-969). */
function parseIniRole(text: string): MatchRole {
  switch (text) {
    case 'IniDocument':
    case 'IniPhysicalLine':
    case 'IniLogicalLine':
    case 'IniSection':
    case 'IniDefaultSection':
    case 'IniEntry':
    case 'IniErrorLine':
    case 'IniSyntaxPiece':
      return text;
    default:
      fail(`unknown INI role ${text}`);
  }
}

/** One input role spelling → the closed Properties role (parse_properties_role, semantic_model_v6.rs:971-983). */
function parsePropertiesRole(text: string): MatchRole {
  switch (text) {
    case 'PropertiesDocument':
    case 'PropertiesNaturalLine':
    case 'PropertiesLogicalLine':
    case 'PropertiesProperty':
    case 'PropertiesComment':
    case 'PropertiesEscape':
    case 'PropertiesErrorLine':
    case 'PropertiesSyntaxPiece':
      return text;
    default:
      fail(`unknown Properties role ${text}`);
  }
}

/** The frozen completion Success(produced, produced) (success, semantic_model_v6.rs:942-944). */
function success(produced: number): Completion {
  return Completion.new('Success', BigInt(produced), BigInt(produced));
}

/** core.registry-manifest@1 */
function registryManifest(case_: VectorCase): void {
  switch (case_.id) {
    case 'registry.v6-manifest': {
      const contractCount = expectedFieldOptional(case_, 'contract_count') as number | undefined;
      const errorCodeCount = expectedFieldOptional(case_, 'error_code_count') as number | undefined;
      if (contractCount !== undefined && new ContractRegistry(6).contracts().length !== contractCount) {
        fail('v6 contract count mismatch');
      }
      if (errorCodeCount !== undefined && new ErrorCodeRegistry(6).codes().length !== errorCodeCount) {
        fail('v6 error code count mismatch');
      }
      return;
    }
    case 'registry.v1-v5-frozen': {
      const contractCounts = expectedFieldOptional(case_, 'contract_counts') as number[] | undefined;
      const errorCodeCounts = expectedFieldOptional(case_, 'error_code_counts') as number[] | undefined;
      if (contractCounts !== undefined) {
        contractCounts.forEach((expected, index) => {
          if (new ContractRegistry((index + 1) as 1 | 2 | 3 | 4 | 5).contracts().length !== expected) {
            fail(`v${index + 1} contract count mismatch`);
          }
        });
      }
      if (errorCodeCounts !== undefined) {
        errorCodeCounts.forEach((expected, index) => {
          if (new ErrorCodeRegistry((index + 1) as 1 | 2 | 3 | 4 | 5).codes().length !== expected) {
            fail(`v${index + 1} error code count mismatch`);
          }
        });
      }
      const previousVectors = expectedFieldOptional(case_, 'previous_vectors') as { name: string; sha256: string }[] | undefined;
      if (previousVectors !== undefined) {
        // The vector file digests are asserted by the aggregate digest; here
        // we only verify the manifest structure.
        if (previousVectors.length !== 3) {
          fail('previous vector inventory must have three entries');
        }
      }
      return;
    }
    case 'registry.v6-additive-contracts': {
      const contracts = expectedFieldOptional(case_, 'contracts') as string[] | undefined;
      if (contracts !== undefined) {
        const v6 = new Set(new ContractRegistry(6).contracts().map((descriptor) => `${descriptor.id}@${descriptor.version}`));
        const v5 = new Set(new ContractRegistry(5).contracts().map((descriptor) => `${descriptor.id}@${descriptor.version}`));
        for (const contract of contracts) {
          if (!v6.has(contract)) {
            fail(`v6 must register ${contract}`);
          }
          if (v5.has(contract)) {
            fail(`${contract} must be new in v6`);
          }
        }
      }
      return;
    }
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** core.error-code-registry@1 */
function errorCodes(case_: VectorCase): void {
  const errorCodeCount = expectedFieldOptional(case_, 'error_code_count') as number | undefined;
  const newCodes = expectedFieldOptional(case_, 'new_codes') as string[] | undefined;
  if (errorCodeCount !== undefined && new ErrorCodeRegistry(6).codes().length !== errorCodeCount) {
    fail('v6 error code count mismatch');
  }
  if (newCodes !== undefined) {
    const registry = new ErrorCodeRegistry(6);
    for (const code of newCodes) {
      if (!registry.contains(code)) {
        fail(`v6 must register ${code}`);
      }
    }
  }
}

/** core.source-encoding@1 */
function sourceEncoding(case_: VectorCase): void {
  switch (case_.id) {
    case 'source-encoding.mandatory-code-pages': {
      const pages = caseField(case_, 'code_pages') as number[];
      let accepted = 0;
      for (const page of pages) {
        const message = SourceEncodingMessage.fromEncoding(codePageEncoding(page));
        const decoded = SourceEncodingMessage.fromValue(message.toValue()).encoding();
        if (decoded.kind === 'WindowsCodePage' && decoded.codePage.equals(WindowsCodePage.fromNumber(page)!)) {
          accepted++;
        }
      }
      const acceptedCount = expectedFieldOptional(case_, 'accepted_count') as number | undefined;
      if (acceptedCount !== undefined && accepted !== acceptedCount) {
        fail(`mandatory code-page count: expected ${acceptedCount}, observed ${accepted}`);
      }
      return;
    }
    case 'source-encoding.reject-unsupported': {
      const value = objectValueFrom([
        { key: 'schema', value: stringValue('core.source-encoding@1') },
        { key: 'kind', value: stringValue('WindowsCodePage') },
        { key: 'windows_code_page', value: integerValue(BigInt(caseField(case_, 'code_page') as number)) },
      ]);
      expectRejected(
        () => SourceEncodingMessage.fromValue(value),
        expectedCode(case_) ?? 'core.protocol.invalid-value@1',
      );
      return;
    }
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** core.source-snapshot@2 */
function sourceSnapshotV2(case_: VectorCase): void {
  switch (case_.id) {
    case 'source.bom-policy-distinct': {
      const raw = hexToBytes(caseField(case_, 'hex') as string);
      const detected = SourceSnapshot.fromRaw(raw, EncodingRequest.create(latin1Encoding()), DEFAULT_SOURCE_LIMITS);
      const content = SourceSnapshot.fromRaw(
        raw,
        EncodingRequest.create(latin1Encoding()).withBomPolicy('TreatAsContent'),
        DEFAULT_SOURCE_LIMITS,
      );
      dualRoundtrip(newContractId('core.source-snapshot', 2), SourceSnapshotMessageV2.fromSnapshot(detected).toValue());
      dualRoundtrip(newContractId('core.source-snapshot', 2), SourceSnapshotMessageV2.fromSnapshot(content).toValue());
      const detectText = expectedFieldOptional(case_, 'detect_text') as string | undefined;
      const contentText = expectedFieldOptional(case_, 'content_text') as string | undefined;
      if (detectText !== undefined && detected.decodedText() !== detectText) {
        fail(`detect_text: expected ${JSON.stringify(detectText)}, observed ${JSON.stringify(detected.decodedText())}`);
      }
      if (contentText !== undefined && content.decodedText() !== contentText) {
        fail(`content_text: expected ${JSON.stringify(contentText)}, observed ${JSON.stringify(content.decodedText())}`);
      }
      if (detected.encodingFacts().bomPolicy() !== 'DetectUnicode' || content.encodingFacts().bomPolicy() !== 'TreatAsContent') {
        fail('BOM policies did not remain distinct');
      }
      return;
    }
    case 'source.snapshot-v2-code-page-boundaries': {
      // The cp932 decode and boundary facts (source_boundaries,
      // semantic_model_v6.rs:340-364): the two-byte code 82a0 decodes to
      // U+3042, so raw boundaries 0/2/3 are the scalar boundaries and raw
      // byte 1 (mid-scalar) is not.
      const snapshot = codePageSnapshot(
        caseField(case_, 'code_page') as number,
        hexToBytes(caseField(case_, 'hex') as string),
      );
      const payload = SourceSnapshotMessageV2.fromSnapshot(snapshot).toValue();
      const decoded = SourceSnapshotMessageV2.fromValue(payload, DEFAULT_SOURCE_LIMITS);
      const text = expectedFieldOptional(case_, 'text') as string | undefined;
      if (text !== undefined && decoded.snapshot().decodedText() !== text) {
        fail(
          `text: expected ${JSON.stringify(text)}, observed ${JSON.stringify(decoded.snapshot().decodedText())}`,
        );
      }
      const boundaries = (expectedFieldOptional(case_, 'raw_boundaries') as number[] | undefined) ?? [];
      for (const boundary of boundaries) {
        try {
          decoded.snapshot().decodedPosition(boundary);
        } catch {
          fail(`raw boundary ${boundary} must be a decoded scalar boundary`);
        }
      }
      const invalidBoundary = expectedFieldOptional(case_, 'invalid_raw_boundary') as number | undefined;
      if (invalidBoundary !== undefined) {
        let resolved = false;
        try {
          decoded.snapshot().decodedPosition(invalidBoundary);
          resolved = true;
        } catch {
          // expected: the mid-scalar raw byte is not a boundary.
        }
        if (resolved) {
          fail(`raw boundary ${invalidBoundary} must not be a decoded scalar boundary`);
        }
      }
      const scalarOne = decoded.snapshot().rawByteAt(unicodeScalarOffset(1));
      if (scalarOne !== 2) {
        fail(`raw_byte_at(unicode scalar 1): expected 2, observed ${scalarOne}`);
      }
      return;
    }
    case 'source.snapshot-v2-reject-digest': {
      const snapshot = codePageSnapshot(
        caseField(case_, 'code_page') as number,
        hexToBytes(caseField(case_, 'hex') as string),
      );
      const encoded = SourceSnapshotMessageV2.fromSnapshot(snapshot).toValue();
      const digest = encoded.entries.find((entry) => entry.key === 'digest')!.value;
      const forged = replaceObjectField(digest, 'hex', stringValue('0'.repeat(64)));
      const changed = replaceObjectField(encoded, 'digest', forged);
      expectRejected(
        () => SourceSnapshotMessageV2.fromValue(changed, DEFAULT_SOURCE_LIMITS),
        expectedCode(case_) ?? 'core.protocol.invalid-value@1',
      );
      return;
    }
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** core.source-patch@2 */
function sourcePatchV2(case_: VectorCase): void {
  if (case_.id === 'source.patch-v2-atomic-apply') {
    const codePage = caseField(case_, 'code_page') as number;
    const baseBytes = hexToBytes(caseField(case_, 'base_hex') as string);
    const base = codePageSnapshot(codePage, baseBytes);
    const start = caseField(case_, 'start') as number;
    const end = caseField(case_, 'end') as number;
    const replacement = new SourceReplacement(
      start,
      end,
      baseBytes.slice(start, end),
      hexToBytes(caseField(case_, 'replacement_hex') as string),
    );
    const patch = SourcePatch.create(base, [replacement], new Map(), DEFAULT_SOURCE_PATCH_LIMITS);
    // Wire roundtrip through the v2 patch record, then atomic apply
    // (semantic_model_v6.rs:388-425).
    const wire = SourcePatchMessageV2.fromPatch(patch).toValue();
    const decodedPatch = SourcePatchMessageV2.fromValue(wire, DEFAULT_SOURCE_PATCH_LIMITS).patch();
    const target = decodedPatch.apply(base, DEFAULT_SOURCE_PATCH_LIMITS);
    const targetHex = expectedFieldOptional(case_, 'target_hex') as string | undefined;
    const observedHex = toHex(target.bytes());
    if (targetHex !== undefined && observedHex !== targetHex) {
      fail(`target_hex: expected ${targetHex}, observed ${observedHex}`);
    }
    const wrongBaseCode = expectedFieldOptional(case_, 'wrong_base_code') as string | undefined;
    if (wrongBaseCode !== undefined) {
      const wrong = codePageSnapshot(codePage, utf8('wrong'));
      try {
        decodedPatch.apply(wrong, DEFAULT_SOURCE_PATCH_LIMITS);
      } catch (error) {
        if (error instanceof SourcePatchError && error.code === wrongBaseCode) {
          return;
        }
        fail(`expected ${wrongBaseCode}, observed ${String(error)}`);
      }
      fail('expected a base-mismatch failure');
    }
    return;
  }
  return skip(
    case_.contract ?? 'core.source-patch@2',
    `runner does not recognize published case ${case_.id}`,
  );
}

/** core.materialization-request@2 */
function materializationRequestV2(case_: VectorCase): void {
  switch (case_.id) {
    case 'materialization.request-v2-roundtrip': {
      const request = new MaterializationRequest(
        new ProfileId(caseField(case_, 'profile') as string, 1),
        new MaterializationStyleId(caseField(case_, 'style') as string, 1),
      )
        .withEncoding(codePageEncoding(caseField(case_, 'code_page') as number))
        .withNewline('CrLf');
      const message = MaterializationRequestMessageV2.fromRequest(request);
      const payload = message.toValue();
      const decoded = MaterializationRequestMessageV2.fromValue(payload).request();
      const reencoded = MaterializationRequestMessageV2.fromRequest(decoded).toValue();
      if (!payloadsEqual(reencoded, payload)) {
        fail('materialization request v2 differed');
      }
      const encodingValue = payload.entries.find((entry) => entry.key === 'encoding')!.value;
      if (encodingValue.kind !== 'Object') {
        fail('encoding must be an Object');
      }
      const kind = encodingValue.entries.find((entry) => entry.key === 'kind')!.value;
      const encodingKind = expectedFieldOptional(case_, 'encoding_kind') as string | undefined;
      if (encodingKind !== undefined && (kind.kind !== 'String' || kind.value !== encodingKind)) {
        fail(`encoding kind: expected ${encodingKind}, observed ${JSON.stringify(kind)}`);
      }
      return;
    }
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** core.materialization-result@2 */
function materializationResultV2(case_: VectorCase): void {
  switch (case_.id) {
    case 'materialization.result-v2-version-closure': {
      const snapshot = codePageSnapshot(
        caseField(case_, 'code_page') as number,
        hexToBytes(caseField(case_, 'hex') as string),
      );
      const message = MaterializationResultMessageV2.complete(
        new ProfileId('ini.windows', 1),
        'target:ini',
        SourceSnapshotMessageV2.fromSnapshot(snapshot),
        'Exact',
        MaterializationReportMessage.default(),
        MaterializationProvenanceMapMessage.default(),
      );
      dualRoundtrip(newContractId('core.materialization-result', 2), message.toValue());

      const utf8Snapshot = SourceSnapshot.fromUtf8(utf8('k=v'));
      const v2 = MaterializationResultMessageV2.complete(
        new ProfileId('ini.portable', 1),
        'target:ini',
        SourceSnapshotMessageV2.fromSnapshot(utf8Snapshot),
        'Exact',
        MaterializationReportMessage.default(),
        MaterializationProvenanceMapMessage.default(),
      );
      const mixed = replaceOutcomeSnapshot(
        v2.toValue(),
        SourceSnapshotMessage.fromSnapshot(utf8Snapshot).toValue(),
      );
      expectRejected(
        () => MaterializationResultMessageV2.fromValueWithRegistry(mixed, new ErrorCodeRegistry(6)),
        (expectedFieldOptional(case_, 'mixed_version_code') as string | undefined) ?? 'core.protocol.schema-mismatch@1',
      );
      return;
    }
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** Replaces the outcome snapshot of a result wire with a forged snapshot value (replace_outcome_snapshot, semantic_model_v6.rs:998-1009). */
function replaceOutcomeSnapshot(result: ObjectValue, snapshot: PortableValue): ObjectValue {
  const outcome = result.entries.find((entry) => entry.key === 'outcome')!.value;
  if (outcome.kind !== 'Object') {
    throw new Error('outcome must be an Object');
  }
  return replaceObjectField(result, 'outcome', replaceObjectField(outcome, 'snapshot', snapshot));
}

/** core.java-utf16-string@1 */
function javaUtf16(case_: VectorCase): void {
  switch (case_.id) {
    case 'java-utf16.edge-matrix': {
      const cases = caseField(case_, 'cases') as { units: string[]; status: string }[];
      let accepted = 0;
      for (const item of cases) {
        const units = item.units.map((text) => Number.parseInt(text, 16));
        const exact = JavaUtf16String.new(units, LIMITS);
        const decoded = JavaUtf16String.fromValue(exact.toValue(), LIMITS);
        if (exact.unicodeStatus() === item.status && equal(decoded.toValue(), exact.toValue())) {
          accepted++;
        }
      }
      const acceptedCount = expectedFieldOptional(case_, 'accepted_count') as number | undefined;
      if (acceptedCount !== undefined && accepted !== acceptedCount) {
        fail(`Java UTF-16 edge matrix: expected ${acceptedCount}, observed ${accepted}`);
      }
      return;
    }
    case 'java-utf16.reject-noncanonical-unit':
    case 'java-utf16.reject-byte-mismatch': {
      const value = objectValueFrom([
        { key: 'schema', value: stringValue('core.java-utf16-string@1') },
        { key: 'encoding', value: stringValue('UTF16BE/1') },
        { key: 'code_units', value: sequenceValue([stringValue(caseField(case_, 'unit') as string)]) },
        { key: 'bytes', value: bytesValue(hexToBytes(caseField(case_, 'bytes_hex') as string)) },
        { key: 'unicode_status', value: stringValue(caseField(case_, 'status') as string) },
      ]);
      expectRejectedAt(
        () => JavaUtf16String.fromValue(value, LIMITS),
        case_,
        expectedCode(case_) ?? 'core.protocol.invalid-value@1',
      );
      return;
    }
    case 'protocol.new-payload-schema-and-limits': {
      const exact = JavaUtf16String.new([0x0041], LIMITS);
      const unknown = appendObjectField(exact.toValue(), 'unknown', nullValue());
      expectRejectedAt(
        () => JavaUtf16String.fromValue(unknown, LIMITS),
        case_,
        (expectedFieldOptional(case_, 'unknown_field_code') as string | undefined) ?? 'core.protocol.unknown-field@1',
      );
      const maxUnits = caseField(case_, 'max_units') as number;
      const limited = { ...LIMITS, maxContainerEntries: maxUnits };
      expectRejectedAt(
        () => JavaUtf16String.fromValue(exact.toValue(), limited),
        case_,
        (expectedFieldOptional(case_, 'limit_code') as string | undefined) ?? 'core.protocol.resource-limit@1',
      );
      return;
    }
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** core.ini-query-result@1 */
function iniQuery(case_: VectorCase): void {
  switch (case_.id) {
    case 'ini-query.all-roles': {
      const roles = caseField(case_, 'roles') as string[];
      const sourceId = caseField(case_, 'source_id') as string;
      for (let ordinal = 0; ordinal < roles.length; ordinal++) {
        const role = parseIniRole(roles[ordinal]);
        const domain: QueryDomain =
          role === 'IniSyntaxPiece' ? domainINILosslessSyntaxV1() : domainININativeV1();
        const result = IniQueryResultMessage.new(
          domain,
          role,
          [IniMatchLocator.new(sourceId, `ini:node:${ordinal}`, role, BigInt(ordinal))],
          success(1),
          [],
        );
        dualRoundtrip(newContractId('core.ini-query-result', 1), result.toValue());
      }
      const roleCount = expectedFieldOptional(case_, 'role_count') as number | undefined;
      if (roleCount !== undefined && roles.length !== roleCount) {
        fail(`INI role count: expected ${roleCount}, observed ${roles.length}`);
      }
      return;
    }
    case 'line-query.reject-domain-role': {
      const role = parseIniRole(caseField(case_, 'role') as string);
      expectRejected(
        () => IniQueryResultMessage.new(domainININativeV1(), role, [], success(0), []),
        expectedCode(case_) ?? 'core.protocol.invalid-value@1',
      );
      return;
    }
    case 'line-query.reject-process-local': {
      const node = DocumentAuthority.fresh().nodeRef(0n, 'IniEntry' as NodeRole);
      expectRejected(
        () => IniMatchLocator.fromProcessLocal(node),
        expectedCode(case_) ?? 'core.protocol.process-local-handle@1',
      );
      return;
    }
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** core.java-properties-query-result@1 */
function propertiesQuery(case_: VectorCase): void {
  switch (case_.id) {
    case 'properties-query.all-roles': {
      const roles = caseField(case_, 'roles') as string[];
      const sourceId = caseField(case_, 'source_id') as string;
      for (let ordinal = 0; ordinal < roles.length; ordinal++) {
        const role = parsePropertiesRole(roles[ordinal]);
        const domain: QueryDomain =
          role === 'PropertiesSyntaxPiece' ? domainJavaPropertiesLosslessSyntaxV1() : domainJavaPropertiesNativeV1();
        const result = JavaPropertiesQueryResultMessage.new(
          domain,
          role,
          [JavaPropertiesMatchLocator.new(sourceId, `properties:node:${ordinal}`, role, BigInt(ordinal))],
          success(1),
          [],
        );
        dualRoundtrip(newContractId('core.java-properties-query-result', 1), result.toValue());
      }
      const roleCount = expectedFieldOptional(case_, 'role_count') as number | undefined;
      if (roleCount !== undefined && roles.length !== roleCount) {
        fail(`Properties role count: expected ${roleCount}, observed ${roles.length}`);
      }
      return;
    }
    case 'line-query.reject-ordinal-and-count': {
      const role = parsePropertiesRole(caseField(case_, 'role') as string);
      const ordinals = caseField(case_, 'ordinals') as number[];
      const produced = caseField(case_, 'produced') as number;
      const matches = ordinals.map((ordinal, index) =>
        JavaPropertiesMatchLocator.new('source:properties', `property:${index}`, role, BigInt(ordinal)),
      );
      expectRejected(
        () => JavaPropertiesQueryResultMessage.new(domainJavaPropertiesNativeV1(), role, matches, success(produced), []),
        expectedCode(case_) ?? 'core.protocol.invalid-value@1',
      );
      return;
    }
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** The eight v6-contract payloads rejected by every old registry (new_payloads, semantic_model_v6.rs:814-901). */
function v6NewPayloads(): { contract: ContractId; payload: PortableValue }[] {
  const encoding = codePageEncoding(1252);
  const snapshot = codePageSnapshot(1252, utf8('k=1'));
  const patch = SourcePatch.create(snapshot, [], new Map(), DEFAULT_SOURCE_PATCH_LIMITS);
  const profile = new ProfileId('ini.windows', 1);
  const request = new MaterializationRequest(profile, new MaterializationStyleId('ini.windows-canonical', 1))
    .withEncoding(encoding)
    .withNewline('CrLf');
  const result = MaterializationResultMessageV2.complete(
    profile,
    'target:ini',
    SourceSnapshotMessageV2.fromSnapshot(snapshot),
    'Exact',
    MaterializationReportMessage.default(),
    MaterializationProvenanceMapMessage.default(),
  );
  const ini = IniQueryResultMessage.new(domainININativeV1(), 'IniDocument', [], success(0), []);
  const properties = JavaPropertiesQueryResultMessage.new(
    domainJavaPropertiesNativeV1(),
    'PropertiesDocument',
    [],
    success(0),
    [],
  );
  return [
    { contract: newContractId('core.ini-query-result', 1), payload: ini.toValue() },
    { contract: newContractId('core.java-properties-query-result', 1), payload: properties.toValue() },
    { contract: newContractId('core.java-utf16-string', 1), payload: JavaUtf16String.new([0xd800], LIMITS).toValue() },
    {
      contract: newContractId('core.materialization-request', 2),
      payload: MaterializationRequestMessageV2.fromRequest(request).toValue(),
    },
    { contract: newContractId('core.materialization-result', 2), payload: result.toValue() },
    { contract: newContractId('core.source-encoding', 1), payload: SourceEncodingMessage.fromEncoding(encoding).toValue() },
    { contract: newContractId('core.source-patch', 2), payload: SourcePatchMessageV2.fromPatch(patch).toValue() },
    { contract: newContractId('core.source-snapshot', 2), payload: SourceSnapshotMessageV2.fromSnapshot(snapshot).toValue() },
  ];
}

/** core.protocol-message@1 */
function protocolMessage(case_: VectorCase): void {
  switch (case_.id) {
    case 'protocol.v1-v5-reject-v6-contracts': {
      const expectedCode_ = expectedCode(case_) ?? 'core.protocol.unknown-contract@1';
      let rejected = 0;
      for (const { contract, payload } of v6NewPayloads()) {
        let allRejected = true;
        for (let version = 1; version <= 5; version++) {
          try {
            new ProtocolMessage(contract, payload, new ContractRegistry(version as ContractRegistryVersion));
            allRejected = false;
          } catch (error) {
            const observed = error instanceof ProtocolError ? error.code : (error as { code?: unknown } | null)?.code;
            if (observed !== expectedCode_) {
              allRejected = false;
            }
          }
        }
        if (allRejected) {
          rejected++;
        }
      }
      const rejectedPairs = expectedFieldOptional(case_, 'rejected_pairs') as number | undefined;
      if (rejectedPairs !== undefined && rejected !== rejectedPairs) {
        fail(`rejected pairs: expected ${rejectedPairs}, observed ${rejected}`);
      }
      return;
    }
    case 'protocol.exact-version-dispatch': {
      const request = new MaterializationRequest(
        new ProfileId('ini.portable', 1),
        new MaterializationStyleId('ini.portable-canonical', 1),
      );
      const v2 = MaterializationRequestMessageV2.fromRequest(request).toValue();
      const disguised = replaceObjectField(v2, 'schema', stringValue('core.materialization-request@1'));
      expectRejected(
        () => new ProtocolMessage(newContractId('core.materialization-request', 1), disguised, V6),
        expectedCode(case_) ?? 'core.protocol.wrong-type@1',
      );
      return;
    }
    case 'protocol.v6-nested-error-code': {
      const code = caseField(case_, 'failure_code') as string;
      expectRejected(
        () => Completion.newWithRegistry('Failed', 1n, 0n, null, code, new ErrorCodeRegistry(5)),
        (expectedFieldOptional(case_, 'v5_code') as string | undefined) ?? 'core.protocol.invalid-value@1',
      );
      const completion = Completion.newWithRegistry('Failed', 1n, 0n, null, code, new ErrorCodeRegistry(6));
      dualRoundtrip(newContractId('core.completion', 1), completion.toValue());
      return;
    }
    case 'protocol.new-contract-canonical-bytes': {
      const encodingPayload = SourceEncodingMessage.fromEncoding(codePageEncoding(1252)).toValue();
      const javaPayload = JavaUtf16String.new([0x0000, 0xd83d, 0xde00, 0xd800], LIMITS).toValue();
      const encodingMessage = new ProtocolMessage(newContractId('core.source-encoding', 1), encodingPayload, V6);
      const javaMessage = new ProtocolMessage(newContractId('core.java-utf16-string', 1), javaPayload, V6);
      const actual = [
        toHex(encodingMessage.toJSON(LIMITS)),
        toHex(encodingMessage.toPVCE(LIMITS)),
        toHex(javaMessage.toJSON(LIMITS)),
        toHex(javaMessage.toPVCE(LIMITS)),
      ];
      const names = [
        'source_encoding_json_hex',
        'source_encoding_pvce_hex',
        'java_utf16_json_hex',
        'java_utf16_pvce_hex',
      ];
      for (let index = 0; index < names.length; index++) {
        const expected = expectedFieldOptional(case_, names[index]) as string | undefined;
        if (expected !== undefined && actual[index] !== expected) {
          fail(`canonical hex differs for ${names[index]}: expected ${expected}, observed ${actual[index]}`);
        }
      }
      return;
    }
    default:
      return skip(
        case_.capability ?? 'unknown',
        `runner does not recognize published case ${case_.id}`,
      );
  }
}

export const runSemanticModelV6: SuiteExecutor = {
  runCase(case_: VectorCase): void {
    switch (case_.capability) {
      case 'core.registry-manifest@1':
        registryManifest(case_);
        return;
      case 'core.error-code-registry@1':
        errorCodes(case_);
        return;
      case 'core.source-patch@2':
        sourcePatchV2(case_);
        return;
      case 'core.source-encoding@1':
        sourceEncoding(case_);
        return;
      case 'core.source-snapshot@2':
        sourceSnapshotV2(case_);
        return;
      case 'core.materialization-request@2':
        materializationRequestV2(case_);
        return;
      case 'core.materialization-result@2':
        materializationResultV2(case_);
        return;
      case 'core.java-utf16-string@1':
        javaUtf16(case_);
        return;
      case 'core.ini-query-result@1':
        iniQuery(case_);
        return;
      case 'core.java-properties-query-result@1':
        propertiesQuery(case_);
        return;
      case 'core.protocol-message@1':
        protocolMessage(case_);
        return;
      default:
        return skip(
          case_.capability ?? 'unknown',
          `runner does not recognize published case ${case_.id}`,
        );
    }
  },
};
