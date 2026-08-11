/**
 * INI projection intent tests.
 *
 * These are blind-written intent documents (docs/multi-language-implementation
 * -plan.md §3): they transcribe the language-neutral facts from
 * conformance/vectors/ini-v1.json and crates/consema-ini/src/projection.rs
 * and run once the toolchain is ready. Golden vector case ids are cited in
 * each test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_INI_PARSE_LIMITS,
  IniProfile,
  profileDefaultSelection,
} from './profile.ts';
import { parseIniDocument } from './document.ts';
import type { PortableValue } from '../core/value.ts';
import {
  IniProjectionRequest,
  projectIni,
  type IniProjectionResult,
  type IniProvenanceRelation,
} from './projection.ts';

function parseText(profile: IniProfile, text: string) {
  return parseIniDocument(
    new TextEncoder().encode(text),
    profile,
    profileDefaultSelection(),
    DEFAULT_INI_PARSE_LIMITS,
  );
}

function relationPresent(result: IniProjectionResult, relation: IniProvenanceRelation): boolean {
  if (result.kind !== 'Complete') {
    return false;
  }
  return result.value
    .provenance()
    .entries()
    .some((entry) => entry.origins().some((origin) => origin.relation() === relation));
}

test('golden projection.exact-duplicate-entry-mapping: duplicates preserved in order', () => {
  // conformance/vectors/ini-v1.json:59-63 — the exact EntryMapping keeps
  // section keys [Main, main] and the first section's entry keys
  // [Name, name], fidelity Exact, zero events, association provenance.
  const document = parseText(
    IniProfile.WINDOWS_V1,
    '[Main]\r\nName=one\r\nname=two\r\n[main]\r\nOther=three\r\n',
  );
  const result = projectIni(document, IniProjectionRequest.bestExactEntryMapping());
  assert.equal(result.kind, 'Complete');
  if (result.kind !== 'Complete') {
    return;
  }
  assert.equal(result.value.fidelity(), 'Exact');
  assert.equal(result.value.report().events().length, 0);
  const value = result.value.value();
  assert.equal(value.kind, 'EntryMapping');
  assert.deepEqual(
    value.entries.map((entry) => (entry.key.kind === 'String' ? entry.key.value : '')),
    ['Main', 'main'],
  );
  const first = value.entries[0].value;
  assert.equal(first.kind, 'EntryMapping');
  assert.deepEqual(
    first.entries.map((entry) => (entry.key.kind === 'String' ? entry.key.value : '')),
    ['Name', 'name'],
  );
  assert.ok(
    result.value
      .provenance()
      .entries()
      .some((entry) => entry.projected().kind === 'Association'),
  );
});

test('golden projection.explicit-object-collapse: Reject fails; First/Last report every collapse', () => {
  // conformance/vectors/ini-v1.json:64-68 — RequireObject under
  // ProfileEquivalent rejects; First yields Transformed with two events and
  // "Main"/"Name"/"one"; Last yields "main"/"Other"/"three"; collapsed
  // provenance is present.
  const document = parseText(
    IniProfile.WINDOWS_V1,
    '[Main]\r\nName=one\r\nname=two\r\n[main]\r\nOther=three\r\n',
  );
  const comparison = 'ProfileEquivalent' as const;

  const rejected = projectIni(
    document,
    IniProjectionRequest.requireObject(comparison, 'Reject'),
  );
  assert.equal(rejected.kind, 'Failed');
  if (rejected.kind === 'Failed') {
    assert.equal(rejected.value.diagnostics()[0].code, 'ini.projection.collision@1');
  }

  const first = projectIni(
    document,
    IniProjectionRequest.requireObject(comparison, 'First'),
  );
  assert.equal(first.kind, 'Complete');
  if (first.kind === 'Complete') {
    assert.equal(first.value.fidelity(), 'Transformed');
    assert.equal(first.value.report().events().length, 2);
    const [sectionKey, entryKey, entryValue] = objectTriplet(first.value.value());
    assert.equal(sectionKey, 'Main');
    assert.equal(entryKey, 'Name');
    assert.equal(entryValue, 'one');
    assert.ok(relationPresent(first, 'Collapsed'));
  }

  const last = projectIni(
    document,
    IniProjectionRequest.requireObject(comparison, 'Last'),
  );
  assert.equal(last.kind, 'Complete');
  if (last.kind === 'Complete') {
    const [sectionKey, entryKey, entryValue] = objectTriplet(last.value.value());
    assert.equal(sectionKey, 'main');
    assert.equal(entryKey, 'Other');
    assert.equal(entryValue, 'three');
  }

  const original = projectIni(
    document,
    IniProjectionRequest.requireObject('OriginalExact', 'Reject'),
  );
  assert.equal(original.kind, 'Complete');
  if (original.kind === 'Complete') {
    assert.equal(original.value.fidelity(), 'Exact');
    const value = original.value.value();
    assert.equal(value.kind, 'Object');
    assert.equal(value.entries.length, 2);
  }
});

function objectTriplet(value: PortableValue): [string, string, string] {
  if (value.kind !== 'Object') {
    throw new Error(`expected an object value, got ${value.kind}`);
  }
  const sections = value.entries;
  const section = sections[0];
  const entries = (section.value as unknown as { entries: { key: string; value: unknown }[] }).entries;
  const entry = entries[0];
  return [section.key, entry.key, String((entry.value as { value: string }).value)];
}

test('golden projection.fragmented-value-provenance: ContinuationFragment and QuoteDerived', () => {
  // conformance/vectors/ini-v1.json:69-73 — Python continuation lines and
  // Windows outer quotes produce distinct provenance relations.
  const python = parseText(IniProfile.PYTHON_CONFIGPARSER_V1, '[s]\nkey = first\n  second\n');
  const pythonResult = projectIni(python, IniProjectionRequest.bestExactEntryMapping());
  assert.equal(relationPresent(pythonResult, 'ContinuationFragment'), true);

  const windows = parseText(IniProfile.WINDOWS_V1, '[s]\r\nk=" value "\r\n');
  const windowsResult = projectIni(windows, IniProjectionRequest.bestExactEntryMapping());
  assert.equal(relationPresent(windowsResult, 'QuoteDerived'), true);
});

test('recovered documents and each projection limit fail without values', () => {
  // projection.rs:288-314; RFC 0009 §10:362. Recovered never projects;
  // the three limit names fail atomically with core.projection.
  // resource-limit@1 (conformance/vectors/ini-v1.json:130-134).
  const recovered = parseText(IniProfile.PORTABLE_V1, '[s]\nbare\n');
  const recoveredResult = projectIni(recovered, IniProjectionRequest.bestExactEntryMapping());
  assert.equal(recoveredResult.kind, 'Failed');
  if (recoveredResult.kind === 'Failed') {
    assert.equal(
      recoveredResult.value.diagnostics()[0].code,
      'ini.projection.incomplete-document@1',
    );
  }

  const complete = parseText(IniProfile.PORTABLE_V1, '[s]\na=1\n');
  const names = ['max_source_associations', 'max_value_nodes', 'max_provenance_units'];
  for (const name of names) {
    const limits = { ...DEFAULT_LIMITS_FOR_PROJECTION };
    if (name === 'max_source_associations') limits.maxSourceAssociations = 1;
    if (name === 'max_value_nodes') limits.maxValueNodes = 1;
    if (name === 'max_provenance_units') limits.maxProvenanceUnits = 1;
    const result = projectIni(
      complete,
      IniProjectionRequest.bestExactEntryMapping().withLimits(limits),
    );
    assert.equal(result.kind, 'Failed', name);
    if (result.kind === 'Failed') {
      assert.equal(result.value.diagnostics()[0].code, 'core.projection.resource-limit@1');
      assert.equal(result.value.diagnostics()[0].arguments.get('limit'), name);
    }
  }
});

const DEFAULT_LIMITS_FOR_PROJECTION = {
  maxSourceAssociations: 2_000_000,
  maxValueNodes: 2_000_000,
  maxReportEntries: 100_000,
  maxProvenanceUnits: 4_000_000,
};
