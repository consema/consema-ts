/**
 * TOML materialization intent tests — the canonical-document style writer
 * with fidelity, report, and provenance.
 *
 * These are blind-written intent documents (docs/multi-language-implementation
 * -plan.md §3): they transcribe the language-neutral facts from RFC 0004
 * §4/§6/§7/§8 and crates/consema-toml/src/materialization.rs and run once
 * the toolchain is ready. The TOML vector suite has no materialization
 * cases; the Rust tests are the cross-reference for the canonical bytes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MaterializationRequest, MaterializationStyleId } from '../document/materialization.ts';
import { ProfileId } from '../document/profile.ts';
import {
  stringValue,
  integerValue,
  booleanValue,
  binaryFloat64Value,
  dateValue,
  timeValue,
  decimalValue,
  localDateTimeValue,
  offsetDateTimeValue,
  sequenceValue,
  objectValue,
  entryMappingValue,
} from '../core/value.ts';
import { materializeToml, canonicalTomlFragment } from './materialization.ts';
import { projectToml, TomlProjectionRequest, TOML_PROJECTION_TARGET_BEST_EXACT_CORE_V1 } from './projection.ts';
import { DEFAULT_MATERIALIZATION_LIMITS } from '../document/materialization.ts';

function request(newline: 'Lf' | 'CrLf' = 'Lf'): MaterializationRequest {
  return new MaterializationRequest(
    new ProfileId('toml.1.0', 1),
    new MaterializationStyleId('toml.canonical-document', 1),
  ).withNewline(newline);
}

function complete(result: ReturnType<typeof materializeToml>) {
  if (result.kind !== 'Complete') {
    assert.fail('materialization must complete');
  }
  return result.value;
}

function bytesOf(value: ReturnType<typeof complete>): string {
  return new TextDecoder().decode(value.document().render());
}

test('canonical document round-trips scalar, container, and temporal values', () => {
  // materialization.rs:908-959 test shape: the materialized document
  // reparses and projects to the exact input value; fidelity Exact; the
  // output ends with one final newline.
  const date = dateValue(2026n, 8, 4);
  const time = timeValue(12, 34, 56, decimalValue(123n, -3n));
  const local = localDateTimeValue(date, time);
  const offset = offsetDateTimeValue(local, 8 * 60 * 60);
  const nested = objectValue([{ key: 'enabled', value: booleanValue(true) }]);
  const sequence = sequenceValue([integerValue(1n), stringValue('two')]);
  const root = objectValue([
    { key: 'date', value: date },
    { key: 'time', value: time },
    { key: 'local', value: local },
    { key: 'offset', value: offset },
    { key: 'items', value: sequence },
    { key: 'nested', value: nested },
    { key: 'float', value: binaryFloat64Value(f64Bits(1.5)) },
    { key: 'nan', value: binaryFloat64Value(0x7ff8000000000000n) },
  ]);

  const result = complete(materializeToml(root, request()));
  assert.equal(result.fidelity(), 'Exact');
  assert.ok(bytesOf(result).endsWith('\n'));
  assert.equal(
    bytesOf(result),
    [
      '"date" = 2026-08-04',
      '"time" = 12:34:56.123',
      '"local" = 2026-08-04T12:34:56.123',
      '"offset" = 2026-08-04T12:34:56.123+08:00',
      '"items" = [1, "two"]',
      '"nested" = { "enabled" = true }',
      '"float" = 1.5',
      '"nan" = nan',
      '',
    ].join('\n'),
  );

  const projection = projectToml(
    result.document(),
    new TomlProjectionRequest(TOML_PROJECTION_TARGET_BEST_EXACT_CORE_V1),
  );
  assert.equal(projection.kind, 'Complete');
  assert.deepEqual(projection.value.value(), root);
});

test('root keys are quoted deterministically; nested objects are inline tables', () => {
  const root = objectValue([
    { key: 'a b', value: integerValue(1n) },
    { key: 'tab\tkey', value: booleanValue(false) },
  ]);
  const result = complete(materializeToml(root, request('CrLf')));
  assert.equal(bytesOf(result), '"a b" = 1\r\n"tab\\tkey" = false\r\n');
});

test('explicit unique-string mapping conversion is reported and reversible as Object', () => {
  // materialization.rs:961-994 test shape: EntryMapping under the explicit
  // policy becomes an Object; fidelity Transformed; the single report event
  // is core.materialization.mapping-transformed@1; render is byte-exact.
  const mapping = entryMappingValue([
    { key: stringValue('a'), value: booleanValue(true) },
    { key: stringValue('b'), value: integerValue(2n) },
  ]);
  const result = complete(
    materializeToml(
      mapping,
      request('CrLf').withMappingPolicy('UniqueStringEntriesToObject'),
    ),
  );
  assert.equal(result.fidelity(), 'Transformed');
  assert.equal(bytesOf(result), '"a" = true\r\n"b" = 2\r\n');
  const events = result.report().events();
  assert.equal(events.length, 1);
  assert.equal(events[0].code, 'core.materialization.mapping-transformed@1');
  assert.equal(events[0].arguments.get('from'), 'EntryMapping');
  assert.equal(events[0].arguments.get('policy'), 'UniqueStringEntriesToObject');
  assert.equal(events[0].arguments.get('to'), 'Object');

  const projection = projectToml(
    result.document(),
    new TomlProjectionRequest(TOML_PROJECTION_TARGET_BEST_EXACT_CORE_V1),
  );
  assert.equal(projection.kind, 'Complete');
  assert.deepEqual(projection.value.value(), objectValue([
    { key: 'a', value: booleanValue(true) },
    { key: 'b', value: integerValue(2n) },
  ]));
});

test('materialization provenance covers every emitted value and association', () => {
  const root = objectValue([
    { key: 'items', value: sequenceValue([integerValue(1n), integerValue(2n)]) },
  ]);
  const result = complete(materializeToml(root, request()));
  const entries = result.provenance().entries();
  assert.ok(entries.length > 0);
  const snapshot = entries[0].outputs()[0].snapshot();
  for (const entry of entries) {
    for (const origin of entry.outputs()) {
      assert.ok(origin.snapshot().equals(snapshot), 'origin is snapshot-bound');
      assert.ok(origin.node().snapshot().equals(snapshot));
      assert.ok(origin.span().snapshot().equals(snapshot));
    }
  }
  const roles = new Set(
    entries.flatMap((entry) => entry.outputs().map((origin) => origin.node().role())),
  );
  assert.ok(roles.has('TomlItem'));
  assert.ok(roles.has('TomlEntry'));
  assert.ok(roles.has('TomlKey'));
  const relations = new Set(entries.flatMap((entry) => entry.outputs().map((origin) => origin.relation())));
  assert.ok(relations.has('Direct'));
});

test('unrepresentable values and implicit mapping conversion fail without partial bytes', () => {
  // materialization.rs:996-1114 test shape.
  const tooLarge = objectValue([
    { key: 'value', value: integerValue(9223372036854775808n) },
  ]);
  const tooLargeResult = materializeToml(tooLarge, request());
  assert.equal(tooLargeResult.kind, 'Failed');
  if (tooLargeResult.kind === 'Failed') {
    assert.equal(tooLargeResult.value.failure().kind, 'Unrepresentable');
    assert.equal(tooLargeResult.value.failure().valueKind, 'Integer');
  }

  const mapping = entryMappingValue([{ key: stringValue('x'), value: booleanValue(true) }]);
  const implicit = materializeToml(mapping, request());
  assert.equal(implicit.kind, 'Failed');
  if (implicit.kind === 'Failed') {
    assert.equal(implicit.value.failure().valueKind, 'EntryMapping');
  }

  const duplicate = entryMappingValue([
    { key: stringValue('x'), value: booleanValue(true) },
    { key: stringValue('x'), value: booleanValue(false) },
  ]);
  const duplicateResult = materializeToml(
    duplicate,
    request().withMappingPolicy('UniqueStringEntriesToObject'),
  );
  assert.equal(duplicateResult.kind, 'Failed');
  if (duplicateResult.kind === 'Failed') {
    assert.equal(duplicateResult.value.failure().valueKind, 'String');
  }

  const nanPayload = objectValue([
    { key: 'nan', value: binaryFloat64Value(0x7ff8000000000001n) },
  ]);
  const nanResult = materializeToml(nanPayload, request());
  assert.equal(nanResult.kind, 'Failed');
  if (nanResult.kind === 'Failed') {
    assert.equal(nanResult.value.failure().valueKind, 'BinaryFloat64');
  }

  const limited = objectValue([{ key: 'value', value: booleanValue(true) }]);
  const limitedResult = materializeToml(
    limited,
    request().withLimits({ ...DEFAULT_MATERIALIZATION_LIMITS, maxOutputBytes: 3 }),
  );
  assert.equal(limitedResult.kind, 'Failed');
  if (limitedResult.kind === 'Failed') {
    assert.equal(limitedResult.value.failure().kind, 'ResourceLimit');
    assert.equal(limitedResult.value.failure().reason, 'output-bytes');
  }

  const noneNewline = materializeToml(objectValue([]), request().withNewline('None'));
  assert.equal(noneNewline.kind, 'Failed');
  if (noneNewline.kind === 'Failed') {
    assert.equal(noneNewline.value.failure().kind, 'UnsupportedNewline');
  }
});

test('canonical fragment renders one canonical value for structural edits', () => {
  const fragment = canonicalTomlFragment(
    sequenceValue([booleanValue(true), stringValue('x\ny')]),
    DEFAULT_MATERIALIZATION_LIMITS,
  );
  assert.equal(new TextDecoder().decode(fragment), '[true, "x\\ny"]');
});

function f64Bits(value: number): bigint {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  return view.getBigUint64(0, false);
}
