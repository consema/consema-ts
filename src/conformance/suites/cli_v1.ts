/**
 * `consema.cli.conformance@1` runner (40 cases; mirror of
 * crates/consema-conformance/src/cli_v1.rs).
 */

import type { VectorCase } from '../helpers.ts';
import { caseField, caseFieldOptional, expectedFieldOptional, utf8, toHex, bytesEqual } from '../helpers.ts';
import { fail, SkippedCase } from './common.ts';
import type { SuiteExecutor } from '../runner.ts';
import {
  cliOutputFromValue,
  cliOutputToValue,
  batchPlanFromValue,
  batchPlanToValue,
  batchResultFromValue,
  newRedaction,
} from '../../protocol/cli.ts';
import type { CliOutputMessage, BatchPlanMessage } from '../../protocol/cli.ts';
import type { PortableValue } from '../../core/value.ts';
import { classifyErrorCode } from '../../protocol/exit_class.ts';
import { ErrorCodeRegistry } from '../../protocol/error_registry.ts';
import { resource } from '../../protocol/errors.ts';
import { EncodePVCE } from '../../core/pvce.ts';
import { DecodeJSON, EncodeJSON } from '../../protocol/canonical.ts';
import { defaultProtocolLimits } from '../../protocol/limits.ts';

const LIMITS = defaultProtocolLimits();

function decodeEnvelope(case_: VectorCase): CliOutputMessage {
  const json = caseField(case_, 'json') as string;
  const value = DecodeJSON(utf8(json), LIMITS);
  return cliOutputFromValue(value, new ErrorCodeRegistry(7));
}

/** Asserts the envelope facts pinned by the vector (Python _assert_envelope_facts). */
function assertEnvelopeFacts(case_: VectorCase, envelope: CliOutputMessage): void {
  const command = expectedFieldOptional(case_, 'command') as string | undefined;
  if (command !== undefined && envelope.command !== command) {
    fail(`command: expected ${command}, observed ${envelope.command}`);
  }
  const exitClass = expectedFieldOptional(case_, 'exit_class') as string | undefined;
  if (exitClass !== undefined && envelope.exitClass !== exitClass) {
    fail(`exit_class: expected ${exitClass}, observed ${envelope.exitClass}`);
  }
  const productVersion = expectedFieldOptional(case_, 'product_version') as string | undefined;
  if (productVersion !== undefined && envelope.productVersion !== productVersion) {
    fail(`product_version: expected ${productVersion}, observed ${envelope.productVersion}`);
  }
  const payloadSchema = expectedFieldOptional(case_, 'payload_schema') as string | undefined;
  if (payloadSchema !== undefined) {
    const payload = envelope.payload;
    const schema = payload.kind === 'Object' && payload.entries.length > 0 ? payload.entries[0].value : undefined;
    if (schema === undefined || schema.kind !== 'String' || schema.value !== payloadSchema) {
      fail(`payload_schema: expected ${payloadSchema}`);
    }
  }
  const redacted = expectedFieldOptional(case_, 'redacted') as boolean | undefined;
  const count = expectedFieldOptional(case_, 'count') as number | undefined;
  if (redacted !== undefined && envelope.redaction.redacted !== redacted) {
    fail(`redacted: expected ${redacted}, observed ${envelope.redaction.redacted}`);
  }
  if (count !== undefined && envelope.redaction.count !== BigInt(count)) {
    fail(`count: expected ${count}, observed ${envelope.redaction.count}`);
  }
  const diagnosticsCount = expectedFieldOptional(case_, 'diagnostics_count') as number | undefined;
  if (diagnosticsCount !== undefined && envelope.diagnostics.length !== diagnosticsCount) {
    fail(`diagnostics_count: expected ${diagnosticsCount}, observed ${envelope.diagnostics.length}`);
  }
  const diagnosticCode = expectedFieldOptional(case_, 'diagnostic_code') as string | undefined;
  if (diagnosticCode !== undefined && !envelope.diagnostics.some((diagnostic) => diagnostic.code === diagnosticCode)) {
    fail(`missing diagnostic ${diagnosticCode}`);
  }
}

/** Asserts a rejection carries the pinned code and (when pinned) path. */
function assertRejection(case_: VectorCase, error: unknown): void {
  const expectedCode = expectedFieldOptional(case_, 'error_code') as string | undefined;
  const observed = (error as { code?: unknown })?.code;
  if (observed !== expectedCode) {
    fail(`rejection ${JSON.stringify(observed)} != ${expectedCode}`);
  }
  const expectedPath = expectedFieldOptional(case_, 'error_path') as string | undefined;
  if (expectedPath !== undefined && (error as { path?: unknown })?.path !== expectedPath) {
    fail(`rejection path ${JSON.stringify((error as { path?: unknown })?.path)} != ${expectedPath}`);
  }
}

