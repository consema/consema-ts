/**
 * Intent documents for the common MaterializationRequest v1 and its
 * completion algebra (RFC 0004 §3/§7/§8;
 * crates/consema-document/src/materialization.rs).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MaterializationRequest,
  MaterializationStyleId,
  type MaterializationLimits,
  MaterializationReport,
  MaterializationProvenanceMap,
  MaterializationProvenanceEntry,
  MaterializedOrigin,
  newlineBytes,
} from './materialization.ts';
import { DEFAULT_MATERIALIZATION_LIMITS } from './materialization.ts';
import { encodingAsStr, utf8Encoding } from './source.ts';
import { DocumentAuthority } from './identity.ts';
import { ProfileId } from './profile.ts';
import { ValuePath, AssociationLocation } from './portable_locations.ts';
import { MaterializationFailure } from './errors.ts';
import { diagnostic } from './diagnostic.ts';

function request(): MaterializationRequest {
  return new MaterializationRequest(
    new ProfileId('json.strict', 1),
    new MaterializationStyleId('json.canonical-pretty', 1),
  );
}

test('request defaults are strict: UTF-8, Lf, RequireObject, ExactOnly (materialization.rs:120-132)', () => {
  const r = request();
  assert.equal(r.targetProfile().toString(), 'json.strict@1');
  assert.equal(r.style().toString(), 'json.canonical-pretty@1');
  assert.equal(encodingAsStr(r.encoding()), 'utf-8');
  assert.equal(r.newline(), 'Lf');
  assert.equal(r.mappingPolicy(), 'RequireObject');
  assert.equal(r.representability(), 'ExactOnly');
  assert.deepEqual(r.limits(), DEFAULT_MATERIALIZATION_LIMITS);
});

test('request builders keep every explicit policy (materialization.rs:134-160)', () => {
  const r = request()
    .withEncoding(utf8Encoding())
    .withNewline('CrLf')
    .withMappingPolicy('UniqueStringEntriesToObject')
    .withLimits({ ...DEFAULT_MATERIALIZATION_LIMITS, maxOutputBytes: 10 });
  assert.equal(r.newline(), 'CrLf');
  assert.equal(r.mappingPolicy(), 'UniqueStringEntriesToObject');
  assert.equal(r.limits().maxOutputBytes, 10);
  // Builders are immutable: the base request is untouched.
  assert.equal(request().newline(), 'Lf');
});

test('newline bytes are the frozen sequences (materialization.rs:53-62)', () => {
  assert.deepEqual(Array.from(newlineBytes('None')), []);
  assert.deepEqual(Array.from(newlineBytes('Lf')), [0x0a]);
  assert.deepEqual(Array.from(newlineBytes('CrLf')), [0x0d, 0x0a]);
});

test('report enforces the event limit (materialization.rs:220-229)', () => {
  const limits: MaterializationLimits = { ...DEFAULT_MATERIALIZATION_LIMITS, maxReportEntries: 1 };
  const report = new MaterializationReport(
    [diagnostic('core.materialization.mapping-transformed@1', 'Materialization', 'Warning', null, 0n)],
    limits,
  );
  assert.equal(report.events().length, 1);
  assert.throws(
    () =>
      new MaterializationReport(
        [
          diagnostic('a@1', 'Materialization', 'Warning', null, 0n),
          diagnostic('b@1', 'Materialization', 'Warning', null, 1n),
        ],
        limits,
      ),
    (error: unknown) => {
      assert.ok(error instanceof MaterializationFailure);
      assert.equal(error.kind, 'ResourceLimit');
      assert.equal(error.reason, 'report-entries');
      assert.equal(error.code, 'core.materialization.resource-limit@1');
      return true;
    },
  );
});

test('provenance is target bound and limited (materialization.rs:287-325)', () => {
  const authority = DocumentAuthority.fresh();
  const target = authority.identity();
  const origin = new MaterializedOrigin(
    target,
    authority.nodeRef(0n, 'Value'),
    authority.span(0, 1),
    'Direct',
  );
  const entry = new MaterializationProvenanceEntry(
    { kind: 'Association', location: new AssociationLocation(ValuePath.root(), 0n, 'ObjectEntry') },
    [origin],
  );
  const map = MaterializationProvenanceMap.create([entry], target, DEFAULT_MATERIALIZATION_LIMITS);
  assert.equal(map.entries().length, 1);

  // An entry with no output is an invalid request.
  const empty = new MaterializationProvenanceEntry({ kind: 'Value', path: ValuePath.root() }, []);
  assert.throws(
    () => MaterializationProvenanceMap.create([empty], target, DEFAULT_MATERIALIZATION_LIMITS),
    (error: unknown) => {
      assert.ok(error instanceof MaterializationFailure);
      assert.equal(error.kind, 'InvalidRequest');
      return true;
    },
  );

  // An origin bound to another snapshot is an invalid request.
  const otherAuthority = DocumentAuthority.fresh();
  const foreign = new MaterializedOrigin(
    otherAuthority.identity(),
    otherAuthority.nodeRef(0n, 'Value'),
    otherAuthority.span(0, 1),
    'Direct',
  );
  const foreignEntry = new MaterializationProvenanceEntry(
    { kind: 'Value', path: ValuePath.root() },
    [foreign],
  );
  assert.throws(
    () => MaterializationProvenanceMap.create([foreignEntry], target, DEFAULT_MATERIALIZATION_LIMITS),
    (error: unknown) => error instanceof MaterializationFailure && error.kind === 'InvalidRequest',
  );
});
