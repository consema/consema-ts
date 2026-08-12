/**
 * Completion, execution-policy, and cancellation-request wire records.
 *
 * authority: crates/consema-protocol/src/execution.rs — Completion state
 * invariants (:40-187), ExecutionPolicy (:189-277), CancellationRequest
 * (:279-340); the fixed-field helpers mirror crates/consema-protocol/src/
 * schema.rs. The Python transcription (consema/conformance/protocol_records.py)
 * is the runner-side cross-reference.
 *
 * Design (TypeScript-idiomatic): plain records with private constructors and
 * validated static factories; every record self-registers its full decoder
 * with the envelope payload dispatch (payload.rs:34/44-46/61).
 */

import type { ObjectValue, PortableValue } from '../core/value.ts';
import { stringValue, integerValue, nullValue } from '../core/value.ts';
import {
  schemaFields,
  stringOf,
  unsigned64,
  nullableStringOf,
  objectOf,
  objectValueFrom,
} from './records.ts';
import { invalid } from './errors.ts';
import { ErrorCodeRegistry } from './error_registry.ts';
import { registerPayloadValidator } from './payload_validators.ts';

/** The six frozen completion states (execution.rs:11-25). */
export type CompletionStatus =
  | 'Success'
  | 'Failed'
  | 'Cancelled'
  | 'ResourceLimited'
  | 'Unsupported'
  | 'NotApplicable';

/** The `core.completion@1` control-flow facts (execution.rs:40-49). */
export class Completion {
  readonly status: CompletionStatus;
  /** Work items consumed before terminal state (u64). */
  readonly processed: bigint;
  /** Complete or locally discovered output count (u64). */
  readonly produced: bigint;
  /** Limit that stopped execution. */
  readonly limitName: string | null;
  /** Stable terminal failure code. */
  readonly failureCode: string | null;

  private constructor(
    status: CompletionStatus,
    processed: bigint,
    produced: bigint,
    limitName: string | null,
    failureCode: string | null,
  ) {
    this.status = status;
    this.processed = processed;
    this.produced = produced;
    this.limitName = limitName;
    this.failureCode = failureCode;
  }

  /** Validates the state invariants against the semantic-model v1 error registry (execution.rs:51-67). */
  static new(
    status: CompletionStatus,
    processed: bigint,
    produced: bigint,
    limitName: string | null = null,
    failureCode: string | null = null,
  ): Completion {
    return Completion.newWithRegistry(
      status,
      processed,
      produced,
      limitName,
      failureCode,
      new ErrorCodeRegistry(1),
    );
  }

  /** Validates completion facts against one explicit semantic-model registry (execution.rs:69-107). */
  static newWithRegistry(
    status: CompletionStatus,
    processed: bigint,
    produced: bigint,
    limitName: string | null,
    failureCode: string | null,
    registry: ErrorCodeRegistry,
  ): Completion {
    if (failureCode !== null) {
      validateRegisteredCode(registry, failureCode, '$.failure_code');
    }
    let valid = false;
    if (status === 'Success' || status === 'Cancelled') {
      valid = limitName === null && failureCode === null;
    } else if (status === 'ResourceLimited') {
      valid = limitName !== null && limitName !== '' && failureCode === null;
    } else if (status === 'Failed' || status === 'Unsupported' || status === 'NotApplicable') {
      valid = limitName === null && failureCode !== null && failureCode !== '';
    }
    if (!valid) {
      throw invalid('$', 'completion status contradicts limit/failure fields');
    }
    return new Completion(status, processed, produced, limitName, failureCode);
  }

  /** Encodes `core.completion@1` (execution.rs:141-153). */
  toValue(): ObjectValue {
    return objectValueFrom([
      { key: 'schema', value: stringValue('core.completion@1') },
      { key: 'status', value: stringValue(this.status) },
      { key: 'processed', value: integerValue(this.processed) },
      { key: 'produced', value: integerValue(this.produced) },
      { key: 'limit_name', value: nullableStringValue(this.limitName) },
      { key: 'failure_code', value: nullableStringValue(this.failureCode) },
    ]);
  }

  /** Strictly decodes `core.completion@1` under the v1 registry (execution.rs:156-158). */
  static fromValue(value: PortableValue): Completion {
    return Completion.fromValueWithRegistry(value, new ErrorCodeRegistry(1));
  }

  /** Strictly decodes `core.completion@1` under one explicit registry (execution.rs:161-186). */
  static fromValueWithRegistry(value: PortableValue, registry: ErrorCodeRegistry): Completion {
    const fields = schemaFields(
      value,
      'core.completion@1',
      ['status', 'processed', 'produced', 'limit_name', 'failure_code'],
      '$',
    );
    return Completion.newWithRegistry(
      parseCompletionStatus(stringOf(fields[0], '$.status')),
      unsigned64(fields[1], '$.processed'),
      unsigned64(fields[2], '$.produced'),
      nullableStringOf(fields[3], '$.limit_name'),
      nullableStringOf(fields[4], '$.failure_code'),
      registry,
    );
  }

  /** Ordered equality over the completion facts. */
  equal(other: Completion): boolean {
    return (
      this.status === other.status &&
      this.processed === other.processed &&
      this.produced === other.produced &&
      this.limitName === other.limitName &&
      this.failureCode === other.failureCode
    );
  }
}

/** The transferable `core.execution-policy@1` record (execution.rs:189-195). */
export class ExecutionPolicy {
  /** Named limits sorted by key on the wire. */
  readonly limits: ReadonlyMap<string, bigint>;
  /** Optional outer-transport cancellation request ID. */
  readonly cancellationRequestId: string | null;