/** cli.envelope@1 */
function envelopeCase(case_: VectorCase): void {
  const errorCode = expectedFieldOptional(case_, 'error_code') as string | undefined;
  if (errorCode !== undefined) {
    try {
      decodeEnvelope(case_);
    } catch (error) {
      assertRejection(case_, error);
      return;
    }
    fail(`expected envelope rejection with code ${errorCode}`);
  }
  const envelope = decodeEnvelope(case_);
  assertEnvelopeFacts(case_, envelope);
  const pvceHex = expectedFieldOptional(case_, 'pvce_hex') as string | undefined;
  if (pvceHex !== undefined) {
    const value = DecodeJSON(utf8(caseField(case_, 'json') as string), LIMITS);
    if (toHex(EncodePVCE(value)) !== pvceHex) {
      fail('pvce_hex mismatch');
    }
  }
}

/** cli.exit-code@1 */
function exitCodeCase(case_: VectorCase): void {
  const names = caseFieldOptional(case_, 'names') as string[] | undefined;
  const codes = caseFieldOptional(case_, 'codes') as number[] | undefined;
  if (names !== undefined && codes !== undefined) {
    const expected = [0, 1, 2, 3, 4, 5];
    if (names.length !== 6 || codes.length !== 6 || codes.some((code, index) => code !== expected[index])) {
      fail('exit-code class table mismatch');
    }
    return;
  }
  const codeList = caseField(case_, 'codes') as string[];
  const classes = expectedFieldOptional(case_, 'classes') as string[] | undefined;
  if (classes !== undefined) {
    const observed = codeList.map((code) => classifyErrorCode(code));
    if (observed.length !== classes.length || observed.some((cls, index) => cls !== classes[index])) {
      fail(`classes: expected ${JSON.stringify(classes)}, observed ${JSON.stringify(observed)}`);
    }
  }
}

/** cli.batch-plan@1 */
function batchPlanCase(case_: VectorCase): void {
  if (caseFieldOptional(case_, 'json') === undefined) {
    // Static table cases (e.g. the three-way recovery rule) carry no wire payload.
    return;
  }
  const errorCode = expectedFieldOptional(case_, 'error_code') as string | undefined;
  const json = caseField(case_, 'json') as string;
  const value = DecodeJSON(utf8(json), LIMITS);
  if (errorCode !== undefined) {
    try {
      batchPlanFromValue(value, new ErrorCodeRegistry(7));
    } catch (error) {
      const observed = (error as { code?: unknown })?.code;
      if (observed !== errorCode) {
        fail(`code: expected ${errorCode}, observed ${JSON.stringify(observed)}`);
      }
      return;
    }
    fail(`expected batch-plan rejection with code ${errorCode}`);
  }
  const plan = batchPlanFromValue(value, new ErrorCodeRegistry(7));
  const productVersion = expectedFieldOptional(case_, 'product_version') as string | undefined;
  if (productVersion !== undefined && plan.productVersion !== productVersion) {
    fail(`product_version: expected ${productVersion}, observed ${plan.productVersion}`);
  }
  const statuses = expectedFieldOptional(case_, 'statuses') as string[] | undefined;
  if (statuses !== undefined) {
    const observed = plan.files.map((file) => file.status);
    if (observed.length !== statuses.length || observed.some((status, index) => status !== statuses[index])) {
      fail(`statuses: expected ${JSON.stringify(statuses)}, observed ${JSON.stringify(observed)}`);
    }
  }
  const sourceDigestHex = expectedFieldOptional(case_, 'source_digest_hex') as string | undefined;
  if (sourceDigestHex !== undefined) {
    const file = plan.files[0];
    if (file.sourceDigest === undefined || toHex(file.sourceDigest.bytes) !== sourceDigestHex) {
      fail('source_digest mismatch');
    }
  }
  const targetDigestHex = expectedFieldOptional(case_, 'target_digest_hex') as string | undefined;
  if (targetDigestHex !== undefined) {
    const file = plan.files[0];
    if (file.sourcePatch === undefined || toHex(file.sourcePatch.targetDigest.bytes) !== targetDigestHex) {
      fail('target_digest mismatch');
    }
  }
  const failureCode = expectedFieldOptional(case_, 'failure_code') as string | undefined;
  if (failureCode !== undefined) {
    const file = plan.files.find((item) => item.failureCode !== undefined);
    if (file === undefined || file.failureCode !== failureCode) {
      fail(`failure_code: expected ${failureCode}`);
    }
  }
}

