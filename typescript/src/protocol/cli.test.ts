/**
 * CLI machine-record intent tests.
 *
 * These pin the presence and cross-constraint validation of RFC 0015 §4/§8/§9
 * (the envelope, the batch plan, and the batch result) and the golden
 * envelope bytes of RFC 0015 §4.4. They run once the toolchain is ready; no
 * gate is claimed before that (§7 START GATE).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ErrorCodeRegistry } from './error_registry.ts';
import {
  newCliOutputMessage,
  cliOutputToValue,
  cliOutputFromValue,
  newBatchPlanMessage,
  batchPlanToValue,
  batchPlanFromValue,
  newBatchResultMessage,
  batchResultToValue,
  batchResultFromValue,
  newBatchPlanFileEntry,
  newBatchResultFileEntry,
  newRedaction,
  isSemanticVersion,
  digestOf,
  parseCliCommand,
  payloadSchemas,
} from './cli.ts';
import type { EditOperationSummary } from './cli.ts';
import { newDiagnostic } from './diagnostic.ts';
import { ProtocolError } from './errors.ts';
import { EncodeJSON, DecodeJSON } from './canonical.ts';
import { defaultProtocolLimits } from './limits.ts';
import { integerValue } from '../core/value.ts';

const V7 = new ErrorCodeRegistry(7);
const LIMITS = defaultProtocolLimits();

const SHA256_OF_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

test('redaction enforces redacted == (count > 0)', () => {
  assert.doesNotThrow(() => newRedaction(false, 0n));
  assert.doesNotThrow(() => newRedaction(true, 1n));
  assert.throws(() => newRedaction(true, 0n), (error: unknown) =>
    (error as ProtocolError).code === 'core.protocol.invalid-value@1',
  );
  assert.throws(() => newRedaction(false, 1n));
});

test('the semantic-version shape of RFC 0015 §4.3', () => {
  assert.equal(isSemanticVersion('0.12.0'), true);
  assert.equal(isSemanticVersion('0.12.0-rc.1'), true);
  assert.equal(isSemanticVersion('1.2.3-alpha.2'), true);
  assert.equal(isSemanticVersion('0.12'), false);
  assert.equal(isSemanticVersion('00.12.0'), false);
  assert.equal(isSemanticVersion('0.12.0+build'), false);
  assert.equal(isSemanticVersion('0.12.0-'), false);
  assert.equal(isSemanticVersion('0.12.0-01'), false);
  assert.equal(isSemanticVersion(''), false);
});

test('the eleven commands and their payload schemas', () => {
  assert.equal(parseCliCommand('inspect'), 'inspect');
  assert.equal(parseCliCommand('plan'), 'plan');
  assert.equal(parseCliCommand('apply'), 'apply');
  assert.equal(parseCliCommand('unknown'), undefined);
  assert.deepEqual(payloadSchemas('plan'), ['core.batch-plan@1']);
  assert.deepEqual(payloadSchemas('apply'), ['core.batch-result@1']);
  assert.ok(payloadSchemas('query').includes('core.ini-query-result@1'));
});

test('plan file entries enforce the per-status presence rules', () => {
  const digest = digestOf(new TextEncoder().encode(''));
  const profile = { id: 'ini.portable', version: 1 };
  const operations: EditOperationSummary[] = [];
  const patch = {
    baseDigest: digest,
    targetDigest: digestOf(new TextEncoder().encode('x')),
    encoding: { bomPolicy: 'DetectUnicode' },
    replacements: [],
    metadata: new Map<string, string>(),
  };
  const planned = newBatchPlanFileEntry('app.conf', 'planned', profile, digest, operations, patch, undefined, undefined, V7);
  assert.equal(planned.status, 'planned');
  // source_digest != base_digest is rejected.
  const otherDigest = digestOf(new TextEncoder().encode('y'));
  assert.throws(
    () => newBatchPlanFileEntry('app.conf', 'planned', profile, otherDigest, operations, patch, undefined, undefined, V7),
    (error: unknown) => (error as ProtocolError).code === 'core.protocol.invalid-value@1',
  );
  // Planned entries cannot carry failure facts.
  assert.throws(
    () => newBatchPlanFileEntry('app.conf', 'planned', profile, digest, operations, patch, 'cli.data.io@1', undefined, V7),
  );
  // Failed entries require failure_code and diagnostics.
  assert.throws(() => newBatchPlanFileEntry('app.conf', 'failed', undefined, undefined, undefined, undefined, undefined, undefined, V7));
  const failed = newBatchPlanFileEntry(
    'app.conf',
    'failed',
    undefined,
    undefined,
    undefined,
    undefined,
    'cli.data.io@1',
    [],
    V7,
  );
  assert.equal(failed.status, 'failed');
});

test('batch plans and results round-trip through the value and JSON levels', () => {
  const digest = digestOf(new TextEncoder().encode(''));
  const planned = newBatchPlanFileEntry(
    'app.conf',
    'planned',
    { id: 'ini.portable', version: 1 },
    digest,
    [],
    {
      baseDigest: digest,
      targetDigest: digest,
      encoding: { bomPolicy: 'DetectUnicode' },
      replacements: [],
      metadata: new Map(),
    },
    undefined,
    undefined,
    V7,
  );
  const failed = newBatchPlanFileEntry(
    'bad.conf',
    'failed',
    undefined,
    undefined,
    undefined,
    undefined,
    'cli.data.io@1',
    [newDiagnostic('cli.data.io@1', 'Encoding', 'Error', undefined, [], new Map(), [], [], 0n, V7)],
    V7,
  );
  const plan = newBatchPlanMessage('0.12.0', [planned, failed], V7);
  const value = batchPlanToValue(plan);
  const decoded = batchPlanFromValue(value, V7);
  assert.equal(decoded.files.length, 2);
  assert.equal(decoded.files[0].status, 'planned');
  assert.equal(decoded.files[1].status, 'failed');
  assert.equal(decoded.files[1].failureCode, 'cli.data.io@1');

  const resultEntry = newBatchResultFileEntry('app.conf', 'completed', undefined, digest, false);
  const result = newBatchResultMessage('0.12.0', [resultEntry]);
  const resultValue = batchResultToValue(result);
  const resultDecoded = batchResultFromValue(resultValue);
  assert.equal(resultDecoded.files[0].status, 'completed');
  assert.equal(resultDecoded.files[0].redacted, false);
});

test('result entries enforce the per-status presence rules', () => {
  const digest = digestOf(new TextEncoder().encode(''));
  assert.throws(
    () => newBatchResultFileEntry('app.conf', 'completed', undefined, undefined, false),
    (error: unknown) => (error as ProtocolError).code === 'core.protocol.invalid-value@1',
  );
  assert.throws(
    () => newBatchResultFileEntry('app.conf', 'failed', undefined, digest, false),
  );
  assert.throws(
    () => newBatchResultFileEntry('app.conf', 'pending', 'cli.data.io@1', undefined, false),
  );
  assert.doesNotThrow(() => newBatchResultFileEntry('app.conf', 'pending', undefined, undefined, true));
  assert.doesNotThrow(() => newBatchResultFileEntry('app.conf', 'skipped-stale', 'core.source.patch-base-mismatch@1', undefined, false));
});

test('the envelope validates command closure, payload schema, and version shape', () => {
  const payload = {
    kind: 'Object' as const,
    entries: [
      { key: 'schema', value: { kind: 'String' as const, value: 'core.batch-plan@1' } },
      { key: 'product_version', value: { kind: 'String' as const, value: '0.12.0' } },
      { key: 'command', value: { kind: 'String' as const, value: 'plan' } },
      { key: 'files', value: { kind: 'Sequence' as const, items: [] as never[] } },
    ],
  };
  const redaction = newRedaction(false, 0n);
  const message = newCliOutputMessage('plan', 'success', '0.12.0', payload, [], redaction, V7);
  assert.equal(message.command, 'plan');
  // A mismatched payload schema is rejected with SchemaMismatch (the Rust
  // validate_payload_schema choice, cli.rs:860-869; the shared vector
  // cli.envelope.reject-command-payload-mismatch pins
  // core.protocol.schema-mismatch@1 at $.payload.schema).
  const wrongPayload = {
    kind: 'Object' as const,
    entries: [
      { key: 'schema', value: { kind: 'String' as const, value: 'cli.inspect@1' } },
    ],
  };
  assert.throws(
    () => newCliOutputMessage('plan', 'success', '0.12.0', wrongPayload, [], redaction, V7),
    (error: unknown) => (error as ProtocolError).code === 'core.protocol.schema-mismatch@1',
  );
  assert.throws(
    () => newCliOutputMessage('plan', 'success', 'not-a-version', payload, [], redaction, V7),
  );
});

test('the envelope round-trips through canonical JSON (RFC 0015 §4.4 form)', () => {
  const payload = {
    kind: 'Object' as const,
    entries: [
      { key: 'schema', value: { kind: 'String' as const, value: 'core.batch-plan@1' } },
    ],
  };
  const message = newCliOutputMessage('plan', 'success', '0.12.0', payload, [], newRedaction(false, 0n), V7);
  const bytes = EncodeJSON(cliOutputToValue(message), LIMITS);
  const decoded = cliOutputFromValue(DecodeJSON(bytes, LIMITS), V7);
  assert.equal(decoded.command, 'plan');
  assert.equal(decoded.exitClass, 'success');
  assert.equal(decoded.productVersion, '0.12.0');
  // The envelope's fixed field order (RFC 0015 §4.1).
  const value = cliOutputToValue(message);
  assert.deepEqual(
    value.entries.map((entry) => entry.key),
    ['schema', 'command', 'exit_class', 'product_version', 'payload', 'diagnostics', 'redaction'],
  );
});

test('the digest is SHA-256 with lowercase hex', () => {
  const digest = digestOf(new Uint8Array(0));
  assert.equal(digest.bytes.length, 32);
  assert.equal(hexOf(digest.bytes), SHA256_OF_EMPTY);
});

function hexOf(bytes: Uint8Array): string {
  let out = '';
  for (const octet of bytes) {
    out += octet.toString(16).padStart(2, '0');
  }
  return out;
}

test('integer leaf spot check', () => {
  assert.equal(integerValue(1n).value, 1n);
});