  private constructor(
    limits: ReadonlyMap<string, bigint>,
    cancellationRequestId: string | null,
  ) {
    this.limits = new Map(limits);
    this.cancellationRequestId = cancellationRequestId;
  }

  /** Validates the limit names and the cancellation ID (execution.rs:196-221). */
  static new(
    limits: ReadonlyMap<string, bigint>,
    cancellationRequestId: string | null = null,
  ): ExecutionPolicy {
    for (const name of limits.keys()) {
      if (!validLimitName(name)) {
        throw invalid('$.limits', 'limit names must be stable lowercase identifiers');
      }
    }
    if (
      cancellationRequestId !== null &&
      (cancellationRequestId === '' || cancellationRequestId.length > 1024)
    ) {
      throw invalid('$.cancellation_request_id', 'invalid cancellation request ID');
    }
    return new ExecutionPolicy(limits, cancellationRequestId);
  }

  /** Encodes `core.execution-policy@1` (execution.rs:237-252). */
  toValue(): ObjectValue {
    const names = [...this.limits.keys()].sort();
    return objectValueFrom([
      { key: 'schema', value: stringValue('core.execution-policy@1') },
      {
        key: 'limits',
        value: {
          kind: 'Object',
          entries: names.map((name) => ({ key: name, value: integerValue(this.limits.get(name)!) })),
        },
      },
      {
        key: 'cancellation_request_id',
        value: nullableStringValue(this.cancellationRequestId),
      },
    ]);
  }

  /** Strictly decodes `core.execution-policy@1` (execution.rs:255-276). */
  static fromValue(value: PortableValue): ExecutionPolicy {
    const fields = schemaFields(
      value,
      'core.execution-policy@1',
      ['limits', 'cancellation_request_id'],
      '$',
    );
    const limitsValue = objectOf(fields[0], '$.limits');
    const limits = new Map<string, bigint>();
    for (const entry of limitsValue.entries) {
      limits.set(entry.key, unsigned64(entry.value, `$.limits.${entry.key}`));
    }
    return ExecutionPolicy.new(limits, nullableStringOf(fields[1], '$.cancellation_request_id'));
  }
}

/** The idempotent outer-transport `core.cancellation-request@1` record (execution.rs:279-290). */
export class CancellationRequest {
  readonly requestId: string;
  readonly reason: string | null;

  private constructor(requestId: string, reason: string | null) {
    this.requestId = requestId;
    this.reason = reason;
  }

  /** Creates a request; this is not a serialized CancellationToken (execution.rs:286-299). */
  static new(requestId: string, reason: string | null = null): CancellationRequest {
    if (requestId === '' || requestId.length > 1024) {
      throw invalid('$.request_id', 'invalid request ID');
    }
    return new CancellationRequest(requestId, reason);
  }

  /** Encodes `core.cancellation-request@1` (execution.rs:313-325). */
  toValue(): ObjectValue {
    return objectValueFrom([
      { key: 'schema', value: stringValue('core.cancellation-request@1') },
      { key: 'request_id', value: stringValue(this.requestId) },
      { key: 'reason', value: nullableStringValue(this.reason) },
    ]);
  }

  /** Strictly decodes `core.cancellation-request@1` (execution.rs:328-339). */
  static fromValue(value: PortableValue): CancellationRequest {
    const fields = schemaFields(
      value,
      'core.cancellation-request@1',
      ['request_id', 'reason'],
      '$',
    );
    return CancellationRequest.new(
      stringOf(fields[0], '$.request_id'),
      nullableStringOf(fields[1], '$.reason'),
    );
  }
}

/** Parses one canonical completion status spelling (execution.rs:353-366). */
function parseCompletionStatus(text: string): CompletionStatus {
  switch (text) {
    case 'Success':
    case 'Failed':
    case 'Cancelled':
    case 'ResourceLimited':
    case 'Unsupported':
    case 'NotApplicable':
      return text;
    default:
      throw invalid('$.status', 'unknown completion status');
  }
}

/** The stable lowercase limit-name rule (execution.rs:368-374). */
function validLimitName(name: string): boolean {
  if (name === '' || name.length > 255) {
    return false;
  }
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    const lower = code >= 0x61 && code <= 0x7a;
    const digit = code >= 0x30 && code <= 0x39;
    if (!lower && !digit && code !== 0x5f) {
      return false;
    }
  }
  return true;
}

/**
 * Rejects an unregistered public code with the frozen InvalidValue rejection.
 * The registry helper itself throws a plain Error; the record boundary
 * converts it to the protocol rejection exactly like error_registry.rs:1500-1510.
 */
function validateRegisteredCode(registry: ErrorCodeRegistry, code: string, path: string): void {
  try {
    registry.validateAt(code, path);
  } catch {
    throw invalid(path, `unregistered public code: ${code}`);
  }
}

/** The Null singleton or a String leaf of an optional string field. */
function nullableStringValue(value: string | null): PortableValue {
  return value === null ? nullValue() : stringValue(value);
}

// Envelope payload dispatch (payload.rs:34, 44-46, 61): every completion,
// execution-policy, and cancellation-request payload validates through its
// record decoder at module load.
registerPayloadValidator('core.completion', 1, (payload, registry) => {
  Completion.fromValueWithRegistry(payload, new ErrorCodeRegistry(registry.versionOf()));
});

registerPayloadValidator('core.execution-policy', 1, (payload) => {
  ExecutionPolicy.fromValue(payload);
});

registerPayloadValidator('core.cancellation-request', 1, (payload) => {
  CancellationRequest.fromValue(payload);
});