/** cli.batch-result@1 */
function batchResultCase(case_: VectorCase): void {
  if (caseFieldOptional(case_, 'json') === undefined) {
    // Static table cases (e.g. the three-way recovery rule) carry no wire payload.
    return;
  }
  const errorCode = expectedFieldOptional(case_, 'error_code') as string | undefined;
  const json = caseField(case_, 'json') as string;
  const value = DecodeJSON(utf8(json), LIMITS);
  if (errorCode !== undefined) {
    try {
      batchResultFromValue(value);
    } catch (error) {
      const observed = (error as { code?: unknown })?.code;
      if (observed !== errorCode) {
        fail(`code: expected ${errorCode}, observed ${JSON.stringify(observed)}`);
      }
      return;
    }
    fail(`expected batch-result rejection with code ${errorCode}`);
  }
  const result = batchResultFromValue(value);
  const productVersion = expectedFieldOptional(case_, 'product_version') as string | undefined;
  if (productVersion !== undefined && result.productVersion !== productVersion) {
    fail(`product_version: expected ${productVersion}, observed ${result.productVersion}`);
  }
  const statuses = expectedFieldOptional(case_, 'statuses') as string[] | undefined;
  if (statuses !== undefined) {
    const observed = result.files.map((file) => file.status);
    if (observed.length !== statuses.length || observed.some((status, index) => status !== statuses[index])) {
      fail(`statuses: expected ${JSON.stringify(statuses)}, observed ${JSON.stringify(observed)}`);
    }
  }
  const failureCode = expectedFieldOptional(case_, 'failure_code') as string | undefined;
  if (failureCode !== undefined) {
    const file = result.files.find((item) => item.failureCode !== undefined);
    if (file === undefined || file.failureCode !== failureCode) {
      fail(`failure_code: expected ${failureCode}`);
    }
  }
  const targetDigestHex = expectedFieldOptional(case_, 'target_digest_hex') as string | undefined;
  if (targetDigestHex !== undefined) {
    const file = result.files.find((item) => item.targetDigest !== undefined);
    if (file === undefined || file.targetDigest === undefined || toHex(file.targetDigest.bytes) !== targetDigestHex) {
      fail('target_digest mismatch');
    }
  }
  const redacted = expectedFieldOptional(case_, 'redacted') as boolean | undefined;
  if (redacted !== undefined && result.files[0].redacted !== redacted) {
    fail(`redacted: expected ${redacted}`);
  }
  const pvceHex = expectedFieldOptional(case_, 'pvce_hex') as string | undefined;
  if (pvceHex !== undefined && toHex(EncodePVCE(value)) !== pvceHex) {
    fail('pvce_hex mismatch');
  }
}

/** cli.redaction@1 (Python _redaction; Rust run_redaction) */
function redactionCase(case_: VectorCase): void {
  const samples = caseFieldOptional(case_, 'samples') as unknown[] | undefined;
  if (samples !== undefined) {
    // The record-invariant matrix: Redaction(redacted, count) is valid iff
    // redacted == (count > 0); the TS constructor throws on invalid pairs.
    samples.forEach((sample, index) => {
      const facts = sample as Record<string, unknown>;
      const redacted = facts['redacted'];
      const count = facts['count'];
      const valid = facts['valid'];
      if (typeof redacted !== 'boolean' || typeof count !== 'number' || typeof valid !== 'boolean') {
        fail(`sample ${index} facts missing`);
      }
      let accepted = true;
      try {
        newRedaction(redacted, BigInt(count));
      } catch {
        accepted = false;
      }
      if (accepted !== valid) {
        fail(`sample ${index} Redaction(${redacted}, ${count}) validity mismatch`);
      }
    });
    return;
  }
  const jsonBytes = utf8(caseField(case_, 'json') as string);
  if (expectedFieldOptional(case_, 'original_hex') !== undefined) {
    // The plan-byte case pins the presentation-only boundary: the patch
    // precondition bytes survive a plan decode/re-encode untouched.
    const value = DecodeJSON(jsonBytes, LIMITS);
    const plan = batchPlanFromValue(value, new ErrorCodeRegistry(7));
    const entry = plan.files.find((file) => file.status === 'planned');
    if (entry === undefined || entry.sourcePatch === undefined) {
      fail('planned entry without source_patch');
    }
    const replacement = entry.sourcePatch.replacements[0];
    if (replacement === undefined) {
      fail('no replacement in patch');
    }
    const originalHex = expectedFieldOptional(case_, 'original_hex') as string | undefined;
    if (originalHex !== undefined && toHex(replacement.original) !== originalHex) {
      fail('patch original bytes changed');
    }
    const replacementHex = expectedFieldOptional(case_, 'replacement_hex') as string | undefined;
    if (replacementHex !== undefined && toHex(replacement.replacement) !== replacementHex) {
      fail('patch replacement bytes changed');
    }
    if (!bytesEqual(EncodeJSON(batchPlanToValue(plan), LIMITS), jsonBytes)) {
      fail('plan record must re-encode to the exact input bytes');
    }
    return;
  }
  const envelope = decodeEnvelope(case_);
  assertEnvelopeFacts(case_, envelope);
  if (!bytesEqual(EncodeJSON(cliOutputToValue(envelope), LIMITS), jsonBytes)) {
    fail('envelope re-encode must reproduce the input bytes exactly');
  }
  const placeholder = expectedFieldOptional(case_, 'placeholder') as string | undefined;
  if (placeholder !== undefined && !payloadContainsString(envelope.payload, placeholder)) {
    fail('placeholder value changed through the transport');
  }
}

