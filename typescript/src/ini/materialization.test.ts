/**
 * INI materialization intent tests.
 *
 * These are blind-written intent documents (docs/multi-language-implementation
 * -plan.md §3): they transcribe the language-neutral facts from
 * conformance/vectors/ini-v1.json and crates/consema-ini/src/materialization.rs
 * and run once the toolchain is ready. Golden vector case ids are cited in
 * each test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MaterializationRequest } from '../document/materialization.ts';
import { utf16LeEncoding, windowsCodePageEncoding, latin1Encoding, WindowsCodePage } from '../document/source.ts';
import { entryMappingValue, stringValue, type PortableValue } from '../core/value.ts';
import { equal } from '../core/equal.ts';
import {
  IniProfile,
  iniPortableCanonicalStyle,
  iniWindowsCanonicalStyle,
  iniPythonConfigParserCanonicalStyle,
} from './profile.ts';
import { materializeIni } from './materialization.ts';
import { projectIni, IniProjectionRequest } from './projection.ts';

function nestedMapping(sections: readonly (readonly [string, readonly (readonly [string, string])[]])[]): PortableValue {
  const outer = sections.map(([name, entries]) => ({
    key: stringValue(name),
    value: entryMappingValue(entries.map(([key, value]) => ({ key: stringValue(key), value: stringValue(value) }))),
  }));
  return entryMappingValue(outer);
}

function portableRequest(): MaterializationRequest {
  return new MaterializationRequest(
    IniProfile.PORTABLE_V1.id(),
    iniPortableCanonicalStyle(),
  ).withMappingPolicy('UniqueStringEntriesToObject');
}

function windowsRequest(): MaterializationRequest {
  return new MaterializationRequest(
    IniProfile.WINDOWS_V1.id(),
    iniWindowsCanonicalStyle(),
  )
    .withEncoding(utf16LeEncoding())
    .withNewline('CrLf')
    .withMappingPolicy('UniqueStringEntriesToObject');
}

function pythonRequest(): MaterializationRequest {
  return new MaterializationRequest(
    IniProfile.PYTHON_CONFIGPARSER_V1.id(),
    iniPythonConfigParserCanonicalStyle(),
  ).withMappingPolicy('UniqueStringEntriesToObject');
}

test('golden materialization.all-canonical-styles: exact outputs and closure', () => {
  // conformance/vectors/ini-v1.json:74-82 — the three canonical outputs
  // (portable ASCII LF; Windows UTF-16LE with BOM and deterministic
  // quoting; Python multiline with four-space continuation), fidelity
  // Exact, and reprojection closure under the request policy.
  const portable = nestedMapping([['main', [['key', 'value'], ['empty', '']]]]);
  const portableResult = materializeIni(portable, portableRequest());
  assert.equal(portableResult.kind, 'Complete');
  if (portableResult.kind === 'Complete') {
    assert.equal(
      new TextDecoder().decode(portableResult.value.document().render()),
      '[main]\nkey=value\nempty=\n',
    );
    const closure = projectIni(
      portableResult.value.document(),
      IniProjectionRequest.bestExactEntryMapping(),
    );
    assert.equal(closure.kind === 'Complete' && equal(closure.value.value(), portable), true);
  }

  const windows = nestedMapping([['Main', [['quoted', ' value '], ['plain', 'value']]]]);
  const windowsResult = materializeIni(windows, windowsRequest());
  assert.equal(windowsResult.kind, 'Complete');
  if (windowsResult.kind === 'Complete') {
    const document = windowsResult.value.document();
    assert.equal(
      // The Windows canonical output is UTF-16LE with a BOM; keep the BOM
      // in the decoded comparison.
      new TextDecoder('utf-16le', { ignoreBOM: true }).decode(document.render()),
      '\u{feff}[Main]\r\nquoted=" value "\r\nplain=value\r\n',
    );
    assert.equal(document.source().encodingFacts().selected().kind, 'Utf16Le');
    assert.equal(windowsResult.value.fidelity(), 'Exact');
  }

  const python = nestedMapping([['DEFAULT', [['raw', '%(name)s'], ['multi', 'first\n\nthird']]]]);
  const pythonResult = materializeIni(python, pythonRequest());
  assert.equal(pythonResult.kind, 'Complete');
  if (pythonResult.kind === 'Complete') {
    const document = pythonResult.value.document();
    assert.equal(
      new TextDecoder().decode(document.render()),
      '[DEFAULT]\nraw = %(name)s\nmulti = first\n\n    third\n',
    );
    assert.equal(document.entries()[1].value(), 'first\n\nthird');
    assert.ok(
      pythonResult.value
        .provenance()
        .entries()
        .some((entry) => entry.outputs().length > 1),
    );
  }
});

test('golden materialization.atomic-failures-and-limits: scalar and limit failures', () => {
  // conformance/vectors/ini-v1.json:83-87 — a scalar input fails with
  // core.materialization.unrepresentable@1; max_input_nodes,
  // max_output_bytes, max_depth, and max_provenance_entries fail with
  // core.materialization.resource-limit@1 while max_report_entries stays
  // Complete.
  const scalar = stringValue('x');
  const scalarResult = materializeIni(scalar, portableRequest());
  assert.equal(scalarResult.kind, 'Failed');
  if (scalarResult.kind === 'Failed') {
    assert.equal(scalarResult.value.failure().code, 'core.materialization.unrepresentable@1');
  }

  const value = nestedMapping([['s', [['key', 'value']]]]);
  const outcomes: string[] = [];
  const cases: [string, number][] = [
    ['max_input_nodes', 1],
    ['max_output_bytes', 2],
    ['max_depth', 0],
    ['max_report_entries', 0],
    ['max_provenance_entries', 1],
  ];
  for (const [name, number] of cases) {
    const limits = {
      maxInputNodes: 1_000_000,
      maxOutputBytes: 64 * 1024 * 1024,
      maxDepth: 256,
      maxReportEntries: 100_000,
      maxProvenanceEntries: 2_000_000,
    };
    if (name === 'max_input_nodes') limits.maxInputNodes = number;
    if (name === 'max_output_bytes') limits.maxOutputBytes = number;
    if (name === 'max_depth') limits.maxDepth = number;
    if (name === 'max_report_entries') limits.maxReportEntries = number;
    if (name === 'max_provenance_entries') limits.maxProvenanceEntries = number;
    const result = materializeIni(value, portableRequest().withLimits(limits));
    if (result.kind === 'Complete') {
      outcomes.push('Complete');
    } else {
      assert.equal(result.value.failure().code, 'core.materialization.resource-limit@1', name);
      outcomes.push('Failed');
    }
  }
  assert.deepEqual(outcomes, ['Failed', 'Failed', 'Failed', 'Complete', 'Failed']);
});

test('Windows code-page materialization is strict and duplicate EntryMappings survive', () => {
  // materialization.rs tests (:970-991): cp1252 encodes café exactly; an
  // unrepresentable scalar (漢) fails with UnsupportedEncoding; duplicate
  // EntryMapping keys remain ordered.
  const page = WindowsCodePage.fromNumber(1252);
  assert.ok(page !== null);
  const request = windowsRequest().withEncoding(windowsCodePageEncoding(page!));
  const value = nestedMapping([['s', [['name', 'café'], ['name', 'two']]]]);
  const result = materializeIni(value, request);
  assert.equal(result.kind, 'Complete');
  if (result.kind === 'Complete') {
    const document = result.value.document();
    assert.equal(document.entries().length, 2);
    assert.equal(document.render().includes(0xe9), true);
  }

  const unrepresentable = nestedMapping([['s', [['name', '漢']]]]);
  const failed = materializeIni(unrepresentable, request);
  assert.equal(failed.kind, 'Failed');
  if (failed.kind === 'Failed') {
    assert.equal(failed.value.failure().kind, 'UnsupportedEncoding');
  }
});

test('Python explicit text encodings are representability checked', () => {
  // materialization.rs tests (:993-1026): Latin-1 round-trips café; UTF-16BE
  // output carries its BOM; an unrepresentable scalar fails.
  const latin = nestedMapping([['s', [['name', 'café']]]]);
  const latinResult = materializeIni(latin, pythonRequest().withEncoding(latin1Encoding()));
  assert.equal(latinResult.kind, 'Complete');
  if (latinResult.kind === 'Complete') {
    assert.equal(latinResult.value.document().source().encodingFacts().selected().kind, 'Latin1');
    assert.equal(latinResult.value.document().render().includes(0xe9), true);
  }

  const unicode = nestedMapping([['節', [['鍵', '値']]]]);
  const utf16 = materializeIni(
    unicode,
    pythonRequest().withEncoding({ kind: 'Utf16Be' }),
  );
  assert.equal(utf16.kind, 'Complete');
  if (utf16.kind === 'Complete') {
    const bytes = utf16.value.document().render();
    assert.equal(bytes[0], 0xfe);
    assert.equal(bytes[1], 0xff);
  }
  const latinFailed = materializeIni(unicode, pythonRequest().withEncoding(latin1Encoding()));
  assert.equal(latinFailed.kind, 'Failed');
});

test('Object input cannot fabricate Windows case collisions', () => {
  // materialization.rs tests (:1028-1048): an Object with case-equivalent
  // keys fails for Windows; distinct keys succeed.
  const colliding = {
    kind: 'Object' as const,
    entries: [
      { key: 's', value: { kind: 'Object' as const, entries: [
        { key: 'Name', value: stringValue('one') },
        { key: 'name', value: stringValue('two') },
      ] } },
    ],
  };
  assert.equal(materializeIni(colliding, windowsRequest()).kind, 'Failed');

  const distinct = {
    kind: 'Object' as const,
    entries: [
      { key: 's', value: { kind: 'Object' as const, entries: [
        { key: 'Name', value: stringValue('one') },
      ] } },
    ],
  };
  assert.equal(materializeIni(distinct, windowsRequest()).kind, 'Complete');
});

test('malformed shapes and unrepresentable values fail atomically', () => {
  // materialization.rs tests (:1050-1087): trailing empty Python value
  // lines are unrepresentable; input-node/output/provenance limits fail.
  const trailing = nestedMapping([['s', [['value', 'line\n']]]]);
  const failed = materializeIni(trailing, pythonRequest());
  assert.equal(failed.kind, 'Failed');
  if (failed.kind === 'Failed') {
    assert.equal(failed.value.failure().kind, 'InvalidRequest');
  }
});