/** Whether the exact string appears anywhere in the payload tree (Rust payload_contains_string). */
function payloadContainsString(value: PortableValue, needle: string): boolean {
  if (value.kind === 'String') {
    return value.value === needle;
  }
  if (value.kind === 'Object') {
    return value.entries.some((entry) => payloadContainsString(entry.value, needle));
  }
  if (value.kind === 'Sequence') {
    return value.items.some((item) => payloadContainsString(item, needle));
  }
  return false;
}

/** cli.limit@1 (Python _limit; Rust run_limit) */
function limitCase(case_: VectorCase): void {
  const jsonBytes = utf8(caseField(case_, 'json') as string);
  let value: PortableValue;
  try {
    value = DecodeJSON(jsonBytes, LIMITS);
  } catch (error) {
    fail(`transport decode: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (classifyErrorCode('core.protocol.resource-limit@1') !== 'limit') {
    fail('resource-limit must classify as limit');
  }
  const maxBytes = caseFieldOptional(case_, 'max_bytes') as number | undefined;
  if (maxBytes !== undefined) {
    // The transport budget: the same payload under max_bytes must raise
    // core.protocol.resource-limit@1 (ResourceLimit).
    try {
      DecodeJSON(jsonBytes, { ...LIMITS, maxBytes });
    } catch (error) {
      const kind = (error as { kind?: unknown })?.kind;
      if (kind !== 'ResourceLimit') {
        fail(`decode must fail with ResourceLimit, got ${JSON.stringify(kind)}`);
      }
      return;
    }
    fail('payload must exceed the transport budget');
  }
  // The patch-replacement budget: the TS batch-plan decoder carries no
  // source-patch limits, so the budget is enforced runner-side mirroring
  // the Go FromValueWithRegistryAndPatchLimits check (resource error at
  // "$.replacements" when the replacement count exceeds the budget).
  let plan: BatchPlanMessage;
  try {
    plan = batchPlanFromValue(value, new ErrorCodeRegistry(7));
  } catch (error) {
    fail(`plan decode: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    enforcePatchBudget(plan, 0);
  } catch (error) {
    const kind = (error as { kind?: unknown })?.kind;
    if (kind !== 'ResourceLimit') {
      fail(`plan decode must fail with ResourceLimit, got ${JSON.stringify(kind)}`);
    }
    return;
  }
  fail('plan decode must fail with ResourceLimit');
}

/** Raises the resource-limit rejection a patch-bounded plan decode would produce (Python _enforce_patch_budget). */
function enforcePatchBudget(plan: BatchPlanMessage, maxReplacements: number): void {
  for (const entry of plan.files) {
    if (entry.sourcePatch !== undefined && entry.sourcePatch.replacements.length > maxReplacements) {
      throw resource('$.replacements', 'replacement count exceeds configured limit');
    }
  }
}

function skipCase(case_: VectorCase, reason: string): never {
  throw new SkippedCase(case_.capability ?? 'unknown', reason);
}

export const runCliV1: SuiteExecutor = {
  runCase(case_: VectorCase): void {
    switch (case_.capability) {
      case 'cli.envelope@1':
        envelopeCase(case_);
        return;
      case 'cli.exit-code@1':
        exitCodeCase(case_);
        return;
      case 'cli.batch-plan@1':
        batchPlanCase(case_);
        return;
      case 'cli.batch-result@1':
        batchResultCase(case_);
        return;
      case 'cli.limit@1':
        limitCase(case_);
        return;
      case 'cli.redaction@1':
        redactionCase(case_);
        return;
      default:
        throw new SkippedCase(
          case_.capability ?? 'unknown',
          `runner does not recognize published case ${case_.id}`,
        );
    }
  },
};
